const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { verifyKey, createLink } = require('../lib/platoboost');
const { issueTicket, verifyTicket, hashHwid } = require('../lib/ticket');
const link = require('../lib/link');
const {
  createChallengeResponse,
  validateClientChallenge,
  isValidScriptName,
  encodeProtectedPayload,
  decodeProtectedPayload,
  deriveRuntimeCredentials,
  verifyRuntimeProof,
} = require('../lib/999MS-server-sdk');
const {
  revokeHwid, revokeHwidHash, revokeUser, revokeIp, checkRevoked, stats, listRevocations,
} = require('../lib/revoke');

const sessions = new Map();
const SESSION_TTL = 30 * 60 * 1000;
const RUNTIME_TTL = 60 * 1000;
const LOADA_PATH_TTL = 20 * 1000;
const ARTIFACT_FILES = Object.freeze({
  loadc: 'loadc.lua',
  loada: 'loada.lua',
  loader: 'loader.lua',
  payload: 'payload.lua',
  sdk: '999MS-sdk.lua',
});
const STAGE_TWO_RAW_SHA256 = '53018577827a3f04b68dfc7fb139e2b07c73d6f3849763a3510ee903af63e076';
// Capability redemption is additionally tracked for the lifetime of a warm
// function. The signed capability is the cross-instance authority; the map
// closes accidental/replayed fetches that return to the same instance.
const redeemedStageCapabilities = new Map();


// ═══ Rate limit ═══
const rateLimit = new Map();
const RATE_WINDOW = 60 * 1000;
const RATE_MAX = 15;

function checkRateLimit(ip) {
  if (!ip) return true;
  const now = Date.now();
  const entry = rateLimit.get(ip) || { count: 0, reset: now + RATE_WINDOW };
  if (now > entry.reset) {
    entry.count = 0;
    entry.reset = now + RATE_WINDOW;
  }
  entry.count++;
  rateLimit.set(ip, entry);
  return entry.count <= RATE_MAX;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimit.entries()) {
    if (now > entry.reset) rateLimit.delete(ip);
  }
}, 5 * 60 * 1000).unref?.();

// ═══ Trap redirect ═══
const TRAP_URL = 'https://yura.lol/09ms';

function trapRedirect(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Location', TRAP_URL);
  return res.status(302).send('');
}

// Roblox-marked requests never receive the browser redirect. Invalid paths or
// methods still fail closed, but with a normal empty HTTP error instead.
function rejectOrTrap(req, res, status = 404) {
  if (hasRobloxHeader(req)) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(status).send('');
  }
  return trapRedirect(res);
}

// ═══ Request classification ═══
// Roblox executor/game requests are allowed through the browser-trap gate when
// any header name or value contains "roblox", regardless of letter casing.
function hasRobloxHeader(req) {
  for (const [name, value] of Object.entries(req.headers || {})) {
    if (`${name}:${Array.isArray(value) ? value.join(',') : value || ''}`.toLowerCase().includes('roblox')) {
      return true;
    }
  }
  return false;
}

