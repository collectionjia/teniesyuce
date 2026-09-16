<script setup>
defineProps({
  open: { type: Boolean, default: false },
  conditionBucketLabel: { type: String, default: '' },
  rulesLoading: { type: Boolean, default: false },
  rulesSummary: { type: String, default: '' },
  canEditConditionRules: { type: Boolean, default: false },
  rulesError: { type: String, default: '' },
  rulesNotice: { type: String, default: '' },
  conditionBucketOn: { type: Boolean, default: false },
  rulesSaving: { type: Boolean, default: false },
  conditionGroups: { type: Array, default: () => [] },
  isInplayMode: { type: Boolean, default: false },
  isPrematchMode: { type: Boolean, default: false },
  canEditProductSelect: { type: [Boolean, null], default: null },
  needsConditionGroupSelect: { type: Boolean, default: false },
  selectError: { type: String, default: '' },
  selectNotice: { type: String, default: '' },
  selectLoading: { type: Boolean, default: false },
  selectSaving: { type: Boolean, default: false },
  productSelectCond: { type: Array, default: () => [] },
  libraryGroups: { type: Array, default: () => [] },
  conditionGroupLabel: { type: Function, required: true },
  setConditionGroupField: { type: Function, required: true },
  removeConditionGroup: { type: Function, required: true },
  addConditionGroup: { type: Function, required: true },
  saveConditionRules: { type: Function, required: true },
  addSelectRow: { type: Function, required: true },
  saveProductSelect: { type: Function, required: true },
  setSelectRowField: { type: Function, required: true },
  removeSelectRow: { type: Function, required: true },
  openAdminEngine: { type: Function, required: true },
})

const emit = defineEmits(['update:open', 'update:conditionBucketOn'])
</script>

