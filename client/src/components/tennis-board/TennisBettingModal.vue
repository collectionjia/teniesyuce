<script setup>
defineProps({
  open: { type: Boolean, default: false },
  isInplayMode: { type: Boolean, default: false },
  betRulesLoading: { type: Boolean, default: false },
  selectLoading: { type: Boolean, default: false },
  betRulesSummary: { type: String, default: '' },
  canEditBettingRules: { type: Boolean, default: false },
  bettingEntryNorm: { type: Object, default: () => ({}) },
  betRulesSaving: { type: Boolean, default: false },
  betRulesError: { type: String, default: '' },
  betRulesNotice: { type: String, default: '' },
  bettingBucketOn: { type: Boolean, default: false },
  bettingSimulateOn: { type: Boolean, default: false },
  bettingBucketLabel: { type: String, default: '' },
  bettingGroups: { type: Array, default: () => [] },
  ensureStopRules: { type: Function, required: true },
  openAdminEngine: { type: Function, required: true },
  setBettingEntryField: { type: Function, required: true },
  addBettingGroup: { type: Function, required: true },
  saveBettingRules: { type: Function, required: true },
  setBettingGroupField: { type: Function, required: true },
  removeBettingGroup: { type: Function, required: true },
  setStopRuleField: { type: Function, required: true },
  removeStopRule: { type: Function, required: true },
  addStopRule: { type: Function, required: true },
})

const emit = defineEmits(['update:open', 'update:bettingBucketOn', 'update:bettingSimulateOn'])
</script>

