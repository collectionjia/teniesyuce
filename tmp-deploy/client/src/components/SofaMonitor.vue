<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
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
const expanded = ref({})
const schedule = ref(null)
const scheduleSaving = ref(false)
const dataSource = ref(null)
const dataSourceSaving = ref(false)

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
const summary = computed(() => ({
  ...(top100Board.value?.summary || {}),
  ...(top100Collect.value?.summary || {}),
  total_matches:
    top100Board.value?.summary?.total_matches
    ?? lastRun.value?.total_events
    ?? top100Collect.value?.summary?.total_matches,
}))
const players = computed(() => {
  const list = tab.value === 'wta' ? top100Board.value?.wta : top100Board.value?.atp
  const max = Number(topPoolMax.value) || 100
  return (Array.isArray(list) ? list : []).filter((p) => {
    const rank = Number(p.rank)
    return Number.isFinite(rank) && rank > 0 && rank <= max
  })
})
const poolSummary = computed(() => {
  const max = Number(topPoolMax.value) || 100
  let matches = 0
  for (const p of players.value) matches += Number(p.matchCount) || 0
  return { max, players: players.value.length, matches }
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
        await loadTop100(false)
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
        <div class="sub">Top100 赛程 · 进行中比分 · 网球页只读 Redis · 当前写入 {{ tennisDataSourceLabel }}</div>
      </div>
      <div class="actions">
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
        <button type="button" class="btn ghost" :disabled="refreshing" @click="refreshAll()">刷新</button>
        <button type="button" class="btn ghost" :disabled="liveCollecting || liveRunning" @click="triggerLiveCollect">
          {{ liveRunning ? '拉取中…' : liveCollecting ? '触发中…' : '拉取进行中' }}
        </button>
        <button type="button" class="btn primary" :disabled="collecting || running" @click="triggerCollect">
          {{ running ? 'Top100 采集中…' : collecting ? '触发中…' : '立即采集 Top100' }}
        </button>
      </div>
    </div>

    <div v-if="notice" class="banner ok">{{ notice }}</div>
    <div v-if="error" class="banner err">{{ error }}</div>
    <div v-if="loading" class="banner">加载中…</div>

    <template v-else>
      <div class="cards">
        <div class="card">
          <div class="label">状态</div>
          <div class="value"><span class="pill" :class="statusTone">{{ statusLabel }}</span></div>
          <div class="hint">{{ status?.time || '—' }}</div>
        </div>
        <div class="card">
          <div class="label">最近采集</div>
          <div class="value mono">{{ fmtTime(lastRun.finished_at || lastRun.started_at) }}</div>
          <div class="hint">
            退出码 {{ lastRun.exit_code ?? '—' }}
            <span v-if="lastRun.error"> · {{ formatMonitorError(lastRun.error) }}</span>
          </div>
        </div>
        <div class="card">
          <div class="label">最新 Bundle</div>
          <div class="value">{{ bundle.date || '—' }}</div>
          <div class="hint">{{ bundle.event_count ?? 0 }} 场 · {{ bundle.tournament_count ?? 0 }} 站</div>
        </div>
        <div class="card">
          <div class="label">进行中采集</div>
          <div class="value">{{ livePoll.live_count ?? liveMatches.length }}</div>
          <div class="hint">
            {{ liveRunning ? '拉取中…' : `更新 ${fmtTime(livePoll.finished_at || livePoll.fetched_at)}` }}
            <span v-if="livePoll.updated != null"> · 写入 {{ livePoll.updated }}</span>
          </div>
        </div>
        <div class="card">
          <div class="label">网球 Redis</div>
          <div class="value">{{ redisUpstreamLabel }}</div>
          <div class="hint">页面读 Redis · 写入 {{ tennisDataSourceLabel }}<span v-if="dataSource?.redis_fetched_at"> · {{ fmtTime(dataSource.redis_fetched_at) }}</span></div>
        </div>
        <div class="card">
          <div class="label">Top100 赛事</div>
          <div class="value">{{ summary.total_matches ?? '—' }}</div>
          <div class="hint">ATP {{ summary.atp_matches ?? 0 }} · WTA {{ summary.wta_matches ?? 0 }} · 榜 {{ summary.atp_players ?? 0 }}/{{ summary.wta_players ?? 0 }}</div>
        </div>
      </div>

      <div v-if="cronLines.length || schedule" class="panel">
        <div class="panel-h row">
          <span>定时任务</span>
          <span class="muted panel-meta">当前 {{ collectIntervalLabel }}</span>
        </div>
        <div class="cron-list">
          <code v-for="(line, i) in cronLines" :key="i">{{ line }}</code>
          <code v-if="!cronLines.length && schedule?.cron_line">{{ schedule.cron_line }}</code>
        </div>
      </div>

      <div class="tabs">
        <button type="button" :class="{ on: tab === 'atp' }" @click="tab = 'atp'">ATP</button>
        <button type="button" :class="{ on: tab === 'wta' }" @click="tab = 'wta'">WTA</button>
        <button type="button" :class="{ on: tab === 'live' }" @click="tab = 'live'">进行中</button>
        <button type="button" :class="{ on: tab === 'logs' }" @click="tab = 'logs'">日志</button>
        <button type="button" class="link" :disabled="busy || running" @click="refreshTop100">重拉 Top100</button>
      </div>

      <div v-if="tab === 'atp' || tab === 'wta'" class="pool-bar">
        <span class="pool-label">排名池</span>
        <button type="button" class="chip-btn" :class="{ active: topPoolMax === '20' }" @click="topPoolMax = '20'">Top20</button>
        <button type="button" class="chip-btn" :class="{ active: topPoolMax === '50' }" @click="topPoolMax = '50'">Top50</button>
        <button type="button" class="chip-btn" :class="{ active: topPoolMax === '100' }" @click="topPoolMax = '100'">Top100</button>
        <span class="pool-meta">{{ tab.toUpperCase() }} · {{ poolSummary.players }} 人 · {{ poolSummary.matches }} 场</span>
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
        <div v-else class="live-list">
          <div v-for="m in liveMatches" :key="m.id" class="live-row">
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
        <div v-else-if="!players.length" class="empty">暂无 Top{{ topPoolMax }} 球员数据</div>

        <div v-else class="plist">
          <div v-for="p in players" :key="p.id" class="player">
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
                  <span>{{ m.round || '' }}</span>
                </div>
              </a>
            </div>
          </div>
        </div>
      </div>

      <div v-else class="panel">
        <div class="panel-h row">
          <span>采集日志</span>
          <span class="muted truncate">{{ logs?.log_file || status?.latest_log || '—' }}</span>
        </div>
        <pre class="log">{{ logs?.content || status?.latest_log_tail || '(暂无日志)' }}</pre>
      </div>
    </template>
  </div>
</template>

<style scoped>
.sofa { display: flex; flex-direction: column; gap: 12px; }
.toolbar { display: flex; gap: 10px; align-items: flex-start; justify-content: space-between; }
.titles .title { font-size: 1.05rem; font-weight: 700; color: #0f172a; }
.titles .sub { margin-top: 2px; font-size: 0.75rem; color: #94a3b8; }
.actions { display: flex; gap: 8px; flex-shrink: 0; align-items: center; flex-wrap: wrap; }
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
  border: 0; border-radius: 10px; padding: 8px 12px; font-size: 0.8rem; font-weight: 600;
  cursor: pointer; transition: .15s;
}
.btn:disabled { opacity: .55; cursor: not-allowed; }
.btn.ghost { background: #e2e8f0; color: #334155; }
.btn.primary { background: #4f46e5; color: #fff; }
.btn.primary:hover:not(:disabled) { background: #4338ca; }

.banner {
  border-radius: 12px; padding: 10px 12px; font-size: 0.82rem;
  background: #f1f5f9; color: #475569;
}
.banner.err { background: #fef2f2; color: #b91c1c; }
.banner.ok { background: #ecfdf5; color: #047857; }

.cards { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.card {
  background: #fff; border: 1px solid #e2e8f0; border-radius: 14px; padding: 12px;
}
.card .label { font-size: 0.72rem; color: #94a3b8; }
.card .value { margin-top: 4px; font-size: 1rem; font-weight: 700; color: #0f172a; }
.card .value.mono { font-size: 0.86rem; font-weight: 600; }
.card .hint { margin-top: 4px; font-size: 0.72rem; color: #64748b; line-height: 1.35; }

.pill {
  display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 0.78rem; font-weight: 700;
}
.pill.run { background: #fff7ed; color: #c2410c; }
.pill.ok { background: #ecfdf5; color: #047857; }
.pill.err { background: #fef2f2; color: #b91c1c; }
.pill.idle { background: #f1f5f9; color: #475569; }

.panel {
  background: #fff; border: 1px solid #e2e8f0; border-radius: 14px; padding: 12px;
}
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
.pool-label { font-size: 0.72rem; font-weight: 700; color: #94a3b8; margin-right: 2px; }
.pool-meta { margin-left: auto; font-size: 0.72rem; color: #64748b; font-weight: 600; }
.chip-btn {
  border: 1px solid #cbd5e1; background: #fff; color: #64748b;
  border-radius: 999px; padding: 5px 11px; font-size: 0.76rem; font-weight: 600; cursor: pointer;
}
.chip-btn.active {
  color: #4f46e5; background: #eef2ff; border-color: #c7d2fe;
}

.plist { display: flex; flex-direction: column; gap: 6px; max-height: 52vh; overflow: auto; }
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
  padding: 12px; font-size: 0.72rem; line-height: 1.45; max-height: 48vh;
  overflow: auto; white-space: pre-wrap; word-break: break-word;
}
</style>
