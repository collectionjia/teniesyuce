<script setup>
import { onMounted, reactive, ref } from 'vue'
import * as api from '../api'

const loading = ref(true)
const saving = ref(false)
const error = ref('')
const notice = ref('')

const status = reactive({
  alchemyKeySet: false,
  alchemyKeyMasked: '',
  quickPrivateKeySet: false,
  quickPrivateKeyMasked: '',
  quickFunder: '',
  quickRelayerKeySet: false,
  quickRelayerKeyMasked: '',
  quickRelayerAddr: '',
  urls: {},
})

const form = reactive({
  alchemyKey: '',
  quickPrivateKey: '',
  quickFunder: '',
  quickRelayerKey: '',
  quickRelayerAddr: '',
})

function applyStatus(data) {
  Object.assign(status, {
    alchemyKeySet: !!data.alchemyKeySet,
    alchemyKeyMasked: data.alchemyKeyMasked || '',
    quickPrivateKeySet: !!data.quickPrivateKeySet,
    quickPrivateKeyMasked: data.quickPrivateKeyMasked || '',
    quickFunder: data.quickFunder || '',
    quickRelayerKeySet: !!data.quickRelayerKeySet,
    quickRelayerKeyMasked: data.quickRelayerKeyMasked || '',
    quickRelayerAddr: data.quickRelayerAddr || '',
    urls: data.urls || {},
  })
  form.alchemyKey = ''
  form.quickPrivateKey = ''
  form.quickFunder = status.quickFunder || ''
  form.quickRelayerKey = ''
  form.quickRelayerAddr = status.quickRelayerAddr || ''
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const data = await api.fetchAdminBtcKeys()
    applyStatus(data)
  } catch (e) {
    error.value = e?.response?.data?.error || e?.message || '加载失败'
  } finally {
    loading.value = false
  }
}

async function save() {
  saving.value = true
  error.value = ''
  notice.value = ''
  try {
    const payload = {
      quickFunder: String(form.quickFunder || '').trim(),
      quickRelayerAddr: String(form.quickRelayerAddr || '').trim(),
    }
    const alchemyKey = String(form.alchemyKey || '').trim()
    const quickPrivateKey = String(form.quickPrivateKey || '').trim()
    const quickRelayerKey = String(form.quickRelayerKey || '').trim()
    if (alchemyKey) payload.alchemyKey = alchemyKey
    if (quickPrivateKey) payload.quickPrivateKey = quickPrivateKey
    if (quickRelayerKey) payload.quickRelayerKey = quickRelayerKey

    const data = await api.saveAdminBtcKeys(payload)
    applyStatus(data)
    notice.value = data.message || '已保存'
    if (data.boardSynced === false && data.boardSyncError) {
      error.value = data.boardSyncError
    }
  } catch (e) {
    error.value = e?.response?.data?.error || e?.message || '保存失败'
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="space-y-3">
    <div class="bg-white rounded-2xl p-4 shadow-sm space-y-4">
      <div>
        <div class="font-semibold">BTC API 密钥</div>
        <div class="text-xs text-slate-400 mt-0.5 leading-relaxed">
          Alchemy RPC 与 Polymarket QUICK 账号。密钥加密存库，保存后尝试热同步到 btc-board。密钥留空表示不修改。
        </div>
      </div>

      <p v-if="loading" class="text-sm text-slate-400">加载中…</p>
      <p v-else-if="error" class="text-sm text-rose-600">{{ error }}</p>
      <p v-if="notice" class="text-sm text-emerald-600">{{ notice }}</p>

      <template v-if="!loading">
        <div class="rounded-xl bg-slate-50 px-3 py-2 text-[11px] text-slate-500 leading-relaxed space-y-0.5">
          <div>CLOB：{{ status.urls.clob || 'https://clob.polymarket.com' }}</div>
          <div>Gamma：{{ status.urls.gamma || 'https://gamma-api.polymarket.com' }}</div>
          <div>RPC：{{ status.urls.alchemyRpc || 'https://polygon-mainnet.g.alchemy.com/v2/{ALCHEMY_KEY}' }}</div>
        </div>

        <div class="grid gap-3 sm:grid-cols-2">
          <div class="sm:col-span-2">
            <div class="text-xs text-slate-400 mb-1">
              Alchemy Key
              <span v-if="status.alchemyKeySet" class="text-emerald-600">（已配置 {{ status.alchemyKeyMasked }}，留空不改）</span>
            </div>
            <input
              v-model="form.alchemyKey"
              type="password"
              autocomplete="new-password"
              class="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-primary-400"
              placeholder="Alchemy Polygon API Key"
            />
          </div>

          <div class="sm:col-span-2">
            <div class="text-xs text-slate-400 mb-1">
              QUICK Private Key
              <span v-if="status.quickPrivateKeySet" class="text-emerald-600">（已配置 {{ status.quickPrivateKeyMasked }}，留空不改）</span>
            </div>
            <input
              v-model="form.quickPrivateKey"
              type="password"
              autocomplete="new-password"
              class="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-primary-400"
              placeholder="0x… 64 位十六进制"
            />
          </div>

          <div class="sm:col-span-2">
            <div class="text-xs text-slate-400 mb-1">QUICK Funder 地址</div>
            <input
              v-model.trim="form.quickFunder"
              type="text"
              autocomplete="off"
              class="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-primary-400"
              placeholder="0x… Polymarket 存款钱包"
            />
          </div>

          <div>
            <div class="text-xs text-slate-400 mb-1">
              Relayer API Key（可选）
              <span v-if="status.quickRelayerKeySet" class="text-emerald-600">（已配置 {{ status.quickRelayerKeyMasked }}）</span>
            </div>
            <input
              v-model="form.quickRelayerKey"
              type="password"
              autocomplete="new-password"
              class="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-primary-400"
              placeholder="留空不改"
            />
          </div>
          <div>
            <div class="text-xs text-slate-400 mb-1">Relayer Address（可选）</div>
            <input
              v-model.trim="form.quickRelayerAddr"
              type="text"
              autocomplete="off"
              class="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-primary-400"
              placeholder="0x…"
            />
          </div>
        </div>

        <div class="flex gap-2">
          <button
            type="button"
            :disabled="saving"
            class="flex-1 py-2.5 rounded-xl bg-primary-600 text-white text-sm font-medium disabled:opacity-60"
            @click="save"
          >
            {{ saving ? '保存中…' : '保存配置' }}
          </button>
          <button
            type="button"
            :disabled="loading || saving"
            class="px-4 py-2.5 rounded-xl border border-slate-200 text-sm text-slate-600 disabled:opacity-60"
            @click="load"
          >
            刷新
          </button>
        </div>
      </template>
    </div>
  </div>
</template>
