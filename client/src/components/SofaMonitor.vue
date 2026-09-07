<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import * as api from '../api'
import { sofaTennisMatchUrl } from '../utils/sofaMatchUrl'

const loading = ref(true)
const refreshing = ref(false)
const collecting = ref(false)
const liveCollecting = ref(false)
const error = ref('')
const notice = ref('')
const status = ref(null)
const top100Board = ref(null)
const liveData = ref(null)
const logs = ref(null)
const tab = ref('atp') // atp | wta | live | logs
const topPoolMax = ref('100') // 20 | 50 | 100
const tierFilter = ref({ gs: false, t1000: false, t500: false })
const onlyWithMatches = ref(false)
const expanded = ref({})
const schedule = ref(null)
const scheduleSaving = ref(false)
const dataSource = ref(null)
const dataSourceSaving = ref(false)
const playerPage = ref(1)
const livePage = ref(1)
const logPage = ref(1)
const cronOpen = ref(false)
const statsOpen = ref(false)
const metricsOpen = ref(false)

const PLAYER_PAGE_SIZE = 15
const LIVE_PAGE_SIZE = 12
const LOG_PAGE_SIZE = 60

const INTERVAL_OPTIONS = [
  { hours: 2, label: '2 小时' },
  { hours: 4, label: '4 小时' },
  { hours: 6, label: '6 小时' },
  { hours: 12, label: '12 小时' },
]

let pollTimer = null
let top100Timer = null
let liveTimer = null
let noticeTimer = null

const top100LoadingSince = ref(0)
const top100LoadingSec = ref(0)
let top100LoadingTick = null

const running = computed(() => !!(
  status.value?.top100_collect?.running
  || status.value?.running
))
const top100Collect = computed(() => status.value?.top100_collect || {})
const lastRun = computed(() => top100Collect.value?.last || status.value?.last_run || {})
const livePoll = computed(() => status.value?.live_poll?.last || liveData.value?.last || {})
const liveRunning = computed(() => !!(status.value?.live_poll?.running || liveData.value?.running))
const liveMatches = computed(() => {
  const list = livePoll.value?.events || []
  return Array.isArray(list) ? list : []
})
const bundle = computed(() => status.value?.latest_bundle || {})
const cronLines = computed(() => (status.value?.cron || []).filter((l) => l && !String(l).startsWith('#')))
const collectIntervalHours = computed(() => {
  const hours = Number(schedule.value?.interval_hours ?? status.value?.schedule?.interval_hours)
  return INTERVAL_OPTIONS.some((o) => o.hours === hours) ? hours : 4
})
const collectIntervalLabel = computed(() => {
  const opt = INTERVAL_OPTIONS.find((o) => o.hours === collectIntervalHours.value)
  return opt?.label || `每 ${collectIntervalHours.value} 小时`
})
const tennisDataSource = computed(() => dataSource.value?.source || 'ipwo')
const tennisDataSourceLabel = computed(() => {
  if (tennisDataSource.value === 'api') return 'AllSports API'
  return 'Sofascore · IPWO'
})
const redisUpstreamLabel = computed(() => {
  const up = dataSource.value?.redis_upstream
  if (!up) return '—'
  if (String(up).includes('allsports')) return 'AllSports API'
  if (String(up).includes('sofa') || String(up).includes('ipwo')) return 'Sofascore · IPWO'
  return up
})
const collectRequests = computed(() => (
  top100Collect.value?.last?.requests
  || top100Board.value?.requests
  || dataSource.value?.collect_requests
  || null
))
const polyMatchStats = computed(() => dataSource.value?.poly_match || null)
const redisRefreshStats = computed(() => dataSource.value?.redis_refresh || null)
const collectElapsedMs = computed(() => {
  const sec = top100Collect.value?.last?.elapsed_sec ?? top100Board.value?.elapsed_sec
  return sec != null ? sec * 1000 : null
})
const polyElapsedMs = computed(() => (
  polyMatchStats.value?.timingMs?.total ?? redisRefreshStats.value?.polyMs ?? null
))

function formatMs(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1000) return `${Math.round(n)} ms`
  return `${(n / 1000).toFixed(1)} s`
}

function collectRequestHint(req) {
  if (!req || typeof req !== 'object') return '—'
  const parts = [
    `预热 ${req.warmup ?? 0}`,
    `API ${req.api ?? 0}`,
    `重试 ${req.retries ?? 0}`,
  ]
  const tier = req.collect?.tier
  if (tier != null) parts.push(`tier ${tier}`)
  return parts.join(' · ')
}

const summary = computed(() => ({
  ...(top100Board.value?.summary || {}),
  ...(top100Collect.value?.summary || {}),
  total_matches:
    top100Board.value?.summary?.total_matches
    ?? lastRun.value?.total_events
    ?? top100Collect.value?.summary?.total_matches,
}))

const TIER_OPTIONS = [
  { key: 'gs', label: '大满贯' },
  { key: 't1000', label: '1000' },
  { key: 't500', label: '500' },
]

function matchTierKey(m) {
  const level = String(m?.level || '').toLowerCase()
  const tour = String(m?.tournament || m?.tournamentShort || '').toLowerCase()
  const combined = `${level} ${tour}`
  if (
    /\bgs\b/.test(level)
    || combined.includes('grand slam')
    || ['australian open', 'roland garros', 'french open', 'wimbledon', 'us open'].some((x) => combined.includes(x))
  ) return 'gs'
  if (/\b1000\b/.test(level) || combined.includes('masters')) return 't1000'
  if (/\b500\b/.test(level) || /\b500\b/.test(tour)) return 't500'
  return 'other'
}

function tierFilterActive() {
  return TIER_OPTIONS.some((o) => tierFilter.value[o.key])
}

function matchPassesTier(m) {
  if (!tierFilterActive()) return true
  const key = matchTierKey(m)
  if (key === 'other') return false
  return !!tierFilter.value[key]
}

function playerMatchesFiltered(p) {
  return (Array.isArray(p?.matches) ? p.matches : []).filter(matchPassesTier)
}

