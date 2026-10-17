const crypto = require('node:crypto');

const revokedHwids = new Set();
const revokedUsers = new Set();
const revokedIps = new Set();

let loaded = false;

function loadFromEnv() {
  if (loaded) return;
  loaded = true;

  for (const h of (process.env.REVOKED_HWIDS || '').split(',').map(s => s.trim()).filter(Boolean))
    revokedHwids.add(h.toLowerCase());
  for (const u of (process.env.REVOKED_USERS || '').split(',').map(s => s.trim()).filter(Boolean))
    revokedUsers.add(u);
  for (const i of (process.env.REVOKED_IPS || '').split(',').map(s => s.trim()).filter(Boolean))
    revokedIps.add(i);
}

const hashHwid = (hwid) =>
  crypto.createHash('sha256').update(String(hwid).trim().toLowerCase()).digest('hex');

function revokeHwid(hwid) { revokedHwids.add(hashHwid(hwid)); }
// The control panel bans by the hash the gateway already reports, so the raw
// device identifier never has to travel back through the browser.
function revokeHwidHash(hash) { revokedHwids.add(String(hash).trim().toLowerCase()); }
function revokeUser(userId) { revokedUsers.add(String(userId)); }
function revokeIp(ip) { revokedIps.add(String(ip)); }

function checkRevoked({ hwid, userId, ip } = {}) {
  loadFromEnv();
  if (hwid && revokedHwids.has(hashHwid(hwid))) return 'hwid_banned';
  if (userId && revokedUsers.has(String(userId))) return 'user_banned';
  if (ip && revokedIps.has(String(ip))) return 'ip_banned';
  return null;
}

function stats() {
  loadFromEnv();
  return { hwids: revokedHwids.size, users: revokedUsers.size, ips: revokedIps.size };
}

module.exports = {
  revokeHwid, revokeHwidHash, revokeUser, revokeIp, checkRevoked, stats, listRevocations,
};

function listRevocations() {
  const mask = (value) => (value.length <= 18 ? value : `${value.slice(0, 12)}…${value.slice(-4)}`);
  return {
    hwids: [...revokedHwids].map(mask),
    users: [...revokedUsers].map(mask),
    ips: [...revokedIps].map(mask),
  };
}
