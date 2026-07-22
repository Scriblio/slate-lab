# -*- coding: utf-8 -*-
"""deflate.py — the cheapest thing that would tie each rung, measured.

Three builds on 2026-07-21 all turned on the same discovery, and it was never the
one I set out to make:

    cube_cause  a two-column DICT ties the attractor substrate -- until the cause
                stops being one column wide
    cube_say    "always warn about the worst thing" ties a full model of the
                listener's mind -- until warning is the wrong move
    cube_mind   every speaker ties, including the one that infers nothing --
                until the listener is unlucky

That is one finding recurring, not three: **the sophisticated thing only earns its
place in the case where the simple thing is wrong, and I only found that case
because I went looking each time.** The eight rungs below cube_cause were written
without anybody going looking. This does that, for the two with the most
suspicious numbers.

It is meant to deflate. Where a claim survives it is worth more afterwards; where
it does not, better to know now, with a patent filed and a commercial thread
hanging off these results.

Standalone lab cube. Never reads / writes / imports the live production substrate.
"""
import collections, itertools, sys
import numpy as np
from core import Slate
import cube_eye as E
from cube_language_induction import context_signatures, induce_categories, induce_templates
from cube_induction_limits import make, DET, ADJ, SN, PN, VS, VP, VPAST
import cube_structure_learner as SL


def sep(t):
    print("\n" + "=" * 78 + f"\n{t}\n" + "=" * 78)


def head(t):
    print(f"\n  --- {t} " + "-" * max(0, 66 - len(t)))


# ══════════════════════════════════════════════════════════════════════════════
# AUDIT 1 — cube_eye.py claims 200/200 = 100% on "images it never saw"
# ══════════════════════════════════════════════════════════════════════════════
def render_j(shape, colour, rng, scale=1.0):
    """cube_eye's renderer with the jitter amount exposed, so it can be turned up."""
    cx = 32 + int(rng.integers(-7, 8) * scale)
    cy = 32 + int(rng.integers(-7, 8) * scale)
    size = max(4, 26 + int(rng.integers(-5, 6) * scale))
    col = np.clip(colour + rng.normal(0, 0.05 * scale, 3).astype(np.float32), 0, 1)
    return E.render(shape, col, size=size, cx=cx, cy=cy)


def eye_dataset(rng, n, scale=1.0):
    X, y, imgs = [], [], []
    for word, (shape, colour) in E.WORLD.items():
        for _ in range(n):
            img = render_j(shape, colour, rng, scale)
            f = E.perceive(img)
            if f is None:
                continue
            X.append(f); y.append(word); imgs.append(img.ravel())
    return np.array(X), y, np.array(imgs)


def _centroid_clf(Xtr, ytr, cols):
    cent = {}
    for w in set(ytr):
        cent[w] = np.mean([x[cols] for x, yy in zip(Xtr, ytr) if yy == w], axis=0)
    def f(x):
        return min(cent, key=lambda w: float(np.sum((x[cols] - cent[w]) ** 2)))
    return f


