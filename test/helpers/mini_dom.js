'use strict';
// A very small stand-in for the browser's DOM, just enough to render Muse's views and read back their text, links and buttons in a test.
class Node { }
class Text extends Node { constructor(t) { super(); this.nodeType = 3; this.data = String(t); } get textContent() { return this.data; } }
class El extends Node {
  constructor(tag) { super(); this.nodeType = 1; this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.className = ''; this._text = null; this.hidden = false; }
  append(...k) { k.forEach(x => this.children.push(x)); } replaceChildren(...k) { this.children = k; } replaceWith() { } focus() { } remove() { }
  setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; } removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); } querySelector() { return null; } querySelectorAll() { return []; }
  set textContent(v) { this.children = [new Text(v)]; } get textContent() { return this.children.map(c => c.textContent).join(''); }
  get classList() { const s = this; return { add: c => { s.className = (s.className + ' ' + c).trim(); }, remove: c => { s.className = s.className.split(' ').filter(x => x !== c).join(' '); }, toggle() { }, contains: c => s.className.split(' ').includes(c) }; }
  get dataset() { return {}; } get style() { return {}; } get value() { return this._v || ''; } set value(v) { this._v = v; }
}
function install() {
  const store = {};
  global.Node = Node; global.document = { createElement: t => new El(t), createElementNS: (ns, t) => new El(t), createTextNode: t => new Text(t), addEventListener() { }, body: new El('body'), activeElement: new El('x') };
  global.window = { addEventListener() { }, dispatchEvent() { }, scrollY: 0, scrollTo() { }, scrollBy() { }, matchMedia: () => ({ matches: false, addEventListener() { } }) };
  global.CustomEvent = class { constructor(n, o) { this.type = n; this.detail = o && o.detail; } };
  global.location = { hash: '' }; global.history = { replaceState() { } };
  global.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
  global.fetch = async () => ({ ok: true, json: async () => ({}) });
}
const walk = (n, f) => { if (!n || n.nodeType !== 1) return; f(n); n.children.forEach(c => walk(c, f)); };
const all = (n, pred) => { const out = []; walk(n, e => { if (pred(e)) out.push(e); }); return out; };
module.exports = { install, walk, all, El, Text };
