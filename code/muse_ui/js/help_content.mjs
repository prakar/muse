// The words of the Help page, as data, so they can be corrected without touching layout code. A test checks that every link points at a real screen.
// Step items are strings, or { t: text, href } for a step that links to a screen. Labels are the exact button names in the interface.

import { DATA } from './muse_map.mjs';
import { fill } from './words.mjs';

// Names of actions and places are tokens ({focus}, {collect}, {collection}, {star}, {starred}, {stick}, {inFocus}) filled from words.mjs when this module loads,
// so a rename there reaches every sentence below and cannot leave Help saying something the buttons no longer say.
const RAW = {};

RAW.INTRO = 'Muse shows you the connections hidden in your notes, so you can write quiz questions of your own. It never writes a question for you. {home} shows the whole vault at a glance; {home} narrows it by how well connected a fact is and by what connects it; {stick} puts one fact in focus and shows what clings to it. Search sits above all of them.';

RAW.QUICK_KEYS = [['/', 'Jump to the search box from anywhere.'], ['Enter', 'In the search box: run a search over your notes. Choose a suggestion with the arrow keys first to open that handle instead.'], ['Esc', 'Close the suggestions, or close the open note.'], ['Tab, Space', 'Move between buttons and press them. Everything works from the keyboard.']];

// "Which button?": the three actions that look alike, side by side.
RAW.WHICH = [
  { button: '{focus}', icon: '{focusEmoji}', what: 'Aim at this fact: it opens on the {stick} page, and you see which other notes share its names, places and dates (what “clings” to it). Focusing saves nothing and changes nothing; it only moves you.', use: 'You want to explore outward from this one fact.', where: 'Everywhere a fact is shown (except while a handle is hidden in Reveal last).', saved: 'Nothing, except “{recentFocus}” (this browser only) and a count of where you focused from.' },
  { button: '{collect}', icon: '➕', what: 'Add it to your {collection}, the working pile where you write how the facts link and copy the cluster out.', use: 'You are building a question and this fact might be part of it.', where: 'Everywhere a fact is shown. The {collection} button at the top of every page opens your pile over whatever you are reading.', saved: 'muse-tray.json, autosaved a moment after each change; survives refresh and restart.' },
  { button: '{star}', icon: '☆', what: 'Save it for good. The fact goes into {starred}, with the set it was found in.', use: 'You are sure you want this fact (or this pair) again later.', where: 'Everywhere a fact is shown. Also “{star} this pair / handle” on a set, for the whole set.', saved: 'muse-marks.jsonl, permanent. Undo from the toast, or press it again.' }
];

