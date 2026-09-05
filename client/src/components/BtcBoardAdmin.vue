<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import * as api from '../api'
import BtcBoard from './BtcBoard.vue'

const crawlEnabled = ref(false)
const crawlBusy = ref(false)
const loading = ref(true)
const error = ref('')
const dataReady = ref(false)

let pollTimer = null

async function loadCrawlStatus() {
  const data = await api.fetchAdminBtcCrawl()
  crawlEnabled.value = !!data.enabled
}

async function refresh() {
  error.value = ''
  try {
    await loadCrawlStatus()
    if (crawlEnabled.value) {
      await api.fetchAdminBtcState()
      dataReady.value = true
    } else {
      dataReady.value = false
    }
  } catch (e) {
    error.value = e?.response?.data?.error || e?.message || '加载失败'
  } finally {
    loading.value = false
  }
}

async function toggleCrawl() {
  if (crawlBusy.value) return
  crawlBusy.value = true
  error.value = ''
  const next = !crawlEnabled.value
  try {
    await api.setAdminBtcCrawl(next)
    crawlEnabled.value = next
    if (next) {
      dataReady.value = false
      await api.fetchAdminBtcState()
      dataReady.value = true
    } else {
      dataReady.value = false
    }
  } catch (e) {
    error.value = e?.response?.data?.error || e?.message || '操作失败'
  } finally {
    crawlBusy.value = false
  }
}

onMounted(() => {
  refresh()
  pollTimer = setInterval(refresh, 15000)
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})
</script>

<template>
  <div class="admin-btc">
    <div class="panel">
      <div class="row">
        <div>
          <div class="title">数据同步</div>
          <div class="sub">开启后 board 服务才会拉取 UP/DOWN 数据；关闭时为快照模式</div>
        </div>
        <button
          type="button"
          class="switch"
          :class="{ on: crawlEnabled, busy: crawlBusy }"
          :disabled="crawlBusy"
          @click="toggleCrawl"
        >
          <span class="track"><span class="knob"></span></span>
          <span>{{ crawlEnabled ? '同步中' : '已关闭' }}</span>
        </button>
      </div>
    </div>

    <div v-if="error" class="banner err">{{ error }}</div>
    <div v-if="loading" class="banner">加载中…</div>

    <template v-else>
      <div v-if="!crawlEnabled" class="banner hint">
        请先打开数据同步开关，下方才会请求并展示看板数据。
      </div>
      <div v-else-if="!dataReady" class="banner">正在连接看板服务…</div>
      <BtcBoard v-else admin />
    </template>
  </div>
</template>

<style scoped>
.admin-btc { display: flex; flex-direction: column; gap: 12px; }
.panel {
  background: #fff; border: 1px solid #e2e8f0; border-radius: 14px; padding: 14px;
}
.row { display: flex; gap: 12px; align-items: center; justify-content: space-between; }
.title { font-size: 0.95rem; font-weight: 700; color: #0f172a; }
.sub { margin-top: 4px; font-size: 0.72rem; color: #94a3b8; max-width: 220px; line-height: 1.4; }
.switch {
  display: inline-flex; align-items: center; gap: 8px; border: 1px solid #e2e8f0;
  background: #f8fafc; border-radius: 999px; padding: 6px 12px 6px 6px;
  font-size: 0.78rem; font-weight: 600; color: #64748b; cursor: pointer;
}
.switch.on { border-color: #bbf7d0; background: #f0fdf4; color: #166534; }
.switch.busy { opacity: 0.6; cursor: wait; }
.track {
  width: 36px; height: 20px; border-radius: 999px; background: #cbd5e1; position: relative;
}
.switch.on .track { background: #22c55e; }
.knob {
  position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
  border-radius: 50%; background: #fff; transition: left 0.15s;
}
.switch.on .knob { left: 18px; }
.banner {
  border-radius: 12px; padding: 10px 12px; font-size: 0.82rem;
  background: #f1f5f9; color: #475569;
}
.banner.err { background: #fef2f2; color: #b91c1c; }
.banner.hint { background: #eef2ff; color: #4338ca; }
</style>
