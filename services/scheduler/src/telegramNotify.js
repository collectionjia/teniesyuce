const path = require('path');

let mod = null;

function load() {
  if (mod) return mod;
  const root = process.env.SERVER_ROOT || path.resolve(__dirname, '../../../server');
  mod = require(path.join(root, 'src/services/schedulerTelegram'));
  return mod;
}

function fireTelegramNotify(ctx) {
  void load().notifyRun(ctx).catch((e) => {
    console.warn('[scheduler/telegram]', e?.message || e);
  });
}

module.exports = { fireTelegramNotify };
