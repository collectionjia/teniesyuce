const { svc } = require('./serverBridge');

async function getBettingConfig() {
  try {
    const tennisEngines = svc('tennisEngines');
    if (typeof tennisEngines.getConfigPreferRedis === 'function') {
      return tennisEngines.getConfigPreferRedis();
    }
    return tennisEngines.getConfig();
  } catch {
    const { getJson } = require('./redis');
    return getJson('tennis:engines:config');
  }
}

async function assertBettingEnabled() {
  const cfg = await getBettingConfig();
  if (cfg?.betting?.enabled === false) {
    return { ok: false, reason: 'betting engine off', cfg };
  }
  return { ok: true, cfg };
}

module.exports = { getBettingConfig, assertBettingEnabled };
