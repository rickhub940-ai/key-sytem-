'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { WebSocket } = require('ws');
const { hashHwid, issueRealtimeTicket } = require('../realtime-ticket');

const port = 20_000 + (process.pid % 10_000);
const realtimeSecret = 'render-realtime-test-secret-at-least-thirty-two-characters';
const adminToken = 'render-admin-test-token-at-least-thirty-two-characters';
const hwid = 'render-test-hwid';
process.env.REALTIME_TICKET_SECRET = realtimeSecret;
const claims = { jti: 'd'.repeat(24), hwidHash: hashHwid(hwid), scriptName: 'main' };

const child = spawn(process.execPath, ['server.js'], {
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, PORT: String(port), REALTIME_TICKET_SECRET: realtimeSecret, SOCKET_ADMIN_TOKEN: adminToken },
  stdio: ['ignore', 'pipe', 'pipe'],
});

function stop() {
  if (!child.killed) child.kill('SIGTERM');
}

async function main() {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('gateway startup timeout')), 5_000);
    child.once('error', reject);
    child.stdout.on('data', (data) => {
      if (data.toString().includes('realtime gateway listening')) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });

  const token = issueRealtimeTicket({ ...claims });
  const seen = [];
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('websocket timeout')), 5_000);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/realtime`);
    socket.once('error', reject);
    socket.on('open', () => socket.send(JSON.stringify({ type: 'authenticate', token, hwid, scriptName: 'main' })));
    socket.on('message', async (raw) => {
      try {
        const message = JSON.parse(raw.toString('utf8'));
        seen.push(message.type);
        if (message.type === 'handshake_challenge') {
          assert.match(message.id, /^[a-f0-9]{32}$/);
          assert.match(message.challenge, /^[a-f0-9]{64}$/);
          socket.send(JSON.stringify({ type: 'handshake_response', id: message.id, challenge: message.challenge }));
        } else if (message.type === 'authenticated') {
          socket.send(JSON.stringify({ type: 'status', stage: 'payload', code: 'active' }));
          socket.send(JSON.stringify({ type: 'heartbeat' }));
        } else if (message.type === 'heartbeat_ack') {
          const list = await fetch(`http://127.0.0.1:${port}/admin/sessions`, {
            headers: { authorization: `Bearer ${adminToken}` },
          });
          assert.equal(list.status, 200);
          const body = await list.json();
          const session = body.sessions.find((value) => value.sessionId === claims.jti);
          assert.equal(session.scriptName, claims.scriptName);
          assert.equal(session.hwidHash, claims.hwidHash);
          assert.equal(typeof session.connectedAt, 'number');
          assert.equal(typeof session.lastActivityAt, 'number');
          const response = await fetch(`http://127.0.0.1:${port}/admin/command`, {
            method: 'POST',
            headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
            body: JSON.stringify({ jti: claims.jti, command: 'notice', message: 'test' }),
          });
          assert.equal(response.status, 200);
        } else if (message.type === 'command') {
          assert.equal(message.command, 'notice');
          clearTimeout(timeout);
          socket.close();
          resolve();
        }
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  });

  assert.ok(seen.includes('handshake_challenge'));
  assert.ok(seen.includes('authenticated'));
  assert.ok(seen.includes('status_ack'));
  assert.ok(seen.includes('heartbeat_ack'));
  assert.equal((await fetch(`http://127.0.0.1:${port}/admin/sessions`)).status, 401);

  // The Vercel panel authenticates with a token derived from the shared secret,
  // so the gateway must accept it without an extra copied credential.
  const derivedAdmin = require('node:crypto')
    .createHmac('sha256', realtimeSecret).update('999MS socket admin v1').digest('hex');
  assert.equal((await fetch(`http://127.0.0.1:${port}/admin/sessions`, {
    headers: { authorization: `Bearer ${derivedAdmin}` },
  })).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/admin/sessions`, {
    headers: { authorization: `Bearer ${'0'.repeat(64)}` },
  })).status, 401);

  const stats = await fetch(`http://127.0.0.1:${port}/admin/stats`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(stats.status, 200);
  const statsBody = await stats.json();
  assert.equal(statsBody.ok, true);
  assert.equal(statsBody.version, '1.2.0');
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json())).version, '1.2.0');

  const rejectedToken = issueRealtimeTicket({ ...claims, jti: 'c'.repeat(24) });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('handshake rejection timeout')), 5_000);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/realtime`);
    socket.once('error', reject);
    socket.on('open', () => socket.send(JSON.stringify({ type: 'authenticate', token: rejectedToken, hwid, scriptName: 'main' })));
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString('utf8'));
      if (message.type === 'handshake_challenge') {
        const bad = `${message.challenge[0] === '0' ? '1' : '0'}${message.challenge.slice(1)}`;
        socket.send(JSON.stringify({ type: 'handshake_response', id: message.id, challenge: bad }));
      }
    });
    socket.on('close', (code) => {
      clearTimeout(timeout);
      try {
        assert.equal(code, 4401);
        resolve();
      } catch (error) { reject(error); }
    });
  });

  const health = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
  assert.equal(health.ok, true);
  console.log('PASS Render realtime gateway');
}

main().then(stop).catch((error) => {
  stop();
  console.error(error);
  process.exitCode = 1;
});
