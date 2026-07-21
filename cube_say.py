# -*- coding: utf-8 -*-
"""cube_say.py — what is WORTH SAYING. The rung after understanding.

cube_cause.py ended with the honest limit: knowing what happens next still does
not tell you what is worth saying. This is that next rung.

THE DEFINITION, made testable. An utterance is worth saying if it CHANGES WHAT
THE LISTENER DOES, FOR THE BETTER. So: give a listener a goal, a partial or
mistaken model of the world, and a choice of things to act on. Let the speaker
say ONE thing, or nothing at all. Then score whether the listener acts well.

Three properties fall out of that which description cannot fake:

  SILENCE IS A CORRECT ANSWER. If the listener would already succeed, then
  saying something true, relevant and interesting is a FAILURE. Every describer
  ever built scores zero on this, because it has no way to say nothing.

  SAME SCENE, DIFFERENT LISTENER -> DIFFERENT UTTERANCE. What is worth saying
  depends on what THEY do not know, not on what is true. Two listeners about to
  make the identical mistake need different sentences, because the belief that
  produced the mistake differs.

  SAME SCENE, DIFFERENT GOAL -> DIFFERENT UTTERANCE. The world does not change;
  the point of speaking does. In this world a herb is the thing to WARN against
  if the listener wants to eat, and the thing to RECOMMEND if the listener wants
  to shift something, because it is bitter but light.

WHAT MAKES THIS PRAGMATICS AND NOT DESCRIPTION. The speaker must run a model of
the listener's mind: simulate hearing, re-planning, and acting. It is scored on
someone else's success, never on the accuracy of its own sentence. A true,
perfectly accurate sentence that changes nothing scores zero here.

BUILT ON THE PREVIOUS RUNG. The speaker's knowledge of the world IS the learned
transition model from cube_cause.py -- not the ground truth. So it advises about
pushing a rock having never once seen a rock pushed, and where its own model
stops, its advice has to stop too.

Standalone lab cube. Never reads / writes / imports the live production
substrate. Aurelia's mind runs on :5057 and is not touched here.
"""
import collections, copy, itertools, sys
import numpy as np
import cube_cause as C

SPEECH_COST = 0.01      # fixed a priori, never tuned on the scored set: enough to
                        # break a tie towards silence, never enough to buy a failure

# ── goals: what a listener is trying to bring about, and what it must avoid ───
# Each goal has exactly ONE branch that achieves it and at least one that is
# actively harmful, so that a listener can be strictly wrong and a single
# sentence can strictly fix it. Without a harmful branch the best any sentence
# could do is create a tie, and then the tie-break would be deciding the
# experiment instead of the speaker.
GOALS = {
    "make a meal of it": dict(action="EAT", want=("patient", "GONE"),
                              avoid={"SICK", "SPAT_OUT"}),        # soft eats clean
    "shift it":          dict(action="PUSH", want=("patient", "MOVED"),
                              avoid={"SORE"}),                     # rooted hurts
    "catch it":          dict(action="CHASE", want=("patient", "CAUGHT"),
                              avoid={"RAN_AWAY", "FLEW_AWAY", "SORE"}),  # it escapes
}


def score_delta(delta, goal, agent, patient):
    """How good is this outcome FOR THIS LISTENER? Harm dominates."""
    if delta is None:
        return 0.0                                   # unknown: neither promising nor safe
    states = set(delta.values())
    if states & goal["avoid"]:
        return -1.0
    role, want = goal["want"]
    if delta.get(agent if role == "agent" else patient) == want:
        return 1.0
    return 0.0


