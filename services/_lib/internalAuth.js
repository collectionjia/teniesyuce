/** 内网 internal API 鉴权（INTERNAL_SERVICE_TOKEN 未设则跳过，便于本地 dev） */
function internalAuth(req, res, next) {
  const token = (process.env.INTERNAL_SERVICE_TOKEN || '').trim();
  if (!token) return next();
  const auth = String(req.headers.authorization || '');
  if (auth === `Bearer ${token}`) return next();
  res.status(401).json({ ok: false, error: 'unauthorized' });
}

module.exports = { internalAuth };
