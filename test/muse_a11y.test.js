'use strict';
const test = require('node:test'), assert = require('node:assert'), path = require('node:path'), fs = require('node:fs'), { pathToFileURL } = require('node:url');
const imp = f => import(pathToFileURL(path.join(__dirname, '..', 'code', 'muse_ui', 'js', f)).href);
const tokens = fs.readFileSync(path.join(__dirname, '..', 'code', 'muse_ui', 'css', 'tokens.css'), 'utf8');

const lum = hex => { const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const palettes = () => [...tokens.matchAll(/--bg:\s*(#\w{6});[^}]*?--surface:\s*(#\w{6});[^}]*?--text:\s*(#\w{6});\s*--text-2:\s*(#\w{6});\s*--text-3:\s*(#\w{6})/g)].map(m => ({ bg: m[1], surface: m[2], text: m[3], t2: m[4], t3: m[5] }));

test('a11y: every text colour reaches 4.5:1 on its background, light and dark', () => {
  const sets = palettes(); assert.ok(sets.length >= 2, 'light and dark palettes found');
  sets.forEach(p => ['text', 't2', 't3'].forEach(k => [p.bg, p.surface].forEach(bg => assert.ok(ratio(p[k], bg) >= 4.5, `${k} ${p[k]} on ${bg} is ${ratio(p[k], bg).toFixed(2)}`))));
});

test('a11y: keyboard areas are read from landmarks, and the overlay documents Esc and Enter', async () => {
  const { KEY_GROUPS } = await imp('keys.mjs');
  const listed = KEY_GROUPS.flatMap(g => g.keys.map(k => k[0]));
  assert.ok(listed.includes('Esc') && listed.includes('Enter'));
  const src = fs.readFileSync(path.join(__dirname, '..', 'code', 'muse_ui', 'js', 'keys.mjs'), 'utf8');
  assert.ok(!/data-zone/.test(src), 'areas no longer come from a separate attribute');
  assert.ok(/aria-modal/.test(src) && /role: 'dialog'/.test(src), 'the ? list is a proper dialog');
});

test('a11y: toggle chips announce pressed state and are not marked current', async () => {
  require('./helpers/mini_dom').install(); const { ToggleChip } = await imp('components/chip.mjs');
  const on = ToggleChip({ label: 'Places', href: '#/x', on: true }), off = ToggleChip({ label: 'Years', href: '#/y', on: false });
  assert.strictEqual(on.attrs['aria-pressed'], 'true'); assert.strictEqual(off.attrs['aria-pressed'], 'false');
  assert.strictEqual(on.attrs.role, 'button'); assert.strictEqual(on.attrs['aria-current'], undefined);
});

test('a11y: a screen-specific style never overrides the shared count badge (accent fill needs its own text colour)', () => {
  const css = f => fs.readFileSync(path.join(__dirname, '..', 'code', 'muse_ui', 'css', f), 'utf8');
  const later = ['views.css', 'search.css', 'layout.css'].map(css).join('\n');
  assert.ok(!/(^|\})\s*\.badge\s*\{/m.test(later), 'a bare .badge rule after components.css would override .badge--count; scope it to its screen');
  assert.match(css('components.css'), /\.badge--count\s*\{[^}]*var\(--accent-contrast\)/);
});

test('tray: redrawing the Collection (autosave) keeps focus and caret in the link box being typed in', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'code', 'muse_ui', 'js', 'components', 'tray.mjs'), 'utf8');
  assert.match(src, /document\.activeElement/);
  assert.match(src, /setSelectionRange\(keep\.a, keep\.z\)/);
});
