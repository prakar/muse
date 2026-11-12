import { h } from '../dom.mjs';
import { tidyTitle } from '../tidy.mjs';

// The title of a note, as a link that opens the full note beside the page. Used everywhere a fact names its note. It asks main.mjs to open the note
// (an event, so a card needs no navigation wiring). With no note id, or while the handle is hidden (the title would give the answer away), it is plain text.
export const NOTE_EVENT = 'muse:open-note';
export function NoteLink({ text, noteId, at, locked, extra = '' }) {
  text = tidyTitle(text);
  const cls = 'fact__note' + (extra ? ' ' + extra : '');
  if (locked || noteId == null || noteId === '') return h('span', { class: cls, text: text || '', title: locked ? 'Available once the handle is revealed' : null });
  return h('a', { class: cls + ' fact__note--link', href: '#', title: 'Read the whole note beside this page', text: text || 'Open note',
    onclick: e => { e.preventDefault(); document.dispatchEvent(new CustomEvent(NOTE_EVENT, { detail: { noteId, at } })); } });
}

// The fact itself is a title too: clicking the sentence opens the note it came from, same as the note's name above it.
export function ClaimLink({ text, noteId, at, locked }) {
  if (locked || noteId == null || noteId === '') return h('p', { class: 'fact__claim', text: text || '' });
  return h('p', { class: 'fact__claim' }, h('a', { class: 'fact__claimlink', href: '#', title: 'Read the whole note beside this page', text: text || '',
    onclick: e => { e.preventDefault(); document.dispatchEvent(new CustomEvent(NOTE_EVENT, { detail: { noteId, at } })); } }));
}
