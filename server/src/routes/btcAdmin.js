const express = require("express");
const { auth } = require("../middleware/auth");
const settings = require("../services/settings");
const btcApiKeys = require("../services/btcApiKeys");

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

async function syncBoardKeys(plain) {
  try {
    const result = await boardFetch("/api/runtime-keys", {
      method: "POST",
      body: {
        ALCHEMY_KEY: plain.alchemyKey || "",
        QUICK_PRIVATE_KEY: plain.privateKey || "",
        QUICK_FUNDER: plain.funder || "",
        QUICK_RELAYER_API_KEY: plain.relayerKey || "",
        QUICK_RELAYER_API_KEY_ADDRESS: plain.relayerAddr || "",
      },
    });
    if (result.status >= 400) {
      return { ok: false, error: result.body?.error || result.body?.message || `HTTP ${result.status}` };
    }
    return { ok: true, ...(result.body || {}) };
  } catch (err) {
    return { ok: false, error: err.message || "board unreachable" };
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

router.get("/keys", async (_req, res) => {
  try {
    const data = await btcApiKeys.getPublicStatus();
    res.json({ success: true, ...data });
  } catch (err) {
    console.error("[btc-board/keys GET]", err);
    res.status(500).json({ success: false, error: err.message || "read failed" });
  }
});

router.put("/keys", async (req, res) => {
  try {
    const data = await btcApiKeys.saveFromBody(req.body || {});
    const plain = await btcApiKeys.getPlainForBoardSync();
    const sync = await syncBoardKeys(plain);
    res.json({
      success: true,
      ...data,
      boardSynced: !!sync.ok,
      boardSyncError: sync.ok ? null : sync.error || "sync failed",
      message: sync.ok
        ? "已保存并同步到 btc-board"
        : `已保存到数据库；同步 btc-board 失败：${sync.error || "unknown"}（可稍后重启容器）`,
    });
  } catch (err) {
    console.error("[btc-board/keys PUT]", err);
    res.status(400).json({ success: false, error: err.message || "save failed" });
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
