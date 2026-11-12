import { Button } from './button.mjs';
import { api } from '../api.mjs';
import { W } from '../words.mjs';

// Star for a fact that is shown on its own (a search result, the fact in focus, a shelf card), so it belongs to no handle. It is saved as a star on the
// fact itself; pressing it again removes the star everywhere, even one made earlier under a handle. `it.starred` is the state the server reported.
export function StarButton(it, via = 'direct') {
  let on = !!it.starred;
  const b = Button({ ic: 'star', extra: 'btn--star', size: 'sm', label: on ? W.starred : W.star, pressed: on, title: on ? 'Remove the star' : 'Star this fact: save it for good' });
  b.addEventListener('click', async () => {
    try { const r = await api.mark({ handle: '*', item: it.id, mark: on ? 'clear' : 'use', ctx: { via, note: it.note } }); on = r.mark === 'use'; it.starred = on; window.dispatchEvent(new CustomEvent('muse:marks', { detail: r.marks })); }
    catch (e) { return; }
    b.setAttribute('aria-pressed', String(on)); b.title = on ? 'Remove the star' : 'Star this fact: save it for good'; b.querySelector('span:last-child').textContent = on ? W.starred : W.star;
  });
  return b;
}
