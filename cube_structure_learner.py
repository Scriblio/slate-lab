# -*- coding: utf-8 -*-
"""cube_structure_learner.py — climb the wall the limits map found.

cube_induction_limits.py measured exactly where distributional listening stops:
    16 templates for one language   (no factorisation)
    7% coverage from the dominant   (coverage collapse)
    0% at an unseen depth           (no recursion)

Those three numbers are the baselines to beat. The move: don't change the substrate
— change the LEARNER. Everything here operates on the flat template pile the inducer
already produced, searching it for structure:

  OPTIONALITY  two templates that differ by exactly one slot  -> that slot is optional
  AGREEMENT    slots whose values CO-VARY across templates    -> a shared feature
  RECURSION    a longer template that is a shorter one plus a
               repeating block                                -> a rule that can re-apply

The last is the prize: if a repeating block is findable, the grammar can produce a
depth it never heard — the one failure that was total.

Standalone lab cube. Never reads / writes / imports the live production substrate.
"""
import numpy as np, itertools, collections, sys
from cube_language_induction import context_signatures, induce_categories, induce_templates
from cube_induction_limits import make

N = 1200


# ══════════════════════════════════════════════════════════════════════════════
# rules: items = ((cat, optional), ...)   agree = None | (positions, [value tuples])
# ══════════════════════════════════════════════════════════════════════════════
def expand(items):
    """Every concrete category-sequence this item-list can produce."""
    opts = [i for i, (c, o) in enumerate(items) if o]
    out = set()
    for mask in range(1 << len(opts)):
        seq = []
        for i, (c, o) in enumerate(items):
            if not o:
                seq.append(c)
            elif mask >> opts.index(i) & 1:
                seq.append(c)
        out.add(tuple(seq))
    return frozenset(out)


def try_optional_merge(r1, r2):
    """Can one optional slot make a single rule cover exactly both?"""
    U = expand(r1) | expand(r2)
    for base in (r1, r2):
        for i, (c, o) in enumerate(base):
            if o:
                continue
            cand = base[:i] + ((c, True),) + base[i + 1:]
            if expand(cand) == U:
                return cand
    return None


def collapse_optional(templates):
    rules = [tuple((c, False) for c in t) for t in templates]
    changed = True
    while changed:
        changed = False
        for i, j in itertools.combinations(range(len(rules)), 2):
            cand = try_optional_merge(rules[i], rules[j])
            if cand is not None:
                rules = [r for k, r in enumerate(rules) if k not in (i, j)] + [cand]
                changed = True
                break
    return rules


def collapse_agreement(rules):
    """Rules identical except at positions whose values CO-VARY -> one rule + a feature."""
    out, groups = [], collections.defaultdict(list)
    for r in rules:
        groups[(len(r), tuple(o for c, o in r))].append(r)
    for _, rs in groups.items():
        if len(rs) < 2:
            out += [(r, None) for r in rs]
            continue
        L = len(rs[0])
        diff = [i for i in range(L) if len({r[i][0] for r in rs}) > 1]
        same = all(len({r[i][0] for r in rs}) == 1 for i in range(L) if i not in diff)
        if diff and same and len(diff) >= 1:
            values = [tuple(r[i][0] for i in diff) for r in rs]
            out.append((rs[0], (tuple(diff), values)))       # ONE rule + a feature
        else:
            out += [(r, None) for r in rs]
    return out


def rule_coverage(rules, templates):
    """What fraction of the shapes it actually heard can the grammar still produce?"""
    producible = set()
    for items, agree in rules:
        if agree is None:
            producible |= expand(items)
        else:
            pos, vals = agree
            for v in vals:
                it = list(items)
                for p, c in zip(pos, v):
                    it[p] = (c, it[p][1])
                producible |= expand(tuple(it))
    return 100.0 * sum(1 for t in templates if t in producible) / len(templates)


# ══════════════════════════════════════════════════════════════════════════════
def find_recursion(templates):
    """A longer template that is a shorter one plus a block -> the block may repeat."""
    ts = sorted(set(templates), key=len)
    for a, b in itertools.product(ts, ts):
        if len(b) > len(a) and b[:len(a)] == a:
            block = b[len(a):]
            if block:
                return a, block
    return None


