#!/usr/bin/env node
'use strict';
/**
 * Builds plain-text (non-obfuscated) chain artifacts from source/*.lua.
 *   source/savecheck.lua -> artifacts/loada.lua    (Stage 2)
 *   source/loader.lua    -> artifacts/loader.lua   (Stage 3)
 *   source/payload.lua   -> artifacts/payload.lua  (Stage 4)
 *   source/loadc.template.lua -> artifacts/loadc.lua (Stage 1 template)
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const luamin = require('luamin');

const root = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, 'source', name), 'utf8');
const write = (name, body) => fs.writeFileSync(path.join(root, 'artifacts', name), body);

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

// Every shipped stage is emitted on a single line with 2-character locals.
// The source files in source/ stay readable for maintenance; only the
// artifacts are compacted here.
const compact = (text, name) => {
  const out = luamin.minify(text);
  if (typeof out !== 'string' || out.length === 0)
    throw new Error(`${name}: minifier returned nothing`);
  if (out.includes('\n')) throw new Error(`${name}: expected a single line`);
  return out;
};

// Stage 2 keeps a literal placeholder that api/auth.js replaces per request
// with the host the executor actually reached.
const stage2Raw = read('savecheck.lua');
if (!stage2Raw.includes('@BASE_URL@')) throw new Error('savecheck.lua missing @BASE_URL@');
const stage2 = compact(stage2Raw, 'savecheck.lua');
if (!/@BASE_URL@\/x\/[a-f0-9]{40}/.test(stage2))
  throw new Error('savecheck.lua: marker literal did not survive compaction');
write('loada.lua', stage2);
console.log('stage 2 (loada)   ', stage2.length, 'bytes  sha256', sha256(stage2));

// Stage 3 / 4 are rendered by api/auth.js with the same substitution.
for (const [source, target] of [['loader.lua', 'loader.lua'], ['payload.lua', 'payload.lua']]) {
  const raw = read(source);
  if (!raw.includes('@BASE_URL@')) throw new Error(`${source} missing @BASE_URL@`);
  const body = compact(raw, source);
  write(target, body);
  console.log(`stage   ${target.padEnd(12)}`, body.length, 'bytes');
}

// Stage 1 template keeps its tokens; the handler fills chain id, capability,
// stage-2 sha and base url at request time.
const stage1Raw = read('loadc.template.lua');
for (const token of ['__CHAIN_ID__', '__STAGE2_URL__', '__STAGE2_SHA256__']) {
  if (!stage1Raw.includes(token)) throw new Error(`loadc template missing ${token}`);
}
const stage1 = compact(stage1Raw, 'loadc.template.lua');
write('loadc.lua', stage1);
console.log('stage 1 (loadc)   ', stage1.length, 'bytes');
console.log('\nstage2 sha256 (pin this in api/auth.js):', sha256(stage2));
