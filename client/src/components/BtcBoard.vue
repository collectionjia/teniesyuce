<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import * as api from '../api'
import { fmtBtcRoundRangeEt, getRoundEndSec } from '../btcRoundFormat'
import {
  SIM_INITIAL,
  SIM_DEFAULT_LIVE_AMOUNT,
  TREND_MARKETS,
  simByMarket,
  simSettings,
  loadSimState,
  saveSimSettings,
  syncSimBets,
  getStake,
  getLiveAmount,
  conditionLabel,
  marketLabelShort,
  getBetStartSec,
  getBetLastSec,
  getMaxEntryPrice,
  isEntryPriceAllowed,
  betSignalForMarket,
  secondsUntilBetWindow,
  clearSimHistory,
  clearAllSimHistory,
  resetSimBalance,
} from '../btcVirtualBet'
import {
  liveOrders,
  loadLiveTradeState,
  recordLiveOrder,
  clearLiveOrders,
  markLivePlaced,
  resolveBuyFillPrice,
  resolveSellFillPrice,
  resolveBuyFillShares,
  recordLiveEntry,
  getLiveEntry,
  clearLiveEntry,
  pruneLivePlaced,
} from '../btcLiveTrade'

const props = defineProps({
  isMember: { type: Boolean, default: false },
  admin: { type: Boolean, default: false },
  showSimBetting: { type: Boolean, default: false },
})

const emit = defineEmits(['wallet-refresh'])

const simBettingActive = computed(() => props.showSimBetting || props.admin)
/** 有效订阅或管理预览：可见信号 / 人数 / 热度 */
const memberView = computed(() => props.isMember || props.admin)

const loading = ref(true)
const error = ref('')
const data = ref(null)
const lastUpdated = ref(0)
const market = ref('5m') // 5m | 15m | 1h
const tick = ref(Date.now())
let pollTimer = null
let tickTimer = null

const walletStatus = reactive({
  configured: false,
  proxyAddress: '',
})
const tradeAmount = ref(1)
const tradeBusy = ref(false)
const tradeMsg = ref('')
const tradeMsgType = ref('success')
const livePositions = reactive({
  market: '',
  roundTs: 0,
  up: 0,
  down: 0,
  loading: false,
})
let positionsTimer = null

const upEntryPrice = computed(() => {
  const e = getLiveEntry(market.value, livePositions.roundTs || Number(currentRound.value?.round_ts || 0), 'up')
  return Number(e?.price || 0)
})
const downEntryPrice = computed(() => {
  const e = getLiveEntry(market.value, livePositions.roundTs || Number(currentRound.value?.round_ts || 0), 'down')
  return Number(e?.price || 0)
})

function fmtEntryPrice(p) {
  const n = Number(p)
  if (!(n > 0)) return ''
  return `@${n.toFixed(2)}`
}

const MARKET_DURATIONS = { '5m': 300, '15m': 900, '1h': 3600 }

const lbKey = computed(() => ({
  '5m': 'leaderboard',
  '15m': 'leaderboard_15m',
  '1h': 'leaderboard_1h',
}[market.value]))

const currentLb = computed(() => {
  const raw = data.value?.[lbKey.value] || data.value?.leaderboard || null
  if (!raw) return null
  const roundTs = Number(currentRound.value?.round_ts || 0)
  const lbRound = Number(raw.round_ts || 0)
  if (market.value === '5m' && roundTs > 0 && lbRound > 0 && lbRound !== roundTs) {
    return {
      ...raw,
      up: [],
      down: [],
      up_count: 0,
      dn_count: 0,
      up_total: 0,
      dn_total: 0,
      _stale: true,
    }
  }
  return raw
})
const currentPrices = computed(() => data.value?.board_prices?.[market.value] || {})

const serverOffsetSec = computed(() => {
  const st = Number(data.value?.server_time || 0)
  if (!st) return 0
  return st - tick.value / 1000
})

function roundInfoForTf(tf) {
  const dur = MARKET_DURATIONS[tf] || 300
  const now = tick.value / 1000 + serverOffsetSec.value
  const ts = Math.floor(now / dur) * dur
  return { round_ts: ts, round_end: ts + dur, strike: 0 }
}

const currentRound = computed(() => {
  const fromApi = data.value?.board_rounds?.[market.value]
  if (fromApi?.round_end) return fromApi
  const info = roundInfoForTf(market.value)
  if (market.value === '5m') {
    return {
      round_ts: Number(data.value?.round_ts || info.round_ts),
      round_end: Number(data.value?.round_end || info.round_end),
      strike: Number(data.value?.strike || 0),
      current: Number(data.value?.crypto_current || 0),
    }
  }
  return info
})

const currentStrike = computed(() => {
  const s = Number(currentRound.value?.strike || 0)
  if (s > 0) return s
  if (market.value === '5m') return Number(data.value?.strike || 0)
  return 0
})

const cryptoCurrent = computed(() => {
  const fromRound = Number(currentRound.value?.current || 0)
  if (Number.isFinite(fromRound) && fromRound > 0) return fromRound
  const n = Number(data.value?.crypto_current || 0)
  return Number.isFinite(n) && n > 0 ? n : 0
})

const countdownSec = computed(() => {
  const end = Number(currentRound.value?.round_end || 0)
  const nowSec = tick.value / 1000 + serverOffsetSec.value
  if (!end) return 0
  return Math.max(0, Math.floor(end - nowSec))
})

const countdownText = computed(() => {
  const s = countdownSec.value
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
  }
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
})

const currentRoundRangeText = computed(() => {
  const ts = Number(currentRound.value?.round_ts || 0)
  const end = getRoundEndSec(ts, currentRound.value?.round_end, market.value, MARKET_DURATIONS)
  return fmtBtcRoundRangeEt(ts, end)
})

const currentOpenBetRoundText = computed(() => {
  const bet = currentSim.value.openBet
  if (!bet) return ''
  const tf = bet.market || market.value
  const end = getRoundEndSec(bet.roundTs, bet.roundEnd, tf, MARKET_DURATIONS)
  return fmtBtcRoundRangeEt(bet.roundTs, end)
})

const strikeDiff = computed(() => {
  const strike = currentStrike.value
  const cur = cryptoCurrent.value
  if (!strike || !cur) return null
  return cur - strike
})

