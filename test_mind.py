"""Tests for cube_mind.py — inferring a mind from behaviour, and knowing when to ask.

Each pins a claim the write-up makes, including the ones that were wrong first.
Run: pytest -q test_mind.py   (no API key, no network)
"""
import numpy as np
import cube_cause as C
import cube_say as S
import cube_mind as M


def _model(seed=0):
    C.use_world("one causal attribute per action")
    train, buckets = C.split()
    eps = [(a, act, p, C.world_apply(a, act, p)) for a, act, p in train]
    m = C.TransitionModel(seed=seed).learn(eps)
    m.calibrate(buckets["calib"], buckets["ood_calib"], apply=True)
    return m


def _orders(n=4):
    return [list(np.random.default_rng(s).permutation(len(M.POOL))) for s in range(n)]


# ── the premise: this is only worth building if behaviour is ambiguous ───────
def test_behaviour_underdetermines_belief():
    """The whole build rests on one reach having several explanations."""
    H = M.hypotheses()
    reaching_badly = [h for h in H if M.choice(h, M.TARGET) == "HERB"]
    assert len(reaching_badly) >= 3, "no ambiguity means the inference is a lookup"
    assert not M.truly_good("HERB")


def test_the_ambiguous_minds_need_different_sentences():
    """If one sentence fixed all of them, there would be nothing to infer."""
    m = _model()
    sp = M.OracleMind(m)
    amb = [h for h in M.hypotheses() if M.choice(h, M.TARGET) == "HERB"]
    said = {str(sp.best_tell([h], M.TARGET)[0]) for h in amb}
    assert len(said) == len(amb), "each broken mind must need its own sentence"
    for h in amb:                       # and each of those sentences must actually work
        u, _ = sp.best_tell([h], M.TARGET)
        assert M.truly_good(M.choice(h, M.TARGET, heard=u))


# ── inference ────────────────────────────────────────────────────────────────
def test_inference_never_rules_out_the_truth():
    """Soundness. Allowed to stay uncertain; never allowed to eliminate the real mind."""
    m, H = _model(), M.hypotheses()
    for k in range(5):
        for h in H:
            for o in _orders():
                assert h in M.trial(M.MindReader(m), h, k, o, H)["survivors"]


def test_watching_longer_narrows_it_down():
    m, H = _model(), M.hypotheses()
    sizes = []
    for k in (0, 4):
        sizes.append(np.mean([len(M.trial(M.MindReader(m), h, k, o, H)["survivors"])
                              for h in H for o in _orders()]))
    assert sizes[1] < sizes[0], "observations must buy something"


def test_the_current_reach_is_used_as_evidence():
    """Leaving it out was a bug: it made the speaker unable to spot a sound listener."""
    m, H = _model(), M.hypotheses()
    sound = [h for h in H if M.truly_good(M.choice(h, M.TARGET))]
    for h in sound:
        r = M.trial(M.MindReader(m), h, 0, _orders()[0], H)
        assert not r["spoke"] and not r["asked"], "a sound listener must be left alone"


# ── speaking, and asking ─────────────────────────────────────────────────────
def test_matches_the_speaker_that_was_handed_the_mind():
    m, H = _model(), M.hypotheses()
    for k in (0, 2, 4):
        mine = sum(M.trial(M.MindReader(m), h, k, o, H)["ok_after"]
                   for h in H for o in _orders())
        orc = sum(M.trial(M.OracleMind(m), h, k, o, H)["ok_after"]
                  for h in H for o in _orders())
        assert mine == orc


def test_asks_whenever_it_actually_needed_to():
    """The column that matters: a required question is never skipped."""
    m, H = _model(), M.hypotheses()
    for k in (0, 2, 4):
        for h in H:
            for o in _orders():
                if not M.trial(M.NeverAsk(m), h, k, o, H)["ok_after"]:
                    assert M.trial(M.MindReader(m), h, k, o, H)["asked"]


def test_asks_far_less_than_a_speaker_that_always_asks():
    m, H = _model(), M.hypotheses()
    mine = sum(M.trial(M.MindReader(m), h, 2, o, H)["asked"] for h in H for o in _orders())
    always = sum(M.trial(M.AlwaysAsk(m), h, 2, o, H)["asked"] for h in H for o in _orders())
    assert mine < always / 2


def test_refusing_to_ask_costs_real_listeners():
    """If never-asking were free, the question machinery would be decoration."""
    m, H = _model(), M.hypotheses()
    never = sum(M.trial(M.NeverAsk(m), h, 0, o, H)["ok_after"] for h in H for o in _orders())
    assert never < len(H) * len(_orders())


# ── the guard against the way this flattered itself ──────────────────────────
def test_tie_break_dependence_is_declared_not_hidden():
    """Under the opposite ordering the task collapses; the write-up must not claim otherwise.

    All three failing minds are TIED in the target scene, so a listener that
    resolves ties the other way stumbles onto the right answer unaided -- and even
    the speaker that infers nothing scores full marks. Pinned here so nobody later
    quotes the success separation as if it were ordering-independent.
    """
    m, H = _model(), M.hypotheses()
    n = len(H) * len(_orders())
    lucky = sum(M.trial(M.PriorCommit(m), h, 2, o, H, "last")["ok_after"]
                for h in H for o in _orders())
    unlucky = sum(M.trial(M.PriorCommit(m), h, 2, o, H, "first")["ok_after"]
                  for h in H for o in _orders())
    assert lucky == n and unlucky < n
    # ...while the inference itself is sound under BOTH orderings
    for tb in ("first", "last"):
        for h in H:
            assert h in M.trial(M.MindReader(m), h, 2, _orders()[0], H, tb)["survivors"]


if __name__ == "__main__":
    for _n, _f in list(globals().items()):
        if _n.startswith("test_") and callable(_f):
            _f(); print(f"ok  {_n}")
    print("all tests passed")
