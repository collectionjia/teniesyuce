const jwt = require('jsonwebtoken');
require('dotenv').config();

function auth(requiredRoles) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: '未登录' });
    try {
      req.user = jwt.verify(token, process.env.JWT_SECRET);
      if (requiredRoles && !requiredRoles.includes(req.user.role)) {
        return res.status(403).json({ error: '无权限' });
      }
      next();
    } catch {
      return res.status(401).json({ error: '登录已过期' });
    }
  };
}

/** 有有效 token 则解析 req.user；无 token 或已过期时不报错，按未登录处理 */
function optionalAuth() {
  return (req, res, next) => {
    req.user = null;
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return next();
    try {
      req.user = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      req.user = null;
    }
    next();
  };
}

module.exports = { auth, optionalAuth };
