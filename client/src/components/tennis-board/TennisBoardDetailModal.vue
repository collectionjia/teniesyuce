<script setup>
defineProps({
  detailMatch: { type: Object, default: null },
  detailHelpOpen: { type: Boolean, default: false },
  detailTips: { type: Array, default: () => [] },
  isInplayMode: { type: Boolean, default: false },
  isSettledMode: { type: Boolean, default: false },
  isRangeMode: { type: Boolean, default: false },
  isNewMode: { type: Boolean, default: false },
  shortName: { type: Function, required: true },
  matchHomeName: { type: Function, required: true },
  matchAwayName: { type: Function, required: true },
  isStartSameDay: { type: Function, required: true },
  fmtTime: { type: Function, required: true },
  statusText: { type: Function, required: true },
  matchLevelLabel: { type: Function, required: true },
  oddsOf: { type: Function, required: true },
  polyOf: { type: Function, required: true },
  gapInfo: { type: Function, required: true },
  pickSide: { type: Function, required: true },
  matchWinnerSide: { type: Function, default: () => null },
  toggleDetailHelp: { type: Function, required: true },
  closeDetail: { type: Function, required: true },
  rankText: { type: Function, required: true },
  currentRankOf: { type: Function, required: true },
  playerLiveScoreText: { type: Function, required: true },
  playerNameWithAge: { type: Function, required: true },
  eloOf: { type: Function, required: true },
  rankDetailOf: { type: Function, required: true },
  fmtEdge: { type: Function, required: true },
  fmtOdds: { type: Function, required: true },
  oddsSourceLabel: { type: Function, required: true },
  polySideCents: { type: Function, required: true },
  polyUrlOf: { type: Function, required: true },
  openMarket: { type: Function, required: true },
  onPolymarketAction: { type: Function, default: null },
  collectUpdatedText: { type: String, default: '' },
  collectRefreshing: { type: Boolean, default: false },
})
</script>

