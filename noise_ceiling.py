"""How deep can the stack actually go? The ceiling is set by ALPHABET CROWDING.

First cut saturated at 100% to depth 50: 64 random 256-d symbols are so
well-separated that no noisy hop ever lands in the wrong basin, so per-hop
accuracy is 1.0 and 1.0**50 = 1.0. That is the real lesson — a vast,
well-separated ("million-ary") alphabet makes deep composition nearly free.

The ceiling appears only when symbols are CROWDED. So we hold noise fixed and
shrink the representation dimension (fewer dims = symbols packed closer =
confusable). A K-deep walk is correct only if every hop lands right, so
accuracy ~ p_hop**K. We measure the depth ceiling as the alphabet crowds, with
and without the error-correcting settle, to see what the basin buys.

Ring of 64 nodes, one relation SUCC (i -> i+1), noise re-injected each hop.
Standalone lab cube. Never touches the live production substrate.
"""
import numpy as np
from core import Slate

NODES = 64
NOISE = 1.0
DEPTHS = [1, 2, 3, 5, 8, 13, 21, 34, 50]
DIMS = [8, 10, 12, 16, 24, 48]        # smaller dim = more crowded alphabet


def build(dim, seed):
    rng = np.random.default_rng(seed)
    vec = [rng.standard_normal(dim).astype(np.float32) for _ in range(NODES)]
    bank = Slate(dim, n_cells=2048, beta=35.0, seed=0)
    for i in range(NODES):
        bank.commit(vec[i], payload=(i + 1) % NODES, id=i)
    return vec, bank, rng


def walk(vec, bank, rng, start, K, noise, max_cycles):
    cur = start
    for _ in range(K):
        probe = vec[cur] + noise * rng.standard_normal(len(vec[0])).astype(np.float32)
        cur = bank.recall(probe, max_cycles=max_cycles)["winner"]["payload"]
    return cur


def accuracy(vec, bank, rng, K, noise, max_cycles, trials=300):
    hits = 0
    for _ in range(trials):
        s = int(rng.integers(NODES))
        hits += (walk(vec, bank, rng, s, K, noise, max_cycles) == (s + K) % NODES)
    return hits / trials


def sep(t): print("\n" + "=" * 72 + f"\n{t}\n" + "=" * 72)


for mode, mc in (("settle (error-corrected)", 4), ("raw (no settle)", 0)):
    sep(f"depth ceiling as the alphabet crowds — {mode}  (noise={NOISE})")
    print("  each cell = % of K-deep composed walks correct\n")
    print("   dim " + "".join(f"{'K=' + str(d):>7}" for d in DEPTHS) + "   ceiling")
    for dim in DIMS:
        vec, bank, rng = build(dim, seed=5)
        accs = [accuracy(vec, bank, rng, K, NOISE, mc) for K in DEPTHS]
        ok = [K for K, a in zip(DEPTHS, accs) if a >= 0.90]
        ceil = max(ok) if ok else 0
        print(f"  {dim:>4} " + "".join(f"{a:>6.0%} " for a in accs) + f"   {ceil:>4}")

sep("what the basin buys — per-hop accuracy, settle vs raw")
print("  per-hop p decides everything: composed accuracy ~ p**depth\n")
print(f"   dim   settle_p    raw_p     settle p**50   raw p**50")
for dim in DIMS:
    vec, bank, rng = build(dim, seed=5)
    ps = accuracy(vec, bank, rng, 1, NOISE, 4, trials=800)
    vec, bank, rng = build(dim, seed=5)
    pr = accuracy(vec, bank, rng, 1, NOISE, 0, trials=800)
    print(f"  {dim:>4}   {ps:>7.1%}   {pr:>7.1%}      {ps**50:>6.0%}       {pr**50:>6.0%}")

sep("VERDICT")
print("Depth is NOT the limit — alphabet separation is.")
print("Composition accuracy ~ (per-hop accuracy) ** depth, so a small per-hop")
print("edge from the error-correcting basin is amplified exponentially over")
print("depth. Keep symbols well-separated (a big 'million-ary' alphabet) and 50")
print("deep is free; crowd them and the basin is what still lets you go deep.")
