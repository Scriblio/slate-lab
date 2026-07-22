"""cube_toddler.py — teach the cube to TALK the way you raise a toddler: little
by little, rung by rung, the method instead of the answers.

The voice-corpus cube (cube_lm.py) was FLASHCARDS for language: memorise finished
adult sentences, reproduce their surface, understand nothing, wander. This is the
other thing — the procedure.py lesson applied to talking. We never store a single
sentence. We store, in the Slate substrate:

  * a LEXICON   — words grounded by category   (category -> word)
  * a GRAMMAR   — productions that COMPOSE      (nonterminal -> right-hand side)

and generation is the C1 feedback loop: expand the leftmost symbol by recalling a
rule for it, recurse until you hit words. Because it holds RULES, not examples, it
speaks sentences it was never shown — it learned HOW to make one.

Developmental ladder (mirrors a real child):
  stage 1  holophrastic   single words                "ball."  "more."
  stage 2  telegraphic    two-word combinations       "dog run."  "more milk."
  stage 3  S-V-O          subject verb object          "baby want cookie."
  stage 4  modifiers      determiners + adjectives     "the big dog see a red ball."
  stage 5  recursion      conjoined / embedded clauses "i see the cat and you hug baby."

Honest ceiling: this grows into genuine, COMPOSITIONAL, but BOUNDED language —
simple and correct, within the grammar it has been taught. It does not become
open-ended English on its own; that is still the large model's job. But every
word here is the cube's own, and every sentence is built, not recited.

Standalone lab cube. Never reads / writes / imports the live production substrate.
"""
import numpy as np, hashlib
from core import Slate

D = 32
CATS = {"AGENT", "ACTION", "OBJECT", "NOUN", "ADJ", "DET", "SOCIAL"}  # lexical slots
NT   = {"S", "NP", "VP"}                                              # structural symbols


def vec(name):
    h = hashlib.md5(f"tok:{name}".encode()).digest()
    seed = int.from_bytes(h[:8], "little")
    return np.random.default_rng(seed).standard_normal(D).astype(np.float32)


class Toddler:
    def __init__(self, seed=0):
        self.lex   = Slate(D, n_cells=1024, beta=40.0, seed=seed)      # category -> word
        self.rules = Slate(D, n_cells=1024, beta=40.0, seed=seed + 1)  # nonterminal -> RHS
        self.rng = np.random.default_rng(11)
        self.stage = 0
        self.lexicon = {}          # category -> set(words), for reporting only

    # ── teaching (one-shot commits — words and rules, never sentences) ─────────
    def learn_word(self, cat, word):
        self.lex.commit(vec(cat), payload=word)
        self.lexicon.setdefault(cat, set()).add(word)

    def learn_rule(self, lhs, *rhs, weight=1):
        # committing a rule `weight` times gives it more sampling mass — this is
        # how the child MATURES: newer, richer structures come to dominate the
        # older one-word habits without ever deleting them.
        for _ in range(weight):
            self.rules.commit(vec(lhs), payload=tuple(rhs))

    def learn_words(self, cat, words):
        for w in words:
            self.learn_word(cat, w)

    # ── recall helpers: all payloads bound to an exact symbol key ──────────────
    def _options(self, slate, symbol):
        r = slate.recall(vec(symbol), max_cycles=0, topk=64)
        if not r or not r["topk"]:
            return []
        best = r["topk"][0][1]
        return [m["payload"] for (_, o, m) in r["topk"] if o >= best - 0.05]

    def _pick(self, slate, symbol):
        opts = self._options(slate, symbol)
        return opts[int(self.rng.integers(len(opts)))] if opts else None

    # ── generation = the feedback loop expanding the grammar ───────────────────
    def expand(self, sym, depth=0):
        if depth > 10:
            return []
        if sym in CATS:                        # lexical slot -> a grounded word
            w = self._pick(self.lex, sym)
            return [w] if w else []
        if sym in NT:                          # structural -> expand a production
            rhs = self._pick(self.rules, sym)
            if rhs is None:
                return []
            out = []
            for s in rhs:
                out += self.expand(s, depth + 1)
            return out
        return [sym]                           # literal terminal ("more", "and", ...)

    def say(self, n=1):
        utts = []
        for _ in range(n):
            words = self.expand("S")
            if not words:
                continue
            s = " ".join(words)
            end = "!" if words[0] in self.lexicon.get("SOCIAL", ()) else "."
            utts.append(s[0].upper() + s[1:] + end)
        return utts


