'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

const port = 30_000 + (process.pid % 10_000);
const adminPort = port + 1;
const env = {
  ...process.env,
  PORT: String(port),
  PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
  REALTIME_WS_URL: 'wss://loader999mss-realtime.onrender.com/realtime',
  TICKET_SECRET: 'ticket-test-secret-at-least-thirty-two-characters',
  REALTIME_TICKET_SECRET: 'realtime-test-secret-at-least-thirty-two-characters',
  PAYLOAD_XOR_KEY: 'payload-test-key',
  ADMIN_TOKEN: 'admin-ui-test-token-at-least-thirty-two-characters',
  REALTIME_ADMIN_TOKEN: 'realtime-admin-test-token-at-least-thirty-two-characters',
  REALTIME_ADMIN_URL: `http://127.0.0.1:${adminPort}`,
};
process.env.TICKET_SECRET = env.TICKET_SECRET;
process.env.REALTIME_TICKET_SECRET = env.REALTIME_TICKET_SECRET;
const { hashHwid, issueTicket } = require('../lib/ticket');
const { verifyRealtimeTicket } = require('../lib/realtime-ticket');

let remoteCommand = null;
const remote = http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${env.REALTIME_ADMIN_TOKEN}`) {
    res.writeHead(401, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: false }));
  }
  if (req.method === 'GET' && req.url === '/admin/sessions') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true,
      sessions: [{
        sessionId: 'f'.repeat(24), hwidHash: 'a'.repeat(64), scriptName: 'main',
        connectedAt: 1000, lastActivityAt: 2000, idleMs: 100,
      }],
    }));
  }
  if (req.method === 'POST' && req.url === '/admin/command') {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      remoteCommand = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false }));
});
const remoteReady = new Promise((resolve) => remote.listen(adminPort, '127.0.0.1', resolve));

const child = spawn(process.execPath, ['server.js'], {
  cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'],
});

function stop() {
  if (!child.killed) child.kill('SIGTERM');
  remote.close();
}

async function post(pathname, body) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-roblox-client': 'test' },
    body: JSON.stringify(body),
  });
}

async function main() {
  await remoteReady;
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

  const dashboard = await fetch(`http://127.0.0.1:${port}/admin`);
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /999MS Realtime Control/);
  const unauthorized = await fetch(`http://127.0.0.1:${port}/api/realtime/sessions`);
  assert.equal(unauthorized.status, 401);
  const listed = await fetch(`http://127.0.0.1:${port}/api/realtime/sessions`, {
    headers: { 'x-admin-token': env.ADMIN_TOKEN },
  });
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).sessions[0].sessionId, 'f'.repeat(24));
  const controlled = await post('/api/realtime/command', {
    sessionId: 'f'.repeat(24), command: 'disconnect', message: 'test',
  });
  assert.equal(controlled.status, 401);
  const command = await fetch(`http://127.0.0.1:${port}/api/realtime/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': env.ADMIN_TOKEN },
    body: JSON.stringify({ sessionId: 'f'.repeat(24), command: 'disconnect', message: 'test' }),
  });
  assert.equal(command.status, 200);
  assert.deepEqual(remoteCommand, { jti: 'f'.repeat(24), command: 'disconnect', reason: 'test' });

  const hwid = 'api-test-hwid';
  const ticket = issueTicket({ scope: 'script', hwidHash: hashHwid(hwid), userId: '7', scriptName: 'main' });
  const response = await post('/api/realtime-ticket', { ticket, hwid, scriptName: 'main' });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.valid, true);
  assert.equal(data.url, env.REALTIME_WS_URL);
  const claims = verifyRealtimeTicket(data.token);
  assert.equal(claims.hwidHash, hashHwid(hwid));
  assert.equal(claims.scriptName, 'main');

  const rejected = await post('/api/realtime-ticket', { ticket, hwid: 'wrong-hwid', scriptName: 'main' });
  assert.equal(rejected.status, 403);
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
  console.log('PASS API realtime ticket binding');
}

main().then(stop).catch((error) => {
  stop();
  console.error(error);
  process.exitCode = 1;
});
