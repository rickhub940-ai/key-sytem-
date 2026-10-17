'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { hashHwid, verifyRealtimeTicket } = require('./realtime-ticket');

const PORT = Number.parseInt(process.env.PORT || '10000', 10);
const PATH = process.env.REALTIME_PATH || '/realtime';
const AUTH_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 30_000;
const MAX_MESSAGE_BYTES = 16 * 1024;
const MAX_MESSAGES_PER_MINUTE = 60;
const STATUS_STAGES = new Set(['stage1', 'stage2', 'stage3', 'payload', 'script', 'main']);
const COMMANDS = new Set(['disconnect', 'reauth', 'notice']);
const sessions = new Map();
const STARTED_AT = Date.now();
const VERSION = '1.2.0';

function reply(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function send(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function close(socket, code, reason) {
  if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close(code, reason);
}

function same(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parse(raw) {
  if (Buffer.byteLength(raw) > MAX_MESSAGE_BYTES) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// The admin surface accepts either an explicit SOCKET_ADMIN_TOKEN or a token
// derived from REALTIME_TICKET_SECRET. Both services already share that secret,
// so the Vercel control panel can authenticate without a second copied value,
// and the derived token is never handed to clients.
function derivedAdminToken() {
  const secret = process.env.REALTIME_TICKET_SECRET;
  if (typeof secret !== 'string' || secret.length < 32) return null;
  return crypto.createHmac('sha256', secret).update('999MS socket admin v1').digest('hex');
}

function adminCandidates() {
  return [process.env.SOCKET_ADMIN_TOKEN, derivedAdminToken()]
    .filter((value) => typeof value === 'string' && value.length >= 32);
}

function authorized(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const supplied = header.slice(7);
  return adminCandidates().some((expected) => same(supplied, expected));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    req.on('data', (chunk) => {
      length += chunk.length;
      if (length > MAX_MESSAGE_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.once('error', reject);
    req.once('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('invalid json')); }
    });
  });
}

function visibleSessions(now = Date.now()) {
  return [...sessions.values()].map((session) => ({
    sessionId: session.jti,
    hwidHash: session.hwidHash,
    scriptName: session.scriptName,
    connectedAt: session.connectedAt,
    lastActivityAt: session.lastActivityAt,
    idleMs: Math.max(0, now - session.lastActivityAt),
  }));
}

function command(body) {
  const session = sessions.get(body.jti);
  if (!session) return false;
  if (body.command === 'disconnect') {
    send(session.socket, { type: 'command', command: 'disconnect', reason: String(body.reason || 'session ended').slice(0, 128) });
    close(session.socket, 4403, 'session ended');
    return true;
  }
  send(session.socket, {
    type: 'command',
    command: body.command,
    message: typeof body.message === 'string' ? body.message.slice(0, 256) : '',
  });
  return true;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return reply(res, 200, {
      ok: true,
      version: VERSION,
      sessions: sessions.size,
      uptime: Math.round((Date.now() - STARTED_AT) / 1000),
      now: Date.now(),
    });
  }
  if (req.method === 'GET' && req.url === '/admin/stats') {
    if (!authorized(req)) return reply(res, 401, { ok: false });
    return reply(res, 200, {
      ok: true,
      version: VERSION,
      sessions: sessions.size,
      uptime: Math.round((Date.now() - STARTED_AT) / 1000),
      now: Date.now(),
    });
  }
  if (req.method === 'GET' && req.url === '/admin/sessions') {
    if (!authorized(req)) return reply(res, 401, { ok: false });
    const now = Date.now();
    return reply(res, 200, { ok: true, now, sessions: visibleSessions(now) });
  }
  if (req.method === 'POST' && req.url === '/admin/command') {
    if (!authorized(req)) return reply(res, 401, { ok: false });
    try {
      const body = await readJson(req);
      if (!body || typeof body.jti !== 'string' || !/^[a-f0-9]{24}$/.test(body.jti)
        || !COMMANDS.has(body.command)) return reply(res, 400, { ok: false });
      return reply(res, 200, { ok: command(body) });
    } catch {
      return reply(res, 400, { ok: false });
    }
  }
  return reply(res, 404, { ok: false });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://realtime.local');
  if (url.pathname !== PATH) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (client) => wss.emit('connection', client));
});

wss.on('connection', (socket) => {
  const state = { authenticated: false, pending: null, alive: true, windowStartedAt: Date.now(), messages: 0, session: null };
  socket._ms999 = state;
  const timeout = setTimeout(() => {
    if (!state.authenticated) close(socket, 4401, 'authentication timeout');
  }, AUTH_TIMEOUT_MS);

  socket.on('pong', () => { state.alive = true; });
  socket.on('message', (raw, binary) => {
    if (binary) return close(socket, 4400, 'text messages only');
    const now = Date.now();
    if (now - state.windowStartedAt >= 60_000) {
      state.windowStartedAt = now;
      state.messages = 0;
    }
    if (++state.messages > MAX_MESSAGES_PER_MINUTE) return close(socket, 4429, 'rate limited');
    const message = parse(raw.toString('utf8'));
    if (!message || typeof message.type !== 'string') return close(socket, 4400, 'invalid message');

    if (!state.authenticated) {
      if (state.pending) {
        const pending = state.pending;
        if (message.type !== 'handshake_response' || typeof message.id !== 'string'
          || typeof message.challenge !== 'string' || !same(message.id, pending.id)
          || !same(message.challenge, pending.challenge)) {
          return close(socket, 4401, 'handshake rejected');
        }
        const ticket = pending.ticket;
        const prior = sessions.get(ticket.jti);
        if (prior && prior.socket !== socket) close(prior.socket, 4402, 'replaced');
        state.pending = null;
        state.authenticated = true;
        state.session = {
          socket, jti: ticket.jti, hwidHash: ticket.hwidHash, scriptName: ticket.scriptName,
          connectedAt: now, lastActivityAt: now,
        };
        sessions.set(ticket.jti, state.session);
        clearTimeout(timeout);
        return send(socket, { type: 'authenticated', heartbeatMs: PING_INTERVAL_MS, expiresAt: ticket.exp * 1000 });
      }
      if (message.type !== 'authenticate' || typeof message.token !== 'string'
        || typeof message.hwid !== 'string' || typeof message.scriptName !== 'string') {
        return close(socket, 4401, 'authentication required');
      }
      const ticket = verifyRealtimeTicket(message.token);
      if (!ticket || ticket.scriptName !== message.scriptName || ticket.hwidHash !== hashHwid(message.hwid)) {
        return close(socket, 4401, 'authentication rejected');
      }
      const id = crypto.randomBytes(16).toString('hex');
      const challenge = crypto.randomBytes(32).toString('hex');
      state.pending = { ticket, id, challenge };
      return send(socket, { type: 'handshake_challenge', id, challenge, expiresAt: Date.now() + AUTH_TIMEOUT_MS });
    }

    if (message.type === 'heartbeat') {
      state.session.lastActivityAt = now;
      return send(socket, { type: 'heartbeat_ack', t: now });
    }
    if (message.type === 'status') {
      if (!STATUS_STAGES.has(message.stage) || (message.code !== undefined
        && (typeof message.code !== 'string' || message.code.length > 64))) {
        return close(socket, 4400, 'invalid status');
      }
      state.session.lastActivityAt = now;
      return send(socket, { type: 'status_ack', t: now });
    }
    return close(socket, 4400, 'unknown message');
  });

  socket.on('close', () => {
    clearTimeout(timeout);
    if (state.session && sessions.get(state.session.jti)?.socket === socket) sessions.delete(state.session.jti);
  });
  socket.on('error', () => {});
});

setInterval(() => {
  for (const socket of wss.clients) {
    const state = socket._ms999;
    if (!state) continue;
    if (!state.alive) {
      socket.terminate();
      continue;
    }
    state.alive = false;
    if (socket.readyState === WebSocket.OPEN) socket.ping();
  }
}, PING_INTERVAL_MS).unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`realtime gateway listening on ${PORT}${PATH}`);
});
