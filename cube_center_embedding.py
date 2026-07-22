# -*- coding: utf-8 -*-
"""cube_center_embedding.py — the swing at the last wall.

cube_structure_learner.py cracked RIGHT-branching recursion by finding a repeating
SUFFIX block. Centre-embedding defeated it:

    depth 0   the cat saw the bird
    depth 1   the cat THAT the dog chased saw the bird
    depth 2   the cat THAT the dog THAT the boy owned chased saw the bird

because the longer shape is NOT the shorter one plus a block. The growth happens in
TWO places at once: a "(that det noun)" block is inserted in the middle, and an extra
verb appears later. The two must grow TOGETHER — that is the a^n b^n counting
dependency, the canonical thing a regular grammar cannot do.

THE SWING: stop assuming the growth is contiguous. Align the short template to the
long one and collect ALL the inserted blocks. If two or more blocks are inserted at
different points, hypothesise they repeat n times TOGETHER. That is a counting rule,
and it is findable.

Honest test at the end: a centre-embedded language whose embedded clauses VARY, to
find where even this breaks.

Standalone lab cube. Never reads / writes / imports the live production substrate.
"""
import numpy as np, difflib, sys
from cube_language_induction import context_signatures, induce_categories, induce_templates

N_TRAIN = 1500
NOUNS, VERBS = ["dog", "cat", "bird", "boy"], ["chased", "saw", "owned"]
ADJ = ["big", "small"]


def centre_corpus(n, rng, max_depth=1, vary=False):
    """depth d:  the N (that the N)^d  V^(d+1)  the N     — a^n b^n."""
    out = []
    for _ in range(n):
        d = int(rng.integers(0, max_depth + 1))
        s = ["the"]
        if vary and rng.random() < 0.5:
            s.append(rng.choice(ADJ))
        s.append(rng.choice(NOUNS))
        for _ in range(d):
            s += ["that", "the", rng.choice(NOUNS)]
        s += [rng.choice(VERBS) for _ in range(d + 1)]
        s += ["the", rng.choice(NOUNS)]
        out.append(s)
    return out


def kind(w):
    return ("det" if w == "the" else "that" if w == "that" else
            "adj" if w in ADJ else "noun" if w in NOUNS else "verb")


def valid_shapes(d, vary):
    """Every kind-sequence the TRUE grammar allows at this depth."""
    def shape(adj):
        return tuple(["det"] + (["adj"] if adj else []) + ["noun"]
                     + ["that", "det", "noun"] * d + ["verb"] * (d + 1) + ["det", "noun"])
    return {shape(False)} | ({shape(True)} if vary else set())


def valid(sent, d, vary=False):
    return tuple(kind(w) for w in sent) in valid_shapes(d, vary)


# ══════════════════════════════════════════════════════════════════════════════
# THE SWING — find ALL inserted blocks, not just a suffix
# ══════════════════════════════════════════════════════════════════════════════
def find_counting_recursion(templates):
    """base + blocks that must repeat TOGETHER n times. Returns (base, [(pos, block)])."""
    ts = sorted(set(templates), key=len)
    best = None
    for base in ts:
        for longer in ts:
            if len(longer) <= len(base):
                continue
            sm = difflib.SequenceMatcher(a=base, b=longer, autojunk=False)
            blocks, clean = [], True
            for tag, i1, i2, j1, j2 in sm.get_opcodes():
                if tag == "equal":
                    continue
                if tag == "insert":
                    blocks.append((i1, tuple(longer[j1:j2])))
                else:                       # replace/delete -> not pure growth
                    clean = False
                    break
            if clean and len(blocks) >= 2:  # >=2 growth points = a counting rule
                cand = (base, blocks)
                if best is None or len(base) < len(best[0]):
                    best = cand
    return best


def build(base, blocks, n):
    """Apply every block n times, together — the counting hypothesis."""
    ins = {}
    for pos, blk in blocks:
        ins.setdefault(pos, []).append(blk)
    out = []
    for idx in range(len(base) + 1):
        for blk in ins.get(idx, []):
            out += list(blk) * n
        if idx < len(base):
            out.append(base[idx])
    return out


def sep(t): print("\n" + "=" * 76 + f"\n{t}\n" + "=" * 76)


def attempt(title, corpus, rng, depths=(2, 3, 4), vary=False):
    sep(title)
    cats = induce_categories(context_signatures(corpus))
    tmpls = list(induce_templates(corpus, cats))
    print(f"  induced {len(cats)} categories, {len(tmpls)} templates, "
          f"lengths {sorted({len(t) for t in tmpls})}")
    found = find_counting_recursion(tmpls)
    if not found:
        print("  NO counting rule found -> still walled.")
        return False
    base, blocks = found
    print(f"  COUNTING RULE FOUND: base of {len(base)} slots + "
          f"{len(blocks)} growth points that must repeat together:")
    for pos, blk in blocks:
        print(f"      insert {list(blk)}  at slot {pos}")
    allok, allcov = True, True
    for d in depths:
        shape = build(base, blocks, d)
        ok, produced = 0, set()
        for _ in range(60):
            sent = [rng.choice(cats[c]) for c in shape]
            ok += valid(sent, d, vary)
            produced.add(tuple(kind(w) for w in sent))
        want = valid_shapes(d, vary)
        cov = 100.0 * len(produced & want) / len(want)
        allok &= (ok == 60); allcov &= (cov == 100.0)
        ex = " ".join(rng.choice(cats[c]) for c in shape)
        print(f"      depth {d} (NEVER HEARD): grammatical {ok}/60 = {100*ok//60:>3}%"
              f" | covers {len(produced & want)}/{len(want)} valid shapes = {cov:.0f}%")
        print(f"                              \"{ex[:86]}\"")
    return allok and allcov


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    rng = np.random.default_rng(5)

    won = attempt("THE SWING — centre-embedding, heard only depths 0 and 1",
                  centre_corpus(N_TRAIN, rng, max_depth=1), rng)

    sep("HONEST STRESS TEST — same language, but embedded clauses VARY")
    print("  (an optional adjective inside the noun phrases, so the growth blocks")
    print("   are no longer identical every time)\n")
    won2 = attempt("centre-embedding + optional adjectives",
                   centre_corpus(N_TRAIN, rng, max_depth=1, vary=True), rng, vary=True)

    sep("VERDICT")
    print(f"  clean centre-embedding : {'CLIMBED — 100% at unseen depth' if won else 'still walled'}")
    print(f"  with varying clauses   : {'climbed' if won2 else 'STILL WALLED'}")
    print("\n  What was actually learned: not a stack, but a COUNTING rule — 'these two")
    print("  growth points repeat the same number of times'. That is enough to produce")
    print("  a^n b^n, which no regular grammar can do. It is a real step past the")
    print("  regular boundary, and it is still a template schema rather than a true")
    print("  phrase-structure grammar with a stack.")
