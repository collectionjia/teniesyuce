const express = require('express');
const pool = require('../db');
const { auth } = require('../middleware/auth');
const { fulfillSubscription } = require('../services/subscription');
const pricing = require('../services/pricing');
const muskpay = require('../services/muskpay');

const router = express.Router();

function clientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '127.0.0.1';
}

function publicBase(req) {
  return process.env.APP_PUBLIC_URL?.replace(/\/$/, '') || `${req.protocol}://${req.get('host')}`;
}

function buildCallbackUrl(reference) {
  const publicUrl = process.env.APP_PUBLIC_URL?.replace(/\/$/, '');
  if (publicUrl) {
    return `${publicUrl}/api/payments/callback?ref=${reference}`;
  }
  return `${frontendUrl(`/?payment=callback&ref=${reference}`)}`;
}

function buildIpnUrl(base) {
  const publicUrl = process.env.APP_PUBLIC_URL?.replace(/\/$/, '');
  if (publicUrl) return `${publicUrl}/api/payments/ipn`;
  return `${base}/api/payments/ipn`;
}

function detectTerminal(req) {
  const ua = req.headers['user-agent'] || '';
  const isMobile = /Mobile|Android|iPhone|iPad|webOS/i.test(ua);
  if (!isMobile) return { terminal: 'ONLINE' };
  return {
    terminal: 'WAP',
    ostype: /Android/i.test(ua) ? 'ANDROID' : 'IOS',
  };
}

function isWeChatBrowser(req) {
  return /MicroMessenger/i.test(req.headers['user-agent'] || '');
}

function frontendUrl(path = '') {
  const base = (process.env.APP_FRONTEND_URL || 'http://localhost:5279').replace(/\/$/, '');
  return base + path;
}

function paymentSuccessUrl(reference) {
  return frontendUrl(`/payment/success?ref=${encodeURIComponent(reference)}`);
}

function paymentFailureUrl(reference, msg) {
  const params = new URLSearchParams();
  if (reference) params.set('ref', reference);
  if (msg) params.set('msg', msg);
  const q = params.toString();
  return frontendUrl(`/payment/failure${q ? `?${q}` : ''}`);
}

async function buildPaymentStatusResponse(reference, userId = null) {
  const [[po]] = await pool.query('SELECT * FROM payment_orders WHERE reference=?', [reference]);
  if (!po) return null;
  if (userId && po.user_id !== userId) return null;

  if (po.status === 'pending') {
    try {
      const tx = await muskpay.queryByReference(po.reference);
      if (tx.status === 'success') {
        await markPaidAndFulfill(po, tx.id, tx.status);
        po.status = 'paid';
      }
    } catch (_) { /* ignore */ }
  }

  const [[latest]] = await pool.query('SELECT * FROM payment_orders WHERE reference=?', [reference]);
  const orderType = latest.order_type || 'subscription';

  let product = null;
  let subs = {};
  let expiryAt = null;
  let balance = null;

  if (orderType === 'balance') {
    const [[userRow]] = await pool.query('SELECT balance FROM users WHERE id=?', [latest.user_id]);
    balance = Number(userRow?.balance || 0);
  } else {
    [[product]] = await pool.query(
      'SELECT id, name, tag, gradient FROM products WHERE id=?',
      [latest.product_id]
    );
    if (userId) {
      const [subRows] = await pool.query('SELECT product_id, expiry_at FROM subscriptions WHERE user_id=?', [userId]);
      for (const r of subRows) subs[r.product_id] = new Date(r.expiry_at).getTime();
      expiryAt = subs[latest.product_id] || null;
    }
  }

  const statusMessages = {
    paid: orderType === 'balance' ? '充值成功，余额已到账' : '支付成功，订阅已生效',
    pending: '等待支付确认',
    failed: '支付失败，请重试',
    cancelled: '订单已取消',
  };

  return {
    status: latest.status,
    orderType,
    reference: latest.reference,
    productId: latest.product_id,
    productName: product?.name || (orderType === 'balance' ? '余额充值' : ''),
    productTag: product?.tag || '',
    productGradient: product?.gradient || '',
    plan: latest.plan,
    amount: Number(latest.amount),
    payAmount: latest.pay_amount,
    paidAt: latest.paid_at,
    expiryAt,
    balance,
    subscriptions: subs,
    message: statusMessages[latest.status] || '等待支付确认',
  };
}

