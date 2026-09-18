/**
 * 管理员「立即采集」：在 server 进程内执行 scripts/tennis-monitor/collect.py
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function resolveMonitorDir() {
  if (process.env.TENNIS_MONITOR_DIR) {
    return path.resolve(process.env.TENNIS_MONITOR_DIR);
  }
  const candidates = [
    '/tennis-monitor',
    path.join(__dirname, '../../../scripts/tennis-monitor'),
    '/opt/yuce/scripts/tennis-monitor',
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'collect.py'))) return path.resolve(dir);
  }
  return path.resolve(candidates[0]);
}

const MONITOR_DIR = resolveMonitorDir();
const SCHEDULE_FILE = path.join(MONITOR_DIR, 'config', 'schedule.json');
const COLLECT_SCRIPT = path.join(MONITOR_DIR, 'collect.py');
const COLLECT_LIVE_SCRIPT = path.join(MONITOR_DIR, 'collect_live.py');
const REFRESH_INPLAY_SCRIPT = path.join(MONITOR_DIR, 'refresh_inplay.py');
const OUTPUT_DIR = path.join(MONITOR_DIR, 'output');
const LOG_DIR = path.join(MONITOR_DIR, 'logs');

const ALLOWED_LIVE_POLL_INTERVALS = [0, 60, 120, 300];
const ALLOWED_COLLECT_HORIZON_DAYS = [1, 2, 3, 5];

let running = false;
let child = null;
let last = { status: 'idle' };
let logBuffer = [];

let liveRunning = false;
let liveChild = null;
let liveLast = { status: 'idle', events: [] };

function isCollectEnabled() {
  try {
    return readScheduleConfig().collect_enabled !== false;
  } catch {
    return true;
  }
}

function readScheduleConfig() {
  const defaults = {
    collect_enabled: true,
    live_poll_interval_sec: 300,
    collect_horizon_days: 1,
  };
  try {
    if (!fs.existsSync(SCHEDULE_FILE)) return { ...defaults };
    const data = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
    let liveSec = Number(data.live_poll_interval_sec ?? defaults.live_poll_interval_sec);
    if (!ALLOWED_LIVE_POLL_INTERVALS.includes(liveSec)) liveSec = defaults.live_poll_interval_sec;
    let horizon = Number(data.collect_horizon_days ?? defaults.collect_horizon_days);
    if (!ALLOWED_COLLECT_HORIZON_DAYS.includes(horizon)) horizon = defaults.collect_horizon_days;
    const enabled = data.collect_enabled;
    return {
      collect_enabled: enabled === undefined ? defaults.collect_enabled : !!enabled,
      live_poll_interval_sec: liveSec,
      collect_horizon_days: horizon,
      collect_target: data.collect_target || 'top100',
    };
  } catch {
    return { ...defaults };
  }
}

function writeScheduleConfig(cfg) {
  const next = { ...cfg };
  delete next.interval_hours;
  fs.mkdirSync(path.dirname(SCHEDULE_FILE), { recursive: true });
  fs.writeFileSync(SCHEDULE_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

function schedulePayload() {
  const cfg = readScheduleConfig();
  const liveSec = cfg.live_poll_interval_sec;
  const horizon = cfg.collect_horizon_days;
  const labels = { 0: '关闭', 60: '1 分钟', 120: '2 分钟', 300: '5 分钟' };
  const horizonLabels = { 1: '今天(1天)', 2: '今天起2天', 3: '今天起3天', 5: '今天起5天' };
  return {
    ok: true,
    collect_enabled: cfg.collect_enabled !== false,
    live_poll_interval_sec: liveSec,
    collect_horizon_days: horizon,
    allowed_live_poll_intervals: ALLOWED_LIVE_POLL_INTERVALS,
    allowed_collect_horizon_days: ALLOWED_COLLECT_HORIZON_DAYS,
    note: 'Docker 无 9004 时由 server 读写 config/schedule.json',
    live_poll_label: labels[liveSec] || `${liveSec} 秒`,
    collect_horizon_label: horizonLabels[horizon] || `今天起${horizon}天`,
    source: 'local',
  };
}

function updateSchedule(body = {}) {
  const cfg = readScheduleConfig();
  if (Object.prototype.hasOwnProperty.call(body, 'collect_enabled')) {
    cfg.collect_enabled = !!body.collect_enabled;
  }
  if (body.live_poll_interval_sec != null) {
    const liveSec = Number(body.live_poll_interval_sec);
    if (!ALLOWED_LIVE_POLL_INTERVALS.includes(liveSec)) {
      const err = new Error(`live_poll_interval_sec must be one of ${ALLOWED_LIVE_POLL_INTERVALS.join(',')}`);
      err.status = 400;
      throw err;
    }
    cfg.live_poll_interval_sec = liveSec;
  }
  if (body.collect_horizon_days != null) {
    const horizon = Number(body.collect_horizon_days);
    if (!ALLOWED_COLLECT_HORIZON_DAYS.includes(horizon)) {
      const err = new Error(`collect_horizon_days must be one of ${ALLOWED_COLLECT_HORIZON_DAYS.join(',')}`);
      err.status = 400;
      throw err;
    }
    cfg.collect_horizon_days = horizon;
  }
  writeScheduleConfig(cfg);
  return schedulePayload();
}

function nowIso() {
  return new Date().toISOString();
}

function pythonBin() {
  if (process.env.TENNIS_PYTHON) return process.env.TENNIS_PYTHON;
  // 宿主机 venv 挂进 Docker 后解释器路径失效，容器内用镜像自带的 python3
  const inDockerCollect = process.env.TENNIS_MONITOR_DIR === '/tennis-monitor';
  const venvPy = path.join(MONITOR_DIR, 'venv', 'bin', 'python');
  const candidates = [
    ...(inDockerCollect ? [] : [venvPy, path.join(MONITOR_DIR, 'venv', 'Scripts', 'python.exe')]),
    process.env.PYTHON,
    // Windows 上 Microsoft Store 的 python3.exe 常是空壳(exit 9009)，优先 python
    ...(process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python']),
  ].filter(Boolean);
  for (const bin of candidates) {
    if (bin.includes(path.sep)) {
      if (fs.existsSync(bin)) return bin;
      continue;
    }
    // 名称型：用 --version 探测，避免点到不可用的 store stub
    try {
      const { spawnSync } = require('child_process');
      const r = spawnSync(bin, ['--version'], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      });
      if (r.status === 0) return bin;
    } catch {
      /* try next */
    }
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

