"""Bake-off, Python side. Run: python run.py  (each library is tried independently; a failure of one does not stop the rest)."""
import json, re, sys, traceback
C = json.load(open('cases.json'))
def section(t): print('\n' + '=' * 8, t)
def tryit(name, fn):
    try: return fn()
    except Exception as e: return 'ERROR ' + type(e).__name__ + ': ' + str(e)[:70]

section('PLURALS: library output vs expected (X = wrong)')
engines = {}
try:
    import inflect; p = inflect.engine(); engines['inflect'] = lambda w: p.singular_noun(w) or w
except Exception as e: print('inflect unavailable:', e)
try:
    import simplemma; engines['simplemma'] = lambda w: simplemma.lemmatize(w, lang='en')
except Exception as e: print('simplemma unavailable:', e)
try:
    import spacy; nlp = spacy.load('en_core_web_sm'); engines['spacy'] = lambda w: nlp(w)[0].lemma_
except Exception as e: print('spacy unavailable:', e)
print('word'.ljust(12), 'expected'.ljust(11), *[n.ljust(11) for n in engines])
score = {n: 0 for n in engines}
for w, exp in C['plural']:
    row = []
    for n, f in engines.items():
        out = tryit(n, lambda: f(w)); ok = out == exp; score[n] += ok; row.append((str(out) + ('' if ok else ' X')).ljust(11))
    print(w.ljust(12), exp.ljust(11), *row)
print('score:', {n: f'{s}/{len(C["plural"])}' for n, s in score.items()})

section('QUANTITIES and DATES: raw output per library, judge by eye')
try:
    from quantulum3 import parser as qp
except Exception as e: qp = None; print('quantulum3 unavailable:', e)
try:
    import dateparser.search as dps
except Exception as e: dps = None; print('dateparser unavailable:', e)
try:
    from recognizers_suite import recognize_dimension, recognize_currency, recognize_datetime, Culture
    R = True
except Exception as e:
    R = None; print('recognizers unavailable:', e)
try: nlp
except NameError: nlp = None
for t in C['text']:
    print('\n>', t)
    if qp: print('  quantulum3   :', tryit('q', lambda: [(q.value, q.unit.name, q.surface) for q in qp.parse(t)]))
    if R:
        print('  recognizers/dim+cur:', tryit('r', lambda: [(r.text, r.resolution.get('value') if r.resolution else None, r.resolution.get('unit') if r.resolution else None) for r in list(recognize_dimension(t, Culture.English))+list(recognize_currency(t, Culture.English))]))
        print('  recognizers/datetime:', tryit('r', lambda: [(r.text, r.resolution.get('values') if r.resolution else None) for r in recognize_datetime(t, Culture.English)]))
    if dps: print('  dateparser   :', tryit('d', lambda: [(s, str(d.date())) for s, d in (dps.search_dates(t, settings={'REQUIRE_PARTS': ['year']}) or [])]))
    if nlp: print('  spacy DATE/QUANTITY/CARDINAL:', tryit('s', lambda: [(e.text, e.label_) for e in nlp(t).ents if e.label_ in ('DATE', 'QUANTITY', 'CARDINAL', 'MONEY', 'PERCENT')]))

section('JSON REPAIR: does the result parse, and is it what we meant?')
try:
    import json_repair
    for s, what in C['json']:
        out = tryit('j', lambda: json_repair.repair_json(s, return_objects=True))
        print('-', what, '->', json.dumps(out, ensure_ascii=False)[:150])
except Exception as e: print('json_repair unavailable:', e)
