<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

const props = defineProps({
  isMember: { type: Boolean, default: false },
})

const API = '/api/dota'
const PAGE_SIZE = 5
const data = ref(null)
const loading = ref(true)
const error = ref('')
const tab = ref('rankings') // rankings | matches | predict
const limit = ref('100')
const filtersOpen = ref(false)
const currentPage = ref(1)
const detailTeam = ref(null)
const detailLoading = ref(false)
const detailData = ref(null)
const detailMatch = ref(null)
const matchPredict = ref(null)
const matchPredictLoading = ref(false)
const predictA = ref(null)
const predictB = ref(null)
const predictQueryA = ref('')
const predictQueryB = ref('')
const suggestA = ref([])
const suggestB = ref([])
const predictResult = ref(null)
const predictLoading = ref(false)
const predictError = ref('')
let timer = null
let suggestTimerA = null
let suggestTimerB = null

const member = computed(() => !!props.isMember || data.value?.member === true)

watch(
  () => props.isMember,
  (ok) => {
    if (!ok) {
      tab.value = 'rankings'
      detailTeam.value = null
      detailData.value = null
      detailMatch.value = null
      matchPredict.value = null
      predictResult.value = null
    }
    load()
  },
  { immediate: true },
)

watch([tab, limit], () => {
  currentPage.value = 1
  if (tab.value !== 'predict') load()
})

const rankings = computed(() => data.value?.rankings || [])
const matches = computed(() => data.value?.matches || [])

const listItems = computed(() => (tab.value === 'matches' ? matches.value : rankings.value))
const totalPages = computed(() => Math.max(1, Math.ceil(listItems.value.length / PAGE_SIZE)))
const paginatedItems = computed(() => {
  const start = (currentPage.value - 1) * PAGE_SIZE
  return listItems.value.slice(start, start + PAGE_SIZE)
})

watch(totalPages, (pages) => {
  if (currentPage.value > pages) currentPage.value = pages
})

const boardDate = computed(() => {
  const now = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
})

const stats = computed(() => ({
  date: boardDate.value,
  teams: rankings.value.length,
  matches: matches.value.length,
  shown: listItems.value.length,
  total: tab.value === 'matches' ? matches.value.length : rankings.value.length,
  highConf: member.value
    ? rankings.value.filter((t) => (t.win_rate || 0) >= 0.6 && (t.matches_played || 0) >= 10).length
    : 0,
}))

const filterSummary = computed(() => {
  const parts = []
  if (tab.value === 'rankings') parts.push('排行榜')
  else if (tab.value === 'matches') parts.push('最近比赛')
  else parts.push('胜率分析')
  if (tab.value === 'rankings') parts.push(`Top ${limit.value}`)
  else if (tab.value === 'matches') parts.push(`${matches.value.length} 场`)
  return parts.join(' · ')
})

function goPage(page) {
  currentPage.value = Math.min(Math.max(1, page), totalPages.value)
}

function fmtPct(v) {
  if (v == null || Number.isNaN(Number(v))) return '—'
  return `${(Number(v) * 100).toFixed(1)}%`
}

function fmtTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

function fmtDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('zh-CN')
}

