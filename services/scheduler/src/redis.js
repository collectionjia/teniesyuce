const { createClient } = require('redis');

let client = null;

async function getClient() {
  const url = (process.env.REDIS_URL || '').trim();
  if (!url) return null;
  if (!client) {
    client = createClient({ url });
    client.on('error', (err) => {
      console.error('[scheduler/redis]', err.message);
    });
    await client.connect();
  }
  return client;
}

async function getJson(key) {
  const c = await getClient();
  if (!c) return null;
  const raw = await c.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

module.exports = { getClient, getJson };
