/**
 * 盘后盈亏比：按 eventId+product 聚合成笔；盈利比/亏损比=笔数比。
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

async function computeSettledStats(userId, { dateKey } = {}) {
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

  return {
    ok: true,
    date: day,
    timezone: 'Asia/Shanghai',
    total: finalizeBlock(total),
    prematch: finalizeBlock(prematch),
    inplay: finalizeBlock(inplay),
    pnlByEvent,
    betEventIds,
  };
}

module.exports = {
  computeSettledStats,
  shanghaiDateKey,
  PREMATCH_PRODUCTS,
  INPLAY_PRODUCTS,
};
