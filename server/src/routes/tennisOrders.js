/**
 * 网球单场下单 API（按邮箱找用户钱包，无需 JWT）
 * POST /api/tennis/orders/buy
 * POST /api/tennis/orders/sell
 */
const { Router } = require('express');
const pool = require('../db');
const btcWallet = require('../services/btcWallet');
const tennisTrade = require('../services/tennisTrade');
const tennisDataSource = require('../services/tennisDataSource');
const tennisBettingEngine = require('../services/tennisBettingEngine');

const router = Router();

const PRODUCTS = new Set(['tennis-prematch', 'tennis-inplay']);

function pickEmail(body = {}) {
  const email = String(body.email || '').trim();
  if (email) return email;
  return String(body.account || '').trim();
}

function normalizeProduct(raw) {
  const p = String(raw || '').trim().toLowerCase();
  return PRODUCTS.has(p) ? p : null;
}

function wantBool(v, defaultVal) {
  if (v === undefined || v === null || v === '') return defaultVal;
  return v === true || v === 1 || v === '1' || v === 'true';
}

async function resolveUserByEmail(email) {
  const account = String(email || '').trim();
  if (!account) return null;
  const [[row]] = await pool.query(
    'SELECT id, account FROM users WHERE account=? LIMIT 1',
    [account],
  );
  return row || null;
}

async function resolveSimulate(bodySimulate) {
  const force = await tennisDataSource.shouldSimulateTrades();
  return force || wantBool(bodySimulate, false);
}

async function ensureWalletForLive(userId, simulate) {
  if (simulate) return;
  const status = await btcWallet.getWalletStatus(userId);
  if (!status?.configured) {
    const err = new Error('该用户未配置钱包');
    err.status = 400;
    throw err;
  }
  if (status.decryptFailed) {
    const err = new Error('该用户钱包解密失败，请重新保存私钥');
    err.status = 400;
    throw err;
  }
}

router.post('/buy', async (req, res) => {
  try {
    const body = req.body || {};
    const email = pickEmail(body);
    if (!email) {
      return res.status(400).json({ ok: false, error: '请填写 email（或 account）' });
    }
    const product = normalizeProduct(body.product);
    if (!product) {
      return res.status(400).json({ ok: false, error: 'product 须为 tennis-prematch 或 tennis-inplay' });
    }
    const eventId = body.eventId ?? body.id;
    if (eventId == null || String(eventId).trim() === '') {
      return res.status(400).json({ ok: false, error: '请填写 eventId' });
    }
    const side = String(body.side || '').toLowerCase();
    if (!['home', 'away'].includes(side)) {
      return res.status(400).json({ ok: false, error: 'side 须为 home 或 away' });
    }
    const amountUsd = Number(body.amountUsd);
    if (!(amountUsd >= 1)) {
      return res.status(400).json({ ok: false, error: 'amountUsd 至少为 1' });
    }

    const user = await resolveUserByEmail(email);
    if (!user) {
      return res.status(404).json({ ok: false, error: '邮箱对应用户不存在' });
    }

    const simulate = await resolveSimulate(body.simulate);
    await ensureWalletForLive(user.id, simulate);

    const batch = await tennisTrade.placeBatchOrders(user.id, {
      orders: [{ eventId, side }],
      amountUsd,
      product,
      simulate,
    });
    const one = Array.isArray(batch?.results) ? batch.results[0] : null;
    if (!one) {
      return res.status(400).json({
        ok: false,
        email: user.account,
        userId: user.id,
        product,
        eventId: String(eventId),
        error: batch?.message || '下单失败',
      });
    }

    let markedPlaced = false;
    const markPlaced = wantBool(body.markPlaced, true);
    if (one.ok && markPlaced) {
      try {
        const sk = String(body.strategyKey || '').trim() || '_';
        const m = await tennisBettingEngine.markPlacedFromOrders({
          userId: user.id,
          product,
          strategyKey: sk,
          orders: [{
            eventId,
            shares: one.shares,
            takingAmount: one.takingAmount,
            amountUsd: one.amountUsd ?? amountUsd,
            price: one.price,
          }],
        });
        markedPlaced = !!m?.ok;
      } catch (e) {
        console.warn('[tennis/orders/buy] markPlaced', e.message);
      }
    }

    if (!one.ok) {
      return res.status(200).json({
        ok: false,
        email: user.account,
        userId: user.id,
        product,
        eventId: String(one.eventId || eventId),
        side,
        amountUsd,
        simulated: !!simulate,
        markedPlaced: false,
        error: one.error || '下单失败',
      });
    }

    return res.json({
      ok: true,
      email: user.account,
      userId: user.id,
      product,
      eventId: String(one.eventId || eventId),
      side: one.side || side,
      amountUsd: one.amountUsd != null ? Number(one.amountUsd) : amountUsd,
      price: one.price != null ? Number(one.price) : null,
      shares: one.shares != null ? Number(one.shares) : null,
      homeName: one.homeName || '',
      awayName: one.awayName || '',
      orderId: one.orderId || '',
      status: one.status || '',
      simulated: !!one.simulated || !!simulate,
      markedPlaced,
      takingAmount: one.takingAmount || '',
      makingAmount: one.makingAmount || '',
    });
  } catch (e) {
    console.error('[tennis/orders/buy]', e);
    const status = e.status || 400;
    res.status(status).json({ ok: false, error: e.message || '买入失败' });
  }
});

