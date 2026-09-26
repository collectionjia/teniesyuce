/**
 * 网球三引擎配置（管理员）：采集 / 条件 / 投注
 * 主存 MySQL `tennis_engines_config`；保存时镜像 Redis：
 *   - `tennis:engines:config` 全量
 *   - `tennis:engines:config:condition` 条件块
 * 列表过滤：getConfigPreferRedis 先读 Redis 条件，再对 Redis 赛程包内存筛选。
 *
 * 条件引擎 buckets：
 *   prematch|inplay|settled: { enabled, groups[] }
 *   groups = 条件组库（组间 AND/OR）；组内字段 AND
 *   组字段：id / name / linkPrematch / tour / pm / gapMin / rankDiffMin / rankDiffMax / strongRankGt / strongRankLt / wonSetIndex / setGapMin
 *
 * 投注引擎 buckets：
 *   prematch|inplay: { enabled, groups[] }（买入 + 盘中止损规则）
 *
 * 调度引擎任务与「条件」参数（bucket/groupIndex）见 scheduler_jobs.params_json（已 MySQL）。
 */
const crypto = require('crypto');
const redis = require('./redis');
const pool = require('../db');

const CONFIG_KEY = 'tennis:engines:config';
const MYSQL_CONFIG_ID = 'default';
const BUCKET_KEYS = ['prematch', 'inplay', 'settled'];
const BETTING_BUCKET_KEYS = ['prematch', 'inplay'];

let tableReady = false;

function newGroupId() {
  return crypto.randomBytes(8).toString('hex');
}

function emptyGroup() {
  return {
    id: newGroupId(),
    name: '',
    /** 与上一组连接：or | and（首组忽略，已废弃；组间独立） */
    joinPrev: 'or',
    /** 盘前桶：允许未开赛产品挂载本组做列表筛选 */
    linkPrematch: false,
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
    /** 盘中：启用第几盘盘差（强−弱 > setGapMin） */
    requireWonFirstSet: false,
    wonSetIndex: 1,
    setGapMin: 'all',
    /** 勾选后排除该盘局分为 firstSetExcludeScore（默认 7:5）的场次 */
    firstSetExcludeEnabled: false,
    firstSetExcludeScore: '7:5',
  };
}

function emptyStopRule() {
  return {
    name: '',
    joinPrev: 'or',
    stopFormat: 'any',
    stopSetIndex: 'all',
    stopStrongSets: 'all',
    stopWeakSets: 'all',
    stopGameLead: 'all',
    stopWeakGamesMin: 'all',
    stopPmCentsMax: 'all',
  };
}

/** 盘中列表/自动投注买入条件（原写死规则，现可在投注引擎配置） */
function defaultInplayBettingEntry() {
  return {
    requireWonFirstSet: false,
    /** 看第几盘的局分（1–5） */
    wonSetIndex: 1,
    /** 盘差：强方局分 − 弱方局分 > setGapMin；'all' 不启用 */
    setGapMin: 0,
    firstSetExcludeEnabled: false,
    firstSetExcludeScore: '7:5',
    pmCentsMax: 91,
    rankGapRules: [],
  };
}

function normalizeInplayBettingEntry(raw) {
  const d = defaultInplayBettingEntry();
  if (!raw || typeof raw !== 'object') {
    return { ...d, rankGapRules: [] };
  }
  let pmCentsMax = d.pmCentsMax;
  if (raw.pmCentsMax === '' || raw.pmCentsMax === 'all' || raw.pmCentsMax == null) {
    pmCentsMax = 'all';
  } else if (Number.isFinite(Number(raw.pmCentsMax))) {
    pmCentsMax = Number(raw.pmCentsMax);
  }
  const excludeScore = raw.firstSetExcludeScore != null && String(raw.firstSetExcludeScore).trim()
    ? String(raw.firstSetExcludeScore).trim().slice(0, 12)
    : d.firstSetExcludeScore;
  const setIdx = Number(raw.wonSetIndex);

  let setGapMin = d.setGapMin;
  if (raw.setGapMin === '' || raw.setGapMin === 'all') {
    setGapMin = 'all';
  } else if (raw.setGapMin != null && Number.isFinite(Number(raw.setGapMin))) {
    setGapMin = Number(raw.setGapMin);
  } else if (raw.setGapMin == null) {
    // 旧配置无盘差字段：曾开「须赢盘」→ 按盘差>0；显式关掉须赢 → 不启用
    setGapMin = raw.requireWonFirstSet === false ? 'all' : 0;
  }

  const hasGap = setGapMin !== 'all' && Number.isFinite(Number(setGapMin));
  return {
    requireWonFirstSet: hasGap || raw.requireWonFirstSet === true,
    wonSetIndex: Number.isFinite(setIdx) ? Math.max(1, Math.min(5, Math.round(setIdx))) : 1,
    setGapMin: hasGap ? Number(setGapMin) : 'all',
    firstSetExcludeEnabled: raw.firstSetExcludeEnabled === true,
    firstSetExcludeScore: excludeScore || '7:5',
    pmCentsMax,
    rankGapRules: [],
  };
}