async function markPaidAndFulfill(paymentOrder, txId, muskStatus) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[po]] = await conn.query('SELECT * FROM payment_orders WHERE id=? FOR UPDATE', [paymentOrder.id]);
    if (!po || po.status === 'paid') {
      await conn.commit();
      return { alreadyPaid: true, orderType: po?.order_type || 'subscription' };
    }

    let result;
    if (po.order_type === 'balance') {
      await conn.query('UPDATE users SET balance = balance + ? WHERE id=?', [Number(po.amount), po.user_id]);
      const [[userRow]] = await conn.query('SELECT balance FROM users WHERE id=?', [po.user_id]);
      result = { orderType: 'balance', balance: Number(userRow.balance) };
    } else {
      result = await fulfillSubscription(conn, po.user_id, po.product_id, po.plan, Number(po.amount));
      result.orderType = 'subscription';
    }

    await conn.query(
      `UPDATE payment_orders SET status='paid', muskpay_tx_id=?, muskpay_status=?, paid_at=NOW() WHERE id=?`,
      [txId || null, muskStatus || 'success', po.id]
    );
    await conn.commit();
    return { alreadyPaid: false, ...result };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

router.post('/create', auth(['user', 'agent', 'admin']), async (req, res) => {
  const { productId, plan, vendor } = req.body;
  if (!productId || !['month', 'week', 'day'].includes(plan)) {
    return res.status(400).json({ error: '参数错误' });
  }

  try {
    const [[product]] = await pool.query('SELECT * FROM products WHERE id=? AND online=1', [productId]);
    if (!product) return res.status(404).json({ error: '产品不存在或已下架' });

    const payVendor = ['alipay', 'wechatpay', 'unionpay'].includes(vendor)
      ? vendor
      : muskpay.DEFAULT_VENDOR;

    const [[userRow]] = await pool.query(
      'SELECT id, role, commission_rate FROM users WHERE id=?',
      [req.user.id]
    );
    const price = pricing.priceForUser(product, plan, userRow);
    const reference = muskpay.genReference();
    const payAmount = muskpay.toRmbAmount(price);
    const currency = muskpay.CURRENCY;
    const base = publicBase(req);

    await pool.query(
      `INSERT INTO payment_orders (reference, user_id, order_type, product_id, plan, amount, currency, pay_amount, status)
       VALUES (?,?, 'subscription', ?,?,?,?,?, 'pending')`,
      [reference, req.user.id, productId, plan, price, currency, payAmount]
    );

    const planLabel = { month: '月', week: '周', day: '天' }[plan];
    const terminalInfo = detectTerminal(req);
    const callbackUrl = buildCallbackUrl(reference);

    const paymentPayload = {
      currency,
      rmb_amount: payAmount,
      vendor: payVendor,
      reference,
      ipn_url: buildIpnUrl(base),
      callback_url: callbackUrl,
      description: `${product.name} ${planLabel}订阅`,
      note: `user:${req.user.id},product:${productId}`,
      terminal: terminalInfo.terminal,
      response_format: 'JSON',
      timeout: 120,
    };
    if (payVendor === 'wechatpay') {
      paymentPayload.in_wechat = isWeChatBrowser(req) ? 'true' : 'false';
    }
    if (terminalInfo.ostype) paymentPayload.ostype = terminalInfo.ostype;

    const checkout = await muskpay.createPayment(paymentPayload);

    res.json({
      redirectUrl: checkout.redirectUrl,
      form: checkout.form,
      reference,
      amount: price,
      payAmount,
      currency: 'CNY',
      vendor: payVendor,
      terminal: terminalInfo.terminal,
      callbackWarning: !process.env.APP_PUBLIC_URL
        ? '本地开发：支付完成后请返回站点查看订阅状态；生产环境请配置 APP_PUBLIC_URL'
        : null,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || '创建支付失败' });
  }
});

