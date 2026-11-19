// The plain names of the hook kinds (a kind is the type of a hook: a name, a place, a year...). One list, used by Home, Browse and the trail.
export const TYPE_LABEL = { entity: 'Names & things', place: 'Places', time: 'Years & dates', day: 'Days', number: 'Numbers', material: 'Materials', etymon: 'Word roots', set: 'Sets & groups',
  mechanism: 'Mechanisms', title: 'Titles', 'former-role': 'Former roles', uniqueness: 'Superlatives & firsts', homonym: 'Same word, other sense' };
export const typeLabel = t => TYPE_LABEL[t] || String(t || '').replace(/-/g, ' ').replace(/^./, c => c.toUpperCase());
