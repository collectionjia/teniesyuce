const { svc } = require('./serverBridge');

const ALLOWED = ['prematch', 'inplay', 'settled'];

async function getConditionConfig() {
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

async function assertBucketEnabled(bucket) {
  if (!ALLOWED.includes(bucket)) {
    return { ok: false, reason: `invalid bucket: ${bucket}` };
  }
  const cfg = await getConditionConfig();
  const b = cfg?.condition?.buckets?.[bucket];
  if (!b?.enabled) {
    return { ok: false, reason: `condition bucket ${bucket} off` };
  }
  return { ok: true, cfg, bucketCfg: b };
}

module.exports = { getConditionConfig, assertBucketEnabled, ALLOWED };
