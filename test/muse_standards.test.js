'use strict';
// The UI spec's written rules, checked by machine: no innerHTML, no inline styles or scripts, one place for the shelf names, and display tidying that never touches stored text.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path'), { pathToFileURL } = require('node:url');
const UI = path.join(__dirname, '..', 'code', 'muse_ui', 'js'), imp = f => import(pathToFileURL(path.join(UI, f)).href);
const files = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(d, e.name)) : /\.mjs$/.test(e.name) ? [path.join(d, e.name)] : []);

test('standards: no innerHTML, no inline style attribute, no inline script or handler strings in the interface code', () => {
  files(UI).forEach(f => {
    const src = fs.readFileSync(f, 'utf8').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n'), name = path.relative(UI, f);
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(src), name + ' builds DOM from strings');
    assert.ok(!/\bstyle:\s*['"`]/.test(src), name + ' sets an inline style attribute (the Content-Security-Policy blocks it); use a class or the style object');
    assert.ok(!/\bon(click|load|error)\s*=\s*['"]/.test(src), name + ' has an inline handler string');
  });
});

test('standards: the shelf names live in one place', () => {
  const dup = files(UI).filter(f => !/words\.mjs$/.test(f)).filter(f => /['"`](Vesicles|Rivulets)['"`]/.test(fs.readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '')));
  assert.deepStrictEqual(dup.map(f => path.relative(UI, f)), [], 'shelf names are repeated outside words.mjs');
});

test('tidy: markdown leftovers are cleaned for display only', async () => {
  const { tidyQuote, tidyTitle } = await imp('tidy.mjs');
  assert.strictEqual(tidyTitle('# How Theodore Vail Built the AT&T Monopoly'), 'How Theodore Vail Built the AT&T Monopoly');
  assert.strictEqual(tidyQuote('| * Kalyaan<br>* Yaman<br>*'), 'Kalyaan · Yaman', 'table markup in a quote becomes plain separators');
  assert.strictEqual(tidyQuote('chose it.\\|[11\\|]\\|[12\\|] This meaning'), 'chose it. This meaning');
  assert.strictEqual(tidyQuote('_‘Ulysses’_ was written in [[Indian Cinema|cinema]], keeping snake_case'), '‘Ulysses’ was written in Indian Cinema, keeping snake_case');
});
