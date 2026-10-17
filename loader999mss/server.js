'use strict';

const http = require('node:http');
const handler = require('./api/auth');

const PORT = Number.parseInt(process.env.PORT || '10000', 10);
const MAX_BODY_BYTES = 1024 * 1024;

function body(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.once('error', reject);
    req.once('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('invalid json')); }
    });
  });
}

function response(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (value) => {
    if (!res.getHeader('content-type')) res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(value));
    return res;
  };
  res.send = (value = '') => {
    if (Buffer.isBuffer(value) || typeof value === 'string') res.end(value);
    else res.end(JSON.stringify(value));
    return res;
  };
  return res;
}

function route(req) {
  const url = new URL(req.url, 'http://gateway.local');
  const query = Object.fromEntries(url.searchParams.entries());
  const routes = {
    '/loadc.lua': ['artifact', 'loadc'],
    '/999MS-sdk.lua': ['artifact', 'sdk'],
    '/api/health': ['health'],
    '/api/link': ['link-create'],
    '/api/control/bans': ['control-bans'],
    '/api/control/traffic': ['control-traffic'],
    '/api/control/events': ['control-events'],
    '/api/verify': ['verify'],
    '/api/script': ['script'],
    '/api/script-verify': ['script-verify'],
    '/api/heartbeat': ['heartbeat'],
    '/api/start': ['start'],
    '/api/admin/ban': ['admin-ban'],
  };
  const linkMatch = url.pathname.match(/^\/x\/([a-f0-9]{40})$/);
  if (linkMatch) {
    query.action = 'link-serve';
    query.p = linkMatch[1];
  }
  const staged = !linkMatch && url.pathname.match(/^\/(loada|loader|payload)\.lua\/([^/]+)$/);
  if (staged) {
    query.action = 'artifact';
    query.name = staged[1];
    query.t = staged[2];
  } else if (!linkMatch) {
    const mapped = routes[url.pathname] || ['trap'];
    query.action = mapped[0];
    if (mapped[1]) query.name = mapped[1];
  }
  req.query = query;
}

const server = http.createServer(async (req, res) => {
  response(res);
  route(req);
  if (req.method === 'GET' && req.url === '/health') {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    return res.status(200).json({ ok: true, now: Date.now() });
  }
  if (req.method === 'POST' && String(req.headers['content-type'] || '').includes('application/json')) {
    try { req.body = await body(req); }
    catch { return res.status(400).json({ error: 'invalid json' }); }
  } else {
    req.body = {};
  }
  try {
    await handler(req, res);
  } catch (error) {
    console.error('[http]', error.message);
    if (!res.writableEnded) res.status(500).json({ error: 'internal error' });
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`api listening on ${PORT}`));
