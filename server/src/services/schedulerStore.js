/**
 * 调度任务 / 运行记录（MySQL 主存）
 */
const crypto = require('crypto');
const pool = require('../db');

let ready = false;

/** 可选任务类型（采集 / 条件 / 投注） */
const JOB_TYPE_DEFS = {
  'collect.full': {
    engine: 'collect',
    requireEngineOn: 'collect',
    defaultTimeout: 300,
    label: '采集引擎 · 全量拆三桶',
    category: 'collect',
    hidden: true,
  },
  'collect.top100': {
    engine: 'collect',
    requireEngineOn: 'collect',
    defaultTimeout: 900,
    label: 'Top100 全量采集',
    category: 'collect',
    intervalUnit: 'hour',
    intervalPresets: [6, 12],
    defaultIntervalSec: 6 * 3600,
    defaultName: 'Top100 全量采集',
  },
  'collect.inplay_tick': {
    engine: 'collect',
    requireEngineOn: 'collect',
    defaultTimeout: 120,
    label: '盘中比分刷新',
    category: 'collect',
    intervalUnit: 'second',
    intervalPresets: [30, 60, 120],
    defaultIntervalSec: 60,
    defaultName: '盘中比分刷新',
  },
  'collect.top100_hf': {
    engine: 'collect',
    requireEngineOn: 'collect',
    defaultTimeout: 120,
    label: 'Top100 高频采集',
    category: 'collect',
    intervalUnit: 'second',
    intervalPresets: [10, 30, 60, 120],
    defaultIntervalSec: 30,
    defaultName: 'Top100 高频采集',
  },
  'condition.query': {
    engine: 'condition',
    requireEngineOn: 'condition',
    defaultTimeout: 60,
    label: '条件引擎 · 查询筛选',
    category: 'condition',
  },
  'bet.scan': {
    engine: 'bet',
    requireEngineOn: 'betting',
    defaultTimeout: 120,
    label: '投注引擎 · 扫描下单',
    category: 'betting',
    hidden: true,
  },
  'bet.stop_loss': {
    engine: 'bet',
    requireEngineOn: 'betting',
    defaultTimeout: 120,
    label: '止损引擎 · 持仓止损扫描',
    category: 'stop',
  },
};

const PRESET_JOBS = [
  {
    id: 'job_collect_top100',
    name: 'Top100 全量采集',
    job_type: 'collect.top100',
    engine: 'collect',
    enabled: 0,
    schedule_mode: 'interval',
    interval_sec: 6 * 3600,
    mutex_key: 'job_collect_top100',
    skip_if_running: 1,
    require_engine_on: 'collect',
    timeout_sec: 900,
  },
  {
    id: 'job_collect_inplay_tick',
    name: '盘中比分刷新',
    job_type: 'collect.inplay_tick',
    engine: 'collect',
    enabled: 0,
    schedule_mode: 'interval',
    interval_sec: 60,
    mutex_key: 'job_collect_inplay_tick',
    skip_if_running: 1,
    require_engine_on: 'collect',
    timeout_sec: 120,
  },
  {
    id: 'job_collect_top100_hf',
    name: 'Top100 高频采集',
    job_type: 'collect.top100_hf',
    engine: 'collect',
    enabled: 0,
    schedule_mode: 'interval',
    interval_sec: 30,
    mutex_key: 'job_collect_top100_hf',
    skip_if_running: 1,
    require_engine_on: 'collect',
    timeout_sec: 120,
  },
  {
    id: 'job_condition_query',
    name: '条件查询筛选',
    job_type: 'condition.query',
    engine: 'condition',
    enabled: 0,
    schedule_mode: 'interval',
    interval_sec: 60,
    mutex_key: 'job_condition_query',
    skip_if_running: 1,
    require_engine_on: 'condition',
    timeout_sec: 60,
  },
  {
    id: 'job_bet_scan',
    name: '投注扫描',
    job_type: 'bet.scan',
    engine: 'bet',
    enabled: 0,
    schedule_mode: 'interval',
    interval_sec: 15,
    mutex_key: 'job_bet_scan',
    skip_if_running: 1,
    require_engine_on: 'betting',
    timeout_sec: 120,
  },
];

