import { reactive, ref } from 'vue'
import {
  loadLiveTradeState,
  markLivePlaced,
  pruneLivePlaced,
  wasLivePlaced,
  getLiveEntry,
} from './btcLiveTrade'

export const SIM_INITIAL = 100
export const SIM_DEFAULT_STAKE = 5
export const SIM_DEFAULT_LIVE_AMOUNT = 1
export const SIM_DEFAULT_MAX_ENTRY_PRICE = 1
/** 仅在回合剩余 ≤ 该秒数时允许（自动）投注，默认最后 1 分钟 */
export const SIM_DEFAULT_BET_LAST_SEC = 60
export const TREND_MARKETS = ['5m', '15m', '1h']
export const MARKET_DURATIONS = { '5m': 300, '15m': 900, '1h': 3600 }

const SIM_STORAGE_KEY = 'yuce.btc.virtualBet.v3'
const SIM_STORAGE_KEY_LEGACY = 'yuce.btc.virtualBet.v2'
const MAX_SIM_HISTORY = 100

export const simSettings = reactive({
  enabled: true,
  stake: SIM_DEFAULT_STAKE,
  markets: ['5m', '15m', '1h'],
  condition: 'strict',
  /** @deprecated 兼容旧本地缓存；实际以 betLastSec 为准 */
  betStartSec: 0,
  /** 仅当回合剩余秒数 ≤ 此值时允许投注（默认 60 = 最后一分钟） */
  betLastSec: SIM_DEFAULT_BET_LAST_SEC,
  maxEntryPrice: SIM_DEFAULT_MAX_ENTRY_PRICE,
  /** 满足条件时同步真实下单（默认关闭） */
  liveAuto: false,
  liveAmount: SIM_DEFAULT_LIVE_AMOUNT,
})

/** @type {null | ((order: { market: string, side: string, amountUsd: number, roundTs: number, entryPrice: number }) => void | Promise<void>)} */
let liveTradeHandler = null
/** @type {null | ((order: { market: string, side: string, roundTs: number, price: number, reason?: string }) => void | Promise<void>)} */
let liveSellHandler = null
const stopSellInFlight = new Set()

export function setLiveTradeHandler(fn) {
  liveTradeHandler = typeof fn === 'function' ? fn : null
}

export function setLiveSellHandler(fn) {
  liveSellHandler = typeof fn === 'function' ? fn : null
}

export function getLiveAmount() {
  const n = Number(simSettings.liveAmount)
  return Number.isFinite(n) && n >= 1 ? Math.min(5000, Math.round(n * 100) / 100) : SIM_DEFAULT_LIVE_AMOUNT
}

export const simByMarket = reactive(Object.fromEntries(TREND_MARKETS.map((k) => [k, {
  openBet: null,
  history: [],
  balance: SIM_INITIAL,
  wins: 0,
  losses: 0,
}])))

export const lastRoundTsByMarket = ref(Object.fromEntries(TREND_MARKETS.map((k) => [k, 0])))

const CONDITION_LABELS = {
  strict: '价格+人数+热度 三项占优',
  price_count: '价格+人数 两项占优',
  price: '仅价格占优',
}

export function conditionLabel(key) {
  return CONDITION_LABELS[key] || CONDITION_LABELS.strict
}

export function marketLabelShort(tf) {
  return ({ '5m': '5 分钟', '15m': '15 分钟', '1h': '1 小时' }[tf] || tf)
}

export function getStake() {
  const n = Number(simSettings.stake)
  return Number.isFinite(n) && n > 0 ? Math.min(1000, Math.round(n * 100) / 100) : SIM_DEFAULT_STAKE
}

export function getBetStartSec() {
  const n = Number(simSettings.betStartSec)
  return Number.isFinite(n) && n >= 0 ? Math.min(3600, Math.floor(n)) : 0
}

export function getBetLastSec() {
  const n = Number(simSettings.betLastSec)
  if (!Number.isFinite(n) || n <= 0) return SIM_DEFAULT_BET_LAST_SEC
  return Math.min(3600, Math.floor(n))
}

