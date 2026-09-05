const tennisCache = require('./tennisCache');
const tennisRangeCache = require('./tennisRangeCache');
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

async function placeBatchOrders(userId, { orders = [], amountUsd, product = 'tennis' } = {}) {
  if (!Array.isArray(orders) || !orders.length) {
    throw new Error('请至少选择一场');
  }
  if (orders.length > 20) {
    throw new Error('单次最多批量下单 20 场');
  }

  const amount = Number(amountUsd);
  if (!(amount >= 1)) throw new Error('每场投注金额至少 $1');

  const secrets = await btcWallet.loadWalletSecrets(userId);
  const tradeProduct = String(product || 'tennis').toLowerCase();
  const bundle = tradeProduct === 'tennis-range'
    ? await tennisRangeCache.getBundle()
    : await tennisCache.getBundle();
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
    const suggested = pickSide(match, bundle.rankingsByPlayer);
    if (suggested && side !== suggested) {
      results.push({ eventId, ok: false, error: '仅支持按建议侧下单' });
      continue;
    }

    try {
      const { tokenId } = await polymarketTrade.getEventSideTokenId(
        poly.url,
        side,
        homeName,
        awayName
      );

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
      const label = `${homeName || '?'} vs ${awayName || '?'}`;
      try {
        await tradeRecords.addTradeRecord(userId, {
          product: tradeProduct,
          action: 'buy',
          market: String(eventId),
          side,
          amountUsd: amount,
          shares,
          price,
          label,
          orderId,
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
        homeName,
        awayName,
        orderId,
        status: result?.status || '',
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
          label: `${homeName || '?'} vs ${awayName || '?'}`,
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
  return {
    ok: okCount > 0,
    total: results.length,
    success: okCount,
    failed: results.length - okCount,
    results,
    message: okCount === 0
      ? '批量下单失败，请查看错误详情'
      : okCount === results.length
        ? `批量下单完成：${okCount} 场已成交`
        : `批量下单：${okCount} 场已成交，${results.length - okCount} 场失败`,
  };
}

module.exports = {
  placeBatchOrders,
  pickSide,
  findMatch,
};
