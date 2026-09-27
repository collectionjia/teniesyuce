import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SofaClient } from "./sofa.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEDULE_PATH = path.join(ROOT, "config", "schedule.json");
const CACHE_DIR = path.join(ROOT, ".cache");
const BOARD_FILE = path.join(CACHE_DIR, "board.json");
const PY_RANKS = path.resolve(ROOT, "..", "tennis-live-board", ".cache", "ranks.json");
const ALLOWED = new Set([1, 2, 3, 5]);
const CACHE_SEC = Number(process.env.SOFA_BOARD_CACHE_SEC || "45");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function todayBj() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
}

function shiftDate(ymd, days) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function collectDateList(startDate, horizonDays = 1) {
  const n = Math.max(1, Number(horizonDays) || 1);
  return Array.from({ length: n }, (_, i) => shiftDate(startDate, i));
}

export function readCollectHorizonDays() {
  try {
    if (fs.existsSync(SCHEDULE_PATH)) {
      const data = JSON.parse(fs.readFileSync(SCHEDULE_PATH, "utf8"));
      const n = Number(data.collect_horizon_days || 1);
      if (ALLOWED.has(n)) return n;
    }
  } catch {
    /* default */
  }
  return 1;
}

export function writeCollectHorizonDays(n) {
  n = ALLOWED.has(Number(n)) ? Number(n) : readCollectHorizonDays();
  try {
    fs.mkdirSync(path.dirname(SCHEDULE_PATH), { recursive: true });
    let data = {};
    if (fs.existsSync(SCHEDULE_PATH)) {
      data = JSON.parse(fs.readFileSync(SCHEDULE_PATH, "utf8")) || {};
    }
    data.collect_horizon_days = n;
    fs.writeFileSync(SCHEDULE_PATH, JSON.stringify(data, null, 2) + "\n", "utf8");
  } catch {
    /* ignore */
  }
  return n;
}

function playerSide(ev, side) {
  let team = ev[`${side}Team`] || ev[side] || {};
  if (typeof team === "string") return { id: null, name: team, rank: null, gender: null };
  let gender = team.gender || team.genderCategory;
  if (gender !== "M" && gender !== "F" && typeof gender === "string") {
    const u = gender.toUpperCase();
    gender = u.startsWith("F") ? "F" : u ? "M" : null;
  }
  return {
    id: team.id ?? null,
    name: team.name || team.shortName,
    shortName: team.shortName,
    rank: team.ranking || team.rank,
    gender: gender || null,
    country: team.country && typeof team.country === "object" ? team.country.name : team.country,
  };
}

function eventGender(ev) {
  for (const side of ["home", "away"]) {
    const g = playerSide(ev, side).gender;
    if (g === "M" || g === "F") return g;
  }
  const unique = ev.uniqueTournament || (ev.tournament || {}).uniqueTournament || {};
  const cat = String(unique.category?.slug || unique.category?.name || "").toLowerCase();
  if (cat.includes("wta") || cat.includes("women")) return "F";
  if (cat.includes("atp") || cat.includes("men")) return "M";
  return null;
}

function eventTour(ev) {
  const unique = ev.uniqueTournament || (ev.tournament || {}).uniqueTournament || {};
  const cat = String(unique.category?.slug || unique.category?.name || "");
  const low = cat.toLowerCase();
  if (low.includes("wta")) return "WTA";
  if (low.includes("atp") || low.includes("challenger")) return "ATP";
  const gender = eventGender(ev);
  if (gender === "F") return "WTA";
  if (gender === "M") return "ATP";
  return String(ev.tour || "").toUpperCase();
}

function tourLevelLabel(ev, tour) {
  const unique = ev.uniqueTournament || (ev.tournament || {}).uniqueTournament || {};
  const name = String(unique.name || unique.slug || "").toLowerCase();
  const tier =
    typeof unique.category === "string" ? String(unique.category).toLowerCase() : "";
  const points = unique.tennisPoints;
  const prefix = (tour || eventTour(ev) || "ATP").toUpperCase();
  if (
    ["australian open", "roland garros", "french open", "wimbledon", "us open"].some((x) =>
      name.includes(x),
    ) ||
    tier.includes("grand_slam") ||
    tier.includes("grand slam")
  ) {
    return `${prefix} GS`;
  }
  if (points != null) {
    const p = Number(points);
    if (!Number.isNaN(p)) {
      if (p >= 1000) return `${prefix} 1000`;
      if (p >= 500) return `${prefix} 500`;
      if (p >= 250) return `${prefix} 250`;
    }
  }
  if (name.includes("1000") || name.includes("masters")) return `${prefix} 1000`;
  if (name.includes("500")) return `${prefix} 500`;
  if (name.includes("250")) return `${prefix} 250`;
  if (name.includes("challenger")) return `${prefix} CH`;
  return prefix;
}

