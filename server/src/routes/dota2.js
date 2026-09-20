/**
 * 代理 dota2elo 服务 JSON API（Vue 直出，不走 iframe）
 * + Polymarket 盘口 bundle / 高置信度市价买入
 * 上游：DOTA2ELO_URL 或 DOTA2ELO_PRODUCT_URL，默认 http://dota2elo:3001
 */
const express = require('express');
const { optionalAuth } = require('../middleware/auth');
const {
  attachUserFromEmailBody,
  resolveTradeSimulatePublic,
} = require('../services/tennisOrdersPublic');
const btcWallet = require('../services/btcWallet');
const polymarketTrade = require('../services/polymarketTrade');
const dota2PmCollect = require('../services/dota2PmCollect');

const router = express.Router();

try {
  dota2PmCollect.startCollectLoop();
} catch (err) {
  console.warn('[dota2] collect loop start failed', err.message || err);
}

function upstreamBase() {
  const raw = process.env.DOTA2ELO_URL
    || process.env.DOTA2ELO_PRODUCT_URL
    || 'http://dota2elo:3001';
  return String(raw).replace(/\/+$/, '');
}

async function proxyJson(req, res) {
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const path = req.path.startsWith('/') ? req.path : `/${req.path}`;
  const url = `${upstreamBase()}/api${path}${qs}`;
  try {
    const upstream = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const text = await upstream.text();
    const type = upstream.headers.get('content-type') || 'application/json';
    res.status(upstream.status).type(type).send(text);
  } catch (err) {
    console.error('[dota2-proxy]', url, err.message || err);
    res.status(502).json({
      ok: false,
      error: err.message || 'dota2elo unreachable',
      upstream: upstreamBase(),
    });
  }
}

router.get('/health', proxyJson);
router.get('/rankings', proxyJson);
router.get('/teams', proxyJson);
router.get('/teams/:teamId', proxyJson);
router.get('/predict', proxyJson);
router.get('/matches', proxyJson);
router.get('/players', proxyJson);
router.get('/players/:playerId', proxyJson);
router.get('/calibration', proxyJson);
router.get('/backtest', proxyJson);

/** Polymarket 过滤盘口（读 Redis bundle） */
router.get('/markets', optionalAuth(), async (req, res) => {
  try {
    let bundle = await dota2PmCollect.readBundle();
    if (!bundle) {
      bundle = {
        ok: true,
        empty: true,
        sport: 'dota2',
        matches: [],
        matchCount: 0,
        thresholds: dota2PmCollect.thresholds(),
        fetched_at: null,
        message: '盘口尚未采集，请刷新',
      };
    }
    let placed = [];
    if (req.user?.id) {
      const set = await dota2PmCollect.getPlacedSet(req.user.id);
      placed = [...set];
    }
    res.json({ ...bundle, placed, member: !!req.user });
  } catch (err) {
    console.error('[dota2/markets]', err);
    res.status(500).json({ ok: false, error: err.message || 'failed to load markets' });
  }
});

router.post('/markets/refresh', optionalAuth(), async (req, res) => {
  try {
    const bundle = await dota2PmCollect.collectOnce();
    res.json(bundle || { ok: false, error: 'collect returned empty' });
  } catch (err) {
    console.error('[dota2/markets/refresh]', err);
    res.status(500).json({ ok: false, error: err.message || 'refresh failed' });
  }
});

/**
 * 批量买入：市价 FOK / 限价 GTC
 * body: {
 *   orders: [{ slug, side, tokenId, amountUsd? }],
 *   amountUsd?, orderType?: 'market'|'limit',
 *   shares?, limitBuyPrice?, limitPrice?, simulate?,
 *   privateKey?, address?, signatureType?  // 私钥+地址下单；签名类型默认 3（新账户 POLY_1271）
 * }
 */
