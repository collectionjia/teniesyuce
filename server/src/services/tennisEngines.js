/**
 * 网球三引擎配置（管理员）：采集 / 条件 / 投注
 * 存 Redis tennis:engines:config
 *
 * 条件引擎 buckets：
 *   prematch|inplay|settled: { enabled, groups[] }
 *   groups = 条件组库（组间 AND/OR 在产品管理配置）；组内字段 AND
 *   组字段：id / name / tour / pm / gapMin / rankDiffMin / rankDiffMax / strongRankMax / strongRankGt / strongRankLt / gapMode
 */
const crypto = require('crypto');
const redis = require('./redis');

const CONFIG_KEY = 'tennis:engines:config';
const ALLOWED_TICK_SEC = [1, 2, 5, 10];
const BUCKET_KEYS = ['prematch', 'inplay', 'settled'];
const BETTING_BUCKET_KEYS = ['prematch', 'inplay'];

function newGroupId() {
  return crypto.randomBytes(8).toString('hex');
}

function emptyGroup() {
  return {
    id: newGroupId(),
    name: '',
    tour: 'all',
    pm: 'all',
    gapMin: 'all',
    rankDiffMin: 'all',
    rankDiffMax: 'all',
    strongRankMax: 'all',
    /** 强现开区间下界：rank > strongRankGt（如 0） */
    strongRankGt: 'all',
    /** 强现开区间上界：rank < strongRankLt（如 10） */
    strongRankLt: 'all',
    gapMode: 'all',
    /** 盘中：要求强者已赢首盘 */
    requireWonFirstSet: false,
    /** 勾选后排除首盘局分为 firstSetExcludeScore（默认 7:5）的场次 */
    firstSetExcludeEnabled: false,
    firstSetExcludeScore: '7:5',
  };
}

function emptyStopRule() {
  return {
    name: '',
    joinPrev: 'or',
    stopFormat: 'bo3',
    stopSetIndex: 3,
    stopStrongSets: 'all',
    stopWeakSets: 'all',
    stopGameLead: 2,
    stopWeakGamesMin: 'all',
  };
}

function emptyBettingGroup(kind = 'inplay') {
  const isInplay = kind === 'inplay';
  return {
    id: newGroupId(),
    name: '',
    joinPrev: 'or',
    stopEnabled: isInplay,
    stopRules: isInplay ? [emptyStopRule()] : [],
  };
}

function normalizeGroup(g) {
  const base = emptyGroup();
  if (!g || typeof g !== 'object' || Array.isArray(g)) return base;
  const id = g.id != null && String(g.id).trim() ? String(g.id).trim().slice(0, 40) : newGroupId();
  const excludeScore = g.firstSetExcludeScore != null && String(g.firstSetExcludeScore).trim()
    ? String(g.firstSetExcludeScore).trim().slice(0, 12)
    : base.firstSetExcludeScore;
  return {
    id,
    name: g.name != null ? String(g.name).slice(0, 40) : '',
    tour: g.tour != null ? g.tour : base.tour,
    pm: g.pm != null ? g.pm : base.pm,
    gapMin: g.gapMin != null ? g.gapMin : base.gapMin,
    rankDiffMin: g.rankDiffMin != null ? g.rankDiffMin : base.rankDiffMin,
    rankDiffMax: g.rankDiffMax != null ? g.rankDiffMax : base.rankDiffMax,
    strongRankMax: g.strongRankMax != null ? g.strongRankMax : base.strongRankMax,
    strongRankGt: g.strongRankGt != null ? g.strongRankGt : base.strongRankGt,
    strongRankLt: g.strongRankLt != null ? g.strongRankLt : base.strongRankLt,
    gapMode: g.gapMode != null ? g.gapMode : base.gapMode,
    requireWonFirstSet: g.requireWonFirstSet === true,
    firstSetExcludeEnabled: g.firstSetExcludeEnabled === true,
    firstSetExcludeScore: excludeScore || '7:5',
  };
}

