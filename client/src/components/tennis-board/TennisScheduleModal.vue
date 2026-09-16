<script setup>
defineProps({
  open: { type: Boolean, default: false },
  autoBetSec: { type: [Number, String], default: 60 },
  stopLossSec: { type: [Number, String], default: 60 },
  pageRefreshSec: { type: [Number, String], default: 0 },
  saving: { type: Boolean, default: false },
  error: { type: String, default: '' },
  notice: { type: String, default: '' },
})

const emit = defineEmits([
  'update:open',
  'update:autoBetSec',
  'update:stopLossSec',
  'update:pageRefreshSec',
  'save',
  'open-admin',
])
</script>

<template>
  <div v-if="open" class="modal-mask modal-mask--top" @click.self="emit('update:open', false)">
    <div class="modal-sheet rules-modal-sheet schedule-sheet" role="dialog" aria-modal="true">
      <div class="modal-head">
        <div class="modal-head-main">
          <div class="modal-title">调度设置</div>
          <div class="modal-sub">页面刷新 / 自动投注 / 止损轮询（10–600 秒；页面刷新填 0 关闭）</div>
        </div>
        <div class="modal-head-actions">
          <button type="button" class="chip-btn" @click="emit('open-admin')">调度中心</button>
          <button type="button" class="modal-x" @click="emit('update:open', false)" aria-label="关闭">×</button>
        </div>
      </div>
      <div class="modal-body">
        <p v-if="error" class="admin-rules-msg err">{{ error }}</p>
        <p v-if="notice" class="admin-rules-msg ok">{{ notice }}</p>
        <div class="schedule-fields">
          <label>
            <span>页面刷新(秒)</span>
            <input
              type="number"
              min="0"
              max="600"
              step="1"
              :value="pageRefreshSec"
              :disabled="saving"
              placeholder="0=关闭"
              title="大于 0 时按间隔自动刷新盘前/盘中列表数据；0 或空=不刷新"
              @input="emit('update:pageRefreshSec', $event.target.value)"
            >
          </label>
          <label>
            <span>自动投注刷新(秒)</span>
            <input
              type="number"
              min="10"
              max="600"
              step="1"
              :value="autoBetSec"
              :disabled="saving"
              @input="emit('update:autoBetSec', $event.target.value)"
            >
          </label>
          <label>
            <span>止损刷新(秒)</span>
            <input
              type="number"
              min="10"
              max="600"
              step="1"
              :value="stopLossSec"
              :disabled="saving"
              @input="emit('update:stopLossSec', $event.target.value)"
            >
          </label>
        </div>
        <p class="schedule-hint">写入投注引擎配置。页面刷新：盘前/盘中打开后按间隔拉最新赛程（含 PM）。自动投注/止损仍按各自间隔；与页面刷新相同时合并为一次请求。</p>
        <div class="schedule-foot">
          <button type="button" class="chip-btn" :disabled="saving" @click="emit('update:open', false)">取消</button>
          <button type="button" class="chip-btn active" :disabled="saving" @click="emit('save')">
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-mask {
  position: fixed;
  inset: 0;
  z-index: 80;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 48px 12px 24px;
  --line: #e2e8f0;
  --card: #ffffff;
  --text: #1e293b;
  --muted: #94a3b8;
  --primary: #4f46e5;
  --primary-soft: #eef2ff;
}
.modal-mask--top { align-items: flex-start; }
.modal-sheet {
  width: min(420px, 100%);
  background: var(--card);
  border-radius: 14px;
  box-shadow: 0 18px 40px rgba(15, 23, 42, 0.22);
  overflow: hidden;
}
.modal-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  padding: 14px 16px 10px;
  border-bottom: 1px solid var(--line);
}
.modal-title { font-size: 1rem; font-weight: 700; color: var(--text); }
.modal-sub { margin-top: 4px; font-size: 0.75rem; color: var(--muted); }
.modal-head-actions { display: flex; align-items: center; gap: 6px; }
.modal-x {
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 1.4rem;
  line-height: 1;
  cursor: pointer;
  padding: 0 2px;
}
.modal-body { padding: 14px 16px 16px; }
.chip-btn {
  border: 1px solid var(--line);
  background: var(--card);
  color: #64748b;
  border-radius: 999px;
  padding: 5px 11px;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
}
.chip-btn.active {
  color: var(--primary);
  border-color: #c7d2fe;
  background: var(--primary-soft);
}
.chip-btn:disabled { opacity: 0.5; cursor: wait; }
.admin-rules-msg { font-size: 0.78rem; margin: 0 0 8px; }
.admin-rules-msg.err { color: #dc2626; }
.admin-rules-msg.ok { color: #16a34a; }
.schedule-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.schedule-fields label:first-child {
  grid-column: 1 / -1;
}
.schedule-fields label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 0.72rem;
  color: #64748b;
}
.schedule-fields input {
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 0.9rem;
  color: var(--text);
}
.schedule-hint {
  margin: 12px 0 0;
  font-size: 0.72rem;
  color: var(--muted);
  line-height: 1.45;
}
.schedule-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}
</style>