RAW.RECIPES = [
  { key: 'link', title: 'Where do I write the line that connects two facts?', goal: 'Record, in your own words, how two facts link, so the {collection} becomes the sketch of a question.',
    start: { t: 'Any fact, on any page', href: '#/search' },
    steps: ['Press {collect} on a fact. It joins your {collection}. Open the {collection} with the button at the top of any page; it slides in beside what you are reading.', 'Press {collect} on a second fact. A dashed field marked ↳ appears between the two facts, with the hint “How do these two link? (optional)”.', 'Click the field and type your line (up to 200 characters). It saves itself a moment after you stop typing; the box header shows Autosaving… then Autosaved.', 'With three facts you get two fields: one between facts 1 and 2, one between 2 and 3. Each line belongs to that pair, as they sit in the list.', 'Press Copy cluster. Your lines are copied between the facts, each starting with ↳.'],
    then: 'If you remove a fact and collect it again it goes to the end of the list, so its neighbours change and the old line stays with the old pair.' },
  { key: 'focus', title: 'What is Focus, and when do I use it?', goal: 'Aim at one fact to see what else in the vault touches it: the other notes that share its names, places and dates.',
    start: { t: 'Search, or any fact', href: '#/search' },
    steps: ['Find any fact: search for it, open a set from {home}, or narrow the facts on {home}.', 'Press {focusEmoji} {focus} on the fact. It opens at the top of the {stick} page.', 'Read below it: each heading is a hook (a name, place or year the fact mentions) that also appears in other notes, with facts from those notes underneath.', 'Press {focus} on one of those facts to move to it, and see what clings to that one. You are walking from fact to fact through the vault.', 'Press {collect} on the ones that fit a question you are building.'],
    then: 'Focus saves nothing, so you can wander freely; press the browser Back button to return. Use it whenever you have one fact and want to know what else the vault says around it.' },
  { key: 'know', title: 'I know a name, place or topic and want to build a question around it', goal: 'Turn something you already know into a connected set of facts.',
    start: { t: 'Search (the box at the top)', href: '#/search' },
    steps: ['Type the name or topic and press Enter. Read the banner first: it says how close the best match is.', 'Press {focus} on the most promising fact. {stick} opens with that fact in focus at the top.', 'Read the hooks that cling, grouped by kind (names, places, years…). Each hook lists facts from other notes.', 'Press {collect} on two or three facts that could make a question together. They gather in the {collection} (the button at the top opens it).', 'Between each two neighbouring facts in the {collection} there is a dashed field marked ↳. Click it and write how the two link, in your own words (see the first recipe).', 'Press Copy cluster and paste it into your quiz notes.'],
    then: 'If the facts under a hook look good as a whole set, click the hook’s name to open it as a set and use {star} there.' },
  { key: 'vein', title: 'I want to find a rich seam to work, with no idea in mind', goal: 'Browse facts that already have lots of links.',
    start: { t: '{home}, {veins}', href: '#/?shelf=veins' },
    steps: ['On {veins}, narrow by kind with the chips (for example Places).', 'Each card lists its strongest hooks. Press {focus} on one that interests you.', 'Under each hook, {collect} the facts that fit together.', 'In the dashed ↳ field between each two collected facts, write how they link, then Copy cluster.'],
    then: 'If a seam is dry, press the browser Back button; you return to the same shelf and page.' },
  { key: 'lone', title: 'I want a surprise from facts with no links', goal: 'Let a lone fact set off a connection in your own head.',
    start: { t: '{home}, {rivulets}', href: '#/?shelf=lone' },
    steps: ['Press Shuffle for a fresh handful. Muse skips ones it has shown you this run.', 'Read until one sets off an idea. Rivulets show no hooks, because the vault has no other note sharing them.', 'Press {collect} to start a cluster with it.', 'Use Search (top box) for the name or topic the fact made you think of, and {focus} or {collect} what turns up.', '{collect} a second fact, then write the link in the dashed ↳ field between them: that is the question.'],
    then: '{focus} on a rivulet fact shows an empty clings list. That is a finding, not a bug.' },
  { key: 'loop', title: 'I want questions the vault itself leaves unanswered', goal: 'Start from a fact whose own note leaves a “why” open.',
    start: { t: '{home}, Loops', href: '#/?loops=1' },
    steps: ['Each card shows the unanswered question under the fact, in italics.', '{focus} on the ones whose why you can answer, or want to.', '{collect} the fact plus any clinging fact that supplies the answer.', 'Copy cluster.'],
    then: 'A loop with nothing clinging is still useful: the why is the question; the answer is yours.' },
  { key: 'handle', title: 'I have a name, place or pair of look-alike words and want every fact that shares it', goal: 'See all the facts joined by one handle.',
    start: { t: '{home}', href: '#/' },
    steps: ['Search for the handle, or browse the wordplay kinds on {home} (anagrams, hidden words, sound-alikes…). Choose a suggestion to open its set.', 'Set how many facts you want and the order (hard to easy, or easy to hard).', 'Press {star} on the facts you want, or {star} this pair / handle for the whole set.', 'Press Copy as text for the list, or open {starred} later to browse everything you starred.'],
    then: 'Dull removes a fact from the set; Wrong sense removes a fact that matched the word but not the meaning. Both can be undone, and Show dull brings them back into view.' },
  { key: 'wordplay', title: 'I want a pun or a trick of spelling to build a question on', goal: 'Find pairs of names and words that echo each other by sound or by letters, for puns, anagrams and hidden-word questions.',
    start: { t: '{home}, Wordplay', href: '#/' },
    steps: ['In the Wordplay block on {home}, pick a trick: Sound-alikes, One letter apart, Letter dropped, Anagram pairs, Anagram of a word, Hidden word, Backwards or Digit look-alike. All wordplay shows every kind together.', 'Each tile is one pair, such as a name and the everyday word it sounds like. Open one to see the facts about it.', 'On the set page press {star} this pair to save it to {starred}, or Dull if the pair is only chance.', 'To build on it, press {focus} on one of its facts, then {collect} the facts that fit the trick (see the recipe on writing the link line).'],
    then: 'Pairs come from a detector that guesses, so expect some chance matches; Dull and Wrong sense teach nothing to the detector but keep them out of your way.' },
  { key: 'test', title: 'I want to test whether I can guess the link', goal: 'Practise the quiz setter’s view: facts first, link hidden.',
    start: { t: '{home}, any set', href: '#/' },
    steps: ['Open a set.', 'Press Reveal last. The handle is blanked in the facts, their quotes and the note titles.', 'Read the facts and guess the handle.', 'Press Show the handle to check.'],
    then: '{focus} and the note title stay switched off until the handle is shown, because they would give the answer away.' },
  { key: 'ask', title: 'I have a question and want to know whether my notes can answer it', goal: 'Find out whether the vault holds an answer, and be told plainly when it does not.',
    start: { t: 'Search', href: '#/search' },
    steps: ['Turn Search by meaning on (it is on by default) and type your question as a question.', 'Read the banner: Closest matches, Weak matches, or Nothing close in the vault. The first fact is the one the rating is based on.', 'Open “How Muse read your question” if you are curious. It is a guess used only for matching, and it may contain invented details.', 'If the banner says Nothing close, trust it: the nearest facts are folded away on purpose.'],
    then: 'A strong match is close to your question, not proof of an answer. Click the note title above the fact to read the passage.' },
  { key: 'words', title: 'I want an exact-words search, not a guess', goal: 'Find facts containing the words you typed.',
    start: { t: 'Search', href: '#/search' },
    steps: ['Switch Search by meaning off.', 'Search. Muse matches the words you typed (a fact can match on just one of them).', 'A note above the results reminds you that this mode cannot say whether the vault has an answer.'],
    then: 'Your choice is remembered in this browser. The address of a search remembers it too, so a bookmark behaves the same way.' },
  { key: 'resume', title: 'I want to pick up where I left off', goal: 'Return to a cluster or to a fact you were exploring.',
    start: { t: '{home}, Yours', href: '#/?yours=1' },
    steps: ['The {collection} is saved automatically. Open it with the button at the top of any page.', '{recentFocus} lists the last facts you put in focus. {focus} on one to continue.', '{starred} lists facts you starred in sets, {home} and {stick}. {focus} on one to explore it.'],
    then: 'Clear in the {collection} empties it. There is no undo, so Copy cluster first if you might want it.' },
  { key: 'junk', title: 'I found junk and want it out of my way', goal: 'Hide a fact or a pair that is dull or means the wrong thing.',
    start: { t: 'A set, or the {stick} page', href: '#/' },
    steps: ['Press Dull for a true but useless fact; Wrong sense when the match used the word in another meaning.', 'The next fact takes its place. Press Undo on the toast if you slipped.', 'Show dull on a Connect set reveals what you have hidden.'],
    then: 'A Reflection button that finds weak facts for you is planned; it will list them in a queue for you to star, retire or fix.' }
];

