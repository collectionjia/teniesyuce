/**
 * 极简 HTTP CONNECT 隧道代理（仅 node:net/tls 内置模块，无第三方依赖）。
 * 供 node:https 请求经 IPWO（或 SOFA_HTTP_PROXY 覆盖）代理访问外网，禁止直连。
 * 代理地址从环境变量读取，规则与 scripts/tennis-monitor/tm/clients/proxy.py 保持一致。
 */
const net = require('net');
const tls = require('tls');
const https = require('https');

function proxyFromEnv() {
  const direct = String(process.env.SOFA_HTTP_PROXY || process.env.HTTP_PROXY || '').trim();
  if (direct) {
    return String(process.env.SOFA_HTTPS_PROXY || process.env.HTTPS_PROXY || direct).trim();
  }
  const user = String(process.env.IPWO_PROXY_USER || process.env.IPWO_USERNAME || '').trim();
  const pass = String(process.env.IPWO_PROXY_PASS || process.env.IPWO_PASSWORD || '').trim();
  if (!user || !pass) return '';
  let u = user;
  const zone = String(process.env.IPWO_PROXY_ZONE || '').trim();
  if (zone && !u.includes('_custom_zone_') && !u.includes('_zone_')) {
    u = `${u}_custom_zone_${zone.toUpperCase()}`;
  }
  const host = String(process.env.IPWO_PROXY_HOST || 'us.ipwo.net').trim();
  const port = String(process.env.IPWO_PROXY_PORT || '7878').trim();
  return `http://${encodeURIComponent(u)}:${encodeURIComponent(pass)}@${host}:${port}`;
}

/** https.Agent：createConnection 经代理 CONNECT 建立 TLS 隧道。 */
class HttpProxyAgent extends https.Agent {
  constructor(proxyUrl) {
    super({ keepAlive: false });
    this.proxyUrl = new URL(proxyUrl);
  }

  createConnection(options, callback) {
    const p = this.proxyUrl;
    const host = options.host || options.servername || 'localhost';
    const port = options.port || 443;
    const auth = p.username
      ? `Basic ${Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64')}`
      : null;

    const socket = net.connect({ host: p.hostname, port: Number(p.port || 7878) });
    const onError = (err) => {
      socket.destroy();
      callback(err);
    };
    socket.once('error', onError);

    socket.once('connect', () => {
      let lines = `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n`;
      if (auth) lines += `Proxy-Authorization: ${auth}\r\n`;
      lines += '\r\n';
      socket.write(lines);
    });

    let buf = Buffer.alloc(0);
    let settled = false;
    const settle = (err, tlsSock) => {
      if (settled) return;
      settled = true;
      callback(err, tlsSock);
    };
    const onTlsError = (err) => {
      socket.removeListener('error', onError);
      socket.destroy();
      settle(err);
    };
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      socket.removeListener('data', onData);
      const head = buf.subarray(0, idx).toString('latin1');
      const status = /^HTTP\/\d\.\d[ ]+(\d{3})/.exec(head)?.[1];
      if (status !== '200') {
        socket.removeListener('error', onError);
        socket.destroy();
        settle(new Error(`代理 CONNECT 失败: HTTP ${status || '?'}`));
        return;
      }
      const rest = buf.subarray(idx + 4);
      let tlsSock;
      try {
        tlsSock = tls.connect({ socket, servername: host }, () => {
          socket.removeListener('error', onError);
          settle(null, tlsSock);
        });
      } catch (err) {
        socket.destroy();
        settle(err);
        return;
      }
      tlsSock.on('error', onTlsError);
      if (rest.length) tlsSock.push(rest);
    };
    socket.on('data', onData);
  }
}

/** Polymarket 默认允许无代理直连；Sofascore 必须经 IPWO；其它 scope 未配置代理时抛错。
 * 非 Sofascore 任务可由 COLLECT_TOP100_USE_PROXY / COLLECT_INPLAY_USE_PROXY=0 强制直连。
 */
const _agents = new Map();
const DIRECT_ALLOWED = new Set(['Polymarket', 'polymarket']);
const SOFA_SCOPE = 'Sofascore';

/** Sofascore 经 IPWO 的请求计数（每次 httpsGetJson scope=Sofascore 且走代理 +1） */
const sofaIpwoStats = { last_tick: 0, total: 0 };

function beginSofaIpwoTick() {
  sofaIpwoStats.last_tick = 0;
}

function getSofaIpwoStats() {
  return { last_tick: sofaIpwoStats.last_tick, total: sofaIpwoStats.total };
}

function bumpSofaIpwo() {
  sofaIpwoStats.last_tick += 1;
  sofaIpwoStats.total += 1;
}

function jobWantsProxy() {
  const job = String(process.env.COLLECT_PROXY_JOB || 'top100').toLowerCase();
  const isInplay = job.includes('inplay');
  const key = isInplay ? 'COLLECT_INPLAY_USE_PROXY' : 'COLLECT_TOP100_USE_PROXY';
  // Sofascore 默认直连（mobile API）；仅显式设为 1 时走代理
  const v = String(process.env[key] || '0').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(v);
}

function requireProxyAgent(scope = '外网') {
  const scopeStr = String(scope);
  // Top100 / 盘中关代理时 Sofascore 允许直连（mobile API）
  if (!jobWantsProxy()) {
    const key = `${scope}|forced-direct`;
    _agents.set(key, undefined);
    return undefined;
  }
  const key = `${scope}|${proxyFromEnv() || 'direct'}`;
  if (_agents.has(key)) return _agents.get(key);
  const url = proxyFromEnv();
  if (!url) {
    if (DIRECT_ALLOWED.has(String(scope))) {
      _agents.set(key, undefined);
      return undefined;
    }
    throw new Error(
      `${scope} 采集必须经 IPWO 代理，禁止直连。请到管理中心「采集代理」配置账号后重试。`
    );
  }
  const agent = new HttpProxyAgent(url);
  _agents.set(key, agent);
  return agent;
}

/** 经代理发起 HTTPS GET 并解析 JSON。Polymarket scope 无代理时直连。 */
function httpsGetJson(url, { scope = '外网', timeoutMs = 8000, headers = {}, allowDirect = false } = {}) {
  const agent = (() => {
    try {
      return requireProxyAgent(scope);
    } catch (e) {
      if (allowDirect || DIRECT_ALLOWED.has(String(scope))) return undefined;
      throw e;
    }
  })();
  if (String(scope) === SOFA_SCOPE && agent) {
    sofaIpwoStats.last_tick += 1;
    sofaIpwoStats.total += 1;
  }
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        ...(agent ? { agent } : {}),
        headers: { Accept: 'application/json', 'User-Agent': 'yuce-bid/1.0', ...headers },
      },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new Error(`${String(url).split('/')[2] || 'http'} HTTP ${res.statusCode}`));
          return;
        }
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (d) => {
          raw += d;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
  });
}

module.exports = {
  HttpProxyAgent,
  proxyFromEnv,
  requireProxyAgent,
  httpsGetJson,
  beginSofaIpwoTick,
  getSofaIpwoStats,
  bumpSofaIpwo,
};