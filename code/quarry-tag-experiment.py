#!/usr/bin/env python3 -I
"""
quarry-tag-experiment.py
Tests tag-based note clustering as an alternative to serendipity selection.

Three clustering strategies:
  shared_root  — notes sharing the same tag root but diverse leaf tags
                 (e.g. india/history + india/economy)
  weak_tie     — anchor note + most topically distant note that still shares ≥1 tag
                 (minimum Jaccard overlap, ≥1 shared tag guaranteed)
  cross_leaf   — notes sharing the same leaf tag from different roots
                 ("meta-related": india/history + japan/history)

Usage:
  python quarry-tag-experiment.py --strategy shared_root
  python quarry-tag-experiment.py --strategy weak_tie --cluster-size 3
  python quarry-tag-experiment.py --strategy cross_leaf --tag history
  python quarry-tag-experiment.py --strategy shared_root --dry-run --count 3
  python quarry-tag-experiment.py --list-tags

Environment:
  QUARRY_DB           path to vault.db  (default: ~/dev/quarry/vault.db)
  ANTHROPIC_API_KEY   Claude API key    (required unless --dry-run)

Output:
  Prints BRIDGE:, REGISTER:, and narrative for each cluster.
  Does NOT write to vault.db — read-only experiment.
"""

import argparse
import json
import os
import random
import re
import sqlite3
import sys
import textwrap
import urllib.request
import urllib.error
from pathlib import Path

# ---------------------------------------------------------------------------
# CONFIG
# ---------------------------------------------------------------------------
QUARRY_HOME   = os.environ.get('QUARRY_HOME', str(Path.home() / 'dev' / 'quarry'))
DB_PATH       = os.environ.get('QUARRY_DB', str(Path(QUARRY_HOME) / 'vault.db'))
VAULT_PATH    = os.environ.get('VAULT_PATH', str(Path.home() / 'vault'))
ANTHROPIC_KEY = os.environ.get('ANTHROPIC_API_KEY', '')

CLAUDE_MODEL_FALLBACK = 'claude-sonnet-4-5'
MAX_TOKENS            = 4096
FULL_BODY_CHARS = 3000

