"""Can the cube learn the METHOD instead of the answers?

distill.py / distill_llm.py proved: feed the cube a function's ANSWERS
(flashcards) and it collapses to chance on unseen inputs when the function is
non-smooth (parity: 50%). Matthew's question (2026-07-15): so don't teach it
the final numbers — teach it the MATH. Store the PROCEDURE as a handful of
tiny lookup rules and run them in a loop (the C1 feedback machinery), instead
of storing input->answer pairs.

The claim under test:
  capability can be carried by compact transition memories, run by a generic
  feedback loop (loop control in Python, task rules in the store) — IF distilled as a
  recipe of small composable steps rather than as example answers. A
  non-smooth global function (parity) is a chain of trivially-smooth local
  steps (1-bit XOR). Memory can hold the steps; feedback supplies the chain.

Two demonstrations, both on inputs the cube has NEVER seen:

  PARITY    4-rule lesson:  (state, bit) -> new state       [the 50% task]
  ADDITION  8-rule lesson:  (a, b, carry) -> (sum, carry)   [a full adder]

Baseline for shame: the flashcard bank from distill.py (hundreds of memorised
examples) on the same held-out inputs.

Standalone lab cube. Never reads/writes/imports the live production substrate.
"""
import numpy as np
from core import Slate

rng = np.random.default_rng(7)

D = 64                     # dim per symbol slot
NBITS = 12                 # inputs are 12-bit numbers, same as distill.py


def sep(t): print("\n" + "=" * 72 + f"\n{t}\n" + "=" * 72)


# symbol vocabulary: every discrete token gets a fixed random vector
_sym = {}
def sym(name):
    if name not in _sym:
        h = abs(hash(("sym", name))) % (2 ** 32)
        _sym[name] = np.random.default_rng(h).standard_normal(D).astype(np.float32)
    return _sym[name]


def key(*tokens):
    """A rule's key = the concatenation of its argument symbols."""
    return np.concatenate([sym(t) for t in tokens])


# ═════════════════════════════════════════════════════════════════════════════
# LESSON 1 — PARITY as a 4-rule recipe
#   walk the bits; XOR each into a running state. Each step is one recall.
# ═════════════════════════════════════════════════════════════════════════════
def teach_parity():
    s = Slate(2 * D, n_cells=2048, beta=35.0, seed=1)
    n_rules = 0
    for state in (0, 1):
        for bit in (0, 1):
            s.commit(key(f"S{state}", f"B{bit}"), payload=state ^ bit,
                     id=f"S{state},B{bit}")
            n_rules += 1
    return s, n_rules


def run_parity(cube, n):
    state = 0
    for i in range(NBITS):                     # feedback loop: output -> next input
        bit = (n >> i) & 1
        state = cube.recall(key(f"S{state}", f"B{bit}"))["winner"]["payload"]
    return state


# ═════════════════════════════════════════════════════════════════════════════
# LESSON 2 — ADDITION as an 8-rule recipe (a full adder)
#   walk the bit positions of two numbers; each step recalls (a,b,carry) ->
#   (sum_bit, carry_out). The cube ADDS numbers it has never seen.
# ═════════════════════════════════════════════════════════════════════════════
def teach_adder():
    s = Slate(3 * D, n_cells=2048, beta=35.0, seed=2)
    n_rules = 0
    for a in (0, 1):
        for b in (0, 1):
            for c in (0, 1):
                total = a + b + c
                s.commit(key(f"A{a}", f"B{b}", f"C{c}"),
                         payload=(total & 1, total >> 1),
                         id=f"A{a},B{b},C{c}")
                n_rules += 1
    return s, n_rules


def run_add(cube, x, y):
    carry, out = 0, 0
    for i in range(NBITS + 1):                 # feedback loop: carry chains forward
        a, b = (x >> i) & 1, (y >> i) & 1
        sbit, carry = cube.recall(key(f"A{a}", f"B{b}", f"C{carry}"))["winner"]["payload"]
        out |= sbit << i
    return out


# ═════════════════════════════════════════════════════════════════════════════
# BASELINE — the flashcard bank from distill.py (memorised parity answers)
# ═════════════════════════════════════════════════════════════════════════════
def teach_parity_flashcards(train_nums):
    s = Slate(NBITS, n_cells=512, beta=35.0, seed=3)
    for n in train_nums:
        b = np.array([(int(n) >> i) & 1 for i in range(NBITS)], dtype=np.float32)
        s.commit(b * 2.0 - 1.0, payload=int(bin(int(n)).count("1") % 2))
    return s


def flashcard_parity(cube, n):
    b = np.array([(int(n) >> i) & 1 for i in range(NBITS)], dtype=np.float32)
    r = cube.recall(b * 2.0 - 1.0)
    return r["winner"]["payload"] if r else 0


# ═════════════════════════════════════════════════════════════════════════════
# RUN
# ═════════════════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    # a held-out world: numbers neither approach may train on
    alln = rng.choice(4096, size=800, replace=False)
    train, heldout = alln[:400], alln[400:800]

    sep("PARITY — flashcards vs the recipe   (held-out inputs, chance = 50%)")
    flash = teach_parity_flashcards(train)
    proc, n_rules = teach_parity()
    gold = [bin(int(n)).count("1") % 2 for n in heldout]
    f_acc = np.mean([flashcard_parity(flash, int(n)) == g
                     for n, g in zip(heldout, gold)])
    p_acc = np.mean([run_parity(proc, int(n)) == g
                     for n, g in zip(heldout, gold)])
    print(f"  flashcards : {len(train)} memorised answers -> "
          f"{f_acc:.0%} on {len(heldout)} unseen numbers")
    print(f"  recipe     : {n_rules} rules + a loop      -> "
          f"{p_acc:.0%} on the same unseen numbers")

    sep("ADDITION — an 8-rule lesson   (pairs the cube has never seen)")
    adder, n_rules = teach_adder()
    pairs = [(int(rng.integers(0, 4096)), int(rng.integers(0, 4096)))
             for _ in range(400)]
    a_acc = np.mean([run_add(adder, x, y) == x + y for x, y in pairs])
    x, y = pairs[0]
    print(f"  taught {n_rules} rules (the full-adder table); tested 400 random sums")
    print(f"  exact-sum accuracy: {a_acc:.0%}")
    print(f"  e.g. {x} + {y} = cube says {run_add(adder, x, y)}   "
          f"(truth {x + y})")

    sep("VERDICT")
    print(f"  Answers don't transfer capability ({f_acc:.0%} ~ chance) — but the")
    print(f"  METHOD does: {p_acc:.0%} parity and {a_acc:.0%} exact addition on")
    print("  never-seen inputs, from single-digit-rule lessons. The capability is")
    print("  carried by compact transition rules in memory run through a generic")
    print("  feedback loop - not by memorised answers. (Loop control lives in")
    print("  Python; the task-specific rules live in the substrate. The distill.py")
    print("  wall was about the lesson's FORMAT, not a limit of the substrate.)")
