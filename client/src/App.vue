<script setup>
import { ref, computed, reactive, onMounted, onUnmounted, watch } from 'vue'
import * as api from './api'
import ProductIcon from './components/ProductIcon.vue'
import TennisBoard from './components/TennisBoard.vue'
import BtcBoard from './components/BtcBoard.vue'
import DotaBoard from './components/DotaBoard.vue'
import BasketballBoard from './components/BasketballBoard.vue'
import Dota2Board from './components/Dota2Board.vue'
import BtcBoardAdmin from './components/BtcBoardAdmin.vue'
import SofaMonitor from './components/SofaMonitor.vue'
import TennisLiveMonitor from './components/TennisLiveMonitor.vue'
import LiveTop100Scraper from './components/LiveTop100Scraper.vue'
import WalletSettings from './components/WalletSettings.vue'
import { PRODUCT_ICON_OPTIONS, productIconSvg } from './productIcons'
import { startBackgroundRunner, stopBackgroundRunner, loadSimState, setLiveTradeHandler, setLiveSellHandler } from './btcVirtualBet'
import { loadLiveTradeState, markLivePlaced, recordLiveOrder, resolveBuyFillPrice, resolveBuyFillShares, resolveSellFillPrice, recordLiveEntry, clearLiveEntry, getLiveEntry } from './btcLiveTrade'
import helpRedeemImg from './assets/help/help-redeem.jpg'
import helpTennisImg from './assets/help/help-tennis.jpg'
import helpBtcImg from './assets/help/help-btc.jpg'

const DAY = 86400000
const now = ref(Date.now())
const telegramSupportUrl = import.meta.env.VITE_TELEGRAM_SUPPORT_URL || 'https://t.me/davinjia66'
const EXTERNAL_SUBSCRIBE_URL_DEFAULT = 'https://pay.ldxp.cn/shop/8GD17A0H'

const authed = ref(false)
const loading = ref(true)
const authView = ref('login')
const showPwd = ref(false)
const loginError = ref('')
const registerError = ref('')
const role = ref('user')
const view = ref('home')
const balance = ref(0)

const f = reactive({ account: '', password: '', confirm: '', regRole: 'user', agree: false, inviteCode: '' })
const currentUser = reactive({ id: null, name: '', account: '', role: 'user', inviteCode: '', tennisFilterEnabled: false, btcSimEnabled: false })

const products = ref([])
const adminProducts = ref([])
const userSubs = reactive({})
const openedProduct = ref(null)

const agent = reactive({
  monthCommission: 0, withdrawable: 0, rate: 25, inviteCode: '',
  clientCount: 0,
  trend: [0, 0, 0, 0, 0, 0, 0], clients: [], orders: [], withdrawLog: [],
})

const admin = reactive({
  stats: [], revenue: [], agentList: [], orders: [], paymentOrders: [], users: [], withdrawals: [],
  pendingWithdrawCount: 0,
})

const dailyReport = reactive({
  loading: false,
  date: '',
  newUsers: 0,
  redeemActivated: 0,
  revenue: 0,
  commission: 0,
  orderCount: 0,
  paidAmount: 0,
  trend: [],
})
const todayReport = reactive({
  loading: false,
  date: '',
  newUsers: 0,
  redeemActivated: 0,
  revenue: 0,
  orderCount: 0,
  paidAmount: 0,
})

const redeemCodes = reactive({
  productId: 'all',
  plan: 'month',
  count: 10,
  expiresInDays: 30,
  generating: false,
  downloading: false,
  lastBatchId: '',
  lastCodes: [],
  batches: [],
  loading: false,
  selectedBatchId: '',
  codes: [],
  codesTotal: 0,
  codesLoading: false,
  codesPage: 1,
  codesPageSize: 5,
  codesSearch: '',
  managing: false,
})

const redeemInput = reactive({
  code: '',
  productId: '',
  busy: false,
})
const showRedeemModal = ref(false)
const redeemModalProduct = ref(null)

const adminModal = reactive({
  open: false, type: '', mode: 'create', id: null, saving: false,
  form: {},
})

const userSubModal = reactive({
  open: false,
  loading: false,
  saving: false,
  user: null,
  subscriptions: [],
  grant: {
    productId: '',
    plan: 'month',
    amount: '',
  },
  expiryDraft: {},
})

const PAGE_SIZE = 5
const page = reactive({ products: 1, agents: 1, orders: 1, users: 1, clients: 1, mine: 1 })
const productStatusFilter = ref('all')
const orderStatusFilter = ref('all')
const agentOrderStatusFilter = ref('all')
const adminWithdrawFilter = ref('pending')
const payingWithdrawId = ref(null)
const listSearch = reactive({
  shop: '',
  mine: '',
  products: '',
  agents: '',
  orders: '',
  users: '',
  clients: '',
  withdrawals: '',
})

function filterBySearch(list, query, fields) {
  const q = (query || '').trim().toLowerCase()
  if (!q) return list || []
  return (list || []).filter((item) => fields.some((field) => {
    const value = typeof field === 'function' ? field(item) : item?.[field]
    return String(value ?? '').toLowerCase().includes(q)
  }))
}

function paginate(list, key) {
  const arr = list || []
  const total = arr.length
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE) || 1)
  let current = page[key] || 1
  if (current > totalPages) current = totalPages
  if (current < 1) current = 1
  const start = (current - 1) * PAGE_SIZE
  return {
    items: arr.slice(start, start + PAGE_SIZE),
    total,
    totalPages,
    current,
    from: total === 0 ? 0 : start + 1,
    to: Math.min(start + PAGE_SIZE, total),
  }
}

const filteredProducts = computed(() => {
  let list = adminProducts.value
  if (productStatusFilter.value === 'online') list = list.filter(p => p.online)
  else if (productStatusFilter.value === 'offline') list = list.filter(p => !p.online)
  return filterBySearch(list, listSearch.products, ['name', 'desc', 'tag', 'url'])
})

const filteredShopProducts = computed(() =>
  filterBySearch(products.value, listSearch.shop, ['name', 'desc', 'tag'])
)
const filteredMineSubs = computed(() =>
  filterBySearch(mySubs.value, listSearch.mine, ['name', 'desc', 'tag'])
)
const filteredAgents = computed(() =>
  filterBySearch(admin.agentList, listSearch.agents, ['name', 'account', 'inviteCode'])
)
const filteredPaymentOrders = computed(() =>
  filterBySearch(admin.paymentOrders, listSearch.orders, [
    'product', 'user', 'account', 'reference', 'agentName', 'agentInviteCode', (o) => planText(o.plan), 'amount', 'status',
  ])
)
const filteredUsers = computed(() =>
  filterBySearch(admin.users, listSearch.users, ['name', 'account', 'role', 'agentName', 'balance'])
)
const filteredAgentOrders = computed(() =>
  filterBySearch(agent.orders, listSearch.clients, ['user', 'product', 'reference', 'amount', 'status'])
)
const filteredWithdrawals = computed(() =>
  filterBySearch(admin.withdrawals, listSearch.withdrawals, ['agentName', 'agentAccount', 'amount', 'status'])
)

const pagedProducts = computed(() => paginate(filteredProducts.value, 'products'))
const pagedAgents = computed(() => paginate(filteredAgents.value, 'agents'))
const pagedPaymentOrders = computed(() => paginate(filteredPaymentOrders.value, 'orders'))
const pagedUsers = computed(() => paginate(filteredUsers.value, 'users'))
const pagedAgentOrders = computed(() => paginate(filteredAgentOrders.value, 'clients'))

function setOrderStatusFilter(status) {
  orderStatusFilter.value = status
  page.orders = 1
  loadPaymentOrders()
}

function setProductStatusFilter(status) {
  productStatusFilter.value = status
  page.products = 1
}

function goPage(key, n) {
  const maps = {
    products: pagedProducts,
    agents: pagedAgents,
    orders: pagedPaymentOrders,
    users: pagedUsers,
    clients: pagedAgentOrders,
  }
  const info = maps[key]?.value
  if (!info) return
  page[key] = Math.min(Math.max(1, n), info.totalPages)
}

const adminModalTitle = computed(() => {
  const labels = { product: '产品', agent: '代理', order: '订单', user: '用户' }
  const action = adminModal.mode === 'create' ? '新建' : '编辑'
  return action + (labels[adminModal.type] || '')
})

const recharge = reactive({ open: false, product: null, plan: 'month', vendor: 'alipay', payMethod: 'online' })
const pwdModal = reactive({ open: false, next: '', confirm: '', saving: false, error: '' })
const resetPwdModal = reactive({
  open: false,
  user: null,
  next: '',
  confirm: '',
  saving: false,
  error: '',
  result: '',
})
const showPwdPlain = ref(false)
const paymentSettings = reactive({
  defaultPlan: 'month',
  redeemPurchaseUrl: EXTERNAL_SUBSCRIBE_URL_DEFAULT,
  plans: [
    { id: 'month', label: '按月订阅' },
    { id: 'week', label: '按周订阅' },
    { id: 'day', label: '按天订阅' },
  ],
})
const siteSettingsForm = reactive({
  redeemPurchaseUrl: EXTERNAL_SUBSCRIBE_URL_DEFAULT,
  saving: false,
})
const redeemPurchaseUrl = computed(() => {
  const u = String(paymentSettings.redeemPurchaseUrl || '').trim()
  return u || EXTERNAL_SUBSCRIBE_URL_DEFAULT
})
const plans = [
  { key: 'month', label: '按月订阅', desc: '周期最长，更划算', priceKey: 'priceMonth' },
  { key: 'week', label: '按周订阅', desc: '灵活短期', priceKey: 'priceWeek' },
  { key: 'day', label: '按天订阅', desc: '按需尝鲜', priceKey: 'priceDay' },
]
const toast = reactive({ show: false, msg: '', type: 'success' })
let toastTimer = null
let paymentPollTimer = null

const paymentResult = reactive({
  show: false,
  isSuccessPage: false,
  loading: false,
  status: 'pending',
  reference: '',
  productId: null,
  productName: '',
  productTag: '',
  productGradient: '',
  plan: '',
  amount: 0,
  expiryAt: null,
  message: '',
  orderType: 'subscription',
  balance: null,
})

const roleTitle = computed(() => ({ user: '普通用户', agent: '代理', admin: '管理员' }[role.value]))
function userRoleLabel(u) {
  return { user: '用户', agent: '代理', admin: '管理员' }[u?.role] || '用户'
}
const displayUserName = computed(() => {
  const name = (currentUser.name || '').trim()
  if (name) return name
  const acc = (currentUser.account || '').trim()
  if (!acc) return '用户'
  const base = /^1\d{10}$/.test(acc) ? acc.slice(-4) : acc.split('@')[0]
  return `${base}用户`
})
const canShowTennisFilters = computed(() => role.value === 'admin' || !!currentUser.tennisFilterEnabled)
const canShowBtcSimBetting = computed(() => role.value === 'admin' || !!currentUser.btcSimEnabled)
/** 钱包仅对已开通 BTC 虚拟投注的用户显示，管理员也需单独开通 */
const canShowWallet = computed(() => !!currentUser.btcSimEnabled)
const showWalletSettings = ref(false)
const walletConfigured = ref(false)
const walletUsdcBalance = ref(null)

const tradeRecords = reactive({
  items: [],
  total: 0,
  product: 'all',
  loading: false,
  error: '',
  loaded: false,
})

async function loadTradeRecords({ reset = false } = {}) {
  if (!authed.value) return
  if (tradeRecords.loading) return
  tradeRecords.loading = true
  tradeRecords.error = ''
  try {
    const offset = reset ? 0 : tradeRecords.items.length
    const data = await api.fetchTradeRecords({
      product: tradeRecords.product,
      limit: 20,
      offset,
    })
    const items = Array.isArray(data?.items) ? data.items : []
    tradeRecords.total = Number(data?.total) || 0
    tradeRecords.items = reset ? items : [...tradeRecords.items, ...items]
    tradeRecords.loaded = true
  } catch (e) {
    tradeRecords.error = e.response?.data?.error || e.message || '加载失败'
    if (reset) tradeRecords.items = []
  } finally {
    tradeRecords.loading = false
  }
}

function setTradeProductFilter(product) {
  if (tradeRecords.product === product) return
  tradeRecords.product = product
  loadTradeRecords({ reset: true })
}

function tradeProductLabel(p) {
  if (p === 'btc') return 'BTC'
  if (p === 'tennis-range') return '区间网球'
  if (p === 'tennis-live') return '盘中网球'
  if (p === 'tennis') return '网球'
  return p
}

function tradeActionLabel(a) {
  return a === 'sell' ? '卖出' : '买入'
}

function tradeSideLabel(side) {
  const s = String(side || '').toLowerCase()
  if (s === 'up') return 'UP'
  if (s === 'down') return 'DOWN'
  if (s === 'home') return '主'
  if (s === 'away') return '客'
  return s ? s.toUpperCase() : ''
}

function fmtTradeTime(v) {
  if (!v) return '—'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return String(v)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fmtTradeAmount(row) {
  if (row.action === 'sell' && row.shares != null) {
    const sh = Number(row.shares)
    const px = Number(row.price)
    if (px > 0) return `${sh.toFixed(2)}份@${px.toFixed(2)}`
    return `${sh.toFixed(2)}份`
  }
  if (row.amountUsd != null) {
    const usd = Number(row.amountUsd)
    const px = Number(row.price)
    if (px > 0) return `$${usd.toFixed(2)}@${px.toFixed(2)}`
    return `$${usd.toFixed(2)}`
  }
  return '—'
}

function resetWalletState() {
  walletConfigured.value = false
  walletUsdcBalance.value = null
  showWalletSettings.value = false
}

function fmtWalletUsdc(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

async function loadWalletHeader() {
  if (!canShowWallet.value) {
    resetWalletState()
    return
  }
  try {
    const w = await api.fetchBtcWallet()
    walletConfigured.value = !!w.configured
    walletUsdcBalance.value = w.usdcBalance ?? null
  } catch {
    resetWalletState()
  }
}

function onWalletUpdated(s) {
  walletConfigured.value = !!s?.configured
  if (!s?.configured) {
    walletUsdcBalance.value = null
    return
  }
  if (s.usdcBalance != null) walletUsdcBalance.value = s.usdcBalance
}
const headerTitle = computed(() => {
  if (paymentResult.show) {
    if (paymentResult.status === 'paid') return '支付成功'
    if (paymentResult.status === 'failed' || paymentResult.status === 'error') return '支付失败'
    return '支付结果'
  }
  const map = {
    user: { home: '数据产品', product: '产品详情', mine: '我的', help: '帮助手册' },
    agent: { overview: '分销概览', shop: '首页', product: '产品详情', clients: '我的客户', mine: '我的订阅', help: '帮助手册' },
    admin: { overview: '平台概览', shop: '首页', manage: '管理中心', product: '产品详情', products: '产品管理', agents: '代理管理', orders: '订单中心', users: '用户管理', mine: '我的订阅', help: '帮助手册', 'sofa-monitor': 'Sofascore 监控', 'tennis-live-scraper': '盘中 Top100 采集', 'tennis-live-monitor': '盘中网球监控', 'btc-board': 'BTC 数据看板', 'redeem-codes': '兑换码', 'daily-report': '运营日报', 'site-settings': '站点设置' },
  }
  return (map[role.value] && map[role.value][view.value]) || ''
})

const paymentResultTitle = computed(() => ({
  paid: '支付成功',
  pending: '支付确认中',
  failed: '支付失败',
  cancelled: '订单已取消',
  error: '支付异常',
}[paymentResult.status] || '支付结果'))

const paymentResultHint = computed(() => {
  if (paymentResult.message && ['paid', 'error'].includes(paymentResult.status)) {
    return paymentResult.message
  }
  if (paymentResult.orderType === 'balance') {
    return {
      paid: '余额已到账',
      pending: '正在向支付平台确认结果，请稍候…',
      failed: '支付未完成',
      cancelled: '该订单已取消',
      error: '无法确认支付结果，请稍后查看余额',
    }[paymentResult.status] || paymentResult.message
  }
  return {
    paid: '订阅已生效，可以立即使用产品',
    pending: '正在向支付平台确认结果，请稍候…',
    failed: '支付未完成，您可以重新发起订阅',
    cancelled: '该订单已取消，如需订阅请重新下单',
    error: '无法确认支付结果，请稍后到「我的」查看订阅状态',
  }[paymentResult.status] || paymentResult.message
})

const paymentStatusStyle = computed(() => ({
  paid: { ring: 'bg-success/10 ring-success/20', icon: 'text-success', glyph: '✓' },
  pending: { ring: 'bg-warning/10 ring-warning/20', icon: 'text-warning', glyph: '…' },
  failed: { ring: 'bg-danger/10 ring-danger/20', icon: 'text-danger', glyph: '×' },
  cancelled: { ring: 'bg-slate-100 ring-slate-200', icon: 'text-slate-400', glyph: '—' },
  error: { ring: 'bg-danger/10 ring-danger/20', icon: 'text-danger', glyph: '!' },
}[paymentResult.status] || { ring: 'bg-slate-100 ring-slate-200', icon: 'text-slate-400', glyph: '?' }))
const adminManageViews = ['manage', 'products', 'agents', 'orders', 'users', 'sofa-monitor', 'tennis-live-scraper', 'tennis-live-monitor', 'btc-board', 'redeem-codes', 'daily-report', 'site-settings']
const adminManageSections = [
  {
    key: 'manage',
    title: '管理类',
    desc: '用户、订单与代理等日常运营',
    items: [
      { view: 'daily-report', label: '运营日报', desc: '今日新增客户、激活码与营收', icon: 'chart', color: 'from-emerald-500 to-teal-500' },
      { view: 'products', label: '产品管理', desc: '上架、定价与产品配置', icon: 'grid', color: 'from-indigo-500 to-violet-500' },
      { view: 'agents', label: '代理管理', desc: '代理账号与分成比例', icon: 'users', color: 'from-sky-500 to-cyan-500' },
      { view: 'orders', label: '订单中心', desc: '支付订单与交易记录', icon: 'list', color: 'from-amber-500 to-orange-500' },
      { view: 'users', label: '用户管理', desc: '用户账号与余额维护', icon: 'user', color: 'from-rose-500 to-pink-500' },
      { view: 'redeem-codes', label: '兑换码', desc: '批量生成月/周/天卡并导出 Excel', icon: 'link', color: 'from-violet-500 to-fuchsia-500' },
    ],
  },
  {
    key: 'settings',
    title: '设置类',
    desc: '数据采集与功能开关配置',
    items: [
      { view: 'site-settings', label: '站点设置', desc: '兑换码购买链接等前台配置', icon: 'link', color: 'from-slate-500 to-slate-700' },
      { view: 'sofa-monitor', label: 'Sofascore 监控', desc: '网球数据采集与 Top20', icon: 'chart', color: 'from-emerald-500 to-lime-500' },
      { view: 'tennis-live-scraper', label: '盘中 Top100 采集', desc: 'Top100 运动员赛事拉取', icon: 'tennis', color: 'from-violet-600 to-purple-500' },
      { view: 'tennis-live-monitor', label: '盘中网球监控', desc: 'Top100 进行中场次 · 2 分钟轮询', icon: 'tennis', color: 'from-violet-500 to-fuchsia-500' },
      { view: 'btc-board', label: 'BTC 数据看板', desc: '数据同步开关与看板预览', icon: 'chart', color: 'from-cyan-500 to-blue-600' },
    ],
  },
]
const tabs = computed(() => ({
  user: [{ view: 'home', label: '首页', icon: 'home' }, { view: 'mine', label: '我的', icon: 'user' }],
  agent: [
    { view: 'shop', label: '首页', icon: 'home' },
    { view: 'overview', label: '概览', icon: 'chart' },
    { view: 'clients', label: '客户', icon: 'users' },
    { view: 'mine', label: '我的', icon: 'user' },
  ],
  admin: [
    { view: 'shop', label: '首页', icon: 'home' },
    { view: 'overview', label: '概览', icon: 'chart' },
    { view: 'manage', label: '管理', icon: 'grid' },
    { view: 'mine', label: '我的', icon: 'user' },
  ],
}[role.value]))

function defaultViewForRole(r) {
  return { user: 'home', agent: 'shop', admin: 'shop' }[r] || 'home'
}

function isTabActive(tab) {
  if (role.value === 'admin' && tab.view === 'manage') return adminManageViews.includes(view.value)
  if (tab.view === 'mine' && view.value === 'help') return true
  return view.value === tab.view
}
const activeCount = computed(() => products.value.filter(p => isActive(p.id)).length)
const mySubs = computed(() => products.value.filter(p => userSubs[p.id]).map(p => p))
const pagedMine = computed(() => paginate(filteredMineSubs.value, 'mine'))
function planPriceInfo(product, planKey) {
  const priceKey = { month: 'priceMonth', week: 'priceWeek', day: 'priceDay' }[planKey]
  return {
    current: product?.[priceKey] ?? 0,
  }
}

function normalizeRechargeProduct(product) {
  return product || null
}

const currentPlanPrice = computed(() => {
  if (!recharge.product) return 0
  return planPriceInfo(recharge.product, recharge.plan).current
})
const balanceInsufficient = computed(() => Number(balance.value) < Number(currentPlanPrice.value))

function shopRoute() {
  return role.value === 'user' ? 'home' : 'shop'
}

const showShopList = computed(() =>
  (role.value === 'user' && view.value === 'home') ||
  ((role.value === 'agent' || role.value === 'admin') && view.value === 'shop')
)
const showProductDetail = computed(() => view.value === 'product' && !!openedProduct.value)
const showMine = computed(() => view.value === 'mine')
const showHelp = computed(() => view.value === 'help')
const helpFrom = ref('mine')

function openHelp(from = 'mine') {
  helpFrom.value = from || 'mine'
  go('help')
}

function closeHelp() {
  go(helpFrom.value === 'mine' ? 'mine' : shopRoute())
}

function goPageMine(n) {
  page.mine = Math.min(Math.max(1, n), pagedMine.value.totalPages)
}

function accountValid(a) {
  const t = (a || '').trim()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)
}
const loginValid = computed(() => accountValid(f.account) && f.password.length >= 6)
const registerValid = computed(() => accountValid(f.account) && f.password.length >= 6 && f.password === f.confirm && f.agree)

function buildRegisterLink(code) {
  const c = String(code || '').trim()
  if (!c) return ''
  const url = new URL(window.location.href)
  url.search = ''
  url.hash = ''
  url.searchParams.set('invite', c.toUpperCase())
  return url.toString()
}

const agentRegisterLink = computed(() => buildRegisterLink(agent.inviteCode))

function applyInviteFromUrl() {
  const params = new URLSearchParams(window.location.search)
  const code = (params.get('invite') || params.get('inviteCode') || '').trim()
  if (!code) return
  f.inviteCode = code.toUpperCase()
  authView.value = 'register'
  params.delete('invite')
  params.delete('inviteCode')
  const qs = params.toString()
  window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''))
}