# ══════════════════════════════════════════════════════════════════════════════
# THE LISTENER — a mind with gaps, which acts on what it believes
# ══════════════════════════════════════════════════════════════════════════════
class Belief:
    """What someone takes to be true. Attributes of things, and rules about actions.

    Rules are keyed (action, attribute, value) so that a rule is SAYABLE as a
    sentence: "eating bitter things makes you sick". Both parties share the FORM
    of a rule; what differs is which rules and which attributes they possess.
    That shared format is a stated simplification -- the question here is what to
    say, not how two minds come to represent things the same way.
    """
    def __init__(self, attrs=None, rules=None):
        self.attrs = collections.defaultdict(dict, copy.deepcopy(attrs or {}))
        self.rules = dict(rules or {})

    def predict(self, agent, action, patient):
        for (act, attr, val), sch in self.rules.items():
            if act == action and self.attrs.get(patient, {}).get(attr) == val:
                return {(agent if r == "agent" else patient): s for r, s in sch.items()}
        return None                                   # I cannot say what would happen

    def hear(self, utt):
        """Believe what you are told. Cooperative listener; no scepticism modelled."""
        if utt is None:
            return self
        if utt[0] == "attr":
            _, ent, attr, val = utt
            self.attrs[ent][attr] = val
        else:
            _, act, attr, val, sch = utt
            self.rules[(act, attr, val)] = sch
        return self


class Listener:
    def __init__(self, belief, goal_name, tiebreak="first"):
        self.belief, self.goal_name = belief, goal_name
        self.goal = GOALS[goal_name]
        self.tiebreak = tiebreak

    def plan(self, options, agent):
        """Choose what to act on, using only what it believes.

        When it genuinely cannot tell two options apart it has to fall back on
        something arbitrary, and that arbitrary choice must never be what decides
        a result here -- so it is a knob, and the scoreboard is run both ways.
        """
        scored = [(score_delta(self.belief.predict(agent, self.goal["action"], o),
                               self.goal, agent, o), i, o)
                  for i, o in enumerate(options)]
        best = max(s for s, _, _ in scored)
        tied = [o for s, _, o in scored if s == best]
        if self.tiebreak == "first":
            return tied[0]
        if self.tiebreak == "last":
            return tied[-1]
        return tied[int(self.tiebreak.integers(len(tied)))]     # a Generator: coin-flip

    def copy(self):
        return Listener(Belief(self.belief.attrs, self.belief.rules), self.goal_name,
                        self.tiebreak)


def full_belief():
    """A complete and correct mind, from which gaps are then knocked out."""
    attrs = {e: dict(C.ENTITIES[e]) for e in C.ENTITIES}
    rules = {}
    for (act, vals), sch in C.RULES.items():
        reads = C.ACTIONS[act]["reads"]
        if len(reads) == 1:
            rules[(act, reads[0], vals[0])] = dict(sch)
    return Belief(attrs, rules)


