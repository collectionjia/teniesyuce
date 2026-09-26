/**
 * Python 盘中采集开关：collect_live.py / refresh_inplay.py
 * 默认开启；关闭：TENNIS_PYTHON_COLLECT=0
 * 全量 collect.py 始终走 Python，不受此开关影响。
 */
function isEnabled() {
  const v = String(process.env.TENNIS_PYTHON_COLLECT || '1').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(v);
}

function blockReason(script = 'python collect') {
  return `Python 盘中采集已关闭（${script}）；恢复请设 TENNIS_PYTHON_COLLECT=1 或删除该变量`;
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