function isActive(pid) { const e = userSubs[pid]; return !!e && e > now.value }
function statusOf(pid) {
  const e = userSubs[pid]
  if (!e) return 'none'
  const rem = e - now.value
  if (rem <= 0) return 'expired'
  if (rem <= 3 * DAY) return 'expiring'
  return 'active'
}
function badgeClass(s) {
  return { active: 'bg-success/10 text-success', expiring: 'bg-warning/10 text-warning', expired: 'bg-danger/10 text-danger', none: 'bg-slate-100 text-slate-400' }[s]
}
function badgeText(s) { return { active: '已订阅', expiring: '即将过期', expired: '已过期', none: '未订阅' }[s] }
function planText(k) { return { month: '月', week: '周', day: '天' }[k] }
function vendorText(v) { return { alipay: '支付宝', wechatpay: '微信支付' }[v] || v }
function fmt(ts) { const d = new Date(ts); return `${d.getMonth() + 1}月${d.getDate()}日` }

function paymentOrderStatusText(s) {
  return { paid: '已付款', pending: '未付款', failed: '支付失败', cancelled: '已取消' }[s] || s
}
function paymentOrderStatusClass(s) {
  return {
    paid: 'bg-success/10 text-success',
    pending: 'bg-warning/10 text-warning',
    failed: 'bg-danger/10 text-danger',
    cancelled: 'bg-slate-100 text-slate-400',
  }[s] || 'bg-slate-100 text-slate-400'
}
function fmtDateTime(ts) {
  if (!ts) return '-'
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function showToast(msg, type) {
  toast.msg = msg; toast.type = type || 'success'; toast.show = true
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.show = false }, 2500)
}

function resetPwdForm() {
  pwdModal.next = ''
  pwdModal.confirm = ''
  pwdModal.error = ''
  pwdModal.saving = false
  pwdModal.open = false
  showPwdPlain.value = false
}

function openPwdModal() {
  pwdModal.error = ''
  pwdModal.next = ''
  pwdModal.confirm = ''
  pwdModal.saving = false
  showPwdPlain.value = false
  pwdModal.open = true
}

function closePwdModal() {
  resetPwdForm()
}

function openResetPwdModal(user) {
  resetPwdModal.user = user
  resetPwdModal.next = ''
  resetPwdModal.confirm = ''
  resetPwdModal.error = ''
  resetPwdModal.result = ''
  resetPwdModal.saving = false
  resetPwdModal.open = true
}

function closeResetPwdModal() {
  resetPwdModal.open = false
  resetPwdModal.user = null
  resetPwdModal.next = ''
  resetPwdModal.confirm = ''
  resetPwdModal.error = ''
  resetPwdModal.result = ''
  resetPwdModal.saving = false
}

function genResetPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  let out = ''
  for (let i = 0; i < 8; i += 1) out += chars[Math.floor(Math.random() * chars.length)]
  resetPwdModal.next = out
  resetPwdModal.confirm = out
  resetPwdModal.error = ''
  resetPwdModal.result = ''
}

async function submitResetUserPassword() {
  if (!resetPwdModal.user?.id) return
  resetPwdModal.error = ''
  resetPwdModal.result = ''
  const manual = !!(resetPwdModal.next || resetPwdModal.confirm)
  if (manual) {
    if (!resetPwdModal.next || resetPwdModal.next.length < 6) {
      resetPwdModal.error = '新密码至少 6 位'
      return
    }
    if (resetPwdModal.next !== resetPwdModal.confirm) {
      resetPwdModal.error = '两次输入的新密码不一致'
      return
    }
  }
  resetPwdModal.saving = true
  try {
    const data = await api.resetUserPassword(
      resetPwdModal.user.id,
      manual ? { password: resetPwdModal.next } : {},
    )
    resetPwdModal.result = data.password || resetPwdModal.next
    resetPwdModal.next = resetPwdModal.result
    resetPwdModal.confirm = resetPwdModal.result
    showToast(`已重置 ${data.account || resetPwdModal.user.account} 的密码`, 'success')
  } catch (e) {
    resetPwdModal.error = e.response?.data?.error || '重置失败'
  } finally {
    resetPwdModal.saving = false
  }
}

async function copyResetPassword() {
  const text = resetPwdModal.result || resetPwdModal.next
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    showToast('密码已复制', 'success')
  } catch {
    showToast('复制失败，请手动选中', 'error')
  }
}

async function submitChangePassword() {
  pwdModal.error = ''
  if (!pwdModal.next || pwdModal.next.length < 6) {
    pwdModal.error = '新密码至少 6 位'
    return
  }
  if (pwdModal.next !== pwdModal.confirm) {
    pwdModal.error = '两次输入的新密码不一致'
    return
  }
  pwdModal.saving = true
  try {
    const data = await api.changePassword(pwdModal.next)
    resetPwdForm()
    showToast(data.message || '密码修改成功', 'success')
  } catch (e) {
    pwdModal.error = e.response?.data?.error || '修改失败'
  } finally {
    pwdModal.saving = false
  }
}

function setUser(u) {
  resetWalletState()
  currentUser.id = u.id
  currentUser.name = u.name
  currentUser.account = u.account
  currentUser.role = u.role
  currentUser.inviteCode = u.boundInviteCode || ''
  currentUser.tennisFilterEnabled = !!u.tennisFilterEnabled
  currentUser.btcSimEnabled = !!u.btcSimEnabled
  role.value = u.role
  balance.value = u.balance
}

async function loadPaymentSettings() {
  try {
    const data = await api.fetchPaymentSettings()
    paymentSettings.defaultPlan = data.defaultPlan || 'month'
    paymentSettings.redeemPurchaseUrl = data.redeemPurchaseUrl || EXTERNAL_SUBSCRIBE_URL_DEFAULT
    siteSettingsForm.redeemPurchaseUrl = paymentSettings.redeemPurchaseUrl
    if (data.plans?.length) paymentSettings.plans = data.plans
  } catch { /* keep defaults */ }
}

async function saveSiteSettings() {
  siteSettingsForm.saving = true
  try {
    const data = await api.updateAdminPaymentSettings({
      redeemPurchaseUrl: siteSettingsForm.redeemPurchaseUrl,
    })
    paymentSettings.redeemPurchaseUrl = data.redeemPurchaseUrl || siteSettingsForm.redeemPurchaseUrl
    siteSettingsForm.redeemPurchaseUrl = paymentSettings.redeemPurchaseUrl
    showToast(data.message || '设置已保存', 'success')
  } catch (e) {
    showToast(e.response?.data?.error || '保存失败', 'error')
  } finally {
    siteSettingsForm.saving = false
  }
}

async function loadProducts() {
  products.value = await api.fetchProducts()
}

async function loadSubscriptions() {
  const subs = await api.fetchSubscriptions()
  Object.keys(userSubs).forEach(k => delete userSubs[k])
  Object.assign(userSubs, subs)
  now.value = Date.now()
}

async function loadAgentData() {
  const overview = await api.fetchAgentOverview()
  agent.clientCount = overview.clientCount
  agent.monthCommission = overview.monthCommission
  agent.withdrawable = overview.withdrawable
  agent.rate = overview.rate
  agent.inviteCode = overview.inviteCode
  agent.trend = overview.trend
  agent.clients = await api.fetchAgentClients()
  agent.orders = await api.fetchAgentOrders(agentOrderStatusFilter.value)
  agent.withdrawLog = await api.fetchWithdrawals()
}

async function loadAgentOrders() {
  agent.orders = await api.fetchAgentOrders(agentOrderStatusFilter.value)
}

function setAgentOrderStatusFilter(status) {
  agentOrderStatusFilter.value = status
  page.clients = 1
  loadAgentOrders()
}

async function loadPaymentOrders() {
  admin.paymentOrders = await api.fetchAdminPaymentOrders(orderStatusFilter.value)
}

async function loadAdminWithdrawals() {
  const [list, pendingList] = await Promise.all([
    api.fetchAdminWithdrawals(adminWithdrawFilter.value),
    api.fetchAdminWithdrawals('pending'),
  ])
  admin.withdrawals = list
  admin.pendingWithdrawCount = pendingList.length
}

function setAdminWithdrawFilter(status) {
  adminWithdrawFilter.value = status
  loadAdminWithdrawals()
}

async function payWithdrawal(id) {
  if (payingWithdrawId.value) return
  payingWithdrawId.value = id
  try {
    const data = await api.payAdminWithdrawal(id)
    showToast(data.message || '已确认打款', 'success')
    await loadAdminWithdrawals()
  } catch (e) {
    showToast(e.response?.data?.error || '确认打款失败', 'error')
  } finally {
    payingWithdrawId.value = null
  }
}

async function loadAdminData() {
  const stats = await api.fetchAdminStats()
  admin.stats = stats.stats
  admin.revenue = stats.revenue
  admin.agentList = await api.fetchAdminAgents()
  await loadPaymentOrders()
  await loadAdminWithdrawals()
  admin.users = await api.fetchAdminUsers()
  adminProducts.value = await api.fetchAdminProducts()
  await loadTodayReport()
}

async function applyDailyReport(target, data) {
  target.date = data.date || ''
  target.newUsers = Number(data.newUsers) || 0
  target.redeemActivated = Number(data.redeemActivated) || 0
  target.revenue = Number(data.revenue) || 0
  target.orderCount = Number(data.orderCount) || 0
  target.paidAmount = Number(data.paidAmount) || 0
  if ('commission' in target) target.commission = Number(data.commission) || 0
  if ('trend' in target) target.trend = Array.isArray(data.trend) ? data.trend : []
}

async function loadTodayReport() {
  todayReport.loading = true
  try {
    const data = await api.fetchAdminDailyReport()
    await applyDailyReport(todayReport, data)
  } catch (e) {
    showToast(e.response?.data?.error || '加载今日报表失败', 'error')
  } finally {
    todayReport.loading = false
  }
}

async function loadDailyReport(date) {
  dailyReport.loading = true
  try {
    const data = await api.fetchAdminDailyReport(date || dailyReport.date || undefined)
    await applyDailyReport(dailyReport, data)
    if (!dailyReport.date) dailyReport.date = data.date
  } catch (e) {
    showToast(e.response?.data?.error || '加载运营日报失败', 'error')
  } finally {
    dailyReport.loading = false
  }
}