function rankPoolPlayers(list) {
  const max = Number(topPoolMax.value) || 100
  return (Array.isArray(list) ? list : []).filter((p) => {
    const rank = Number(p.rank)
    return Number.isFinite(rank) && rank > 0 && rank <= max
  })
}

const players = computed(() => {
  const list = tab.value === 'wta' ? top100Board.value?.wta : top100Board.value?.atp
  return rankPoolPlayers(list).filter((p) => {
    const matches = playerMatchesFiltered(p)
    if (onlyWithMatches.value && !matches.length) return false
    return true
  }).map((p) => {
    const matches = playerMatchesFiltered(p)
    return { ...p, matches, matchCount: matches.length }
  })
})
const rawPoolPlayers = computed(() => rankPoolPlayers(
  tab.value === 'wta' ? top100Board.value?.wta : top100Board.value?.atp,
))
const poolSummary = computed(() => {
  const max = Number(topPoolMax.value) || 100
  let matches = 0
  for (const p of players.value) matches += Number(p.matchCount) || 0
  return { max, players: players.value.length, matches }
})
const playerPageCount = computed(() => Math.max(1, Math.ceil(players.value.length / PLAYER_PAGE_SIZE)))
const pagedPlayers = computed(() => {
  const start = (playerPage.value - 1) * PLAYER_PAGE_SIZE
  return players.value.slice(start, start + PLAYER_PAGE_SIZE)
})
const livePageCount = computed(() => Math.max(1, Math.ceil(liveMatches.value.length / LIVE_PAGE_SIZE)))
const pagedLiveMatches = computed(() => {
  const start = (livePage.value - 1) * LIVE_PAGE_SIZE
  return liveMatches.value.slice(start, start + LIVE_PAGE_SIZE)
})
const logLines = computed(() => {
  const raw = logs.value?.content || status.value?.latest_log_tail || ''
  return String(raw).split('\n')
})
const logPageCount = computed(() => Math.max(1, Math.ceil(logLines.value.length / LOG_PAGE_SIZE)))
const pagedLogText = computed(() => {
  const start = (logPage.value - 1) * LOG_PAGE_SIZE
  return logLines.value.slice(start, start + LOG_PAGE_SIZE).join('\n') || '(暂无日志)'
})

const statusLabel = computed(() => {
  if (running.value) return '采集中'
  const s = lastRun.value.status
  if (s === 'success') return '最近成功'
  if (s === 'failed') return '最近失败'
  if (s === 'running') return '采集中'
  return '空闲'
})

const statusTone = computed(() => {
  if (running.value || lastRun.value.status === 'running') return 'run'
  if (lastRun.value.status === 'success') return 'ok'
  if (lastRun.value.status === 'failed') return 'err'
  return 'idle'
})

const busy = computed(() => (
  running.value
  || collecting.value
  || liveCollecting.value
  || liveRunning.value
  || !!top100Board.value?.loading
))

function showNotice(msg) {
  notice.value = msg
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    notice.value = ''
    noticeTimer = null
  }, 8000)
}

function startTop100LoadingClock() {
  top100LoadingSince.value = Date.now()
  top100LoadingSec.value = 0
  if (top100LoadingTick) clearInterval(top100LoadingTick)
  top100LoadingTick = setInterval(() => {
    if (!top100Board.value?.loading) {
      stopTop100LoadingClock()
      return
    }
    top100LoadingSec.value = Math.floor((Date.now() - top100LoadingSince.value) / 1000)
  }, 1000)
}

function stopTop100LoadingClock() {
  if (top100LoadingTick) {
    clearInterval(top100LoadingTick)
    top100LoadingTick = null
  }
  top100LoadingSince.value = 0
  top100LoadingSec.value = 0
}

function toggle(id) {
  expanded.value = { ...expanded.value, [id]: !expanded.value[id] }
}

function formatMonitorError(raw) {
  const msg = String(raw || '').trim()
  if (!msg) return ''
  const low = msg.toLowerCase()
  if (low.includes('curl: (28)') || low.includes('connection timed out') || low.includes('timed out after')) {
    return 'Sofascore 请求超时（代理或网络较慢），请稍后重试'
  }
  if (low.includes('curl: (7)') || low.includes('failed to connect')) {
    return '无法连接 Sofascore/代理，请检查网络或代理配置'
  }
  if (low.includes('403') && (low.includes('forbidden') || low.includes('拒绝'))) {
    return 'Sofascore 拒绝访问（403），请检查代理 IP'
  }
  if (low.includes('monitor unreachable') || low.includes('502')) {
    return '监控服务不可达，请确认采集服务是否运行'
  }
  return msg
}

function fmtTime(v) {
  if (!v) return '—'
  const s = String(v)
  if (s.includes('T')) {
    const d = new Date(s)
    if (!Number.isNaN(d.getTime())) {
      const p = (n) => String(n).padStart(2, '0')
      return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    }
  }
  return s.replace('T', ' ').slice(0, 19)
}

async function loadStatus() {
  status.value = await api.fetchSofaMonitorStatus()
}

async function loadTop100(force = false) {
  const data = await api.fetchSofaMonitorTop100(force)
  top100Board.value = data
  if (data?.loading) {
    startTop100LoadingClock()
    if (!top100Timer) {
      top100Timer = setInterval(async () => {
        try {
          const next = await api.fetchSofaMonitorTop100(false)
          top100Board.value = next
          if (!next?.loading) {
            clearInterval(top100Timer)
            top100Timer = null
            stopTop100LoadingClock()
            if (next?.error) {
              error.value = formatMonitorError(next.error)
            }
          }
        } catch {
          /* keep polling */
        }
      }, 2000)
    }
  } else {
    stopTop100LoadingClock()
    if (top100Timer) {
      clearInterval(top100Timer)
      top100Timer = null
    }
  }
}

async function loadLive() {
  liveData.value = await api.fetchSofaMonitorLive()
}

async function loadSchedule() {
  schedule.value = await api.fetchSofaMonitorSchedule()
}

async function loadDataSource() {
  dataSource.value = await api.fetchSofaMonitorDataSource()
}

async function loadLogs() {
  logs.value = await api.fetchSofaMonitorLogs(150)
}