function appendLogFile(lines) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const file = path.join(LOG_DIR, `collect_${day}.log`);
    fs.appendFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  } catch (err) {
    console.error('[tennis/collect] log write failed:', err.message);
  }
}

function pushLog(chunk) {
  const parts = String(chunk || '').split(/\r?\n/);
  for (const line of parts) {
    if (!line) continue;
    logBuffer.push(line);
  }
  if (logBuffer.length > 4000) logBuffer = logBuffer.slice(-4000);
}

/** 读取 monitor.env*：补齐进程里缺失或为空的 IPWO/REDIS，避免空环境变量挡住文件配置 */
function loadMonitorEnvForChild() {
  const appEnv = String(process.env.APP_ENV || '').trim().toLowerCase();
  const explicit = String(process.env.SOFA_MONITOR_ENV_FILE || '').trim();
  const candidates = [];
  if (explicit) {
    candidates.push(path.isAbsolute(explicit) ? explicit : path.join(MONITOR_DIR, explicit));
  }
  if (appEnv === 'test') candidates.push(path.join(MONITOR_DIR, 'monitor.env.test'));
  if (appEnv === 'production' || appEnv === 'prod') {
    candidates.push(path.join(MONITOR_DIR, 'monitor.env.prod'));
  }
  candidates.push(path.join(MONITOR_DIR, 'monitor.env'));
  let file = null;
  for (const p of candidates) {
    if (p && fs.existsSync(p)) {
      file = p;
      break;
    }
  }
  if (!file) return { file: null, env: {} };
  const env = {};
  try {
    for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || !line.includes('=')) continue;
      const i = line.indexOf('=');
      const key = line.slice(0, i).trim();
      const val = line.slice(i + 1).trim().replace(/\r$/, '');
      if (!key) continue;
      const cur = process.env[key];
      if (cur == null || String(cur).trim() === '') env[key] = val;
    }
  } catch (e) {
    console.warn('[tennis/collect-live] load monitor.env failed:', e.message);
  }
  return { file, env };
}