// Prefer the host the executor actually reached so a preview deployment or a
// renamed project can never point the chain at a host that does not exist.
// PUBLIC_BASE_URL stays as the fallback for local runs.
function requestOrigin(req) {
  const host = String(
    (req && req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || '',
  ).split(',')[0].trim();
  if (!host || !/^[a-zA-Z0-9.:-]+$/.test(host)) return publicBaseUrl();
  const proto = String((req.headers['x-forwarded-proto'] || 'https')).split(',')[0].trim();
  return `${proto === 'http' ? 'http' : 'https'}://${host}`;
}

function publicBaseUrl() {
  const value = process.env.PUBLIC_BASE_URL;
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

// LOADA_PATH_SECRET is optional when the already-required TICKET_SECRET is
// present. The sole Stage-1 capability is stateless, so its Stage-2 fetch can
// land on a different Vercel instance without a database.
function timingSafeStringEquals(supplied, expectedValue) {
  if (typeof supplied !== 'string' || typeof expectedValue !== 'string') return false;
  const expected = Buffer.from(expectedValue, 'utf8');
  const candidate = Buffer.from(supplied, 'utf8');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function hasAdminAccess(req) {
  const expected = process.env.ADMIN_TOKEN;
  return typeof expected === 'string' && expected.length >= 32
    && timingSafeStringEquals(req.headers['x-admin-token'], expected);
}

// The save-detector marker used to be the literal "-- supper_Boom". It is now a
// long random-looking value derived from a server secret: stable across
// requests and instances (so a file saved in one session is still caught in the
// next), but impossible to guess from the served script alone.
let cachedChainMarker = null;
function chainMarker() {
  if (cachedChainMarker) return cachedChainMarker;
  const secret = process.env.LINK_SECRET || process.env.TICKET_SECRET;
  if (typeof secret !== 'string' || secret.length < 32) return null;
  const digest = crypto.createHmac('sha256', secret).update('999MS chain marker v1').digest('hex');
  cachedChainMarker = 'MS9MARK_' + digest;
  return cachedChainMarker;
}

// Applied to every served stage, right before the Stage-2 hash is computed, so
// the pinned hash always covers exactly the bytes the executor receives.
function applyChainTokens(body, baseUrl) {
  if (typeof body !== 'string') return body;
  let out = body;
  if (baseUrl && out.includes('@BASE_URL@')) out = out.replaceAll('@BASE_URL@', baseUrl);
  if (out.includes('__CHAIN_MARKER__')) {
    const marker = chainMarker();
    if (!marker) return null;
    out = out.replaceAll('__CHAIN_MARKER__', marker);
  }
  return out;
}

function loadaPathSecret() {
  const secret = process.env.LOADA_PATH_SECRET || process.env.TICKET_SECRET;
  return typeof secret === 'string' && secret.length >= 32 ? secret : null;
}

function capabilityTimestamp(d) {
  return Number.parseInt(d.slice(0, 12), 16);
}

function isFreshCapabilityId(d) {
  if (typeof d !== 'string' || !/^[a-f0-9]{64}$/.test(d)) return false;
  const issuedAt = capabilityTimestamp(d);
  const now = Date.now();
  return Number.isSafeInteger(issuedAt) && issuedAt <= now + 5000 &&
    now - issuedAt <= LOADA_PATH_TTL;
}

function signStagePath(stage, d, secret) {
  return crypto.createHmac('sha256', secret).update(`999MS-stage-v2:${stage}:${d}`).digest('hex');
}

function createLoadaPathCapability() {
  const secret = loadaPathSecret();
  if (!secret) return null;
  // Root Stage-2 id: current milliseconds plus 26 random bytes. It is minted
  // into each generated loadc response and is the only chain path capability.
  const d = Date.now().toString(16).padStart(12, '0') + crypto.randomBytes(26).toString('hex');
  return { stage: 'loada', d, n: signStagePath('loada', d, secret) };
}

function readStageCapability(req, url, stage) {
  const d = req.query?.d || url.searchParams.get('d');
  const n = req.query?.n || url.searchParams.get('n');
  const secret = loadaPathSecret();
  if (!isFreshCapabilityId(d) || typeof n !== 'string' || !/^[a-f0-9]{64}$/.test(n) || !secret) return null;
  if (!timingSafeStringEquals(n, signStagePath(stage, d, secret))) return null;
  return { stage, d, n };
}

function consumeStageCapability(capability) {
  const now = Date.now();
  for (const [key, expiresAt] of redeemedStageCapabilities) {
    if (expiresAt < now) redeemedStageCapabilities.delete(key);
  }
  const key = `${capability.stage}:${capability.d}`;
  if (redeemedStageCapabilities.has(key)) return false;
  redeemedStageCapabilities.set(key, capabilityTimestamp(capability.d) + LOADA_PATH_TTL);
  return true;
}

// Browser trapping is cosmetic anti-scraping, never authorization. Mobile
// executors (Delta, Fluxus, …) look like Chrome, so trapping artifacts on UA
// used to break the loader's own /loader.lua fetch. Opt in with
// TRAP_BROWSER_ARTIFACTS=1 to restore the old behaviour.
function trapBrowserArtifacts() {
  return process.env.TRAP_BROWSER_ARTIFACTS === '1';
}

function isBrowserRequest(req) {
  const headers = req.headers || {};
  if (hasRobloxHeader(req)) return false;
  const ua = (headers['user-agent'] || '').toLowerCase();

  if (/mozilla|chrome|safari|firefox|edge|opera|msie|trident/i.test(ua)) return true;
  if (/discordbot|telegrambot|twitterbot|facebookexternalhit|slackbot/i.test(ua)) return true;

  if (headers['origin'] || headers['referer']) return true;
  if (headers['accept-language']) return true;
  for (const k of Object.keys(headers)) {
    if (k.startsWith('sec-')) return true;
  }

  return false;
}

// ═══ Main handler ═══
const CONTROL_ACTIONS = new Set(['control-bans', 'control-traffic']);
// Ring buffer of the last 200 requests (no bodies, keys, HWIDs or tickets) so
// the panel can show what an executor actually fetched and which status it got.
const trafficLog = [];
const TRAFFIC_MAX = 200;

// ═══ /api/link (admin) ═══
// Creates one random, expiring loader link: /x/<40 hex>?at=<token>.
async function handleLinkCreate(req, res) {
  if (!hasAdminAccess(req)) return res.status(401).json({ ok: false, reason: 'unauthorized' });

  const body = req.body || {};
  const scriptName = link.normalizeScriptName(body.scriptName) || 'main';
  const hours = Math.min(Math.max(Number(body.hours) || 168, 1), 24 * 365);
  const origin = requestOrigin(req) || publicBaseUrl();
  if (!origin) return res.status(503).json({ ok: false, reason: 'origin unavailable' });

  const linkPath = link.randomLinkPath();
  const expiresAt = Date.now() + hours * 60 * 60 * 1000;
  const token = link.issuePathToken({ path: linkPath, expiresAt });
  if (!token) return res.status(503).json({ ok: false, reason: 'LINK_SECRET/TICKET_SECRET missing' });

  const entry = link.renderEntryBody({ baseUrl: origin, path: linkPath, token });
  const digest = link.sha256(entry);
  const url = `${origin}/x/${linkPath}?at=${token}`;

  return res.status(200).json({
    ok: true,
    id: link.linkId(linkPath),
    path: `/x/${linkPath}`,
    url,
    line: `loadstring(game:HttpGet("${url}"))()`,
    sha256: digest,
    scriptName,
    expiresAt,
    stub: link.renderStub({ baseUrl: origin, path: linkPath, token, sha256: digest, scriptName, expiresAt }),
  });
}

// ═══ /x/<40 hex> ═══
// Serves the deterministic entry script for a link, then the normal chain.
async function handleLinkServe(req, res, url) {
  const linkPath = req.query?.p || url.searchParams.get('p') || '';
  const token = url.searchParams.get('at') || req.query?.at || '';
  if (!link.isLinkPath(linkPath)) return rejectOrTrap(req, res);
  const claim = link.verifyPathToken(token, linkPath);
  if (!claim) return rejectOrTrap(req, res);
  const origin = requestOrigin(req) || publicBaseUrl();
  if (!origin) return res.status(503).send('');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(link.renderEntryBody({ baseUrl: origin, path: linkPath, token }));
}

module.exports = async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const action = req.query?.action || url.searchParams.get('action');

  const trace = {
    ts: Date.now(),
    method: req.method,
    path: url.pathname,
    action: action || null,
    name: req.query?.name || url.searchParams.get('name') || null,
    host: String(req.headers['x-forwarded-host'] || req.headers.host || ''),
    ua: String(req.headers['user-agent'] || '').slice(0, 80),
    status: 0,
    ms: 0,
  };
  trafficLog.push(trace);
  if (trafficLog.length > TRAFFIC_MAX) trafficLog.shift();
  const finish = (code) => { trace.status = trace.status || code; trace.ms = Date.now() - trace.ts; };
  const rawStatus = res.status.bind(res);
  res.status = (code) => { finish(code); return rawStatus(code); };
  for (const methodName of ['send', 'json', 'end']) {
    if (typeof res[methodName] === 'function') {
      const raw = res[methodName].bind(res);
      res[methodName] = (...args) => { finish(200); return raw(...args); };
    }
  }

  // Payload remains the static final handoff from the legacy stage chain.
  if (action === 'payload') {
    if (req.method !== 'GET') return rejectOrTrap(req, res, 405);
    if (trapBrowserArtifacts() && isBrowserRequest(req)) return trapRedirect(res);
    try {
      let body = readArtifact('payload');
      if (typeof body !== 'string') return res.status(404).send('Not Found');
      body = applyChainTokens(body, requestOrigin(req));
      if (!body) return res.status(404).send('Not Found');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).send(body);
    } catch (error) {
      console.error('[payload]', error.message);
      return res.status(404).send('Not Found');
    }
  }

  // loadc is generated per request and is the only stage that mints a path
  // capability. The remaining legacy artifacts keep their static handoffs.
  if (action === 'artifact') {
    if (req.method !== 'GET') return rejectOrTrap(req, res, 405);
    if (trapBrowserArtifacts() && isBrowserRequest(req)) return trapRedirect(res);
    const name = req.query?.name || url.searchParams.get('name');
    return await serveArtifact(req, res, name, url, requestOrigin(req));
  }

  // Public, credential-free health probe for the landing page.
  if (action === 'health') {
    if (req.method !== 'GET') return res.status(405).json({ ok: false });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).json({
      ok: true,
      service: '999MS',
      version: '3.0.0',
      chain: '999MS-chain-v1',
      ts: Date.now(),
    });
  }

  // ═══ Control panel (browser-facing, ADMIN_TOKEN gated) ═══
  if (CONTROL_ACTIONS.has(action)) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.method !== 'POST') return res.status(405).json({ ok: false, reason: 'method' });
    if (!hasAdminAccess(req)) return res.status(401).json({ ok: false, reason: 'unauthorized' });

    if (action === 'control-traffic') {
      const limit = Math.min(Number(req.body && req.body.limit) || 100, TRAFFIC_MAX);
      return res.status(200).json({ ok: true, count: trafficLog.length, traffic: trafficLog.slice(-limit).reverse() });
    }

    // control-bans
    return res.status(200).json({
      ok: true,
      stats: stats(),
      lists: listRevocations(),
      scope: 'instance',
      note: 'In-memory revocations apply to this function instance; env REVOKED_* entries apply everywhere.',
    });
  }

  // Link system: /x/<40 hex>?at=<token> serves the entry script and
  // /api/link (admin) mints a new random link.
  if (action === 'link-serve') {
    if (req.method !== 'GET') return rejectOrTrap(req, res, 405);
    return await handleLinkServe(req, res, url);
  }

  if (action === 'link-create') {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.method !== 'POST') return res.status(405).json({ ok: false, reason: 'method' });
    if (trapBrowserArtifacts() && isBrowserRequest(req)) return trapRedirect(res);
    return await handleLinkCreate(req, res);
  }

  if (action === 'trap') return rejectOrTrap(req, res);



  // ═══ อื่นๆ: ต้อง POST ═══
  if (req.method !== 'POST') return rejectOrTrap(req, res, 405);
  if (trapBrowserArtifacts() && isBrowserRequest(req)) return trapRedirect(res);

  const ct = req.headers['content-type'] || '';
  if (!ct.includes('application/json')) return rejectOrTrap(req, res, 415);

  const validActions = ['verify', 'script', 'script-verify', 'heartbeat', 'start', 'admin-ban'];
  if (!action || !validActions.includes(action)) return rejectOrTrap(req, res);

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
             req.socket?.remoteAddress || '';

  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Rate limited' });
  }

  try {
    switch (action) {
      case 'verify':         return await handleVerify(req, res, ip);
      case 'script':         return await handleScript(req, res, ip);
      case 'script-verify':  return await handleScriptVerify(req, res);
      case 'heartbeat':      return await handleHeartbeat(req, res, ip);
      case 'start':          return await handleStart(req, res, ip);
      case 'admin-ban':      return await handleAdminBan(req, res);
      default:
        return trapRedirect(res);
    }
  } catch (err) {
    console.error('[auth]', action, err.message);
    return res.status(502).json({ error: 'Service unavailable' });
  }
};

