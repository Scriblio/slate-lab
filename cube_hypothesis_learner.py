# -*- coding: utf-8 -*-
"""cube_hypothesis_learner.py — the honest fix: hypotheses, then evidence.

cube_integrated_learner.py composed the two learners (factor, then count) and FAILED
worse than before (0% where the naive version got 50%). The diagnosis is more useful
than the failure:

    From depth 0 and depth 1 ALONE, the recursion is UNDERDETERMINED.
    "insert (that det noun) here AND (verb) there"      -> correct
    "insert (that det noun verb) as one block"          -> also explains depth 1
    Both reproduce everything heard. They disagree at depth 2.

So the earlier centre-embedding win was partly luck — difflib happened to pick the
right decomposition. An aligner cannot choose correctly, because the evidence it was
given does not contain the answer.

THE FIX — proper induction instead of a lucky alignment:
    1. ENUMERATE every decomposition consistent with what was heard.
    2. Have each one PREDICT a deeper structure.
    3. KEEP only those whose prediction matches held-out evidence.
That is hypothesis generation and selection, and it is what the earlier code skipped.

Standalone lab cube. Never reads / writes / imports the live production substrate.
"""
import numpy as np, sys
from cube_language_induction import context_signatures, induce_categories, induce_templates
from cube_structure_learner import collapse_optional, expand
from cube_center_embedding import centre_corpus, kind, valid_shapes

N_TRAIN = 2600


# ── enumerate EVERY way the short rule embeds in the long one ─────────────────
def embeddings(base, longer):
    n, m = len(base), len(longer)
    def rec(i, j, acc):
        if i == n:
            yield tuple(acc); return
        if m - j < n - i:
            return
        for k in range(j, m):
            if longer[k] == base[i]:
                yield from rec(i + 1, k + 1, acc + [k])
    yield from rec(0, 0, [])


def blocks_of(base, longer, emb):
    used, blocks, consumed, run = set(emb), [], 0, []
    for idx in range(len(longer)):
        if idx in used:
            if run:
                blocks.append((consumed, tuple(run))); run = []
            consumed += 1
        else:
            run.append(longer[idx])
    if run:
        blocks.append((consumed, tuple(run)))
    return tuple(blocks)


def hypotheses(base, longer, cap=4000):
    out = set()
    for i, emb in enumerate(embeddings(base, longer)):
        if i > cap:
            break
        out.add(blocks_of(base, longer, emb))
    return sorted(out, key=lambda b: (len(b), b))


def build_rule(base_items, blocks, n):
    ins = {}
    for pos, blk in blocks:
        ins.setdefault(pos, []).append(blk)
    out = []
    for idx in range(len(base_items) + 1):
        for blk in ins.get(idx, []):
            out += list(blk) * n
        if idx < len(base_items):
            out.append(base_items[idx])
    return tuple(out)


def sample(items, cats, rng):
    return [rng.choice(cats[c]) for c, o in items if not (o and rng.random() < 0.5)]


def sep(t): print("\n" + "=" * 76 + f"\n{t}\n" + "=" * 76)


def run(title, vary, rng, heard_depth=2, test_depths=(3, 4, 5)):
    sep(title)
    corpus = centre_corpus(N_TRAIN, rng, max_depth=heard_depth, vary=vary)
    cats = induce_categories(context_signatures(corpus))
    tmpls = set(induce_templates(corpus, cats))
    rules = collapse_optional([t for t in tmpls])
    by_len = sorted(rules, key=len)
    base, mid = by_len[0], by_len[1]
    print(f"  heard depths 0..{heard_depth}: {len(tmpls)} templates -> "
          f"{len(rules)} factored rules")

    cands = hypotheses(base, mid)
    print(f"  hypotheses consistent with depth 0->1 : {len(cands)}  "
          f"(they all explain what was heard)")

    # SELECT: which hypothesis correctly predicts the DEEPER structure we held out?
    survivors = []
    for blocks in cands:
        pred = expand(build_rule(base, blocks, 2))
        obs = {t for t in tmpls if len(t) in {len(p) for p in pred}}
        if pred and pred == obs:
            survivors.append(blocks)
    print(f"  survive prediction of depth 2         : {len(survivors)}")
    if not survivors:
        print("  -> no hypothesis survives. walled.")
        return False
    blocks = survivors[0]
    for pos, blk in blocks:
        print(f"      growth: {[c for c, o in blk]} at slot {pos}")

    good = True
    for d in test_depths:
        items = build_rule(base, blocks, d)
        ok, produced = 0, set()
        for _ in range(150):
            s = sample(items, cats, rng)
            ok += tuple(kind(w) for w in s) in valid_shapes(d, vary)
            produced.add(tuple(kind(w) for w in s))
        want = valid_shapes(d, vary)
        cov = 100.0 * len(produced & want) / len(want)
        good &= (ok == 150 and cov == 100.0)
        print(f"      depth {d} (NEVER HEARD): grammatical {ok}/150 = {100*ok//150:>3}%"
              f" | covers {len(produced & want)}/{len(want)} shapes = {cov:.0f}%")
    return good


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    rng = np.random.default_rng(5)

    sep("FIRST — show the ambiguity that broke the naive learner")
    corpus = centre_corpus(N_TRAIN, rng, max_depth=1, vary=True)
    cats = induce_categories(context_signatures(corpus))
    tm = set(induce_templates(corpus, cats))
    rls = sorted(collapse_optional([t for t in tm]), key=len)
    hs = hypotheses(rls[0], rls[1])
    print(f"  hearing ONLY depths 0 and 1, there are {len(hs)} decompositions that")
    print("  each fully explain what was heard. Their depth-2 predictions differ:")
    for blocks in hs[:4]:
        pred = build_rule(rls[0], blocks, 2)
        print(f"     {[ [c for c,o in b] for _,b in blocks ]}"
              f"  -> depth2 length {len(pred)}")
    print("  With two depths, nothing in the data picks the right one. That's why")
    print("  the aligner's arbitrary choice decided success or failure.")

    a = run("CONTROL — clean centre-embedding, now with depth 2 as evidence",
            False, rng)
    b = run("THE TEST — centre-embedding + optional adjective (was 50%, then 0%)",
            True, rng)

    sep("SCOREBOARD")
    print(f"  clean centre-embedding   : {'PASS' if a else 'FAIL'}")
    print(f"  varying centre-embedding : {'PASS' if b else 'FAIL'}")
    print("\n  The fix was not a cleverer aligner. It was giving the learner enough")
    print("  evidence to CHOOSE between hypotheses it generated itself — which is")
    print("  what induction actually is.")
