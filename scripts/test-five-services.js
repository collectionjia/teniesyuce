#!/usr/bin/env node
/**
 * 五服务 simulate 联调：虚拟三桶 → rules → betting → stop-loss
 * 用法: node scripts/test-five-services.js
 * 需 server/.env + 五服务已启动（scripts/dev-services.ps1）
 */
const path = require('path');

require(path.join(__dirname, '../server/node_modules/dotenv')).config({
  path: path.join(__dirname, '../server/.env'),
});

const BASE = {
  rules: process.env.RULES_URL || 'http://127.0.0.1:9102',
  betting: process.env.BETTING_URL || 'http://127.0.0.1:9103',
  stopLoss: process.env.STOP_LOSS_URL || 'http://127.0.0.1:9104',
};

const PERMISSIVE_GROUP = {
  tour: 'all',
  pm: 'all',
  strongRankMax: 200,
  gapMin: 0,
  rankDiffMax: 999,
  gapMode: 'all',
};

async function post(url, body = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const token = (process.env.INTERNAL_SERVICE_TOKEN || '').trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText || 'request failed');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function resolveUserId() {
  const pool = require('../server/src/db');
  const envId = Number(process.env.TENNIS_BETTING_USER_ID || 0);
  if (envId) return envId;
  const [[row]] = await pool.query('SELECT id, account FROM users ORDER BY id ASC LIMIT 1');
  if (!row?.id) {
    throw new Error('no users in DB — create one or set TENNIS_BETTING_USER_ID');
  }
  console.log(`[test] betting user: id=${row.id} account=${row.account}`);
  return Number(row.id);
}

async function main() {
  const tennisEngines = require('../server/src/services/tennisEngines');
  const tennisDataSource = require('../server/src/services/tennisDataSource');
  const tennisThreeBuckets = require('../server/src/services/tennisThreeBuckets');

  const userId = await resolveUserId();
  const prevCfg = await tennisEngines.getConfigPreferRedis();

  console.log('[test] enable simulate engines + docks500');
  await tennisDataSource.set('docks500');
  await tennisEngines.setConfig({
    collect: { enabled: true, inplay_tick_enabled: true },
    condition: {
      enabled: true,
      buckets: {
        prematch: { enabled: true, groups: [PERMISSIVE_GROUP] },
        inplay: { enabled: true, groups: [PERMISSIVE_GROUP] },
      },
    },
    betting: {
      enabled: true,
      userId,
      amountUsd: 1,
      buckets: {
        prematch: { enabled: true, simulate: true },
        inplay: { enabled: true, simulate: true },
      },
    },
  });

  console.log('[test] seed virtual prematch/inplay');
  const seed = await tennisThreeBuckets.seedVirtualPrematchInplay({
    prematchCount: 3,
    inplayCount: 2,
    forceRebuild: true,
  });
  if (!seed.ok) throw new Error(seed.error || 'seed failed');
  console.log('[test] seed ok', {
    date: seed.date,
    prematch: seed.prematch,
    inplay: seed.inplay,
  });

  const steps = [];

  for (const bucket of ['prematch', 'inplay']) {
    const rules = await post(`${BASE.rules}/internal/rules/evaluate`, { bucket });
    steps.push({ step: `rules.${bucket}`, rules: rules.matched ?? rules.metrics?.matched ?? rules });
    console.log(`[test] rules ${bucket}:`, JSON.stringify(rules));

    const bet = await post(`${BASE.betting}/internal/betting/scan`, { bucket });
    steps.push({ step: `betting.${bucket}`, bet });
    console.log(`[test] betting ${bucket}:`, JSON.stringify(bet));
  }

  const stop = await post(`${BASE.stopLoss}/internal/stop-loss/scan`, {});
  steps.push({ step: 'stop-loss', stop });
  console.log('[test] stop-loss:', JSON.stringify(stop));

  // 恢复引擎开关（保留 userId）
  await tennisEngines.setConfig({
    betting: { enabled: prevCfg.betting?.enabled ?? false },
    condition: { enabled: prevCfg.condition?.enabled ?? false },
  });

  const summary = {
    ok: true,
    seed: { date: seed.date, prematch: seed.prematch, inplay: seed.inplay },
    prematchMatched: steps.find((s) => s.step === 'rules.prematch')?.rules,
    inplayMatched: steps.find((s) => s.step === 'rules.inplay')?.rules,
    prematchPlaced: steps.find((s) => s.step === 'betting.prematch')?.bet?.metrics?.placed ?? 0,
    inplayPlaced: steps.find((s) => s.step === 'betting.inplay')?.bet?.metrics?.placed ?? 0,
    stopLoss: stop.skipped ? stop.message : stop.metrics,
  };
  console.log('\n=== summary ===');
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

main().catch((e) => {
  console.error('[test] failed:', e.message);
  if (e.data) console.error(e.data);
  process.exit(1);
});