function readArtifact(name) {
  const filename = ARTIFACT_FILES[name];
  if (!filename) return null;
  const body = fs.readFileSync(path.join(process.cwd(), 'artifacts', filename), 'utf8');
  if (name === 'loada' && crypto.createHash('sha256').update(body).digest('hex') !== STAGE_TWO_RAW_SHA256) {
    throw new Error('Stage-2 raw artifact integrity check failed');
  }
  return body;
}

// Roblox exposes a non-string `script` object in many executor environments.
// The legacy Stage-3 loader treated that object as a user script selection and
// kicked before its normal flow. Normalize only missing/invalid values; a
// valid caller-provided script name remains untouched.
const LOADER_SCRIPT_NORMALIZER = 'local e=getgenv();local s=e.script;if type(s)~="string"or#s<1 or#s>64 or not s:match("^[%w_%-]+$")then e.script="main"end;';

function renderLoaderArtifact() {
  return `${LOADER_SCRIPT_NORMALIZER}${readArtifact('loader')}`;
}

async function serveArtifact(req, res, name, url, origin) {
  if (name === 'loadc') {
    const body = renderLoadcArtifact(origin);
    if (!body) return res.status(503).send('');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(body);
  }
  if (name === 'loada') {
    const capability = readStageCapability(req, url, 'loada');
    if (!capability || !consumeStageCapability(capability)) return rejectOrTrap(req, res);
  } else if (name !== 'loader' && name !== 'sdk') {
    return rejectOrTrap(req, res);
  }
  try {
    let body = name === 'loader' ? renderLoaderArtifact() : readArtifact(name);
    if (typeof body !== 'string') return res.status(503).send('');
    // Readable stages carry @BASE_URL@ (host) and __CHAIN_MARKER__ (save
    // detector) so neither a host nor the marker is ever hard-coded.
    body = applyChainTokens(body, origin || '');
    if (!body) return res.status(503).send('');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(body);
  } catch (error) {
    console.error('[artifact]', error.message);
    return res.status(404).send('Not Found');
  }
}