function emptyBettingGroup(kind = 'inplay') {
  const isInplay = kind === 'inplay';
  return {
    id: newGroupId(),
    name: '',
    joinPrev: 'or',
    amountUsd: 1,
    stopEnabled: isInplay,
    stopRules: isInplay ? [emptyStopRule()] : [],
  };
}

function clampPollSec(raw, fallback = 60) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(600, Math.max(10, Math.round(n)));
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
    strategyKey: (() => {
      const sk = g.strategyKey != null ? String(g.strategyKey).trim().slice(0, 48) : '';
      return sk || id;
    })(),
    name: g.name != null ? String(g.name).slice(0, 40) : '',
    joinPrev: String(g.joinPrev || 'or').toLowerCase() === 'and' ? 'and' : 'or',
    linkPrematch: g.linkPrematch === true,
    tour: g.tour != null ? g.tour : base.tour,
    pm: g.pm != null ? g.pm : base.pm,
    gapMin: g.gapMin != null ? g.gapMin : base.gapMin,
    rankDiffMin: g.rankDiffMin != null ? g.rankDiffMin : base.rankDiffMin,
    rankDiffMax: g.rankDiffMax != null ? g.rankDiffMax : base.rankDiffMax,
    strongRankMax: g.strongRankMax != null ? g.strongRankMax : base.strongRankMax,
    strongRankGt: g.strongRankGt != null ? g.strongRankGt : base.strongRankGt,
    strongRankLt: g.strongRankLt != null ? g.strongRankLt : base.strongRankLt,
    requireWonFirstSet: g.requireWonFirstSet === true
      || (g.setGapMin != null && g.setGapMin !== '' && g.setGapMin !== 'all' && Number.isFinite(Number(g.setGapMin))),
    wonSetIndex: (() => {
      const n = Number(g.wonSetIndex);
      return Number.isFinite(n) ? Math.max(1, Math.min(5, Math.round(n))) : 1;
    })(),
    setGapMin: (() => {
      if (g.setGapMin === '' || g.setGapMin === 'all' || g.setGapMin == null) {
        return g.requireWonFirstSet === true ? 0 : 'all';
      }
      const n = Number(g.setGapMin);
      return Number.isFinite(n) ? n : 'all';
    })(),
    firstSetExcludeEnabled: g.firstSetExcludeEnabled === true,
    firstSetExcludeScore: excludeScore || '7:5',
    /** 条件检查调度间隔（秒）：时间到了检查，满足则买入 */
    checkIntervalSec: clampPollSec(g.checkIntervalSec, 60),
  };
}

