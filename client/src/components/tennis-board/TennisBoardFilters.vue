<script setup>
defineProps({
  isMember: { type: Boolean, default: false },
  isNewMode: { type: Boolean, default: false },
  showFilters: { type: Boolean, default: false },
  isPrematchMode: { type: Boolean, default: false },
  isMixMode: { type: Boolean, default: false },
  isInplayMode: { type: Boolean, default: false },
  isSettledMode: { type: Boolean, default: false },
  isRangeMode: { type: Boolean, default: false },
  classicRankFiltersOn: { type: Boolean, default: false },
  hideEndedEvents: { type: Boolean, default: false },
  topPoolMax: { type: String, default: '20' },
  newPoolRulesText: { type: String, default: '' },
  filtersOpen: { type: Boolean, default: false },
  filterSummary: { type: String, default: '' },
  filter: { type: String, default: 'all' },
  tour: { type: String, default: 'all' },
  pmFilter: { type: String, default: 'all' },
  settledPnlMark: { type: String, default: 'all' },
  settledDate: { type: String, default: 'all' },
  availableSettledDates: { type: Array, default: () => [] },
  gapMin: { type: String, default: 'all' },
  diffMax: { type: String, default: 'all' },
  strongRankMax: { type: String, default: 'all' },
  rangeRulesText: { type: String, default: '' },
  setStatusFilter: { type: Function, required: true },
})

const emit = defineEmits([
  'update:topPoolMax',
  'update:filtersOpen',
  'update:tour',
  'update:pmFilter',
  'update:settledPnlMark',
  'update:settledDate',
  'update:gapMin',
  'update:diffMax',
  'update:strongRankMax',
])
</script>

<template>
<div v-if="isMember && isNewMode" class="new-pool-bar">
      <span class="label">排名池</span>
      <button type="button" class="chip-btn" :class="{ active: topPoolMax === '20' }" @click="emit('update:topPoolMax', '20')">Top20</button>
      <button type="button" class="chip-btn" :class="{ active: topPoolMax === '50' }" @click="emit('update:topPoolMax', '50')">Top50</button>
      <span class="new-pool-hint">{{ newPoolRulesText }}</span>
    </div>

    <div v-if="isSettledMode" class="filter-panel settled-date-panel">
      <div class="filter-body settled-body">
        <div class="filter-row">
          <span class="label">日期</span>
          <button type="button" class="chip-btn" :class="{ active: settledDate === 'all' }" @click="emit('update:settledDate', 'all')">全部</button>
          <button
            v-for="d in availableSettledDates.slice(0, 8)"
            :key="d.date"
            type="button"
            class="chip-btn"
            :class="{ active: settledDate === d.date }"
            @click="emit('update:settledDate', d.date)"
          >{{ d.date.slice(5) }}·{{ d.count }}</button>
          <input
            class="date-input"
            type="date"
            :value="settledDate !== 'all' ? settledDate : ''"
            @change="emit('update:settledDate', $event.target.value || 'all')"
          />
        </div>
        <div class="filter-row">
          <span class="label">盈亏</span>
          <button type="button" class="chip-btn" :class="{ active: settledPnlMark === 'all' }" @click="emit('update:settledPnlMark', 'all')">全部</button>
          <button type="button" class="chip-btn" :class="{ active: settledPnlMark === 'bet' }" @click="emit('update:settledPnlMark', 'bet')">有投注</button>
          <button type="button" class="chip-btn" :class="{ active: settledPnlMark === 'win' }" @click="emit('update:settledPnlMark', 'win')">盈利</button>
          <button type="button" class="chip-btn" :class="{ active: settledPnlMark === 'loss' }" @click="emit('update:settledPnlMark', 'loss')">亏损</button>
        </div>
      </div>
    </div>

    <div v-if="showFilters && !isPrematchMode && !isInplayMode && !isSettledMode && !isMixMode" class="filter-panel">
      <button type="button" class="filter-toggle" @click="emit('update:filtersOpen', !filtersOpen)">
        <span class="filter-toggle-main">
          <span class="filter-toggle-title">筛选</span>
          <span class="filter-toggle-summary">{{ filterSummary }}</span>
        </span>
        <span class="filter-toggle-arrow" :class="{ open: filtersOpen }">▾</span>
      </button>

      <div v-show="filtersOpen" class="filter-body">
        <div v-if="!isInplayMode && !isPrematchMode && !isSettledMode && !isMixMode" class="filters">
          <button type="button" :class="{ active: filter === 'all' }" @click="setStatusFilter('all')">全部</button>
          <button type="button" :class="{ active: filter === 'Not started' }" @click="setStatusFilter('Not started')">未开始</button>
          <button type="button" :class="{ active: filter === 'liveish' }" @click="setStatusFilter('liveish')">进行中</button>
          <button v-if="!hideEndedEvents" type="button" :class="{ active: filter === 'ended' }" @click="setStatusFilter('ended')">已结束</button>
        </div>

        <div class="filter-row">
          <span class="label">巡回</span>
          <button type="button" class="chip-btn" :class="{ active: tour === 'all' }" @click="emit('update:tour', 'all')">全部</button>
          <button type="button" class="chip-btn" :class="{ active: tour === 'ATP' }" @click="emit('update:tour', 'ATP')">男</button>
          <button type="button" class="chip-btn" :class="{ active: tour === 'WTA' }" @click="emit('update:tour', 'WTA')">女</button>
        </div>

        <div class="filter-row">
          <span class="label">PM</span>
          <button type="button" class="chip-btn" :class="{ active: pmFilter === 'all' }" @click="emit('update:pmFilter', 'all')">全部</button>
          <button type="button" class="chip-btn" :class="{ active: pmFilter === 'yes' }" @click="emit('update:pmFilter', 'yes')">有外链</button>
          <button type="button" class="chip-btn" :class="{ active: pmFilter === 'no' }" @click="emit('update:pmFilter', 'no')">无外链</button>
        </div>

        <template v-if="classicRankFiltersOn">
          <div class="filter-row">
            <span class="label">现差</span>
            <button type="button" class="chip-btn" :class="{ active: gapMin === 'all' }" @click="emit('update:gapMin', 'all')">不限</button>
            <button type="button" class="chip-btn" :class="{ active: gapMin === '50' }" @click="emit('update:gapMin', '50')">≥50</button>
            <button type="button" class="chip-btn" :class="{ active: gapMin === '70' }" @click="emit('update:gapMin', '70')">≥70</button>
            <button type="button" class="chip-btn" :class="{ active: gapMin === '90' }" @click="emit('update:gapMin', '90')">≥90</button>
          </div>

          <div class="filter-row">
            <span class="label">排差</span>
            <button type="button" class="chip-btn" :class="{ active: diffMax === 'all' }" @click="emit('update:diffMax', 'all')">不限</button>
            <button type="button" class="chip-btn" :class="{ active: diffMax === '0' }" @click="emit('update:diffMax', '0')">&lt;0</button>
            <button type="button" class="chip-btn" :class="{ active: diffMax === '-30' }" @click="emit('update:diffMax', '-30')">≤-30</button>
            <button type="button" class="chip-btn" :class="{ active: diffMax === '-50' }" @click="emit('update:diffMax', '-50')">≤-50</button>
            <button type="button" class="chip-btn" :class="{ active: diffMax === '-70' }" @click="emit('update:diffMax', '-70')">≤-70</button>
          </div>

          <div class="filter-row">
            <span class="label">强现</span>
            <button type="button" class="chip-btn" :class="{ active: strongRankMax === 'all' }" @click="emit('update:strongRankMax', 'all')">不限</button>
            <button type="button" class="chip-btn" :class="{ active: strongRankMax === '10' }" @click="emit('update:strongRankMax', '10')">≤10</button>
            <button type="button" class="chip-btn" :class="{ active: strongRankMax === '20' }" @click="emit('update:strongRankMax', '20')">≤20</button>
            <button type="button" class="chip-btn" :class="{ active: strongRankMax === '50' }" @click="emit('update:strongRankMax', '50')">≤50</button>
            <button type="button" class="chip-btn" :class="{ active: strongRankMax === '100' }" @click="emit('update:strongRankMax', '100')">≤100</button>
          </div>
        </template>
        <div v-else-if="isMember && isRangeMode" class="filter-row range-rules">
          <span class="label">区间</span>
          <span class="range-rules-text">{{ rangeRulesText }}</span>
        </div>
      </div>
    </div>
