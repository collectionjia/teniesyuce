const path = require('path');

/**
 * 过渡期：EXECUTOR_MODE=legacy 时调用 server 内嵌 schedulerRunner（仅本机 dev）
 */
let legacyRunner = null;

function loadLegacyRunner() {
  if (legacyRunner) return legacyRunner;
  const root = process.env.SERVER_ROOT || path.resolve(__dirname, '../../../server');
  legacyRunner = require(path.join(root, 'src/services/schedulerRunner'));
  return legacyRunner;
}

async function executeJobTypeLegacy(job, params = {}) {
  const { executeJobType } = loadLegacyRunner();
  return executeJobType(job, params);
}

module.exports = { executeJobTypeLegacy };
