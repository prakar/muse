// "Using Muse as a ...": what to tell someone who picks an occupation. Muse is set up for ONE profile per clone (the folder packs/<id> named in muse.yaml),
// so this never switches anything: it says whether the profile is active, installed, or missing, and for a missing one, how the person builds it.
// Pure functions, so they can be tested without a browser.
export const OTHER = '__other__';
export const slug = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'my-field';

export function guide(label, id, row) {
  const name = String(label || '').trim() || 'your field';
  if (row && row.active) return { state: 'active', heading: 'Active: ' + row.label,
    lines: ['Muse in this copy is set up as: ' + row.label + '. Its words, shapes and extraction rules come from the folder packs/' + row.id + '.'] };
  if (row && row.installed) return { state: 'installed', heading: row.label + ': installed, not active',
    lines: ['A profile for ' + row.label + ' is installed (packs/' + row.id + ') but this copy of Muse is not using it. A copy of Muse runs one profile.',
      'To use it: set  pack: ' + row.id + '  in muse.yaml and restart Muse. Facts already extracted keep the kinds and hooks they were extracted with; the new profile applies to notes extracted from then on, so try it on a copy of your vault first.'] };
  const pid = id || slug(name);
  return { state: 'missing', heading: name + ': not enabled',
    lines: ['There is no profile for ' + name + ' in this copy of Muse, so this option is not enabled. Muse is not switched between professions from this page: a copy is cloned and set up for one profile.',
      'To use Muse as a ' + name.toLowerCase() + ', the profile has to come from someone who knows the field. What they bring:'],
    steps: [
      'Benchmark material: examples of how good work in the field links facts. From it, draw up a list of patterns, each with a name.',
      'Run  npm run pack:new -- ' + pid + '  to create packs/' + pid + ' from the neutral profile.',
      'Edit packs/' + pid + '/pack.json: what a fact is in this field (kinds), what joins facts (hook types such as statute, party, date), and the one-line purpose.',
      'Write the shapes to look for in packs/' + pid + '/lenses.json and shapes.json. Start with the two that come with the neutral profile and add yours.',
      'Run  npm run pack:check -- ' + pid + '  until it passes.',
      'Set  pack: ' + pid + '  in muse.yaml, restart, and try it on a copy of your vault before a full extraction (extraction costs model calls).'],
    foot: 'The full guide is PACKS.md in the Muse repository.' };
}
