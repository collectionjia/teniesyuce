const { setJson, getJson } = require('./lib/redis');

function matchedKey(sport, bucket) {
  const s = String(sport || 'tennis').toLowerCase();
  if (s === 'tennis') return `tennis:rules:matched:${bucket}`;
  return `${s}:rules:matched:${bucket}`;
}

async function writeMatched(sport, bucket, payload) {
  await setJson(matchedKey(sport, bucket), payload, Number(process.env.RULES_MATCHED_TTL_SEC || 86400));
}

async function readMatched(sport, bucket) {
  return getJson(matchedKey(sport, bucket));
}

module.exports = { writeMatched, readMatched, matchedKey };
