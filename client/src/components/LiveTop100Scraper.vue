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
const top100 = ref(null)
const liveData = ref(null)
const logs = ref(null)
const tab = ref('atp')
const hideEmptyPlayers = ref(true)

const expanded = ref({})

let pollTimer = null
let top100Timer = null
let liveTimer = null
let noticeTimer = null

const top100LoadingSince = ref(0)
const top100LoadingSec = ref(0)
let top100LoadingTick = null

const top100Running = computed(() => !!status.value?.top100_collect?.running || !!top100.value?.loading)
const lastTop100 = computed(() => status.value?.top100_collect?.last || {})
const livePoll = computed(() => status.value?.live_poll?.last || liveData.value?.last || {})
const liveRunning = computed(() => !!(status.value?.live_poll?.running || liveData.value?.running))
const liveMatches = computed(() => {
  const list = livePoll.value?.events || []
  return Array.isArray(list) ? list : []
})
const liveIntervalSec = computed(() => Number(status.value?.live_poll?.interval_sec || 120))
const liveIntervalLabel = computed(() => {
  const sec = liveIntervalSec.value
  if (sec >= 60 && sec % 60 === 0) return `${sec / 60} 分钟`
  return `${sec} 秒`
})
const summary = computed(() => top100.value?.summary || status.value?.top100_collect?.summary || {})
const players = computed(() => {
  const list = tab.value === 'wta' ? top100.value?.wta : top100.value?.atp
  return Array.isArray(list) ? list : []
})

function playerMatchCount(p) {
  const n = Number(p?.matchCount)
  if (Number.isFinite(n) && n >= 0) return n
  return Array.isArray(p?.matches) ? p.matches.length : 0
}

const playersWithMatches = computed(() => players.value.filter((p) => playerMatchCount(p) > 0))

const visiblePlayers = computed(() => (
  hideEmptyPlayers.value ? playersWithMatches.value : players.value
))

const statusLabel = computed(() => {
  if (top100Running.value) return '拉取中'
  const s = lastTop100.value.status
  if (s === 'success') return '最近成功'
  if (s === 'failed') return '最近失败'
  if (s === 'running') return '拉取中'
  return '空闲'
})

const statusTone = computed(() => {
  if (top100Running.value || lastTop100.value.status === 'running') return 'run'
  if (lastTop100.value.status === 'success') return 'ok'
  if (lastTop100.value.status === 'failed') return 'err'
  return 'idle'
})

const busy = computed(() => (
  top100Running.value
  || collecting.value
  || liveCollecting.value
  || liveRunning.value
))

const proxyInfo = computed(() => status.value?.proxy || {})
const proxyLabel = computed(() => {
  if (!proxyInfo.value.enabled) return '直连（未配置代理）'
  if (proxyInfo.value.mode === 'ipwo') {
    const zone = proxyInfo.value.zone ? ` · ${proxyInfo.value.zone}` : ''
    return `IPWO 代理 · ${proxyInfo.value.host || '—'}${zone}`
  }
  return `代理 · ${proxyInfo.value.host || '—'}`
})

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
    if (!top100.value?.loading) {
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
  status.value = await api.fetchTennisLiveScraperStatus()
}

