// Bake-off, Node side. Run: node run.js  (each library is tried independently)
const C = require('./cases.json');
const tryit = (f) => { try { return f(); } catch (e) { return 'ERROR ' + String(e.message).slice(0, 70); } };
const load = (n) => { try { return require(n); } catch (e) { console.log(n + ' unavailable: ' + e.message.split('\n')[0]); return null; } };
const pluralize = load('pluralize'), compromise = load('compromise'), chrono = load('chrono-node'), R = load('@microsoft/recognizers-text-suite'), jr = load('jsonrepair');

console.log('\n======== PLURALS (X = wrong)');
const eng = {};
if (pluralize) eng.pluralize = (w) => pluralize.singular(w);
if (compromise) eng.compromise = (w) => { const d = compromise(w); return d.nouns().toSingular().text() || w; };
console.log('word'.padEnd(12), 'expected'.padEnd(11), ...Object.keys(eng).map((n) => n.padEnd(11)));
const score = Object.fromEntries(Object.keys(eng).map((n) => [n, 0]));
for (const [w, exp] of C.plural) {
  const row = Object.entries(eng).map(([n, f]) => { const out = tryit(() => f(w)); const ok = out === exp; score[n] += ok ? 1 : 0; return (out + (ok ? '' : ' X')).padEnd(11); });
  console.log(w.padEnd(12), exp.padEnd(11), ...row);
}
console.log('score:', JSON.stringify(score), 'of', C.plural.length);

console.log('\n======== DATES and QUANTITIES (judge by eye)');
for (const t of C.text) {
  console.log('\n> ' + t);
  if (chrono) console.log('  chrono-node   :', JSON.stringify(tryit(() => chrono.parse(t).map((r) => r.text))));
  if (R) {
    console.log('  recognizers dim :', JSON.stringify(tryit(() => R.recognizeDimension(t, R.Culture.English).map((r) => [r.text, r.resolution && r.resolution.value, r.resolution && r.resolution.unit]))));
    console.log('  recognizers cur :', JSON.stringify(tryit(() => R.recognizeCurrency(t, R.Culture.English).map((r) => [r.text, r.resolution && r.resolution.value, r.resolution && r.resolution.unit]))));
    console.log('  recognizers date:', JSON.stringify(tryit(() => R.recognizeDateTime(t, R.Culture.English).map((r) => [r.text, r.typeName]))));
  }
}

console.log('\n======== JSON REPAIR');
if (jr) for (const [s, what] of C.json) {
  const out = tryit(() => JSON.stringify(JSON.parse(jr.jsonrepair(s))));
  console.log('-', what, '->', String(out).slice(0, 150));
}
