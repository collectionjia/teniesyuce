const { createClient } = require('redis');

let client = null;
let connectPromise = null;

async function getClient() {
  const url = (process.env.REDIS_URL || '').trim();
  if (!url) return null;

  if (client?.isOpen) return client;

  if (!connectPromise) {
    connectPromise = (async () => {
      try {
        const c = createClient({ url });
        c.on('error', (err) => console.error('[redis]', err.message));
        await c.connect();
        client = c;
        console.log('[redis] connected');
        return client;
      } catch (err) {
        console.error('[redis] connect failed:', err.message);
        connectPromise = null;
        return null;
      }
    })();
  }

  return connectPromise;
}

module.exports = { getClient };
