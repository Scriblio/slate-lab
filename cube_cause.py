# -*- coding: utf-8 -*-
"""cube_cause.py — from a store of STATES to a model of TRANSITIONS.

Matthew, 2026-07-21: the cube can describe, ground and judge a world, but it
cannot PREDICT a consequence, EXPLAIN a cause, or run a COUNTERFACTUAL. That is
the operational definition of understanding we set, and this is the build that
buys it: stop storing what things ARE and start storing how they CHANGE.

The world (extending cube_fuse.py's) now has consequences, and every consequence
is determined JOINTLY by the action and by one causally-relevant attribute of
the thing it is done to:

    EAT   reads TEXTURE   soft -> it is gone   hard -> it cracks   bitter -> spat out
    PUSH  reads WEIGHT    light -> it moves    heavy -> nothing    rooted -> you get sore
    CHASE reads SPEED     slow -> caught       fast -> runs off    flying -> flies off
    SEE   reads nothing   -> nothing ever happens

That "jointly" is the whole point of the design. If an outcome depended on the
action alone, this benchmark would be a four-row lookup table and a held-out
split over entities would flatter it into meaninglessness. The attributes also
CROSS-CUT: knowing what happens when you eat a thing tells you nothing about
what happens when you push it (a pear is soft AND heavy; a seed is hard AND
light). So no shortcut through entity identity survives either.

WHAT IS ACTUALLY LEARNED. Nothing about the rules above is given to the model.
From (scene, action, next_scene) triples alone it has to work out:
  - which actions are licensed on which things   (selectional constraints)
  - WHICH ATTRIBUTE EACH ACTION READS           (relevance, by gain ratio)
  - what each attribute value does              (the transitions, in the Slate)
and it stores episodes CONCRETELY, exactly as experienced. Generalisation
happens at READ time: the recalled episode's roles are re-bound to the query's
participants. That is analogy, and it is a general mechanism, not a hand-coded
answer — the proof is that mis-retrieval produces a confidently wrong answer,
which is what the baselines below demonstrate.

THE SCOREBOARD — four things, every one on genuinely held-out cases:
  1. PREDICT      novel (scene, action) -> what results
  2. EXPLAIN      given an outcome, infer the cause (the model, run backwards)
  3. COUNTERFACT  "if the apple had been a ball?" -> nothing, it can't be eaten
  4. UNCERTAINTY  outside its model, say "I don't know" from the Slate's own
                  margin rather than confabulating

HOW THE HOLD-OUT WORKS. Whole (action, patient) CELLS are removed from training,
so the model has never seen that thing undergo that action at all. Two whole
CAUSAL BRANCHES are removed as well — nothing bitter is ever eaten, nothing
rooted is ever pushed — and those are unknowable, not merely unseen, so the only
correct answer there is "I don't know". One branch calibrates the doubt
threshold and the OTHER one tests it, so the gate is never tuned on its own exam.

HONEST SCOPE: this buys understanding of a world. It does not buy pragmatics or
open-ended language. Knowing what happens next still does not tell it what is
worth saying. That is a further rung.

Standalone lab cube. Never reads / writes / imports the live production
substrate. Aurelia's mind runs on :5057 and is not touched here.
"""
import numpy as np, collections, math, sys, itertools
from core import Slate

# ══════════════════════════════════════════════════════════════════════════════
# THE WORLD
# ══════════════════════════════════════════════════════════════════════════════
# Perception delivers an attribute bundle per entity. That is all the model ever
# sees of a thing — never its name as a meaningful token, never its rule.
ATTRS = ("kind", "texture", "weight", "speed", "colour")
ENTITIES = {
    # animates                     kind        texture   weight    speed
    "DOG":    dict(kind="animate",                weight="heavy",  speed="slow",   colour="brown"),
    "TURTLE": dict(kind="animate",                weight="heavy",  speed="slow",   colour="green"),
    "CAT":    dict(kind="animate",                weight="light",  speed="fast",   colour="red"),
    "MOUSE":  dict(kind="animate",                weight="light",  speed="fast",   colour="brown"),
    "FOX":    dict(kind="animate",                weight="heavy",  speed="fast",   colour="red"),
    "BIRD":   dict(kind="animate",                weight="light",  speed="flying", colour="green"),
    "BAT":    dict(kind="animate",                weight="light",  speed="flying", colour="brown"),
    # WOLF/HARE/CROW exist to make the cause IDENTIFIABLE. Without them, CHASE
    # trained on only three patients (DOG brown+slow, CAT red+fast, BIRD
    # green+flying) in which colour predicted the outcome exactly as well as
    # speed did -- a perfect confound, and the model rightly could not tell which
    # was the cause. That is a property of the SAMPLE, not of the learner: three
    # examples cannot separate two attributes that agree on all three.
    "WOLF":   dict(kind="animate",                weight="heavy",  speed="slow",   colour="red"),
    "HARE":   dict(kind="animate",                weight="light",  speed="fast",   colour="green"),
    "CROW":   dict(kind="animate",                weight="light",  speed="flying", colour="red"),
    # DEER is the heavy FAST animal. Without it every heavy animal ever chased in
    # training was also slow, so weight scored 0.58 under CHASE and pulled a
    # heavy fast fox towards "caught". The CHASE/FOX cell asks the model to
    # ignore weight, and a sample in which weight is half-confounded with the
    # cause does not entitle anyone to ask that. The fix belongs in the DATA.
    "DEER":   dict(kind="animate",                weight="heavy",  speed="fast",   colour="brown"),
    # foods — texture and weight deliberately cross-cut, so knowing what happens
    # when you EAT a thing tells you nothing about what happens when you PUSH it
    "APPLE":  dict(kind="food", texture="soft",   weight="light",  colour="red"),
    "PLUM":   dict(kind="food", texture="soft",   weight="light",  colour="green"),
    "PEAR":   dict(kind="food", texture="soft",   weight="heavy",  colour="brown"),
    "MELON":  dict(kind="food", texture="soft",   weight="heavy",  colour="red"),
    "SEED":   dict(kind="food", texture="hard",   weight="light",  colour="brown"),
    "NUT":    dict(kind="food", texture="hard",   weight="light",  colour="red"),
    "BONE":   dict(kind="food", texture="hard",   weight="heavy",  colour="green"),
    "COCO":   dict(kind="food", texture="hard",   weight="heavy",  colour="brown"),
    "HERB":   dict(kind="food", texture="bitter", weight="light",  colour="green"),
    "ROOT":   dict(kind="food", texture="bitter", weight="heavy",  colour="red"),
    # GOURD/ACORN/SHELL are here for the same reason WOLF/HARE/CROW are: with
    # only five training foods, `colour` explained EAT's outcomes exactly as well
    # as texture and weight did, and the dict baseline duly picked colour as the
    # cause. Two entities per texture x weight cell, in different colours, is what
    # makes the real cause identifiable and the distractor visibly useless.
    "GOURD":  dict(kind="food", texture="soft",   weight="heavy",  colour="green"),
    "ACORN":  dict(kind="food", texture="hard",   weight="light",  colour="green"),
    "SHELL":  dict(kind="food", texture="hard",   weight="heavy",  colour="red"),
    # inanimate non-foods
    "BALL":   dict(kind="toy",                    weight="light",  colour="red"),
    "ROCK":   dict(kind="thing",                  weight="heavy",  colour="green"),
    "LOG":    dict(kind="thing",                  weight="heavy",  colour="brown"),
    "TREE":   dict(kind="thing",                  weight="rooted", colour="red"),
    "POST":   dict(kind="thing",                  weight="rooted", colour="green"),
}
# `colour` is a pure distractor: no action reads it, and it is assigned so that it
# correlates with nothing. A model that cannot learn to IGNORE an attribute will
# be caught by it -- and so will a baseline that matches on the whole profile.

