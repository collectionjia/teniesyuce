/**
 * 盘后盈亏比：按 eventId+product 聚合成笔；盈利比/亏损比=笔数比。
 * 另按产品「投注买入条件」挂载的各条件组分别统计收益/损失。
 * 日界：北京时间结算完成日（此处用 created_at 的 Asia/Shanghai 自然日近似止损/成交日）。
 */
const pool = require('../db');

const PREMATCH_PRODUCTS = ['tennis-prematch', 'tennis-range', 'tennis-new', 'tennis'];
const INPLAY_PRODUCTS = ['tennis-inplay', 'tennis-live'];

function shanghaiDateKey(d) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(d instanceof Date ? d : new Date(d));
}

function emptyBlock() {
  return {
    settledCount: 0,
    winCount: 0,
    lossCount: 0,
    flatCount: 0,
    winRate: null,
    lossRate: null,
    totalStake: 0,
    totalPnl: 0,
  };
}

function finalizeBlock(b) {
  const n = b.settledCount;
  return {
    ...b,
    winRate: n > 0 ? b.winCount / n : null,
    lossRate: n > 0 ? b.lossCount / n : null,
  };
}

/**
 * 简化盈亏：同 eventId+product 下 buy 合计投入，sell 按 shares*price 回笼。
 * 返回全部有 buy 的仓位；统计块只计 hasBuy+hasSell。
 */
function aggregatePositions(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!r.ok) continue;
    const product = String(r.product || '').toLowerCase();
    const key = `${product}::${r.market || r.label || ''}`;
    if (!map.has(key)) {
      map.set(key, {
        product,
        eventKey: String(r.market || r.label || ''),
        stake: 0,
        proceeds: 0,
        hasBuy: false,
        hasSell: false,
        lastAt: r.created_at,
      });
    }
    const pos = map.get(key);
    const at = r.created_at;
    if (at && new Date(at) > new Date(pos.lastAt || 0)) pos.lastAt = at;
    if (r.action === 'buy') {
      pos.hasBuy = true;
      pos.stake += Number(r.amount_usd) || 0;
    } else if (r.action === 'sell') {
      pos.hasSell = true;
      const sh = Number(r.shares) || 0;
      const px = Number(r.price) || 0;
      pos.proceeds += sh * px;
    }
  }
  return [...map.values()].filter((p) => p.hasBuy);
}

function addToBlock(block, pos) {
  const pnl = pos.proceeds - pos.stake;
  block.settledCount += 1;
  block.totalStake += pos.stake;
  block.totalPnl += pnl;
  if (pnl > 0) block.winCount += 1;
  else if (pnl < 0) block.lossCount += 1;
  else block.flatCount += 1;
}

function scoreSide(m, side) {
  const block = side === 'home'
    ? (m.homeScore || m.home_score || m.score?.home || {})
    : (m.awayScore || m.away_score || m.score?.away || {});
  return block;
}

function periodScore(block, i) {
  if (block == null || typeof block !== 'object') return null;
  const key = `period${i}`;
  const setKey = `set${i}`;
  const n = Number(block[key] ?? block[setKey] ?? (Array.isArray(block.periods) ? block.periods[i - 1] : null));
  return Number.isFinite(n) ? n : null;
}

function isSetComplete(a, b) {
  if (a == null || b == null) return false;
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  if (hi >= 6 && hi - lo >= 2) return true;
  if (hi >= 7 && lo >= 5) return true;
  return false;
}

