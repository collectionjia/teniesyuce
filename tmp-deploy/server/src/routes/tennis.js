const { Router } = require("express");
const { auth } = require("../middleware/auth");
const tennisCache = require("../services/tennisCache");
const tennisFromMonitor = require("../services/tennisFromMonitor");
const btcWallet = require("../services/btcWallet");
const tennisTrade = require("../services/tennisTrade");

const router = Router();

async function requireWallet(req, res, next) {
  try {
    const ok = await btcWallet.userHasWalletAccess(req.user);
    if (!ok) return res.status(403).json({ error: "未开通 BTC 虚拟投注权限，无法批量下单" });
    next();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "权限校验失败" });
  }
}

/**
 * 前端只读 Redis 快照；不在用户请求时触发监控刷新。
 */
router.get("/today", auth(), async (_req, res) => {
  try {
    const full = await tennisCache.getBundle();
    if (!full) {
      return res.status(503).json({
        ok: false,
        error: "网球数据尚未就绪，请稍后再试",
      });
    }
    res.json({ ...full, member: true, readFrom: 'redis' });
  } catch (err) {
    console.error("[tennis/today]", err);
    res.status(500).json({
      ok: false,
      error: err.message || "failed to load tennis data",
    });
  }
});

router.post("/cache/refresh", auth(["admin"]), async (_req, res) => {
  try {
    const tennisDataSource = require("../services/tennisDataSource");
    const bundle = await tennisFromMonitor.refreshRedisFromMonitor({ includeLive: true });
    res.json({
      ok: true,
      events: bundle.events,
      date: bundle.date,
      fetched_at: bundle.fetched_at,
      live: bundle.live?.eventCount ?? 0,
      dataSource: bundle.dataSource || (await tennisDataSource.get()),
      upstream: bundle.upstream || bundle.source,
      readFrom: "redis",
    });
  } catch (err) {
    console.error("[tennis/cache/refresh]", err);
    res.status(500).json({ ok: false, error: err.message || "cache refresh failed" });
  }
});

/** 批量 Polymarket 下单（需已配置钱包） */
router.post("/trade/batch", auth(), requireWallet, async (req, res) => {
  try {
    const { orders, amountUsd } = req.body || {};
    const result = await tennisTrade.placeBatchOrders(req.user.id, { orders, amountUsd });
    res.json(result);
  } catch (e) {
    console.error("[tennis/trade/batch]", e);
    res.status(400).json({ ok: false, error: e.message || "批量下单失败" });
  }
});

module.exports = router;
