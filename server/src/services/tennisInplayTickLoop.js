/**
 * 盘中 tick 后台循环（按管理员配置间隔）
 */
const tennisEngines = require('./tennisEngines');
const tennisInplayTick = require('./tennisInplayTick');

let timer = null;
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

async function resyncFromConfig() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  const cfg = await tennisEngines.getConfig();
  if (cfg.collect?.enabled === false || cfg.collect?.inplay_tick_enabled === false) {
    console.log('[tennis/tick-loop] stopped');
    return;
  }
  let sec = Number(cfg.collect?.inplay_tick_interval_sec || 5);
  if (![1, 2, 5, 10].includes(sec)) sec = 5;
  timer = setInterval(tickOnce, sec * 1000);
  console.log(`[tennis/tick-loop] every ${sec}s`);
  setTimeout(tickOnce, 2000);
}

function start() {
  resyncFromConfig().catch((e) => console.error('[tennis/tick-loop] start', e.message));
}

module.exports = { start, resyncFromConfig, tickOnce };