async function refreshAll({ silent = false } = {}) {
  if (!silent) {
    refreshing.value = true
    error.value = ''
    notice.value = ''
  }
  try {
    await Promise.all([loadStatus(), loadTop100(false), loadLive(), loadLogs(), loadSchedule(), loadDataSource()])
  } catch (e) {
    error.value = formatMonitorError(e?.response?.data?.error || e?.message || '加载失败')
  } finally {
    loading.value = false
    refreshing.value = false
  }
}

async function waitCollectDone() {
  const deadline = Date.now() + 10 * 60 * 1000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000))
    await loadStatus()
    await loadLogs()
    if (!running.value) {
      const err = lastRun.value?.error
      if (lastRun.value?.status === 'failed' && err) {
        notice.value = ''
        error.value = formatMonitorError(err)
      } else if (lastRun.value?.status === 'success') {
        error.value = ''
        showNotice(`Top100 采集完成：${lastRun.value?.total_events ?? bundle.value?.event_count ?? '—'} 场比赛`)
        api.refreshTennisCache().catch(() => {})
        api.refreshTennisNewCache().catch(() => {})
        await loadTop100(true)
        await loadDataSource()
      }
      return
    }
  }
  notice.value = ''
  error.value = '采集仍在进行，请稍后在日志中查看结果'
}

async function waitLiveCollectDone() {
  const deadline = Date.now() + 90 * 1000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000))
    await loadLive()
    await loadStatus()
    if (!liveRunning.value) {
      const err = livePoll.value?.error
      if (livePoll.value?.status === 'failed' && err) {
        notice.value = ''
        error.value = formatMonitorError(err)
      } else {
        error.value = ''
        showNotice(`进行中比分已更新：${livePoll.value?.live_count ?? liveMatches.value.length} 场`)
        api.refreshTennisCache().catch(() => {})
      }
      return
    }
  }
  notice.value = ''
  error.value = '拉取进行中比分超时，请稍后再试'
}

async function triggerCollect() {
  if (collecting.value || running.value) return
  collecting.value = true
  error.value = ''
  notice.value = ''
  try {
    await api.triggerSofaMonitorCollect()
    await loadStatus()
    await loadLogs()
    if (running.value) await waitCollectDone()
  } catch (e) {
    error.value = formatMonitorError(e?.response?.data?.error || e?.message || '触发失败')
  } finally {
    collecting.value = false
  }
}

async function triggerLiveCollect() {
  if (liveCollecting.value || liveRunning.value) return
  liveCollecting.value = true
  error.value = ''
  notice.value = ''
  try {
    await api.triggerSofaMonitorLiveCollect()
    await loadLive()
    await loadStatus()
    await loadLogs()
    if (liveRunning.value) await waitLiveCollectDone()
  } catch (e) {
    error.value = formatMonitorError(e?.response?.data?.error || e?.message || '触发失败')
  } finally {
    liveCollecting.value = false
  }
}

function parseScoreTextSides(text) {
  if (!text) return null
  const sets = String(text).replace(/,\s*/g, ' ').trim().split(/\s+/).filter(Boolean)
  const home = []
  const away = []
  for (const part of sets) {
    const m = part.match(/^(\d+)-(\d+)$/)
    if (!m) continue
    home.push(m[1])
    away.push(m[2])
  }
  if (!home.length) return null
  return { home: home.join(' '), away: away.join(' ') }
}

function playerLiveScoreText(m, side) {
  const combined = m?.scoreText || m?.score_text || m?.score
  if (combined && typeof combined === 'string') {
    const parsed = parseScoreTextSides(combined)
    if (parsed) return parsed[side]
  }
  const raw = side === 'home' ? m?.homeScore : m?.awayScore
  if (raw == null || raw === '') return ''
  return String(raw)
}

async function onIntervalChange(event) {
  const hours = Number(event.target.value)
  if (!INTERVAL_OPTIONS.some((o) => o.hours === hours) || hours === collectIntervalHours.value) return
  scheduleSaving.value = true
  error.value = ''
  try {
    const data = await api.updateSofaMonitorSchedule(hours)
    schedule.value = data
    await loadStatus()
  } catch (e) {
    error.value = formatMonitorError(e?.response?.data?.error || e?.message || '更新频度失败')
    event.target.value = String(collectIntervalHours.value)
  } finally {
    scheduleSaving.value = false
  }
}

async function onDataSourceChange(next) {
  if (next === tennisDataSource.value || dataSourceSaving.value) return
  if (next === 'api' && !dataSource.value?.api_available) {
    error.value = 'AllSports API 未配置（需 RAPIDAPI_KEY）'
    return
  }
  dataSourceSaving.value = true
  error.value = ''
  notice.value = ''
  try {
    const data = await api.updateSofaMonitorDataSource(next)
    dataSource.value = { ...(dataSource.value || {}), ...data }
    showNotice(data.message || `已切换为 ${data.label || next}，正在写入 Redis`)
    api.refreshTennisCache().catch(() => {})
  } catch (e) {
    error.value = formatMonitorError(e?.response?.data?.error || e?.message || '切换数据源失败')
  } finally {
    dataSourceSaving.value = false
  }
}

async function refreshTop100() {
  if (running.value) {
    error.value = 'Top100 采集进行中，请稍后再重拉'
    return
  }
  error.value = ''
  notice.value = ''
  try {
    await loadTop100(true)
  } catch (e) {
    error.value = formatMonitorError(e?.response?.data?.error || e?.message || '刷新 Top100 失败')
  }
}

function setPlayerPage(page) {
  playerPage.value = Math.min(Math.max(1, page), playerPageCount.value)
}

function setLivePage(page) {
  livePage.value = Math.min(Math.max(1, page), livePageCount.value)
}

function setLogPage(page) {
  logPage.value = Math.min(Math.max(1, page), logPageCount.value)
}

function toggleTier(key) {
  tierFilter.value = { ...tierFilter.value, [key]: !tierFilter.value[key] }
}

function tierFilterSummary() {
  const on = TIER_OPTIONS.filter((o) => tierFilter.value[o.key]).map((o) => o.label)
  return on.length ? on.join(' · ') : '未选'
}

