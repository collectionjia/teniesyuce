const { Router } = require("express");
const { auth } = require("../middleware/auth");
const pool = require("../db");

const router = Router();

const DOTA_BASE = (process.env.DOTA_INTERNAL_URL || "http://dota:8777").replace(/\/$/, "");
const POLY_GAMMA = "https://gamma-api.polymarket.com";
const POLY_CACHE_MS = 5 * 60 * 1000;

let polyCache = { at: 0, items: [] };

async function fetchDota(path) {
  const res = await fetch(`${DOTA_BASE}${path}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`dota HTTP ${res.status}`);
  return res.json();
}

function slimRankings(list) {
  return (list || []).map((t, i) => ({
    rank: i + 1,
    id: t.id,
    name: t.name,
    tag: t.tag || null,
  }));
}

function slimMatches(list) {
  return (list || []).map((m) => ({
    match_id: m.match_id,
    start_time: m.start_time,
    league_name: m.league_name,
    radiant_name: m.radiant_name,
    dire_name: m.dire_name,
    radiant_team_id: m.radiant_team_id,
    dire_team_id: m.dire_team_id,
    radiant_score: m.radiant_score,
    dire_score: m.dire_score,
    radiant_win: m.radiant_win,
  }));
}

function slimPreview(rankings, matches) {
  return {
    ok: true,
    member: false,
    rankings: slimRankings(rankings),
    matches: slimMatches(matches),
    message: "非会员预览（仅战队名单与比分）",
  };
}

async function userHasDotaAccess(user) {
  if (!user) return false;
  if (user.role === "admin") return true;
  const [products] = await pool.query(
    `SELECT id FROM products
     WHERE online = 1 AND (
       LOWER(tag) = 'dota'
       OR name LIKE '%DOTA%'
       OR LOWER(name) LIKE '%dota%'
     )`,
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

/** 队名归一化，便于 Polymarket 与 OpenDota 队名模糊匹配 */
function normalizeTeam(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .replace(/\b(team|esports|e sports|gaming|club|org|organisation|organization)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokensOf(name) {
  const n = normalizeTeam(name);
  if (!n) return [];
  return n.split(" ").filter((t) => t.length >= 2);
}

function namesMatch(a, b) {
  const na = normalizeTeam(a);
  const nb = normalizeTeam(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 4 && nb.length >= 4 && (na.includes(nb) || nb.includes(na))) return true;
  const ta = tokensOf(a);
  const tb = tokensOf(b);
  if (!ta.length || !tb.length) return false;
  const setB = new Set(tb);
  const overlap = ta.filter((t) => setB.has(t));
  if (overlap.length >= Math.min(ta.length, tb.length)) return true;
  if (overlap.length >= 1 && Math.min(ta.length, tb.length) === 1) return true;
  return false;
}

function parseOutcomes(raw) {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      /* ignore */
    }
  }
  return [];
}

function extractEventSides(ev) {
  const title = String(ev?.title || "");
  const m = title.match(/dota\s*2?\s*:\s*(.+?)\s+vs\.?\s+(.+?)(?:\s*\(|\s+-|$)/i);
  if (m) return [m[1].trim(), m[2].trim()];
  for (const market of ev?.markets || []) {
    const outs = parseOutcomes(market.outcomes);
    if (outs.length >= 2 && !/^(yes|no)$/i.test(outs[0])) {
      return [outs[0], outs[1]];
    }
  }
  return [null, null];
}

async function fetchPolymarketDotaEvents() {
  const now = Date.now();
  if (polyCache.items.length && now - polyCache.at < POLY_CACHE_MS) {
    return polyCache.items;
  }
  const urls = [
    `${POLY_GAMMA}/events?tag_slug=dota-2&active=true&closed=false&limit=100`,
    `${POLY_GAMMA}/events?tag_slug=dota-2&closed=false&order=startDate&ascending=false&limit=50`,
  ];
  const bySlug = new Map();
  await Promise.all(
    urls.map(async (url) => {
      try {
        const res = await fetch(url, { headers: { Accept: "application/json" } });
        if (!res.ok) return;
        const list = await res.json();
        for (const ev of list || []) {
          if (!ev?.slug) continue;
          bySlug.set(ev.slug, ev);
        }
      } catch (err) {
        console.warn("[dota/polymarket]", err.message || err);
      }
    }),
  );
  const items = [...bySlug.values()].map((ev) => {
    const [sideA, sideB] = extractEventSides(ev);
    return {
      slug: ev.slug,
      title: ev.title || "",
      url: `https://polymarket.com/event/${ev.slug}`,
      sideA,
      sideB,
      startMs: ev.startDate ? Date.parse(ev.startDate) : NaN,
      endMs: ev.endDate ? Date.parse(ev.endDate) : NaN,
    };
  });
  polyCache = { at: now, items };
  return items;
}

