// Pure paging maths. No DOM, so it is unit-tested in node.
export const LANDMARKS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
export const pageCount = (total, size) => Math.max(1, Math.ceil(total / Math.max(1, size)));
export const clampPage = (p, pages) => Math.min(Math.max(parseInt(p, 10) || 1, 1), Math.max(1, pages));
export const rangeOf = (page, size, total) => total ? { from: (page - 1) * size + 1, to: Math.min(page * size, total) } : { from: 0, to: 0 };

// Which page links to show: the ends, a window around the current page, and landmark jumps (10, 25, 50, 100 ...) so any page is a couple of clicks away.
// A gap of exactly one page shows that page instead of an ellipsis. Returns numbers and the string 'gap'.
export function pageStops(current, pages) {
  if (pages <= 9) return Array.from({ length: pages }, (_, i) => i + 1);
  const keep = new Set([1, pages]);
  for (let p = current - 2; p <= current + 2; p++) if (p >= 1 && p <= pages) keep.add(p);
  if (current <= 3) keep.add(2), keep.add(3);
  LANDMARKS.forEach(p => { if (p < pages) keep.add(p); });
  const sorted = [...keep].sort((a, b) => a - b), out = [];
  sorted.forEach((p, i) => {
    if (i) { const gap = p - sorted[i - 1]; if (gap === 2) out.push(p - 1); else if (gap > 2) out.push('gap'); }
    out.push(p);
  });
  return out;
}