# ---------------------------------------------------------------------------
# SYSTEM PROMPT  (same as narrator.js v0.2 — kept in sync manually)
# ---------------------------------------------------------------------------
SYSTEM_PROMPT = """\
You are QUARRY, a narrative engine that surfaces moving, surprising stories
from a curated personal knowledge vault built over 10 years by a single
curious mind spanning history, music, science, language, economics, and culture
— with a particular depth in Indian and South Asian knowledge.

You will receive 2-5 note excerpts. Your task is to compose a single
self-contained narrative of 200-400 words that connects them into a moment
of astonishment.

---

OUTPUT FORMAT — NON-NEGOTIABLE

Every response must begin with exactly this line:
BRIDGE: [one sentence stating the factual or structural mechanism connecting at least two notes]

Then the narrative body (200-400 words).
Then: REGISTER: senior or REGISTER: junior

If no factual or structural bridge is available (only thematic category-overlap
or surface word-resemblance), output only:
BRIDGE: none — [one phrase describing what the notes superficially share]
REGISTER: unnarratable

Do not write a narrative body in the unnarratable case.
The curator will re-queue with different notes.

A response without a BRIDGE: first line will be treated as a failed generation.

---

WHAT YOU ARE PRODUCING

A short narrative of one or two paragraphs. Not a question. Not a quiz. Not a summary.

The narrative succeeds when the reader thinks:
"I didn't know these things were connected — and now I can't unknow it!"

---

MANDATORY: FIND A UNIFYING PRINCIPLE BEFORE WRITING

Before writing a single word, identify one concept, fact, person, place,
or mechanism that genuinely connects at least two of the notes.

TEST YOUR CONNECTION:
1. Do the two things share the same MECHANISM, not just the same word?
2. Would a domain expert in both fields recognise this as a real connection?
3. If you remove the connecting word/phrase, does the connection still hold?

If any answer is no — ABANDON that connection. Find a different one.
If no connection survives this test — use the BRIDGE: none format and stop.

CONNECTION HIERARCHY — strongest to weakest:
1. FACTUAL: documented causal link, shared historical moment, same person,
   verified etymological descent, same geographic origin
2. STRUCTURAL: same underlying mechanism operating in different domains
3. IRONIC: the two things contradict each other in a revealing way
4. ANALOGICAL: similar shape or pattern — ONLY use if mechanism is shared
5. METAPHORICAL: surface resemblance in language — FORBIDDEN.
   Thematic category-overlap is also FORBIDDEN as a primary bridge.
   If only a metaphorical or thematic bridge is available, use BRIDGE: none.

---

ATTRIBUTION RULE

When your narrative names a specific person and attributes a method, theory,
concept, or historical act to them, that attribution must come directly from
what the source note says about that specific person.

When a note lists two or more thinkers or figures together, do NOT transfer
one person's method or contribution to another. Each attribution must be
separately traceable to what the note says about that specific person.

Before attributing anything to a named person: verify the note explicitly
connects that attribution to that person (not merely to someone else nearby).
If you cannot trace it, omit the attribution entirely.

---

USE ALL NOTES

Every note provided must appear in the narrative.
If a note cannot be connected to the others through a factual or structural
bridge, say so: "REGISTER: junior — note [N] not integrated"

---

TWO REGISTERS

SENIOR REGISTER: The double reveal. Two facts devastating at their junction.
JUNIOR REGISTER: One fact, one moment of astonishment. Emotionally direct.

---

THE BRAID PRINCIPLE

Braid two or more of: etymology · history · geography · economics ·
literature · current affairs · science · music · religion · biography

---

THE TIME COLLAPSE — the signature move

Find the moment where something ancient is secretly operating inside
something contemporary, or vice versa.

---

ENTRY POINTS

ETYMOLOGICAL · TIME COLLAPSE · HIDDEN IDENTITY · PRIORITY CLAIM ·
SCALE SHOCK · REVERSAL

---

CLOSING MOVES

THE STILL-HERE CLOSE · THE NAMING REVEAL · THE TIME COLLAPSE CLOSE ·
THE HIDDEN IDENTITY CLOSE · THE PRIORITY CLOSE · THE SCALE CLOSE

---

TONE

- Curious, warm, never condescending
- Never "interestingly", "fascinatingly", "remarkably"
- The first sentence is the hook. It must earn the second.
- Never open with "This narrative explores..."
- Indic cultural references are a strength; do not flatten them.
- Hindi, Marathi, Sanskrit, Telugu phrases may be used directly.

---

AFTER THE NARRATIVE

Append: REGISTER: senior  or  REGISTER: junior
Nothing else. No question. No summary.
"""

# ---------------------------------------------------------------------------
# DATABASE
# ---------------------------------------------------------------------------
def open_db():
    if not Path(DB_PATH).exists():
        sys.exit(f"vault.db not found at {DB_PATH}\nSet QUARRY_DB env var.")
    return sqlite3.connect(DB_PATH)


def get_note_tags(conn, note_id):
    """Returns (set of tag_full, set of tag_root, set of tag_leaf)."""
    rows = conn.execute(
        "SELECT tag_full, tag_root, tag_leaf FROM note_tags WHERE note_id = ?",
        (note_id,)
    ).fetchall()
    fulls  = {r[0] for r in rows if r[0]}
    roots  = {r[1] for r in rows if r[1]}
    leaves = {r[2] for r in rows if r[2]}
    return fulls, roots, leaves


def get_note(conn, note_id):
    row = conn.execute(
        "SELECT id, filepath, title, first_paragraph, source_url, word_count "
        "FROM vault_notes WHERE id = ?", (note_id,)
    ).fetchone()
    if not row:
        return None
    return {
        'id':            row[0],
        'filepath':      row[1],
        'title':         row[2],
        'first_para':    row[3],
        'source_url':    row[4],
        'word_count':    row[5],
    }


def get_classifications(conn, note_id):
    rows = conn.execute(
        "SELECT bucket, claim FROM note_classifications "
        "WHERE note_id = ? AND bucket IN ('verified','evergreen','trivia') "
        "ORDER BY bucket",
        (note_id,)
    ).fetchall()
    verified  = [r[1] for r in rows if r[0] == 'verified']
    evergreen = [r[1] for r in rows if r[0] == 'evergreen']
    trivia    = [r[1] for r in rows if r[0] == 'trivia']
    return verified, evergreen, trivia