// ═══ Dynamic Stage-1 renderer ═══
// /loadc.lua is rendered from the readable template in artifacts/loadc.lua.
// No obfuscator is involved: the source served to the executor stays plain Lua
// that anyone can audit line by line.
function renderLoadcArtifact(origin) {
  const baseUrl = origin || publicBaseUrl();
  if (!baseUrl) return null;
  const capability = createLoadaPathCapability();
  if (!capability) return null;
  const stagedRaw = readArtifact('loada');
  if (!stagedRaw) return null;
  // Stage 1 pins exactly the bytes Stage 2 will receive, with the host already
  // resolved for this request.
  const stagedSource = applyChainTokens(stagedRaw, baseUrl);
  if (!stagedSource) return null;
  const stagedSha256 = crypto.createHash('sha256').update(stagedSource).digest('hex');
  return fs.readFileSync(path.join(process.cwd(), 'artifacts', 'loadc.lua'), 'utf8')
    .replaceAll('__CHAIN_ID__', crypto.randomBytes(32).toString('hex'))
    .replaceAll('__CAP_D__', capability.d)
    .replaceAll('__CAP_N__', capability.n)
    .replaceAll('__STAGE2_SHA256__', stagedSha256)
    .replaceAll('__BASE_URL__', baseUrl);
}