# ══════════════════════════════════════════════════════════════════════════════
# THE SPEAKER — chooses by simulating the listener, not by describing the scene
# ══════════════════════════════════════════════════════════════════════════════
class Speaker:
    """Says the one thing that most improves what the listener will DO.

    Its knowledge of the world is the LEARNED transition model from the previous
    rung, so it can be wrong, and where that model abstains this speaker has
    nothing honest to offer.
    """
    name = "models the listener"

    def __init__(self, model):
        self.model = model

    def value_of(self, agent, action, patient, goal):
        r = self.model.predict(agent, action, patient)
        return score_delta(r["delta"] if r["answered"] else None, goal, agent, patient)

    def learned_rules(self, action):
        """The general rules this speaker can HONESTLY assert, from its own model.

        Not from the world's rule table -- that would let it confidently teach a
        rule it never learned, which is exactly the confabulation the previous
        rung was built to prevent. A rule is sayable only if the model answers
        for every thing of that kind AND gives the same answer every time. Where
        its model declines (nothing bitter was ever eaten in training), it has no
        sentence to offer, and that silence is the point.
        """
        key = max(self.model.rel_raw.get(action, {None: 0}),
                  key=lambda k: self.model.rel_raw[action][k])
        if key is None or key[0] != "patient":
            return []
        attr, out = key[1], []
        for val in {C.ENTITIES[e].get(attr) for e in C.ENTITIES} - {None}:
            schemas, agent = set(), "DOG"
            for e in C.ENTITIES:
                if C.ENTITIES[e].get(attr) != val or not C.legal(agent, action, e):
                    continue
                r = self.model.predict(agent, action, e)
                schemas.add(C.schema_of(agent, e, r["delta"]) if r["answered"] else None)
            if schemas and None not in schemas and len(schemas) == 1:
                out.append(("rule", action, attr, val, dict(schemas.pop())))
        return out

    def candidates(self, options, action):
        """Everything it could say. Includes true irrelevances, deliberately.

        Attributes are PERCEIVED, so it may state any of them -- including the
        colour, which nothing reads and which is always worthless to mention.
        Rules are LEARNED, so it may only state the ones it actually knows.
        """
        out = [None]
        for o in options:
            for attr, val in C.ENTITIES[o].items():
                out.append(("attr", o, attr, val))
        return out + self.learned_rules(action)

    def choose(self, listener, options, agent):
        """Pick the sentence with the best EXPECTED effect on what they do.

        Expected, because when two options look identical to the listener the
        speaker cannot know which way it will jump -- so it scores a candidate by
        averaging over that ambiguity instead of assuming a convenient answer.
        Sampling one guess instead cost 1.4 of 12 on the tie-free cases: the
        speaker was choosing sentences on the strength of a coin-flip it had
        imagined going its way.
        """
        goal = listener.goal
        best, best_s = None, -9e9
        for u in self.candidates(options, goal["action"]):
            vals = []
            for tb in ("first", "last"):
                sim = listener.copy()
                sim.tiebreak = tb
                sim.belief.hear(u)
                pick = sim.plan(options, agent)
                vals.append(self.value_of(agent, goal["action"], pick, goal)
                            if pick else 0.0)
            s = sum(vals) / len(vals) - SPEECH_COST * (u is not None)
            if s > best_s:
                best, best_s = u, s
        return best


class SilentSpeaker(Speaker):
    """Never says anything. The floor -- and it beats a chatterer at silence."""
    name = "says nothing, ever"

    def choose(self, listener, options, agent):
        return None


class BlindSpeaker(Speaker):
    """Knows the world perfectly, models the LISTENER not at all.

    Says the most objectively informative true thing about the scene: the
    attribute of the option whose outcome is most extreme under the goal. This
    is the baseline that decides whether pragmatics needs a theory of mind, or
    whether saying-what-matters-about-the-world is enough.
    """
    name = "world-informative, listener-blind"

    def choose(self, listener, options, agent):
        goal = listener.goal
        best, best_s = None, -9e9
        for o in options:
            for attr in C.ACTIONS[goal["action"]]["reads"]:
                v = C.ENTITIES[o].get(attr)
                if v is None:
                    continue
                s = abs(self.value_of(agent, goal["action"], o, goal))
                if s > best_s:
                    best, best_s = ("attr", o, attr, v), s
        return best


class EagerSpeaker(Speaker):
    """Always warns about the worst option. Helpful-sounding, listener-blind."""
    name = "always warns about the worst thing"

    def choose(self, listener, options, agent):
        goal = listener.goal
        worst = min(options, key=lambda o: self.value_of(agent, goal["action"], o, goal))
        attr = C.ACTIONS[goal["action"]]["reads"][0]
        return ("attr", worst, attr, C.ENTITIES[worst].get(attr))


class OracleSpeaker(Speaker):
    """Identical policy, but reasons with the TRUE world instead of a learned model.

    The gap between this and the real speaker is the price of having learned the
    world rather than been given it.
    """
    name = "same policy, ground-truth world"

    def value_of(self, agent, action, patient, goal):
        if not C.legal(agent, action, patient):
            return 0.0
        return score_delta(C.world_apply(agent, action, patient), goal, agent, patient)


# ══════════════════════════════════════════════════════════════════════════════
# SCENARIOS — a listener about to get it wrong, and why
# ══════════════════════════════════════════════════════════════════════════════
# Every scenario is built on cells the speaker's world model NEVER saw acted on,
# so its advice is generalisation, not recall.
Scenario = collections.namedtuple(
    "Scenario", "goal agent options gap harmful label")


