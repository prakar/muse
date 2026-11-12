// The names of Muse's actions and places, in ONE place. The UI, Help and the Muse map all read from here, so renaming one is a one-line change.
// (Route names, server calls, saved-file formats and CSS classes keep their old internal names on purpose: only what you read on screen is here.)
// The shelves, most to least connected (a blood-vessel idiom: veins carry the most, vesicles a little, rivulets a trickle). One place for the names.
export const SHELF_NAME = { all: 'All shelves', veins: 'Veins', grip: 'Vesicles', lone: 'Rivulets' };
export const W = {
  veins: SHELF_NAME.veins, vesicles: SHELF_NAME.grip, rivulets: SHELF_NAME.lone,   // for {tokens} in Help text
  stick: 'In focus',            // the page that shows the one fact you aimed at, and what clings to it: page title, breadcrumb
  home: 'Home',                 // the landing page: the first crumb on every page
  admin: 'Admin',               // the sys admin page, next to Help
  focusEmoji: '\uD83C\uDFAF',   // the target: Focus is about aiming at one fact
  focus: 'Focus',               // button: put this fact in focus on the Stick page, to see what clings to it. Saves nothing.
  inFocus: 'In focus',          // the fact on the Stick page
  recentFocus: 'Recently in focus',
  collect: 'Collect',           // button: add this fact to the Collection (the working pile where you write the links)
  collected: 'Collected',       // the same button once pressed
  collection: 'Collection',     // the working pile (was the "Picked up" tray)
  star: 'Star',                 // button: save this fact or pair for good
  starred: 'Starred',
  // The nudge that says what Focus is, when to use it and what happens. The tooltip is short; the hint is shown on pages full of facts.
  focusTip: 'Aim at this fact: see which other notes share its names, places and dates.',
  focusHintShort: 'Focus a fact to see what connects to it. Collect the ones that fit.',
  focusHint: 'Focus on any fact to see what other notes connect to it, through the names, places, years and other hooks it shares. Then Collect the ones that fit a question.'            // the place your starred things live (was the Basket), and the state of a starred fact
};

// Help text is written with {focus}, {collection} and so on; this swaps in the words above. {{ and }} are not special: a missing name throws, so a typo cannot ship.
export const fill = s => typeof s === 'string' ? s.replace(/\{(\w+)\}/g, (m, k) => { if (!(k in W)) throw new Error('Unknown word {' + k + '} in Help text'); return W[k]; }) : Array.isArray(s) ? s.map(fill) : s && typeof s === 'object' ? Object.fromEntries(Object.entries(s).map(([k, v]) => [k, fill(v)])) : s;
