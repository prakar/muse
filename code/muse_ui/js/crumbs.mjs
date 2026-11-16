import { build } from './router.mjs';
import { kindLabel } from './kinds.mjs';
import { typeLabel } from './kind_labels.mjs';
import { W } from './words.mjs';

// The trail for a route, as [{label, href?}]; the last item has no href (it is the current page). Every earlier level links back to
// exactly the state you left it in (same page, same size, the item you came from still highlighted), so each crumb is also a zoom-out.
// ctx.surface: the title of the open set; ctx.hidden: true in reveal-last mode, so the trail does not give the answer away.
import { SHELF_NAME } from './words.mjs';
export const SHELF_LABEL = { veins: SHELF_NAME.veins, grip: SHELF_NAME.grip, lone: SHELF_NAME.lone, loops: 'Loops' };
export function trail(route, ctx = {}) {
  const root = { label: W.home, href: build('home') };
  if (route.name === 'home') return homeTrail(route, root);
  if (route.name === 'help') return [root, { label: 'Help' }];
  if (route.name === 'admin') return [root, { label: W.admin }];
  if (route.name === 'dipaka') return [root, { label: W.dipaka }];
  if (route.name === 'stick') return [root, { label: W.stick }];
  if (route.name === 'search') return [root, { label: 'Search' }];
  if (route.name === 'basket') return [root, { label: W.starred }];
  if (route.name === 'set') {
    const q = route.query, out = [root];
    if (q.from === 'basket') out.push({ label: W.starred, href: build('basket') });
    else if (q.from) out.push({ label: kindLabel(q.from), href: build('home', {}, { wp: q.from, wpage: q.wpage, wsize: q.wsize, sel: ctx.hidden ? '' : route.params.id }) });
    out.push({ label: ctx.hidden ? 'Hidden handle' : (ctx.surface || route.params.id) });
    return out;
  }
  return [{ label: W.home }];
}

// Home's trail follows whichever block you used last. Facts: Home > shelf > kinds > overlays. Wordplay: Home > Wordplay > the trick.
// "All shelves", "All kinds" and "All wordplay" are not steps. Clicking a step drops everything after it, so each crumb is one zoom-out.
function homeTrail(route, root) {
  const q = route.query;
  if (q.focus) return [root, { label: W.inFocus }];
  if (q.wp) {
    const w = { label: 'Wordplay', href: build('home', {}, { wp: 'all' }) }, k = { label: kindLabel(q.wp), href: build('home', {}, { wp: q.wp, wpage: q.wpage, wsize: q.wsize, sel: q.pair }) };
    if (q.pair) return q.wp === 'all' ? [root, w, { label: q.pair }] : [root, w, k, { label: q.pair }];   // an opened pair is one more step down
    return q.wp === 'all' ? [root, { label: 'Wordplay' }] : [root, w, { label: kindLabel(q.wp) }];
  }
  const shelf = SHELF_LABEL[q.shelf] ? q.shelf : '', types = String(q.type || '').split(',').filter(Boolean), every = q.match === 'every' && types.length > 1, steps = [], at = {};
  if (shelf) { at.shelf = shelf; steps.push({ label: SHELF_LABEL[shelf], href: build('home', {}, { ...at }) }); }
  if (types.length) { at.type = types.join(','); if (every) at.match = 'every'; steps.push({ label: types.map(typeLabel).join(every ? ' + ' : ' or '), href: build('home', {}, { ...at }) }); }
  if (q.loops) { at.loops = '1'; steps.push({ label: 'Loops', href: build('home', {}, { ...at }) }); }
  if (q.yours) { at.yours = '1'; steps.push({ label: 'Yours', href: build('home', {}, { ...at }) }); }
  if (!steps.length) return [{ label: W.home }];
  return [root, ...steps.map((st, i) => i === steps.length - 1 ? { label: st.label } : st)];
}
