<script setup>
import { onMounted, ref, watch } from 'vue'
import {
  fetchDota2Rankings,
  fetchDota2Matches,
  fetchDota2Predict,
  searchDota2Teams,
} from '../api'

defineProps({
  isMember: { type: Boolean, default: false },
})

const tab = ref('rankings') // rankings | predict | matches
const loading = ref(false)
const error = ref('')
const limit = ref(100)
const rankings = ref([])
const matches = ref([])

const teamA = ref({ id: null, name: '' })
const teamB = ref({ id: null, name: '' })
const suggestA = ref([])
const suggestB = ref([])
const predict = ref(null)
const predictBusy = ref(false)
const predictError = ref('')

let searchTimerA = null
let searchTimerB = null

function pct(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—'
  return `${(Number(n) * 100).toFixed(1)}%`
}

function fmtTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
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

watch(tab, (t) => {
  if (t === 'rankings') void loadRankings()
  if (t === 'matches') void loadMatches()
})

watch(limit, () => {
  if (tab.value === 'rankings') void loadRankings()
})

onMounted(() => {
  void loadRankings()
})
</script>

<template>
  <div class="dota-board">
    <div class="tabs">
      <button type="button" class="chip" :class="{ on: tab === 'rankings' }" @click="tab = 'rankings'">排行榜</button>
      <button type="button" class="chip" :class="{ on: tab === 'predict' }" @click="tab = 'predict'">胜率预测</button>
      <button type="button" class="chip" :class="{ on: tab === 'matches' }" @click="tab = 'matches'">最近比赛</button>
      <button
        v-if="tab === 'rankings' || tab === 'matches'"
        type="button"
        class="btn-refresh"
        :disabled="loading"
        @click="tab === 'rankings' ? loadRankings() : loadMatches()"
      >{{ loading ? '加载中…' : '刷新' }}</button>
    </div>

    <p v-if="error" class="err">{{ error }}</p>

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
th, td { padding: 8px 6px; text-align: left; border-bottom: 1px solid var(--line); }
th { color: var(--muted); font-size: 0.72rem; font-weight: 700; }
.name { font-weight: 700; }
.rating { color: var(--primary); font-weight: 800; }
.win { color: var(--win); font-weight: 700; }
.lose { color: var(--lose); font-weight: 600; }
.score { font-variant-numeric: tabular-nums; font-weight: 700; }
.predict-form {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  gap: 8px;
  align-items: start;
  margin-bottom: 12px;
}
.team-box { position: relative; }
.team-box label {
  display: block;
  font-size: 0.72rem;
  color: var(--muted);
  font-weight: 600;
  margin-bottom: 4px;
}
.team-box input {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 8px 10px;
  font-size: 0.85rem;
  background: #fff;
}
.vs {
  align-self: center;
  padding-top: 18px;
  font-weight: 800;
  color: var(--muted);
  font-size: 0.8rem;
}
.suggest {
  position: absolute;
  left: 0; right: 0; top: 100%;
  z-index: 5;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 10px;
  max-height: 200px;
  overflow: auto;
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.12);
}
.suggest-item {
  width: 100%;
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border: 0;
  background: transparent;
  cursor: pointer;
  font-size: 0.8rem;
  text-align: left;
}
.suggest-item:hover { background: #eef2ff; }
.btn {
  border: 0;
  background: var(--primary);
  color: #fff;
  border-radius: 10px;
  padding: 8px 16px;
  font-weight: 700;
  font-size: 0.85rem;
  cursor: pointer;
}
.btn:disabled { opacity: 0.6; }
.predict-result {
  margin-top: 14px;
  display: grid;
  grid-template-columns: 1fr 1.2fr 1fr;
  gap: 8px;
  align-items: center;
}
.side { text-align: center; }
.team-name { font-weight: 800; font-size: 0.9rem; }
.prob { font-size: 1.4rem; font-weight: 800; margin-top: 4px; }
.prob.accent { color: var(--primary); }
.mid { text-align: center; }
.bar-wrap {
  height: 8px;
  background: #e2e8f0;
  border-radius: 999px;
  overflow: hidden;
  margin-bottom: 6px;
}
.bar {
  height: 100%;
  background: linear-gradient(90deg, #16a34a, #4f46e5);
}
.hc {
  display: inline-block;
  margin-bottom: 4px;
  padding: 2px 8px;
  border-radius: 999px;
  background: #ecfdf5;
  color: #15803d;
  font-size: 0.7rem;
  font-weight: 700;
}
</style>