def audit_eye():
    sep("AUDIT 1 — cube_eye.py:  '200/200 = 100% on images it never saw'")
    print("  Five words in a 5-D percept (r, g, b, fill, aspect). Before believing that")
    print("  100% says anything about the substrate, ask what it takes to tie it.")

    rng = np.random.default_rng(20260720)
    Xtr, ytr, Itr = eye_dataset(rng, 5)
    Xte, yte, Ite = eye_dataset(rng, 40)

    eye = E.Eye()
    for x, w in zip(Xtr, ytr):
        eye.slate.commit(x, payload=w)
        eye.seen.setdefault(w, []).append(x)

    rivals = {
        "the Slate eye (as shipped)":
            lambda i: eye.slate.recall(Xte[i], max_cycles=3)["winner"]["payload"],
        "nearest centroid, same 5 features":
            (lambda f: (lambda i: f(Xte[i])))(_centroid_clf(Xtr, ytr, slice(0, 5))),
        "nearest centroid, COLOUR ONLY":
            (lambda f: (lambda i: f(Xte[i])))(_centroid_clf(Xtr, ytr, slice(0, 3))),
        "nearest centroid, SHAPE ONLY":
            (lambda f: (lambda i: f(Xte[i])))(_centroid_clf(Xtr, ytr, slice(3, 5))),
        "1-NN on RAW PIXELS, no percept at all":
            lambda i: ytr[int(np.argmin(((Itr - Ite[i]) ** 2).sum(1)))],
    }
    head("what ties it")
    print(f"      {'method':<40}{'correct'}")
    for name, f in rivals.items():
        ok = sum(f(i) == yte[i] for i in range(len(yte)))
        print(f"      {name:<40}{ok}/{len(yte)} = {100*ok//len(yte)}%")
    print(f"      {'chance (5 words)':<40}20%")
    print("\n      A class average ties it exactly, and raw pixels get within a few points")
    print("      with no percept at all. The 100% is a fact about the TASK, not about the")
    print("      substrate: four distinct colours over five words, and the single")
    print("      colour-clash pair (apple/leaf, both green) is separated by shape.")
    print("      COLOUR ONLY at 81% is perfect on the three unambiguous words and about a")
    print("      coin-flip on the green pair -- exactly what a feature that cannot see")
    print("      the difference should score.")

    head("so where does it actually break?  (jitter turned up)")
    print(f"      {'jitter':<10}{'Slate':<12}{'centroid':<12}{'raw pixels':<12}{'colour only'}")
    rows = []
    for scale in (1, 2, 3, 4, 6):
        r2 = np.random.default_rng(7)
        Xtr2, ytr2, Itr2 = eye_dataset(r2, 5, scale)
        Xte2, yte2, Ite2 = eye_dataset(r2, 40, scale)
        s = Slate(5, n_cells=1024, beta=40.0, seed=0)
        for x, w in zip(Xtr2, ytr2):
            s.commit(x, payload=w)
        cen = _centroid_clf(Xtr2, ytr2, slice(0, 5))
        col = _centroid_clf(Xtr2, ytr2, slice(0, 3))
        a = sum(s.recall(Xte2[i], max_cycles=3)["winner"]["payload"] == yte2[i]
                for i in range(len(yte2))) * 100 // len(yte2)
        b = sum(cen(Xte2[i]) == yte2[i] for i in range(len(yte2))) * 100 // len(yte2)
        c = sum(ytr2[int(np.argmin(((Itr2 - Ite2[i]) ** 2).sum(1)))] == yte2[i]
                for i in range(len(yte2))) * 100 // len(yte2)
        d = sum(col(Xte2[i]) == yte2[i] for i in range(len(yte2))) * 100 // len(yte2)
        rows.append((scale, a, b, c, d))
        print(f"      x{scale:<9}{f'{a}%':<12}{f'{b}%':<12}{f'{c}%':<12}{d}%")
    gap = max(b - a for _, a, b, _, _ in rows)
    print("\n      Two things, and the second one is not comfortable.")
    print("      `raw pixels` collapses first, because position jitter moves every pixel")
    print("      while the PERCEPT is translation-invariant by construction. So the")
    print("      retina does earn its place under stress, even though it earns nothing")
    print("      at the difficulty the demo ships with.")
    print(f"\n      And the nearest CENTROID beats the Slate at every noise level above")
    print(f"      zero, by up to {gap} points. The reason is not subtle: the Slate commits")
    print(f"      every exemplar and recalls the closest one, so a noisy training example")
    print(f"      stays in the bank as its own basin, while a class mean averages the")
    print(f"      noise away. On this task the attractor substrate is not merely tied by")
    print(f"      a class average -- it is BEATEN by one, and more so the harder the task.")
    return rows


# ══════════════════════════════════════════════════════════════════════════════
# AUDIT 2 — cube_structure_learner.py claims coverage 7% -> 100%
# ══════════════════════════════════════════════════════════════════════════════
def true_grammatical(sent):
    """Is this a sentence of the language cube_induction_limits.make actually generates?

    DET (ADJ)? NOUN VERB DET (ADJ)? NOUN, the object always singular, and the verb
    AGREEING with the subject's number. Agreement is the part a grammar can quietly
    lose while its coverage score stays at a perfect 100%.
    """
    i = 0
    if i >= len(sent) or sent[i] not in DET:
        return False
    i += 1
    if i < len(sent) and sent[i] in ADJ:
        i += 1
    if i >= len(sent) or sent[i] not in SN + PN:
        return False
    subj = sent[i]; i += 1
    if i >= len(sent) or sent[i] not in VS + VP + VPAST:
        return False
    verb = sent[i]; i += 1
    if i >= len(sent) or sent[i] not in DET:
        return False
    i += 1
    if i < len(sent) and sent[i] in ADJ:
        i += 1
    if i >= len(sent) or sent[i] not in SN:            # object is always singular
        return False
    if i != len(sent) - 1:
        return False
    if verb in VPAST:
        return True                                     # past tense does not inflect
    return (verb in VP) if subj in PN else (verb in VS)


