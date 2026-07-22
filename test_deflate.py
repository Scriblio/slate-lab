"""Tests for deflate.py — pins the audit's findings so they cannot quietly rot.

These are deliberately written to FAIL if someone later restores the flattering
version of any of these claims. Run: pytest -q test_deflate.py
"""
import numpy as np
import deflate as D
import cube_structure_learner as SL
from cube_language_induction import context_signatures, induce_categories, induce_templates
from cube_induction_limits import make


# ── cube_eye: the 200/200 is a fact about the task ───────────────────────────
def test_a_class_average_ties_the_slate_on_the_shipped_task():
    rng = np.random.default_rng(20260720)
    Xtr, ytr, _ = D.eye_dataset(rng, 5)
    Xte, yte, _ = D.eye_dataset(rng, 40)
    import cube_eye as E
    from core import Slate
    s = Slate(5, n_cells=1024, beta=40.0, seed=0)
    for x, w in zip(Xtr, ytr):
        s.commit(x, payload=w)
    cen = D._centroid_clf(Xtr, ytr, slice(0, 5))
    slate = sum(s.recall(Xte[i], max_cycles=3)["winner"]["payload"] == yte[i]
                for i in range(len(yte)))
    cent = sum(cen(Xte[i]) == yte[i] for i in range(len(yte)))
    assert cent >= slate, "if a class mean stops tying it, the task got harder -- recheck"
    assert cent == len(yte)


def test_the_class_average_beats_the_slate_once_it_gets_noisy():
    """The uncomfortable finding. The attractor is not merely tied here, it loses."""
    from core import Slate
    rng = np.random.default_rng(7)
    Xtr, ytr, _ = D.eye_dataset(rng, 5, scale=3)
    Xte, yte, _ = D.eye_dataset(rng, 40, scale=3)
    s = Slate(5, n_cells=1024, beta=40.0, seed=0)
    for x, w in zip(Xtr, ytr):
        s.commit(x, payload=w)
    cen = D._centroid_clf(Xtr, ytr, slice(0, 5))
    slate = sum(s.recall(Xte[i], max_cycles=3)["winner"]["payload"] == yte[i]
                for i in range(len(yte)))
    cent = sum(cen(Xte[i]) == yte[i] for i in range(len(yte)))
    assert cent > slate


def test_the_percept_is_what_survives_noise_not_the_substrate():
    """Raw pixels collapse under position jitter; the percept does not. This is the
    part of cube_eye's story that the audit CONFIRMED rather than deflated."""
    rng = np.random.default_rng(7)
    Xtr, ytr, Itr = D.eye_dataset(rng, 5, scale=6)
    Xte, yte, Ite = D.eye_dataset(rng, 40, scale=6)
    cen = D._centroid_clf(Xtr, ytr, slice(0, 5))
    percept = sum(cen(Xte[i]) == yte[i] for i in range(len(yte)))
    pixels = sum(ytr[int(np.argmin(((Itr - Ite[i]) ** 2).sum(1)))] == yte[i]
                 for i in range(len(yte)))
    assert percept > pixels * 1.5


# ── the coverage metric ──────────────────────────────────────────────────────
def test_coverage_alone_is_maxed_out_by_a_worthless_grammar():
    """The reason `rule_coverage` cannot be reported on its own."""
    rng = np.random.default_rng(11)
    corpus = make(SL.N, rng, number=True, adj=True, tense=True)
    cats = induce_categories(context_signatures(corpus))
    tmpls = list(induce_templates(corpus, cats))
    lens, allcats = sorted({len(t) for t in tmpls}), sorted(cats)
    assert all(len(t) in lens and all(c in allcats for c in t) for t in tmpls)
    junk = [[str(rng.choice(cats[allcats[int(rng.integers(len(allcats)))]]))
             for _ in range(lens[int(rng.integers(len(lens)))])] for _ in range(300)]
    assert sum(map(D.true_grammatical, junk)) / len(junk) < 0.05


def test_the_shipped_grammar_survives_the_precision_test():
    """It keeps number agreement -- the thing it could have lost invisibly."""
    rng = np.random.default_rng(11)
    corpus = make(SL.N, rng, number=True, adj=True, tense=True)
    cats = induce_categories(context_signatures(corpus))
    tmpls = list(induce_templates(corpus, cats))
    rules = SL.collapse_agreement(SL.collapse_optional(tmpls))
    said = [s for s in (D.sample_rule(rules[int(rng.integers(len(rules)))], cats, rng)
                        for _ in range(400)) if s]
    assert sum(map(D.true_grammatical, said)) / len(said) > 0.98
    assert SL.rule_coverage(rules, tmpls) > 99


def test_what_the_collapse_buys_is_compression_not_correctness():
    rng = np.random.default_rng(11)
    corpus = make(SL.N, rng, number=True, adj=True, tense=True)
    cats = induce_categories(context_signatures(corpus))
    tmpls = list(induce_templates(corpus, cats))
    rules = SL.collapse_agreement(SL.collapse_optional(tmpls))
    memorised = [(tuple((c, False) for c in t), None) for t in tmpls]
    said = [s for s in (D.sample_rule(memorised[int(rng.integers(len(memorised)))], cats, rng)
                        for _ in range(300)) if s]
    assert sum(map(D.true_grammatical, said)) / len(said) > 0.98   # memorising is correct too
    assert len(rules) < len(memorised) / 4                          # the gain is size