function isEnded(ev) {
  const st = typeof ev.status === "object" && ev.status ? ev.status : {};
  const typ = String(st.type || ev.statusType || "").toLowerCase();
  const desc = String(st.description || (typeof ev.status === "string" ? ev.status : "") || "").toLowerCase();
  if (["finished", "canceled", "cancelled"].includes(typ)) return true;
  return ["ended", "finished", "retired", "walkover", "cancel"].some((k) => desc.includes(k));
}

function isLive(ev) {
  const st = String(ev.statusType || "").toLowerCase();
  if (["inprogress", "live", "interrupted"].includes(st)) return true;
  const desc = String(ev.status || "").toLowerCase();
  return ["set", "live", "progress"].some((k) => desc.includes(k));
}

function isUnfinished(ev) {
  return !isEnded(ev);
}

function eventScore(ev) {
  const hs = ev.homeScore || {};
  const as_ = ev.awayScore || {};
  if (typeof hs !== "object" || typeof as_ !== "object") return null;
  const parts = [];
  for (const key of ["period1", "period2", "period3", "period4", "period5"]) {
    if (hs[key] != null && as_[key] != null) parts.push(`${hs[key]}-${as_[key]}`);
  }
  if (parts.length) return parts.join(" ");
  if (hs.current != null && as_.current != null) return `${hs.current}-${as_.current}`;
  return null;
}

function roundLabel(info) {
  if (!info || typeof info !== "object") return null;
  for (const key of ["name", "round", "description"]) {
    if (info[key]) return String(info[key]);
  }
  return info.cupRoundType != null ? String(info.cupRoundType) : null;
}

function eventMatchUrl(ev) {
  const slug = String(ev.slug || "").trim().replace(/^\/+|\/+$/g, "");
  const customId = String(ev.customId || "").trim().replace(/^\/+|\/+$/g, "");
  const eid = ev.id;
  if (slug && customId) {
    let url = `https://www.sofascore.com/tennis/match/${slug}/${customId}`;
    if (eid != null) url += `#id:${eid}`;
    return url;
  }
  if (eid != null) return `https://www.sofascore.com/event/tennis/${eid}`;
  return null;
}

