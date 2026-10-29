import { build } from './router.mjs';
import { kindLabel } from './kinds.mjs';

// The trail for a route, as [{label, href?}]; the last item has no href (it is the current page). Every earlier level links back to
// exactly the state you left it in (same page, same size, the item you came from still highlighted).
// ctx.surface: the title of the open set; ctx.hidden: true in reveal-last mode, so the trail does not give the answer away.
export function trail(route, ctx = {}) {
  const root = { label: 'Connect', href: build('home') };
  if (route.name === 'search') return [root, { label: 'Search' }];
  if (route.name === 'basket') return [root, { label: 'Basket' }];
  if (route.name === 'wordplay') return [root, { label: kindLabel(route.params.kind) }];
  if (route.name === 'set') {
    const q = route.query, out = [root];
    if (q.from === 'basket') out.push({ label: 'Basket', href: build('basket') });
    else if (q.from) out.push({ label: kindLabel(q.from), href: build('wordplay', { kind: q.from }, { page: q.page, size: q.size, sel: ctx.hidden ? '' : route.params.id }) });
    out.push({ label: ctx.hidden ? 'Hidden handle' : (ctx.surface || route.params.id) });
    return out;
  }
  return [{ label: 'Connect' }];
}
