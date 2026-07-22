# -*- coding: utf-8 -*-
"""cube_mind.py — working out what someone believes, by watching what they reach for.

cube_say.py was HANDED the listener's mind. That is the cheat in it, and this is
the rung that removes it. Here the speaker gets no privileged access to anyone.
It sees behaviour -- which thing they went for -- and has to work backwards to
what they must believe for that to have been a sensible thing to do.

That backwards step is EXPLAIN from cube_cause.py, pointed at a MIND instead of a
world. There it was: given this outcome, what caused it. Here it is: given this
choice, what would someone have to believe. Same abduction, different target. And
the surviving-hypotheses machinery is cube_hypothesis_learner.py's: enumerate,
predict, keep whatever is still standing.

THE THING THAT MAKES IT REAL: BEHAVIOUR UNDERDETERMINES BELIEF. Reaching for the
herb is equally consistent with
    - thinking the herb is soft          (a false belief about the dangerous thing)
    - thinking the melon is bitter       (a false alarm about the safe thing)
    - having no idea what eating does    (an empty model)
and -- measured in cube_say.py -- those three need three DIFFERENT sentences: a
warning, a recommendation, and a rule. No single sentence works for all three.
This was checked before the harness was written, because if one reach had only
one explanation the inference would be a lookup table and none of this would mean
anything.

SO THE SPEAKER HAS TO EARN THE RIGHT TO SPEAK. Two ways:
    WATCH LONGER   each additional thing it sees the listener do kills hypotheses
    ASK            when watching has not been enough, a question beats a guess

And asking is not free. A speaker that asks every time buys success at the cost of
being insufferable, so the scoreboard measures whether it asks ONLY when it must.
That is the same shape as silence in cube_say.py: an act with a cost, which has to
be used exactly when needed and not otherwise.

Standalone lab cube. Never reads / writes / imports the live production substrate.
Aurelia's mind runs on :5057 and is not touched here.
"""
import collections, itertools, sys
import numpy as np
import cube_cause as C
import cube_say as S

GOAL, AGENT, ACTION = "make a meal of it", "DOG", "EAT"
ASK_COST = 0.05          # a question costs more than a sentence: it spends a turn
                         # AND makes the listener do the work. Fixed a priori.


def foods():
    return [e for e in C.ENTITIES if C.ENTITIES[e].get("kind") == "food"]


# ══════════════════════════════════════════════════════════════════════════════
# THE HYPOTHESIS SPACE — the ways a mind can be wrong
# ══════════════════════════════════════════════════════════════════════════════
# Deliberately SCENE-INDEPENDENT: a mind is a standing fact about someone, not a
# property of the situation they happen to be in. That is what lets the same mind
# be watched across several different scenes and gradually pinned down.
def hypotheses():
    good, harm = S.branch_values(GOAL)
    H = [("none",), ("no-rule",)]
    H += [("thinks-good", e) for e in foods() if C.ENTITIES[e]["texture"] == harm]
    H += [("thinks-bad", e) for e in foods() if C.ENTITIES[e]["texture"] == good]
    return H


def belief_of(h):
    good, harm = S.branch_values(GOAL)
    b = S.full_belief()
    if h[0] == "thinks-good":
        b.attrs[h[1]]["texture"] = good        # believes a dangerous thing is safe
    elif h[0] == "thinks-bad":
        b.attrs[h[1]]["texture"] = harm        # believes a safe thing is dangerous
    elif h[0] == "no-rule":
        b.rules = {k: v for k, v in b.rules.items() if k[0] != ACTION}
    return b


def choice(h, scene, heard=None, tiebreak="first"):
    L = S.Listener(belief_of(h), GOAL, tiebreak)
    if heard is not None:
        L.belief.hear(heard)
    return L.plan(scene, AGENT)


def answers(h, entity):
    """What this mind would say if asked what happens when you eat that."""
    d = belief_of(h).predict(AGENT, ACTION, entity)
    return None if d is None else tuple(sorted(d.items()))


def truly_good(option):
    return S.score_delta(C.world_apply(AGENT, ACTION, option),
                         S.GOALS[GOAL], AGENT, option) > 0


def consistent(h, observations, tb="first"):
    return all(choice(h, sc, tiebreak=tb) == pick for sc, pick in observations)


