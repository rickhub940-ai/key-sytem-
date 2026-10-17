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
// Stage 2 is built in two parts: the HEADER block (marker + next-stage link,
// kept verbatim so the name and literals stay readable) and the BODY, which is
// compacted. @BASE_URL@ stays unresolved so the server can fill it per host.
const stage2Raw = read('savecheck.lua');
if (!stage2Raw.includes('@BASE_URL@')) throw new Error('savecheck.lua missing @BASE_URL@');

const headerEnd = stage2Raw.indexOf('-- ═══ BODY ═══');
if (headerEnd < 0) throw new Error('savecheck.lua missing the BODY marker');
const headerSource = stage2Raw.slice(0, headerEnd);
const bodySource = stage2Raw.slice(headerEnd);

// The header keeps its comments out and its whitespace collapsed, but the
// table name and both literals are untouched.
const header = headerSource
  .split('\n')
  .filter((line) => !/^\s*--/.test(line))
  .join('\n')
  .replace(/\s+/g, ' ')
  .trim();
if (!/^local gamaramam\s*=/.test(header)) throw new Error('header must declare gamaramam');
if (!/@BASE_URL@\/x\/[a-f0-9]{40}/.test(header)) throw new Error('header lost the marker literal');
if (!header.includes('"@NEXT@"')) throw new Error('header lost the next-link slot');

const stage2 = `${header};${compact(bodySource, 'savecheck.lua')}`;
if (!/local gamaramam\s*=/.test(stage2)) throw new Error('stage 2 dropped the header table');
if (!/gamaramam\s*\[/.test(stage2)) throw new Error('body no longer reads the header table');
write('loada.lua', stage2);
console.log('stage 2 (loada)   ', stage2.length, 'bytes  sha256', sha256(stage2));

// Stage 3 / 4 are rendered by api/auth.js with the same substitution.
function splitHeader(source, raw, marker) {
  const cut = raw.indexOf(marker);
  if (cut < 0) throw new Error(`${source} missing the BODY marker`);
  const header = raw.slice(0, cut)
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
  if (!/^local gamaramam\s*=/.test(header)) throw new Error(`${source}: header must declare gamaramam`);
  if (!header.includes('"@NEXT@"')) throw new Error(`${source}: header lost the next-link slot`);
  return { header, body: raw.slice(cut) };
}

// Stage 3 carries the same header (marker + next link) as Stage 2.
{
  const raw = read('loader.lua');
  const { header, body } = splitHeader('loader.lua', raw, '-- ═══ BODY ═══');
  const out = `${header};${compact(body, 'loader.lua')}`;
  write('loader.lua', out);
  console.log('stage   loader.lua    ', out.length, 'bytes');
}

// Stage 4 is the final hand-off: no header, no next link.
{
  const raw = read('payload.lua');
  if (!raw.includes('@BASE_URL@')) throw new Error('payload.lua missing @BASE_URL@');
  const body = compact(raw, 'payload.lua');
  write('payload.lua', body);
  console.log('stage   payload.lua   ', body.length, 'bytes');
}

// Stage 1 template keeps its tokens; the handler fills chain id, capability,
// stage-2 sha and base url at request time.
const stage1Raw = read('loadc.template.lua');
for (const token of ['__STAGE2_TOKEN__', '__STAGE2_SHA256__', '__BASE_URL__']) {
  if (!stage1Raw.includes(token)) throw new Error(`loadc template missing ${token}`);
}
const stage1 = compact(stage1Raw, 'loadc.template.lua');
write('loadc.lua', stage1);
console.log('stage 1 (loadc)   ', stage1.length, 'bytes');
console.log('\nstage2 sha256 (pin this in api/auth.js):', sha256(stage2));
