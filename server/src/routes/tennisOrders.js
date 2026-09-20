/**
 * 网球下单 API
 * - 页面登录：JWT → 当前用户钱包
 * - 对外：body.email / account 定位用户
 * POST /api/tennis/orders/buy
 * POST /api/tennis/orders/sell
 * POST /api/tennis/orders/batch
 */
const { Router } = require('express');
const tennisTrade = require('../services/tennisTrade');
const tennisBettingEngine = require('../services/tennisBettingEngine');
const { optionalAuth } = require('../middleware/auth');
const {
  pickEmail,
  wantBool,
  resolveUserByEmail,
  resolveUserById,
  resolveSimulate,
  ensureWalletForLive,
  walletOverrideFromBody,
  attachUserFromEmailBody,
  resolveTradeSimulatePublic,
} = require('../services/tennisOrdersPublic');

const router = Router();

const PRODUCTS = new Set(['tennis-prematch', 'tennis-inplay']);

function normalizeProduct(raw) {
  const p = String(raw || '').trim().toLowerCase();
  return PRODUCTS.has(p) ? p : null;
}

async function resolveOrderUser(req) {
  if (req.user?.id) {
    return resolveUserById(req.user.id);
  }
  const email = pickEmail(req.body || {});
  if (!email) return null;
  return resolveUserByEmail(email);
}

router.post('/buy', optionalAuth(), async (req, res) => {
  try {
    const body = req.body || {};
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

    const user = await resolveOrderUser(req);
    if (!user) {
      if (!req.user?.id && !pickEmail(body)) {
        return res.status(400).json({ ok: false, error: '请登录，或填写 email（或 account）' });
      }
      return res.status(404).json({ ok: false, error: '邮箱对应用户不存在' });
    }

    const simulate = await resolveSimulate(body.simulate);
    const wallet = walletOverrideFromBody(body);
    if (!wallet) await ensureWalletForLive(user.id, simulate);

    const batch = await tennisTrade.placeBatchOrders(user.id, {
      orders: [{ eventId, side }],
      amountUsd,
      product,
      simulate,
      wallet,
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

router.post('/sell', optionalAuth(), async (req, res) => {
  try {
    const body = req.body || {};
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

    const user = await resolveOrderUser(req);
    if (!user) {
      if (!req.user?.id && !pickEmail(body)) {
        return res.status(400).json({ ok: false, error: '请登录，或填写 email（或 account）' });
      }
      return res.status(404).json({ ok: false, error: '邮箱对应用户不存在' });
    }

    const simulate = await resolveSimulate(body.simulate);
    const wallet = walletOverrideFromBody(body);
    if (!wallet) await ensureWalletForLive(user.id, simulate);

    const sellRes = await tennisTrade.placeSellOrder(user.id, {
      eventId,
      side,
      shares,
      product,
      simulate,
      wallet,
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

/** 批量买入（1～20 场，每场同 amountUsd） */
router.post('/batch', optionalAuth(), attachUserFromEmailBody, resolveTradeSimulatePublic, async (req, res) => {
  try {
    const body = req.body || {};
    const product = normalizeProduct(body.product);
    if (!product) {
      return res.status(400).json({ ok: false, error: 'product 须为 tennis-prematch 或 tennis-inplay' });
    }
    const { orders, amountUsd } = body;
    const result = await tennisTrade.placeBatchOrders(req.tennisUser.id, {
      orders,
      amountUsd,
      product,
      simulate: !!req.tradeSimulate,
      wallet: req.walletOverride,
    });
    res.json({
      ...result,
      email: req.tennisUser.account,
      userId: req.tennisUser.id,
      product,
    });
  } catch (e) {
    console.error('[tennis/orders/batch]', e);
    res.status(400).json({ ok: false, error: e.message || '批量下单失败' });
  }
});

module.exports = router;
