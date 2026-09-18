<script setup>
import { ref, onMounted } from 'vue'
import * as api from '../api'

const loading = ref(false)
const keys = ref([])
const msg = ref('')
const err = ref('')
const newKeyName = ref('engine-key')
const createdKeyPlain = ref('')
/** 本会话创建的明文，供列表「复制」使用 */
const plainById = ref({})

function isActive(k) {
  return !!(k.enabled && !k.revokedAt)
}

async function refresh() {
  if (loading.value) return
  loading.value = true
  err.value = ''
  try {
    const data = await api.fetchEngineApiKeys()
    keys.value = data.keys || []
  } catch (e) {
    err.value = e?.response?.data?.error || e.message || '加载失败'
  } finally {
    loading.value = false
  }
}

async function createKey() {
  createdKeyPlain.value = ''
  msg.value = ''
  err.value = ''
  try {
    const r = await api.createEngineApiKey({ name: newKeyName.value || 'engine-key' })
    createdKeyPlain.value = r.apiKey || ''
    if (r.key?.id && r.apiKey) {
      plainById.value = { ...plainById.value, [r.key.id]: r.apiKey }
    }
    msg.value = '密钥已创建，请立即复制保存'
    await refresh()
  } catch (e) {
    err.value = e?.response?.data?.error || e.message
  }
}

async function copyText(text, okMsg = '已复制到剪贴板') {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    msg.value = okMsg
  } catch {
    msg.value = '复制失败，请手动选中复制'
  }
}

async function copyRow(row) {
  msg.value = ''
  const plain = plainById.value[row.id]
  if (plain) {
    await copyText(plain, '已复制完整密钥')
    return
  }
  await copyText(row.keyPrefix || '', '已复制密钥前缀（完整密钥仅创建时可见）')
}

async function copyPlain() {
  await copyText(createdKeyPlain.value, '已复制到剪贴板')
}

async function revokeKey(row) {
  if (!confirm(`确认吊销密钥 ${row.keyPrefix}…？吊销后将无法再调用。`)) return
  msg.value = ''
  try {
    await api.revokeEngineApiKey(row.id)
    msg.value = '已吊销'
    if (createdKeyPlain.value?.startsWith(row.keyPrefix)) createdKeyPlain.value = ''
    await refresh()
  } catch (e) {
    err.value = e?.response?.data?.error || e.message
  }
}

async function deleteKey(row) {
  if (!confirm(`确认永久删除密钥 ${row.keyPrefix}…？删除后不可恢复。`)) return
  msg.value = ''
  try {
    await api.deleteEngineApiKey(row.id)
    msg.value = '已删除'
    const next = { ...plainById.value }
    delete next[row.id]
    plainById.value = next
    if (createdKeyPlain.value?.startsWith(row.keyPrefix)) createdKeyPlain.value = ''
    await refresh()
  } catch (e) {
    err.value = e?.response?.data?.error || e.message
  }
}

onMounted(refresh)
</script>

<template>
  <div class="space-y-4">
    <div class="bg-white rounded-2xl p-4 shadow-sm space-y-2">
      <div class="flex items-center justify-between gap-2">
        <div>
          <div class="font-semibold">引擎 API Key</div>
          <p class="text-xs text-slate-400 mt-0.5">
            持有密钥即可调用
            <code class="text-[11px] bg-slate-100 px-1 rounded">/api/engine/*</code>
            ，与账号角色无关。
          </p>
        </div>
        <button
          type="button"
          class="text-sm px-3 py-1.5 rounded-xl border border-slate-200 text-slate-600"
          :disabled="loading"
          @click="() => void refresh()"
        >刷新</button>
      </div>
      <p class="text-xs text-slate-500">
        Header：
        <code class="bg-slate-100 px-1 rounded">X-Api-Key</code>
        或
        <code class="bg-slate-100 px-1 rounded">Authorization: Bearer eng_…</code>
      </p>
      <p v-if="msg" class="text-xs text-emerald-600">{{ msg }}</p>
      <p v-if="err" class="text-xs text-rose-600">{{ err }}</p>
    </div>

    <div class="bg-white rounded-2xl p-4 shadow-sm space-y-3">
      <div class="font-semibold text-sm">生成密钥</div>
      <div class="flex flex-wrap gap-2 items-end">
        <div class="flex-1 min-w-[140px]">
          <div class="text-xs text-slate-400 mb-1">备注名</div>
          <input
            v-model="newKeyName"
            class="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm"
            placeholder="engine-key"
          />
        </div>
        <button
          type="button"
          class="px-4 py-2 rounded-xl bg-primary-600 text-white text-sm"
          @click="createKey"
        >生成密钥</button>
      </div>
      <div
        v-if="createdKeyPlain"
        class="text-xs bg-amber-50 border border-amber-100 rounded-xl p-3 space-y-2"
      >
        <div class="font-medium text-amber-800">明文密钥（仅显示一次）</div>
        <code class="break-all block">{{ createdKeyPlain }}</code>
        <button
          type="button"
          class="text-xs px-2.5 py-1 rounded-lg border border-amber-200 text-amber-800"
          @click="copyPlain"
        >复制</button>
      </div>
    </div>

    <div class="bg-white rounded-2xl p-4 shadow-sm space-y-2">
      <div class="font-semibold text-sm">已签发列表</div>
      <div v-if="!keys.length" class="text-xs text-slate-400">暂无密钥</div>
      <div
        v-for="k in keys"
        :key="k.id"
        class="flex items-center justify-between gap-2 text-xs border border-slate-100 rounded-xl px-3 py-2"
      >
        <div class="min-w-0">
          <div class="font-medium text-sm">{{ k.name }}</div>
          <div class="text-slate-400 mt-0.5">
            {{ k.keyPrefix }}…
            ·
            <span :class="isActive(k) ? 'text-emerald-600' : 'text-rose-500'">
              {{ isActive(k) ? '有效' : '已吊销' }}
            </span>
            <span v-if="k.lastUsedAt"> · 最近 {{ k.lastUsedAt }}</span>
            <span v-if="k.createdAt"> · 创建 {{ k.createdAt }}</span>
          </div>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            class="border border-slate-200 text-slate-600 px-2 py-1 rounded-lg"
            @click="copyRow(k)"
          >复制</button>
          <button
            v-if="isActive(k)"
            type="button"
            class="text-rose-600 border border-rose-100 px-2 py-1 rounded-lg"
            @click="revokeKey(k)"
          >吊销</button>
          <button
            v-else
            type="button"
            class="text-rose-700 border border-rose-200 bg-rose-50 px-2 py-1 rounded-lg"
            @click="deleteKey(k)"
          >删除</button>
        </div>
      </div>
    </div>
  </div>
</template>
