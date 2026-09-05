const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

const MARKET_META = {
  '5m': { slugPrefix: 'btc-updown-5m', duration: 300, slugType: '' },
  '15m': { slugPrefix: 'btc-updown-15m', duration: 900, slugType: '' },
  '1h': { slugPrefix: 'bitcoin', duration: 3600, slugType: 'hourly' },
};

function hourlySlug(roundTs) {
  const et = new Date((Number(roundTs) - 4 * 3600) * 1000);
  const month = MONTHS[et.getUTCMonth()];
  const day = et.getUTCDate();
  const year = et.getUTCFullYear();
  const hour = et.getUTCHours();
  const ampm = hour < 12 ? 'am' : 'pm';
  let h12 = hour % 12;
  if (h12 === 0) h12 = 12;
  return `bitcoin-up-or-down-${month}-${day}-${year}-${h12}${ampm}-et`;
}

function marketSlug(tf, roundTs) {
  const meta = MARKET_META[tf];
  if (!meta || !roundTs) return '';
  if (meta.slugType === 'hourly') return hourlySlug(roundTs);
  return `${meta.slugPrefix}-${roundTs}`;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'yuce-bid/1.0' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function getRoundTokenIds(tf, roundTs) {
  const slug = marketSlug(tf, roundTs);
  if (!slug) return {};
  const { tokens, outcomes } = await getEventTokenIdsBySlug(slug);
  const result = {};
  for (let i = 0; i < outcomes.length; i += 1) {
    if (tokens[i]) result[String(outcomes[i]).toLowerCase()] = String(tokens[i]);
  }
  return result;
}

function extractEventSlug(urlOrSlug) {
  const raw = String(urlOrSlug || '').trim();
  if (!raw) return '';
  const m = raw.match(/polymarket\.com\/event\/([^/?#]+)/i);
  if (m) return decodeURIComponent(m[1]);
  return raw.replace(/^\/+|\/+$/g, '');
}

function lastToken(name) {
  if (!name) return '';
  const parts = String(name).trim().split(/\s+/);
  return (parts[parts.length - 1] || '').toLowerCase();
}

function sideIndex(outcomes, homeName, awayName, side) {
  const outcomesList = outcomes || [];
  if (!outcomesList.length) return side === 'home' ? 0 : 1;
  const homeLast = lastToken(homeName);
  const awayLast = lastToken(awayName);
  let homeIdx = outcomesList.findIndex((n) => lastToken(n) === homeLast);
  let awayIdx = outcomesList.findIndex((n) => lastToken(n) === awayLast);
  if (homeIdx < 0 && awayIdx < 0) {
    homeIdx = 0;
    awayIdx = 1;
  } else if (homeIdx < 0) homeIdx = awayIdx === 0 ? 1 : 0;
  else if (awayIdx < 0) awayIdx = homeIdx === 0 ? 1 : 0;
  return side === 'home' ? homeIdx : awayIdx;
}

async function getEventTokenIdsBySlug(slugOrUrl) {
  const slug = extractEventSlug(slugOrUrl);
  if (!slug) return { slug: '', tokens: [], outcomes: [] };
  const events = await fetchJson(
    `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`
  );
  if (!Array.isArray(events) || !events.length) {
    return { slug, tokens: [], outcomes: [] };
  }
  const markets = events[0]?.markets || [];
  let mkt = null;
  for (const candidate of markets) {
    let outcomes = candidate.outcomes || '[]';
    if (typeof outcomes === 'string') outcomes = JSON.parse(outcomes);
    const outs = (outcomes || []).map(String);
    if (outs.length >= 2 && !/^(yes|no)$/i.test(outs[0])) {
      mkt = candidate;
      break;
    }
  }
  if (!mkt) mkt = markets[0] || {};
  let tokens = mkt.clobTokenIds || '[]';
  let outcomes = mkt.outcomes || '[]';
  if (typeof tokens === 'string') tokens = JSON.parse(tokens);
  if (typeof outcomes === 'string') outcomes = JSON.parse(outcomes);
  return { slug, tokens, outcomes };
}

async function getEventSideTokenId(slugOrUrl, side, homeName, awayName) {
  const { slug, tokens, outcomes } = await getEventTokenIdsBySlug(slugOrUrl);
  if (!tokens.length) throw new Error(`未找到市场 token（${slug || 'unknown'}）`);
  const idx = sideIndex(outcomes, homeName, awayName, side === 'away' ? 'away' : 'home');
  const tokenId = tokens[idx];
  if (!tokenId) throw new Error('未找到对应方向的 token');
  return { tokenId: String(tokenId), slug, outcomes, prices: null };
}

function loadClob() {
  try {
    return require('@polymarket/clob-client-v2');
  } catch (e) {
    throw new Error('交易组件未安装（@polymarket/clob-client-v2），请联系管理员');
  }
}

function parseUsdcBalance(raw) {
  if (!raw || typeof raw !== 'object') return null;
  let b = raw.balance;
  if (b == null && raw.collateral && typeof raw.collateral === 'object') {
    b = raw.collateral.balance;
  }
  const n = Number(b);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round((n / 1e6) * 100) / 100;
}

function parseTokenShares(raw) {
  if (!raw || typeof raw !== 'object') return 0;
  const n = Number(raw.balance);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // conditional token 6 decimals → shares，向下取到 0.01
  return Math.floor((n / 1e6) * 100) / 100;
}

async function fetchUsdcBalance(secrets) {
  const client = await createClobClient(secrets);
  if (typeof client.getBalanceAllowance !== 'function') return null;
  const params = { asset_type: 'COLLATERAL' };
  try {
    if (typeof client.updateBalanceAllowance === 'function') {
      await client.updateBalanceAllowance(params);
    }
  } catch {
    /* 刷新失败仍尝试读取 */
  }
  const raw = await client.getBalanceAllowance(params);
  return parseUsdcBalance(raw);
}

async function fetchTokenShares(secrets, tokenId) {
  const tid = String(tokenId || '');
  if (!tid) return 0;
  const clob = loadClob();
  const { AssetType } = clob;
  const client = await createClobClient(secrets);
  if (typeof client.getBalanceAllowance !== 'function') return 0;
  const params = {
    asset_type: AssetType.CONDITIONAL,
    token_id: tid,
  };
  try {
    if (typeof client.updateBalanceAllowance === 'function') {
      await client.updateBalanceAllowance(params);
    }
  } catch {
    /* 刷新失败仍尝试读取 */
  }
  const raw = await client.getBalanceAllowance(params);
  return parseTokenShares(raw);
}

function adaptSigner(wallet) {
  // ethers v6 uses signTypedData; SDK prefers _signTypedData for EthersSigner path
  return {
    getAddress: async () => wallet.address,
    _signTypedData: async (domain, types, value) => wallet.signTypedData(domain, types, value),
  };
}

function resolveSignatureType(signatureType, eoaAddress, proxyAddress) {
  let sig = Number(signatureType);
  // 0=EOA, 1=Proxy(旧), 2=Gnosis Safe, 3=POLY_1271(V2 存款钱包，新账户常用)
  if (![0, 1, 2, 3].includes(sig)) sig = 1;
  const eoa = String(eoaAddress || '').toLowerCase();
  const proxy = String(proxyAddress || '').toLowerCase();
  // EOA 模式资金地址必须是私钥对应地址
  if (sig === 0) return { signatureType: 0, funderAddress: eoaAddress };
  // Proxy / Safe / 1271：资金在 proxy；若未填或与 EOA 相同则退回 EOA 模式
  if (!proxy || proxy === eoa) {
    return { signatureType: 0, funderAddress: eoaAddress };
  }
  return { signatureType: sig, funderAddress: proxyAddress };
}

async function createClobClient({ privateKey, proxyAddress, signatureType }) {
  const { ClobClient, Chain } = loadClob();
  const { ethers } = require('ethers');
  const wallet = new ethers.Wallet(privateKey);
  const signer = adaptSigner(wallet);
  const host = 'https://clob.polymarket.com';
  const resolved = resolveSignatureType(signatureType, wallet.address, proxyAddress);

  // L1 only：创建或派生与 EOA 绑定的 API Key
  const temp = new ClobClient({
    host,
    chain: Chain.POLYGON,
    signer,
  });
  const creds = typeof temp.createOrDeriveApiKey === 'function'
    ? await temp.createOrDeriveApiKey()
    : await temp.deriveApiKey();

  if (!creds?.key) {
    throw new Error('无法获取 Polymarket API Key，请确认私钥正确');
  }

  // L1+L2：下单客户端；API Key 归属 EOA，order.signer 也必须是 EOA
  return new ClobClient({
    host,
    chain: Chain.POLYGON,
    signer,
    creds,
    signatureType: resolved.signatureType,
    funderAddress: resolved.funderAddress,
  });
}

function formatClobError(result) {
  if (!result || typeof result !== 'object') return '下单无响应';
  if (result.errorMsg) return String(result.errorMsg);
  if (typeof result.error === 'string' && result.error) return result.error;
  if (result.error && typeof result.error === 'object') {
    try {
      return JSON.stringify(result.error);
    } catch {
      /* ignore */
    }
  }
  if (result.message) return String(result.message);
  const status = result.status;
  if (status != null && status !== '' && String(status).toLowerCase() !== 'matched') {
    return `CLOB 拒绝订单（${status}）`;
  }
  return '订单未成交（可能盘口不足或价格变动）';
}

function assertOrderFilled(result) {
  if (!result || typeof result !== 'object') {
    throw new Error('下单无响应');
  }
  // HTTP/SDK 错误体：{ error, status: 400 }
  if ('error' in result && result.success !== true) {
    throw new Error(formatClobError(result));
  }
  if (result.success === false) {
    throw new Error(formatClobError(result));
  }
  const taking = Number(result.takingAmount);
  const making = Number(result.makingAmount);
  const hasFill = (Number.isFinite(taking) && taking > 0)
    || (Number.isFinite(making) && making > 0);
  const hasTradeProof = (Array.isArray(result.tradeIDs) && result.tradeIDs.length > 0)
    || (Array.isArray(result.transactionsHashes) && result.transactionsHashes.length > 0);
  const status = String(result.status || '').toLowerCase();
  if (result.success === true && (hasFill || hasTradeProof || status === 'matched')) {
    return result;
  }
  if (hasFill || hasTradeProof) return result;
  throw new Error(formatClobError(result));
}

async function placeMarketBuy({
  privateKey,
  proxyAddress,
  signatureType,
  tokenId,
  amountUsd,
  price,
}) {
  const clob = loadClob();
  const { OrderType, Side } = clob;
  const client = await createClobClient({ privateKey, proxyAddress, signatureType });

  const amount = Math.round(Number(amountUsd) * 100) / 100;
  if (!(amount >= 1)) throw new Error('投注金额至少 $1');

  // 不传缓存价：让 SDK 用实时 orderbook 计算市价，避免看板价格过期导致 FOK 拒单
  const marketOrder = {
    tokenID: String(tokenId),
    amount,
    side: Side.BUY,
    orderType: OrderType.FOK,
  };

  let result;
  try {
    if (typeof client.createAndPostMarketOrder === 'function') {
      result = await client.createAndPostMarketOrder(
        marketOrder,
        { tickSize: '0.01' },
        OrderType.FOK
      );
    } else if (typeof client.createMarketOrder === 'function' && typeof client.postOrder === 'function') {
      const signed = await client.createMarketOrder(marketOrder, { tickSize: '0.01' });
      result = await client.postOrder(signed, OrderType.FOK);
    } else {
      const buyPrice = (price != null && Number(price) > 0)
        ? Math.round(Math.min(Math.max(Number(price) + 0.05, 0.01), 0.99) * 100) / 100
        : await client.calculateMarketPrice(String(tokenId), Side.BUY, amount, OrderType.FOK);
      const size = Math.floor((amount / buyPrice) * 100) / 100;
      if (!(size > 0)) throw new Error('下单份额无效');
      result = await client.createAndPostOrder(
        {
          tokenID: String(tokenId),
          price: buyPrice,
          size,
          side: Side.BUY,
        },
        { tickSize: '0.01' },
        OrderType.FOK
      );
    }
  } catch (e) {
    const data = e?.data;
    let detail = '';
    if (typeof data === 'string') detail = data;
    else if (data && typeof data === 'object') {
      detail = data.error || data.errorMsg || data.message
        || (typeof data.error === 'object' ? JSON.stringify(data.error) : '')
        || JSON.stringify(data).slice(0, 300);
    }
    const msg = (detail && String(detail)) || e?.message || String(e);
    console.error('[polymarket/placeMarketBuy]', e?.message || e, detail || '');
    throw new Error(msg);
  }

  try {
    return assertOrderFilled(result);
  } catch (e) {
    console.error('[polymarket/orderResult]', JSON.stringify(result).slice(0, 800));
    throw e;
  }
}

async function placeMarketSell({
  privateKey,
  proxyAddress,
  signatureType,
  tokenId,
  shares,
}) {
  const clob = loadClob();
  const { OrderType, Side } = clob;
  const client = await createClobClient({ privateKey, proxyAddress, signatureType });

  let amount = Math.floor(Number(shares) * 100) / 100;
  if (!(amount >= 0.01)) {
    // 未指定或无效时，从余额读全部可卖份额
    amount = await fetchTokenShares({ privateKey, proxyAddress, signatureType }, tokenId);
  }
  if (!(amount >= 0.01)) throw new Error('无持仓可平');

  const marketOrder = {
    tokenID: String(tokenId),
    amount,
    side: Side.SELL,
    orderType: OrderType.FOK,
  };

  let result;
  try {
    if (typeof client.createAndPostMarketOrder === 'function') {
      result = await client.createAndPostMarketOrder(
        marketOrder,
        { tickSize: '0.01' },
        OrderType.FOK
      );
    } else if (typeof client.createMarketOrder === 'function' && typeof client.postOrder === 'function') {
      const signed = await client.createMarketOrder(marketOrder, { tickSize: '0.01' });
      result = await client.postOrder(signed, OrderType.FOK);
    } else {
      const sellPrice = await client.calculateMarketPrice(
        String(tokenId),
        Side.SELL,
        amount,
        OrderType.FOK
      );
      result = await client.createAndPostOrder(
        {
          tokenID: String(tokenId),
          price: Math.round(Math.min(Math.max(Number(sellPrice) || 0.01, 0.01), 0.99) * 100) / 100,
          size: amount,
          side: Side.SELL,
        },
        { tickSize: '0.01' },
        OrderType.FOK
      );
    }
  } catch (e) {
    const data = e?.data;
    let detail = '';
    if (typeof data === 'string') detail = data;
    else if (data && typeof data === 'object') {
      detail = data.error || data.errorMsg || data.message
        || (typeof data.error === 'object' ? JSON.stringify(data.error) : '')
        || JSON.stringify(data).slice(0, 300);
    }
    const msg = (detail && String(detail)) || e?.message || String(e);
    console.error('[polymarket/placeMarketSell]', e?.message || e, detail || '');
    throw new Error(msg);
  }

  try {
    return { ...assertOrderFilled(result), soldShares: amount };
  } catch (e) {
    console.error('[polymarket/sellResult]', JSON.stringify(result).slice(0, 800));
    throw e;
  }
}

/**
 * 测试钱包能否连接 Polymarket CLOB（派生 API Key，不下单）。
 */
async function testWalletConnection({ privateKey, proxyAddress, signatureType }) {
  const { ethers } = require('ethers');
  const wallet = new ethers.Wallet(privateKey);
  const eoa = wallet.address;
  let resolved = resolveSignatureType(signatureType, eoa, proxyAddress);
  const client = await createClobClient({ privateKey, proxyAddress, signatureType: resolved.signatureType });
  let apiKeyHint = '';
  try {
    const key = client.creds?.key || client.creds?.apiKey || '';
    if (key) apiKeyHint = `${String(key).slice(0, 6)}…`;
  } catch {
    /* ignore */
  }
  let usdcBalance = null;
  try {
    usdcBalance = await fetchUsdcBalance({ privateKey, proxyAddress, signatureType: resolved.signatureType });
  } catch {
    /* balance 可选，连接成功即可 */
  }

  // 新账户多为 V2 存款钱包：用旧 Proxy(1) 会鉴权成功但余额恒为 0；自动探测 POLY_1271(3)
  let suggestedSignatureType = null;
  if (
    (usdcBalance == null || usdcBalance === 0)
    && resolved.signatureType === 1
    && proxyAddress
    && String(proxyAddress).toLowerCase() !== eoa.toLowerCase()
  ) {
    try {
      const bal3 = await fetchUsdcBalance({ privateKey, proxyAddress, signatureType: 3 });
      if (bal3 != null && bal3 > 0) {
        usdcBalance = bal3;
        resolved = { signatureType: 3, funderAddress: proxyAddress };
        suggestedSignatureType = 3;
      }
    } catch {
      /* ignore */
    }
  }

  return {
    ok: true,
    eoa,
    proxyAddress: resolved.funderAddress,
    signatureType: resolved.signatureType,
    suggestedSignatureType,
    apiKeyHint,
    usdcBalance,
    message: suggestedSignatureType === 3
      ? '连接成功：检测到 V2 存款钱包，请改用「Deposit Wallet / POLY_1271」以同步余额'
      : '钱包连接成功，已通过 Polymarket CLOB 鉴权',
  };
}

module.exports = {
  MARKET_META,
  marketSlug,
  extractEventSlug,
  getRoundTokenIds,
  getEventTokenIdsBySlug,
  getEventSideTokenId,
  sideIndex,
  assertOrderFilled,
  resolveSignatureType,
  placeMarketBuy,
  placeMarketSell,
  createClobClient,
  fetchUsdcBalance,
  fetchTokenShares,
  parseUsdcBalance,
  parseTokenShares,
  testWalletConnection,
};
