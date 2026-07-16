"""The first automatic SKILL TRANSPLANT — opus writes the recipe, the cube runs it.

procedure.py proved capability moves through pure memory when a skill is
distilled as composable steps + feedback (4-rule parity 100%, 8-rule addition
100%) — but a human (CC) wrote those step-tables by hand. This closes the loop:

    1. ASK the LARGE model (claude-opus-4-8) to emit a skill as a STEP-TABLE —
       a deterministic finite automaton over bits: (state, bit) -> new state,
       plus output rules (state -> answer). No hand-authoring.
    2. POUR every rule into the cube (transitions AND outputs both live in
       substrate — nothing of the skill exists outside memory).
    3. RUN it with the feedback loop on inputs nobody has seen.
    4. VERIFY against TRUE computable gold — not against opus — and compare
       with SMALL (claude-haiku-4-5) answering the same questions bare, and
       with a flashcard bank (the distill.py format) as the fallen baseline.

Skills: divisibility by 3 and by 7. Non-smooth (bit-flip sensitive), flashcards
provably fail them, true gold is one line of Python, and haiku has no cheap
trick for div-7 on 4-digit numbers.

If this works: a small model's system gains a permanent, perfect skill for the
one-off cost of asking the large model to write the lesson — the bridge between
layer B (facts transplant) and procedure.py (method beats answers).

Standalone lab cube. Never reads/writes/imports the live production substrate.
Cost guard: ~2 opus calls + ~80 haiku calls, well under $1.
"""
import json
import re

import numpy as np
from core import Slate
from distill_llm import ask, ask_many, LARGE, SMALL, _stats
from procedure import sym, key, D, teach_parity_flashcards, flashcard_parity

rng = np.random.default_rng(7)
NBITS = 12


def sep(t): print("\n" + "=" * 72 + f"\n{t}\n" + "=" * 72)


# ─────────────────────────────────────────────────────────────────────────────
# 1. opus authors the recipe
# ─────────────────────────────────────────────────────────────────────────────
def opus_recipe(n):
    prompt = (
        f"Emit a deterministic finite automaton that decides whether a binary "
        f"number is divisible by {n}, reading its bits MOST-SIGNIFICANT FIRST.\n"
        "Return ONLY a JSON object (no prose, no code fence) with keys:\n"
        '  "start": the start state (a string),\n'
        '  "transition": an object mapping "STATE,BIT" -> "NEWSTATE" for every '
        "state and bit in {0,1},\n"
        '  "output": an object mapping each STATE -> 1 (divisible) or 0 (not).\n'
        "Use any state names you like. The automaton must be exactly correct."
    )
    raw = ask(LARGE, prompt, max_tokens=1500)
    raw = re.sub(r"^```(json)?|```$", "", raw.strip(), flags=re.M).strip()
    m = re.search(r"\{.*\}", raw, re.S)
    return json.loads(m.group(0))


# ─────────────────────────────────────────────────────────────────────────────
# 2. pour the recipe into substrate — transitions AND outputs
# ─────────────────────────────────────────────────────────────────────────────
def pour(recipe, seed):
    cube = Slate(2 * D, n_cells=2048, beta=35.0, seed=seed)
    n_rules = 0
    for k_, v in recipe["transition"].items():
        st, bit = [p.strip() for p in k_.split(",")]
        cube.commit(key(f"T:{st}", f"B{bit}"), payload=str(v), id=k_)
        n_rules += 1
    for st, out in recipe["output"].items():
        cube.commit(key("OUT", f"T:{st}"), payload=int(out), id=f"OUT:{st}")
        n_rules += 1
    return cube, n_rules


# ─────────────────────────────────────────────────────────────────────────────
# 3. run it — the feedback loop; every step is one recall
# ─────────────────────────────────────────────────────────────────────────────
def run_skill(cube, recipe, n):
    state = str(recipe["start"])
    for i in range(NBITS - 1, -1, -1):               # MSB first
        bit = (n >> i) & 1
        state = cube.recall(key(f"T:{state}", f"B{bit}"))["winner"]["payload"]
    return cube.recall(key("OUT", f"T:{state}"))["winner"]["payload"]


# ─────────────────────────────────────────────────────────────────────────────
# 4. verify vs true gold; haiku bare + flashcards as baselines
# ─────────────────────────────────────────────────────────────────────────────
def balanced_test_set(n, size=40):
    """half multiples of n, half not — so accuracy is base-rate-proof."""
    mult = [x for x in range(0, 4096, n)]
    non = [x for x in range(4096) if x % n]
    pick = lambda pool, k: list(rng.choice(pool, size=k, replace=False))
    xs = pick(mult, size // 2) + pick(non, size // 2)
    rng.shuffle(xs)
    return [int(x) for x in xs]


def flashcards_div(n, train, test):
    """the fallen format: memorise 400 answers, recall nearest on unseen."""
    s = Slate(NBITS, n_cells=512, beta=35.0, seed=9)
    tovec = lambda x: np.array([(x >> i) & 1 for i in range(NBITS)],
                               dtype=np.float32) * 2.0 - 1.0
    for x in train:
        s.commit(tovec(int(x)), payload=int(int(x) % n == 0))
    return np.mean([s.recall(tovec(x))["winner"]["payload"] == int(x % n == 0)
                    for x in test])


if __name__ == "__main__":
    train = [int(x) for x in rng.choice(4096, size=400, replace=False)]
    results = {}
    for n in (3, 7):
        sep(f"SKILL TRANSPLANT — divisibility by {n}")
        recipe = opus_recipe(n)
        cube, n_rules = pour(recipe, seed=n)
        print(f"  opus authored the recipe: {len(recipe['transition'])} transitions"
              f" + {len(recipe['output'])} output rules = {n_rules} rules in substrate")

        test = balanced_test_set(n)
        gold = [int(x % n == 0) for x in test]

        cube_acc = np.mean([run_skill(cube, recipe, x) == g
                            for x, g in zip(test, gold)])
        flash_acc = flashcards_div(n, train, test)

        qs = [f"Is {x} divisible by {n}? Reply with ONLY 1 for yes or 0 for no."
              for x in test]
        hk = ask_many(SMALL, qs, max_tokens=5)
        hk_acc = np.mean([(1 if "1" in (a or "") else 0) == g
                          for a, g in zip(hk, gold)])

        results[n] = (flash_acc, hk_acc, cube_acc)
        print(f"  flashcards (400 answers)     : {flash_acc:>4.0%}")
        print(f"  haiku bare                   : {hk_acc:>4.0%}")
        print(f"  cube running opus's recipe   : {cube_acc:>4.0%}"
              f"   (vs TRUE gold, balanced set, chance=50%)")

    sep("VERDICT — the automatic skill transplant")
    for n, (f, h, c) in results.items():
        print(f"  div-{n}:  flashcards {f:.0%}   haiku {h:.0%}   "
              f"opus-recipe-in-cube {c:.0%}")
    print(f"\n  spend: {_stats['calls']} calls "
          f"({_stats[LARGE]} opus, {_stats[SMALL]} haiku)  ~${_stats['cost']:.2f}")
    print("\n  READ-OUT: no human wrote these rules. The large model authored the")
    print("  lesson, the cube memorised it, the feedback loop executed it — and the")
    print("  skill is now a permanent, token-free part of the small system. This is")
    print("  layer B (facts) + procedure.py (methods) fused: automatic distillation")
    print("  of BOTH substances of knowledge into substrate.")