function normalizeStopRule(r) {
  const base = emptyStopRule();
  if (!r || typeof r !== 'object') return base;
  const join = String(r.joinPrev || 'or').toLowerCase();
  const fmt = String(r.stopFormat || base.stopFormat).toLowerCase();
  const setIndex = Number(r.stopSetIndex);
  return {
    name: r.name != null ? String(r.name).slice(0, 40) : '',
    joinPrev: join === 'and' ? 'and' : 'or',
    stopFormat: ['bo3', 'bo5', 'any'].includes(fmt) ? fmt : 'any',
    stopSetIndex: Number.isFinite(setIndex) ? Math.max(1, Math.min(5, setIndex)) : base.stopSetIndex,
    stopStrongSets: r.stopStrongSets != null ? r.stopStrongSets : base.stopStrongSets,
    stopWeakSets: r.stopWeakSets != null ? r.stopWeakSets : base.stopWeakSets,
    stopGameLead: r.stopGameLead != null ? Number(r.stopGameLead) : base.stopGameLead,
    stopWeakGamesMin: r.stopWeakGamesMin != null ? r.stopWeakGamesMin : base.stopWeakGamesMin,
  };
}

function migrateLegacyStop(g, base) {
  if (g.stopFormat != null || g.stopSetIndex != null) {
    return {
      stopFormat: g.stopFormat != null ? g.stopFormat : base.stopFormat,
      stopSetIndex: g.stopSetIndex != null ? Number(g.stopSetIndex) : base.stopSetIndex,
      stopStrongSets: g.stopStrongSets != null ? g.stopStrongSets : base.stopStrongSets,
      stopWeakSets: g.stopWeakSets != null ? g.stopWeakSets : base.stopWeakSets,
      stopGameLead: g.stopGameLead != null ? Number(g.stopGameLead) : base.stopGameLead,
      stopWeakGamesMin: g.stopWeakGamesMin != null ? g.stopWeakGamesMin : base.stopWeakGamesMin,
    };
  }
  if (g.stopBo5PathB === true) {
    return { stopFormat: 'bo5', stopSetIndex: 4, stopStrongSets: 1, stopWeakSets: 2, stopGameLead: 2, stopWeakGamesMin: 'all' };
  }
  if (g.stopBo5Set5 === true) {
    return { stopFormat: 'bo5', stopSetIndex: 5, stopStrongSets: 2, stopWeakSets: 2, stopGameLead: 2, stopWeakGamesMin: 'all' };
  }
  if (g.stopBo3 === true) {
    return { stopFormat: 'bo3', stopSetIndex: 3, stopStrongSets: 1, stopWeakSets: 1, stopGameLead: 2, stopWeakGamesMin: 'all' };
  }
  return null;
}

function resolveStopRules(g, kind = 'inplay') {
  // 显式空数组 = 无止损，勿回填默认条
  if (Array.isArray(g?.stopRules)) {
    return g.stopRules.map(normalizeStopRule);
  }
  const legacy = migrateLegacyStop(g || {}, emptyStopRule());
  if (legacy) return [normalizeStopRule(legacy)];
  return kind === 'inplay' ? [emptyStopRule()] : [];
}

function normalizeBettingGroup(g, kind = 'inplay') {
  const base = emptyBettingGroup(kind);
  if (!g || typeof g !== 'object' || Array.isArray(g)) return base;
  const join = String(g.joinPrev || 'or').toLowerCase();
  const id = g.id != null && String(g.id).trim() ? String(g.id).trim().slice(0, 40) : newGroupId();
  return {
    id,
    name: g.name != null ? String(g.name).slice(0, 40) : '',
    joinPrev: join === 'and' ? 'and' : 'or',
    stopEnabled: g.stopEnabled != null ? !!g.stopEnabled : base.stopEnabled,
    stopRules: resolveStopRules(g, kind),
  };
}

function flatRulesToGroup(flat) {
  if (!flat || typeof flat !== 'object') return emptyGroup();
  return normalizeGroup(flat);
}

function defaultBucket(flatRules, enabled = false) {
  return {
    enabled: !!enabled,
    groups: [flatRulesToGroup(flatRules)],
  };
}

function defaultSection9StopRules() {
  return [
    normalizeStopRule({
      name: 'BO3·第3盘',
      joinPrev: 'or',
      stopFormat: 'bo3',
      stopSetIndex: 3,
      stopStrongSets: 1,
      stopWeakSets: 1,
      stopGameLead: 2,
    }),
    normalizeStopRule({
      name: 'BO5·第4盘',
      joinPrev: 'or',
      stopFormat: 'bo5',
      stopSetIndex: 4,
      stopStrongSets: 1,
      stopWeakSets: 2,
      stopGameLead: 2,
    }),
    normalizeStopRule({
      name: 'BO5·第5盘',
      joinPrev: 'or',
      stopFormat: 'bo5',
      stopSetIndex: 5,
      stopStrongSets: 2,
      stopWeakSets: 2,
      stopGameLead: 2,
    }),
  ];
}

