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
};
process.env.TICKET_SECRET = env.TICKET_SECRET;

const { hashHwid, issueTicket } = require('../lib/ticket');

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
  assert.equal(script.status, 403); // token/secret mismatch is still enforced
  const invalid = await post('/api/script-verify', { ticket: 'bad' });
  assert.equal(invalid.status, 401); // malformed ticket is rejected before any proof check

  // ── artifacts are plain, readable Lua ──
  for (const file of ['loadc', 'loader', 'payload']) {
    const res = await fetch(`http://127.0.0.1:${port}/${file}.lua`, {
      headers: { 'x-roblox-client': 'test' },
    });
    assert.equal(res.status, 200, file + ' should serve');
    const body = await res.text();
    assert.ok(!/WeAreDevs|obfuscate/i.test(body), file + ' must stay readable');
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
  assert.match(STAGE2, /local MN0 = "@BASE_URL@\/x\/[a-f0-9]{40}"/,
    'the marker is a fixed literal with an opaque name at the top of the stage');
  assert.match(STAGE2, /local marker = MN0/, 'the scanner uses that same variable');
  assert.equal(/NEXT_LINK/.test(STAGE2), false, 'the variable name must not describe its role');
  assert.equal(
    require('node:crypto').createHash('sha256').update(STAGE2).digest('hex'),
    fs.readFileSync(path.join(__dirname, '..', 'api', 'auth.js'), 'utf8')
      .match(/STAGE_TWO_RAW_SHA256 = '([a-f0-9]{64})'/)[1],
    'the raw-artifact pin must match artifacts/loada.lua',
  );

  const loadc1 = await (await fetch(`http://127.0.0.1:${port}/loadc.lua`, {
    headers: { 'x-roblox-client': 'test' },
  })).text();
  const cap = loadc1.match(/CAP_D = "([a-f0-9]+)"/);
  const capN = loadc1.match(/CAP_N = "([a-f0-9]+)"/);
  const pinned = loadc1.match(/STAGE2_SHA256 = "([a-f0-9]{64})"/)[1];
  const stage2 = await (await fetch(`http://127.0.0.1:${port}/loada.lua/${cap[1]}/${capN[1]}`, {
    headers: { 'x-roblox-client': 'test' },
  })).text();
  assert.equal(
    require('node:crypto').createHash('sha256').update(stage2).digest('hex'),
    pinned,
    'the served Stage 2 must hash to the pin inside the served Stage 1',
  );
  const hop = stage2.match(/local MN0 = "([^"]+)"/);
  assert.ok(hop, 'served Stage 2 declares the marker literal');
  assert.equal(hop[1].includes('@BASE_URL@'), false, 'the host is resolved before serving');
  assert.ok(stage2.includes('local marker = MN0'), 'scanner still points at the marker');

  // The same bytes every time: the marker must not be randomised per request.
  const loadc2 = await (await fetch(`http://127.0.0.1:${port}/loadc.lua`, {
    headers: { 'x-roblox-client': 'test' },
  })).text();
  const cap2 = loadc2.match(/CAP_D = "([a-f0-9]+)"/);
  const capN2 = loadc2.match(/CAP_N = "([a-f0-9]+)"/);
  const stage2b = await (await fetch(`http://127.0.0.1:${port}/loada.lua/${cap2[1]}/${capN2[1]}`, {
    headers: { 'x-roblox-client': 'test' },
  })).text();
  assert.equal(stage2b, stage2, 'Stage 2 is byte-identical across requests');

  for (const file of ['loader', 'payload']) {
    const body = await (await fetch(`http://127.0.0.1:${port}/${file}.lua`, {
      headers: { 'x-roblox-client': 'test' },
    })).text();
    assert.equal(/supper_Boom|super_boom/i.test(body), false, file + ' has no static marker');
    assert.equal(/__CHAIN_MARKER__/.test(body), false, file + ' has no unresolved token');
  }

  console.log('PASS API without realtime');  console.log('PASS API without realtime');
}

main().then(() => { stop(); process.exit(0); })
  .catch((error) => { console.error(error); stop(); process.exit(1); });
