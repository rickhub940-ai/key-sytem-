const crypto = require('node:crypto');

const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
// Keep the identifier canonical everywhere. Platoboost is the persistent
// key-to-device authority, so casing/whitespace must not create a second
// identifier for the same reported device value.
const normalizeHwid = (hwid) => String(hwid).trim().toLowerCase();

const service = () => {
  const v = process.env.PLATO_SERVICE_ID;
  if (!v) throw new Error('Missing PLATO_SERVICE_ID');
  return v;
};
const secret = () => {
  const v = process.env.PLATO_SECRET;
  if (!v) throw new Error('Missing PLATO_SECRET');
  return v;
};
const host = () =>
  (process.env.PLATO_API_HOST || 'https://api.platoboost.net').replace(/\/$/, '');

async function platoFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(10000),
  });
  let data;
  try { data = await res.json(); }
  catch { throw new Error('Invalid response from Platoboost'); }
  return { status: res.status, data };
}

function verifyIntegrity(data, nonce) {
  return (
    data?.success === true &&
    data?.data?.valid === true &&
    data.data.hash === sha256(`true-${nonce}-${secret()}`)
  );
}

async function verifyKey(key, hwid) {
  if (typeof key !== 'string' || !key.trim())
    return { valid: false, message: 'Invalid key' };
  if (typeof hwid !== 'string' || !hwid.trim() || hwid.length > 512)
    return { valid: false, message: 'Invalid device' };

  const identifier = sha256(normalizeHwid(hwid));
  const nonce = crypto.randomBytes(16).toString('hex');
  const url = new URL(`/public/whitelist/${encodeURIComponent(service())}`, host());
  url.searchParams.set('identifier', identifier);
  url.searchParams.set('key', key.trim());
  url.searchParams.set('nonce', nonce);

  let result = await platoFetch(url.toString());
  if (result.status === 429)
    return { valid: false, rateLimited: true, message: 'Rate limited' };
  if (result.status !== 200 || result.data?.success !== true)
    return { valid: false, message: result.data?.message || 'Verification failed' };

  if (verifyIntegrity(result.data, nonce)) return { valid: true };

  if (result.data?.data?.valid !== true && key.trim().startsWith('KEY_')) {
    const redeemNonce = crypto.randomBytes(16).toString('hex');
    result = await platoFetch(
      `${host()}/public/redeem/${encodeURIComponent(service())}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identifier, key: key.trim(), nonce: redeemNonce }),
      }
    );
    if (result.status === 429)
      return { valid: false, rateLimited: true, message: 'Rate limited' };
    if (!verifyIntegrity(result.data, redeemNonce))
      return { valid: false, message: result.data?.message || 'Key invalid' };

    const checkNonce = crypto.randomBytes(16).toString('hex');
    url.searchParams.set('nonce', checkNonce);
    const check = await platoFetch(url.toString());
    if (check.status === 200 && verifyIntegrity(check.data, checkNonce))
      return { valid: true };
    return { valid: false, message: check.data?.message || 'Activation unverified' };
  }

  return { valid: false, message: 'Could not verify integrity' };
}

async function createLink(hwid) {
  if (typeof hwid !== 'string' || !hwid.trim() || hwid.length > 512)
    throw new Error('Invalid device');

  const result = await platoFetch(`${host()}/public/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ service: service(), identifier: sha256(normalizeHwid(hwid)) }),
  });
  if (result.status === 429) return { rateLimited: true };
  if (result.status !== 200 || result.data?.success !== true ||
      typeof result.data?.data?.url !== 'string')
    throw new Error(result.data?.message || 'Could not create link');
  return { url: result.data.data.url };
}

module.exports = { verifyKey, createLink };
