const path = require('path');

const SERVER_ROOT = path.resolve(
  process.env.SERVER_ROOT || path.join(__dirname, '../../../../server')
);

function svc(name) {
  return require(path.join(SERVER_ROOT, 'src/services', name));
}

module.exports = { svc, SERVER_ROOT };
