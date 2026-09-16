<script setup>
defineProps({
  m: { type: Object, required: true },
  allowBatchTrade: { type: Boolean, default: false },
  autoPlacedIds: { type: Object, default: () => new Set() },
  isMember: { type: Boolean, default: false },
  isNewMode: { type: Boolean, default: false },
  isInplayMode: { type: Boolean, default: false },
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
})
</script>

<template>
<article
        class="row-card"
        :class="{ selected: isSelected(m), selectable: canSelectMatch(m) }"
      >
        <label v-if="allowBatchTrade" class="row-check" :class="{ disabled: !canSelectMatch(m) }">
          <input
            type="checkbox"
            :checked="isSelected(m)"
            :disabled="!canSelectMatch(m)"
            @change="toggleSelect(m)"
          />
        </label>
        <span
          v-if="allowBatchTrade && autoPlacedIds.has(String(m.id))"
          class="placed-badge"
          title="本列表已下单，不再重复下单"
        >已下</span>
        <div class="row-body">
        <div class="row-time">
          <span class="start-value" :class="{ today: isStartSameDay(m.startTimestamp) }">{{ fmtTime(m.startTimestamp) }}</span>
          <span class="start-status" :class="{ live: isMatchLive(m) }">{{ statusText(m) }}</span>
          <span class="tour-title">{{ matchTourTitle(m) }}</span>
          <div class="badges">
            <span class="badge" :class="matchGenderClass(m)">{{ matchGenderLabel(m) }}</span>
            <span class="badge level">{{ matchLevelLabel(m) }}</span>
            <span v-if="isMember && oddsOf(m.id)?.full_time" class="badge odds">报</span>
            <span v-if="isMember && polyOf(m.id)?.url" class="badge poly">外</span>
            <span v-if="isMember && isNewMode && gapInfo(m).ready" class="badge live-tier">{{ gapInfo(m).tier }}</span>
            <span
              v-if="isInplayMode && gapInfo(m).ready"
              class="badge live-tier"
              :title="`现差 ${gapInfo(m).gap} · 需≥${gapInfo(m).minGap}`"
            >{{ gapInfo(m).tier }} · 差{{ gapInfo(m).gap }}</span>
            <span
              v-if="settledPnlBadge(m)"
              class="badge"
              :class="settledPnlBadge(m).cls"
            >{{ settledPnlBadge(m).text }}</span>
          </div>
        </div>
        <div class="row-main">
          <div v-if="isMatchLive(m)" class="matchup is-live-board">
            <div class="matchup-line">
              <span class="name live-player-top" :class="{ pick: isMember && pickSide(m) === 'home', 'live-side': true }">
                <span v-if="isMember && listRankOf(m, 'home') != null" class="list-rank">#{{ listRankOf(m, 'home') }}</span>
                <span class="player-name">{{ matchHomeName(m) }}</span>
                <span v-if="isMember && pickSide(m) === 'home'" class="pick-tag">优</span>
              </span>
              <div class="live-set-scores" aria-label="主队盘分">
                <span
                  v-for="(cell, idx) in liveSetCells(m, 'home')"
                  :key="'h' + idx"
                  class="set-cell"
                  :class="cell.cls"
                >{{ cell.text }}</span>
                <span v-if="livePointText(m, 'home')" class="live-point">{{ livePointText(m, 'home') }}</span>
              </div>
            </div>
            <span class="vs-row">VS</span>
            <div class="matchup-line">
              <span class="name live-player-bottom" :class="{ pick: isMember && pickSide(m) === 'away', 'live-side': true }">
                <span v-if="isMember && listRankOf(m, 'away') != null" class="list-rank">#{{ listRankOf(m, 'away') }}</span>
                <span class="player-name">{{ matchAwayName(m) }}</span>
                <span v-if="isMember && pickSide(m) === 'away'" class="pick-tag">优</span>
              </span>
              <div class="live-set-scores" aria-label="客队盘分">
                <span
                  v-for="(cell, idx) in liveSetCells(m, 'away')"
                  :key="'a' + idx"
                  class="set-cell"
                  :class="cell.cls"
                >{{ cell.text }}</span>
                <span v-if="livePointText(m, 'away')" class="live-point">{{ livePointText(m, 'away') }}</span>
              </div>
            </div>
          </div>
          <div v-else class="matchup is-stacked">
            <div class="matchup-line">
              <span class="name" :class="{ pick: isMember && pickSide(m) === 'home' }">
                <span v-if="isMember && listRankOf(m, 'home') != null" class="list-rank">#{{ listRankOf(m, 'home') }}</span>
                <span class="player-name">{{ matchHomeName(m) }}</span>
                <span v-if="isMember && pickSide(m) === 'home'" class="pick-tag">优</span>
              </span>
            </div>
            <span class="vs-row">VS</span>
            <div class="matchup-line">
              <span class="name" :class="{ pick: isMember && pickSide(m) === 'away' }">
                <span v-if="isMember && listRankOf(m, 'away') != null" class="list-rank">#{{ listRankOf(m, 'away') }}</span>
                <span class="player-name">{{ matchAwayName(m) }}</span>
                <span v-if="isMember && pickSide(m) === 'away'" class="pick-tag">优</span>
              </span>
            </div>
          </div>
          <div v-if="isMember" class="row-actions">
            <button type="button" class="act-btn" @click="openDetail(m)">详情</button>
            <button
              type="button"
              class="act-btn market"
              :disabled="!polyUrlOf(m)"
              :title="polyUrlOf(m) ? '打开关联页' : '暂无对应外链'"
              @click="openMarket(m)"
            >外链</button>
          </div>
        </div>
        </div>
      </article>
</template>

