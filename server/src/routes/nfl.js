/**
 * NFL：Polymarket 盘口列表/下单 + nflelo 预测代理
 */
const express = require('express');
const { boardRouter } = require('./dota2');

const router = express.Router();

function upstreamBase() {
  const raw = process.env.NFLELO_URL || 'http://nflelo:8000';
  return String(raw).replace(/\/+$/, '');
}

async function proxy(req, res) {
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const path = req.path.startsWith('/') ? req.path : `/${req.path}`;
  const url = `${upstreamBase()}/api${path}${qs}`;
  try {
    const init = {
      method: req.method,
      headers: { Accept: 'application/json' },
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(req.body ?? {});
    }
    const upstream = await fetch(url, init);
    const text = await upstream.text();
    const type = upstream.headers.get('content-type') || 'application/json';
    res.status(upstream.status).type(type).send(text);
  } catch (err) {
    console.error('[nfl-proxy]', url, err.message || err);
    res.status(502).json({
      ok: false,
      error: err.message || 'nflelo unreachable',
      upstream: upstreamBase(),
    });
  }
}

router.get('/health', proxy);
router.get('/info', proxy);
router.get('/rankings', proxy);
router.get('/team/:abbr', proxy);
router.post('/predict', proxy);
router.post('/predict/batch', proxy);

router.use((req, _res, next) => {
  req.boardSport = 'nfl';
  next();
});
router.use(boardRouter);

module.exports = router;