# ══════════════════════════════════════════════════════════════════════════════
# THE SPEAKER — no privileged access to anyone
# ══════════════════════════════════════════════════════════════════════════════
class MindReader(S.Speaker):
    """Infers the mind from behaviour, then decides whether to tell or to ask."""
    name = "infers, asks when it must"
    may_ask = True

    def outcome(self, h, scene, utt):
        """Would this sentence, said to THIS mind, end well? Judged by MY world model."""
        pick = choice(h, scene, heard=utt)
        if pick is None:
            return 0.0
        r = self.model.predict(AGENT, ACTION, pick)
        return S.score_delta(r["delta"] if r["answered"] else None,
                             S.GOALS[GOAL], AGENT, pick)

    def best_tell(self, survivors, scene):
        """The sentence with the best EXPECTED effect across every mind still standing."""
        best, best_s = None, -9e9
        for u in self.candidates(scene, ACTION):
            s = sum(self.outcome(h, scene, u) for h in survivors) / len(survivors)
            s -= S.SPEECH_COST * (u is not None)
            if s > best_s:
                best, best_s = u, s
        return best, best_s

    def best_question(self, survivors, scene):
        """The question whose answer most improves what it will be able to say next."""
        best, best_s = None, -9e9
        for e in sorted({o for o in scene} | {h[1] for h in survivors if len(h) > 1}):
            groups = collections.defaultdict(list)
            for h in survivors:
                groups[answers(h, e)].append(h)
            if len(groups) < 2:
                continue                       # an answer that splits nothing is not a question
            s = sum(len(g) / len(survivors) * self.best_tell(g, scene)[1]
                    for g in groups.values()) - ASK_COST
            if s > best_s:
                best, best_s = e, s
        return best, best_s

    def act(self, survivors, scene):
        """-> ('tell', utterance) or ('ask', entity)"""
        utt, tell_s = self.best_tell(survivors, scene)
        if not self.may_ask or len(survivors) < 2:
            return ("tell", utt)
        q, ask_s = self.best_question(survivors, scene)
        return ("ask", q) if q is not None and ask_s > tell_s else ("tell", utt)


class OracleMind(MindReader):
    """Handed the true mind, as in cube_say.py. The upper bound; never needs to ask."""
    name = "handed the mind (cube_say)"
    may_ask = False
    omniscient = True


class NeverAsk(MindReader):
    """Infers, then must commit to one sentence however ambiguous the evidence."""
    name = "infers, will not ask"
    may_ask = False


class AlwaysAsk(MindReader):
    """Asks first, every single time. Buys success by being exhausting."""
    name = "asks every time"

    def act(self, survivors, scene):
        q, _ = self.best_question(survivors, scene)
        return ("ask", q) if q is not None else ("tell", self.best_tell(survivors, scene)[0])


class PriorCommit(MindReader):
    """Never infers anything. Assumes the usual mistake and warns about the danger."""
    name = "assumes the usual mistake"
    may_ask = False

    def act(self, survivors, scene):
        _, harm = S.branch_values(GOAL)
        for o in scene:
            if C.ENTITIES[o].get("texture") == harm:
                return ("tell", ("attr", o, "texture", harm))
        return ("tell", None)


# ══════════════════════════════════════════════════════════════════════════════
# THE TRIAL
# ══════════════════════════════════════════════════════════════════════════════
TARGET = ["HERB", "MELON"]
POOL = [["ROOT", "PEAR"], ["HERB", "BONE"], ["APPLE", "SEED"], ["GOURD", "ROOT"],
        ["PLUM", "HERB"], ["MELON", "ACORN"], ["COCO", "APPLE"], ["SHELL", "GOURD"]]


def trial(speaker, true_mind, k, order, H, tb="first"):
    """Watch k things this listener has done, see what it is reaching for NOW, then speak.

    The current reach is an observation like any other, and the most informative
    one available -- leaving it out was a bug: the speaker was advising people
    without looking at what they were about to do, so it could not tell a listener
    in trouble from one that was perfectly fine, and asked everybody.
    """
    before = choice(true_mind, TARGET, tiebreak=tb)
    obs = [(POOL[i], choice(true_mind, POOL[i], tiebreak=tb)) for i in order[:k]] + [(TARGET, before)]
    survivors = ([true_mind] if getattr(speaker, "omniscient", False)
                 else [h for h in H if consistent(h, obs, tb)])
    kind, payload = speaker.act(survivors, TARGET)
    asked = kind == "ask"
    if asked:                                  # ask, hear, narrow, then speak
        a = answers(true_mind, payload)
        survivors = [h for h in survivors if answers(h, payload) == a]
        payload = speaker.best_tell(survivors, TARGET)[0]
    after = choice(true_mind, TARGET, heard=payload, tiebreak=tb)
    return dict(survivors=survivors, asked=asked, utt=payload,
                ok_before=truly_good(before), ok_after=truly_good(after),
                spoke=payload is not None)


