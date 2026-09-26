/**
 * Sofascore API via Python curl_cffi worker（Chrome TLS + IPWO，避免 Node 403）。
 */
const { spawn, spawnSync } = require('child_process');
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
    if (fs.existsSync(path.join(dir, 'tm', 'clients', 'sofascore.py'))) return path.resolve(dir);
  }
  return path.resolve(candidates[1]);
}

function monitorDir() {
  return resolveMonitorDir();
}

function workerScript() {
  return path.join(monitorDir(), 'bin', 'sofa_json_worker.py');
}

let curlAvailable = null;
let lastProbeNote = '';
let child = null;
let buf = '';
/** @type {{ resolve: (v: unknown) => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout> } | null} */
let current = null;
let starting = null;
let lastProxyKey = '';

function pythonBin() {
  if (process.env.TENNIS_PYTHON) return process.env.TENNIS_PYTHON;
  const dir = monitorDir();
  const inDocker = process.env.TENNIS_MONITOR_DIR === '/tennis-monitor';
  const venvPy = path.join(dir, 'venv', 'bin', 'python');
  const candidates = [
    ...(inDocker ? [] : [venvPy, path.join(dir, 'venv', 'Scripts', 'python.exe')]),
    process.env.PYTHON,
    ...(process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python']),
  ].filter(Boolean);
  for (const bin of candidates) {
    if (bin.includes(path.sep)) {
      if (fs.existsSync(bin)) return bin;
      continue;
    }
    try {
      const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      if (r.status === 0) return bin;
    } catch { /* next */ }
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

function resetProbe() {
  curlAvailable = null;
  lastProbeNote = '';
}

function probeCurlAvailable(force = false) {
  if (!force && curlAvailable != null) return curlAvailable;
  const dir = monitorDir();
  const script = workerScript();
  if (!fs.existsSync(script)) {
    curlAvailable = false;
    lastProbeNote = `worker missing: ${script}`;
    console.warn(`[tennis/sofa-curl] ${lastProbeNote}`);
    return false;
  }
  const bin = pythonBin();
  try {
    const r = spawnSync(
      bin,
      ['-c', 'from curl_cffi import requests; print("ok")'],
      {
        cwd: dir,
        env: { ...process.env, PYTHONPATH: dir },
        encoding: 'utf8',
        timeout: 15000,
        windowsHide: true,
      },
    );
    curlAvailable = r.status === 0 && String(r.stdout || '').includes('ok');
    if (!curlAvailable) {
      const detail = String(r.stderr || r.stdout || `exit ${r.status}`).trim().split(/\r?\n/)[0];
      lastProbeNote = `${bin}: ${detail || 'curl_cffi import failed'}`;
    }
  } catch (err) {
    curlAvailable = false;
    lastProbeNote = `${bin}: ${err?.message || err}`;
  }
  if (!curlAvailable) {
    console.warn(`[tennis/sofa-curl] curl_cffi unavailable (${lastProbeNote || 'unknown'})`);
  }
  return curlAvailable;
}

function probeNote() {
  return lastProbeNote;
}

function isEnabled() {
  if (String(process.env.SOFA_USE_NODE_HTTP || '').trim() === '1') return false;
  return probeCurlAvailable(false);
}

function proxyEnvKey() {
  return [
    process.env.SOFA_HTTP_PROXY || '',
    process.env.HTTP_PROXY || '',
    process.env.COLLECT_PROXY_JOB || '',
  ].join('|');
}

function failCurrent(err) {
  if (!current) return;
  clearTimeout(current.timer);
  current.reject(err);
  current = null;
}

function onStdout(chunk) {
  buf += String(chunk || '');
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line || !current) continue;
    const p = current;
    current = null;
    clearTimeout(p.timer);
    try {
      const msg = JSON.parse(line);
      if (msg.ok) p.resolve(msg.data);
      else p.reject(new Error(msg.error || 'sofa worker failed'));
    } catch (e) {
      p.reject(e);
    }
  }
}

async function ensureWorker() {
  const key = proxyEnvKey();
  if (child && !child.killed && key !== lastProxyKey) {
    closeWorker();
  }
  lastProxyKey = key;
  if (child && !child.killed) return child;
  if (starting) return starting;
  starting = new Promise((resolve, reject) => {
    const bin = pythonBin();
    const dir = monitorDir();
    const proc = spawn(bin, ['-u', workerScript()], {
      cwd: dir,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',
        PYTHONPATH: dir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child = proc;
    buf = '';
    proc.stdout.on('data', onStdout);
    proc.stderr.on('data', (d) => {
      const t = String(d || '').trim();
      if (t) console.warn('[tennis/sofa-curl]', t.slice(0, 300));
    });
    proc.on('error', (err) => {
      failCurrent(err);
      child = null;
      starting = null;
    });
    proc.on('close', (code) => {
      failCurrent(new Error(`sofa worker exited ${code ?? '?'}`));
      child = null;
      starting = null;
    });
    setTimeout(() => {
      starting = null;
      resolve(proc);
    }, 80);
  });
  return starting;
}

function bumpIpwo() {
  try {
    const { bumpSofaIpwo } = require('../lib/httpProxyAgent');
    if (typeof bumpSofaIpwo === 'function') bumpSofaIpwo();
  } catch { /* ignore */ }
}

/**
 * @param {string} apiPath Sofascore API path (no host)
 * @param {{ timeoutMs?: number, referer?: string }} [opts]
 */
let chain = Promise.resolve();

async function apiGet(apiPath, opts = {}) {
  const run = async () => {
    await ensureWorker();
    if (!child || child.killed) throw new Error('sofa worker not running');
    const timeoutMs = Math.max(5000, Number(opts.timeoutMs) || 90000);
    const data = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (current) current = null;
        reject(new Error(`sofa worker timeout ${timeoutMs}ms`));
      }, timeoutMs);
      current = { resolve, reject, timer };
      try {
        child.stdin.write(
          `${JSON.stringify({ cmd: 'get', path: apiPath, referer: opts.referer || null })}\n`,
        );
      } catch (err) {
        clearTimeout(timer);
        current = null;
        reject(err);
      }
    });
    bumpIpwo();
    return data;
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

function closeWorker() {
  if (!child || child.killed) return;
  try {
    child.stdin.write('{"cmd":"quit"}\n');
  } catch { /* ignore */ }
  try {
    child.kill();
  } catch { /* ignore */ }
  child = null;
  lastProxyKey = '';
  failCurrent(new Error('sofa worker closed'));
}

module.exports = {
  isEnabled,
  apiGet,
  closeWorker,
  resetProbe,
  probeNote,
  get WORKER_SCRIPT() {
    return workerScript();
  },
  get MONITOR_DIR() {
    return monitorDir();
  },
};