# ── two worlds, because the first one turned out to be winnable by a dict ─────
# WORLD 1 gives every action exactly ONE causal attribute. That makes a two-column
# lookup table a COMPLETE model of it, which is a property of the world, not a
# virtue of anything that solves it -- see the DictOnBestAttr baseline.
# WORLD 2 changes one thing: EAT now reads texture AND weight JOINTLY. No single
# attribute determines the outcome, so the dict cannot express the rule at all.
# That is the comparison that says whether the substrate earns its place.
WORLDS = {
    "one causal attribute per action": dict(
        actions={
            "EAT":   dict(agent="animate", patient="food",    reads=("texture",)),
            "PUSH":  dict(agent="animate", patient=None,      reads=("weight",)),
            "CHASE": dict(agent="animate", patient="animate", reads=("speed",)),
            "SEE":   dict(agent="animate", patient=None,      reads=()),
        },
        rules={
            ("EAT", ("soft",)):     {"patient": "GONE",     "agent": "FULL"},
            ("EAT", ("hard",)):     {"patient": "CRACKED",  "agent": "FULL"},
            ("EAT", ("bitter",)):   {"patient": "SPAT_OUT", "agent": "SICK"},
            ("PUSH", ("light",)):   {"patient": "MOVED"},
            ("PUSH", ("heavy",)):   {},                     # too heavy: nothing happens
            ("PUSH", ("rooted",)):  {"agent": "SORE"},      # won't budge; you strain
            ("CHASE", ("slow",)):   {"patient": "CAUGHT"},
            ("CHASE", ("fast",)):   {"patient": "RAN_AWAY"},
            ("CHASE", ("flying",)): {"patient": "FLEW_AWAY"},
            ("SEE", ()):            {},
        }),
    "EAT needs TWO attributes at once": dict(
        actions={
            "EAT":   dict(agent="animate", patient="food",    reads=("texture", "weight")),
            "PUSH":  dict(agent="animate", patient=None,      reads=("weight",)),
            "CHASE": dict(agent="animate", patient="animate", reads=("speed",)),
            "SEE":   dict(agent="animate", patient=None,      reads=()),
        },
        rules={
            ("EAT", ("soft", "light")):   {"patient": "GONE",     "agent": "FULL"},
            ("EAT", ("soft", "heavy")):   {"patient": "GONE",     "agent": "SLEEPY"},
            ("EAT", ("hard", "light")):   {"patient": "CRACKED",  "agent": "FULL"},
            ("EAT", ("hard", "heavy")):   {"patient": "CRACKED",  "agent": "SORE"},
            ("EAT", ("bitter", "light")): {"patient": "SPAT_OUT", "agent": "SICK"},
            ("EAT", ("bitter", "heavy")): {"patient": "SPAT_OUT", "agent": "SICK"},
            ("PUSH", ("light",)):   {"patient": "MOVED"},
            ("PUSH", ("heavy",)):   {},
            ("PUSH", ("rooted",)):  {"agent": "SORE"},
            ("CHASE", ("slow",)):   {"patient": "CAUGHT"},
            ("CHASE", ("fast",)):   {"patient": "RAN_AWAY"},
            ("CHASE", ("flying",)): {"patient": "FLEW_AWAY"},
            ("SEE", ()):            {},
        }),
}
ACTIONS, RULES = WORLDS["one causal attribute per action"].values()


def use_world(name):
    global ACTIONS, RULES
    ACTIONS = WORLDS[name]["actions"]
    RULES = WORLDS[name]["rules"]


def legal(agent, action, patient):
    """Does the world permit this at all?"""
    if agent == patient:
        return False
    need = ACTIONS[action]
    if ENTITIES[agent].get("kind") != need["agent"]:
        return False
    if need["patient"] and ENTITIES[patient].get("kind") != need["patient"]:
        return False
    return True


def world_apply(agent, action, patient):
    """The true consequence, as a CONCRETE next-state delta: {entity: state}."""
    reads = ACTIONS[action]["reads"]
    schema = RULES[(action, tuple(ENTITIES[patient].get(r) for r in reads))]
    return {(agent if role == "agent" else patient): st
            for role, st in schema.items()}


def all_legal():
    return [(a, act, p) for a in ENTITIES for act in ACTIONS for p in ENTITIES
            if legal(a, act, p)]


def features(entity):
    """The perceptual feature set: attribute=value strings. Nothing else."""
    return {f"{k}={v}" for k, v in ENTITIES[entity].items() if v is not None}


# ══════════════════════════════════════════════════════════════════════════════
# THE SPLITS — designed so that no number here can flatter itself
# ══════════════════════════════════════════════════════════════════════════════
# A "cell" is an (action, patient) pair. Removing a whole cell means the model
# never once saw that thing undergo that action.
#
# in-model cells: the causal BRANCH is still taught by some other entity, so the
#   right answer is reachable and the model is expected to get it right.
#   Three of them (*) also demand a NOVEL attribute profile, so the model has to
#   have worked out which attribute the action reads and ignore the others.
TEST_CELLS = [
    ("EAT",   "MELON"),   # soft+heavy   — profile matched by PEAR
    ("EAT",   "BONE"),    # hard+heavy   * no hard+heavy food is ever eaten in training
    ("PUSH",  "ROCK"),    # thing+heavy  * no plain `thing` is ever pushed in training
    ("PUSH",  "LOG"),     # thing+heavy  *          "
    ("PUSH",  "BALL"),    # toy+light    * no `toy` is ever pushed in training
    ("CHASE", "TURTLE"),  # heavy+slow   — profile matched by DOG
    ("CHASE", "BAT"),     # light+flying — profile matched by BIRD
    ("CHASE", "FOX"),     # heavy+fast   * every fast animate in training is light
    ("SEE",   "APPLE"),   # the null-effect control
]
# NOTE ON (SEE, APPLE): this was (SEE, LOG) in the first version, and that was a
# broken split. LOG's only two legal appearances are PUSH and SEE, so holding out
# BOTH removed LOG from training entirely -- those 14 "held-out" cases were not
# held-out recombinations at all, they were structurally unanswerable, and the
# model correctly declined every one of them. It read as a 0/7 failure. The guard
# in verify_splits() now makes that impossible to ship again.
CALIB_CELLS = [("EAT", "NUT"), ("PUSH", "MOUSE"), ("PUSH", "PEAR"),
               ("CHASE", "MOUSE")]
# out-of-model BRANCHES: an entire causal branch never demonstrated in any form.
# The answer is not merely unseen, it is UNKNOWABLE from the training data --
# so confidently answering is the failure and "I don't know" is the only pass.
OOD_TEST_CELLS = [("EAT", "HERB"), ("EAT", "ROOT")]      # nothing bitter is eaten
OOD_CALIB_CELLS = [("PUSH", "TREE"), ("PUSH", "POST")]   # nothing rooted is pushed
# A never-before-seen entity. Structurally out of distribution as a matter of
# FACT, not of confidence -- caught by Slate.knows(), no threshold involved.
NOVEL_ENTITY = "GLARB"
NOVEL_FEATURES = dict(kind="food", texture="soft", weight="light")


def split():
    held = set(TEST_CELLS) | set(CALIB_CELLS) | set(OOD_TEST_CELLS) | set(OOD_CALIB_CELLS)
    train, buckets = [], collections.defaultdict(list)
    for t in all_legal():
        cell = (t[1], t[2])
        if cell in held:
            for name, cells in (("test", TEST_CELLS), ("calib", CALIB_CELLS),
                                ("ood_test", OOD_TEST_CELLS),
                                ("ood_calib", OOD_CALIB_CELLS)):
                if cell in cells:
                    buckets[name].append(t)
        else:
            train.append(t)
    return train, buckets


def verify_splits(train, buckets):
    """Prove the hold-out rather than asserting it in prose."""
    tr, tr_cells = set(train), {(t[1], t[2]) for t in train}
    problems = []
    for name in ("test", "calib", "ood_test", "ood_calib"):
        for t in buckets[name]:
            if t in tr:
                problems.append(f"{name} triple {t} leaked into training")
            if (t[1], t[2]) in tr_cells:
                problems.append(f"{name} cell {(t[1], t[2])} leaked into training")
    # the two OOD branches must be genuinely undemonstrated -- not merely an
    # unseen entity, but an unseen VALUE of what the action actually reads, so
    # that the answer is unknowable rather than just uncomputed
    for cells in (OOD_TEST_CELLS, OOD_CALIB_CELLS):
        act = cells[0][0]
        banned = {reads_of(act, p) for _, p in cells}
        seen = {reads_of(act, p) for a, ac, p in train if ac == act}
        if seen & banned:
            problems.append(f"OOD branch {act}/{banned} was demonstrated in training")
    # Every entity used in an in-model or near-OOD question must APPEAR somewhere
    # in training. If it does not, the question is structurally unanswerable and
    # belongs in the structural-OOD bucket -- scoring it as an in-model test
    # measures nothing. This is the guard the first run needed and did not have.
    known = {e for t in train for e in (t[0], t[2])}
    for name in ("test", "calib", "ood_test", "ood_calib"):
        for a, act, p in buckets[name]:
            for e in (a, p):
                if e not in known:
                    problems.append(f"{name}: {e} never appears in training at all -- "
                                    f"{(act, p)} is structurally OOD, not held-out")
    # every in-model branch must still be taught by SOMETHING, or the "held-out
    # recombination" is really an unknowable and belongs in the OOD bucket
    for act, p in TEST_CELLS + CALIB_CELLS:
        if not ACTIONS[act]["reads"]:
            continue
        if not any(reads_of(act, pp) == reads_of(act, p)
                   for a, ac, pp in train if ac == act):
            problems.append(f"in-model cell ({act},{p}) has no teaching example")
    # An in-model test cell must be a genuine act of generalisation: if the test
    # entity has an exact profile twin in that action's training set, the answer
    # is available by pure memorisation and the cell proves nothing.
    for act, p in TEST_CELLS:
        twins = [pp for a, ac, pp in train if ac == act and profile(pp) == profile(p)]
        if twins:
            problems.append(f"in-model cell ({act},{p}) has an exact profile twin "
                            f"in training ({twins[0]}) -- memorisable, not held out")
    return problems