# ── the recursion claim, which got stronger ──────────────────────────────────
def test_the_recursion_rule_rejects_as_well_as_generates():
    """A generator is not a grammar. This is the test the shipped file did not run."""
    rng = np.random.default_rng(11)
    NN, VV = ["dog", "cat", "bird"], ["chased", "saw"]

    def sent(depth, r):
        s = ["the", str(r.choice(NN)), str(r.choice(VV)), "the", str(r.choice(NN))]
        for _ in range(depth):
            s += ["that", str(r.choice(VV)), "the", str(r.choice(NN))]
        return s

    corp = [sent(int(rng.integers(0, 2)), rng) for _ in range(SL.N)]
    cats = induce_categories(context_signatures(corp))
    rec = SL.find_recursion(list(induce_templates(corp, cats)))
    assert rec is not None
    base, block = rec
    of = {w: c for c, ws in cats.items() for w in ws}

    def accepts(s):
        seq = [of.get(w) for w in s]
        if any(c is None for c in seq) or tuple(seq[:len(base)]) != tuple(base):
            return False
        rest = seq[len(base):]
        return not (len(rest) % len(block)) and all(
            tuple(rest[i:i + len(block)]) == tuple(block)
            for i in range(0, len(rest), len(block)))

    for depth in (2, 3, 4):                       # depths NEVER heard
        good = [sent(depth, rng) for _ in range(60)]
        assert all(map(accepts, good))
        half = [s[:-2] for s in good]             # legal words, broken structure
        assert not any(map(accepts, half))


def test_the_knowledge_claim_is_tied_by_a_plain_dict():
    """distill_llm's 100/100/100 at 1/2/3 hops is chained lookup, not the substrate.

    The commercially load-bearing claim. Cues are byte-identical to stored keys,
    so the settle has nothing to correct and a dict scores the same. Written to
    fail if anyone ever restores this as a Slate-vs-nothing comparison.
    """
    from core import Slate
    from distill_llm import entity_vec, DIM
    comp, REL = D._synth_kb(40, np.random.default_rng(0))
    banks = {}
    for r, m in REL.items():
        s = Slate(DIM, n_cells=2048, beta=35.0, seed=0)
        for a, b in m.items():
            s.commit(entity_vec(a), payload=b, id=a)
        banks[r] = s
    seq = ["TEACHER", "CITY", "COUNTRY"]

    def cube(start):
        cur = start
        for rel in seq:
            cur = banks[rel].recall(entity_vec(cur))["winner"]["payload"]
        return cur

    def dct(start):
        cur = start
        for rel in seq:
            cur = REL[rel][cur]
        return cur

    assert all(cube(c) == dct(c) for c in comp)
    assert sum(cube(c) == dct(c) for c in comp) == len(comp)


def test_a_hash_makes_the_substrates_one_advantage_unreachable():
    """Near-miss NAME must be a near-miss VECTOR for error-correction to ever fire."""
    from distill_llm import entity_vec
    a, b = entity_vec("composer_1"), entity_vec("composer_1X")
    cos = float(a @ b / (np.linalg.norm(a) * np.linalg.norm(b)))
    assert abs(cos) < 0.15, "if this becomes semantic, the dict comparison changes"


def test_mutual_exclusivity_earns_its_place_in_cube_fuse():
    """cube_fuse SURVIVES its audit -- the one rung with a real prior it would.

    Ablating the child bias costs a grounded word and a produced sentence, which
    is exactly the argument the file makes, now with the ablation behind it.
    """
    import cube_fuse as F
    scenes = F.all_legal_scenes()
    got = {}
    for meaning in ("shipped", "intersect-only", "mode"):
        rng = np.random.default_rng(4)
        idx = rng.permutation(len(scenes))
        held, train = [scenes[i] for i in idx[:8]], [scenes[i] for i in idx[8:]]
        exposure = [(F.render(sc, "S-V-O"), sc) for sc in
                    [train[int(rng.integers(len(train)))] for _ in range(900)]]
        L = D.FuseVariant(meaning).learn(exposure)
        right = sum(1 for w, r in L.refers.items() if F.WORD.get(r) == w)
        prod = 0
        for sc in held:
            try:
                prod += (L.describe(sc, rng) == F.render(sc, "S-V-O"))
            except (KeyError, IndexError):
                pass
        got[meaning] = (right, prod)
    assert got["shipped"] == (9, 8)
    assert got["intersect-only"][0] < 9      # the bias is load-bearing
    assert got["mode"][1] < got["shipped"][1]


def test_cube_fuse_holds_on_both_word_orders():
    """The guard cube_fuse already had: a learner that ASSUMED an order fails here."""
    import cube_fuse as F
    scenes = F.all_legal_scenes()
    for order in ("S-V-O", "S-O-V"):
        rng = np.random.default_rng(4)
        idx = rng.permutation(len(scenes))
        held, train = [scenes[i] for i in idx[:8]], [scenes[i] for i in idx[8:]]
        exposure = [(F.render(sc, order), sc) for sc in
                    [train[int(rng.integers(len(train)))] for _ in range(900)]]
        L = D.FuseVariant("shipped").learn(exposure)
        assert all(L.understand(F.render(sc, order)) == sc for sc in held)


if __name__ == "__main__":
    for _n, _f in list(globals().items()):
        if _n.startswith("test_") and callable(_f):
            _f(); print(f"ok  {_n}")
    print("all tests passed")
