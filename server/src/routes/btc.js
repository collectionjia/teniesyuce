const { Router } = require('express');
const { auth } = require('../middleware/auth');
const pool = require('../db');
const btcWallet = require('../services/btcWallet');
const polymarketTrade = require('../services/polymarketTrade');
const tradeRecords = require('../services/tradeRecords');
const settings = require('../services/settings');

const router = Router();

const BOARD_BASE = (process.env.BOARD_INTERNAL_URL || 'http://btc-board:8890').replace(/\/$/, '');

function idleBoardState(crawlEnabled = false) {
  const now = Math.floor(Date.now() / 1000);
  return {
    ok: true,
    crawl_enabled: crawlEnabled,
    server_time: now,
    active_market: '5m',
    market_label: '',
    round_ts: 0,
    round_end: 0,
    strike: null,
    crypto_current: null,
    up_price: null,
    down_price: null,
    up_ask: null,
    down_ask: null,
    board_prices: {},
    board_rounds: {},
    leaderboard: null,
    leaderboard_15m: null,
    leaderboard_1h: null,
    message: crawlEnabled ? '' : 'BTC 数据采集已关闭',
  };
}

async function fetchBoardState() {
  const crawlEnabled = await settings.getBtcCrawlEnabled();
  if (!crawlEnabled) {
    const err = new Error('BTC 数据采集已关闭');
    err.code = 'CRAWL_DISABLED';
    throw err;
  }
  const res = await fetch(`${BOARD_BASE}/api/state`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`board HTTP ${res.status}`);
  return res.json();
}

function slimLeaderboard(lb) {
  if (!lb || typeof lb !== 'object') return null;
  return {
    up_count: lb.up_count ?? 0,
    dn_count: lb.dn_count ?? 0,
    up_total: lb.up_total ?? 0,
    dn_total: lb.dn_total ?? 0,
    hedged_count: lb.hedged_count ?? 0,
    filter_makers: !!lb.filter_makers,
    round_stats: lb.round_stats || null,
    hot_streak_stats: lb.hot_streak_stats || null,
    winners: lb.winners
      ? {
          side: lb.winners.side,
          total: lb.winners.total,
          up_n: lb.winners.up_n,
          dn_n: lb.winners.dn_n,
          majority_side: lb.winners.majority_side,
        }
      : null,
  };
}

function slimPreview(state) {
  return {
    ok: true,
    member: false,
    active_market: state.active_market,
    market_label: state.market_label,
    round_ts: state.round_ts,
    round_end: state.round_end,
    server_time: state.server_time,
    strike: state.strike,
    crypto_current: state.crypto_current,
    up_price: state.up_price,
    down_price: state.down_price,
    up_ask: state.up_ask,
    down_ask: state.down_ask,
    board_prices: state.board_prices || {},
    board_rounds: state.board_rounds || {},
    crawl_enabled: !!state.crawl_enabled,
    leaderboard: slimLeaderboard(state.leaderboard),
    leaderboard_15m: slimLeaderboard(state.leaderboard_15m),
    leaderboard_1h: slimLeaderboard(state.leaderboard_1h),
    message: '非会员预览（仅盘口与人数统计）',
  };
}

async function userHasBtcAccess(user) {
  if (!user) return false;
  const [products] = await pool.query(
    `SELECT id FROM products
     WHERE online = 1 AND (
       LOWER(tag) = 'crypto'
       OR name LIKE '%BTC%'
       OR name LIKE '%持仓%'
       OR LOWER(name) LIKE '%btc%board%'
     )`
  );
  if (!products.length) return false;
  const ids = products.map((p) => p.id);
  const placeholders = ids.map(() => '?').join(',');
  const [subs] = await pool.query(
    `SELECT product_id FROM subscriptions
     WHERE user_id = ? AND product_id IN (${placeholders}) AND expiry_at > NOW()
     LIMIT 1`,
    [user.id, ...ids]
  );
  return subs.length > 0;
}

async function requireBtcSim(req, res, next) {
  try {
    const ok = await btcWallet.userHasBtcSimAccess(req.user);
    if (!ok) return res.status(403).json({ error: '未开通 BTC 虚拟投注权限' });
    next();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '权限校验失败' });
  }
}

async function requireWallet(req, res, next) {
  try {
    const ok = await btcWallet.userHasWalletAccess(req.user);
    if (!ok) return res.status(403).json({ error: '未开通 BTC 虚拟投注权限，无法使用钱包' });
    next();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '权限校验失败' });
  }
}

