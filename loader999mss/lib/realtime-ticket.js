'use strict';

const crypto = require('node:crypto');

const TTL_SECONDS = 30 * 60;

function secret() {
  const value = process.env.REALTIME_TICKET_SECRET;
  if (typeof value !== 'string' || value.length < 32) {
    throw new Error('REALTIME_TICKET_SECRET must be at least 32 characters');
  }
  return value;
}

function b64url(value) {
  return Buffer.from(value).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeB64url(value) {
  const source = String(value).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(source + '='.repeat((4 - source.length % 4) % 4), 'base64');
}

function sign(value) {
  return b64url(crypto.createHmac('sha256', secret()).update(value).digest());
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function hashHwid(hwid) {
  return crypto.createHash('sha256').update(String(hwid).trim().toLowerCase()).digest('hex');
}

function issueRealtimeTicket({ jti, hwidHash, scriptName, now = Date.now() }) {
  if (!/^[a-f0-9]{24}$/.test(String(jti))) throw new Error('invalid jti');
  if (!/^[a-f0-9]{64}$/.test(String(hwidHash))) throw new Error('invalid hwid hash');
  if (typeof scriptName !== 'string' || !/^[\w-]{1,64}$/.test(scriptName)) throw new Error('invalid script name');
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const iat = Math.floor(now / 1000);
  const body = b64url(JSON.stringify({ scope: 'realtime', jti, hwidHash, scriptName, iat, exp: iat + TTL_SECONDS }));
  return `${header}.${body}.${sign(`${header}.${body}`)}`;
}

function verifyRealtimeTicket(token, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  if (!safeEqual(signature, sign(`${header}.${body}`))) return null;
  let claims;
  try { claims = JSON.parse(decodeB64url(body).toString('utf8')); }
  catch { return null; }
  const current = Math.floor(now / 1000);
  if (!claims || claims.scope !== 'realtime' || !/^[a-f0-9]{24}$/.test(String(claims.jti))
    || !/^[a-f0-9]{64}$/.test(String(claims.hwidHash))
    || typeof claims.scriptName !== 'string' || !/^[\w-]{1,64}$/.test(claims.scriptName)
    || !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp)
    || claims.iat > current + 60 || claims.exp <= current || claims.exp - claims.iat > TTL_SECONDS) return null;
  return claims;
}

module.exports = { TTL_SECONDS, hashHwid, issueRealtimeTicket, verifyRealtimeTicket };
