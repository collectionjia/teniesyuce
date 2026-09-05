import { reactive, ref } from 'vue'

const LIVE_STORAGE_KEY = 'yuce.btc.liveTrade.v1'
const MAX_LIVE_ORDERS = 50

/** @type {import('vue').Ref<Array<Record<string, any>>>} */
export const liveOrders = ref([])

/** round keys already submitted: `${market}:${roundTs}` */
export const livePlacedKeys = reactive({})

/**
 * 本回合买入成本：key = `${market}:${roundTs}:${side}`
 * value = { shares, price, cost }
 */
export const liveEntries = reactive({})

export function liveRoundKey(market, roundTs) {
  return `${market}:${Number(roundTs) || 0}`
}

export function liveEntryKey(market, roundTs, side) {
  return `${market}:${Number(roundTs) || 0}:${String(side || '').toLowerCase()}`
}

export function wasLivePlaced(market, roundTs) {
  return !!livePlacedKeys[liveRoundKey(market, roundTs)]
}

export function markLivePlaced(market, roundTs) {
  livePlacedKeys[liveRoundKey(market, roundTs)] = true
  saveLiveTradeState()
}

/** 市价买入成交均价：making=USDC，taking=股数 */
export function resolveBuyFillPrice(resp, fallbackPrice) {
  const taking = Number(resp?.takingAmount)
  const making = Number(resp?.makingAmount)
  if (taking > 0 && making > 0) {
    const p = making / taking
    if (p > 0 && p <= 1.05) return Math.round(Math.min(p, 1) * 1000) / 1000
  }
  const fb = Number(fallbackPrice)
  if (fb > 0 && fb <= 1) return Math.round(fb * 1000) / 1000
  return 0
}

function clampProbPrice(p) {
  const n = Number(p)
  if (!(n > 0)) return 0
  // 已是 0–1 概率价
  if (n <= 1.05) return Math.round(Math.min(n, 1) * 1000) / 1000
  // 偶发以百分数/美分返回（如 52 → 0.52）
  if (n <= 100) return Math.round((n / 100) * 1000) / 1000
  return 0
}

function pickFillAmounts(resp) {
  const nested = resp?.result && typeof resp.result === 'object' ? resp.result : null
  const taking = Number(
    resp?.takingAmount ?? nested?.takingAmount ?? nested?.taking_amount ?? 0
  )
  const making = Number(
    resp?.makingAmount ?? nested?.makingAmount ?? nested?.making_amount ?? 0
  )
  return { taking, making }
}

/** 市价卖出成交均价：making=股数，taking=USDC */
export function resolveSellFillPrice(resp, fallbackPrice) {
  const { taking, making } = pickFillAmounts(resp)
  if (taking > 0 && making > 0) {
    // 常规：USDC / 股数
    const a = clampProbPrice(taking / making)
    if (a > 0) return a
    // 若字段对调：股数 / USDC
    const b = clampProbPrice(making / taking)
    if (b > 0) return b
  }
  const explicit = clampProbPrice(
    resp?.sellPrice ?? resp?.price ?? resp?.result?.sellPrice ?? resp?.result?.price
  )
  if (explicit > 0) return explicit
  return clampProbPrice(fallbackPrice)
}

export function resolveBuyFillShares(resp, amountUsd, price) {
  const taking = Number(resp?.takingAmount)
  if (taking > 0) return Math.round(taking * 100) / 100
  const p = Number(price)
  const usd = Number(amountUsd)
  if (p > 0 && usd > 0) return Math.round((usd / p) * 100) / 100
  return 0
}

export function recordLiveEntry(market, roundTs, side, shares, price) {
  const sh = Number(shares)
  const px = Number(price)
  if (!(sh > 0) || !(px > 0)) return
  const key = liveEntryKey(market, roundTs, side)
  const prev = liveEntries[key]
  if (prev && prev.shares > 0 && prev.price > 0) {
    const totalShares = prev.shares + sh
    const cost = (prev.cost || prev.shares * prev.price) + sh * px
    liveEntries[key] = {
      shares: Math.round(totalShares * 100) / 100,
      price: Math.round((cost / totalShares) * 1000) / 1000,
      cost: Math.round(cost * 100) / 100,
    }
  } else {
    liveEntries[key] = {
      shares: Math.round(sh * 100) / 100,
      price: Math.round(px * 1000) / 1000,
      cost: Math.round(sh * px * 100) / 100,
    }
  }
  saveLiveTradeState()
}

export function getLiveEntry(market, roundTs, side) {
  return liveEntries[liveEntryKey(market, roundTs, side)] || null
}

export function clearLiveEntry(market, roundTs, side) {
  const key = liveEntryKey(market, roundTs, side)
  if (key in liveEntries) {
    delete liveEntries[key]
    saveLiveTradeState()
  }
}

export function pruneLiveEntries(nowSec = Math.floor(Date.now() / 1000)) {
  const cutoff = nowSec - 7200
  for (const key of Object.keys(liveEntries)) {
    const ts = Number(String(key).split(':')[1] || 0)
    if (ts && ts < cutoff) delete liveEntries[key]
  }
}

export function recordLiveOrder(order) {
  liveOrders.value.unshift({
    side: order.side,
    amount: order.amount,
    market: order.market,
    orderId: order.orderId || '',
    at: order.at || Date.now(),
    ok: !!order.ok,
    error: order.error || '',
    auto: !!order.auto,
    roundTs: Number(order.roundTs || 0),
    action: order.action === 'sell' ? 'sell' : 'buy',
    shares: Number(order.shares || 0) || 0,
    entryPrice: Number(order.entryPrice || 0) || 0,
  })
  if (liveOrders.value.length > MAX_LIVE_ORDERS) {
    liveOrders.value.length = MAX_LIVE_ORDERS
  }
  saveLiveTradeState()
}

export function clearLiveOrders() {
  liveOrders.value = []
  saveLiveTradeState()
}

export function loadLiveTradeState() {
  try {
    const raw = localStorage.getItem(LIVE_STORAGE_KEY)
    if (!raw) return
    const saved = JSON.parse(raw)
    if (Array.isArray(saved.orders)) {
      liveOrders.value = saved.orders.slice(0, MAX_LIVE_ORDERS)
    }
    if (saved.placed && typeof saved.placed === 'object') {
      Object.keys(livePlacedKeys).forEach((k) => { delete livePlacedKeys[k] })
      Object.assign(livePlacedKeys, saved.placed)
    }
    if (saved.entries && typeof saved.entries === 'object') {
      Object.keys(liveEntries).forEach((k) => { delete liveEntries[k] })
      Object.assign(liveEntries, saved.entries)
    }
  } catch { /* ignore */ }
}

export function saveLiveTradeState() {
  try {
    localStorage.setItem(LIVE_STORAGE_KEY, JSON.stringify({
      orders: liveOrders.value.slice(0, MAX_LIVE_ORDERS),
      placed: { ...livePlacedKeys },
      entries: { ...liveEntries },
    }))
  } catch { /* ignore */ }
}

/** Drop old round keys older than ~2 hours to keep storage small */
export function pruneLivePlaced(nowSec = Math.floor(Date.now() / 1000)) {
  const cutoff = nowSec - 7200
  for (const key of Object.keys(livePlacedKeys)) {
    const ts = Number(String(key).split(':')[1] || 0)
    if (ts && ts < cutoff) delete livePlacedKeys[key]
  }
  pruneLiveEntries(nowSec)
}
