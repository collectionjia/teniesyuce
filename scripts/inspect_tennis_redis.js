const tennisCache = require('./src/services/tennisCache');

(async () => {
  const b = await tennisCache.getBundle();
  const poly = b.polymarketByEvent || {};
  const linked = Object.keys(poly).filter((k) => poly[k]?.url);
  console.log('poly count', linked.length);
  for (const id of linked) {
    const m = null; // find in tournaments
    let ev = null;
    for (const t of b.scheduled?.tournaments || []) {
      ev = (t.events || []).find((e) => String(e.id) === id);
      if (ev) break;
    }
    if (!ev) ev = (b.live?.matches || []).find((e) => String(e.id) === id);
    if (ev) {
      const h = ev.homePlayer?.rank ?? ev.homePlayer?.ranking;
      const a = ev.awayPlayer?.rank ?? ev.awayPlayer?.ranking;
      console.log(id, ev.home, 'vs', ev.away, 'status', ev.status, 'ranks', h, a, poly[id].url.slice(0, 60));
    }
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