// ═══ /api/verify ═══
async function handleVerify(req, res, ip) {
  const xorKey = process.env.PAYLOAD_XOR_KEY || '';
  const { key, hwid, userId, scriptName } = req.body || {};
  // First request challenge: reject a simple forged `{ valid: true }` response
  // before issuing a signed ticket. The provider still owns key/device binding.
  // The deployed payload sends its RNG challenge with /api/script (where it is
  // verified against the decrypted `Data` envelope), so this gate only applies
  // when the caller actually supplied RNG fields. Requiring them here made real
  // clients fail with "RNG integers rejected" before their key was ever checked.
  const challengeFields = ['Rng1', 'Rng2', 'Rng3', 'Rng4', 'Rng5', 'RngFloat'];
  const challengeSupplied = challengeFields.some((field) => req.body?.[field] !== undefined);
  const clientChallenge = validateClientChallenge(req.body);

  if (typeof key !== 'string' || !key.trim())
    return res.status(400).json({ valid: false, error: 'key required' });
  if (typeof hwid !== 'string' || hwid.length < 4 || hwid.length > 512)
    return res.status(400).json({ valid: false, error: 'invalid hwid format' });
  if (typeof scriptName !== 'string' || scriptName.length < 1 || scriptName.length > 64)
    return res.status(400).json({ valid: false, error: 'scriptName required' });
  if (!isValidScriptName(scriptName))
    return res.status(400).json({ valid: false, error: 'invalid scriptName format' });
  if (challengeSupplied && !clientChallenge.ok)
    return res.status(400).json({ valid: false, error: clientChallenge.reason });

  const reason = checkRevoked({ hwid, userId, ip });
  if (reason)
    return res.status(403).json({ valid: false, message: 'Banned: ' + reason });

  const result = await verifyKey(key, hwid);
  if (!result.valid) {
    return res.status(result.rateLimited ? 429 : 200).json({
      valid: false,
      message: result.message || 'Invalid key',
    });
  }

  const ticket = issueTicket({
    hwidHash: hashHwid(hwid),
    scope: 'script',
    userId: userId || null,
    scriptName,
  });

  const response = { valid: true, ticket, k: xorKey };
  if (clientChallenge.ok) response.check = createChallengeResponse(clientChallenge.values);
  return res.status(200).json(response);
}

