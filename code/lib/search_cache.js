'use strict';
// The search cache: a small WRITABLE SQLite file beside the read-only vault.db (muse-cache.db). It holds three things, all derived and all safe to delete:
//   rewrites  one LLM rewrite per distinct (question, prompt version, model): asked once, never paid for again
//   qvecs     the embedding of a question or of its rewrite, so a repeated search needs no embedding server
//   spend     one row per paid call, so the daily cap and the ledger come from the same place
// Search RESULTS are never cached: they depend on the vault as it is now. Questions are stored as typed, so the file is as private as your notes.
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');

// Pure: the normal form of a question (lowercase, collapsed whitespace, trailing ? . ! stripped) so "Who made X?" and "who made x" share a cache entry.
const normQuestion = q => String(q || '').toLowerCase().replace(/\s+/g, ' ').replace(/[\s?.!]+$/g, '').trim();
const sha = s => crypto.createHash('sha1').update(String(s)).digest('hex');
const rewriteKey = (q, promptVersion, model) => sha([normQuestion(q), promptVersion, model].join('\u0000'));
const vecKey = (text, kind, model) => sha([text, kind, model].join('\u0000'));

function open(file) {
  const db = new DatabaseSync(file || ':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS rewrites (key TEXT PRIMARY KEY, question TEXT NOT NULL, prompt_version TEXT NOT NULL, model TEXT NOT NULL, rewrite TEXT NOT NULL,
      tokens_in INTEGER, tokens_out INTEGER, cost REAL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS qvecs (key TEXT PRIMARY KEY, model TEXT NOT NULL, dim INTEGER NOT NULL, vec BLOB NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS spend (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, task TEXT NOT NULL, provider TEXT, model TEXT, tokens_in INTEGER, tokens_out INTEGER, cost REAL NOT NULL);`);
  const getRw = db.prepare('SELECT rewrite, model, cost FROM rewrites WHERE key=?'), putRw = db.prepare('INSERT OR REPLACE INTO rewrites VALUES (?,?,?,?,?,?,?,?,?)');
  const getV = db.prepare('SELECT dim, vec FROM qvecs WHERE key=?'), putV = db.prepare('INSERT OR REPLACE INTO qvecs VALUES (?,?,?,?,?)');
  const addSpend = db.prepare('INSERT INTO spend (ts, task, provider, model, tokens_in, tokens_out, cost) VALUES (?,?,?,?,?,?,?)'), spendSince = db.prepare('SELECT COALESCE(SUM(cost),0) AS c FROM spend WHERE ts >= ?');
  return {
    getRewrite: key => getRw.get(key) || null,
    putRewrite: r => putRw.run(r.key, r.question, r.promptVersion, r.model, r.rewrite, r.tokensIn || 0, r.tokensOut || 0, r.cost || 0, new Date().toISOString()),
    getVec(key) { const r = getV.get(key); return r ? new Float32Array(r.vec.buffer.slice(r.vec.byteOffset, r.vec.byteOffset + r.vec.byteLength)) : null; },
    putVec: (key, model, vec) => putV.run(key, model, vec.length, Buffer.from(new Float32Array(vec).buffer), new Date().toISOString()),
    addSpend: s => addSpend.run(new Date().toISOString(), s.task, s.provider || null, s.model || null, s.tokensIn || 0, s.tokensOut || 0, s.cost || 0),
    spentSince: iso => spendSince.get(iso).c,
    counts: () => ({ rewrites: db.prepare('SELECT COUNT(*) c FROM rewrites').get().c, vectors: db.prepare('SELECT COUNT(*) c FROM qvecs').get().c,
      spentTotal: db.prepare('SELECT COALESCE(SUM(cost),0) c FROM spend').get().c }),
    close: () => db.close()
  };
}

module.exports = { normQuestion, rewriteKey, vecKey, open };
