<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  fetchDota2Rankings,
  fetchDota2Matches,
  fetchDota2Predict,
  searchDota2Teams,
  fetchDota2Markets,
  refreshDota2Markets,
  placeDota2TradeBatch,
} from '../api'

const props = defineProps({
  isMember: { type: Boolean, default: false },
})

const AUTO_BET_KEY = 'yuce.dota2.autoBet.v1'
const BATCH_AMOUNT_KEY = 'yuce.dota2.batchAmountUsd.v1'
const POLL_MS = 45_000

const tab = ref('markets') // markets | rankings | predict | matches
const loading = ref(false)
const error = ref('')
const limit = ref(100)
const rankings = ref([])
const matches = ref([])
const marketRows = ref([])
const marketMeta = ref(null)
const placedKeys = ref(new Set())
const autoBetEnabled = ref(false)
const batchAmountUsd = ref('1')
const batchBusy = ref(false)
const batchNotice = ref('')
const batchError = ref('')

const teamA = ref({ id: null, name: '' })
const teamB = ref({ id: null, name: '' })
const suggestA = ref([])
const suggestB = ref([])
const predict = ref(null)
const predictBusy = ref(false)
const predictError = ref('')

let searchTimerA = null
let searchTimerB = null
let pollTimer = null
let autoBetRunning = false

function pct(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—'
  return `${(Number(n) * 100).toFixed(1)}%`
}