function slimEvent(ev) {
  const home = playerSide(ev, "home");
  const away = playerSide(ev, "away");
  const status = typeof ev.status === "object" && ev.status ? ev.status : {};
  const tournament = ev.tournament || {};
  const unique = ev.uniqueTournament || tournament.uniqueTournament || {};
  const tour = eventTour(ev);
  const gender = eventGender(ev);
  if (gender) {
    home.gender = home.gender || gender;
    away.gender = away.gender || gender;
  }
  const ts = ev.startTimestamp;
  let startTime = null;
  if (ts) {
    startTime = new Date(Number(ts) * 1000).toLocaleTimeString("en-GB", {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }
  const flatScore = (obj) => {
    if (!obj || typeof obj !== "object") return null;
    for (let i = 1; i <= 5; i++) if (obj[`period${i}`] != null) return null;
    return obj.current ?? null;
  };
  const homeScoreObj = typeof ev.homeScore === "object" ? ev.homeScore : null;
  const awayScoreObj = typeof ev.awayScore === "object" ? ev.awayScore : null;
  return {
    id: ev.id,
    level: tourLevelLabel(ev, tour),
    tour,
    gender,
    tennisPoints: unique.tennisPoints,
    home: home.name,
    away: away.name,
    homePlayer: home,
    awayPlayer: away,
    status: status.description || ev.status,
    statusType: status.type || ev.statusType,
    homeScore: homeScoreObj ?? ev.homeScore,
    awayScore: awayScoreObj ?? ev.awayScore,
    home_score: flatScore(homeScoreObj),
    away_score: flatScore(awayScoreObj),
    scoreText: eventScore(ev),
    tournament: unique.name || tournament.name,
    tournamentShort: tournament.name || unique.name,
    roundInfo: ev.roundInfo,
    roundLabel: roundLabel(ev.roundInfo),
    groundType: ev.groundType || unique.groundType,
    startTimestamp: ts,
    startTime,
    slug: ev.slug,
    customId: ev.customId,
    url: eventMatchUrl(ev),
  };
}

function wantBoardTournament(tournament) {
  const unique = tournament.uniqueTournament || {};
  const cat = String(unique.category?.slug || "").toLowerCase();
  if (cat !== "atp" && cat !== "wta") return false;
  const tour = cat === "wta" ? "WTA" : "ATP";
  const label = tourLevelLabel({ uniqueTournament: unique, tournament }, tour);
  return label.endsWith(" 1000") || label.endsWith(" 500");
}

function is5001000Event(ev) {
  const label = tourLevelLabel(ev, eventTour(ev));
  return label.endsWith(" 1000") || label.endsWith(" 500");
}

async function listScheduledTournaments(client, matchDate) {
  const tournaments = [];
  const seen = new Set();
  let page = 1;
  while (page <= 10) {
    const data = await client.apiGet(`sport/tennis/scheduled-tournaments/${matchDate}/page/${page}`);
    for (const group of data.scheduled || []) {
      const tournament = group.tournament || {};
      const tid = tournament.id;
      if (tid == null || seen.has(tid)) continue;
      seen.add(tid);
      tournaments.push(tournament);
    }
    if (!data.hasNextPage) return { tournaments, pages: page };
    page += 1;
    await sleep(500);
  }
  return { tournaments, pages: page };
}

async function fetchTournamentEvents(client, tournament) {
  const unique = tournament.uniqueTournament || {};
  const uid = unique.id;
  const tid = tournament.id;
  if (!uid || !tid) return [];
  const seasons = await client.apiGet(`unique-tournament/${uid}/seasons`);
  const seasonList = seasons.seasons || [];
  if (!seasonList.length) return [];
  const sid = seasonList[0].id;
  await sleep(500);
  const evdata = await client.apiGet(`tournament/${tid}/season/${sid}/events`);
  return evdata.events || [];
}

async function fetchDayEvents(client, matchDate, horizonDays) {
  const horizon = ALLOWED.has(Number(horizonDays)) ? Number(horizonDays) : readCollectHorizonDays();
  const out = [];
  const seen = new Set();
  const tourSeen = new Set();
  for (const d of collectDateList(matchDate, horizon)) {
    let listed;
    try {
      ({ tournaments: listed } = await listScheduledTournaments(client, d));
    } catch (e) {
      console.log(`[board] schedule list ${d} failed: ${e.message || e}`);
      continue;
    }
    for (const tournament of listed) {
      const tid = tournament.id;
      if (tid == null || tourSeen.has(tid)) continue;
      if (!wantBoardTournament(tournament)) continue;
      tourSeen.add(tid);
      let evs;
      try {
        evs = await fetchTournamentEvents(client, tournament);
      } catch (e) {
        const name = tournament.uniqueTournament?.name || tournament.name;
        console.log(`[board] tournament events skip ${name}: ${e.message || e}`);
        continue;
      }
      for (const ev of evs) {
        if (ev.id == null) continue;
        const iid = Number(ev.id);
        if (seen.has(iid)) continue;
        seen.add(iid);
        out.push(ev);
      }
    }
  }
  console.log(`[board] schedule 500/1000 tournaments=${tourSeen.size} events=${out.length} horizon=${horizon}d`);
  return out;
}

function groupTournaments(events, tour) {
  const groups = new Map();
  for (const ev of events) {
    if (String(ev.tour || "").toLowerCase() !== tour) continue;
    const key = ev.tournament || ev.tournamentShort || "Unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ev);
  }
  const out = [];
  for (const [name, items] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    items.sort((a, b) => (a.startTimestamp || 0) - (b.startTimestamp || 0) || (a.id || 0) - (b.id || 0));
    out.push({ name, events: items, eventCount: items.length });
  }
  return out;
}

function loadRanksBoard() {
  for (const p of [path.join(CACHE_DIR, "ranks.json"), PY_RANKS]) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      const board = raw.board || raw;
      if (board?.atp || board?.wta) {
        return {
          atp: board.atp || [],
          wta: board.wta || [],
        };
      }
    } catch {
      /* next */
    }
  }
  return { atp: [], wta: [] };
}

export function loadDiskBoard() {
  try {
    if (!fs.existsSync(BOARD_FILE)) return null;
    return JSON.parse(fs.readFileSync(BOARD_FILE, "utf8"));
  } catch {
    return null;
  }
}

export function saveDiskBoard(data) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(BOARD_FILE, JSON.stringify(data), "utf8");
}

/** @type {{ at: number, data: any }} */
const cache = { at: 0, data: null };
let building = false;

export function getCachedBoard() {
  return cache.data;
}