<template>
<Teleport to="body">
      <div v-if="detailMatch" class="modal-mask" @click.self="closeDetail">
        <div class="modal-sheet" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div class="modal-head-main">
              <div class="modal-title">详情</div>
              <div class="modal-sub">
                {{ shortName(matchHomeName(detailMatch)) }} vs {{ shortName(matchAwayName(detailMatch)) }}
              </div>
              <div class="modal-meta">
                <span>{{ (detailMatch.tournamentShort || detailMatch.tournament || '').replace(/,.*/, '') }}</span>
                <template v-if="detailMatch.roundLabel"> · {{ detailMatch.roundLabel }}</template>
                · <span :class="{ today: isStartSameDay(detailMatch.startTimestamp) }">{{ fmtTime(detailMatch.startTimestamp) }}</span>
                · {{ statusText(detailMatch) }}
                <template v-if="detailMatch.groundLabel"> · {{ detailMatch.groundLabel }}</template>
              </div>
              <div class="badges modal-badges">
                <span
                  class="badge"
                  :class="(detailMatch.gender || detailMatch.homePlayer?.gender || detailMatch.awayPlayer?.gender) === 'F' ? 'gender-f' : 'gender-m'"
                >{{ (detailMatch.gender || detailMatch.homePlayer?.gender || detailMatch.awayPlayer?.gender) === 'F' ? '女' : '男' }}</span>
                <span class="badge level">{{ matchLevelLabel(detailMatch) }}</span>
                <span v-if="oddsOf(detailMatch.id)?.full_time" class="badge odds">报</span>
                <span v-if="polyOf(detailMatch.id)?.url" class="badge poly">外</span>
                <span
                  v-if="isInplayMode && gapInfo(detailMatch).ready"
                  class="badge live-tier"
                >{{ gapInfo(detailMatch).tier }} · 差{{ gapInfo(detailMatch).gap }}</span>
                <span
                  v-if="isSettledMode && pickSide(detailMatch)"
                  class="badge pick"
                >荐{{ pickSide(detailMatch) === 'home' ? shortName(matchHomeName(detailMatch)) : shortName(matchAwayName(detailMatch)) }}</span>
                <span
                  v-else-if="pickSide(detailMatch)"
                  class="badge pick"
                >优{{ pickSide(detailMatch) === 'home' ? shortName(matchHomeName(detailMatch)) : shortName(matchAwayName(detailMatch)) }}</span>
                <span
                  v-if="isSettledMode && matchWinnerSide(detailMatch)"
                  class="badge win"
                >赢{{ matchWinnerSide(detailMatch) === 'home' ? shortName(matchHomeName(detailMatch)) : shortName(matchAwayName(detailMatch)) }}</span>
              </div>
            </div>
            <div class="modal-head-actions">
              <button
                type="button"
                class="help-bang modal-help-bang"
                :class="{ on: detailHelpOpen }"
                title="字段说明"
                aria-label="字段说明"
                @click="toggleDetailHelp($event)"
              >!</button>
              <button type="button" class="modal-x" @click="closeDetail" aria-label="关闭">×</button>
            </div>
          </div>

          <div v-if="detailHelpOpen" class="modal-help-panel">
            <div class="modal-help-title">字段说明</div>
            <ul class="modal-help-list">
              <li v-for="item in detailTips" :key="item.k">
                <b>{{ item.k }}</b>：{{ item.t }}
              </li>
            </ul>
          </div>

          <div class="modal-body">
            <div class="duel">
              <div
                class="duel-side"
                :class="{
                  pick: pickSide(detailMatch) === 'home',
                  winner: isSettledMode && matchWinnerSide(detailMatch) === 'home',
                }"
              >
                <div class="duel-top">
                  <span class="duel-rank">
                    #{{ rankText(currentRankOf(detailMatch.homePlayer || { name: detailMatch.home })) }}<span
                      v-if="rankDetailOf(detailMatch.homePlayer || {}, detailMatch).best != null"
                      class="duel-best"
                      :class="{ up: Number(rankDetailOf(detailMatch.homePlayer || {}, detailMatch).best) < Number(currentRankOf(detailMatch.homePlayer || { name: detailMatch.home })) }"
                    >({{ rankText(rankDetailOf(detailMatch.homePlayer || {}, detailMatch).best) }})</span>
                  </span>
                  <span class="duel-score" v-if="playerLiveScoreText(detailMatch, 'home')">{{ playerLiveScoreText(detailMatch, 'home') }}</span>
                </div>
                <div class="duel-name">
                  {{ playerNameWithAge(detailMatch.homePlayer || { name: detailMatch.home }, eloOf(detailMatch.id)?.home) }}
                  <span v-if="isSettledMode && pickSide(detailMatch) === 'home'" class="pick-tag">荐</span>
                  <span v-else-if="pickSide(detailMatch) === 'home'" class="pick-tag">优</span>
                  <span v-if="isSettledMode && matchWinnerSide(detailMatch) === 'home'" class="win-tag">赢</span>
                </div>
                <div class="duel-sub">
                  周{{ rankText(rankDetailOf(detailMatch.homePlayer || {}, detailMatch).previous) }}
                  · L{{ rankText(rankDetailOf(detailMatch.homePlayer || {}, detailMatch).live) }}
                  · U{{ rankText(rankDetailOf(detailMatch.homePlayer || {}, detailMatch).utr) }}
                </div>
              </div>
              <div class="duel-vs">VS</div>
              <div
                class="duel-side"
                :class="{
                  pick: pickSide(detailMatch) === 'away',
                  winner: isSettledMode && matchWinnerSide(detailMatch) === 'away',
                }"
              >
                <div class="duel-top">
                  <span class="duel-rank">
                    #{{ rankText(currentRankOf(detailMatch.awayPlayer || { name: detailMatch.away })) }}<span
                      v-if="rankDetailOf(detailMatch.awayPlayer || {}, detailMatch).best != null"
                      class="duel-best"
                      :class="{ up: Number(rankDetailOf(detailMatch.awayPlayer || {}, detailMatch).best) < Number(currentRankOf(detailMatch.awayPlayer || { name: detailMatch.away })) }"
                    >({{ rankText(rankDetailOf(detailMatch.awayPlayer || {}, detailMatch).best) }})</span>
                  </span>
                  <span class="duel-score" v-if="playerLiveScoreText(detailMatch, 'away')">{{ playerLiveScoreText(detailMatch, 'away') }}</span>
                </div>
                <div class="duel-name">
                  {{ playerNameWithAge(detailMatch.awayPlayer || { name: detailMatch.away }, eloOf(detailMatch.id)?.away) }}
                  <span v-if="isSettledMode && pickSide(detailMatch) === 'away'" class="pick-tag">荐</span>
                  <span v-else-if="pickSide(detailMatch) === 'away'" class="pick-tag">优</span>
                  <span v-if="isSettledMode && matchWinnerSide(detailMatch) === 'away'" class="win-tag">赢</span>
                </div>
                <div class="duel-sub">
                  周{{ rankText(rankDetailOf(detailMatch.awayPlayer || {}, detailMatch).previous) }}
                  · L{{ rankText(rankDetailOf(detailMatch.awayPlayer || {}, detailMatch).live) }}
                  · U{{ rankText(rankDetailOf(detailMatch.awayPlayer || {}, detailMatch).utr) }}
                </div>
              </div>
            </div>

            <div class="kv-grid">
              <template v-if="gapInfo(detailMatch).ready">
                <div class="kv" v-if="isRangeMode || isNewMode || isInplayMode">
                  <span class="k">{{ isInplayMode ? '盘中档' : (isNewMode ? '档位' : '区间') }}</span>
                  <span class="v">{{ gapInfo(detailMatch).tier }}</span>
                  <span class="s">现差 {{ gapInfo(detailMatch).gap }} · 需≥{{ gapInfo(detailMatch).minGap }}</span>
                </div>
                <template v-else>
                  <div class="kv">
                    <span class="k">现排名差</span>
                    <span class="v rank-curr">{{ gapInfo(detailMatch).gap }}</span>
                    <span class="s">{{ rankText(gapInfo(detailMatch).weakNow) }}−{{ rankText(gapInfo(detailMatch).strongNow) }} · {{ gapInfo(detailMatch).better }}高</span>
                  </div>
                  <div class="kv" v-if="gapInfo(detailMatch).rankDiff != null">
                    <span class="k">排差</span>
                    <span class="v rank-best">{{ gapInfo(detailMatch).rankDiff }}</span>
                    <span class="s">强现 {{ rankText(gapInfo(detailMatch).strongNow) }} − 现弱历史最高 {{ rankText(gapInfo(detailMatch).weakBest) }}</span>
                  </div>
                  <div class="kv" v-else>
                    <span class="k">排差</span>
                    <span class="v muted">—</span>
                    <span class="s">缺历史最高排名</span>
                  </div>
                </template>
              </template>
              <div class="kv" v-else>
                <span class="k">现排名差</span>
                <span class="v muted">—</span>
                <span class="s">暂无现排名</span>
              </div>

              <template v-if="eloOf(detailMatch.id)?.ok">
                <div class="kv wide">
                  <span class="k">Elo</span>
                  <span class="v">
                    <template v-if="eloOf(detailMatch.id).best?.edge_pct == null">
                      {{ eloOf(detailMatch.id).best?.short || '—' }} {{ eloOf(detailMatch.id).best?.win_pct ?? '—' }}%
                    </template>
                    <template v-else>
                      {{ eloOf(detailMatch.id).best?.short || '—' }}
                      <span :class="eloOf(detailMatch.id).best.edge_pct >= 0 ? 'pos' : 'neg'">{{ fmtEdge(eloOf(detailMatch.id).best.edge_pct) }}</span>
                    </template>
                  </span>
                  <span class="s">
                    {{ eloOf(detailMatch.id).home?.short || '主' }} {{ eloOf(detailMatch.id).home?.win_pct ?? '—' }}%
                    <span :class="(eloOf(detailMatch.id).home?.edge_pct ?? 0) >= 0 ? 'pos' : 'neg'">{{ fmtEdge(eloOf(detailMatch.id).home?.edge_pct) }}</span>
                    ·
                    {{ eloOf(detailMatch.id).away?.short || '客' }} {{ eloOf(detailMatch.id).away?.win_pct ?? '—' }}%
                    <span :class="(eloOf(detailMatch.id).away?.edge_pct ?? 0) >= 0 ? 'pos' : 'neg'">{{ fmtEdge(eloOf(detailMatch.id).away?.edge_pct) }}</span>
                    · {{ eloOf(detailMatch.id).ratingSource || eloOf(detailMatch.id).surface || 'elo' }}
                  </span>
                </div>
              </template>
              <div class="kv wide" v-else>
                <span class="k">Elo</span>
                <span class="v muted">—</span>
                <span class="s">未匹配 Tennis Abstract</span>
              </div>

              <div class="kv" v-if="oddsOf(detailMatch.id)?.full_time">
                <span class="k">报价</span>
                <div class="kv-lines">
                  <div class="kv-line">
                    <span class="n">{{ shortName(matchHomeName(detailMatch)) }}</span>
                    <span class="num">{{ fmtOdds(oddsOf(detailMatch.id).full_time.home) }}</span>
                  </div>
                  <div class="kv-line">
                    <span class="n">{{ shortName(matchAwayName(detailMatch)) }}</span>
                    <span class="num">{{ fmtOdds(oddsOf(detailMatch.id).full_time.away) }}</span>
                  </div>
                </div>
                <span v-if="oddsSourceLabel(detailMatch.id)" class="s">{{ oddsSourceLabel(detailMatch.id) }}</span>
              </div>

              <div class="kv" v-if="polyOf(detailMatch.id)?.url">
                <span class="k">polymarket赔率</span>
                <div class="kv-lines">
                  <div class="kv-line">
                    <span class="n">{{ shortName(matchHomeName(detailMatch)) }}</span>
                    <span class="num">{{ polySideCents(polyOf(detailMatch.id), matchHomeName(detailMatch), matchAwayName(detailMatch)).home == null ? '—' : polySideCents(polyOf(detailMatch.id), matchHomeName(detailMatch), matchAwayName(detailMatch)).home }}</span>
                  </div>
                  <div class="kv-line">
                    <span class="n">{{ shortName(matchAwayName(detailMatch)) }}</span>
                    <span class="num">{{ polySideCents(polyOf(detailMatch.id), matchHomeName(detailMatch), matchAwayName(detailMatch)).away == null ? '—' : polySideCents(polyOf(detailMatch.id), matchHomeName(detailMatch), matchAwayName(detailMatch)).away }}</span>
                  </div>
                </div>
                <span class="s">
                  {{ polyOf(detailMatch.id)?.closed ? '已结算 · 隐含占比' : '隐含占比' }}
                  <template v-if="isInplayMode && collectUpdatedText"> · 更新 {{ collectUpdatedText }}</template>
                </span>
              </div>
            </div>
          </div>

          <div class="modal-foot">
            <button type="button" class="act-btn" @click="closeDetail">关闭</button>
            <button
              type="button"
              class="act-btn market"
              :disabled="!polyUrlOf(detailMatch)"
              :title="polyUrlOf(detailMatch) ? '打开 Polymarket' : '暂无对应外链'"
              @click="(onPolymarketAction || openMarket)(detailMatch)"
            >{{ collectRefreshing && isInplayMode ? '刷新中…' : 'polymarket赔率' }}</button>
          </div>
        </div>
      </div>
    </Teleport>
