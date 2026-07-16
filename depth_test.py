"""Does STACKED depth compose, or just polish?

C3 earlier tested width (independent projections voting) — redundancy, not
composition. This tests the real claim: layers that each apply a DIFFERENT
transform, where layer k's cleaned output is layer k+1's input, computing a
function no single layer can.

The task is multi-relation inference over a small knowledge base. Only ONE-HOP
edges are stored, in separate relation banks:

  CYAN    = PARENT  (person -> their parent)
  MAGENTA = SIBLING (person -> their sibling)
  YELLOW  = LIVES   (person -> their place)

A query like  LIVES(SIBLING(PARENT(x)))  has no stored entry — the KB never
saw the 3-hop pair. A single associative lookup returns a one-hop neighbour and
stops. Only a stack that pipes PARENT->SIBLING->LIVES, re-cleaning the entity
at each step, reaches the answer. So:

  * single layer must FAIL for any query needing >1 relation (provably: the
    pair isn't stored),
  * a depth-D stack must solve queries needing <=D relations and fail those
    needing >D — depth = reasoning depth. That upper-triangular signature is
    impossible to fake with width.

Standalone lab cube. Never touches the live production substrate.
"""
import numpy as np
from core import Slate

DIM = 256
rng = np.random.default_rng(3)

# ── a tiny binary-tree family + geography ────────────────────────────────
N = 16                                   # people P0..P15 (a full binary tree)
PLACES = 5
people = [f"P{i}" for i in range(N)]
places = [f"L{i}" for i in range(PLACES)]
vec = {e: rng.standard_normal(DIM).astype(np.float32) for e in people + places}

parent = {f"P{i}": f"P{i // 2}" for i in range(1, N)}          # P0 is the root
sibling = {}
for k in range(N):
    a, b = 2 * k, 2 * k + 1
    if b < N:
        sibling[f"P{a}"] = f"P{b}"
        sibling[f"P{b}"] = f"P{a}"
lives = {f"P{i}": f"L{i % PLACES}" for i in range(N)}

REL = {"PARENT": parent, "SIBLING": sibling, "LIVES": lives}


def build_bank(rel_map, seed):
    s = Slate(DIM, n_cells=2048, beta=35.0, seed=seed)
    for src, dst in rel_map.items():
        s.commit(vec[src], payload=dst, id=src)
    return s


# heterogeneous stack: one bank per relation, each a DIFFERENT transform
BANKS = {name: build_bank(m, seed=i) for i, (name, m) in enumerate(REL.items())}

# flat baseline: ALL edges dumped into one bank keyed by source entity — it
# cannot know which relation a query wants, nor compose across them
flat = Slate(DIM, n_cells=2048, beta=35.0, seed=99)
for name, m in REL.items():
    for src, dst in m.items():
        flat.commit(vec[src], payload=dst, id=f"{name}:{src}")


def apply_relation(bank, entity_id):
    """One hop: settle the entity into its basin, read the bound target id."""
    r = bank.recall(vec[entity_id])
    return r["winner"]["payload"] if r else None


def stacked_answer(start_id, rel_sequence, depth):
    """Apply the query's relations in order through `depth` slots. Slots beyond
    the query length are identity pass-through. If depth < len(sequence) the
    computation is truncated — the stack isn't deep enough to hold it."""
    cur = start_id
    for k in range(depth):
        if k < len(rel_sequence):
            cur = apply_relation(BANKS[rel_sequence[k]], cur)
            if cur is None:
                return None
    return cur


def true_answer(start_id, rel_sequence):
    cur = start_id
    for name in rel_sequence:
        cur = REL[name].get(cur)
        if cur is None:
            return None
    return cur


# valid starts = people deep enough that PARENT/SIBLING/LIVES all resolve
def valid_starts(rel_sequence):
    out = []
    for p in people:
        if true_answer(p, rel_sequence) is not None:
            out.append(p)
    return out


def sep(t): print("\n" + "=" * 68 + f"\n{t}\n" + "=" * 68)


# ── the queries, by number of relations they compose ─────────────────────
QUERIES = {
    1: ["PARENT"],
    2: ["PARENT", "SIBLING"],
    3: ["PARENT", "SIBLING", "LIVES"],
}

sep("single layer vs heterogeneous stack (composition)")
print("query = compose these relations left-to-right:\n")
for k, seq in QUERIES.items():
    starts = valid_starts(seq)
    # flat single lookup: one recall from start, compare to composed truth
    flat_hits = 0
    for s in starts:
        r = flat.recall(vec[s])
        got = r["winner"]["payload"] if r else None
        flat_hits += (got == true_answer(s, seq))
    # stack deep enough to hold the whole query
    stk_hits = sum(stacked_answer(s, seq, depth=len(seq)) == true_answer(s, seq)
                   for s in starts)
    print(f"  {k}-relation  {'>'.join(seq):<24} "
          f"flat {flat_hits}/{len(starts):<3}  stack-d{len(seq)} {stk_hits}/{len(starts)}")

sep("depth = reasoning depth  (accuracy by stack depth D vs query hops K)")
print("expect upper-triangular: D >= K solves it, D < K can't hold it\n")
Ks = sorted(QUERIES)
hdr = "   K\\D " + "".join(f"{'D=' + str(d):>7}" for d in Ks)
print(hdr)
for K in Ks:
    seq = QUERIES[K]
    starts = valid_starts(seq)
    row = f"   K={K} "
    for D in Ks:
        hits = sum(stacked_answer(s, seq, depth=D) == true_answer(s, seq)
                   for s in starts)
        row += f"{hits / len(starts):>6.0%} "
    print(row)

sep("order matters  (composition is ordered, not a bag of lookups)")
seq = ["PARENT", "SIBLING", "LIVES"]
rev = list(reversed(seq))
starts = valid_starts(seq)
fwd = sum(stacked_answer(s, seq, 3) == true_answer(s, seq) for s in starts)
# reversed order: LIVES(person)->place, then SIBLING(place) is undefined -> fails
bad = sum(stacked_answer(s, rev, 3) is not None
          and stacked_answer(s, rev, 3) == true_answer(s, seq) for s in starts)
print(f"  correct order PARENT>SIBLING>LIVES : {fwd}/{len(starts)}")
print(f"  reversed order LIVES>SIBLING>PARENT: {bad}/{len(starts)}  "
      f"(LIVES yields a place; SIBLING(place) has no basin -> composition breaks)")

sep("VERDICT")
seq3 = QUERIES[3]; st3 = valid_starts(seq3)
flat3 = sum((flat.recall(vec[s])["winner"]["payload"] == true_answer(s, seq3))
            for s in st3)
stack3 = sum(stacked_answer(s, seq3, 3) == true_answer(s, seq3) for s in st3)
d2_on_k3 = sum(stacked_answer(s, seq3, 2) == true_answer(s, seq3) for s in st3)
composes = stack3 == len(st3) and flat3 == 0 and d2_on_k3 == 0
print(f"3-relation query:  flat {flat3}/{len(st3)}   depth-3 stack {stack3}/{len(st3)}"
      f"   depth-2 stack {d2_on_k3}/{len(st3)}")
print(f"\nSTACKED DEPTH COMPOSES: {'YES' if composes else 'NO'} — the stack solves what "
      f"no single layer can, and needs exactly enough depth to hold the computation")
