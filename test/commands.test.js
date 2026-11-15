'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const C = require('../code/lib/commands');

const all = C.groups.reduce((a, g) => a.concat(g.items), []);

test('no command is listed twice, and every entry is complete', () => {
  const seen = new Set();
  all.forEach(i => {
    assert.ok(i.cmd && i.does && i.effect, 'incomplete: ' + JSON.stringify(i));
    assert.ok(!seen.has(i.cmd), 'duplicate: ' + i.cmd);
    seen.add(i.cmd);
    if (i.alt) assert.ok(!seen.has(i.alt), 'alt listed separately: ' + i.alt);
  });
});

test('every npm script in package.json is in the catalogue ', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const text = all.map(i => i.cmd + ' ' + (i.alt || '')).join('\n');
  Object.keys(pkg.scripts).forEach(s => {
    const needle = s === 'test' ? 'npm test' : 'npm run ' + s;
    assert.ok(text.indexOf(needle) >= 0, 'missing in catalogue: ' + needle);
  });
});

test('the test script runs every test file', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js'));
  files.forEach(f => assert.ok(pkg.scripts.test.indexOf('test/*.test.js') >= 0 || pkg.scripts.test.indexOf(f) >= 0, 'not run by npm test: ' + f));
});
