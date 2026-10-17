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

const root = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, 'source', name), 'utf8');
const write = (name, body) => fs.writeFileSync(path.join(root, 'artifacts', name), body);

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

// Stage 2 keeps a literal placeholder that api/auth.js replaces per request
// with the host the executor actually reached.
const stage2 = read('savecheck.lua');
if (!stage2.includes('@BASE_URL@')) throw new Error('savecheck.lua missing @BASE_URL@');
write('loada.lua', stage2);
console.log('stage 2 (loada)   ', stage2.length, 'bytes  sha256', sha256(stage2));

// Stage 3 / 4 are rendered by api/auth.js with the same substitution.
for (const [source, target] of [['loader.lua', 'loader.lua'], ['payload.lua', 'payload.lua']]) {
  const body = read(source);
  if (!body.includes('@BASE_URL@')) throw new Error(`${source} missing @BASE_URL@`);
  write(target, body);
  console.log(`stage   ${target.padEnd(12)}`, body.length, 'bytes');
}

// Stage 1 template keeps its tokens; the handler fills chain id, capability,
// stage-2 sha and base url at request time.
const stage1 = read('loadc.template.lua');
for (const token of ['__CHAIN_ID__', '__CAP_D__', '__CAP_N__', '__STAGE2_SHA256__', '__BASE_URL__']) {
  if (!stage1.includes(token)) throw new Error(`loadc template missing ${token}`);
}
write('loadc.lua', stage1);
console.log('stage 1 (loadc)   ', stage1.length, 'bytes');
console.log('\nstage2 sha256 (pin this in api/auth.js):', sha256(stage2));