// ═══ /api/script ═══
async function handleScript(req, res, ip) {
  const xorKey = process.env.PAYLOAD_XOR_KEY || '';
  const { ticket, Data, scriptName } = req.body || {};

  if (typeof ticket !== 'string' || ticket.length > 4096)
    return res.status(400).json({ Valid: false, reason: 'ticket required' });

  const payload = verifyTicket(ticket);
  if (!payload) return res.status(401).json({ Valid: false, reason: 'invalid ticket' });
  if (payload.scope !== 'script')
    return res.status(403).json({ Valid: false, reason: 'scope' });

  const reason = checkRevoked({ userId: payload.userId, ip });
  if (reason)
    return res.status(403).json({ Valid: false, reason: 'Banned: ' + reason });

  const name = (typeof scriptName === 'string' && scriptName.length > 0)
    ? scriptName
    : payload.scriptName;

  if (!name) return res.status(400).json({ Valid: false, reason: 'no scriptName' });
  if (name !== payload.scriptName)
    return res.status(403).json({ Valid: false, reason: 'scriptName mismatch' });

  if (!isValidScriptName(name))
    return res.status(200).json(encodeProtectedPayload({ Valid: false, reason: 'Invalid script name' }, xorKey));

  let clientData = null;
  if (Data) {
    const decoded = decodeProtectedPayload({ Data }, xorKey);
    if (decoded.ok) clientData = decoded.data;
  }

  // This is a tamper signal only; server-issued tickets remain the
  // authorization boundary.
  const rngChallenge = validateClientChallenge(clientData);
  if (!rngChallenge.ok) {
    return res.status(200).json(encodeProtectedPayload({
      Valid: false, reason: 'RNG challenge rejected',
    }, xorKey));
  }

  // Keep the response fields compatible with the existing obfuscated stages,
  // while making the proof verifiable by any Vercel instance (no in-memory
  // affinity is required between /api/script and /api/script-verify).
  const { scriptToken, runtimeSecret } = deriveRuntimeCredentials({
    ticketPayload: payload,
    scriptName: name,
  });

  sessions.set(payload.jti, {
    createdAt: Date.now(),
    scriptIssuedAt: Date.now(),
    lastBeat: Date.now(),
    failCount: 0,
    hwidHash: payload.hwidHash,
    userId: payload.userId || null,
    scriptToken,
    runtimeSecret,
    scriptName: name,
    verified: false,
  });

  let scriptBody;
  try {
    const p = path.join(process.cwd(), 'scripts', name + '.lua');
    scriptBody = fs.readFileSync(p, 'utf8');
  } catch {
    return res.status(200).json(encodeProtectedPayload({ Valid: false, reason: 'Script not found: ' + name }, xorKey));
  }

  // main.lua remains readable/server-templated for this runtime build.
  scriptBody = scriptBody
    .replace(/\$\{SERVERID\}/g, payload.jti)
    .replace(/\$\{SCRIPTID\}/g, name)
    .replace(/\$\{HWIDHASH\}/g, payload.hwidHash)
    .replace(/\$\{ISSUED\}/g, new Date().toISOString());

  const check = createChallengeResponse(rngChallenge.values);

  return res.status(200).json(encodeProtectedPayload({
    Valid: true,
    check,
    Body: scriptBody,
    ServerId: payload.jti,
    ScriptId: name,
    ScriptToken: scriptToken,
    RuntimeSecret: runtimeSecret,
  }, xorKey));
}