function defaultInplayBettingGroups() {
  const stops = defaultSection9StopRules();
  return [
    normalizeBettingGroup({
      name: '止损组 A',
      joinPrev: 'or',
      stopEnabled: true,
      stopRules: stops,
    }, 'inplay'),
    normalizeBettingGroup({
      name: '止损组 B',
      joinPrev: 'or',
      stopEnabled: true,
      stopRules: stops,
    }, 'inplay'),
  ];
}

function defaultPrematchBettingGroups() {
  return [
    normalizeBettingGroup({
      name: '盘前止损',
      joinPrev: 'or',
      stopEnabled: false,
      stopRules: [],
    }, 'prematch'),
  ];
}

const DEFAULT_CONFIG = {
  collect: {
    enabled: true,
    inplay_tick_enabled: true,
    inplay_tick_interval_sec: 5,
  },
  condition: {
    enabled: false,
    buckets: {
      prematch: defaultBucket(
        { tour: 'all', pm: 'all', gapMin: 50, rankDiffMax: 0, strongRankMax: 20 },
        false,
      ),
      inplay: defaultBucket(
        { tour: 'all', pm: 'all', strongRankMax: 100, gapMode: 'all' },
        false,
      ),
      settled: defaultBucket(
        { tour: 'all', pm: 'all', strongRankMax: 100 },
        false,
      ),
    },
  },
  betting: {
    enabled: false,
    userId: null,
    userAccount: null,
    amountUsd: 1,
    buckets: {
      prematch: { enabled: false, groups: defaultPrematchBettingGroups() },
      inplay: { enabled: false, groups: defaultInplayBettingGroups() },
    },
    rules: {
      note: '盘前/盘中分桶；买入条件在产品管理选择；此处仅配止损',
    },
  },
};

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object') return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object' && base[k] && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** 旧版 condition.rules 扁平结构 → buckets；并规范化 groups */
function normalizeCondition(condition) {
  const c = condition && typeof condition === 'object' ? { ...condition } : { enabled: false };
  const legacy = c.rules && typeof c.rules === 'object' ? c.rules : {};
  const src = c.buckets && typeof c.buckets === 'object' ? c.buckets : null;
  const buckets = {};
  for (const key of BUCKET_KEYS) {
    const raw = src?.[key];
    // 显式 groups 数组（含空数组）必须保留，否则删除会被 normalize 回默认组
    if (raw && Array.isArray(raw.groups)) {
      buckets[key] = {
        enabled: !!raw.enabled,
        groups: raw.groups.map(normalizeGroup),
      };
    } else if (raw && typeof raw === 'object' && !Array.isArray(raw.groups) && (raw.gapMin != null || raw.strongRankMax != null || raw.tour)) {
      // 误把扁平规则写在 bucket 上
      buckets[key] = {
        enabled: !!raw.enabled,
        groups: [normalizeGroup(raw)],
      };
    } else {
      buckets[key] = defaultBucket(legacy[key], !!c.enabled);
      if (src?.[key]?.enabled != null) buckets[key].enabled = !!src[key].enabled;
    }
  }
  c.buckets = buckets;
  c.enabled = !!c.enabled;
  return c;
}

function normalizeBetting(betting) {
  const b = betting && typeof betting === 'object' ? { ...betting } : {};
  const legacyPm = Number(b.rules?.pmMaxCents);
  const src = b.buckets && typeof b.buckets === 'object' ? b.buckets : null;
  const buckets = {};
  for (const key of BETTING_BUCKET_KEYS) {
    const raw = src?.[key];
    if (raw && Array.isArray(raw.groups)) {
      buckets[key] = {
        enabled: !!raw.enabled,
        groups: raw.groups.map((g) => normalizeBettingGroup(g, key)),
      };
    } else {
      buckets[key] = {
        enabled: false,
        groups: key === 'inplay' ? defaultInplayBettingGroups() : defaultPrematchBettingGroups(),
      };
      if (Number.isFinite(legacyPm) && key === 'inplay') {
        buckets[key].groups = buckets[key].groups.map((g) => ({ ...g, pmMaxCents: legacyPm }));
      }
      if (raw?.enabled != null) buckets[key].enabled = !!raw.enabled;
    }
  }
  // 旧版仅全局 enabled + rules：视为盘中桶
  if (!src && b.enabled && b.rules) {
    buckets.inplay.enabled = true;
  }
  b.buckets = buckets;
  b.enabled = !!b.enabled;
  b.userId = b.userId != null && b.userId !== '' ? Number(b.userId) || null : null;
  b.userAccount = b.userAccount != null && String(b.userAccount).trim()
    ? String(b.userAccount).trim()
    : null;
  b.amountUsd = b.amountUsd != null ? Number(b.amountUsd) || 1 : 1;
  b.rules = {
    note: b.rules?.note || '盘前/盘中分桶；多组 OR；组内买入且止损可配',
  };
  return b;
}