router.get('/crawl', auth(), async (_req, res) => {
  try {
    const enabled = await settings.getBtcCrawlEnabled();
    res.json({ success: true, enabled });
  } catch (err) {
    console.error('[btc/crawl GET]', err);
    res.status(500).json({ success: false, error: err.message || '读取失败' });
  }
});

router.get('/state', auth(), async (req, res) => {
  try {
    const crawlEnabled = await settings.getBtcCrawlEnabled();
    if (!crawlEnabled) {
      const member = await userHasBtcAccess(req.user);
      const idle = idleBoardState(false);
      if (!member) return res.json(slimPreview(idle));
      return res.json({ ...idle, member: true });
    }
    const full = await fetchBoardState();
    const member = await userHasBtcAccess(req.user);
    if (!member) {
      return res.json(slimPreview(full));
    }
    res.json({ ...full, ok: true, member: true, crawl_enabled: true });
  } catch (err) {
    if (err.code === 'CRAWL_DISABLED') {
      const member = await userHasBtcAccess(req.user);
      const idle = idleBoardState(false);
      if (!member) return res.json(slimPreview(idle));
      return res.json({ ...idle, member: true });
    }
    console.error('[btc/state]', err);
    res.status(502).json({
      ok: false,
      error: err.message || 'failed to load board state',
    });
  }
});

router.get('/wallet', auth(), requireWallet, async (req, res) => {
  try {
    const status = await btcWallet.getWalletStatus(req.user.id);
    if (status.configured) {
      try {
        const secrets = await btcWallet.loadWalletSecrets(req.user.id);
        status.usdcBalance = await polymarketTrade.fetchUsdcBalance(secrets);
        // V2 存款钱包：旧 Proxy(1) 读余额恒为 0，自动改用 POLY_1271(3) 并落库
        if (
          (status.usdcBalance == null || status.usdcBalance === 0)
          && Number(secrets.signatureType) === 1
        ) {
          const bal3 = await polymarketTrade.fetchUsdcBalance({ ...secrets, signatureType: 3 });
          if (bal3 != null && bal3 > 0) {
            status.usdcBalance = bal3;
            status.signatureType = 3;
            try {
              await btcWallet.saveWallet(req.user.id, {
                proxyAddress: secrets.proxyAddress,
                signatureType: 3,
              });
            } catch {
              /* 落库失败不影响返回余额 */
            }
          }
        }
      } catch {
        status.usdcBalance = null;
      }
    }
    res.json(status);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '获取钱包配置失败' });
  }
});

router.put('/wallet', auth(), requireWallet, async (req, res) => {
  try {
    const { privateKey, proxyAddress, signatureType } = req.body || {};
    if (!proxyAddress) {
      return res.status(400).json({ error: '请填写钱包地址' });
    }
    const status = await btcWallet.saveWallet(req.user.id, {
      privateKey,
      proxyAddress,
      signatureType,
    });
    res.json({ message: '钱包已保存', ...status });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message || '保存失败' });
  }
});

router.delete('/wallet', auth(), requireWallet, async (req, res) => {
  try {
    const status = await btcWallet.clearWallet(req.user.id);
    res.json({ message: '钱包已清除', ...status });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '清除失败' });
  }
});

/** 测试已保存（或表单草稿）钱包能否连接 Polymarket CLOB */
router.post('/wallet/test', auth(), requireWallet, async (req, res) => {
  try {
    const { privateKey, proxyAddress, signatureType } = req.body || {};
    let secrets;
    if (privateKey && proxyAddress) {
      const { normalizePrivateKey, normalizeAddress } = require('../services/cryptoSecret');
      secrets = {
        privateKey: normalizePrivateKey(privateKey),
        proxyAddress: normalizeAddress(proxyAddress),
        signatureType: [0, 1, 2, 3].includes(Number(signatureType))
          ? Number(signatureType)
          : 1,
      };
    } else {
      secrets = await btcWallet.loadWalletSecrets(req.user.id);
    }
    const result = await polymarketTrade.testWalletConnection(secrets);
    res.json(result);
  } catch (e) {
    console.error('[btc/wallet/test]', e);
    const msg = e.message || '钱包连接测试失败';
    const decryptFailed = /无法解密|密文无效|unable to authenticate/i.test(msg);
    res.status(decryptFailed ? 409 : 400).json({
      ok: false,
      code: decryptFailed ? 'WALLET_DECRYPT_FAILED' : undefined,
      error: msg,
    });
  }
});

