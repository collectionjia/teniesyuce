#!/usr/bin/env node
/** 本地看板 Node 版：静态页 + /api/board + /api/live（无 Redis 推送） */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getBoard, loadDiskBoard, refreshLiveBoard } from "./lib/collect.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const HOST = process.env.SOFA_BOARD_HOST || "127.0.0.1";
const PORT = Number(process.env.SOFA_BOARD_PORT || "8766");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

function send(res, code, body, type = "application/json; charset=utf-8") {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(code, {
    "Content-Type": type,
    "Content-Length": buf.length,
    "Cache-Control": "no-store",
  });
  res.end(buf);
}

function sendJson(res, code, obj) {
  send(res, code, JSON.stringify(obj), "application/json; charset=utf-8");
}

async function handleBoard(url, res) {
  const refresh = (url.searchParams.get("refresh") || "").toLowerCase();
  const force = ["1", "true", "yes"].includes(refresh);
  const daysRaw = url.searchParams.get("days") || "";
  let horizonDays = null;
  if (/^\d+$/.test(daysRaw) && [2, 3, 5].includes(Number(daysRaw))) {
    horizonDays = Number(daysRaw);
  }
  try {
    const data = await getBoard({
      force,
      horizonDays: force ? horizonDays : null,
    });
    sendJson(res, 200, data);
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String(e.message || e) });
  }
}

async function handleLive(url, res) {
  const refresh = (url.searchParams.get("refresh") || "").toLowerCase();
  const force = ["1", "true", "yes"].includes(refresh);
  try {
    const data = await refreshLiveBoard({ force });
    sendJson(res, data.ok ? 200 : 503, data);
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String(e.message || e) });
  }
}

function serveStatic(reqPath, res) {
  let rel = decodeURIComponent(reqPath).replace(/^\/+/, "") || "index.html";
  if (rel.includes("..")) {
    send(res, 403, "forbidden", "text/plain");
    return;
  }
  const filePath = path.resolve(PUBLIC, rel);
  if (!filePath.startsWith(PUBLIC) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    send(res, 404, "not found", "text/plain");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  send(res, 200, fs.readFileSync(filePath), MIME[ext] || "application/octet-stream");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  const p = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "GET" && (p === "/api/health" || p === "/api/health/")) {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === "GET" && (p === "/api/board" || p === "/api/board/")) {
    await handleBoard(url, res);
    return;
  }
  if (req.method === "GET" && (p === "/api/live" || p === "/api/live/")) {
    await handleLive(url, res);
    return;
  }
  if (req.method === "GET") {
    serveStatic(p === "/" ? "/index.html" : p, res);
    return;
  }
  send(res, 405, "method not allowed", "text/plain");
});

const disk = loadDiskBoard();
if (disk) {
  console.log(`[board] loaded disk cache · events=${(disk.events || []).length}`);
}

server.listen(PORT, HOST, () => {
  console.log(`[board-node] http://${HOST}:${PORT}/`);
});
