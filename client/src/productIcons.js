const ICONS = {
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V4"/><path d="M4 20h16"/><path d="M8 16l3-4 3 2 4-6"/></svg>',
  trend: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l6-6 4 4 8-10"/><path d="M14 5h7v7"/></svg>',
  football: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 3l2.5 4.5L12 12l-2.5-4.5L12 3zM12 21l2.5-4.5L12 12l-2.5 4.5L12 21zM3 12h6M15 12h6"/></svg>',
  basketball: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 4 9 15 15 0 0 1-4 9 15 15 0 0 1-4-9 15 15 0 0 1 4-9z"/></svg>',
  tennis: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M6 6c4 4 4 8 0 12M18 6c-4 4-4 8 0 12"/></svg>',
  stock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19V5"/><path d="M4 19h16"/><rect x="7" y="10" width="3" height="9" rx="1"/><rect x="12" y="7" width="3" height="12" rx="1"/><rect x="17" y="13" width="3" height="6" rx="1"/></svg>',
  crypto: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9 8h4a2 2 0 0 1 0 4h-2a2 2 0 0 0 0 4h5"/><path d="M12 6v2M12 16v2"/></svg>',
  lottery: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="9" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="15" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="15" r="1.2" fill="currentColor" stroke="none"/></svg>',
  ai: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="18" r="2"/></svg>',
  radar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 12L18 8"/><path d="M12 12V6"/><path d="M12 12a4 4 0 0 1 3 1"/></svg>',
  target: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/></svg>',
  wave: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12c2-3 4-3 6 0s4 3 6 0 4-3 6 0"/></svg>',
}

export const PRODUCT_ICON_OPTIONS = [
  { key: 'chart', label: '走势分析', gradient: 'linear-gradient(135deg,#6366f1,#8b5cf6)' },
  { key: 'trend', label: '趋势分析', gradient: 'linear-gradient(135deg,#2563eb,#06b6d4)' },
  { key: 'football', label: '足球', gradient: 'linear-gradient(135deg,#15803d,#22c55e)' },
  { key: 'basketball', label: '篮球', gradient: 'linear-gradient(135deg,#c2410c,#f97316)' },
  { key: 'tennis', label: '网球', gradient: 'linear-gradient(135deg,#a16207,#eab308)' },
  { key: 'stock', label: '股票', gradient: 'linear-gradient(135deg,#1d4ed8,#3b82f6)' },
  { key: 'crypto', label: '数字货币', gradient: 'linear-gradient(135deg,#0e7490,#06b6d4)' },
  { key: 'lottery', label: '彩票', gradient: 'linear-gradient(135deg,#be123c,#f43f5e)' },
  { key: 'ai', label: 'AI 模型', gradient: 'linear-gradient(135deg,#6d28d9,#a855f7)' },
  { key: 'radar', label: '雷达分析', gradient: 'linear-gradient(135deg,#0f766e,#14b8a6)' },
  { key: 'target', label: '精准命中', gradient: 'linear-gradient(135deg,#be185d,#f472b6)' },
  { key: 'wave', label: '波动分析', gradient: 'linear-gradient(135deg,#4338ca,#6366f1)' },
]

const NAME_RULES = [
  [/足球|soccer|football/i, 'football'],
  [/\bnba\b|篮球|basketball/i, 'basketball'],
  [/网球|tennis/i, 'tennis'],
  [/dota\s*2|dota2/i, 'radar'],
  [/股票|证券|stock/i, 'stock'],
  [/比特|加密|crypto|btc|eth/i, 'crypto'],
  [/彩票|lottery/i, 'lottery'],
  [/ai|智能|模型/i, 'ai'],
  [/雷达|radar/i, 'radar'],
  [/走势|趋势|trend/i, 'trend'],
  [/波动|wave/i, 'wave'],
  [/命中|精准|target/i, 'target'],
]

const FALLBACK_KEYS = Object.keys(ICONS)

export function getProductIconKey(product) {
  const tag = String(product?.tag || '').trim().toLowerCase()
  if (tag === 'nba' || tag === 'basketball') return 'basketball'
  if (tag === 'dota2' || tag === 'dota') return tag === 'dota2' ? 'radar' : 'radar'
  if (ICONS[tag]) return tag
  const name = String(product?.name || '')
  for (const [pattern, key] of NAME_RULES) {
    if (pattern.test(name)) return key
  }
  const id = Number(product?.id) || 0
  return FALLBACK_KEYS[id % FALLBACK_KEYS.length]
}

export function productIconSvg(key) {
  return ICONS[key] || ICONS.chart
}

export function productGradient(key) {
  return PRODUCT_ICON_OPTIONS.find((item) => item.key === key)?.gradient
    || 'linear-gradient(135deg,#6366f1,#8b5cf6)'
}

export function productIconMeta(product) {
  const key = getProductIconKey(product)
  return {
    key,
    svg: productIconSvg(key),
    gradient: product?.gradient || productGradient(key),
  }
}
