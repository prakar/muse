import { h } from '../dom.mjs';
import { build } from '../router.mjs';
import { Button } from '../components/button.mjs';
import { Prose } from '../components/prose.mjs';
import { tray, loadTray } from '../components/tray.mjs';
import { toast } from '../components/toast.mjs';
import { parse } from '../markdown.mjs';
import { getPref, setPref } from '../prefs.mjs';
import { W } from '../words.mjs';

// Dipaka: the lamp. The facts in your Collection go into a packet you can read and edit; one press sends it to the strongest model, which tells you related things
// you did not ask because you did not know enough to ask. The answer is learning material for you, kept in muse-dipaka.jsonl and never written into your notes
// or counted as a verified fact. If something is worth keeping, write the note yourself in Obsidian (Copy answer helps).
const NO_LABEL = 'clear';   // what the server takes to remove a label
export const LABEL_NAME = { yielded: 'Yielded', generic: 'Generic', 'already-knew': 'Already knew', wrong: 'Wrong or loaded' };
const LABEL_HINT = { yielded: 'It taught me something worth following up.', generic: 'True, but it could have been said of any facts.', 'already-knew': 'Nothing here was new to me.', wrong: 'It was mistaken, or it loaded the question.' };
export const usd = n => n == null ? '' : n < 0.01 ? '$' + n.toFixed(4) : '$' + n.toFixed(2);

function Labels({ thread, api, onChange }) {
  const row = h('div', { class: 'seg', role: 'group', 'aria-label': 'What was this answer worth?' });
  const draw = () => row.replaceChildren(...Object.keys(LABEL_NAME).map(k => Button({ label: LABEL_NAME[k], size: 'sm', pressed: thread.label === k, title: LABEL_HINT[k],
    onClick: async () => { try { const r = await api.dipakaLabel({ id: thread.id, label: thread.label === k ? NO_LABEL : k }); thread.label = r.thread.label; draw(); onChange && onChange(); } catch (e) { toast({ text: e.message }); } } })));
  draw(); return row;
}
// Permanent, on every answer. Asking a model to fill gaps is a fuzzy match by design, so it will sometimes invent. A wrong detail can still be a useful lead (a mix-up led to the right name once), but nothing goes into the vault unchecked.
const CAUTION = 'The nature of this query can produce hallucinations. Itemise and check every claim before committing it to the vault.';
// Delete is two presses: the first arms it for a few seconds, the second removes the answer, its packet and its label from muse-dipaka.jsonl for good.
const SURE = 'Press again to delete';
function Delete({ thread, api, box, onChange }) {
  let armed = null;
  const say = t => { btn.lastElementChild.textContent = t; };
  const btn = Button({ label: 'Delete', size: 'sm', title: 'Remove this answer from muse-dipaka.jsonl for good.', onClick: async () => {
    if (!armed) { armed = setTimeout(() => { armed = null; say('Delete'); }, 4000); say(SURE); return; }
    clearTimeout(armed); armed = null;
    try { await api.dipakaDelete({ id: thread.id }); box.replaceChildren(h('p', { class: 'hint', role: 'status', text: 'Deleted.' })); onChange && onChange(); } catch (e) { toast({ text: e.message }); say('Delete'); } } });
  return btn;
}
export const Answer = (thread, api, onChange) => { const box = h('div', { class: 'dipaka__answer' }); box.append(...answerParts(thread, api, onChange, box)); return box; };
const answerParts = (thread, api, onChange, box) => [ h('p', { class: 'hint dipaka__caution', role: 'note', text: CAUTION }), Prose(parse(thread.response)),
  h('p', { class: 'hint', text: 'Unverified. ' + (thread.model || 'The model') + ' wrote this from the facts you gave it; it is not from your notes and has not been checked. ' + usd(thread.cost) }),
  h('div', { class: 'toolbar' }, Labels({ thread, api, onChange }),
    Button({ label: 'Copy answer', ic: 'copy', size: 'sm', onClick: async () => { try { await navigator.clipboard.writeText(thread.response); toast({ text: 'Copied. Paste it into a note in Obsidian if it is worth keeping.' }); } catch (e) { toast({ text: 'The browser blocked copy. Select the text and copy it by hand.' }); } } }),
    Delete({ thread, api, box, onChange }))];

