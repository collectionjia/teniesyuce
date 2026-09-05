const ET = 'America/New_York'

export function getRoundEndSec(roundTs, roundEndSec, tf, durations) {
  const end = Number(roundEndSec || 0)
  if (end > 0) return end
  const ts = Number(roundTs || 0)
  if (!ts) return 0
  const dur = durations?.[tf] || 300
  return ts + dur
}

function fmtEtDate(date) {
  const month = new Intl.DateTimeFormat('zh-CN', { timeZone: ET, month: 'long' }).format(date)
  const day = new Intl.DateTimeFormat('zh-CN', { timeZone: ET, day: 'numeric' }).format(date)
  return `${month} ${day}`
}

function fmtEtClock(date) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: ET,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(date)
  const dayPeriod = parts.find((p) => p.type === 'dayPeriod')?.value || ''
  const hour = parts.find((p) => p.type === 'hour')?.value || ''
  const minute = parts.find((p) => p.type === 'minute')?.value || ''
  return `${dayPeriod} ${hour}:${minute}`
}

/** 例：八月 31, 下午 11:05-下午 11:10 ET */
export function fmtBtcRoundRangeEt(roundTs, roundEndSec) {
  const startSec = Number(roundTs || 0)
  const endSec = Number(roundEndSec || 0)
  if (!startSec || !endSec || endSec <= startSec) return '—'
  const start = new Date(startSec * 1000)
  const end = new Date(endSec * 1000)
  return `${fmtEtDate(start)}, ${fmtEtClock(start)}-${fmtEtClock(end)} ET`
}
