/**
 * Shared Polymarket sports catalog proxy (NBA / DOTA2 scrapers).
 */
const pool = require("../db");

function createSportsPolyRouter({
  envUrlKey,
  defaultUrl,
  productTag,
  productNameHints,
  sportLabel,
}) {
  const { Router } = require("express");
  const { auth } = require("../middleware/auth");
  const router = Router();

  function baseUrl() {
    return String(process.env[envUrlKey] || defaultUrl).replace(/\/$/, "");
  }

  async function fetchUpstream(path) {
    const res = await fetch(`${baseUrl()}${path}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`${sportLabel} upstream HTTP ${res.status}`);
    return res.json();
  }

  async function userHasAccess(user) {
    if (!user) return false;
    if (user.role === "admin") return true;
    const hints = productNameHints || [];
    const nameConds = hints.map(() => "name LIKE ?").join(" OR ");
    const params = [productTag, ...hints.map((h) => `%${h}%`)];
    const [products] = await pool.query(
      `SELECT id FROM products
       WHERE online = 1 AND (
         LOWER(tag) = ?
         ${nameConds ? `OR (${nameConds})` : ""}
       )`,
      params,
    );
    if (!products.length) return false;
    const ids = products.map((p) => p.id);
    const placeholders = ids.map(() => "?").join(",");
    const [subs] = await pool.query(
      `SELECT product_id FROM subscriptions
       WHERE user_id = ? AND product_id IN (${placeholders}) AND expiry_at > NOW()
       LIMIT 1`,
      [user.id, ...ids],
    );
    return subs.length > 0;
  }

  function slimEvent(e) {
    return {
      id: e.id,
      slug: e.slug,
      title: e.title,
      outcomes: e.outcomes || [],
      startDate: e.startDate,
      endDate: e.endDate,
      closed: !!e.closed,
      active: e.active !== false,
    };
  }

  function fullEvent(e) {
    return {
      ...slimEvent(e),
      url: e.url,
      prices: e.prices,
      cents: e.cents,
      volume: e.volume,
      question: e.question,
    };
  }

  router.get("/health", auth(), async (_req, res) => {
    try {
      const data = await fetchUpstream("/api/health");
      res.json(data);
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message || "upstream error" });
    }
  });

  router.get("/events", auth(), async (req, res) => {
    try {
      const q = String(req.query.q || "").trim();
      const qs = q ? `?q=${encodeURIComponent(q)}` : "";
      const data = await fetchUpstream(`/api/events${qs}`);
      const member = await userHasAccess(req.user);
      const events = (data.events || []).map((e) => (member ? fullEvent(e) : slimEvent(e)));
      res.json({
        ok: true,
        sport: data.sport || sportLabel,
        tag: data.tag,
        updatedAt: data.updatedAt,
        count: events.length,
        member,
        message: member ? undefined : "非会员预览（隐藏价格与外链）",
        events,
      });
    } catch (e) {
      console.error(`[${sportLabel}/events]`, e.message || e);
      res.status(502).json({ ok: false, error: e.message || "加载失败" });
    }
  });

  router.post("/refresh", auth(["admin"]), async (_req, res) => {
    try {
      const data = await fetch(`${baseUrl()}/api/refresh`, {
        method: "POST",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(60000),
      }).then((r) => r.json());
      res.json(data);
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message || "刷新失败" });
    }
  });

  return router;
}

module.exports = { createSportsPolyRouter };