function normalizeConfig(cfg) {
  const next = cfg && typeof cfg === 'object' ? { ...cfg } : JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  next.condition = normalizeCondition(next.condition || {});
  next.betting = normalizeBetting(next.betting || {});
  return next;
}

async function getConfig() {
  const client = await redis.getClient();
  if (!client) return normalizeConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
  try {
    const raw = await client.get(CONFIG_KEY);
    const cfg = normalizeConfig(raw ? JSON.parse(raw) : JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
    await enrichBettingAccount(cfg);
    return cfg;
  } catch (e) {
    console.error('[tennis/engines] getConfig', e.message);
    return normalizeConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
  }
}

async function enrichBettingAccount(cfg) {
  try {
    const pool = require('../db');
    const bet = cfg?.betting;
    if (!bet) return;
    if (bet.userAccount && !bet.userId) {
      const [[row]] = await pool.query(
        'SELECT id, account FROM users WHERE account=? LIMIT 1',
        [String(bet.userAccount).trim()]
      );
      if (row) {
        bet.userId = row.id;
        bet.userAccount = row.account;
      }
    } else if (bet.userId && !bet.userAccount) {
      const [[row]] = await pool.query(
        'SELECT id, account FROM users WHERE id=? LIMIT 1',
        [Number(bet.userId)]
      );
      if (row) bet.userAccount = row.account;
    }
  } catch (e) {
    console.warn('[tennis/engines] enrichBettingAccount', e.message);
  }
}

async function resolveBettingUser(patchBetting, nextBetting) {
  const pool = require('../db');
  const accountRaw = patchBetting?.userAccount;
  if (accountRaw !== undefined) {
    const account = accountRaw != null ? String(accountRaw).trim() : '';
    if (!account) {
      nextBetting.userId = null;
      nextBetting.userAccount = null;
      return;
    }
    const [[row]] = await pool.query(
      'SELECT id, account FROM users WHERE account=? LIMIT 1',
      [account]
    );
    if (!row) {
      const err = new Error(`投注账号不存在：${account}`);
      err.status = 400;
      throw err;
    }
    nextBetting.userId = row.id;
    nextBetting.userAccount = row.account;
    return;
  }
  if (patchBetting?.userId !== undefined) {
    const uid = Number(patchBetting.userId);
    if (!Number.isFinite(uid) || uid <= 0) {
      nextBetting.userId = null;
      nextBetting.userAccount = null;
      return;
    }
    const [[row]] = await pool.query(
      'SELECT id, account FROM users WHERE id=? LIMIT 1',
      [uid]
    );
    if (!row) {
      const err = new Error(`投注账号ID不存在：${uid}`);
      err.status = 400;
      throw err;
    }
    nextBetting.userId = row.id;
    nextBetting.userAccount = row.account;
  }
}

async function setConfig(patch) {
  const cur = await getConfig();
  let next = deepMerge(cur, patch || {});
  // 整桶 groups 以 patch 为准（避免与旧组合并残留）
  const patchBuckets = patch?.condition?.buckets;
  if (patchBuckets && typeof patchBuckets === 'object') {
    next.condition = next.condition || {};
    next.condition.buckets = next.condition.buckets || {};
    for (const key of BUCKET_KEYS) {
      if (!patchBuckets[key]) continue;
      const p = patchBuckets[key];
      const base = next.condition.buckets[key] || defaultBucket(null, false);
      next.condition.buckets[key] = {
        enabled: p.enabled != null ? !!p.enabled : !!base.enabled,
        groups: Array.isArray(p.groups) ? p.groups.map(normalizeGroup) : (base.groups || [emptyGroup()]),
      };
    }
  }
  const patchBetBuckets = patch?.betting?.buckets;
  if (patchBetBuckets && typeof patchBetBuckets === 'object') {
    next.betting = next.betting || {};
    next.betting.buckets = next.betting.buckets || {};
    for (const key of BETTING_BUCKET_KEYS) {
      if (!patchBetBuckets[key]) continue;
      const p = patchBetBuckets[key];
      const base = next.betting.buckets[key] || {
        enabled: false,
        groups: key === 'inplay' ? defaultInplayBettingGroups() : defaultPrematchBettingGroups(),
      };
      next.betting.buckets[key] = {
        enabled: p.enabled != null ? !!p.enabled : !!base.enabled,
        groups: Array.isArray(p.groups)
          ? p.groups.map((g) => normalizeBettingGroup(g, key))
          : (base.groups || [emptyBettingGroup(key)]),
      };
    }
  }
  next = normalizeConfig(next);
  if (patch?.betting) {
    await resolveBettingUser(patch.betting, next.betting);
  }
  if (next.collect?.inplay_tick_interval_sec != null) {
    const n = Number(next.collect.inplay_tick_interval_sec);
    if (!ALLOWED_TICK_SEC.includes(n)) {
      const err = new Error(`inplay_tick_interval_sec must be one of ${ALLOWED_TICK_SEC.join(',')}`);
      err.status = 400;
      throw err;
    }
    next.collect.inplay_tick_interval_sec = n;
  }
  const client = await redis.getClient();
  if (!client) {
    const err = new Error('Redis unavailable; engine config not persisted');
    err.status = 503;
    throw err;
  }
  await client.set(CONFIG_KEY, JSON.stringify(next));
  return next;
}

async function writeConfig(cfg) {
  const next = normalizeConfig(cfg);
  if (next.collect?.inplay_tick_interval_sec != null) {
    const n = Number(next.collect.inplay_tick_interval_sec);
    if (!ALLOWED_TICK_SEC.includes(n)) {
      const err = new Error(`inplay_tick_interval_sec must be one of ${ALLOWED_TICK_SEC.join(',')}`);
      err.status = 400;
      throw err;
    }
    next.collect.inplay_tick_interval_sec = n;
  }
  const client = await redis.getClient();
  if (!client) {
    const err = new Error('Redis unavailable; engine config not persisted');
    err.status = 503;
    throw err;
  }
  await client.set(CONFIG_KEY, JSON.stringify(next));
  return next;
}

function assertConditionBucket(bucket) {
  if (!BUCKET_KEYS.includes(bucket)) {
    const err = new Error(`bucket must be one of ${BUCKET_KEYS.join(',')}`);
    err.status = 400;
    throw err;
  }
}

async function getCondition() {
  const cfg = await getConfig();
  return {
    open: !!cfg.condition?.enabled,
    buckets: cfg.condition?.buckets || {},
  };
}

/**
 * 设置默认投注金额（USD）
 * @param {number|string} amountUsd
 */
async function setBettingAmountUsd(amountUsd) {
  const n = Number(amountUsd);
  if (!Number.isFinite(n) || n <= 0) {
    const err = new Error('amountUsd must be a positive number');
    err.status = 400;
    throw err;
  }
  // 保留两位小数，避免浮点脏值
  const rounded = Math.round(n * 100) / 100;
  return setConfig({ betting: { amountUsd: rounded } });
}

async function getBetting() {
  const cfg = await getConfig();
  return {
    open: !!cfg.betting?.enabled,
    amountUsd: cfg.betting?.amountUsd != null ? Number(cfg.betting.amountUsd) : 1,
    userAccount: cfg.betting?.userAccount || null,
    userId: cfg.betting?.userId || null,
    buckets: cfg.betting?.buckets || {},
    rules: cfg.betting?.rules || {},
  };
}

async function setConditionOpen(open) {
  const cur = await getConfig();
  cur.condition = cur.condition || {};
  cur.condition.enabled = !!open;
  return writeConfig(cur);
}

/** 整表替换条件配置：{ open?, buckets? } */
async function putConditionRules({ open, buckets } = {}) {
  const cur = await getConfig();
  cur.condition = cur.condition || { enabled: false, buckets: {} };
  if (open != null) cur.condition.enabled = !!open;
  if (buckets && typeof buckets === 'object') {
    cur.condition.buckets = cur.condition.buckets || {};
    for (const key of BUCKET_KEYS) {
      if (!buckets[key]) continue;
      const b = buckets[key];
      cur.condition.buckets[key] = {
        enabled: !!b.enabled,
        groups: Array.isArray(b.groups) ? b.groups.map(normalizeGroup) : [emptyGroup()],
      };
    }
  }
  return writeConfig(cur);
}

async function putConditionBucket(bucket, { enabled, groups } = {}) {
  assertConditionBucket(bucket);
  const cur = await getConfig();
  cur.condition = cur.condition || { enabled: false, buckets: {} };
  cur.condition.buckets = cur.condition.buckets || {};
  const prev = cur.condition.buckets[bucket] || defaultBucket(null, false);
  let nextGroups;
  if (Array.isArray(groups)) {
    nextGroups = groups.map(normalizeGroup);
  } else if (Array.isArray(prev.groups)) {
    nextGroups = prev.groups.map(normalizeGroup);
  } else {
    nextGroups = [emptyGroup()];
  }
  cur.condition.buckets[bucket] = {
    enabled: enabled != null ? !!enabled : !!prev.enabled,
    groups: nextGroups,
  };
  return writeConfig(cur);
}

async function addConditionGroup(bucket, group) {
  assertConditionBucket(bucket);
  const cur = await getConfig();
  cur.condition = cur.condition || { enabled: false, buckets: {} };
  cur.condition.buckets = cur.condition.buckets || {};
  const prev = cur.condition.buckets[bucket] || defaultBucket(null, false);
  const groups = [...(prev.groups || []).map(normalizeGroup)];
  groups.push(normalizeGroup(group || emptyGroup()));
  cur.condition.buckets[bucket] = { enabled: !!prev.enabled, groups };
  return writeConfig(cur);
}

async function updateConditionGroup(bucket, index, patchGroup) {
  assertConditionBucket(bucket);
  const cur = await getConfig();
  const prev = cur.condition?.buckets?.[bucket] || defaultBucket(null, false);
  const groups = [...(prev.groups || []).map(normalizeGroup)];
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= groups.length) {
    const err = new Error(`group index out of range: ${index}`);
    err.status = 404;
    throw err;
  }
  groups[i] = normalizeGroup({ ...groups[i], ...(patchGroup || {}) });
  cur.condition.buckets[bucket] = { enabled: !!prev.enabled, groups };
  return writeConfig(cur);
}