function matchPolymarket(match, events) {
  const a = match.radiant_name;
  const b = match.dire_name;
  if (!a || !b || !events.length) return null;
  const matchMs = match.start_time ? Date.parse(match.start_time) : NaN;
  let best = null;
  let bestScore = -1;
  for (const ev of events) {
    if (!ev.sideA || !ev.sideB) continue;
    const same =
      (namesMatch(a, ev.sideA) && namesMatch(b, ev.sideB)) ||
      (namesMatch(a, ev.sideB) && namesMatch(b, ev.sideA));
    if (!same) continue;
    let score = 10;
    if (Number.isFinite(matchMs)) {
      const ref = Number.isFinite(ev.endMs)
        ? ev.endMs
        : Number.isFinite(ev.startMs)
          ? ev.startMs
          : NaN;
      if (Number.isFinite(ref)) {
        const dayDiff = Math.abs(matchMs - ref) / 86400000;
        if (dayDiff <= 2) score += 50;
        else if (dayDiff <= 7) score += 20;
        else if (dayDiff <= 30) score += 5;
        else score -= 5;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = ev;
    }
  }
  if (!best || bestScore < 10) return null;
  return {
    title: best.title,
    url: best.url,
    slug: best.slug,
  };
}

async function attachPolymarket(matches) {
  const events = await fetchPolymarketDotaEvents();
  return (matches || []).map((m) => {
    const polymarket = matchPolymarket(m, events);
    return polymarket ? { ...m, polymarket } : m;
  });
}

router.get("/overview", auth(), async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const matchLimit = Math.min(Math.max(Number(req.query.matchLimit) || 30, 1), 100);
    const [rankings, matches] = await Promise.all([
      fetchDota(`/api/rankings?limit=${limit}`),
      fetchDota(`/api/matches?limit=${matchLimit}`),
    ]);
    const member = await userHasDotaAccess(req.user);
    if (!member) {
      return res.json(slimPreview(rankings, matches));
    }
    const enriched = await attachPolymarket(matches || []);
    res.json({
      ok: true,
      member: true,
      rankings: (rankings || []).map((t, i) => ({ ...t, rank: i + 1 })),
      matches: enriched,
    });
  } catch (err) {
    console.error("[dota/overview]", err);
    res.status(502).json({
      ok: false,
      error: err.message || "failed to load dota data",
    });
  }
});

router.get("/teams", auth(), async (req, res) => {
  try {
    const member = await userHasDotaAccess(req.user);
    if (!member) {
      return res.status(403).json({ error: "需要订阅 DOTA 产品" });
    }
    const q = String(req.query.q || "").trim();
    if (!q) return res.json([]);
    const list = await fetchDota(`/api/teams?q=${encodeURIComponent(q)}`);
    res.json(list || []);
  } catch (err) {
    console.error("[dota/teams]", err);
    res.status(502).json({ error: err.message || "search failed" });
  }
});

router.get("/teams/:id", auth(), async (req, res) => {
  try {
    const member = await userHasDotaAccess(req.user);
    if (!member) {
      return res.status(403).json({ error: "需要订阅 DOTA 产品" });
    }
    const detail = await fetchDota(`/api/teams/${encodeURIComponent(req.params.id)}`);
    res.json(detail);
  } catch (err) {
    console.error("[dota/teams/:id]", err);
    res.status(502).json({ error: err.message || "team detail failed" });
  }
});

router.get("/predict", auth(), async (req, res) => {
  try {
    const member = await userHasDotaAccess(req.user);
    if (!member) {
      return res.status(403).json({ error: "需要订阅 DOTA 产品" });
    }
    const a = req.query.a;
    const b = req.query.b;
    if (!a || !b) {
      return res.status(400).json({ error: "缺少战队 ID" });
    }
    const qs = new URLSearchParams({ a, b });
    if (req.query.series_type != null) qs.set("series_type", req.query.series_type);
    const data = await fetchDota(`/api/predict?${qs.toString()}`);
    res.json(data);
  } catch (err) {
    console.error("[dota/predict]", err);
    res.status(502).json({ error: err.message || "predict failed" });
  }
});

module.exports = router;