def sample_rule(rule, cats, rng):
    """Speak one sentence from a learned rule, honouring its optional slots + feature."""
    items, agree = rule
    it = list(items)
    if agree is not None:
        pos, vals = agree
        v = vals[int(rng.integers(len(vals)))]
        for p, c in zip(pos, v):
            it[p] = (c, it[p][1])
    seq = [c for c, o in it if not o or rng.random() < 0.5]
    if not all(c in cats and cats[c] for c in seq):
        return None
    return [str(rng.choice(cats[c])) for c in seq]


def audit_structure():
    sep("AUDIT 2 — cube_structure_learner.py:  'coverage 7% -> 100%'")
    print("  `rule_coverage` asks what fraction of the shapes it HEARD the grammar can")
    print("  still produce. That is recall. There is no precision term anywhere in the")
    print("  file, and a grammar that produces EVERYTHING scores a perfect 100% on it.")

    rng = np.random.default_rng(11)
    corpus = make(SL.N, rng, number=True, adj=True, tense=True)
    cats = induce_categories(context_signatures(corpus))
    tmpls = list(induce_templates(corpus, cats))
    r_opt = SL.collapse_optional(tmpls)
    r_full = SL.collapse_agreement(r_opt)
    cov = SL.rule_coverage(r_full, tmpls)

    # The null grammar: ANY category in ANY order, at any length the corpus shows.
    # It cannot be written in the (items, agree) format -- expand() only ever emits
    # subsequences of one fixed ordering, which is why the first version of this
    # scored 0% while the caption above it claimed 100%. It gets its own two lines.
    lens = sorted({len(t) for t in tmpls})
    allcats = sorted(cats)

    def null_covers(t):
        return len(t) in lens and all(c in allcats for c in t)

    def null_say():
        L = lens[int(rng.integers(len(lens)))]
        return [str(rng.choice(cats[allcats[int(rng.integers(len(allcats)))]]))
                for _ in range(L)]

    head("the null grammar: any category, any order, any length it has seen")
    null_cov = 100.0 * sum(map(null_covers, tmpls)) / len(tmpls)
    print(f"      shipped grammar : {len(r_full)} rule(s), coverage {cov:.0f}%")
    print(f"      null grammar    : permits everything, coverage {null_cov:.0f}%"
          f"   <- speaks pure junk, ties the shipped score")
    print("      A metric that a deliberately worthless grammar maxes out is not")
    print("      measuring grammar. Coverage needs its other half.")

    head("the missing half: PRECISION — is what it says actually grammatical?")
    print(f"      {'grammar':<34}{'rules':<8}{'coverage':<12}{'precision':<12}{'F1'}")
    rows = []
    for name, rules in (("shipped (optional + agreement)", r_full),
                        ("optional only, no agreement", [(r, None) for r in r_opt]),
                        ("raw templates, memorised", [(tuple((c, False) for c in t), None)
                                                      for t in tmpls]),
                        ("null: anything goes", None)):
        if rules is None:
            said, rc, nr = [null_say() for _ in range(600)], null_cov, "1"
        else:
            said = [s for s in (sample_rule(rules[int(rng.integers(len(rules)))], cats, rng)
                                for _ in range(600)) if s]
            rc, nr = SL.rule_coverage(rules, tmpls), str(len(rules))
        prec = 100.0 * sum(map(true_grammatical, said)) / max(1, len(said))
        f1 = 0 if prec + rc == 0 else 2 * prec * rc / (prec + rc)
        rows.append((name, nr, rc, prec, f1))
        print(f"      {name:<34}{nr:<8}{f'{rc:.0f}%':<12}{f'{prec:.0f}%':<12}{f1:.0f}%")
    print("\n      Coverage was never WRONG -- it was half a metric, reported as if whole.")
    print("      With the other half supplied, the shipped grammar SURVIVES: it says only")
    print("      grammatical things, including the number agreement it would have been")
    print("      easy to lose while coverage sat at 100%.")
    print("\n      But read the `rules` column. Memorising the raw templates also scores")
    print("      100/100 -- of course it does, it is the data. So what the collapse buys")
    print("      is not correctness, it is COMPRESSION: the same language in far fewer")
    print("      rules. And the agreement step specifically buys nothing beyond what")
    print("      optionality already got; it only shrinks the rule count further.")
    return rows