router.post('/balance/create', auth(['user', 'agent', 'admin']), async (req, res) => {
  const amount = Number(req.body.amount);
  const { vendor } = req.body;
  if (!amount || amount < 1 || amount > 10000) {
    return res.status(400).json({ error: '充值金额需在 ¥1 ~ ¥10000 之间' });
  }

  try {
    const payVendor = ['alipay', 'wechatpay', 'unionpay'].includes(vendor)
      ? vendor
      : muskpay.DEFAULT_VENDOR;

    const reference = muskpay.genReference();
    const payAmount = muskpay.toRmbAmount(amount);
    const currency = muskpay.CURRENCY;
    const base = publicBase(req);

    await pool.query(
      `INSERT INTO payment_orders (reference, user_id, order_type, product_id, plan, amount, currency, pay_amount, status)
       VALUES (?,?, 'balance', NULL, NULL, ?,?,?, 'pending')`,
      [reference, req.user.id, amount, currency, payAmount]
    );

    const terminalInfo = detectTerminal(req);
    const callbackUrl = buildCallbackUrl(reference);

    const paymentPayload = {
      currency,
      rmb_amount: payAmount,
      vendor: payVendor,
      reference,
      ipn_url: buildIpnUrl(base),
      callback_url: callbackUrl,
      description: `账户余额充值 ¥${amount}`,
      note: `user:${req.user.id},balance_topup`,
      terminal: terminalInfo.terminal,
      response_format: 'JSON',
      timeout: 120,
    };
    if (payVendor === 'wechatpay') {
      paymentPayload.in_wechat = isWeChatBrowser(req) ? 'true' : 'false';
    }
    if (terminalInfo.ostype) paymentPayload.ostype = terminalInfo.ostype;

    const checkout = await muskpay.createPayment(paymentPayload);

    res.json({
      redirectUrl: checkout.redirectUrl,
      form: checkout.form,
      reference,
      amount,
      payAmount,
      currency: 'CNY',
      vendor: payVendor,
      terminal: terminalInfo.terminal,
      orderType: 'balance',
      callbackWarning: !process.env.APP_PUBLIC_URL
        ? '本地开发：支付完成后请返回站点查看余额；生产环境请配置 APP_PUBLIC_URL'
        : null,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || '创建充值订单失败' });
  }
});

router.post('/ipn', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const params = req.body || {};
    if (!muskpay.verifySign(params)) {
      console.error('IPN signature invalid', params);
      return res.status(400).send('invalid sign');
    }

    const [[po]] = await pool.query('SELECT * FROM payment_orders WHERE reference=?', [params.reference]);
    if (!po) return res.status(404).send('order not found');

    if (params.status === 'success') {
      await markPaidAndFulfill(po, params.id, params.status);
    } else if (params.status === 'failure') {
      await pool.query('UPDATE payment_orders SET status=?, muskpay_status=? WHERE id=?', ['failed', params.status, po.id]);
    }

    res.send('ok');
  } catch (e) {
    console.error('IPN error', e);
    res.status(500).send('error');
  }
});

router.get('/callback', async (req, res) => {
  const reference = req.query.ref || req.query.reference;
  const { status } = req.query;
  if (!reference) {
    return res.redirect(paymentFailureUrl(null, 'missing_reference'));
  }

  try {
    const [[po]] = await pool.query('SELECT * FROM payment_orders WHERE reference=?', [reference]);
    if (!po) {
      return res.redirect(paymentFailureUrl(null, 'order_not_found'));
    }

    if (po.status !== 'paid') {
      try {
        const tx = await muskpay.queryByReference(reference);
        if (tx.status === 'success') {
          await markPaidAndFulfill(po, tx.id, tx.status);
        }
      } catch (e) {
        console.warn('callback query tx:', e.message);
      }
    }

    const [[updated]] = await pool.query('SELECT status FROM payment_orders WHERE reference=?', [reference]);
    if (updated?.status === 'paid') {
      return res.redirect(paymentSuccessUrl(reference));
    }

    const st = status === 'failure' ? 'failure' : 'pending';
    return res.redirect(paymentFailureUrl(reference, st === 'failure' ? 'payment_failed' : null));
  } catch (e) {
    console.error('callback error', e);
    return res.redirect(paymentFailureUrl(null, 'callback_error'));
  }
});

router.get('/public-status/:reference', async (req, res) => {
  try {
    const data = await buildPaymentStatusResponse(req.params.reference);
    if (!data) return res.status(404).json({ error: '订单不存在' });
    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '查询支付状态失败' });
  }
});

router.get('/status/:reference', auth(), async (req, res) => {
  try {
    const data = await buildPaymentStatusResponse(req.params.reference, req.user.id);
    if (!data) return res.status(404).json({ error: '订单不存在' });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: '查询支付状态失败' });
  }
});

module.exports = router;
