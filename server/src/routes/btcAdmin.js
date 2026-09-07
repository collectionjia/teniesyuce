const express = require("express");
const { auth } = require("../middleware/auth");

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

router.use(auth(["admin"]));

router.get("/crawl", async (_req, res) => {
  try {
    const result = await boardFetch("/api/crawl");
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error("[btc-board/crawl GET]", err);
    res.status(502).json({ success: false, error: err.message || "board unreachable" });
  }
});

router.post("/crawl", async (req, res) => {
  try {
    const enabled = !!req.body?.enabled;
    const result = await boardFetch("/api/crawl", { method: "POST", body: { enabled } });
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error("[btc-board/crawl POST]", err);
    res.status(502).json({ success: false, error: err.message || "board unreachable" });
  }
});

router.get("/state", async (_req, res) => {
  try {
    const result = await boardFetch("/api/state");
    if (result.status >= 400) {
      return res.status(result.status).json(result.body);
    }
    res.json({ ...result.body, ok: true, member: true });
  } catch (err) {
    console.error("[btc-board/state]", err);
    res.status(502).json({ ok: false, error: err.message || "board unreachable" });
  }
});

module.exports = router;