export const { INTRO, QUICK_KEYS, WHICH, RECIPES } = fill(RAW);

// Generated from the Muse map, so this table cannot drift from the code (see muse_map.mjs and `node code/muse_map_check.js`).
export const SAVED = DATA.map(d => [d.what, d.where, d.notes]);

export const GLOSSARY = fill([
  ['Fact', 'One statement pulled from a note (the code calls it a burr), with the quote it came from.'],
  ['Hook', 'A name, place, year, number, material or other thing a fact mentions (the code calls it a bristle). A hook that appears in other notes is what lets facts connect.'],
  ['Handle', 'A hook, or a pair of look-alike words, that you open to see every fact sharing it. Sets are organised around handles.'],
  ['Set', 'The facts that share one handle, shown on one page.'],
  ['{inFocus}', 'The one fact you have put in focus. The {stick} page shows what clings to it.'],
  ['Cling', 'A fact from another note that shares a hook with the fact in focus. Clings are grouped by the kind of hook.'],
  ['Shelf', 'How well connected a fact is, used to narrow facts on {home}: {veins} (3 or more hooks), {vesicles} (1 or 2), {rivulets} (none). Each fact is on exactly one shelf, so the shelf counts add up. Loops (an unanswered why) and Yours are overlays, not shelves.'],
  ['Keyboard', 'Press Shift + ? anywhere to see every shortcut.'],
  ['Kind', 'The type of a hook: a name, place, year, day, number. A fact can have several kinds, so kind counts overlap and do not add up. On {home} you pick any kinds; Match says whether a fact needs any chosen kind or every one.'],
  ['All shelves, All kinds', 'Zoom back out. All shelves drops the shelf choice and All kinds clears the chosen kinds. Clicking an earlier step in the trail at the top of a page does the same.'],
  ['{collection}', 'The working pile of facts you have chosen to build a question from, plus the lines you write about how they link. The button at the top opens it over any page.'],
  ['{starred}', 'Everything you have starred, across sets, {home} and {stick}. Starring is permanent; the {collection} is a working pile.'],
  ['Loop', 'A question the note itself raises and leaves open.'],
  ['Far apart', 'A badge on a cling whose note shares no tag with the note of the fact in focus. Roughly half of all clings get it, so read it as “different subject area”, not “surprising”.'],
  ['Banner, closeness, best match', 'On a search by meaning: the banner rates the best match by its closeness to your question (0 to 1). 0.50 and above is Closest matches, 0.40 to 0.50 Weak matches, under 0.40 Nothing close. Best match marks the fact the rating is based on.'],
  ['Search by meaning', 'On: finds facts that mean the same thing as your question, using an embedding model on your Mac plus one cheap AI call for each new question (repeat questions are free). Off: matches the words you typed.']
]);

