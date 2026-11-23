import { h, mount } from '../dom.mjs';
import { Button } from '../components/button.mjs';
import { guide, slug, OTHER } from '../pack_guide.mjs';

// Admin, first tab: Profile. Which profile this copy of Muse runs, the ones installed, and what it takes to add another. Choosing an installed one is the one
// action here: it asks you to confirm, writes `pack:` into muse.yaml, and says plainly that nothing changes until Muse is restarted. It never switches a running Muse.
const SOURCE = { env: 'The MUSE_PACK environment variable is set and decides this; muse.yaml is ignored while it is.', file: 'It comes from muse.yaml.', default: 'There is no muse.yaml, so Muse uses its default.' };

export function profileTab({ api, meta }) {
  const pk = (meta && meta.pack) || {}, rows = Array.isArray(pk.catalogue) ? pk.catalogue : [];
  const out = h('div', { class: 'profile__out', 'aria-live': 'polite' });
  const sel = h('select', { class: 'field', 'aria-label': 'Occupation' }, rows.map(r => h('option', { value: r.id, text: r.label + (r.active ? ' (running now)' : r.installed ? ' (installed)' : ' (not installed)') })), h('option', { value: OTHER, text: 'Something else…' }));
  const box = h('input', { type: 'text', class: 'field', placeholder: 'Your occupation or field', 'aria-label': 'Your occupation or field', maxlength: '60' });
  let confirming = false, result = null;
  const current = () => sel.value === OTHER ? null : rows.find(r => r.id === sel.value);
  const draw = () => {
    const other = sel.value === OTHER; box.hidden = !other;
    const row = current(), label = other ? box.value : row && row.label, g = guide(label, other ? slug(box.value) : sel.value, row);
    const kids = [h('h3', { text: g.heading })];
    if (result && result.ok) {
      kids.push(h('div', { class: 'fresh fresh--stale profile__done', role: 'alert' }, h('p', { text: 'muse.yaml now says  pack: ' + result.pack + '.' }),
        h('p', { text: 'Muse is still running the old profile. Run  muse restart  and the new one starts. ' + (result.envOverrides ? 'The MUSE_PACK environment variable is set and will override this file until you unset it. ' : '') + (result.backup ? 'The previous file was kept as ' + result.backup + '.' : '') })));
    } else {
      (g.state === 'installed' ? ['This profile is installed (packs/' + row.id + '), but Muse is not running it. A copy of Muse runs one profile, chosen when Muse starts.', 'Use this profile writes the choice into muse.yaml. It takes effect at the next restart.'] : g.lines).forEach(t => kids.push(h('p', { text: t })));
      if (g.steps) kids.push(h('ol', {}, g.steps.map(s => h('li', { text: s }))));
      if (g.foot) kids.push(h('p', { class: 'hint', text: g.foot }));
      if (result && result.error) kids.push(h('p', { class: 'drift__bad', role: 'alert', text: result.error }));
      if (g.state === 'installed') {
        if (!confirming) kids.push(h('div', { class: 'toolbar' }, Button({ label: 'Use this profile', ic: 'check', size: 'sm', onClick: () => { confirming = true; result = null; draw(); } })));
        else kids.push(h('div', { class: 'fresh fresh--stale profile__confirm', role: 'alertdialog', 'aria-label': 'Confirm the profile change' },
          h('p', { text: 'Write  pack: ' + row.id + '  into muse.yaml? Nothing running changes until you restart Muse. Facts already extracted keep the vocabulary they were extracted with, and notes extracted after the restart use ' + row.label + '. It is safest to try it on a copy of your vault first.' }),
          h('div', { class: 'toolbar' },
            Button({ label: 'Write muse.yaml', ic: 'check', size: 'sm', onClick: async function () { try { result = await api.adminProfile(row.id); } catch (e) { result = { error: (e && e.message) || 'Could not write muse.yaml.' }; } confirming = false; draw(); } }),
            Button({ label: 'Cancel', variant: 'ghost', size: 'sm', onClick: () => { confirming = false; draw(); } }))));
      }
    }
    mount(out, kids);
  };
  sel.addEventListener('change', () => { confirming = false; result = null; draw(); }); box.addEventListener('input', draw);
  const active = rows.find(r => r.active); if (active) sel.value = active.id;
  draw();
  return h('section', { class: 'flow__group profile', 'aria-label': 'Profile' },
    h('div', { class: 'band__head' }, h('h3', { class: 'col__title', text: 'Profile' }), h('p', { class: 'col__hint hint', text: 'Do this first: the profile decides what Muse extracts and tags. ' + (SOURCE[pk.source] || '') })),
    h('p', { class: 'profile__now', text: 'Running now: ' + (active ? active.label : pk.name || 'unknown') + '.' }),
    h('div', { class: 'profile__pick' }, sel, box), out);
}