// ═══ /api/script-verify ═══
// The on-screen client reference stays opaque. This server-side category is
// intentionally credential-free, so it can be safely correlated in Vercel logs
// without recording keys, tickets, HWIDs, tokens, or runtime secrets.
function diagnosticReference(category) {
  const text = `[999MS] ${category}`;
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 33 + text.charCodeAt(index) + index + 1) % 2147483647;
  }
  return `MS9-${hash.toString(16).toUpperCase().padStart(8, '0')}`;
}

function rejectRuntimeVerification(res, status, category) {
  console.warn(`[script-verify] category=${category} reference=${diagnosticReference(category)}`);
  return res.status(status).json({ valid: false, diagnostic: category });
}

async function handleScriptVerify(req, res) {
  const { ticket, hwid, scriptToken, runtimeSecret, scriptName } = req.body || {};

  if (typeof ticket !== 'string' || ticket.length > 4096) {
    return rejectRuntimeVerification(res, 400, 'D2_TICKET_MISSING');
  }

  const payload = verifyTicket(ticket);
  if (!payload) return rejectRuntimeVerification(res, 401, 'D2_TICKET_INVALID');
  if (payload.scope !== 'script') return rejectRuntimeVerification(res, 403, 'D2_TICKET_SCOPE');

  const banReason = checkRevoked({ userId: payload.userId });
  if (banReason) return rejectRuntimeVerification(res, 403, 'D2_REVOKED');

  if (typeof runtimeSecret !== 'string' || runtimeSecret.length !== 64) {
    return rejectRuntimeVerification(res, 403, 'D2_SECRET_FORMAT');
  }
  if (typeof hwid !== 'string' || hwid.length < 4 || hwid.length > 512) {
    return rejectRuntimeVerification(res, 403, 'D2_HWID_FORMAT');
  }

  const proofFailure = verifyRuntimeProof({
    ticketPayload: payload,
    runtimeSecret,
    scriptToken,
    hwidHash: hashHwid(hwid),
    scriptName,
    runtimeTtl: RUNTIME_TTL,
  });
  if (proofFailure) {
    const categories = {
      'ticket claims invalid': 'D2_TICKET_CLAIMS',
      'scriptName changed': 'D2_SCRIPT_MISMATCH',
      'hwid mismatch': 'D2_HWID_MISMATCH',
      'token malformed': 'D2_TOKEN_FORMAT',
      'runtime expired': 'D2_RUNTIME_EXPIRED',
      'token mismatch': 'D2_TOKEN_MISMATCH',
      'secret mismatch': 'D2_SECRET_MISMATCH',
    };
    return rejectRuntimeVerification(res, 403, categories[proofFailure] || 'D2_PROOF_REJECTED');
  }

  // This in-memory entry is only used by the optional heartbeat UX. It is no
  // longer an authorization dependency, so a new Vercel instance cannot turn
  // a valid proof into a false "session not found" failure.
  const session = sessions.get(payload.jti);
  if (session) {
    session.verified = true;
    session.verifiedAt = Date.now();
  }

  return res.status(200).json({ valid: true, serverId: payload.jti, diagnostic: 'D2_OK' });
}

