// Plain-language metadata for each wordplay kind. Data, not code: adding a kind to the detector needs only a line here to get a proper label.
import PACK from './pack_vocab.mjs';
// 'all' is every kind together. The kinds themselves belong to the pack that has wordplay (wordplayKinds in its vocabulary).
export const KINDS = Object.assign({ all: { label: 'All wordplay', blurb: 'Every kind of pair together.' } }, PACK.wordplayKinds);
export const kindLabel = k => (KINDS[k] && KINDS[k].label) || String(k || '').replace(/-/g, ' ').replace(/^./, c => c.toUpperCase());
export const kindBlurb = k => (KINDS[k] && KINDS[k].blurb) || '';
