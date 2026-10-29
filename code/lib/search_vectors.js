'use strict';
// The vector store for search: one unit-length vector per burr, in a flat binary file (Float32) plus a small JSON file naming the burr behind each row.
// It is DERIVED data: rebuild it any time with `node code/search_build.js`. Each row remembers a short hash of the text it was made from, so a burr whose
// claim or note title changed since is left out (it still shows up in word search) instead of matching the old meaning.
//   <dir>/search-vectors-<model>.json   { model, dim, count, ids[], hashes[] }
//   <dir>/search-vectors-<model>.f32    count * dim little-endian floats
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const Core = require('./search_core');

const fileBase = (dir, model) => path.join(dir, 'search-vectors-' + String(model).replace(/[^\w.-]/g, '_'));
const textHash = text => crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 12);

// rows: [{ id, text, vec }] (vec = any length-dim array). Writes both files atomically enough for a derived file (temp + rename).
function write(dir, model, rows) {
  const dim = rows.length ? rows[0].vec.length : 0, mat = new Float32Array(rows.length * dim);
  rows.forEach(function (r, i) { if (r.vec.length !== dim) throw new Error('vector for burr ' + r.id + ' has ' + r.vec.length + ' numbers, expected ' + dim); mat.set(Core.normalise(r.vec), i * dim); });
  const base = fileBase(dir, model);
  fs.writeFileSync(base + '.f32.tmp', Buffer.from(mat.buffer));
  fs.writeFileSync(base + '.json.tmp', JSON.stringify({ model, dim, count: rows.length, built: new Date().toISOString(), ids: rows.map(r => r.id), hashes: rows.map(r => textHash(r.text)) }));
  fs.renameSync(base + '.f32.tmp', base + '.f32'); fs.renameSync(base + '.json.tmp', base + '.json');
  return { dim, count: rows.length };
}

// currentText(id) -> the text the vector SHOULD have been made from now (or undefined if the burr is gone). Returns null when there is no store.
function load(dir, model, currentText) {
  const base = fileBase(dir, model);
  if (!fs.existsSync(base + '.json') || !fs.existsSync(base + '.f32')) return null;
  const meta = JSON.parse(fs.readFileSync(base + '.json', 'utf8')), buf = fs.readFileSync(base + '.f32');
  if (buf.length !== meta.count * meta.dim * 4) throw new Error('vector file does not match its description; rebuild with: node code/search_build.js');
  const mat = buf.byteOffset % 4 === 0 ? new Float32Array(buf.buffer, buf.byteOffset, meta.count * meta.dim)      // a Float32 view needs a 4-byte-aligned start
    : new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  // Keep only rows whose text is unchanged.
  const keep = []; let stale = 0, gone = 0;
  meta.ids.forEach(function (id, i) {
    const t = currentText(id);
    if (t === undefined) { gone++; return; }
    if (textHash(t) !== meta.hashes[i]) { stale++; return; }
    keep.push(i);
  });
  const dim = meta.dim, packed = new Float32Array(keep.length * dim), ids = new Array(keep.length);
  keep.forEach(function (src, dst) { packed.set(mat.subarray(src * dim, (src + 1) * dim), dst * dim); ids[dst] = meta.ids[src]; });
  return {
    model: meta.model, dim, count: keep.length, built: meta.built, stale, gone, ids,
    // The k nearest burrs to a query vector: [{ id, sim }], best first.
    nearest: function (q, k) { return Core.rankVectors(packed, dim, keep.length, Core.normalise(q), k).map(function (r) { return { id: ids[r.row], sim: r.sim }; }); }
  };
}

module.exports = { fileBase, textHash, write, load };