async function load() {
  error.value = ''
  loading.value = true
  try {
    const token = localStorage.getItem('token') || ''
    const res = await fetch(`${API}/overview?limit=${limit.value}&matchLimit=30`, {
      cache: 'no-store',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const payload = await res.json()
    if (!props.isMember && payload && !payload.member) {
      data.value = {
        ...payload,
        member: false,
        message: payload.message || '非会员预览（仅战队名单与比分）',
      }
    } else {
      data.value = payload
      if (payload?.member && Array.isArray(payload.matches)) {
        enrichMatchesPolymarket(payload.matches)
      }
    }
  } catch (e) {
    error.value = e?.message || '加载失败'
  } finally {
    loading.value = false
  }
}

async function openTeam(team) {
  if (!member.value || !team?.id) return
  detailTeam.value = team
  detailData.value = null
  detailLoading.value = true
  try {
    const token = localStorage.getItem('token') || ''
    const res = await fetch(`${API}/teams/${team.id}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    detailData.value = await res.json()
  } catch (e) {
    detailData.value = { error: e?.message || '加载失败' }
  } finally {
    detailLoading.value = false
  }
}

function closeTeam() {
  detailTeam.value = null
  detailData.value = null
}

function winnerSide(m) {
  if (m?.radiant_win == null) return null
  return m.radiant_win ? 'radiant' : 'dire'
}

function matchStatusText(m) {
  if (m?.radiant_win != null) return '已结束'
  return '进行中'
}

function predictProbA(result) {
  return result?.upset_adjusted_prob ?? result?.p_a_win ?? 0.5
}

function polyUrlOf(m) {
  return m?.polymarket?.url || ''
}

function openMarket(m) {
  if (!member.value) return
  const url = polyUrlOf(m)
  if (!url) return
  window.open(url, '_blank', 'noopener,noreferrer')
}

function normalizeTeam(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .replace(/\b(team|esports|e sports|gaming|club|org|organisation|organization)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function namesMatch(a, b) {
  const na = normalizeTeam(a)
  const nb = normalizeTeam(b)
  if (!na || !nb) return false
  if (na === nb) return true
  if (na.length >= 4 && nb.length >= 4 && (na.includes(nb) || nb.includes(na))) return true
  return false
}

function parsePolySides(ev) {
  const title = String(ev?.title || '')
  const m = title.match(/dota\s*2?\s*:\s*(.+?)\s+vs\.?\s+(.+?)(?:\s*\(|\s+-|$)/i)
  if (m) return [m[1].trim(), m[2].trim()]
  try {
    const outs = JSON.parse(ev?.markets?.[0]?.outcomes || '[]')
    if (Array.isArray(outs) && outs.length >= 2) return [String(outs[0]), String(outs[1])]
  } catch { /* ignore */ }
  return [null, null]
}

/** 浏览器侧兜底：服务端打不开 Polymarket 时，用本机网络再匹配一次 */
async function enrichMatchesPolymarket(matches) {
  if (!member.value || !Array.isArray(matches) || !matches.length) return
  if (matches.some((m) => m.polymarket?.url)) return
  try {
    const res = await fetch(
      'https://gamma-api.polymarket.com/events?tag_slug=dota-2&active=true&closed=false&limit=100',
      { cache: 'no-store' },
    )
    if (!res.ok) return
    const events = await res.json()
    const catalog = (events || []).map((ev) => {
      const [sideA, sideB] = parsePolySides(ev)
      return {
        sideA,
        sideB,
        title: ev.title || '',
        url: ev.slug ? `https://polymarket.com/event/${ev.slug}` : '',
        slug: ev.slug,
      }
    }).filter((e) => e.url && e.sideA && e.sideB)

    let changed = false
    const next = matches.map((m) => {
      if (m.polymarket?.url) return m
      const hit = catalog.find((ev) =>
        (namesMatch(m.radiant_name, ev.sideA) && namesMatch(m.dire_name, ev.sideB)) ||
        (namesMatch(m.radiant_name, ev.sideB) && namesMatch(m.dire_name, ev.sideA)),
      )
      if (!hit) return m
      changed = true
      return { ...m, polymarket: { title: hit.title, url: hit.url, slug: hit.slug } }
    })
    if (changed && data.value) {
      data.value = { ...data.value, matches: next }
    }
  } catch {
    /* 本机网络不可达时忽略 */
  }
}

