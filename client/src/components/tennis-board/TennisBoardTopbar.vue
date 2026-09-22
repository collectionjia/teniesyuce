<script setup>
defineProps({
  isInplayMode: { type: Boolean, default: false },
  isPrematchMode: { type: Boolean, default: false },
  isMixMode: { type: Boolean, default: false },
  isSettledMode: { type: Boolean, default: false },
  allowBatchTrade: { type: Boolean, default: false },
  bundleHint: { type: String, default: '' },
  collectUpdatedText: { type: String, default: '' },
  collectRefreshing: { type: Boolean, default: false },
  collectNotice: { type: String, default: '' },
  collectError: { type: String, default: '' },
  refreshScoreOddsCollect: { type: Function, default: null },
  inplayAutoRulesText: { type: String, default: '' },
  settledStats: { type: Object, default: null },
  stats: { type: Object, required: true },
  loading: { type: Boolean, default: false },
  filter: { type: String, default: 'all' },
  hideEndedEvents: { type: Boolean, default: false },
  pct: { type: Function, required: true },
  num: { type: Function, required: true },
  setStatusFilter: { type: Function, required: true },
})
</script>

<template>
    <div v-if="isSettledMode && settledStats" class="settled-stats-bar">
      <span>合计 盈{{ pct(settledStats.total?.winRate) }} / 亏{{ pct(settledStats.total?.lossRate) }} · PnL {{ num(settledStats.total?.totalPnl) }}</span>
      <span>盘前 盈{{ pct(settledStats.prematch?.winRate) }} / 亏{{ pct(settledStats.prematch?.lossRate) }}</span>
      <span>盘中 盈{{ pct(settledStats.inplay?.winRate) }} / 亏{{ pct(settledStats.inplay?.lossRate) }}</span>
      <template v-if="(settledStats.rules || []).length">
        <span
          v-for="r in settledStats.rules"
          :key="r.key || r.id"
          class="settled-rule-stat"
          :title="(r.bucket === 'prematch' ? '盘前' : '盘中') + ' · ' + (r.source === 'trade' ? '真实成交' : '纸面回测') + ' · n=' + (r.settledCount || 0)"
        >
          {{ r.bucket === 'prematch' ? '前' : '中' }}·{{ r.name }}
          盈{{ pct(r.winRate) }} / 亏{{ pct(r.lossRate) }}
          · {{ num(r.totalPnl) }}
          <em v-if="r.source === 'paper'">纸</em>
        </span>
      </template>
      <span v-else class="settled-rule-hint">未配置投注条件组时不按规则拆分</span>
    </div>

    <div class="topbar">
      <span class="meta-chip">{{ stats.date }}</span>
      <span class="meta-chip">{{ loading ? '…' : `${stats.shown}/${stats.all}` }}</span>
      <div class="stats">
        <div class="stat"><b>{{ stats.tournaments }}</b><span>赛</span></div>
        <div class="stat"><b>{{ stats.collected }}</b><span>总</span></div>
        <button
          v-if="!isPrematchMode && !isMixMode"
          type="button"
          class="stat stat-btn"
          :class="{ active: filter === 'all' }"
          @click="setStatusFilter('all')"
        >
          <b>{{ stats.all }}</b><span>全</span>
        </button>
        <div v-if="isPrematchMode" class="stat stat-static active">
          <b>{{ stats.open }}</b><span>未开</span>
        </div>
        <template v-else-if="isMixMode">
          <div class="stat stat-static active">
            <b>{{ stats.open }}</b><span>未开</span>
          </div>
          <div class="stat stat-static">
            <b>{{ stats.live }}</b><span>进行</span>
          </div>
        </template>
        <button
          v-else-if="!isInplayMode"
          type="button"
          class="stat stat-btn"
          :class="{ active: filter === 'Not started' }"
          @click="setStatusFilter('Not started')"
        >
          <b>{{ stats.open }}</b><span>未开</span>
        </button>
        <button
          v-if="!isInplayMode && !isPrematchMode && !isMixMode"
          type="button"
          class="stat stat-btn"
          :class="{ active: filter === 'liveish' }"
          @click="setStatusFilter('liveish')"
        >
          <b>{{ stats.live }}</b><span>进行</span>
        </button>
        <button
          v-if="!hideEndedEvents && !isMixMode"
          type="button"
          class="stat stat-btn"
          :class="{ active: filter === 'ended' }"
          @click="setStatusFilter('ended')"
        >
          <b>{{ stats.ended }}</b><span>结束</span>
        </button>
      </div>
    </div>