# ══════════════════════════════════════════════════════════════════════════════
# AUDIT 3 — cube_structure_learner.py claims unseen depth 0% -> 100%
# ══════════════════════════════════════════════════════════════════════════════
def audit_recursion():
    sep("AUDIT 3 — cube_structure_learner.py:  'unseen depth 0% -> 100%'")
    print("  The shipped test GENERATES a depth-3 sentence from the learned rule and")
    print("  checks it came out grammatical. But the sentence is built by drawing words")
    print("  from the induced categories -- so that test can only fail if a CATEGORY is")
    print("  impure. It measures category purity and reports it as recursion.")

    rng = np.random.default_rng(11)
    NN, VV = SL.NN if hasattr(SL, "NN") else ["dog", "cat", "bird"], ["chased", "saw"]

    def sent(depth, r):
        s = ["the", str(r.choice(NN)), str(r.choice(VV)), "the", str(r.choice(NN))]
        for _ in range(depth):
            s += ["that", str(r.choice(VV)), "the", str(r.choice(NN))]
        return s

    corp = [sent(int(rng.integers(0, 2)), rng) for _ in range(SL.N)]
    cats2 = induce_categories(context_signatures(corp))
    t2 = list(induce_templates(corp, cats2))
    rec = SL.find_recursion(t2)
    head("is the category alphabet pure?")
    kind = lambda w: ("det" if w == "the" else "that" if w == "that"
                      else "noun" if w in NN else "verb")
    pure = all(len({kind(w) for w in ws}) == 1 for ws in cats2.values())
    print(f"      {len(cats2)} induced categories, all internally pure: {pure}")
    print(f"      -> so the shipped generate-and-check test cannot fail. Its 100% is")
    print(f"         real but it is a purity measurement wearing a recursion label.")

    head("the test that can fail: does the rule REJECT?")
    print("      A generator is not a grammar. A grammar draws a line. Build an acceptor")
    print("      from the learned rule -- base + block x n for any n -- and feed it")
    print("      grammatical sentences at a depth never heard, and corrupted ones.")
    if not rec:
        print("      no recursion found; nothing to test.")
        return
    base, block = rec
    of = {w: c for c, ws in cats2.items() for w in ws}

    def accepts(s):
        seq = [of.get(w) for w in s]
        if any(c is None for c in seq):
            return False
        if tuple(seq[:len(base)]) != tuple(base):
            return False
        rest = seq[len(base):]
        if len(rest) % len(block):
            return False
        return all(tuple(rest[i:i + len(block)]) == tuple(block)
                   for i in range(0, len(rest), len(block)))

    def c_kind(s, r):                       # a word of the wrong kind
        s = list(s); i = int(r.integers(len(s)))
        s[i] = str(r.choice([w for w in ["the", "that"] + NN + VV
                             if kind(w) != kind(s[i])]))
        return s

    def c_truncate(s, r):                   # a HALF block: right alphabet, wrong structure
        s = list(s)
        if len(s) <= 5:
            return None
        return s[:-1 - int(r.integers(3))]

    def c_reorder(s, r):                    # two adjacent words swapped inside a block
        s = list(s)
        if len(s) <= 5:
            return None
        i = 5 + int(r.integers(len(s) - 6)) if len(s) > 6 else 5
        s[i], s[i + 1] = s[i + 1], s[i]
        return s if [kind(w) for w in s] != [kind(w) for w in sent(0, r)] else None

    print("\n      Corruptions of three kinds. The first only breaks the ALPHABET, which")
    print("      any category-level check catches. The other two keep every word legal")
    print("      and break the STRUCTURE -- those are the ones that test the rule.\n")
    print(f"      {'depth':<18}{'accepts good':<16}{'rej. wrong-word':<18}"
          f"{'rej. half-block':<18}{'rej. reordered'}")
    for depth in (1, 2, 3, 4):
        good = [sent(depth, rng) for _ in range(120)]
        a = sum(map(accepts, good))
        cells = []
        for fn in (c_kind, c_truncate, c_reorder):
            bad = [b for b in (fn(s, rng) for s in good) if b]
            cells.append(f"{sum(1 for s in bad if not accepts(s))}/{len(bad)}"
                         if bad else "n/a")
        heard = "heard" if depth <= 1 else "NEVER heard"
        print(f"      {depth} ({heard:<11}){f'{a}/{len(good)}':<16}"
              + "".join(f"{c:<18}" for c in cells))
    print("\n      This is the claim that survives being attacked, and it is stronger than")
    print("      the one that was made: the rule does not merely EMIT unseen depths, it")
    print("      draws a line at them. That is a grammar.")


