/**
 * YUCE 后端入口：Express API。
 * 网球列表：collect.py → Redis → GET /api/tennis/today（默认不连 9004 monitor）。
 */
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
const tennisMonitorRoutes = require('./routes/tennisMonitor');
const tradesRoutes = require('./routes/trades');
const tennisRangeRoutes = require('./routes/tennisRange');
const tennisLiveRoutes = require('./routes/tennisLive');
const tennisNewRoutes = require('./routes/tennisNew');
const tennisInplayRoutes = require('./routes/tennisInplay');
const tennisPrematchRoutes = require('./routes/tennisPrematch');
const tennisSettledRoutes = require('./routes/tennisSettled');
const engineApiRoutes = require('./routes/engineApi');
const adminSchedulerRoutes = require('./routes/adminScheduler');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.get('/api/health', (_, res) => res.json({ ok: true }));

// 用户 / 订阅 / 支付
app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/agent', agentRoutes);
app.use('/api/admin', adminRoutes);
// 管理员：网球采集监控、BTC 看板配置
app.use('/api/admin/tennis-monitor', tennisMonitorRoutes);
app.use('/api/admin/btc-board', btcAdminRoutes);
app.use('/api/admin', adminSchedulerRoutes);
app.use('/api/engine', engineApiRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/embed', embedRoutes);
// 网球产品（盘前 / 盘中 / 盘后 + 旧 range/live/new 暂留）
app.use('/api/tennis', tennisRoutes);
app.use('/api/btc', btcRoutes);
app.use('/api/trades', tradesRoutes);
app.use('/api/tennis-prematch', tennisPrematchRoutes);
app.use('/api/tennis-inplay', tennisInplayRoutes);
app.use('/api/tennis-settled', tennisSettledRoutes);
app.use('/api/tennis-range', tennisRangeRoutes);
app.use('/api/tennis-live', tennisLiveRoutes);
app.use('/api/tennis-new', tennisNewRoutes);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: '服务器错误' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`API server running on http://localhost:${PORT}`);
  setTimeout(async () => {
    try {
      const tennisRedis = require('./services/tennisRedis');
      await tennisRedis.warmOnStartup();
      try {
        const schedulerLoop = require('./services/schedulerLoop');
        await schedulerLoop.start();
      } catch (err) {
        console.error('[scheduler] start failed:', err.message);
        try {
          const tennisInplayTickLoop = require('./services/tennisInplayTickLoop');
          tennisInplayTickLoop.start();
          console.warn('[scheduler] fallback: tennisInplayTickLoop started');
        } catch (e2) {
          console.error('[tennis/tick-loop] start failed:', e2.message);
        }
      }
      try {
        const engineApiKeys = require('./services/engineApiKeys');
        await engineApiKeys.ensureTable();
      } catch (err) {
        console.error('[engine-api-keys] ensure failed:', err.message);
      }
      try {
        const tennisThreeBuckets = require('./services/tennisThreeBuckets');
        const r = await tennisThreeBuckets.splitFullToThreeBuckets();
        if (r?.ok) console.log('[tennis/three-buckets] split on startup', r);
      } catch (err) {
        console.error('[tennis/three-buckets] startup split:', err.message);
      }
      if (!tennisRedis.monitorSyncEnabled()) return;

      const tennisFromMonitor = require('./services/tennisFromMonitor');
      await tennisFromMonitor.refreshRedisFromMonitor({ includeLive: true });
      tennisFromMonitor.startBackgroundRefresh();
      try {
        const tennisLiveFromMonitor = require('./services/tennisLiveFromMonitor');
        await tennisLiveFromMonitor.refreshLiveBundleFromMonitor();
        tennisLiveFromMonitor.startBackgroundRefresh();
        console.log('[tennis/live-cache] warmed from Sofascore monitor → Redis');
      } catch (err) {
        console.error('[tennis/live-cache] warm failed:', err.message);
      }
      console.log('[tennis/cache] monitor→redis sync enabled (TENNIS_SYNC_FROM_MONITOR=1)');
    } catch (err) {
      console.error('[tennis/cache] startup failed:', err.message);
    }
  }, 2000);
});
