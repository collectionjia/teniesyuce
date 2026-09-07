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

function isCollectEnabled() {
  try {
    if (!fs.existsSync(SCHEDULE_FILE)) return true;
    const data = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
    return data.collect_enabled !== false;
  } catch {
    return true;
  }
}
const COLLECT_SCRIPT = path.join(MONITOR_DIR, 'collect.py');
const OUTPUT_DIR = path.join(MONITOR_DIR, 'output');
const LOG_DIR = path.join(MONITOR_DIR, 'logs');

let running = false;
let child = null;
let last = { status: 'idle' };
let logBuffer = [];

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
    'python3',
    'python',
  ].filter(Boolean);
  for (const bin of candidates) {
    if (bin.includes(path.sep) && fs.existsSync(bin)) return bin;
  }
  return 'python3';
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
  console.log(`[tennis/collect] spawn ${bin} ${args.join(' ')}`);

  child = spawn(bin, args, {
    cwd: MONITOR_DIR,
    env: { ...process.env },
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
    const totalEvents = parsedEvents ?? meta?.events ?? 0;
    const requests = meta?.requests || null;
    const elapsed = elapsedSecFromTiming(meta?.timing);

    if (code === 0 && totalEvents > 0) {
      last = {
        status: 'success',
        trigger: 'admin-collect.py',
        started_at: last.started_at,
        finished_at: finishedAt,
        exit_code: code,
        error: null,
        total_events: totalEvents,
        requests,
        elapsed_sec: elapsed,
        bundle_file: meta?.bundle_file || null,
      };
      console.log(`[tennis/collect] done events=${totalEvents} elapsed=${elapsed ?? '-'}s`);
    } else if (code === 0) {
      last = {
        status: 'failed',
        trigger: 'admin-collect.py',
        started_at: last.started_at,
        finished_at: finishedAt,
        exit_code: code,
        error: '无符合条件的比赛',
        total_events: 0,
        requests,
        elapsed_sec: elapsed,
      };
    } else {
      last = {
        status: 'failed',
        trigger: 'admin-collect.py',
        started_at: last.started_at,
        finished_at: finishedAt,
        exit_code: code,
        error: `collect.py 退出码 ${code}`,
        total_events: totalEvents || null,
        requests,
        elapsed_sec: elapsed,
      };
    }
    appendLogFile(logBuffer);
  });

  return { ok: true, message: 'collect.py started', last: { ...last } };
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
  statusPayload,
  recentLogs,
  isRunning: () => running,
  getLast: () => ({ ...last }),
  isCollectEnabled,
  isCollectAvailable: () => fs.existsSync(COLLECT_SCRIPT),
  getCollectScript: () => COLLECT_SCRIPT,
};