async function loadTop100(force = false) {
  const data = await api.fetchTennisLiveScraperTop100(force)
  top100.value = data
  if (data?.error && !data?.loading) {
    error.value = formatMonitorError(data.error)
  }
  if (data?.loading) {
    startTop100LoadingClock()
    if (!top100Timer) {
      top100Timer = setInterval(async () => {
        try {
          const next = await api.fetchTennisLiveScraperTop100(false)
          top100.value = next
          await loadStatus()
          if (!next?.loading) {
            clearInterval(top100Timer)
            top100Timer = null
            stopTop100LoadingClock()
            if (next?.error) {
              error.value = formatMonitorError(next.error)
            } else if (next?.ok) {
              error.value = ''
              const n = next.summary?.total_matches ?? '—'
              showNotice(`Top100 拉取完成：${next.date || '—'} · ${n} 场比赛`)
            }
          }
        } catch {
          /* keep polling */
        }
      }, 3000)
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
  liveData.value = await api.fetchTennisLiveScraperLive()
}

async function loadLogs() {
  logs.value = await api.fetchTennisLiveScraperLogs(150)
}

async function refreshAll({ silent = false } = {}) {
  if (!silent) {
    refreshing.value = true
    error.value = ''
    notice.value = ''
  }
  try {
    await Promise.all([loadStatus(), loadTop100(false), loadLive(), loadLogs()])
  } catch (e) {
    error.value = formatMonitorError(e?.response?.data?.error || e?.message || '加载失败')
  } finally {
    loading.value = false
    refreshing.value = false
  }
}

async function waitTop100Done() {
  const deadline = Date.now() + 10 * 60 * 1000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000))
    await loadStatus()
    await loadTop100(false)
    await loadLogs()
    if (!top100Running.value) {
      const err = lastTop100.value?.error || top100.value?.error
      if (lastTop100.value?.status === 'failed' && err) {
        notice.value = ''
        error.value = formatMonitorError(err)
      } else if (lastTop100.value?.status === 'success' || top100.value?.ok) {
        error.value = ''
        const n = summary.value?.total_matches ?? '—'
        showNotice(`Top100 拉取完成：${top100.value?.date || '—'} · ${n} 场比赛`)
      }
      return
    }
  }
  notice.value = ''
  error.value = 'Top100 拉取仍在进行，请稍后在日志中查看结果'
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
      }
      return
    }
  }
  notice.value = ''
  error.value = '拉取进行中比分超时，请稍后再试'
}