router.post('/trade', auth(), requireBtcSim, async (req, res) => {
  try {
    if (!(await settings.getBtcCrawlEnabled())) {
      return res.status(409).json({ error: 'BTC 数据采集已关闭，暂无法下单' });
    }
    const { market = '5m', side, amountUsd } = req.body || {};
    if (!['5m', '15m', '1h'].includes(market)) {
      return res.status(400).json({ error: '市场无效' });
    }
    if (!['up', 'down'].includes(String(side || '').toLowerCase())) {
      return res.status(400).json({ error: '方向无效（up/down）' });
    }
    const amount = Number(amountUsd);
    if (!(amount >= 1)) return res.status(400).json({ error: '投注金额至少 $1' });

    const secrets = await btcWallet.loadWalletSecrets(req.user.id);
    const board = await fetchBoardState();
    const round = board?.board_rounds?.[market]
      || (market === '5m'
        ? { round_ts: board.round_ts, round_end: board.round_end }
        : null);
    const roundTs = Number(round?.round_ts || 0);
    const roundEnd = Number(round?.round_end || 0);
    const now = Number(board.server_time || Date.now() / 1000);
    if (!roundTs) return res.status(409).json({ error: '当前回合未就绪' });
    if (roundEnd && now >= roundEnd - 3) {
      return res.status(409).json({ error: '回合即将结束，暂停下单' });
    }

    const tokens = await polymarketTrade.getRoundTokenIds(market, roundTs);
    const sideKey = String(side).toLowerCase();
    const tokenId = tokens[sideKey] || tokens[sideKey === 'up' ? 'yes' : 'no'];
    if (!tokenId) return res.status(409).json({ error: '未找到市场 token，请稍后重试' });

    const result = await polymarketTrade.placeMarketBuy({
      privateKey: secrets.privateKey,
      proxyAddress: secrets.proxyAddress,
      signatureType: secrets.signatureType,
      tokenId,
      amountUsd: amount,
    });

    const orderId = result?.orderID || result?.id || result?.orderId || '';
    const price = tradeRecords.priceFromFill(result, { action: 'buy', amountUsd: amount });
    const shares = tradeRecords.sharesFromFill(result, { action: 'buy', amountUsd: amount, price });
    const marketLabel = ({ '5m': '5分钟', '15m': '15分钟', '1h': '1小时' })[market] || market;
    try {
      await tradeRecords.addTradeRecord(req.user.id, {
        product: 'btc',
        action: 'buy',
        market,
        side: sideKey,
        amountUsd: amount,
        shares,
        price,
        label: `BTC ${marketLabel} ${sideKey.toUpperCase()}`,
        orderId,
        ok: true,
      });
    } catch (err) {
      console.error('[btc/trade] record', err.message || err);
    }

    res.json({
      success: true,
      message: `已成交 ${sideKey.toUpperCase()} $${amount}`,
      orderId,
      status: result?.status || '',
      takingAmount: result?.takingAmount || '',
      makingAmount: result?.makingAmount || '',
      result,
    });
  } catch (e) {
    console.error('[btc/trade]', e.message || e);
    res.status(400).json({ error: e.message || '下单失败' });
  }
});

router.get('/positions', auth(), requireBtcSim, async (req, res) => {
  try {
    if (!(await settings.getBtcCrawlEnabled())) {
      const market = String(req.query.market || '5m');
      return res.json({
        market,
        roundTs: 0,
        roundEnd: 0,
        up: 0,
        down: 0,
        upTokenId: '',
        downTokenId: '',
      });
    }
    const market = String(req.query.market || '5m');
    if (!['5m', '15m', '1h'].includes(market)) {
      return res.status(400).json({ error: '市场无效' });
    }
    const secrets = await btcWallet.loadWalletSecrets(req.user.id);
    const board = await fetchBoardState();
    const round = board?.board_rounds?.[market]
      || (market === '5m'
        ? { round_ts: board.round_ts, round_end: board.round_end }
        : null);
    const roundTs = Number(round?.round_ts || 0);
    const roundEnd = Number(round?.round_end || 0);
    if (!roundTs) {
      return res.json({
        market,
        roundTs: 0,
        roundEnd: 0,
        up: 0,
        down: 0,
        upTokenId: '',
        downTokenId: '',
      });
    }

    const tokens = await polymarketTrade.getRoundTokenIds(market, roundTs);
    const upTokenId = tokens.up || tokens.yes || '';
    const downTokenId = tokens.down || tokens.no || '';
    const [up, down] = await Promise.all([
      upTokenId
        ? polymarketTrade.fetchTokenShares(secrets, upTokenId)
        : Promise.resolve(0),
      downTokenId
        ? polymarketTrade.fetchTokenShares(secrets, downTokenId)
        : Promise.resolve(0),
    ]);

    res.json({
      market,
      roundTs,
      roundEnd,
      up,
      down,
      upTokenId,
      downTokenId,
    });
  } catch (e) {
    console.error('[btc/positions]', e.message || e);
    res.status(400).json({ error: e.message || '读取持仓失败' });
  }
});

