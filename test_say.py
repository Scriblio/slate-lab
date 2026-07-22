"""Tests for cube_say.py — the properties that make this pragmatics, not description.

Each of these pins a claim the write-up makes, including the ones that went wrong
first. Run: pytest -q test_say.py   (no API key, no network)
"""
import numpy as np
import cube_cause as C
import cube_say as S


def _speaker(seed=0):
    C.use_world("one causal attribute per action")
    train, buckets = C.split()
    eps = [(a, act, p, C.world_apply(a, act, p)) for a, act, p in train]
    m = C.TransitionModel(seed=seed).learn(eps)
    m.calibrate(buckets["calib"], buckets["ood_calib"], apply=True)
    return S.Speaker(m), m


def _sc(gap, goal="make a meal of it", bad="HERB"):
    return next(s for s in S.scenarios() if s.gap == gap and s.goal == goal
                and s.harmful == bad)


# ── the three properties ─────────────────────────────────────────────────────
def test_silence_is_an_answer():
    """A listener that needs nothing must be told nothing, however much is true."""
    sp, _ = _speaker()
    for sc in S.scenarios():
        if sc.gap == "none":
            assert S.run_scenario(sp, sc)["utt"] is None


def test_same_scene_different_listener_different_sentence():
    """Identical scene and goal; what is worth saying tracks the MIND, not the world."""
    sp, _ = _speaker()
    said = {g: S.run_scenario(sp, _sc(g))["utt"]
            for g in ("wrong-attr", "false-negative", "no-rule")}
    assert said["wrong-attr"][0] == "attr" and said["wrong-attr"][1] == "HERB"  # a warning
    assert said["false-negative"][0] == "attr" and said["false-negative"][1] == "MELON"
    assert said["no-rule"][0] == "rule"                                        # a rule
    assert len({str(v) for v in said.values()}) == 3


def test_same_scene_different_goal_different_sentence():
    """The herb is the thing to avoid when eating and the thing to take when shifting."""
    sp, _ = _speaker()
    a = S.run_scenario(sp, S.Scenario("make a meal of it", "DOG", ["HERB", "MELON"],
                                      "wrong-attr", "HERB", ""))
    b = S.run_scenario(sp, S.Scenario("shift it", "DOG", ["TREE", "HERB"],
                                      "wrong-attr", "TREE", ""))
    assert a["after"] == "MELON" and a["ok_after"]      # steered off the herb
    assert b["after"] == "HERB" and b["ok_after"]       # steered onto it
    assert a["utt"] != b["utt"]


# ── the comparisons that decide whether any of it means anything ─────────────
def test_beats_silence_and_listener_blind_on_the_tie_free_cases():
    sp, m = _speaker()
    tiefree = [s for s in S.scenarios() if s.gap in ("wrong-attr", "false-negative")]
    mine = sum(S.run_scenario(sp, s)["ok_after"] for s in tiefree)
    mute = sum(S.run_scenario(S.SilentSpeaker(m), s)["ok_after"] for s in tiefree)
    blind = sum(S.run_scenario(S.BlindSpeaker(m), s)["ok_after"] for s in tiefree)
    assert mine == len(tiefree)
    assert mute == 0                                   # luck rescues no false belief
    assert blind < mine


def test_warning_reflex_fails_the_mirror_case():
    """The heuristic that ties the speaker on false beliefs collapses on false alarms.

    This is the whole reason `false-negative` exists: without it, "always warn
    about the worst thing" is a complete policy and the listener model earns
    nothing -- the same trap as a one-causal-attribute world in cube_cause.py.
    """
    sp, m = _speaker()
    eager = S.EagerSpeaker(m)
    fn = [s for s in S.scenarios() if s.gap == "false-negative"]
    wa = [s for s in S.scenarios() if s.gap == "wrong-attr"]
    assert sum(S.run_scenario(eager, s)["ok_after"] for s in wa) == len(wa)
    assert sum(S.run_scenario(eager, s)["ok_after"] for s in fn) == 0
    assert sum(S.run_scenario(sp, s)["ok_after"] for s in fn) == len(fn)


def test_never_makes_a_sound_listener_worse():
    sp, _ = _speaker()
    for sc in S.scenarios():
        r = S.run_scenario(sp, sc)
        assert not (r["ok_before"] and not r["ok_after"])


# ── the guards against the ways this flattered itself first ──────────────────
def test_tie_free_cases_do_not_depend_on_the_tie_break():
    """If the listener's arbitrary fallback changes the answer, the result is mine, not its."""
    sp, _ = _speaker()
    for sc in S.scenarios():
        if sc.gap not in ("wrong-attr", "false-negative"):
            continue
        assert (S.run_scenario(sp, sc, "first")["ok_after"]
                == S.run_scenario(sp, sc, "last")["ok_after"] is True)


def test_speaker_cannot_assert_a_rule_it_never_learned():
    """Candidate sentences come from the LEARNED model, never the world's rule table.

    Nothing bitter is ever eaten in training, so there must be no sayable rule
    about eating bitter things -- otherwise the speaker could confidently teach a
    fact it has no grounds for, which is the confabulation cube_cause.py gates.
    """
    sp, m = _speaker()
    rules = sp.learned_rules("EAT")
    assert rules, "it should be able to state the rules it DID learn"
    assert all(val != "bitter" for _, _, _, val, _ in rules)
    assert not m.predict("DOG", "EAT", "HERB")["answered"]


def test_expected_value_planning_survives_an_unpredictable_listener():
    """Scoring a sentence on one sampled coin-flip cost 1.4/12; averaging fixes it."""
    sp, _ = _speaker()
    rng = np.random.default_rng(0)
    tiefree = [s for s in S.scenarios() if s.gap in ("wrong-attr", "false-negative")]
    for _ in range(25):
        assert all(S.run_scenario(sp, s, rng)["ok_after"] for s in tiefree)


def test_every_scenario_is_actually_solvable_and_actually_broken():
    """No scenario may be already-won or impossible; both would be scoring nothing."""
    for sc in S.scenarios():
        good = [o for o in sc.options if S.truly_good(sc, o)]
        assert len(good) == 1, f"{sc.label}/{sc.gap} needs exactly one right answer"
        before = S.make_listener(sc).plan(sc.options, sc.agent)
        assert S.truly_good(sc, before) == (sc.gap == "none")


if __name__ == "__main__":
    for _n, _f in list(globals().items()):
        if _n.startswith("test_") and callable(_f):
            _f(); print(f"ok  {_n}")
    print("all tests passed")
