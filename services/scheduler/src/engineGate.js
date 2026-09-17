const { getJson } = require('./redis');

const ENGINES_KEY = 'tennis:engines:config';

async function getEnginesConfig() {
  return getJson(ENGINES_KEY);
}

async function engineGate(requireEngineOn) {
  if (!requireEngineOn) return { ok: true };
  const cfg = await getEnginesConfig();
  if (!cfg) return { ok: true };

  if (requireEngineOn === 'collect') {
    if (cfg.collect?.enabled === false) {
      return { ok: false, reason: 'collect engine off' };
    }
    return { ok: true };
  }
  if (requireEngineOn === 'betting') {
    if (cfg.betting?.enabled === false) {
      return { ok: false, reason: 'betting engine off' };
    }
    return { ok: true };
  }
  if (requireEngineOn === 'condition') {
    const buckets = cfg.condition?.buckets || {};
    const anyOn = ['prematch', 'inplay', 'settled'].some((k) => buckets[k]?.enabled);
    if (!anyOn) {
      return { ok: false, reason: 'condition buckets all off' };
    }
    return { ok: true };
  }
  return { ok: true };
}

module.exports = { engineGate, getEnginesConfig };
