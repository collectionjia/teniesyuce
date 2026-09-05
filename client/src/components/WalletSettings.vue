<script setup>
import { computed, reactive, ref, watch } from 'vue'
import * as api from '../api'

const props = defineProps({
  open: { type: Boolean, default: false },
})
const emit = defineEmits(['close', 'updated'])

const loading = ref(false)
const saving = ref(false)
const testing = ref(false)
const error = ref('')
const notice = ref('')
const status = reactive({
  configured: false,
  proxyAddress: '',
  signatureType: 1,
  maskedKey: '',
  usdcBalance: null,
})
const draft = reactive({
  privateKey: '',
  proxyAddress: '',
  signatureType: 1,
})
const testResult = ref(null)

const shortProxy = computed(() => {
  const a = status.proxyAddress || ''
  if (a.length < 12) return a || '—'
  return `${a.slice(0, 6)}…${a.slice(-4)}`
})

async function loadStatus() {
  loading.value = true
  error.value = ''
  notice.value = ''
  testResult.value = null
  try {
    const data = await api.fetchBtcWallet()
    Object.assign(status, {
      configured: !!data.configured,
      proxyAddress: data.proxyAddress || '',
      signatureType: Number(data.signatureType || 1),
      maskedKey: data.maskedKey || '',
      usdcBalance: data.usdcBalance ?? null,
    })
    draft.privateKey = ''
    draft.proxyAddress = status.proxyAddress || ''
    draft.signatureType = status.signatureType || 1
    if (status.configured) emit('updated', { ...status })
  } catch (e) {
    error.value = e.response?.data?.error || e.message || '加载失败'
  } finally {
    loading.value = false
  }
}

watch(
  () => props.open,
  (v) => {
    if (v) loadStatus()
  },
)

function close() {
  emit('close')
}

async function save() {
  if (!draft.proxyAddress.trim()) {
    error.value = '请填写账户地址'
    return
  }
  if (!status.configured && !draft.privateKey.trim()) {
    error.value = '请填写私钥和账户地址'
    return
  }
  saving.value = true
  error.value = ''
  notice.value = ''
  testResult.value = null
  try {
    const data = await api.saveBtcWallet({
      privateKey: draft.privateKey.trim() || undefined,
      proxyAddress: draft.proxyAddress.trim(),
      signatureType: Number(draft.signatureType),
    })
    Object.assign(status, {
      configured: !!data.configured,
      proxyAddress: data.proxyAddress || '',
      signatureType: Number(data.signatureType || 1),
      maskedKey: data.maskedKey || '',
      usdcBalance: status.usdcBalance,
    })
    draft.privateKey = ''
    notice.value = data.message || '账户已加密保存'
    emit('updated', { ...status })
    if (status.configured) {
      try {
        const test = await api.testBtcWallet({})
        if (test?.ok) {
          status.usdcBalance = test.usdcBalance ?? null
          emit('updated', { ...status })
        }
      } catch { /* ignore */ }
    }
  } catch (e) {
    error.value = e.response?.data?.error || e.message || '保存失败'
  } finally {
    saving.value = false
  }
}

async function clear() {
  if (!window.confirm('确定清除已保存的私钥和账户？')) return
  saving.value = true
  error.value = ''
  notice.value = ''
  testResult.value = null
  try {
    const data = await api.clearBtcWallet()
    Object.assign(status, {
      configured: false,
      proxyAddress: '',
      signatureType: 1,
      maskedKey: '',
      usdcBalance: null,
    })
    draft.privateKey = ''
    draft.proxyAddress = ''
    draft.signatureType = 1
    notice.value = data.message || '账户已清除'
    emit('updated', { ...status })
  } catch (e) {
    error.value = e.response?.data?.error || e.message || '清除失败'
  } finally {
    saving.value = false
  }
}

async function testConnect() {
  testing.value = true
  error.value = ''
  notice.value = ''
  testResult.value = null
  try {
    const payload = {}
    // 有草稿私钥则测草稿；否则测已保存配置
    if (draft.privateKey.trim() && draft.proxyAddress.trim()) {
      payload.privateKey = draft.privateKey.trim()
      payload.proxyAddress = draft.proxyAddress.trim()
      payload.signatureType = Number(draft.signatureType)
    }
    const data = await api.testBtcWallet(payload)
    testResult.value = data
    if (data?.ok && data.usdcBalance != null) {
      status.usdcBalance = data.usdcBalance
      emit('updated', { ...status })
    }
    if (data?.suggestedSignatureType === 3) {
      draft.signatureType = 3
      notice.value = data.message || '检测到 V2 存款钱包，已切换为 POLY_1271，请再点「加密保存」'
    } else {
      notice.value = data.message || '连接成功'
    }
    if (data?.signatureType != null) {
      draft.signatureType = Number(data.signatureType)
      status.signatureType = Number(data.signatureType)
    }
  } catch (e) {
    error.value = e.response?.data?.error || e.message || '连接测试失败'
    testResult.value = { ok: false }
  } finally {
    testing.value = false
  }
}
</script>