function fmtTime(isoOrMs) {
  if (isoOrMs == null || isoOrMs === '') return '—'
  const d = typeof isoOrMs === 'number' ? new Date(isoOrMs) : new Date(isoOrMs)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function placeKey(slug, side) {
  return `${slug}:${side}`
}

function loadAutoState() {
  try {
    autoBetEnabled.value = localStorage.getItem(AUTO_BET_KEY) === '1'
    const amt = Number(localStorage.getItem(BATCH_AMOUNT_KEY))
    if (Number.isFinite(amt) && amt >= 1) batchAmountUsd.value = String(amt)
  } catch {
    autoBetEnabled.value = false
  }
}

function saveAutoState() {
  try {
    localStorage.setItem(AUTO_BET_KEY, autoBetEnabled.value ? '1' : '0')
    localStorage.setItem(BATCH_AMOUNT_KEY, String(Number(batchAmountUsd.value) || 1))
  } catch { /* ignore */ }
}

async function loadRankings() {
  loading.value = true
  error.value = ''
  try {
    const data = await fetchDota2Rankings(limit.value)
    rankings.value = Array.isArray(data) ? data : (data?.teams || data?.items || [])
  } catch (e) {
    error.value = e?.response?.data?.error || e.message || '加载排行失败'
    rankings.value = []
  } finally {
    loading.value = false
  }
}

async function loadMatches() {
  loading.value = true
  error.value = ''
  try {
    const data = await fetchDota2Matches(30)
    matches.value = Array.isArray(data) ? data : (data?.matches || [])
  } catch (e) {
    error.value = e?.response?.data?.error || e.message || '加载比赛失败'
    matches.value = []
  } finally {
    loading.value = false
  }
}

async function loadMarkets({ quiet = false } = {}) {
  if (!quiet) {
    loading.value = true
    error.value = ''
  }
  try {
    const data = await fetchDota2Markets()
    marketMeta.value = data
    marketRows.value = Array.isArray(data?.matches) ? data.matches : []
    placedKeys.value = new Set(Array.isArray(data?.placed) ? data.placed : [])
  } catch (e) {
    if (!quiet) {
      error.value = e?.response?.data?.error || e.message || '加载盘口失败'
      marketRows.value = []
    }
  } finally {
    if (!quiet) loading.value = false
  }
}

async function onRefresh() {
  if (tab.value === 'markets') {
    loading.value = true
    error.value = ''
    try {
      const data = await refreshDota2Markets()
      marketMeta.value = data
      marketRows.value = Array.isArray(data?.matches) ? data.matches : []
      await loadMarkets({ quiet: true })
    } catch (e) {
      error.value = e?.response?.data?.error || e.message || '刷新失败'
    } finally {
      loading.value = false
    }
    return
  }
  if (tab.value === 'rankings') return loadRankings()
  if (tab.value === 'matches') return loadMatches()
}

function onSearchA(q) {
  clearTimeout(searchTimerA)
  const text = String(q || '').trim()
  teamA.value = { id: null, name: text }
  if (!text) { suggestA.value = []; return }
  searchTimerA = setTimeout(async () => {
    try {
      const list = await searchDota2Teams(text)
      suggestA.value = Array.isArray(list) ? list.slice(0, 8) : []
    } catch {
      suggestA.value = []
    }
  }, 220)
}

function onSearchB(q) {
  clearTimeout(searchTimerB)
  const text = String(q || '').trim()
  teamB.value = { id: null, name: text }
  if (!text) { suggestB.value = []; return }
  searchTimerB = setTimeout(async () => {
    try {
      const list = await searchDota2Teams(text)
      suggestB.value = Array.isArray(list) ? list.slice(0, 8) : []
    } catch {
      suggestB.value = []
    }
  }, 220)
}

function pickA(t) {
  teamA.value = { id: t.id, name: t.name }
  suggestA.value = []
}

function pickB(t) {
  teamB.value = { id: t.id, name: t.name }
  suggestB.value = []
}

async function runPredict() {
  predictError.value = ''
  predict.value = null
  if (!teamA.value.id || !teamB.value.id) {
    predictError.value = '请从搜索结果中选择两支战队'
    return
  }
  if (teamA.value.id === teamB.value.id) {
    predictError.value = '请选择不同的两支战队'
    return
  }
  predictBusy.value = true
  try {
    predict.value = await fetchDota2Predict({ a: teamA.value.id, b: teamB.value.id })
  } catch (e) {
    predictError.value = e?.response?.data?.detail || e?.response?.data?.error || e.message || '预测失败'
  } finally {
    predictBusy.value = false
  }
}

const hcCount = computed(() => marketRows.value.filter((m) => m.passAutoBet || m.is_high_confidence).length)

const thresholdsLabel = computed(() => {
  const t = marketMeta.value?.thresholds
  if (!t) return ''
  return `Elo≥${t.eloDiffMin} 或 胜率≥${pct(t.winProbMin)} 或 HC`
})

async function runAutoBet() {
  if (!props.isMember || !autoBetEnabled.value || autoBetRunning || batchBusy.value) return
  const amount = Math.round(Number(batchAmountUsd.value) * 100) / 100
  if (!(amount >= 1)) {
    batchError.value = '投注金额至少 $1'
    return
  }
  const candidates = marketRows.value.filter((m) => {
    if (!m.passAutoBet && !m.is_high_confidence) return false
    if (!m.pickTokenId || !m.slug || !m.pickSide) return false
    return !placedKeys.value.has(placeKey(m.slug, m.pickSide))
  })
  if (!candidates.length) return

  autoBetRunning = true
  batchBusy.value = true
  batchError.value = ''
  batchNotice.value = ''
  try {
    const orders = candidates.slice(0, 10).map((m) => ({
      slug: m.slug,
      side: m.pickSide,
      tokenId: m.pickTokenId,
      amountUsd: amount,
    }))
    const resp = await placeDota2TradeBatch({ orders })
    const results = Array.isArray(resp?.results) ? resp.results : []
    let ok = 0
    let skip = 0
    let fail = 0
    const next = new Set(placedKeys.value)
    for (const r of results) {
      if (r.ok && r.skipped) {
        skip += 1
        if (r.slug && r.side) next.add(placeKey(r.slug, r.side))
      } else if (r.ok) {
        ok += 1
        if (r.slug && r.side) next.add(placeKey(r.slug, r.side))
      } else {
        fail += 1
      }
    }
    placedKeys.value = next
    batchNotice.value = `自动投注：成功 ${ok} · 跳过 ${skip} · 失败 ${fail}`
    if (fail && results.find((r) => !r.ok)?.error) {
      batchError.value = results.find((r) => !r.ok).error
    }
  } catch (e) {
    batchError.value = e?.response?.data?.error || e.message || '自动投注失败'
  } finally {
    batchBusy.value = false
    autoBetRunning = false
  }
}

function onAutoBetChange() {
  if (!props.isMember) {
    autoBetEnabled.value = false
    batchError.value = '需会员并配置钱包后才能自动投注'
    return
  }
  saveAutoState()
  batchNotice.value = autoBetEnabled.value ? '已开启自动投注（仅高置信度）' : '已关闭自动投注'
  if (autoBetEnabled.value) void runAutoBet()
}

function syncPoll() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (tab.value !== 'markets') return
  pollTimer = setInterval(async () => {
    await loadMarkets({ quiet: true })
    if (autoBetEnabled.value) void runAutoBet()
  }, POLL_MS)
}

watch(tab, (t) => {
  if (t === 'markets') {
    void loadMarkets().then(() => {
      if (autoBetEnabled.value) void runAutoBet()
    })
    syncPoll()
  } else {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
    if (t === 'rankings') void loadRankings()
    if (t === 'matches') void loadMatches()
  }
})