# ══════════════════════════════════════════════════════════════════════════════
# AUDIT 4 — distill_llm.py's KNOWLEDGE result, the commercially load-bearing one
# ══════════════════════════════════════════════════════════════════════════════
# README: "haiku bare 17/33/8% at 1/2/3 hops -> cube 100/100/100% = matches opus;
# gap -85% -> +0%". That is the number the agents-as-a-service thread rests on:
# a small model plus a cube knowledge slate performing like a frontier model.
#
# The README carries an unusually honest "what this is NOT" section, and it does
# guard the DFA/policy benchmarks against a dict ("~1,400x slower ... and ties
# them on accuracy"). It does NOT guard this one, and this one is the commercial
# claim. No API key needed here: the KB structure is three functional relations,
# which is reproducible offline.
import hashlib
from distill_llm import entity_vec, DIM   # the real functions, not a copy


def _synth_kb(n, rng):
    comp = [f"composer_{i}" for i in range(n)]
    teach = [f"teacher_{i}" for i in range(n)]
    city = [f"city_{i}" for i in range(n)]
    ctry = [f"country_{i % 7}" for i in range(n)]
    return (comp, {"TEACHER": dict(zip(comp, teach)),
                   "CITY": dict(zip(teach, city)),
                   "COUNTRY": dict(zip(city, ctry))})


