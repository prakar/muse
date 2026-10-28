// A small, safe Markdown reader for Obsidian-style notes: it produces a data tree (never HTML strings), so nothing from a note can inject markup.
// Supported: frontmatter (skipped), headings, paragraphs, bullet/numbered/task lists with nesting, block quotes, fenced code, rules, tables,
// **bold**, *italic*, ==mark==, `code`, [links](url), [[wikilinks|alias]], bare URLs. Embeds and images show as plain text.
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const SAFE_URL = /^(https?:|mailto:)/i;
const FRONTMATTER = /^---\n[\s\S]*?\n---\n?/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const indentOf = s => s.match(/^\s*/)[0].length;
const startsBlock = l => /^(#{1,6}\s|\s*(```|~~~)|\s*>|\s*([-*_])(\s*\3){2,}\s*$)/.test(l) || LIST.test(l);

export function parse(src) {
  return blocks(String(src || '').replace(/\r\n?/g, '\n').replace(FRONTMATTER, '').split('\n'));
}

function blocks(lines) {
  const out = []; let i = 0;
  while (i < lines.length) {
    const line = lines[i]; let m;
    if (!line.trim()) { i++; continue; }
    if ((m = line.match(/^\s*(```|~~~)\s*([\w+-]*)/))) {
      const buf = []; i++;
      while (i < lines.length && !lines[i].trim().startsWith(m[1])) buf.push(lines[i++]);
      i++; out.push({ t: 'code', lang: m[2], text: buf.join('\n') }); continue;
    }
    if ((m = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/))) { out.push({ t: 'h', level: m[1].length, c: inline(m[2]) }); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push({ t: 'hr' }); i++; continue; }
    if (/^\s*>/.test(line)) {
      const buf = []; while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push({ t: 'quote', c: blocks(buf) }); continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => inline(c.trim()));
      const head = cells(line), rows = []; i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push({ t: 'table', head, rows }); continue;
    }
    if (LIST.test(line)) { const r = list(lines, i); out.push(r.node); i = r.next; continue; }
    const buf = [line]; i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) buf.push(lines[i++]);
    out.push({ t: 'p', c: inline(buf.map(s => s.trim()).join(' ')) });
  }
  return out;
}

function list(lines, start) {
  const first = lines[start].match(LIST), base = first[1].length, ordered = /\d/.test(first[2]), items = []; let i = start;
  while (i < lines.length) {
    const m = lines[i].match(LIST);
    if (!m || m[1].length !== base) break;
    let text = m[3], checked = null; const t = text.match(/^\[( |x|X)\]\s+(.*)$/);
    if (t) { checked = t[1] !== ' '; text = t[2]; }
    const sub = []; i++;
    while (i < lines.length && lines[i].trim() && indentOf(lines[i]) > base) sub.push(lines[i++]);
    const min = sub.length ? Math.min(...sub.map(indentOf)) : 0;
    items.push({ t: 'li', checked, c: inline(text), sub: blocks(sub.map(s => s.slice(min))) });
  }
  return { node: { t: ordered ? 'ol' : 'ul', items }, next: i };
}

const RULES = [
  ['code', /`([^`\n]+)`/], ['embed', /!\[\[([^\]]+)\]\]/], ['image', /!\[([^\]]*)\]\([^)]*\)/],
  ['wiki', /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/], ['link', /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/],
  ['strong', /\*\*(.+?)\*\*|__(.+?)__/], ['mark', /==(.+?)==/], ['em', /\*(?![\s*])(.+?)\*|(?<![\w])_(?![\s_])(.+?)_(?![\w])/], ['url', /https?:\/\/[^\s<>)\]]+/]
];

export function inline(text) {
  const out = []; let rest = String(text);
  const push = v => { if (v) { const last = out[out.length - 1]; if (last && last.t === 'text') last.v += v; else out.push({ t: 'text', v }); } };
  while (rest) {
    let best = null;
    for (const [name, re] of RULES) { const m = re.exec(rest); if (m && (!best || m.index < best.m.index)) best = { name, m }; }
    if (!best) { push(rest); break; }
    const { name, m } = best; push(rest.slice(0, m.index)); rest = rest.slice(m.index + m[0].length);
    const body = m[1] != null ? m[1] : m[2];
    if (name === 'code') out.push({ t: 'code', v: m[1] });
    else if (name === 'embed') push(m[1]);
    else if (name === 'image') push(m[1] || 'image');
    else if (name === 'wiki') out.push({ t: 'wiki', target: m[1].trim(), c: [{ t: 'text', v: (m[2] || m[1]).trim() }] });
    else if (name === 'link') SAFE_URL.test(m[2]) ? out.push({ t: 'link', href: m[2], c: inline(m[1]) }) : push(m[1]);
    else if (name === 'url') out.push({ t: 'link', href: m[0], c: [{ t: 'text', v: m[0] }] });
    else out.push({ t: name, c: inline(body) });
  }
  return out;
}

export function plain(nodes) {
  return (nodes || []).map(n => n.v != null ? n.v : n.c ? plain(n.c) : '').join('');
}

// The text blocks of a document in reading order: headings, paragraphs and list items (the places a quote can live).
export function leaves(tree, out = []) {
  tree.forEach(b => {
    if (b.t === 'p' || b.t === 'h') out.push(b);
    else if (b.t === 'quote') leaves(b.c, out);
    else if (b.t === 'ul' || b.t === 'ol') b.items.forEach(it => { out.push(it); leaves(it.sub, out); });
    else if (b.t === 'table') b.rows.forEach(r => out.push({ t: 'row', c: [].concat(...r) }));
  });
  return out;
}

const norm = s => String(s).toLowerCase().replace(/[*_`=[\]()"'‘’“”]/g, '').replace(/\s+/g, ' ').trim();
// The leaf that holds a quote (matched on its opening words, then a middle slice, to survive small formatting differences), or null.
export function locate(tree, quote) {
  const q = norm(quote); if (q.length < 12) return null;
  const probes = [q.slice(0, 48), q.slice(Math.max(0, (q.length >> 1) - 24), (q.length >> 1) + 24)];
  const all = leaves(tree);
  for (const p of probes) { const hit = all.find(l => norm(plain(l.c)).includes(p)); if (hit) return hit; }
  return null;
}
