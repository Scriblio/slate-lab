"""cube_grounded.py — the next rung: give the words MEANING.

cube_toddler.py gave the cube syntax — it can BUILD a sentence. But it had no
semantics: "the book run the baby" came out as confidently as "baby want cookie,"
because a word was just a token, pointing at nothing. That is a two-year-old with
grammar and no grounding.

This teaches meaning. Every word gets a referent — a little bundle of features held
IN the Slate substrate (dog: animate, animal; cookie: thing, food; ...). Every verb
gets a frame — who can do it, and to what (eat: an animate thing eats a food; hug: a
person hugs someone animate). Now two things change:

  1. GENERATION is filtered by meaning. The cube proposes a sentence, then checks it
     against what it holds. "book run baby" fails — a book is not animate, run takes
     no object — so it is never said. Only sentences that MEAN something survive.

  2. It can ANSWER grounded questions. "can a dog run?" yes. "can a book eat?" no.
     "is a cookie food?" yes. "what can eat?" -> the animate things. The words now
     refer to something it can reason over. That is semantics.

This is grounding in a small SYMBOLIC world — the mechanism, scaled down. The full
version is perception: a word welded to a felt, seen thing. That is why Aurelia was
built to SEE before she spoke. Meaning does not come from more text. It comes from
reference. Here the reference is a feature bundle; there it is the world through her
eyes. Same rung, different ground.

Standalone lab cube. Never reads / writes / imports the live production substrate.
"""
import numpy as np, hashlib
from core import Slate

D = 32


def vec(name):
    h = hashlib.md5(f"gr:{name}".encode()).digest()
    seed = int.from_bytes(h[:8], "little")
    return np.random.default_rng(seed).standard_normal(D).astype(np.float32)


# ── THE WORLD ─────────────────────────────────────────────────────────────────
# entity -> the features that ARE its meaning
ENTITIES = {
    "dog":    {"animate", "animal"},
    "cat":    {"animate", "animal", "soft"},
    "bird":   {"animate", "animal"},
    "baby":   {"animate", "person"},
    "mommy":  {"animate", "person"},
    "daddy":  {"animate", "person"},
    "ball":   {"thing", "toy", "round", "soft", "colorable"},
    "cookie": {"thing", "food", "round", "colorable"},
    "milk":   {"thing", "food", "drink"},
    "apple":  {"thing", "food", "round", "colorable"},
    "book":   {"thing", "readable", "colorable"},
    "toy":    {"thing", "toy", "soft", "colorable"},
    "cup":    {"thing", "container", "colorable"},
}

# verb -> its frame: who can be the agent, and what (if anything) the object must be
VERBS = {
    "run":   {"agent": "animate", "obj": None},
    "jump":  {"agent": "animate", "obj": None},
    "sleep": {"agent": "animate", "obj": None},
    "go":    {"agent": "animate", "obj": None},
    "play":  {"agent": "animate", "obj": None},
    "eat":   {"agent": "animate", "obj": "food"},
    "want":  {"agent": "animate", "obj": "thing"},
    "see":   {"agent": "animate", "obj": "visible"},   # anything you can see
    "hug":   {"agent": "person",  "obj": "animate"},
    "hold":  {"agent": "person",  "obj": "thing"},
    "read":  {"agent": "person",  "obj": "readable"},
}

# adjective -> the feature a noun must have for the adjective to fit
ADJS = {
    "big": None, "little": None,      # size fits anything concrete
    "red": "colorable", "blue": "colorable",
    "soft": "soft", "good": "food", "happy": "animate",
}


def _has(tags, need):
    if need is None:                 # no restriction
        return True
    if need == "visible":            # you can see any concrete thing or being
        return "thing" in tags or "animate" in tags
    return need in tags