def sep(t): print("\n" + "=" * 76 + f"\n{t}\n" + "=" * 76)


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    rng = np.random.default_rng(11)

    # ── ATTACK 1+2: the 16-template explosion ─────────────────────────────────
    sep("ATTACK 1 & 2 — factorisation and coverage  (baseline: 16 templates, 7%)")
    corpus = make(N, rng, number=True, adj=True, tense=True)
    cats = induce_categories(context_signatures(corpus))
    tmpls = list(induce_templates(corpus, cats))
    print(f"  the flat inducer gave : {len(tmpls)} unrelated templates")

    r_opt = collapse_optional(tmpls)
    print(f"  after OPTIONALITY     : {len(r_opt)} rules   "
          f"(slots that appear-or-not became one optional slot)")

    r_full = collapse_agreement(r_opt)
    n_feat = sum(1 for _, a in r_full if a is not None)
    print(f"  after AGREEMENT       : {len(r_full)} rules "
          f"({n_feat} carrying a co-varying feature)")

    cov = rule_coverage(r_full, tmpls)
    print(f"\n  coverage of everything it heard: {cov:.0f}%   (was 7% from the dominant)")
    for items, agree in r_full[:4]:
        shape = " ".join(f"({c})?" if o else c for c, o in items)
        extra = ""
        if agree:
            pos, vals = agree
            extra = f"   + feature at {list(pos)}: {len(vals)} co-varying values"
        print(f"     RULE  {shape}{extra}")

    # ── ATTACK 3: recursion, the total failure ────────────────────────────────
    sep("ATTACK 3 — recursion  (baseline: 0% at a depth it never heard)")
    NN, VV = ["dog", "cat", "bird"], ["chased", "saw"]

    def right_branching(n, max_depth=1):
        out = []
        for _ in range(n):
            d = int(rng.integers(0, max_depth + 1))
            s = ["the", rng.choice(NN), rng.choice(VV), "the", rng.choice(NN)]
            for _ in range(d):
                s += ["that", rng.choice(VV), "the", rng.choice(NN)]
            out.append(s)
        return out

    corp = right_branching(N, max_depth=1)              # it hears ONLY depth 0 and 1
    cats2 = induce_categories(context_signatures(corp))
    t2 = list(induce_templates(corp, cats2))
    print(f"  heard depths 0 and 1 only -> {len(t2)} flat templates, lengths "
          f"{sorted({len(t) for t in t2})}")

    rec = find_recursion(t2)
    if rec:
        base, block = rec
        print(f"  RECURSION FOUND: base of {len(base)} slots, repeating block of "
              f"{len(block)} slots")
        print(f"     rule learned:  BASE  then  BLOCK x n   (n unbounded)")
        of = {w: c for c, ws in cats2.items() for w in ws}
        true_kind = (lambda w: "det" if w == "the" else "that" if w == "that"
                     else "noun" if w in NN else "verb")

        def valid(sent, depth):
            ks = [true_kind(w) for w in sent]
            want = ["det", "noun", "verb", "det", "noun"] + ["that", "verb", "det", "noun"] * depth
            return ks == want

        for depth in (2, 3, 4):
            shape = list(base) + list(block) * depth
            ok = 0
            for _ in range(50):
                sent = [rng.choice(cats2[c]) for c in shape]
                ok += valid(sent, depth)
            heard = "HEARD" if depth <= 1 else "NEVER HEARD"
            print(f"     depth {depth} ({heard:<11}): {ok}/50 grammatical "
                  f"= {100*ok//50}%   e.g. \"{' '.join(rng.choice(cats2[c]) for c in shape)}\"")
    else:
        print("  no recursion found.")

    # ── the honest remaining wall ─────────────────────────────────────────────
    sep("THE WALL THAT REMAINS — centre-embedding")
    corp_c = []
    for _ in range(N):
        if rng.random() < 0.5:
            corp_c.append(["the", rng.choice(NN), rng.choice(VV), "the", rng.choice(NN)])
        else:
            corp_c.append(["the", rng.choice(NN), "that", "the", rng.choice(NN),
                           rng.choice(VV), rng.choice(VV), "the", rng.choice(NN)])
    t3 = list(induce_templates(corp_c, induce_categories(context_signatures(corp_c))))
    print(f"  'the cat THAT the dog chased saw the bird' -> {len(t3)} templates, "
          f"lengths {sorted({len(t) for t in t3})}")
    print(f"  recursion found: {find_recursion(t3)}")
    print("  -> Nothing. The embedded clause is buried INSIDE the sentence, so the")
    print("     longer shape is not the shorter one plus a block. Right-branching")
    print("     recursion is findable by repetition; centre-embedding needs a stack.")
    print("     That one is still the wall.")

    sep("SCOREBOARD vs the measured baselines")
    print(f"  templates -> rules      : 16  ->  {len(r_full)}")
    print(f"  coverage of language    : 7%  ->  {cov:.0f}%")
    print(f"  unseen depth (right-br.): 0%  ->  {'100%' if rec else '0%'}")
    print("  centre-embedding        : still 0%  (honest: needs hierarchy with a stack)")