export async function dipakaView({ api }) {
  await loadTray();
  const items = tray.items(), ids = items.map(i => i.id), links = {};
  for (let i = 0; i < items.length - 1; i++) { const t = tray.link(items[i].id, items[i + 1].id); if (t) links[items[i].id + '>' + items[i + 1].id] = t; }
  const info = await api.dipaka(), usable = info.providers.filter(p => p.key).map(p => p.id), saved = getPref('dipakaProvider', null);
  let chosen = usable.includes(saved) ? saved : usable.includes(info.provider) ? info.provider : usable[0] || info.provider;   // the saved choice, else the server's default, else any provider that has a key
  let pv = ids.length ? await api.dipakaPreview({ ids, links, provider: chosen }).catch(e => ({ error: e.message })) : null;
  const head = h('div', { class: 'page-head' }, h('h1', { text: W.dipaka }),
    h('p', { text: 'Gather facts in your ' + W.collection + ', then ' + W.illuminate + ': one model call that tells you related things you did not think to ask. It is learning material for you, not a fact from your notes.' }));
  const out = h('section', { class: 'section', 'aria-live': 'polite' });
  const history = h('section', { class: 'section' });
  const drawHistory = () => {
    history.replaceChildren(); if (!info.threads.length) return;
    history.append(h('h2', {}, 'Earlier answers', h('small', { text: String(info.threads.length) })));
    info.threads.forEach(t => history.append(h('details', { class: 'dipaka__old' }, h('summary', { text: new Date(t.ts).toLocaleString() + ' · ' + t.seeds.length + ' facts · ' + usd(t.cost) + (t.label ? ' · ' + LABEL_NAME[t.label] : '') }), Answer(t, api, drawHistory))));
  };
  drawHistory();
  if (!ids.length) return { node: h('div', {}, head, h('p', { class: 'empty', text: 'Your ' + W.collection + ' is empty. Press ' + W.collect + ' on facts that belong together, then come back.' }), history), title: W.dipaka };
  if (pv.error) return { node: h('div', {}, head, h('p', { class: 'notice', role: 'status', text: pv.error }), history), title: W.dipaka };

  const box = h('textarea', { class: 'dipaka__packet', rows: '16', 'aria-label': 'What will be sent', spellcheck: 'false', maxlength: '30000' }); box.value = pv.packet;
  const money = h('p', { class: 'hint', role: 'status' });
  const showMoney = () => { money.textContent = 'About ' + usd(pv.estimate.usd) + ' (' + pv.estimate.tokensIn + ' tokens in, answer up to a few thousand out) with ' + (pv.model ? pv.model.id + ' (' + (pv.profile || 'economy') + ' profile, ' + pv.model.source + ')' : chosen + ', model chosen when it runs') + '. Spent today: ' + usd(info.spentToday) + '.'
    + (pv.key ? '' : ' No ' + chosen + ' key is set on this machine, so this cannot run with it.') + (pv.missing.length ? ' ' + pv.missing.length + ' fact(s) are not in this database and were left out.' : ''); };
  showMoney();
  const sel = h('select', { id: 'dipaka-provider', class: 'dipaka__provider' }, info.providers.map(p => h('option', { value: p.id, text: p.id + (p.key ? '' : ' (no key on this machine)') })));
  sel.value = chosen;
  sel.addEventListener('change', async () => { chosen = sel.value; setPref('dipakaProvider', chosen);
    try { const r = await api.dipakaPreview({ ids, links, provider: chosen }); pv.estimate = r.estimate; pv.key = r.key; pv.model = r.model; showMoney(); } catch (e) { money.textContent = e.message; } });
  const run = Button({ label: W.illuminate, ic: 'search', onClick: async () => {
    run.disabled = true; out.replaceChildren(h('p', { class: 'hint', text: 'Waiting for the model. This can take a minute.' }));
    try { const r = await api.dipakaRun({ packet: box.value, seeds: ids, provider: chosen }); info.threads.unshift(r.thread); info.spentToday += r.thread.cost || 0; showMoney(); drawHistory();
      out.replaceChildren(h('h2', { text: 'The answer' }), Answer(r.thread, api, drawHistory)); }
    catch (e) { out.replaceChildren(h('p', { class: 'notice', role: 'status', text: e.message }), h('p', { class: 'hint', text: 'Nothing was kept. If this is the provider’s own limit or an outage, choose another provider above and press ' + W.illuminate + ' again.' })); }
    finally { run.disabled = false; } } });
  const reset = Button({ label: 'Reset packet', variant: 'ghost', onClick: () => { box.value = pv.packet; } });
  const node = h('div', {}, head,
    h('section', { class: 'section' }, h('h2', {}, 'What will be sent', h('small', { text: String(pv.facts) + ' facts' })),
      h('p', { class: 'hint', text: 'Built from your ' + W.collection + ' and the lines you wrote between facts. Read it, change anything you like, then ' + W.illuminate + '. Nothing is sent until you press the button.' }),
      box, money, h('div', { class: 'toolbar' }, h('label', { for: 'dipaka-provider', class: 'toolbar__label', text: 'Provider' }), sel, run, reset)),
    out, history);
  return { node, title: W.dipaka };
}
