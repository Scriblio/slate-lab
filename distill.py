"""Can we distil a LARGE model's knowledge into Cube 3.0 so a SMALL model
performs like the large one — without the per-query token cost?

This is the experiment behind Matthew's north-star question. It does NOT use a
real LLM (that's the swap-in, layer B — see the note at the bottom). It uses
CONTROLLED oracles so the answer is a clean, reproducible NUMBER instead of a
vibe: we can dial exactly what each agent knows and can do, and watch which gap
the cube closes.

Three agents answer two families of task:

  LARGE          — the big model: knows every fact, has every procedure.
  SMALL          — the small model, bare: knows only a FRACTION of the facts,
                   has NO learned procedure.
  SMALL + CUBE3.0 — the small model plus a cube DISTILLED from LARGE:
                     * knowledge  -> extracted as separated relation banks
                                     (depth_test's composition machinery)
                     * procedures -> the only thing a memory can do with a
                                     procedure: store LARGE's input->output
                                     EXAMPLES and recall the nearest one.

Two task families, chosen to separate the two substances of "knowledge":

  KNOWLEDGE-BOUND   k-hop relational queries over a family+geography KB.
                    Hard because you must KNOW and CHAIN stored facts.
  CAPABILITY-BOUND  a function that must generalise to UNSEEN inputs:
                    PARITY  (xor of bits — high-frequency, non-smooth)
                    MAJORITY(more 1s than 0s — smooth, low-frequency)
                    Hard because it's a learned transform, not a fact.

Prediction (= the honest answer to the question):
  * knowledge gap COLLAPSES   — SMALL+CUBE ~ LARGE
  * capability gap PERSISTS   — SMALL+CUBE ~ SMALL bare ...
    ...EXCEPT to the exact degree the function is locally smooth: MAJORITY
    transfers as interpolation, PARITY does not. That boundary is the real
    lesson — memory absorbs the smooth part of "reasoning"; the non-smooth
    part stays the irreducible job of a gradient-trained model.

Standalone lab cube. Never reads/writes/imports the live production substrate.
"""
import numpy as np
from core import Slate

rng = np.random.default_rng(7)


def sep(t): print("\n" + "=" * 72 + f"\n{t}\n" + "=" * 72)


# ═══════════════════════════════════════════════════════════════════════════
# THE WORLD  (what LARGE knows)
# ═══════════════════════════════════════════════════════════════════════════
DIM = 256
N = 16
PLACES = 5
people = [f"P{i}" for i in range(N)]
places = [f"L{i}" for i in range(PLACES)]
vec = {e: rng.standard_normal(DIM).astype(np.float32) for e in people + places}

REL = {
    "PARENT":  {f"P{i}": f"P{i // 2}" for i in range(1, N)},
    "SIBLING": {},
    "LIVES":   {f"P{i}": f"L{i % PLACES}" for i in range(N)},
}
for k in range(N):
    a, b = 2 * k, 2 * k + 1
    if b < N:
        REL["SIBLING"][f"P{a}"] = f"P{b}"
        REL["SIBLING"][f"P{b}"] = f"P{a}"

QUERIES = {1: ["PARENT"], 2: ["PARENT", "SIBLING"], 3: ["PARENT", "SIBLING", "LIVES"]}


def truth(start, seq):
    cur = start
    for r in seq:
        cur = REL[r].get(cur)
        if cur is None:
            return None
    return cur


def valid_starts(seq):
    return [p for p in people if truth(p, seq) is not None]


# ═══════════════════════════════════════════════════════════════════════════
# THE AGENTS
# ═══════════════════════════════════════════════════════════════════════════
P_KNOW = 0.40            # fraction of individual facts the SMALL model has

# SMALL's partial knowledge: it knows each edge independently w.p. P_KNOW
small_knows = {name: {src: (rng.random() < P_KNOW) for src in m}
               for name, m in REL.items()}


def large_chain(start, seq):                       # LARGE: full KB
    return truth(start, seq)


def small_chain(start, seq):                       # SMALL bare: partial KB
    cur = start
    for r in seq:
        if not small_knows[r].get(cur, False):     # doesn't know this hop -> stuck
            return None
        cur = REL[r].get(cur)
    return cur


# ── distil LARGE's relational knowledge into Cube 3.0 (separated banks) ──────
def build_bank(name, seed):
    s = Slate(DIM, n_cells=2048, beta=35.0, seed=seed)
    for src, dst in REL[name].items():             # LARGE emits every edge
        s.commit(vec[src], payload=dst, id=src)
    return s


BANKS = {name: build_bank(name, i) for i, name in enumerate(REL)}
N_FACTS = sum(len(m) for m in REL.values())


def cube_chain(start, seq):                        # SMALL + CUBE3.0
    cur = start
    for r in seq:
        res = BANKS[r].recall(vec[cur])
        if res is None:
            return None
        cur = res["winner"]["payload"]
    return cur


