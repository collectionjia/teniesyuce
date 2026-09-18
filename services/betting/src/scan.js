/**
 * 投注扫描：只读 rules matched 集 → 买入（mode=buy）
 */
const path = require('path');
const { svc, SERVER_ROOT } = require('./lib/serverBridge');
const { assertBettingEnabled, getBettingConfig } = require('./lib/engineGate');
const { readMatched } = require('./matchedReader');
const { isOpen, markPlaced } = require('./stateHelpers');

function productForBucket(bucket) {
  return bucket === 'prematch' ? 'tennis-prematch' : 'tennis-inplay';
}

function currentRank(player, rankingsByPlayer = {}) {
  const id = player?.id ?? player?.teamId;
  const fromMap = id != null ? rankingsByPlayer[String(id)] || rankingsByPlayer[id] : null;
  const n = Number(fromMap?.current ?? player?.ranking ?? player?.currentRank);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function pickStrongSide(m, rankings) {
  const home = m?.homePlayer || { name: m?.home };
  const away = m?.awayPlayer || { name: m?.away };
  const homeR = currentRank(home, rankings);
  const awayR = currentRank(away, rankings);
  if (homeR == null || awayR == null || homeR === awayR) return null;
  return homeR < awayR ? 'home' : 'away';
}

async function resolveUserIdFixed(cfg, bodyUserId) {
  const uidNum = Number(
    bodyUserId
    ?? cfg?.betting?.userId
    ?? process.env.TENNIS_BETTING_USER_ID
    ?? 0
  );
  if (uidNum) return uidNum;
  const account = cfg?.betting?.userAccount;
  if (!account) return 0;
  try {
    const pool = require(path.join(SERVER_ROOT, 'src/db'));
    const [[row]] = await pool.query(
      'SELECT id FROM users WHERE account=? LIMIT 1',
      [String(account).trim()]
    );
    return row?.id ? Number(row.id) : 0;
  } catch {
    return 0;
  }
}

async function scan(body = {}) {
  const gate = await assertBettingEnabled();
  if (!gate.ok) {
    return { skipped: true, message: gate.reason };
  }
  const cfg = gate.cfg || (await getBettingConfig());
  const sport = String(body.sport || 'tennis').toLowerCase();
  const onlyBucket = body.bucket ? String(body.bucket).toLowerCase() : null;
  const buckets = onlyBucket ? [onlyBucket] : ['prematch', 'inplay'];

  const uid = await resolveUserIdFixed(cfg, body.userId);
  if (!uid) {
    return { skipped: true, message: 'no engine user (betting.userAccount / userId)' };
  }

  const tennisBettingEngine = svc('tennisBettingEngine');
  const tennisTrade = svc('tennisTrade');
  const tennisDataSource = svc('tennisDataSource');
  const simulateGlobal = (await tennisDataSource.get()) === 'docks500' || !!cfg.betting?.simulate;

  let state;
  try {
    state = await tennisBettingEngine.loadState();
  } catch (e) {
    return { skipped: true, message: e.message || 'state load failed' };
  }

  let scanned = 0;
  let placed = 0;
  let skippedCount = 0;
  const errors = [];

  for (const bucket of buckets) {
    if (!['prematch', 'inplay'].includes(bucket)) continue;
    const bucketCfg = cfg.betting?.buckets?.[bucket];
    if (!bucketCfg?.enabled) continue;

    const matched = await readMatched(sport, bucket);
    const entries = matched?.matches || [];
    if (!entries.length) continue;

    const product = productForBucket(bucket);
    const simulate = simulateGlobal || !!bucketCfg.simulate;
    const cache = bucket === 'inplay'
      ? svc('tennisInplayCache')
      : svc('tennisPrematchCache');
    const bundle = await cache.getBundle();
    const rankings = bundle?.rankingsByPlayer || {};

    const byAmount = new Map();
    for (const entry of entries) {
      scanned += 1;
      const eventId = String(entry.eventId);
      const strategyKey = entry.groupId || entry.groupName || '_';
      if (isOpen(state, uid, product, eventId, strategyKey)) {
        skippedCount += 1;
        continue;
      }

      let side = null;
      const full = bundle && findMatchInBundle(bundle, bucket, eventId);
      if (full) side = pickStrongSide(full, rankings);
      if (!side) {
        skippedCount += 1;
        errors.push({ eventId, error: '无法确定投注侧' });
        continue;
      }

      const amountUsd = Number(entry.amountUsd ?? matched.amountUsd ?? cfg.betting?.amountUsd ?? 1) || 1;
      const key = String(amountUsd);
      if (!byAmount.has(key)) byAmount.set(key, []);
      byAmount.get(key).push({ eventId, side, strategyKey, amountUsd, entry });
    }

    for (const [, batch] of byAmount) {
      if (!batch.length) continue;
      const amountUsd = batch[0].amountUsd;
      try {
        const result = await tennisTrade.placeBatchOrders(uid, {
          orders: batch.map((o) => ({ eventId: o.eventId, side: o.side })),
          amountUsd,
          product,
          simulate,
          orderType: bucketCfg?.orderType || cfg.betting?.orderType || 'market',
          limitPrice: bucketCfg?.limitBuyPrice ?? bucketCfg?.limitPrice ?? cfg.betting?.limitBuyPrice ?? cfg.betting?.limitPrice,
          limitBuyPrice: bucketCfg?.limitBuyPrice ?? bucketCfg?.limitPrice ?? cfg.betting?.limitBuyPrice ?? cfg.betting?.limitPrice,
          shares: bucketCfg?.shares ?? cfg.betting?.shares,
        });
        const byId = new Map(batch.map((o) => [String(o.eventId), o]));
        for (const r of result.results || []) {
          const id = String(r.eventId);
          const meta = byId.get(id);
          if (r.ok) {
            placed += 1;
            const sh = Number(r.shares) || 0;
            markPlaced(state, uid, product, id, meta?.strategyKey, sh);
          } else {
            errors.push({ eventId: id, error: r.error || 'buy failed' });
          }
        }
      } catch (e) {
        errors.push({ bucket, error: e.message || String(e) });
      }
    }
  }

  try {
    await tennisBettingEngine.saveState(state);
  } catch (e) {
    return {
      skipped: true,
      message: e.message || 'state save failed',
      metrics: { scanned, placed, skipped: skippedCount, errors },
    };
  }

  if (scanned === 0 && placed === 0) {
    return {
      message: 'betting scan done',
      matched: 0,
      placed: 0,
      skipped: skippedCount,
      metrics: { scanned: 0, placed: 0, skipped: skippedCount, errors },
    };
  }

  return {
    message: 'betting scan done',
    metrics: { scanned, placed, skipped: skippedCount, errors },
  };
}

function findMatchInBundle(bundle, bucket, eventId) {
  const id = String(eventId);
  if (bucket === 'prematch') {
    for (const t of bundle.scheduled?.tournaments || []) {
      const m = (t.events || []).find((e) => String(e.id) === id);
      if (m) return m;
    }
    return null;
  }
  return (bundle.live?.matches || []).find((m) => String(m.id) === id) || null;
}

module.exports = { scan };