export const COMING = fill([
  ['Live now', '{home}, {stick}, Search, {starred}, Admin (status only), Help.'],
  ['Planned modes', 'Thread (follow a chain hook by hook), Slice (everything touching a year or day), Shelf (etymology and other typed shelves), Loops (the vault’s unanswered whys, as a mode), Drift (one unprompted spark a day), Wander (a random walk over words with several meanings).'],
  ['Planned features', 'Reflection (a button that inspects Muse for weak facts and fills a review queue: star, retire, fix); {star} on search results; a report of which shelves your finished questions came from; help for each mode as it arrives.']
]);

// Sys Admin: for whoever keeps Muse running and tidy. The commands live in ~/dotfiles/zsh/quarry.zshrc.local (the `muse` function); this table is written by hand,
// so when a command changes there, change it here.
export const SYSADMIN = {
  intro: 'Everything here is typed in the Terminal on the Mac, inside the quarry folder. Muse itself never runs these.',
  commands: [
    ['muse', 'Start Muse (if it is not already up), wait until the page answers, and open it in the browser. Safe to repeat.'],
    ['muse status | logs | attach | stop | restart | open', 'Is it up; the last 200 lines of output; watch it live (detach with Ctrl-b d); stop it; stop and start it; open the page.'],
    ['muse --fg', 'Run in the foreground instead, to see why it will not start.'],
    ['muse drift', 'The fast audit, about a second: does the Muse map still match the code (screens, buttons, server calls, saved files, Help recipes), and has the heuristic registry drifted. Changes nothing.'],
    ['muse check', 'The full gate, about 16 seconds: the drift audit plus every test. Changes nothing. Run it before saying work is done.'],
    ['muse commit "message" PATH...', 'Run the full gate, stage only the files you name (paths from the repo root), show them, ask, then commit with your message. Add --tracked to take every already-tracked changed file, --yes to skip the question, --push to push afterwards. It never pushes unless told to. New files are never taken by --tracked: it lists them so you can name them. Anything already staged is refused unless you add --staged, which commits it as well.'],
    ['muse hook', 'Install the pre-commit hook in this clone, once. From then on any commit (even a plain git commit) runs the drift audit first and is blocked if something has drifted. Skip it once, on purpose, with git commit --no-verify.']
  ],
  refuses: 'muse commit refuses to stage databases, the meaning index, Muse\u2019s own data files, your labels, private-candidate scans, backups, quiz material and secrets, even if you name them.',
  map: [
    'The Muse map (code/muse_ui/js/muse_map.mjs) lists every feature once: its screen, buttons, server calls, saved files and Help recipes. The Contents list and the \u201cWhere things are saved\u201d table on this page are generated from it.',
    'When you add a screen, button, server call or saved file, add it to the map, and write a recipe if people will use it. The drift audit fails until you do. When you remove one, it fails until the map is updated.',
    'The map has a budget (BUDGET in the same file): features, saved files, buttons per feature, recipes, and features that Help does not teach. The audit warns above 80% of a limit and fails above the limit. Trim first: merge a small feature into its parent, retire a recipe, drop a saved file. The failure names the smallest features as the first candidates. Raising a limit is allowed, but write the reason in the file\u2019s reasons list in the same commit.'
  ]
};
