/**
 * 盘中 tick 单次执行（定时调度已移除，仅保留手动触发入口）
 */
const tennisInplayTick = require('./tennisInplayTick');

let running = false;

async function tickOnce() {
  if (running) return;
  running = true;
  try {
    await tennisInplayTick.runInplayTick();
  } catch (e) {
    console.error('[tennis/tick-loop]', e.message || e);
  } finally {
    running = false;
  }
}

function start() {}

async function resyncFromConfig() {}

module.exports = { start, resyncFromConfig, tickOnce };