/** 完赛场次胜方 home|away|null */
function matchWinnerSide(m) {
  if (!m) return null;
  const w = String(m.winner || m.winnerCode || m.winner_code || '').toLowerCase();
  if (w === 'home' || w === '1' || w === 'h') return 'home';
  if (w === 'away' || w === '2' || w === 'a') return 'away';
  const hsRaw = m.homeScore ?? m.home_score;
  const asRaw = m.awayScore ?? m.away_score;
  if (typeof hsRaw === 'number' && typeof asRaw === 'number' && hsRaw !== asRaw) {
    return hsRaw > asRaw ? 'home' : 'away';
  }
  const hs = scoreSide(m, 'home');
  const as = scoreSide(m, 'away');
  const displayH = Number(hs?.display ?? hs?.current ?? hs);
  const displayA = Number(as?.display ?? as?.current ?? as);
  if (Number.isFinite(displayH) && Number.isFinite(displayA) && displayH !== displayA) {
    return displayH > displayA ? 'home' : 'away';
  }
  let homeSets = 0;
  let awaySets = 0;
  for (let i = 1; i <= 5; i++) {
    const h = periodScore(hs, i);
    const a = periodScore(as, i);
    if (h == null || a == null) break;
    if (!isSetComplete(h, a)) break;
    if (h > a) homeSets += 1;
    else if (a > h) awaySets += 1;
  }
  if (homeSets !== awaySets) return homeSets > awaySets ? 'home' : 'away';
  return null;
}

function pickStrongSide(m, rankings) {
  const home = m?.homePlayer || { name: m?.home };
  const away = m?.awayPlayer || { name: m?.away };
  const homeId = home?.id ?? home?.teamId;
  const awayId = away?.id ?? away?.teamId;
  const homeR = Number(
    (homeId != null ? (rankings?.[String(homeId)] || rankings?.[homeId])?.current : null)
    ?? home?.ranking ?? home?.currentRank,
  );
  const awayR = Number(
    (awayId != null ? (rankings?.[String(awayId)] || rankings?.[awayId])?.current : null)
    ?? away?.ranking ?? away?.currentRank,
  );
  if (!Number.isFinite(homeR) || !Number.isFinite(awayR) || homeR <= 0 || awayR <= 0) return null;
  return homeR < awayR ? 'home' : 'away';
}

function flattenSettledMatches(bundle) {
  const live = bundle?.live?.matches || [];
  if (live.length) return live;
  const tournaments = bundle?.scheduled?.tournaments || [];
  return tournaments.flatMap((t) =>
    (t.events || []).map((e) => ({
      ...e,
      tournament: e.tournament || t.name,
      level: e.level || t.level,
    })),
  );
}