router.post('/sell', async (req, res) => {
  try {
    const body = req.body || {};
    const email = pickEmail(body);
    if (!email) {
      return res.status(400).json({ ok: false, error: '请填写 email（或 account）' });
    }
    const product = normalizeProduct(body.product);
    if (!product) {
      return res.status(400).json({ ok: false, error: 'product 须为 tennis-prematch 或 tennis-inplay' });
    }
    const eventId = body.eventId ?? body.id;
    if (eventId == null || String(eventId).trim() === '') {
      return res.status(400).json({ ok: false, error: '请填写 eventId' });
    }
    const side = String(body.side || '').toLowerCase();
    if (!['home', 'away'].includes(side)) {
      return res.status(400).json({ ok: false, error: 'side 须为 home 或 away' });
    }
    const shares = body.shares === undefined || body.shares === null || body.shares === ''
      ? 'all'
      : body.shares;

    const user = await resolveUserByEmail(email);
    if (!user) {
      return res.status(404).json({ ok: false, error: '邮箱对应用户不存在' });
    }

    const simulate = await resolveSimulate(body.simulate);
    await ensureWalletForLive(user.id, simulate);

    const sellRes = await tennisTrade.placeSellOrder(user.id, {
      eventId,
      side,
      shares,
      product,
      simulate,
    });

    let markedSold = false;
    const markSold = wantBool(body.markSold, true);
    if (sellRes?.ok && markSold) {
      try {
        const sk = String(body.strategyKey || '').trim() || undefined;
        const soldAll = shares === 'all' || shares === 'ALL';
        const m = await tennisBettingEngine.markSoldFromOrders({
          userId: user.id,
          product,
          strategyKey: sk,
          orders: [{
            eventId,
            shares: sellRes.soldShares ?? shares,
            soldAll,
          }],
        });
        markedSold = !!m?.ok;
      } catch (e) {
        console.warn('[tennis/orders/sell] markSold', e.message);
      }
    }

    return res.json({
      ok: !!sellRes?.ok,
      email: user.account,
      userId: user.id,
      product,
      eventId: String(sellRes?.eventId || eventId),
      side: sellRes?.side || side,
      orderId: sellRes?.orderId || '',
      soldShares: sellRes?.soldShares ?? shares,
      price: sellRes?.price != null ? Number(sellRes.price) : null,
      amountUsd: sellRes?.amountUsd != null ? Number(sellRes.amountUsd) : null,
      status: sellRes?.status || '',
      homeName: sellRes?.homeName || '',
      awayName: sellRes?.awayName || '',
      simulated: !!sellRes?.simulated || !!simulate,
      markedSold,
      error: sellRes?.ok ? undefined : (sellRes?.error || '卖出失败'),
    });
  } catch (e) {
    console.error('[tennis/orders/sell]', e);
    const status = e.status || 400;
    res.status(status).json({ ok: false, error: e.message || '卖出失败' });
  }
});

module.exports = router;