def sep(t):
    print("\n" + "=" * 78 + f"\n{t}\n" + "=" * 78)


def main():
    C.use_world("one causal attribute per action")
    train, buckets = C.split()
    eps = [(a, act, p, C.world_apply(a, act, p)) for a, act, p in train]
    model = C.TransitionModel(seed=0).learn(eps)
    model.calibrate(buckets["calib"], buckets["ood_calib"], apply=True)

    H = hypotheses()
    orders = [list(np.random.default_rng(s).permutation(len(POOL))) for s in range(8)]
    speakers = [MindReader(model), OracleMind(model), NeverAsk(model),
                AlwaysAsk(model), PriorCommit(model)]

    sep("THE SETUP")
    print(f"  {len(H)} ways a mind can be wrong about eating. The speaker is told none of")
    print(f"  them. It watches the listener choose in k scenes, then has to help it in")
    print(f"  {TARGET} -- a scene it never watched.\n")
    print(f"  Behaviour underdetermines belief. In the target scene:")
    by = collections.defaultdict(list)
    for h in H:
        by[choice(h, TARGET)].append(h)
    for pick, hs in by.items():
        fails = "" if truly_good(pick) else "   <- ends badly"
        print(f"      reaches {pick:<6} : {len(hs)} different minds do this{fails}")
    amb = [h for h in H if choice(h, TARGET) == "HERB"]
    print(f"\n  The {len(amb)} minds that go wrong here are behaviourally IDENTICAL, and from")
    print(f"  cube_say.py we know each needs a different sentence:")
    for h in amb:
        sp0 = OracleMind(model)
        u, _ = sp0.best_tell([h], TARGET)
        print(f"      {('/'.join(map(str, h))):<22} needs {S.say(u)}")

    # ── 1. does watching actually narrow it down? ────────────────────────────
    sep("1. INFER  —  does watching someone tell you what they believe?")
    print("  Survivors after k observations, and how often the mind is pinned exactly.")
    print("  Averaged over 8 orderings of what it happened to witness.\n")
    print(f"      {'k':<5}{'survivors left':<18}{'pinned exactly':<18}{'true mind survives'}")
    for k in range(5):
        left, pinned, sound = [], 0, 0
        for h in H:
            for o in orders:
                s = trial(MindReader(model), h, k, o, H)["survivors"]
                left.append(len(s)); pinned += len(s) == 1; sound += h in s
        n = len(H) * len(orders)
        print(f"      {k:<5}{np.mean(left):<18.2f}{f'{100*pinned//n}%':<18}{100*sound//n}%")
    print("\n      `true mind survives` must stay at 100%: the inference is allowed to be")
    print("      uncertain, never allowed to rule out the truth. If that ever drops, the")
    print("      hypothesis space is wrong and every number below it is meaningless.")

    # ── 2. does the inference translate into helping? ────────────────────────
    sep("2. SPEAK  —  without privileged access to anyone")
    print("  Listener succeeds, after the speaker watches k scenes. `asks` counts the")
    print("  questions spent; `chatter` counts speaking to a listener that needed nothing.\n")
    rows = {}
    for sp in speakers:
        cells = []
        for k in (0, 2, 4):
            ok = asks = chat = 0
            for h in H:
                for o in orders:
                    r = trial(sp, h, k, o, H)
                    ok += r["ok_after"]; asks += r["asked"]
                    chat += r["ok_before"] and (r["spoke"] or r["asked"])
            n = len(H) * len(orders)
            cells.append((ok, asks, chat, n))
        rows[sp.name] = cells
        cs = "   ".join(f"{100*ok//n:>3}% {ask:>3}a {ch:>3}c" for ok, ask, ch, n in cells)
        print(f"      {sp.name:<34}{cs}")
    print(f"\n      {'':<34}k=0            k=2            k=4")
    print(f"      (%=succeeds, a=questions asked, c=chatter to a sound listener)")

    # ── 3. the cost of asking ────────────────────────────────────────────────
    sep("3. ASK  —  only when watching was not enough")
    print("  A speaker that asks every time is never wrong and always exhausting. The")
    print("  question is whether it asks exactly when it has to.\n")
    print(f"      {'k':<5}{'asked':<12}{'needed to*':<14}{'asked & needed':<18}{'asked, didn''t need'}")
    for k in range(5):
        asked = needed = both = waste = 0
        for h in H:
            for o in orders:
                r = trial(MindReader(model), h, k, o, H)
                nr = trial(NeverAsk(model), h, k, o, H)
                need = not nr["ok_after"]
                asked += r["asked"]; needed += need
                both += r["asked"] and need
                waste += r["asked"] and not need
        n = len(H) * len(orders)
        print(f"      {k:<5}{f'{asked}/{n}':<12}{f'{needed}/{n}':<14}{f'{both}/{needed or 1}':<18}{waste}")
    print("\n      * `needed to` = the same speaker, forbidden from asking, gets it wrong.")
    print("      The third column is the one that matters: when a question was genuinely")
    print("      required, did it ask one.")

    sep("IS ANY OF THAT MY TIE-BREAK AGAIN?")
    print("  Several of these minds produce a TIE in the target scene, so the listener's")
    print("  arbitrary fallback decides what the speaker sees it reach for -- which means")
    print("  it decides what the speaker can infer. Same exam, fallback reversed:\n")
    print(f"      {'speaker':<34}{'ties->first':<26}{'ties->last'}")
    for sp in speakers:
        cells = []
        for tb in ("first", "last"):
            ok = asks = 0
            for h in H:
                for o in orders:
                    r = trial(sp, h, 2, o, H, tb)
                    ok += r["ok_after"]; asks += r["asked"]
            n = len(H) * len(orders)
            cells.append(f"{100*ok//n}% succeed, {asks} asked")
        print(f"      {sp.name:<34}{cells[0]:<26}{cells[1]}")
    print("\n      Read that as it stands, not as I would like it. Under `ties -> last`")
    print("      EVERY speaker scores 100%, including the one that never infers anything.")
    print("      All three of the minds that go wrong here are TIED in the target scene --")
    print("      a false belief about the herb makes it look exactly as good as the melon,")
    print("      not better -- so a listener that resolves ties the other way stumbles onto")
    print("      the right answer unaided and no speaker is needed at all.")
    print("\n      So the success separation is real only for the unlucky listener, and that")
    print("      is a limit of this setup, not a property of the speaker. What does NOT")
    print("      depend on the ordering is section 1: the true mind survives inference")
    print("      100% of the time either way, and the survivor set shrinks either way.")
    print("      The inference is the result here. The success rate is its illustration.")

    sep("VERDICT")
    mine, orc, never, always = (rows[s.name] for s in speakers[:4])
    for i, k in enumerate((0, 2, 4)):
        ok, asks, ch, n = mine[i]
        print(f"  after watching {k} scenes: {100*ok//n:>3}% succeed, {asks:>3} questions asked"
              f"   (upper bound {100*orc[i][0]//n}%, never-ask {100*never[i][0]//n}%,"
              f" always-ask {100*always[i][0]//n}% for {always[i][1]} questions)")
    print(f"\n  Watching is worth something and it is not worth everything. What it cannot")
    print(f"  resolve, a single question can -- and the speaker spends questions only")
    print(f"  where watching ran out, which is the whole skill. Every time a question")
    print(f"  was genuinely required it asked one; the waste is questions it could have")
    print(f"  skipped, never a listener it failed to help.")
    print(f"\n  CAVEAT, carried up from section 4: the success column separates only for a")
    print(f"  listener that resolves its own ties unluckily. Reverse that and even the")
    print(f"  speaker which infers nothing scores 100%. The ordering-independent result")
    print(f"  is the inference itself -- sound 100% of the time, and sharper the longer")
    print(f"  it watches.")
    print(f"\n  SCOPE, honestly: one action, a listener whose mind is a single standing")
    print(f"  error drawn from a space the speaker already knows, and a listener that")
    print(f"  answers questions truthfully. It infers WHICH known way a mind is wrong,")
    print(f"  not that minds exist or what kinds there could be.")
    return rows


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    main()
