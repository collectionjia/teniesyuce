<script setup>
defineProps({
  allowBatchTrade: { type: Boolean, default: false },
  autoSimBetEnabled: { type: Boolean, default: false },
  pageAllSelected: { type: Boolean, default: false },
  pageSelectable: { type: Array, default: () => [] },
  selectedCount: { type: Number, default: 0 },
  batchAmountUsd: { type: [String, Number], default: 1 },
  batchSubmitting: { type: Boolean, default: false },
  batchNotice: { type: String, default: '' },
  batchError: { type: String, default: '' },
  /** 未开赛：展示市价/限价、Up/Down */
  showManualTradeOpts: { type: Boolean, default: false },
  manualOrderType: { type: String, default: 'market' },
  manualSide: { type: String, default: 'suggest' },
  manualShares: { type: [String, Number], default: '10' },
  manualLimitBuyPrice: { type: [String, Number], default: '0.55' },
  toggleAutoBet: { type: Function, required: true },
  toggleSelectPage: { type: Function, required: true },
  submitBatchTrade: { type: Function, required: true },
  clearSelection: { type: Function, required: true },
})

const emit = defineEmits([
  'update:batchAmountUsd',
  'update:manualOrderType',
  'update:manualSide',
  'update:manualShares',
  'update:manualLimitBuyPrice',
])
</script>

<template>
<div class="batch-bar">
      <div class="batch-bar-controls">
        <label class="auto-bet-toggle" :class="{ on: autoSimBetEnabled }" title="默认关闭；打开后按当前列表条件自动下单。采集未开虚拟=真实交易；虚拟采集=仅记账">
          <input type="checkbox" :checked="autoSimBetEnabled" @change="toggleAutoBet" />
          <span>自动投注</span>
        </label>
        <template v-if="allowBatchTrade">
        <label class="batch-check-all">
          <input
            type="checkbox"
            :checked="pageAllSelected && pageSelectable.length > 0"
            :disabled="!pageSelectable.length"
            @change="toggleSelectPage"
          />
          <span>全选</span>
        </label>
        <span class="batch-count">{{ selectedCount }}</span>

        <template v-if="showManualTradeOpts">
          <div class="seg" title="手动批量：市价 FOK / 限价 GTC">
            <button
              type="button"
              class="seg-btn"
              :class="{ on: manualOrderType === 'market' }"
              :disabled="batchSubmitting"
              @click="emit('update:manualOrderType', 'market')"
            >市价</button>
            <button
              type="button"
              class="seg-btn"
              :class="{ on: manualOrderType === 'limit' }"
              :disabled="batchSubmitting"
              @click="emit('update:manualOrderType', 'limit')"
            >限价</button>
          </div>
          <div class="seg" title="Up=主队 home，Down=客队 away；建议=按排名优侧">
            <button
              type="button"
              class="seg-btn"
              :class="{ on: manualSide === 'suggest' }"
              :disabled="batchSubmitting"
              @click="emit('update:manualSide', 'suggest')"
            >建议</button>
            <button
              type="button"
              class="seg-btn"
              :class="{ on: manualSide === 'home' }"
              :disabled="batchSubmitting"
              @click="emit('update:manualSide', 'home')"
            >Up</button>
            <button
              type="button"
              class="seg-btn"
              :class="{ on: manualSide === 'away' }"
              :disabled="batchSubmitting"
              @click="emit('update:manualSide', 'away')"
            >Down</button>
          </div>
          <template v-if="manualOrderType === 'limit'">
            <label class="batch-amount" title="限价买入份额">
              <span>份</span>
              <input
                :value="manualShares"
                @input="emit('update:manualShares', $event.target.value)"
                type="number"
                min="0.01"
                step="0.01"
                inputmode="decimal"
              />
            </label>
            <label class="batch-amount" title="买入目标价 0.01–0.99">
              <span>价</span>
              <input
                :value="manualLimitBuyPrice"
                @input="emit('update:manualLimitBuyPrice', $event.target.value)"
                type="number"
                min="0.01"
                max="0.99"
                step="0.01"
                inputmode="decimal"
              />
            </label>
          </template>
          <label v-else class="batch-amount">
            <span>元</span>
            <input :value="batchAmountUsd" @input="emit('update:batchAmountUsd', $event.target.value)" type="number" min="1" step="1" inputmode="decimal" />
          </label>
        </template>
        <label v-else class="batch-amount">
          <span>元</span>
          <input :value="batchAmountUsd" @input="emit('update:batchAmountUsd', $event.target.value)" type="number" min="1" step="1" inputmode="decimal" />
        </label>

        <button
          type="button"
          class="batch-btn"
          :disabled="batchSubmitting || selectedCount === 0"
          @click="submitBatchTrade()"
        >{{ batchSubmitting ? '…' : '批量手动下单' }}</button>
        <button
          v-if="selectedCount"
          type="button"
          class="batch-clear"
          :disabled="batchSubmitting"
          @click="clearSelection"
        >清</button>
        </template>
      </div>
      <div v-if="batchNotice" class="batch-notice">{{ batchNotice }}</div>
      <div v-if="batchError" class="batch-error">{{ batchError }}</div>
    </div>
