require('dotenv').config();
const settings = require('../src/services/settings');

settings.setBtcCrawlEnabled(true)
  .then((ok) => {
    console.log('btc_crawl_enabled:', ok);
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
