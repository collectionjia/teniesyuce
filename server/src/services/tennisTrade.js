const tennisCache = require('./tennisCache');
const tennisRangeCache = require('./tennisRangeCache');
const tennisLiveCache = require('./tennisLiveCache');
const tennisInplayCache = require('./tennisInplayCache');
const tennisNewCache = require('./tennisNewCache');
const tennisPrematchCache = require('./tennisPrematchCache');
const tennisSettledCache = require('./tennisSettledCache');
const btcWallet = require('./btcWallet');
const polymarketTrade = require('./polymarketTrade');
const tradeRecords = require('./tradeRecords');

function allMatches(bundle) {
  if (!bundle) return [];
  const tournaments = bundle.scheduled?.tournaments || [];
  const fromSched = tournaments.flatMap((t) =>
    (t.events || []).map((e) => ({
      ...e,
      tournament: e.tournament || t.name,
    }))
  );
  const live = bundle.live?.matches || [];
  const byId = new Map();
  for (const m of [...fromSched, ...live]) {
    if (m?.id != null) byId.set(String(m.id), m);
  }
  return [...byId.values()];
}

function findMatch(bundle, eventId) {
  return allMatches(bundle).find((m) => String(m.id) === String(eventId)) || null;
}

function currentRankOf(player, rankingsByPlayer) {
  const id = player?.id ?? player?.teamId;
  const map = rankingsByPlayer || {};
  const fromMap = id != null ? map[String(id)] || map[id] : null;
  return fromMap?.current ?? player?.ranking ?? player?.currentRank ?? null;
}

function pickSide(match, rankingsByPlayer) {
  const home = match.homePlayer || { name: match.home, ranking: null };
  const away = match.awayPlayer || { name: match.away, ranking: null };
  const homeR = currentRankOf(home, rankingsByPlayer);
  const awayR = currentRankOf(away, rankingsByPlayer);
  if (homeR == null || awayR == null || homeR === awayR) return null;
  return homeR < awayR ? 'home' : 'away';
}

function bucketFromProduct(product) {
  const p = String(product || '').toLowerCase();
  if (p.includes('inplay') || p.includes('live')) return 'inplay';
  return 'prematch';
}

