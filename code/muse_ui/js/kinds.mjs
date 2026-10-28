// Plain-language metadata for each wordplay kind. Data, not code: adding a kind to the detector needs only a line here to get a proper label.
export const KINDS = {
  all: { label: 'All wordplay', blurb: 'Every kind of pair together.' },
  'anagram-pair': { label: 'Anagram pairs', blurb: 'Two names made from exactly the same letters.' },
  'one-letter-off': { label: 'One letter apart', blurb: 'Two names that differ by a single letter.' },
  'head-tail': { label: 'Letter dropped', blurb: 'A name that becomes another word when its first or last letter is dropped.' },
  homophone: { label: 'Sound-alikes', blurb: 'A name and an everyday word that sound exactly alike.' },
  'anagram-of-word': { label: 'Anagram of a word', blurb: 'A name whose letters rearrange into an everyday word.' },
  'hidden-word': { label: 'Hidden word', blurb: 'A name with another word hiding inside it.' },
  reversal: { label: 'Backwards', blurb: 'A name that spells another name when read backwards.' },
  'digit-lookalike': { label: 'Digit look-alike', blurb: 'A name where letters stand in for digits.' }
};
export const kindLabel = k => (KINDS[k] && KINDS[k].label) || String(k || '').replace(/-/g, ' ').replace(/^./, c => c.toUpperCase());
export const kindBlurb = k => (KINDS[k] && KINDS[k].blurb) || '';