def branch_values(goal):
    """(the attribute value that achieves this goal, one that actively harms it).

    Read off the world's rules, so the scenarios cannot drift out of step with it.
    """
    g, act = GOALS[goal], GOALS[goal]["action"]
    good = harm = None
    for (a, vals), sch in C.RULES.items():
        if a != act or len(vals) != 1:
            continue
        role, want = g["want"]
        if sch.get(role) == want:
            good = vals[0]
        if set(sch.values()) & g["avoid"]:
            harm = vals[0]
    return good, harm


def make_listener(sc, tiebreak="first"):
    """Build the flawed mind that the scenario's gap describes."""
    b = full_belief()
    act = GOALS[sc.goal]["action"]
    attr = C.ACTIONS[act]["reads"][0]
    good = next(o for o in sc.options if o != sc.harmful)
    good_v, harm_v = branch_values(sc.goal)
    if sc.gap == "wrong-attr":
        # It believes the harmful thing is the GOOD kind, and knows nothing about
        # the thing that would actually work. So it STRICTLY prefers the harmful
        # option (+1 over 0), and once corrected it STRICTLY prefers the good one
        # (0 over -1). No tie either side -- the tie-break cannot touch this case.
        # The right sentence here is a WARNING.
        b.attrs[sc.harmful][attr] = good_v
        b.attrs[good].pop(attr, None)
    elif sc.gap == "false-negative":
        # The mirror image, and the case that separates a mind-modelling speaker
        # from a reflex. It believes the GOOD thing is dangerous, and knows nothing
        # about the harmful one -- so it strictly avoids the very thing it wants.
        # Warning it about the worst option cannot help: that only makes both look
        # bad. The only sentence that works is a RECOMMENDATION.
        b.attrs[good][attr] = harm_v
        b.attrs[sc.harmful].pop(attr, None)
    elif sc.gap == "no-rule":
        # Attributes all correct, but no idea what this action DOES. Everything
        # looks equally blank, so this case IS decided by the tie-break until
        # somebody tells it a rule -- which is exactly why both orders are run.
        b.rules = {k: v for k, v in b.rules.items() if k[0] != act}
    elif sc.gap == "none":
        pass                                          # a sound mind: silence is correct
    return Listener(b, sc.goal, tiebreak)


def scenarios():
    """(scene, gap, goal) triples. Held-out cells only, one correct answer each."""
    out = []
    # EAT: only SOFT things get eaten clean; bitter ones make you sick.
    #      MELON was never seen eaten in training.
    for bad in ("HERB", "ROOT"):
        for gap in ("wrong-attr", "false-negative", "no-rule", "none"):
            out.append(Scenario("make a meal of it", "DOG", [bad, "MELON"], gap, bad,
                                f"eat: {bad} vs MELON"))
    # PUSH: only LIGHT things move; rooted ones leave you sore.
    #       BALL was never seen pushed in training.
    for bad in ("TREE", "POST"):
        for gap in ("wrong-attr", "false-negative", "no-rule", "none"):
            out.append(Scenario("shift it", "DOG", [bad, "BALL"], gap, bad,
                                f"shift: {bad} vs BALL"))
    # CHASE: only SLOW things are caught; the rest escape.
    #        TURTLE/BAT/FOX were never seen chased in training.
    for bad in ("BAT", "FOX"):
        for gap in ("wrong-attr", "false-negative", "no-rule", "none"):
            out.append(Scenario("catch it", "DOG", [bad, "TURTLE"], gap, bad,
                                f"catch: {bad} vs TURTLE"))
    return out


def truly_good(sc, o):
    """Would acting on this option actually achieve the goal, in the real world?"""
    g = GOALS[sc.goal]
    if not C.legal(sc.agent, g["action"], o):
        return False
    return score_delta(C.world_apply(sc.agent, g["action"], o), g, sc.agent, o) > 0


