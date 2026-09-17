const { getJson } = require('./lib/redis');

function matchedKey(sport, bucket) {
  const s = String(sport || 'tennis').toLowerCase();
  if (s === 'tennis') return `tennis:rules:matched:${bucket}`;
  return `${s}:rules:matched:${bucket}`;
}

async function readMatched(sport, bucket) {
  return getJson(matchedKey(sport, bucket));
}

module.exports = { readMatched, matchedKey };