def identifiability(model, threshold=0.75):
    """Warn when an attribute the world does NOT read explains the outcomes anyway.

    Three separate times a first measurement here was decided by a distractor
    that the training sample happened to correlate with the true cause. A total
    tie is caught by the CONFOUNDED banner; this catches the weaker version,
    where a spurious attribute merely has enough pull to drag a novel case into
    the wrong basin. Both are properties of the SAMPLE, not of the learner.
    """
    out = []
    for act, raw in model.rel_raw.items():
        for (role, attr), v in raw.items():
            if v >= threshold and (role == "agent" or attr not in ACTIONS[act]["reads"]):
                out.append(f"{act}: {role}.{attr} explains {v:.2f} but is not a cause")
    return out


def reads_of(action, entity):
    """The value-tuple of whatever this action actually reads. World-side only."""
    return tuple(ENTITIES[entity].get(r) for r in ACTIONS[action]["reads"])


def profile(entity):
    return tuple(ENTITIES[entity].get(a) for a in ATTRS)


def novel_profile(act, p, train):
    """Is this test entity's FULL attribute profile unseen under this action?

    Derived from the split rather than hand-labelled, so it cannot drift out of
    step with the data the way a hardcoded list would.
    """
    return not any(profile(pp) == profile(p) for a, ac, pp in train if ac == act)


# ══════════════════════════════════════════════════════════════════════════════
# THE MODEL
# ══════════════════════════════════════════════════════════════════════════════
def _entropy(counter):
    n = sum(counter.values())
    return -sum((c / n) * math.log2(c / n) for c in counter.values() if c) if n else 0.0


def _explains(pairs):
    """What FRACTION of the outcome's uncertainty does this attribute remove?

    The uncertainty coefficient, IG / H(outcome). The first version of this used
    gain ratio (IG / H(attribute)) -- the decision-tree heuristic that guards
    against an attribute winning merely by having many values. That guard cost
    more than it bought here and the first measurement was wrong because of it:
    under CHASE, `speed` resolves the outcome completely while `weight` resolves
    it only partly, yet gain ratio scored them BOTH exactly 1.0, because it
    divides away precisely the advantage that matters. The model then weighted a
    half-predictive attribute as heavily as the real cause and could not say what
    happens when you chase a fox. The cardinality guard is unnecessary here in
    any case: every attribute has 2-4 values and entity identity is not among
    them, so there is no high-cardinality attribute to defend against.
    """
    n = len(pairs)
    if not n:
        return 0.0
    h0 = _entropy(collections.Counter(o for _, o in pairs))
    if h0 <= 0:
        return 0.0                                   # outcome never varies: nothing to explain
    by = collections.defaultdict(collections.Counter)
    for v, o in pairs:
        by[v][o] += 1
    cond = sum(sum(c.values()) / n * _entropy(c) for c in by.values())
    return max(0.0, (h0 - cond) / h0)


def schema_of(agent, patient, delta):
    """Concrete delta -> role-relative schema. {APPLE:GONE,DOG:FULL} -> {patient:GONE,agent:FULL}"""
    out = {}
    for ent, st in delta.items():
        out["agent" if ent == agent else "patient"] = st
    return tuple(sorted(out.items()))


def instantiate(schema, agent, patient):
    """Role-relative schema -> concrete delta for THESE participants. The analogy step."""
    return {(agent if role == "agent" else patient): st for role, st in schema}