/** 从 engines 配置生成 Python/子进程代理环境（账号以库为准，覆盖 monitor.env） */
async function proxyEnvForJob(job = 'top100') {
  try {
    const tennisEngines = require('./tennisEngines');
    const cfg = await tennisEngines.getConfig();
    return tennisEngines.buildProxyProcessEnv(cfg, job);
  } catch (e) {
    console.warn('[tennis/collect] proxy config read failed:', e.message);
    const isInplay = String(job).toLowerCase().includes('inplay');
    return {
      COLLECT_PROXY_JOB: isInplay ? 'inplay' : 'top100',
      COLLECT_TOP100_USE_PROXY: '1',
      COLLECT_INPLAY_USE_PROXY: '1',
    };
  }
}

/** 去掉旧版 env 里的代理键，避免盖过管理员库配置 */
function stripLegacyProxyEnv(env = {}) {
  const out = { ...env };
  for (const k of Object.keys(out)) {
    if (/^(IPWO_|SOFA_HTTP_PROXY|SOFA_HTTPS_PROXY|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY)/i.test(k)) {
      delete out[k];
    }
  }
  return out;
}

function recentLiveLogTail(maxLines = 40) {
  return logBuffer.slice(-Math.max(5, maxLines)).join('\n').slice(0, 2500);
}

function parseLiveCollectSummary(text) {
  const t = String(text || '');
  const m = t.match(/完成:\s*(\d+)\s*场进行中/);
  const pm = t.match(/PM\s+(\d+)/);
  const redisFail = /Redis 失败|未配置 REDIS_URL/.test(t);
  const noProxy = /未配置 IPWO|必须经 IPWO|禁止直连/.test(t);
  return {
    total_events: m ? Number(m[1]) : (/完成:\s*无进行中比赛/.test(t) ? 0 : null),
    polymarket_matched: pm ? Number(pm[1]) : null,
    redis_failed: redisFail,
    no_proxy: noProxy,
  };
}

