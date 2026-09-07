const { createClient } = require('redis');

let client = null;
let connectPromise = null;
let lastDisconnectLogAt = 0;

function isBenignDisconnect(msg) {
  const m = String(msg || '').toLowerCase();
  return (
    m.includes('socket closed unexpectedly')
    || m.includes('connection is closed')
    || m.includes('econnreset')
    || m.includes('etimedout')
  );
}

function logRedisIssue(err) {
  const msg = err?.message || String(err);
  if (isBenignDisconnect(msg)) {
    const now = Date.now();
    if (now - lastDisconnectLogAt > 60000) {
      lastDisconnectLogAt = now;
      console.warn('[redis] connection dropped (will auto-reconnect)');
    }
    return;
  }
  console.error('[redis]', msg);
}

async function getClient() {
  const url = (process.env.REDIS_URL || '').trim();
  if (!url) return null;

  if (!client) {
    client = createClient({
      url,
      socket: {
        connectTimeout: 10000,
        keepAlive: 15000,
        reconnectStrategy(retries) {
          if (retries > 30) return new Error('redis reconnect exhausted');
          return Math.min(retries * 200, 5000);
        },
      },
    });

    client.on('error', logRedisIssue);
    client.on('reconnecting', () => {
      console.warn('[redis] reconnecting…');
    });
    client.on('ready', () => {
      console.log('[redis] ready');
    });
  }

  if (client.isOpen) return client;

  if (!connectPromise) {
    connectPromise = client.connect()
      .then(() => client)
      .catch((err) => {
        logRedisIssue(err);
        return null;
      })
      .finally(() => {
        connectPromise = null;
      });
  }

  const c = await connectPromise;
  return c?.isOpen ? c : null;
}

module.exports = { getClient };