async function listBettingRules() {
  const tennisEngines = require('./tennisEngines');
  const productService = require('./product');
  const tennisConditionApply = require('./tennisConditionApply');
  const cfg = await tennisEngines.getConfig();
  const out = [];
  const seen = new Set();
  for (const bucket of ['prematch', 'inplay']) {
    const product = await productService.findOnlineProductForBucket(bucket);
    const library = cfg.condition?.buckets?.[bucket]?.groups || [];
    const select = product?.bettingSelect || [];
    const resolved = tennisConditionApply.resolveGroupsFromProductSelect(library, select);
    for (let i = 0; i < resolved.length; i++) {
      const g = resolved[i];
      const id = String(g.id || `${bucket}-${i}`);
      const key = `${bucket}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id,
        key,
        bucket,
        name: g.name ? String(g.name) : `条件组 ${i + 1}`,
        group: g,
        productId: product?.id || null,
        productName: product?.name || null,
      });
    }
  }
  return out;
}

/**
 * 按投注规则（条件组）分别统计：
 * - trade：该规则能命中的已平仓真实成交盈亏
 * - paper：盘后列表中命中该规则的场次，按「强者方向」纸面胜负（单位 1）
 */
function computeRuleBreakdown(rules, matches, closedPos, bundle) {
  const tennisConditionApply = require('./tennisConditionApply');
  const rankings = bundle?.rankingsByPlayer || {};
  const closedByEvent = new Map();
  for (const pos of closedPos || []) {
    const id = String(pos.eventKey || '').trim();
    if (!id) continue;
    if (!closedByEvent.has(id)) closedByEvent.set(id, []);
    closedByEvent.get(id).push(pos);
  }

  return (rules || []).map((rule) => {
    const trade = emptyBlock();
    const paper = emptyBlock();
    for (const m of matches || []) {
      if (!tennisConditionApply.passGroup(m, rule.group, bundle)) continue;
      const strong = pickStrongSide(m, rankings);
      const winner = matchWinnerSide(m);
      if (strong && winner) {
        // 单位 1：赢回笼 2（PnL+1），亏回笼 0（PnL-1）
        addToBlock(paper, {
          stake: 1,
          proceeds: strong === winner ? 2 : 0,
          hasBuy: true,
          hasSell: true,
        });
      }
      const id = String(m.id);
      for (const pos of closedByEvent.get(id) || []) {
        const bucketOk = rule.bucket === 'prematch'
          ? PREMATCH_PRODUCTS.includes(pos.product)
          : INPLAY_PRODUCTS.includes(pos.product);
        if (!bucketOk || !pos.hasSell) continue;
        addToBlock(trade, pos);
      }
    }
    const useTrade = trade.settledCount > 0;
    const block = finalizeBlock(useTrade ? trade : paper);
    return {
      id: rule.id,
      key: rule.key,
      bucket: rule.bucket,
      name: rule.name,
      productId: rule.productId,
      productName: rule.productName,
      source: useTrade ? 'trade' : 'paper',
      ...block,
      trade: finalizeBlock(trade),
      paper: finalizeBlock(paper),
    };
  });
}

async function computeSettledStats(userId, { dateKey, bundle } = {}) {
  const day = dateKey || shanghaiDateKey(new Date());
  const products = [...PREMATCH_PRODUCTS, ...INPLAY_PRODUCTS];
  const placeholders = products.map(() => '?').join(',');
  const [rows] = await pool.query(
    `SELECT product, action, market, side, amount_usd, shares, price, label, ok, created_at
     FROM trade_records
     WHERE user_id=? AND ok=1
       AND product IN (${placeholders})
     ORDER BY created_at ASC`,
    [userId, ...products]
  );

  const allPos = aggregatePositions(rows || []);
  const dayPos = allPos.filter((p) => shanghaiDateKey(p.lastAt) === day);
  const closed = dayPos.filter((p) => p.hasSell);

  const total = emptyBlock();
  const prematch = emptyBlock();
  const inplay = emptyBlock();

  for (const pos of closed) {
    addToBlock(total, pos);
    if (PREMATCH_PRODUCTS.includes(pos.product)) addToBlock(prematch, pos);
    if (INPLAY_PRODUCTS.includes(pos.product)) addToBlock(inplay, pos);
  }

  /** 列表盈亏标记：有投注 / 已平仓盈亏；同 event 多 product 时合并（先 bet，再累加 pnl） */
  const pnlByEvent = {};
  const betEventIds = {};
  for (const pos of allPos) {
    const id = String(pos.eventKey || '').trim();
    if (!id) continue;
    betEventIds[id] = true;
    if (pos.hasSell) {
      const pnl = pos.proceeds - pos.stake;
      pnlByEvent[id] = (Number(pnlByEvent[id]) || 0) + pnl;
    }
  }

  let rules = [];
  try {
    const settledBundle = bundle || (await require('./tennisSettledCache').getBundle()) || {};
    const matches = flattenSettledMatches(settledBundle);
    const bettingRules = await listBettingRules();
    rules = computeRuleBreakdown(bettingRules, matches, closed, settledBundle);
  } catch (e) {
    console.warn('[tennis-settled-stats] rule breakdown', e.message);
  }

  return {
    ok: true,
    date: day,
    timezone: 'Asia/Shanghai',
    total: finalizeBlock(total),
    prematch: finalizeBlock(prematch),
    inplay: finalizeBlock(inplay),
    rules,
    pnlByEvent,
    betEventIds,
  };
}

module.exports = {
  computeSettledStats,
  shanghaiDateKey,
  PREMATCH_PRODUCTS,
  INPLAY_PRODUCTS,
  matchWinnerSide,
  listBettingRules,
  computeRuleBreakdown,
};