export function getMaxEntryPrice() {
  const n = Number(simSettings.maxEntryPrice)
  if (!Number.isFinite(n) || n <= 0 || n > 1) return SIM_DEFAULT_MAX_ENTRY_PRICE
  return Math.round(n * 100) / 100
}

export function isEntryPriceAllowed(entryPrice) {
  const entry = Number(entryPrice)
  if (!entry || entry <= 0) return false
  return entry <= getMaxEntryPrice()
}

/** 入场上价同时为止损价：持仓现价严格高于上价时触发自动卖出（上价=1 表示不启用） */
export function isStopLossHit(price) {
  const p = Number(price)
  const max = getMaxEntryPrice()
  if (!(p > 0) || !(max > 0) || max >= 1) return false
  return p > max
}

export function getServerNowSec(data, tickMs = Date.now()) {
  const st = Number(data?.server_time || 0)
  const serverOffset = st ? st - tickMs / 1000 : 0
  return tickMs / 1000 + serverOffset
}

export function getRoundElapsedSec(data, tickMs, tf) {
  const round = getMarketRound(data, tickMs, tf)
  const now = getServerNowSec(data, tickMs)
  const roundTs = Number(round.round_ts || 0)
  if (!roundTs) return 0
  return Math.max(0, now - roundTs)
}

export function getRoundRemainingSec(data, tickMs, tf) {
  const round = getMarketRound(data, tickMs, tf)
  const now = getServerNowSec(data, tickMs)
  const end = Number(round.round_end || 0)
  if (!end) {
    const dur = MARKET_DURATIONS[tf] || 300
    const elapsed = getRoundElapsedSec(data, tickMs, tf)
    return Math.max(0, dur - elapsed)
  }
  return Math.max(0, end - now)
}

export function isRoundReadyForBet(data, tickMs, tf) {
  const remain = getRoundRemainingSec(data, tickMs, tf)
  const lastSec = getBetLastSec()
  // 最后 N 秒内，且至少还剩约 3 秒避免贴截止下单失败
  return remain > 3 && remain <= lastSec
}

export function secondsUntilBetWindow(data, tickMs, tf) {
  const remain = getRoundRemainingSec(data, tickMs, tf)
  const lastSec = getBetLastSec()
  if (remain <= lastSec) return 0
  return Math.ceil(remain - lastSec)
}

function marketPrices(data, tf) {
  const prices = data?.board_prices?.[tf] || {}
  return {
    up: Number(prices.up ?? (tf === '5m' ? data?.up_price : null) ?? 0),
    down: Number(prices.down ?? (tf === '5m' ? data?.down_price : null) ?? 0),
  }
}

export function betSignalForMarket(data, tf, condition = simSettings.condition) {
  const lbKeyMap = { '5m': 'leaderboard', '15m': 'leaderboard_15m', '1h': 'leaderboard_1h' }
  const lb = data?.[lbKeyMap[tf]]
  if (!lb) return 'none'
  const prices = marketPrices(data, tf)
  const upP = prices.up
  const downP = prices.down
  const upC = Number(lb.up_count ?? 0)
  const downC = Number(lb.dn_count ?? 0)
  const hot = lb.hot_streak_stats || {}
  const hotUp = Number(hot.up_n ?? 0)
  const hotDn = Number(hot.dn_n ?? 0)

  if (condition === 'price') {
    if (upP > downP && upP > 0) return 'up'
    if (downP > upP && downP > 0) return 'down'
    return 'none'
  }
  if (condition === 'price_count') {
    if (upP > downP && upC > downC) return 'up'
    if (downP > upP && downC > upC) return 'down'
    return 'none'
  }
  if (upP > downP && upC > downC && hotUp > hotDn) return 'up'
  if (downP > upP && downC > upC && hotDn > hotUp) return 'down'
  return 'none'
}

function roundInfoForTf(data, tickMs, tf) {
  const dur = MARKET_DURATIONS[tf] || 300
  const now = getServerNowSec(data, tickMs)
  const ts = Math.floor(now / dur) * dur
  return { round_ts: ts, round_end: ts + dur, strike: 0 }
}

