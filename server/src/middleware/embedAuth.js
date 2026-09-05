const jwt = require('jsonwebtoken');
require('dotenv').config();

const COOKIE_PREFIX = 'embed_auth_';

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  for (const part of raw.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    const val = trimmed.slice(eq + 1);
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

function embedAuth(req, res, next) {
  const productId = req.params.productId;
  const header = req.headers.authorization || '';
  const headerToken = header.startsWith('Bearer ') ? header.slice(7) : null;
  const queryToken = typeof req.query.token === 'string' ? req.query.token : null;
  const cookies = parseCookies(req);
  const cookieToken = productId ? cookies[`${COOKIE_PREFIX}${productId}`] : null;
  const token = headerToken || queryToken || cookieToken;

  if (!token) return res.status(401).send('未登录');

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    if (queryToken && productId) {
      const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
      res.cookie(`${COOKIE_PREFIX}${productId}`, token, {
        httpOnly: true,
        secure,
        sameSite: 'lax',
        maxAge: 8 * 60 * 60 * 1000,
        path: `/api/embed/${productId}`,
      });
    }
    next();
  } catch {
    return res.status(401).send('登录已过期');
  }
}

module.exports = { embedAuth, COOKIE_PREFIX };