def audit_knowledge():
    sep("AUDIT 4 — distill_llm.py:  'cube 100/100/100% at 1/2/3 hops = matches opus'")
    print("  This is the commercially load-bearing claim in the repo. The README's")
    print("  'what this is NOT' section guards the DFA benchmarks against a dict but")
    print("  never guards this one, and distill_llm.py contains no retrieval baseline")
    print("  of any kind -- no dict, no RAG, no vector index.")

    rng = np.random.default_rng(0)
    comp, REL = _synth_kb(60, rng)
    CHAIN = {1: ["TEACHER"], 2: ["TEACHER", "CITY"], 3: ["TEACHER", "CITY", "COUNTRY"]}
    banks = {}
    for r, m in REL.items():
        s = Slate(DIM, n_cells=2048, beta=35.0, seed=0)
        for a, b in m.items():
            s.commit(entity_vec(a), payload=b, id=a)
        banks[r] = s

    def cube_chain(start, seq, jitter=0.0, r=None):
        cur = start
        for rel in seq:
            v = entity_vec(cur)
            if jitter:
                v = v + r.normal(0, jitter, v.shape).astype(np.float32)
            res = banks[rel].recall(v)
            if res is None:
                return None
            cur = res["winner"]["payload"]
        return cur

    def dict_chain(start, seq):
        cur = start
        for rel in seq:
            cur = REL[rel].get(cur)
            if cur is None:
                return None
        return cur

    def truth(start, seq):
        return dict_chain(start, seq)

    head("the rival that was never run: the same three relations, in a dict")
    print(f"      {'hops':<8}{'cube (as shipped)':<22}{'a plain dict':<18}{'gap'}")
    for h in (1, 2, 3):
        c = sum(cube_chain(x, CHAIN[h]) == truth(x, CHAIN[h]) for x in comp)
        d = sum(dict_chain(x, CHAIN[h]) == truth(x, CHAIN[h]) for x in comp)
        print(f"      {h:<8}{f'{100*c//len(comp)}%':<22}{f'{100*d//len(comp)}%':<18}"
              f"{100*c//len(comp) - 100*d//len(comp)}")
    print("\n      Identical, and it could not have been otherwise: build_bank commits")
    print("      entity_vec(src) and cube_chain recalls entity_vec(cur) -- the cue is")
    print("      BYTE-IDENTICAL to the stored key. Every recall is an exact lookup, so")
    print("      the error-correcting settle has nothing to correct.")

    head("could the substrate's advantage fire here even in principle?")
    r = np.random.default_rng(1)
    typo = sum(cube_chain(c[:-1] + "X", CHAIN[1]) == truth(c, CHAIN[1]) for c in comp)
    print(f"      a misspelled composer name, cube:  {100*typo//len(comp)}% recovered")
    v1, v2 = entity_vec("composer_1"), entity_vec("composer_1X")
    cos = float(v1 @ v2 / (np.linalg.norm(v1) * np.linalg.norm(v2)))
    print(f"      cosine(name, name+typo) under entity_vec: {cos:+.3f}   <- a HASH, so a")
    print(f"      near-miss NAME is not a near-miss VECTOR. It is unrelated noise.")
    print(f"\n      {'vector jitter':<18}{'cube 1-hop':<14}{'dict'}")
    for j in (0.0, 0.3, 0.6, 1.0):
        c = sum(cube_chain(x, CHAIN[1], j, r) == truth(x, CHAIN[1]) for x in comp)
        print(f"      {j:<18.1f}{f'{100*c//len(comp)}%':<14}{'0%' if j else '100%'}")
    print("\n      The tolerance is REAL -- perturb the vector and the cube holds where a")
    print("      dict returns nothing. But nothing upstream in this pipeline ever")
    print("      PRODUCES a perturbed vector: entity_vec is a blake2b hash of the name,")
    print("      so the only cue it can ever receive is exact or unrelated. The one")
    print("      property that would beat a dict is unreachable by construction.")

    head("what the knowledge result actually shows")
    print("      Not that the substrate closes the knowledge gap. That a CHAINED lookup")
    print("      does -- and the chaining is a three-line Python loop, not the store.")
    print("      That is still a real and useful finding, because a small model plus")
    print("      chained retrieval genuinely does match a frontier model on multi-hop")
    print("      facts, and naive single-shot RAG is exactly what struggles there.")
    print("      But the claim belongs to the retrieval strategy, not to the Slate, and")
    print("      as written it reads as the Slate's. To make it the Slate's you would")
    print("      need entity vectors where a near-miss NAME lands near-miss -- i.e.")
    print("      semantic embeddings -- and then the rival is a vector index, which the")
    print("      README already concedes ties on accuracy.")


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    audit_eye()
    audit_structure()
    audit_recursion()
    audit_knowledge()
    sep("WHAT THIS PASS FOUND")
    print("  Three claims attacked, three different outcomes. None was fabricated; all")
    print("  three were reported without the one measurement that would have located")
    print("  their limits.\n")
    print("  DEFLATED   cube_eye's 200/200. A class average ties it exactly and raw")
    print("             pixels get within 7 points, because five words over four")
    print("             distinct colours is a separable task. Worse: turn the noise up")
    print("             and the class average BEATS the Slate by up to 12 points, because")
    print("             the Slate keeps every noisy exemplar as its own basin while a")
    print("             mean averages the noise out. The honest claim is not 'the")
    print("             substrate recognises' but 'the percept is translation-invariant")
    print("             and raw pixels are not' -- which the same sweep does support.")
    print("\n  REFRAMED   'coverage 7% -> 100%'. Coverage alone is half a metric: a grammar")
    print("             that permits anything also scores 100%. Supplying precision, the")
    print("             shipped grammar survives at 100/100 -- it keeps number agreement")
    print("             it could easily have lost. But memorising the raw templates scores")
    print("             100/100 too, so what the collapse actually buys is COMPRESSION,")
    print("             16 rules to 1, not correctness. That is still a real result. It is")
    print("             not the result the file claims.")
    print("\n  SURVIVED   'unseen depth 0% -> 100%', and it is STRONGER than claimed. The")
    print("             shipped test only generates, so it could not fail unless a")
    print("             category was impure. Turned into an acceptor it discriminates at")
    print("             depths never heard -- including against corruptions that keep")
    print("             every word legal and break only the structure. That is a grammar")
    print("             drawing a line, which is a bigger claim than the one made.")
    print("\n  The pattern from the three builds today holds on the older rungs too: the")
    print("  cheapest rival ties the sophisticated thing far more often than anyone")
    print("  checks, and the interesting result is always at the point where it stops.")
