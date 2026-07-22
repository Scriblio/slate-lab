# -*- coding: utf-8 -*-
"""cube_integrated_learner.py — compose the two learners: FACTOR FIRST, THEN COUNT.

The centre-embedding swing crossed the regular boundary but only on a language with
ONE clean shape. Add an optional adjective and coverage fell to 50%: the counting
detector picked a single base TEMPLATE and silently dropped its rivals. The two
learners never spoke to each other.

    cube_structure_learner   solved variation      (optionality / agreement)
    cube_center_embedding    solved unseen depth   (a^n b^n counting)
    ...but not at the same time.

THE INTEGRATION: run the optionality collapse FIRST, then detect counting recursion
over the FACTORED RULES rather than the raw templates. The growth points are then
found on a rule that already carries the optional slot — so optionality survives all
the way into the depth-n output.

SCOREBOARD (no room to flatter it): does the varying centre-embedded language go
from 50% -> 100% coverage at a depth it never heard?

Standalone lab cube. Never reads / writes / imports the live production substrate.
"""
import numpy as np, difflib, sys
from cube_language_induction import context_signatures, induce_categories, induce_templates
from cube_structure_learner import collapse_optional
from cube_center_embedding import centre_corpus, kind, valid_shapes

N_TRAIN = 1500


def find_counting_over_rules(rules):
    """Same alignment trick, but over FACTORED rules (items = (cat, optional))."""
    rs = sorted(set(rules), key=len)
    for base in rs:
        for longer in rs:
            if len(longer) <= len(base):
                continue
            sm = difflib.SequenceMatcher(a=base, b=longer, autojunk=False)
            blocks, clean = [], True
            for tag, i1, i2, j1, j2 in sm.get_opcodes():
                if tag == "equal":
                    continue
                if tag == "insert":
                    blocks.append((i1, tuple(longer[j1:j2])))
                else:
                    clean = False
                    break
            if clean and blocks:
                return base, blocks
    return None


def build_rule(base_items, blocks, n):
    """Apply every growth block n times, together — optional slots preserved."""
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


def sample(rule_items, cats, rng):
    seq = []
    for c, opt in rule_items:
        if opt and rng.random() < 0.5:
            continue
        seq.append(rng.choice(cats[c]))
    return seq


def sep(t): print("\n" + "=" * 76 + f"\n{t}\n" + "=" * 76)


def run(title, vary, rng, depths=(2, 3, 4)):
    sep(title)
    corpus = centre_corpus(N_TRAIN, rng, max_depth=1, vary=vary)
    cats = induce_categories(context_signatures(corpus))
    tmpls = list(induce_templates(corpus, cats))
    print(f"  raw templates from listening : {len(tmpls)}  "
          f"(lengths {sorted({len(t) for t in tmpls})})")

    rules = collapse_optional(tmpls)                      # <-- FACTOR FIRST
    n_opt = sum(1 for r in rules for c, o in r if o)
    print(f"  after factoring              : {len(rules)} rules "
          f"({n_opt} optional slot(s) absorbed)")

    found = find_counting_over_rules(rules)               # <-- THEN COUNT
    if not found:
        print("  no counting rule found -> walled.")
        return False
    base, blocks = found
    print(f"  counting rule over rules     : base of {len(base)} slots + "
          f"{len(blocks)} growth point(s) repeating together")
    shape = " ".join(f"({c})?" if o else c for c, o in base)
    print(f"      base rule : {shape}")
    for pos, blk in blocks:
        print(f"      grows by  : {[c for c, o in blk]} at slot {pos}")

    allgood = True
    for d in depths:
        items = build_rule(base, blocks, d)
        ok, produced = 0, set()
        for _ in range(120):
            s = sample(items, cats, rng)
            ok += tuple(kind(w) for w in s) in valid_shapes(d, vary)
            produced.add(tuple(kind(w) for w in s))
        want = valid_shapes(d, vary)
        cov = 100.0 * len(produced & want) / len(want)
        allgood &= (ok == 120 and cov == 100.0)
        print(f"      depth {d} (NEVER HEARD): grammatical {ok}/120 = {100*ok//120:>3}%"
              f" | covers {len(produced & want)}/{len(want)} shapes = {cov:.0f}%")
    return allgood


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    rng = np.random.default_rng(5)
    a = run("CONTROL — clean centre-embedding (was already 100%)", False, rng)
    b = run("THE TEST — centre-embedding + optional adjective (was 50% coverage)",
            True, rng)

    sep("SCOREBOARD")
    print(f"  clean centre-embedding        : {'PASS' if a else 'FAIL'}  "
          f"(grammatical + full coverage at unseen depth)")
    print(f"  varying centre-embedding      : {'PASS — 50% -> 100%' if b else 'FAIL'}")
    print("\n  Composing the two learners is what did it: factoring absorbs the")
    print("  variation into an optional slot, so the counting detector aligns two")
    print("  RULES instead of two rival templates — and the optional slot rides")
    print("  along into depths the language was never heard at.")
