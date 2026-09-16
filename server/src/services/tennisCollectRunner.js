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
const OUTPUT_DIR = path.join(MONITOR_DIR, 'output');
const LOG_DIR = path.join(MONITOR_DIR, 'logs');

const ALLOWED_COLLECT_INTERVALS = [0, 2, 4, 6, 12];
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
    interval_hours: 6,
    collect_enabled: true,
    live_poll_interval_sec: 300,
    collect_horizon_days: 1,
  };
  try {
    if (!fs.existsSync(SCHEDULE_FILE)) return { ...defaults };
    const data = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
    let hours = Number(data.interval_hours ?? defaults.interval_hours);
    if (!ALLOWED_COLLECT_INTERVALS.includes(hours)) hours = defaults.interval_hours;
    let liveSec = Number(data.live_poll_interval_sec ?? defaults.live_poll_interval_sec);
    if (!ALLOWED_LIVE_POLL_INTERVALS.includes(liveSec)) liveSec = defaults.live_poll_interval_sec;
    let horizon = Number(data.collect_horizon_days ?? defaults.collect_horizon_days);
    if (!ALLOWED_COLLECT_HORIZON_DAYS.includes(horizon)) horizon = defaults.collect_horizon_days;
    const enabled = data.collect_enabled;
    return {
      interval_hours: hours,
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
  fs.mkdirSync(path.dirname(SCHEDULE_FILE), { recursive: true });
  fs.writeFileSync(SCHEDULE_FILE, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
}

function schedulePayload() {
  const cfg = readScheduleConfig();
  const hours = cfg.interval_hours;
  const liveSec = cfg.live_poll_interval_sec;
  const horizon = cfg.collect_horizon_days;
  const labels = { 0: '关闭', 60: '1 分钟', 120: '2 分钟', 300: '5 分钟' };
  const horizonLabels = { 1: '今天(1天)', 2: '今天起2天', 3: '今天起3天', 5: '今天起5天' };
  return {
    ok: true,
    interval_hours: hours,
    collect_enabled: cfg.collect_enabled !== false,
    live_poll_interval_sec: liveSec,
    collect_horizon_days: horizon,
    allowed_intervals: ALLOWED_COLLECT_INTERVALS,
    allowed_live_poll_intervals: ALLOWED_LIVE_POLL_INTERVALS,
    allowed_collect_horizon_days: ALLOWED_COLLECT_HORIZON_DAYS,
    cron: cfg.collect_enabled && hours > 0 ? `0 */${hours} * * *` : null,
    note: 'Docker 无 9004 时由 server 读写 config/schedule.json（定时需另配 cron/宿主机）',
    live_poll_label: labels[liveSec] || `${liveSec} 秒`,
    collect_horizon_label: horizonLabels[horizon] || `今天起${horizon}天`,
    source: 'local',
  };
}

function updateSchedule(body = {}) {
  const cfg = readScheduleConfig();
  if (body.interval_hours != null) {
    const hours = Number(body.interval_hours);
    if (!ALLOWED_COLLECT_INTERVALS.includes(hours)) {
      const err = new Error(`interval_hours must be one of ${ALLOWED_COLLECT_INTERVALS.join(',')}`);
      err.status = 400;
      throw err;
    }
    cfg.interval_hours = hours;
  }
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
  // 把「未开赛采集间隔」同步到调度任务 collect.top100（小时 → 秒）
  setImmediate(() => {
    syncTop100CollectJob(cfg).catch((e) => {
      console.warn('[tennisCollectRunner] syncTop100CollectJob', e.message || e);
    });
  });
  return schedulePayload();
}

async function syncTop100CollectJob(cfg) {
  const store = require('./schedulerStore');
  await store.ensureTables();
  const hours = Number(cfg.interval_hours);
  const enabled = cfg.collect_enabled !== false && hours > 0;
  const intervalSec = hours > 0 ? Math.round(hours * 3600) : 6 * 3600;
  const id = 'job_collect_top100';
  const existing = await store.getJob(id);
  const body = {
    name: '网球·Top100采集(collect.py)',
    scheduleMode: 'interval',
    intervalSec,
    enabled,
    timeoutSec: 900,
    params: { top100: true },
  };
  if (existing) {
    await store.updateJob(id, body);
    return;
  }
  if (!enabled) return;
  await store.createJob({
    id,
    jobType: 'collect.top100',
    ...body,
  });
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
    return 'IPWO 代理被拒绝 (403)，请检查 monitor.env 代理账号/额度，或临时改直连';
  }
  const failLine = [...t.split(/\r?\n/)].reverse().find((l) => /采集失败:/.test(l));
  if (failLine) return failLine.replace(/^采集失败:\s*/, '').slice(0, 200);
  const errLine = [...t.split(/\r?\n/)].reverse().find((l) => /Error:|Traceback|HTTP \d{3}/.test(l));
  if (errLine) return errLine.slice(0, 200);
  return `collect.py 退出码 ${code}`;
}

function elapsedSecFromTiming(timing) {
  const total = timing?.total;
  return typeof total === 'number' && Number.isFinite(total) ? Math.round(total * 10) / 10 : null;
}

function startCollect({ matchDate = null, top100 = true } = {}) {
  if (running) {
    return { ok: false, status: 409, error: 'collect already running', last };
  }
  if (!isCollectEnabled()) {
    return { ok: false, status: 403, error: '采集已关闭，请在管理页打开采集开关', last };
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
  console.log(`[tennis/collect] spawn ${bin} -u ${args.join(' ')}`);

  child = spawn(bin, ['-u', ...args], {
    cwd: MONITOR_DIR,
    env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
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

function startLiveCollect() {
  if (liveRunning) {
    return { ok: false, status: 409, error: 'live collect already running', last: { ...liveLast } };
  }
  if (!isCollectEnabled()) {
    return { ok: false, status: 403, error: '采集已关闭，请在管理页打开采集开关', last: { ...liveLast } };
  }
  if (!fs.existsSync(COLLECT_LIVE_SCRIPT)) {
    return { ok: false, status: 500, error: `collect_live.py not found: ${COLLECT_LIVE_SCRIPT}` };
  }

  liveRunning = true;
  const startedAt = nowIso();
  liveLast = {
    status: 'running',
    trigger: 'admin-collect_live.py',
    started_at: startedAt,
    finished_at: null,
    error: null,
    events: [],
    live_count: null,
  };
  pushLog(`=== collect_live.py --filter=true ${startedAt} trigger=admin ===`);

  const bin = pythonBin();
  const liveArgs = ['-u', COLLECT_LIVE_SCRIPT, '--filter=true'];
  console.log(`[tennis/collect-live] spawn ${bin} ${liveArgs.join(' ')}`);
  liveChild = spawn(bin, liveArgs, {
    cwd: MONITOR_DIR,
    env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  liveChild.stdout.on('data', (d) => pushLog(d));
  liveChild.stderr.on('data', (d) => pushLog(d));

  liveChild.on('error', (err) => {
    liveRunning = false;
    liveChild = null;
    liveLast = {
      ...liveLast,
      status: 'failed',
      finished_at: nowIso(),
      error: err.message || 'spawn failed',
    };
    appendLogFile(logBuffer);
    console.error('[tennis/collect-live] spawn error:', err.message);
  });

  liveChild.on('close', (code) => {
    liveRunning = false;
    liveChild = null;
    const finishedAt = nowIso();
    const text = logBuffer.join('\n');
    const emptyRun = /完成:\s*无进行中比赛|无符合条件的比赛/.test(text);
    liveLast = {
      status: code === 0 ? 'success' : 'failed',
      trigger: 'admin-collect_live.py',
      started_at: liveLast.started_at,
      finished_at: finishedAt,
      exit_code: code,
      error: code === 0 ? null : (friendlyCollectError(code, text) || `collect_live.py 退出码 ${code}`),
      events: [],
      live_count: emptyRun ? 0 : null,
      fetched_at: finishedAt,
    };
    appendLogFile(logBuffer);
    try {
      const tennisRedis = require('./tennisRedis');
      tennisRedis.invalidateMemCache();
    } catch { /* ignore */ }
  });

  return { ok: true, message: 'collect_live.py started', last: { ...liveLast } };
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

module.exports = {
  startCollect,
  startLiveCollect,
  statusPayload,
  livePayload,
  schedulePayload,
  updateSchedule,
  syncTop100CollectJob,
  readScheduleConfig,
  recentLogs,
  isRunning: () => running,
  isLiveRunning: () => liveRunning,
  getLast: () => ({ ...last }),
  isCollectEnabled,
  isCollectAvailable: () => fs.existsSync(COLLECT_SCRIPT),
  isLiveCollectAvailable: () => fs.existsSync(COLLECT_LIVE_SCRIPT),
  getCollectScript: () => COLLECT_SCRIPT,
};
