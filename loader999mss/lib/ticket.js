const crypto = require('node:crypto');

const TICKET_TTL = 30 * 60;

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}
function tsecret() {
  const v = process.env.TICKET_SECRET;
  if (!v || v.length < 32) throw new Error('TICKET_SECRET must be >=32 chars');
  return v;
}
function sign(data) {
  return b64url(crypto.createHmac('sha256', tsecret()).update(data).digest());
}

function issueTicket(payload) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const body = b64url(JSON.stringify({
    ...payload, iat: now, exp: now + TICKET_TTL,
    jti: crypto.randomBytes(12).toString('hex'),
  }));
  return `${header}.${body}.${sign(`${header}.${body}`)}`;
}

function verifyTicket(token) {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = sign(`${header}.${body}`);
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let payload;
  try { payload = JSON.parse(b64urlDecode(body).toString('utf8')); }
  catch { return null; }
  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now) return null;
  if (!payload.iat || payload.iat > now + 60) return null;
  return payload;
}

const hashHwid = (hwid) =>
  crypto.createHash('sha256').update(String(hwid).trim().toLowerCase()).digest('hex');

module.exports = { issueTicket, verifyTicket, hashHwid };