<template>
<!-- 投注设置弹框：盘中先体现买入条件，再配止损；盘前仅止损 -->
    <div v-if="open" class="modal-mask modal-mask--top" @click.self="emit('update:open', false)">
      <div class="modal-sheet rules-modal-sheet" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div class="modal-head-main">
            <div class="modal-title">{{ isInplayMode ? '盘中投注设置' : '盘前投注止损' }}</div>
            <div class="modal-sub">{{ (betRulesLoading || selectLoading) ? '加载中…' : betRulesSummary }}</div>
          </div>
          <div class="modal-head-actions">
            <button type="button" class="chip-btn" @click="openAdminEngine('betting')">引擎页</button>
            <button type="button" class="modal-x" @click="emit('update:open', false)" aria-label="关闭">×</button>
          </div>
        </div>
        <div class="modal-body admin-rules-body">
          <template v-if="isInplayMode">
            <div class="admin-select-section-title admin-select-section-title--first">盘中自动买入</div>
            <p class="admin-rules-hint">列表自动投注与调度买入共用：选第几盘，填盘差（强方局分 − 弱方局分 &gt; N）。</p>
            <div class="admin-rule-fields">
              <label>
                <span>第几盘</span>
                <select
                  :value="bettingEntryNorm.wonSetIndex || 1"
                  :disabled="betRulesSaving || betRulesLoading"
                  @change="setBettingEntryField('wonSetIndex', $event.target.value)"
                >
                  <option :value="1">第1盘</option>
                  <option :value="2">第2盘</option>
                  <option :value="3">第3盘</option>
                  <option :value="4">第4盘</option>
                  <option :value="5">第5盘</option>
                </select>
              </label>
              <label title="盘差：强方局分 − 弱方局分 > 此值；留空=不启用">
                <span>盘差 &gt;</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  :value="bettingEntryNorm.setGapMin === 'all' || bettingEntryNorm.setGapMin == null ? '' : bettingEntryNorm.setGapMin"
                  placeholder="不限"
                  :disabled="betRulesSaving || betRulesLoading"
                  @change="setBettingEntryField('setGapMin', $event.target.value)"
                >
              </label>
              <label>
                <span>PM¢&lt;</span>
                <input
                  type="number"
                  min="1"
                  max="99"
                  :value="bettingEntryNorm.pmCentsMax === 'all' || bettingEntryNorm.pmCentsMax == null ? '' : bettingEntryNorm.pmCentsMax"
                  placeholder="不限"
                  :disabled="betRulesSaving || betRulesLoading"
                  @change="setBettingEntryField('pmCentsMax', $event.target.value)"
                >
              </label>
            </div>
          </template>

          <template v-if="canEditBettingRules">
            <div v-if="isInplayMode" class="admin-select-section-title">卖出条件</div>
            <p v-if="betRulesError" class="admin-rules-msg err">{{ betRulesError }}</p>
            <p v-if="betRulesNotice" class="admin-rules-msg ok">{{ betRulesNotice }}</p>
            <div class="admin-rules-toggles">
              <label class="admin-toggle">
                <input :checked="bettingBucketOn" @change="emit('update:bettingBucketOn', $event.target.checked)" type="checkbox" :disabled="betRulesSaving || betRulesLoading">
                <span>{{ bettingBucketLabel }}打开</span>
              </label>
              <label v-if="!isInplayMode" class="admin-toggle" title="引擎/调度侧默认；列表用户需各自打开「自动投注」">
                <input :checked="bettingSimulateOn" @change="emit('update:bettingSimulateOn', $event.target.checked)" type="checkbox" :disabled="betRulesSaving || betRulesLoading">
                <span>模拟投注</span>
              </label>
              <button type="button" class="chip-btn" :disabled="betRulesSaving || betRulesLoading" @click="addBettingGroup">加一组</button>
              <button type="button" class="chip-btn active" :disabled="betRulesSaving || betRulesLoading" @click="saveBettingRules">
                {{ betRulesSaving ? '保存中…' : (isInplayMode ? '保存条件' : '保存止损条件') }}
              </button>
            </div>
            <div v-for="(g, gi) in bettingGroups" :key="g.id || ('bet-' + gi)" class="admin-rule-group">
              <div class="admin-rule-head">
                <select v-if="gi > 0" class="admin-rule-join" :value="g.joinPrev || 'or'" :disabled="betRulesSaving" @change="setBettingGroupField(gi, 'joinPrev', $event.target.value)">
                  <option value="or">或 OR</option>
                  <option value="and">且 AND</option>
                </select>
                <span v-else class="admin-rule-join-label">首组</span>
                <input class="admin-rule-name" type="text" maxlength="40" :value="g.name || ''" :placeholder="isInplayMode ? `条件组 ${gi + 1}` : `止损组 ${gi + 1}`" :disabled="betRulesSaving" @change="setBettingGroupField(gi, 'name', $event.target.value)">
                <label class="admin-toggle">
                  <input type="checkbox" :checked="g.stopEnabled !== false" :disabled="betRulesSaving" @change="setBettingGroupField(gi, 'stopEnabled', $event.target.checked)">
                  <span>{{ isInplayMode ? '启用' : '启用止损' }}</span>
                </label>
                <button type="button" class="chip-btn" :disabled="betRulesSaving" @click="removeBettingGroup(gi)">删组</button>
              </div>
              <div v-for="(sr, si) in ensureStopRules(g)" :key="'sr-' + gi + '-' + si" class="admin-stop-rule" :class="{ off: g.stopEnabled === false }">
                <div class="admin-rule-head">
                  <select v-if="si > 0" class="admin-rule-join" :value="sr.joinPrev || 'or'" :disabled="betRulesSaving || g.stopEnabled === false" @change="setStopRuleField(gi, si, 'joinPrev', $event.target.value)">
                    <option value="or">或 OR</option>
                    <option value="and">且 AND</option>
                  </select>
                  <span v-else class="admin-rule-join-label">{{ isInplayMode ? '条件' : '止损' }}</span>
                  <input class="admin-rule-name" type="text" maxlength="40" :value="sr.name || ''" :placeholder="isInplayMode ? `条件 ${si + 1}` : `止损 ${si + 1}`" :disabled="betRulesSaving || g.stopEnabled === false" @change="setStopRuleField(gi, si, 'name', $event.target.value)">
                  <button type="button" class="chip-btn" :disabled="betRulesSaving || g.stopEnabled === false || ensureStopRules(g).length <= 1" @click="removeStopRule(gi, si)">删</button>
                </div>
                <div class="admin-rule-fields">
                  <label>
                    <span>赛制</span>
                    <select :value="sr.stopFormat || 'any'" :disabled="betRulesSaving || g.stopEnabled === false" @change="setStopRuleField(gi, si, 'stopFormat', $event.target.value)">
                      <option value="any">不限</option>
                      <option value="bo3">BO3</option>
                      <option value="bo5">BO5</option>
                    </select>
                  </label>
                  <label>
                    <span>第几盘</span>
                    <input type="number" min="1" max="5" :value="sr.stopSetIndex === 'all' || sr.stopSetIndex == null || sr.stopSetIndex === '' ? '' : sr.stopSetIndex" placeholder="—" :disabled="betRulesSaving || g.stopEnabled === false" @change="setStopRuleField(gi, si, 'stopSetIndex', $event.target.value)">
                  </label>
                  <label>
                    <span>强者已胜盘</span>
                    <input type="number" min="0" max="3" :value="sr.stopStrongSets === 'all' || sr.stopStrongSets == null ? '' : sr.stopStrongSets" placeholder="—" :disabled="betRulesSaving || g.stopEnabled === false" @change="setStopRuleField(gi, si, 'stopStrongSets', $event.target.value)">
                  </label>
                  <label>
                    <span>弱者已胜盘</span>
                    <input type="number" min="0" max="3" :value="sr.stopWeakSets === 'all' || sr.stopWeakSets == null ? '' : sr.stopWeakSets" placeholder="—" :disabled="betRulesSaving || g.stopEnabled === false" @change="setStopRuleField(gi, si, 'stopWeakSets', $event.target.value)">
                  </label>
                  <label>
                    <span>局差≥</span>
                    <input type="number" :value="sr.stopGameLead === 'all' || sr.stopGameLead == null || sr.stopGameLead === '' ? '' : sr.stopGameLead" placeholder="—" :disabled="betRulesSaving || g.stopEnabled === false" @change="setStopRuleField(gi, si, 'stopGameLead', $event.target.value)">
                  </label>
                  <label>
                    <span>PM¢&lt;</span>
                    <input
                      type="number"
                      min="1"
                      max="99"
                      step="1"
                      :value="sr.stopPmCentsMax === 'all' || sr.stopPmCentsMax == null || sr.stopPmCentsMax === '' ? '' : sr.stopPmCentsMax"
                      placeholder="—"
                      title="买入侧 Polymarket 价格(¢)小于此值则触发；与局差满足其一即可；留空不参与判断"
                      :disabled="betRulesSaving || g.stopEnabled === false"
                      @change="setStopRuleField(gi, si, 'stopPmCentsMax', $event.target.value)"
                    >
                  </label>
                </div>
              </div>
              <button type="button" class="chip-btn" style="align-self: flex-start" :disabled="betRulesSaving" @click="addStopRule(gi)">{{ isInplayMode ? '加一条条件' : '加一条止损' }}</button>
            </div>
            <p class="admin-rules-hint">勾选「{{ bettingBucketLabel }}打开」并保存后联动自动投注。不涉及投入金额；买入金额用列表批量投入。{{ isInplayMode ? '买入条件见上方。局差与 PM 满足其一即可触发卖出。' : '「模拟投注」打开时只记账、不真实下单（可不配钱包）；关闭则为实盘（需页头钱包）。' }}未填字段表示不限制。需购物车有未平仓持仓，且实际满足你填的条件才会卖出。</p>
          </template>
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
.admin-rules-body { padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 8px; }
.admin-rules-toggles { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.admin-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.75rem;
  color: #92400e;
  font-weight: 600;
}
.admin-rule-stake {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.72rem;
  color: #92400e;
  font-weight: 600;
  white-space: nowrap;
}
.admin-rule-stake input {
  width: 4.5rem;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 3px 6px;
  font-size: 0.75rem;
}
.admin-rule-group {
  border: 1px solid #fde68a;
  border-radius: 8px;
  padding: 8px;
  background: #fff;
}
.admin-rule-head { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; }
.admin-rule-join {
  border: 1px solid #f59e0b;
  border-radius: 6px;
  padding: 3px 6px;
  font-size: 0.7rem;
  font-weight: 700;
  color: #92400e;
  background: #fff7ed;
}
.admin-rule-join-label {
  font-size: 0.65rem;
  color: #a16207;
  font-weight: 600;
  min-width: 2rem;
}
.admin-rule-name {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 0.8rem;
}
.admin-rule-fields {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
}
.admin-rule-fields label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 0.65rem;
  color: #64748b;
}
.admin-rule-fields input,
.admin-rule-fields select {
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 3px 6px;
  font-size: 0.75rem;
  min-width: 4.5rem;
  max-width: 6.5rem;
}
.admin-rules-hint { margin: 0; font-size: 0.65rem; color: #a16207; }
.admin-rules-msg { margin: 0; font-size: 0.75rem; }
.admin-rules-msg.err { color: #b91c1c; }
.admin-rules-msg.ok { color: #047857; }
.admin-bet-panel {
  border-color: #c4b5fd;
  background: #f5f3ff;
}
.admin-stop-rule {
  border: 1px dashed #ddd6fe;
  border-radius: 8px;
  padding: 6px;
  margin-bottom: 6px;
  background: #faf5ff;
}
.admin-stop-rule.off { opacity: 0.55; }
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
</style>