async function triggerCollect() {
  if (collecting.value || top100Running.value) return
  collecting.value = true
  error.value = ''
  notice.value = ''
  try {
    const data = await api.triggerTennisLiveScraperTop100Collect()
    if (data?.atp?.length || data?.wta?.length) {
      top100.value = { ...data, loading: false, ok: true }
      error.value = ''
      const n = data.summary?.total_matches ?? '—'
      showNotice(`Top100 拉取完成：${data.date || '—'} · ${n} 场比赛`)
      return
    }
    top100.value = { ...(top100.value || {}), loading: true }
    startTop100LoadingClock()
    await loadStatus()
    await loadLogs()
    if (top100Running.value) await waitTop100Done()
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
    await api.triggerTennisLiveScraperLiveCollect()
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

function rankText(v) {
  return v != null && v !== '' ? v : '—'
}

function sideRank(m, side) {
  if (side === 'home') return m?.homeRank ?? m?.homePlayer?.rank
  return m?.awayRank ?? m?.awayPlayer?.rank
}

function matchUrl(m) {
  return sofaTennisMatchUrl(m)
}

async function refreshTop100() {
  if (top100Running.value) {
    error.value = 'Top100 拉取进行中，请稍后再试'
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
    if (top100Running.value) loadLogs().catch(() => {})
  }, 5000)
  liveTimer = setInterval(() => {
    loadLive().catch(() => {})
  }, Math.max(30000, liveIntervalSec.value * 1000))
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
  <div class="scraper">
    <div class="toolbar">
      <div class="titles">
        <div class="title">盘中 Top100 采集</div>
        <div class="sub">Top100 运动员赛事 · {{ proxyLabel }} · 进行中每 {{ liveIntervalLabel }} 自动刷新</div>
      </div>
      <div class="actions">
        <button type="button" class="btn ghost" :disabled="refreshing" @click="refreshAll()">刷新</button>
        <button type="button" class="btn ghost" :disabled="liveCollecting || liveRunning" @click="triggerLiveCollect">
          {{ liveRunning ? '拉取中…' : liveCollecting ? '触发中…' : '拉取进行中' }}
        </button>
        <button type="button" class="btn primary" :disabled="collecting || top100Running" @click="triggerCollect">
          {{ top100Running ? '拉取中…' : collecting ? '触发中…' : '立即拉取' }}
        </button>
      </div>
    </div>

    <div v-if="notice" class="banner ok">{{ notice }}</div>
    <div v-if="error" class="banner err">{{ error }}</div>
    <div v-if="loading" class="banner">加载中…</div>

    <template v-else>
      <div class="cards">
        <div class="card">
          <div class="label">Top100 状态</div>
          <div class="value"><span class="pill" :class="statusTone">{{ statusLabel }}</span></div>
          <div class="hint">{{ fmtTime(lastTop100.finished_at || lastTop100.started_at) }}</div>
        </div>
        <div class="card">
          <div class="label">最新赛程</div>
          <div class="value">{{ top100?.date || '—' }}</div>
          <div class="hint">更新 {{ fmtTime(top100?.fetched_at || status?.top100_collect?.cached_at) }}</div>
        </div>
        <div class="card">
          <div class="label">Top100 今日</div>
          <div class="value">{{ summary.total_matches ?? '—' }}</div>
          <div class="hint">ATP {{ summary.atp_matches ?? 0 }} · WTA {{ summary.wta_matches ?? 0 }}</div>
        </div>
        <div class="card">
          <div class="label">进行中采集</div>
          <div class="value">{{ livePoll.live_count ?? liveMatches.length }}</div>
          <div class="hint">
            {{ liveRunning ? '拉取中…' : `每 ${liveIntervalLabel} 自动 · ${fmtTime(livePoll.finished_at || livePoll.fetched_at)}` }}
          </div>
        </div>
        <div class="card">
          <div class="label">运动员</div>
          <div class="value">{{ (summary.atp_players ?? 0) + (summary.wta_players ?? 0) || '—' }}</div>
          <div class="hint">ATP {{ summary.atp_players ?? 0 }} · WTA {{ summary.wta_players ?? 0 }}</div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-h row">
          <span>说明</span>
          <span class="muted panel-meta">盘中产品数据源</span>
        </div>
        <div class="hint-block">
          与 Sofascore 监控相同，经监控服务（9004）的 <strong>curl_cffi + IPWO 住宅代理</strong> 访问 Sofascore API。
          「立即拉取」异步采集 ATP/WTA Top100 排名与当日赛程，并写入 Redis 盘中 bundle。
          进行中比分每 {{ liveIntervalLabel }} 轮询；也可手动点「拉取进行中」。
          <span v-if="!proxyInfo.enabled" class="warn">当前监控未检测到代理配置，拉取可能失败或被拒。</span>
        </div>
      </div>

      <div class="tabs">
        <button type="button" :class="{ on: tab === 'atp' }" @click="tab = 'atp'">ATP Top100</button>
        <button type="button" :class="{ on: tab === 'wta' }" @click="tab = 'wta'">WTA Top100</button>
        <button type="button" :class="{ on: tab === 'live' }" @click="tab = 'live'">进行中</button>
        <button type="button" :class="{ on: tab === 'logs' }" @click="tab = 'logs'">日志</button>
        <button type="button" class="link" :disabled="busy" @click="refreshTop100">重拉榜</button>
        <button
          v-if="tab === 'atp' || tab === 'wta'"
          type="button"
          class="link"
          :class="{ on: hideEmptyPlayers }"
          @click="hideEmptyPlayers = !hideEmptyPlayers"
        >
          {{ hideEmptyPlayers ? '显示全部' : '隐藏无赛' }}
        </button>
      </div>

      <div v-if="tab === 'live'" class="panel">
        <div class="panel-h row">
          <span class="panel-title">进行中 · {{ livePoll.date || top100?.date || '—' }}</span>
          <span class="muted panel-meta">
            <template v-if="liveRunning">拉取中…</template>
            <template v-else>每 {{ liveIntervalLabel }} 自动刷新 · {{ fmtTime(livePoll.finished_at || livePoll.fetched_at) }}</template>
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
                <span class="live-name">
                  <span class="rk">#{{ rankText(sideRank(m, 'home')) }}</span>
                  {{ m.home || '—' }}
                </span>
                <span v-if="playerLiveScoreText(m, 'home')" class="live-player-score">{{ playerLiveScoreText(m, 'home') }}</span>
              </div>
              <span class="live-vs">VS</span>
              <div class="live-player-line">
                <span class="live-name">
                  <span class="rk">#{{ rankText(sideRank(m, 'away')) }}</span>
                  {{ m.away || '—' }}
                </span>
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
          <span class="panel-title">{{ tab.toUpperCase() }} · {{ top100?.date || '—' }}</span>
          <span class="muted panel-meta">
            <template v-if="top100?.loading">拉取中…<span v-if="top100LoadingSec"> · 已 {{ top100LoadingSec }}s</span></template>
            <template v-else>
              更新 {{ fmtTime(top100?.fetched_at) }}
              <span v-if="players.length"> · 显示 {{ visiblePlayers.length }}/{{ players.length }}</span>
            </template>
          </span>
        </div>

        <div v-if="top100?.error" class="banner err">{{ formatMonitorError(top100.error) }}</div>
        <div v-else-if="top100?.loading && !players.length" class="empty">
          正在拉取 Sofascore Top100…<span v-if="top100LoadingSec">（已 {{ top100LoadingSec }} 秒，通常 1～3 分钟）</span>
        </div>
        <div v-else-if="!players.length" class="empty">暂无球员数据，请点击「立即拉取」</div>
        <div v-else-if="hideEmptyPlayers && !visiblePlayers.length" class="empty">
          当前榜单无人有今日赛程，可点「显示全部」查看完整 Top100
        </div>

        <div v-else class="plist">
          <div v-for="p in visiblePlayers" :key="p.id" class="player">
            <button type="button" class="player-h" @click="toggle(p.id)">
              <span class="rank">#{{ p.rank }}</span>
              <span class="player-main">
                <span class="name">{{ p.name }}</span>
                <span class="meta">{{ p.country || '—' }} · {{ p.points ?? '—' }} pts</span>
              </span>
              <span class="mc" :class="{ hot: playerMatchCount(p) > 0 }">{{ playerMatchCount(p) }} 场</span>
            </button>
            <div v-if="expanded[p.id]" class="matches">
              <div v-if="!(p.matches || []).length" class="empty tiny">今日无比赛</div>
              <a
                v-for="m in p.matches || []"
                :key="m.id"
                class="match"
                :href="matchUrl(m)"
                target="_blank"
                rel="noopener noreferrer"
              >
                <div class="m-top">
                  <span class="st">{{ m.status || m.statusRaw || '—' }}</span>
                  <span>{{ m.startTime || '—' }}</span>
                </div>
                <div class="m-mid match-up">
                  <span class="side">
                    <span class="rk">#{{ rankText(m.playerRank ?? p.rank) }}</span>
                    {{ p.name }}
                  </span>
                  <span class="vs-inline">vs</span>
                  <span class="side">
                    <span class="rk">#{{ rankText(m.opponentRank) }}</span>
                    {{ m.opponent || '—' }}
                  </span>
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
.scraper { display: flex; flex-direction: column; gap: 12px; }
.toolbar { display: flex; gap: 10px; align-items: flex-start; justify-content: space-between; }
.titles .title { font-size: 1.05rem; font-weight: 700; color: #0f172a; }
.titles .sub { margin-top: 2px; font-size: 0.75rem; color: #94a3b8; }
.actions { display: flex; gap: 8px; flex-shrink: 0; align-items: center; flex-wrap: wrap; }
.btn {
  border: 0; border-radius: 10px; padding: 8px 12px; font-size: 0.8rem; font-weight: 600;
  cursor: pointer; transition: .15s;
}
.btn:disabled { opacity: .55; cursor: not-allowed; }
.btn.ghost { background: #e2e8f0; color: #334155; }
.btn.primary { background: #7c3aed; color: #fff; }
.btn.primary:hover:not(:disabled) { background: #6d28d9; }

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
.hint-block { font-size: 0.78rem; color: #64748b; line-height: 1.45; }
.hint-block .warn { display: block; margin-top: 6px; color: #b45309; font-weight: 600; }

.tabs { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.tabs button {
  border: 0; background: #e2e8f0; color: #475569; border-radius: 999px;
  padding: 6px 12px; font-size: 0.78rem; font-weight: 600; cursor: pointer;
}
.tabs button.on { background: #7c3aed; color: #fff; }
.tabs .link { background: transparent; color: #7c3aed; padding-inline: 8px; }
.tabs .link.on { color: #5b21b6; font-weight: 800; text-decoration: underline; text-underline-offset: 3px; }
.tabs .link:disabled { opacity: .45; cursor: not-allowed; }

.plist { display: flex; flex-direction: column; gap: 6px; max-height: 52vh; overflow: auto; }
.player { border: 1px solid #e2e8f0; border-radius: 12px; background: #fafbfc; }
.player-h {
  width: 100%; display: flex; gap: 8px; align-items: flex-start;
  text-align: left; border: 0; background: transparent;
  padding: 10px; cursor: pointer;
}
.rank {
  flex: 0 0 34px; font-weight: 800; color: #7c3aed; font-size: 0.82rem; line-height: 1.35;
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
  flex: 0 0 auto; font-size: 0.72rem; font-weight: 700; color: #94a3b8; padding-top: 2px;
}
.mc.hot { color: #7c3aed; }

.matches { padding: 0 10px 10px; display: flex; flex-direction: column; gap: 6px; }
.match {
  display: block; border: 1px solid #e2e8f0; border-radius: 10px; padding: 8px 10px;
  text-decoration: none; color: inherit; background: #fff;
}
.match:hover { border-color: #c4b5fd; }
.m-top, .m-bot { display: flex; justify-content: space-between; gap: 8px; font-size: 0.72rem; color: #64748b; }
.m-mid { margin: 4px 0; font-size: 0.82rem; font-weight: 600; color: #0f172a; }
.match-up { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.match-up .side { display: inline-flex; align-items: baseline; gap: 4px; }
.match-up .vs-inline { color: #94a3b8; font-size: 0.72rem; font-weight: 700; }
.rk { color: #7c3aed; font-weight: 700; margin-right: 2px; }
.st { font-weight: 700; }
.st.live { color: #ea580c; }

.empty { padding: 24px 12px; text-align: center; color: #94a3b8; font-size: 0.82rem; }
.empty.tiny { padding: 8px; font-size: 0.75rem; }

.live-list { display: flex; flex-direction: column; gap: 8px; max-height: 52vh; overflow: auto; }
.live-row { border: 1px solid #e2e8f0; border-radius: 12px; padding: 10px; background: #fafbfc; }
.live-top { margin-bottom: 6px; }
.live-players { display: flex; flex-direction: column; gap: 4px; }
.live-player-line { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
.live-name { font-weight: 700; color: #0f172a; font-size: 0.86rem; word-break: break-word; }
.live-player-score { font-weight: 800; color: #7c3aed; font-size: 0.82rem; white-space: nowrap; }
.live-vs { font-size: 0.68rem; color: #94a3b8; font-weight: 700; align-self: center; }
.live-bot { margin-top: 6px; font-size: 0.72rem; color: #64748b; }

.log {
  background: #0f172a; color: #e2e8f0; border-radius: 8px; padding: 10px;
  font-size: 0.72rem; max-height: 52vh; overflow: auto; white-space: pre-wrap; word-break: break-word;
}
</style>
