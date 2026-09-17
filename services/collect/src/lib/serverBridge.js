const path = require('path');

/** 加载 server/src/services 模块（P2 过渡；依赖 server 的 node_modules 与 REDIS 配置） */
const SERVER_ROOT = path.resolve(
  process.env.SERVER_ROOT || path.join(__dirname, '../../../../server')
);

function svc(name) {
  return require(path.join(SERVER_ROOT, 'src/services', name));
}

module.exports = { svc, SERVER_ROOT };