function playerPageLabel() {
  if (!players.value.length) return '0 条'
  const start = (playerPage.value - 1) * PLAYER_PAGE_SIZE + 1
  const end = Math.min(playerPage.value * PLAYER_PAGE_SIZE, players.value.length)
  return `${start}-${end} / ${players.value.length}`
}

function livePageLabel() {
  if (!liveMatches.value.length) return '0 条'
  const start = (livePage.value - 1) * LIVE_PAGE_SIZE + 1
  const end = Math.min(livePage.value * LIVE_PAGE_SIZE, liveMatches.value.length)
  return `${start}-${end} / ${liveMatches.value.length}`
}

function logPageLabel() {
  if (!logLines.value.length) return '0 行'
  const start = (logPage.value - 1) * LOG_PAGE_SIZE + 1
  const end = Math.min(logPage.value * LOG_PAGE_SIZE, logLines.value.length)
  return `${start}-${end} / ${logLines.value.length}`
}

watch([tab, topPoolMax, tierFilter, onlyWithMatches], () => {
  playerPage.value = 1
  expanded.value = {}
})
watch(tab, () => {
  livePage.value = 1
  logPage.value = 1
})
watch(players, (list) => {
  if (playerPage.value > Math.max(1, Math.ceil(list.length / PLAYER_PAGE_SIZE))) {
    playerPage.value = 1
  }
})
watch(liveMatches, (list) => {
  if (livePage.value > Math.max(1, Math.ceil(list.length / LIVE_PAGE_SIZE))) {
    livePage.value = 1
  }
})
watch(logLines, () => {
  if (logPage.value > logPageCount.value) logPage.value = 1
})

onMounted(() => {
  refreshAll()
  pollTimer = setInterval(() => {
    loadStatus().catch(() => {})
    if (running.value) loadLogs().catch(() => {})
  }, 5000)
  liveTimer = setInterval(() => {
    loadLive().catch(() => {})
  }, 60000)
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
  if (top100Timer) clearInterval(top100Timer)
  if (liveTimer) clearInterval(liveTimer)
  if (noticeTimer) clearTimeout(noticeTimer)
  stopTop100LoadingClock()
})
</script>

