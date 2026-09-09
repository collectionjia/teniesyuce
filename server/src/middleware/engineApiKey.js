/**
 * /api/engine/* 鉴权：有效 API Key，不看角色
 */
const engineApiKeys = require('../services/engineApiKeys');

function extractApiKey(req) {
  const h = req.headers['x-api-key'];
  if (h && String(h).trim()) return String(h).trim();
  const auth = req.headers.authorization || '';
  if (auth.toLowerCase().startsWith('bearer ')) {
    const token = auth.slice(7).trim();
    if (token.startsWith('eng_')) return token;
  }
  if (req.query?.apiKey) return String(req.query.apiKey).trim();
  return null;
}

function engineApiKeyAuth() {
  return async (req, res, next) => {
    try {
      const raw = extractApiKey(req);
      if (!raw) {
        return res.status(401).json({
          ok: false,
          error: 'missing api key',
          code: 'INVALID_API_KEY',
        });
      }
      const key = await engineApiKeys.verifyRawKey(raw);
      if (!key) {
        return res.status(401).json({
          ok: false,
          error: 'invalid api key',
          code: 'INVALID_API_KEY',
        });
      }
      req.engineKey = key;
      next();
    } catch (e) {
      console.error('[engine-api-key]', e.message);
      res.status(500).json({ ok: false, error: 'auth failed' });
    }
  };
}

module.exports = { engineApiKeyAuth, extractApiKey };