watch(limit, () => {
  if (tab.value === 'rankings') void loadRankings()
})

watch(batchAmountUsd, () => saveAutoState())

onMounted(() => {
  loadAutoState()
  void loadMarkets().then(() => {
    if (autoBetEnabled.value) void runAutoBet()
  })
  syncPoll()
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
  clearTimeout(searchTimerA)
  clearTimeout(searchTimerB)
})
</script>

<template>
  <div class="dota-board">
    <div class="tabs">
      <button type="button" class="chip" :class="{ on: tab === 'markets' }" @click="tab = 'markets'">盘口</button>
      <button type="button" class="chip" :class="{ on: tab === 'rankings' }" @click="tab = 'rankings'">排行榜</button>
      <button type="button" class="chip" :class="{ on: tab === 'predict' }" @click="tab = 'predict'">胜率预测</button>
      <button type="button" class="chip" :class="{ on: tab === 'matches' }" @click="tab = 'matches'">最近比赛</button>
      <button
        type="button"
        class="btn-refresh"
        :disabled="loading"
        @click="onRefresh"
      >{{ loading ? '加载中…' : '刷新' }}</button>
    </div>

    <div v-if="tab === 'markets'" class="auto-bar">
      <label class="auto-toggle">
        <input
          v-model="autoBetEnabled"
          type="checkbox"
          :disabled="!isMember || batchBusy"
          @change="onAutoBetChange"
        />
        自动投注（仅 HC）
      </label>
      <label class="amount">
        金额 $
        <input v-model="batchAmountUsd" type="number" min="1" step="1" :disabled="batchBusy" />
      </label>
      <span v-if="thresholdsLabel" class="muted small">筛选：{{ thresholdsLabel }}</span>
      <span class="muted small">HC {{ hcCount }} · 共 {{ marketRows.length }}</span>
    </div>
    <p v-if="batchNotice" class="notice">{{ batchNotice }}</p>
    <p v-if="batchError" class="err">{{ batchError }}</p>
    <p v-if="error" class="err">{{ error }}</p>

    <div v-show="tab === 'markets'" class="panel">
      <div class="toolbar">
        <span class="muted small">
          更新 {{ marketMeta?.fetched_at ? fmtTime(marketMeta.fetched_at) : '—' }}
          <template v-if="marketMeta?.scanned != null"> · 扫描 {{ marketMeta.scanned }}</template>
        </span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>对阵</th>
              <th>PM 价</th>
              <th>Elo</th>
              <th>胜率</th>
              <th>Elo差</th>
              <th>推荐</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in marketRows" :key="m.slug">
              <td class="name">
                <div>{{ m.sideA || m.teamA?.name }} vs {{ m.sideB || m.teamB?.name }}</div>
                <div class="muted small">{{ fmtTime(m.startMs) }}</div>
                <span v-if="m.is_high_confidence" class="hc-badge">HC</span>
              </td>
              <td class="mono">
                {{ m.prices?.[0] != null ? Number(m.prices[0]).toFixed(2) : '—' }}
                /
                {{ m.prices?.[1] != null ? Number(m.prices[1]).toFixed(2) : '—' }}
              </td>
              <td class="mono">
                {{ m.teamA?.rating != null ? Number(m.teamA.rating).toFixed(0) : '—' }}
                /
                {{ m.teamB?.rating != null ? Number(m.teamB.rating).toFixed(0) : '—' }}
              </td>
              <td>
                <span :class="m.pickSide === 'a' ? 'win' : ''">{{ pct(m.pA) }}</span>
                /
                <span :class="m.pickSide === 'b' ? 'win' : ''">{{ pct(1 - Number(m.pA || 0.5)) }}</span>
              </td>
              <td class="mono">{{ m.eloDiff != null ? Number(m.eloDiff).toFixed(0) : '—' }}</td>
              <td>
                <span class="pick">{{ m.pickName || (m.pickSide === 'a' ? m.sideA : m.sideB) }}</span>
                <div v-if="placedKeys.has(placeKey(m.slug, m.pickSide))" class="muted small">已下单</div>
              </td>
              <td>
                <a v-if="m.url" class="link" :href="m.url" target="_blank" rel="noopener">PM</a>
              </td>
            </tr>
            <tr v-if="!loading && !marketRows.length">
              <td colspan="7" class="empty">暂无过阈值的盘口（需匹配 dota2elo 且 HC / Elo差 / 胜率过线）</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div v-show="tab === 'rankings'" class="panel">
      <div class="toolbar">
        <label>
          显示
          <select v-model.number="limit">
            <option :value="50">50</option>
            <option :value="100">100</option>
            <option :value="200">200</option>
          </select>
          支
        </label>
        <span class="muted">共 {{ rankings.length }} 支</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>战队</th>
              <th>评分</th>
              <th>胜/负</th>
              <th>胜率</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(t, i) in rankings" :key="t.id || i">
              <td class="muted">{{ i + 1 }}</td>
              <td class="name">{{ t.name }}</td>
              <td class="rating">{{ t.rating != null ? Number(t.rating).toFixed(0) : '—' }}</td>
              <td>
                <span class="win">{{ t.wins ?? 0 }}</span>
                /
                <span class="lose">{{ t.losses ?? 0 }}</span>
              </td>
              <td>{{ pct(t.win_rate) }}</td>
            </tr>
            <tr v-if="!loading && !rankings.length">
              <td colspan="5" class="empty">暂无排行数据</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div v-show="tab === 'predict'" class="panel">
      <div class="predict-form">
        <div class="team-box">
          <label>战队 A</label>
          <input
            :value="teamA.name"
            type="search"
            placeholder="搜索战队…"
            @input="onSearchA($event.target.value)"
          />
          <div v-if="suggestA.length" class="suggest">
            <button
              v-for="t in suggestA"
              :key="'a' + t.id"
              type="button"
              class="suggest-item"
              @click="pickA(t)"
            >
              <span>{{ t.name }}</span>
              <span class="muted">{{ t.rating != null ? Number(t.rating).toFixed(0) : '' }}</span>
            </button>
          </div>
        </div>
        <div class="vs">VS</div>
        <div class="team-box">
          <label>战队 B</label>
          <input
            :value="teamB.name"
            type="search"
            placeholder="搜索战队…"
            @input="onSearchB($event.target.value)"
          />
          <div v-if="suggestB.length" class="suggest">
            <button
              v-for="t in suggestB"
              :key="'b' + t.id"
              type="button"
              class="suggest-item"
              @click="pickB(t)"
            >
              <span>{{ t.name }}</span>
              <span class="muted">{{ t.rating != null ? Number(t.rating).toFixed(0) : '' }}</span>
            </button>
          </div>
        </div>
      </div>
      <button type="button" class="btn" :disabled="predictBusy" @click="runPredict">
        {{ predictBusy ? '计算中…' : '预测胜率' }}
      </button>
      <p v-if="predictError" class="err">{{ predictError }}</p>
      <div v-if="predict" class="predict-result">
        <div class="side">
          <div class="team-name">{{ predict.team_a_name || teamA.name }}</div>
          <div class="rating">Elo {{ predict.team_a_rating != null ? Number(predict.team_a_rating).toFixed(0) : '—' }}</div>
          <div class="prob win">{{ pct(predict.upset_adjusted_prob ?? predict.composite_p_a_win ?? predict.p_a_win) }}</div>
        </div>
        <div class="mid">
          <div class="bar-wrap">
            <div
              class="bar"
              :style="{ width: `${Math.round(Number(predict.upset_adjusted_prob ?? predict.composite_p_a_win ?? predict.p_a_win ?? 0.5) * 100)}%` }"
            />
          </div>
          <div v-if="predict.is_high_confidence" class="hc">高置信度</div>
          <div class="muted small">风险分 {{ predict.risk_points ?? '—' }}</div>
        </div>
        <div class="side">
          <div class="team-name">{{ predict.team_b_name || teamB.name }}</div>
          <div class="rating">Elo {{ predict.team_b_rating != null ? Number(predict.team_b_rating).toFixed(0) : '—' }}</div>
          <div class="prob accent">{{ pct(1 - Number(predict.upset_adjusted_prob ?? predict.composite_p_a_win ?? predict.p_a_win ?? 0.5)) }}</div>
        </div>
      </div>
    </div>

    <div v-show="tab === 'matches'" class="panel">
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>对阵</th>
              <th>比分</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(m, i) in matches" :key="m.match_id || m.id || i">
              <td class="muted">{{ fmtTime(m.start_time || m.played_at || m.startTime) }}</td>
              <td class="name">
                {{ m.radiant_name || m.team_a || m.radiant || '—' }}
                vs
                {{ m.dire_name || m.team_b || m.dire || '—' }}
              </td>
              <td class="score">
                {{ m.radiant_score ?? m.score_a ?? '—' }}
                :
                {{ m.dire_score ?? m.score_b ?? '—' }}
              </td>
            </tr>
            <tr v-if="!loading && !matches.length">
              <td colspan="3" class="empty">暂无比赛</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dota-board {
  --bg: #f8fafc;
  --card: #fff;
  --line: #e2e8f0;
  --text: #1e293b;
  --muted: #94a3b8;
  --primary: #4f46e5;
  --win: #16a34a;
  --lose: #dc2626;
  color: var(--text);
  background: var(--bg);
  padding: 8px 4px 16px;
  min-height: 320px;
}
.tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  margin-bottom: 10px;
}
.chip {
  border: 1px solid var(--line);
  background: #fff;
  color: #475569;
  border-radius: 999px;
  padding: 6px 12px;
  font-size: 0.75rem;
  font-weight: 600;
  cursor: pointer;
}
.chip.on {
  color: #4338ca;
  background: #eef2ff;
  border-color: #6366f1;
}
.btn-refresh {
  margin-left: auto;
  border: 0;
  background: #0f172a;
  color: #fff;
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 0.75rem;
  font-weight: 700;
  cursor: pointer;
}
.btn-refresh:disabled { opacity: 0.6; }
.auto-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 14px;
  margin-bottom: 8px;
  font-size: 0.78rem;
}
.auto-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 700;
  cursor: pointer;
}
.amount input {
  width: 56px;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 2px 6px;
  margin-left: 4px;
}
.notice { color: var(--win); font-size: 0.8rem; margin: 4px 0; }
.panel {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 12px;
}
.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  font-size: 0.8rem;
  gap: 8px;
}
.toolbar select {
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 2px 6px;
  margin: 0 4px;
}
.muted { color: var(--muted); }
.small { font-size: 0.72rem; }
.err { color: var(--lose); font-size: 0.85rem; margin: 8px 0; }
.empty { text-align: center; color: var(--muted); padding: 16px 0; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
th, td { padding: 8px 6px; text-align: left; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-size: 0.72rem; font-weight: 700; }
.name { font-weight: 700; }
.rating { color: var(--primary); font-weight: 800; }
.win { color: var(--win); font-weight: 700; }
.lose { color: var(--lose); }
.mono { font-variant-numeric: tabular-nums; font-family: ui-monospace, monospace; font-size: 0.78rem; }
.pick { font-weight: 800; color: var(--primary); }
.hc-badge {
  display: inline-block;
  margin-top: 4px;
  font-size: 0.65rem;
  font-weight: 800;
  color: #b45309;
  background: #fffbeb;
  border: 1px solid #fbbf24;
  border-radius: 4px;
  padding: 1px 5px;
}
.link {
  color: var(--primary);
  font-weight: 700;
  font-size: 0.75rem;
  text-decoration: none;
}
.predict-form {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: flex-start;
  margin-bottom: 12px;
}
.team-box { flex: 1; min-width: 140px; position: relative; }
.team-box label { display: block; font-size: 0.72rem; color: var(--muted); margin-bottom: 4px; }
.team-box input {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 0.85rem;
  box-sizing: border-box;
}
.vs {
  align-self: center;
  font-weight: 800;
  color: var(--muted);
  padding-top: 18px;
}
.suggest {
  position: absolute;
  z-index: 5;
  left: 0; right: 0;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 8px;
  margin-top: 4px;
  max-height: 200px;
  overflow: auto;
  box-shadow: 0 4px 12px rgba(15, 23, 42, 0.08);
}
.suggest-item {
  display: flex;
  justify-content: space-between;
  width: 100%;
  border: 0;
  background: transparent;
  padding: 8px 10px;
  cursor: pointer;
  font-size: 0.8rem;
  text-align: left;
}
.suggest-item:hover { background: #f1f5f9; }
.btn {
  border: 0;
  background: var(--primary);
  color: #fff;
  border-radius: 8px;
  padding: 8px 16px;
  font-weight: 700;
  cursor: pointer;
}
.btn:disabled { opacity: 0.6; }
.predict-result {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-top: 16px;
}
.predict-result .side { flex: 1; text-align: center; }
.predict-result .team-name { font-weight: 800; margin-bottom: 4px; }
.predict-result .prob { font-size: 1.4rem; font-weight: 800; }
.predict-result .prob.accent { color: var(--primary); }
.mid { flex: 1.2; text-align: center; }
.bar-wrap {
  height: 8px;
  background: #e2e8f0;
  border-radius: 999px;
  overflow: hidden;
  margin-bottom: 8px;
}
.bar { height: 100%; background: var(--win); }
.hc {
  display: inline-block;
  font-size: 0.7rem;
  font-weight: 800;
  color: #b45309;
  background: #fffbeb;
  border-radius: 4px;
  padding: 2px 6px;
  margin-bottom: 4px;
}
.score { font-variant-numeric: tabular-nums; font-weight: 700; }
</style>
