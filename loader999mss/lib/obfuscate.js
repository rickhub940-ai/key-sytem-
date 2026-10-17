'use strict';

/**
 * Per-run obfuscation of Stage 1 via the WeAreDevs obfuscator API.
 *
 * Every /loadc.lua is POSTed to https://wearedevs.net/api/obfuscate, so each
 * response is a fresh obfuscation of the freshly minted links.
 *
 * If the API is unreachable (network egress blocked, rate limited, timeout)
 * the same source is obfuscated locally with `lua-obfuscator` so the chain
 * still runs. The method is reported in the x-999ms-obf response header.
 */

let localObfuscate = null;
try {
  ({ obfuscate: localObfuscate } = require('lua-obfuscator'));
} catch {
  localObfuscate = null;
}

const API_URL = process.env.WEARE_API_URL || 'https://wearedevs.net/api/obfuscate';
const API_TIMEOUT_MS = Number(process.env.WEARE_API_TIMEOUT_MS) || 8000;
const LOCAL_STEPS = Object.freeze([
  { name: 'RenameVariables' },
  { name: 'ConstantArray' },
  { name: 'StringsToExpressions' },
  { name: 'NumbersToExpressions' },
  { name: 'EncryptStrings' },
  { name: 'EncryptNumbers' },
  { name: 'InsertJunk' },
  { name: 'WrapInFunction' },
]);

// Measured with an EWMA so chain links can be minted with a window that still
// gives the client the full TTL after obfuscation finished.
let measuredMs = 0;

function obfuscationBudgetMs() {
  return Math.ceil(measuredMs);
}

function obfuscateLocally(source) {
  if (!localObfuscate) return null;
  try {
    const output = localObfuscate(source, 'luaU', { steps: LOCAL_STEPS, minify: true });
    return typeof output === 'string' && output.length > source.length ? output : null;
  } catch (error) {
    console.error('[obfuscate] local', error.message);
    return null;
  }
}

const RETRY_DELAYS_MS = (process.env.WEARE_API_RETRY_MS || '500,1200,2000')
  .split(',').map((v) => Number(v)).filter((v) => Number.isFinite(v) && v >= 0);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function postOnce(source) {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      // The public endpoint answers 403 to non-browser agents.
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      origin: 'https://wearedevs.net',
      referer: 'https://wearedevs.net/obfuscator',
    },
    body: JSON.stringify({ script: source }),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after')) * 1000;
    const error = new Error('HTTP 429');
    error.retryAfter = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null;
    throw error;
  }
  if (!response.ok) throw new Error('HTTP ' + response.status);
  const payload = await response.json();
  const output = payload && payload.obfuscated;
  if (payload?.success !== true || typeof output !== 'string' || output.length < 100) {
    throw new Error('unexpected response');
  }
  return output;
}

// The public endpoint allows roughly one call per second, so a burst is
// retried instead of silently degrading to the local obfuscator.
async function obfuscateWithWeAreDevs(source) {
  const started = Date.now();
  let lastError = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const body = await postOnce(source);
      return { body, method: 'wearedevs', ms: Date.now() - started, attempts: attempt + 1 };
    } catch (error) {
      lastError = error;
      const delay = error.retryAfter ?? RETRY_DELAYS_MS[attempt];
      if (delay === undefined) break;
      await sleep(delay);
    }
  }
  console.error('[obfuscate] wearedevs', lastError ? lastError.message : 'failed');
  return null;
}

async function obfuscateStageOne(source) {
  if (typeof source !== 'string' || source.length === 0) return null;

  let result = await obfuscateWithWeAreDevs(source);
  if (!result) {
    const local = obfuscateLocally(source);
    result = local
      ? { body: local, method: 'local', ms: 0 }
      : { body: source, method: 'plain', ms: 0 };
  }

  // Feed the budget used for the next minted link.
  if (result.method === 'wearedevs') {
    measuredMs = measuredMs === 0 ? result.ms : measuredMs * 0.7 + result.ms * 0.3;
  } else if (result.method === 'local') {
    // A local fallback is fast; keep the link budget honest so the next run
    // does not hand out an already-shrunken window.
    measuredMs = 0;
  }
  return result;
}

module.exports = { obfuscateStageOne, obfuscationBudgetMs };
