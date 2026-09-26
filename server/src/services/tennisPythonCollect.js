/**
 * Python 采集开关：collect.py / collect_live.py / refresh_inplay.py
 * 默认关闭；恢复：TENNIS_PYTHON_COLLECT=1
 */
function isEnabled() {
  const v = String(process.env.TENNIS_PYTHON_COLLECT || '0').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(v);
}

function blockReason(script = 'python collect') {
  return `Python 采集已暂停（${script}）；恢复请设 TENNIS_PYTHON_COLLECT=1`;
}

function blockedResponse(script, extra = {}) {
  return {
    ok: false,
    skipped: true,
    status: 503,
    error: blockReason(script),
    reason: 'python_collect_disabled',
    ...extra,
  };
}

module.exports = { isEnabled, blockReason, blockedResponse };