def run_scenario(speaker, sc, tiebreak="first"):
    L = make_listener(sc, tiebreak)
    before = L.plan(sc.options, sc.agent)
    utt = speaker.choose(L, sc.options, sc.agent)
    L.belief.hear(utt)
    after = L.plan(sc.options, sc.agent)
    return dict(before=before, utt=utt, after=after,
                ok_before=truly_good(sc, before), ok_after=truly_good(sc, after))


def say(utt):
    if utt is None:
        return "(says nothing)"
    if utt[0] == "attr":
        return f"\"the {utt[1].lower()} is {utt[3]}\""
    _, act, _, val, sch = utt
    eff = ", ".join(f"{r} {s}" for r, s in sorted(sch.items())) or "nothing happens"
    return f"\"{act.lower()}ing {val} things -> {eff}\""


def sep(t):
    print("\n" + "=" * 78 + f"\n{t}\n" + "=" * 78)


# ══════════════════════════════════════════════════════════════════════════════
def main():
    C.use_world("one causal attribute per action")
    train, buckets = C.split()
    assert not C.verify_splits(train, buckets)
    episodes = [(a, act, p, C.world_apply(a, act, p)) for a, act, p in train]
    model = C.TransitionModel(seed=0).learn(episodes)
    f, _, _, _ = model.calibrate(buckets["calib"], buckets["ood_calib"], apply=True)

    scs = scenarios()
    speakers = [Speaker(model), SilentSpeaker(model), BlindSpeaker(model),
                EagerSpeaker(model), OracleSpeaker(model)]

    sep("THE SETUP")
    print("  A listener wants something, believes some wrong or incomplete things, and")
    print("  is about to choose what to act on. The speaker may say ONE thing, or")
    print("  nothing. It is scored on what the LISTENER then does -- never on whether")
    print("  its own sentence was true. Every true sentence here is available to say;")
    print("  almost all of them are worthless.\n")
    print(f"  {len(scs)} situations, built only on things the speaker's world model never")
    print(f"  saw acted on ({', '.join(f'{a}/{p}' for a, p in C.TEST_CELLS[:4])}, ...).")
    print(f"  It advises about pushing a rock having never once seen a rock pushed.")
    print(f"  The speech cost ({SPEECH_COST}) was fixed in advance, not tuned here.")

    # ── the three properties, shown before they are scored ───────────────────
    sep("1. SILENCE IS AN ANSWER")
    print("  Same scene, same goal. The only difference is whether the listener already")
    print("  knows what it needs. A describer says something true in both rows.\n")
    S = Speaker(model)
    for gap, note in (("wrong-attr", "believes the herb is soft"),
                      ("none", "already knows everything it needs")):
        sc = next(s for s in scs if s.gap == gap and s.harmful == "HERB")
        r = run_scenario(S, sc)
        print(f"      listener {note:<34} -> {say(r['utt'])}")
        print(f"          would have taken the {r['before']}, "
              f"ends up taking the {r['after']}")

    sep("2. SAME SCENE, DIFFERENT LISTENER -> DIFFERENT SENTENCE")
    print("  Two listeners, identical scene, identical goal, both about to eat the same")
    print("  wrong thing. What they need to hear is not the same, because what is broken")
    print("  in them is not the same.\n")
    for gap, note in (("wrong-attr", "has a FALSE BELIEF about the herb"),
                      ("no-rule", "has no idea what EATING does at all")):
        sc = next(s for s in scs if s.gap == gap and s.harmful == "HERB")
        r = run_scenario(S, sc)
        print(f"      {note:<38} -> {say(r['utt'])}")
    print("\n      One needs a fact about a thing. The other needs a rule about the world.")
    print("      Nothing in the scene distinguishes them -- only the mind does.")

    sep("3. THE SAME THING IS WORTH OPPOSITE SENTENCES, DEPENDING ON THE GOAL")
    print("  A herb is bitter AND light. So it is the thing to steer a listener AWAY")
    print("  from when they want to eat, and the thing they should end up TAKING when")
    print("  they want to shift something. The herb does not change. The world does not")
    print("  change. Only the point of speaking moves, and the sentence moves with it.\n")
    for goal, opts in (("make a meal of it", ["HERB", "MELON"]),
                       ("shift it", ["TREE", "HERB"])):
        sc = Scenario(goal, "DOG", opts, "wrong-attr", opts[0], "")
        r = run_scenario(S, sc)
        print(f"      listener wants to {goal:<18} -> {say(r['utt'])}")
        print(f"          takes the {r['after']:<6}"
              + ("  (right)" if r["ok_after"] else "  (wrong)")
              + ("   <- the herb is the THING TO AVOID here"
                 if r["after"] != "HERB" else
                 "   <- the herb is the RIGHT ANSWER here"))

    # ── the scoreboard ───────────────────────────────────────────────────────
    sep("SCOREBOARD")
    print("  helped   = listener would have failed, and now succeeds")
    print("  broke it = listener would have SUCCEEDED, and now fails  (talking made it worse)")
    print("  chatter  = spoke to a listener that needed nothing\n")
    n, nneed = len(scs), sum(1 for sc in scs if sc.gap == "none")
    wa = [sc for sc in scs if sc.gap in ("wrong-attr", "false-negative")]
    nr = [sc for sc in scs if sc.gap == "no-rule"]

    def rate(sp, subset, mode, trials=200):
        """Success on a subset. With a coin-flip listener, averaged over trials."""
        if mode != "random":
            return sum(run_scenario(sp, sc, mode)["ok_after"] for sc in subset) / max(1, len(subset))
        rng, tot = np.random.default_rng(0), 0
        for _ in range(trials):
            tot += sum(run_scenario(sp, sc, rng)["ok_after"] for sc in subset)
        return tot / max(1, trials * len(subset))

    print(f"      {'speaker':<34}{'succeeds':<12}{'helped':<10}{'broke it':<11}{'chatter'}")
    rows = {}
    for sp in speakers:
        ok = helped = broke = chatter = 0
        for sc in scs:
            r = run_scenario(sp, sc)
            ok += r["ok_after"]
            helped += (not r["ok_before"]) and r["ok_after"]
            broke += r["ok_before"] and not r["ok_after"]
            chatter += (sc.gap == "none") and (r["utt"] is not None)
        rows[sp.name] = (ok, helped, broke, chatter)
        print(f"      {sp.name:<34}{f'{ok}/{n}':<12}{helped:<10}{broke:<11}{chatter}/{nneed}")

    base = sum(1 for sc in scs if truly_good(sc, make_listener(sc).plan(sc.options, sc.agent)))
    print(f"\n      (with no speaker at all the listener succeeds {base}/{n} times --")
    print(f"       that is the floor any of this has to beat)")

    # ── how much of that was MY arbitrary tie-break rather than the speaker? ──
    print(f"\n  ATTACK ON THE ABOVE. When two options look identical the listener must")
    print(f"  fall back on something arbitrary, and that fallback must not be what")
    print(f"  produces the result. Re-running with it reversed shows it very nearly is:")
    print(f"  under `ties -> last` even the listener-blind speaker scores full marks,")
    print(f"  because the good option happens to sit second in every option list.\n")
    print(f"      {'speaker':<34}{'ties->first':<14}{'ties->last':<13}{'coin-flip'}")
    for sp in speakers:
        a, b, c = (rate(sp, scs, m) for m in ("first", "last", "random"))
        print(f"      {sp.name:<34}{a*n:>5.0f}/{n}{'':<6}{b*n:>5.0f}/{n}{'':<5}{c*n:>6.1f}/{n}")
    print(f"\n  So the aggregate is not the result. The signal lives in the {len(wa)} situations")
    print(f"  that are TIE-FREE BY CONSTRUCTION -- the listener strictly prefers the wrong")
    print(f"  option before the sentence and strictly prefers the right one after it, so")
    print(f"  no fallback can touch them. Split by WHAT IS BROKEN in the listener, with a")
    print(f"  coin-flip listener throughout:\n")
    gaps = [("wrong-attr", "false belief"), ("false-negative", "false alarm"),
            ("no-rule", "no rules"), ("none", "nothing")]
    print(f"      {'speaker':<34}" + "".join(f"{lbl:<16}" for _, lbl in gaps))
    for sp in speakers:
        cells = []
        for g, _ in gaps:
            sub = [s for s in scs if s.gap == g]
            cells.append(f"{rate(sp, sub, 'random')*len(sub):>4.1f}/{len(sub)}")
        print(f"      {sp.name:<34}" + "".join(f"{c:<16}" for c in cells))
    print(f"\n      The first two columns are the whole story, and they pull in OPPOSITE")
    print(f"      directions. A listener with a FALSE BELIEF about the dangerous thing")
    print(f"      needs a WARNING. A listener with a FALSE ALARM about the good thing")
    print(f"      needs a RECOMMENDATION -- and warning it about the dangerous thing")
    print(f"      makes both options look bad and leaves it exactly where it was.")
    print(f"      That is why 'always warn about the worst thing' scores full marks in")
    print(f"      one column and no better than a coin-flip in the next (it is a flat")
    print(f"      0/6 there when the listener does not flip coins at all), while the")
    print(f"      speaker that actually simulates the mind in front of it handles both.")

    # ── where its own model runs out ─────────────────────────────────────────
    sep("WHEN THE SPEAKER ITSELF DOES NOT KNOW")
    print("  Nothing bitter is ever eaten in the speaker's training, so its own model")
    print("  declines to predict what eating a herb does. It can still SEE that the herb")
    print("  is bitter. Whether that helps depends entirely on the listener:\n")
    for gap, note in (("wrong-attr", "knows the bitter rule, wrong about this herb"),
                      ("no-rule", "does not know the bitter rule either")):
        sc = Scenario("make a meal of it", "DOG", ["HERB", "MELON"], gap, "HERB", "")
        r = run_scenario(S, sc)
        print(f"      listener {note:<44} -> {say(r['utt'])}")
        print(f"          takes the {r['after']}"
              + ("  (right)" if r["ok_after"] else "  (WRONG -- neither of them knows)"))
    pred = model.predict("DOG", "EAT", "HERB")
    print(f"\n      the speaker's own model on EAT/HERB: "
          f"{'answers' if pred['answered'] else 'DECLINES'}"
          f"  <- it passes on its own doubt instead of inventing a warning")

    sep("VERDICT")
    cf = {sp.name: rate(sp, scs, "random") * len(scs) for sp in speakers}
    print(f"  Scored against a listener whose coin-flips nobody can predict, so that none")
    print(f"  of this rests on an ordering I chose:\n")
    print(f"      listener succeeds {cf[Speaker.name]:.0f}/{n} with a speaker that models its mind")
    print(f"      {cf[SilentSpeaker.name]:.1f}/{n} with silence")
    print(f"      {cf[BlindSpeaker.name]:.1f}/{n} with a speaker that knows the world perfectly and models no mind")
    print(f"      {cf[EagerSpeaker.name]:.1f}/{n} with a speaker that always warns about the worst thing")
    print(f"      {cf[OracleSpeaker.name]:.0f}/{n} upper bound, same policy reasoning from the TRUE world")
    print(f"\n  It reaches the ground-truth upper bound while its own world model was")
    print(f"  LEARNED and is missing whole branches -- and it says nothing at all to the")
    print(f"  {nneed} listeners who needed nothing, which every rival that opens its mouth fails.")
    print(f"\n  The listener-blind speaker is the one that matters. It says true, relevant,")
    print(f"  world-informative things and it does not help, because WHAT IS WORTH SAYING")
    print(f"  IS NOT A PROPERTY OF THE WORLD. It is a property of the gap between two")
    print(f"  minds, and you cannot read it off the scene however well you understand it.")
    print(f"\n  SCOPE, honestly: cooperative, single-turn, one sentence, and the listener's")
    print(f"  mind is HANDED to the speaker rather than inferred from behaviour. Inferring")
    print(f"  it -- watching what someone reaches for and working out what they must")
    print(f"  believe -- is theory of mind, and it is the next rung, not this one.")
    return rows


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    main()