def read_note_body(filepath):
    try:
        raw = Path(filepath).read_text(encoding='utf-8', errors='replace')
        body = re.sub(r'^---\r?\n.*?\r?\n---\r?\n?', '', raw, count=1, flags=re.DOTALL)
        body = re.sub(r'_Created at[^_]*\._', '', body)
        body = re.sub(r'_Source URL:[^_]*\._', '', body)
        body = re.sub(r'_Last updated:[^_]*\._', '', body)
        return body.strip()[:FULL_BODY_CHARS]
    except Exception:
        return None


def build_note_block(conn, note_id):
    """Build full note context dict for one note."""
    note = get_note(conn, note_id)
    if not note:
        return None

    fulls, roots, leaves = get_note_tags(conn, note_id)
    verified, evergreen, trivia = get_classifications(conn, note_id)
    body = read_note_body(note['filepath']) if note['filepath'] else None

    return {
        'id':        note_id,
        'title':     note['title'],
        'tags':      sorted(fulls)[:8],
        'source_url': note['source_url'],
        'body':      body or note['first_para'] or '',
        'verified':  verified[:8],
        'evergreen': evergreen[:4],
        'trivia':    trivia[:3],
        'has_classifications': bool(verified or evergreen or trivia),
    }


# ---------------------------------------------------------------------------
# CLUSTERING STRATEGIES
# ---------------------------------------------------------------------------

def jaccard(set_a, set_b):
    if not set_a and not set_b:
        return 0.0
    inter = len(set_a & set_b)
    union = len(set_a | set_b)
    return inter / union if union else 0.0


def strategy_shared_root(conn, cluster_size, tag_filter=None, count=1):
    """
    Notes sharing same tag_root but with diverse leaf tags.
    Selects random root, then picks cluster_size notes with that root,
    preferring diverse leaf tags.
    """
    results = []
    attempts = 0

    while len(results) < count and attempts < 200:
        attempts += 1

        # Pick a root that has ≥ cluster_size tagged notes
        if tag_filter:
            row = conn.execute(
                "SELECT tag_root, COUNT(DISTINCT note_id) as c "
                "FROM note_tags WHERE tag_root = ? "
                "GROUP BY tag_root HAVING c >= ?",
                (tag_filter, cluster_size)
            ).fetchone()
            if not row:
                print(f"[shared_root] No root '{tag_filter}' with ≥{cluster_size} notes.")
                break
            root = row[0]
        else:
            rows = conn.execute(
                "SELECT tag_root, COUNT(DISTINCT note_id) as c "
                "FROM note_tags nt "
                "JOIN vault_notes vn ON vn.id = nt.note_id "
                "WHERE vn.quarry_exclude IS NULL OR vn.quarry_exclude = 0 "
                "GROUP BY tag_root HAVING c >= ? "
                "ORDER BY RANDOM() LIMIT 20",
                (cluster_size,)
            ).fetchall()
            if not rows:
                print("[shared_root] No qualifying roots found.")
                break
            root = random.choice(rows)[0]

        # Get candidate notes with this root
        candidates = conn.execute(
            "SELECT DISTINCT nt.note_id FROM note_tags nt "
            "JOIN vault_notes vn ON vn.id = nt.note_id "
            "WHERE nt.tag_root = ? "
            "AND (vn.quarry_exclude IS NULL OR vn.quarry_exclude = 0) "
            "ORDER BY RANDOM() LIMIT 100",
            (root,)
        ).fetchall()
        candidates = [r[0] for r in candidates]

        if len(candidates) < cluster_size:
            continue

        # Pick cluster_size with diverse leaf tags
        selected = [candidates[0]]
        used_leaves = get_note_tags(conn, candidates[0])[2]

        for nid in candidates[1:]:
            if len(selected) >= cluster_size:
                break
            _, _, leaves = get_note_tags(conn, nid)
            new_leaves = leaves - used_leaves
            if new_leaves or len(selected) < 2:
                selected.append(nid)
                used_leaves |= leaves

        if len(selected) < cluster_size:
            continue

        random.shuffle(selected)
        results.append({
            'strategy': 'shared_root',
            'theme': f'tag:{root}',
            'note_ids': selected[:cluster_size],
            'seed_tag': root,
        })

    return results