<template>
  <div class="sofa">
    <div class="toolbar">
      <div class="titles">
        <div class="title">Sofascore 监控</div>
        <div class="sub">Top100 赛程 · 进行中比分 · Redis 写入 {{ tennisDataSourceLabel }}</div>
      </div>
      <div class="actions-primary">
        <button type="button" class="btn ghost" :disabled="refreshing" @click="refreshAll()">刷新</button>
        <button type="button" class="btn ghost" :disabled="liveCollecting || liveRunning" @click="triggerLiveCollect">
          {{ liveRunning ? '拉取中…' : liveCollecting ? '触发中…' : '拉取进行中' }}
        </button>
        <button type="button" class="btn primary" :disabled="collecting || running" @click="triggerCollect">
          {{ running ? 'Top100 采集中…' : collecting ? '触发中…' : '立即采集 Top100' }}
        </button>
      </div>
    </div>

    <div v-if="!loading" class="settings-row">
      <div class="source-group" role="radiogroup" aria-label="网球页 Redis 写入源">
        <span class="source-label">网球数据源</span>
        <label class="source-opt" :class="{ on: tennisDataSource === 'ipwo' }">
          <input
            type="radio"
            name="tennis-data-source"
            value="ipwo"
            :checked="tennisDataSource === 'ipwo'"
            :disabled="dataSourceSaving || loading"
            @change="onDataSourceChange('ipwo')"
          >
          IPWO
        </label>
        <label class="source-opt" :class="{ on: tennisDataSource === 'api', disabled: !dataSource?.api_available }">
          <input
            type="radio"
            name="tennis-data-source"
            value="api"
            :checked="tennisDataSource === 'api'"
            :disabled="dataSourceSaving || loading || !dataSource?.api_available"
            @change="onDataSourceChange('api')"
          >
          API
        </label>
      </div>
      <label class="interval-select">
        <span>更新频度</span>
        <select
          :value="collectIntervalHours"
          :disabled="scheduleSaving || loading || running"
          @change="onIntervalChange"
        >
          <option v-for="opt in INTERVAL_OPTIONS" :key="opt.hours" :value="opt.hours">
            {{ opt.label }}
          </option>
        </select>
      </label>
    </div>

    <div v-if="notice" class="banner ok">{{ notice }}</div>
    <div v-if="error" class="banner err">{{ error }}</div>
    <div v-if="loading" class="banner">加载中…</div>

    <template v-else>
      <details class="panel panel-fold stats-fold" :open="statsOpen" @toggle="statsOpen = $event.target.open">
        <summary class="fold-summary stats-summary">
          <span class="fold-title">运行状态</span>
          <span class="fold-inline">
            <span class="pill sm" :class="statusTone">{{ statusLabel }}</span>
            <span class="fold-meta">
              {{ fmtTime(lastRun.finished_at || lastRun.started_at) }}
              · {{ bundle.event_count ?? 0 }} 场
              · 进行中 {{ livePoll.live_count ?? liveMatches.length }}
              · Top100 {{ summary.total_matches ?? '—' }}
            </span>
          </span>
          <span class="muted fold-toggle">{{ statsOpen ? '收起' : '展开' }}</span>
        </summary>
        <div class="cards cards-compact">
          <div class="card">
            <div class="label">状态</div>
            <div class="value"><span class="pill" :class="statusTone">{{ statusLabel }}</span></div>
          </div>
          <div class="card">
            <div class="label">最近采集</div>
            <div class="value mono sm">{{ fmtTime(lastRun.finished_at || lastRun.started_at) }}</div>
          </div>
          <div class="card">
            <div class="label">Bundle</div>
            <div class="value sm">{{ bundle.event_count ?? 0 }} 场</div>
            <div class="hint">{{ bundle.date || '—' }}</div>
          </div>
          <div class="card">
            <div class="label">进行中</div>
            <div class="value sm">{{ livePoll.live_count ?? liveMatches.length }}</div>
          </div>
          <div class="card">
            <div class="label">Redis</div>
            <div class="value sm">{{ redisUpstreamLabel }}</div>
          </div>
          <div class="card">
            <div class="label">Top100</div>
            <div class="value sm">{{ summary.total_matches ?? '—' }}</div>
            <div class="hint">A{{ summary.atp_matches ?? 0 }} · W{{ summary.wta_matches ?? 0 }}</div>
          </div>
        </div>
      </details>

      <details class="panel panel-fold metrics-fold" :open="metricsOpen" @toggle="metricsOpen = $event.target.open">
        <summary class="fold-summary stats-summary">
          <span class="fold-title">采集统计</span>
          <span class="fold-meta">
            HTTP {{ collectRequests?.total ?? '—' }} 次
            · 采集 {{ formatMs(collectElapsedMs) }}
            · PM {{ formatMs(polyElapsedMs) }}
            · Redis {{ formatMs(redisRefreshStats?.totalMs) }}
          </span>
          <span class="muted fold-toggle">{{ metricsOpen ? '收起' : '展开' }}</span>
        </summary>
        <div class="metrics metrics-inner">
          <div class="metric">
            <div class="metric-label">采集 HTTP 请求</div>
            <div class="metric-value">{{ collectRequests?.total ?? '—' }} 次</div>
            <div class="metric-hint">{{ collectRequestHint(collectRequests) }}</div>
          </div>
          <div class="metric">
            <div class="metric-label">采集耗时</div>
            <div class="metric-value">{{ formatMs(collectElapsedMs) }}</div>
            <div class="metric-hint">Top100 最近一轮</div>
          </div>
          <div class="metric">
            <div class="metric-label">Polymarket 外链</div>
            <div class="metric-value">{{ formatMs(polyElapsedMs) }}</div>
            <div class="metric-hint">
              匹配 {{ formatMs(polyMatchStats?.timingMs?.match ?? redisRefreshStats?.polyMatchMs) }}
              · 刷价 {{ formatMs(polyMatchStats?.timingMs?.prices ?? redisRefreshStats?.polyPriceMs) }}
              · 链接 {{ polyMatchStats?.matched ?? '—' }} 场
            </div>
          </div>
          <div class="metric">
            <div class="metric-label">写入 Redis 总耗时</div>
            <div class="metric-value">{{ formatMs(redisRefreshStats?.totalMs) }}</div>
            <div class="metric-hint">含 PM 外链 · {{ fmtTime(dataSource?.redis_fetched_at) }}</div>
          </div>
        </div>
      </details>

      <details v-if="cronLines.length || schedule" class="panel panel-fold" :open="cronOpen" @toggle="cronOpen = $event.target.open">
        <summary class="panel-h row fold-summary">
          <span>定时任务 · {{ collectIntervalLabel }}</span>
          <span class="muted panel-meta">{{ cronOpen ? '收起' : '展开' }}</span>
        </summary>
        <div class="cron-list">
          <code v-for="(line, i) in cronLines" :key="i">{{ line }}</code>
          <code v-if="!cronLines.length && schedule?.cron_line">{{ schedule.cron_line }}</code>
        </div>
      </details>

      <div class="tabs">
        <button type="button" :class="{ on: tab === 'atp' }" @click="tab = 'atp'">ATP</button>
        <button type="button" :class="{ on: tab === 'wta' }" @click="tab = 'wta'">WTA</button>
        <button type="button" :class="{ on: tab === 'live' }" @click="tab = 'live'">进行中</button>
        <button type="button" :class="{ on: tab === 'logs' }" @click="tab = 'logs'">日志</button>
        <button type="button" class="link" :disabled="busy || running" @click="refreshTop100">重拉 Top100</button>
      </div>

      <div v-if="tab === 'atp' || tab === 'wta'" class="filter-bars">
        <div class="pool-bar">
          <span class="pool-label">排名池</span>
          <button type="button" class="chip-btn" :class="{ active: topPoolMax === '20' }" @click="topPoolMax = '20'">Top20</button>
          <button type="button" class="chip-btn" :class="{ active: topPoolMax === '50' }" @click="topPoolMax = '50'">Top50</button>
          <button type="button" class="chip-btn" :class="{ active: topPoolMax === '100' }" @click="topPoolMax = '100'">Top100</button>
        </div>
        <div class="pool-bar">
          <span class="pool-label">赛事</span>
          <button
            v-for="opt in TIER_OPTIONS"
            :key="opt.key"
            type="button"
            class="chip-btn"
            :class="{ active: tierFilter[opt.key] }"
            @click="toggleTier(opt.key)"
          >
            {{ opt.label }}
          </button>
        </div>
        <div class="pool-bar pool-bar-tail">
          <label class="match-only">
            <input v-model="onlyWithMatches" type="checkbox">
            <span>仅有赛事</span>
          </label>
          <span class="pool-meta">
            {{ tab.toUpperCase() }} · {{ poolSummary.players }} 人 · {{ poolSummary.matches }} 场
            <template v-if="tierFilterActive()"> · {{ tierFilterSummary() }}</template>
          </span>
        </div>
      </div>

      <div v-if="tab === 'live'" class="panel">
        <div class="panel-h row">
          <span class="panel-title">进行中 · {{ livePoll.date || status?.latest_bundle?.date || '—' }}</span>
          <span class="muted panel-meta">
            <template v-if="liveRunning">拉取中…</template>
            <template v-else>每 60 秒自动刷新 · {{ fmtTime(livePoll.finished_at || livePoll.fetched_at) }}</template>
          </span>
        </div>
        <div v-if="livePoll.error" class="banner err">{{ formatMonitorError(livePoll.error) }}</div>
        <div v-else-if="!liveMatches.length" class="empty">当前没有进行中的比赛</div>
        <template v-else>
          <div class="pager">
            <span class="pager-info">第 {{ livePage }} / {{ livePageCount }} 页 · {{ livePageLabel() }}</span>
            <div class="pager-actions">
              <button type="button" class="pager-btn" :disabled="livePage <= 1" @click="setLivePage(livePage - 1)">上一页</button>
              <button type="button" class="pager-btn" :disabled="livePage >= livePageCount" @click="setLivePage(livePage + 1)">下一页</button>
            </div>
          </div>
          <div class="live-list">
          <div v-for="m in pagedLiveMatches" :key="m.id" class="live-row">
            <div class="live-top">
              <span class="st live">{{ m.status || '进行中' }}</span>
            </div>
            <div class="live-players">
              <div class="live-player-line">
                <span class="live-name">{{ m.home || '—' }}</span>
                <span v-if="playerLiveScoreText(m, 'home')" class="live-player-score">{{ playerLiveScoreText(m, 'home') }}</span>
              </div>
              <span class="live-vs">VS</span>
              <div class="live-player-line">
                <span class="live-name">{{ m.away || '—' }}</span>
                <span v-if="playerLiveScoreText(m, 'away')" class="live-player-score">{{ playerLiveScoreText(m, 'away') }}</span>
              </div>
            </div>
            <div class="live-bot">
              <span>{{ (m.tournamentShort || m.tournament || '—').replace(/,.*/, '') }}</span>
              <span v-if="m.roundLabel"> · {{ m.roundLabel }}</span>
              <span> · {{ m.tour || '' }}</span>
            </div>
          </div>
          </div>
          <div class="pager pager-bottom">
            <span class="pager-info">{{ livePageLabel() }}</span>
            <div class="pager-actions">
              <button type="button" class="pager-btn" :disabled="livePage <= 1" @click="setLivePage(livePage - 1)">上一页</button>
              <button type="button" class="pager-btn" :disabled="livePage >= livePageCount" @click="setLivePage(livePage + 1)">下一页</button>
            </div>
          </div>
        </template>
      </div>

      <div v-else-if="tab !== 'logs'" class="panel">
        <div class="panel-h row">
          <span class="panel-title">{{ tab.toUpperCase() }} Top{{ topPoolMax }} · {{ top100Board?.date || '—' }}</span>
          <span class="muted panel-meta">
            <template v-if="top100Board?.loading">拉取中…<span v-if="top100LoadingSec"> · 已 {{ top100LoadingSec }}s</span></template>
            <template v-else>更新 {{ fmtTime(top100Board?.fetched_at) }}</template>
          </span>
        </div>

        <div v-if="top100Board?.error" class="banner err">{{ formatMonitorError(top100Board.error) }}</div>
        <div v-else-if="top100Board?.loading && !players.length" class="empty">
          正在拉取 Sofascore Top{{ topPoolMax }}…<span v-if="top100LoadingSec">（已 {{ top100LoadingSec }} 秒，通常 1～3 分钟）</span>
        </div>
        <div v-else-if="!players.length" class="empty">
          <template v-if="rawPoolPlayers.length && (onlyWithMatches || tierFilterActive())">
            暂无符合筛选的球员（池内 {{ rawPoolPlayers.length }} 人）
            <div class="hint">可取消「仅有赛事」或调整 500/1000/大满贯 筛选</div>
          </template>
          <template v-else>暂无 Top{{ topPoolMax }} 球员数据</template>
        </div>

        <template v-else>
          <div class="pager">
            <span class="pager-info">第 {{ playerPage }} / {{ playerPageCount }} 页 · {{ playerPageLabel() }} · 每页 {{ PLAYER_PAGE_SIZE }} 人</span>
            <div class="pager-actions">
              <button type="button" class="pager-btn" :disabled="playerPage <= 1" @click="setPlayerPage(playerPage - 1)">上一页</button>
              <button type="button" class="pager-btn" :disabled="playerPage >= playerPageCount" @click="setPlayerPage(playerPage + 1)">下一页</button>
            </div>
          </div>
          <div class="plist">
          <div v-for="p in pagedPlayers" :key="p.id" class="player">
            <button type="button" class="player-h" @click="toggle(p.id)">
              <span class="rank">#{{ p.rank }}</span>
              <span class="player-main">
                <span class="name">{{ p.name }}</span>
                <span class="meta">{{ p.country || '—' }} · {{ p.points ?? '—' }} pts</span>
              </span>
              <span class="mc" :class="{ hot: (p.matchCount || 0) > 0 }">{{ p.matchCount || 0 }} 场</span>
            </button>
            <div v-if="expanded[p.id]" class="matches">
              <div v-if="!(p.matches || []).length" class="empty tiny">今日无比赛</div>
              <a
                v-for="m in p.matches || []"
                :key="m.id"
                class="match"
                :href="sofaTennisMatchUrl(m)"
                target="_blank"
                rel="noopener noreferrer"
              >
                <div class="m-top">
                  <span class="st">{{ m.status || m.statusRaw || '—' }}</span>
                  <span>{{ m.startTime || '—' }}</span>
                </div>
                <div class="m-mid">
                  vs {{ m.opponent || '—' }}
                  <span v-if="m.opponentRank" class="rk">#{{ m.opponentRank }}</span>
                </div>
                <div class="m-bot">
                  <span>{{ m.tournament || '—' }}</span>
                  <span v-if="m.level" class="lv">{{ m.level }}</span>
                  <span>{{ m.round || '' }}</span>
                </div>
              </a>
            </div>
          </div>
          </div>
          <div class="pager pager-bottom">
            <span class="pager-info">{{ playerPageLabel() }}</span>
            <div class="pager-actions">
              <button type="button" class="pager-btn" :disabled="playerPage <= 1" @click="setPlayerPage(playerPage - 1)">上一页</button>
              <button type="button" class="pager-btn" :disabled="playerPage >= playerPageCount" @click="setPlayerPage(playerPage + 1)">下一页</button>
            </div>
          </div>
        </template>
      </div>

      <div v-else class="panel">
        <div class="panel-h row">
          <span>采集日志</span>
          <span class="muted truncate">{{ logs?.log_file || status?.latest_log || '—' }}</span>
        </div>
        <div class="pager">
          <span class="pager-info">第 {{ logPage }} / {{ logPageCount }} 页 · {{ logPageLabel() }}</span>
          <div class="pager-actions">
            <button type="button" class="pager-btn" :disabled="logPage <= 1" @click="setLogPage(logPage - 1)">上一页</button>
            <button type="button" class="pager-btn" :disabled="logPage >= logPageCount" @click="setLogPage(logPage + 1)">下一页</button>
          </div>
        </div>
        <pre class="log">{{ pagedLogText }}</pre>
        <div class="pager pager-bottom">
          <span class="pager-info">{{ logPageLabel() }}</span>
          <div class="pager-actions">
            <button type="button" class="pager-btn" :disabled="logPage <= 1" @click="setLogPage(logPage - 1)">上一页</button>
            <button type="button" class="pager-btn" :disabled="logPage >= logPageCount" @click="setLogPage(logPage + 1)">下一页</button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.sofa { display: flex; flex-direction: column; gap: 8px; }
