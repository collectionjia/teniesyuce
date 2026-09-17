#!/usr/bin/env node
const url = process.env.COLLECT_URL || 'http://host.docker.internal:9101';
(async () => {
  try {
    const h = await fetch(`${url}/health`);
    console.log('health', h.status, await h.text());
    const r = await fetch(`${url}/internal/collect/full`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sport: 'tennis', top100: true }),
    });
    console.log('full', r.status, await r.text());
  } catch (e) {
    console.error('ERR', e.cause?.code || e.message);
    process.exit(1);
  }
})();