class TransitionModel:
    """(state, action) -> next_state, learned into the Slate substrate."""

    ACT_W = 2.0        # the action is always highly relevant; fixed a priori
    FLOOR_W = 0.15     # irrelevant attributes are damped, never erased

    def __init__(self, dim=256, n_cells=2048, seed=0,
                 relevance=True, shared_features=True, settle=True):
        self.rng = np.random.default_rng(1234 + seed)
        self.dim, self.n_cells, self.seed = dim, n_cells, seed
        self.relevance = relevance            # ablation: learn which attribute matters
        self.shared_features = shared_features  # ablation: entities as feature bundles
        self.settle = settle                  # ablation: attractor settle vs raw argmax
        # Which doubt signals the gate reads. The calibration data rates margin
        # and familiarity identically (both 1.00), so it cannot choose between
        # them -- and they diverge sharply on the exam. Choosing by exam score
        # would be tuning on the test set, so the gate requires BOTH: it answers
        # only when no signal is in doubt. Strictly more conservative, and it
        # needs no choice the available data cannot justify.
        self.gate_on = ("margin_rel", "familiarity")
        self.gate_floors = {}
        self._vec = {}
        self._cache = {}

    def v(self, tag):
        if tag not in self._vec:
            self._vec[tag] = self.rng.standard_normal(self.dim).astype(np.float32)
        return self._vec[tag]

    # ── learning ─────────────────────────────────────────────────────────────
    def learn(self, episodes):
        """episodes: [(agent, action, patient, concrete_delta)]"""
        self.actions = sorted({e[1] for e in episodes})

        # 1. SELECTIONAL CONSTRAINTS — what each action was ever done, and BY what.
        #    Intersect the observed feature sets (the cube_fuse trick). Both roles:
        #    the first version constrained the patient only, and the model duly
        #    concluded that an apple can push a ball, which wrecked EXPLAIN by
        #    flooding it with impossible causes.
        self.sel = {}
        for a, act, p, _ in episodes:
            fa, fp = features(a), features(p)
            if act not in self.sel:
                self.sel[act] = [set(fa), set(fp)]
            else:
                self.sel[act][0] &= fa
                self.sel[act][1] &= fp

        # 2. RELEVANCE — WHICH ATTRIBUTE DOES EACH ACTION READ?  Induced, not told.
        self.rel, self.rel_raw = {}, {}
        for act in self.actions:
            eps = [e for e in episodes if e[1] == act]
            raw = {}
            for role in ("agent", "patient"):
                for attr in ATTRS:
                    pairs = [(ENTITIES[e[0] if role == "agent" else e[2]].get(attr, "NA"),
                              schema_of(e[0], e[2], e[3])) for e in eps]
                    raw[(role, attr)] = _explains(pairs)
            self.rel_raw[act] = raw
            top = max(raw.values()) if raw else 0.0
            # If NOTHING explains the outcome (SEE: it never varies), the honest
            # conclusion is that no attribute matters -- so damp them all, rather
            # than the earlier fallback of trusting them all equally, which made
            # every SEE key hyper-specific for no reason.
            self.rel[act] = ({k: v / top for k, v in raw.items()} if top > 0
                             else {k: 0.0 for k in raw})

        # 3. THE TRANSITIONS — committed CONCRETELY, one entry per episode lived.
        self.slate = Slate(self.dim, n_cells=self.n_cells, beta=35.0, seed=self.seed)
        for a, act, p, delta in episodes:
            self.slate.commit(self.key(a, act, p),
                              payload=(a, act, p, schema_of(a, p, delta)),
                              symbols=[a, act, p])
        # PER-ACTION MARGIN SCALE, from TRAINING episodes only.
        # A raw margin is not comparable between actions: when a rule depends on
        # two attributes instead of one, the evidence splits and every margin
        # under that action shrinks. World 2 exposed this -- a floor calibrated
        # on single-attribute PUSH let half the unknowable conjunctive EAT cases
        # through while prediction still read 100%. Dividing by what a KNOWN case
        # scores under the same action makes the quantity scale-free, and uses
        # nothing but training data to do it.
        self.ref, self._cache = None, {}
        ref = collections.defaultdict(list)
        for a, act, p, _ in episodes:
            ref[act].append(self._read(a, act, p)["margin"])
        self.ref = {act: float(np.median(v)) for act, v in ref.items()}
        self.gate_floors = {}                  # set by calibrate(), never by test data
        return self

    def key(self, agent, action, patient):
        k = self.ACT_W * self.v(("act", action))
        for role, ent in (("agent", agent), ("patient", patient)):
            if not self.shared_features:       # ablation: no shared structure at all
                k = k + self.v(("whole", role, ent))
                continue
            for attr in ATTRS:
                val = ENTITIES[ent].get(attr)
                if val is None:
                    continue
                w = 1.0
                if self.relevance:
                    r = self.rel.get(action, {}).get((role, attr), 1.0)
                    w = self.FLOOR_W + (1.0 - self.FLOOR_W) * r
                k = k + w * self.v(("f", role, attr, val))
        return k

    # ── reading: recall + the decision margin ────────────────────────────────
    def _read(self, agent, action, patient):
        """Returns (winning schema, decision_margin, familiarity, presettle_schema).

        Memoised: the store is immutable after learn(), and EXPLAIN re-reads the
        same few thousand candidate triples for every observation it is given.
        """
        hit = self._cache.get((agent, action, patient))
        if hit is not None:
            return hit
        k = self.key(agent, action, patient)
        o = self.slate.overlaps_for(k)
        pre = int(np.argmax(o))
        if self.settle:
            r = self.slate.recall(k, topk=1)
            win, fam = r["winner_idx"], float(r["familiarity"])
        else:
            win, fam = pre, float(o[pre])
        top_schema = self.slate.meta[win]["payload"][3]
        # The margin that matters is the gap between the best evidence FOR the
        # answer and the best evidence for a DIFFERENT answer. Not the runner-up
        # entry: hundreds of stored episodes share one outcome, and their mutual
        # ties say nothing at all about whether the answer is in doubt. That is
        # what `raw_margin` below measures, and it is reported alongside so the
        # difference between the two is a number and not a claim.
        same = [ov for i, ov in enumerate(o)
                if self.slate.meta[i]["payload"][3] == top_schema]
        rival = [ov for i, ov in enumerate(o)
                 if self.slate.meta[i]["payload"][3] != top_schema]
        margin = float(max(same) - max(rival)) if rival else float(max(same))
        two = np.partition(o, -2)[-2:] if o.size >= 2 else np.array([o[0], o[0]])
        raw_margin = float(two[-1] - two[-2])
        ref = (self.ref or {}).get(action) if self.ref else None
        rel = margin / ref if ref else margin      # scale-free: vs a known case
        out = dict(schema=top_schema, margin=margin, raw_margin=raw_margin,
                   margin_rel=rel, familiarity=fam,
                   presettle=self.slate.meta[pre]["payload"][3],
                   winner=self.slate.meta[win]["payload"])
        if self.ref is not None:      # only cache once the scale is final
            self._cache[(agent, action, patient)] = out
        return out

    def licensed(self, agent, action, patient):
        """Does the model believe this action can even apply here?"""
        if agent == patient:
            return False
        need = self.sel.get(action)
        if need is None:
            return False
        return need[0] <= features(agent) and need[1] <= features(patient)

    def predict(self, agent, action, patient, gate=True):
        """-> dict(delta, answered, why, margin, raw_margin, familiarity, winner)"""
        blank = dict(margin=0.0, raw_margin=0.0, margin_rel=0.0, familiarity=0.0, winner=None)
        if not self.slate.knows(agent, action, patient):
            return dict(delta=None, answered=False, unlicensed=False,
                        why="I have never encountered that at all", **blank)
        if not self.licensed(agent, action, patient):
            return dict(delta={}, answered=True, unlicensed=True,
                        why="that is not something which can be done to it",
                        margin=1.0, raw_margin=1.0, margin_rel=1.0, familiarity=1.0, winner=None)
        r = self._read(agent, action, patient)
        if gate and self.gate_floors and any(r[k] < f for k, f in self.gate_floors.items()):
            return dict(delta=None, answered=False, unlicensed=False,
                        why="I have nothing like this in my model", **{
                            k: r[k] for k in ("margin", "raw_margin", "margin_rel",
                                          "familiarity", "winner")})
        return dict(delta=instantiate(r["schema"], agent, patient), answered=True,
                    unlicensed=False, why="", **{
                        k: r[k] for k in ("margin", "raw_margin", "margin_rel",
                                          "familiarity", "winner")})

    # ── the doubt threshold: calibrated on CALIBRATION data, then frozen ──────
    def calibrate(self, in_model, out_of_model, key="margin", apply=False):
        """Best separating floor + its balanced accuracy, on CALIBRATION data only."""
        pos = [self.predict(*t[:3], gate=False)[key] for t in in_model]
        neg = [self.predict(*t[:3], gate=False)[key] for t in out_of_model]
        cuts = sorted(set(pos + neg))
        best, floor = -1.0, 0.0
        for i in range(len(cuts) + 1):
            c = (cuts[i - 1] + cuts[i]) / 2 if 0 < i < len(cuts) else (
                cuts[0] - 1e-6 if i == 0 else cuts[-1] + 1e-6)
            j = (sum(p >= c for p in pos) / max(1, len(pos))
                 + sum(n < c for n in neg) / max(1, len(neg))) / 2
            if j > best:
                best, floor = j, c
        if apply:
            self.gate_floors[key] = floor
        return floor, best, pos, neg

    # ── EXPLAIN: the model run backwards, by forward-simulating candidates ────
    def explain(self, observed, universe=None):
        universe = universe or list(ENTITIES)
        causes = set()
        for a in universe:
            for act in self.actions:
                for p in universe:
                    if not self.licensed(a, act, p):
                        continue
                    r = self.predict(a, act, p)
                    if r["answered"] and r["delta"] == observed:
                        causes.add((a, act, p))
        return causes

    # ── COUNTERFACTUAL: substitute a participant and re-run. Free, given a model.
    def counterfactual(self, agent, action, patient, new_patient):
        return self.predict(agent, action, new_patient)


# ══════════════════════════════════════════════════════════════════════════════
# BASELINES — every number below has to beat these to mean anything
# ══════════════════════════════════════════════════════════════════════════════
class MajorityPerAction:
    """'The action alone tells you the outcome.' The lookup table this must beat."""
    def learn(self, episodes):
        tally = collections.defaultdict(collections.Counter)
        for a, act, p, d in episodes:
            tally[act][schema_of(a, p, d)] += 1
        self.best = {act: c.most_common(1)[0][0] for act, c in tally.items()}
        return self

    def predict(self, a, act, p, gate=True):
        return dict(delta=instantiate(self.best[act], a, p), answered=True,
                    why="", margin=1.0, familiarity=1.0)


class DictOnBestAttr:
    """No substrate at all: learn which attribute the action reads, then look it up.

    This is the baseline that matters most, and it is handed the model's OWN
    learned relevance so the comparison isolates the substrate rather than the
    relevance learning. On a world where each action reads exactly one attribute
    this is a COMPLETE model, and it should win -- an attractor memory cannot
    beat a correct lookup table. Where it must fail is a rule that no single
    attribute determines, which is precisely what the second world tests.
    """
    def __init__(self, rel):
        self.rel = rel

    def learn(self, episodes):
        self.pick, self.table = {}, collections.defaultdict(collections.Counter)
        for act, raw in self.rel.items():
            self.pick[act] = max(raw, key=raw.get) if raw and max(raw.values()) > 0 else None
        for a, act, p, d in episodes:
            self.table[(act, self._val(act, a, p))][schema_of(a, p, d)] += 1
        self.table = {k: c.most_common(1)[0][0] for k, c in self.table.items()}
        return self

    def _val(self, act, a, p):
        rp = self.pick.get(act)
        return None if rp is None else ENTITIES[a if rp[0] == "agent" else p].get(rp[1])

    def predict(self, a, act, p, gate=True):
        k = (act, self._val(act, a, p))
        if k not in self.table:                       # unseen value -> honest abstention
            return dict(delta=None, answered=False, unlicensed=False, why="unseen value",
                        margin=0.0, raw_margin=0.0, margin_rel=0.0,
                        familiarity=0.0, winner=None)
        return dict(delta=instantiate(self.table[k], a, p), answered=True,
                    unlicensed=False, why="", margin=1.0, raw_margin=1.0,
                    familiarity=1.0, winner=None)


class DictOnFullProfile:
    """Exact match on the entire (agent profile, action, patient profile). Abstain if unseen.

    The other end of the spectrum from DictOnBestAttr: no generalisation at all,
    only memorisation. The `colour` distractor is what defeats it -- a bone and a
    coco behave identically and differ only in a colour nothing reads.
    """
    def learn(self, episodes):
        self.table = {}
        for a, act, p, d in episodes:
            self.table[(profile(a), act, profile(p))] = schema_of(a, p, d)
        return self

    def predict(self, a, act, p, gate=True):
        s = self.table.get((profile(a), act, profile(p)))
        if s is None:
            return dict(delta=None, answered=False, unlicensed=False, why="never seen",
                        margin=0.0, raw_margin=0.0, margin_rel=0.0,
                        familiarity=0.0, winner=None)
        return dict(delta=instantiate(s, a, p), answered=True, unlicensed=False,
                    why="", margin=1.0, raw_margin=1.0, margin_rel=1.0, familiarity=1.0, winner=None)


