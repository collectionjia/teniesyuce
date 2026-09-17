/**
 * 规则评估：读三桶 → 条件筛选 → 写 matched 集
 */
const { svc } = require('./lib/serverBridge');
const { assertBucketEnabled } = require('./lib/engineGate');
const { writeMatched } = require('./matchedStore');

function countBundle(bucket, bundle) {
  if (!bundle) return 0;
  if (bucket === 'prematch') {
    return Number(bundle.scheduled?.eventCount || bundle.events || 0);
  }
  return Number(bundle.live?.eventCount || bundle.events || (bundle.live?.matches || []).length || 0);
}

function extractMatches(bucket, bundle) {
  if (!bundle) return [];
  if (bucket === 'prematch') {
    const list = [];
    for (const t of bundle.scheduled?.tournaments || []) {
      for (const e of t.events || []) list.push(e);
    }
    return list;
  }
  return [...(bundle.live?.matches || [])];
}

function slimMatch(m) {
  return {
    id: m.id,
    home: m.home,
    away: m.away,
    tour: m.tour,
    startTime: m.startTime,
    statusType: m.statusType || m.status?.type,
  };
}

function assignGroups(matches, groups, bundle, passGroup, amountUsd, bucket) {
  const out = [];
  const seen = new Set();
  for (const m of matches) {
    const id = m?.id;
    if (id == null) continue;
    const sid = String(id);
    if (seen.has(sid)) continue;
    for (let i = 0; i < groups.length; i += 1) {
      const g = groups[i];
      if (passGroup(m, g, bundle)) {
        seen.add(sid);
        out.push({
          eventId: sid,
          groupId: g.id || null,
          groupIndex: i,
          groupName: g.name || '',
          amountUsd,
          bucket,
          match: slimMatch(m),
        });
        break;
      }
    }
  }
  return out;
}

async function evaluate(body = {}) {
  const bucket = String(body.bucket || '').toLowerCase();
  const sport = String(body.sport || 'tennis').toLowerCase();
  const groupIndex = body.groupIndex != null ? Number(body.groupIndex) : null;
  const groupName = body.groupName || null;

  if (!bucket) {
    const err = new Error('bucket required (prematch|inplay|settled)');
    err.status = 400;
    throw err;
  }

  const gate = await assertBucketEnabled(bucket);
  if (!gate.ok) {
    return { skipped: true, message: gate.reason };
  }

  let groups = gate.bucketCfg?.groups || [];
  if (groupIndex != null && groups[groupIndex]) {
    groups = [groups[groupIndex]];
  }
  if (!groups.length) {
    return { skipped: true, message: 'no condition groups' };
  }

  const caches = {
    prematch: svc('tennisPrematchCache'),
    inplay: svc('tennisInplayCache'),
    settled: svc('tennisSettledCache'),
  };
  const cache = caches[bucket];
  if (!cache) {
    return { skipped: true, message: `unknown bucket ${bucket}` };
  }

  const tennisConditionApply = svc('tennisConditionApply');
  const bundle = await cache.getBundle();
  const before = countBundle(bucket, bundle);
  if (!bundle) {
    return {
      skipped: true,
      message: 'no bundle in cache',
      metrics: { bucket, before: 0, after: 0, matched: 0 },
    };
  }

  const useBucket = { enabled: true, groups };
  let filtered = bundle;
  if (bucket === 'prematch') {
    filtered = tennisConditionApply.applyToPrematchBundle(bundle, useBucket);
  } else {
    filtered = tennisConditionApply.applyToInplayBundle(bundle, useBucket);
  }
  const after = countBundle(bucket, filtered);

  const cfg = gate.cfg || {};
  const amountUsd = Number(body.amountUsd ?? cfg.betting?.amountUsd ?? 1);
  const rawMatches = extractMatches(bucket, filtered);
  const matched = assignGroups(
    rawMatches,
    groups,
    bundle,
    tennisConditionApply.passGroup,
    amountUsd,
    bucket
  );

  const evaluatedAt = new Date().toISOString();
  await writeMatched(sport, bucket, {
    sport,
    bucket,
    evaluatedAt,
    groupIndex,
    groupName,
    amountUsd,
    matches: matched,
  });

  return {
    message: 'rules evaluate done',
    metrics: {
      bucket,
      sport,
      before,
      after,
      matched: matched.length,
      groupName,
      groupIndex,
      evaluatedAt,
    },
  };
}

module.exports = { evaluate, countBundle, extractMatches };
