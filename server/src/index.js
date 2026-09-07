/**
 * YUCE 后端入口：Express API + 启动时预热网球 Redis 缓存。
 * 数据流：tennis-monitor(9004) → server 刷 Redis → 前端只读 API。
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
app.use('/api/payments', paymentRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/embed', embedRoutes);
// 网球产品（列表 / 区间 / 盘中 / 新列表）
app.use('/api/tennis', tennisRoutes);
app.use('/api/btc', btcRoutes);
app.use('/api/trades', tradesRoutes);
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
  // 启动 5s 后从 tennis-monitor 拉 bundle 写入 Redis，并开后台定时刷新
  setTimeout(async () => {
    try {
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
        try {
          require('./services/tennisLiveFromMonitor').startBackgroundRefresh();
        } catch (_) {
          /* ignore */
        }
      }
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