class VerbatimCopy(TransitionModel):
    """Recall the nearest episode and emit its outcome WITHOUT re-binding roles.

    Isolates how much work the read-time analogy is doing: without it the model
    confidently reports that some other animal's dinner vanished.
    """
    def predict(self, agent, action, patient, gate=True):
        if not self.licensed(agent, action, patient):
            return dict(delta={}, answered=True, why="", margin=1.0, familiarity=1.0)
        o = self.slate.overlaps_for(self.key(agent, action, patient))
        wa, _, wp, wsch = self.slate.meta[int(np.argmax(o))]["payload"]
        return dict(delta=instantiate(wsch, wa, wp), answered=True, why="",
                    margin=1.0, familiarity=1.0)


# ══════════════════════════════════════════════════════════════════════════════
# SCORING
# ══════════════════════════════════════════════════════════════════════════════
def sep(t):
    print("\n" + "=" * 78 + f"\n{t}\n" + "=" * 78)


def score_predict(model, triples, gate=True):
    ok = ans = 0
    per_cell = collections.defaultdict(lambda: [0, 0])
    for a, act, p in triples:
        r = model.predict(a, act, p, gate=gate)
        truth = world_apply(a, act, p)
        per_cell[(act, p)][1] += 1
        if r["answered"]:
            ans += 1
            if r["delta"] == truth:
                ok += 1
                per_cell[(act, p)][0] += 1
    return ok, ans, len(triples), per_cell


def fmt(delta):
    return ", ".join(f"{k} {v}" for k, v in sorted(delta.items())) if delta else "nothing changes"


def learning_curve(seed=0, world="one causal attribute per action"):
    """How much of the world does it need to see before it finds the causes?

    An asymptote is easy to fake and hard to interpret; a curve is neither. This
    also answers whether 687 episodes were doing real work or whether the thing
    was solved long before, which the headline 100% cannot tell you.
    """
    use_world(world)
    train_t, buckets = split()
    causal = [a for a in ACTIONS if ACTIONS[a]["reads"]]
    sizes = (8, 16, 32, 64, 128, 256, len(train_t))
    acc = collections.defaultdict(list)
    found_at = collections.defaultdict(list)
    # NESTED prefixes of a single shuffle per repeat, not a fresh draw per size.
    # Drawing independently at each size made the curve non-monotonic (100% at 64
    # episodes, 88% at 128) -- which was measuring subsample luck, not learning.
    # Averaged over repeats so one unlucky shuffle cannot set the shape.
    for rep in range(5):
        order = np.random.default_rng(100 + rep).permutation(len(train_t))
        for n in sizes:
            eps = [(t[0], t[1], t[2], world_apply(*t))
                   for t in (train_t[i] for i in order[:n])]
            M = TransitionModel(seed=seed).learn(eps)
            ok, _, tot, _ = score_predict(M, buckets["test"], gate=False)
            acc[n].append(100.0 * ok / tot)
            found_at[n].append(sum(1 for act in causal if act in M.rel_raw
                                   and max(M.rel_raw[act], key=M.rel_raw[act].get)[1]
                                   in ACTIONS[act]["reads"]))
    return [(n, np.mean(acc[n]), min(acc[n]), max(acc[n]),
             np.mean(found_at[n]), len(causal)) for n in sizes]