<style scoped>
.badge.live-tier { background: #f5f3ff; color: #6d28d9; border: 1px solid #ddd6fe; }
.badge.live-tier.ok { background: #ecfdf5; color: #047857; border-color: #bbf7d0; }
.badge.live-tier.warn { background: #fff7ed; color: #c2410c; border-color: #fed7aa; }
.badges { display: flex; flex-wrap: wrap; gap: 4px; }
.badge {
  border-radius: 999px; padding: 3px 8px;
  font-size: 0.76rem; font-weight: 700; line-height: 1.35;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.badge.gender-m { background: #eef2ff; color: #4338ca; }
.badge.gender-f { background: #fdf2f8; color: #be185d; }
.badge.level { background: #f0fdf4; color: #15803d; }
.badge.odds { background: #fffbeb; color: #b45309; }
.badge.poly { background: #f5f3ff; color: #6d28d9; }
.badge.pnl-win { background: #ecfdf5; color: #047857; }
.badge.pnl-loss { background: #fef2f2; color: #b91c1c; }
.badge.pnl-flat { background: #f8fafc; color: #64748b; }
.badge.pnl-bet { background: #eff6ff; color: #1d4ed8; }
.badge.pick { background: var(--primary); color: #fff; }
.row-card {
  background: var(--card);
  border: 1px solid #f1f5f9;
  border-radius: 10px;
  padding: 6px 8px;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  gap: 6px;
}
.row-card.selected {
  border-color: #c7d2fe;
  background: #fafaff;
  box-shadow: 0 0 0 1px rgba(79, 70, 229, 0.12);
}
.row-check {
  flex-shrink: 0;
  padding-top: 2px;
  cursor: pointer;
  display: flex;
  align-items: flex-start;
}
.row-check.disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.row-check input {
  width: 16px;
  height: 16px;
  accent-color: var(--primary);
  cursor: inherit;
}
.placed-badge {
  flex-shrink: 0;
  margin-top: 1px;
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: #b45309;
  background: #fffbeb;
  border: 1px solid #fde68a;
}
.row-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.row-time {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 6px;
  padding-bottom: 4px;
  border-bottom: 1px solid #f1f5f9;
}
.row-time .start-value {
  color: #0f172a;
  font-size: 0.84rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.row-time .start-value.today {
  color: #dc2626;
}
.row-time .start-status {
  color: #64748b;
  font-size: 0.7rem;
  font-weight: 600;
}
.row-time .start-status.live {
  color: var(--success);
  font-weight: 700;
}
.row-time .tour-title {
  color: #64748b;
  font-size: 0.7rem;
  font-weight: 600;
  line-height: 1.3;
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-main {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.matchup {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 6px;
  min-width: 0;
  flex: 1;
}
.matchup.is-live-board,
.matchup.is-stacked {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 1px;
  flex: 1;
  min-width: 0;
}
.matchup-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
}
.matchup.is-stacked .matchup-line {
  justify-content: flex-start;
}
.vs-row {
  color: var(--muted);
  font-size: 0.72rem;
  font-weight: 800;
  line-height: 1.1;
  padding: 1px 0;
  flex-shrink: 0;
}
.matchup.is-live-board .name {
  min-width: 0;
  flex: 1;
  text-align: left;
  justify-content: flex-start;
  padding: 0;
  margin: 0;
}
.matchup.is-live-board .live-player-top,
.matchup.is-live-board .live-player-bottom {
  width: auto;
  max-width: 100%;
}
.live-set-scores {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  padding: 0 2px;
  flex-shrink: 0;
}
.live-set-scores .set-cell {
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
  min-width: 0.9rem;
  text-align: center;
}
.live-set-scores .score-big {
  color: #2563eb;
  font-size: 0.95rem;
  font-weight: 800;
}
.live-set-scores .score-small {
  color: #dc2626;
  font-size: 0.78rem;
  font-weight: 700;
}
.live-set-scores .score-even {
  color: #334155;
  font-size: 0.86rem;
  font-weight: 700;
}
.live-set-scores .live-point {
  margin-left: 2px;
  padding-left: 5px;
  border-left: 1px solid #e2e8f0;
  color: #0f172a;
  font-size: 0.82rem;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}
.matchup.is-stacked .name {
  min-width: 0;
  flex-wrap: wrap;
  white-space: normal;
}
.matchup.is-stacked .player-name {
  min-width: 0;
}
.matchup.is-live .player-row.live-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.matchup.is-live .player-row.live-line .name {
  flex: 1;
  min-width: 0;
}
.matchup .name .player-score,
.matchup .player-row .player-score {
  margin-left: 5px;
  flex-shrink: 0;
  font-size: 0.82rem;
  font-weight: 800;
  color: #334155;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.04em;
}
.matchup.is-live .player-row.live-line .player-score {
  margin-left: 0;
  text-align: right;
  white-space: nowrap;
}
.matchup .name {
  font-size: 0.96rem;
  font-weight: 700;
  color: #0f172a;
  line-height: 1.3;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.matchup .name.pick { color: var(--primary); }
.list-rank {
  color: #64748b;
  font-size: 0.72rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.pick-tag {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: 1px 5px;
  font-size: 0.6rem;
  font-weight: 700;
  line-height: 1.35;
  color: #fff;
  background: var(--primary);
}
.matchup .vs-text {
  color: var(--muted);
  font-size: 0.7rem;
  font-weight: 600;
  flex-shrink: 0;
}
.row-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
  align-items: center;
}
.act-btn {
  border: 1px solid #c7d2fe;
  background: var(--primary-soft);
  color: var(--primary);
  border-radius: 8px;
  padding: 7px 11px;
  font-size: 0.8rem;
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
.act-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