function fmtMoney(n) {
  const v = Number(n) || 0
  return v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function emptyForm(type) {
  if (type === 'product') return { name: '', tag: 'chart', gradient: 'linear-gradient(135deg,#6366f1,#8b5cf6)', url: '', desc: '', priceMonth: 39, priceWeek: 12, priceDay: 3, defaultPlan: paymentSettings.defaultPlan || 'month', online: true }
  if (type === 'agent') return { account: '', password: '', name: '', rate: 25, agentStatus: 'approved' }
  if (type === 'order') return { userId: '', productId: '', plan: 'month', amount: '' }
  if (type === 'user') return { account: '', password: '', name: '', role: 'user', balance: 0, tennisFilterEnabled: false, btcSimEnabled: false }
  return {}
}

function setProductDefaultPlan(plan) {
  adminModal.form.defaultPlan = plan
}

function selectProductIcon(option) {
  adminModal.form.tag = option.key
  adminModal.form.gradient = option.gradient
}

async function openAdminModal(type, mode, item) {
  adminModal.type = type
  adminModal.mode = mode
  adminModal.id = item?.id ?? null
  adminModal.form = mode === 'create' ? emptyForm(type) : {
    ...item,
    defaultPlan: item.defaultPlan || paymentSettings.defaultPlan || 'month',
    password: '',
  }
  if (type === 'order' && mode === 'create') {
    if (!admin.users.length) admin.users = await api.fetchAdminUsers()
    if (!adminProducts.value.length) adminProducts.value = await api.fetchAdminProducts()
    adminModal.form.userId = admin.users.find(x => x.role === 'user')?.id || ''
    adminModal.form.productId = adminProducts.value[0]?.id || ''
  }
  adminModal.open = true
}

async function refreshAdminList(type) {
  if (type === 'product') adminProducts.value = await api.fetchAdminProducts()
  else if (type === 'agent') admin.agentList = await api.fetchAdminAgents()
  else if (type === 'order') await loadPaymentOrders()
  else if (type === 'user') admin.users = await api.fetchAdminUsers()
  const keyMap = { product: 'products', agent: 'agents', order: 'orders', user: 'users' }
  const key = keyMap[type]
  if (key && page[key] > 1) {
    const maps = { products: pagedProducts, agents: pagedAgents, orders: pagedPaymentOrders, users: pagedUsers }
    if (maps[key].value.items.length === 0) page[key] = Math.max(1, page[key] - 1)
  }
}

async function saveAdminModal() {
  adminModal.saving = true
  try {
    const { type, mode, id, form } = adminModal
    if (type === 'product') {
      const payload = {
        name: form.name, tag: form.tag, gradient: form.gradient, url: form.url, desc: form.desc,
        priceMonth: Number(form.priceMonth), priceWeek: Number(form.priceWeek), priceDay: Number(form.priceDay),
        defaultPlan: form.defaultPlan,
        online: !!form.online,
      }
      if (mode === 'create') await api.createProduct(payload)
      else await api.updateProduct(id, payload)
    } else if (type === 'agent') {
      if (mode === 'create') await api.createAgent({ account: form.account, password: form.password, name: form.name, rate: Number(form.rate) })
      else await api.updateAgent(id, { name: form.name, rate: Number(form.rate), agentStatus: form.agentStatus, password: form.password || undefined })
    } else if (type === 'order') {
      if (mode === 'create') await api.createOrder({ userId: Number(form.userId), productId: Number(form.productId), plan: form.plan, amount: form.amount ? Number(form.amount) : undefined })
      else await api.updateOrder(id, { plan: form.plan, amount: Number(form.amount) })
    } else if (type === 'user') {
      if (mode === 'create') await api.createUser({ account: form.account, password: form.password, name: form.name, role: form.role, balance: Number(form.balance), tennisFilterEnabled: !!form.tennisFilterEnabled, btcSimEnabled: !!form.btcSimEnabled })
      else {
        await api.updateUser(id, { name: form.name, balance: Number(form.balance), role: form.role, password: form.password || undefined, tennisFilterEnabled: !!form.tennisFilterEnabled, btcSimEnabled: !!form.btcSimEnabled })
        if (Number(id) === currentUser.id) {
          currentUser.tennisFilterEnabled = !!form.tennisFilterEnabled
          currentUser.btcSimEnabled = !!form.btcSimEnabled
        }
      }
    }
    adminModal.open = false
    await refreshAdminList(type)
    showToast(mode === 'create' ? '创建成功' : '更新成功', 'success')
  } catch (e) {
    showToast(e.response?.data?.error || '操作失败', 'error')
  } finally {
    adminModal.saving = false
  }
}

async function deleteAdminItem(type, id) {
  if (!confirm('确定删除？此操作不可恢复')) return
  try {
    if (type === 'product') await api.deleteProduct(id)
    else if (type === 'agent') await api.deleteAgent(id)
    else if (type === 'order') await api.deleteOrder(id)
    else if (type === 'user') await api.deleteUser(id)
    await refreshAdminList(type)
    showToast('已删除', 'success')
  } catch (e) {
    showToast(e.response?.data?.error || '删除失败', 'error')
  }
}

function toDatetimeLocalValue(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

function subscriptionStatusText(sub) {
  if (!sub?.expiryAt) return '未订阅'
  return sub.active ? `有效至 ${fmtDateTime(sub.expiryAt)}` : `已过期 ${fmtDateTime(sub.expiryAt)}`
}

function subscriptionStatusClass(sub) {
  if (!sub?.expiryAt) return 'text-slate-400'
  return sub.active ? 'text-success' : 'text-danger'
}

async function loadUserSubModal(user) {
  userSubModal.loading = true
  userSubModal.user = user
  userSubModal.expiryDraft = {}
  try {
    if (!adminProducts.value.length) adminProducts.value = await api.fetchAdminProducts()
    const data = await api.fetchAdminUserSubscriptions(user.id)
    const subMap = new Map((data.subscriptions || []).map((s) => [s.productId, s]))
    userSubModal.subscriptions = adminProducts.value.map((p) => {
      const row = subMap.get(p.id)
      const expiryAt = row?.expiryAt || null
      const active = !!row?.active
      userSubModal.expiryDraft[p.id] = toDatetimeLocalValue(expiryAt)
      return {
        productId: p.id,
        productName: p.name,
        expiryAt,
        active,
      }
    })
    userSubModal.grant.productId = adminProducts.value[0]?.id || ''
    userSubModal.grant.plan = paymentSettings.defaultPlan || 'month'
    userSubModal.grant.amount = ''
    userSubModal.open = true
  } catch (e) {
    showToast(e.response?.data?.error || '加载订阅失败', 'error')
  } finally {
    userSubModal.loading = false
  }
}

async function refreshAdminUsers() {
  admin.users = await api.fetchAdminUsers()
}

async function saveUserSubscriptionExpiry(productId) {
  const userId = userSubModal.user?.id
  const raw = userSubModal.expiryDraft[productId]
  if (!userId || !raw) return showToast('请设置到期时间', 'error')
  userSubModal.saving = true
  try {
    const data = await api.updateAdminUserSubscription(userId, productId, {
      expiryAt: new Date(raw).getTime(),
    })
    showToast(data.message || '订阅已更新', 'success')
    await loadUserSubModal(userSubModal.user)
    await refreshAdminUsers()
  } catch (e) {
    showToast(e.response?.data?.error || '更新失败', 'error')
  } finally {
    userSubModal.saving = false
  }
}

async function revokeUserSubscription(productId, productName) {
  const userId = userSubModal.user?.id
  if (!userId) return
  if (!confirm(`确定取消 ${productName} 的订阅？`)) return
  userSubModal.saving = true
  try {
    const data = await api.revokeAdminUserSubscription(userId, productId)
    showToast(data.message || '订阅已取消', 'success')
    await loadUserSubModal(userSubModal.user)
    await refreshAdminUsers()
  } catch (e) {
    showToast(e.response?.data?.error || '取消失败', 'error')
  } finally {
    userSubModal.saving = false
  }
}

function bumpUserSubExpiry(productId, days) {
  const sub = userSubModal.subscriptions.find((s) => s.productId === productId)
  const base = sub?.expiryAt && sub.active ? sub.expiryAt : Date.now()
  userSubModal.expiryDraft[productId] = toDatetimeLocalValue(base + days * 86400000)
}

function userSubSummaryLine(u) {
  const subs = u.subscriptions || []
  if (!subs.length) return ''
  const active = subs.filter((s) => s.active)
  if (!active.length) return `订阅 ${subs.length} 项（均已过期）`
  return `有效订阅 ${active.length} 项`
}

async function grantUserSubscription() {
  const userId = userSubModal.user?.id
  const { productId, plan, amount } = userSubModal.grant
  if (!userId || !productId || !plan) return showToast('请选择产品和订阅周期', 'error')
  userSubModal.saving = true
  try {
    const payload = { userId: Number(userId), productId: Number(productId), plan }
    if (amount !== '' && amount !== null && amount !== undefined) payload.amount = Number(amount)
    const data = await api.grantAdminSubscription(payload)
    showToast(data.message || '订阅已开通', 'success')
    await loadUserSubModal(userSubModal.user)
    await refreshAdminUsers()
  } catch (e) {
    showToast(e.response?.data?.error || '开通失败', 'error')
  } finally {
    userSubModal.saving = false
  }
}

async function loadRedeemCodesPage() {
  redeemCodes.loading = true
  try {
    if (!adminProducts.value.length) adminProducts.value = await api.fetchAdminProducts()
    if (redeemCodes.productId === '' || redeemCodes.productId == null) {
      redeemCodes.productId = 'all'
    }
    redeemCodes.batches = await api.fetchRedeemCodeBatches()
    if (redeemCodes.selectedBatchId) {
      await loadRedeemBatchCodes(redeemCodes.selectedBatchId)
    }
  } catch (e) {
    showToast(e.response?.data?.error || '加载兑换码失败', 'error')
  } finally {
    redeemCodes.loading = false
  }
}

async function loadRedeemBatchCodes(batchId, opts = {}) {
  if (!batchId) {
    redeemCodes.selectedBatchId = ''
    redeemCodes.codes = []
    redeemCodes.codesTotal = 0
    redeemCodes.codesPage = 1
    redeemCodes.codesSearch = ''
    return
  }
  const reset = opts.reset !== false && batchId !== redeemCodes.selectedBatchId
  if (reset) {
    redeemCodes.codesPage = 1
    redeemCodes.codesSearch = ''
  }
  if (opts.page != null) redeemCodes.codesPage = Math.max(1, Number(opts.page) || 1)
  if (opts.search !== undefined) redeemCodes.codesSearch = String(opts.search || '')

  redeemCodes.selectedBatchId = batchId
  redeemCodes.codesLoading = true
  try {
    const pageSize = redeemCodes.codesPageSize || 5
    const page = Math.max(1, Number(redeemCodes.codesPage) || 1)
    const data = await api.fetchRedeemCodes({
      batchId,
      search: redeemCodes.codesSearch.trim() || undefined,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    })
    redeemCodes.codes = data.items || []
    redeemCodes.codesTotal = data.total || 0
    const maxPage = Math.max(1, Math.ceil(redeemCodes.codesTotal / pageSize) || 1)
    if (page > maxPage) {
      redeemCodes.codesPage = maxPage
      if (maxPage !== page) {
        const again = await api.fetchRedeemCodes({
          batchId,
          search: redeemCodes.codesSearch.trim() || undefined,
          limit: pageSize,
          offset: (maxPage - 1) * pageSize,
        })
        redeemCodes.codes = again.items || []
        redeemCodes.codesTotal = again.total || 0
      }
    }
  } catch (e) {
    showToast(e.response?.data?.error || '加载码列表失败', 'error')
  } finally {
    redeemCodes.codesLoading = false
  }
}

function redeemCodesTotalPages() {
  const size = redeemCodes.codesPageSize || 5
  return Math.max(1, Math.ceil((redeemCodes.codesTotal || 0) / size) || 1)
}

async function searchRedeemCodes() {
  if (!redeemCodes.selectedBatchId) return
  redeemCodes.codesPage = 1
  await loadRedeemBatchCodes(redeemCodes.selectedBatchId, { reset: false, page: 1 })
}

async function gotoRedeemCodesPage(page) {
  if (!redeemCodes.selectedBatchId) return
  const max = redeemCodesTotalPages()
  const p = Math.min(max, Math.max(1, Number(page) || 1))
  if (p === redeemCodes.codesPage && redeemCodes.codes.length) return
  await loadRedeemBatchCodes(redeemCodes.selectedBatchId, { reset: false, page: p })
}

async function generateRedeemCodes() {
  if (redeemCodes.productId === '' || redeemCodes.productId == null) {
    return showToast('请选择产品', 'error')
  }
  const count = Number(redeemCodes.count)
  if (!(count >= 1 && count <= 500)) return showToast('数量需在 1–500', 'error')
  redeemCodes.generating = true
  try {
    const payload = {
      productId: redeemCodes.productId === 'all' ? 'all' : Number(redeemCodes.productId),
      plan: redeemCodes.plan,
      count,
    }
    const days = Number(redeemCodes.expiresInDays)
    if (Number.isFinite(days) && days > 0) payload.expiresInDays = Math.floor(days)
    const data = await api.generateRedeemCodes(payload)
    redeemCodes.lastBatchId = data.batchId
    redeemCodes.lastCodes = data.codes || []
    const prodLabel = data.allProducts ? '全部产品' : data.productName
    showToast(`已生成 ${data.count} 个${prodLabel}·${data.planLabel}卡兑换码`, 'success')
    redeemCodes.batches = await api.fetchRedeemCodeBatches()
    await loadRedeemBatchCodes(data.batchId)
  } catch (e) {
    showToast(e.response?.data?.error || e.message || '生成失败', 'error')
  } finally {
    redeemCodes.generating = false
  }
}

async function downloadRedeemBatch(batchId) {
  const id = batchId || redeemCodes.lastBatchId
  if (!id) return showToast('请先生成或选择批次', 'error')
  redeemCodes.downloading = true
  try {
    await api.downloadRedeemCodesExcel(id)
    showToast('Excel 已开始下载', 'success')
  } catch (e) {
    showToast(e.response?.data?.error || e.message || '下载失败', 'error')
  } finally {
    redeemCodes.downloading = false
  }
}

async function removeRedeemCode(item) {
  if (!item?.id) return
  if (!confirm(`移除兑换码 ${item.code}？未使用码将标记为已移除`)) return
  redeemCodes.managing = true
  try {
    await api.disableRedeemCode(item.id)
    showToast('已移除', 'success')
    await loadRedeemBatchCodes(redeemCodes.selectedBatchId)
    redeemCodes.batches = await api.fetchRedeemCodeBatches()
  } catch (e) {
    showToast(e.response?.data?.error || e.message || '移除失败', 'error')
  } finally {
    redeemCodes.managing = false
  }
}

async function deleteRedeemCodeItem(item) {
  if (!item?.id) return
  if (!confirm(`删除兑换码 ${item.code}？此操作不可恢复`)) return
  redeemCodes.managing = true
  try {
    await api.deleteRedeemCode(item.id)
    showToast('已删除', 'success')
    await loadRedeemBatchCodes(redeemCodes.selectedBatchId)
    redeemCodes.batches = await api.fetchRedeemCodeBatches()
  } catch (e) {
    showToast(e.response?.data?.error || e.message || '删除失败', 'error')
  } finally {
    redeemCodes.managing = false
  }
}

async function removeRedeemBatch(batchId) {
  if (!batchId) return
  if (!confirm(`移除该批次全部未使用兑换码？`)) return
  redeemCodes.managing = true
  try {
    const data = await api.disableRedeemBatch(batchId)
    showToast(data.message || '已移除', 'success')
    redeemCodes.batches = await api.fetchRedeemCodeBatches()
    if (redeemCodes.selectedBatchId === batchId) await loadRedeemBatchCodes(batchId)
  } catch (e) {
    showToast(e.response?.data?.error || e.message || '移除失败', 'error')
  } finally {
    redeemCodes.managing = false
  }
}

async function deleteRedeemBatch(batchId) {
  if (!batchId) return
  if (!confirm(`删除该批次全部兑换码？此操作不可恢复`)) return
  redeemCodes.managing = true
  try {
    const data = await api.deleteRedeemBatch(batchId)
    showToast(data.message || '已删除', 'success')
    if (redeemCodes.selectedBatchId === batchId) {
      redeemCodes.selectedBatchId = ''
      redeemCodes.codes = []
      redeemCodes.codesTotal = 0
    }
    if (redeemCodes.lastBatchId === batchId) {
      redeemCodes.lastBatchId = ''
      redeemCodes.lastCodes = []
    }
    redeemCodes.batches = await api.fetchRedeemCodeBatches()
  } catch (e) {
    showToast(e.response?.data?.error || e.message || '删除失败', 'error')
  } finally {
    redeemCodes.managing = false
  }
}

function fmtRedeemTime(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function resolveRedeemProductId() {
  if (redeemModalProduct.value?.id) return Number(redeemModalProduct.value.id)
  if (redeemInput.productId) return Number(redeemInput.productId)
  return null
}

async function submitRedeemCode() {
  const code = String(redeemInput.code || '').trim()
  if (!code) return showToast('请输入兑换码', 'error')
  const productId = resolveRedeemProductId()
  redeemInput.busy = true
  try {
    const data = await api.redeemSubscriptionCode(code, productId)
    if (data.subscriptions) {
      Object.keys(userSubs).forEach((k) => delete userSubs[k])
      Object.assign(userSubs, data.subscriptions)
    } else {
      await loadSubscriptions()
    }
    redeemInput.code = ''
    redeemInput.productId = ''
    showRedeemModal.value = false
    redeemModalProduct.value = null
    showToast(data.message || '兑换成功', 'success')
  } catch (e) {
    showToast(e.response?.data?.error || '兑换失败', 'error')
  } finally {
    redeemInput.busy = false
  }
}

function openRedeem(p) {
  redeemModalProduct.value = p || openedProduct.value || null
  redeemInput.code = ''
  redeemInput.productId = redeemModalProduct.value?.id || ''
  showRedeemModal.value = true
}

function closeRedeemModal() {
  if (redeemInput.busy) return
  showRedeemModal.value = false
  redeemModalProduct.value = null
  redeemInput.productId = ''
}

async function toggleProductOnline(p) {
  try {
    const online = !p.online
    await api.updateProduct(p.id, {
      name: p.name, tag: p.tag, gradient: p.gradient, url: p.url, desc: p.desc,
      priceMonth: p.priceMonth, priceWeek: p.priceWeek, priceDay: p.priceDay,
      defaultPlan: p.defaultPlan || 'month',
      online,
    })
    await refreshAdminList('product')
    showToast(online ? '已上架' : '已下架', 'success')
  } catch (e) {
    showToast(e.response?.data?.error || '操作失败', 'error')
  }
}

function agentStatusText(s) {
  return { pending: '待审核', approved: '已通过', rejected: '已拒绝' }[s] || s
}

function withdrawStatusText(s) {
  return { pending: '待打款', approved: '已通过', rejected: '已拒绝', paid: '已打款' }[s] || s
}
function withdrawStatusClass(s) {
  return {
    pending: 'bg-warning/10 text-warning',
    approved: 'bg-primary-50 text-primary-700',
    rejected: 'bg-danger/10 text-danger',
    paid: 'bg-success/10 text-success',
  }[s] || 'bg-slate-100 text-slate-400'
}

async function refreshRoleData() {
  if (role.value === 'user') {
    await loadProducts()
    await loadSubscriptions()
  } else if (role.value === 'agent') {
    await loadProducts()
    await loadSubscriptions()
    await loadAgentData()
  } else if (role.value === 'admin') {
    await loadProducts()
    await loadSubscriptions()
    await loadAdminData()
  }
}

async function initSession() {
  loading.value = true
  try {
    const token = localStorage.getItem('token')
    if (!token) { authed.value = false; return }
    const user = await api.fetchMe()
    setUser(user)
    authed.value = true
    view.value = defaultViewForRole(user.role)
    await refreshRoleData()
  } catch {
    api.logoutLocal()
    authed.value = false
  } finally {
    loading.value = false
  }
}

watch(() => f.account, () => { loginError.value = ''; registerError.value = '' })
watch(() => f.password, () => { loginError.value = ''; registerError.value = '' })
watch(() => f.confirm, () => { registerError.value = '' })
watch(() => f.agree, () => { registerError.value = '' })
watch(authView, () => { loginError.value = ''; registerError.value = '' })

async function doLogin() {
  if (!loginValid.value) {
    loginError.value = '请输入正确的邮箱并填写密码'
    return
  }
  loginError.value = ''
  try {
    const data = await api.login(f.account, f.password)
    setUser(data.user)
    authed.value = true
    view.value = defaultViewForRole(data.user.role)
    await refreshRoleData()
    showToast('登录成功', 'success')
  } catch (e) {
    loginError.value = e.response?.data?.error || '账号或密码错误'
  }
}

async function doRegister() {
  if (!accountValid(f.account)) {
    registerError.value = '请输入正确的邮箱'
    return
  }
  if (!f.password || f.password.length < 6) {
    registerError.value = '密码至少 6 位'
    return
  }
  if (f.password !== f.confirm) {
    registerError.value = '两次输入的密码不一致'
    return
  }
  if (!f.agree) {
    registerError.value = '请先阅读并同意用户协议与隐私政策'
    return
  }
  registerError.value = ''
  try {
    const data = await api.register({
      account: f.account, password: f.password,
      regRole: f.regRole, inviteCode: f.inviteCode,
    })
    setUser(data.user)
    authed.value = true
    view.value = f.regRole === 'agent' ? 'shop' : 'home'
    await refreshRoleData()
    showToast(data.message, 'success')
  } catch (e) {
    registerError.value = e.response?.data?.error || '注册失败'
  }
}

function logout() {
  api.logoutLocal()
  resetWalletState()
  authed.value = false
  authView.value = 'login'
  loginError.value = ''
  registerError.value = ''
  f.account = ''; f.password = ''; f.confirm = ''; f.agree = false; f.inviteCode = ''
  currentUser.id = null
  currentUser.name = ''
  currentUser.account = ''
  currentUser.role = 'user'
  currentUser.inviteCode = ''
  currentUser.tennisFilterEnabled = false
  currentUser.btcSimEnabled = false
  role.value = 'user'
}

function go(v) {
  view.value = v
  if (v === 'products') page.products = 1
  if (v === 'agents') page.agents = 1
  if (v === 'orders') page.orders = 1
  if (v === 'users') page.users = 1
  if (v === 'clients') page.clients = 1
  if (v === 'mine') page.mine = 1
}

function openProduct(p) {
  openedProduct.value = p
  now.value = Date.now()
  view.value = 'product'
}

function openRecharge(p) {
  const product = normalizeRechargeProduct(p)
  recharge.product = product
  recharge.plan = product?.defaultPlan || paymentSettings.defaultPlan || 'month'
  recharge.vendor = 'alipay'
  recharge.payMethod = 'online'
  recharge.open = true
}

function submitPayForm(form) {
  // NihaoPay 可能直接返回完整 HTML form
  if (form.form && typeof form.form === 'string') {
    const wrap = document.createElement('div')
    wrap.style.display = 'none'
    wrap.innerHTML = form.form
    const f = wrap.querySelector('form')
    if (f) {
      document.body.appendChild(wrap)
      HTMLFormElement.prototype.submit.call(f)
      return
    }
    wrap.remove()
  }

  const f = document.createElement('form')
  f.method = form.method || 'POST'
  f.action = form.actionUrl
  f.target = form.target || '_self'
  for (const [k, v] of Object.entries(form.params || {})) {
    if (k === 'submit') continue // name=submit 会覆盖 form.submit() 方法
    const input = document.createElement('input')
    input.type = 'hidden'
    input.name = k
    input.value = v
    f.appendChild(input)
  }
  document.body.appendChild(f)
  HTMLFormElement.prototype.submit.call(f)
}

async function confirmRecharge() {
  const p = recharge.product
  if (!p) return
  if (recharge.payMethod === 'balance') {
    return confirmBalanceSubscribe()
  }
  try {
    const data = await api.createPayment(p.id, recharge.plan, recharge.vendor)
    recharge.open = false
    if (data.callbackWarning) showToast(data.callbackWarning, 'error')
    showToast('正在跳转支付页面…', 'success')
    if (data.redirectUrl) {
      window.location.href = data.redirectUrl
    } else if (data.form) {
      submitPayForm(data.form)
    } else {
      showToast('未获取到支付链接', 'error')
    }
  } catch (e) {
    const msg = e.response?.data?.error || e.message || '创建支付失败'
    console.error('createPayment failed', e.response?.data || e)
    showToast(msg, 'error')
  }
}

async function confirmBalanceSubscribe() {
  const p = recharge.product
  if (!p) return
  if (balanceInsufficient.value) {
    showToast('余额不足', 'error')
    return
  }
  try {
    const data = await api.subscribe(p.id, recharge.plan)
    balance.value = data.balance
    if (data.subscriptions) Object.assign(userSubs, data.subscriptions)
    now.value = Date.now()
    recharge.open = false
    showToast(data.message || '订阅成功', 'success')
    if (role.value === 'agent') await loadAgentData()
  } catch (e) {
    const msg = e.response?.data?.error || e.message || '余额支付失败'
    showToast(msg, 'error')
  }
}

function stopPaymentPoll() {
  if (paymentPollTimer) {
    clearInterval(paymentPollTimer)
    paymentPollTimer = null
  }
}

function applyPaymentStatusData(data) {
  const map = { paid: 'paid', pending: 'pending', failed: 'failed', cancelled: 'cancelled' }
  paymentResult.status = map[data.status] || 'pending'
  paymentResult.reference = data.reference || paymentResult.reference
  paymentResult.productId = data.productId
  paymentResult.productName = data.productName || ''
  paymentResult.productTag = data.productTag || ''
  paymentResult.productGradient = data.productGradient || ''
  paymentResult.plan = data.plan || ''
  paymentResult.amount = data.amount || 0
  paymentResult.expiryAt = data.expiryAt
  paymentResult.message = data.message || ''
  paymentResult.orderType = data.orderType || 'subscription'
  paymentResult.balance = data.balance ?? paymentResult.balance
  if (data.subscriptions) Object.assign(userSubs, data.subscriptions)
  if (data.balance != null) balance.value = data.balance
  now.value = Date.now()
}

async function refreshPaymentStatus() {
  if (!paymentResult.reference) return
  paymentResult.loading = true
  try {
    const token = localStorage.getItem('token')
    const data = token
      ? await api.fetchPaymentStatus(paymentResult.reference)
      : await api.fetchPublicPaymentStatus(paymentResult.reference)
    applyPaymentStatusData(data)
    if (data.status === 'paid') {
      stopPaymentPoll()
      if (authed.value && role.value === 'agent') await loadAgentData()
    } else if (data.status === 'pending') {
      startPaymentPoll()
    } else {
      stopPaymentPoll()
    }
  } catch {
    paymentResult.status = 'error'
    paymentResult.message = '无法确认支付结果，请稍后重试'
    stopPaymentPoll()
  } finally {
    paymentResult.loading = false
  }
}

function startPaymentPoll() {
  if (paymentPollTimer) return
  paymentPollTimer = setInterval(async () => {
    if (!paymentResult.show || paymentResult.status === 'paid') {
      stopPaymentPoll()
      return
    }
    try {
      const token = localStorage.getItem('token')
      const data = token
        ? await api.fetchPaymentStatus(paymentResult.reference)
        : await api.fetchPublicPaymentStatus(paymentResult.reference)
      applyPaymentStatusData(data)
      if (data.status === 'paid') {
        stopPaymentPoll()
        const toastMsg = data.orderType === 'balance' ? '余额已到账' : '支付成功，订阅已生效'
        showToast(toastMsg, 'success')
        if (role.value === 'agent') await loadAgentData()
      } else if (data.status !== 'pending') {
        stopPaymentPoll()
      }
    } catch { /* ignore poll errors */ }
  }, 3000)
}

function openPaymentResult(ref, initialStatus = 'pending', isSuccessPage = false) {
  paymentResult.show = true
  paymentResult.isSuccessPage = isSuccessPage
  paymentResult.reference = ref
  paymentResult.status = initialStatus
  paymentResult.loading = true
  refreshPaymentStatus()
}

function closePaymentResult() {
  stopPaymentPoll()
  paymentResult.show = false
  paymentResult.isSuccessPage = false
  window.history.replaceState({}, '', '/')
  if (!authed.value) {
    authView.value = 'login'
    return
  }
  go(role.value === 'user' || role.value === 'agent' || role.value === 'admin' ? shopRoute() : 'overview')
}

function useProductFromPayment() {
  const prod = products.value.find(x => String(x.id) === String(paymentResult.productId))
  stopPaymentPoll()
  paymentResult.show = false
  if (prod) openProduct(prod)
  else go(shopRoute())
}

function retryPayment() {
  if (paymentResult.orderType === 'balance') {
    closePaymentResult()
    return
  }
  const prod = products.value.find(x => String(x.id) === String(paymentResult.productId))
  closePaymentResult()
  if (prod) openRedeem(prod)
}

async function handlePaymentReturn() {
  const path = window.location.pathname.replace(/\/$/, '') || '/'
  const params = new URLSearchParams(window.location.search)
  const ref = params.get('ref')
  const msg = params.get('msg')

  if (path === '/payment/success' && ref) {
    window.history.replaceState({}, '', '/')
    openPaymentResult(ref, 'pending', true)
    return
  }

  if (path === '/payment/failure') {
    window.history.replaceState({}, '', '/')
    if (ref) {
      openPaymentResult(ref, 'failed')
      paymentResult.message = msg === 'payment_failed' ? '支付失败，请重试' : '支付未完成'
      paymentResult.loading = false
      stopPaymentPoll()
      return
    }
    paymentResult.show = true
    paymentResult.status = 'error'
    paymentResult.message = msg === 'order_not_found'
      ? '订单不存在'
      : msg === 'missing_reference'
        ? '缺少订单号'
        : '支付异常，请稍后重试'
    paymentResult.loading = false
    return
  }

  const payment = params.get('payment')
  if (!payment || !ref) return

  window.history.replaceState({}, '', window.location.pathname)

  const statusMap = {
    success: 'pending',
    result: 'pending',
    callback: 'pending',
    pending: 'pending',
    failure: 'failed',
    error: 'error',
  }
  const initial = statusMap[payment] || 'pending'
  openPaymentResult(ref, initial, payment === 'result' || payment === 'success')

  if (payment === 'failure') {
    paymentResult.status = 'failed'
    paymentResult.message = '支付失败，请重试'
    paymentResult.loading = false
    stopPaymentPoll()
  } else if (payment === 'error') {
    paymentResult.status = 'error'
    paymentResult.message = params.get('msg') === 'order_not_found'
      ? '订单不存在'
      : params.get('msg') === 'missing_reference'
        ? '缺少订单号'
        : '支付异常，请稍后重试'
    paymentResult.loading = false
    stopPaymentPoll()
  }
}

async function doWithdraw() {
  try {
    const data = await api.withdraw()
    agent.withdrawable = data.withdrawable
    agent.withdrawLog = data.withdrawLog
    showToast(data.message, 'success')
  } catch (e) {
    showToast(e.response?.data?.error || '提现失败', 'error')
  }
}

async function copyRegisterLink(code) {
  const link = buildRegisterLink(code || agent.inviteCode)
  if (!link) return
  try {
    await navigator.clipboard.writeText(link)
    showToast('注册链接已复制', 'success')
  } catch {
    showToast('复制失败', 'error')
  }
}

watch(view, async (v) => {
  if (!authed.value) return
  if (role.value === 'agent') {
    if (v === 'shop' || v === 'mine') {
      await loadProducts()
      if (v === 'mine') await loadSubscriptions()
    } else if (v === 'clients') await loadAgentOrders()
    else if (v === 'overview') await loadAgentData()
  }
  if (role.value === 'admin' && ['overview', 'shop', 'manage', 'products', 'agents', 'orders', 'users', 'mine', 'redeem-codes', 'daily-report', 'site-settings'].includes(v)) {
    if (v === 'shop' || v === 'mine') {
      await loadProducts()
      if (v === 'mine') await loadSubscriptions()
    } else if (v === 'products') adminProducts.value = await api.fetchAdminProducts()
    else if (v === 'agents') admin.agentList = await api.fetchAdminAgents()
    else if (v === 'orders') await loadPaymentOrders()
    else if (v === 'users') admin.users = await api.fetchAdminUsers()
    else if (v === 'redeem-codes') await loadRedeemCodesPage()
    else if (v === 'daily-report') await loadDailyReport(dailyReport.date || undefined)
    else if (v === 'site-settings') {
      await loadPaymentSettings()
      siteSettingsForm.redeemPurchaseUrl = paymentSettings.redeemPurchaseUrl
    }
    else await loadAdminData()
    if (v === 'overview' && role.value === 'admin') await loadAdminWithdrawals()
  }
  if (role.value === 'user' && v === 'mine') await loadSubscriptions()
})

watch(listSearch, () => {
  page.products = 1
  page.agents = 1
  page.orders = 1
  page.users = 1
  page.clients = 1
  page.mine = 1
}, { deep: true })

onMounted(async () => {
  await loadPaymentSettings()
  await initSession()
  if (!authed.value) applyInviteFromUrl()
  await handlePaymentReturn()
})

watch(
  () => (authed.value && showMine.value ? 1 : 0),
  (on) => {
    if (on) loadTradeRecords({ reset: true })
  },
)

watch(
  () => (authed.value && canShowWallet.value ? currentUser.id : null),
  async (userId) => {
    resetWalletState()
    if (userId != null) await loadWalletHeader()
  },
  { immediate: true },
)

watch(
  () => authed.value && canShowBtcSimBetting.value,
  async (on) => {
    if (on) {
      loadSimState()
      loadLiveTradeState()
      setLiveTradeHandler(async (order) => {
        try {
          const resp = await api.placeBtcTrade({
            market: order.market,
            side: order.side,
            amountUsd: order.amountUsd,
          })
          markLivePlaced(order.market, order.roundTs)
          const fillPrice = resolveBuyFillPrice(resp, order.entryPrice)
          const fillShares = resolveBuyFillShares(resp, order.amountUsd, fillPrice || order.entryPrice)
          if (order.roundTs && fillPrice > 0) {
            recordLiveEntry(order.market, order.roundTs, order.side, fillShares || order.amountUsd / fillPrice, fillPrice)
          }
          recordLiveOrder({
            side: order.side,
            amount: order.amountUsd,
            market: order.market,
            orderId: resp.orderId || '',
            at: Date.now(),
            ok: true,
            auto: true,
            roundTs: order.roundTs,
            action: 'buy',
            shares: fillShares,
            entryPrice: fillPrice,
          })
          loadWalletHeader()
          setTimeout(() => loadWalletHeader(), 1500)
        } catch (e) {
          recordLiveOrder({
            side: order.side,
            amount: order.amountUsd,
            market: order.market,
            orderId: '',
            at: Date.now(),
            ok: false,
            auto: true,
            roundTs: order.roundTs,
            error: e.response?.data?.error || e.message || '自动同步失败',
          })
        }
      })
      setLiveSellHandler(async (order) => {
        try {
          const resp = await api.placeBtcSell({
            market: order.market,
            side: order.side,
            shares: 'all',
          })
          const entry = getLiveEntry(order.market, order.roundTs, order.side)
          const sold = Number(resp.soldShares || entry?.shares || 0)
          const fillPrice = resolveSellFillPrice(resp, order.price || entry?.price)
          if (order.roundTs) clearLiveEntry(order.market, order.roundTs, order.side)
          recordLiveOrder({
            side: order.side,
            amount: sold,
            shares: sold,
            market: order.market,
            orderId: resp.orderId || '',
            at: Date.now(),
            ok: true,
            auto: true,
            roundTs: order.roundTs,
            action: 'sell',
            entryPrice: fillPrice || Number(order.price) || 0,
          })
          loadWalletHeader()
          setTimeout(() => loadWalletHeader(), 1500)
        } catch (e) {
          recordLiveOrder({
            side: order.side,
            amount: 0,
            shares: 0,
            market: order.market,
            orderId: '',
            at: Date.now(),
            ok: false,
            auto: true,
            roundTs: order.roundTs,
            error: e.response?.data?.error || e.message || '止损卖出失败',
            action: 'sell',
          })
        }
      })
      startBackgroundRunner(() => api.fetchBtcState(), 10000)
    } else {
      setLiveTradeHandler(null)
      setLiveSellHandler(null)
      stopBackgroundRunner()
    }
  },
  { immediate: true },
)

onUnmounted(() => {
  stopPaymentPoll()
  stopBackgroundRunner()
})

const icons = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5L12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V4"/><path d="M4 20h16"/><path d="M8 16v-4M12 16V8M16 16v-6"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M16 5a3.5 3.5 0 0 1 0 7"/><path d="M18 20a6 6 0 0 0-3-5"/></svg>',
  wallet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M16 12h3"/><path d="M3 9h14a2 2 0 0 1 2 2"/></svg>',
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1.2"/><circle cx="3.5" cy="12" r="1.2"/><circle cx="3.5" cy="18" r="1.2"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4"><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1.5 1.5"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1.5-1.5"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4"><path d="M15 18l-6-6 6-6"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="w-12 h-12"><path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/></svg>',
  help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4"/><path d="M12 17h.01"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.6 10.6a3 3 0 0 0 4.2 4.2"/><path d="M9.4 4.7A9.6 9.6 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4M6 6.3A17 17 0 0 0 2 12s3.5 7 10 7a9.6 9.6 0 0 0 3.5-.6"/></svg>',
}
function icon(name) { return icons[name] || '' }

function canAccessProduct(pid) {
  if (role.value === 'admin') return true
  return isActive(pid)
}

/** 站内路径产品（旧 /tennis/ HTML）；网球已改为 Vue 组件 */
function isDirectProduct(product) {
  const u = (product?.url || '').trim()
  return u.startsWith('/') && !u.startsWith('//')
}

/** Sofascore Courtline 网球：详情页用 Vue 直出，不用 iframe */
function isTennisLiveProduct(product) {
  const tag = String(product?.tag || '').toLowerCase()
  if (tag === 'tennis-live') return true
  return /盘中/.test(String(product?.name || ''))
}

function isTennisRangeProduct(product) {
  const tag = String(product?.tag || '').toLowerCase()
  if (tag === 'tennis-range') return true
  return /区间网球/.test(String(product?.name || ''))
}

function isTennisProduct(product) {
  if (isTennisRangeProduct(product) || isTennisLiveProduct(product)) return false
  const tag = String(product?.tag || '').toLowerCase()
  if (tag === 'tennis') return true
  return /网球|tennis/i.test(String(product?.name || ''))
}

/** BTC 持仓看板：Vue 直出，不用 iframe */
function isBtcBoardProduct(product) {
  const tag = String(product?.tag || '').toLowerCase()
  if (tag === 'crypto') return /btc|持仓/i.test(String(product?.name || ''))
  return /btc.*持仓|持仓看板|btc.*board/i.test(String(product?.name || ''))
}

/** DOTA2 Polymarket 盘口（与 Elo 的 tag=dota 区分） */
function isDota2Product(product) {
  const tag = String(product?.tag || '').toLowerCase()
  if (tag === 'dota2') return true
  const name = String(product?.name || '').trim()
  return /^dota\s*2$/i.test(name) || /^dota2$/i.test(name)
}

/** NBA Polymarket */
function isNbaProduct(product) {
  const tag = String(product?.tag || '').toLowerCase()
  if (tag === 'nba' || tag === 'basketball') return true
  return /\bnba\b|篮球/i.test(String(product?.name || ''))
}

/** DOTA Elo 看板：Vue 直出，不用 iframe */
function isDotaProduct(product) {
  if (isDota2Product(product)) return false
  const tag = String(product?.tag || '').toLowerCase()
  if (tag === 'dota') return true
  return /dota/i.test(String(product?.name || ''))
}

function isNativeBoardProduct(product) {
  return (
    isTennisProduct(product) ||
    isTennisRangeProduct(product) ||
    isTennisLiveProduct(product) ||
    isBtcBoardProduct(product) ||
    isDotaProduct(product) ||
    isDota2Product(product) ||
    isNbaProduct(product)
  )
}

function showSubscriptionInHeader(product) {
  // 手机上兑换入口放顶部，避免滚到看板/内容最底才看到
  return !!product
}

function directProductUrl(product) {
  const u = (product?.url || '').trim()
  if (!u) return ''
  return u.endsWith('/') || u.includes('?') || u.includes('#') ? u : `${u}/`
}

function productEmbedUrl(product) {
  if (!product?.id || !product?.url?.trim()) return ''
  if (isNativeBoardProduct(product)) return ''
  if (!canAccessProduct(product.id)) return ''
  if (isDirectProduct(product)) return directProductUrl(product)
  const token = localStorage.getItem('token')
  if (!token) return ''
  return `/api/embed/${product.id}?token=${encodeURIComponent(token)}`
}
</script>

<template>
  <div class="min-h-screen text-slate-800">
    <div v-if="loading" class="min-h-screen flex items-center justify-center bg-slate-900 text-white">加载中...</div>

    <template v-else>
      <div class="relative mx-auto max-w-md min-h-screen bg-slate-50 flex flex-col phone-shadow overflow-hidden">

        <!-- 支付结果 / 成功页 -->
        <template v-if="paymentResult.show">
          <header
            :class="[
              'text-white px-4 pt-5 pb-6 shrink-0',
              paymentResult.status === 'paid'
                ? 'bg-gradient-to-br from-emerald-500 via-green-600 to-teal-600'
                : 'bg-gradient-to-br from-indigo-600 via-indigo-700 to-violet-800'
            ]">
            <div class="text-[10px] uppercase tracking-widest opacity-70 mb-1">数据分析平台</div>
            <div class="text-xl font-bold">{{ headerTitle }}</div>
            <p v-if="paymentResult.status === 'paid' && !paymentResult.loading" class="text-sm text-white/85 mt-2">
              {{ paymentResult.orderType === 'balance' ? '余额已到账，可立即使用' : '订阅已生效，可立即使用产品' }}
            </p>
          </header>

          <div class="flex-1 overflow-y-auto no-scrollbar px-4 py-6 space-y-4 -mt-3">
            <div class="bg-white rounded-2xl p-6 shadow-sm text-center fade-up">
              <div v-if="paymentResult.loading" class="py-6">
                <div class="mx-auto w-14 h-14 rounded-full border-4 border-primary-100 border-t-primary-600 animate-spin"></div>
                <p class="text-sm text-slate-500 mt-4">正在确认支付结果…</p>
              </div>
              <template v-else>
                <div
                  :class="['mx-auto w-20 h-20 rounded-full ring-8 flex items-center justify-center text-3xl font-bold mb-4', paymentStatusStyle.ring, paymentStatusStyle.icon]">
                  <span v-if="paymentResult.status==='pending'" class="animate-pulse">…</span>
                  <span v-else>{{ paymentStatusStyle.glyph }}</span>
                </div>
                <h2 class="text-2xl font-bold text-slate-800">{{ paymentResultTitle }}</h2>
                <p class="text-sm text-slate-500 mt-2 leading-relaxed">{{ paymentResultHint }}</p>
                <p v-if="paymentResult.status==='paid' && paymentResult.amount" class="text-3xl font-bold text-primary-700 mt-4 tabular-nums">
                  ¥{{ paymentResult.amount }}
                </p>
                <p v-if="paymentResult.status==='pending'" class="text-xs text-slate-400 mt-3">系统将自动刷新，也可手动点击刷新</p>
              </template>
            </div>

            <div v-if="paymentResult.reference && !paymentResult.loading" class="bg-white rounded-2xl p-4 shadow-sm space-y-3 fade-up">
              <div v-if="paymentResult.productName" class="flex items-center gap-3">
                <ProductIcon
                  v-if="paymentResult.orderType !== 'balance'"
                  :product="{ id: paymentResult.productId, name: paymentResult.productName, tag: paymentResult.productTag, gradient: paymentResult.productGradient }"
                  size="md"
                />
                <div v-else class="w-12 h-12 rounded-xl bg-gradient-to-br from-amber-400 to-orange-500 text-white flex items-center justify-center text-xl font-bold shrink-0">¥</div>
                <div class="min-w-0">
                  <div class="font-medium truncate">{{ paymentResult.productName }}</div>
                  <div v-if="paymentResult.plan" class="text-xs text-slate-400">按{{ planText(paymentResult.plan) }}订阅</div>
                  <div v-else-if="paymentResult.orderType === 'balance'" class="text-xs text-slate-400">账户余额</div>
                </div>
              </div>
              <div class="border-t border-slate-100 pt-3 space-y-2.5 text-sm">
                <div class="flex justify-between gap-3">
                  <span class="text-slate-400 shrink-0">订单号</span>
                  <span class="text-slate-700 font-mono text-xs text-right break-all">{{ paymentResult.reference }}</span>
                </div>
                <div v-if="paymentResult.status==='paid' && paymentResult.orderType==='balance' && paymentResult.balance != null" class="flex justify-between">
                  <span class="text-slate-400">当前余额</span>
                  <span class="text-success font-medium">¥{{ paymentResult.balance }}</span>
                </div>
                <div v-if="paymentResult.status==='paid' && paymentResult.orderType!=='balance' && paymentResult.expiryAt" class="flex justify-between">
                  <span class="text-slate-400">有效期至</span>
                  <span class="text-success font-medium">{{ fmt(paymentResult.expiryAt) }}</span>
                </div>
              </div>
            </div>

            <div v-if="!paymentResult.loading" class="space-y-2.5 fade-up">
              <button
                v-if="paymentResult.status==='paid' && authed && paymentResult.orderType!=='balance'"
                @click="useProductFromPayment"
                class="w-full py-3 rounded-xl bg-primary-600 text-white font-medium hover:bg-primary-700 active:scale-95 transition">
                立即使用
              </button>
              <button
                v-if="paymentResult.status==='paid' && authed"
                @click="closePaymentResult"
                class="w-full py-3 rounded-xl bg-primary-600 text-white font-medium hover:bg-primary-700 active:scale-95 transition">
                {{ paymentResult.orderType === 'balance' ? '返回首页' : '完成' }}
              </button>
              <button
                v-if="paymentResult.status==='paid' && !authed"
                @click="authView='login'; closePaymentResult()"
                class="w-full py-3 rounded-xl bg-primary-600 text-white font-medium hover:bg-primary-700 active:scale-95 transition">
                登录查看
              </button>
              <button
                v-if="paymentResult.status==='failed' || paymentResult.status==='cancelled'"
                @click="retryPayment"
                class="w-full py-3 rounded-xl bg-primary-600 text-white font-medium hover:bg-primary-700 active:scale-95 transition">
                {{ paymentResult.orderType === 'balance' ? '关闭' : '重新订阅' }}
              </button>
              <button
                v-if="paymentResult.status==='pending'"
                @click="refreshPaymentStatus"
                :disabled="paymentResult.loading"
                class="w-full py-3 rounded-xl border border-primary-200 text-primary-700 font-medium hover:bg-primary-50 active:scale-95 transition disabled:opacity-50">
                刷新状态
              </button>
              <button
                @click="closePaymentResult"
                class="w-full py-3 rounded-xl border border-slate-200 text-slate-600 font-medium hover:bg-slate-50 active:scale-95 transition">
                {{ authed ? '返回首页' : '返回登录' }}
              </button>
            </div>
          </div>
        </template>

        <!-- 未登录 -->
        <div v-else-if="!authed" class="auth-screen min-h-screen flex flex-col relative overflow-hidden">
          <div class="auth-bg absolute inset-0"></div>
          <div class="auth-orb auth-orb-1"></div>
          <div class="auth-orb auth-orb-2"></div>
          <div class="auth-mesh absolute inset-0"></div>

          <div class="auth-layout relative z-10 flex flex-col justify-between px-5 pt-10 pb-7 max-w-md mx-auto w-full">
            <div class="auth-hero shrink-0">
              <div class="auth-brand-row">
                <div class="auth-logo">
                  <div class="auth-logo-inner">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" class="w-8 h-8">
                      <path d="M4 19V5"/><path d="M4 19h16"/><path d="M8 15l3.2-4.2 2.8 2.1L18 8"/>
                    </svg>
                  </div>
                </div>
                <div class="auth-brand-text">
                  <div class="auth-brand-name">YUCE<span class="auth-brand-dot">.</span>BID</div>
                  <div class="auth-brand-sub">数据分析平台</div>
                </div>
              </div>
              <p class="auth-lead">整合多源数据与结构化指标，辅助你更快完成研判与决策。</p>
            </div>

            <div class="auth-card rounded-3xl p-5 sm:p-6 shrink-0 fade-up">
              <div class="auth-card-head">
                <div class="flex bg-slate-100/80 rounded-xl p-1 text-sm font-medium">
                  <button type="button" @click="authView='login'" :class="authView==='login' ? 'flex-1 py-2.5 rounded-lg bg-white shadow-sm text-indigo-700 font-semibold' : 'flex-1 py-2.5 text-slate-500'">登录</button>
                  <button type="button" @click="authView='register'" :class="authView==='register' ? 'flex-1 py-2.5 rounded-lg bg-white shadow-sm text-indigo-700 font-semibold' : 'flex-1 py-2.5 text-slate-500'">注册</button>
                </div>
              </div>

              <div class="auth-card-body">
                <div v-show="authView==='login'" class="auth-form-panel space-y-3">
                  <div class="auth-field">
                    <span class="auth-field-icon" v-html="icon('user')"></span>
                    <input v-model.trim="f.account" type="email" autocomplete="username" placeholder="邮箱" class="auth-input"/>
                  </div>
                  <div class="auth-field">
                    <span class="auth-field-icon" v-html="icon('lock')"></span>
                    <input :type="showPwd?'text':'password'" v-model="f.password" autocomplete="current-password" placeholder="登录密码" class="auth-input"/>
                    <button type="button" @click="showPwd=!showPwd" v-html="icon(showPwd?'eyeOff':'eye')" class="auth-field-action"></button>
                  </div>
                  <p v-if="loginError" class="text-danger text-sm text-center -mt-1">{{ loginError }}</p>
                  <button type="button" @click="doLogin" class="auth-submit">登录</button>
                </div>

                <div v-show="authView==='register'" class="auth-form-panel space-y-3">
                  <div class="auth-field">
                    <span class="auth-field-icon" v-html="icon('user')"></span>
                    <input v-model.trim="f.account" type="email" autocomplete="email" placeholder="邮箱" class="auth-input"/>
                  </div>
                  <div class="auth-field">
                    <span class="auth-field-icon" v-html="icon('lock')"></span>
                    <input :type="showPwd?'text':'password'" v-model="f.password" placeholder="设置密码（6 位以上）" class="auth-input"/>
                    <button type="button" @click="showPwd=!showPwd" v-html="icon(showPwd?'eyeOff':'eye')" class="auth-field-action"></button>
                  </div>
                  <div class="auth-field">
                    <span class="auth-field-icon" v-html="icon('lock')"></span>
                    <input :type="showPwd?'text':'password'" v-model="f.confirm" placeholder="确认密码" class="auth-input"/>
                  </div>
                  <div class="auth-field">
                    <span class="auth-field-icon" v-html="icon('link')"></span>
                    <input v-model.trim="f.inviteCode" type="text" placeholder="邀请码（选填）" class="auth-input"/>
                  </div>
                  <div class="flex bg-slate-100/80 rounded-xl p-1 text-sm">
                    <button type="button" @click="f.regRole='user'" :class="f.regRole==='user' ? 'flex-1 py-2 rounded-lg bg-white shadow-sm text-indigo-700 font-medium' : 'flex-1 py-2 text-slate-500'">普通用户</button>
                    <button type="button" @click="f.regRole='agent'" :class="f.regRole==='agent' ? 'flex-1 py-2 rounded-lg bg-white shadow-sm text-indigo-700 font-medium' : 'flex-1 py-2 text-slate-500'">代理申请</button>
                  </div>
                  <label class="flex items-start gap-2 text-xs text-slate-500 px-1">
                    <input type="checkbox" v-model="f.agree" class="mt-0.5 accent-indigo-600"/>
                    <span>我已阅读并同意用户协议与隐私政策</span>
                  </label>
                  <p v-if="registerError" class="text-danger text-sm text-center -mt-1">{{ registerError }}</p>
                  <button type="button" @click="doRegister" class="auth-submit">注册并登录</button>
                </div>
              </div>
            </div>

            <p class="auth-foot">用数据洞察 · 用分析决策</p>
          </div>
        </div>

        <!-- 已登录 -->
        <template v-else>
          <header class="bg-gradient-to-br from-indigo-600 via-indigo-700 to-violet-800 text-white px-3 pt-3 pb-2.5 shrink-0">
            <div class="flex items-center justify-between gap-2">
              <div class="min-w-0 flex-1">
                <div class="text-[10px] opacity-70 truncate leading-tight">{{ displayUserName }} · {{ roleTitle }}</div>
                <div class="text-[15px] font-semibold leading-tight mt-0.5 truncate">{{ headerTitle }}</div>
              </div>
              <div class="flex items-center gap-1.5 shrink-0">
                <div
                  v-if="canShowWallet && walletConfigured && walletUsdcBalance != null"
                  class="text-right px-1.5 py-0.5 rounded-md bg-white/10 border border-white/15 leading-tight"
                  title="账户余额"
                >
                  <div class="text-[9px] opacity-70">余额</div>
                  <div class="text-xs font-bold tabular-nums">${{ fmtWalletUsdc(walletUsdcBalance) }}</div>
                </div>
                <button
                  v-if="canShowWallet"
                  type="button"
                  @click="showWalletSettings = true"
                  class="h-7 px-2 rounded-md border border-white/25 hover:bg-white/10 transition text-[11px] font-medium whitespace-nowrap flex items-center gap-1"
                  :title="walletConfigured ? '账户已配置' : '账户设置'"
                >
                  <span class="inline-block w-3 h-3" v-html="icon('wallet')"></span>
                  <span>{{ walletConfigured ? '已配' : '账户' }}</span>
                  <span
                    class="w-1.5 h-1.5 rounded-full"
                    :class="walletConfigured ? 'bg-emerald-300' : 'bg-white/40'"
                  ></span>
                </button>
                <button
                  v-if="!showHelp && !paymentResult.show"
                  type="button"
                  class="h-7 px-2 rounded-md border border-white/25 hover:bg-white/10 transition text-[11px] font-medium whitespace-nowrap flex items-center gap-1"
                  aria-label="产品帮助手册"
                  title="产品帮助手册"
                  @click="openHelp(shopRoute())"
                >
                  <span class="inline-block w-3.5 h-3.5" v-html="icon('help')"></span>
                  <span>帮助</span>
                </button>
                <a
                  v-if="telegramSupportUrl"
                  :href="telegramSupportUrl"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="h-7 px-2 rounded-md border border-white/25 hover:bg-white/10 transition text-[11px] font-medium whitespace-nowrap flex items-center gap-1"
                  aria-label="飞机客服"
                  title="飞机客服"
                >
                  <svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
                    <path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 0 0-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.74-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38z"/>
                  </svg>
                  <span>客服</span>
                </a>
                <button @click="logout" class="h-7 px-2 rounded-md border border-white/25 hover:bg-white/10 transition text-[11px] font-medium whitespace-nowrap">
                  退出
                </button>
              </div>
            </div>
          </header>

          <main
            class="flex-1 overflow-y-auto no-scrollbar"
            :class="[
              showProductDetail && (isBtcBoardProduct(openedProduct) || isTennisProduct(openedProduct) || isTennisRangeProduct(openedProduct) || isTennisLiveProduct(openedProduct))
                ? 'px-2 py-2 space-y-2'
                : showShopList
                  ? 'px-3 py-2'
                  : 'px-4 py-4 space-y-4',
              showShopList ? 'shop-main' : '',
            ]"
          >

            <section v-if="showShopList" class="shop-page fade-up">
              <div class="shop-toolbar">
                <div class="shop-summary">
                  <h2 class="shop-summary-title">数据产品</h2>
                  <p class="shop-summary-sub">{{ activeCount }} 有效 · {{ filteredShopProducts.length }} 个</p>
                </div>
                <div class="list-search-wrap shop-search">
                  <span class="list-search-icon" v-html="icon('search')"></span>
                  <input v-model="listSearch.shop" type="search" placeholder="搜索..." class="list-search-input" />
                </div>
              </div>
              <div v-if="filteredShopProducts.length === 0" class="shop-empty">
                未找到匹配的产品
              </div>
              <div v-else class="product-tile-grid">
                <button
                  v-for="p in filteredShopProducts"
                  :key="p.id"
                  type="button"
                  class="product-tile"
                  @click="openProduct(p)"
                >
                  <span :class="badgeClass(statusOf(p.id))" class="product-tile-badge">{{ badgeText(statusOf(p.id)) }}</span>
                  <ProductIcon :product="p" size="md" rounded="2xl" />
                  <div class="product-tile-name">{{ p.name }}</div>
                  <div class="product-tile-price">¥{{ p.priceMonth }}/月起</div>
                </button>
              </div>
            </section>

            <section v-else-if="showProductDetail" class="space-y-2 fade-up">
              <template v-if="isBtcBoardProduct(openedProduct) || isTennisProduct(openedProduct) || isTennisRangeProduct(openedProduct) || isTennisLiveProduct(openedProduct)">
                <button
                  type="button"
                  @click="go(shopRoute())"
                  class="product-board-back text-lg text-primary-700 flex items-center gap-1.5 py-1 font-semibold"
                ><span v-html="icon('back')"></span>返回</button>
                <div class="flex items-center gap-2 min-w-0 flex-wrap">
                  <div class="font-semibold text-sm truncate">{{ openedProduct.name }}</div>
                  <template v-if="showSubscriptionInHeader(openedProduct)">
                    <span :class="badgeClass(statusOf(openedProduct.id))" class="shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-medium">{{ badgeText(statusOf(openedProduct.id)) }}</span>
                    <span
                      v-if="isActive(openedProduct.id)"
                      class="shrink-0 text-[10px] text-slate-500 font-medium"
                    >至 {{ fmt(userSubs[openedProduct.id]) }}</span>
                  </template>
                </div>
                <div
                  v-if="showSubscriptionInHeader(openedProduct)"
                  class="flex flex-wrap items-center gap-2"
                >
                  <button
                    type="button"
                    @click="openRedeem(openedProduct)"
                    class="shrink-0 px-2.5 py-1.5 rounded-lg border border-primary-200 text-primary-700 text-xs font-semibold hover:bg-primary-50"
                    :class="!isActive(openedProduct.id) ? 'bg-primary-600 text-white border-primary-600' : ''"
                  >兑换码兑换</button>
                  <a
                    :href="redeemPurchaseUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="shrink-0 px-2.5 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700"
                  >兑换码购买</a>
                </div>
                <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-primary-700 font-medium px-0.5">
                  <span v-for="pl in plans" :key="pl.key">
                    ¥{{ planPriceInfo(openedProduct, pl.key).current }}/{{ planText(pl.key) }}
                  </span>
                </div>
              </template>
              <div v-else class="flex items-center gap-2 min-h-0">
                <button @click="go(shopRoute())" class="text-xs text-primary-700 flex items-center gap-0.5 shrink-0 py-0.5"><span v-html="icon('back')"></span>返回</button>
              </div>
              <div v-if="!(isBtcBoardProduct(openedProduct) || isTennisProduct(openedProduct) || isTennisRangeProduct(openedProduct) || isTennisLiveProduct(openedProduct))" class="bg-white rounded-2xl p-4 shadow-sm">
                <div class="flex items-center gap-3">
                  <ProductIcon :product="openedProduct" size="md" />
                  <div>
                    <div class="font-semibold text-lg">{{ openedProduct.name }}</div>
                    <div class="text-xs flex flex-wrap items-center gap-x-2 gap-y-1.5 mt-1">
                      <span v-for="pl in plans" :key="pl.key" class="text-primary-700 font-medium">
                        ¥{{ planPriceInfo(openedProduct, pl.key).current }}/{{ planText(pl.key) }}
                      </span>
                      <template v-if="showSubscriptionInHeader(openedProduct)">
                        <span :class="badgeClass(statusOf(openedProduct.id))" class="px-2 py-0.5 rounded-full text-[11px] font-medium">{{ badgeText(statusOf(openedProduct.id)) }}</span>
                        <span v-if="isActive(openedProduct.id)" class="text-slate-400">有效期至 {{ fmt(userSubs[openedProduct.id]) }}</span>
                        <button
                          v-if="isActive(openedProduct.id)"
                          @click="openRedeem(openedProduct)"
                          class="px-2.5 py-1 rounded-lg border border-primary-200 text-primary-700 text-[11px] font-medium hover:bg-primary-50 active:scale-95 transition"
                        >兑换码兑换</button>
                        <button
                          v-else
                          @click="openRedeem(openedProduct)"
                          class="px-2.5 py-1 rounded-lg bg-primary-600 text-white text-[11px] font-medium hover:bg-primary-700 active:scale-95 transition"
                        >兑换码兑换</button>
                      </template>
                    </div>
                  </div>
                </div>
                <p class="text-sm text-slate-500 mt-3">{{ openedProduct.desc }}</p>
              </div>
              <div
                :class="isNativeBoardProduct(openedProduct)
                  ? ((isBtcBoardProduct(openedProduct) || isTennisProduct(openedProduct) || isTennisRangeProduct(openedProduct) || isTennisLiveProduct(openedProduct))
                    ? 'rounded-xl overflow-hidden border border-slate-200 bg-slate-50 shadow-sm'
                    : 'rounded-2xl overflow-hidden border border-slate-200 bg-slate-50 shadow-sm')
                  : 'rounded-2xl overflow-hidden border border-slate-200 bg-white shadow-sm'"
              >
                <!-- 网球：登录用户统一看全量数据 -->
                <div v-if="isTennisLiveProduct(openedProduct)" class="p-0">
                  <TennisBoard
                    board-mode="live"
                    :show-filters="canShowTennisFilters"
                    :is-member="isActive(openedProduct.id)"
                    :can-batch-trade="canShowWallet && walletConfigured"
                  />
                </div>
                <div v-else-if="isTennisRangeProduct(openedProduct)" class="p-0">
                  <TennisBoard
                    board-mode="range"
                    :show-filters="canShowTennisFilters"
                    :is-member="isActive(openedProduct.id)"
                    :can-batch-trade="canShowWallet && walletConfigured"
                  />
                </div>
                <div v-else-if="isTennisProduct(openedProduct)" class="p-0">
                  <TennisBoard
                    :show-filters="canShowTennisFilters"
                    :is-member="isActive(openedProduct.id)"
                    :can-batch-trade="canShowWallet && walletConfigured"
                  />
                </div>
                <!-- BTC 持仓看板：与网球相同浅色 Vue 直出 -->
                <div v-else-if="isBtcBoardProduct(openedProduct)" class="p-0">
                  <BtcBoard
                    :is-member="isActive(openedProduct.id)"
                    :show-sim-betting="canShowBtcSimBetting"
                    @wallet-refresh="loadWalletHeader"
                  />
                </div>
                <!-- DOTA Elo 看板：与网球相同浅色 Vue 直出 -->
                <div v-else-if="isDotaProduct(openedProduct)" class="p-0">
                  <DotaBoard :is-member="isActive(openedProduct.id)" />
                </div>
                <!-- NBA Polymarket 盘口 -->
                <div v-else-if="isNbaProduct(openedProduct)" class="p-0">
                  <BasketballBoard :is-member="isActive(openedProduct.id)" />
                </div>
                <!-- DOTA2 Polymarket 盘口（与 Elo 的 DOTA 区分） -->
                <div v-else-if="isDota2Product(openedProduct)" class="p-0">
                  <Dota2Board :is-member="isActive(openedProduct.id)" />
                </div>
                <div
                  v-else
                  class="relative bg-slate-50"
                  :style="isDirectProduct(openedProduct)
                    ? { height: 'min(78vh, 720px)', minHeight: '420px' }
                    : { height: 'min(60vh, 520px)', minHeight: '320px' }"
                >
                  <iframe
                    v-if="canAccessProduct(openedProduct.id) && openedProduct.url && productEmbedUrl(openedProduct)"
                    :key="openedProduct.id + '-' + openedProduct.url"
                    :src="productEmbedUrl(openedProduct)"
                    class="w-full h-full border-0 bg-white"
                    :title="openedProduct.name + ' 内容'"
                    referrerpolicy="no-referrer-when-downgrade"
                  ></iframe>
                  <div
                    v-else-if="canAccessProduct(openedProduct.id) && !openedProduct.url"
                    class="absolute inset-0 flex flex-col items-center justify-center text-center p-6 gap-2 text-sm text-slate-500"
                  >
                    <div class="font-medium text-slate-700">尚未配置产品链接</div>
                    <p>请联系管理员在后台填写外链 URL。</p>
                  </div>
                  <div v-if="!canAccessProduct(openedProduct.id)"
                    class="absolute inset-0 bg-white/95 backdrop-blur-sm flex flex-col items-center justify-center text-center p-6 gap-3">
                    <div class="h-16 w-16 rounded-full bg-danger/10 flex items-center justify-center text-danger">
                      <span v-html="icon('lock')" class="w-8 h-8"></span>
                    </div>
                    <div class="text-lg font-semibold">{{ statusOf(openedProduct.id)==='expired' ? '订阅已过期' : '尚未订阅' }}</div>
                    <p class="text-sm text-slate-500 max-w-[260px]">订阅有效期内可在本页查看产品数据。</p>
                    <button @click="openRedeem(openedProduct)" class="px-6 py-2.5 rounded-xl bg-primary-600 text-white font-medium hover:bg-primary-700 active:scale-95 transition">兑换码兑换</button>
                  </div>
                </div>
              </div>
            </section>

            <section v-else-if="showMine" class="space-y-3 fade-up">
              <div class="mine-profile">
                <div class="mine-avatar">{{ (displayUserName || '用').slice(0, 1) }}</div>
                <div class="mine-profile-main">
                  <div class="mine-name">{{ displayUserName }}</div>
                  <div class="mine-account">{{ currentUser.account || '—' }}</div>
                </div>
                <button type="button" class="mine-pwd-btn" @click="openPwdModal">修改密码</button>
              </div>

              <div class="bg-white rounded-2xl p-3 shadow-sm ring-1 ring-slate-100 space-y-2">
                <div class="flex items-center justify-between gap-2">
                  <div class="text-sm font-semibold text-slate-800">买卖记录</div>
                  <button
                    type="button"
                    class="text-xs text-primary-700 font-medium disabled:opacity-50"
                    :disabled="tradeRecords.loading"
                    @click="loadTradeRecords({ reset: true })"
                  >{{ tradeRecords.loading ? '刷新中…' : '刷新' }}</button>
                </div>
                <div class="flex gap-1.5">
                  <button
                    v-for="opt in [
                      { id: 'all', label: '全部' },
                      { id: 'btc', label: 'BTC' },
                      { id: 'tennis', label: '网球' },
                      { id: 'tennis-range', label: '区间网球' },
                      { id: 'tennis-live', label: 'ATP·WTA 盘中' },
                    ]"
                    :key="opt.id"
                    type="button"
                    class="px-2.5 py-1 rounded-lg text-xs font-medium border transition"
                    :class="tradeRecords.product === opt.id
                      ? 'bg-primary-600 text-white border-primary-600'
                      : 'bg-white text-slate-600 border-slate-200'"
                    @click="setTradeProductFilter(opt.id)"
                  >{{ opt.label }}</button>
                </div>
                <div v-if="tradeRecords.error" class="text-xs text-rose-600">{{ tradeRecords.error }}</div>
                <div v-else-if="!tradeRecords.loaded && tradeRecords.loading" class="text-xs text-slate-400 py-3 text-center">加载中…</div>
                <div v-else-if="!tradeRecords.items.length" class="text-xs text-slate-400 py-3 text-center">暂无买卖记录</div>
                <div v-else class="space-y-1.5 max-h-72 overflow-y-auto">
                  <div
                    v-for="row in tradeRecords.items"
                    :key="row.id"
                    class="rounded-xl px-2.5 py-2 border border-slate-100 bg-slate-50/80"
                  >
                    <div class="flex items-center justify-between gap-2">
                      <div class="min-w-0 flex items-center gap-1.5 text-xs font-semibold">
                        <span
                          class="shrink-0 px-1.5 py-0.5 rounded-md"
                          :class="row.product === 'btc' ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700'"
                        >{{ tradeProductLabel(row.product) }}</span>
                        <span :class="row.action === 'sell' ? 'text-rose-600' : 'text-sky-700'">{{ tradeActionLabel(row.action) }}</span>
                        <span v-if="tradeSideLabel(row.side)" class="text-slate-500">{{ tradeSideLabel(row.side) }}</span>
                        <span v-if="!row.ok" class="text-rose-500">失败</span>
                      </div>
                      <div class="shrink-0 text-[10px] text-slate-400 tabular-nums">{{ fmtTradeTime(row.createdAt) }}</div>
                    </div>
                    <div class="mt-0.5 text-xs text-slate-700 truncate">{{ row.label || '—' }}</div>
                    <div class="mt-0.5 flex items-center justify-between gap-2 text-[11px] text-slate-500">
                      <span class="tabular-nums">{{ fmtTradeAmount(row) }}</span>
                      <span v-if="row.error" class="truncate text-rose-500">{{ row.error }}</span>
                      <span v-else-if="row.orderId" class="truncate text-slate-400">{{ row.orderId.slice(0, 12) }}…</span>
                    </div>
                  </div>
                </div>
                <button
                  v-if="tradeRecords.items.length < tradeRecords.total"
                  type="button"
                  class="w-full py-1.5 rounded-lg text-xs text-primary-700 font-medium border border-primary-100 disabled:opacity-50"
                  :disabled="tradeRecords.loading"
                  @click="loadTradeRecords()"
                >加载更多（{{ tradeRecords.items.length }}/{{ tradeRecords.total }}）</button>
              </div>

              <div class="bg-white rounded-2xl p-3 shadow-sm ring-1 ring-slate-100 space-y-2">
                <div class="flex items-center justify-between gap-2">
                  <div class="text-sm font-semibold text-slate-800">兑换码</div>
                  <button type="button" class="text-xs text-primary-700 font-medium" @click="openRedeem()">兑换码兑换</button>
                </div>
                <select
                  v-model="redeemInput.productId"
                  class="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm outline-none"
                >
                  <option value="">自动识别产品（通用码需选择）</option>
                  <option v-for="p in products" :key="p.id" :value="p.id">{{ p.name }}</option>
                </select>
                <div class="flex gap-2">
                  <input
                    v-model="redeemInput.code"
                    type="text"
                    placeholder="输入兑换码"
                    class="flex-1 min-w-0 border border-slate-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-primary-400 uppercase"
                    @keyup.enter="submitRedeemCode"
                  />
                  <button
                    type="button"
                    :disabled="redeemInput.busy"
                    @click="submitRedeemCode"
                    class="shrink-0 px-4 py-2 rounded-xl bg-primary-600 text-white text-sm font-medium disabled:opacity-60"
                  >{{ redeemInput.busy ? '兑换中…' : '兑换码兑换' }}</button>
                </div>
              </div>

              <button
                type="button"
                class="w-full bg-white rounded-2xl p-3.5 shadow-sm ring-1 ring-slate-100 flex items-center gap-3 text-left active:scale-[0.99] transition"
                @click="openHelp('mine')"
              >
                <span class="w-9 h-9 rounded-xl bg-primary-50 text-primary-700 flex items-center justify-center shrink-0" v-html="icon('help')"></span>
                <div class="min-w-0 flex-1">
                  <div class="text-sm font-semibold text-slate-800">产品帮助手册</div>
                  <div class="text-xs text-slate-400 mt-0.5">开通、兑换、产品使用说明</div>
                </div>
                <span class="text-slate-300 text-lg leading-none">›</span>
              </button>

              <div class="shop-summary">
                <div>
                  <h2 class="shop-summary-title">我的订阅</h2>
                  <p class="shop-summary-sub">{{ mySubs.length }} 个产品 · {{ activeCount }} 个有效</p>
                </div>
              </div>
              <div class="list-search-wrap">
                <span class="list-search-icon" v-html="icon('search')"></span>
                <input v-model="listSearch.mine" type="search" placeholder="搜索订阅产品..." class="list-search-input" />
              </div>
              <div v-if="mySubs.length===0" class="shop-empty">
                <div class="text-slate-300 mb-2" v-html="icon('box')"></div>
                <p>还没有任何订阅</p>
                <button type="button" @click="go(shopRoute())" class="mt-3 px-4 py-2 rounded-xl bg-primary-600 text-white text-sm">去选产品</button>
              </div>
              <div v-else-if="filteredMineSubs.length === 0" class="shop-empty">
                未找到匹配的订阅
              </div>
              <template v-else>
                <div class="product-tile-grid">
                  <button
                    v-for="s in pagedMine.items"
                    :key="s.id"
                    type="button"
                    class="product-tile"
                    @click="openProduct(s)"
                  >
                    <span :class="badgeClass(statusOf(s.id))" class="product-tile-badge">{{ badgeText(statusOf(s.id)) }}</span>
                    <ProductIcon :product="s" size="lg" rounded="2xl" />
                    <div class="product-tile-name">{{ s.name }}</div>
                    <div class="product-tile-price">{{ isActive(s.id) ? '至 ' + fmt(userSubs[s.id]) : '已过期' }}</div>
                  </button>
                </div>
                <div v-if="pagedMine.totalPages > 1" class="flex items-center justify-between bg-white rounded-2xl px-3 py-2 shadow-sm text-sm">
                  <button @click="goPageMine(pagedMine.current-1)" :disabled="pagedMine.current<=1" class="px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 disabled:opacity-40">上一页</button>
                  <span class="text-xs text-slate-400">{{ pagedMine.from }}-{{ pagedMine.to }} / {{ pagedMine.total }} · 第 {{ pagedMine.current }}/{{ pagedMine.totalPages }} 页</span>
                  <button @click="goPageMine(pagedMine.current+1)" :disabled="pagedMine.current>=pagedMine.totalPages" class="px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 disabled:opacity-40">下一页</button>
                </div>
              </template>
            </section>

            <section v-else-if="showHelp" class="space-y-3 fade-up pb-24">
              <button type="button" @click="closeHelp" class="text-sm text-primary-700 flex items-center gap-1 px-1">
                <span v-html="icon('back')"></span>返回
              </button>

              <div class="bg-white rounded-2xl p-4 shadow-sm space-y-2">
                <div class="font-semibold text-base">YUCE.BID 帮助手册</div>
                <p class="text-xs text-slate-500 leading-relaxed">
                  本平台提供赛程与行情等数据展示，用于研究与复盘。数据仅供参考，不构成任何操作建议，也不承诺收益。
                </p>
              </div>

              <div class="bg-white rounded-2xl p-4 shadow-sm space-y-3">
                <div class="font-semibold text-sm">一、如何开通产品</div>
                <ol class="text-sm text-slate-600 space-y-2 list-decimal pl-5 leading-relaxed">
                  <li>在产品页点击「兑换码购买」，完成购买后获得兑换码。</li>
                  <li>回到产品页或「我的」，点击「兑换码兑换」。</li>
                  <li>输入兑换码并确认，即可开通或延期对应产品。</li>
                </ol>
                <img class="help-shot" :src="helpRedeemImg" alt="兑换码购买与兑换入口示意" loading="lazy" />
                <p class="help-shot-cap">实机截图：产品页顶部的「兑换码兑换」「兑换码购买」入口。</p>
                <div class="flex flex-wrap gap-2 pt-1">
                  <a
                    :href="redeemPurchaseUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-semibold"
                  >兑换码购买</a>
                  <button
                    type="button"
                    class="px-3 py-1.5 rounded-lg border border-primary-200 text-primary-700 text-xs font-semibold"
                    @click="openRedeem()"
                  >兑换码兑换</button>
                </div>
              </div>

              <div class="bg-white rounded-2xl p-4 shadow-sm space-y-3">
                <div class="font-semibold text-sm">二、网球看板</div>
                <ul class="text-sm text-slate-600 space-y-1.5 list-disc pl-5 leading-relaxed">
                  <li>未开通：可看赛程、对阵与比分。</li>
                  <li>已开通：可看排名、推荐标记、详情与外链。</li>
                  <li>过期后高级信息会隐藏，重新兑换即可恢复。</li>
                </ul>
                <img class="help-shot" :src="helpTennisImg" alt="网球看板开通后示意" loading="lazy" />
                <p class="help-shot-cap">实机截图：开通后可见排名、「优」推荐，以及「详情」「外链」按钮。</p>
              </div>

              <div class="bg-white rounded-2xl p-4 shadow-sm space-y-3">
                <div class="font-semibold text-sm">三、BTC 看板</div>
                <ul class="text-sm text-slate-600 space-y-1.5 list-disc pl-5 leading-relaxed">
                  <li>未开通：可看周期切换、倒计时与 UP/DOWN 价格。</li>
                  <li>已开通：可看信号、参与人数、连续热度等指标。</li>
                  <li>过期后上述指标会隐藏，重新兑换即可恢复。</li>
                </ul>
                <img class="help-shot" :src="helpBtcImg" alt="BTC 看板开通后示意" loading="lazy" />
                <p class="help-shot-cap">实机截图：开通后可见信号提示、参与人数与连续热度。</p>
              </div>

              <div class="bg-white rounded-2xl p-4 shadow-sm space-y-3">
                <div class="font-semibold text-sm">四、兑换码说明</div>
                <ul class="text-sm text-slate-600 space-y-1.5 list-disc pl-5 leading-relaxed">
                  <li>每个兑换码通常只能使用一次。</li>
                  <li>产品专属码只能兑换对应产品；通用码需先选择产品。</li>
                  <li>码过期、已使用或产品不匹配时，会提示原因。</li>
                  <li>兑换成功后，可在「我的」查看有效期。</li>
                </ul>
              </div>

              <div v-if="role === 'agent'" class="bg-white rounded-2xl p-4 shadow-sm space-y-3">
                <div class="font-semibold text-sm">五、代理说明</div>
                <ul class="text-sm text-slate-600 space-y-1.5 list-disc pl-5 leading-relaxed">
                  <li>分享邀请链接，用户注册后会绑定到你名下。</li>
                  <li>名下用户兑换开通时，按产品标价 × 你的分成比例计佣金。</li>
                  <li>佣金可在概览页查看，并申请提现。</li>
                </ul>
              </div>

              <div class="bg-white rounded-2xl p-4 shadow-sm space-y-3">
                <div class="font-semibold text-sm">{{ role === 'agent' ? '六' : '五' }}、常见问题</div>
                <div class="space-y-2.5 text-sm text-slate-600 leading-relaxed">
                  <div>
                    <div class="font-medium text-slate-800">兑换成功但看不到完整数据？</div>
                    <p class="text-xs text-slate-500 mt-0.5">请确认兑换的是当前产品，并强刷页面；过期需重新兑换。</p>
                  </div>
                  <div>
                    <div class="font-medium text-slate-800">提示「兑换产品错误」？</div>
                    <p class="text-xs text-slate-500 mt-0.5">当前页面产品与兑换码绑定产品不一致，请到对应产品页再兑。</p>
                  </div>
                  <div>
                    <div class="font-medium text-slate-800">提示「已兑换 / 过期」？</div>
                    <p class="text-xs text-slate-500 mt-0.5">该码已用过或超过有效期，需更换新码。</p>
                  </div>
                  <div>
                    <div class="font-medium text-slate-800">如何联系支持？</div>
                    <p class="text-xs text-slate-500 mt-0.5">
                      点击顶部「客服」，或通过
                      <a :href="telegramSupportUrl" target="_blank" rel="noopener noreferrer" class="text-primary-700 underline">Telegram</a>
                      咨询。
                    </p>
                  </div>
                </div>
              </div>
            </section>

            <section v-else-if="role==='agent' && view==='overview'" class="space-y-4 fade-up">
              <div class="grid grid-cols-2 gap-3">
                <div class="bg-white rounded-2xl p-4 shadow-sm">
                  <div class="text-xs text-slate-400">本月佣金</div>
                  <div class="text-2xl font-bold text-accent-500 mt-1">¥{{ agent.monthCommission }}</div>
                </div>
                <div class="bg-white rounded-2xl p-4 shadow-sm">
                  <div class="text-xs text-slate-400">发展客户</div>
                  <div class="text-2xl font-bold mt-1">{{ agent.clientCount }} <span class="text-sm font-normal text-slate-400">人</span></div>
                </div>
                <div class="bg-white rounded-2xl p-4 shadow-sm">
                  <div class="text-xs text-slate-400">可提现</div>
                  <div class="text-2xl font-bold mt-1">¥{{ agent.withdrawable }}</div>
                </div>
                <div class="bg-white rounded-2xl p-4 shadow-sm">
                  <div class="text-xs text-slate-400">分成比例</div>
                  <div class="text-2xl font-bold mt-1">{{ agent.rate }}%</div>
                </div>
              </div>
              <div class="bg-white rounded-2xl p-4 shadow-sm">
                <div class="text-sm font-medium mb-1">我的邀请码</div>
                <p class="text-xs text-slate-400 mb-3">分享下方注册链接，好友打开后会自动填入邀请码</p>
                <div class="flex items-start gap-2">
                  <code class="flex-1 bg-slate-100 rounded-xl px-3 py-2 text-primary-700 font-mono text-xs break-all leading-relaxed">{{ agentRegisterLink }}</code>
                  <button @click="copyRegisterLink()" class="shrink-0 px-3 py-2 rounded-xl bg-primary-600 text-white text-sm active:scale-95 transition">复制链接</button>
                </div>
                <div class="text-xs text-slate-400 mt-2">
                  邀请码：<span class="font-mono text-primary-600">{{ agent.inviteCode }}</span>
                  · 名下用户兑换码开通时，按产品标价 × 分成比例计入佣金
                </div>
              </div>
              <div class="bg-white rounded-2xl p-4 shadow-sm">
                <div class="text-sm font-medium mb-3">近 7 天收益趋势</div>
                <div class="flex items-end gap-1.5 h-24">
                  <div v-for="(v,i) in agent.trend" :key="i" class="flex-1 rounded-t bg-gradient-to-t from-primary-400 to-primary-600"
                    :style="{height: Math.max(4, (v / Math.max(...agent.trend, 1) * 100)) + '%'}"></div>
                </div>
              </div>
              <div class="bg-white rounded-2xl p-5 shadow-sm text-center">
                <div class="text-sm text-slate-400">可提现佣金</div>
                <div class="text-3xl font-bold text-accent-500 mt-1">¥{{ agent.withdrawable }}</div>
              </div>
              <button @click="doWithdraw" class="w-full py-3 rounded-xl bg-primary-600 text-white font-medium hover:bg-primary-700 active:scale-95 transition">申请提现到微信</button>
              <div class="bg-white rounded-2xl p-4 shadow-sm">
                <div class="text-sm font-medium mb-2">提现记录</div>
                <div v-if="!agent.withdrawLog.length" class="text-sm text-slate-400 py-2">暂无提现记录</div>
                <div v-for="w in agent.withdrawLog" :key="w.id" class="flex justify-between text-sm py-2 border-t border-slate-100">
                  <span class="text-slate-500">{{ w.date }}</span>
                  <span class="tabular-nums">¥{{ w.amount }} · {{ w.status }}</span>
                </div>
              </div>
            </section>

            <section v-else-if="role==='agent' && view==='clients'" class="space-y-3 fade-up">
              <div class="flex items-center justify-between px-1">
                <h2 class="text-xl font-semibold">我的客户</h2>
                <span class="text-xs text-slate-400">邀请客户 {{ agent.clientCount }} 人</span>
              </div>
              <div class="flex bg-slate-100 rounded-xl p-1 text-sm">
                <button
                  v-for="opt in [{key:'all',label:'全部'},{key:'paid',label:'已付款'},{key:'pending',label:'未付款'}]"
                  :key="opt.key"
                  @click="setAgentOrderStatusFilter(opt.key)"
                  :class="['flex-1 py-2 rounded-lg transition', agentOrderStatusFilter===opt.key ? 'bg-white shadow text-primary-700 font-medium' : 'text-slate-500']">
                  {{ opt.label }}
                </button>
              </div>
              <div class="list-search-wrap">
                <span class="list-search-icon" v-html="icon('search')"></span>
                <input v-model="listSearch.clients" type="search" placeholder="搜索客户、产品、单号..." class="list-search-input" />
              </div>
              <div v-if="pagedAgentOrders.total === 0" class="bg-white rounded-2xl p-8 shadow-sm text-center text-sm text-slate-400">
                暂无{{ agentOrderStatusFilter === 'paid' ? '已付款' : agentOrderStatusFilter === 'pending' ? '未付款' : '' }}客户订单
              </div>
              <div v-for="o in pagedAgentOrders.items" :key="o.id" class="bg-white rounded-xl px-3 py-3 shadow-sm ring-1 ring-slate-100">
                <div class="flex items-start justify-between gap-2">
                  <div class="min-w-0">
                    <div class="font-medium truncate">{{ o.user }}</div>
                    <div class="text-xs text-slate-400 mt-0.5">{{ o.product }} · 按{{ planText(o.plan) }} · ¥{{ o.amount }}</div>
                    <div class="text-[11px] text-slate-400 mt-1 font-mono truncate">{{ o.reference }}</div>
                  </div>
                  <span :class="paymentOrderStatusClass(o.status)" class="shrink-0 px-2 py-0.5 rounded-full text-xs font-medium">
                    {{ paymentOrderStatusText(o.status) }}
                  </span>
                </div>
                <div class="flex justify-between text-[11px] text-slate-400 mt-3 pt-3 border-t border-slate-100">
                  <span>提交 {{ fmtDateTime(o.createdAt) }}</span>
                  <span v-if="o.paidAt">付款 {{ fmtDateTime(o.paidAt) }}</span>
                  <span v-else-if="o.status==='pending'">等待支付</span>
                </div>
              </div>
              <div v-if="pagedAgentOrders.totalPages > 1" class="flex items-center justify-between bg-white rounded-2xl px-3 py-2 shadow-sm text-sm">
                <button @click="goPage('clients', pagedAgentOrders.current-1)" :disabled="pagedAgentOrders.current<=1" class="px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 disabled:opacity-40">上一页</button>
                <span class="text-xs text-slate-400">{{ pagedAgentOrders.from }}-{{ pagedAgentOrders.to }} / {{ pagedAgentOrders.total }} · 第 {{ pagedAgentOrders.current }}/{{ pagedAgentOrders.totalPages }} 页</span>
                <button @click="goPage('clients', pagedAgentOrders.current+1)" :disabled="pagedAgentOrders.current>=pagedAgentOrders.totalPages" class="px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 disabled:opacity-40">下一页</button>
              </div>
            </section>

            <section v-else-if="role==='admin' && view==='manage'" class="space-y-4 fade-up">
              <h2 class="text-xl font-semibold px-1">管理中心</h2>
              <p class="text-sm text-slate-500 px-1">按功能分类进入对应模块</p>
              <div v-for="section in adminManageSections" :key="section.key" class="space-y-2">
                <div class="px-1 pt-1">
                  <div class="text-sm font-semibold text-slate-700">{{ section.title }}</div>
                  <div class="text-xs text-slate-400 mt-0.5">{{ section.desc }}</div>
                </div>
                <div class="grid grid-cols-4 gap-2">
                  <button
                    v-for="item in section.items"
                    :key="item.view"
                    type="button"
                    @click="go(item.view)"
                    class="bg-white rounded-xl px-1.5 py-2.5 shadow-sm ring-1 ring-slate-100 hover:bg-slate-50 transition-colors active:scale-[0.98] flex flex-col items-center gap-1.5 text-center"
                    :title="item.desc"
                  >
                    <div :class="['h-10 w-10 rounded-xl flex items-center justify-center text-white shrink-0 bg-gradient-to-br', item.color]">
                      <span v-html="icon(item.icon)" class="w-5 h-5"></span>
                    </div>
                    <div class="text-[11px] font-medium text-slate-700 leading-tight line-clamp-2 w-full px-0.5">{{ item.label }}</div>
                  </button>
                </div>
              </div>
            </section>

            <section v-else-if="role==='admin' && view==='daily-report'" class="space-y-3 fade-up">
              <button @click="go('manage')" class="text-sm text-primary-700 flex items-center gap-1 px-1">
                <span v-html="icon('back')"></span>返回管理中心
              </button>

              <div class="bg-white rounded-2xl p-4 shadow-sm space-y-3">
                <div class="flex items-center justify-between gap-2">
                  <div>
                    <div class="font-semibold">运营日报</div>
                    <div class="text-xs text-slate-400 mt-0.5">按日统计新增客户、兑换码激活与营收</div>
                  </div>
                  <button
                    type="button"
                    class="text-xs text-primary-700 font-medium px-2 py-1 rounded-lg hover:bg-primary-50"
                    :disabled="dailyReport.loading"
                    @click="loadDailyReport(dailyReport.date)"
                  >刷新</button>
                </div>
                <div>
                  <div class="text-xs text-slate-400 mb-1">日期</div>
                  <input
                    v-model="dailyReport.date"
                    type="date"
                    class="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-primary-400"
                    @change="loadDailyReport(dailyReport.date)"
                  />
                </div>
              </div>

              <div class="grid grid-cols-1 gap-3">
                <div class="bg-white rounded-2xl p-4 shadow-sm">
                  <div class="text-xs text-slate-400">新增客户</div>
                  <div class="text-3xl font-bold mt-1 tabular-nums">{{ dailyReport.loading ? '…' : dailyReport.newUsers }}</div>
                  <div class="text-xs text-slate-400 mt-1">当日新注册用户（role=user）</div>
                </div>
                <div class="bg-white rounded-2xl p-4 shadow-sm">
                  <div class="text-xs text-slate-400">激活兑换码</div>
                  <div class="text-3xl font-bold mt-1 tabular-nums">{{ dailyReport.loading ? '…' : dailyReport.redeemActivated }}</div>
                  <div class="text-xs text-slate-400 mt-1">当日成功兑换的激活码数量</div>
                </div>
                <div class="bg-white rounded-2xl p-4 shadow-sm">
                  <div class="text-xs text-slate-400">营收金额</div>
                  <div class="text-3xl font-bold mt-1 tabular-nums text-emerald-600">¥{{ dailyReport.loading ? '…' : fmtMoney(dailyReport.revenue) }}</div>
                  <div class="text-xs text-slate-400 mt-1">
                    订单 {{ dailyReport.orderCount }} 笔
                    · 支付实收 ¥{{ fmtMoney(dailyReport.paidAmount) }}
                    · 代理佣金 ¥{{ fmtMoney(dailyReport.commission) }}
                  </div>
                </div>
              </div>

              <div class="bg-white rounded-2xl p-4 shadow-sm space-y-3">
                <div class="text-sm font-medium">近 7 日趋势</div>
                <div v-if="!dailyReport.trend.length" class="text-sm text-slate-400 text-center py-4">暂无数据</div>
                <div v-else class="space-y-2">
                  <div
                    v-for="row in dailyReport.trend"
                    :key="row.date"
                    class="rounded-xl px-3 py-2.5 ring-1 ring-slate-100 flex items-center gap-3"
                  >
                    <div class="text-sm font-medium w-[5.5rem] shrink-0 tabular-nums">{{ row.date.slice(5) }}</div>
                    <div class="flex-1 min-w-0 grid grid-cols-3 gap-1 text-center">
                      <div>
                        <div class="text-[10px] text-slate-400">客户</div>
                        <div class="text-sm font-semibold tabular-nums">{{ row.newUsers }}</div>
                      </div>
                      <div>
                        <div class="text-[10px] text-slate-400">激活码</div>
                        <div class="text-sm font-semibold tabular-nums">{{ row.redeemActivated }}</div>
                      </div>
                      <div>
                        <div class="text-[10px] text-slate-400">营收</div>
                        <div class="text-sm font-semibold tabular-nums text-emerald-600">¥{{ fmtMoney(row.revenue) }}</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <section v-else-if="role==='admin' && view==='site-settings'" class="space-y-3 fade-up">
              <button @click="go('manage')" class="text-sm text-primary-700 flex items-center gap-1 px-1">
                <span v-html="icon('back')"></span>返回管理中心
              </button>
              <div class="bg-white rounded-2xl p-4 shadow-sm space-y-3">
                <div>
                  <div class="font-semibold">站点设置</div>
                  <div class="text-xs text-slate-400 mt-0.5">配置前台「兑换码购买」跳转链接</div>
                </div>
                <div>
                  <div class="text-xs text-slate-400 mb-1">兑换码购买链接</div>
                  <input
                    v-model.trim="siteSettingsForm.redeemPurchaseUrl"
                    type="url"
                    placeholder="https://..."
                    class="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-primary-400"
                  />
                  <p class="text-[11px] text-slate-400 mt-1.5 leading-relaxed">
                    用户点击产品页「兑换码购买」时将打开此地址。请填写完整 http(s) 链接。
                  </p>
                </div>
                <button
                  type="button"
                  :disabled="siteSettingsForm.saving || !siteSettingsForm.redeemPurchaseUrl"
                  @click="saveSiteSettings"
                  class="w-full py-2.5 rounded-xl bg-primary-600 text-white text-sm font-medium disabled:opacity-60"
                >{{ siteSettingsForm.saving ? '保存中…' : '保存设置' }}</button>
              </div>
            </section>

            <section v-else-if="role==='admin' && view==='btc-board'" class="space-y-3 fade-up">
              <button @click="go('manage')" class="text-sm text-primary-700 flex items-center gap-1 px-1">
                <span v-html="icon('back')"></span>返回管理中心
              </button>
              <BtcBoardAdmin />
            </section>

            <section v-else-if="role==='admin' && view==='tennis-live-scraper'" class="space-y-3 fade-up">
              <button @click="go('manage')" class="text-sm text-primary-700 flex items-center gap-1 px-1">
                <span v-html="icon('back')"></span>返回管理中心
              </button>
              <LiveTop100Scraper />
            </section>

            <section v-else-if="role==='admin' && view==='tennis-live-monitor'" class="space-y-3 fade-up">
              <button @click="go('manage')" class="text-sm text-primary-700 flex items-center gap-1 px-1">
                <span v-html="icon('back')"></span>返回管理中心
              </button>
              <TennisLiveMonitor />
            </section>

            <section v-else-if="role==='admin' && view==='sofa-monitor'" class="space-y-3 fade-up">
              <button @click="go('manage')" class="text-sm text-primary-700 flex items-center gap-1 px-1">
                <span v-html="icon('back')"></span>返回管理中心
              </button>
              <SofaMonitor />
            </section>

            <section v-else-if="role==='admin' && view==='redeem-codes'" class="space-y-3 fade-up">
              <button @click="go('manage')" class="text-sm text-primary-700 flex items-center gap-1 px-1">
                <span v-html="icon('back')"></span>返回管理中心
              </button>

              <div class="bg-white rounded-2xl p-4 shadow-sm space-y-3">
                <div class="font-semibold">批量生成兑换码</div>
                <p class="text-xs text-slate-400">支持绑定单一产品或全部产品；单次最多 500 个，可设过期天数</p>
                <div>
                  <div class="text-xs text-slate-400 mb-1">产品</div>
                  <select v-model="redeemCodes.productId" class="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm outline-none">
                    <option value="all">全部产品</option>
                    <option v-for="p in adminProducts" :key="p.id" :value="p.id">{{ p.name }}</option>
                  </select>
                </div>
                <div>
                  <div class="text-xs text-slate-400 mb-1">套餐</div>
                  <div class="flex gap-2">
                    <button
                      v-for="pl in plans"
                      :key="pl.key"
                      type="button"
                      @click="redeemCodes.plan = pl.key"
                      :class="['flex-1 py-2 rounded-xl border text-sm font-medium transition', redeemCodes.plan === pl.key ? 'border-primary-600 bg-primary-50 text-primary-700' : 'border-slate-200 text-slate-600']"
                    >{{ pl.label.replace('订阅', '卡') }}</button>
                  </div>
                </div>
                <div class="grid grid-cols-2 gap-2">
                  <div>
                    <div class="text-xs text-slate-400 mb-1">数量</div>
                    <input v-model.number="redeemCodes.count" type="number" min="1" max="500" class="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm outline-none" />
                  </div>
                  <div>
                    <div class="text-xs text-slate-400 mb-1">有效天数（0=不过期）</div>
                    <input v-model.number="redeemCodes.expiresInDays" type="number" min="0" max="3650" class="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm outline-none" />
                  </div>
                </div>
                <div class="flex gap-2">
                  <button
                    type="button"
                    :disabled="redeemCodes.generating"
                    @click="generateRedeemCodes"
                    class="flex-1 py-2.5 rounded-xl bg-primary-600 text-white text-sm font-medium disabled:opacity-60"
                  >{{ redeemCodes.generating ? '生成中…' : '生成' }}</button>
                  <button
                    type="button"
                    :disabled="!redeemCodes.lastBatchId || redeemCodes.downloading"
                    @click="downloadRedeemBatch(redeemCodes.lastBatchId)"
                    class="flex-1 py-2.5 rounded-xl border border-primary-200 text-primary-700 text-sm font-medium disabled:opacity-40"
                  >{{ redeemCodes.downloading ? '下载中…' : '下载 Excel' }}</button>
                </div>
                <div v-if="redeemCodes.lastBatchId" class="text-xs text-slate-500 bg-slate-50 rounded-xl px-3 py-2">
                  最近批次 <span class="font-mono text-primary-700">{{ redeemCodes.lastBatchId }}</span>
                  · {{ redeemCodes.lastCodes.length }} 个
                </div>
              </div>

              <div class="bg-white rounded-2xl p-4 shadow-sm space-y-2">
                <div class="flex items-center justify-between">
                  <div class="font-semibold">历史批次</div>
                  <button type="button" class="text-xs text-primary-700" :disabled="redeemCodes.loading" @click="loadRedeemCodesPage">刷新</button>
                </div>
                <div v-if="redeemCodes.loading" class="text-sm text-slate-400 py-4 text-center">加载中…</div>
                <div v-else-if="!redeemCodes.batches.length" class="text-sm text-slate-400 py-4 text-center">暂无批次</div>
                <div
                  v-for="b in redeemCodes.batches"
                  :key="b.batchId"
                  class="border border-slate-100 rounded-xl px-3 py-2.5 space-y-1.5"
                  :class="redeemCodes.selectedBatchId === b.batchId ? 'border-primary-300 bg-primary-50/40' : ''"
                >
                  <div class="flex items-start justify-between gap-2">
                    <button type="button" class="min-w-0 text-left" @click="loadRedeemBatchCodes(b.batchId)">
                      <div class="font-medium text-sm truncate">{{ b.productName }} · {{ b.planLabel }}卡</div>
                      <div class="text-[11px] text-slate-400 font-mono truncate">{{ b.batchId }}</div>
                      <div class="text-[11px] text-slate-400 mt-0.5">
                        {{ fmtRedeemTime(b.createdAt) }}
                        <template v-if="b.expiresAt"> · 过期 {{ fmtRedeemTime(b.expiresAt) }}</template>
                        · 共 {{ b.total }} · 未用 {{ b.unused }} · 已兑 {{ b.used }}
                        <template v-if="b.disabled"> · 已移除 {{ b.disabled }}</template>
                      </div>
                    </button>
                    <div class="shrink-0 flex flex-col gap-1">
                      <button
                        type="button"
                        class="px-2.5 py-1 rounded-lg border border-primary-200 text-primary-700 text-xs font-medium"
                        :disabled="redeemCodes.downloading"
                        @click="downloadRedeemBatch(b.batchId)"
                      >Excel</button>
                      <button
                        type="button"
                        class="px-2.5 py-1 rounded-lg border border-amber-200 text-amber-700 text-xs font-medium disabled:opacity-40"
                        :disabled="redeemCodes.managing || !b.unused"
                        @click="removeRedeemBatch(b.batchId)"
                      >移除</button>
                      <button
                        type="button"
                        class="px-2.5 py-1 rounded-lg border border-rose-200 text-rose-600 text-xs font-medium disabled:opacity-40"
                        :disabled="redeemCodes.managing"
                        @click="deleteRedeemBatch(b.batchId)"
                      >删除</button>
                    </div>
                  </div>
                </div>
              </div>

              <div v-if="redeemCodes.selectedBatchId" class="bg-white rounded-2xl p-4 shadow-sm space-y-2">
                <div class="flex items-center justify-between gap-2">
                  <div class="font-semibold">码列表</div>
                  <div class="text-[11px] text-slate-400 font-mono truncate">{{ redeemCodes.selectedBatchId }} · {{ redeemCodes.codesTotal }}</div>
                </div>
                <div class="flex gap-2">
                  <input
                    v-model="redeemCodes.codesSearch"
                    type="search"
                    placeholder="搜索兑换码…"
                    class="flex-1 min-w-0 border border-slate-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-primary-400 uppercase"
                    @keyup.enter="searchRedeemCodes"
                  />
                  <button
                    type="button"
                    class="shrink-0 px-3 py-2 rounded-xl border border-primary-200 text-primary-700 text-sm font-medium disabled:opacity-40"
                    :disabled="redeemCodes.codesLoading"
                    @click="searchRedeemCodes"
                  >搜索</button>
                </div>
                <div v-if="redeemCodes.codesLoading" class="text-sm text-slate-400 py-4 text-center">加载中…</div>
                <div v-else-if="!redeemCodes.codes.length" class="text-sm text-slate-400 py-4 text-center">
                  {{ redeemCodes.codesSearch.trim() ? '无匹配兑换码' : '该批次无兑换码' }}
                </div>
                <template v-else>
                  <div
                    v-for="c in redeemCodes.codes"
                    :key="c.id"
                    class="flex items-center gap-2 border border-slate-100 rounded-xl px-3 py-2"
                  >
                    <div class="min-w-0 flex-1">
                      <div class="font-mono text-sm text-slate-800 truncate">{{ c.code }}</div>
                      <div class="text-[11px] text-slate-400 mt-0.5">
                        {{ c.statusLabel }}
                        <template v-if="c.expiresAt"> · 过期 {{ fmtRedeemTime(c.expiresAt) }}</template>
                        <template v-if="c.redeemedByName"> · {{ c.redeemedByName }}</template>
                      </div>
                    </div>
                    <button
                      v-if="c.status === 'unused' && !c.expired"
                      type="button"
                      class="shrink-0 px-2 py-1 rounded-lg border border-amber-200 text-amber-700 text-xs disabled:opacity-40"
                      :disabled="redeemCodes.managing"
                      @click="removeRedeemCode(c)"
                    >移除</button>
                    <button
                      type="button"
                      class="shrink-0 px-2 py-1 rounded-lg border border-rose-200 text-rose-600 text-xs disabled:opacity-40"
                      :disabled="redeemCodes.managing"
                      @click="deleteRedeemCodeItem(c)"
                    >删除</button>
                  </div>
                  <div class="flex items-center justify-between gap-2 pt-1">
                    <button
                      type="button"
                      class="px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 text-xs font-medium disabled:opacity-40"
                      :disabled="redeemCodes.codesLoading || redeemCodes.codesPage <= 1"
                      @click="gotoRedeemCodesPage(redeemCodes.codesPage - 1)"
                    >上一页</button>
                    <div class="text-xs text-slate-500 tabular-nums">
                      {{ redeemCodes.codesPage }} / {{ redeemCodesTotalPages() }}
                    </div>
                    <button
                      type="button"
                      class="px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 text-xs font-medium disabled:opacity-40"
                      :disabled="redeemCodes.codesLoading || redeemCodes.codesPage >= redeemCodesTotalPages()"
                      @click="gotoRedeemCodesPage(redeemCodes.codesPage + 1)"
                    >下一页</button>
                  </div>
                </template>
              </div>
            </section>

            <section v-else-if="role==='admin' && view==='overview'" class="space-y-4 fade-up">
              <div class="bg-white rounded-2xl p-4 shadow-sm space-y-3">
                <div class="flex items-center justify-between gap-2">
                  <div>
                    <div class="text-sm font-semibold text-slate-800">今日运营</div>
                    <div class="text-xs text-slate-400 mt-0.5">{{ todayReport.date || '今日' }} · 新增客户 / 激活码 / 营收</div>
                  </div>
                  <button type="button" class="text-xs text-primary-700 font-medium" @click="go('daily-report')">查看日报 ›</button>
                </div>
                <div class="grid grid-cols-3 gap-2">
                  <div class="rounded-xl bg-slate-50 px-2.5 py-3 text-center">
                    <div class="text-[11px] text-slate-400">新增客户</div>
                    <div class="text-xl font-bold mt-1 tabular-nums">{{ todayReport.loading ? '…' : todayReport.newUsers }}</div>
                  </div>
                  <div class="rounded-xl bg-slate-50 px-2.5 py-3 text-center">
                    <div class="text-[11px] text-slate-400">激活兑换码</div>
                    <div class="text-xl font-bold mt-1 tabular-nums">{{ todayReport.loading ? '…' : todayReport.redeemActivated }}</div>
                  </div>
                  <div class="rounded-xl bg-slate-50 px-2.5 py-3 text-center">
                    <div class="text-[11px] text-slate-400">营收</div>
                    <div class="text-lg font-bold mt-1 tabular-nums text-emerald-600">¥{{ todayReport.loading ? '…' : fmtMoney(todayReport.revenue) }}</div>
                  </div>
                </div>
              </div>
              <div class="grid grid-cols-2 gap-3">
                <div v-for="s in admin.stats" :key="s.label" class="bg-white rounded-2xl p-4 shadow-sm">
                  <div class="text-xs text-slate-400">{{ s.label }}</div>
                  <div class="text-2xl font-bold mt-1">{{ s.value }}</div>
                </div>
              </div>
              <div class="bg-white rounded-2xl p-4 shadow-sm">
                <div class="text-sm font-medium mb-3">平台营收（近 7 日）</div>
                <div class="flex items-end gap-2 h-28">
                  <div v-for="(v,i) in admin.revenue" :key="i" class="flex-1 rounded-t bg-gradient-to-t from-primary-500 to-accent-500"
                    :style="{height: Math.max(4, (v / Math.max(...admin.revenue, 1) * 100)) + '%'}"></div>
                </div>
              </div>
              <div class="bg-white rounded-2xl p-4 shadow-sm space-y-3">
                <div class="flex items-center justify-between gap-2">
                  <div>
                    <div class="text-sm font-medium">提现申请</div>
                    <div class="text-xs text-slate-400 mt-0.5">通过后标记为已打款</div>
                  </div>
                  <span v-if="admin.pendingWithdrawCount > 0" class="px-2 py-0.5 rounded-full text-xs font-medium bg-warning/10 text-warning">
                    {{ admin.pendingWithdrawCount }} 笔待处理
                  </span>
                </div>
                <div class="flex bg-slate-100 rounded-xl p-1 text-sm">
                  <button
                    v-for="opt in [{key:'pending',label:'待打款'},{key:'paid',label:'已打款'},{key:'all',label:'全部'}]"
                    :key="opt.key"
                    @click="setAdminWithdrawFilter(opt.key)"
                    :class="['flex-1 py-2 rounded-lg transition', adminWithdrawFilter===opt.key ? 'bg-white shadow text-primary-700 font-medium' : 'text-slate-500']">
                    {{ opt.label }}
                  </button>
                </div>
                <div class="list-search-wrap">
                  <span class="list-search-icon" v-html="icon('search')"></span>
                  <input v-model="listSearch.withdrawals" type="search" placeholder="搜索代理、账号..." class="list-search-input" />
                </div>
                <div v-if="filteredWithdrawals.length === 0" class="text-sm text-slate-400 text-center py-6">
                  暂无{{ adminWithdrawFilter === 'pending' ? '待打款' : adminWithdrawFilter === 'paid' ? '已打款' : '' }}提现申请
                </div>
                <div v-for="w in filteredWithdrawals" :key="w.id" class="rounded-xl px-3 py-3 ring-1 ring-slate-100 flex items-center gap-3">
                  <div class="flex-1 min-w-0">
                    <div class="font-medium truncate">{{ w.agentName || '代理' }}</div>
                    <div class="text-xs text-slate-400 mt-0.5 truncate">{{ w.agentAccount }}</div>
                    <div class="text-xs text-slate-400 mt-1">{{ fmtDateTime(w.createdAt) }}</div>
                  </div>
                  <div class="text-right shrink-0">
                    <div class="font-bold text-accent-500 tabular-nums">¥{{ w.amount }}</div>
                    <span :class="withdrawStatusClass(w.status)" class="inline-block mt-1 px-2 py-0.5 rounded-full text-[11px] font-medium">
                      {{ withdrawStatusText(w.status) }}
                    </span>
                  </div>
                  <button
                    v-if="w.status === 'pending'"
                    @click="payWithdrawal(w.id)"
                    :disabled="payingWithdrawId === w.id"
                    class="shrink-0 px-3 py-2 rounded-xl bg-primary-600 text-white text-xs font-medium hover:bg-primary-700 active:scale-95 transition disabled:opacity-50"
                  >
                    {{ payingWithdrawId === w.id ? '处理中' : '确认打款' }}
                  </button>
                </div>
              </div>
            </section>

            <section v-else-if="role==='admin' && view==='products'" class="space-y-3 fade-up">
              <button @click="go('manage')" class="text-sm text-primary-700 flex items-center gap-1 px-1"><span v-html="icon('back')"></span>返回管理中心</button>
              <div class="flex items-center justify-between px-1">
                <h2 class="text-xl font-semibold">产品管理</h2>
                <button @click="openAdminModal('product','create')" class="px-3 py-1.5 rounded-xl bg-primary-600 text-white text-sm active:scale-95 transition">+ 新建</button>
              </div>
              <div class="flex bg-slate-100 rounded-xl p-1 text-sm">
                <button
                  v-for="opt in [{key:'all',label:'全部'},{key:'online',label:'已上架'},{key:'offline',label:'已下架'}]"
                  :key="opt.key"
                  @click="setProductStatusFilter(opt.key)"
                  :class="['flex-1 py-2 rounded-lg transition', productStatusFilter===opt.key ? 'bg-white shadow text-primary-700 font-medium' : 'text-slate-500']">
                  {{ opt.label }}
                </button>
              </div>
              <div class="list-search-wrap">
                <span class="list-search-icon" v-html="icon('search')"></span>
                <input v-model="listSearch.products" type="search" placeholder="搜索产品名称、链接..." class="list-search-input" />
              </div>
              <div v-if="pagedProducts.total === 0" class="bg-white rounded-2xl p-8 shadow-sm text-center text-sm text-slate-400">
                暂无{{ productStatusFilter === 'online' ? '已上架' : productStatusFilter === 'offline' ? '已下架' : '' }}产品
              </div>
              <div v-for="p in pagedProducts.items" :key="p.id" class="bg-white rounded-xl px-3 py-3 shadow-sm ring-1 ring-slate-100">
                <div class="flex items-center justify-between gap-2">
                  <div class="flex items-center gap-3 min-w-0">
                    <ProductIcon :product="p" size="sm" />
                    <div class="min-w-0">
                      <div class="font-medium truncate">{{ p.name }}</div>
                      <div class="text-xs text-slate-400">月{{ p.priceMonth }} / 周{{ p.priceWeek }} / 天{{ p.priceDay }}</div>
                      <div class="text-[11px] text-primary-600 mt-0.5">支付默认：按{{ planText(p.defaultPlan || 'month') }}</div>
                    </div>
                  </div>
                  <span :class="p.online ? 'bg-success/10 text-success' : 'bg-slate-100 text-slate-400'" class="shrink-0 px-2 py-0.5 rounded-full text-xs font-medium">{{ p.online ? '已上架' : '已下架' }}</span>
                </div>
                <div class="flex gap-2 mt-3">
                  <button @click="openAdminModal('product','edit',p)" class="flex-1 py-1.5 rounded-lg border border-primary-200 text-primary-700 text-xs font-medium">编辑</button>
                  <button @click="toggleProductOnline(p)"
                    :class="p.online ? 'border-warning/40 text-warning' : 'border-success/40 text-success'"
                    class="flex-1 py-1.5 rounded-lg border text-xs font-medium">
                    {{ p.online ? '下架' : '上架' }}
                  </button>
                  <button @click="deleteAdminItem('product',p.id)" class="flex-1 py-1.5 rounded-lg border border-danger/30 text-danger text-xs font-medium">删除</button>
                </div>
              </div>
              <div v-if="pagedProducts.total > 0" class="flex items-center justify-between bg-white rounded-2xl px-3 py-2 shadow-sm text-sm">
                <button @click="goPage('products', pagedProducts.current-1)" :disabled="pagedProducts.current<=1" class="px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 disabled:opacity-40">上一页</button>
                <span class="text-xs text-slate-400">{{ pagedProducts.from }}-{{ pagedProducts.to }} / {{ pagedProducts.total }} · 第 {{ pagedProducts.current }}/{{ pagedProducts.totalPages }} 页</span>
                <button @click="goPage('products', pagedProducts.current+1)" :disabled="pagedProducts.current>=pagedProducts.totalPages" class="px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 disabled:opacity-40">下一页</button>
              </div>
            </section>

            <section v-else-if="role==='admin' && view==='agents'" class="space-y-3 fade-up">
              <button @click="go('manage')" class="text-sm text-primary-700 flex items-center gap-1 px-1"><span v-html="icon('back')"></span>返回管理中心</button>
              <div class="flex items-center justify-between px-1">
                <h2 class="text-xl font-semibold">代理管理</h2>
                <button @click="openAdminModal('agent','create')" class="px-3 py-1.5 rounded-xl bg-primary-600 text-white text-sm active:scale-95 transition">+ 新建</button>
              </div>
              <div class="list-search-wrap">
                <span class="list-search-icon" v-html="icon('search')"></span>
                <input v-model="listSearch.agents" type="search" placeholder="搜索代理姓名、账号、邀请码..." class="list-search-input" />
              </div>
              <div v-if="pagedAgents.total === 0" class="bg-white rounded-2xl p-8 shadow-sm text-center text-sm text-slate-400">未找到匹配的代理</div>
              <div v-for="a in pagedAgents.items" :key="a.id" class="bg-white rounded-xl px-3 py-3 shadow-sm ring-1 ring-slate-100">
                <div class="flex items-start justify-between gap-2">
                  <div>
                    <div class="font-medium">{{ a.name }}</div>
                    <div class="text-xs text-slate-400 mt-0.5">{{ a.account }}</div>
                    <div class="text-xs text-slate-400 mt-1">客户 {{ a.clients }} 人 · 佣金 ¥{{ a.commission }} · 邀请码 {{ a.inviteCode }}</div>
                    <div v-if="buildRegisterLink(a.inviteCode)" class="mt-2 text-[11px] text-slate-500 font-mono break-all leading-relaxed">{{ buildRegisterLink(a.inviteCode) }}</div>
                  </div>
                  <div class="text-right shrink-0">
                    <span class="px-2 py-0.5 rounded-full text-xs font-medium bg-primary-50 text-primary-700">分成 {{ a.rate }}%</span>
                    <div class="text-[11px] text-slate-400 mt-1">{{ agentStatusText(a.agentStatus) }}</div>
                  </div>
                </div>
                <div class="flex gap-2 mt-3">
                  <button @click="copyRegisterLink(a.inviteCode)" class="flex-1 py-1.5 rounded-lg border border-accent-200 text-accent-700 text-xs font-medium">复制注册链接</button>
                  <button @click="openAdminModal('agent','edit',a)" class="flex-1 py-1.5 rounded-lg border border-primary-200 text-primary-700 text-xs font-medium">编辑</button>
                  <button @click="deleteAdminItem('agent',a.id)" class="flex-1 py-1.5 rounded-lg border border-danger/30 text-danger text-xs font-medium">删除</button>
                </div>
              </div>
              <div v-if="pagedAgents.total > 0" class="flex items-center justify-between bg-white rounded-2xl px-3 py-2 shadow-sm text-sm">
                <button @click="goPage('agents', pagedAgents.current-1)" :disabled="pagedAgents.current<=1" class="px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 disabled:opacity-40">上一页</button>
                <span class="text-xs text-slate-400">{{ pagedAgents.from }}-{{ pagedAgents.to }} / {{ pagedAgents.total }} · 第 {{ pagedAgents.current }}/{{ pagedAgents.totalPages }} 页</span>
                <button @click="goPage('agents', pagedAgents.current+1)" :disabled="pagedAgents.current>=pagedAgents.totalPages" class="px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 disabled:opacity-40">下一页</button>
              </div>
            </section>

            <section v-else-if="role==='admin' && view==='orders'" class="space-y-3 fade-up">
              <button @click="go('manage')" class="text-sm text-primary-700 flex items-center gap-1 px-1"><span v-html="icon('back')"></span>返回管理中心</button>
              <div class="flex items-center justify-between px-1">
                <h2 class="text-xl font-semibold">订单中心</h2>
              </div>
              <div class="flex bg-slate-100 rounded-xl p-1 text-sm">
                <button
                  v-for="opt in [{key:'all',label:'全部'},{key:'paid',label:'已付款'},{key:'pending',label:'未付款'}]"
                  :key="opt.key"
                  @click="setOrderStatusFilter(opt.key)"
                  :class="['flex-1 py-2 rounded-lg transition', orderStatusFilter===opt.key ? 'bg-white shadow text-primary-700 font-medium' : 'text-slate-500']">
                  {{ opt.label }}
                </button>
              </div>
              <div class="list-search-wrap">
                <span class="list-search-icon" v-html="icon('search')"></span>
                <input v-model="listSearch.orders" type="search" placeholder="搜索订单、用户、单号..." class="list-search-input" />
              </div>
              <div v-if="pagedPaymentOrders.total === 0" class="bg-white rounded-2xl p-8 shadow-sm text-center text-sm text-slate-400">
                暂无{{ orderStatusFilter === 'paid' ? '已付款' : orderStatusFilter === 'pending' ? '未付款' : '' }}订单
              </div>
              <div v-for="o in pagedPaymentOrders.items" :key="o.id" class="bg-white rounded-xl px-3 py-3 shadow-sm ring-1 ring-slate-100">
                <div class="flex items-start justify-between gap-2">
                  <div class="min-w-0">
                    <div class="font-medium truncate">{{ o.product }}</div>
                    <div class="text-xs text-slate-400 mt-0.5">{{ o.user }} · {{ o.account }}</div>
                    <div class="text-xs text-slate-400 mt-1">
                      代理：
                      <span v-if="o.agentName" class="text-primary-600">{{ o.agentName }}</span>
                      <span v-if="o.agentInviteCode" class="font-mono">（{{ o.agentInviteCode }}）</span>
                      <span v-else class="text-slate-300">无</span>
                    </div>
                    <div class="text-xs text-slate-400 mt-1">按{{ planText(o.plan) }} · ¥{{ o.amount }}</div>
                    <div class="text-[11px] text-slate-400 mt-1 font-mono truncate">单号 {{ o.reference }}</div>
                  </div>
                  <span :class="paymentOrderStatusClass(o.status)" class="shrink-0 px-2 py-0.5 rounded-full text-xs font-medium">
                    {{ paymentOrderStatusText(o.status) }}
                  </span>
                </div>
                <div class="flex justify-between text-[11px] text-slate-400 mt-3 pt-3 border-t border-slate-100">
                  <span>提交 {{ fmtDateTime(o.createdAt) }}</span>
                  <span v-if="o.paidAt">付款 {{ fmtDateTime(o.paidAt) }}</span>
                  <span v-else-if="o.status==='pending'">等待支付中</span>
                </div>
              </div>
              <div v-if="pagedPaymentOrders.total > 0" class="flex items-center justify-between bg-white rounded-2xl px-3 py-2 shadow-sm text-sm">
                <button @click="goPage('orders', pagedPaymentOrders.current-1)" :disabled="pagedPaymentOrders.current<=1" class="px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 disabled:opacity-40">上一页</button>
                <span class="text-xs text-slate-400">{{ pagedPaymentOrders.from }}-{{ pagedPaymentOrders.to }} / {{ pagedPaymentOrders.total }} · 第 {{ pagedPaymentOrders.current }}/{{ pagedPaymentOrders.totalPages }} 页</span>
                <button @click="goPage('orders', pagedPaymentOrders.current+1)" :disabled="pagedPaymentOrders.current>=pagedPaymentOrders.totalPages" class="px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 disabled:opacity-40">下一页</button>
              </div>
            </section>

            <section v-else-if="role==='admin' && view==='users'" class="space-y-3 fade-up">
              <button @click="go('manage')" class="text-sm text-primary-700 flex items-center gap-1 px-1"><span v-html="icon('back')"></span>返回管理中心</button>
              <div class="flex items-center justify-between px-1">
                <h2 class="text-xl font-semibold">用户管理</h2>
                <button @click="openAdminModal('user','create')" class="px-3 py-1.5 rounded-xl bg-primary-600 text-white text-sm active:scale-95 transition">+ 新建</button>
              </div>
              <div class="list-search-wrap">
                <span class="list-search-icon" v-html="icon('search')"></span>
                <input v-model="listSearch.users" type="search" placeholder="搜索用户姓名、账号..." class="list-search-input" />
              </div>
              <div v-if="pagedUsers.total === 0" class="bg-white rounded-2xl p-8 shadow-sm text-center text-sm text-slate-400">未找到匹配的用户</div>
              <div v-for="u in pagedUsers.items" :key="u.id" class="bg-white rounded-xl px-3 py-3 shadow-sm ring-1 ring-slate-100">
                <div class="flex items-center justify-between gap-2">
                  <div>
                    <div class="font-medium">{{ u.name }} <span class="text-xs font-normal" :class="u.role==='admin'?'text-amber-600':'text-slate-400'">{{ userRoleLabel(u) }}</span></div>
                    <div class="text-xs text-slate-400 mt-0.5">{{ u.account }}</div>
                    <div class="text-xs text-slate-400 mt-1">
                      <template v-if="u.role!=='admin'">余额 ¥{{ u.balance }}</template>
                      <template v-else>管理员账号</template>
                      <span v-if="u.agentName"> · 代理 {{ u.agentName }}</span>
                      <span v-if="u.tennisFilterEnabled"> · 网球自动投注</span>
                      <span v-if="u.btcSimEnabled"> · BTC自动投注</span>
                      <span v-if="userSubSummaryLine(u)"> · {{ userSubSummaryLine(u) }}</span>
                    </div>
                    <div v-if="u.subscriptions?.length" class="mt-1.5 flex flex-wrap gap-1">
                      <span
                        v-for="sub in u.subscriptions.slice(0, 4)"
                        :key="`${u.id}-${sub.productName}`"
                        class="text-[10px] px-2 py-0.5 rounded-full"
                        :class="sub.active ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-400'"
                      >{{ sub.productName }}{{ sub.active ? ` ${fmt(sub.expiryAt)}` : ' 过期' }}</span>
                    </div>
                  </div>
                </div>
                <div class="flex gap-2 mt-3">
                  <button @click="openAdminModal('user','edit',u)" class="flex-1 py-1.5 rounded-lg border border-primary-200 text-primary-700 text-xs font-medium">编辑</button>
                  <button @click="openResetPwdModal(u)" class="flex-1 py-1.5 rounded-lg border border-amber-200 text-amber-700 text-xs font-medium">重置密码</button>
                  <button @click="loadUserSubModal(u)" class="flex-1 py-1.5 rounded-lg border border-emerald-200 text-emerald-700 text-xs font-medium">订阅</button>
                  <button v-if="u.role!=='admin'" @click="deleteAdminItem('user',u.id)" class="flex-1 py-1.5 rounded-lg border border-danger/30 text-danger text-xs font-medium">删除</button>
                </div>
              </div>
              <div v-if="pagedUsers.total > 0" class="flex items-center justify-between bg-white rounded-2xl px-3 py-2 shadow-sm text-sm">
                <button @click="goPage('users', pagedUsers.current-1)" :disabled="pagedUsers.current<=1" class="px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 disabled:opacity-40">上一页</button>
                <span class="text-xs text-slate-400">{{ pagedUsers.from }}-{{ pagedUsers.to }} / {{ pagedUsers.total }} · 第 {{ pagedUsers.current }}/{{ pagedUsers.totalPages }} 页</span>
                <button @click="goPage('users', pagedUsers.current+1)" :disabled="pagedUsers.current>=pagedUsers.totalPages" class="px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 disabled:opacity-40">下一页</button>
              </div>
            </section>

          </main>

          <nav class="shrink-0 bg-white border-t border-slate-200 grid px-2 py-1.5" :style="{ gridTemplateColumns: `repeat(${tabs.length}, 1fr)` }">
            <button v-for="t in tabs" :key="t.view" @click="go(t.view)"
              :class="['flex flex-col items-center py-1.5 text-[11px] gap-0.5 transition-colors', isTabActive(t) ? 'text-primary-700' : 'text-slate-400 hover:text-slate-600']">
              <span :class="isTabActive(t) ? 'text-primary-600' : ''" v-html="icon(t.icon)" class="w-5 h-5"></span>
              {{ t.label }}
            </button>
          </nav>

          <div v-if="pwdModal.open" class="absolute inset-0 z-50 flex items-end sm:items-center justify-center">
            <div class="absolute inset-0 bg-black/40" @click="closePwdModal"></div>
            <div class="relative bg-white w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl p-5 fade-up">
              <div class="flex items-center justify-between mb-4">
                <div class="font-semibold text-lg">修改密码</div>
                <button type="button" @click="closePwdModal" class="text-slate-400 text-xl leading-none">×</button>
              </div>
              <p v-if="pwdModal.error" class="text-sm text-danger mb-3">{{ pwdModal.error }}</p>
              <div class="space-y-3">
                <div>
                  <label class="text-xs text-slate-400 mb-1 block">新密码</label>
                  <input
                    v-model="pwdModal.next"
                    :type="showPwdPlain ? 'text' : 'password'"
                    autocomplete="new-password"
                    placeholder="至少 6 位"
                    class="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-primary-400 bg-slate-50"
                  />
                </div>
                <div>
                  <label class="text-xs text-slate-400 mb-1 block">确认新密码</label>
                  <input
                    v-model="pwdModal.confirm"
                    :type="showPwdPlain ? 'text' : 'password'"
                    autocomplete="new-password"
                    placeholder="再次输入新密码"
                    class="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-primary-400 bg-slate-50"
                  />
                </div>
                <label class="flex items-center gap-2 text-xs text-slate-500 select-none">
                  <input v-model="showPwdPlain" type="checkbox" class="rounded border-slate-300" />
                  显示密码
                </label>
              </div>
              <button
                type="button"
                :disabled="pwdModal.saving"
                @click="submitChangePassword"
                class="w-full mt-4 py-3 rounded-xl bg-primary-600 text-white font-medium hover:bg-primary-700 active:scale-95 transition disabled:opacity-50"
              >{{ pwdModal.saving ? '提交中…' : '确认修改' }}</button>
            </div>
          </div>

          <div v-if="resetPwdModal.open" class="absolute inset-0 z-50 flex items-end sm:items-center justify-center">
            <div class="absolute inset-0 bg-black/40" @click="closeResetPwdModal"></div>
            <div class="relative bg-white w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl p-5 fade-up">
              <div class="flex items-center justify-between mb-4">
                <div class="font-semibold text-lg">重置密码</div>
                <button type="button" @click="closeResetPwdModal" class="text-slate-400 text-xl leading-none">×</button>
              </div>
              <p class="text-sm text-slate-500 mb-3">
                账号 <span class="font-medium text-slate-700">{{ resetPwdModal.user?.account }}</span>
                <span v-if="resetPwdModal.user?.name">（{{ resetPwdModal.user.name }}）</span>
              </p>
              <p v-if="resetPwdModal.error" class="text-sm text-danger mb-3">{{ resetPwdModal.error }}</p>
              <div class="space-y-3">
                <div>
                  <label class="text-xs text-slate-400 mb-1 block">新密码（可留空，将自动生成）</label>
                  <input
                    v-model="resetPwdModal.next"
                    type="text"
                    autocomplete="off"
                    placeholder="至少 6 位，或点下方随机生成"
                    class="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-primary-400 bg-slate-50 font-mono"
                  />
                </div>
                <div>
                  <label class="text-xs text-slate-400 mb-1 block">确认新密码</label>
                  <input
                    v-model="resetPwdModal.confirm"
                    type="text"
                    autocomplete="off"
                    placeholder="与上方一致；留空则自动生成"
                    class="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-primary-400 bg-slate-50 font-mono"
                  />
                </div>
                <button
                  type="button"
                  @click="genResetPassword"
                  class="w-full py-2 rounded-xl border border-slate-200 text-sm text-slate-600 hover:bg-slate-50"
                >随机生成 8 位密码</button>
                <div v-if="resetPwdModal.result" class="rounded-xl bg-emerald-50 border border-emerald-100 px-3 py-2.5">
                  <div class="text-xs text-emerald-700 mb-1">新密码（请告知用户，仅显示一次）</div>
                  <div class="flex items-center gap-2">
                    <code class="flex-1 text-sm font-mono text-emerald-900 break-all">{{ resetPwdModal.result }}</code>
                    <button type="button" @click="copyResetPassword" class="shrink-0 px-2.5 py-1 rounded-lg bg-emerald-600 text-white text-xs">复制</button>
                  </div>
                </div>
              </div>
              <button
                type="button"
                :disabled="resetPwdModal.saving"
                @click="submitResetUserPassword"
                class="w-full mt-4 py-3 rounded-xl bg-amber-600 text-white font-medium hover:bg-amber-700 active:scale-95 transition disabled:opacity-50"
              >{{ resetPwdModal.saving ? '重置中…' : (resetPwdModal.result ? '再次重置' : '确认重置') }}</button>
            </div>
          </div>

          <div v-if="recharge.open" class="absolute inset-0 z-50 flex items-end sm:items-center justify-center">
            <div class="absolute inset-0 bg-black/40" @click="recharge.open=false"></div>
            <div class="relative bg-white w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl p-5 fade-up">
              <div class="flex items-center justify-between mb-4">
                <div class="font-semibold text-lg">订阅 · {{ recharge.product?.name }}</div>
                <button @click="recharge.open=false" class="text-slate-400 text-xl leading-none">×</button>
              </div>
              <p class="text-xs text-slate-400 mb-3">选择订阅周期与支付方式</p>
              <div class="space-y-2" role="radiogroup">
                <button v-for="pl in plans" :key="pl.key" @click="recharge.plan=pl.key"
                  :class="['w-full flex items-center justify-between px-4 py-3 rounded-xl border text-left transition active:scale-95', recharge.plan===pl.key ? 'border-primary-600 bg-primary-50' : 'border-slate-200 hover:border-primary-300']">
                  <div>
                    <div class="font-medium">{{ pl.label }}</div>
                    <div class="text-xs text-slate-400">{{ pl.desc }}</div>
                  </div>
                  <div class="flex items-center gap-2 shrink-0">
                    <span class="font-bold text-primary-700">¥{{ recharge.product ? planPriceInfo(recharge.product, pl.key).current : 0 }}</span>
                    <span :class="recharge.plan===pl.key ? 'bg-primary-600 text-white' : 'bg-slate-100 text-slate-300'" class="w-4 h-4 rounded-full flex items-center justify-center text-[10px]">✓</span>
                  </div>
                </button>
              </div>
              <p class="text-xs text-slate-400 mt-3 mb-2">付款方式</p>
              <div class="grid grid-cols-2 gap-2 mb-3">
                <button @click="recharge.payMethod='online'"
                  :class="['py-2.5 rounded-xl border text-sm font-medium transition active:scale-95', recharge.payMethod==='online' ? 'border-primary-600 bg-primary-50 text-primary-700' : 'border-slate-200 text-slate-600 hover:border-slate-300']">
                  在线支付
                </button>
                <button @click="recharge.payMethod='balance'"
                  :class="['py-2.5 rounded-xl border text-sm font-medium transition active:scale-95', recharge.payMethod==='balance' ? 'border-primary-600 bg-primary-50 text-primary-700' : 'border-slate-200 text-slate-600 hover:border-slate-300']">
                  余额支付
                </button>
              </div>
              <template v-if="recharge.payMethod==='balance'">
                <div class="rounded-xl bg-slate-50 border border-slate-100 px-4 py-3 text-sm">
                  <div class="flex justify-between">
                    <span class="text-slate-500">当前余额</span>
                    <span class="font-semibold text-slate-800">¥{{ balance }}</span>
                  </div>
                  <div class="flex justify-between mt-1.5">
                    <span class="text-slate-500">应付金额</span>
                    <span class="font-semibold text-primary-700">¥{{ currentPlanPrice }}</span>
                  </div>
                </div>
                <p v-if="balanceInsufficient" class="text-xs text-danger mt-2">
                  余额不足，还差 ¥{{ (currentPlanPrice - balance).toFixed(2) }}
                </p>
              </template>
              <template v-else>
              <p class="text-xs text-slate-400 mb-2">支付方式</p>
              <div class="grid grid-cols-2 gap-2">
                <button @click="recharge.vendor='alipay'"
                  :class="['py-3 rounded-xl border text-sm font-medium flex items-center justify-center gap-2 transition active:scale-95', recharge.vendor==='alipay' ? 'border-[#1677ff] bg-[#1677ff]/10 text-[#1677ff]' : 'border-slate-200 text-slate-600 hover:border-slate-300']">
                  <span class="w-5 h-5 rounded-md bg-[#1677ff] text-white text-xs font-bold flex items-center justify-center">支</span>
                  支付宝
                </button>
                <button @click="recharge.vendor='wechatpay'"
                  :class="['py-3 rounded-xl border text-sm font-medium flex items-center justify-center gap-2 transition active:scale-95', recharge.vendor==='wechatpay' ? 'border-[#07c160] bg-[#07c160]/10 text-[#07c160]' : 'border-slate-200 text-slate-600 hover:border-slate-300']">
                  <span class="w-5 h-5 rounded-md bg-[#07c160] text-white text-xs font-bold flex items-center justify-center">微</span>
                  微信支付
                </button>
              </div>
              <p class="text-[11px] text-slate-400 mt-2 leading-relaxed">
                电脑端微信会显示扫码支付；手机微信内打开请选「微信支付」
              </p>
              </template>
              <p v-if="currentUser.inviteCode" class="text-xs text-center mt-2 text-slate-400">
                由邀请码 <span class="font-mono text-primary-600">{{ currentUser.inviteCode }}</span> 代理邀请
              </p>
              <button @click="confirmRecharge" :disabled="recharge.payMethod==='balance' && balanceInsufficient"
                class="w-full mt-4 py-3 rounded-xl bg-primary-600 text-white font-medium hover:bg-primary-700 active:scale-95 transition disabled:opacity-50 disabled:cursor-not-allowed">
                <template v-if="recharge.payMethod==='balance'">
                  余额支付 ¥{{ currentPlanPrice }}
                </template>
                <template v-else>
                  {{ recharge.vendor === 'wechatpay' ? '微信' : '支付宝' }}支付 ¥{{ currentPlanPrice }}
                </template>
              </button>
            </div>
          </div>

          <!-- 管理员 CRUD 弹窗 -->
          <div v-if="userSubModal.open" class="absolute inset-0 z-50 flex items-end sm:items-center justify-center">
            <div class="absolute inset-0 bg-black/40" @click="userSubModal.open=false"></div>
            <div class="relative bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl p-5 fade-up max-h-[88vh] overflow-y-auto">
              <div class="flex items-center justify-between mb-4">
                <div>
                  <div class="font-semibold text-lg">管理订阅</div>
                  <div class="text-xs text-slate-400 mt-0.5">{{ userSubModal.user?.name }} · {{ userSubModal.user?.account }}</div>
                </div>
                <button @click="userSubModal.open=false" class="text-slate-400 text-xl leading-none">×</button>
              </div>

              <div v-if="userSubModal.loading" class="text-sm text-slate-400 text-center py-8">加载中...</div>
              <template v-else>
                <div class="space-y-3">
                  <div v-for="sub in userSubModal.subscriptions" :key="sub.productId" class="rounded-xl border border-slate-200 p-3">
                    <div class="flex items-start justify-between gap-2">
                      <div>
                        <div class="font-medium text-sm">{{ sub.productName }}</div>
                        <div class="text-xs mt-1" :class="subscriptionStatusClass(sub)">{{ subscriptionStatusText(sub) }}</div>
                      </div>
                      <button
                        v-if="sub.expiryAt"
                        type="button"
                        class="text-xs text-danger shrink-0"
                        :disabled="userSubModal.saving"
                        @click="revokeUserSubscription(sub.productId, sub.productName)"
                      >取消</button>
                    </div>
                    <div class="mt-3 flex items-center gap-2">
                      <input
                        v-model="userSubModal.expiryDraft[sub.productId]"
                        type="datetime-local"
                        class="flex-1 border border-slate-200 rounded-xl px-3 py-2 text-xs outline-none focus:border-primary-400"
                      />
                      <button
                        type="button"
                        class="shrink-0 px-2 py-2 rounded-xl border border-slate-200 text-xs text-slate-600"
                        :disabled="userSubModal.saving"
                        @click="bumpUserSubExpiry(sub.productId, 7)"
                      >+7天</button>
                      <button
                        type="button"
                        class="shrink-0 px-2 py-2 rounded-xl border border-slate-200 text-xs text-slate-600"
                        :disabled="userSubModal.saving"
                        @click="bumpUserSubExpiry(sub.productId, 30)"
                      >+30天</button>
                      <button
                        type="button"
                        class="shrink-0 px-3 py-2 rounded-xl bg-primary-600 text-white text-xs font-medium disabled:opacity-50"
                        :disabled="userSubModal.saving"
                        @click="saveUserSubscriptionExpiry(sub.productId)"
                      >保存</button>
                    </div>
                  </div>
                </div>

                <div class="mt-5 pt-4 border-t border-slate-100">
                  <div class="text-sm font-semibold mb-3">开通 / 延期</div>
                  <div class="space-y-2">
                    <select v-model="userSubModal.grant.productId" class="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm outline-none">
                      <option v-for="p in adminProducts" :key="p.id" :value="p.id">{{ p.name }}</option>
                    </select>
                    <select v-model="userSubModal.grant.plan" class="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm outline-none">
                      <option v-for="pl in plans" :key="pl.key" :value="pl.key">{{ pl.label }}</option>
                    </select>
                    <input
                      v-model.number="userSubModal.grant.amount"
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="记录金额（留空为 0）"
                      class="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm outline-none"
                    />
                    <button
                      type="button"
                      class="w-full py-3 rounded-xl bg-emerald-600 text-white text-sm font-medium disabled:opacity-50"
                      :disabled="userSubModal.saving"
                      @click="grantUserSubscription"
                    >{{ userSubModal.saving ? '处理中...' : '开通 / 延期' }}</button>
                  </div>
                  <p class="text-[11px] text-slate-400 mt-2 leading-relaxed">延期会在当前未过期订阅基础上顺延；也可直接修改上方到期时间。</p>
                </div>
              </template>
            </div>
          </div>

          <div v-if="adminModal.open" class="absolute inset-0 z-50 flex items-end sm:items-center justify-center">
            <div class="absolute inset-0 bg-black/40" @click="adminModal.open=false"></div>
            <div class="relative bg-white w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl p-5 fade-up max-h-[85vh] overflow-y-auto">
              <div class="flex items-center justify-between mb-4">
                <div class="font-semibold text-lg">{{ adminModalTitle }}</div>
                <button @click="adminModal.open=false" class="text-slate-400 text-xl leading-none">×</button>
              </div>

              <!-- 产品表单 -->
              <div v-if="adminModal.type==='product'" class="space-y-3">
                <input v-model="adminModal.form.name" placeholder="产品名称" class="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-primary-400"/>
                <div>
                  <div class="text-xs text-slate-500 mb-2">选择图标</div>
                  <div class="grid grid-cols-4 gap-2">
                    <button
                      v-for="opt in PRODUCT_ICON_OPTIONS"
                      :key="opt.key"
                      type="button"
                      @click="selectProductIcon(opt)"
                      :class="['rounded-xl p-2 flex flex-col items-center gap-1 border transition', adminModal.form.tag===opt.key ? 'border-indigo-500 bg-indigo-50 ring-2 ring-indigo-200' : 'border-slate-200 hover:border-slate-300']"
                    >
                      <div class="h-9 w-9 rounded-lg flex items-center justify-center text-white" :style="{ background: opt.gradient }">
                        <span v-html="productIconSvg(opt.key)" class="w-4 h-4"></span>
                      </div>
                      <span class="text-[10px] text-slate-500 leading-tight text-center">{{ opt.label }}</span>
                    </button>
                  </div>
                </div>
                <input v-model="adminModal.form.url" placeholder="外链 URL" class="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-primary-400"/>
                <textarea v-model="adminModal.form.desc" placeholder="产品描述" rows="2" class="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-primary-400"></textarea>
                <div class="grid grid-cols-3 gap-2">
                  <div>
                    <input v-model.number="adminModal.form.priceMonth" type="number" placeholder="月价" class="w-full border border-slate-200 rounded-xl px-2 py-2 text-sm outline-none"/>
                    <label class="flex items-center gap-1.5 text-xs text-slate-500 mt-1.5 cursor-pointer">
                      <input type="checkbox" :checked="adminModal.form.defaultPlan === 'month'" class="accent-primary-600" @change="setProductDefaultPlan('month')"/>
                      默认
                    </label>
                  </div>
                  <div>
                    <input v-model.number="adminModal.form.priceWeek" type="number" placeholder="周价" class="w-full border border-slate-200 rounded-xl px-2 py-2 text-sm outline-none"/>
                    <label class="flex items-center gap-1.5 text-xs text-slate-500 mt-1.5 cursor-pointer">
                      <input type="checkbox" :checked="adminModal.form.defaultPlan === 'week'" class="accent-primary-600" @change="setProductDefaultPlan('week')"/>
                      默认
                    </label>
                  </div>
                  <div>
                    <input v-model.number="adminModal.form.priceDay" type="number" placeholder="天价" class="w-full border border-slate-200 rounded-xl px-2 py-2 text-sm outline-none"/>
                    <label class="flex items-center gap-1.5 text-xs text-slate-500 mt-1.5 cursor-pointer">
                      <input type="checkbox" :checked="adminModal.form.defaultPlan === 'day'" class="accent-primary-600" @change="setProductDefaultPlan('day')"/>
                      默认
                    </label>
                  </div>
                </div>
                <p class="text-[11px] text-slate-400">勾选「默认」的周期，用户支付时将自动选中</p>
                <label class="flex items-center gap-2 text-sm text-slate-600">
                  <input type="checkbox" v-model="adminModal.form.online" class="accent-primary-600"/> 上架销售
                </label>
              </div>

              <!-- 代理表单 -->
              <div v-else-if="adminModal.type==='agent'" class="space-y-3">
                <input v-if="adminModal.mode==='create'" v-model="adminModal.form.account" placeholder="登录账号" class="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-primary-400"/>
                <input v-model="adminModal.form.name" placeholder="显示名称" class="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-primary-400"/>
                <input v-model="adminModal.form.password" type="password" :placeholder="adminModal.mode==='create'?'密码（6位以上）':'新密码（留空不改）'" class="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-primary-400"/>
                <input v-model.number="adminModal.form.rate" type="number" placeholder="分成比例 %" class="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-primary-400"/>
                <select v-if="adminModal.mode==='edit'" v-model="adminModal.form.agentStatus" class="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm outline-none">
                  <option value="pending">待审核</option>
                  <option value="approved">已通过</option>
                  <option value="rejected">已拒绝</option>
                </select>
              </div>

              <!-- 订单表单 -->
              <div v-else-if="adminModal.type==='order'" class="space-y-3">
                <template v-if="adminModal.mode==='create'">
                  <select v-model="adminModal.form.userId" class="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm outline-none">
                    <option v-for="u in admin.users.filter(x=>x.role==='user')" :key="u.id" :value="u.id">{{ u.name }} ({{ u.account }})</option>
                  </select>
                  <select v-model="adminModal.form.productId" class="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm outline-none">
                    <option v-for="p in adminProducts" :key="p.id" :value="p.id">{{ p.name }}</option>
                  </select>
                </template>
                <select v-model="adminModal.form.plan" class="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm outline-none">
                  <option value="month">按月</option>
                  <option value="week">按周</option>
                  <option value="day">按天</option>
                </select>
                <input v-model.number="adminModal.form.amount" type="number" :placeholder="adminModal.mode==='create'?'金额（留空用产品定价）':'金额'" class="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-primary-400"/>
              </div>

              <!-- 用户表单 -->
              <div v-else-if="adminModal.type==='user'" class="space-y-3">
                <input v-if="adminModal.mode==='create'" v-model="adminModal.form.account" placeholder="登录账号" class="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-primary-400"/>
                <input v-model="adminModal.form.name" placeholder="显示名称" class="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-primary-400"/>
                <input v-model="adminModal.form.password" type="password" :placeholder="adminModal.mode==='create'?'密码（6位以上）':'新密码（留空不改）'" class="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-primary-400"/>
                <select v-model="adminModal.form.role" class="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm outline-none">
                  <option value="user">普通用户</option>
                  <option value="agent">代理</option>
                  <option value="admin">管理员</option>
                </select>
                <input v-if="adminModal.form.role!=='admin'" v-model.number="adminModal.form.balance" type="number" placeholder="账户余额" class="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-primary-400"/>
                <p v-if="adminModal.form.role==='admin'" class="text-xs text-slate-400">管理员无余额账户；下方权限开关用于控制网球/BTC 自动投注能力（管理员默认拥有全部后台权限）。</p>
                <label class="flex items-center gap-2 text-sm text-slate-600">
                  <input type="checkbox" v-model="adminModal.form.tennisFilterEnabled" class="accent-primary-600"/> 开通网球自动投注（筛选+批量）
                </label>
                <label class="flex items-center gap-2 text-sm text-slate-600">
                  <input type="checkbox" v-model="adminModal.form.btcSimEnabled" class="accent-primary-600"/> 开通 BTC 自动投注
                </label>
              </div>

              <button @click="saveAdminModal" :disabled="adminModal.saving" class="w-full mt-4 py-3 rounded-xl bg-primary-600 text-white font-medium hover:bg-primary-700 active:scale-95 transition disabled:opacity-60">
                {{ adminModal.saving ? '处理中...' : '保存' }}
              </button>
            </div>
          </div>

          <WalletSettings
            :open="showWalletSettings"
            @close="showWalletSettings = false"
            @updated="onWalletUpdated"
          />

          <div
            v-if="showRedeemModal"
            class="absolute inset-0 z-50 bg-black/40 flex items-start sm:items-center justify-center pt-3 sm:pt-0 px-0 sm:px-4"
            @click.self="closeRedeemModal"
          >
            <div class="relative bg-white w-full sm:max-w-sm rounded-b-2xl sm:rounded-2xl p-5 fade-up shadow-lg">
              <div class="flex items-start justify-between gap-3 mb-3">
                <div>
                  <div class="font-semibold text-lg">兑换码</div>
                  <p class="text-xs text-slate-400 mt-1">
                    <template v-if="redeemModalProduct?.name">为「{{ redeemModalProduct.name }}」输入兑换码开通或延期</template>
                    <template v-else>输入兑换码开通或延期订阅</template>
                  </p>
                </div>
                <button type="button" class="text-slate-400 text-xl leading-none px-1" @click="closeRedeemModal">×</button>
              </div>
              <select
                v-if="!redeemModalProduct?.id"
                v-model="redeemInput.productId"
                class="w-full mb-2 border border-slate-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-primary-400"
              >
                <option value="">自动识别产品（通用码需选择）</option>
                <option v-for="p in products" :key="p.id" :value="p.id">{{ p.name }}</option>
              </select>
              <input
                v-model="redeemInput.code"
                type="text"
                placeholder="请输入兑换码"
                class="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-primary-400 uppercase tracking-wide"
                @keyup.enter="submitRedeemCode"
              />
              <button
                type="button"
                :disabled="redeemInput.busy"
                @click="submitRedeemCode"
                class="w-full mt-3 py-2.5 rounded-xl bg-primary-600 text-white text-sm font-medium disabled:opacity-60"
              >{{ redeemInput.busy ? '兑换中…' : '兑换码兑换' }}</button>
            </div>
          </div>

          <div v-if="toast.show" class="absolute top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-xl text-white text-sm shadow-lg fade-up"
            :class="toast.type==='error' ? 'bg-danger' : 'bg-success'">
            {{ toast.msg }}
          </div>
        </template>
      </div>
    </template>
  </div>
</template>

<style scoped>
.product-board-back :deep(svg) {
  width: 1.35rem;
  height: 1.35rem;
}
</style>