function normalizeStopRule(r) {
  const base = emptyStopRule();
  if (!r || typeof r !== 'object') return base;
  const join = String(r.joinPrev || 'or').toLowerCase();
  let fmt = String(r.stopFormat || base.stopFormat).toLowerCase();
  const setRaw = r.stopSetIndex;
  let stopSetIndex = 'all';
  if (setRaw != null && setRaw !== '' && setRaw !== 'all') {
    const setIndex = Number(setRaw);
    if (Number.isFinite(setIndex) && setIndex > 0) stopSetIndex = Math.max(1, Math.min(5, setIndex));
  }
  const leadRaw = r.stopGameLead;
  let stopGameLead = 'all';
  if (leadRaw != null && leadRaw !== '' && leadRaw !== 'all') {
    const lead = Number(leadRaw);
    if (Number.isFinite(lead)) stopGameLead = lead;
  }
  // 旧默认占位 BO3+第3盘+局差2 → 视为未限制
  if (fmt === 'bo3' && stopSetIndex === 3 && stopGameLead === 2) {
    fmt = 'any';
    stopSetIndex = 'all';
    stopGameLead = 'all';
  }
  const pmRaw = r.stopPmCentsMax;
  let stopPmCentsMax = base.stopPmCentsMax;
  if (pmRaw != null && pmRaw !== '' && pmRaw !== 'all') {
    const pm = Number(pmRaw);
    stopPmCentsMax = Number.isFinite(pm) && pm > 0 ? pm : 'all';
  } else if (pmRaw === '' || pmRaw === 'all') {
    stopPmCentsMax = 'all';
  }
  return {
    name: r.name != null ? String(r.name).slice(0, 40) : '',
    joinPrev: join === 'and' ? 'and' : 'or',
    stopFormat: ['bo3', 'bo5', 'any'].includes(fmt) ? fmt : 'any',
    stopSetIndex,
    stopStrongSets: r.stopStrongSets != null ? r.stopStrongSets : base.stopStrongSets,
    stopWeakSets: r.stopWeakSets != null ? r.stopWeakSets : base.stopWeakSets,
    stopGameLead,
    stopWeakGamesMin: r.stopWeakGamesMin != null ? r.stopWeakGamesMin : base.stopWeakGamesMin,
    stopPmCentsMax,
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
  const amountRaw = Number(g.amountUsd);
  const amountUsd = Number.isFinite(amountRaw) && amountRaw >= 1
    ? Math.round(amountRaw * 100) / 100
    : base.amountUsd;
  return {
    id,
    strategyKey: (() => {
      const sk = g.strategyKey != null ? String(g.strategyKey).trim().slice(0, 48) : '';
      return sk || id;
    })(),
    name: g.name != null ? String(g.name).slice(0, 40) : '',
    joinPrev: join === 'and' ? 'and' : 'or',
    amountUsd,
    stopEnabled: g.stopEnabled != null ? !!g.stopEnabled : base.stopEnabled,
    stopRules: resolveStopRules(g, kind),
    /** 止损检查调度间隔（秒）：时间到了检查，满足则卖出 */
    stopIntervalSec: clampPollSec(g.stopIntervalSec, 60),
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
    inplay_tick_fields: {
      score: false,
      odds: false,
    },
    /** 后台比分/赔率刷新（管理员页配置，优先于 SOFA_SCORE_LOOP_MS / POLY_ODDS_LOOP_MS） */
    background: {
      score_enabled: true,
      score_interval_sec: 30,
      odds_enabled: true,
      odds_interval_sec: 1,
    },
  },
  condition: {
    enabled: false,
    buckets: {
      prematch: defaultBucket(
        { tour: 'all', pm: 'all', gapMin: 50, rankDiffMax: 0, strongRankMax: 20 },
        false,
      ),
      inplay: defaultBucket(
        { tour: 'all', pm: 'all', strongRankMax: 100 },
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
    /** market=市价 FOK；limit=限价 GTC（填份额+买/卖目标价） */
    orderType: 'market',
    /** 限价买入份额 */
    shares: null,
    /** 买入目标价（0.01–0.99）；兼容旧字段 limitPrice */
    limitBuyPrice: null,
    limitPrice: null,
    /** 卖出/止损目标价（0.01–0.99） */
    limitSellPrice: null,
    /** 列表页「自动投注」刷新间隔（秒） */
    listAutoBetIntervalSec: 60,
    /** 列表页止损检查间隔（秒） */
    listStopLossIntervalSec: 60,
    /** 列表页整页数据刷新间隔（秒）；0=关闭 */
    listPageRefreshIntervalSec: 0,
    buckets: {
      prematch: {
        enabled: false,
        simulate: false,
        orderType: 'market',
        amountUsd: 1,
        shares: null,
        limitBuyPrice: null,
        limitPrice: null,
        limitSellPrice: null,
        groups: defaultPrematchBettingGroups(),
      },
      inplay: {
        enabled: false,
        simulate: false,
        orderType: 'market',
        amountUsd: 1,
        shares: null,
        limitBuyPrice: null,
        limitPrice: null,
        limitSellPrice: null,
        groups: defaultInplayBettingGroups(),
        entry: defaultInplayBettingEntry(),
      },
    },
    rules: {
      note: '未开赛/比赛中分桶；市价用金额、限价用买入数量+目标价；比赛中买入条件见 inplay.entry；止损见各组 stopRules',
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

function clampListPollSec(raw, fallback = 60) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(10, Math.min(600, Math.round(n)));
}

/** 页面刷新：0=关闭，其余 10–600 秒 */
function clampPageRefreshSec(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(10, Math.min(600, Math.round(n)));
}

function clampProbPrice(raw) {
  const n = Number(raw);
  if (!(n >= 0.01 && n <= 0.99)) return null;
  return Math.round(n * 100) / 100;
}

function normalizeBucketOrder(raw = {}, fallback = {}) {
  const srcType = raw.orderType != null && raw.orderType !== '' ? raw.orderType : fallback.orderType;
  const orderType = String(srcType || 'market').toLowerCase() === 'limit' ? 'limit' : 'market';
  const buyRaw = raw.limitBuyPrice != null && raw.limitBuyPrice !== ''
    ? raw.limitBuyPrice
    : (raw.limitPrice != null && raw.limitPrice !== ''
      ? raw.limitPrice
      : (fallback.limitBuyPrice ?? fallback.limitPrice));
  const buyP = clampProbPrice(buyRaw);
  const sellRaw = raw.limitSellPrice != null && raw.limitSellPrice !== ''
    ? raw.limitSellPrice
    : fallback.limitSellPrice;
  const sellP = clampProbPrice(sellRaw);
  const shRaw = raw.shares != null && raw.shares !== '' ? raw.shares : fallback.shares;
  const sh = Math.floor(Number(shRaw) * 100) / 100;
  const amtRaw = raw.amountUsd != null && raw.amountUsd !== '' ? raw.amountUsd : fallback.amountUsd;
  const amt = Number(amtRaw);
  return {
    orderType,
    amountUsd: Number.isFinite(amt) && amt > 0 ? Math.round(amt * 100) / 100 : 1,
    limitBuyPrice: buyP,
    limitPrice: buyP,
    limitSellPrice: sellP,
    shares: Number.isFinite(sh) && sh > 0 ? sh : null,
  };
}

function normalizeBetting(betting) {
  const b = betting && typeof betting === 'object' ? { ...betting } : {};
  const legacyPm = Number(b.rules?.pmMaxCents);
  const src = b.buckets && typeof b.buckets === 'object' ? b.buckets : null;
  // 先规范化全局（旧配置兼容，作各桶缺省回退）
  b.orderType = String(b.orderType || 'market').toLowerCase() === 'limit' ? 'limit' : 'market';
  const buyP = clampProbPrice(b.limitBuyPrice != null && b.limitBuyPrice !== '' ? b.limitBuyPrice : b.limitPrice);
  b.limitBuyPrice = buyP;
  b.limitPrice = buyP;
  b.limitSellPrice = clampProbPrice(b.limitSellPrice);
  const shGlobal = Math.floor(Number(b.shares) * 100) / 100;
  b.shares = Number.isFinite(shGlobal) && shGlobal > 0 ? shGlobal : null;
  const globalOrder = {
    orderType: b.orderType,
    amountUsd: b.amountUsd != null ? Number(b.amountUsd) || 1 : 1,
    shares: b.shares,
    limitBuyPrice: b.limitBuyPrice,
    limitPrice: b.limitPrice,
    limitSellPrice: b.limitSellPrice,
  };

  const buckets = {};
  for (const key of BETTING_BUCKET_KEYS) {
    const raw = src?.[key];
    const order = normalizeBucketOrder(raw && typeof raw === 'object' ? raw : {}, globalOrder);
    if (raw && Array.isArray(raw.groups)) {
      buckets[key] = {
        enabled: !!raw.enabled,
        simulate: !!raw.simulate,
        ...order,
        groups: raw.groups.map((g) => normalizeBettingGroup(g, key)),
      };
      if (key === 'inplay') {
        buckets[key].entry = normalizeInplayBettingEntry(raw.entry);
      }
    } else {
      buckets[key] = {
        enabled: false,
        simulate: false,
        ...order,
        groups: key === 'inplay' ? defaultInplayBettingGroups() : defaultPrematchBettingGroups(),
      };
      if (key === 'inplay') {
        buckets[key].entry = normalizeInplayBettingEntry(raw?.entry);
      }
      if (Number.isFinite(legacyPm) && key === 'inplay') {
        buckets[key].groups = buckets[key].groups.map((g) => ({ ...g, pmMaxCents: legacyPm }));
      }
      if (raw?.enabled != null) buckets[key].enabled = !!raw.enabled;
      if (raw?.simulate != null) buckets[key].simulate = !!raw.simulate;
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
  b.listAutoBetIntervalSec = clampListPollSec(b.listAutoBetIntervalSec, 60);
  b.listStopLossIntervalSec = clampListPollSec(b.listStopLossIntervalSec, 60);
  b.listPageRefreshIntervalSec = clampPageRefreshSec(b.listPageRefreshIntervalSec);
  b.rules = {
    note: b.rules?.note || '未开赛/比赛中分桶；各桶独立下单类型；多组 OR；组内买入且止损可配',
  };
  return b;
}

function clampScoreIntervalSec(n, fallback = 30) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(600, Math.max(5, Math.round(v)));
}

function clampOddsIntervalSec(n, fallback = 1) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(60, Math.max(1, Math.round(v)));
}

function normalizeCollectBackground(bg = {}, baseBg = DEFAULT_CONFIG.collect.background) {
  const inBg = bg && typeof bg === 'object' ? bg : {};
  const base = baseBg || DEFAULT_CONFIG.collect.background;
  return {
    score_enabled: inBg.score_enabled != null ? !!inBg.score_enabled : base.score_enabled !== false,
    score_interval_sec: clampScoreIntervalSec(
      inBg.score_interval_sec != null ? inBg.score_interval_sec : base.score_interval_sec,
    ),
    odds_enabled: inBg.odds_enabled != null ? !!inBg.odds_enabled : base.odds_enabled !== false,
    odds_interval_sec: clampOddsIntervalSec(
      inBg.odds_interval_sec != null ? inBg.odds_interval_sec : base.odds_interval_sec,
    ),
  };
}

let collectBackgroundMem = normalizeCollectBackground();

function syncCollectBackgroundMem(collect) {
  collectBackgroundMem = normalizeCollectBackground(collect?.background);
  return collectBackgroundMem;
}

/** 同步读取后台比分/赔率循环配置（由 getConfig/setConfig 刷新） */
function getCollectBackgroundSettings() {
  const envScoreMs = Number(process.env.SOFA_SCORE_LOOP_MS);
  const envOddsMs = Number(process.env.POLY_ODDS_LOOP_MS);
  const envScoreEnabled = String(process.env.SOFA_SCORE_LOOP || '1').trim().toLowerCase();
  const envOddsEnabled = String(process.env.POLY_ODDS_LOOP || '1').trim().toLowerCase();
  const bg = collectBackgroundMem;
  const scoreIntervalMs = Number.isFinite(envScoreMs) && envScoreMs >= 5000
    ? envScoreMs
    : bg.score_interval_sec * 1000;
  const oddsIntervalMs = Number.isFinite(envOddsMs) && envOddsMs >= 200
    ? envOddsMs
    : bg.odds_interval_sec * 1000;
  return {
    score_enabled: !['0', 'false', 'no', 'off'].includes(envScoreEnabled) && bg.score_enabled !== false,
    score_interval_ms: scoreIntervalMs,
    score_interval_sec: bg.score_interval_sec,
    odds_enabled: !['0', 'false', 'no', 'off'].includes(envOddsEnabled) && bg.odds_enabled !== false,
    odds_interval_ms: oddsIntervalMs,
    odds_interval_sec: bg.odds_interval_sec,
  };
}

function applyCollectBackgroundLoops(cfg) {
  syncCollectBackgroundMem(cfg?.collect);
  try {
    require('./sofaScoreBackground').restartScoreLoop?.();
  } catch (e) {
    console.warn('[tennis/engines] restart score loop', e.message);
  }
  try {
    require('./polyOddsBackground').restartOddsLoop?.();
  } catch (e) {
    console.warn('[tennis/engines] restart odds loop', e.message);
  }
}

function normalizeCollect(c = {}) {
  const base = DEFAULT_CONFIG.collect;
  const fields = {
    ...base.inplay_tick_fields,
    ...(c.inplay_tick_fields && typeof c.inplay_tick_fields === 'object' ? c.inplay_tick_fields : {}),
  };
  return {
    enabled: c.enabled !== false,
    inplay_tick_enabled: c.inplay_tick_enabled !== false,
    inplay_tick_fields: {
      score: fields.score === true,
      odds: fields.odds !== false,
    },
    background: normalizeCollectBackground(c.background, base.background),
  };
}

/** API 对外 */
function toPublicConfig(cfg) {
  const next = cfg && typeof cfg === 'object' ? JSON.parse(JSON.stringify(cfg)) : normalizeConfig({});
  if (next?.collect?.proxy) delete next.collect.proxy;
  return next;
}

/**
 * 拼 IPWO HTTP 代理 URL（与 Python tm.clients.proxy.ipwo_proxy_urls 一致）。
 */
function buildIpwoProxyUrl(ipwo = {}) {
  const host = String(ipwo.host || process.env.IPWO_PROXY_HOST || 'us.ipwo.net').trim() || 'us.ipwo.net';
  const port = String(ipwo.port || process.env.IPWO_PROXY_PORT || '7878').trim() || '7878';
  let user = String(ipwo.user || process.env.IPWO_PROXY_USER || process.env.IPWO_USERNAME || '').trim();
  const pass = String(ipwo.pass || process.env.IPWO_PROXY_PASS || process.env.IPWO_PASSWORD || '').trim();
  const zone = String(ipwo.zone || process.env.IPWO_PROXY_ZONE || '').trim();
  if (!user || !pass) return '';
  if (zone && !user.includes('_custom_zone_') && !user.includes('_zone_')) {
    user = `${user}_custom_zone_${zone.toUpperCase()}`;
  }
  const sess = String(ipwo.session || process.env.IPWO_PROXY_SESSION || '').trim();
  if (sess && !user.includes('_sid_')) user = `${user}_sid_${sess}`;
  const sticky = String(ipwo.stickyMin || process.env.IPWO_PROXY_STICKY_MIN || '').trim();
  if (sticky && !user.includes('_time_')) user = `${user}_time_${parseInt(sticky, 10) || sticky}`;
  return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
}

/**
 * Top100：IPWO 或 SOFA_HTTP_PROXY；盘中强制直连。
 * opts: { proxyUrl, ipwo: { host, port, user, pass, zone } }
 */
function buildProxyProcessEnv(cfg, job = 'top100', opts = {}) {
  void cfg;
  const isInplay = String(job).toLowerCase().includes('inplay');
  const ipwo = opts.ipwo && typeof opts.ipwo === 'object' ? opts.ipwo : {};
  const fromIpwo = buildIpwoProxyUrl(ipwo);
  // Top100：有 IPWO 凭证则优先 IPWO（避免残留静态 SOFA_HTTP_PROXY）
  const url = String(fromIpwo || opts.proxyUrl || process.env.SOFA_HTTP_PROXY || process.env.HTTP_PROXY || '').trim();
  const clearProxy = {
    SOFA_HTTP_PROXY: '',
    SOFA_HTTPS_PROXY: '',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    IPWO_PROXY_HOST: '',
    IPWO_PROXY_PORT: '',
    IPWO_PROXY_USER: '',
    IPWO_PROXY_PASS: '',
    IPWO_PROXY_ZONE: '',
    IPWO_PROXY_SESSION: '',
    IPWO_PROXY_STICKY_MIN: '',
  };
  if (isInplay) {
    return {
      COLLECT_PROXY_JOB: 'inplay',
      COLLECT_TOP100_USE_PROXY: '0',
      COLLECT_INPLAY_USE_PROXY: '0',
      ...clearProxy,
    };
  }
  if (url) {
    const out = {
      COLLECT_PROXY_JOB: 'top100',
      COLLECT_TOP100_USE_PROXY: '1',
      COLLECT_INPLAY_USE_PROXY: '0',
      SOFA_HTTP_PROXY: url,
      SOFA_HTTPS_PROXY: url,
      HTTP_PROXY: url,
      HTTPS_PROXY: url,
    };
    // 同步写入 IPWO_*，便于 Python sofa_proxy_map / 日志显示 mode=ipwo
    if (ipwo.host || ipwo.user || process.env.IPWO_PROXY_USER) {
      out.IPWO_PROXY_HOST = String(ipwo.host || process.env.IPWO_PROXY_HOST || 'us.ipwo.net');
      out.IPWO_PROXY_PORT = String(ipwo.port || process.env.IPWO_PROXY_PORT || '7878');
      out.IPWO_PROXY_USER = String(ipwo.user || process.env.IPWO_PROXY_USER || '');
      out.IPWO_PROXY_PASS = String(ipwo.pass || process.env.IPWO_PROXY_PASS || '');
      out.IPWO_PROXY_ZONE = String(ipwo.zone || process.env.IPWO_PROXY_ZONE || '');
    }
    return out;
  }
  return {
    COLLECT_PROXY_JOB: 'top100',
    COLLECT_INPLAY_USE_PROXY: '0',
  };
}

function normalizeConfig(cfg) {
  const next = cfg && typeof cfg === 'object' ? { ...cfg } : JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  next.collect = normalizeCollect(next.collect || {});
  next.condition = normalizeCondition(next.condition || {});
  next.betting = normalizeBetting(next.betting || {});
  return next;
}

async function ensureTable() {
  if (tableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tennis_engines_config (
      id VARCHAR(32) NOT NULL PRIMARY KEY,
      config_json JSON NOT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  tableReady = true;
}

async function readRedisRaw() {
  const client = await redis.getClient();
  if (!client) return null;
  try {
    const raw = await client.get(CONFIG_KEY);
    return raw || null;
  } catch (e) {
    console.warn('[tennis/engines] redis read', e.message);
    return null;
  }
}

async function mirrorRedis(cfg) {
  try {
    const client = await redis.getClient();
    if (!client) return;
    const payload = JSON.stringify(cfg);
    await client
      .multi()
      .set(CONFIG_KEY, payload)
      .set(`${CONFIG_KEY}:condition`, JSON.stringify(cfg.condition || {}))
      .exec();
  } catch (e) {
    console.warn('[tennis/engines] redis mirror', e.message);
  }
}

async function loadConfigFromMysql() {
  await ensureTable();
  const [[row]] = await pool.query(
    'SELECT config_json FROM tennis_engines_config WHERE id=? LIMIT 1',
    [MYSQL_CONFIG_ID]
  );
  if (!row?.config_json) return null;
  try {
    const raw = row.config_json;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    console.error('[tennis/engines] mysql parse', e.message);
    return null;
  }
}

async function saveConfigToMysql(cfg) {
  await ensureTable();
  const json = JSON.stringify(cfg);
  await pool.query(
    `INSERT INTO tennis_engines_config (id, config_json)
     VALUES (?, CAST(? AS JSON))
     ON DUPLICATE KEY UPDATE config_json=VALUES(config_json), updated_at=NOW()`,
    [MYSQL_CONFIG_ID, json]
  );
}

async function getConfig() {
  try {
    let parsed = await loadConfigFromMysql();
    if (!parsed) {
      const redisRaw = await readRedisRaw();
      if (redisRaw) {
        try {
          parsed = JSON.parse(redisRaw);
          const normalized = normalizeConfig(parsed);
          await saveConfigToMysql(normalized);
          console.log('[tennis/engines] migrated config Redis → MySQL');
          parsed = normalized;
        } catch (e) {
          console.warn('[tennis/engines] redis migrate parse', e.message);
          parsed = null;
        }
      }
    }
    const cfg = normalizeConfig(parsed || JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
    await enrichBettingAccount(cfg);
    syncCollectBackgroundMem(cfg.collect);
    return cfg;
  } catch (e) {
    console.error('[tennis/engines] getConfig', e.message);
    const cfg = normalizeConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
    syncCollectBackgroundMem(cfg.collect);
    return cfg;
  }
}

/**
 * 列表过滤专用：优先读 Redis 条件，再筛 Redis 赛程包；空则回退 MySQL 并回写 Redis。
 */
async function getConfigPreferRedis() {
  try {
    const client = await redis.getClient();
    if (client) {
      try {
        let parsed = null;
        const fullRaw = await client.get(CONFIG_KEY);
        if (fullRaw) parsed = JSON.parse(fullRaw);
        const condRaw = await client.get(`${CONFIG_KEY}:condition`);
        if (condRaw) {
          const condition = JSON.parse(condRaw);
          parsed = parsed ? { ...parsed, condition } : { condition };
        }
        if (parsed) {
          const cfg = normalizeConfig(parsed);
          await enrichBettingAccount(cfg);
          return cfg;
        }
      } catch (e) {
        console.warn('[tennis/engines] getConfigPreferRedis redis', e.message);
      }
    }
    const fromMysql = await loadConfigFromMysql();
    if (fromMysql) {
      const cfg = normalizeConfig(fromMysql);
      await mirrorRedis(cfg);
      return cfg;
    }
    return normalizeConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
  } catch (e) {
    console.error('[tennis/engines] getConfigPreferRedis', e.message);
    return getConfig();
  }
}

async function enrichBettingAccount(cfg) {
  try {
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
  let incoming = patch && typeof patch === 'object' ? { ...patch } : {};
  if (incoming.collect && typeof incoming.collect === 'object') {
    const { proxy: _dropProxy, ...restCollect } = incoming.collect;
    void _dropProxy;
    incoming = { ...incoming, collect: restCollect };
  }
  let next = deepMerge(cur, incoming || {});
  if (next?.collect?.proxy) delete next.collect.proxy;
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
      // base 已是 deepMerge 结果，含本桶 orderType/amountUsd/shares/限价等
      const base = next.betting.buckets[key] || {
        enabled: false,
        simulate: false,
        orderType: 'market',
        amountUsd: 1,
        shares: null,
        limitBuyPrice: null,
        limitPrice: null,
        limitSellPrice: null,
        groups: key === 'inplay' ? defaultInplayBettingGroups() : defaultPrematchBettingGroups(),
      };
      next.betting.buckets[key] = {
        ...base,
        enabled: p.enabled != null ? !!p.enabled : !!base.enabled,
        simulate: p.simulate != null ? !!p.simulate : !!base.simulate,
        // groups 以 patch 整数组为准，避免与旧组合并残留
        groups: Array.isArray(p.groups)
          ? p.groups.map((g) => normalizeBettingGroup(g, key))
          : (base.groups || [emptyBettingGroup(key)]),
      };
      if (p.orderType != null && p.orderType !== '') {
        next.betting.buckets[key].orderType = String(p.orderType).toLowerCase() === 'limit' ? 'limit' : 'market';
      }
      if (p.amountUsd != null && p.amountUsd !== '') {
        const amt = Number(p.amountUsd);
        if (Number.isFinite(amt) && amt > 0) {
          next.betting.buckets[key].amountUsd = Math.round(amt * 100) / 100;
        }
      }
      if (Object.prototype.hasOwnProperty.call(p, 'shares')) {
        const sh = Math.floor(Number(p.shares) * 100) / 100;
        next.betting.buckets[key].shares = Number.isFinite(sh) && sh > 0 ? sh : null;
      }
      if (Object.prototype.hasOwnProperty.call(p, 'limitBuyPrice') || Object.prototype.hasOwnProperty.call(p, 'limitPrice')) {
        const buy = clampProbPrice(p.limitBuyPrice != null && p.limitBuyPrice !== '' ? p.limitBuyPrice : p.limitPrice);
        next.betting.buckets[key].limitBuyPrice = buy;
        next.betting.buckets[key].limitPrice = buy;
      }
      if (Object.prototype.hasOwnProperty.call(p, 'limitSellPrice')) {
        next.betting.buckets[key].limitSellPrice = clampProbPrice(p.limitSellPrice);
      }
      if (key === 'inplay') {
        next.betting.buckets[key].entry = normalizeInplayBettingEntry(
          p.entry != null ? p.entry : base.entry,
        );
      }
    }
  }
  next = normalizeConfig(next);
  if (patch?.betting) {
    await resolveBettingUser(patch.betting, next.betting);
  }
  try {
    await saveConfigToMysql(next);
  } catch (e) {
    console.error('[tennis/engines] setConfig mysql', e.message);
    const err = new Error('MySQL unavailable; engine config not persisted');
    err.status = 503;
    throw err;
  }
  await mirrorRedis(next);
  applyCollectBackgroundLoops(next);
  return next;
}

async function writeConfig(cfg) {
  const next = normalizeConfig(cfg);
  try {
    await saveConfigToMysql(next);
  } catch (e) {
    console.error('[tennis/engines] writeConfig mysql', e.message);
    const err = new Error('MySQL unavailable; engine config not persisted');
    err.status = 503;
    throw err;
  }
  await mirrorRedis(next);
  applyCollectBackgroundLoops(next);
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
  const buckets = cfg.condition?.buckets || {};
  const anyOn = ['prematch', 'inplay', 'settled'].some((k) => buckets[k]?.enabled);
  return {
    open: anyOn,
    buckets,
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
  getConfigPreferRedis,
  setConfig,
  writeConfig,
  toPublicConfig,
  buildProxyProcessEnv,
  buildIpwoProxyUrl,
  getCollectBackgroundSettings,
  applyCollectBackgroundLoops,
  DEFAULT_CONFIG,
  CONFIG_KEY,
  BUCKET_KEYS,
  BETTING_BUCKET_KEYS,
  emptyGroup,
  emptyBettingGroup,
  emptyStopRule,
  defaultInplayBettingEntry,
  normalizeInplayBettingEntry,
  normalizeGroup,
  normalizeBettingGroup,
  normalizeStopRule,
  normalizeCondition,
  normalizeBetting,
  newGroupId,
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
