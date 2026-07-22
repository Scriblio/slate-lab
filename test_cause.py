"""Tests for cube_cause.py — these pin the MEASUREMENT, not just the code.

Every one of these corresponds to something that actually went wrong while
building this benchmark, and each time the broken measurement looked like a
result. In order: a test entity that never appeared in training at all (scored
as a 0/7 failure when it was structurally unanswerable), a distractor attribute
perfectly confounded with the true cause (scored as a model failure when it was
a defect in the sample), a test entity with an exact profile twin in training
(scored as generalisation when it was memorisation), and a doubt threshold that
would have been free to see its own exam.

Run: pytest test_cause.py -q      (no API key, no network, a few seconds)
"""
import pytest
import cube_cause as C

WORLDS = list(C.WORLDS)


_BUILT = {}


def built(world):
    """Trained model for `world`, and the module switched over to that world.

    use_world() mutates module globals, so which world is "current" is process
    state. A module-scoped fixture that pre-built both worlds left the global set
    to whichever was built last, and the tests then scored world 1's model against
    world 2's rules -- reporting 74/96 for a model that gets 96/96. The world
    switch has to happen per test, on every call, cache hit or not.
    """
    C.use_world(world)                                  # ALWAYS, not just on miss
    if world not in _BUILT:
        train, buckets = C.split()
        eps = [(a, ac, p, C.world_apply(a, ac, p)) for a, ac, p in train]
        M = C.TransitionModel(seed=0).learn(eps)
        for k in ("margin_rel", "familiarity"):
            M.calibrate(buckets["calib"], buckets["ood_calib"], key=k, apply=True)
        _BUILT[world] = (train, buckets, eps, M)
    return _BUILT[world]


@pytest.mark.parametrize("world", WORLDS)
def test_split_is_clean(world):
    """No leakage, no unanswerable in-model cells, no memorisable ones."""
    C.use_world(world)
    train, buckets = C.split()
    assert C.verify_splits(train, buckets) == []


@pytest.mark.parametrize("world", WORLDS)
def test_no_test_triple_or_cell_appears_in_training(world):
    C.use_world(world)
    train, buckets = C.split()
    tr, cells = set(train), {(t[1], t[2]) for t in train}
    for name in ("test", "ood_test"):
        for t in buckets[name]:
            assert t not in tr
            assert (t[1], t[2]) not in cells        # the whole cell is withheld


@pytest.mark.parametrize("world", WORLDS)
def test_every_in_model_test_entity_is_known_but_never_memorisable(world):
    """The distinction the first version got wrong in both directions.

    An in-model question must be ANSWERABLE (the entity was seen under some other
    action, so it is not structurally out of distribution) and must still require
    GENERALISATION (no exact profile twin under this action).
    """
    C.use_world(world)
    train, buckets = C.split()
    known = {e for t in train for e in (t[0], t[2])}
    for a, act, p in buckets["test"]:
        assert a in known and p in known
        assert C.novel_profile(act, p, train)


@pytest.mark.parametrize("world", WORLDS)
def test_unknowable_branches_are_genuinely_undemonstrated(world):
    """Not merely an unseen entity -- an unseen value of what the action reads."""
    C.use_world(world)
    train, _ = C.split()
    for cells in (C.OOD_TEST_CELLS, C.OOD_CALIB_CELLS):
        act = cells[0][0]
        seen = {C.reads_of(act, p) for a, ac, p in train if ac == act}
        assert not (seen & {C.reads_of(act, p) for _, p in cells})


@pytest.mark.parametrize("world", WORLDS)
def test_the_cause_is_identifiable_and_the_model_finds_it(world):
    """No non-cause may explain an action's outcomes as well as the real one."""
    _, _, _, M = built(world)
    assert C.identifiability(M) == []
    for act in C.ACTIONS:
        if not C.ACTIONS[act]["reads"]:
            continue
        best = max(M.rel_raw[act], key=M.rel_raw[act].get)
        assert best[0] == "patient" and best[1] in C.ACTIONS[act]["reads"]


