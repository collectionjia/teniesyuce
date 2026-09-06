require('./src/services/tennisFromMonitor')
  .refreshRedisFromMonitor({ includeLive: true })
  .then((b) => {
    const p = b.polymarketByEvent || {};
    const linked = Object.keys(p).filter((k) => p[k] && p[k].url).length;
    console.log(JSON.stringify({ events: b.events, live: b.live?.eventCount, poly: linked }));
    process.exit(0);
  })
  .catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
