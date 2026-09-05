const express = require('express');
const pool = require('../db');
const { embedAuth } = require('../middleware/embedAuth');

const router = express.Router();

const STRIP_RESPONSE_HEADERS = new Set([
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'strict-transport-security',
  'transfer-encoding',
  'connection',
  'content-encoding',
]);

const REWRITABLE_TYPES = /html|javascript|json|text\/plain|xml/i;

async function userCanAccessProduct(userId, role, productId) {
  if (role === 'admin') return true;
  const [[sub]] = await pool.query(
    'SELECT expiry_at FROM subscriptions WHERE user_id=? AND product_id=?',
    [userId, productId]
  );
  return sub && new Date(sub.expiry_at) > new Date();
}

function embedBase(productId) {
  return `/api/embed/${productId}`;
}

function buildUpstreamUrl(productUrl, subPath, search = '') {
  const target = new URL(productUrl);
  if (!subPath) {
    const url = new URL(productUrl);
    if (search) url.search = search;
    return url.href;
  }
  const normalized = subPath.startsWith('/') ? subPath.slice(1) : subPath;
  const url = new URL(normalized, target);
  if (search) url.search = search;
  return url.href;
}

function injectFetchShim(html, base) {
  const shim = `<script>(function(){var B=${JSON.stringify(base)};var o=window.fetch;window.fetch=function(u,i){if(typeof u==="string"&&u.charAt(0)==="/"&&u.indexOf(B)!==0)u=B+u;return o.call(this,u,i);};var XO=window.XMLHttpRequest;function XP(){var r=new XO(),op=r.open;r.open=function(m,u){if(typeof u==="string"&&u.charAt(0)==="/"&&u.indexOf(B)!==0)u=B+u;return op.apply(r,arguments);};return r;}window.XMLHttpRequest=XP;})();</script>`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>${shim}`);
  }
  return `<!DOCTYPE html><html><head>${shim}</head><body>${html}</body></html>`;
}

function rewriteHtmlAssets(html, base) {
  let body = html
    .replace(/<base[^>]*>/gi, '')
    .replace(/<meta[^>]+http-equiv=["']content-security-policy["'][^>]*>/gi, '')
    .replace(/<meta[^>]+http-equiv=["']x-frame-options["'][^>]*>/gi, '');

  body = body.replace(/(\s(?:src|href)=)(["'])\/([^"'#?]+)\2/gi, (match, attr, quote, path) => {
    if (path.startsWith('api/embed/')) return match;
    return `${attr}${quote}${base}/${path}${quote}`;
  });

  return injectFetchShim(body, base);
}

function rewriteSetCookie(value, base) {
  return value
    .replace(/;\s*Path=\/(?=[;\s]|$)/gi, `; Path=${base}`)
    .replace(/;\s*Domain=[^;]+/gi, '');
}

function forwardRequestHeaders(req, upstreamUrl) {
  const headers = {
    'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (compatible; YuceEmbed/1.0)',
    Accept: req.headers.accept || '*/*',
    'Accept-Language': req.headers['accept-language'] || 'zh-CN,zh;q=0.9',
  };
  if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
  if (req.headers.cookie) {
    const filtered = req.headers.cookie
      .split(';')
      .map((c) => c.trim())
      .filter((c) => !c.startsWith('embed_auth_'))
      .join('; ');
    if (filtered) headers.Cookie = filtered;
  }
  const upstream = new URL(upstreamUrl);
  if (req.headers.referer) {
    try {
      const ref = new URL(req.headers.referer);
      ref.protocol = upstream.protocol;
      ref.host = upstream.host;
      headers.Referer = ref.href;
    } catch {
      headers.Referer = upstream.origin + '/';
    }
  } else {
    headers.Referer = upstream.origin + '/';
  }
  return headers;
}

async function proxyProduct(req, res) {
  const productId = Number(req.params.productId);
  if (!productId) return res.status(400).send('无效产品');

  const canAccess = await userCanAccessProduct(req.user.id, req.user.role, productId);
  if (!canAccess) return res.status(403).send('未订阅或已过期');

  const [[product]] = await pool.query(
    'SELECT url FROM products WHERE id=? AND online=1',
    [productId]
  );
  if (!product?.url?.trim()) return res.status(404).send('产品链接未配置');

  const targetUrl = product.url.trim();
  if (!/^https?:\/\//i.test(targetUrl)) {
    return res.status(400).send('无效外链，请使用 http:// 或 https:// 开头');
  }

  const rawPath = req.params.splat;
  const subPath = Array.isArray(rawPath) ? rawPath.join('/') : (rawPath || '');
  const query = new URLSearchParams(req.query);
  query.delete('token');
  const search = query.toString();
  const upstreamUrl = buildUpstreamUrl(targetUrl, subPath, search);
  const base = embedBase(productId);

  const fetchInit = {
    method: req.method,
    headers: forwardRequestHeaders(req, upstreamUrl),
    redirect: 'follow',
  };

  if (!['GET', 'HEAD'].includes(req.method)) {
    if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) {
      fetchInit.body = JSON.stringify(req.body);
      fetchInit.headers['Content-Type'] = req.headers['content-type'] || 'application/json';
    } else if (typeof req.body === 'string' && req.body) {
      fetchInit.body = req.body;
    }
  }

  const response = await fetch(upstreamUrl, fetchInit);
  const contentType = response.headers.get('content-type') || 'application/octet-stream';

  response.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (STRIP_RESPONSE_HEADERS.has(lower)) return;
    if (lower === 'set-cookie') {
      const rewritten = rewriteSetCookie(value, base);
      res.appendHeader('Set-Cookie', rewritten);
      return;
    }
    res.setHeader(key, value);
  });

  res.setHeader('Cache-Control', 'no-store');

  if (contentType.includes('html')) {
    const html = rewriteHtmlAssets(await response.text(), base);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(response.status).send(html);
  }

  if (REWRITABLE_TYPES.test(contentType) && response.status < 400) {
    let text = await response.text();
    if (contentType.includes('javascript') || contentType.includes('json')) {
      text = text.replace(/(["'`])\/(api\/)/g, `$1${base}/$2`);
    }
    return res.status(response.status).send(text);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  return res.status(response.status).send(buffer);
}

async function handleEmbed(req, res) {
  try {
    await proxyProduct(req, res);
  } catch (e) {
    const detail = e.cause?.message || e.message || 'unknown';
    console.error('embed error', productIdFrom(req), detail);
    return res.status(502).send(`内嵌页面加载失败：${detail}`);
  }
}

function productIdFrom(req) {
  return req.params.productId;
}

router.get('/:productId/*splat', embedAuth, handleEmbed);
router.post('/:productId/*splat', embedAuth, handleEmbed);
router.put('/:productId/*splat', embedAuth, handleEmbed);
router.patch('/:productId/*splat', embedAuth, handleEmbed);
router.delete('/:productId/*splat', embedAuth, handleEmbed);
router.get('/:productId', embedAuth, handleEmbed);
router.post('/:productId', embedAuth, handleEmbed);

module.exports = router;
