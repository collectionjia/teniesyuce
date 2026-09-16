<script setup>
import TennisBoardMatchRow from './TennisBoardMatchRow.vue'

defineProps({
  loading: { type: Boolean, default: false },
  data: { type: Object, default: null },
  error: { type: String, default: '' },
  matches: { type: Array, default: () => [] },
  isInplayMode: { type: Boolean, default: false },
  stats: { type: Object, required: true },
  bundleHint: { type: String, default: '' },
  allowBatchTrade: { type: Boolean, default: false },
  paginatedMatches: { type: Array, default: () => [] },
  autoPlacedIds: { type: Object, default: () => new Set() },
  isMember: { type: Boolean, default: false },
  isNewMode: { type: Boolean, default: false },
  isSelected: { type: Function, required: true },
  canSelectMatch: { type: Function, required: true },
  toggleSelect: { type: Function, required: true },
  isStartSameDay: { type: Function, required: true },
  fmtTime: { type: Function, required: true },
  statusText: { type: Function, required: true },
  matchTourTitle: { type: Function, required: true },
  matchGenderClass: { type: Function, required: true },
  matchGenderLabel: { type: Function, required: true },
  matchLevelLabel: { type: Function, required: true },
  oddsOf: { type: Function, required: true },
  polyOf: { type: Function, required: true },
  gapInfo: { type: Function, required: true },
  settledPnlBadge: { type: Function, required: true },
  isMatchLive: { type: Function, required: true },
  pickSide: { type: Function, required: true },
  listRankOf: { type: Function, required: true },
  matchHomeName: { type: Function, required: true },
  matchAwayName: { type: Function, required: true },
  liveSetCells: { type: Function, required: true },
  livePointText: { type: Function, required: true },
  openDetail: { type: Function, required: true },
  openMarket: { type: Function, required: true },
  polyUrlOf: { type: Function, required: true },
  totalPages: { type: Number, default: 1 },
  currentPage: { type: Number, default: 1 },
  goPage: { type: Function, required: true },
})
</script>

<template>
  <div v-if="loading && !data" class="empty">加载赛程中…</div>
  <div v-else-if="error && !data" class="empty err">{{ error }}</div>
  <template v-else>
    <!-- 无赛事也保留自动投注 / 金额 / 批量，便于提前打开开关 -->
    <slot name="batch" />

    <div v-if="!matches.length && !isInplayMode" class="empty">
      当前筛选下没有场次（池内 {{ stats.total }} 场 · 符合筛选 {{ stats.shown }} 场）
      <div v-if="bundleHint" class="hint">{{ bundleHint }}</div>
    </div>
    <div v-else-if="!matches.length && isInplayMode" class="empty" role="status">
      暂无数据
    </div>

    <template v-else>
      <div class="list">
        <TennisBoardMatchRow
          v-for="m in paginatedMatches"
          :key="m.id"
          :m="m"
          :allow-batch-trade="allowBatchTrade"
          :auto-placed-ids="autoPlacedIds"
          :is-member="isMember"
          :is-new-mode="isNewMode"
          :is-inplay-mode="isInplayMode"
          :is-selected="isSelected"
          :can-select-match="canSelectMatch"
          :toggle-select="toggleSelect"
          :is-start-same-day="isStartSameDay"
          :fmt-time="fmtTime"
          :status-text="statusText"
          :match-tour-title="matchTourTitle"
          :match-gender-class="matchGenderClass"
          :match-gender-label="matchGenderLabel"
          :match-level-label="matchLevelLabel"
          :odds-of="oddsOf"
          :poly-of="polyOf"
          :gap-info="gapInfo"
          :settled-pnl-badge="settledPnlBadge"
          :is-match-live="isMatchLive"
          :pick-side="pickSide"
          :list-rank-of="listRankOf"
          :match-home-name="matchHomeName"
          :match-away-name="matchAwayName"
          :live-set-cells="liveSetCells"
          :live-point-text="livePointText"
          :open-detail="openDetail"
          :open-market="openMarket"
          :poly-url-of="polyUrlOf"
        />
      </div>

      <div v-if="totalPages > 1" class="pager">
        <button type="button" class="pager-btn" :disabled="currentPage <= 1" @click="goPage(currentPage - 1)">上一页</button>
        <span class="pager-info">第 {{ currentPage }} / {{ totalPages }} 页</span>
        <button type="button" class="pager-btn" :disabled="currentPage >= totalPages" @click="goPage(currentPage + 1)">下一页</button>
      </div>
    </template>
  </template>
</template>

<style scoped>
.list { display: grid; gap: 5px; }
.pager {
  display: flex; align-items: center; justify-content: center; gap: 8px;
  margin-top: 8px; padding-top: 8px; border-top: 1px solid #f1f5f9;
}
.pager-info {
  color: #64748b; font-size: 0.76rem; font-weight: 600;
  min-width: 5.5em; text-align: center;
}
.pager-btn {
  border: 1px solid var(--line);
  background: var(--card);
  color: #475569;
  border-radius: 8px;
  padding: 7px 14px;
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
}
.pager-btn:hover:not(:disabled) {
  border-color: #c7d2fe;
  color: var(--primary);
  background: var(--primary-soft);
}
.pager-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.empty {
  text-align: center; color: var(--muted);
  padding: 16px 8px; font-size: 0.86rem;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 10px;
}
.empty.err { color: var(--danger); }
.empty .hint { margin-top: 6px; font-size: 0.68rem; opacity: 0.85; }
.empty.inplay-empty {
  border-color: #fed7aa;
  background: #fff7ed;
  color: #9a3412;
}
.empty.inplay-empty .inplay-empty-inline {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-weight: 700;
  font-size: 0.92rem;
}
.empty.inplay-empty .bang {
  width: 1.35rem;
  height: 1.35rem;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 800;
  font-size: 0.85rem;
  line-height: 1;
  color: #fff;
  background: #ea580c;
}
.empty.inplay-empty .hint {
  margin-top: 8px;
  color: #9a3412;
  opacity: 0.95;
  font-size: 0.74rem;
  line-height: 1.45;
  max-width: 28rem;
  margin-left: auto;
  margin-right: auto;
}
</style>