// ═══ /api/heartbeat ═══
async function handleHeartbeat(req, res, ip) {
  const xorKey = process.env.PAYLOAD_XOR_KEY || '';
  const { ticket, Data } = req.body || {};

  if (typeof ticket !== 'string' || ticket.length > 4096)
    return res.status(400).json({ kick: null });

  const payload = verifyTicket(ticket);
  if (!payload) return res.status(401).json({ kick: 'Session expired' });

  const reason = checkRevoked({ userId: payload.userId, ip });
  if (reason) {
    sessions.delete(payload.jti);
    return res.status(200).json({ kick: 'Banned: ' + reason });
  }

  const session = sessions.get(payload.jti);
  if (!session)
    return res.status(200).json(encodeProtectedPayload({ Valid: true, commands: [] }, xorKey));

  session.lastBeat = Date.now();

  if (Data) {
    const decoded = decodeProtectedPayload({ Data }, xorKey);
    if (!decoded.ok) {
      session.failCount += 1;
    } else {
      session.failCount = 0;
      const sentName = decoded.data?.scriptName;
      if (typeof sentName !== 'string' || sentName !== session.scriptName) {
        sessions.delete(payload.jti);
        return res.status(200).json({ kick: 'Script name changed' });
      }
    }
  }

  if (session.failCount > 12) {
    sessions.delete(payload.jti);
    return res.status(200).json({ kick: 'Tamper detected' });
  }

  if (Date.now() - session.createdAt > SESSION_TTL) {
    sessions.delete(payload.jti);
    return res.status(200).json({ kick: 'Session expired' });
  }

  return res.status(200).json(encodeProtectedPayload({
    Valid: true, commands: [], t: Date.now(),
  }, xorKey));
}

function verifiedScriptContext(ticket, hwid, scriptName, ip) {
  if (typeof ticket !== 'string' || ticket.length > 4096) return { error: 'ticket required', status: 400 };
  if (typeof hwid !== 'string' || hwid.length < 4 || hwid.length > 512) return { error: 'invalid hwid format', status: 400 };
  const payload = verifyTicket(ticket);
  if (!payload || payload.scope !== 'script') return { error: 'invalid ticket', status: 401 };
  if (!timingSafeStringEquals(payload.hwidHash, hashHwid(hwid))) return { error: 'hwid mismatch', status: 403 };
  const name = typeof scriptName === 'string' && scriptName.length ? scriptName : payload.scriptName;
  if (!isValidScriptName(name) || name !== payload.scriptName) return { error: 'scriptName mismatch', status: 403 };
  const reason = checkRevoked({ hwid, userId: payload.userId, ip });
  if (reason) return { error: 'Banned: ' + reason, status: 403 };
  return { payload, name, hwidHash: hashHwid(hwid) };
}

async function handleStart(req, res, ip) {
  const { hwid } = req.body || {};

  if (typeof hwid !== 'string' || hwid.length < 4 || hwid.length > 512)
    return res.status(400).json({ error: 'invalid hwid' });

  if (!checkRateLimit(ip))
    return res.status(429).json({ error: 'Rate limited' });

  const reason = checkRevoked({ hwid, ip });
  if (reason)
    return res.status(403).json({ error: 'Banned: ' + reason });

  try {
    const result = await createLink(hwid);
    return res.status(result.rateLimited ? 429 : 200).json(result);
  } catch (err) {
    console.error('[start]', err.message);
    return res.status(502).json({ error: 'Could not create link' });
  }
}

// ═══ /api/admin/ban ═══
async function handleAdminBan(req, res) {
  if (!hasAdminAccess(req)) return res.status(401).json({ error: 'unauthorized' });

  const { type, value } = req.body || {};
  if (typeof value !== 'string' || value.length < 1 || value.length > 512)
    return res.status(400).json({ error: 'invalid value' });

  switch (type) {
    case 'hwid': revokeHwid(value); break;
    case 'hwidHash':
      if (!/^[a-f0-9]{64}$/i.test(value)) return res.status(400).json({ error: 'invalid hash' });
      revokeHwidHash(value);
      break;
    case 'user': revokeUser(value); break;
    case 'ip':   revokeIp(value);   break;
    default: return res.status(400).json({ error: 'invalid type' });
  }

  return res.status(200).json({
    ok: true, type,
    value: value.slice(0, 20) + (value.length > 20 ? '...' : ''),
    stats: stats(),
  });
    }