export async function buildBoard({ horizonDays = null } = {}) {
  const started = Date.now();
  const matchDate = todayBj();
  let error = null;
  const horizon =
    horizonDays != null && ALLOWED.has(Number(horizonDays))
      ? writeCollectHorizonDays(Number(horizonDays))
      : readCollectHorizonDays();

  const ranks = loadRanksBoard();
  const rawById = new Map();
  const client = new SofaClient();

  try {
    for (const ev of await fetchDayEvents(client, matchDate, horizon)) {
      if (ev.id != null) rawById.set(Number(ev.id), ev);
    }
  } catch (e) {
    error = `schedule: ${e.message || e}`;
  }

  try {
    const live = await client.getLiveTennisEvents();
    for (const ev of live.events || []) {
      if (ev.id != null) rawById.set(Number(ev.id), ev);
    }
  } catch (e) {
    const msg = `live: ${e.message || e}`;
    error = error ? `${error}; ${msg}` : msg;
  }

  const slimEvents = [];
  for (const ev of rawById.values()) {
    if (!isUnfinished(ev) || !is5001000Event(ev)) continue;
    const slim = slimEvent(ev);
    slim.scoreText = eventScore(ev);
    slim.tour = eventTour(ev);
    slimEvents.push(slim);
  }
  slimEvents.sort(
    (a, b) => (isLive(a) ? 0 : 1) - (isLive(b) ? 0 : 1) || (a.startTimestamp || 0) - (b.startTimestamp || 0),
  );

  const liveEvents = slimEvents.filter(isLive);
  const upcoming = slimEvents.length - liveEvents.length;

  const data = {
    ok: true,
    date: matchDate,
    fetched_at: new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC"),
    elapsed_sec: Math.round(((Date.now() - started) / 1000) * 100) / 100,
    filter: "atp_wta_500_1000_unfinished",
    filter_note: "ATP/WTA 500·1000；仅未开赛+进行中",
    horizon_days: horizon,
    error,
    summary: {
      atp_players: ranks.atp.length,
      wta_players: ranks.wta.length,
      total_events: slimEvents.length,
      live_events: liveEvents.length,
      upcoming_events: upcoming,
      horizon_days: horizon,
    },
    atp: ranks.atp,
    wta: ranks.wta,
    events: slimEvents,
    live: liveEvents,
    tournaments: {
      atp: groupTournaments(slimEvents, "atp"),
      wta: groupTournaments(slimEvents, "wta"),
    },
  };

  cache.data = data;
  cache.at = Date.now() / 1000;
  saveDiskBoard(data);
  return data;
}

export async function getBoard({ force = false, horizonDays = null } = {}) {
  const age = Date.now() / 1000 - (cache.at || 0);
  if (cache.data && !force && age < CACHE_SEC) {
    return { ...cache.data, cached: true };
  }

  const disk = loadDiskBoard();
  if (disk && !force) {
    if (!cache.data) {
      cache.data = disk;
      cache.at = Date.now() / 1000 - CACHE_SEC - 1;
    }
    if (!building) {
      building = true;
      buildBoard({ horizonDays: null })
        .catch((e) => console.log(`[board] background refresh failed: ${e.message || e}`))
        .finally(() => {
          building = false;
        });
    }
    return { ...disk, cached: true, stale: true };
  }

  if (building && !force) {
    if (disk) return { ...disk, cached: true, stale: true };
    if (cache.data) return { ...cache.data, cached: true };
  }

  building = true;
  try {
    return await buildBoard({ horizonDays });
  } finally {
    building = false;
  }
}

export async function refreshLiveBoard({ force = false } = {}) {
  const base = cache.data || loadDiskBoard();
  if (!base) {
    return { ok: false, error: "no board cache; refresh full first" };
  }
  if (!force && cache.at && Date.now() / 1000 - cache.at < 15 && Array.isArray(base.live)) {
    return { ok: true, skipped: true, live_count: base.live.length };
  }

  const client = new SofaClient();
  let liveRaw = [];
  try {
    liveRaw = (await client.getLiveTennisEvents()).events || [];
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }

  const byId = new Map((base.events || []).map((e) => [Number(e.id), e]));
  for (const ev of liveRaw) {
    if (ev.id == null || !isUnfinished(ev) || !is5001000Event(ev)) continue;
    const slim = slimEvent(ev);
    slim.scoreText = eventScore(ev);
    slim.tour = eventTour(ev);
    byId.set(Number(ev.id), slim);
  }

  const events = [...byId.values()].sort(
    (a, b) => (isLive(a) ? 0 : 1) - (isLive(b) ? 0 : 1) || (a.startTimestamp || 0) - (b.startTimestamp || 0),
  );
  const liveEvents = events.filter(isLive);
  const upcoming = events.length - liveEvents.length;
  const updated = {
    ...base,
    events,
    live: liveEvents,
    tournaments: {
      atp: groupTournaments(events, "atp"),
      wta: groupTournaments(events, "wta"),
    },
    summary: {
      ...(base.summary || {}),
      total_events: events.length,
      live_events: liveEvents.length,
      upcoming_events: upcoming,
    },
    live_refreshed_at: new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC"),
  };
  cache.data = updated;
  cache.at = Date.now() / 1000;
  saveDiskBoard(updated);
  return {
    ok: true,
    live_count: liveEvents.length,
    live_refreshed_at: updated.live_refreshed_at,
    summary: updated.summary,
    events,
    live: liveEvents,
    tournaments: updated.tournaments,
  };
}