# ══════════════════════════════════════════════════════════════════════════════
# THE DEVELOPMENTAL LADDER — each stage adds words and/or rules to the SAME cube
# ══════════════════════════════════════════════════════════════════════════════
def stage1(t):                     # holophrastic: first words, one at a time
    t.learn_words("AGENT",  ["dog", "cat", "baby", "mommy", "daddy"])
    t.learn_words("OBJECT", ["ball", "milk", "cookie"])
    t.learn_words("SOCIAL", ["hi", "bye", "no", "more", "yes"])
    t.learn_rule("S", "AGENT")
    t.learn_rule("S", "OBJECT")
    t.learn_rule("S", "SOCIAL")
    t.stage = 1


def stage2(t):                     # telegraphic: two-word combinations
    t.learn_words("ACTION", ["run", "jump", "sleep", "eat", "want", "go", "play", "see"])
    t.learn_rule("S", "AGENT", "ACTION", weight=2)    # dog run
    t.learn_rule("S", "ACTION", "OBJECT", weight=2)   # want cookie
    t.learn_rule("S", "more", "OBJECT", weight=2)     # more milk  (literal + slot)
    t.stage = 2


def stage3(t):                     # subject-verb-object
    t.learn_words("OBJECT", ["book", "toy", "cup", "apple"])
    t.learn_rule("S", "AGENT", "ACTION", "OBJECT", weight=4)   # baby want cookie
    t.stage = 3


def stage4(t):                     # determiners + adjectives -> noun phrases
    t.learn_words("NOUN", ["dog", "cat", "ball", "cookie", "baby", "book", "toy", "bird"])
    t.learn_words("ADJ",  ["big", "little", "red", "blue", "good", "soft", "happy"])
    t.learn_words("DET",  ["the", "a", "my"])
    t.learn_rule("NP", "DET", "NOUN", weight=2)
    t.learn_rule("NP", "DET", "ADJ", "NOUN", weight=3)
    t.learn_rule("NP", "AGENT", weight=1)
    t.learn_rule("VP", "ACTION", "NP", weight=3)
    t.learn_rule("VP", "ACTION", weight=1)
    t.learn_rule("S", "NP", "VP", weight=7)           # the big dog see a red ball
    t.stage = 4


def stage5(t):                     # recursion: conjunction + a reason clause
    t.learn_rule("S", "S", "and", "S", weight=3)      # i see ball and you run
    t.learn_rule("S", "NP", "want", "NP", "because", "S", weight=3)
    t.stage = 5


LADDER = [
    ("stage 1 · holophrastic (single words)",          stage1),
    ("stage 2 · telegraphic (two-word)",               stage2),
    ("stage 3 · subject-verb-object",                  stage3),
    ("stage 4 · determiners + adjectives",             stage4),
    ("stage 5 · recursion (and / because)",            stage5),
]


def sep(t): print("\n" + "=" * 72 + f"\n{t}\n" + "=" * 72)


if __name__ == "__main__":
    import sys
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    tod = Toddler()
    print("teaching the cube to talk — little by little, the method not the answers.")
    print("(it is NEVER shown a sentence; only words and rules. every line it says,")
    print(" it built by expanding grammar it holds in the Slate substrate.)")
    for title, teach in LADDER:
        teach(tod)
        sep(title)
        n_words = sum(len(v) for v in tod.lexicon.values())
        n_rules = tod.rules.count()
        print(f"  vocabulary: {n_words} words   grammar: {n_rules} rules\n")
        for u in tod.say(8):
            print("   cube:", u)
    sep("the point")
    print("  Not one of those sentences was taught. Each was composed from words +")
    print("  rules by the same recall-and-feedback loop as the rest of the lab.")
    print("  Flashcards give you a parrot; the METHOD gives you a speaker. This is")
    print("  the difference between showing it the end results and teaching it how.")
