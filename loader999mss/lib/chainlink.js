'use strict';

/**
 * On-demand stage links.
 *
 *   /loadc.lua  ──►  https://host/<token>  ──►  https://host/<token>  ──►  https://host/<token>
 *                     (Stage 2)                 (Stage 3)                 (Stage 4)
 *
 * Only the entry script carries a file name. Every later stage is reached
 * through a bare, opaque token, so a link says nothing about what it serves.
 *
 * Token layout: `<chainId>.<exp>.<sig>`
 *   chainId  16 random bytes (32 hex), fresh for every minted link
 *   exp      epoch milliseconds, the link dies after TTL
 *   sig      HMAC-SHA256(secret, "999MS-link-v2|<stage>|<chainId>|<exp>")[:32]
 *
 * The stage is inside the signature only, never in the token, so the server
 * resolves it by testing the token against each stage.
 */

const crypto = require('node:crypto');

const STAGES = ['loada', 'loader', 'payload'];
const NEXT_STAGE = Object.freeze({ loada: 'loader', loader: 'payload' });
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
    .update(`999MS-link-v2|${stage}|${chainId}|${exp}`)
    .digest('hex')
    .slice(0, 32);
}

function tokenFor(stage, chainId, exp) {
  if (!STAGES.includes(stage)) throw new Error('unknown stage: ' + stage);
  return `${chainId}.${exp}.${sign(chainId, stage, exp)}`;
}

// One fresh link, minted at the moment a stage is served or picked up.
// `budgetMs` covers work done between minting and delivery (Stage 1 is
// obfuscated after its link exists), so the client still gets the full TTL.
function mintLink(stage, now = Date.now(), budgetMs = 0) {
  if (!chainSecret() || !STAGES.includes(stage)) return null;
  const chainId = crypto.randomBytes(16).toString('hex');
  const exp = now + linkTtlMs() + Math.max(0, Math.floor(budgetMs));
  return { chainId, stage, exp, token: tokenFor(stage, chainId, exp) };
}

function isTokenShape(token) {
  return typeof token === 'string' && /^[a-f0-9]{32}\.\d{13}\.[a-f0-9]{32}$/.test(token);
}

// Resolve which stage a bare token belongs to. The stage is not written in the
// token, so it is recovered by checking the signature against each stage.
function resolveToken(token, now = Date.now()) {
  if (!chainSecret() || !isTokenShape(token)) return null;

  const [chainId, expRaw, signature] = token.split('.');
  const exp = Number(expRaw);
  if (!Number.isSafeInteger(exp)) return null;
  if (exp <= now) return null;
  // A link may never be minted further ahead than one window.
  if (exp > now + 120_000) return null;

  const supplied = Buffer.from(signature, 'utf8');
  for (const stage of STAGES) {
    const expected = Buffer.from(sign(chainId, stage, exp), 'utf8');
    if (supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected)) {
      return { chainId, stage, exp };
    }
  }
  return null;
}

// Kept for callers that already know the stage (tests, tooling).
function verifyToken(token, stage, now = Date.now()) {
  const claim = resolveToken(token, now);
  return claim && claim.stage === stage ? claim : null;
}

// One link is good for one fetch on this instance. Expiry already bounds a
// replay to 10 s; this closes that window where the instance is the same.
const usedLinks = new Map();

function consume(token, now = Date.now()) {
  const claim = resolveToken(token, now);
  if (!claim) return null;
  for (const [key, expiresAt] of usedLinks) {
    if (expiresAt <= now) usedLinks.delete(key);
  }
  const key = `${claim.chainId}:${claim.stage}`;
  if (usedLinks.has(key)) return null;
  usedLinks.set(key, claim.exp);
  return claim;
}

// The next link is derived from the token that was just redeemed, so the whole
// chain can be rendered (and hashed) the moment any stage is served. Nothing is
// stored: the same token always derives the same next link.
function deriveNext(token, now = Date.now()) {
  const claim = resolveToken(token, now);
  if (!claim) return null;
  const nextStage = NEXT_STAGE[claim.stage];
  if (!nextStage) return null;

  const chainId = crypto
    .createHmac('sha256', chainSecret())
    .update(`999MS-next-v1|${token}`)
    .digest('hex')
    .slice(0, 32);
  const exp = claim.exp + linkTtlMs();
  return { chainId, stage: nextStage, exp, token: tokenFor(nextStage, chainId, exp) };
}

module.exports = {
  STAGES,
  NEXT_STAGE,
  mintLink,
  tokenFor,
  resolveToken,
  verifyToken,
  deriveNext,
  consume,
  isTokenShape,
  linkTtlMs,
};