async function openMatchDetail(m) {
  if (!member.value || !m) return
  detailMatch.value = m
  matchPredict.value = null
  matchPredictLoading.value = true
  try {
    const token = localStorage.getItem('token') || ''
    const res = await fetch(
      `${API}/predict?a=${encodeURIComponent(m.radiant_team_id)}&b=${encodeURIComponent(m.dire_team_id)}`,
      { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    )
    if (res.ok) matchPredict.value = await res.json()
  } catch {
    /* ignore */
  } finally {
    matchPredictLoading.value = false
  }
}

function closeMatchDetail() {
  detailMatch.value = null
  matchPredict.value = null
}

function addTeamToPredict() {
  const team = detailData.value?.team
  if (!team?.id) return
  tab.value = 'predict'
  predictA.value = { id: team.id, name: team.name }
  predictQueryA.value = team.name
  closeTeam()
}

async function searchTeams(side, q) {
  if (!member.value || !q.trim()) {
    if (side === 'a') suggestA.value = []
    else suggestB.value = []
    return
  }
  try {
    const token = localStorage.getItem('token') || ''
    const res = await fetch(`${API}/teams?q=${encodeURIComponent(q.trim())}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (!res.ok) return
    const list = await res.json()
    if (side === 'a') suggestA.value = (list || []).slice(0, 8)
    else suggestB.value = (list || []).slice(0, 8)
  } catch {
    /* ignore */
  }
}

function onPredictInput(side, value) {
  if (side === 'a') {
    predictQueryA.value = value
    predictA.value = null
    clearTimeout(suggestTimerA)
    suggestTimerA = setTimeout(() => searchTeams('a', value), 220)
  } else {
    predictQueryB.value = value
    predictB.value = null
    clearTimeout(suggestTimerB)
    suggestTimerB = setTimeout(() => searchTeams('b', value), 220)
  }
}

function pickSuggest(side, team) {
  if (side === 'a') {
    predictA.value = team
    predictQueryA.value = team.name
    suggestA.value = []
  } else {
    predictB.value = team
    predictQueryB.value = team.name
    suggestB.value = []
  }
}

async function runPredict(aId, bId) {
  if (!member.value) return
  predictError.value = ''
  predictResult.value = null
  predictLoading.value = true
  try {
    const token = localStorage.getItem('token') || ''
    const res = await fetch(`${API}/predict?a=${aId}&b=${bId}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    predictResult.value = await res.json()
  } catch (e) {
    predictError.value = e?.message || '分析失败'
  } finally {
    predictLoading.value = false
  }
}

async function submitPredict() {
  if (!predictA.value?.id || !predictB.value?.id) {
    predictError.value = '请从下拉中选择两支战队'
    return
  }
  await runPredict(predictA.value.id, predictB.value.id)
}

function predictFromMatch(m) {
  if (!member.value) return
  tab.value = 'predict'
  predictA.value = { id: m.radiant_team_id, name: m.radiant_name }
  predictB.value = { id: m.dire_team_id, name: m.dire_name }
  predictQueryA.value = m.radiant_name
  predictQueryB.value = m.dire_name
  runPredict(m.radiant_team_id, m.dire_team_id)
}

const teamHistoryRecent = computed(() => {
  const hist = detailData.value?.history || []
  return hist.slice(-20).reverse()
})

onMounted(() => {
  timer = setInterval(load, 45000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
  clearTimeout(suggestTimerA)
  clearTimeout(suggestTimerB)
})
</script>

<template>
  <div class="wrap">
    <div class="topbar">
      <div class="toolbar-row">
        <span class="meta-chip">{{ stats.date }}</span>
        <span class="meta-chip">{{ loading ? '加载中…' : `${stats.shown}/${stats.total}` }}</span>
        <button class="btn ghost" type="button" :disabled="loading" @click="load">刷新</button>
      </div>
    </div>

    <div class="stats">
      <div class="stat"><b>{{ stats.teams }}</b><span>战队</span></div>
      <div class="stat"><b>{{ stats.shown }}/{{ stats.total }}</b><span>当前</span></div>
      <div class="stat"><b>{{ stats.matches }}</b><span>最近赛</span></div>
      <div class="stat"><b>{{ member ? stats.highConf : stats.matches }}</b><span>{{ member ? '高置信' : '场次' }}</span></div>
    </div>

    <div v-if="!member && data?.message" class="guest-banner">{{ data.message }}</div>

    <div class="filter-panel">
      <button type="button" class="filter-toggle" @click="filtersOpen = !filtersOpen">
        <span class="filter-toggle-main">
          <span class="filter-toggle-title">筛选条件</span>
          <span class="filter-toggle-summary">{{ filterSummary }}</span>
        </span>
        <span class="filter-toggle-arrow" :class="{ open: filtersOpen }">▾</span>
      </button>

      <div v-show="filtersOpen" class="filter-body">
        <div class="filters">
          <button type="button" :class="{ active: tab === 'rankings' }" @click="tab = 'rankings'">排行榜</button>
          <button type="button" :class="{ active: tab === 'matches' }" @click="tab = 'matches'">最近比赛</button>
          <button type="button" :class="{ active: tab === 'predict' }" @click="tab = 'predict'">胜率分析</button>
        </div>

        <div v-if="tab === 'rankings'" class="filter-row">
          <span class="label">数量</span>
          <button type="button" class="chip-btn" :class="{ active: limit === '50' }" @click="limit = '50'">Top 50</button>
          <button type="button" class="chip-btn" :class="{ active: limit === '100' }" @click="limit = '100'">Top 100</button>
          <button type="button" class="chip-btn" :class="{ active: limit === '200' }" @click="limit = '200'">Top 200</button>
        </div>
      </div>
    </div>

    <div v-if="tab === 'predict'" class="predict-panel">
      <template v-if="member">
        <div class="predict-form">
          <div class="team-select">
            <label>战队 A</label>
            <input
              :value="predictQueryA"
              type="text"
              placeholder="输入战队名"
              @input="onPredictInput('a', $event.target.value)"
            />
            <div v-if="suggestA.length" class="suggest">
              <button
                v-for="t in suggestA"
                :key="'a-' + t.id"
                type="button"
                class="suggest-item"
                @click="pickSuggest('a', t)"
              >
                <span>{{ t.name }}</span>
                <span class="muted">{{ t.rating }}</span>
              </button>
            </div>
          </div>
          <div class="vs-text">VS</div>
          <div class="team-select">
            <label>战队 B</label>
            <input
              :value="predictQueryB"
              type="text"
              placeholder="输入战队名"
              @input="onPredictInput('b', $event.target.value)"
            />
            <div v-if="suggestB.length" class="suggest">
              <button
                v-for="t in suggestB"
                :key="'b-' + t.id"
                type="button"
                class="suggest-item"
                @click="pickSuggest('b', t)"
              >
                <span>{{ t.name }}</span>
                <span class="muted">{{ t.rating }}</span>
              </button>
            </div>
          </div>
        </div>
        <button type="button" class="btn ghost predict-btn" :disabled="predictLoading" @click="submitPredict">
          {{ predictLoading ? '分析中…' : '开始分析' }}
        </button>
        <div v-if="predictError" class="empty err">{{ predictError }}</div>
        <div v-if="predictResult" class="predict-result">
          <div class="predict-side">
            <div class="predict-name">{{ predictResult.team_a_name }}</div>
            <div class="predict-meta">Elo {{ predictResult.team_a_rating }}</div>
            <div class="predict-prob">{{ fmtPct(predictResult.upset_adjusted_prob ?? predictResult.p_a_win) }}</div>
          </div>
          <div class="prob-bar-wrap">
            <div
              class="prob-bar"
              :style="{ width: `${(((predictResult.upset_adjusted_prob ?? predictResult.p_a_win) ?? 0.5) * 100).toFixed(1)}%` }"
            />
          </div>
          <div class="predict-side">
            <div class="predict-name">{{ predictResult.team_b_name }}</div>
            <div class="predict-meta">Elo {{ predictResult.team_b_rating }}</div>
            <div class="predict-prob">{{ fmtPct(1 - (predictResult.upset_adjusted_prob ?? predictResult.p_a_win ?? 0.5)) }}</div>
          </div>
        </div>
        <div v-if="predictResult && member" class="predict-extra">
          <span v-if="predictResult.is_high_confidence" class="badge poly">高置信</span>
          <span class="badge level">Risk {{ predictResult.risk_points ?? 0 }}</span>
          <span class="badge odds">K {{ predictResult.k_factor ?? '—' }}</span>
        </div>
      </template>
      <div v-else class="guest-hint">订阅后可使用胜率分析</div>
    </div>

    <template v-else>
      <div v-if="loading && !data" class="empty">加载数据中…</div>
      <div v-else-if="error && !data" class="empty err">{{ error }}</div>
      <div v-else-if="!paginatedItems.length" class="empty">
      当前筛选下没有数据
      <div v-if="data?.message" class="hint">{{ data.message }}</div>
    </div>

      <template v-else>
        <div class="list">
          <article v-for="item in paginatedItems" :key="tab + '-' + (item.id || item.match_id)" class="row-card">
            <template v-if="tab === 'rankings'">
              <div class="row-meta">
                <span class="tour-title">#{{ item.rank }} · {{ item.tag || '职业' }}</span>
                <div class="badges">
                  <span v-if="member && item.rating != null" class="badge odds">Elo {{ item.rating }}</span>
                  <span v-if="member && (item.win_rate || 0) >= 0.6" class="badge poly">高置信</span>
                </div>
              </div>
              <div class="row-main">
                <div class="matchup">
                  <span class="name">{{ item.name }}</span>
                  <span v-if="member" class="vs-text">{{ item.wins ?? 0 }}胜 {{ item.losses ?? 0 }}负 · {{ fmtPct(item.win_rate) }}</span>
                </div>
                <div v-if="member" class="row-actions">
                  <button type="button" class="act-btn" @click="openTeam(item)">参数详情</button>
                </div>
                <div v-else class="guest-hint">订阅后可查看</div>
              </div>
              <div v-if="member && item.last_match_at" class="row-foot">最近 {{ fmtTime(item.last_match_at) }}</div>
            </template>

            <template v-else>
              <div class="row-meta">
                <span class="tour-title">{{ item.league_name || '职业赛' }}</span>
                <div class="badges">
                  <span class="badge level">{{ fmtDate(item.start_time) }}</span>
                  <span class="badge" :class="matchStatusText(item) === '已结束' ? 'odds' : 'poly'">{{ matchStatusText(item) }}</span>
                  <span v-if="member && polyUrlOf(item)" class="badge poly">外链</span>
                </div>
              </div>
              <div class="row-main">
                <div class="matchup">
                  <span class="name" :class="{ pick: winnerSide(item) === 'radiant' }">
                    {{ item.radiant_name }}
                    <span v-if="member && winnerSide(item) === 'radiant'" class="pick-tag">胜</span>
                  </span>
                  <span class="vs-text">对</span>
                  <span class="name" :class="{ pick: winnerSide(item) === 'dire' }">
                    {{ item.dire_name }}
                    <span v-if="member && winnerSide(item) === 'dire'" class="pick-tag">胜</span>
                  </span>
                </div>
                <div v-if="member" class="row-actions">
                  <button type="button" class="act-btn" @click="openMatchDetail(item)">参数详情</button>
                  <button
                    v-if="polyUrlOf(item)"
                    type="button"
                    class="act-btn market"
                    title="打开关联页"
                    @click="openMarket(item)"
                  >外链</button>
                  <button type="button" class="act-btn" @click="predictFromMatch(item)">胜率分析</button>
                </div>
                <div v-else class="guest-hint">订阅后可查看</div>
              </div>
              <div class="row-foot">
                <span class="score-line">{{ item.radiant_score }} : {{ item.dire_score }}</span>
                <span>{{ fmtTime(item.start_time) }}</span>
              </div>
            </template>
          </article>
        </div>

        <div v-if="totalPages > 1" class="pager">
          <button type="button" class="pager-btn" :disabled="currentPage <= 1" @click="goPage(currentPage - 1)">上一页</button>
          <span class="pager-info">第 {{ currentPage }} / {{ totalPages }} 页</span>
          <button type="button" class="pager-btn" :disabled="currentPage >= totalPages" @click="goPage(currentPage + 1)">下一页</button>
        </div>
      </template>
    </template>

    <Teleport to="body">
      <div v-if="member && detailMatch" class="modal-mask" @click.self="closeMatchDetail">
        <div class="modal-sheet" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div>
              <div class="modal-title">参数详情</div>
              <div class="modal-sub">
                {{ detailMatch.radiant_name }} 对 {{ detailMatch.dire_name }}
              </div>
            </div>
            <button type="button" class="modal-close" @click="closeMatchDetail">关闭</button>
          </div>

          <div class="modal-body">
            <div class="card-head">
              <div class="tour-title">{{ detailMatch.league_name || '职业赛' }}</div>
              <div class="badges">
                <span class="badge level">{{ fmtDate(detailMatch.start_time) }}</span>
                <span class="badge" :class="matchStatusText(detailMatch) === '已结束' ? 'odds' : 'poly'">
                  {{ matchStatusText(detailMatch) }}
                </span>
                <span v-if="polyUrlOf(detailMatch)" class="badge poly">外链</span>
              </div>
            </div>

            <div class="players">
              <div class="player-row">
                <div class="player-main">
                  <span class="rank">天辉</span>
                  <span class="pname" :class="{ pick: winnerSide(detailMatch) === 'radiant' }">{{ detailMatch.radiant_name }}</span>
                  <span class="pscore">{{ detailMatch.radiant_score ?? '' }}</span>
                </div>
              </div>
              <div class="vs">对</div>
              <div class="player-row">
                <div class="player-main">
                  <span class="rank">夜魇</span>
                  <span class="pname" :class="{ pick: winnerSide(detailMatch) === 'dire' }">{{ detailMatch.dire_name }}</span>
                  <span class="pscore">{{ detailMatch.dire_score ?? '' }}</span>
                </div>
              </div>
            </div>

            <div v-if="matchPredictLoading" class="empty">加载分析中…</div>
            <div v-else-if="matchPredict" class="elo-panel">
              <div class="elo-best">
                分析胜率
                <span class="who">{{ matchPredict.team_a_name }}</span>
                {{ fmtPct(predictProbA(matchPredict)) }}
                ·
                <span class="who">{{ matchPredict.team_b_name }}</span>
                {{ fmtPct(1 - predictProbA(matchPredict)) }}
              </div>
              <div class="elo-rows">
                <div>
                  {{ matchPredict.team_a_name }} Elo {{ matchPredict.team_a_rating ?? '—' }}
                  · 边
                  <span class="edge pos">{{ fmtPct(predictProbA(matchPredict)) }}</span>
                </div>
                <div>
                  {{ matchPredict.team_b_name }} Elo {{ matchPredict.team_b_rating ?? '—' }}
                  · 边
                  <span class="edge pos">{{ fmtPct(1 - predictProbA(matchPredict)) }}</span>
                </div>
              </div>
              <div class="elo-meta">
                <span v-if="matchPredict.is_high_confidence">高置信 · </span>
                Risk {{ matchPredict.risk_points ?? 0 }} · K {{ matchPredict.k_factor ?? '—' }}
              </div>
            </div>
            <div v-else class="box"><span class="muted">暂无分析数据</span></div>

            <div v-if="polyUrlOf(detailMatch)" class="poly-panel">
              <div class="poly-title">关联外链</div>
              <div class="poly-note">{{ detailMatch.polymarket?.title || '已匹配到外链' }}</div>
            </div>

            <div class="card-foot">
              <span>开赛 {{ fmtTime(detailMatch.start_time) }}</span>
              <span>{{ matchStatusText(detailMatch) }}</span>
            </div>
          </div>

          <div class="modal-foot">
            <button type="button" class="act-btn" @click="closeMatchDetail">关闭</button>
            <button
              v-if="polyUrlOf(detailMatch)"
              type="button"
              class="act-btn market"
              @click="openMarket(detailMatch)"
            >外链</button>
            <button type="button" class="act-btn" @click="predictFromMatch(detailMatch); closeMatchDetail()">
              胜率分析
            </button>
          </div>
        </div>
      </div>

      <div v-if="member && detailTeam" class="modal-mask" @click.self="closeTeam">
        <div class="modal-sheet" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div>
              <div class="modal-title">战队详情</div>
              <div class="modal-sub">{{ detailTeam.name }}</div>
            </div>
            <button type="button" class="modal-close" @click="closeTeam">关闭</button>
          </div>

          <div class="modal-body">
            <div v-if="detailLoading" class="empty">加载中…</div>
            <div v-else-if="detailData?.error" class="empty err">{{ detailData.error }}</div>
            <template v-else-if="detailData?.team">
              <div class="stats detail-stats">
                <div class="stat"><b>{{ detailData.team.rating }}</b><span>Elo</span></div>
                <div class="stat"><b>{{ detailData.team.matches_played }}</b><span>场次</span></div>
                <div class="stat"><b>{{ fmtPct(detailData.team.win_rate) }}</b><span>历史胜率</span></div>
                <div class="stat"><b>{{ detailData.team.wins }}/{{ detailData.team.losses }}</b><span>胜/负</span></div>
              </div>

              <div class="section-title">Elo 变化（最近 {{ teamHistoryRecent.length }} 场）</div>
              <div v-if="!teamHistoryRecent.length" class="empty">暂无历史</div>
              <div v-else class="history-list">
                <div v-for="h in teamHistoryRecent" :key="h.match_id + '-' + h.recorded_at" class="history-row">
                  <span class="hist-date">{{ fmtDate(h.recorded_at) }}</span>
                  <span :class="h.result === 'win' ? 'win' : 'lose'">{{ h.result === 'win' ? '胜' : '负' }}</span>
                  <span class="hist-elo">{{ h.elo_before }} → {{ h.elo_after }}</span>
                  <span class="hist-k">K {{ h.k_factor ?? '—' }}</span>
                </div>
              </div>
            </template>
          </div>

          <div class="modal-foot">
            <button type="button" class="act-btn" @click="closeTeam">关闭</button>
            <button
              v-if="detailData?.team"
              type="button"
              class="act-btn market"
              @click="addTeamToPredict"
            >
              加入分析
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.wrap {
  --bg: #f8fafc;
  --card: #ffffff;
  --card-2: #f1f5f9;
  --line: #e2e8f0;
  --text: #1e293b;
  --muted: #94a3b8;
  --primary: #4f46e5;
  --primary-soft: #eef2ff;
  --success: #16a34a;
  --warning: #d97706;
  --danger: #dc2626;
  --pink: #db2777;
  color: var(--text);
  background: var(--bg);
  padding: 12px;
  border-radius: 0;
}
.topbar {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 12px;
}
.toolbar-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.meta-chip, .btn, .chip-btn, .filters button {
  border: 1px solid var(--line);
  background: var(--card);
  color: #64748b;
  border-radius: 999px;
  padding: 5px 10px;
  font-size: 0.72rem;
  font-weight: 600;
}
.btn.ghost {
  cursor: pointer;
  color: var(--primary);
  border-color: #c7d2fe;
  background: var(--primary-soft);
}
.btn:disabled { opacity: 0.5; cursor: wait; }
.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 5px;
  margin-bottom: 8px;
}
.stat {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 4px 6px;
  text-align: center;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
}
.stat b {
  display: block;
  color: var(--primary);
  font-size: 0.82rem;
  font-weight: 700;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}
.stat span { color: var(--muted); font-size: 0.58rem; }
.detail-stats { margin-bottom: 12px; }
.filters { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.filter-panel {
  margin-bottom: 12px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 14px;
  overflow: hidden;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
}
.filter-toggle {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border: 0;
  background: transparent;
  cursor: pointer;
  text-align: left;
}
.filter-toggle-main { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.filter-toggle-title { font-size: 0.82rem; font-weight: 700; color: #0f172a; }
.filter-toggle-summary {
  font-size: 0.7rem;
  color: #64748b;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.filter-toggle-arrow {
  color: var(--primary);
  font-size: 0.85rem;
  line-height: 1;
  transition: transform 0.18s ease;
  flex-shrink: 0;
}
.filter-toggle-arrow.open { transform: rotate(180deg); }
.filter-body { padding: 0 12px 12px; border-top: 1px solid #f1f5f9; padding-top: 10px; }
.filters { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.filter-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  margin-bottom: 8px;
}
.filter-row:last-child { margin-bottom: 0; }
.filter-row .label { color: #64748b; font-size: 0.72rem; font-weight: 600; min-width: 2.8rem; }
.chip-btn, .filters button { cursor: pointer; }
.chip-btn.active, .filters button.active {
  color: var(--primary);
  background: var(--primary-soft);
  border-color: #c7d2fe;
  font-weight: 700;
}
.guest-banner {
  margin-bottom: 10px;
  padding: 8px 10px;
  border-radius: 10px;
  background: #fff7ed;
  border: 1px solid #fed7aa;
  color: #9a3412;
  font-size: 0.72rem;
}
.list { display: grid; gap: 8px; }
.row-card {
  background: var(--card);
  border: 1px solid #f1f5f9;
  border-radius: 14px;
  padding: 10px 12px;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.05);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.row-meta {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 8px;
}
.row-meta .tour-title {
  color: #64748b;
  font-size: 0.72rem;
  font-weight: 600;
  line-height: 1.35;
  min-width: 0;
}
.row-main { display: flex; align-items: center; gap: 8px; min-width: 0; }
.matchup { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 6px; flex: 1; min-width: 0; }
.matchup .name {
  font-size: 0.86rem;
  font-weight: 700;
  color: #0f172a;
  line-height: 1.3;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.matchup .name.pick { color: var(--primary); }
.pick-tag {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: 1px 5px;
  font-size: 0.58rem;
  font-weight: 700;
  line-height: 1.3;
  color: #fff;
  background: var(--primary);
}
.matchup .vs-text {
  color: var(--muted);
  font-size: 0.72rem;
  font-weight: 600;
  flex-shrink: 0;
}
.row-foot {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 0.68rem;
  color: var(--muted);
}
.score-line {
  color: var(--primary);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.row-actions { display: flex; gap: 4px; flex-shrink: 0; align-items: center; }
.act-btn {
  border: 1px solid #c7d2fe;
  background: var(--primary-soft);
  color: var(--primary);
  border-radius: 8px;
  padding: 4px 8px;
  font-size: 0.68rem;
  font-weight: 700;
  cursor: pointer;
  white-space: nowrap;
  line-height: 1.2;
}
.act-btn.market {
  background: var(--primary);
  color: #fff;
  border-color: var(--primary);
}
.act-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.guest-hint { font-size: 0.68rem; color: var(--muted); white-space: nowrap; flex-shrink: 0; }
.badges { display: flex; flex-wrap: wrap; gap: 4px; justify-content: flex-end; }
.badge {
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 0.66rem;
  font-weight: 700;
  line-height: 1.3;
  background: var(--card-2);
  color: #64748b;
}
.badge.level { background: #f0fdf4; color: #15803d; }
.badge.odds { background: #fffbeb; color: #b45309; }
.badge.poly { background: #f5f3ff; color: #6d28d9; }
.empty {
  text-align: center;
  padding: 28px 10px;
  color: var(--muted);
  font-size: 0.88rem;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 16px;
}
.empty.err { color: var(--danger); }
.empty .hint { margin-top: 8px; font-size: 0.75rem; opacity: 0.85; }
.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid #f1f5f9;
}
.pager-btn {
  border: 1px solid var(--line);
  background: var(--card);
  color: #475569;
  border-radius: 10px;
  padding: 6px 12px;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
}
.pager-btn:hover:not(:disabled) {
  border-color: #c7d2fe;
  color: var(--primary);
  background: var(--primary-soft);
}
.pager-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.pager-info {
  font-size: 0.78rem;
  font-weight: 600;
  color: #64748b;
  min-width: 6.5em;
  text-align: center;
}
.predict-panel {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 12px;
}
.predict-form { display: grid; gap: 10px; margin-bottom: 10px; }
.team-select { position: relative; }
.team-select label { display: block; font-size: 0.72rem; color: #64748b; margin-bottom: 4px; }
.team-select input {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 8px 10px;
  font-size: 0.82rem;
  background: #fff;
}
.suggest {
  position: absolute;
  left: 0;
  right: 0;
  top: calc(100% + 4px);
  z-index: 5;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 10px;
  overflow: hidden;
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.12);
}
.suggest-item {
  width: 100%;
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border: 0;
  border-bottom: 1px solid #f1f5f9;
  background: #fff;
  cursor: pointer;
  text-align: left;
  font-size: 0.78rem;
}
.suggest-item:last-child { border-bottom: 0; }
.suggest-item .muted { color: var(--muted); }
.predict-btn { margin-bottom: 10px; cursor: pointer; }
.predict-result { display: grid; gap: 8px; margin-top: 8px; }
.predict-side { text-align: center; }
.predict-name { font-weight: 700; font-size: 0.9rem; }
.predict-meta { font-size: 0.72rem; color: var(--muted); }
.predict-prob { font-size: 1.1rem; font-weight: 800; color: var(--primary); }
.prob-bar-wrap {
  height: 8px;
  background: #e2e8f0;
  border-radius: 999px;
  overflow: hidden;
}
.prob-bar {
  height: 100%;
  background: linear-gradient(90deg, #16a34a, #4f46e5);
  border-radius: 999px;
}
.predict-extra { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.section-title { font-size: 0.78rem; font-weight: 700; margin: 10px 0 8px; color: #0f172a; }
.history-list { display: grid; gap: 6px; }
.history-row {
  display: grid;
  grid-template-columns: 1fr auto auto auto;
  gap: 8px;
  align-items: center;
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--card-2);
  font-size: 0.72rem;
}
.history-row .win { color: var(--success); font-weight: 700; }
.history-row .lose { color: var(--danger); font-weight: 700; }
.hist-elo { font-variant-numeric: tabular-nums; }
.hist-k { color: var(--muted); }
.modal-mask {
  position: fixed;
  inset: 0;
  z-index: 80;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding: 12px;
}
.modal-sheet {
  width: 100%;
  max-width: 28rem;
  max-height: min(85vh, 760px);
  background: #fff;
  border-radius: 20px 20px 16px 16px;
  box-shadow: 0 20px 50px rgba(15, 23, 42, 0.25);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.modal-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px 10px;
  border-bottom: 1px solid #f1f5f9;
}
.modal-title { font-size: 1rem; font-weight: 700; color: #0f172a; }
.modal-sub { margin-top: 2px; font-size: 0.75rem; color: #64748b; line-height: 1.35; }
.modal-close {
  border: 1px solid var(--line);
  background: #fff;
  color: #475569;
  border-radius: 10px;
  padding: 6px 10px;
  font-size: 0.75rem;
  font-weight: 600;
  cursor: pointer;
  flex-shrink: 0;
}
.modal-body {
  padding: 12px 16px;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}
.modal-foot {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  padding: 10px 16px 14px;
  border-top: 1px solid #f1f5f9;
}
.modal-foot .act-btn {
  flex: 1;
  padding: 8px 10px;
  font-size: 0.78rem;
  border-radius: 10px;
}
.card-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: flex-start;
  margin-bottom: 8px;
}
.tour-title { color: #64748b; font-size: 0.75rem; font-weight: 600; }
.players { display: grid; gap: 6px; }
.player-row { display: grid; gap: 2px; }
.vs { color: var(--muted); font-size: 0.68rem; padding-left: 2px; line-height: 1; }
.player-main { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.rank {
  color: var(--primary);
  font-weight: 700;
  font-size: 0.92rem;
  min-width: 2rem;
  font-variant-numeric: tabular-nums;
}
.pname {
  font-weight: 700;
  font-size: 0.88rem;
  color: #0f172a;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pname.pick { color: var(--primary); }
.pscore {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
  color: #64748b;
  font-weight: 700;
  font-size: 0.85rem;
}
.box {
  margin-top: 8px;
  border: 1px solid var(--line);
  background: var(--card-2);
  border-radius: 10px;
  padding: 8px 10px;
  font-size: 0.76rem;
  line-height: 1.4;
}
.box .muted { color: var(--muted); }
.elo-panel {
  margin-top: 8px;
  border: 1px solid #c7d2fe;
  background: var(--primary-soft);
  border-radius: 10px;
  padding: 8px 10px;
  font-size: 0.76rem;
}
.elo-best { font-weight: 700; margin-bottom: 4px; color: #312e81; }
.elo-best .who { color: var(--primary); }
.elo-rows { display: grid; gap: 2px; color: #334155; }
.elo-meta { margin-top: 4px; color: var(--muted); font-size: 0.66rem; }
.edge.pos, .pos { color: var(--success); }
.edge.neg, .neg { color: var(--danger); }
.poly-panel {
  margin-top: 8px;
  border: 1px solid #ddd6fe;
  background: #f5f3ff;
  border-radius: 10px;
  padding: 8px 10px;
  font-size: 0.76rem;
}
.poly-title { color: #6d28d9; font-weight: 700; font-size: 0.7rem; margin-bottom: 4px; }
.poly-note { color: #64748b; font-size: 0.7rem; line-height: 1.35; }
.card-foot {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-top: 10px;
  font-size: 0.68rem;
  color: var(--muted);
}
</style>
