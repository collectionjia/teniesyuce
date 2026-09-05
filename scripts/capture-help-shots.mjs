import { chromium } from 'playwright'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.resolve(__dirname, '../client/src/assets/help')
fs.mkdirSync(outDir, { recursive: true })

const BASE = 'https://www.yuce.bid'
const ACCOUNT = 'admin@demo.com'
const PASSWORD = '123456'

async function wait(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function apiLogin(page) {
  const res = await page.request.post(`${BASE}/api/auth/login`, {
    data: { account: ACCOUNT, password: PASSWORD },
    headers: { 'Content-Type': 'application/json' },
  })
  const body = await res.json()
  if (!res.ok()) throw new Error(`login failed ${res.status()} ${JSON.stringify(body)}`)
  if (!body.token) throw new Error(`no token ${JSON.stringify(body)}`)
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.evaluate((token) => localStorage.setItem('token', token), body.token)
  await page.reload({ waitUntil: 'networkidle' })
  await wait(2000)
  return body
}

async function clickProduct(page, keywords) {
  for (const kw of keywords) {
    const tile = page.locator('.product-tile, button.product-tile').filter({ hasText: kw }).first()
    if (await tile.count()) {
      await tile.click()
      await wait(2500)
      return kw
    }
  }
  // fallback: any text match in shop grid
  for (const kw of keywords) {
    const el = page.getByText(kw, { exact: false }).first()
    if (await el.count()) {
      await el.click()
      await wait(2500)
      return kw
    }
  }
  throw new Error('product not found: ' + keywords.join('/'))
}

async function goShop(page) {
  const shop = page.getByText('首页', { exact: true }).first()
  if (await shop.count()) {
    await shop.click()
    await wait(1200)
  }
}

async function shotClip(page, file, clip) {
  const vw = page.viewportSize()
  const c = {
    x: Math.max(0, Math.floor(clip.x)),
    y: Math.max(0, Math.floor(clip.y)),
    width: Math.min(Math.floor(clip.width), (vw?.width || 430) - Math.max(0, Math.floor(clip.x))),
    height: Math.min(Math.floor(clip.height), (vw?.height || 900) - Math.max(0, Math.floor(clip.y))),
  }
  if (c.width < 40 || c.height < 40) throw new Error('clip too small ' + JSON.stringify(c))
  await page.screenshot({
    path: path.join(outDir, file),
    type: 'jpeg',
    quality: 88,
    clip: c,
  })
  console.log('saved', file, c)
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 430, height: 920 },
    deviceScaleFactor: 2,
    locale: 'zh-CN',
  })
  const page = await context.newPage()
  page.setDefaultTimeout(25000)

  console.log('api login…')
  const user = await apiLogin(page)
  console.log('user', user.user?.role || user.role, user.user?.account || user.account)
  await page.screenshot({ path: path.join(outDir, '_debug-home.png'), fullPage: false })

  // dump product names
  const names = await page.locator('.product-tile-name, .product-tile').allTextContents()
  console.log('products visible:', names.slice(0, 20))

  await goShop(page)
  console.log('open tennis…')
  await clickProduct(page, ['网球', 'Tennis', 'Sofascore', 'Courtline'])
  await wait(2000)
  await page.screenshot({ path: path.join(outDir, '_debug-tennis.png'), fullPage: false })

  // redeem buttons area
  const redeem = page.getByText('兑换码兑换').first()
  const buy = page.getByText('兑换码购买').first()
  if (await redeem.count() && await buy.count()) {
    const b1 = await redeem.boundingBox()
    const b2 = await buy.boundingBox()
    const x = Math.max(0, Math.min(b1.x, b2.x) - 12)
    const y = Math.max(0, Math.min(b1.y, b2.y) - 70)
    const right = Math.max(b1.x + b1.width, b2.x + b2.width) + 12
    const bottom = Math.max(b1.y + b1.height, b2.y + b2.height) + 16
    await shotClip(page, 'help-redeem.jpg', { x, y, width: right - x, height: bottom - y })
  } else {
    await shotClip(page, 'help-redeem.jpg', { x: 8, y: 56, width: 414, height: 220 })
  }

  // tennis board body
  const main = page.locator('main').first()
  const mb = await main.boundingBox()
  if (mb) {
    await shotClip(page, 'help-tennis.jpg', {
      x: mb.x + 4,
      y: mb.y + 8,
      width: mb.width - 8,
      height: Math.min(560, mb.height - 8),
    })
  }

  // back + BTC
  console.log('open btc…')
  const back = page.locator('button').filter({ hasText: '返回' }).first()
  if (await back.count()) {
    await back.click()
    await wait(1200)
  } else {
    await goShop(page)
  }
  await clickProduct(page, ['BTC', '比特币', 'btc'])
  await wait(3000)
  await page.screenshot({ path: path.join(outDir, '_debug-btc.png'), fullPage: false })
  const mb2 = await page.locator('main').first().boundingBox()
  if (mb2) {
    await shotClip(page, 'help-btc.jpg', {
      x: mb2.x + 4,
      y: mb2.y + 8,
      width: mb2.width - 8,
      height: Math.min(560, mb2.height - 8),
    })
  }

  await browser.close()
  console.log('done')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
