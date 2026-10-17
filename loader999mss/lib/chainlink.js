'use strict';

/**
 * Per-run stage links.
 *
 * A single /loadc.lua request mints one chain id and one link per stage. All
 * links share an expiry (10 s by default) counted from that request, so the
 * whole 4-stage run has to finish inside the window.
 *
 *   loadc -> loada -> loader -> payload
 *
 * Every link is `<chainId>.<stage>.<exp>.<hmac>`: stateless, so a run may hit
 * four different serverless instances without a database, while a link still
 * cannot be forged or re-pointed at another stage.
 */

const crypto = require('node:crypto');

const STAGES = ['loada', 'loader', 'payload'];
const DEFAULT_TTL_MS = 10_000;

function chainSecret() {
  const secret = process.env.CHAIN_LINK_SECRET || process.env.TICKET_SECRET;
  return typeof secret === 'string' && secret.length >= 32 ? secret : null;
}

function linkTtlMs() {
  const configured = Number(process.env.CHAIN_LINK_TTL_MS);
  if (Number.isFinite(configured) && configured >= 1000 && configured <= 120_000) {
    return Math.floor(configured);
  }
  return DEFAULT_TTL_MS;
}

function sign(chainId, stage, exp) {
  return crypto
    .createHmac('sha256', chainSecret())
    .update(`999MS-link-v1|${chainId}|${stage}|${exp}`)
    .digest('hex')
    .slice(0, 32);
}

function tokenFor(chainId, stage, exp) {
  if (!STAGES.includes(stage)) throw new Error('unknown stage: ' + stage);
  return `${chainId}.${stage}.${exp}.${sign(chainId, stage, exp)}`;
}

// `budgetMs` covers work done between minting and delivery (Stage-1 is
// obfuscated after the links exist), so the client still gets the full TTL.
function createChain(now = Date.now(), budgetMs = 0) {
  if (!chainSecret()) return null;
  const chainId = crypto.randomBytes(16).toString('hex');
  const exp = now + linkTtlMs() + Math.max(0, Math.floor(budgetMs));
  const tokens = {};
  for (const stage of STAGES) tokens[stage] = tokenFor(chainId, stage, exp);
  return { chainId, exp, ttlMs: linkTtlMs(), tokens };
}

function verifyToken(token, stage, now = Date.now()) {
  if (!chainSecret()) return null;
  if (typeof token !== 'string' || token.length > 200) return null;

  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [chainId, tokenStage, expRaw, signature] = parts;

  if (!/^[a-f0-9]{32}$/.test(chainId)) return null;
  if (tokenStage !== stage || !STAGES.includes(tokenStage)) return null;
  if (!/^\d{13}$/.test(expRaw)) return null;

  const exp = Number(expRaw);
  if (!Number.isSafeInteger(exp)) return null;
  if (exp <= now) return null;
  // A link may never be minted further ahead than one window.
  if (exp > now + 120_000) return null;

  const expected = Buffer.from(sign(chainId, tokenStage, exp), 'utf8');
  const supplied = Buffer.from(signature, 'utf8');
  if (supplied.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(supplied, expected)) return null;

  return { chainId, stage: tokenStage, exp };
}

// One link is good for one fetch on this instance. Expiry already bounds a
// replay to 10 s; this closes that window where the instance is the same.
const usedLinks = new Map();

function consume(token, stage, now = Date.now()) {
  const claim = verifyToken(token, stage, now);
  if (!claim) return null;
  for (const [key, expiresAt] of usedLinks) {
    if (expiresAt <= now) usedLinks.delete(key);
  }
  const key = `${claim.chainId}:${claim.stage}`;
  if (usedLinks.has(key)) return null;
  usedLinks.set(key, claim.exp);
  return claim;
}

module.exports = { STAGES, createChain, tokenFor, verifyToken, consume, linkTtlMs };
