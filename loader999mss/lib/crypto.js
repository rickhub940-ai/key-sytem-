function xorCipher(data, key) {
  if (typeof data === 'string') data = Buffer.from(data, 'utf8');
  if (typeof key === 'string') key = Buffer.from(key, 'utf8');
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = data[i] ^ key[i % key.length];
  }
  return out;
}

function b64encode(buf) { return Buffer.from(buf).toString('base64'); }
function b64decode(str) { return Buffer.from(str, 'base64'); }
function inverse(y) { return ((y * 20) + 5) / 10; }

module.exports = { xorCipher, b64encode, b64decode, inverse };
