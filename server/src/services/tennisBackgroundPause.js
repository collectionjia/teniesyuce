/** 全量采集期间暂停 B/C 增量写，避免整桶替换与 patch 互踩 */
let depth = 0;
let reason = '';

function pauseTennisBackgroundRefresh(why = 'full-collect') {
  depth += 1;
  reason = why || reason;
}

function resumeTennisBackgroundRefresh() {
  depth = Math.max(0, depth - 1);
  if (depth === 0) reason = '';
}

function isTennisBackgroundRefreshPaused() {
  return depth > 0;
}

function pauseReason() {
  return reason;
}

module.exports = {
  pauseTennisBackgroundRefresh,
  resumeTennisBackgroundRefresh,
  isTennisBackgroundRefreshPaused,
  pauseReason,
};