function normalizeDailyTime(v) {
  const s = String(v || '').trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

const PRESETS_SEEDED_KEY = 'scheduler_presets_seeded';

async function ensureAppSettingsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key VARCHAR(64) PRIMARY KEY,
      setting_value VARCHAR(512) NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

async function getAppSetting(key) {
  await ensureAppSettingsTable();
  const [[row]] = await pool.query(
    'SELECT setting_value FROM app_settings WHERE setting_key=? LIMIT 1',
    [key],
  );
  return row?.setting_value ?? '';
}

async function setAppSetting(key, value) {
  await ensureAppSettingsTable();
  await pool.query(
    `INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)`,
    [key, String(value ?? '').slice(0, 512)],
  );
}

/** 仅首次安装空库时写入预置；打标后用户删光任务也不会再自动恢复 */
async function seedPresetJobsIfNeeded() {
  if (await getAppSetting(PRESETS_SEEDED_KEY) === '1') return;
  const [[{ c }]] = await pool.query(`SELECT COUNT(*) AS c FROM scheduler_jobs`);
  if (Number(c) === 0) {
    for (const j of PRESET_JOBS) {
      await pool.query(
        `INSERT INTO scheduler_jobs
          (id, name, job_type, engine, enabled, schedule_mode, interval_sec,
           mutex_key, skip_if_running, require_engine_on, timeout_sec)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          j.id,
          j.name,
          j.job_type,
          j.engine,
          j.enabled,
          j.schedule_mode,
          j.interval_sec,
          j.mutex_key,
          j.skip_if_running,
          j.require_engine_on,
          j.timeout_sec,
        ],
      );
    }
  }
  await setAppSetting(PRESETS_SEEDED_KEY, '1');
}

async function ensureTables() {
  if (ready) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scheduler_jobs (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      name VARCHAR(128) NOT NULL,
      job_type VARCHAR(64) NOT NULL,
      engine VARCHAR(32) NOT NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      schedule_mode VARCHAR(16) NOT NULL,
      interval_sec INT NULL,
      cron_expr VARCHAR(64) NULL,
      timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Shanghai',
      params_json JSON NULL,
      mutex_key VARCHAR(128) NULL,
      skip_if_running TINYINT(1) NOT NULL DEFAULT 1,
      require_engine_on VARCHAR(64) NULL,
      timeout_sec INT NOT NULL DEFAULT 300,
      created_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_sched_jobs_enabled (enabled),
      INDEX idx_sched_jobs_type (job_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scheduler_runs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      run_id VARCHAR(64) NOT NULL,
      job_id VARCHAR(64) NOT NULL,
      trigger_type VARCHAR(16) NOT NULL,
      status VARCHAR(16) NOT NULL,
      message VARCHAR(512) NULL,
      error_msg VARCHAR(1024) NULL,
      metrics_json JSON NULL,
      started_at DATETIME NOT NULL,
      finished_at DATETIME NULL,
      UNIQUE KEY uk_sched_run_id (run_id),
      INDEX idx_sched_runs_job_started (job_id, started_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await seedPresetJobsIfNeeded();
  await pool.query(`UPDATE scheduler_jobs SET enabled=0 WHERE id='job_collect_full'`);
  await pool.query(
    `UPDATE scheduler_jobs SET name='盘中比分刷新' WHERE id='job_collect_inplay_tick' AND job_type='collect.inplay_tick'`,
  );
  ready = true;
}

function mapJob(row) {
  if (!row) return null;
  let params = null;
  if (row.params_json != null) {
    try {
      params = typeof row.params_json === 'string' ? JSON.parse(row.params_json) : row.params_json;
    } catch {
      params = null;
    }
  }
  const def = JOB_TYPE_DEFS[row.job_type];
  return {
    id: row.id,
    name: row.name,
    jobType: row.job_type,
    jobTypeLabel: def?.label || row.job_type,
    category: def?.category || row.engine,
    engine: row.engine,
    enabled: !!row.enabled,
    scheduleMode: row.schedule_mode,
    intervalSec: row.interval_sec != null ? Number(row.interval_sec) : null,
    cronExpr: row.cron_expr,
    dailyTime: row.schedule_mode === 'daily' ? row.cron_expr : null,
    timezone: row.timezone || 'Asia/Shanghai',
    params,
    mutexKey: row.mutex_key,
    skipIfRunning: !!row.skip_if_running,
    requireEngineOn: row.require_engine_on,
    timeoutSec: Number(row.timeout_sec || 300),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRun(row) {
  if (!row) return null;
  let metrics = null;
  if (row.metrics_json != null) {
    try {
      metrics = typeof row.metrics_json === 'string' ? JSON.parse(row.metrics_json) : row.metrics_json;
    } catch {
      metrics = null;
    }
  }
  return {
    id: row.id,
    runId: row.run_id,
    jobId: row.job_id,
    trigger: row.trigger_type,
    status: row.status,
    message: row.message,
    error: row.error_msg,
    metrics,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

async function listJobs() {
  await ensureTables();
  const [rows] = await pool.query(`SELECT * FROM scheduler_jobs ORDER BY created_at DESC, id`);
  return rows.map(mapJob);
}

async function getJob(id) {
  await ensureTables();
  const [rows] = await pool.query(`SELECT * FROM scheduler_jobs WHERE id=? LIMIT 1`, [id]);
  return mapJob(rows[0]);
}

function newJobId() {
  return `job_${crypto.randomBytes(8).toString('hex')}`;
}

function parseParamsJson(raw) {
  if (raw == null) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

function paramsGroupMatch(a, b) {
  return String(a?.bucket ?? '') === String(b?.bucket ?? '')
    && Number(a?.groupIndex) === Number(b?.groupIndex);
}

async function findDuplicateJobSlot(jobType, params) {
  const [rows] = await pool.query('SELECT job_type, params_json FROM scheduler_jobs WHERE job_type=?', [jobType]);
  if (String(jobType).startsWith('collect.')) {
    return rows.length ? rows[0] : null;
  }
  for (const row of rows) {
    const p = parseParamsJson(row.params_json);
    if (paramsGroupMatch(p, params)) return row;
  }
  return null;
}

async function createJob(input = {}) {
  await ensureTables();
  const jobType = String(input.jobType || '').trim();
  const def = JOB_TYPE_DEFS[jobType];
  if (!def) {
    const err = new Error(`unsupported jobType: ${jobType}`);
    err.status = 400;
    throw err;
  }
  const dup = await findDuplicateJobSlot(jobType, input.params);
  if (dup) {
    const err = new Error(
      String(jobType).startsWith('collect.')
        ? `任务类型 ${def.label || jobType} 已存在，无需重复添加`
        : '该分组已存在调度任务，无需重复添加',
    );
    err.status = 409;
    throw err;
  }
  const scheduleMode = input.scheduleMode === 'daily' ? 'daily' : 'interval';
  let intervalSec = null;
  let cronExpr = null;
  if (scheduleMode === 'interval') {
    intervalSec = Number(input.intervalSec);
    if (!(intervalSec > 0) || intervalSec > 86400 * 7) {
      const err = new Error('intervalSec must be 1..604800');
      err.status = 400;
      throw err;
    }
  } else {
    cronExpr = normalizeDailyTime(input.dailyTime || input.cronExpr);
    if (!cronExpr) {
      const err = new Error('dailyTime must be HH:mm');
      err.status = 400;
      throw err;
    }
  }
  const id = input.id && String(input.id).startsWith('job_') ? String(input.id) : newJobId();
  const existing = await getJob(id);
  if (existing) {
    // 已有任务：按修改处理，避免重复新增
    return updateJob(id, {
      name: input.name,
      enabled: input.enabled,
      scheduleMode: input.scheduleMode,
      intervalSec: input.intervalSec,
      dailyTime: input.dailyTime || input.cronExpr,
      timeoutSec: input.timeoutSec,
      params: input.params,
    });
  }
  const name = String(input.name || def.label).slice(0, 128);
  const timeoutSec = Number(input.timeoutSec) > 0 ? Number(input.timeoutSec) : def.defaultTimeout;
  const enabled = input.enabled === false || input.enabled === 0 ? 0 : 1;
  const paramsJson = input.params != null ? JSON.stringify(input.params) : null;
  await pool.query(
    `INSERT INTO scheduler_jobs
      (id, name, job_type, engine, enabled, schedule_mode, interval_sec, cron_expr,
       timezone, params_json, mutex_key, skip_if_running, require_engine_on, timeout_sec, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Asia/Shanghai', ?, ?, 1, ?, ?, ?)`,
    [
      id,
      name,
      jobType,
      def.engine,
      enabled,
      scheduleMode,
      intervalSec,
      cronExpr,
      paramsJson,
      id,
      def.requireEngineOn,
      timeoutSec,
      input.createdBy ?? null,
    ]
  );
  return getJob(id);
}

async function updateJob(id, patch = {}) {
  await ensureTables();
  const cur = await getJob(id);
  if (!cur) {
    const err = new Error('job not found');
    err.status = 404;
    throw err;
  }
  const enabled = patch.enabled != null ? (patch.enabled ? 1 : 0) : cur.enabled ? 1 : 0;
  const name = patch.name != null ? String(patch.name).slice(0, 128) : cur.name;
  const timeoutSec =
    patch.timeoutSec != null ? Number(patch.timeoutSec) : cur.timeoutSec;

  let scheduleMode = cur.scheduleMode;
  let intervalSec = cur.intervalSec;
  let cronExpr = cur.cronExpr;
  if (patch.scheduleMode === 'interval' || patch.scheduleMode === 'daily') {
    scheduleMode = patch.scheduleMode;
  }
  if (scheduleMode === 'interval') {
    if (patch.intervalSec != null) intervalSec = Number(patch.intervalSec);
    if (!(intervalSec > 0)) {
      const err = new Error('intervalSec must be > 0');
      err.status = 400;
      throw err;
    }
    cronExpr = null;
  } else if (scheduleMode === 'daily') {
    const t = normalizeDailyTime(patch.dailyTime ?? patch.cronExpr ?? cronExpr);
    if (!t) {
      const err = new Error('dailyTime must be HH:mm');
      err.status = 400;
      throw err;
    }
    cronExpr = t;
    intervalSec = null;
  }

  await pool.query(
    `UPDATE scheduler_jobs
     SET name=?, enabled=?, schedule_mode=?, interval_sec=?, cron_expr=?, timeout_sec=?,
         params_json=COALESCE(?, params_json), updated_at=NOW()
     WHERE id=?`,
    [
      name,
      enabled,
      scheduleMode,
      intervalSec,
      cronExpr,
      timeoutSec,
      patch.params !== undefined ? JSON.stringify(patch.params) : null,
      id,
    ]
  );
  return getJob(id);
}

async function setJobEnabled(id, enabled) {
  return updateJob(id, { enabled: !!enabled });
}

async function deleteJob(id) {
  await ensureTables();
  const cur = await getJob(id);
  if (!cur) {
    const err = new Error('job not found');
    err.status = 404;
    throw err;
  }
  await pool.query(`DELETE FROM scheduler_runs WHERE job_id=?`, [id]);
  await pool.query(`DELETE FROM scheduler_jobs WHERE id=?`, [id]);
  return true;
}

function newRunId() {
  return `run_${crypto.randomBytes(12).toString('hex')}`;
}

async function startRun({ jobId, trigger }) {
  await ensureTables();
  const runId = newRunId();
  await pool.query(
    `INSERT INTO scheduler_runs (run_id, job_id, trigger_type, status, started_at)
     VALUES (?, ?, ?, 'running', NOW())`,
    [runId, jobId, trigger]
  );
  return runId;
}

async function finishRun(runId, { status, message = null, error = null, metrics = null }) {
  await ensureTables();
  let metricsJson = null;
  if (metrics != null) {
    try {
      const copy = typeof metrics === 'object' ? { ...metrics } : { value: metrics };
      // 保证过程日志进库；过长截断避免撑爆 JSON 列
      const proc = String(copy.process_log || copy.log_tail || copy.refresh_inplay?.process_log || '');
      if (proc && !copy.process_log) copy.process_log = proc;
      if (typeof copy.process_log === 'string' && copy.process_log.length > 48000) {
        copy.process_log = `${copy.process_log.slice(0, 48000)}\n…(truncated)`;
      }
      metricsJson = JSON.stringify(copy);
    } catch {
      metricsJson = JSON.stringify({ error: 'metrics serialize failed' });
    }
  }
  await pool.query(
    `UPDATE scheduler_runs
     SET status=?, message=?, error_msg=?, metrics_json=?, finished_at=NOW()
     WHERE run_id=?`,
    [
      status,
      message != null ? String(message).slice(0, 512) : null,
      error != null ? String(error).slice(0, 1024) : null,
      metricsJson,
      runId,
    ]
  );
}

async function listRuns(jobId, { limit = 30, offset = 0 } = {}) {
  await ensureTables();
  const lim = Math.min(Math.max(Number(limit) || 30, 1), 200);
  const off = Math.max(Number(offset) || 0, 0);
  const [rows] = await pool.query(
    `SELECT * FROM scheduler_runs WHERE job_id=? ORDER BY started_at DESC LIMIT ? OFFSET ?`,
    [jobId, lim, off]
  );
  return rows.map(mapRun);
}

async function clearRuns(jobId) {
  await ensureTables();
  const cur = await getJob(jobId);
  if (!cur) {
    const err = new Error('job not found');
    err.status = 404;
    throw err;
  }
  const [r] = await pool.query(`DELETE FROM scheduler_runs WHERE job_id=?`, [jobId]);
  return { deleted: r?.affectedRows ?? 0 };
}

async function getRun(runId) {
  await ensureTables();
  const [rows] = await pool.query(`SELECT * FROM scheduler_runs WHERE run_id=? LIMIT 1`, [runId]);
  return mapRun(rows[0]);
}

async function hasRunningSchedule(jobId) {
  await ensureTables();
  const [rows] = await pool.query(
    `SELECT id FROM scheduler_runs
     WHERE job_id=? AND trigger_type='schedule' AND status='running'
     LIMIT 1`,
    [jobId]
  );
  return rows.length > 0;
}

function listJobTypeDefs() {
  return Object.entries(JOB_TYPE_DEFS)
    .filter(([, def]) => !def.hidden)
    .map(([jobType, def]) => ({
      jobType,
      ...def,
    }));
}

const BUCKET_LABEL = {
  prematch: '盘前',
  inplay: '盘中',
  settled: '盘后',
};

/**
 * 调度任务「名称」下拉选项：
 * - 采集：固定「采集」
 * - 条件：条件引擎各桶分组 name
 * - 止损：投注引擎各桶分组 name（止损扫描）
 */
async function listNameOptions() {
  const tennisEngines = require('./tennisEngines');
  const cfg = await tennisEngines.getConfig();
  const collect = [
    {
      key: 'collect:top100',
      value: 'Top100 全量采集',
      label: 'Top100 全量采集',
      category: 'collect',
      jobType: 'collect.top100',
    },
    {
      key: 'collect:inplay',
      value: '盘中比分刷新',
      label: '盘中比分刷新',
      category: 'collect',
      jobType: 'collect.inplay_tick',
    },
    {
      key: 'collect:top100_hf',
      value: 'Top100 高频采集',
      label: 'Top100 高频采集',
      category: 'collect',
      jobType: 'collect.top100_hf',
    },
  ];

  const condition = [];
  for (const bucket of ['prematch', 'inplay', 'settled']) {
    const groups = cfg.condition?.buckets?.[bucket]?.groups || [];
    groups.forEach((g, groupIndex) => {
      const groupName = (g?.name && String(g.name).trim()) || `未命名组${groupIndex + 1}`;
      condition.push({
        key: `condition:${bucket}:${groupIndex}`,
        value: groupName,
        label: `${BUCKET_LABEL[bucket] || bucket} · ${groupName}`,
        category: 'condition',
        bucket,
        groupIndex,
        groupName,
      });
    });
  }

  const stop = [];
  for (const bucket of ['prematch', 'inplay']) {
    const groups = cfg.betting?.buckets?.[bucket]?.groups || [];
    groups.forEach((g, groupIndex) => {
      const groupName = (g?.name && String(g.name).trim()) || `未命名组${groupIndex + 1}`;
      stop.push({
        key: `stop:${bucket}:${groupIndex}`,
        category: 'stop',
        value: groupName,
        label: `${BUCKET_LABEL[bucket] || bucket} · ${groupName}`,
        bucket,
        groupIndex,
        groupName,
      });
    });
  }

  return { collect, condition, stop };
}

module.exports = {
  ensureTables,
  listJobs,
  getJob,
  createJob,
  updateJob,
  setJobEnabled,
  deleteJob,
  startRun,
  finishRun,
  listRuns,
  clearRuns,
  getRun,
  hasRunningSchedule,
  listJobTypeDefs,
  listNameOptions,
  JOB_TYPE_DEFS,
  PRESET_JOBS,
  normalizeDailyTime,
};