<template>
  <div v-if="open" class="wm-mask" @click.self="close">
    <div class="wm-sheet" role="dialog" aria-modal="true">
      <div class="wm-head">
        <div>
          <div class="wm-title">账户设置</div>
          <div class="wm-sub">签名账户 · 私钥加密存储</div>
        </div>
        <button type="button" class="wm-x" @click="close">×</button>
      </div>

      <div v-if="loading" class="wm-loading">加载中…</div>
      <template v-else>
        <div class="wm-status" :class="{ ok: status.configured }">
          <span class="dot" />
          <span v-if="status.configured">已配置 · {{ shortProxy }} · {{ status.maskedKey || '私钥已加密' }}</span>
          <span v-else>尚未配置账户</span>
        </div>

        <p class="wm-tip">
          私钥以密文保存在服务端，页面永不回显明文。保存后可用「测试连接」验证连通性。
        </p>

        <label class="wm-field">
          <span>私钥（非明文输入）</span>
          <input
            v-model="draft.privateKey"
            type="password"
            autocomplete="new-password"
            spellcheck="false"
            :placeholder="status.configured ? '留空表示不修改已保存私钥；重新输入则覆盖' : '0x… 或 64 位十六进制'"
          />
        </label>

        <label class="wm-field">
          <span>账户地址（Proxy / Funder）</span>
          <input
            v-model="draft.proxyAddress"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="0x…"
          />
        </label>

        <label class="wm-field">
          <span>签名类型</span>
          <select v-model.number="draft.signatureType">
            <option :value="3">Deposit Wallet / POLY_1271（新账户常用）</option>
            <option :value="1">Proxy（旧版网站登录账户）</option>
            <option :value="2">Gnosis Safe</option>
            <option :value="0">EOA（私钥地址即资金地址）</option>
          </select>
          <span class="wm-hint">账户地址填 Polymarket 个人页资金/Proxy 地址；私钥填导出的 EOA 私钥。新账户余额为 0 时请选 POLY_1271。</span>
        </label>

        <p v-if="error" class="wm-err">{{ error }}</p>
        <p v-else-if="notice" class="wm-ok">{{ notice }}</p>

        <div v-if="testResult?.ok" class="wm-test-box">
          <div>EOA：{{ testResult.eoa }}</div>
          <div>Proxy：{{ testResult.proxyAddress }}</div>
          <div v-if="testResult.usdcBalance != null">余额：${{ Number(testResult.usdcBalance).toFixed(2) }}</div>
          <div v-if="testResult.apiKeyHint">API Key：{{ testResult.apiKeyHint }}</div>
        </div>

        <div class="wm-actions">
          <button type="button" class="wm-btn primary" :disabled="saving" @click="save">
            {{ saving ? '保存中…' : '加密保存' }}
          </button>
          <button
            type="button"
            class="wm-btn test"
            :disabled="testing || (!status.configured && !(draft.privateKey && draft.proxyAddress))"
            @click="testConnect"
          >
            {{ testing ? '测试中…' : '测试连接' }}
          </button>
          <button
            v-if="status.configured"
            type="button"
            class="wm-btn danger"
            :disabled="saving"
            @click="clear"
          >
            清除
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.wm-mask {
  position: fixed;
  inset: 0;
  z-index: 80;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding: 12px;
}
.wm-sheet {
  width: 100%;
  max-width: 420px;
  background: #fff;
  border-radius: 18px 18px 14px 14px;
  padding: 16px 16px 18px;
  box-shadow: 0 20px 50px rgba(15, 23, 42, 0.25);
  max-height: min(88vh, 640px);
  overflow-y: auto;
}
.wm-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 8px;
  margin-bottom: 12px;
}
.wm-title { font-size: 1.05rem; font-weight: 800; color: #0f172a; }
.wm-sub { font-size: 0.72rem; color: #64748b; margin-top: 2px; }
.wm-x {
  border: none;
  background: transparent;
  font-size: 1.5rem;
  line-height: 1;
  color: #94a3b8;
  cursor: pointer;
}
.wm-loading { padding: 24px; text-align: center; color: #64748b; font-size: 0.85rem; }
.wm-status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 10px;
  background: #f1f5f9;
  font-size: 0.75rem;
  color: #475569;
  margin-bottom: 10px;
}
.wm-status.ok { background: #ecfdf5; color: #047857; }
.wm-status .dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: #94a3b8;
  flex-shrink: 0;
}
.wm-status.ok .dot { background: #10b981; }
.wm-tip {
  font-size: 0.72rem;
  color: #64748b;
  line-height: 1.5;
  margin-bottom: 12px;
}
.wm-field {
  display: grid;
  gap: 4px;
  margin-bottom: 10px;
  font-size: 0.72rem;
  color: #64748b;
}
.wm-field input,
.wm-field select {
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 9px 11px;
  font-size: 0.85rem;
  color: #0f172a;
  outline: none;
}
.wm-field input:focus,
.wm-field select:focus { border-color: #6366f1; }
.wm-hint {
  font-size: 0.66rem;
  color: #94a3b8;
  line-height: 1.4;
}
.wm-err { color: #dc2626; font-size: 0.75rem; margin: 4px 0 8px; }
.wm-ok { color: #059669; font-size: 0.75rem; margin: 4px 0 8px; }
.wm-test-box {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 8px 10px;
  font-size: 0.7rem;
  color: #334155;
  line-height: 1.55;
  margin-bottom: 10px;
  word-break: break-all;
}
.wm-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
.wm-btn {
  border: none;
  border-radius: 10px;
  padding: 9px 14px;
  font-size: 0.8rem;
  font-weight: 700;
  cursor: pointer;
}
.wm-btn:disabled { opacity: 0.55; cursor: not-allowed; }
.wm-btn.primary { background: #4f46e5; color: #fff; }
.wm-btn.test { background: #ecfdf5; color: #047857; }
.wm-btn.danger { background: #fee2e2; color: #b91c1c; }
</style>