def strategy_weak_tie(conn, cluster_size, tag_filter=None, count=1):
    """
    Anchor note + most topically distant note(s) that still share ≥1 tag.
    Minimum Jaccard overlap. Creates surprising but not random connections.
    """
    results = []
    attempts = 0

    while len(results) < count and attempts < 200:
        attempts += 1

        # Pick an anchor note that has tags
        if tag_filter:
            anchor_rows = conn.execute(
                "SELECT DISTINCT nt.note_id FROM note_tags nt "
                "JOIN vault_notes vn ON vn.id = nt.note_id "
                "WHERE nt.tag_full LIKE ? "
                "AND (vn.quarry_exclude IS NULL OR vn.quarry_exclude = 0) "
                "ORDER BY RANDOM() LIMIT 20",
                (f'%{tag_filter}%',)
            ).fetchall()
        else:
            anchor_rows = conn.execute(
                "SELECT DISTINCT note_id FROM note_tags nt "
                "JOIN vault_notes vn ON vn.id = nt.note_id "
                "WHERE (vn.quarry_exclude IS NULL OR vn.quarry_exclude = 0) "
                "ORDER BY RANDOM() LIMIT 50"
            ).fetchall()

        if not anchor_rows:
            print("[weak_tie] No anchor candidates found.")
            break

        anchor_id = random.choice(anchor_rows)[0]
        anchor_fulls, anchor_roots, _ = get_note_tags(conn, anchor_id)

        if not anchor_fulls:
            continue

        # Find candidates sharing ≥1 tag with anchor
        placeholders = ','.join('?' * len(anchor_fulls))
        candidates = conn.execute(
            f"SELECT DISTINCT nt.note_id FROM note_tags nt "
            f"JOIN vault_notes vn ON vn.id = nt.note_id "
            f"WHERE nt.tag_full IN ({placeholders}) "
            f"AND nt.note_id != ? "
            f"AND (vn.quarry_exclude IS NULL OR vn.quarry_exclude = 0) "
            f"ORDER BY RANDOM() LIMIT 200",
            list(anchor_fulls) + [anchor_id]
        ).fetchall()
        candidates = [r[0] for r in candidates]

        if len(candidates) < cluster_size - 1:
            continue

        # Score by jaccard: lower = more distant (weak tie)
        scored = []
        for nid in candidates:
            c_fulls, _, _ = get_note_tags(conn, nid)
            j = jaccard(anchor_fulls, c_fulls)
            scored.append((j, nid))

        # Sort ascending (most distant first), pick cluster_size - 1
        scored.sort(key=lambda x: x[0])
        # Skip completely disjoint (j=0), which would mean no shared tags despite our query
        scored = [(j, nid) for j, nid in scored if j > 0]

        if len(scored) < cluster_size - 1:
            continue

        # Pick from the bottom quartile (weakest ties)
        bottom = scored[:max(cluster_size - 1, len(scored) // 4)]
        partners = random.sample(bottom, cluster_size - 1)
        partner_ids = [nid for _, nid in partners]

        # Build seed theme from shared tags between anchor and first partner
        _, p_roots, _ = get_note_tags(conn, partner_ids[0])
        shared_roots = anchor_roots & p_roots
        theme = 'weak_tie:' + (sorted(shared_roots)[0] if shared_roots else 'cross-domain')

        results.append({
            'strategy': 'weak_tie',
            'theme': theme,
            'note_ids': [anchor_id] + partner_ids,
            'seed_tag': theme,
        })

    return results


def strategy_cross_leaf(conn, cluster_size, tag_filter=None, count=1):
    """
    Notes sharing same leaf tag from different roots.
    e.g. india/history + japan/history — "meta-related" notes.
    """
    results = []
    attempts = 0

    while len(results) < count and attempts < 200:
        attempts += 1

        # Find a leaf tag appearing in ≥ cluster_size different roots
        if tag_filter:
            row = conn.execute(
                "SELECT tag_leaf, COUNT(DISTINCT tag_root) as rc, COUNT(DISTINCT note_id) as nc "
                "FROM note_tags WHERE tag_leaf = ? AND tag_root IS NOT NULL "
                "GROUP BY tag_leaf HAVING rc >= ? AND nc >= ?",
                (tag_filter, cluster_size, cluster_size)
            ).fetchone()
            if not row:
                print(f"[cross_leaf] Leaf '{tag_filter}' not found in ≥{cluster_size} roots.")
                break
            leaf = row[0]
        else:
            rows = conn.execute(
                "SELECT tag_leaf, COUNT(DISTINCT tag_root) as rc, COUNT(DISTINCT note_id) as nc "
                "FROM note_tags nt "
                "JOIN vault_notes vn ON vn.id = nt.note_id "
                "WHERE tag_root IS NOT NULL AND tag_leaf IS NOT NULL "
                "AND (vn.quarry_exclude IS NULL OR vn.quarry_exclude = 0) "
                "GROUP BY tag_leaf HAVING rc >= ? AND nc >= ? "
                "ORDER BY RANDOM() LIMIT 30",
                (cluster_size, cluster_size)
            ).fetchall()
            if not rows:
                print("[cross_leaf] No qualifying leaf tags found.")
                break
            leaf = random.choice(rows)[0]

        # Get notes with this leaf, one per root (prefer diversity)
        candidates = conn.execute(
            "SELECT nt.note_id, nt.tag_root FROM note_tags nt "
            "JOIN vault_notes vn ON vn.id = nt.note_id "
            "WHERE nt.tag_leaf = ? AND nt.tag_root IS NOT NULL "
            "AND (vn.quarry_exclude IS NULL OR vn.quarry_exclude = 0) "
            "ORDER BY RANDOM() LIMIT 100",
            (leaf,)
        ).fetchall()

        # One note per root
        by_root = {}
        for nid, root in candidates:
            if root not in by_root:
                by_root[root] = nid

        roots_available = list(by_root.keys())
        if len(roots_available) < cluster_size:
            continue

        chosen_roots = random.sample(roots_available, cluster_size)
        selected = [by_root[r] for r in chosen_roots]

        results.append({
            'strategy': 'cross_leaf',
            'theme': f'cross_leaf:{leaf}',
            'note_ids': selected,
            'seed_tag': leaf,
        })

    return results


STRATEGIES = {
    'shared_root': strategy_shared_root,
    'weak_tie':    strategy_weak_tie,
    'cross_leaf':  strategy_cross_leaf,
}

# ---------------------------------------------------------------------------
# BUILD USER MESSAGE
# ---------------------------------------------------------------------------
def build_user_message(notes, seed_theme):
    lines = []
    lines.append(f"SEED THEME: {seed_theme}")
    lines.append("")
    lines.append(f"NOTES ({len(notes)}):")
    lines.append("")

    for i, note in enumerate(notes, 1):
        lines.append(f"--- NOTE {i}: {note['title']} ---")
        if note['tags']:
            lines.append("Tags: " + ", ".join(note['tags']))
        if note['source_url']:
            lines.append(f"Source: {note['source_url']}")
        lines.append("")

        if note['has_classifications']:
            if note['verified']:
                lines.append("VERIFIED FACTS:")
                for f in note['verified']:
                    lines.append(f"  • {f}")
                lines.append("")
            if note['evergreen']:
                lines.append("CORE CONCEPTS:")
                for e in note['evergreen'][:4]:
                    m = re.search(r'\*([^*]+)\*', e) or re.match(r'^[-•*\d.]+\s*([^:\n]{3,40})', e)
                    lines.append("  • " + (m.group(1).strip() if m else e[:80]))
                lines.append("")
            if note['trivia']:
                lines.append("TRIVIA / SURPRISING CONNECTIONS:")
                for t in note['trivia']:
                    lines.append(f"  • {t}")
                lines.append("")
            lines.append("RAW NOTE (for additional context):")

        lines.append(note['body'] or '(no content)')
        lines.append("")

    lines.append("---")
    lines.append("Your response MUST begin with exactly this line:")
    lines.append("BRIDGE: [one sentence — the factual or structural mechanism connecting at least two notes]")
    lines.append("")
    lines.append("Then write the narrative (200-400 words).")
    lines.append("Then append: REGISTER: senior or REGISTER: junior")
    lines.append("")
    lines.append("If the only available bridge is thematic category-overlap or surface word-resemblance:")
    lines.append("BRIDGE: none — [one phrase describing the surface resemblance]")
    lines.append("REGISTER: unnarratable")
    lines.append("(No narrative body in this case.)")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# MODEL RESOLVER
# ---------------------------------------------------------------------------
def resolve_model(api_key, fallback=CLAUDE_MODEL_FALLBACK):
    """
    Resolve current recommended claude-sonnet model via /v1/models.
    Mirrors the llm-model-resolver npm package used in narrator.js.
    Falls back to CLAUDE_MODEL_FALLBACK on any error.
    """
    try:
        req = urllib.request.Request(
            'https://api.anthropic.com/v1/models',
            headers={
                'x-api-key':         api_key,
                'anthropic-version': '2023-06-01',
            }
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            models = json.loads(resp.read().decode('utf-8')).get('data', [])
        sonnet = sorted(
            [m for m in models if 'claude-sonnet' in m.get('id', '')],
            key=lambda m: m.get('created_at', 0),
            reverse=True
        )
        return sonnet[0]['id'] if sonnet else fallback
    except Exception:
        return fallback


# ---------------------------------------------------------------------------
# CLAUDE API CALL
# ---------------------------------------------------------------------------
def call_claude(user_message):
    if not ANTHROPIC_KEY:
        sys.exit("ANTHROPIC_API_KEY not set. Use --dry-run to skip API calls.")

    model = resolve_model(ANTHROPIC_KEY)

    payload = json.dumps({
        "model":      model,
        "max_tokens": MAX_TOKENS,
        "system":     SYSTEM_PROMPT,
        "messages":   [{"role": "user", "content": user_message}]
    }).encode('utf-8')

    req = urllib.request.Request(
        'https://api.anthropic.com/v1/messages',
        data=payload,
        headers={
            'x-api-key':         ANTHROPIC_KEY,
            'anthropic-version': '2023-06-01',
            'content-type':      'application/json',
        },
        method='POST'
    )

    try:
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', errors='replace')
        sys.exit(f"Claude API error {e.code}: {body}")

    text = "".join(
        b['text'] for b in data.get('content', []) if b.get('type') == 'text'
    )
    return text, model


# ---------------------------------------------------------------------------
# PARSE BRIDGE / REGISTER
# ---------------------------------------------------------------------------
def parse_bridge(text):
    lines = text.strip().split('\n')
    first = lines[0].strip()
    m = re.match(r'^BRIDGE:\s*(.+)$', first, re.IGNORECASE)
    if not m:
        return None, False, text
    bridge_text = m.group(1).strip()
    is_none = bool(re.match(r'^none\s*[—–-]', bridge_text, re.IGNORECASE)) or bridge_text.lower() == 'none'
    rest = "\n".join(lines[1:]).strip()
    return bridge_text, is_none, rest


def parse_register(text):
    m = re.search(r'REGISTER:\s*(senior|junior|unnarratable)', text, re.IGNORECASE)
    return m.group(1).lower() if m else 'unknown'


# ---------------------------------------------------------------------------
# OUTPUT PRINTER
# ---------------------------------------------------------------------------
DIVIDER = "─" * 60

def print_cluster_result(cluster, notes, response_text, dry_run=False):
    print()
    print(DIVIDER)
    print(f"STRATEGY : {cluster['strategy']}")
    print(f"THEME    : {cluster['theme']}")
    print(f"NOTES    : {', '.join(n['title'] for n in notes)}")
    print(DIVIDER)

    if dry_run:
        print("[DRY RUN — no API call made]")
        print()
        return

    bridge, is_unnarratable, rest = parse_bridge(response_text)
    register = parse_register(rest or response_text)

    if bridge:
        color_b = '\033[93m'  # yellow
        color_r = (
            '\033[92m' if register == 'senior'       # green
            else '\033[96m' if register == 'junior'  # cyan
            else '\033[91m'                           # red = unnarratable
        )
        reset = '\033[0m'
        print(f"{color_b}BRIDGE  : {bridge}{reset}")
        print(f"{color_r}REGISTER: {register}{reset}")
    else:
        print("⚠️  No BRIDGE line in response (model did not comply with format)")
        print(f"REGISTER: {register}")

    print()

    if is_unnarratable:
        print("  [UNNARRATABLE — no narrative produced]")
    else:
        body = re.sub(r'\n?REGISTER:\s*(senior|junior|unnarratable)\s*$', '', rest or response_text, flags=re.IGNORECASE).strip()
        # Wrap to 72 chars for readability
        for para in body.split('\n\n'):
            wrapped = textwrap.fill(para.strip(), width=72)
            print(wrapped)
            print()

    print(DIVIDER)


# ---------------------------------------------------------------------------
# LIST TAGS
# ---------------------------------------------------------------------------
def cmd_list_tags(conn, top_n=50):
    print(f"\nTop {top_n} tag roots by note count:\n")
    rows = conn.execute(
        "SELECT tag_root, COUNT(DISTINCT note_id) as c "
        "FROM note_tags GROUP BY tag_root ORDER BY c DESC LIMIT ?",
        (top_n,)
    ).fetchall()
    for root, c in rows:
        print(f"  {c:5d}  {root}")

    print(f"\nTop {top_n} leaf tags across multiple roots:\n")
    rows = conn.execute(
        "SELECT tag_leaf, COUNT(DISTINCT tag_root) as roots, COUNT(DISTINCT note_id) as notes "
        "FROM note_tags WHERE tag_root IS NOT NULL AND tag_leaf IS NOT NULL "
        "GROUP BY tag_leaf HAVING roots >= 2 "
        "ORDER BY roots DESC, notes DESC LIMIT ?",
        (top_n,)
    ).fetchall()
    for leaf, roots, notes in rows:
        print(f"  {roots:3d} roots  {notes:5d} notes  {leaf}")


# ---------------------------------------------------------------------------
# MAIN
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(
        description='QUARRY tag-based clustering experiment',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )
    parser.add_argument(
        '--strategy', choices=list(STRATEGIES.keys()), default='shared_root',
        help='Clustering strategy (default: shared_root)'
    )
    parser.add_argument(
        '--cluster-size', type=int, default=2,
        help='Number of notes per cluster, 2-5 (default: 2)'
    )
    parser.add_argument(
        '--tag', default=None,
        help='Filter by specific tag root (shared_root), leaf (cross_leaf), or substring (weak_tie)'
    )
    parser.add_argument(
        '--count', type=int, default=1,
        help='Number of clusters to generate (default: 1)'
    )
    parser.add_argument(
        '--dry-run', action='store_true',
        help='Print cluster info and user message only; skip API call'
    )
    parser.add_argument(
        '--list-tags', action='store_true',
        help='Print top tags and exit'
    )
    parser.add_argument(
        '--seed', type=int, default=None,
        help='Random seed for reproducibility'
    )

    args = parser.parse_args()

    if args.cluster_size < 2 or args.cluster_size > 5:
        parser.error("--cluster-size must be between 2 and 5")

    if args.seed is not None:
        random.seed(args.seed)

    conn = open_db()

    if args.list_tags:
        cmd_list_tags(conn)
        conn.close()
        return

    fn      = STRATEGIES[args.strategy]
    clusters = fn(conn, args.cluster_size, tag_filter=args.tag, count=args.count)

    if not clusters:
        print(f"[{args.strategy}] No clusters found. Try --list-tags to see available tags.")
        conn.close()
        return

    print(f"\n🪨 QUARRY Tag-Cluster Experiment")
    print(f"   Strategy    : {args.strategy}")
    print(f"   Cluster size: {args.cluster_size}")
    print(f"   Clusters    : {len(clusters)}")
    if args.dry_run:
        print(f"   Mode        : DRY RUN (no API calls)")

    for i, cluster in enumerate(clusters, 1):
        print(f"\n[{i}/{len(clusters)}] Building note blocks...")
        notes = []
        for nid in cluster['note_ids']:
            block = build_note_block(conn, nid)
            if block:
                notes.append(block)
            else:
                print(f"  ⚠️  Note {nid} not found in DB — skipping cluster")
                break

        if len(notes) < 2:
            print(f"  ⚠️  Too few readable notes in cluster — skipping")
            continue

        user_message = build_user_message(notes, cluster['theme'])

        if args.dry_run:
            print_cluster_result(cluster, notes, None, dry_run=True)
            print("USER MESSAGE (first 1200 chars):")
            print(user_message[:1200])
            print("...")
            continue

        response, model_used = call_claude(user_message)
        print(f"  Model: {model_used}")
        print_cluster_result(cluster, notes, response, dry_run=False)

    conn.close()
    print("\nDone.")


if __name__ == '__main__':
    main()
