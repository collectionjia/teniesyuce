/**
 * 整体采集：collect.top100（spawn collect.py）或 collect.full（拆三桶 + 迁移）
 */
const collectRunner = require('./collectRunner');
const { svc } = require('./lib/serverBridge');
const { assertCollectEnabled } = require('./lib/engineGate');

async function runFull(body = {}) {
  const sport = String(body.sport || 'tennis').toLowerCase();
  if (sport !== 'tennis') {
    return { skipped: true, message: `sport ${sport} not implemented (P2 tennis only)` };
  }

  const gate = await assertCollectEnabled();
  if (!gate.ok) {
    return { skipped: true, message: gate.reason };
  }

  const tennisDataSource = svc('tennisDataSource');
  const isVirtual = (await tennisDataSource.get()) === 'docks500';
  const tennisThreeBuckets = svc('tennisThreeBuckets');

  const isTop100 = body.top100 !== false && body.all !== true;

  if (isTop100) {
    if (isVirtual) {
      return { skipped: true, message: '虚拟(txt)模式跳过官网 Top100 采集' };
    }
    if (collectRunner.isRunning()) {
      return { skipped: true, message: 'collect.py already running' };
    }
    const started = collectRunner.startCollect({
      matchDate: body.matchDate || null,
      top100: body.top100 !== false,
    });
    if (!started.ok) {
      throw new Error(started.error || 'collect.top100 start failed');
    }
    return {
      message: 'collect.top100 started',
      metrics: started.last || {},
    };
  }

  if (isVirtual) {
    const r = await tennisThreeBuckets.seedVirtualPrematchInplay({
      txtName: body.txtName || '2026_500.txt',
      prematchCount: body.prematchCount,
      inplayCount: body.inplayCount,
    });
    if (!r.ok) throw new Error(r.error || 'virtual txt seed failed');
    return {
      message: r.message || 'collect.full virtual txt done',
      metrics: r,
    };
  }

  const split = await tennisThreeBuckets.splitFullToThreeBuckets();
  const migP = await tennisThreeBuckets.migratePrematchByStartTime();
  const migI = await tennisThreeBuckets.migrateInplayEnded();
  return {
    message: 'collect.full done',
    metrics: { split, migratePrematch: migP, migrateInplay: migI },
  };
}

module.exports = { runFull };
