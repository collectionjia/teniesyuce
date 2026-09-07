const express = require("express");
const { auth } = require("../middleware/auth");
const settings = require("../services/settings");

const router = express.Router();
const BOARD_BASE = (process.env.BOARD_INTERNAL_URL || "http://btc-board:8890").replace(/\/$/, "");

async function boardFetch(pathname, { method = "GET", body } = {}) {
  const url = `${BOARD_BASE}${pathname}`;
  const opts = {
    method,
    headers: { Accept: "application/json", "Content-Type": "application/json" },
  };
  if (body != null) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { success: false, error: text || `HTTP ${res.status}` };
  }
  return { status: res.status, body: data };
}

async function syncBoardCrawl(enabled) {
  try {
    await boardFetch("/api/crawl", { method: "POST", body: { enabled } });
  } catch (err) {
    console.warn("[btc-board/crawl] board sync failed:", err.message || err);
  }
}

router.use(auth(["admin"]));

router.get("/crawl", async (_req, res) => {
  try {
    const enabled = await settings.getBtcCrawlEnabled();
    res.json({ success: true, enabled });
  } catch (err) {
    console.error("[btc-board/crawl GET]", err);
    res.status(500).json({ success: false, error: err.message || "read failed" });
  }
});

router.post("/crawl", async (req, res) => {
  try {
    const enabled = !!req.body?.enabled;
    await settings.setBtcCrawlEnabled(enabled);
    await syncBoardCrawl(enabled);
    res.json({ success: true, enabled: await settings.getBtcCrawlEnabled() });
  } catch (err) {
    console.error("[btc-board/crawl POST]", err);
    res.status(500).json({ success: false, error: err.message || "save failed" });
  }
});

router.get("/state", async (_req, res) => {
  try {
    const enabled = await settings.getBtcCrawlEnabled();
    if (!enabled) {
      return res.json({
        ok: true,
        member: true,
        crawl_enabled: false,
        message: "BTC 数据采集已关闭",
      });
    }
    const result = await boardFetch("/api/state");
    if (result.status >= 400) {
      return res.status(result.status).json(result.body);
    }
    res.json({ ...result.body, ok: true, member: true, crawl_enabled: true });
  } catch (err) {
    console.error("[btc-board/state]", err);
    res.status(502).json({ ok: false, error: err.message || "board unreachable" });
  }
});

module.exports = router;
