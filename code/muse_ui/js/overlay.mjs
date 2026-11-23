// A pack adds to the core's list of features or recipes, or rewords one. An entry with a key the core already has PATCHES that row (its fields replace the
// core's); a field named like "buttons+" APPENDS its list to the core's "buttons" instead of replacing it; a new key is inserted after the row named in
// `after` (or at the end). Pure; the core list is never changed.
export function overlay(core, extra) {
  const out = core.map((x) => Object.assign({}, x));
  (extra || []).forEach((e) => {
    const row = Object.assign({}, e); delete row.after;
    const i = out.findIndex((x) => x.key === e.key);
    if (i >= 0) {
      Object.keys(row).filter((k) => /\+$/.test(k)).forEach((k) => { const base = k.slice(0, -1); out[i][base] = (out[i][base] || []).concat(row[k]); delete row[k]; });
      out[i] = Object.assign(out[i], row); return;
    }
    const j = e.after ? out.findIndex((x) => x.key === e.after) : -1;
    if (j >= 0) out.splice(j + 1, 0, row); else out.push(row);
  });
  return out;
}
