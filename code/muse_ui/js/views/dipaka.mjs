import { h } from '../dom.mjs';
import { build } from '../router.mjs';
import { Button } from '../components/button.mjs';
import { Prose } from '../components/prose.mjs';
import { tray, loadTray } from '../components/tray.mjs';
import { toast } from '../components/toast.mjs';
import { parse } from '../markdown.mjs';
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
const Answer = (thread, api, onChange) => h('div', { class: 'dipaka__answer' }, Prose(parse(thread.response)),
  h('p', { class: 'hint', text: 'Unverified. ' + (thread.model || 'The model') + ' wrote this from the facts you gave it; it is not from your notes and has not been checked. ' + usd(thread.cost) }),
  h('div', { class: 'toolbar' }, Labels({ thread, api, onChange }),
    Button({ label: 'Copy answer', ic: 'copy', size: 'sm', onClick: async () => { try { await navigator.clipboard.writeText(thread.response); toast({ text: 'Copied. Paste it into a note in Obsidian if it is worth keeping.' }); } catch (e) { toast({ text: 'The browser blocked copy. Select the text and copy it by hand.' }); } } })));

export async function dipakaView({ api }) {
  await loadTray();
  const items = tray.items(), ids = items.map(i => i.id), links = {};
  for (let i = 0; i < items.length - 1; i++) { const t = tray.link(items[i].id, items[i + 1].id); if (t) links[items[i].id + '>' + items[i + 1].id] = t; }
  const [info, pv] = await Promise.all([api.dipaka(), ids.length ? api.dipakaPreview({ ids, links }).catch(e => ({ error: e.message })) : Promise.resolve(null)]);
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
  const showMoney = () => { money.textContent = 'About ' + usd(pv.estimate.usd) + ' (' + pv.estimate.tokensIn + ' tokens in, answer up to a few thousand out) with ' + info.provider + '. Spent today: ' + usd(info.spentToday) + '.'
    + (pv.key ? '' : ' No ' + info.provider + ' key is set on this machine, so this cannot run here.') + (pv.missing.length ? ' ' + pv.missing.length + ' fact(s) are not in this database and were left out.' : ''); };
  showMoney();
  const run = Button({ label: W.illuminate, ic: 'search', onClick: async () => {
    run.disabled = true; out.replaceChildren(h('p', { class: 'hint', text: 'Waiting for the model. This can take a minute.' }));
    try { const r = await api.dipakaRun({ packet: box.value, seeds: ids }); info.threads.unshift(r.thread); info.spentToday += r.thread.cost || 0; showMoney(); drawHistory();
      out.replaceChildren(h('h2', { text: 'The answer' }), Answer(r.thread, api, drawHistory)); }
    catch (e) { out.replaceChildren(h('p', { class: 'notice', role: 'status', text: e.message })); }
    finally { run.disabled = false; } } });
  const reset = Button({ label: 'Reset packet', variant: 'ghost', onClick: () => { box.value = pv.packet; } });
  const node = h('div', {}, head,
    h('section', { class: 'section' }, h('h2', {}, 'What will be sent', h('small', { text: String(pv.facts) + ' facts' })),
      h('p', { class: 'hint', text: 'Built from your ' + W.collection + ' and the lines you wrote between facts. Read it, change anything you like, then ' + W.illuminate + '. Nothing is sent until you press the button.' }),
      box, money, h('div', { class: 'toolbar' }, run, reset)),
    out, history);
  return { node, title: W.dipaka };
}