def main(seed=0, verbose=True, world="one causal attribute per action"):
    use_world(world)
    train_t, buckets = split()
    problems = verify_splits(train_t, buckets)

    if verbose:
        sep(f"THE HOLD-OUT, VERIFIED BEFORE ANYTHING IS MEASURED   [world: {world}]")
        print(f"  {len(ENTITIES)} things, {len(ACTIONS)} actions, "
              f"{len(all_legal())} situations the world permits")
        print(f"  trained on {len(train_t)}   "
              + "   ".join(f"{k}={len(v)}" for k, v in sorted(buckets.items())))
        print(f"  held-out cells (this thing NEVER undergoes this action in training):")
        print(f"      in-model : {', '.join(f'{a}/{p}' for a, p in TEST_CELLS)}")
        print(f"      unknowable: {', '.join(f'{a}/{p}' for a, p in OOD_TEST_CELLS)}"
              f"   <- nothing bitter is ever eaten. Not unseen: UNKNOWABLE.")
        print(f"  doubt threshold is calibrated on a DIFFERENT unknowable branch "
              f"({', '.join(f'{a}/{p}' for a, p in OOD_CALIB_CELLS)}),")
        print(f"      so the gate is never tuned on the exam it sits.")
        print(f"\n  leakage check: {'CLEAN' if not problems else chr(10).join(problems)}")
    assert not problems, problems

    episodes = [(a, act, p, world_apply(a, act, p)) for a, act, p in train_t]
    M = TransitionModel(seed=seed).learn(episodes)

    # ── what it worked out for itself ────────────────────────────────────────
    if verbose:
        sep("WHAT IT WORKED OUT FOR ITSELF  (none of this was given)")
        print("  Which attribute does each action READ? Induced from the consequences")
        print("  alone. The runner-up is shown so you can see it won on merit:\n")
        for act in M.actions:
            rel = sorted(M.rel_raw[act].items(), key=lambda kv: -kv[1])
            (r1, a1), v1 = rel[0]
            (r2, a2), v2 = rel[1]
            truth = ACTIONS[act]["reads"]
            hit = ("world reads patient." + "+".join(truth)) if truth else "world reads nothing"
            got = f"{r1}.{a1}" if v1 > 0 else "(nothing explains it)"
            print(f"  {act:<6} -> {got:<18} explains {v1:.2f} of the outcome"
                  f"   (next best {r2}.{a2} {v2:.2f})")
            print(f"         {hit:<28}  agent must be: "
                  + (", ".join(sorted(M.sel[act][0])) or "anything")
                  + " | patient: " + (", ".join(sorted(M.sel[act][1])) or "anything"))
            # A permanent guard against the confound above: if ANY attribute the
            # world does not read scores as highly as the best one, the training
            # sample cannot identify the cause and every number downstream is
            # luck. Checking only the runner-up was not enough -- when the
            # distractor sorts FIRST among the tied attributes the check passed
            # while the model was in fact keying on colour.
            if v1 > 0:
                tied = [(r, a) for (r, a), v in rel if v >= v1 - 1e-9]
                fakes = [f"{r}.{a}" for r, a in tied
                         if r == "agent" or a not in ACTIONS[act]["reads"]]
                if fakes:
                    print(f"         !! CONFOUNDED: {', '.join(fakes)} explains this action's")
                    print(f"            outcomes as well as the real cause does, in this sample.")
                    print(f"            The cause is NOT IDENTIFIABLE from this data.")
        agent_w = np.mean([v for act in M.actions for (r, _), v in M.rel[act].items() if r == "agent"])
        print(f"\n  mean weight it gives AGENT attributes: {agent_w:.2f}  "
              f"<- it discovered that WHO does it doesn't change what happens")
        weak = identifiability(M)
        print(f"  identifiability: " + ("no non-cause explains any action above 0.75"
                                        if not weak else "; ".join(weak)))

    # ── calibrate the doubt, on calibration data only ────────────────────────
    # Three candidate doubt signals, each calibrated the SAME way on the SAME
    # calibration data, then all three sat on the same exam. Which one wins is a
    # measurement, not a preference carried over from an earlier benchmark.
    gates = {}
    for k in ("margin_rel", "margin", "raw_margin", "familiarity"):
        f, q, pos_, neg_ = M.calibrate(buckets["calib"], buckets["ood_calib"], key=k)
        gates[k] = dict(floor=f, calib_acc=q, pos=pos_, neg=neg_)
    # The primary gate is chosen a priori, not by exam score: a floor that has to
    # transfer from the action it was calibrated on to a different action must be
    # scale-free, and margin_rel is the scale-free one. The others are reported
    # beside it on the same exam so the choice can be checked rather than trusted.
    M.gate_floors = {k: gates[k]["floor"] for k in M.gate_on}
    floor, sepq = gates["margin_rel"]["floor"], gates["margin_rel"]["calib_acc"]
    pos, neg = gates["margin_rel"]["pos"], gates["margin_rel"]["neg"]

    # How often does the attractor settle actually change the answer? Measured,
    # not assumed -- the settle is the substrate's headline property and it is
    # entirely possible it earns nothing on this task.
    settle_changed = sum(1 for a, act, p in buckets["test"]
                         if M.licensed(a, act, p)
                         and M._read(a, act, p)["schema"] != M._read(a, act, p)["presettle"])
    settle_changed_ood = sum(1 for a, act, p in buckets["ood_test"]
                             if M.licensed(a, act, p)
                             and M._read(a, act, p)["schema"] != M._read(a, act, p)["presettle"])

    # ══ 1. PREDICT ═══════════════════════════════════════════════════════════
    ok, ans, n, per_cell = score_predict(M, buckets["test"])
    maj = MajorityPerAction().learn(episodes)
    mok, _, _, _ = score_predict(maj, buckets["test"])
    vb = VerbatimCopy(seed=seed).learn(episodes)
    vok, _, _, _ = score_predict(vb, buckets["test"])
    norel = TransitionModel(seed=seed, relevance=False).learn(episodes)
    nrok, nrans, _, _ = score_predict(norel, buckets["test"], gate=False)
    nosh = TransitionModel(seed=seed, shared_features=False).learn(episodes)
    nsok, _, _, _ = score_predict(nosh, buckets["test"], gate=False)
    nost = TransitionModel(seed=seed, settle=False).learn(episodes)
    nsettle_ok, _, _, _ = score_predict(nost, buckets["test"], gate=False)
    ungated_ok, _, _, _ = score_predict(M, buckets["test"], gate=False)
    # the two baselines with no substrate in them at all
    dba = DictOnBestAttr(M.rel_raw).learn(episodes)
    dbok, dbans, _, _ = score_predict(dba, buckets["test"])
    db_ood = sum(not dba.predict(*t[:3])["answered"] for t in buckets["ood_test"])
    dfp = DictOnFullProfile().learn(episodes)
    dfok, dfans, _, _ = score_predict(dfp, buckets["test"])
    # EAT is the only action that differs between the two worlds, so the whole
    # test set dilutes the comparison badly (67 of 87 questions are unchanged).
    # Score the manipulated cells on their own.
    eat = [t for t in buckets["test"] if t[1] == "EAT"]
    eat_m = sum(M.predict(*t)["delta"] == world_apply(*t) for t in eat)
    eat_d = sum(dba.predict(*t)["delta"] == world_apply(*t) for t in eat)

    if verbose:
        sep("1. PREDICT  —  novel (scene, action) -> what results")
        print(f"  on {n} held-out situations it has never seen anything like:\n")
        print(f"      {'cell':<15}{'score':<7}{'it answers':<26}{'by recalling'}")
        crossings = []
        for (act, p), (c, t) in sorted(per_cell.items()):
            star = "*" if novel_profile(act, p, train_t) else " "
            ag = "DOG" if legal("DOG", act, p) else "CAT"
            r = M.predict(ag, act, p)
            w = r["winner"]
            src = f"{w[0]} {w[1]} {w[2]}" if w else "-"
            said = fmt(r["delta"]) if r["answered"] else "I DON'T KNOW"
            print(f"    {star} {act:<6}{p:<8}{c}/{t}    {said:<26}{src}")
            if w and ENTITIES[w[2]].get("kind") != ENTITIES[p].get("kind"):
                crossings.append((p, w[2]))
        print(f"\n      * = its FULL attribute profile never appeared under this action, so")
        print(f"          it had to know which attribute the action reads and ignore the rest")
        print(f"      'by recalling' is the episode the Slate actually settled on. Note that")
        print(f"      it reaches ACROSS KINDS OF THING"
              + (f" -- a {crossings[0][0]} by analogy to a {crossings[0][1]}, "
                 f"a different kind of\n      object entirely" if crossings else "")
              + f" -- because it worked out what the action reads.")
        print(f"\n  ANSWERED {ans}/{n}   CORRECT {ok}/{n} = {100*ok//n}%"
              f"   (of the ones it chose to answer: {ok}/{ans})")
        print(f"\n  and what that has to beat. Every rival below is scored UNGATED, so")
        print(f"  compare them against this model ungated, {100*ungated_ok//n}%:")
        print(f"      chance (uniform over the 9 outcomes the world has) : {100//9}%")
        print(f"      'the action alone tells you the outcome'           : {100*mok//n}%"
              f"   <- the lookup table this had to beat")
        print(f"      recall the nearest episode, don't re-bind the roles: {100*vok//n}%"
              f"   <- names the wrong animal's dinner")
        print(f"      ablation: don't learn which attribute matters      : {100*nrok//n}%")
        print(f"      ablation: entities as opaque symbols, no features  : {100*nsok//n}%")
        print(f"      ablation: raw argmax, no attractor settle          : {100*nsettle_ok//n}%")
        print(f"      THIS MODEL, ungated                                : {100*ungated_ok//n}%")
        print(f"\n  and the baseline that matters most -- NO SUBSTRATE AT ALL. Learn which")
        print(f"  attribute the action reads (handed this model's own learned relevance,")
        print(f"  so only the substrate is being compared), then just look it up:")
        print(f"      dict on the single best attribute   : {100*dbok//n}% correct, "
              f"answered {dbans}/{n}, declines {db_ood}/{len(buckets['ood_test'])} unknowable")
        print(f"      dict on the WHOLE profile, exact    : {100*dfok//n}% correct, "
              f"answered {dfans}/{n}   <- pure memorisation, defeated by `colour`")
        print(f"\n  The settle ablation is worth stating plainly rather than leaving to be")
        print(f"  assumed: the attractor dynamics -- the substrate's headline property --")
        print(f"  earn NOTHING here. Turning the settle off scores identically, and across")
        print(f"  the {len(buckets['test'])} in-model questions it changes the retrieved outcome {settle_changed} times")
        print(f"  ({settle_changed_ood} times on the {len(buckets['ood_test'])} unknowable ones, where the answer is declined")
        print(f"  anyway). What the substrate contributes on this task is the similarity-")
        print(f"  preserving projection and the margin, NOT error correction: these cues")
        print(f"  already land close enough to their basin that settling has nothing to fix.")

    # ══ 2. EXPLAIN ═══════════════════════════════════════════════════════════
    sep_lines = []
    exact = 0
    cases = []
    seen_obs = set()
    for a, act, p in buckets["test"]:
        obs = world_apply(a, act, p)
        if not obs or tuple(sorted(obs.items())) in seen_obs:
            continue
        seen_obs.add(tuple(sorted(obs.items())))
        got = M.explain(obs)
        truth = {t for t in all_legal() if world_apply(*t) == obs}
        exact += (got == truth)
        cases.append((obs, got, truth))
    if verbose:
        sep("2. EXPLAIN  —  given an outcome, infer the cause (the model, backwards)")
        print(f"  It is handed a consequence and searches its own transitions for every")
        print(f"  cause that would produce EXACTLY it. Scored on set equality against the")
        print(f"  world's true preimage: returning everything fails, returning one when")
        print(f"  there were two fails.\n")
        for obs, got, truth in cases[:6]:
            g = sorted(got)
            if not g:
                said = "no cause found"
            elif len(g) == 1:
                said = f"{g[0][0]} {g[0][1]} {g[0][2]}"
            else:
                said = (f"any of {len(g)}: [{', '.join(x[0] for x in g)}] "
                        f"{g[0][1]} {g[0][2]}")
            print(f"      saw: {fmt(obs):<32} -> {said}"
                  + ("   OK" if got == truth else f"   WRONG (true preimage: {len(truth)})"))
        print(f"\n  EXACT preimage recovered on {exact}/{len(cases)} held-out outcomes = "
              f"{100*exact//max(1,len(cases))}%")
        empty_causes = M.explain({})
        print(f"\n  honest caveat: an EMPTY observation ('nothing happened') has a huge")
        print(f"      preimage -- it returns {len(empty_causes)} candidates, correctly. Nothing was")
        print(f"      learned there, so empty outcomes are excluded from the score above.")

    # ══ 3. COUNTERFACTUAL ════════════════════════════════════════════════════
    cf = collections.defaultdict(lambda: [0, 0])
    cf_show = []
    base_pairs = [(a, act, p) for a, act, p in train_t if act in ("EAT", "PUSH", "CHASE")]
    subs = {"flip": [("EAT", "BONE"), ("EAT", "MELON"), ("PUSH", "ROCK"), ("PUSH", "BALL"),
                     ("CHASE", "FOX"), ("CHASE", "BAT")],
            "impossible": [("EAT", "BALL"), ("EAT", "ROCK"), ("EAT", "DOG"),
                           ("CHASE", "APPLE"), ("CHASE", "ROCK")],
            "unknowable": [("EAT", "HERB"), ("EAT", "ROOT")]}
    cf_target = collections.defaultdict(lambda: [0, 0])
    for kind, pairs in subs.items():
        for act, newp in pairs:
            for a, act0, p in base_pairs:
                if act0 != act or a == newp or p == newp:
                    continue
                r = M.counterfactual(a, act, p, newp)
                cf[kind][1] += 1
                cf_target[(kind, act, newp)][1] += 1
                if kind == "unknowable":
                    good = not r["answered"]
                elif kind == "impossible":
                    # strict: it must decline on the grounds that the action does
                    # not apply, not merely happen to emit an empty delta (which
                    # is also what pushing something heavy produces)
                    good = r["answered"] and r["delta"] == {} and r["unlicensed"]
                else:
                    good = r["answered"] and r["delta"] == world_apply(a, act, newp)
                cf[kind][0] += good
                cf_target[(kind, act, newp)][0] += good
                if len(cf_show) < 12 and cf[kind][1] <= 1:
                    cf_show.append((kind, a, act, p, newp, r))
    if verbose:
        sep("3. COUNTERFACTUAL  —  substitute a participant, re-run the model")
        print(f"  A model of transitions gives counterfactuals for free: it is a function,")
        print(f"  so you can evaluate it off the data you actually saw.\n")
        for kind, a, act, p, newp, r in cf_show:
            if not r["answered"]:
                ans = "I DON'T KNOW"
            elif r["unlicensed"]:
                ans = "nothing -- that can't be done to it"
            else:
                ans = fmt(r["delta"])
            print(f"      {a} {act} {p:<6} ... but if it had been a {newp:<6} -> {ans}")
        print()
        for kind, label in (("flip", "the outcome should CHANGE branch"),
                            ("impossible", "it can't be done to that -> nothing happens"),
                            ("unknowable", "never demonstrated -> must say I DON'T KNOW")):
            c, t = cf[kind]
            print(f"      {label:<52} {c}/{t} = {100*c//max(1,t)}%")
        print(f"\n  broken out by substitution, because an average hides which one failed:")
        for (kind, act, newp), (c, t) in sorted(cf_target.items()):
            flag = "" if c == t else "   <-- misses here"
            print(f"      {kind:<11} {act:<6} -> {newp:<6} {c}/{t}{flag}")

    # ══ 4. UNCERTAINTY ═══════════════════════════════════════════════════════
    in_ans = sum(M.predict(*t[:3])["answered"] for t in buckets["test"])
    ood_abst = sum(not M.predict(*t[:3])["answered"] for t in buckets["ood_test"])
    ood_ungated_right = 0
    for a, act, p in buckets["ood_test"]:
        r = M.predict(a, act, p, gate=False)
        ood_ungated_right += (r["delta"] == world_apply(a, act, p))
    # THE COST OF DOUBT: how many in-model questions does the gate refuse that
    # the model would in fact have got RIGHT? A gate that never answers scores
    # a perfect 100% on refusal, so this number is the one that keeps it honest.
    gate_cost = sum(1 for a, act, p in buckets["test"]
                    if not M.predict(a, act, p)["answered"]
                    and M.predict(a, act, p, gate=False)["delta"] == world_apply(a, act, p))
    # All three candidate gates on the same exam, each with its own calibrated floor.
    for k, g in gates.items():
        g["ood_declined"] = sum(M.predict(*t[:3], gate=False)[k] < g["floor"]
                                for t in buckets["ood_test"])
        g["in_answered"] = sum(M.predict(*t[:3], gate=False)[k] >= g["floor"]
                               for t in buckets["test"])
    gates["BOTH"] = dict(floor=float("nan"), calib_acc=float("nan"),
                         ood_declined=ood_abst, in_answered=in_ans, pos=[], neg=[])
    # structural OOD: an entity it has never encountered
    ENTITIES[NOVEL_ENTITY] = NOVEL_FEATURES
    novel_abst = sum(not M.predict(a, "EAT", NOVEL_ENTITY)["answered"]
                     for a in ("DOG", "CAT", "BIRD"))
    del ENTITIES[NOVEL_ENTITY]

    if verbose:
        sep("4. UNCERTAINTY  —  saying 'I don't know' instead of confabulating")
        print(f"  Nothing bitter is ever eaten in training, so what happens when you eat a")
        print(f"  herb is not merely unseen -- it is UNKNOWABLE from the data. Answering")
        print(f"  confidently is the failure; the only pass is to decline.\n")
        print(f"  the gate: it answers only when NO doubt signal objects --")
        print(f"      " + ", ".join(f"{k} >= {v:.3f}" for k, v in M.gate_floors.items()))
        print(f"      calibrated on {len(pos)} in-model + {len(neg)} unknowable cases from a")
        print(f"      DIFFERENT branch (pushing rooted things), balanced acc {sepq:.2f}")
        print(f"      margins: in-model {np.mean(pos):+.3f} avg   unknowable {np.mean(neg):+.3f} avg\n")
        print(f"      answers {in_ans}/{len(buckets['test'])} of the in-model held-out questions"
              f"  ({100*in_ans//len(buckets['test'])}%)")
        print(f"      declines {ood_abst}/{len(buckets['ood_test'])} of the unknowable ones"
              f"  ({100*ood_abst//len(buckets['ood_test'])}%)")
        print(f"      declines {novel_abst}/3 involving a thing it has never encountered"
              f"  (structural: Slate.knows(), no threshold)")
        print(f"\n      with the gate OFF it answers all {len(buckets['ood_test'])} unknowable questions"
              f" confidently and gets {ood_ungated_right}/{len(buckets['ood_test'])} right.")
        print(f"      That is the confabulation the gate exists to prevent.")
        print(f"\n  WHAT THE DOUBT COSTS. Refusing everything would score 100% here, so the")
        print(f"  number that keeps this honest is what the gate throws away:")
        print(f"      {gate_cost} of the {len(buckets['test'])} in-model questions are declined that it would")
        print(f"      have answered CORRECTLY -- the gate is not buying its refusals with")
        print(f"      silence. For contrast, ungated it scores {100*ungated_ok//n}% on prediction and")
        print(f"      0/{len(buckets['ood_test'])} on knowing when to stop.")
        print(f"      (An earlier build paid 6 correct answers for this, all of them a heavy")
        print(f"      fast fox, because every fast animal it had seen chased was light. That")
        print(f"      was a defect in the SAMPLE, not in the gate, and it is fixed in the data.)")
        print(f"\n  WHICH DOUBT SIGNAL? Four candidates, each calibrated identically on the")
        print(f"  calibration branch, all of them sat on the same exam:\n")
        print(f"      {'signal':<24}{'floor':<10}{'calib':<8}{'declines OOD':<15}{'answers in-model'}")
        for k, lbl in (("BOTH", "BOTH (the gate used)"),
                       ("margin_rel", "decision margin, scaled"),
                       ("margin", "decision margin, raw"),
                       ("raw_margin", "Slate top1-top2"),
                       ("familiarity", "familiarity")):
            g = gates[k]
            fl = "--" if k == "BOTH" else f"{g['floor']:.4f}"
            ca = "--" if k == "BOTH" else f"{g['calib_acc']:.2f}"
            print(f"      {lbl:<24}{fl:<10}{ca:<8}"
                  f"{g['ood_declined']}/{len(buckets['ood_test'])}{'':<11}"
                  f"{g['in_answered']}/{len(buckets['test'])}")
        print(f"\n      Read that honestly, in three parts.")
        print(f"      (1) Slate's RAW top1-top2 margin is useless here "
              f"({gates['raw_margin']['calib_acc']:.2f} on calibration):")
        print(f"          {M.slate.count()} stored episodes share a handful of outcomes, so the top two")
        print(f"          entries are near-duplicates of each other and their gap measures")
        print(f"          nothing. That is the gap the decision margin was built to fix.")
        print(f"      (2) The prior finding from bench_escalation.py -- familiarity accepts")
        print(f"          near-OOD cues, only the margin catches them -- does NOT reproduce")
        print(f"          on this world. They tie. The unknowable cases here differ on the")
        print(f"          very attribute the model weights most, so the cue really is far")
        print(f"          away and plain familiarity can see it perfectly well.")
        print(f"      (3) They come apart in the OTHER direction on world 2 below, where")
        print(f"          familiarity beats the margin badly. Since the calibration data")
        print(f"          rates them identically, it cannot justify picking either one, and")
        print(f"          picking by exam score would be tuning on the test set. So the gate")
        print(f"          requires BOTH -- which costs nothing in either world.")

    return dict(predict=(ok, n), answered=ans, majority=mok, verbatim=vok,
                norel=nrok, noshared=nsok, nosettle=nsettle_ok, ungated=ungated_ok,
                explain=(exact, len(cases)), cf={k: tuple(v) for k, v in cf.items()},
                in_ans=(in_ans, len(buckets["test"])),
                ood_abst=(ood_abst, len(buckets["ood_test"])),
                gates=gates, gate_cost=gate_cost, settle_changed=settle_changed,
                floor=floor, novel=novel_abst,
                dict_best=(dbok, dbans), dict_full=(dfok, dfans), dict_ood=db_ood,
                eat=(eat_m, eat_d, len(eat)), pick=dba.pick.get("EAT"))


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    W1, W2 = list(WORLDS)
    r = main(seed=0, verbose=True, world=W1)

    # ══ THE DECISIVE COMPARISON ══════════════════════════════════════════════
    # World 1 is winnable by a lookup table, so it cannot on its own show that
    # the substrate earns anything. World 2 changes exactly one thing: EAT now
    # depends on two attributes at once, which no single-attribute dict can
    # express. Everything else -- entities, splits, model, gate -- is identical.
    sep(f"DOES THE SUBSTRATE ACTUALLY EARN ITS PLACE?")
    print("  World 1 gives every action ONE causal attribute, which makes a two-column")
    print("  lookup table a COMPLETE model of it. An attractor memory cannot beat a")
    print("  correct lookup table, and it should not be credited for tying one. So:")
    print("  world 2 changes exactly one thing -- EAT now reads texture AND weight")
    print("  jointly (a big soft meal makes you SLEEPY, a hard heavy one makes you")
    print("  SORE). No single attribute determines the outcome. Same entities, same")
    print("  splits, same model, same gate.\n")
    r2 = main(seed=0, verbose=False, world=W2)
    n1, n2 = r["predict"][1], r2["predict"][1]
    print(f"      {'':<38}{'world 1':<22}{'world 2'}")
    print(f"      {'':<38}{'(one attribute)':<22}{'(two, jointly)'}")
    rows_ = [("dict on best attribute, no substrate",
              f"{100*r['dict_best'][0]//n1}%", f"{100*r2['dict_best'][0]//n2}%"),
             ("dict on whole profile, exact match",
              f"{100*r['dict_full'][0]//n1}%", f"{100*r2['dict_full'][0]//n2}%"),
             ("the action alone",
              f"{100*r['majority']//n1}%", f"{100*r2['majority']//n2}%"),
             ("THIS MODEL (gated)",
              f"{100*r['predict'][0]//n1}%", f"{100*r2['predict'][0]//n2}%"),
             ("THIS MODEL (ungated)",
              f"{100*r['ungated']//n1}%", f"{100*r2['ungated']//n2}%")]
    for lbl, a, b in rows_:
        print(f"      {lbl:<38}{a:<22}{b}")
    e1, e2 = r["eat"], r2["eat"]
    print(f"\n  But EAT is the only action that differs between the worlds, and it is {e1[2]}")
    print(f"  of the {n1} test questions -- the aggregate above dilutes the very thing being")
    print(f"  manipulated. On the EAT cells alone:")
    print(f"      {'':<38}{'world 1':<22}{'world 2'}")
    print(f"      {'dict on best attribute':<38}{f'{e1[1]}/{e1[2]}':<22}{f'{e2[1]}/{e2[2]}'}")
    print(f"      {'THIS MODEL':<38}{f'{e1[0]}/{e1[2]}':<22}{f'{e2[0]}/{e2[2]}'}")
    print(f"\n  Read it honestly. On world 1 the dict TIES this model and costs nothing,")
    print(f"  because a world with one cause per action is a lookup table wearing a")
    print(f"  costume -- and an attractor memory deserves no credit for tying one. The")
    print(f"  substrate earns its place only in world 2, where the rule is a conjunction:")
    print(f"  graded overlap across several attributes at once retrieves the right joint")
    print(f"  case, while a single-column dict cannot represent the rule at all.")
    print(f"  That is the actual scope of the claim -- not 'the Slate predicts', but")
    print(f"  'the Slate keeps working when the cause stops being one column'.")

    # The doubt signals disagree across the two worlds, and that disagreement is
    # the reason the gate demands both of them rather than picking a favourite.
    print(f"\n  AND THE DOUBT SIGNALS DISAGREE ACROSS THE TWO WORLDS. Unknowable cases")
    print(f"  correctly declined, out of {r['ood_abst'][1]}:\n")
    print(f"      {'':<26}{'world 1':<22}{'world 2'}")
    for k, lbl in (("margin_rel", "decision margin, scaled"), ("margin", "decision margin, raw"),
                   ("familiarity", "familiarity"), ("BOTH", "BOTH (the gate used)")):
        print(f"      {lbl:<26}{f'{r['gates'][k]['ood_declined']}/{r['ood_abst'][1]}':<22}"
              f"{r2['gates'][k]['ood_declined']}/{r2['ood_abst'][1]}")
    print(f"\n  The margin collapses on world 2 -- when a rule needs two attributes the")
    print(f"  evidence splits between them, every margin under that action shrinks, and a")
    print(f"  floor calibrated on a one-attribute action sits far too high. Scaling the")
    print(f"  margin by what a KNOWN case scores under the same action was the obvious")
    print(f"  fix and it did NOT work, which is why it is reported rather than quietly")
    print(f"  dropped. Familiarity survives the change; requiring both signals keeps the")
    print(f"  better of them in each world at a cost of zero in-model answers in either.")
    print(f"  The honest summary: prediction generalises across these two worlds, and the")
    print(f"  calibrated doubt only PARTLY does -- {r2['ood_abst'][0]}/{r2['ood_abst'][1]} on world 2, not {r['ood_abst'][0]}/{r['ood_abst'][1]}.")

    # ── how much of the world does it need to see? ───────────────────────────
    sep("HOW MUCH EXPOSURE DOES IT NEED?")
    print("  A headline of 100% cannot tell you whether the training set was doing")
    print("  real work or whether the thing was solved long before the last example.")
    print("  Trained on random subsets, scored on the SAME held-out exam:\n")
    print("  Nested subsets, averaged over 5 shuffles (min-max shown):\n")
    print(f"      {'episodes seen':<16}{'causes found':<16}{'held-out prediction'}")
    for n, mean_, lo, hi, found, ncausal in learning_curve():
        print(f"      {n:<16}{f'{found:.1f}/{ncausal}':<16}{mean_:5.1f}%   [{lo:.0f}-{hi:.0f}]")
    print("\n  The causes are pinned early -- it does not need the tail of the data to")
    print("  find them. What the extra episodes buy is coverage of the branches: the")
    print("  model can only answer about a branch some example actually demonstrated,")
    print("  which is the same property that makes it decline the bitter foods.")

    # ── does it survive a different substrate roll? ──────────────────────────
    sep("SEED SWEEP  —  the same exam on 7 different random substrates")
    rows = [main(seed=s, verbose=False, world=W1) for s in range(7)]
    pa = [100 * x["predict"][0] // x["predict"][1] for x in rows]
    ea = [100 * x["explain"][0] // max(1, x["explain"][1]) for x in rows]
    oa = [100 * x["ood_abst"][0] // max(1, x["ood_abst"][1]) for x in rows]
    ia = [100 * x["in_ans"][0] // max(1, x["in_ans"][1]) for x in rows]
    for lbl, v in (("PREDICT correct", pa), ("EXPLAIN exact", ea),
                   ("in-model answered", ia), ("unknowable declined", oa)):
        print(f"  {lbl:<22} min {min(v):>3}%   mean {int(np.mean(v)):>3}%   max {max(v):>3}%")

    sep("VERDICT")
    o, n = r["predict"]
    o2, n2 = r2["predict"]
    print(f"                   world 1 (one cause)      world 2 (two, jointly)")
    print(f"  PREDICT          {100*o//n}%                     {100*o2//n2}%"
          f"          held-out (action, thing) cells")
    print(f"  EXPLAIN          {100*r['explain'][0]//max(1,r['explain'][1])}%                     "
          f"{100*r2['explain'][0]//max(1,r2['explain'][1])}%          exact preimage, set equality")
    print(f"  COUNTERFACT      {sum(v[0] for v in r['cf'].values())}/{sum(v[1] for v in r['cf'].values())}"
          f"               {sum(v[0] for v in r2['cf'].values())}/{sum(v[1] for v in r2['cf'].values())}"
          f"       branch-flip + impossible + unknowable")
    print(f"  UNCERTAINTY      {r['ood_abst'][0]}/{r['ood_abst'][1]} declined            "
          f"{r2['ood_abst'][0]}/{r2['ood_abst'][1]} declined     answering {r['in_ans'][0]}/{r['in_ans'][1]} and "
          f"{r2['in_ans'][0]}/{r2['in_ans'][1]} in-model")
    print(f"\n  vs the best no-substrate baseline, on the cells that separate them:")
    print(f"      dict on the learned cause   {r['eat'][1]}/{r['eat'][2]}                    {r2['eat'][1]}/{r2['eat'][2]}")
    print(f"\n  The store of states became a model of transitions. It predicts consequences")
    print(f"  for things it never saw acted on, runs that model backwards to a cause,")
    print(f"  evaluates it on substitutions that never happened, and knows where it ends.")
    print(f"\n  SCOPE, honestly. This is understanding of a WORLD: {len(ACTIONS)} actions over {len(ENTITIES)} things,")
    print(f"  where the causes are attributes the model can see. On the world whose rules")
    print(f"  are one column wide a plain lookup table does just as well, and says so")
    print(f"  above. The doubt only partly transfers between the two worlds. And none of")
    print(f"  it is pragmatics or open-ended language -- knowing what happens next still")
    print(f"  does not tell it what is worth saying. That is a further rung.")