function getMarketRound(data, tickMs, tf) {
  const fromApi = data?.board_rounds?.[tf]
  if (fromApi?.round_end) {
    return {
      round_ts: Number(fromApi.round_ts || 0),
      round_end: Number(fromApi.round_end || 0),
      strike: Number(fromApi.strike || 0),
    }
  }
  if (tf === '5m' && data?.round_end) {
    return {
      round_ts: Number(data.round_ts || 0),
      round_end: Number(data.round_end || 0),
      strike: Number(data.strike || 0),
    }
  }
  return roundInfoForTf(data, tickMs, tf)
}

function settleSimBet(tf, finalPrice) {
  const state = simByMarket[tf]
  const bet = state.openBet
  if (!bet || bet.market !== tf) return
  const stake = Number(bet.stake) || getStake()

  const strike = Number(bet.strike || 0)
  const price = Number(finalPrice || 0)
  let pnl = -stake
  let won = false
  let push = false

  if (strike > 0 && price > 0) {
    if (bet.side === 'up') won = price > strike
    else won = price < strike
    push = price === strike
    if (push) {
      pnl = 0
    } else if (won && bet.entryPrice > 0) {
      pnl = stake / bet.entryPrice - stake
    }
  }

  state.history.unshift({
    ...bet,
    finalPrice: price,
    won,
    push,
    pnl,
    settledAt: Date.now(),
  })
  if (state.history.length > MAX_SIM_HISTORY) state.history.length = MAX_SIM_HISTORY
  state.balance += pnl
  if (pnl > 0) state.wins += 1
  else if (pnl < 0) state.losses += 1
  state.openBet = null
  saveSimState()
}

function shouldSettleOpenBet(data, tickMs, tf, openBet, round, lastTs, roundTs) {
  if (!openBet || openBet.market !== tf) return false
  const now = getServerNowSec(data, tickMs)
  const roundEnd = Number(round.round_end || 0)
  if (openBet.roundTs === roundTs && roundEnd > 0 && now >= roundEnd) return true
  if (lastTs && roundTs && roundTs !== lastTs && openBet.roundTs === lastTs) return true
  return false
}

function maybeFireLiveTrade({ tf, sig, entry, roundTs }) {
  if (!simSettings.liveAuto || !liveTradeHandler) return
  if (!roundTs || wasLivePlaced(tf, roundTs)) return
  markLivePlaced(tf, roundTs)
  try {
    const ret = liveTradeHandler({
      market: tf,
      side: sig,
      amountUsd: getLiveAmount(),
      roundTs,
      entryPrice: entry,
    })
    if (ret && typeof ret.then === 'function') {
      ret.catch(() => { /* handler records failures */ })
    }
  } catch { /* ignore */ }
}

function maybeFireLiveStopSell({ tf, side, price, roundTs }) {
  if (!simSettings.liveAuto || !liveSellHandler) return
  if (!roundTs || !isStopLossHit(price)) return
  const key = `${tf}:${roundTs}:${String(side).toLowerCase()}`
  if (stopSellInFlight.has(key)) return
  stopSellInFlight.add(key)
  try {
    const ret = liveSellHandler({
      market: tf,
      side,
      roundTs,
      price,
      reason: 'stop_loss',
    })
    if (ret && typeof ret.then === 'function') {
      ret.catch(() => { /* handler records failures */ })
        .finally(() => { stopSellInFlight.delete(key) })
    } else {
      stopSellInFlight.delete(key)
    }
  } catch {
    stopSellInFlight.delete(key)
  }
}

function checkLiveStopLossForMarket(data, tf, roundTs) {
  if (!simSettings.liveAuto || !roundTs) return
  const prices = marketPrices(data, tf)
  for (const side of ['up', 'down']) {
    const entry = getLiveEntry(tf, roundTs, side)
    if (!entry || !(Number(entry.shares) >= 0.01)) continue
    const px = side === 'up' ? prices.up : prices.down
    if (!isStopLossHit(px)) continue
    maybeFireLiveStopSell({ tf, side, price: px, roundTs })
  }
}