@pytest.mark.parametrize("world", WORLDS)
def test_the_gate_never_sees_its_own_exam(world):
    """Floors must come from the calibration buckets alone."""
    _, buckets, _, M = built(world)
    exam = set(buckets["test"]) | set(buckets["ood_test"])
    for t in buckets["calib"] + buckets["ood_calib"]:
        assert t not in exam
    floors = dict(M.gate_floors)
    M.calibrate(buckets["calib"], buckets["ood_calib"], key="margin_rel", apply=True)
    assert M.gate_floors["margin_rel"] == pytest.approx(floors["margin_rel"])


@pytest.mark.parametrize("world", WORLDS)
def test_predict_explain_counterfactual_on_held_out(world):
    _, buckets, _, M = built(world)
    ok, ans, n, _ = C.score_predict(M, buckets["test"])
    assert ok == n, f"{world}: predicted {ok}/{n}"
    # EXPLAIN: exact preimage by set equality, on outcomes it never trained on
    seen, checked = set(), 0
    for a, act, p in buckets["test"]:
        obs = C.world_apply(a, act, p)
        key = tuple(sorted(obs.items()))
        if not obs or key in seen:
            continue
        seen.add(key)
        checked += 1
        truth = {t for t in C.all_legal() if C.world_apply(*t) == obs}
        assert M.explain(obs) == truth
    assert checked >= 6
    # COUNTERFACTUAL: an entity that cannot be eaten yields nothing, on the
    # grounds that the action does not apply -- not by emitting a lucky blank
    r = M.counterfactual("DOG", "EAT", "APPLE", "BALL")
    assert r["answered"] and r["delta"] == {} and r["unlicensed"]


@pytest.mark.parametrize("world", WORLDS)
def test_it_declines_the_unknowable_and_does_not_buy_that_with_silence(world):
    _, buckets, _, M = built(world)
    declined = sum(not M.predict(*t)["answered"] for t in buckets["ood_test"])
    assert declined >= 0.9 * len(buckets["ood_test"])
    # ...while still answering everything it legitimately can
    assert all(M.predict(*t)["answered"] for t in buckets["test"])
    # and an entity it has never encountered is refused structurally, no threshold
    C.ENTITIES["GLARB"] = C.NOVEL_FEATURES
    try:
        assert not M.predict("DOG", "EAT", "GLARB")["answered"]
    finally:
        del C.ENTITIES["GLARB"]


def test_conjunctive_world_is_where_the_substrate_earns_its_place():
    """The decisive comparison, pinned so it cannot quietly stop being true.

    World 1's rules are one column wide, so a lookup table is a COMPLETE model of
    it and ties. World 2's EAT needs two attributes at once, which the dict cannot
    represent at all.
    """
    got = {}
    for w in WORLDS:
        _, buckets, eps, M = built(w)
        D = C.DictOnBestAttr(M.rel_raw).learn(eps)
        cells = [t for t in buckets["test"] if t[1] == "EAT"]
        got[w] = (sum(M.predict(*t)["delta"] == C.world_apply(*t) for t in cells),
                  sum(D.predict(*t)["delta"] == C.world_apply(*t) for t in cells),
                  len(cells))
    (m1, d1, n1), (m2, d2, n2) = got[WORLDS[0]], got[WORLDS[1]]
    assert m1 == n1 and d1 == n1        # one causal attribute: the dict ties
    assert m2 == n2 and d2 == 0         # a conjunction: only the substrate holds


def test_role_rebinding_is_what_makes_the_recall_useful():
    """Without re-binding the recalled episode's roles it names the wrong entity."""
    _, buckets, eps, M = built(WORLDS[0])
    vb = C.VerbatimCopy(seed=0).learn(eps)
    ok, _, n, _ = C.score_predict(M, buckets["test"])
    vok, _, _, _ = C.score_predict(vb, buckets["test"])
    assert vok < 0.6 * ok


def test_lab_cube_never_touches_the_live_substrate():
    """Standing rule: this lab must never reach the production mind on :5057."""
    src = open(C.__file__, encoding="utf-8").read()
    for forbidden in ("5057", "aurelia.db", "fractal-memory", "slate_engine",
                      "requests", "sqlite3", "socket", "urllib"):
        assert forbidden not in src.replace("Aurelia's mind runs on :5057", "")


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
