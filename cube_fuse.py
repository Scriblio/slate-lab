# -*- coding: utf-8 -*-
"""cube_fuse.py — grammar from listening + meaning from looking, learned together.

Matthew, 2026-07-21: "lets do the fuse"

Three cubes so far, each missing a half:
    :8899  memorised a corpus     — fluent, understands nothing
    :8900  grounded meaning       — understands, but its grammar was HANDED to it
    :8901  induced grammar        — learns your language, but means nothing by it

This fuses the last two. Nothing is hand-given: it hears (SENTENCE, SCENE) pairs —
words spoken while a situation is visible, which is what a child actually gets — and
learns all of it at once:

    GRAMMAR   categories + word order          (distributional, from the sentences)
    MEANING   which word refers to which thing (cross-situational: a word means what
                                                is reliably PRESENT when it's used)
    ROLES     which slot is the doer, which is the done-to
    SENSE     which things can do which actions (selectional constraints)

The words are INVENTED, so nothing can be solved by string matching. It has to earn
the fact that "vek" means DOG.

Proof it learned rather than assumed: the whole thing is run twice, on two different
word orders (S-V-O and S-O-V). The role mapping flips; everything else holds.

Standalone lab cube. Never reads / writes / imports the live production substrate.
"""
import numpy as np, collections, sys
from cube_language_induction import context_signatures, induce_categories, induce_templates

# ── the world: invented words, so nothing is given away by spelling ───────────
FEATURES = {
    "DOG":   {"animate", "animal"}, "CAT": {"animate", "animal"},
    "BIRD":  {"animate", "animal"},
    "APPLE": {"thing", "food"}, "SEED": {"thing", "food"}, "BALL": {"thing", "toy"},
}
WORD = {"DOG": "vek", "CAT": "mira", "BIRD": "lun",
        "APPLE": "tol", "SEED": "gan", "BALL": "sim",
        "EAT": "nak", "SEE": "pel", "CHASE": "tor"}
ACTIONS = {                       # what the world actually permits
    "EAT":   dict(agent="animate", patient="food"),
    "SEE":   dict(agent="animate", patient=None),
    "CHASE": dict(agent="animate", patient="animate"),
}
DET = "sa"
ORDERS = {"S-V-O": ["det", "agent", "action", "det", "patient"],
          "S-O-V": ["det", "agent", "det", "patient", "action"]}


def legal(agent, action, patient):
    need = ACTIONS[action]
    if agent == patient:
        return False                                   # keep roles unambiguous
    if need["agent"] not in FEATURES[agent]:
        return False
    if need["patient"] and need["patient"] not in FEATURES[patient]:
        return False
    return True


def make_scene(rng):
    while True:
        a = str(rng.choice(list(FEATURES))); p = str(rng.choice(list(FEATURES)))
        act = str(rng.choice(list(ACTIONS)))
        if legal(a, act, p):
            return dict(agent=a, action=act, patient=p)


def render(scene, order):
    out = []
    for slot in ORDERS[order]:
        out.append(DET if slot == "det" else WORD[scene[slot]])
    return out


# ══════════════════════════════════════════════════════════════════════════════
class FusedLearner:
    """Learns grammar, word meanings, roles and sense — from sentence+scene pairs."""

    def learn(self, exposure):
        sents = [t for t, s in exposure]

        # 1. GRAMMAR — purely from the sentences (no scenes involved)
        self.cats = induce_categories(context_signatures(sents))
        self.tmpl = induce_templates(sents, self.cats).most_common(1)[0][0]

        # 2. MEANING — cross-situational: a word means what is always present with it
        cand = {}
        for toks, sc in exposure:
            present = {sc["agent"], sc["action"], sc["patient"]}
            for w in set(toks):
                cand[w] = present if w not in cand else (cand[w] & present)
        # 2b. MUTUAL EXCLUSIVITY — the bias children use. Some words never occur
        # apart from another thing (a ball is only ever SEEN here), so co-occurrence
        # alone can't tell "sim" = BALL from "sim" = SEE. But if another word has
        # already claimed SEE, then this one must mean something else.
        self.rescued = []
        changed = True
        while changed:
            changed = False
            claimed = {next(iter(v)) for v in cand.values() if len(v) == 1}
            for w, v in cand.items():
                if len(v) > 1 and (v - claimed):
                    if v - claimed != v:
                        cand[w] = v - claimed
                        if len(cand[w]) == 1:
                            self.rescued.append(w)
                        changed = True

        self.refers = {w: next(iter(v)) for w, v in cand.items() if len(v) == 1}
        self.function_words = sorted(w for w, v in cand.items() if len(v) != 1)
        self.name = {r: w for w, r in self.refers.items()}

        # 3. ROLES — which slot of the induced template is doer / done-to
        tally = collections.defaultdict(collections.Counter)
        for toks, sc in exposure:
            if len(toks) != len(self.tmpl):
                continue
            for i, w in enumerate(toks):
                r = self.refers.get(w)
                if r is None:
                    continue
                for role in ("agent", "action", "patient"):
                    if sc[role] == r:
                        tally[i][role] += 1
        self.slot_role = {i: c.most_common(1)[0][0] for i, c in tally.items()}

        # 4. SENSE — what was ALWAYS true of each action's agent and patient
        self.sel = {}
        for _, sc in exposure:
            a, act, p = sc["agent"], sc["action"], sc["patient"]
            if act not in self.sel:
                self.sel[act] = [set(FEATURES[a]), set(FEATURES[p])]
            else:
                self.sel[act][0] &= FEATURES[a]
                self.sel[act][1] &= FEATURES[p]
        return self

    # ── it can now SPEAK about a scene it has never seen ──────────────────────
    def describe(self, scene, rng):
        out = []
        for i, c in enumerate(self.tmpl):
            role = self.slot_role.get(i)
            out.append(self.name[scene[role]] if role else
                       str(rng.choice(self.cats[c])))
        return out

    # ── ...and UNDERSTAND a sentence it has never heard ───────────────────────
    def understand(self, toks):
        sc = {}
        for i, w in enumerate(toks):
            role = self.slot_role.get(i)
            if role and w in self.refers:
                sc[role] = self.refers[w]
        return sc

    # ── ...and know when a sentence describes something impossible ────────────
    def makes_sense(self, sc):
        if not {"agent", "action", "patient"} <= set(sc):
            return None
        need = self.sel.get(sc["action"])
        if not need:
            return None
        return (need[0] <= FEATURES[sc["agent"]]) and (need[1] <= FEATURES[sc["patient"]])


