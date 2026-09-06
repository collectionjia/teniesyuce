const tennisCache = require('./src/services/tennisCache');

(async () => {
  const b = await tennisCache.getBundle();
  console.log('rankings keys', Object.keys(b.rankingsByPlayer || {}).length);
  console.log('sample rank map', JSON.stringify(Object.entries(b.rankingsByPlayer || {}).slice(0, 2)));
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
