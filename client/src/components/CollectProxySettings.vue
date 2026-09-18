<script setup>
import { onMounted, reactive, ref } from 'vue'
import * as api from '../api'

const loading = ref(true)
const saving = ref(false)
const error = ref('')
const notice = ref('')

const form = reactive({
  top100: true,
  inplay_tick: true,
  host: 'us.ipwo.net',
  port: '7878',
  user: '',
  pass: '',
  zone: '',
  passSet: false,
})

function applyFromCfg(cfg) {
  const p = cfg?.collect?.proxy || {}
  form.top100 = p.top100 !== false
  form.inplay_tick = p.inplay_tick !== false
  form.host = String(p.host || 'us.ipwo.net')
  form.port = String(p.port || '7878')
  form.user = String(p.user || '')
  form.pass = ''
  form.zone = String(p.zone || '')
  form.passSet = !!p.passSet
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const cfg = await api.fetchTennisEngines({ force: true })
    applyFromCfg(cfg)
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
    const proxy = {
      top100: !!form.top100,
      inplay_tick: !!form.inplay_tick,
      host: String(form.host || '').trim() || 'us.ipwo.net',
      port: String(form.port || '').trim() || '7878',
      user: String(form.user || '').trim(),
      zone: String(form.zone || '').trim(),
    }
    const pass = String(form.pass || '').trim()
    if (pass) proxy.pass = pass
    const cfg = await api.updateTennisEngines({ collect: { proxy } })
    applyFromCfg(cfg)
    notice.value = '已保存。采集子进程下次启动即使用新配置。'
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
        <div class="font-semibold">采集代理（IPWO）</div>
        <div class="text-xs text-slate-400 mt-0.5 leading-relaxed">
          账号保存在引擎配置库，不再依赖 monitor.env。密码留空表示不修改已存密码。
        </div>
      </div>

      <p v-if="loading" class="text-sm text-slate-400">加载中…</p>
      <p v-else-if="error" class="text-sm text-rose-600">{{ error }}</p>
      <p v-if="notice" class="text-sm text-emerald-600">{{ notice }}</p>

      <template v-if="!loading">
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="flex items-center justify-between gap-3 rounded-xl border border-slate-200 px-3 py-2.5">
            <span class="text-sm text-slate-700">Top100 全量采集走代理</span>
            <input v-model="form.top100" type="checkbox" class="h-4 w-4" />
          </label>
          <label class="flex items-center justify-between gap-3 rounded-xl border border-slate-200 px-3 py-2.5">
            <span class="text-sm text-slate-700">盘中刷新走代理</span>
            <input v-model="form.inplay_tick" type="checkbox" class="h-4 w-4" />
          </label>
        </div>

        <div class="grid gap-3 sm:grid-cols-2">
          <div>
            <div class="text-xs text-slate-400 mb-1">Host</div>
            <input
              v-model.trim="form.host"
              type="text"
              autocomplete="off"
              class="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-primary-400"
              placeholder="us.ipwo.net"
            />
          </div>
          <div>
            <div class="text-xs text-slate-400 mb-1">Port</div>
            <input
              v-model.trim="form.port"
              type="text"
              autocomplete="off"
              class="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-primary-400"
              placeholder="7878"
            />
          </div>
          <div>
            <div class="text-xs text-slate-400 mb-1">User</div>
            <input
              v-model.trim="form.user"
              type="text"
              autocomplete="off"
              class="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-primary-400"
              placeholder="IPWO 用户名"
            />
          </div>
          <div>
            <div class="text-xs text-slate-400 mb-1">
              Password
              <span v-if="form.passSet" class="text-emerald-600">（已保存，留空不改）</span>
            </div>
            <input
              v-model="form.pass"
              type="password"
              autocomplete="new-password"
              class="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-primary-400"
              placeholder="••••••••"
            />
          </div>
          <div class="sm:col-span-2">
            <div class="text-xs text-slate-400 mb-1">Zone（可选，如 US）</div>
            <input
              v-model.trim="form.zone"
              type="text"
              autocomplete="off"
              class="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-primary-400"
              placeholder="US"
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
