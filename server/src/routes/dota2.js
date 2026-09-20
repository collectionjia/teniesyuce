/**
 * 代理 dota2elo 服务 JSON API（Vue 直出，不走 iframe）
 * 上游：DOTA2ELO_URL 或 DOTA2ELO_PRODUCT_URL，默认 http://dota2elo:3001
 */
const express = require('express');

const router = express.Router();

function upstreamBase() {
  const raw = process.env.DOTA2ELO_URL
    || process.env.DOTA2ELO_PRODUCT_URL
    || 'http://dota2elo:3001';
  return String(raw).replace(/\/+$/, '');
}

async function proxyJson(req, res) {
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const path = req.path.startsWith('/') ? req.path : `/${req.path}`;
  const url = `${upstreamBase()}/api${path}${qs}`;
  try {
    const upstream = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const text = await upstream.text();
    const type = upstream.headers.get('content-type') || 'application/json';
    res.status(upstream.status).type(type).send(text);
  } catch (err) {
    console.error('[dota2-proxy]', url, err.message || err);
    res.status(502).json({
      ok: false,
      error: err.message || 'dota2elo unreachable',
      upstream: upstreamBase(),
    });
  }
}

router.get('/health', proxyJson);
router.get('/rankings', proxyJson);
router.get('/teams', proxyJson);
router.get('/teams/:teamId', proxyJson);
router.get('/predict', proxyJson);
router.get('/matches', proxyJson);
router.get('/players', proxyJson);
router.get('/players/:playerId', proxyJson);
router.get('/calibration', proxyJson);
router.get('/backtest', proxyJson);

module.exports = router;
