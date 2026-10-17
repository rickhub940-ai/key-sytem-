'use strict';

// Loader-link system.
//
// A link is `https://HOST/x/<40 hex random>?at=<exp>.<sig>`: the namespace and
// the token are random long values (the somtank-style `/x/<40 hex>` shape), and
// nothing about them can be guessed from another link. The token is stateless
// (HMAC), so a link works across Vercel instances and needs no database.
//
// `/x/<path>` serves a small, fully deterministic entry script; because the
// bytes depend only on the link, the generated stub can pin `sha256` of them
// exactly like the reference loader does with its `d` constant.

const crypto = require('node:crypto');

const PATH_HEX = 40;
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

function linkSecret() {
  const value = process.env.LINK_SECRET || process.env.TICKET_SECRET;
  if (typeof value !== 'string' || value.length < 32) return null;
  return value;
}

function b64url(buffer) {
  return Buffer.from(buffer).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(value) {
  const secret = linkSecret();
  if (!secret) return null;
  return b64url(crypto.createHmac('sha256', secret).update(value).digest()).slice(0, 32);
}

function isLinkPath(value) {
  return typeof value === 'string' && new RegExp(`^[a-f0-9]{${PATH_HEX}}$`).test(value);
}

function randomLinkPath() {
  return crypto.randomBytes(PATH_HEX / 2).toString('hex');
}

// Short, human-friendly id shown in the panel (derived from the path).
function linkId(linkPath) {
  return Buffer.from(linkPath, 'hex').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 22);
}

function normalizeScriptName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!/^[\w-]{1,64}$/.test(name)) return null;
  return name;
}

// The token binds only the path and expiry: script selection still happens
// through getgenv().script, so one link serves the whole chain.
function issuePathToken({ path: linkPath, expiresAt }) {
  const exp = Math.floor(Number(expiresAt) / 1000);
  if (!isLinkPath(linkPath) || !Number.isFinite(exp)) return null;
  const sig = sign(`link|${linkPath}|${exp}`);
  if (!sig) return null;
  return `${exp.toString(36)}.${sig}`;
}

function verifyPathToken(token, linkPath) {
  if (typeof token !== 'string' || token.length > 128) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const exp = Number.parseInt(parts[0], 36);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return null;
  const expected = sign(`link|${linkPath}|${exp}`);
  if (!expected) return null;
  const supplied = Buffer.from(parts[1], 'utf8');
  const want = Buffer.from(expected, 'utf8');
  if (supplied.length !== want.length || !crypto.timingSafeEqual(supplied, want)) return null;
  return { expiresAt: exp * 1000, path: linkPath };
}

// Deterministic entry script: same link ⇒ same bytes, so the stub's sha256 pin
// always matches. It only hands over to the regular Stage-1 loader.
function renderEntryBody({ baseUrl, path: linkPath, token }) {
  const url = `${baseUrl}/x/${linkPath}?at=${token}`;
  return [
    '-- 999MS link entry (readable).',
    '-- Generated for one link only: the namespace and token are random, and the',
    '-- body is deterministic so the launcher can verify its sha256 before running.',
    `local LINK_URL = ${JSON.stringify(url)}`,
    '',
    'if not game:IsLoaded() then game.Loaded:Wait() end',
    '',
    'local BASE_URL = LINK_URL:match("^(https://[^/]+)")',
    'if type(BASE_URL) ~= "string" then',
    '    return warn("[999MS] Link malformed")',
    'end',
    '',
    '-- Hand over to Stage 1 on the same host; the chain is unchanged from there.',
    'local body = game:HttpGet(BASE_URL .. "/loadc.lua")',
    'local chunk, err = loadstring(body)',
    'if not chunk then',
    '    return warn("[999MS] Link entry failed: " .. tostring(err))',
    'end',
    'return chunk()',
    '',
  ].join('\n');
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// The launcher the user pastes into the executor, in the same shape as the
// reference loader: a short table of constants, the URL, the hash, then a
// verified loadstring.
function renderStub({ baseUrl, path: linkPath, token, sha256: digest, scriptName, expiresAt }) {
  const url = `${baseUrl}/x/${linkPath}?at=${token}`;
  const shortId = linkId(linkPath);
  const table = JSON.stringify([baseUrl, `/x/${linkPath}`, token, shortId, scriptName, true]);
  return [
    `-- 999MS loader link • ${scriptName} • expires ${new Date(expiresAt).toISOString()}`,
    `local c=${table}`,
    `local u=${JSON.stringify(url)}`,
    `local d=${JSON.stringify(digest)}`,
    '',
    'if not game:IsLoaded() then game.Loaded:Wait() end',
    '',
    'local body = game:HttpGet(u)',
    'if type(body) ~= "string" or #body == 0 then',
    '    return warn("[999MS] Link fetch failed")',
    'end',
    '',
    '-- Hash check when the executor exposes a sha256 helper; otherwise the chain',
    '-- still verifies its own stages server-side.',
    'local function sha256Hex(s)',
    '    local crypt = (syn and syn.crypt and syn.crypt.hash) or (crypt and crypt.hash)',
    '    if type(crypt) ~= "function" then return nil end',
    '    local ok, v = pcall(crypt, s, "sha256")',
    '    if not ok or type(v) ~= "string" then return nil end',
    '    return string.lower((v:gsub("%s", "")))',
    'end',
    '',
    'local got = sha256Hex(body)',
    'if got and got ~= d then',
    '    return warn("[999MS] Link integrity check failed")',
    'end',
    '',
    'local chunk, err = loadstring(body)',
    'if not chunk then',
    '    return warn("[999MS] Link load failed: " .. tostring(err))',
    'end',
    'return chunk()',
    '',
  ].join('\n');
}

module.exports = {
  PATH_HEX,
  DEFAULT_TTL_SECONDS,
  isLinkPath,
  randomLinkPath,
  linkId,
  normalizeScriptName,
  issuePathToken,
  verifyPathToken,
  renderEntryBody,
  renderStub,
  sha256,
};