async function placeBatchOrders(userId, {
  orders = [],
  amountUsd,
  product = 'tennis',
  simulate = false,
  strategyKey: batchStrategyKey = null,
  bucket: batchBucket = null,
  orderType: batchOrderType = 'market',
  limitPrice: batchLimitPrice = null,
  limitBuyPrice: batchLimitBuyPrice = null,
  shares: batchShares = null,
  wallet = null,
} = {}) {
  if (!Array.isArray(orders) || !orders.length) {
    throw new Error('请至少选择一场');
  }
  if (orders.length > 20) {
    throw new Error('单次最多批量下单 20 场');
  }

  const orderType = String(batchOrderType || 'market').toLowerCase() === 'limit' ? 'limit' : 'market';
  let limitBuyPrice = null;
  let shares = null;
  let amount = Number(amountUsd);

  if (orderType === 'limit') {
    const buyRaw = batchLimitBuyPrice != null && batchLimitBuyPrice !== ''
      ? batchLimitBuyPrice
      : batchLimitPrice;
    const p = Number(buyRaw);
    if (!(p >= 0.01 && p <= 0.99)) {
      throw new Error('限价单须填写买入目标价（0.01–0.99）');
    }
    limitBuyPrice = Math.round(p * 100) / 100;
    shares = Math.floor(Number(batchShares) * 100) / 100;
    if (!(shares > 0)) throw new Error('限价单须填写份额');
    amount = Math.round(shares * limitBuyPrice * 100) / 100;
    if (!(amount >= 1)) {
      const minShares = Math.ceil((1 / limitBuyPrice) * 100) / 100;
      throw new Error(
        `限价买入金额 $${amount} 不足 $1（Polymarket 最低），请提高份额（当前价建议至少 ${minShares} 份）`,
      );
    }
  } else if (!(amount >= 1)) {
    throw new Error('每场投注金额至少 $1');
  }

  const isSim = !!simulate;
  const secrets = isSim ? null : (wallet || await btcWallet.loadWalletSecrets(userId));
  const tradeProduct = String(product || 'tennis').toLowerCase();
  const defaultBucket = batchBucket || bucketFromProduct(tradeProduct);
  const defaultSk = batchStrategyKey != null ? String(batchStrategyKey).trim().slice(0, 48) : '';
  let bundle;
  if (tradeProduct === 'tennis-prematch') {
    bundle = await tennisPrematchCache.getBundle();
  } else if (tradeProduct === 'tennis-range') {
    bundle = await tennisRangeCache.getBundle();
  } else if (tradeProduct === 'tennis-live') {
    bundle = await tennisLiveCache.getBundle();
  } else if (tradeProduct === 'tennis-inplay') {
    bundle = await tennisInplayCache.getBundle();
  } else if (tradeProduct === 'tennis-new') {
    bundle = await tennisNewCache.getBundle();
  } else if (tradeProduct === 'tennis-settled') {
    bundle = await tennisSettledCache.getBundle();
  } else {
    bundle = await tennisCache.getBundle();
  }
  if (!bundle) throw new Error('网球数据尚未就绪');

  const results = [];
  for (const item of orders) {
    const eventId = item?.eventId ?? item?.id;
    const side = String(item?.side || '').toLowerCase();
    if (!eventId) {
      results.push({ eventId: null, ok: false, error: '缺少 eventId' });
      continue;
    }
    if (!['home', 'away'].includes(side)) {
      results.push({ eventId, ok: false, error: '投注方向无效' });
      continue;
    }

    const match = findMatch(bundle, eventId);
    if (!match) {
      results.push({ eventId, ok: false, error: '未找到该场次' });
      continue;
    }

    const poly = bundle.polymarketByEvent?.[String(eventId)] || bundle.polymarketByEvent?.[eventId];
    if (!poly?.url) {
      results.push({ eventId, ok: false, error: '暂无 Polymarket 市场' });
      continue;
    }

    const homeName = match.homePlayer?.name || match.home || '';
    const awayName = match.awayPlayer?.name || match.away || '';

    const labelBase = `${homeName || '?'} vs ${awayName || '?'}`;
    const label = isSim ? `[模拟] ${labelBase}` : labelBase;

    try {
      if (isSim) {
        const orderId = `sim_${Date.now().toString(36)}_${String(eventId).slice(-6)}`;
        const simPrice = orderType === 'limit' ? limitBuyPrice : 1;
        const simShares = orderType === 'limit' ? shares : amount;
        try {
          await tradeRecords.addTradeRecord(userId, {
            product: tradeProduct,
            action: 'buy',
            market: String(eventId),
            side,
            amountUsd: amount,
            shares: simShares,
            price: simPrice,
            label,
            orderId,
            strategyKey: String(item?.strategyKey || defaultSk || '').trim() || null,
            bucket: item?.bucket || defaultBucket,
            ok: true,
          });
        } catch (err) {
          console.error('[tennis/trade] sim record', eventId, err.message || err);
        }
        results.push({
          eventId,
          ok: true,
          side,
          amountUsd: amount,
          price: simPrice,
          shares: simShares,
          homeName,
          awayName,
          orderId,
          simulated: true,
          status: 'simulated',
          orderType,
          takingAmount: String(simShares),
          makingAmount: '',
        });
        continue;
      }

      const { tokenId } = await polymarketTrade.getEventSideTokenId(
        poly.url,
        side,
        homeName,
        awayName
      );

      const result = orderType === 'limit'
        ? await polymarketTrade.placeLimitBuy({
          privateKey: secrets.privateKey,
          proxyAddress: secrets.proxyAddress,
          signatureType: secrets.signatureType,
          tokenId,
          shares,
          price: limitBuyPrice,
        })
        : await polymarketTrade.placeMarketBuy({
          privateKey: secrets.privateKey,
          proxyAddress: secrets.proxyAddress,
          signatureType: secrets.signatureType,
          tokenId,
          amountUsd: amount,
        });

      const orderId = result?.orderID || result?.id || result?.orderId || '';
      const price = orderType === 'limit'
        ? limitBuyPrice
        : tradeRecords.priceFromFill(result, { action: 'buy', amountUsd: amount });
      const fillShares = orderType === 'limit'
        ? (result?.size ?? shares)
        : tradeRecords.sharesFromFill(result, { action: 'buy', amountUsd: amount, price });
      try {
        await tradeRecords.addTradeRecord(userId, {
          product: tradeProduct,
          action: 'buy',
          market: String(eventId),
          side,
          amountUsd: amount,
          shares: fillShares,
          price,
          label,
          orderId,
          strategyKey: String(item?.strategyKey || defaultSk || '').trim() || null,
          bucket: item?.bucket || defaultBucket,
          ok: true,
        });
      } catch (err) {
        console.error('[tennis/trade] record', eventId, err.message || err);
      }

      results.push({
        eventId,
        ok: true,
        side,
        amountUsd: amount,
        price,
        shares: fillShares,
        homeName,
        awayName,
        orderId,
        status: result?.status || '',
        orderType,
        takingAmount: result?.takingAmount || '',
        makingAmount: result?.makingAmount || '',
      });
    } catch (e) {
      console.error('[tennis/trade]', eventId, e.message || e);
      try {
        await tradeRecords.addTradeRecord(userId, {
          product: tradeProduct,
          action: 'buy',
          market: String(eventId),
          side,
          amountUsd: amount,
          label,
          ok: false,
          error: e.message || '下单失败',
        });
      } catch { /* ignore */ }
      results.push({
        eventId,
        ok: false,
        side,
        error: e.message || '下单失败',
      });
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  const simTag = isSim ? '模拟' : '';
  const doneVerb = orderType === 'limit' ? '挂单' : (isSim ? '记账' : '成交');
  return {
    ok: okCount > 0,
    total: results.length,
    success: okCount,
    failed: results.length - okCount,
    simulated: isSim,
    orderType,
    results,
    message: okCount === 0
      ? `批量${simTag}下单失败，请查看错误详情`
      : okCount === results.length
        ? `批量${simTag}下单完成：${okCount} 场已${doneVerb}`
        : `批量${simTag}下单：${okCount} 场已${doneVerb}，${results.length - okCount} 场失败`,
  };
}

async function resolveBundle(product) {
  const tradeProduct = String(product || 'tennis').toLowerCase();
  if (tradeProduct === 'tennis-prematch') return tennisPrematchCache.getBundle();
  if (tradeProduct === 'tennis-range') return tennisRangeCache.getBundle();
  if (tradeProduct === 'tennis-live') return tennisLiveCache.getBundle();
  if (tradeProduct === 'tennis-inplay') return tennisInplayCache.getBundle();
  if (tradeProduct === 'tennis-new') return tennisNewCache.getBundle();
  if (tradeProduct === 'tennis-settled') return tennisSettledCache.getBundle();
  return tennisCache.getBundle();
}

/** 平仓（市价卖出全部持仓；限价时按卖出目标价挂 GTC） */
async function placeSellOrder(userId, {
  eventId,
  side,
  shares = 'all',
  product = 'tennis-inplay',
  simulate = false,
  orderType: sellOrderType = 'market',
  limitSellPrice = null,
  limitPrice = null,
  wallet = null,
} = {}) {
  const tradeProduct = String(product || 'tennis-inplay').toLowerCase();
  const sideKey = String(side || '').toLowerCase();
  if (!eventId) throw new Error('缺少 eventId');
  if (!['home', 'away'].includes(sideKey)) throw new Error('投注方向无效');

  const isSim = !!simulate;
  const orderType = String(sellOrderType || 'market').toLowerCase() === 'limit' ? 'limit' : 'market';
  let sellLimit = null;
  if (orderType === 'limit') {
    const p = Number(limitSellPrice != null && limitSellPrice !== '' ? limitSellPrice : limitPrice);
    if (!(p >= 0.01 && p <= 0.99)) {
      throw new Error('限价卖出须填写卖出目标价（0.01–0.99）');
    }
    sellLimit = Math.round(p * 100) / 100;
  }

  // 模拟卖出：不依赖 Redis 场次 / PM 外链（虚拟日联调常缺这两项）
  if (isSim) {
    let homeName = '';
    let awayName = '';
    try {
      const bundle = await resolveBundle(tradeProduct);
      const match = bundle ? findMatch(bundle, eventId) : null;
      if (match) {
        homeName = match.homePlayer?.name || match.home || '';
        awayName = match.awayPlayer?.name || match.away || '';
      }
    } catch (_) { /* ignore */ }
    const labelBase = (homeName || awayName)
      ? `${homeName || '?'} vs ${awayName || '?'}`
      : String(eventId);
    const label = `[模拟] ${labelBase}`;
    const orderId = `sim_sell_${Date.now().toString(36)}_${String(eventId).slice(-6)}`;
    try {
      await tradeRecords.addTradeRecord(userId, {
        product: tradeProduct,
        action: 'sell',
        market: String(eventId),
        side: sideKey,
        shares: null,
        label,
        orderId,
        ok: true,
      });
    } catch (err) {
      console.error('[tennis/trade] sim sell record', eventId, err.message || err);
    }
    return {
      ok: true,
      eventId: String(eventId),
      side: sideKey,
      simulated: true,
      orderId,
      soldShares: 'all',
      status: 'simulated',
      homeName,
      awayName,
    };
  }

  const secrets = wallet || await btcWallet.loadWalletSecrets(userId);
  const bundle = await resolveBundle(tradeProduct);
  if (!bundle) throw new Error('网球数据尚未就绪');

  const match = findMatch(bundle, eventId);
  if (!match) throw new Error('未找到该场次');

  const poly = bundle.polymarketByEvent?.[String(eventId)] || bundle.polymarketByEvent?.[eventId];
  if (!poly?.url) throw new Error('暂无 Polymarket 市场');

  const homeName = match.homePlayer?.name || match.home || '';
  const awayName = match.awayPlayer?.name || match.away || '';
  const label = `${homeName || '?'} vs ${awayName || '?'}`;

  const { tokenId } = await polymarketTrade.getEventSideTokenId(
    poly.url,
    sideKey,
    homeName,
    awayName
  );

  const sellShares = (shares === 'all' || shares == null || shares === '')
    ? undefined
    : Number(shares);

  const result = orderType === 'limit'
    ? await polymarketTrade.placeLimitSell({
      privateKey: secrets.privateKey,
      proxyAddress: secrets.proxyAddress,
      signatureType: secrets.signatureType,
      tokenId,
      shares: sellShares,
      price: sellLimit,
    })
    : await polymarketTrade.placeMarketSell({
      privateKey: secrets.privateKey,
      proxyAddress: secrets.proxyAddress,
      signatureType: secrets.signatureType,
      tokenId,
      shares: sellShares,
    });

  const orderId = result?.orderID || result?.id || result?.orderId || '';
  const price = orderType === 'limit'
    ? sellLimit
    : tradeRecords.priceFromFill(result, { action: 'sell' });
  const soldShares = orderType === 'limit'
    ? (result?.soldShares ?? sellShares)
    : tradeRecords.sharesFromFill(result, { action: 'sell', price });
  try {
    await tradeRecords.addTradeRecord(userId, {
      product: tradeProduct,
      action: 'sell',
      market: String(eventId),
      side: sideKey,
      amountUsd: price > 0 && soldShares > 0
        ? Math.round(price * soldShares * 100) / 100
        : null,
      shares: soldShares,
      price,
      label,
      orderId,
      ok: true,
    });
  } catch (err) {
    console.error('[tennis/sell] record', eventId, err.message || err);
  }

  return {
    ok: true,
    eventId: String(eventId),
    side: sideKey,
    orderId,
    soldShares,
    price,
    orderType,
    amountUsd: price > 0 && soldShares > 0
      ? Math.round(price * soldShares * 100) / 100
      : null,
    homeName,
    awayName,
    status: result?.status || '',
    takingAmount: result?.takingAmount || '',
    makingAmount: result?.makingAmount || '',
  };
}

module.exports = {
  placeBatchOrders,
  placeSellOrder,
  pickSide,
  findMatch,
};