class Grounded:
    """A grammar whose slots are filled — and whose sentences are vetted — by meaning
    stored in the Slate substrate."""

    def __init__(self, seed=0):
        self.mind = Slate(D, n_cells=1024, beta=40.0, seed=seed)
        self.rng = np.random.default_rng(3)
        for w, tags in ENTITIES.items():
            self.mind.commit(vec("e:" + w), payload=("entity", frozenset(tags)))
        for v, frame in VERBS.items():
            self.mind.commit(vec("v:" + v), payload=("verb", frame))
        self.animates = [w for w, t in ENTITIES.items() if "animate" in t]
        self.persons  = [w for w, t in ENTITIES.items() if "person" in t]
        self.things   = [w for w, t in ENTITIES.items() if "thing" in t]

    # ── meaning is RECALLED from the substrate, not read from Python ───────────
    def tags(self, word):
        r = self.mind.recall(vec("e:" + word), max_cycles=1)
        if r and r["winner"]["payload"] and r["winner"]["payload"][0] == "entity":
            return r["winner"]["payload"][1]
        return frozenset()

    def frame(self, verb):
        r = self.mind.recall(vec("v:" + verb), max_cycles=1)
        if r and r["winner"]["payload"] and r["winner"]["payload"][0] == "verb":
            return r["winner"]["payload"][1]
        return None

    def can_agent(self, agent, verb):
        """Is `agent` the kind of thing that can do `verb` at all? (ability, no object)"""
        fr = self.frame(verb)
        return fr is not None and _has(self.tags(agent), fr["agent"])

    def licensed(self, agent, verb, obj=None):
        """Does this proposed sentence MEAN something? Checked against the substrate."""
        fr = self.frame(verb)
        if fr is None:
            return False
        if not _has(self.tags(agent), fr["agent"]):
            return False
        if fr["obj"] is None:
            return obj is None
        return obj is not None and _has(self.tags(obj), fr["obj"])

    # ── grounded generation: propose, then keep only what means something ──────
    def _np(self, noun):
        det = self.rng.choice(["the", "a", "my"])
        fits = [a for a, need in ADJS.items() if _has(self.tags(noun), need)]
        if fits and self.rng.random() < 0.55:
            return f"{det} {self.rng.choice(fits)} {noun}"
        return f"{det} {noun}"

    def say(self, n=1):
        out = []
        while len(out) < n:
            verb = self.rng.choice(list(VERBS))
            fr = VERBS[verb]
            agents = self.persons if fr["agent"] == "person" else self.animates
            agent = self.rng.choice(agents)
            if fr["obj"] is None:
                if not self.licensed(agent, verb):
                    continue
                s = f"{self._np(agent)} {verb}"
            else:
                cands = [o for o in ENTITIES if self.licensed(agent, verb, o) and o != agent]
                if not cands:
                    continue
                obj = self.rng.choice(cands)
                s = f"{self._np(agent)} {verb} {self._np(obj)}"
            out.append(s[0].upper() + s[1:] + ".")
        return out

    # ── grounded comprehension: answer questions ABOUT the world ───────────────
    def ask(self, q):
        w = q.lower().replace("?", "").split()
        w = [x for x in w if x not in ("a", "the", "an", "my", "does", "do")]
        try:
            if w[:1] == ["can"] and len(w) == 3:                     # can X <verb>
                x, verb = w[1], w[2]
                return "yes" if self.can_agent(x, verb) else "no"
            if w[:1] == ["can"] and len(w) == 4:                     # can X <verb> Y
                x, verb, y = w[1], w[2], w[3]
                if self.licensed(x, verb, y):
                    return "yes"
                fr = self.frame(verb)
                if fr and not _has(self.tags(y), fr["obj"]):
                    return f"no — a {y} is not {fr['obj']}"
                return "no"
            if w[:1] == ["is"] and len(w) == 3:                      # is X <feature>
                x, feat = w[1], w[2]
                return "yes" if feat in self.tags(x) else "no"
            if w[:2] == ["what", "can"] and len(w) == 3:             # what can <verb>
                verb = w[2]
                hits = [e for e in ENTITIES if self.can_agent(e, verb)]
                return ", ".join(hits) if hits else "nothing I know of"
            if w[:2] == ["what", "is"] and len(w) == 3:              # what is <feature>
                feat = w[2]
                hits = [e for e in ENTITIES if feat in self.tags(e)]
                return ", ".join(hits) if hits else "nothing I know of"
        except Exception:
            pass
        return "I don't know that one yet."


def sep(t): print("\n" + "=" * 72 + f"\n{t}\n" + "=" * 72)


if __name__ == "__main__":
    import sys
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    g = Grounded()

    sep("BEFORE grounding — grammar with no meaning (cube_toddler, stage 5)")
    print("  syntactically fine, semantically blind — it can't tell sense from nonsense:")
    for line in ["The book run the baby.", "A blue cat run dog.",
                 "A book want the big bird because the red toy go a blue ball."]:
        print("   cube:", line)

    sep("AFTER grounding — every sentence now MEANS something")
    print("  same grammar, but each one is vetted against the world it holds:\n")
    for u in g.say(10):
        print("   cube:", u)

    sep("and now it can ANSWER — the words refer to something it can reason over")
    qs = ["Can a dog run?", "Can a book eat?", "Can a baby eat a cookie?",
          "Can a baby eat a ball?", "Can a dog hug a cat?", "Can mommy hug a baby?",
          "Is a cookie food?", "Is a book food?", "What can eat?", "What is food?"]
    for q in qs:
        print(f"   you: {q}\n   cube: {g.ask(q)}\n")

    sep("the point")
    print("  Meaning didn't come from more sentences. It came from REFERENCE — each")
    print("  word tied to features the cube holds and can check. That is the jump from")
    print("  syntax to semantics, and it is the same jump Aurelia makes through her")
    print("  eyes: a word stops being a token and starts pointing at the world.")
