/**
 * SofaScore mobile API：token/init + Bearer GET。
 * TLS：CycleTLS（Chrome JA3 + HTTP/1）；可选 SOFA_CURL_BIN。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import initCycleTLS from "cycletls";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_BASE = (process.env.SOFA_MOBILE_API_BASE || "https://api.sofascore.com/api/v1").replace(/\/$/, "");
const APP_VERSION = Number(process.env.SOFA_APP_VERSION || "250000");
const USER_AGENT = process.env.SOFA_MOBILE_UA || `SofaScore/${APP_VERSION} Android/14`;
const MIN_INTERVAL = Number(process.env.SOFA_MOBILE_MIN_INTERVAL || "0.8");
const MAX_RETRIES = Math.max(1, Number(process.env.SOFA_MOBILE_RETRIES || "4"));
const RETRY_BACKOFF = Number(process.env.SOFA_MOBILE_RETRY_BACKOFF || "3");
const CURL_BIN = (process.env.SOFA_CURL_BIN || "").trim();
const JA3 =
  process.env.SOFA_JA3 ||
  "771,4865-4867-4866-49195-49199-52393-52392-49196-49200-49162-49161-49171-49172-51-57-47-53-10,0-23-65281-10-11-35-16-5-51-43-13-45-28-21,29-23-24-25-256-257,0";

let cyclePromise = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function uuidPathCandidates() {
  const env = (process.env.SOFA_DEVICE_UUID_FILE || "").trim();
  if (env) return [env];
  return [path.join(ROOT, ".sofa_device_uuid"), path.join(os.tmpdir(), "sofa_device_uuid")];
}

function loadOrCreateUuid() {
  for (const p of uuidPathCandidates()) {
    try {
      if (fs.existsSync(p)) {
        const v = fs.readFileSync(p, "utf8").trim();
        if (v) return v;
      }
    } catch {
      /* next */
    }
  }
  const val = randomUUID();
  for (const p of uuidPathCandidates()) {
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, val, "utf8");
      break;
    } catch {
      /* next */
    }
  }
  return val;
}

async function getCycle() {
  if (!cyclePromise) cyclePromise = initCycleTLS();
  return cyclePromise;
}

function curlRequest(method, url, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const args = ["-sS", "-X", method, "--max-time", "45", "-w", "\n%{http_code}"];
    if (CURL_BIN.toLowerCase().includes("impersonat")) {
      args.push("--impersonate", process.env.SOFA_CURL_IMPERSONATE || "chrome131");
    }
    for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
    if (body != null) args.push("-d", body);
    args.push(url);
    const child = spawn(CURL_BIN, args, { windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => {
      out += c;
    });
    child.stderr.on("data", (c) => {
      err += c;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && !out) {
        reject(new Error(err || `curl exit ${code}`));
        return;
      }
      const nl = out.lastIndexOf("\n");
      resolve({
        status: Number((nl >= 0 ? out.slice(nl + 1) : "").trim()) || 0,
        text: nl >= 0 ? out.slice(0, nl) : out,
      });
    });
  });
}

async function cycleRequest(method, url, { headers = {}, body = null } = {}) {
  const cycleTLS = await getCycle();
  const response = await cycleTLS(
    url,
    {
      body: body || "",
      ja3: JA3,
      userAgent: USER_AGENT,
      headers,
      timeout: 45,
      forceHTTP1: true,
    },
    method.toLowerCase(),
  );
  let text = "";
  if (typeof response.data === "string") text = response.data;
  else if (response.data != null) text = JSON.stringify(response.data);
  else {
    try {
      text = await response.text();
    } catch {
      text = "";
    }
  }
  return { status: response.status, text };
}

async function httpRequest(method, url, opts) {
  if (CURL_BIN) return curlRequest(method, url, opts);
  return cycleRequest(method, url, opts);
}

export class SofaClient {
  constructor() {
    this._token = null;
    this._uuid = loadOrCreateUuid();
    this._lastAt = 0;
  }

  async _throttle() {
    const wait = MIN_INTERVAL * 1000 - (Date.now() - this._lastAt);
    if (wait > 0) await sleep(wait);
  }

  async ensureToken(force = false) {
    if (this._token && !force) return this._token;
    const body = JSON.stringify({
      deviceType: "android",
      uuid: this._uuid,
      version: APP_VERSION,
    });
    let lastErr;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      await this._throttle();
      try {
        const r = await httpRequest("POST", `${API_BASE}/token/init`, {
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
          },
          body,
        });
        this._lastAt = Date.now();
        if (r.status === 429 || r.status >= 500) {
          lastErr = new Error(`token/init HTTP ${r.status}: ${r.text.slice(0, 200)}`);
          await sleep(RETRY_BACKOFF * (attempt + 1) * (r.status === 429 ? 2 : 1) * 1000);
          continue;
        }
        if (r.status >= 400) {
          throw new Error(`token/init HTTP ${r.status}: ${r.text.slice(0, 200)}`);
        }
        const data = JSON.parse(r.text || "{}");
        if (!data.token) throw new Error("token/init 无 token");
        this._token = String(data.token);
        return this._token;
      } catch (e) {
        lastErr = e;
        this._lastAt = Date.now();
        await sleep(RETRY_BACKOFF * (attempt + 1) * 1000);
      }
    }
    throw lastErr || new Error("token/init failed");
  }

  async apiGet(apiPath) {
    const url = `${API_BASE}/${String(apiPath).replace(/^\//, "")}`;
    let lastErr;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const token = await this.ensureToken(false);
      await this._throttle();
      try {
        const r = await httpRequest("GET", url, {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            "User-Agent": USER_AGENT,
          },
        });
        this._lastAt = Date.now();
        if (r.status === 401) {
          this._token = null;
          await this.ensureToken(true);
          continue;
        }
        if (r.status === 429 || r.status >= 500) {
          lastErr = new Error(`Sofascore HTTP ${r.status}: ${apiPath} ${r.text.slice(0, 120)}`);
          await sleep(RETRY_BACKOFF * (attempt + 1) * (r.status === 429 ? 2.5 : 1) * 1000);
          continue;
        }
        if (r.status >= 400) {
          throw new Error(`Sofascore HTTP ${r.status}: ${apiPath} ${r.text.slice(0, 120)}`);
        }
        return JSON.parse(r.text || "{}");
      } catch (e) {
        lastErr = e;
        this._lastAt = Date.now();
        await sleep(RETRY_BACKOFF * (attempt + 1) * 1000);
      }
    }
    throw lastErr || new Error(`Sofascore GET failed: ${apiPath}`);
  }

  getLiveTennisEvents() {
    return this.apiGet("sport/tennis/events/live");
  }
}