.toolbar {
  display: flex; gap: 8px; align-items: center; justify-content: space-between; flex-wrap: wrap;
}
.titles .title { font-size: 0.98rem; font-weight: 700; color: #0f172a; line-height: 1.25; }
.titles .sub { margin-top: 1px; font-size: 0.72rem; color: #94a3b8; }
.actions-primary { display: flex; gap: 6px; flex-shrink: 0; align-items: center; flex-wrap: wrap; }
.settings-row {
  display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
  padding: 8px 10px; background: #fff; border: 1px solid #e2e8f0; border-radius: 12px;
}
.source-group {
  display: flex; align-items: center; gap: 4px;
  padding: 3px; border-radius: 10px; background: #f1f5f9; border: 1px solid #e2e8f0;
}
.source-label {
  padding: 0 6px; font-size: 0.72rem; font-weight: 700; color: #64748b; white-space: nowrap;
}
.source-opt {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 6px 10px; border-radius: 8px; font-size: 0.78rem; font-weight: 700;
  color: #64748b; cursor: pointer; user-select: none;
}
.source-opt input { accent-color: #4f46e5; }
.source-opt.on { background: #fff; color: #4f46e5; box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08); }
.source-opt.disabled { opacity: .45; cursor: not-allowed; }
.interval-select {
  display: flex; align-items: center; gap: 6px;
  font-size: 0.75rem; color: #64748b; font-weight: 600;
}
.interval-select select {
  border: 1px solid #cbd5e1; border-radius: 8px;
  padding: 7px 10px; font-size: 0.8rem; font-weight: 600;
  color: #334155; background: #fff; cursor: pointer;
}
.interval-select select:disabled { opacity: .55; cursor: not-allowed; }
.btn {
  border: 0; border-radius: 8px; padding: 7px 11px; font-size: 0.78rem; font-weight: 600;
  cursor: pointer; transition: .15s;
}
.btn:disabled { opacity: .55; cursor: not-allowed; }
.btn.ghost { background: #e2e8f0; color: #334155; }
.btn.primary { background: #4f46e5; color: #fff; }
.btn.primary:hover:not(:disabled) { background: #4338ca; }

.banner {
  border-radius: 10px; padding: 8px 10px; font-size: 0.78rem;
  background: #f1f5f9; color: #475569;
}
.banner.err { background: #fef2f2; color: #b91c1c; }
.banner.ok { background: #ecfdf5; color: #047857; }

.cards { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.cards-compact { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.card {
  background: #fafbfc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 8px 10px;
}
.cards-compact .card { padding: 8px 10px; }
.metrics-inner {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px;
}
.metric {
  padding: 8px 10px; border: 1px solid #e2e8f0; border-radius: 10px; background: #fafbfc;
}
.metric-label { font-size: 0.68rem; color: #94a3b8; font-weight: 700; }
.metric-value { margin-top: 2px; font-size: 0.92rem; font-weight: 800; color: #0f172a; }
.metric-hint { margin-top: 2px; font-size: 0.68rem; color: #64748b; line-height: 1.3; }
.card .label { font-size: 0.68rem; color: #94a3b8; }
.card .value { margin-top: 2px; font-size: 0.92rem; font-weight: 700; color: #0f172a; }
.card .value.sm { font-size: 0.86rem; }
.card .value.mono { font-size: 0.82rem; font-weight: 600; }
.card .hint { margin-top: 2px; font-size: 0.68rem; color: #64748b; line-height: 1.3; }

.pill {
  display: inline-block; padding: 2px 7px; border-radius: 999px; font-size: 0.74rem; font-weight: 700;
}
.pill.sm { font-size: 0.68rem; padding: 1px 6px; }
.pill.run { background: #fff7ed; color: #c2410c; }
.pill.ok { background: #ecfdf5; color: #047857; }
.pill.err { background: #fef2f2; color: #b91c1c; }
.pill.idle { background: #f1f5f9; color: #475569; }

.panel {
  background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 8px 10px;
}
.panel-fold { padding-top: 6px; padding-bottom: 6px; }
.stats-fold[open], .metrics-fold[open] { padding-bottom: 10px; }
.fold-summary {
  cursor: pointer; list-style: none; margin-bottom: 0;
  display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px;
  font-size: 0.78rem; font-weight: 700; color: #334155;
}
.stats-summary { padding: 2px 0; }
.fold-summary::-webkit-details-marker { display: none; }
.panel-fold[open] .fold-summary { margin-bottom: 8px; }
.fold-title { flex: 0 0 auto; color: #475569; }
.fold-inline { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; flex: 1 1 auto; min-width: 0; }
.fold-meta {
  flex: 1 1 auto; min-width: 0;
  font-size: 0.72rem; font-weight: 600; color: #64748b;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.fold-toggle { flex: 0 0 auto; font-size: 0.68rem; font-weight: 600; }
.panel-h { font-size: 0.82rem; font-weight: 700; color: #334155; margin-bottom: 8px; }
.panel-h.row {
  display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 10px;
  align-items: baseline;
}
.panel-title { flex: 1 1 auto; min-width: 0; word-break: break-word; }
.panel-meta { flex: 0 1 auto; min-width: 0; text-align: right; }
.muted { color: #94a3b8; font-weight: 500; font-size: 0.72rem; }
.truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }

.cron-list { display: flex; flex-direction: column; gap: 6px; }
.cron-list code {
  display: block; background: #0f172a; color: #e2e8f0; border-radius: 8px;
  padding: 8px 10px; font-size: 0.72rem; overflow-x: auto;
}

.tabs { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.tabs button {
  border: 0; background: #e2e8f0; color: #475569; border-radius: 999px;
  padding: 6px 12px; font-size: 0.78rem; font-weight: 600; cursor: pointer;
}
.tabs button.on { background: #4f46e5; color: #fff; }
.tabs .link { background: transparent; color: #4f46e5; padding-inline: 8px; }
.tabs .link:disabled { opacity: .45; cursor: not-allowed; }

.pool-bar {
  display: flex; gap: 6px; align-items: center; flex-wrap: wrap;
  padding: 0 2px;
}
.filter-bars { display: flex; flex-direction: column; gap: 6px; }
.pool-bar-tail { justify-content: space-between; }
.pool-label { font-size: 0.72rem; font-weight: 700; color: #94a3b8; margin-right: 2px; white-space: nowrap; }
.pool-meta { margin-left: auto; font-size: 0.72rem; color: #64748b; font-weight: 600; text-align: right; }
.match-only {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 0.76rem; font-weight: 600; color: #475569; cursor: pointer; user-select: none;
}
.match-only input { accent-color: #4f46e5; }
.chip-btn {
  border: 1px solid #cbd5e1; background: #fff; color: #64748b;
  border-radius: 999px; padding: 5px 11px; font-size: 0.76rem; font-weight: 600; cursor: pointer;
}
.chip-btn.active {
  color: #4f46e5; background: #eef2ff; border-color: #c7d2fe;
}

.plist { display: flex; flex-direction: column; gap: 6px; }
.pager {
  display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;
  padding: 6px 2px; margin-bottom: 8px;
}
.pager-bottom { margin-bottom: 0; margin-top: 8px; }
.pager-info { font-size: 0.72rem; color: #64748b; font-weight: 600; }
.pager-actions { display: flex; gap: 6px; }
.pager-btn {
  border: 1px solid #cbd5e1; background: #fff; color: #475569;
  border-radius: 8px; padding: 5px 10px; font-size: 0.76rem; font-weight: 600; cursor: pointer;
}
.pager-btn:disabled { opacity: .45; cursor: not-allowed; }
.pager-btn:not(:disabled):hover { border-color: #a5b4fc; color: #4f46e5; }
.player { border: 1px solid #e2e8f0; border-radius: 12px; background: #fafbfc; }
.player-h {
  width: 100%; display: flex; gap: 8px; align-items: flex-start;
  text-align: left; border: 0; background: transparent;
  padding: 10px; cursor: pointer;
}
.rank {
  flex: 0 0 34px; font-weight: 800; color: #4f46e5; font-size: 0.82rem; line-height: 1.35;
}
.player-main {
  flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px;
}
.name {
  font-weight: 700; color: #0f172a; font-size: 0.86rem; line-height: 1.35;
  word-break: break-word;
}
.meta {
  color: #94a3b8; font-size: 0.72rem; line-height: 1.35;
  word-break: break-word;
}
.mc {
  flex: 0 0 auto; align-self: flex-start; margin-top: 1px;
  font-size: 0.72rem; font-weight: 700; color: #64748b;
  background: #e2e8f0; border-radius: 999px; padding: 2px 8px; white-space: nowrap;
}
.mc.hot { background: #dbeafe; color: #1d4ed8; }

.matches { padding: 0 10px 10px; display: flex; flex-direction: column; gap: 6px; }
.match {
  display: block; text-decoration: none; color: inherit;
  background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 8px 10px;
}
.match:hover { border-color: #a5b4fc; }
.m-top, .m-bot {
  display: flex; justify-content: space-between; gap: 8px; font-size: 0.72rem; color: #64748b;
  flex-wrap: wrap;
}
.m-bot span:first-child { flex: 1 1 auto; min-width: 0; word-break: break-word; }
.lv {
  flex: 0 0 auto; font-size: 0.68rem; font-weight: 700; color: #6d28d9;
  background: #f5f3ff; border-radius: 999px; padding: 1px 6px;
}
.m-mid { margin: 4px 0; font-size: 0.84rem; font-weight: 600; color: #0f172a; word-break: break-word; }
.st { font-weight: 700; color: #b45309; }
.rk { margin-left: 6px; color: #94a3b8; font-weight: 500; font-size: 0.75rem; }

.live-list { display: flex; flex-direction: column; gap: 8px; }
.live-row {
  border: 1px solid #e2e8f0; border-radius: 12px; padding: 10px 12px; background: #fafbfc;
}
.live-top { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 6px; }
.live-top .st.live { color: #b91c1c; font-weight: 700; font-size: 0.75rem; }
.live-players { display: flex; flex-direction: column; gap: 4px; margin: 4px 0; }
.live-player-line { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.live-name { font-weight: 700; font-size: 0.88rem; color: #0f172a; min-width: 0; }
.live-player-score { flex: 0 0 auto; font-weight: 800; font-size: 0.82rem; color: #0f172a; font-variant-numeric: tabular-nums; letter-spacing: 0.04em; }
.live-vs { align-self: center; font-size: 0.68rem; font-weight: 700; color: #94a3b8; }
.live-bot { margin-top: 4px; font-size: 0.72rem; color: #64748b; }

.empty { text-align: center; color: #94a3b8; font-size: 0.82rem; padding: 18px 8px; }
.empty.tiny { padding: 8px; font-size: 0.75rem; }

.log {
  margin: 0; background: #0f172a; color: #e2e8f0; border-radius: 10px;
  padding: 12px; font-size: 0.72rem; line-height: 1.45; min-height: 240px;
  max-height: 42vh; overflow: auto; white-space: pre-wrap; word-break: break-word;
}

@media (max-width: 720px) {
  .cards-compact { grid-template-columns: 1fr 1fr; }
  .metrics-inner { grid-template-columns: 1fr; }
  .fold-meta { white-space: normal; }
  .settings-row, .actions-primary { width: 100%; }
}
</style>
