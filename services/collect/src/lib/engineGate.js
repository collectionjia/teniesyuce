const { getJson } = require('./redis');
const { svc } = require('./serverBridge');

async function getCollectConfig() {
  try {
    const tennisEngines = svc('tennisEngines');
    if (typeof tennisEngines.getConfigPreferRedis === 'function') {
      return tennisEngines.getConfigPreferRedis();
    }
    return tennisEngines.getConfig();
  } catch {
    return getJson('tennis:engines:config');
  }
}

async function assertCollectEnabled() {
  const cfg = await getCollectConfig();
  if (cfg?.collect?.enabled === false) {
    return { ok: false, reason: 'collect engine off' };
  }
  return { ok: true, cfg };
}

module.exports = { getCollectConfig, assertCollectEnabled };
