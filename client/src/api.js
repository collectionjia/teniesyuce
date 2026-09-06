import axios from 'axios'

const api = axios.create({ baseURL: '/api' })

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

export async function login(account, password) {
  const { data } = await api.post('/auth/login', { account, password })
  localStorage.setItem('token', data.token)
  return data
}

export async function register(payload) {
  const { data } = await api.post('/auth/register', payload)
  localStorage.setItem('token', data.token)
  return data
}

export async function fetchMe() {
  const { data } = await api.get('/auth/me')
  return data.user
}

export async function changePassword(newPassword) {
  const { data } = await api.post('/auth/change-password', { newPassword })
  return data
}

export async function fetchProducts() {
  const { data } = await api.get('/products')
  return data.products
}

export async function fetchSubscriptions() {
  const { data } = await api.get('/subscriptions/mine')
  return data.subscriptions
}

export async function subscribe(productId, plan) {
  const { data } = await api.post('/subscriptions/subscribe', { productId, plan })
  return data
}

export async function createPayment(productId, plan, vendor = 'alipay') {
  const { data } = await api.post('/payments/create', { productId, plan, vendor })
  return data
}

export async function createBalancePayment(amount, vendor = 'alipay') {
  const { data } = await api.post('/payments/balance/create', { amount, vendor })
  return data
}

export async function fetchPublicPaymentStatus(reference) {
  const { data } = await api.get(`/payments/public-status/${reference}`)
  return data
}

export async function fetchPaymentStatus(reference) {
  const { data } = await api.get(`/payments/status/${reference}`)
  return data
}

export async function fetchPaymentSettings() {
  const { data } = await api.get('/settings/payment')
  return data
}

export async function fetchAdminPaymentSettings() {
  const { data } = await api.get('/admin/settings/payment')
  return data
}

export async function updateAdminPaymentSettings(payload) {
  const body = typeof payload === 'string' ? { defaultPlan: payload } : (payload || {})
  const { data } = await api.put('/admin/settings/payment', body)
  return data
}

export async function fetchAgentOverview() {
  const { data } = await api.get('/agent/overview')
  return data
}

export async function fetchAgentOrders(status = 'all') {
  const { data } = await api.get('/agent/orders', { params: status === 'all' ? {} : { status } })
  return data.orders
}

export async function fetchAgentClients() {
  const { data } = await api.get('/agent/clients')
  return data.clients
}

export async function withdraw() {
  const { data } = await api.post('/agent/withdraw')
  return data
}

export async function fetchWithdrawals() {
  const { data } = await api.get('/agent/withdrawals')
  return data.withdrawLog
}

export async function fetchAdminStats() {
  const { data } = await api.get('/admin/stats')
  return data
}

export async function fetchAdminDailyReport(date) {
  const { data } = await api.get('/admin/daily-report', { params: date ? { date } : {} })
  return data
}

export async function fetchAdminWithdrawals(status = 'pending') {
  const { data } = await api.get('/admin/withdrawals', { params: status === 'all' ? {} : { status } })
  return data.withdrawals
}

export async function payAdminWithdrawal(id) {
  const { data } = await api.post(`/admin/withdrawals/${id}/pay`)
  return data
}

// 浜у搧 CRUD
export async function fetchAdminProducts() {
  const { data } = await api.get('/admin/products')
  return data.products
}
export async function createProduct(payload) {
  const { data } = await api.post('/admin/products', payload)
  return data
}
export async function updateProduct(id, payload) {
  const { data } = await api.put(`/admin/products/${id}`, payload)
  return data
}
export async function deleteProduct(id) {
  const { data } = await api.delete(`/admin/products/${id}`)
  return data
}

// 浠ｇ悊 CRUD
export async function fetchAdminAgents() {
  const { data } = await api.get('/admin/agents')
  return data.agentList
}
export async function createAgent(payload) {
  const { data } = await api.post('/admin/agents', payload)
  return data
}
export async function updateAgent(id, payload) {
  const { data } = await api.put(`/admin/agents/${id}`, payload)
  return data
}
export async function deleteAgent(id) {
  const { data } = await api.delete(`/admin/agents/${id}`)
  return data
}