router.post('/trade/batch', optionalAuth(), attachUserFromEmailBody, resolveTradeSimulatePublic, async (req, res) => {
  try {
    const userId = req.tennisUser?.id;
    if (!userId) {
      return res.status(401).json({ ok: false, error: '请先登录' });
    }
    const simulate = !!req.tradeSimulate;
    const orders = Array.isArray(req.body?.orders) ? req.body.orders : [];
    if (!orders.length) {
      return res.status(400).json({ ok: false, error: '请至少选择一场' });
    }
    if (orders.length > 20) {
      return res.status(400).json({ ok: false, error: '单次最多批量下单 20 场' });
    }

    const orderType = String(req.body?.orderType || 'market').toLowerCase() === 'limit'
      ? 'limit'
      : 'market';
    let limitBuyPrice = null;
    let shares = null;
    if (orderType === 'limit') {
      const buyRaw = req.body?.limitBuyPrice ?? req.body?.limitPrice;
      const p = Number(buyRaw);
      if (!(p >= 0.01 && p <= 0.99)) {
        return res.status(400).json({ ok: false, error: '限价单须填写买入目标价（0.01–0.99）' });
      }
      limitBuyPrice = Math.round(p * 100) / 100;
      shares = Math.floor(Number(req.body?.shares) * 100) / 100;
      if (!(shares > 0)) {
        return res.status(400).json({ ok: false, error: '限价单须填写份额' });
      }
      const notional = Math.round(shares * limitBuyPrice * 100) / 100;
      if (!(notional >= 1)) {
        return res.status(400).json({
          ok: false,
          error: `限价买入金额 $${notional} 不足 $1，请提高份额`,
        });
      }
    }

    const wallet = req.walletOverride || null;
    if (!simulate && !wallet) {
      const status = await btcWallet.getWalletStatus(userId);
      if (!status?.configured) {
        return res.status(400).json({ ok: false, error: '该用户未配置钱包' });
      }
    }

    const placed = await dota2PmCollect.getPlacedSet(userId);
    const secrets = simulate ? null : (wallet || await btcWallet.loadWalletSecrets(userId));
    const results = [];

    for (const item of orders) {
      const slug = String(item?.slug || '').trim();
      const side = String(item?.side || item?.pickSide || '').toLowerCase();
      const tokenId = String(item?.tokenId || item?.pickTokenId || '').trim();
      const amountUsd = Number(item?.amountUsd ?? req.body?.amountUsd ?? 1);
      const placeKey = `${slug}:${side}`;

      if (!slug || !tokenId) {
        results.push({ slug, side, ok: false, error: '缺少 slug 或 tokenId' });
        continue;
      }
      if (!['a', 'b'].includes(side)) {
        results.push({ slug, side, ok: false, error: 'side 须为 a|b' });
        continue;
      }
      if (orderType === 'market' && !(amountUsd >= 1)) {
        results.push({ slug, side, ok: false, error: '金额至少 $1' });
        continue;
      }
      if (placed.has(placeKey)) {
        results.push({ slug, side, ok: true, skipped: true, reason: 'already_placed' });
        continue;
      }

      try {
        if (simulate) {
          await dota2PmCollect.markPlaced(userId, placeKey);
          placed.add(placeKey);
          results.push({
            slug,
            side,
            ok: true,
            simulate: true,
            orderType,
            tokenId,
            amountUsd: orderType === 'limit'
              ? Math.round(shares * limitBuyPrice * 100) / 100
              : amountUsd,
            shares: orderType === 'limit' ? shares : undefined,
            limitBuyPrice: orderType === 'limit' ? limitBuyPrice : undefined,
            orderId: `sim-dota2-${Date.now()}`,
          });
          continue;
        }

        let order;
        if (orderType === 'limit') {
          order = await polymarketTrade.placeLimitBuy({
            privateKey: secrets.privateKey,
            proxyAddress: secrets.proxyAddress,
            signatureType: secrets.signatureType,
            tokenId,
            shares,
            price: limitBuyPrice,
            amountUsd,
          });
        } else {
          order = await polymarketTrade.placeMarketBuy({
            privateKey: secrets.privateKey,
            proxyAddress: secrets.proxyAddress,
            signatureType: secrets.signatureType,
            tokenId,
            amountUsd,
          });
        }
        await dota2PmCollect.markPlaced(userId, placeKey);
        placed.add(placeKey);
        results.push({
          slug,
          side,
          ok: true,
          orderType,
          tokenId,
          amountUsd: orderType === 'limit'
            ? Math.round(shares * limitBuyPrice * 100) / 100
            : amountUsd,
          shares: orderType === 'limit' ? shares : undefined,
          limitBuyPrice: orderType === 'limit' ? limitBuyPrice : undefined,
          orderId: order?.orderID || order?.id || null,
          result: order,
        });
      } catch (e) {
        results.push({ slug, side, ok: false, error: e.message || String(e) });
      }
    }

    res.json({
      ok: true,
      email: req.tennisUser.account,
      userId,
      product: 'dota2',
      simulate,
      orderType,
      results,
    });
  } catch (e) {
    console.error('[dota2/trade/batch]', e);
    res.status(400).json({ ok: false, error: e.message || '批量下单失败' });
  }
});

module.exports = router;