</template>

<style scoped>
.modal-mask {
  --bg: #f8fafc; --card: #ffffff; --card-2: #f1f5f9; --line: #e2e8f0;
  --text: #1e293b; --muted: #94a3b8; --primary: #4f46e5; --primary-soft: #eef2ff;
  --success: #16a34a; --warning: #d97706; --danger: #dc2626; --pink: #db2777;
}
.modal-mask {
  position: fixed;
  inset: 0;
  z-index: 80;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding: 8px;
}
.modal-mask--top {
  align-items: flex-start;
  padding-top: 12px;
}
.modal-sheet {
  width: 100%;
  max-width: 26rem;
  max-height: min(88vh, 720px);
  background: #fff;
  border-radius: 14px 14px 12px 12px;
  box-shadow: 0 16px 40px rgba(15, 23, 42, 0.22);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.modal-mask--top .modal-sheet {
  border-radius: 12px 12px 14px 14px;
}
.rules-modal-sheet {
  max-width: min(36rem, 100%);
  max-height: min(90vh, 820px);
}
.admin-select-section-title {
  margin: 14px 0 8px;
  padding-top: 12px;
  border-top: 1px solid #e2e8f0;
  font-size: 0.8rem;
  font-weight: 600;
  color: #334155;
}
.admin-select-section-title--first {
  margin-top: 0;
  padding-top: 0;
  border-top: none;
}
.admin-buy-preview {
  padding: 10px;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  background: #f8fafc;
}
.admin-buy-detail {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 2px 0 4px;
}
.admin-buy-chip {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  background: #e0f2fe;
  color: #075985;
  font-size: 0.7rem;
  font-weight: 600;
}
.admin-rule-fields--readonly {
  opacity: 0.92;
}
.admin-rule-fields--readonly input,
.admin-rule-fields--readonly select {
  background: #f1f5f9;
  cursor: default;
}
.admin-select-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 10px;
}
.admin-select-row-main {
  display: flex;
  gap: 8px;
  align-items: center;
}
.admin-select-row-main .admin-rule-name {
  flex: 1;
  min-width: 0;
}
.modal-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 12px 10px;
  border-bottom: 1px solid #f1f5f9;
}
.modal-head-main { min-width: 0; flex: 1; }
.modal-head-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.modal-title { font-size: 0.92rem; font-weight: 800; color: #0f172a; line-height: 1.2; }
.modal-sub { margin-top: 2px; font-size: 0.88rem; font-weight: 700; color: #334155; line-height: 1.3; }
.modal-meta {
  margin-top: 4px; font-size: 0.72rem; color: #64748b; line-height: 1.35;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.modal-meta .today { color: #dc2626; font-weight: 700; }
.modal-badges { margin-top: 6px; justify-content: flex-start; }
.modal-x {
  width: 32px; height: 32px; border: 1px solid var(--line);
  background: #fff; color: #64748b; border-radius: 8px;
  font-size: 1.25rem; line-height: 1; cursor: pointer; flex-shrink: 0;
}
.modal-body {
  padding: 10px 12px 12px;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}
.modal-foot {
  display: flex;
  gap: 8px;
  padding: 10px 12px 12px;
  border-top: 1px solid #f1f5f9;
}
.modal-foot .act-btn {
  flex: 1;
  padding: 10px 10px;
  font-size: 0.86rem;
  border-radius: 8px;
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
.badge.win { background: #ecfdf5; color: #047857; }
.duel {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  gap: 6px;
  align-items: stretch;
  margin-bottom: 10px;
}
.duel-vs {
  align-self: center;
  font-size: 0.72rem;
  font-weight: 800;
  color: var(--muted);
}
.duel-side {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 8px 9px;
  min-width: 0;
}
.duel-side.pick {
  border-color: #c7d2fe;
  background: var(--primary-soft);
}
.duel-side.winner {
  border-color: #a7f3d0;
  background: #ecfdf5;
}
.duel-top {
  display: flex; align-items: center; justify-content: space-between; gap: 4px;
}
.duel-rank {
  font-size: 0.82rem; font-weight: 800; color: #2563eb;
  font-variant-numeric: tabular-nums;
}
.duel-best {
  color: inherit;
  font-weight: 700;
}
.duel-best.up {
  color: #16a34a;
}
.duel-score {
  font-size: 0.8rem; font-weight: 800; color: #0f172a;
  font-variant-numeric: tabular-nums;
}
.duel-name {
  margin-top: 3px;
  font-size: 0.88rem; font-weight: 800; color: #0f172a;
  line-height: 1.25;
  word-break: break-word;
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
}
.duel-side.pick .duel-name { color: #3730a3; }
.duel-side.winner .duel-name { color: #047857; }
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
.win-tag {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: 1px 5px;
  font-size: 0.6rem;
  font-weight: 700;
  line-height: 1.35;
  color: #047857;
  background: #ecfdf5;
  border: 1px solid #a7f3d0;
}
.duel-sub {
  margin-top: 3px;
  font-size: 0.68rem; color: #64748b; line-height: 1.35;
}
.duel-sub .rank-best {
  color: #dc2626;
  font-weight: 700;
}

.kv-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
.kv {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 7px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.kv.wide { grid-column: 1 / -1; }
.kv .k {
  font-size: 0.68rem; font-weight: 700; color: #94a3b8;
  text-transform: uppercase; letter-spacing: 0.02em;
}
.kv .v {
  font-size: 0.86rem; font-weight: 800; color: #0f172a;
  font-variant-numeric: tabular-nums; line-height: 1.3;
  word-break: break-word;
}
.kv .v.warn { color: var(--warning); }
.kv .v.rank-curr { color: #2563eb; }
.kv .v.rank-best { color: #dc2626; }
.kv .v.muted, .kv .s { color: #64748b; }
.kv .s { font-size: 0.68rem; line-height: 1.35; font-weight: 600; }
.kv-lines { display: grid; gap: 3px; margin-top: 1px; }
.kv-line {
  display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
  font-variant-numeric: tabular-nums;
}
.kv-line .n {
  font-size: 0.82rem; font-weight: 700; color: #334155;
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.kv-line .num {
  font-size: 0.88rem; font-weight: 800; color: #0f172a; flex-shrink: 0;
}
.pos { color: var(--success); }
.neg { color: var(--danger); }

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
.badge.win { background: #ecfdf5; color: #047857; }
.help-bang.modal-help-bang {
  width: 32px;
  height: 32px;
  border: 1px solid #fed7aa;
  border-radius: 8px;
  background: #fff7ed;
  color: #c2410c;
  font-size: 1rem;
  font-weight: 800;
  line-height: 1;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.help-bang.modal-help-bang.on {
  background: #ea580c;
  border-color: #ea580c;
  color: #fff;
}
.modal-help-panel {
  margin: 0;
  padding: 10px 12px;
  border-bottom: 1px solid #fed7aa;
  background: #fff7ed;
  color: #9a3412;
  max-height: 40vh;
  overflow-y: auto;
}
.modal-help-title {
  font-size: 0.8rem;
  font-weight: 800;
  margin-bottom: 6px;
}
.modal-help-list {
  margin: 0;
  padding-left: 1.1rem;
  font-size: 0.72rem;
  line-height: 1.5;
  font-weight: 600;
}
.modal-help-list li { margin-bottom: 4px; }
.modal-help-list b { color: #7c2d12; }
</style>