# ═══════════════════════════════════════════════════════════════════════════
# CAPABILITY TASKS  (a procedure that must generalise to unseen inputs)
# ═══════════════════════════════════════════════════════════════════════════
NBITS = 12
CAP = {
    "PARITY":   lambda b: int(b.sum() % 2),               # non-smooth
    "MAJORITY": lambda b: int(b.sum() > NBITS / 2),       # smooth
}


def bits(n):
    return rng.integers(0, 2, size=(n, NBITS)).astype(np.int64)


# a disjoint train / held-out split (dedup so no test row was 'seen')
_all = bits(3000)
_seen = {tuple(r) for r in _all[:600]}
train = _all[:600]
heldout = np.array([r for r in _all[600:] if tuple(r) not in _seen])[:400]


def distil_capability(fn, seed):
    """The ONLY thing a memory can do with a procedure: store LARGE's
    input->output examples. dim = NBITS, keyed by the ±1 bit pattern."""
    s = Slate(NBITS, n_cells=512, beta=35.0, seed=seed)
    for b in train:
        s.commit(b * 2.0 - 1.0, payload=int(fn(b)))       # LARGE labels it
    return s


def cube_capability(bank, b):
    r = bank.recall(b * 2.0 - 1.0)
    return r["winner"]["payload"] if r else None


# ═══════════════════════════════════════════════════════════════════════════
# RUN
# ═══════════════════════════════════════════════════════════════════════════
sep("DISTILLATION — what got poured into Cube 3.0")
print(f"  knowledge : {N_FACTS} facts across {len(REL)} relations "
      f"-> {len(BANKS)} separated banks")
print(f"  SMALL bare knows only {P_KNOW:.0%} of individual facts")
print(f"  capability: {len(train)} input->output examples per function memorised")

sep("KNOWLEDGE-BOUND  — k-hop relational queries  (% correct)")
print(f"  {'hops':<6}{'LARGE':>8}{'SMALL bare':>13}{'SMALL+CUBE3.0':>16}")
krows = {}
for k, seq in QUERIES.items():
    st = valid_starts(seq)
    L = sum(large_chain(s, seq) == truth(s, seq) for s in st) / len(st)
    S = sum(small_chain(s, seq) == truth(s, seq) for s in st) / len(st)
    C = sum(cube_chain(s, seq) == truth(s, seq) for s in st) / len(st)
    krows[k] = (L, S, C)
    print(f"  {k:<6}{L:>7.0%}{S:>12.0%}{C:>15.0%}")

sep("CAPABILITY-BOUND — a procedure on UNSEEN inputs  (% correct)")
print("  the cube can only MEMORISE examples; does that generalise?\n")
print(f"  {'task':<11}{'LARGE':>7}{'SMALL bare':>12}"
      f"{'CUBE (seen)':>13}{'CUBE (held-out)':>17}")
crows = {}
for name, fn in CAP.items():
    bank = distil_capability(fn, seed=100 + len(name))
    # LARGE has the procedure -> perfect on held-out
    Lh = np.mean([cube_capability_is := fn(b) == fn(b) for b in heldout])  # =1.0
    # SMALL bare: no procedure -> guesses
    Sh = np.mean([int(rng.integers(0, 2)) == fn(b) for b in heldout])
    # CUBE: memorised examples, recalled by nearest neighbour
    seen_acc = np.mean([cube_capability(bank, b) == fn(b) for b in train[:400]])
    held_acc = np.mean([cube_capability(bank, b) == fn(b) for b in heldout])
    crows[name] = (1.0, Sh, seen_acc, held_acc)
    print(f"  {name:<11}{1.0:>6.0%}{Sh:>11.0%}{seen_acc:>12.0%}{held_acc:>16.0%}")

sep("VERDICT — which gap did distillation close?")
kg_bare = np.mean([krows[k][0] - krows[k][1] for k in krows])
kg_cube = np.mean([krows[k][0] - krows[k][2] for k in krows])
print(f"  KNOWLEDGE gap (LARGE - SMALL):  bare {kg_bare:+.0%}  ->  "
      f"with cube {kg_cube:+.0%}   [{'COLLAPSED' if abs(kg_cube) < 0.1 else 'open'}]")
for name in CAP:
    L, S, _, H = crows[name]
    print(f"  CAPABILITY gap ({name:<8} LARGE - SMALL): bare {L - S:+.0%}  ->  "
          f"with cube {L - H:+.0%}   "
          f"[{'PERSISTS' if L - H > 0.25 else 'closed (smooth fn)'}]")
print()
print("  READ-OUT:")
print("  * Distilling knowledge into the cube CLOSES the knowledge gap: a small")
print("    model that half-remembers the facts matches the large one once the")
print("    cube holds and chains them — at a few retrieved items, not a full context.")
print("  * It does NOT hand over capability. The cube memorises a procedure's")
print("    examples perfectly (CUBE seen ~100%) and generalises them only as far")
print("    as the function is locally SMOOTH: MAJORITY transfers, PARITY collapses")
print("    to chance on unseen inputs. The non-smooth part of reasoning stays the")
print("    irreducible job of a gradient-trained model — route only THAT to LARGE.")
