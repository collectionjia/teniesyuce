#!/usr/bin/env node
/**
 * Local server for LLM perf test pages (GPT / Gemini text).
 * Serves the pages and proxies upstream calls (avoids browser CORS).
 *
 *   node scripts/gpt-perf-server.mjs
 *   open http://127.0.0.1:8791/          (GPT / Azure)
 *   open http://127.0.0.1:8791/gemini   (Gemini text)
 *
 * Outbound proxy (needed for Gemini when Google is blocked):
 *   set HTTPS_PROXY=http://127.0.0.1:12450
 *   or leave unset — auto-detects common local proxy ports and re-execs
 *   with NODE_USE_ENV_PROXY=1 so Node fetch uses the proxy.
 */
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8791);

const PAGES = {
  "/": "gpt-perf-test.html",
  "/gpt": "gpt-perf-test.html",
  "/index.html": "gpt-perf-test.html",
  "/gemini": "gemini-perf-test.html",
  "/gemini.html": "gemini-perf-test.html",
};

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, api-key, X-Upstream-Base, x-goog-api-key"
  );
  res.setHeader("Access-Control-Expose-Headers", "*");
}

function sendFile(res, filePath) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  fs.createReadStream(filePath).pipe(res);
}

function portOpen(host, port, ms = 250) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port }, () => {
      s.end();
      resolve(true);
    });
    s.on("error", () => resolve(false));
    s.setTimeout(ms, () => {
      s.destroy();
      resolve(false);
    });
  });
}

async function resolveProxyUrl() {
  const fromEnv =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy;
  if (fromEnv) return fromEnv.trim();

  for (const port of [12450, 7890, 7897, 10809, 1087, 6152]) {
    if (await portOpen("127.0.0.1", port)) return `http://127.0.0.1:${port}`;
  }
  return null;
}

function errDetail(e) {
  const cause = e && e.cause ? e.cause : e;
  return [
    e && e.message ? e.message : String(e),
    cause && cause.code ? `code=${cause.code}` : null,
    cause && cause.message && cause.message !== e.message ? cause.message : null,
  ]
    .filter(Boolean)
    .join(" | ");
}

async function startServer(outboundProxy) {
  const server = http.createServer(async (req, res) => {
    cors(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const u = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);

    if (u.pathname === "/__proxy") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          proxy: true,
          outboundProxy: outboundProxy || null,
          envProxyEnabled: process.env.NODE_USE_ENV_PROXY === "1",
        })
      );
      return;
    }

    const page = PAGES[u.pathname];
    if (page) {
      sendFile(res, path.join(__dirname, page));
      return;
    }

    if (u.pathname.startsWith("/proxy/")) {
      const upstreamBase = String(req.headers["x-upstream-base"] || "")
        .trim()
        .replace(/\/+$/, "");
      if (!upstreamBase) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "missing X-Upstream-Base header" }));
        return;
      }
      try {
        // validate URL
        // eslint-disable-next-line no-new
        new URL(upstreamBase);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid X-Upstream-Base" }));
        return;
      }
      if (!/^https?:\/\//i.test(upstreamBase)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "upstream must be http(s)" }));
        return;
      }

      const suffix = u.pathname.slice("/proxy".length) + u.search;
      const target = upstreamBase + suffix;
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const bodyBuf = Buffer.concat(chunks);

      const headers = {};
      if (req.headers["content-type"]) headers["Content-Type"] = req.headers["content-type"];
      if (req.headers["api-key"]) headers["api-key"] = req.headers["api-key"];
      if (req.headers["x-goog-api-key"]) headers["x-goog-api-key"] = req.headers["x-goog-api-key"];
      if (req.headers.authorization) headers.Authorization = req.headers.authorization;

      try {
        const upstream = await fetch(target, {
          method: req.method,
          headers,
          body: bodyBuf.length ? bodyBuf : undefined,
        });
        res.writeHead(upstream.status, {
          "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
          "Cache-Control": "no-store",
        });
        if (!upstream.body) {
          res.end();
          return;
        }
        await pipeline(Readable.fromWeb(upstream.body), res);
      } catch (e) {
        const detail = errDetail(e);
        console.error("[proxy]", target, detail);
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: detail,
              outboundProxy: outboundProxy || null,
              hint: outboundProxy
                ? "上游连接失败；请检查本地代理能否访问目标站，以及 API Key / Base URL。"
                : "未检测到出站代理。访问 Gemini/Google 请设置 HTTPS_PROXY（如 http://127.0.0.1:12450）后重启本服务。",
            })
          );
        } else {
          res.destroy(e);
        }
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
  });

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`GPT:    http://127.0.0.1:${PORT}/`);
    console.log(`Gemini: http://127.0.0.1:${PORT}/gemini`);
    console.log(`Outbound proxy: ${outboundProxy || "(none)"}`);
  });
}

const proxyUrl = await resolveProxyUrl();
if (proxyUrl && process.env.NODE_USE_ENV_PROXY !== "1") {
  console.log(`Re-exec with NODE_USE_ENV_PROXY=1 via ${proxyUrl}`);
  const child = spawn(process.execPath, process.argv.slice(1), {
    env: {
      ...process.env,
      NODE_USE_ENV_PROXY: "1",
      HTTPS_PROXY: process.env.HTTPS_PROXY || proxyUrl,
      HTTP_PROXY: process.env.HTTP_PROXY || proxyUrl,
      https_proxy: process.env.https_proxy || proxyUrl,
      http_proxy: process.env.http_proxy || proxyUrl,
    },
    stdio: "inherit",
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
} else {
  await startServer(proxyUrl);
}