async function replaceConditionGroup(bucket, index, group) {
  assertConditionBucket(bucket);
  const cur = await getConfig();
  const prev = cur.condition?.buckets?.[bucket] || defaultBucket(null, false);
  const groups = [...(prev.groups || []).map(normalizeGroup)];
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= groups.length) {
    const err = new Error(`group index out of range: ${index}`);
    err.status = 404;
    throw err;
  }
  groups[i] = normalizeGroup(group || emptyGroup());
  cur.condition.buckets[bucket] = { enabled: !!prev.enabled, groups };
  return writeConfig(cur);
}

async function deleteConditionGroup(bucket, index) {
  assertConditionBucket(bucket);
  const cur = await getConfig();
  const prev = cur.condition?.buckets?.[bucket] || defaultBucket(null, false);
  const groups = [...(prev.groups || []).map(normalizeGroup)];
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= groups.length) {
    const err = new Error(`group index out of range: ${index}`);
    err.status = 404;
    throw err;
  }
  groups.splice(i, 1);
  cur.condition.buckets[bucket] = { enabled: !!prev.enabled, groups };
  return writeConfig(cur);
}

module.exports = {
  getConfig,
  setConfig,
  writeConfig,
  DEFAULT_CONFIG,
  ALLOWED_TICK_SEC,
  CONFIG_KEY,
  BUCKET_KEYS,
  BETTING_BUCKET_KEYS,
  emptyGroup,
  emptyBettingGroup,
  emptyStopRule,
  normalizeGroup,
  normalizeBettingGroup,
  normalizeStopRule,
  normalizeCondition,
  normalizeBetting,
  newGroupId,
  emptyGroup,
  emptyBettingGroup,
  getCondition,
  getBetting,
  setBettingAmountUsd,
  setConditionOpen,
  putConditionRules,
  putConditionBucket,
  addConditionGroup,
  updateConditionGroup,
  replaceConditionGroup,
  deleteConditionGroup,
};