const strikeDiffClass = computed(() => {
  const d = strikeDiff.value
  if (d == null || Math.abs(d) < 0.0000001) return 'flat'
  return d > 0 ? 'pos' : 'neg'
})

const strikeDiffText = computed(() => {
  const d = strikeDiff.value
  if (d == null) return '—'
  // 与官网一致：价差显示为整数美元
  const abs = Math.round(Math.abs(d)).toLocaleString('en-US')
  if (d > 0) return `+$${abs}`
  if (d < 0) return `-$${abs}`
  return `$0`
})

const marketLabel = computed(() => ({
  '5m': '5 分钟',
  '15m': '15 分钟',
  '1h': '1 小时',
}[market.value] || market.value))

const roundStats = computed(() => currentLb.value?.round_stats || {})
const upPct = computed(() => Number(roundStats.value.up_pct || 0))
const dnPct = computed(() => Number(roundStats.value.dn_pct || 0))

const hotStreakStats = computed(() => currentLb.value?.hot_streak_stats || null)
const hotUpCount = computed(() => Number(hotStreakStats.value?.up_n ?? 0))
const hotDnCount = computed(() => Number(hotStreakStats.value?.dn_n ?? 0))

const upPriceNum = computed(() => {
  const p = currentPrices.value.up ?? (market.value === '5m' ? data.value?.up_price : null)
  const n = Number(p)
  return Number.isFinite(n) ? n : 0
})
const downPriceNum = computed(() => {
  const p = currentPrices.value.down ?? (market.value === '5m' ? data.value?.down_price : null)
  const n = Number(p)
  return Number.isFinite(n) ? n : 0
})
const upPrice = computed(() => fmtPrice(upPriceNum.value || null))
const downPrice = computed(() => fmtPrice(downPriceNum.value || null))
const upBuyerCount = computed(() => Number(currentLb.value?.up_count ?? 0))
const downBuyerCount = computed(() => Number(currentLb.value?.dn_count ?? 0))