</template>

<style scoped>
.batch-bar {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
  margin-bottom: 6px;
  padding: 6px 8px;
  background: var(--card);
  border: 1px solid #c7d2fe;
  border-radius: 8px;
}
.batch-bar-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.auto-bet-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.72rem;
  font-weight: 700;
  color: #64748b;
  border: 1px solid #e2e8f0;
  background: #fff;
  border-radius: 999px;
  padding: 4px 8px;
  cursor: pointer;
  flex-shrink: 0;
}
.auto-bet-toggle.on {
  color: #14532d;
  border-color: #86efac;
  background: #f0fdf4;
}
.auto-bet-toggle input {
  accent-color: #16a34a;
}
.batch-check-all {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.74rem;
  font-weight: 600;
  color: #475569;
  cursor: pointer;
  flex-shrink: 0;
}
.batch-check-all input {
  width: 16px;
  height: 16px;
  accent-color: var(--primary);
}
.batch-count {
  font-size: 0.74rem;
  font-weight: 700;
  color: var(--primary);
  flex-shrink: 0;
}
.seg {
  display: inline-flex;
  align-items: stretch;
  border: 1px solid #c7d2fe;
  border-radius: 8px;
  overflow: hidden;
  flex-shrink: 0;
  background: #fff;
}
.seg-btn {
  border: 0;
  border-right: 1px solid #e0e7ff;
  background: transparent;
  color: #64748b;
  padding: 5px 8px;
  font-size: 0.72rem;
  font-weight: 700;
  cursor: pointer;
  line-height: 1.2;
}
.seg-btn:last-child {
  border-right: 0;
}
.seg-btn.on {
  background: #eef2ff;
  color: #3730a3;
}
.seg-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.batch-amount {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 0.74rem;
  font-weight: 600;
  color: #64748b;
  flex-shrink: 0;
}
.batch-amount input {
  width: 3.6rem;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 5px 6px;
  font-size: 0.82rem;
  font-weight: 700;
  color: #0f172a;
}
.batch-btn {
  border: 0;
  background: var(--primary);
  color: #fff;
  border-radius: 8px;
  padding: 7px 12px;
  font-size: 0.82rem;
  font-weight: 700;
  cursor: pointer;
  flex-shrink: 0;
}
.batch-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.batch-clear {
  border: 1px solid var(--line);
  background: #fff;
  color: #64748b;
  border-radius: 8px;
  padding: 7px 12px;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  flex-shrink: 0;
}
.batch-notice,
.batch-error {
  display: block;
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
  font-size: 0.72rem;
  font-weight: 600;
  line-height: 1.4;
  white-space: pre-line;
  word-break: break-word;
  overflow-wrap: anywhere;
  max-height: 5.6em;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 4px 2px 2px;
}
.batch-notice {
  color: var(--success);
  border-top: 1px dashed #bbf7d0;
}
.batch-error {
  color: var(--danger);
  border-top: 1px dashed #fecaca;
}
</style>