// 璁㈠崟 CRUD
export async function fetchAdminPaymentOrders(status = 'all') {
  const { data } = await api.get('/admin/payment-orders', { params: status === 'all' ? {} : { status } })
  return data.orders
}

// 璁㈠崟 CRUD锛堝巻鍙插吋瀹癸級
export async function fetchAdminOrders() {
  const { data } = await api.get('/admin/orders')
  return data.orders
}
export async function createOrder(payload) {
  const { data } = await api.post('/admin/orders', payload)
  return data
}
export async function updateOrder(id, payload) {
  const { data } = await api.put(`/admin/orders/${id}`, payload)
  return data
}
export async function deleteOrder(id) {
  const { data } = await api.delete(`/admin/orders/${id}`)
  return data
}

// 鐢ㄦ埛 CRUD
export async function fetchAdminUsers() {
  const { data } = await api.get('/admin/users')
  return data.users
}
export async function createUser(payload) {
  const { data } = await api.post('/admin/users', payload)
  return data
}
export async function updateUser(id, payload) {
  const { data } = await api.put(`/admin/users/${id}`, payload)
  return data
}
export async function resetUserPassword(id, payload = {}) {
  const { data } = await api.post(`/admin/users/${id}/reset-password`, payload)
  return data
}
export async function deleteUser(id) {
  const { data } = await api.delete(`/admin/users/${id}`)
  return data
}

export async function fetchAdminUserSubscriptions(userId) {
  const { data } = await api.get(`/admin/users/${userId}/subscriptions`)
  return data
}

export async function grantAdminSubscription(payload) {
  const { data } = await api.post('/admin/subscriptions/grant', payload)
  return data
}

export async function generateRedeemCodes(payload) {
  const { data } = await api.post('/admin/redeem-codes/generate', payload)
  return data
}

export async function fetchRedeemCodeBatches() {
  const { data } = await api.get('/admin/redeem-codes/batches')
  return data.batches || []
}

export async function fetchRedeemCodes(params = {}) {
  const { data } = await api.get('/admin/redeem-codes', { params })
  return data
}