const lastUpdatedText = computed(() => {
  if (!lastUpdated.value) return '同步中…'
  const d = new Date(lastUpdated.value)
  return `更新 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
})

/** 一侧三项（价格/人数/冒火）均高于对方 → 建议投注；否则不建议 */
const betSignal = computed(() => {
  const upWins =
    upPriceNum.value > downPriceNum.value &&
    upBuyerCount.value > downBuyerCount.value &&
    hotUpCount.value > hotDnCount.value
  const downWins =
    downPriceNum.value > upPriceNum.value &&
    downBuyerCount.value > upBuyerCount.value &&
    hotDnCount.value > hotUpCount.value
  if (upWins) return 'up'
  if (downWins) return 'down'
  return 'none'
})

const betBgClass = computed(() => {
  if (!memberView.value) return ''
  return betSignal.value === 'none' ? 'bg-avoid' : 'bg-suggest'
})

const betHintText = computed(() => {
  if (betSignal.value === 'up') return '信号偏 UP'
  if (betSignal.value === 'down') return '信号偏 DOWN'
  return '信号不足'
})

/** 各周期回合内每 30s 采样 UP/DOWN 股数占比 */
const TREND_INTERVAL_MS = 30000

const showSimHistory = ref(false)
const showSimSettings = ref(false)
const simPanelOpen = ref(false)
const simSettingsDraft = reactive({
  enabled: true,
  stake: 5,
  markets: ['5m', '15m', '1h'],
  condition: 'strict',
  betStartSec: 0,
  betLastSec: 60,
  maxEntryPrice: 1,
  liveAuto: false,
  liveAmount: SIM_DEFAULT_LIVE_AMOUNT,
})

const currentSim = computed(() => simByMarket[market.value])
const currentSimPnl = computed(() => currentSim.value.balance - SIM_INITIAL)
const simHistoryCount = computed(() => currentSim.value.history.length)
const simHistoryTotal = computed(() => (
  TREND_MARKETS.reduce((sum, tf) => sum + (simByMarket[tf].history?.length || 0), 0)
))
const simStake = computed(() => getStake())
const simRunning = computed(() => simSettings.enabled || simSettings.liveAuto)
const simBetWaitSec = computed(() => {
  if (!simBettingActive.value || !data.value || currentSim.value.openBet) return 0
  return secondsUntilBetWindow(data.value, tick.value, market.value)
})
const simEntryPrice = computed(() => {
  if (!data.value) return 0
  const sig = betSignalForMarket(data.value, market.value)
  if (sig === 'up') return upPriceNum.value
  if (sig === 'down') return downPriceNum.value
  return 0
})
const simPriceSkipped = computed(() => {
  if (!simBettingActive.value || !data.value || currentSim.value.openBet || simBetWaitSec.value > 0) return false
  const sig = betSignalForMarket(data.value, market.value)
  if (sig !== 'up' && sig !== 'down') return false
  return !isEntryPriceAllowed(simEntryPrice.value)
})
const simConditionOptions = [
  { value: 'strict', label: '三项占优（价格+人数+热度）' },
  { value: 'price_count', label: '价格+人数占优' },
  { value: 'price', label: '仅价格占优' },
]

function openSimSettings() {
  Object.assign(simSettingsDraft, {
    enabled: simSettings.enabled,
    stake: getStake(),
    markets: [...simSettings.markets],
    condition: simSettings.condition,
    betStartSec: getBetStartSec(),
    betLastSec: getBetLastSec(),
    maxEntryPrice: getMaxEntryPrice(),
    liveAuto: !!simSettings.liveAuto,
    liveAmount: getLiveAmount(),
  })
  showSimSettings.value = true
}

function draftToggleMarket(tf) {
  const set = new Set(simSettingsDraft.markets)
  if (set.has(tf)) {
    if (set.size <= 1) return
    set.delete(tf)
  } else {
    set.add(tf)
  }
  simSettingsDraft.markets = TREND_MARKETS.filter((k) => set.has(k))
}

function applySimSettings() {
  const nextLiveAuto = !!simSettingsDraft.liveAuto
  if (nextLiveAuto && !simSettings.liveAuto) {
    if (!walletStatus.configured) {
      tradeMsg.value = '开启自动投注前请先在右上角配置账户'
      tradeMsgType.value = 'error'
      return
    }
    const amt = Math.max(1, Number(simSettingsDraft.liveAmount) || SIM_DEFAULT_LIVE_AMOUNT)
    if (!window.confirm(
      `确认开启自动投注？\n仅在回合最后 N 秒、信号满足且价≤入场上价时自动确认；持仓现价超过入场上价将自动卖出。\n每笔约 $${amt}。请确认账户余额充足，风险自负。`
    )) {
      return
    }
  }
  Object.assign(simSettings, {
    enabled: !!simSettingsDraft.enabled,
    stake: Math.max(1, Number(simSettingsDraft.stake) || 5),
    markets: simSettingsDraft.markets.length ? [...simSettingsDraft.markets] : ['5m'],
    condition: simSettingsDraft.condition,
    betStartSec: Math.min(3600, Math.max(0, Math.floor(Number(simSettingsDraft.betStartSec) || 0))),
    betLastSec: Math.min(3600, Math.max(5, Math.floor(Number(simSettingsDraft.betLastSec) || 60))),
    maxEntryPrice: Math.min(1, Math.max(0.01, Math.round((Number(simSettingsDraft.maxEntryPrice) || 1) * 100) / 100)),
    liveAuto: nextLiveAuto,
    liveAmount: Math.min(5000, Math.max(1, Math.round((Number(simSettingsDraft.liveAmount) || SIM_DEFAULT_LIVE_AMOUNT) * 100) / 100)),
  })
  tradeAmount.value = simSettings.liveAmount
  saveSimSettings()
  showSimSettings.value = false
}

function toggleLiveAutoFromUi(ev) {
  const want = !!ev?.target?.checked
  if (want === !!simSettings.liveAuto) return
  if (want) {
    if (!walletStatus.configured) {
      tradeMsg.value = '开启自动投注前请先在右上角配置账户'
      tradeMsgType.value = 'error'
      ev.target.checked = false
      return
    }
    const amt = Math.max(1, Number(tradeAmount.value) || getLiveAmount())
    if (!window.confirm(
      `确认开启自动投注？\n仅在回合最后 N 秒、信号满足且价≤入场上价时自动确认；持仓现价超过入场上价将自动卖出。\n每笔约 $${amt}。风险自负。`
    )) {
      ev.target.checked = false
      return
    }
    simSettings.liveAmount = amt
    tradeAmount.value = amt
  }
  simSettings.liveAuto = want
  saveSimSettings()
  tradeMsg.value = want ? '已开启自动投注' : '已关闭自动投注'
  tradeMsgType.value = 'success'
}

function onLiveAmountChange() {
  const amt = Math.min(5000, Math.max(1, Math.round((Number(tradeAmount.value) || SIM_DEFAULT_LIVE_AMOUNT) * 100) / 100))
  tradeAmount.value = amt
  simSettings.liveAmount = amt
  saveSimSettings()
}

function clearSimHistoryRecords() {
  if (!simHistoryCount.value) return
  if (!window.confirm(`确定清空${marketLabelShort(market.value)}的模拟记录？当前余额与进行中的记录将保留。`)) return
  clearSimHistory(market.value)
}

function clearAllSimHistoryRecords() {
  if (!simHistoryTotal.value) return
  if (!window.confirm('确定清空全部周期的模拟记录？当前余额与进行中的记录将保留。')) return
  clearAllSimHistory()
}

function resetSimBalanceRecord() {
  if (!window.confirm(`确定将${marketLabelShort(market.value)}模拟余额重置为 ¥${SIM_INITIAL}？进行中的记录将取消。`)) return
  resetSimBalance(market.value)
}

function simHistoryRoundRange(h) {
  const tf = h.market || market.value
  const end = getRoundEndSec(h.roundTs, h.roundEnd, tf, MARKET_DURATIONS)
  return fmtBtcRoundRangeEt(h.roundTs, end)
}

function fmtSimTime(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function simResultText(h) {
  if (h.push) return '平局'
  if (h.won) return '盈利'
  return '亏损'
}

function runSimSync() {
  if (!simBettingActive.value || !data.value) return
  syncSimBets(data.value, tick.value)
}

function fmtSimMoney(v, { signed = false } = {}) {
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  const sign = signed && n > 0 ? '+' : ''
  return `${sign}¥${n.toFixed(2)}`
}

function fmtSimSide(side) {
  return side === 'up' ? 'UP' : 'DOWN'
}

/** 各周期回合内每 30s 采样 UP/DOWN 股数占比 */
const trendByMarket = ref(Object.fromEntries(TREND_MARKETS.map((k) => [k, []])))
const trendMeta = ref(Object.fromEntries(TREND_MARKETS.map((k) => [k, { lastAt: 0, roundTs: 0 }])))

const trendSamples = computed(() => trendByMarket.value[market.value] || [])
const maxTrendSamples = computed(() => {
  const dur = MARKET_DURATIONS[market.value] || 300
  return Math.ceil(dur / 30) + 1
})

function resetTrendIfNewRound(tf, roundTs) {
  if (!roundTs) return
  const meta = trendMeta.value[tf]
  if (!meta || meta.roundTs === roundTs) return
  meta.roundTs = roundTs
  meta.lastAt = 0
  trendByMarket.value[tf] = []
}

function sampleTrendForMarket(tf, force = false) {
  if (!TREND_MARKETS.includes(tf)) return

  const lbKeyMap = { '5m': 'leaderboard', '15m': 'leaderboard_15m', '1h': 'leaderboard_1h' }
  const lb = data.value?.[lbKeyMap[tf]] || null
  const round = data.value?.board_rounds?.[tf]
    || (tf === '5m' && data.value?.round_end
      ? {
          round_ts: data.value.round_ts,
          round_end: data.value.round_end,
        }
      : roundInfoForTf(tf))

  const roundTs = Number(round?.round_ts || 0)
  if (!roundTs) return
  resetTrendIfNewRound(tf, roundTs)

  const samples = trendByMarket.value[tf]
  const meta = trendMeta.value[tf]
  const rs = lb?.round_stats || {}
  const up = Number(rs.up_share_pct ?? rs.up_pct ?? 0)
  const dn = Number(rs.dn_share_pct ?? rs.dn_pct ?? 0)
  const now = Date.now()
  const elapsed = Math.max(0, Math.floor(tick.value / 1000 + serverOffsetSec.value - roundTs))

  if (!force && samples.length && now - meta.lastAt < TREND_INTERVAL_MS) return

  const last = samples[samples.length - 1]
  if (last && last.elapsed === elapsed && last.up === up && last.dn === dn && !force) return

  samples.push({ roundTs, elapsed, up, dn })
  const cap = Math.ceil((MARKET_DURATIONS[tf] || 300) / 30) + 1
  if (samples.length > cap) {
    trendByMarket.value[tf] = samples.slice(-cap)
  }
  meta.lastAt = now
}

function sampleTrend(force = false) {
  sampleTrendForMarket(market.value, force)
  if (force) {
    for (const tf of TREND_MARKETS) {
      if (tf !== market.value) sampleTrendForMarket(tf, false)
    }
  }
}

const trendChart = computed(() => {
  const samples = trendSamples.value
  const roundDur = MARKET_DURATIONS[market.value] || 300
  const w = 320
  const h = 110
  const pad = { t: 10, r: 8, b: 22, l: 32 }
  const iw = w - pad.l - pad.r
  const ih = h - pad.t - pad.b
  if (!samples.length) {
    return { w, h, pad, upPath: '', dnPath: '', upArea: '', dnArea: '', ticks: [], gridY: [25, 50, 75] }
  }
  const maxElapsed = Math.max(roundDur, samples[samples.length - 1].elapsed || 0)
  const px = (elapsed) => pad.l + (elapsed / maxElapsed) * iw
  const py = (pct) => pad.t + ih - (Math.min(100, Math.max(0, pct)) / 100) * ih

  const upPoints = samples.map((s) => `${px(s.elapsed).toFixed(1)},${py(s.up).toFixed(1)}`)
  const dnPoints = samples.map((s) => `${px(s.elapsed).toFixed(1)},${py(s.dn).toFixed(1)}`)
  const baseY = pad.t + ih
  const upPath = upPoints.length ? `M ${upPoints.join(' L ')}` : ''
  const dnPath = dnPoints.length ? `M ${dnPoints.join(' L ')}` : ''
  const upArea = upPoints.length
    ? `${upPath} L ${px(samples[samples.length - 1].elapsed).toFixed(1)},${baseY} L ${px(samples[0].elapsed).toFixed(1)},${baseY} Z`
    : ''
  const dnArea = dnPoints.length
    ? `${dnPath} L ${px(samples[samples.length - 1].elapsed).toFixed(1)},${baseY} L ${px(samples[0].elapsed).toFixed(1)},${baseY} Z`
    : ''

  const ticks = samples.length <= 4
    ? samples.map((s) => ({ x: px(s.elapsed), label: fmtTrendTick(s.elapsed) }))
    : [samples[0], samples[Math.floor(samples.length / 2)], samples[samples.length - 1]]
      .map((s) => ({ x: px(s.elapsed), label: fmtTrendTick(s.elapsed) }))

  return { w, h, pad, upPath, dnPath, upArea, dnArea, ticks, gridY: [25, 50, 75], maxElapsed }
})

function fmtTrendTick(sec) {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
  return `${m}:${String(s).padStart(2, '0')}`
}

function fmtTrendPct(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  return `${n.toFixed(1)}%`
}

function fmtUsd(v, digits = 2) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return '—'
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}

function fmtPrice(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return '—'
  return n.toFixed(2)
}

function fmtNum(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  return Math.round(n).toLocaleString('en-US')
}

async function load() {
  error.value = ''
  try {
    const payload = props.admin
      ? await api.fetchAdminBtcState()
      : await api.fetchBtcState()
    if (!props.admin && !props.isMember && payload) {
      data.value = {
        ...payload,
        member: false,
        leaderboard: payload.leaderboard,
        leaderboard_15m: payload.leaderboard_15m,
        leaderboard_1h: payload.leaderboard_1h,
      }
    } else {
      data.value = payload
    }
    lastUpdated.value = Date.now()
    sampleTrend(true)
    if (simBettingActive.value) runSimSync()
  } catch (e) {
    error.value = e?.response?.data?.error || e?.message || '加载失败'
  } finally {
    loading.value = false
  }
}

async function loadWalletStatus() {
  if (!simBettingActive.value) return
  try {
    const s = await api.fetchBtcWallet()
    Object.assign(walletStatus, {
      configured: !!s.configured,
      proxyAddress: s.proxyAddress || '',
    })
    if (walletStatus.configured) loadLivePositions()
  } catch { /* ignore */ }
}

async function loadLivePositions() {
  if (!simBettingActive.value || !walletStatus.configured) {
    livePositions.up = 0
    livePositions.down = 0
    livePositions.roundTs = 0
    return
  }
  livePositions.loading = true
  try {
    const p = await api.fetchBtcPositions(market.value)
    livePositions.market = p.market || market.value
    livePositions.roundTs = Number(p.roundTs || 0)
    livePositions.up = Number(p.up || 0)
    livePositions.down = Number(p.down || 0)
    const rts = livePositions.roundTs
    if (rts) {
      if (livePositions.up < 0.01) clearLiveEntry(market.value, rts, 'up')
      if (livePositions.down < 0.01) clearLiveEntry(market.value, rts, 'down')
    }
    pruneLivePlaced()
  } catch {
    /* ignore */
  } finally {
    livePositions.loading = false
  }
}

async function placeLiveTrade(side) {
  if (!walletStatus.configured) {
    tradeMsg.value = '请先在右上角配置账户'
    tradeMsgType.value = 'error'
    return
  }
  const amount = Number(tradeAmount.value)
  if (!(amount >= 1)) {
    tradeMsg.value = '金额至少 $1'
    tradeMsgType.value = 'error'
    return
  }
  tradeBusy.value = true
  tradeMsg.value = ''
  try {
    const resp = await api.placeBtcTrade({
      market: market.value,
      side,
      amountUsd: amount,
    })
    const roundTs = Number(currentRound.value?.round_ts || 0)
    if (roundTs) markLivePlaced(market.value, roundTs)
    const boardPrice = side === 'up' ? upPriceNum.value : downPriceNum.value
    const fillPrice = resolveBuyFillPrice(resp, boardPrice)
    const fillShares = resolveBuyFillShares(resp, amount, fillPrice || boardPrice)
    if (roundTs && fillPrice > 0) {
      recordLiveEntry(market.value, roundTs, side, fillShares || amount / fillPrice, fillPrice)
    }
    tradeMsg.value = resp.message || '已确认'
    tradeMsgType.value = 'success'
    recordLiveOrder({
      side,
      amount,
      market: market.value,
      orderId: resp.orderId || '',
      at: Date.now(),
      ok: true,
      auto: false,
      roundTs,
      action: 'buy',
      shares: fillShares,
      entryPrice: fillPrice,
    })
    await loadLivePositions()
    emit('wallet-refresh')
    setTimeout(() => emit('wallet-refresh'), 1500)
  } catch (e) {
    tradeMsg.value = e.response?.data?.error || e.message || '确认失败'
    tradeMsgType.value = 'error'
    recordLiveOrder({
      side,
      amount,
      market: market.value,
      orderId: '',
      at: Date.now(),
      ok: false,
      auto: false,
      roundTs: Number(currentRound.value?.round_ts || 0),
      error: tradeMsg.value,
      action: 'buy',
    })
  } finally {
    tradeBusy.value = false
  }
}

async function closeLivePosition(side) {
  if (!walletStatus.configured) {
    tradeMsg.value = '请先在右上角配置账户'
    tradeMsgType.value = 'error'
    return
  }
  const shares = side === 'up' ? livePositions.up : livePositions.down
  if (!(shares >= 0.01)) {
    tradeMsg.value = `${String(side).toUpperCase()} 无份额`
    tradeMsgType.value = 'error'
    return
  }
  tradeBusy.value = true
  tradeMsg.value = ''
  try {
    const resp = await api.placeBtcSell({
      market: market.value,
      side,
      shares: 'all',
    })
    const sold = Number(resp.soldShares || shares)
    const roundTs = Number(currentRound.value?.round_ts || 0)
    const boardPrice = side === 'up' ? upPriceNum.value : downPriceNum.value
    const entryPx = Number(getLiveEntry(market.value, roundTs || livePositions.roundTs, side)?.price || 0)
    const fillPrice = resolveSellFillPrice(resp, boardPrice || entryPx)
    if (roundTs) clearLiveEntry(market.value, roundTs, side)
    tradeMsg.value = fillPrice > 0
      ? `${resp.message || '已卖出'} · 卖出@${fillPrice.toFixed(2)}`
      : (resp.message || '已卖出')
    tradeMsgType.value = 'success'
    recordLiveOrder({
      side,
      amount: sold,
      shares: sold,
      market: market.value,
      orderId: resp.orderId || '',
      at: Date.now(),
      ok: true,
      auto: false,
      roundTs,
      action: 'sell',
      entryPrice: fillPrice || undefined,
    })
    await loadLivePositions()
    emit('wallet-refresh')
    setTimeout(() => emit('wallet-refresh'), 1500)
  } catch (e) {
    tradeMsg.value = e.response?.data?.error || e.message || '卖出失败'
    tradeMsgType.value = 'error'
    recordLiveOrder({
      side,
      amount: shares,
      shares,
      market: market.value,
      orderId: '',
      at: Date.now(),
      ok: false,
      auto: false,
      roundTs: Number(currentRound.value?.round_ts || 0),
      error: tradeMsg.value,
      action: 'sell',
    })
  } finally {
    tradeBusy.value = false
  }
}

function clearLiveOrderRecords() {
  if (!liveOrders.value.length) return
  if (!window.confirm('确定清空操作记录？')) return
  clearLiveOrders()
}

watch(
  () => [props.isMember, props.admin, simBettingActive.value],
  ([, , active]) => {
    if (active) {
      loadSimState()
      loadLiveTradeState()
      tradeAmount.value = getLiveAmount()
      loadWalletStatus()
    }
    load()
  },
)

watch(market, () => {
  sampleTrend(true)
  showSimHistory.value = false
  if (simBettingActive.value && walletStatus.configured) loadLivePositions()
})

watch(
  () => Number(currentRound.value?.round_ts || 0),
  (ts, prev) => {
    if (ts && ts !== prev && simBettingActive.value && walletStatus.configured) {
      loadLivePositions()
    }
  },
)

watch(
  () => [
    market.value,
    currentLb.value?.round_stats?.up_share_pct,
    currentLb.value?.round_stats?.dn_share_pct,
    currentRound.value?.round_ts,
  ],
  () => sampleTrend(),
)

watch(
  () => [
    simBettingActive.value,
    market.value,
    betSignal.value,
    currentRound.value?.round_ts,
    data.value?.crypto_current,
    upPriceNum.value,
    downPriceNum.value,
    currentLb.value?.up_count,
    currentLb.value?.dn_count,
    hotUpCount.value,
    hotDnCount.value,
  ],
  () => runSimSync(),
)

onMounted(() => {
  if (simBettingActive.value) {
    loadSimState()
    loadLiveTradeState()
    tradeAmount.value = getLiveAmount()
    loadWalletStatus()
  }
  load()
  pollTimer = setInterval(load, 2000)
  tickTimer = setInterval(() => {
    tick.value = Date.now()
    for (const tf of TREND_MARKETS) sampleTrendForMarket(tf, false)
  }, 1000)
  positionsTimer = setInterval(() => {
    if (simBettingActive.value && walletStatus.configured) loadLivePositions()
  }, 12000)
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
  if (tickTimer) clearInterval(tickTimer)
  if (positionsTimer) clearInterval(positionsTimer)
})
</script>

<template>
  <div class="wrap" :class="betBgClass">
    <div class="topbar">
      <div class="topbar-main">
        <span class="brand-title">BTC</span>
        <div class="filter-inline">
          <button type="button" class="chip-btn" :class="{ active: market === '5m' }" @click="market = '5m'">5m</button>
          <button type="button" class="chip-btn" :class="{ active: market === '15m' }" @click="market = '15m'">15m</button>
          <button type="button" class="chip-btn" :class="{ active: market === '1h' }" @click="market = '1h'">1h</button>
        </div>
        <button type="button" class="btn ghost" :disabled="loading" @click="load">刷</button>
      </div>
    </div>

    <div v-if="error && !data" class="empty err">{{ error }}</div>
    <div v-else-if="loading && !data" class="empty">加载中…</div>

    <template v-else>
      <div v-if="!data?.crawl_enabled && !(currentLb?.up_count || currentLb?.dn_count)" class="empty hint">
        数据同步未开启，暂无看板数据。请联系管理员在管理中心打开。
      </div>

      <div class="round-bar">
        <div class="round-bar-top">
          <span class="round-label">{{ marketLabel }} 回合</span>
          <span class="round-countdown" :class="{ urgent: countdownSec <= 90 }">剩余 {{ countdownText }}</span>
          <span
            v-if="memberView"
            class="bet-hint-inline"
            :class="betSignal === 'none' ? 'avoid' : 'suggest'"
          >{{ betHintText }}</span>
        </div>
        <div v-if="currentRoundRangeText !== '—'" class="round-range">{{ currentRoundRangeText }}</div>
        <div v-if="market === '5m'" class="price-strip">
          <div class="price-cell">
            <span class="price-k">目标</span>
            <span class="price-v">{{ fmtUsd(currentStrike) }}</span>
          </div>
          <div class="price-cell">
            <span class="price-k">当前</span>
            <span class="price-v" :class="strikeDiffClass">{{ fmtUsd(cryptoCurrent) }}</span>
          </div>
          <div class="price-cell">
            <span class="price-k">价差</span>
            <span class="price-v" :class="strikeDiffClass">{{ strikeDiffText }}</span>
          </div>
        </div>
      </div>

      <div class="duel-grid">
        <section class="side-panel up" :class="{ winner: memberView && betSignal === 'up' }">
          <div class="side-head">UP</div>
          <div class="side-price">{{ upPrice }}</div>
          <div v-if="memberView" class="side-meta">
            <div class="meta-row">
              <span class="meta-label">参与人数</span>
              <span class="meta-value">{{ upBuyerCount }} 人</span>
            </div>
            <div class="meta-row hot">
              <span class="meta-label">连续热度</span>
              <span class="meta-value">🔥 {{ hotUpCount }} 人</span>
            </div>
          </div>
          <button
            v-if="simBettingActive"
            type="button"
            class="live-bet-btn up"
            :disabled="tradeBusy"
            @click="placeLiveTrade('up')"
          >确认 UP</button>
        </section>

        <section class="side-panel down" :class="{ winner: memberView && betSignal === 'down' }">
          <div class="side-head">DOWN</div>
          <div class="side-price">{{ downPrice }}</div>
          <div v-if="memberView" class="side-meta">
            <div class="meta-row">
              <span class="meta-label">参与人数</span>
              <span class="meta-value">{{ downBuyerCount }} 人</span>
            </div>
            <div class="meta-row hot">
              <span class="meta-label">连续热度</span>
              <span class="meta-value">🔥 {{ hotDnCount }} 人</span>
            </div>
          </div>
          <button
            v-if="simBettingActive"
            type="button"
            class="live-bet-btn down"
            :disabled="tradeBusy"
            @click="placeLiveTrade('down')"
          >确认 DOWN</button>
        </section>
      </div>

      <div v-if="simBettingActive" class="live-trade-panel">
        <div class="live-trade-row">
          <label class="auto-bet-toggle" :class="{ on: simSettings.liveAuto }">
            <input type="checkbox" :checked="!!simSettings.liveAuto" @change="toggleLiveAutoFromUi" />
            <span>自动投注</span>
          </label>
          <span class="live-trade-label">$</span>
          <input v-model.number="tradeAmount" type="number" min="1" max="5000" step="1" class="live-trade-input" @change="onLiveAmountChange" />
          <span class="live-trade-wallet" :class="{ ok: walletStatus.configured }">
            {{ walletStatus.configured ? `${walletStatus.proxyAddress.slice(0, 6)}…${walletStatus.proxyAddress.slice(-4)}` : '未配账户' }}
          </span>
          <button type="button" class="sim-clear-btn" @click="openSimSettings">设置</button>
        </div>
        <div v-if="walletStatus.configured" class="live-pos-row">
          <span class="live-trade-label">份额</span>
          <div class="live-pos-item up">
            <span>UP {{ livePositions.up.toFixed(1) }}<em v-if="upEntryPrice">{{ fmtEntryPrice(upEntryPrice) }}</em></span>
            <button
              type="button"
              class="live-close-btn up"
              :disabled="tradeBusy || livePositions.up < 0.01"
              @click="closeLivePosition('up')"
            >卖</button>
          </div>
          <div class="live-pos-item down">
            <span>DN {{ livePositions.down.toFixed(1) }}<em v-if="downEntryPrice">{{ fmtEntryPrice(downEntryPrice) }}</em></span>
            <button
              type="button"
              class="live-close-btn down"
              :disabled="tradeBusy || livePositions.down < 0.01"
              @click="closeLivePosition('down')"
            >卖</button>
          </div>
          <button
            type="button"
            class="sim-clear-btn"
            :disabled="livePositions.loading || tradeBusy"
            @click="loadLivePositions"
          >刷</button>
        </div>
        <div v-if="tradeMsg" class="live-trade-msg" :class="tradeMsgType">{{ tradeMsg }}</div>
        <div v-if="liveOrders.length" class="live-trade-orders">
          <div class="live-trade-orders-head">
            <span>操作记录</span>
            <button type="button" class="sim-clear-btn" @click="clearLiveOrderRecords">清空</button>
          </div>
          <div v-for="(o, i) in liveOrders.slice(0, 3)" :key="`${o.at}-${i}`" class="live-trade-order" :class="{ ok: o.ok, bad: !o.ok }">
            {{ o.ok ? '成功' : '失败' }}
            · {{ o.action === 'sell' ? '卖出' : '确认' }}
            <template v-if="o.auto"> · 自动</template>
            · {{ marketLabelShort(o.market || market) }} · {{ String(o.side).toUpperCase() }}
            · {{ o.action === 'sell' ? `${Number(o.shares || o.amount || 0).toFixed(2)}份` : `$${o.amount}` }}
            <template v-if="o.entryPrice">
              · {{ o.action === 'sell' ? '卖出' : '买入' }}{{ fmtEntryPrice(o.entryPrice) }}
            </template>
            <span v-if="o.orderId"> · {{ o.orderId.slice(0, 10) }}…</span>
            <span v-else-if="o.error"> · {{ o.error }}</span>
          </div>
        </div>
      </div>

    </template>

    <div v-if="showSimSettings" class="sim-modal-mask" @click.self="showSimSettings = false">
      <div class="sim-modal">
        <div class="sim-modal-head">
          <strong>自动投注设置</strong>
          <button type="button" class="sim-clear-btn" @click="showSimSettings = false">关闭</button>
        </div>
        <label class="sim-modal-row">
          <input type="checkbox" v-model="simSettingsDraft.liveAuto" />
          <span>开启自动投注（信号满足时自动确认）</span>
        </label>
        <label class="sim-modal-row">
          <span>每笔金额 $</span>
          <input v-model.number="simSettingsDraft.liveAmount" type="number" min="1" max="5000" step="1" />
        </label>
        <label class="sim-modal-row">
          <span>入场上价 / 止损价</span>
          <input v-model.number="simSettingsDraft.maxEntryPrice" type="number" min="0.01" max="1" step="0.01" />
        </label>
        <p class="sim-modal-hint">买入价须 ≤ 此价；持仓现价超过此价自动卖出（填 1 表示不启用止损）</p>
        <label class="sim-modal-row">
          <span>最后 N 秒可投</span>
          <input v-model.number="simSettingsDraft.betLastSec" type="number" min="5" max="3600" step="1" />
        </label>
        <div class="sim-modal-row wrap markets-check">
          <span>周期</span>
          <label v-for="tf in TREND_MARKETS" :key="tf" class="market-check">
            <input
              type="checkbox"
              :checked="simSettingsDraft.markets.includes(tf)"
              @change="draftToggleMarket(tf)"
            />
            <span>{{ marketLabelShort(tf) }}</span>
          </label>
        </div>
        <label class="sim-modal-row">
          <span>条件</span>
          <select v-model="simSettingsDraft.condition">
            <option v-for="o in simConditionOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </label>
        <button type="button" class="sim-modal-save" @click="applySimSettings">保存</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wrap {
  --bg: #f8fafc;
  --card: #ffffff;
  --line: #e2e8f0;
  --text: #1e293b;
  --muted: #94a3b8;
  --primary: #4f46e5;
  --primary-soft: #eef2ff;
  --up: #16a34a;
  --down: #dc2626;
  color: var(--text);
  background: var(--bg);
  padding: 6px;
  border-radius: 10px;
  transition: background 0.35s ease;
}
.wrap.bg-suggest {
  background: linear-gradient(180deg, #ecfdf5 0%, #bbf7d0 55%, #dcfce7 100%);
}
.wrap.bg-avoid {
  background: linear-gradient(180deg, #fef2f2 0%, #fecaca 55%, #fee2e2 100%);
}
.bet-hint-inline {
  font-size: 0.76rem; font-weight: 800;
  padding: 3px 10px; border-radius: 999px; letter-spacing: 0.01em;
}
.bet-hint-inline.suggest { color: #14532d; background: rgba(255, 255, 255, 0.75); border: 1px solid #86efac; }
.bet-hint-inline.avoid { color: #991b1b; background: rgba(255, 255, 255, 0.75); border: 1px solid #fca5a5; }

.pos { color: var(--up); }
.neg { color: var(--down); }
.flat { color: #64748b; }
.sim-clear-btn {
  border: 1px solid #fecaca; background: #fff; color: #dc2626;
  border-radius: 999px; padding: 5px 12px; font-size: 0.78rem; font-weight: 700;
}
.sim-clear-btn:disabled { opacity: 0.45; cursor: not-allowed; }

.topbar {
  display: flex; flex-direction: column; gap: 4px; margin-bottom: 6px;
}
.topbar-main {
  display: flex; flex-wrap: nowrap; align-items: center; gap: 6px;
  overflow-x: auto;
}
.brand-title {
  font-size: 0.88rem; font-weight: 800; color: #0f172a; flex-shrink: 0;
}
.filter-inline { display: inline-flex; gap: 4px; flex-shrink: 0; }
.meta-chip, .btn, .chip-btn {
  border: 1px solid var(--line); background: var(--card); color: #64748b;
  border-radius: 999px; padding: 5px 11px; font-size: 0.78rem; font-weight: 600;
  flex-shrink: 0; line-height: 1.3;
}
.meta-chip.live { color: var(--up); border-color: #bbf7d0; background: #f0fdf4; }
.meta-chip.muted { color: #64748b; border-color: #e2e8f0; background: #f8fafc; font-size: 0.72rem; }
.btn.ghost {
  cursor: pointer; color: var(--primary); border-color: #c7d2fe; background: var(--primary-soft);
  padding: 6px 12px; font-size: 0.82rem;
}
.btn:disabled { opacity: 0.5; cursor: wait; }
.chip-btn { cursor: pointer; padding: 6px 12px; font-size: 0.82rem; }
.chip-btn.active {
  background: var(--primary-soft); border-color: #c7d2fe; color: var(--primary);
}

.round-bar {
  display: flex; flex-direction: column; gap: 2px;
  margin-bottom: 6px; padding: 6px 10px;
  background: var(--card); border: 1px solid var(--line); border-radius: 8px;
}
.round-bar-top { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.round-label { font-size: 0.76rem; font-weight: 700; color: #334155; }
.round-range {
  font-size: 0.7rem; font-weight: 600; color: #475569; line-height: 1.3;
}
.price-strip {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 4px;
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px dashed var(--line);
}
.price-cell {
  display: flex; flex-direction: column; align-items: center; gap: 1px;
  min-width: 0;
}
.price-k {
  font-size: 0.62rem; color: var(--muted); font-weight: 600; letter-spacing: 0.02em;
}
.price-v {
  font-size: 0.78rem; font-weight: 800; color: #0f172a;
  font-variant-numeric: tabular-nums; line-height: 1.15;
  white-space: nowrap;
}
.price-v.pos { color: var(--up); }
.price-v.neg { color: var(--down); }
.price-v.flat { color: #64748b; }
.round-countdown {
  font-size: 1.15rem; font-weight: 800; color: var(--primary);
  font-variant-numeric: tabular-nums; line-height: 1.15;
  letter-spacing: 0.02em;
}
.round-countdown.urgent {
  color: var(--down, #dc2626);
  animation: countdown-urgent-pulse 1s ease-in-out infinite;
}
@keyframes countdown-urgent-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}

.duel-grid {
  display: grid; grid-template-columns: 1fr 1fr; gap: 8px;
}
.side-panel {
  background: var(--card); border: 1px solid var(--line);
  border-radius: 12px; padding: 10px 12px; text-align: center;
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.06);
  min-height: 0; display: flex; flex-direction: column;
}
.side-panel.up { border-color: #86efac; background: rgba(255, 255, 255, 0.82); }
.side-panel.down { border-color: #fca5a5; background: rgba(255, 255, 255, 0.82); }
.side-panel.winner {
  box-shadow: 0 0 0 2px #16a34a, 0 4px 14px rgba(22, 163, 74, 0.25);
}
.side-panel.down.winner {
  box-shadow: 0 0 0 2px #16a34a, 0 4px 14px rgba(22, 163, 74, 0.25);
}
.side-head {
  font-size: 0.86rem; font-weight: 800; letter-spacing: 0.06em;
}
.side-panel.up .side-head { color: var(--up); }
.side-panel.down .side-head { color: var(--down); }
.side-price {
  font-size: 1.7rem; font-weight: 800; line-height: 1.05;
  margin: 6px 0 8px; font-variant-numeric: tabular-nums;
}
.side-panel.up .side-price { color: var(--up); }
.side-panel.down .side-price { color: var(--down); }
.side-meta { margin-top: auto; display: grid; gap: 4px; text-align: left; }
.meta-row {
  display: flex; justify-content: space-between; align-items: center; gap: 8px;
  padding: 5px 9px; border-radius: 8px; background: rgba(255, 255, 255, 0.75);
  border: 1px solid rgba(226, 232, 240, 0.9);
}
.meta-row.hot { background: #fffbeb; border-color: #fde68a; }
.meta-label { font-size: 0.72rem; color: #64748b; font-weight: 600; }
.meta-value { font-size: 0.84rem; font-weight: 800; color: #0f172a; font-variant-numeric: tabular-nums; }
.meta-row.hot .meta-value { color: #b45309; }

.empty { text-align: center; color: var(--muted); font-size: 0.86rem; padding: 12px 8px; }
.empty.hint { color: #4338ca; background: #eef2ff; border-radius: 10px; margin-bottom: 6px; padding: 8px; }
.empty.err { color: var(--down); }

.live-bet-btn {
  margin-top: 8px; width: 100%; border: none; border-radius: 10px;
  padding: 10px 12px; font-size: 0.9rem; font-weight: 800; color: #fff;
}
.live-bet-btn:disabled { opacity: 0.55; }
.live-bet-btn.up { background: var(--up); }
.live-bet-btn.down { background: var(--down); }
.live-trade-panel {
  margin-top: 8px; padding: 10px 12px; border-radius: 10px;
  background: rgba(255,255,255,0.88); border: 1px solid var(--line);
}
.live-trade-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.auto-bet-toggle {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 0.72rem; font-weight: 700; color: #64748b;
  border: 1px solid var(--line); background: #fff;
  border-radius: 999px; padding: 4px 8px; cursor: pointer;
}
.auto-bet-toggle.on {
  color: #14532d; border-color: #86efac; background: #f0fdf4;
}
.auto-bet-toggle input { accent-color: #16a34a; }
.live-trade-label { font-size: 0.74rem; color: #64748b; font-weight: 600; }
.live-trade-input {
  width: 80px; border: 1px solid #e2e8f0; border-radius: 8px;
  padding: 6px 8px; font-size: 0.84rem;
}
.live-trade-wallet { font-size: 0.72rem; color: #94a3b8; }
.live-trade-wallet.ok { color: #059669; font-weight: 700; }
.live-pos-row {
  margin-top: 6px; display: flex; align-items: center; gap: 6px;
  flex-wrap: nowrap; overflow-x: auto;
}
.live-pos-item {
  display: inline-flex; align-items: center; gap: 5px; flex-shrink: 0;
  font-size: 0.74rem; font-weight: 700;
  padding: 4px 8px; border-radius: 8px; background: #f8fafc; border: 1px solid #e2e8f0;
}
.live-pos-item em {
  font-style: normal; font-weight: 800; opacity: 0.85; margin-left: 2px;
}
.live-pos-item.up { color: var(--up); }
.live-pos-item.down { color: var(--down); }
.live-close-btn {
  border: none; border-radius: 8px; padding: 5px 11px;
  font-size: 0.8rem; font-weight: 800; color: #fff; cursor: pointer;
}
.live-close-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.live-close-btn.up { background: #15803d; }
.live-close-btn.down { background: #b91c1c; }
.live-trade-msg { margin-top: 6px; font-size: 0.76rem; font-weight: 700; }
.live-trade-msg.success { color: #059669; }
.live-trade-msg.error { color: #dc2626; }
.live-trade-orders { margin-top: 6px; display: grid; gap: 2px; }
.live-trade-orders-head {
  display: flex; align-items: center; justify-content: space-between;
  font-size: 0.72rem; color: #64748b; font-weight: 700;
}
.live-trade-order { font-size: 0.7rem; color: #64748b; }
.live-trade-order.ok { color: #059669; }
.live-trade-order.bad { color: #dc2626; }

.sim-modal-mask {
  position: fixed; inset: 0; z-index: 80;
  background: rgba(15, 23, 42, 0.45);
  display: flex; align-items: flex-start; justify-content: center;
  padding: 12px; padding-top: 48px;
}
.sim-modal {
  width: min(420px, 100%); background: #fff; border-radius: 14px;
  padding: 14px; box-shadow: 0 12px 40px rgba(15, 23, 42, 0.2);
  display: grid; gap: 10px;
}
.sim-modal-head {
  display: flex; align-items: center; justify-content: space-between;
}
.sim-modal-row {
  display: flex; align-items: center; gap: 8px;
  font-size: 0.82rem; color: #334155;
}
.sim-modal-row.wrap { flex-wrap: wrap; }
.markets-check { align-items: flex-start; }
.market-check {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 0.82rem; color: #334155; cursor: pointer;
  border: 1px solid #e2e8f0; border-radius: 8px; padding: 5px 8px;
  background: #f8fafc;
}
.market-check input { accent-color: #4f46e5; }
.sim-modal-row input[type='number'],
.sim-modal-row select {
  flex: 1; min-width: 0; border: 1px solid #e2e8f0; border-radius: 8px;
  padding: 6px 8px;
}
.sim-modal-hint {
  margin: -4px 0 0;
  font-size: 0.7rem;
  line-height: 1.4;
  color: #94a3b8;
}
.sim-modal-save {
  border: none; border-radius: 10px; padding: 10px;
  background: #4f46e5; color: #fff; font-weight: 700;
}

@media (max-width: 520px) {
  .duel-grid { grid-template-columns: 1fr 1fr; gap: 6px; }
  .side-price { font-size: 1.5rem; }
  .side-panel { padding: 8px 10px; }
}
</style>