export function syncSimBets(data, tickMs = Date.now()) {
  if (!data) return
  const doVirtual = !!simSettings.enabled
  const doLive = !!simSettings.liveAuto
  if (!doVirtual && !doLive) return

  const crypto = Number(data.crypto_current || 0)
  const activeMarkets = (simSettings.markets?.length ? simSettings.markets : TREND_MARKETS)
    .filter((tf) => TREND_MARKETS.includes(tf))
  const stake = getStake()
  pruneLivePlaced(getServerNowSec(data, tickMs))

  // 止损：已开启自动投注的周期，持仓现价超过入场上价则自动卖出
  if (doLive) {
    for (const tf of TREND_MARKETS) {
      const round = getMarketRound(data, tickMs, tf)
      const roundTs = round.round_ts
      if (roundTs) checkLiveStopLossForMarket(data, tf, roundTs)
    }
  }

  for (const tf of activeMarkets) {
    const state = simByMarket[tf]
    const round = getMarketRound(data, tickMs, tf)
    const roundTs = round.round_ts
    const lastTs = lastRoundTsByMarket.value[tf] || 0

    if (doVirtual && state.openBet && shouldSettleOpenBet(data, tickMs, tf, state.openBet, round, lastTs, roundTs)) {
      settleSimBet(tf, crypto)
    }
    if (roundTs) lastRoundTsByMarket.value[tf] = roundTs

    if (!isRoundReadyForBet(data, tickMs, tf)) continue

    const sig = betSignalForMarket(data, tf)
    if (sig !== 'up' && sig !== 'down') continue
    const prices = marketPrices(data, tf)
    const entry = sig === 'up' ? prices.up : prices.down
    if (!entry || entry <= 0 || !roundTs) continue
    if (!isEntryPriceAllowed(entry)) continue

    if (doVirtual && !state.openBet && state.balance >= stake) {
      state.openBet = {
        side: sig,
        roundTs,
        roundEnd: Number(round.round_end || 0),
        entryPrice: entry,
        stake,
        strike: round.strike,
        market: tf,
        placedAt: Date.now(),
      }
      saveSimState()
    }

    if (doLive) {
      maybeFireLiveTrade({ tf, sig, entry, roundTs })
    }
  }
}

export function loadSimState() {
  try {
    let raw = localStorage.getItem(SIM_STORAGE_KEY)
    let fromLegacy = false
    if (!raw) {
      raw = localStorage.getItem(SIM_STORAGE_KEY_LEGACY) || localStorage.getItem('yuce.btc.virtualBet.v1')
      fromLegacy = !!raw
    }
    if (!raw) return
    const saved = JSON.parse(raw)
    if (saved.settings && typeof saved.settings === 'object') {
      Object.assign(simSettings, {
        enabled: saved.settings.enabled !== false,
        stake: Number(saved.settings.stake) || SIM_DEFAULT_STAKE,
        markets: Array.isArray(saved.settings.markets) && saved.settings.markets.length
          ? saved.settings.markets.filter((m) => TREND_MARKETS.includes(m))
          : ['5m', '15m', '1h'],
        condition: CONDITION_LABELS[saved.settings.condition] ? saved.settings.condition : 'strict',
        betStartSec: Number.isFinite(Number(saved.settings.betStartSec))
          ? Math.min(3600, Math.max(0, Math.floor(Number(saved.settings.betStartSec))))
          : 0,
        betLastSec: Number.isFinite(Number(saved.settings.betLastSec)) && Number(saved.settings.betLastSec) > 0
          ? Math.min(3600, Math.floor(Number(saved.settings.betLastSec)))
          : SIM_DEFAULT_BET_LAST_SEC,
        maxEntryPrice: Number.isFinite(Number(saved.settings.maxEntryPrice))
          ? Math.min(1, Math.max(0.01, Math.round(Number(saved.settings.maxEntryPrice) * 100) / 100))
          : SIM_DEFAULT_MAX_ENTRY_PRICE,
        liveAuto: !!saved.settings.liveAuto,
        // v2 及更早版本默认金额曾为 5，迁移时统一改为 1
        liveAmount: fromLegacy
          ? SIM_DEFAULT_LIVE_AMOUNT
          : (Number.isFinite(Number(saved.settings.liveAmount)) && Number(saved.settings.liveAmount) >= 1
            ? Math.min(5000, Math.round(Number(saved.settings.liveAmount) * 100) / 100)
            : SIM_DEFAULT_LIVE_AMOUNT),
      })
    }
    const marketRows = saved.markets && typeof saved.markets === 'object' && !Array.isArray(saved.markets)
      ? saved.markets
      : saved
    for (const tf of TREND_MARKETS) {
      const row = marketRows?.[tf]
      if (!row) continue
      const state = simByMarket[tf]
      state.balance = Number.isFinite(Number(row.balance)) ? Number(row.balance) : SIM_INITIAL
      state.wins = Number(row.wins) || 0
      state.losses = Number(row.losses) || 0
      state.history = Array.isArray(row.history) ? row.history.slice(0, MAX_SIM_HISTORY) : []
      state.openBet = row.openBet && typeof row.openBet === 'object' ? row.openBet : null
    }
    if (fromLegacy) saveSimState()
  } catch { /* ignore */ }
}