export async function downloadRedeemCodesExcel(batchId) {
  const { data } = await api.get('/admin/redeem-codes/export', {
    params: { batchId },
    responseType: 'blob',
  })
  const blob = data instanceof Blob ? data : new Blob([data], { type: 'application/vnd.ms-excel' })
  // 若后端返回 JSON 错误
  if (blob.type && blob.type.includes('application/json')) {
    const text = await blob.text()
    let msg = '导出失败'
    try { msg = JSON.parse(text).error || msg } catch { /* ignore */ }
    throw new Error(msg)
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `redeem-${batchId}.xls`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export async function disableRedeemCode(id) {
  const { data } = await api.post(`/admin/redeem-codes/${id}/disable`)
  return data
}

export async function deleteRedeemCode(id) {
  const { data } = await api.delete(`/admin/redeem-codes/${id}`)
  return data
}

export async function disableRedeemBatch(batchId) {
  const { data } = await api.post(`/admin/redeem-codes/batches/${encodeURIComponent(batchId)}/disable`)
  return data
}

export async function deleteRedeemBatch(batchId) {
  const { data } = await api.delete(`/admin/redeem-codes/batches/${encodeURIComponent(batchId)}`)
  return data
}

export async function redeemSubscriptionCode(code, productId) {
  const payload = { code }
  if (productId != null && productId !== '') payload.productId = Number(productId)
  const { data } = await api.post('/subscriptions/redeem', payload)
  return data
}

export async function updateAdminUserSubscription(userId, productId, payload) {
  const { data } = await api.put(`/admin/users/${userId}/subscriptions/${productId}`, payload)
  return data
}

export async function revokeAdminUserSubscription(userId, productId) {
  const { data } = await api.delete(`/admin/users/${userId}/subscriptions/${productId}`)
  return data
}

export function logoutLocal() {
  localStorage.removeItem('token')
}

export async function fetchSofaMonitorStatus() {
  const { data } = await api.get('/admin/sofa-monitor/status')
  return data
}

export async function fetchSofaMonitorTop100(refresh = false) {
  const { data } = await api.get('/admin/sofa-monitor/top100', {
    params: refresh ? { refresh: 1 } : {},
  })
  return data
}

export async function fetchSofaMonitorTop20(refresh = false) {
  const { data } = await api.get('/admin/sofa-monitor/top20', {
    params: refresh ? { refresh: 1 } : {},
  })
  return data
}

export async function fetchSofaMonitorLogs(lines = 120) {
  const { data } = await api.get('/admin/sofa-monitor/logs', { params: { lines } })
  return data
}

export async function triggerSofaMonitorCollect() {
  const { data } = await api.post('/admin/sofa-monitor/collect')
  return data
}

export async function fetchSofaMonitorLive() {
  const { data } = await api.get('/admin/sofa-monitor/live')
  return data
}

export async function triggerSofaMonitorLiveCollect() {
  const { data } = await api.post('/admin/sofa-monitor/live/collect')
  return data
}

export async function fetchSofaMonitorSchedule() {
  const { data } = await api.get('/admin/sofa-monitor/schedule')
  return data
}

export async function updateSofaMonitorSchedule(intervalHours) {
  const { data } = await api.post('/admin/sofa-monitor/schedule', { interval_hours: intervalHours })
  return data
}

export async function fetchSofaMonitorDataSource() {
  const { data } = await api.get('/admin/sofa-monitor/data-source')
  return data
}

export async function updateSofaMonitorDataSource(source) {
  const { data } = await api.post('/admin/sofa-monitor/data-source', { source })
  return data
}

export async function refreshTennisCache() {
  const { data } = await api.post('/tennis/cache/refresh')
  return data
}

export async function fetchBtcState() {
  const { data } = await api.get('/btc/state', {
    params: { _: Date.now() },
    headers: { 'Cache-Control': 'no-cache' },
  })
  return data
}

export async function fetchBtcWallet() {
  const { data } = await api.get('/btc/wallet')
  return data
}

export async function saveBtcWallet(payload) {
  const { data } = await api.put('/btc/wallet', payload)
  return data
}

export async function clearBtcWallet() {
  const { data } = await api.delete('/btc/wallet')
  return data
}

export async function testBtcWallet(payload = {}) {
  const { data } = await api.post('/btc/wallet/test', payload)
  return data
}

export async function placeBtcTrade(payload) {
  const { data } = await api.post('/btc/trade', payload)
  return data
}

export async function fetchBtcPositions(market = '5m') {
  const { data } = await api.get('/btc/positions', {
    params: { market, _: Date.now() },
    headers: { 'Cache-Control': 'no-cache' },
  })
  return data
}

export async function placeBtcSell(payload) {
  const { data } = await api.post('/btc/trade/sell', payload)
  return data
}

export async function fetchTradeRecords({ product = 'all', limit = 30, offset = 0 } = {}) {
  const { data } = await api.get('/trades', {
    params: { product, limit, offset, _: Date.now() },
    headers: { 'Cache-Control': 'no-cache' },
  })
  return data
}

export async function placeTennisBatchTrade(payload) {
  const { data } = await api.post('/tennis/trade/batch', payload)
  return data
}

export async function placeTennisRangeBatchTrade(payload) {
  const { data } = await api.post('/tennis-range/trade/batch', payload)
  return data
}

export async function refreshTennisRangeCache() {
  const { data } = await api.post('/tennis-range/cache/refresh')
  return data
}

export async function placeTennisLiveBatchTrade(payload) {
  const { data } = await api.post('/tennis-live/trade/batch', payload)
  return data
}

export async function placeTennisNewBatchTrade(payload) {
  const { data } = await api.post('/tennis-new/trade/batch', payload)
  return data
}

export async function refreshTennisNewCache() {
  const { data } = await api.post('/tennis-new/cache/refresh')
  return data
}

export async function refreshTennisLiveCache() {
  const { data } = await api.post('/tennis-live/cache/refresh')
  return data
}

export async function fetchAdminBtcCrawl() {
  const { data } = await api.get('/admin/btc-board/crawl')
  return data
}

export async function setAdminBtcCrawl(enabled) {
  const { data } = await api.post('/admin/btc-board/crawl', { enabled })
  return data
}

export async function fetchAdminBtcState() {
  const { data } = await api.get('/admin/btc-board/state', {
    params: { _: Date.now() },
    headers: { 'Cache-Control': 'no-cache' },
  })
  return data
}

export default api