</template>

<style scoped>
.chip-btn {
  border: 1px solid var(--line);
  background: var(--card);
  color: #64748b;
  border-radius: 999px;
  padding: 6px 12px;
  font-size: 0.82rem;
  font-weight: 600;
  flex-shrink: 0;
  line-height: 1.3;
  cursor: pointer;
}
.chip-btn.active {
  color: var(--primary);
  background: var(--primary-soft);
  border-color: #c7d2fe;
  font-weight: 700;
}
.filters button {
  border: 1px solid var(--line);
  background: var(--card);
  color: #64748b;
  border-radius: 999px;
  padding: 6px 12px;
  font-size: 0.82rem;
  font-weight: 600;
  flex-shrink: 0;
  line-height: 1.3;
  cursor: pointer;
}
.filters button.active {
  color: var(--primary);
  background: var(--primary-soft);
  border-color: #c7d2fe;
  font-weight: 700;
}
.filters { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
.filter-panel {
  margin-bottom: 6px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 10px;
  overflow: hidden;
}
.settled-body {
  display: block !important;
  padding: 8px 10px;
}
.date-input {
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 5px 8px;
  font-size: 0.82rem;
  color: #334155;
  background: #fff;
}
.filter-toggle {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border: 0;
  background: transparent;
  cursor: pointer;
  text-align: left;
}
.filter-toggle-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.filter-toggle-title {
  font-size: 0.8rem;
  font-weight: 700;
  color: #0f172a;
}
.filter-toggle-summary {
  font-size: 0.7rem;
  color: #64748b;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.filter-toggle-arrow {
  color: var(--primary);
  font-size: 0.86rem;
  line-height: 1;
  transition: transform 0.18s ease;
  flex-shrink: 0;
}
.filter-toggle-arrow.open { transform: rotate(180deg); }
.filter-body {
  padding: 0 8px 8px;
  border-top: 1px solid #f1f5f9;
  padding-top: 8px;
}
.filter-row {
  display: flex; flex-wrap: wrap; gap: 4px; align-items: center;
  margin-bottom: 6px;
}
.filter-row:last-child { margin-bottom: 0; }
.filter-row .label {
  color: #64748b; font-size: 0.72rem; font-weight: 600; min-width: 2rem;
}
.range-rules-text {
  flex: 1;
  font-size: 0.72rem;
  line-height: 1.35;
  color: #475569;
  font-weight: 600;
}
.new-pool-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  margin-bottom: 8px;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
}
.new-pool-bar .label {
  color: #64748b;
  font-size: 0.72rem;
  font-weight: 600;
  min-width: 2.5rem;
}
.new-pool-hint {
  flex: 1 1 160px;
  font-size: 0.68rem;
  color: #94a3b8;
  line-height: 1.35;
}
</style>