function readLatestBundleMeta() {
  try {
    if (!fs.existsSync(OUTPUT_DIR)) return null;
    const files = fs
      .readdirSync(OUTPUT_DIR)
      .filter((f) => /^daily_bundle_\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map((f) => ({ f, m: fs.statSync(path.join(OUTPUT_DIR, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    if (!files.length) return null;
    const raw = fs.readFileSync(path.join(OUTPUT_DIR, files[0].f), 'utf8');
    const data = JSON.parse(raw);
    return {
      date: data.date,
      events: data.events,
      fetched_at: data.fetched_at,
      bundle_file: files[0].f,
      requests: data.requests || null,
      timing: data.timing || null,
    };
  } catch {
    return null;
  }
}

function parseTotalEvents(text) {
  const m = String(text || '').match(/完成:\s*(\d+)\s*场/);
  return m ? Number(m[1]) : null;
}

function friendlyCollectError(code, text) {
  const t = String(text || '');
  if (/CONNECT tunnel failed|curl:\s*\(7\)/i.test(t) || /代理被拒绝/i.test(t)) {
    return 'IPWO 代理被拒绝 (403)，请检查 monitor.env 代理账号/额度；采集禁止直连，请修复代理后重试';
  }
  if (/Failed to perform|curl_cffi|ProxyError|Tunnel connection failed|SOCKS|Connection reset|timed out|Timeout/i.test(t)) {
    const hit = [...t.split(/\r?\n/)].reverse().find((l) =>
      /Failed to perform|ProxyError|Tunnel|SOCKS|Connection reset|timed out|Timeout|curl_cffi|采集失败/i.test(l),
    );
    if (hit) return hit.replace(/^采集失败:\s*/, '').slice(0, 240);
    return 'Sofascore/代理网络失败（超时或隧道失败），请检查 IPWO 与容器出网';
  }
  const failLine = [...t.split(/\r?\n/)].reverse().find((l) => /采集失败:/.test(l));
  if (failLine) return failLine.replace(/^采集失败:\s*/, '').slice(0, 240);
  // Traceback 最后一行常为 "RuntimeError: xxx"；空 message 时继续往前找有内容的异常行
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (/^(RuntimeError|Exception|OSError|ValueError|TypeError|KeyError|HTTPError|ProxyError)\b/.test(l)) {
      const msg = l.replace(/^[A-Za-z.]+:\s*/, '').trim();
      if (msg) return l.slice(0, 240);
      // 空 message：带上前一行上下文
      const prev = lines[i - 1] || '';
      return `${l} (${prev.slice(0, 160) || `exit ${code}`})`.slice(0, 240);
    }
  }
  const errLine = [...lines].reverse().find((l) => /Error:|Traceback|HTTP \d{3}/.test(l));
  if (errLine) return errLine.slice(0, 240);
  return `collect_live.py 退出码 ${code}`;
}

function elapsedSecFromTiming(timing) {
  const total = timing?.total;
  return typeof total === 'number' && Number.isFinite(total) ? Math.round(total * 10) / 10 : null;
}

async function startCollect({ matchDate = null, top100 = true } = {}) {
  if (running) {
    return { ok: false, status: 409, error: 'collect already running', last };
  }
  if (!fs.existsSync(COLLECT_SCRIPT)) {
    return { ok: false, status: 500, error: `collect.py not found: ${COLLECT_SCRIPT}` };
  }

  running = true;
  const startedAt = nowIso();
  last = {
    status: 'running',
    trigger: 'admin-collect.py',
    started_at: startedAt,
    finished_at: null,
    exit_code: null,
    error: null,
    total_events: null,
    requests: null,
    elapsed_sec: null,
  };
  logBuffer = [`=== collect.py ${startedAt} trigger=admin ===`];

  const args = [COLLECT_SCRIPT];
  if (matchDate) args.push(String(matchDate));
  if (!top100) args.push('--all');

  const bin = pythonBin();
  const proxyEnv = await proxyEnvForJob('top100');
  const monitorEnv = loadMonitorEnvForChild();
  console.log(
    `[tennis/collect] spawn ${bin} -u ${args.join(' ')} proxy=${proxyEnv.COLLECT_TOP100_USE_PROXY} ipwo=${proxyEnv.IPWO_PROXY_USER ? 'yes' : 'no'}`,
  );

  child = spawn(bin, ['-u', ...args], {
    cwd: MONITOR_DIR,
    env: {
      ...stripLegacyProxyEnv({ ...process.env, ...monitorEnv.env }),
      ...proxyEnv,
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (d) => pushLog(d));
  child.stderr.on('data', (d) => pushLog(d));

  child.on('error', (err) => {
    running = false;
    child = null;
    const finishedAt = nowIso();
    last = {
      ...last,
      status: 'failed',
      finished_at: finishedAt,
      exit_code: -1,
      error: err.message || 'spawn failed',
    };
    appendLogFile(logBuffer);
    console.error('[tennis/collect] spawn error:', err.message);
  });

  child.on('close', (code) => {
    running = false;
    child = null;
    const finishedAt = nowIso();
    const text = logBuffer.join('\n');
    const meta = readLatestBundleMeta();
    const parsedEvents = parseTotalEvents(text);
    const emptyRun = /完成:\s*无(进行中)?比赛/.test(text);
    const totalEvents = parsedEvents ?? (emptyRun ? 0 : (meta?.events ?? null));
    const requests = meta?.requests || null;
    const elapsed = elapsedSecFromTiming(meta?.timing);

    if (code === 0 && (totalEvents == null || totalEvents > 0)) {
      last = {
        status: 'success',
        trigger: 'admin-collect.py',
        started_at: last.started_at,
        finished_at: finishedAt,
        exit_code: code,
        error: null,
        total_events: totalEvents ?? meta?.events ?? 0,
        requests,
        elapsed_sec: elapsed,
        bundle_file: meta?.bundle_file || null,
      };
      console.log(`[tennis/collect] done events=${last.total_events} elapsed=${elapsed ?? '-'}s`);
    } else if (code === 0 || emptyRun) {
      last = {
        status: 'success',
        trigger: 'admin-collect.py',
        started_at: last.started_at,
        finished_at: finishedAt,
        exit_code: code ?? 0,
        error: null,
        total_events: 0,
        requests,
        elapsed_sec: elapsed,
        message: '无符合条件的比赛',
      };
      console.log('[tennis/collect] done events=0 (empty)');
    } else {
      last = {
        status: 'failed',
        trigger: 'admin-collect.py',
        started_at: last.started_at,
        finished_at: finishedAt,
        exit_code: code,
        error: friendlyCollectError(code, text),
        total_events: totalEvents,
        requests,
        elapsed_sec: elapsed,
      };
    }
    appendLogFile(logBuffer);
    try {
      const tennisRedis = require('./tennisRedis');
      tennisRedis.invalidateMemCache();
    } catch { /* ignore */ }
  });

  return { ok: true, message: 'collect.py started', last: { ...last } };
}

async function startLiveCollect() {
  const r = await beginLiveCollect({ trigger: 'admin-collect_live.py', wait: false });
  if (!r.ok) return r;
  return { ok: true, message: 'collect_live.py started', last: { ...liveLast } };
}

/**
 * 轻量盘中刷新：只刷 Redis tennis:bundle:inplay 已有场次的比分(Sofascore) + Polymarket 赔率。
 * 不重跑 collect_live 全量发现。
 */
async function runInplayRefreshAndWait({
  timeoutMs = 120000,
  scoresOnly = false,
  oddsOnly = false,
} = {}) {
  const timeout = Math.max(15000, Number(timeoutMs) || 120000);
  if (!fs.existsSync(REFRESH_INPLAY_SCRIPT)) {
    return {
      ok: false,
      error: `refresh_inplay.py not found: ${REFRESH_INPLAY_SCRIPT}`,
      upstream: 'ipwo',
    };
  }
  const bin = pythonBin();
  const args = ['-u', REFRESH_INPLAY_SCRIPT];
  if (scoresOnly) args.push('--scores-only');
  if (oddsOnly) args.push('--odds-only');
  const envExtra = loadMonitorEnvForChild();
  const proxyEnv = await proxyEnvForJob('inplay');
  // 同步到当前 Node 进程，供 tennisPolymarket.js 直连判断
  Object.assign(process.env, proxyEnv);
  return new Promise((resolve) => {
    const chunks = [];
    let settled = false;
    const childProc = spawn(bin, args, {
      cwd: MONITOR_DIR,
      env: {
        ...stripLegacyProxyEnv({ ...process.env, ...envExtra.env }),
        ...proxyEnv,
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',
      },
      windowsHide: true,
    });
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      try {
        childProc.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      finish({
        ok: false,
        timedOut: true,
        error: `refresh_inplay timed out after ${timeout}ms`,
        process_log: chunks.join('').split(/\r?\n/).filter(Boolean).slice(-200).join('\n'),
        log_tail: chunks.slice(-40).join(''),
        upstream: 'ipwo',
      });
    }, timeout);
    childProc.stdout?.on('data', (buf) => {
      const text = String(buf);
      chunks.push(text);
      pushLog(text);
    });
    childProc.stderr?.on('data', (buf) => {
      const text = String(buf);
      chunks.push(text);
      pushLog(text);
    });
    childProc.on('error', (err) => {
      const msg = err.message || String(err);
      pushLog(`[refresh_inplay] spawn error: ${msg}`);
      const text = chunks.join('');
      finish({
        ok: false,
        error: msg,
        process_log: text.split(/\r?\n/).filter(Boolean).slice(-200).join('\n') || `[refresh_inplay] spawn error: ${msg}`,
        log_tail: chunks.slice(-40).join(''),
        upstream: 'ipwo',
      });
    });
    childProc.on('close', (code) => {
      const text = chunks.join('');
      let summary = null;
      const m = text.match(/SUMMARY\s+(\{.*\})\s*$/m) || text.match(/SUMMARY\s+(\{[\s\S]*\})/);
      if (m) {
        try {
          summary = JSON.parse(m[1]);
        } catch {
          summary = null;
        }
      }
      const ok = code === 0 && (!summary || summary.ok !== false);
      const lines = text.split(/\r?\n/);
      const process_log = lines.filter((l) => l.length).slice(-200).join('\n');
      const log_tail = lines.slice(-80).join('\n');
      try {
        appendLogFile([
          `=== refresh_inplay.py ${new Date().toISOString()} ===`,
          ...lines.filter(Boolean).slice(-120),
        ]);
      } catch {
        /* ignore */
      }
      finish({
        ok,
        code,
        summary,
        error: ok ? null : summary?.error || (code != null ? `exit ${code}` : 'refresh_inplay failed'),
        process_log,
        log_tail,
        upstream: 'ipwo',
        script: 'refresh_inplay.py',
      });
    });
  });
}

/**
 * 同步跑 collect_live.py（IPWO → Sofascore 比分/状态 + Polymarket），写完 Redis 再返回。
 * 供调度「盘中比分刷新」使用。
 */
async function runLiveCollectAndWait({ timeoutMs = 180000 } = {}) {
  const timeout = Math.max(30000, Number(timeoutMs) || 180000);
  if (liveRunning) {
    const waited = await waitForLiveCollectIdle(timeout);
    return {
      ok: liveLast.status === 'success',
      waited: true,
      timedOut: !!waited?.timedOut,
      last: { ...liveLast },
      error: liveLast.error || null,
      summary: {
        total_events: liveLast.live_count ?? liveLast.total_events ?? null,
        polymarket_matched: liveLast.polymarket_matched ?? null,
        redis_failed: !!liveLast.redis_failed,
        no_proxy: !!liveLast.no_proxy,
      },
      log_tail: liveLast.log_tail || recentLiveLogTail(40),
      process_log: liveLast.log_tail || recentLiveLogTail(80),
      upstream: 'ipwo',
    };
  }
  const started = await beginLiveCollect({ trigger: 'scheduler-collect_live.py', wait: true });
  if (!started.ok) {
    return { ...started, upstream: 'ipwo' };
  }
  const result = await started.done;
  return {
    ...result,
    upstream: 'ipwo',
  };
}

function waitForLiveCollectIdle(timeoutMs) {
  const started = Date.now();
  return new Promise((resolve) => {
    const t = setInterval(() => {
      if (!liveRunning) {
        clearInterval(t);
        resolve({ timedOut: false });
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(t);
        resolve({ timedOut: true });
      }
    }, 400);
  });
}

async function beginLiveCollect({ trigger = 'admin-collect_live.py', wait = false } = {}) {
  if (liveRunning) {
    return { ok: false, status: 409, error: 'live collect already running', last: { ...liveLast } };
  }
  if (!isCollectEnabled()) {
    return { ok: false, status: 403, error: '采集已关闭，请在管理页打开采集开关', last: { ...liveLast } };
  }
  if (!fs.existsSync(COLLECT_LIVE_SCRIPT)) {
    return { ok: false, status: 500, error: `collect_live.py not found: ${COLLECT_LIVE_SCRIPT}`, last: { ...liveLast } };
  }

  liveRunning = true;
  const startedAt = nowIso();
  logBuffer = [];
  const monitorEnv = loadMonitorEnvForChild();
  liveLast = {
    status: 'running',
    trigger,
    started_at: startedAt,
    finished_at: null,
    error: null,
    events: [],
    live_count: null,
    monitor_env: monitorEnv.file ? path.basename(monitorEnv.file) : null,
  };
  pushLog(`=== collect_live.py --filter=true ${startedAt} trigger=${trigger} ===`);
  if (monitorEnv.file) {
    pushLog(`[env] child fills empty keys from ${path.basename(monitorEnv.file)}（代理账号以管理员库为准）`);
  } else {
    pushLog('[env] 未找到 monitor.env*；代理请在管理中心「采集代理」配置');
  }

  const bin = pythonBin();
  const liveArgs = ['-u', COLLECT_LIVE_SCRIPT, '--filter=true'];
  const proxyEnv = await proxyEnvForJob('top100');
  console.log(`[tennis/collect-live] spawn ${bin} ${liveArgs.join(' ')} ipwo=${proxyEnv.IPWO_PROXY_USER ? 'yes' : 'no'}`);
  liveChild = spawn(bin, liveArgs, {
    cwd: MONITOR_DIR,
    env: {
      ...stripLegacyProxyEnv({ ...process.env, ...monitorEnv.env }),
      ...proxyEnv,
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let settle;
  const done = new Promise((resolve) => {
    settle = resolve;
  });

  const finish = (payload) => {
    liveRunning = false;
    liveChild = null;
    const text = logBuffer.join('\n');
    const summary = parseLiveCollectSummary(text);
    liveLast = {
      ...liveLast,
      ...payload,
      ...summary,
      log_tail: recentLiveLogTail(40),
    };
    appendLogFile(logBuffer);
    try {
      const tennisRedis = require('./tennisRedis');
      tennisRedis.invalidateMemCache();
    } catch { /* ignore */ }
    if (typeof settle === 'function') {
      settle({
        ok: payload.status === 'success',
        last: { ...liveLast },
        error: payload.error || null,
        summary,
        log_tail: liveLast.log_tail,
      });
    }
  };

  liveChild.stdout.on('data', (d) => pushLog(d));
  liveChild.stderr.on('data', (d) => pushLog(d));

  liveChild.on('error', (err) => {
    console.error('[tennis/collect-live] spawn error:', err.message);
    finish({
      status: 'failed',
      finished_at: nowIso(),
      error: err.message || 'spawn failed',
    });
  });

  liveChild.on('close', (code) => {
    const finishedAt = nowIso();
    const text = logBuffer.join('\n');
    const emptyRun = /完成:\s*无进行中比赛|无符合条件的比赛/.test(text);
    const summary = parseLiveCollectSummary(text);
    let error = null;
    if (code !== 0) {
      error = friendlyCollectError(code, text) || `collect_live.py 退出码 ${code}`;
    } else if (summary.no_proxy) {
      error = '未配置 IPWO 代理，无法采集比分/Polymarket';
    } else if (summary.redis_failed) {
      error = 'Redis 写入失败：请在 monitor.env 配置与 server 一致的 REDIS_URL';
    }
    finish({
      status: error ? 'failed' : 'success',
      finished_at: finishedAt,
      exit_code: code,
      error,
      events: [],
      live_count: emptyRun ? 0 : (summary.total_events != null ? summary.total_events : null),
      fetched_at: finishedAt,
    });
  });

  if (wait) {
    const timeoutMs = Number(process.env.COLLECT_LIVE_TIMEOUT_MS || 180000);
    const timed = Promise.race([
      done,
      new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            ok: false,
            timedOut: true,
            error: `collect_live.py timeout ${timeoutMs}ms`,
            last: { ...liveLast },
          });
        }, Math.max(30000, timeoutMs));
      }),
    ]);
    return { ok: true, done: timed, last: { ...liveLast } };
  }

  return { ok: true, last: { ...liveLast } };
}

function livePayload() {
  return {
    ok: true,
    running: liveRunning,
    interval_sec: readScheduleConfig().live_poll_interval_sec,
    last: { ...liveLast },
    source: 'local',
  };
}

function statusPayload() {
  const meta = readLatestBundleMeta();
  return {
    running,
    last: { ...last },
    cached_at: meta?.fetched_at || null,
    summary: meta
      ? { events: meta.events, date: meta.date, bundle_file: meta.bundle_file }
      : {},
    script: COLLECT_SCRIPT,
  };
}

function recentLogs(maxLines = 120) {
  const tail = logBuffer.slice(-maxLines);
  if (tail.length) return tail.join('\n');
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const files = fs
      .readdirSync(LOG_DIR)
      .filter((f) => f.startsWith('collect_') && f.endsWith('.log'))
      .map((f) => ({ f, m: fs.statSync(path.join(LOG_DIR, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    if (!files.length) return '';
    const raw = fs.readFileSync(path.join(LOG_DIR, files[0].f), 'utf8').split(/\r?\n/);
    return raw.slice(-maxLines).join('\n');
  } catch {
    return '';
  }
}

function clearLogs() {
  logBuffer = [];
  let deleted = 0;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    for (const f of fs.readdirSync(LOG_DIR)) {
      if (!f.startsWith('collect_') || !f.endsWith('.log')) continue;
      fs.writeFileSync(path.join(LOG_DIR, f), '', 'utf8');
      deleted += 1;
    }
  } catch (err) {
    const error = new Error(err.message || 'clear logs failed');
    error.status = 500;
    throw error;
  }
  return { ok: true, deleted };
}

module.exports = {
  startCollect,
  startLiveCollect,
  runLiveCollectAndWait,
  runInplayRefreshAndWait,
  statusPayload,
  livePayload,
  schedulePayload,
  updateSchedule,
  readScheduleConfig,
  recentLogs,
  clearLogs,
  isRunning: () => running,
  isLiveRunning: () => liveRunning,
  getLast: () => ({ ...last }),
  isCollectEnabled,
  isCollectAvailable: () => fs.existsSync(COLLECT_SCRIPT),
  isLiveCollectAvailable: () => fs.existsSync(COLLECT_LIVE_SCRIPT),
  isInplayRefreshAvailable: () => fs.existsSync(REFRESH_INPLAY_SCRIPT),
  getCollectScript: () => COLLECT_SCRIPT,
};