export function saveSimSettings() {
  simSettings.stake = getStake()
  simSettings.betStartSec = getBetStartSec()
  simSettings.betLastSec = getBetLastSec()
  simSettings.maxEntryPrice = getMaxEntryPrice()
  simSettings.liveAmount = getLiveAmount()
  simSettings.liveAuto = !!simSettings.liveAuto
  if (!simSettings.markets.length) simSettings.markets = ['5m']
  saveSimState()
}

export function saveSimState() {
  try {
    const markets = {}
    for (const tf of TREND_MARKETS) {
      const state = simByMarket[tf]
      markets[tf] = {
        balance: state.balance,
        wins: state.wins,
        losses: state.losses,
        history: state.history.slice(0, MAX_SIM_HISTORY),
        openBet: state.openBet,
      }
    }
    localStorage.setItem(SIM_STORAGE_KEY, JSON.stringify({
      settings: { ...simSettings, markets: [...simSettings.markets] },
      markets,
    }))
  } catch { /* ignore */ }
}

export function toggleSimMarket(tf) {
  const set = new Set(simSettings.markets)
  if (set.has(tf)) {
    if (set.size <= 1) return
    set.delete(tf)
  } else {
    set.add(tf)
  }
  simSettings.markets = TREND_MARKETS.filter((k) => set.has(k))
}

export function clearSimHistory(tf) {
  const state = simByMarket[tf]
  if (!state) return
  state.history = []
  state.wins = 0
  state.losses = 0
  saveSimState()
}

export function clearAllSimHistory() {
  for (const tf of TREND_MARKETS) {
    const state = simByMarket[tf]
    if (!state) continue
    state.history = []
    state.wins = 0
    state.losses = 0
  }
  saveSimState()
}

export function resetSimBalance(tf, { keepOpenBet = false } = {}) {
  const state = simByMarket[tf]
  if (!state) return
  state.balance = SIM_INITIAL
  if (!keepOpenBet) state.openBet = null
  saveSimState()
}

export function resetAllSimBalance({ keepOpenBet = false } = {}) {
  for (const tf of TREND_MARKETS) {
    const state = simByMarket[tf]
    if (!state) continue
    state.balance = SIM_INITIAL
    if (!keepOpenBet) state.openBet = null
  }
  saveSimState()
}

let runnerTimer = null

export function startBackgroundRunner(fetchState, intervalMs = 10000) {
  stopBackgroundRunner()
  loadSimState()
  loadLiveTradeState()
  runnerTimer = setInterval(async () => {
    if (!simSettings.enabled && !simSettings.liveAuto) return
    try {
      const data = await fetchState()
      if (data) syncSimBets(data)
    } catch { /* ignore background errors */ }
  }, intervalMs)
}

export function stopBackgroundRunner() {
  if (runnerTimer) {
    clearInterval(runnerTimer)
    runnerTimer = null
  }
}

export function isBackgroundRunnerActive() {
  return !!runnerTimer
}
