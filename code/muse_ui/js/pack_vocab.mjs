// Generated from the active pack by code/lib/pack_vocab.js (node code/pack_vocab_build.js). Do not edit by hand.
export default {
  "purpose": "so you can write quiz questions of your own. It never writes a question for you.",
  "recipes": [
    {
      "key": "wordplay",
      "title": "I want a pun or a trick of spelling to build a question on",
      "goal": "Find pairs of names and words that echo each other by sound or by letters, for puns, anagrams and hidden-word questions.",
      "start": {
        "t": "{home}, Wordplay",
        "href": "#/"
      },
      "steps": [
        "In the Wordplay block on {home}, pick a trick: Sound-alikes, One letter apart, Letter dropped, Anagram pairs, Anagram of a word, Hidden word, Backwards or Digit look-alike. All wordplay shows every kind together.",
        "Each tile is one pair, such as a name and the everyday word it sounds like. Open one to see the facts about it.",
        "On the set page press {star} this pair to save it to {starred}, or Dull if the pair is only chance.",
        "To build on it, press {focus} on one of its facts, then {collect} the facts that fit the trick (see the recipe on writing the link line)."
      ],
      "then": "Pairs come from a detector that guesses, so expect some chance matches; Dull and Wrong sense teach nothing to the detector but keep them out of your way.",
      "after": "handle"
    },
    {
      "key": "angles",
      "after": "link",
      "title": "I want to start from a quiz shape, not a pile",
      "goal": "Browse every place in your notes where a shape shows up (a word with a story, a first-or-only claim, two facts on one day, a stated cause), and collect the ones that spark something.",
      "start": {
        "t": "Angles",
        "href": "#/angles"
      },
      "steps": [
        "Press Angles at the top of any page. The first visit takes a few seconds while Muse reads every fact once.",
        "Pick a shape from the row of chips. The number is how many findings it has.",
        "Each card names the shape, says why it fired, and gives a seed: what the answer would be, what joins the facts, and what you would hide. Below are the facts themselves.",
        "Wordplay pairs opens Home’s Wordplay block (anagrams, one-letter-off pairs, hidden words and more). Press Glossary to see what each shape name means in Muse, with an example and how fully Muse can find it. Clicking a card’s shape name opens its entry.",
        "Press {collect} on facts that spark something. The {collection} then shows the shapes your own pile hints at."
      ],
      "then": "A card is a pointer, not a question. Some are wrong: a word with a story can be a dull plural, and a “because” can be trivial. Skip those."
    },
    {
      "key": "test",
      "goal": "Practise the quiz setter’s view: facts first, link hidden."
    },
    {
      "key": "link",
      "steps": [
        "Press {collect} on a fact. It joins your {collection}. Open the {collection} with the button at the top of any page; it slides in beside what you are reading.",
        "Press {collect} on a second fact. A dashed field marked ↳ appears between the two facts, with the hint “How do these two link? (optional)”.",
        "Click the field and type your line (up to 200 characters). It saves itself a moment after you stop typing; the box header shows Autosaving… then Autosaved.",
        "With three facts you get two fields: one between facts 1 and 2, one between 2 and 3. Each line belongs to that pair, as they sit in the list.",
        "Under the list, Angles names the quiz shapes your facts already hint at (a shared date, the same name for two kinds of thing, a word with a story, a “because”), with the facts involved. It is a pointer, not a question; it costs nothing and uses no model.",
        "Press Copy cluster. Your lines are copied between the facts, each starting with ↳."
      ]
    }
  ],
  "features": [
    {
      "key": "home",
      "blurb": "Two blocks that stay put: Facts (narrow by how well connected and what connects; All shelves and All kinds zoom back out) and Results (shuffled by default, or ordered by a lens, with Starred only) and Wordplay (pairs of names by trick). The results below follow the one you touched last.",
      "buttons+": [
        "Sound-alikes",
        "One letter apart",
        "Letter dropped",
        "Digit look-alike",
        "Backwards",
        "Hidden word",
        "Anagram pairs",
        "Anagram of a word",
        "All wordplay"
      ],
      "recipes": [
        "know",
        "vein",
        "lone",
        "wordplay",
        "handle"
      ]
    },
    {
      "key": "angles",
      "title": "Angles",
      "route": "angles",
      "blurb": "Start from a quiz shape instead of a pile: every word with a story, first-or-only claim, shared day or stated cause in the vault, each with a seed (answer, join, what to hide) and its facts ready to Collect.",
      "api": [
        "/api/angles/browse",
        "/api/glossary"
      ],
      "buttons": [
        "Angles",
        "Glossary",
        "Wordplay pairs"
      ],
      "data": [
        "events"
      ],
      "recipes": [
        "angles"
      ],
      "after": "admin"
    },
    {
      "key": "collection",
      "blurb": "The working pile of facts, with a line between neighbours for how they link, and an Angles list of the quiz shapes the pile already hints at. The button at the top opens it over any page; Collect is on every fact.",
      "api": [
        "/api/tray",
        "/api/event",
        "/api/angles"
      ]
    }
  ],
  "glossaryOthers": " (from another setter; shown on this machine only)",
  "typeLabels": {
    "material": "Materials",
    "etymon": "Word roots",
    "set": "Sets & groups",
    "mechanism": "Mechanisms",
    "former-role": "Former roles",
    "uniqueness": "Superlatives & firsts",
    "homonym": "Same word, other sense"
  },
  "wordplayKinds": {
    "anagram-pair": {
      "label": "Anagram pairs",
      "blurb": "Two names made from exactly the same letters."
    },
    "one-letter-off": {
      "label": "One letter apart",
      "blurb": "Two names that differ by a single letter."
    },
    "head-tail": {
      "label": "Letter dropped",
      "blurb": "A name that becomes another word when its first or last letter is dropped."
    },
    "homophone": {
      "label": "Sound-alikes",
      "blurb": "A name and an everyday word that sound exactly alike."
    },
    "anagram-of-word": {
      "label": "Anagram of a word",
      "blurb": "A name whose letters rearrange into an everyday word."
    },
    "hidden-word": {
      "label": "Hidden word",
      "blurb": "A name with another word hiding inside it."
    },
    "reversal": {
      "label": "Backwards",
      "blurb": "A name that spells another name when read backwards."
    },
    "digit-lookalike": {
      "label": "Digit look-alike",
      "blurb": "A name where letters stand in for digits."
    }
  }
};