</template>

<style scoped>
.meta-chip {
  border: 1px solid var(--line);
  background: var(--card);
  color: #64748b;
  border-radius: 999px;
  padding: 5px 11px;
  font-size: 0.78rem;
  font-weight: 600;
  flex-shrink: 0;
  line-height: 1.3;
}
.topbar {
  display: flex; flex-wrap: nowrap; align-items: center; gap: 4px;
  margin-bottom: 6px; overflow-x: auto;
}
.meta-chip, .btn, .chip-btn, .filters button {
  border: 1px solid var(--line);
  background: var(--card);
  color: #64748b;
  border-radius: 999px;
  padding: 5px 11px;
  font-size: 0.78rem;
  font-weight: 600;
  flex-shrink: 0;
  line-height: 1.3;
}
.btn.ghost {
  cursor: pointer;
  color: var(--primary);
  border-color: #c7d2fe;
  background: var(--primary-soft);
  padding: 6px 12px;
  font-size: 0.82rem;
}
.btn:disabled { opacity: 0.5; cursor: wait; }
.stats {
  display: grid; grid-template-columns: repeat(6, 1fr); gap: 3px;
  margin: 0 0 0 auto; min-width: 168px; flex: 1; max-width: 260px;
}
.stat {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 2px 4px;
  text-align: center;
  display: inline-flex;
  align-items: baseline;
  justify-content: center;
  gap: 2px;
  white-space: nowrap;
}
.stat b {
  color: var(--primary);
  font-size: 0.72rem;
  font-weight: 700;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
}
.stat span { color: var(--muted); font-size: 0.58rem; line-height: 1.2; }
.stat-btn {
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
  font: inherit;
  width: 100%;
  padding: 2px 2px;
}
.stat-btn:hover {
  border-color: #c7d2fe;
  background: var(--primary-soft);
}
.stat-btn.active {
  border-color: var(--primary);
  background: var(--primary-soft);
  box-shadow: 0 0 0 1px rgba(79, 70, 229, 0.25);
}
.stat-btn.active span { color: #6366f1; font-weight: 600; }
.stat-static {
  cursor: default;
}
.stat-static.active {
  border-color: var(--primary);
  background: var(--primary-soft);
  box-shadow: 0 0 0 1px rgba(79, 70, 229, 0.25);
}
.stat-static.active span { color: #6366f1; font-weight: 600; }
.inplay-source-bar {
  margin-bottom: 8px;
  padding: 8px 10px;
  border-radius: 10px;
  background: #fffbeb;
  border: 1px solid #fde68a;
  color: #92400e;
  font-size: 0.72rem;
  line-height: 1.4;
}
.inplay-collect-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.inplay-collect-main {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
  min-width: 0;
}
.inplay-collect-label {
  font-weight: 700;
  color: #78350f;
}
.inplay-collect-time {
  font-variant-numeric: tabular-nums;
  color: #92400e;
}
.inplay-collect-time.muted { color: #b45309; opacity: 0.75; }
.inplay-refresh-btn {
  flex-shrink: 0;
  border: 1px solid #f59e0b;
  background: #fff7ed;
  color: #b45309;
  border-radius: 8px;
  padding: 4px 10px;
  font-size: 0.72rem;
  font-weight: 700;
  cursor: pointer;
  line-height: 1.2;
}
.inplay-refresh-btn:disabled {
  opacity: 0.55;
  cursor: wait;
}
.inplay-collect-extra {
  margin-top: 6px;
  color: #92400e;
}
.inplay-collect-notice {
  margin-top: 6px;
  color: #047857;
  font-weight: 600;
}
.inplay-collect-error {
  margin-top: 6px;
  color: #b91c1c;
  font-weight: 600;
  word-break: break-word;
}
.settled-stats-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
  margin-bottom: 8px;
  padding: 8px 10px;
  border-radius: 10px;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  color: #334155;
  font-size: 0.72rem;
  line-height: 1.4;
}
.settled-rule-stat {
  padding: 2px 8px;
  border-radius: 999px;
  background: #fff;
  border: 1px solid #e2e8f0;
  color: #0f172a;
}
.settled-rule-stat em {
  font-style: normal;
  margin-left: 4px;
  color: #94a3b8;
  font-size: 0.65rem;
}
.settled-rule-hint {
  color: #94a3b8;
}
.inplay-source-bar code {
  font-size: 0.7rem;
  background: #fef3c7;
  padding: 1px 4px;
  border-radius: 4px;
}
</style>
