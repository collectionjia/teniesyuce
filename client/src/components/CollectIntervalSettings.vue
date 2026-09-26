<script setup>
import { onMounted, reactive, ref } from 'vue'
import * as api from '../api'

const loading = ref(true)
const saving = ref(false)
const error = ref('')
const notice = ref('')

const form = reactive({
  score_enabled: true,
  score_interval_sec: 30,
  odds_enabled: true,
  odds_interval_sec: 1,
})

function applyFromCfg(cfg) {
  const bg = cfg?.collect?.background || {}
  form.score_enabled = bg.score_enabled !== false
  form.score_interval_sec = Number(bg.score_interval_sec) || 30
  form.odds_enabled = bg.odds_enabled !== false
  form.odds_interval_sec = Number(bg.odds_interval_sec) || 1
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

function refresh() {
  void load()
}

async function save() {
  saving.value = true
  error.value = ''
  notice.value = ''
  try {
    const scoreSec = Math.min(600, Math.max(5, Math.round(Number(form.score_interval_sec) || 30)))
    const oddsSec = Math.min(60, Math.max(1, Math.round(Number(form.odds_interval_sec) || 1)))
    const cfg = await api.updateTennisEngines({
      collect: {
        background: {
          score_enabled: !!form.score_enabled,
          score_interval_sec: scoreSec,
          odds_enabled: !!form.odds_enabled,
          odds_interval_sec: oddsSec,
        },
      },
    })
    applyFromCfg(cfg)
    notice.value = '保存成功，后台循环已按新间隔重启'
  } catch (e) {
    error.value = `保存失败：${e?.response?.data?.error || e?.message || '请重试'}`
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
        <div class="font-semibold">采集频率</div>
        <div class="text-xs text-slate-400 mt-0.5 leading-relaxed">
          控制 server 后台循环：Sofascore 盘中比分、Polymarket 赔率（含 Dota2/NFL）。保存后立即生效。
        </div>
      </div>

      <p v-if="loading" class="text-sm text-slate-400">加载中…</p>
      <p v-else-if="error" class="text-sm text-rose-600">{{ error }}</p>
      <p v-if="notice" class="text-sm text-emerald-600">{{ notice }}</p>

      <template v-if="!loading">
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="flex items-center justify-between gap-3 rounded-xl border border-slate-200 px-3 py-2.5 sm:col-span-2">
            <span class="text-sm text-slate-700">开启 Sofascore 比分刷新</span>
            <input v-model="form.score_enabled" type="checkbox" class="h-4 w-4" />
          </label>
          <div>
            <div class="text-xs text-slate-400 mb-1">比分间隔（秒，5–600）</div>
            <input
              v-model.number="form.score_interval_sec"
              type="number"
              min="5"
              max="600"
              step="1"
              :disabled="!form.score_enabled"
              class="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-primary-400 disabled:opacity-50"
            />
          </div>
          <div class="flex items-end text-xs text-slate-400 pb-2.5">
            默认 30 秒 · 经 IPWO 拉 Sofascore
          </div>

          <label class="flex items-center justify-between gap-3 rounded-xl border border-slate-200 px-3 py-2.5 sm:col-span-2">
            <span class="text-sm text-slate-700">开启 Polymarket 赔率刷新</span>
            <input v-model="form.odds_enabled" type="checkbox" class="h-4 w-4" />
          </label>
          <div>
            <div class="text-xs text-slate-400 mb-1">赔率间隔（秒，1–60）</div>
            <input
              v-model.number="form.odds_interval_sec"
              type="number"
              min="1"
              max="60"
              step="1"
              :disabled="!form.odds_enabled"
              class="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-primary-400 disabled:opacity-50"
            />
          </div>
          <div class="flex items-end text-xs text-slate-400 pb-2.5">
            默认 1 秒 · PM 直连
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
            @click="refresh"
          >
            刷新
          </button>
        </div>
      </template>
    </div>
  </div>
</template>
