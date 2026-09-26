/**
 * Optional HTTP CONNECT tunnel (node:net/tls only).
 * Sofascore / Polymarket default to direct; only SOFA_HTTP_PROXY / HTTP_PROXY enable a tunnel.
 * IPWO support removed.
 */
const net = require('net');
const tls = require('tls');
const https = require('https');

function proxyFromEnv() {
  const direct = String(process.env.SOFA_HTTP_PROXY || process.env.HTTP_PROXY || '').trim();
  if (!direct) return '';
  return String(process.env.SOFA_HTTPS_PROXY || process.env.HTTPS_PROXY || direct).trim();
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

const _agents = new Map();
const SOFA_SCOPE = 'Sofascore';

/** Compat counters (were IPWO hits; now any Sofascore request via tunnel). */
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
  const v = String(process.env[key] || '0').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(v);
}

/** Never required — missing proxy means direct. */
function requireProxyAgent(scope = '外网') {
  if (!jobWantsProxy()) {
    const key = `${scope}|forced-direct`;
    _agents.set(key, undefined);
    return undefined;
  }
  const url = proxyFromEnv();
  const key = `${scope}|${url || 'direct'}`;
  if (_agents.has(key)) return _agents.get(key);
  if (!url) {
    _agents.set(key, undefined);
    return undefined;
  }
  const agent = new HttpProxyAgent(url);
  _agents.set(key, agent);
  return agent;
}

function httpsGetJson(url, { scope = '外网', timeoutMs = 8000, headers = {}, allowDirect = false } = {}) {
  void allowDirect;
  const agent = requireProxyAgent(scope);
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
