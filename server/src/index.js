const path = require('path');
const express = require('express');
const cors = require('cors');

require('dotenv').config({
  path: process.env.ENV_FILE
    ? path.resolve(process.cwd(), process.env.ENV_FILE)
    : path.resolve(__dirname, '..', '.env'),
});

const authRoutes = require('./routes/auth');
const productRoutes = require('./routes/products');
const subscriptionRoutes = require('./routes/subscriptions');
const agentRoutes = require('./routes/agent');
const adminRoutes = require('./routes/admin');

const paymentRoutes = require('./routes/payments');
const settingsRoutes = require('./routes/settings');
const embedRoutes = require('./routes/embed');
const tennisRoutes = require('./routes/tennis');
const btcRoutes = require('./routes/btc');
const btcAdminRoutes = require('./routes/btcAdmin');
const sofaMonitorRoutes = require('./routes/sofaMonitor');
const dotaRoutes = require('./routes/dota');
const nbaRoutes = require('./routes/nba');
const dota2Routes = require('./routes/dota2');
const tradesRoutes = require('./routes/trades');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.get('/api/health', (_, res) => res.json({ ok: true }));

app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/agent', agentRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin/sofa-monitor', sofaMonitorRoutes);
app.use('/api/admin/btc-board', btcAdminRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/embed', embedRoutes);
app.use('/api/tennis', tennisRoutes);
app.use('/api/btc', btcRoutes);
app.use('/api/dota', dotaRoutes);
app.use('/api/nba', nbaRoutes);
app.use('/api/dota2', dota2Routes);
app.use('/api/trades', tradesRoutes);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: '服务器错误' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`API server running on http://localhost:${PORT}`);
  setTimeout(async () => {
    try {
      const tennisFromMonitor = require('./services/tennisFromMonitor');
      await tennisFromMonitor.refreshRedisFromMonitor({ includeLive: true });
      tennisFromMonitor.startBackgroundRefresh();
      console.log('[tennis/cache] warmed from Sofascore monitor → Redis');
    } catch (err) {
      console.error('[tennis/cache] warm failed:', err.message);
      try {
        require('./services/tennisFromMonitor').startBackgroundRefresh();
      } catch (_) {
        /* ignore */
      }
    }
  }, 5000);
});
