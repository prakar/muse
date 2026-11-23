// The plain names of the hook kinds (a kind is the type of a hook: a name, a place, a year...). One list, used by Home, Browse and the trail.
import PACK from './pack_vocab.mjs';
// The hook types every pack has. A pack's own (typeLabels in its vocabulary) are added to them.
export const TYPE_LABEL = Object.assign({ entity: 'Names & things', place: 'Places', time: 'Years & dates', day: 'Days', number: 'Numbers', title: 'Titles' }, PACK.typeLabels);
export const typeLabel = t => TYPE_LABEL[t] || String(t || '').replace(/-/g, ' ').replace(/^./, c => c.toUpperCase());