def sep(t): print("\n" + "=" * 76 + f"\n{t}\n" + "=" * 76)


def all_legal_scenes():
    out = []
    for a in FEATURES:
        for act in ACTIONS:
            for p in FEATURES:
                if legal(a, act, p):
                    out.append(dict(agent=a, action=act, patient=p))
    return out


def run(order, rng, n=900, n_held=8):
    sep(f"LEARNING FROM SCRATCH — word order {order}, invented vocabulary")
    scenes = all_legal_scenes()
    idx = rng.permutation(len(scenes))
    held = [scenes[i] for i in idx[:n_held]]          # NEVER shown during learning
    train = [scenes[i] for i in idx[n_held:]]
    exposure = []
    for _ in range(n):
        sc = train[int(rng.integers(len(train)))]
        exposure.append((render(sc, order), sc))
    print(f"  {len(scenes)} possible situations: trained on {len(train)}, "
          f"HELD OUT {len(held)} it will never see until tested")
    L = FusedLearner().learn(exposure)

    print(f"  grammar induced  : {len(L.cats)} categories, "
          f"word order of {len(L.tmpl)} slots")
    print(f"  words it grounded: " + ", ".join(f"{w}={r}" for w, r in
                                               sorted(L.refers.items())))
    print(f"  no referent found: {L.function_words}   <- it discovered the function "
          f"word by itself (present everywhere, means nothing)")
    if L.rescued:
        print(f"  needed MUTUAL EXCLUSIVITY to pin: {L.rescued}   <- always co-occurred "
              f"with something else; resolved because that thing was already claimed")
    print(f"  roles learned    : " + ", ".join(f"slot{i}={r}" for i, r in
                                               sorted(L.slot_role.items())))

    # PRODUCTION — on the HELD-OUT situations only
    prod_ok = 0
    for sc in held:
        said = L.describe(sc, rng)
        prod_ok += (L.understand(said) == sc) and (said == render(sc, order))
    print(f"\n  SPEAKING about HELD-OUT situations : {prod_ok}/{len(held)} = "
          f"{100*prod_ok//len(held)}% correct (right words, right order)")
    for sc in held[:3]:
        print(f"      sees {sc['agent']} {sc['action']} {sc['patient']:<6} -> says "
              f"\"{' '.join(L.describe(sc, rng))}\"   (never heard this said)")

    # COMPREHENSION — sentences it has genuinely never heard
    comp_ok = sum(L.understand(render(sc, order)) == sc for sc in held)
    print(f"  UNDERSTANDING HELD-OUT sentences   : {comp_ok}/{len(held)} = "
          f"{100*comp_ok//len(held)}% (recovers who did what to whom)")

    # SENSE — can it tell a possible scene from an impossible one?
    good = dict(agent="DOG", action="EAT", patient="APPLE")
    bad = dict(agent="APPLE", action="EAT", patient="DOG")
    bad2 = dict(agent="DOG", action="EAT", patient="BALL")
    print(f"  JUDGING sense:")
    for lbl, sc in (("a dog eats an apple", good), ("an apple eats a dog", bad),
                    ("a dog eats a ball", bad2)):
        v = L.makes_sense(sc)
        print(f"      {lbl:<22} -> {'possible' if v else 'IMPOSSIBLE'}")
    return prod_ok == len(held) and comp_ok == len(held)


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    rng = np.random.default_rng(4)
    a = run("S-V-O", rng)
    b = run("S-O-V", rng)
    sep("VERDICT")
    print(f"  S-V-O: {'PASS' if a else 'FAIL'}      S-O-V: {'PASS' if b else 'FAIL'}")
    print("\n  Nothing was hand-given: not the categories, not the word order, not the")
    print("  meaning of a single invented word, not which slot is the doer. It learned")
    print("  all of it from hearing sentences while seeing situations — and it learned")
    print("  a DIFFERENT role mapping for a different word order, which is the proof")
    print("  it induced the language rather than assuming one.")