<template>
<!-- 条件设置弹框：盘前/盘中均可编辑条件组；多组时可再选用挂到本产品 -->
    <div v-if="open" class="modal-mask modal-mask--top" @click.self="emit('update:open', false)">
      <div class="modal-sheet rules-modal-sheet" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div class="modal-head-main">
            <div class="modal-title">{{ conditionBucketLabel }}条件</div>
            <div class="modal-sub">{{ rulesLoading ? '加载中…' : rulesSummary }}</div>
          </div>
          <div class="modal-head-actions">
            <button type="button" class="chip-btn" @click="openAdminEngine('condition')">引擎页</button>
            <button type="button" class="modal-x" @click="emit('update:open', false)" aria-label="关闭">×</button>
          </div>
        </div>
        <div class="modal-body admin-rules-body">
          <template v-if="canEditConditionRules">
            <p v-if="rulesError" class="admin-rules-msg err">{{ rulesError }}</p>
            <p v-if="rulesNotice" class="admin-rules-msg ok">{{ rulesNotice }}</p>
            <div class="admin-rules-toggles">
              <label class="admin-toggle">
                <input :checked="conditionBucketOn" @change="emit('update:conditionBucketOn', $event.target.checked)" type="checkbox" :disabled="rulesSaving || rulesLoading">
                <span>{{ conditionBucketLabel }}打开</span>
              </label>
              <button type="button" class="chip-btn" :disabled="rulesSaving || rulesLoading" @click="addConditionGroup">加一组</button>
              <button type="button" class="chip-btn active" :disabled="rulesSaving || rulesLoading" @click="saveConditionRules">
                {{ rulesSaving ? '保存中…' : '保存并刷新列表' }}
              </button>
            </div>
            <div v-for="(g, gi) in conditionGroups" :key="g.id || gi" class="admin-rule-group">
              <div class="admin-rule-head">
                <select
                  v-if="gi > 0"
                  class="admin-rule-join"
                  :value="g.joinPrev || 'or'"
                  :disabled="rulesSaving"
                  title="与上一组的连接"
                  @change="setConditionGroupField(gi, 'joinPrev', $event.target.value)"
                >
                  <option value="or">或 OR</option>
                  <option value="and">且 AND</option>
                </select>
                <span v-else class="admin-rule-join-label">首组</span>
                <input
                  class="admin-rule-name"
                  type="text"
                  maxlength="40"
                  :value="g.name || ''"
                  :placeholder="`条件组 ${gi + 1}`"
                  :disabled="rulesSaving"
                  @change="setConditionGroupField(gi, 'name', $event.target.value)"
                >
                <button type="button" class="chip-btn" :disabled="rulesSaving" @click="removeConditionGroup(gi)">删</button>
              </div>
              <div class="admin-rule-fields">
                <label>
                  <span>巡回</span>
                  <select :value="g.tour || 'all'" :disabled="rulesSaving" @change="setConditionGroupField(gi, 'tour', $event.target.value)">
                    <option value="all">全部</option>
                    <option value="ATP">男</option>
                    <option value="WTA">女</option>
                  </select>
                </label>
                <label>
                  <span>PM</span>
                  <select :value="g.pm || 'all'" :disabled="rulesSaving" @change="setConditionGroupField(gi, 'pm', $event.target.value)">
                    <option value="all">全部</option>
                    <option value="yes">有外链</option>
                    <option value="no">无外链</option>
                  </select>
                </label>
                <label>
                  <span>现差≥</span>
                  <input type="number" :value="g.gapMin === 'all' || g.gapMin == null ? '' : g.gapMin" placeholder="—" :disabled="rulesSaving" @change="setConditionGroupField(gi, 'gapMin', $event.target.value)">
                </label>
                <label>
                  <span>排差≥</span>
                  <input type="number" :value="g.rankDiffMin === 'all' || g.rankDiffMin == null ? '' : g.rankDiffMin" placeholder="—" :disabled="rulesSaving" @change="setConditionGroupField(gi, 'rankDiffMin', $event.target.value)">
                </label>
                <label>
                  <span>排差≤</span>
                  <input type="number" :value="g.rankDiffMax === 'all' || g.rankDiffMax == null ? '' : g.rankDiffMax" placeholder="—" :disabled="rulesSaving" @change="setConditionGroupField(gi, 'rankDiffMax', $event.target.value)">
                </label>
                <label>
                  <span>强现&gt;</span>
                  <input type="number" :value="g.strongRankGt === 'all' || g.strongRankGt == null ? '' : g.strongRankGt" placeholder="—" :disabled="rulesSaving" @change="setConditionGroupField(gi, 'strongRankGt', $event.target.value)">
                </label>
                <label>
                  <span>强现&lt;</span>
                  <input type="number" :value="g.strongRankLt === 'all' || g.strongRankLt == null ? '' : g.strongRankLt" placeholder="—" :disabled="rulesSaving" @change="setConditionGroupField(gi, 'strongRankLt', $event.target.value)">
                </label>
                <template v-if="isInplayMode">
                  <label class="admin-toggle" title="强者须已赢下第一盘">
                    <input
                      type="checkbox"
                      :checked="!!g.requireWonFirstSet"
                      :disabled="rulesSaving"
                      @change="setConditionGroupField(gi, 'requireWonFirstSet', $event.target.checked)"
                    >
                    <span>赢首盘</span>
                  </label>
                  <label
                    v-if="g.requireWonFirstSet"
                    class="admin-toggle"
                    title="首盘局分为该比分时不入选（顺序无关，默认 7:5）"
                  >
                    <input
                      type="checkbox"
                      :checked="!!g.firstSetExcludeEnabled"
                      :disabled="rulesSaving"
                      @change="setConditionGroupField(gi, 'firstSetExcludeEnabled', $event.target.checked)"
                    >
                    <span>排除首盘</span>
                  </label>
                  <label v-if="g.requireWonFirstSet && g.firstSetExcludeEnabled">
                    <span>局分</span>
                    <input
                      type="text"
                      :value="g.firstSetExcludeScore || '7:5'"
                      placeholder="7:5"
                      :disabled="rulesSaving"
                      @change="setConditionGroupField(gi, 'firstSetExcludeScore', $event.target.value)"
                    >
                  </label>
                </template>
              </div>
            </div>
            <p class="admin-rules-hint">组内字段「且」· 多组用「或 / 且」左结合连接。</p>

            <!-- 多组时：本产品选用哪些组（盘前/盘中一致） -->
            <template v-if="canEditProductSelect && needsConditionGroupSelect">
              <div class="admin-select-section-title">本产品选用条件组</div>
              <p v-if="selectError" class="admin-rules-msg err">{{ selectError }}</p>
              <p v-if="selectNotice" class="admin-rules-msg ok">{{ selectNotice }}</p>
              <div v-if="selectLoading" class="admin-rules-hint">加载挂载中…</div>
              <template v-else>
                <div class="admin-rules-toggles">
                  <button type="button" class="chip-btn" :disabled="selectSaving" @click="addSelectRow('cond')">添加一组</button>
                  <button type="button" class="chip-btn active" :disabled="selectSaving" @click="saveProductSelect('condition')">
                    {{ selectSaving ? '保存中…' : '保存选用' }}
                  </button>
                </div>
                <div v-if="!productSelectCond.length" class="admin-rules-hint">多组时请选择本产品要用的组；未选则列表使用引擎全部组</div>
                <div v-for="(row, ri) in productSelectCond" :key="'pcs-' + ri" class="admin-select-row">
                  <select
                    v-if="ri > 0"
                    class="admin-rule-join"
                    :value="row.joinPrev || 'or'"
                    :disabled="selectSaving"
                    @change="setSelectRowField('cond', ri, 'joinPrev', $event.target.value)"
                  >
                    <option value="or">或 OR</option>
                    <option value="and">且 AND</option>
                  </select>
                  <div class="admin-select-row-main">
                    <select class="admin-rule-name" :value="row.id" :disabled="selectSaving" @change="setSelectRowField('cond', ri, 'id', $event.target.value)">
                      <option v-for="(g, gi) in libraryGroups" :key="g.id || gi" :value="g.id">{{ conditionGroupLabel(g, gi) }}</option>
                    </select>
                    <button type="button" class="chip-btn" :disabled="selectSaving" @click="removeSelectRow('cond', ri)">删</button>
                  </div>
                </div>
              </template>
            </template>
            <p v-else-if="canEditProductSelect === false" class="admin-rules-hint">缺少产品 ID 时无法按产品选用多组</p>
            <p v-else-if="canEditProductSelect && !needsConditionGroupSelect" class="admin-rules-hint">仅一组时无需再选用，列表直接用上方条件组。</p>
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
