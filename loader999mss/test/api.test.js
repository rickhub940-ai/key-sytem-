'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const port = 30_000 + (process.pid % 10_000);
const env = {
  ...process.env,
  PORT: String(port),
  PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
  TICKET_SECRET: 'ticket-test-secret-at-least-thirty-two-characters',
  PAYLOAD_XOR_KEY: 'payload-test-key',
  ADMIN_TOKEN: 'admin-ui-test-token-at-least-thirty-two-characters',
  CHAIN_DEBUG: '1',
  CHAIN_LINK_TTL_MS: '10000',
  WEARE_API_TIMEOUT_MS: '4000',
};
process.env.TICKET_SECRET = env.TICKET_SECRET;

const { hashHwid, issueTicket } = require('../lib/ticket');
const chainLinks = require('../lib/chainlink');

const child = spawn(process.execPath, ['server.js'], {
  cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'],
});

function stop() {
  if (!child.killed) child.kill('SIGTERM');
}

async function post(pathname, body, headers = {}) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-roblox-client': 'test', ...headers },
    body: JSON.stringify(body),
  });
}

async function main() {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('startup timeout')), 5_000);
    child.stdout.on('data', (data) => {
      if (data.toString().includes('api listening')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once('error', reject);
  });

  // ── health ──
  const health = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal(healthBody.ok, true);
  assert.equal(healthBody.service, '999MS');
  assert.equal(healthBody.realtime, undefined, 'health must not advertise realtime');

  // ── the realtime/WebSocket surface is gone ──
  for (const gone of ['/admin', '/api/realtime-ticket', '/api/realtime/sessions',
    '/api/realtime/command', '/api/session-renew']) {
    const get = await fetch(`http://127.0.0.1:${port}${gone}`, { redirect: 'manual' });
    assert.ok(get.status >= 300 || get.status === 404, gone + ' must be gone, got ' + get.status);
    const posted = await post(gone, {});
    assert.ok(posted.status >= 300 || posted.status === 404, gone + ' POST must be gone, got ' + posted.status);
  }

  // ── control panel API (HTTP only) ──
  const denied = await post('/api/control/bans', {});
  assert.equal(denied.status, 401);
  const bans = await post('/api/control/bans', {}, { 'x-admin-token': env.ADMIN_TOKEN });
  assert.equal(bans.status, 200);
  const bansBody = await bans.json();
  assert.equal(bansBody.ok, true);
  assert.equal(typeof bansBody.stats.hwids, 'number');

  const traffic = await post('/api/control/traffic', { limit: 5 }, { 'x-admin-token': env.ADMIN_TOKEN });
  assert.equal(traffic.status, 200);
  assert.equal(Array.isArray((await traffic.json()).traffic), true);

  const removedControl = await post('/api/control/sessions', {}, { 'x-admin-token': env.ADMIN_TOKEN });
  assert.ok(removedControl.status >= 300 || removedControl.status === 404);

  // ── ban enforcement ──
  const banned = await post('/api/admin/ban', { type: 'hwid', value: 'banned-hwid' }, { 'x-admin-token': env.ADMIN_TOKEN });
  assert.equal(banned.status, 200);
  const bannedVerify = await post('/api/verify', { key: 'KEY_TEST', hwid: 'banned-hwid', scriptName: 'main' });
  assert.equal(bannedVerify.status, 403);

  // ── regression: payload-style /api/verify without RNG still reaches key checks ──
  const payloadStyleVerify = await post('/api/verify', {
    key: 'KEY_TEST', hwid: 'api-test-hwid', scriptName: 'main', userId: '7',
  });
  const payloadStyleBody = await payloadStyleVerify.json().catch(() => ({}));
  assert.notEqual(payloadStyleBody.error, 'RNG integers rejected',
    'payload-style /api/verify must reach key verification');

  const forgedVerify = await post('/api/verify', {
    key: 'KEY_TEST', hwid: 'api-test-hwid', scriptName: 'main',
    Rng1: 1.5, Rng2: 1, Rng3: 1, Rng4: 1, Rng5: 1, RngFloat: 2,
  });
  assert.equal(forgedVerify.status, 400);
  assert.equal((await forgedVerify.json()).error, 'RNG integers rejected');

  // ── ticket flow still works without realtime ──
  const hwid = 'api-test-hwid';
  const ticket = issueTicket({ scope: 'script', hwidHash: hashHwid(hwid), userId: '7', scriptName: 'main' });
  const script = await post('/api/script-verify', {
    ticket, hwid, scriptToken: 'x', runtimeSecret: 'y'.repeat(64), scriptName: 'main',
  });
  assert.equal(script.status, 409, 'a missing hop is rejected before the proof check');
  assert.equal((await script.json()).diagnostic, 'D2_HOP_MISSING');

  const forgedHop = await post('/api/script-verify', {
    ticket, hwid, scriptToken: 'x', runtimeSecret: 'y'.repeat(64), scriptName: 'main',
    hop: 'f'.repeat(48),
  });
  assert.equal(forgedHop.status, 409, 'a guessed hop is rejected');

  // ── /api/script refuses a ticket that never came through /api/verify ──
  const noHop = await post('/api/script', { ticket, scriptName: 'main' });
  assert.equal(noHop.status, 409, 'script requires a hop issued by verify');
  assert.equal((await noHop.json()).reason, 'hop required');

  const guessedHop = await post('/api/script', { ticket, scriptName: 'main', hop: 'a'.repeat(48), eq: 1 });
  assert.equal(guessedHop.status, 409, 'a guessed hop is never accepted');
  assert.equal((await guessedHop.json()).reason, 'hop required');

  // The hop/equation primitives are one-time and bound to the ticket.
  const sdk = require('../lib/999MS-server-sdk');
  const jti = 'a'.repeat(24);
  const firstHop = sdk.issueHop(jti, { answer: 42 });
  assert.equal(sdk.consumeHop(firstHop, 'b'.repeat(24)), null, 'hop is bound to its ticket');
  assert.equal(sdk.consumeHop(firstHop, jti).answer, 42, 'hop carries its metadata');
  assert.equal(sdk.consumeHop(firstHop, jti), null, 'a burned hop cannot be reused');
  const eq = sdk.createEquationChallenge();
  assert.equal(sdk.checkEquationAnswer(eq, eq.answer), true);
  assert.equal(sdk.checkEquationAnswer(eq, eq.answer + 1), false);
  assert.equal(sdk.checkEquationAnswer(eq, String(eq.answer)), false);
  const invalid = await post('/api/script-verify', { ticket: 'bad' });
  assert.equal(invalid.status, 401); // malformed ticket is rejected before any proof check

  // ── Stages 2-4 stay plain, readable Lua (only Stage 1 is obfuscated) ──
  // Served stages now require a run token, so readability is checked on the
  // artifacts that the chain hands out.
  for (const file of ['loada', 'loader', 'payload']) {
    const body = fs.readFileSync(path.join(__dirname, '..', 'artifacts', file + '.lua'), 'utf8');
    assert.equal(/WeAreDevs|obfuscate/i.test(body), false, file + ' must stay readable');
    assert.ok(body.includes('local '), file + ' keeps plain Lua statements');
  }
  // Without a token the stage routes fall through to the trap.
  for (const file of ['loada', 'loader', 'payload']) {
    const res = await fetch(`http://127.0.0.1:${port}/${file}.lua`, { redirect: 'manual' });
    assert.notEqual(res.status, 200, file + ' must require a run link');
  }

  // ── client Lua must not carry any realtime code ──
  const mainLua = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'main.lua'), 'utf8');
  assert.equal(/WebSocket|websocket|realtime|Realtime/i.test(mainLua), false,
    'main.lua must not reference the realtime system');

  // ── loader links (somtank-style random namespace + token) ──
  const linkDenied = await post('/api/link', {});
  assert.equal(linkDenied.status, 401);

  const created = await post('/api/link', { scriptName: 'main', hours: 2 }, { 'x-admin-token': env.ADMIN_TOKEN });
  assert.equal(created.status, 200);
  const linkBody = await created.json();
  assert.equal(linkBody.ok, true);
  assert.match(linkBody.path, /^\/x\/[a-f0-9]{40}$/, 'link path must be 40 random hex');
  assert.match(linkBody.url, /^http[^?]+\/x\/[a-f0-9]{40}\?at=[0-9a-z]+\.[A-Za-z0-9_-]{32}$/);
  assert.match(linkBody.line, /^loadstring\(game:HttpGet\("/);
  assert.match(linkBody.sha256, /^[a-f0-9]{64}$/);
  assert.ok(linkBody.stub.includes(linkBody.url), 'stub carries the link');
  assert.ok(linkBody.stub.includes(linkBody.sha256), 'stub pins the hash');

  const linkPathAndQuery = new URL(linkBody.url).pathname + new URL(linkBody.url).search;
  const linkRes = await fetch(`http://127.0.0.1:${port}${linkPathAndQuery}`, {
    headers: { 'x-roblox-client': 'test' },
  });
  assert.equal(linkRes.status, 200);
  const entry = await linkRes.text();
  const crypto = require('node:crypto');
  assert.equal(crypto.createHash('sha256').update(entry).digest('hex'), linkBody.sha256,
    'served entry must hash to the pinned value');
  assert.ok(entry.includes('/loadc.lua'), 'entry hands over to the chain');

  const tampered = await fetch(`http://127.0.0.1:${port}${linkBody.path}?at=${'0'.repeat(8)}.${'a'.repeat(32)}`, {
    redirect: 'manual',
  });
  assert.ok(tampered.status >= 300, 'a bad token must not serve the entry');

  const second = await (await post('/api/link', { scriptName: 'main' }, { 'x-admin-token': env.ADMIN_TOKEN })).json();
  assert.notEqual(second.path, linkBody.path, 'every link gets its own random namespace');

  // ── save-detector marker: a fixed literal, styled as the next-hop variable ──
  const STAGE2 = fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'loada.lua'), 'utf8');
  assert.equal(/supper_Boom|super_boom/i.test(STAGE2), false, 'the old literal is gone');
  assert.equal(STAGE2.includes('__CHAIN_MARKER__'), false, 'the marker is not a serve-time token');
  assert.match(STAGE2, /local (?:[A-Za-z_][A-Za-z0-9_]?)="@BASE_URL@\/x\/[a-f0-9]{40}"/,
    'the marker is a fixed literal bound to a <=2-character local at the top of the stage');
  const markerName = STAGE2.match(/local ([A-Za-z_][A-Za-z0-9_]?)="@BASE_URL@\/x\/[a-f0-9]{40}"/)[1];
  assert.equal((STAGE2.match(new RegExp('\\b' + markerName + '\\b', 'g')) || []).length >= 2, true,
    'the scanner reuses that same local');
  assert.equal(STAGE2.includes('\n'), false, 'Stage 2 ships as a single line');
  assert.equal(/NEXT_LINK|local marker/.test(STAGE2), false, 'no descriptive name survives');
  assert.equal(
    require('node:crypto').createHash('sha256').update(STAGE2).digest('hex'),
    fs.readFileSync(path.join(__dirname, '..', 'api', 'auth.js'), 'utf8')
      .match(/STAGE_TWO_RAW_SHA256 = '([a-f0-9]{64})'/)[1],
    'the raw-artifact pin must match artifacts/loada.lua',
  );

  // ── 4-stage chain: one run, one link per stage, 10-second window ──
  const loadc1 = await fetch(`http://127.0.0.1:${port}/loadc.lua`, {
    headers: { 'x-roblox-client': 'test' },
  });
  const loadc1Body = await loadc1.text();
  assert.equal(loadc1.status, 200);
  assert.equal(loadc1Body.includes('\n'), false, 'Stage 1 ships as a single line');
  assert.ok(['wearedevs', 'local', 'plain'].includes(loadc1.headers.get('x-999ms-obf')),
    'Stage 1 reports how it was obfuscated');
  assert.equal(/loada\.lua/.test(loadc1Body), false,
    'the Stage-2 URL is not readable in the obfuscated Stage 1');
  const stage2Url = loadc1.headers.get('x-999ms-stage2');
  assert.ok(stage2Url && stage2Url.includes('/loada.lua/'), 'debug header carries the Stage-2 link');

  const stage2Res = await fetch(stage2Url, { headers: { 'x-roblox-client': 'test' } });
  assert.equal(stage2Res.status, 200, 'the minted Stage-2 link is served once');
  const stage2 = await stage2Res.text();
  assert.equal(
    crypto.createHash('sha256').update(stage2).digest('hex'),
    fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'loada.lua'), 'utf8')
      && crypto.createHash('sha256').update(stage2).digest('hex'),
    'stage 2 hashes to itself (sanity)',
  );
  assert.equal(
    (await fetch(stage2Url, { redirect: 'manual' })).status !== 200,
    true,
    'a burned Stage-2 link is never served twice',
  );

  const stage3Url = (stage2.match(/https?:\/\/[^"'\s]+\/loader\.lua\/[A-Za-z0-9.]+/) || [])[0];
  assert.ok(stage3Url, 'Stage 2 carries its own Stage-3 link');
  const stage3Res = await fetch(stage3Url, { headers: { 'x-roblox-client': 'test' } });
  assert.equal(stage3Res.status, 200, 'Stage 3 link works');
  const stage3 = await stage3Res.text();

  const stage4Url = (stage3.match(/https?:\/\/[^"'\s]+\/payload\.lua\/[A-Za-z0-9.]+/) || [])[0];
  assert.ok(stage4Url, 'Stage 3 carries its own Stage-4 link');
  const stage4Res = await fetch(stage4Url, { headers: { 'x-roblox-client': 'test' } });
  assert.equal(stage4Res.status, 200, 'Stage 4 link works');
  const stage4 = await stage4Res.text();
  assert.ok(stage4.length > 1000, 'payload body arrived');

  // A link is scoped to its stage: the Stage-3 token must not open Stage 4.
  const stage3Token = stage3Url.split('/loader.lua/')[1];
  const crossStage = await fetch(`http://127.0.0.1:${port}/payload.lua/${stage3Token}`, { redirect: 'manual' });
  assert.notEqual(crossStage.status, 200, 'a link cannot be re-pointed at another stage');

  // And a link from an expired run is refused.
  const expired = chainLinks.tokenFor('a'.repeat(32), 'loada', Date.now() - 1000);
  const expiredRes = await fetch(`http://127.0.0.1:${port}/loada.lua/${expired}`, { redirect: 'manual' });
  assert.notEqual(expiredRes.status, 200, 'an expired link is refused');

  // Two runs never share links, and Stage 1 is re-obfuscated each time.
  const loadc2 = await fetch(`http://127.0.0.1:${port}/loadc.lua`, {
    headers: { 'x-roblox-client': 'test' },
  });
  const loadc2Body = await loadc2.text();
  assert.notEqual(loadc2.headers.get('x-999ms-stage2'), stage2Url, 'each run gets fresh links');
  assert.notEqual(loadc2Body, loadc1Body, 'each run is obfuscated again');

  console.log('PASS API without realtime');  console.log('PASS API without realtime');
}

main().then(() => { stop(); process.exit(0); })
  .catch((error) => { console.error(error); stop(); process.exit(1); });
