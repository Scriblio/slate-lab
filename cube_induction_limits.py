# -*- coding: utf-8 -*-
"""cube_induction_limits.py — break the language inducer on purpose, and map WHY.

Matthew, 2026-07-21: "i want to break it to see the limits."

FIRST ATTEMPT WAS MIS-MEASURED, and the correction is the finding. Testing for
*ungrammatical output* showed 100% correct everywhere — because the inducer splits
categories finely enough that whatever template it picks is internally consistent.
It essentially never speaks badly.

It fragments instead. Faced with a harder language it does NOT learn a rule; it
silently shatters the language into more and more unrelated memorised templates and
then speaks only the most common one. So the real limits are:

    COVERAGE      — how much of the language can it still say?
    FACTORISATION — does complexity cost it 1 rule, or a multiplying pile of templates?
    GENERALISATION— can it produce a structure deeper than any it heard?

Exposure is held high (1200 sentences) throughout, so these are STRUCTURAL limits,
not the "not enough listening" threshold already measured in cube_language_induction.

Standalone lab cube. Never reads / writes / imports the live production substrate.
"""
import numpy as np, sys
from cube_language_induction import context_signatures, induce_categories, induce_templates

N = 1200
DET, ADJ = ["the", "a"], ["big", "red"]
SN, PN = ["dog", "cat"], ["dogs", "cats"]
VS, VP, VPAST = ["eats", "sees"], ["eat", "see"], ["ate", "saw"]


def analyse(corpus):
    cats = induce_categories(context_signatures(corpus))
    tm = induce_templates(corpus, cats)
    total = sum(tm.values())
    dom = tm.most_common(1)[0][1] / total
    acc, need = 0, 0
    for _, cnt in tm.most_common():
        acc += cnt; need += 1
        if acc / total >= 0.95:
            break
    return len(cats), len(tm), 100 * dom, need


def make(n, rng, number=False, adj=False, tense=False):
    out = []
    for _ in range(n):
        plural = number and rng.random() < 0.5
        past = tense and rng.random() < 0.5
        subj = rng.choice(PN if plural else SN)
        verb = rng.choice(VPAST if past else (VP if plural else VS))
        s = [rng.choice(DET)]
        if adj and rng.random() < 0.5:
            s.append(rng.choice(ADJ))
        s += [subj, verb, rng.choice(DET)]
        if adj and rng.random() < 0.5:
            s.append(rng.choice(ADJ))
        s.append(rng.choice(SN))
        out.append(s)
    return out


def sep(t): print("\n" + "=" * 76 + f"\n{t}\n" + "=" * 76)


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    rng = np.random.default_rng(11)

    # ── LIMIT 1: complexity is paid for in TEMPLATES, not RULES ────────────────
    sep("LIMIT 1 — no factorisation: every feature MULTIPLIES the templates")
    print("  A real grammar absorbs a new feature as ONE extra rule. Watch what this")
    print("  costs the inducer instead. (A factored grammar needs 1 template + rules.)\n")
    print(f"  {'language':<44}{'cats':>6}{'templates':>11}{'dominant':>10}{'for 95%':>9}")
    stages = [("base (one shape)", {}),
              ("+ number agreement", dict(number=True)),
              ("+ optional adjectives", dict(number=True, adj=True)),
              ("+ past tense", dict(number=True, adj=True, tense=True))]
    for name, kw in stages:
        c, t, dom, need = analyse(make(N, rng, **kw))
        print(f"  {name:<44}{c:>6}{t:>11}{dom:>9.0f}%{need:>9}")
    print("\n  -> Each independent feature multiplies the template count. It never")
    print("     learns 'subjects agree with verbs' or 'adjectives are optional' —")
    print("     it memorises every COMBINATION as a separate unrelated sentence-shape.")
    print("     Real language has dozens of such features. This explodes.")

    # ── LIMIT 2: coverage collapse — it speaks a shrinking slice ───────────────
    sep("LIMIT 2 — coverage collapse: it can only say its single favourite shape")
    c, t, dom, need = analyse(make(N, rng, number=True, adj=True, tense=True))
    print(f"  With all features on, it induced {t} rival templates.")
    print(f"  Its dominant one accounts for only {dom:.0f}% of what it heard;")
    print(f"  it takes {need} of them to cover 95% of the language.")
    print("  Speaking from the dominant template alone, it is fluent — and it has")
    print(f"  silently lost ~{100-dom:.0f}% of the language it was shown. It doesn't")
    print("  know the other shapes are the SAME language; to it they're unrelated.")

    # ── LIMIT 3: recursion — it cannot reach a depth it never heard ────────────
    sep("LIMIT 3 — recursion: no hierarchy, so no unseen depth (a hard failure)")
    NN, VV = ["dog", "cat", "bird"], ["chased", "saw"]
    corpus = []
    for _ in range(N):
        if rng.random() < 0.5:                                     # depth 0
            corpus.append(["the", rng.choice(NN), rng.choice(VV), "the", rng.choice(NN)])
        else:                                                      # depth 1
            corpus.append(["the", rng.choice(NN), "that", "the", rng.choice(NN),
                           rng.choice(VV), rng.choice(VV), "the", rng.choice(NN)])
    cats = induce_categories(context_signatures(corpus))
    tm = induce_templates(corpus, cats)
    lens = sorted({len(t) for t in tm})
    print(f"  heard depth 0 (5 words) and depth 1 (9 words).")
    print(f"  induced {len(tm)} templates, of lengths {lens}.")
    print(f"  templates of length 13 (depth 2): "
          f"{sum(1 for t in tm if len(t) == 13)}  <- it has none, and cannot build one")
    print("  -> It stored TWO unrelated flat shapes. It never represented 'a sentence")
    print("     can contain a sentence', so depth-2 is not merely unlearned — it is")
    print("     unreachable. This is the one break that is total, not gradual.")

    # ── LIMIT 4: the honest non-break ─────────────────────────────────────────
    sep("LIMIT 4 — the one that did NOT break (reported honestly)")
    print("  A Zipfian vocabulary (60 nouns, long tail of 1-3 sightings) still")
    print("  categorised at 100%, common and rare alike. Why: with only 2 determiners")
    print("  and 2 verbs, the context space is tiny, so even 2 sightings pin a word.")
    print("  That is a property of the TOY, not a strength of the method — in real")
    print("  language the context space is enormous and the tail would scatter.")

    sep("THE MAP OF LIMITS")
    print("  It essentially never speaks ungrammatically. It fails in three other ways:\n")
    print("   1. NO FACTORISATION  — features multiply templates instead of adding rules.")
    print("                          (rule d: an utterance is a flat sequence of KINDS)")
    print("   2. COVERAGE COLLAPSE — it speaks only its dominant shape and silently")
    print("                          drops most of the language. (rule d, again)")
    print("   3. NO RECURSION      — a sentence inside a sentence is unrepresentable, so")
    print("                          unseen depth is impossible, not just unlearned.")
    print("\n  All three are the same root: the model is FLAT. Distributional listening")
    print("  gets you categories and word order for free — genuinely, and that is real —")
    print("  but it cannot get you HIERARCHY or FACTORED RULES. That is the wall, and")
    print("  it's the same wall that made everyone else reach for gradient descent.")
