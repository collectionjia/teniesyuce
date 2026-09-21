<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { fetchTennisSettledToday } from '../api'
import { sofaTennisMatchUrl } from '../utils/sofaMatchUrl'

defineProps({
  standalone: { type: Boolean, default: false },
  /** 产品详情内嵌：不显示大标题，适配手机壳 */
  embedded: { type: Boolean, default: false },
})

const loading = ref(false)
const error = ref('')
const matches = ref([])
const availableDates = ref([])
const settledDate = ref('all')
const message = ref('')
const detailMatch = ref(null)

function fmtTime(isoOrTs) {
  if (!isoOrTs) return '—'
  const d = typeof isoOrTs === 'number'
    ? new Date(isoOrTs > 1e12 ? isoOrTs : isoOrTs * 1000)
    : new Date(isoOrTs)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function winnerLabel(m) {
  if (m.winner === 'home') return m.home || m.winnerName || '主'
  if (m.winner === 'away') return m.away || m.winnerName || '客'
  return m.winnerName || '—'
}

function pickHitText(m) {
  if (m.pickHit === 1) return '荐中'
  if (m.pickHit === 0) return '荐未中'
  return '无推荐'
}

function rankOf(player) {
  const n = Number(player?.ranking ?? player?.currentRank ?? player?.rank)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

function bestOf(player) {
  const n = Number(player?.bestRank ?? player?.best)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

function prevOf(player) {
  const n = Number(player?.previousRank ?? player?.previous)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

function rankText(n) {
  return n == null ? '—' : String(n)
}

function cents(price) {
  if (price == null || !Number.isFinite(Number(price))) return '—'
  return `${Math.round(Number(price) * 100)}¢`
}

function gapOf(m) {
  const homeR = rankOf(m?.homePlayer) ?? m?.homeRank
  const awayR = rankOf(m?.awayPlayer) ?? m?.awayRank
  if (homeR == null || awayR == null) return null
  return Math.abs(homeR - awayR)
}

function openDetail(m) {
  detailMatch.value = m
}

function closeDetail() {
  detailMatch.value = null
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const params = {}
    if (settledDate.value && settledDate.value !== 'all') params.date = settledDate.value
    const bundle = await fetchTennisSettledToday(params)
    matches.value = bundle?.live?.matches || []
    availableDates.value = Array.isArray(bundle?.availableDates) ? bundle.availableDates : []
    message.value = bundle?.message || ''
  } catch (e) {
    error.value = e?.response?.data?.error || e.message || '加载失败'
    matches.value = []
  } finally {
    loading.value = false
  }
}

watch(settledDate, () => {
  void load()
})

onMounted(() => {
  void load()
})

const titleDate = computed(() => (
  settledDate.value === 'all' ? '全部日期' : settledDate.value
))

const pickStats = computed(() => {
  let win = 0
  let loss = 0
  for (const m of matches.value) {
    if (m?.pickHit === 1) win += 1
    else if (m?.pickHit === 0) loss += 1
  }
  const total = win + loss
  const pct = (n) => (total ? `${Math.round((n / total) * 1000) / 10}%` : '—')
  return {
    win,
    loss,
    total,
    winRate: pct(win),
  }
})
</script>

<template>
  <div class="page" :class="{ standalone, embedded }">
    <header class="head" :class="{ compact: embedded }">
      <div>
        <h1 v-if="!embedded">完赛网球</h1>
        <p class="sub">
          <span>{{ titleDate }} · {{ matches.length }} 场</span>
          <span> · 胜 </span>
          <span class="stat-win">{{ pickStats.total ? pickStats.win : '—' }}</span>
          <span> 场</span>
          <span> · 胜率 </span>
          <span class="stat-win">{{ pickStats.winRate }}</span>
        </p>
      </div>
      <button type="button" class="btn" :disabled="loading" @click="load">
        {{ loading ? '加载中…' : '刷新' }}
      </button>
    </header>

    <div class="filters">
      <button
        type="button"
        class="chip"
        :class="{ on: settledDate === 'all' }"
        @click="settledDate = 'all'"
      >全部</button>
      <button
        v-for="d in availableDates.slice(0, 10)"
        :key="d.date"
        type="button"
        class="chip"
        :class="{ on: settledDate === d.date }"
        @click="settledDate = d.date"
      >{{ String(d.date).slice(5) }}·{{ d.count }}</button>
      <input
        class="date"
        type="date"
        :value="settledDate !== 'all' ? settledDate : ''"
        @change="settledDate = $event.target.value || 'all'"
      />
    </div>

    <p v-if="error" class="err">{{ error }}</p>
    <p v-else-if="!loading && !matches.length" class="empty">暂无完赛记录</p>
    <p v-else-if="message && !loading" class="hint">{{ message }}</p>

    <div class="list">
      <article v-for="m in matches" :key="m.id" class="card" @click="openDetail(m)">
        <div class="row top">
          <span class="time">{{ fmtTime(m.settledAt || m.startTimestamp) }}</span>
          <div class="top-badges">
            <span v-if="m.pickSide" class="badge pick" title="平台推荐">优</span>
            <span v-if="m.winner" class="badge win" title="实际胜方">赢</span>
            <span class="badge" :class="m.pickHit === 1 ? 'ok' : (m.pickHit === 0 ? 'miss' : '')">
              {{ pickHitText(m) }}
            </span>
          </div>
        </div>
        <div class="names">
          <span :class="{ win: m.winner === 'home', pick: m.pickSide === 'home' }">
            <span v-if="rankOf(m.homePlayer) != null" class="rank">#{{ rankOf(m.homePlayer) }}</span>
            {{ m.home }}
            <span v-if="m.pickSide === 'home'" class="pick-tag">优</span>
            <span v-if="m.winner === 'home'" class="win-tag">赢</span>
          </span>
          <span class="vs">vs</span>
          <span :class="{ win: m.winner === 'away', pick: m.pickSide === 'away' }">
            <span v-if="rankOf(m.awayPlayer) != null" class="rank">#{{ rankOf(m.awayPlayer) }}</span>
            {{ m.away }}
            <span v-if="m.pickSide === 'away'" class="pick-tag">优</span>
            <span v-if="m.winner === 'away'" class="win-tag">赢</span>
          </span>
        </div>
        <div class="row meta">
          <span>比分 {{ m.scoreText || '—' }}</span>
          <span v-if="gapOf(m) != null">差 {{ gapOf(m) }}</span>
          <span>胜方 {{ winnerLabel(m) }}</span>
          <button type="button" class="detail-btn" @click.stop="openDetail(m)">详情</button>
        </div>
      </article>
    </div>

    <Teleport to="body">
      <div v-if="detailMatch" class="modal-mask" @click.self="closeDetail">
        <div class="modal-sheet" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div>
              <div class="modal-title">详情</div>
              <div class="modal-sub">{{ detailMatch.home }} vs {{ detailMatch.away }}</div>
              <div class="modal-meta">
                {{ fmtTime(detailMatch.settledAt || detailMatch.startTimestamp) }}
                · 已结束
                <template v-if="detailMatch.tournament || detailMatch.tournamentShort">
                  · {{ detailMatch.tournamentShort || detailMatch.tournament }}
                </template>
              </div>
            </div>
            <button type="button" class="modal-x" aria-label="关闭" @click="closeDetail">×</button>
          </div>

          <div class="duel">
            <div class="duel-side" :class="{ pick: detailMatch.pickSide === 'home', winner: detailMatch.winner === 'home' }">
              <div class="duel-rank">
                现 #{{ rankText(rankOf(detailMatch.homePlayer) ?? detailMatch.homeRank) }}
              </div>
              <div class="duel-name">
                {{ detailMatch.home }}
                <span v-if="detailMatch.pickSide === 'home'" class="pick-tag">优</span>
                <span v-if="detailMatch.winner === 'home'" class="win-tag">赢</span>
              </div>
              <div class="duel-hist">
                周 {{ rankText(prevOf(detailMatch.homePlayer)) }}
                · 史 {{ rankText(bestOf(detailMatch.homePlayer)) }}
              </div>
            </div>
            <div class="duel-vs">VS</div>
            <div class="duel-side" :class="{ pick: detailMatch.pickSide === 'away', winner: detailMatch.winner === 'away' }">
              <div class="duel-rank">
                现 #{{ rankText(rankOf(detailMatch.awayPlayer) ?? detailMatch.awayRank) }}
              </div>
              <div class="duel-name">
                {{ detailMatch.away }}
                <span v-if="detailMatch.pickSide === 'away'" class="pick-tag">优</span>
                <span v-if="detailMatch.winner === 'away'" class="win-tag">赢</span>
              </div>
              <div class="duel-hist">
                周 {{ rankText(prevOf(detailMatch.awayPlayer)) }}
                · 史 {{ rankText(bestOf(detailMatch.awayPlayer)) }}
              </div>
            </div>
          </div>

          <div class="kv-grid">
            <div class="kv">
              <span class="k">比分</span>
              <span class="v">{{ detailMatch.scoreText || '—' }}</span>
            </div>
            <div class="kv">
              <span class="k">现排名差</span>
              <span class="v">{{ gapOf(detailMatch) != null ? gapOf(detailMatch) : '—' }}</span>
              <span class="s">
                {{ rankText(rankOf(detailMatch.homePlayer) ?? detailMatch.homeRank) }}
                −
                {{ rankText(rankOf(detailMatch.awayPlayer) ?? detailMatch.awayRank) }}
              </span>
            </div>
            <div class="kv">
              <span class="k">胜方</span>
              <span class="v">{{ winnerLabel(detailMatch) }}</span>
            </div>
            <div class="kv">
              <span class="k">平台推荐</span>
              <span class="v">{{ detailMatch.pickName || '无' }}</span>
              <span class="s">{{ pickHitText(detailMatch) }}</span>
            </div>
            <div class="kv">
              <span class="k">主队价</span>
              <span class="v">{{ cents(detailMatch.pmHomePrice) }}</span>
            </div>
            <div class="kv">
              <span class="k">客队价</span>
              <span class="v">{{ cents(detailMatch.pmAwayPrice) }}</span>
            </div>
          </div>

          <div class="modal-actions">
            <a
              v-if="sofaTennisMatchUrl(detailMatch) !== '#'"
              class="link"
              :href="sofaTennisMatchUrl(detailMatch)"
              target="_blank"
              rel="noopener noreferrer"
            >Sofascore</a>
            <button type="button" class="btn" @click="closeDetail">关闭</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.page {
  min-height: 100%;
  background: #f8fafc;
  color: #0f172a;
  padding: 16px;
}
.page.standalone {
  min-height: 100vh;
  max-width: 720px;
  margin: 0 auto;
}
.page.embedded {
  padding: 8px 4px 16px;
  background: transparent;
  min-height: 0;
}
.head.compact {
  margin-bottom: 10px;
  align-items: center;
}
.head.compact .sub {
  margin: 0;
  font-size: 0.8rem;
}
.head.compact .btn {
  padding: 6px 12px;
  font-size: 0.8rem;
  border-radius: 8px;
}
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}
h1 {
  margin: 0;
  font-size: 1.35rem;
  font-weight: 800;
}
.sub {
  margin: 4px 0 0;
  color: #0f172a;
  font-size: 0.85rem;
  font-weight: 600;
}
.stat-win {
  color: #16a34a;
  font-weight: 800;
}
.stat-loss {
  color: #dc2626;
  font-weight: 800;
}
.btn {
  border: 0;
  background: #0f172a;
  color: #fff;
  border-radius: 10px;
  padding: 8px 14px;
  font-weight: 700;
  cursor: pointer;
}
.btn:disabled { opacity: 0.6; cursor: wait; }
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
  align-items: center;
}
.chip {
  border: 1px solid #e2e8f0;
  background: #fff;
  color: #64748b;
  border-radius: 999px;
  padding: 6px 12px;
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
}
.chip.on {
  color: #4f46e5;
  background: #eef2ff;
  border-color: #c7d2fe;
  font-weight: 700;
}
.date {
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 5px 8px;
  font-size: 0.82rem;
}
.err { color: #dc2626; font-size: 0.9rem; }
.empty, .hint { color: #64748b; font-size: 0.9rem; margin: 8px 0 12px; }
.list { display: flex; flex-direction: column; gap: 10px; }
.card {
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 12px 14px;
  cursor: pointer;
}
.card:active { background: #f8fafc; }
.row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: center;
}
.top { margin-bottom: 6px; }
.time { color: #64748b; font-size: 0.78rem; font-weight: 600; }
.top-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  justify-content: flex-end;
}
.badge {
  font-size: 0.72rem;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 999px;
  background: #f1f5f9;
  color: #64748b;
}
.badge.pick { background: #4f46e5; color: #fff; }
.badge.win { background: #ecfdf5; color: #047857; }
.badge.ok { background: #ecfdf5; color: #047857; }
.badge.miss { background: #fef2f2; color: #b91c1c; }
.names {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: baseline;
  font-weight: 700;
  font-size: 1rem;
  margin-bottom: 6px;
}
.vs { color: #94a3b8; font-size: 0.8rem; font-weight: 600; }
.names .pick { color: #4f46e5; }
.win { color: #2563eb; }
.rank {
  color: #64748b;
  font-size: 0.78rem;
  font-weight: 700;
  margin-right: 2px;
}
.pick-tag,
.win-tag {
  display: inline-flex;
  align-items: center;
  margin-left: 4px;
  padding: 0 5px;
  border-radius: 4px;
  font-size: 0.68rem;
  font-weight: 800;
  line-height: 1.35;
  vertical-align: middle;
}
.pick-tag { background: #4f46e5; color: #fff; }
.win-tag { background: #ecfdf5; color: #047857; border: 1px solid #bbf7d0; }
.meta {
  color: #64748b;
  font-size: 0.8rem;
  margin-top: 4px;
}
.detail-btn {
  border: 1px solid #e2e8f0;
  background: #fff;
  color: #4f46e5;
  border-radius: 8px;
  padding: 2px 8px;
  font-size: 0.75rem;
  font-weight: 700;
  cursor: pointer;
}
.link {
  color: #047857;
  font-weight: 700;
  text-decoration: none;
}
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
  max-width: 440px;
  max-height: min(88vh, 720px);
  overflow: auto;
  background: #fff;
  border-radius: 16px 16px 12px 12px;
  padding: 14px 16px 18px;
  box-shadow: 0 20px 40px rgba(15, 23, 42, 0.2);
}
.modal-head {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 12px;
}
.modal-title { font-size: 1.05rem; font-weight: 800; }
.modal-sub { font-size: 0.92rem; font-weight: 700; margin-top: 2px; }
.modal-meta { color: #64748b; font-size: 0.78rem; margin-top: 4px; }
.modal-x {
  border: 0;
  background: #f1f5f9;
  width: 32px;
  height: 32px;
  border-radius: 999px;
  font-size: 1.2rem;
  line-height: 1;
  cursor: pointer;
  color: #475569;
}
.duel {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  gap: 8px;
  align-items: center;
  margin-bottom: 12px;
  padding: 10px;
  background: #f8fafc;
  border-radius: 12px;
}
.duel-side.pick { color: #4f46e5; }
.duel-side.winner .duel-name { color: #2563eb; }
.duel-rank { font-size: 0.85rem; font-weight: 800; color: #64748b; }
.duel-best { font-weight: 700; color: #94a3b8; margin-left: 2px; }
.duel-name { font-weight: 800; font-size: 0.95rem; margin-top: 4px; }
.duel-hist { color: #94a3b8; font-size: 0.72rem; font-weight: 600; margin-top: 4px; }
.duel-vs { color: #94a3b8; font-weight: 800; font-size: 0.75rem; }
.kv-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 12px;
}
.kv {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 8px 10px;
}
.kv .k { display: block; color: #64748b; font-size: 0.72rem; font-weight: 600; }
.kv .v { display: block; font-size: 0.95rem; font-weight: 800; margin-top: 2px; }
.kv .s { display: block; color: #94a3b8; font-size: 0.72rem; margin-top: 2px; }
.modal-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
}
</style>