router.post('/trade/sell', auth(), requireBtcSim, async (req, res) => {
  try {
    if (!(await settings.getBtcCrawlEnabled())) {
      return res.status(409).json({ error: 'BTC 数据采集已关闭，暂无法平仓' });
    }
    const { market = '5m', side, shares } = req.body || {};
    if (!['5m', '15m', '1h'].includes(market)) {
      return res.status(400).json({ error: '市场无效' });
    }
    if (!['up', 'down'].includes(String(side || '').toLowerCase())) {
      return res.status(400).json({ error: '方向无效（up/down）' });
    }

    const secrets = await btcWallet.loadWalletSecrets(req.user.id);
    const board = await fetchBoardState();
    const round = board?.board_rounds?.[market]
      || (market === '5m'
        ? { round_ts: board.round_ts, round_end: board.round_end }
        : null);
    const roundTs = Number(round?.round_ts || 0);
    const roundEnd = Number(round?.round_end || 0);
    const now = Number(board.server_time || Date.now() / 1000);
    if (!roundTs) return res.status(409).json({ error: '当前回合未就绪' });
    if (roundEnd && now >= roundEnd - 2) {
      return res.status(409).json({ error: '回合即将结束，暂停平仓' });
    }

    const tokens = await polymarketTrade.getRoundTokenIds(market, roundTs);
    const sideKey = String(side).toLowerCase();
    const tokenId = tokens[sideKey] || tokens[sideKey === 'up' ? 'yes' : 'no'];
    if (!tokenId) return res.status(409).json({ error: '未找到市场 token，请稍后重试' });

    const sellShares = (shares === 'all' || shares == null || shares === '')
      ? undefined
      : Number(shares);

    const result = await polymarketTrade.placeMarketSell({
      privateKey: secrets.privateKey,
      proxyAddress: secrets.proxyAddress,
      signatureType: secrets.signatureType,
      tokenId,
      shares: sellShares,
    });

    const sold = result?.soldShares
      || Number(result?.makingAmount)
      || sellShares
      || 0;
    const taking = Number(result?.takingAmount ?? result?.taking_amount);
    const making = Number(result?.makingAmount ?? result?.making_amount);
    const clampPx = (p) => {
      const n = Number(p);
      if (!(n > 0)) return 0;
      if (n <= 1.05) return Math.round(Math.min(n, 1) * 1000) / 1000;
      if (n <= 100) return Math.round((n / 100) * 1000) / 1000;
      return 0;
    };
    let sellPrice = 0;
    if (taking > 0 && making > 0) {
      sellPrice = clampPx(taking / making) || clampPx(making / taking);
    }
    if (!sellPrice) {
      sellPrice = clampPx(result?.sellPrice ?? result?.price ?? result?.avgPrice);
    }
    const priceHint = sellPrice > 0 ? ` · 卖出@${sellPrice.toFixed(2)}` : '';
    const orderId = result?.orderID || result?.id || result?.orderId || '';
    const marketLabel = ({ '5m': '5分钟', '15m': '15分钟', '1h': '1小时' })[market] || market;
    try {
      await tradeRecords.addTradeRecord(req.user.id, {
        product: 'btc',
        action: 'sell',
        market,
        side: sideKey,
        amountUsd: sellPrice > 0 && Number(sold) > 0
          ? Math.round(sellPrice * Number(sold) * 100) / 100
          : null,
        shares: Number(sold) || null,
        price: sellPrice || null,
        label: `BTC ${marketLabel} ${sideKey.toUpperCase()}`,
        orderId,
        ok: true,
      });
    } catch (err) {
      console.error('[btc/trade/sell] record', err.message || err);
    }

    res.json({
      success: true,
      message: `已平仓 ${sideKey.toUpperCase()} ${Number(sold).toFixed(2)} 股${priceHint}`,
      orderId,
      status: result?.status || '',
      soldShares: sold,
      sellPrice: sellPrice || undefined,
      takingAmount: Number.isFinite(taking) && taking > 0 ? taking : (result?.takingAmount || ''),
      makingAmount: Number.isFinite(making) && making > 0 ? making : (result?.makingAmount || ''),
      result,
    });
  } catch (e) {
    console.error('[btc/trade/sell]', e.message || e);
    res.status(400).json({ error: e.message || '平仓失败' });
  }
});

module.exports = router;
