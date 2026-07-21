"""Isolating the settle: does the attractor dynamics add anything over projected NN?

The reviewer's key ablation. Three retrieval methods over the SAME div-7 rules,
queries, seeds, and noise -- identical everything except the mechanism:

  knn         raw-vector cosine nearest-neighbour         (a vector index)
  slate_ns    sign-projected bipolar cells, NEAREST        (projection + binary
              pattern, ZERO settling cycles                 representation only)
  slate_full  sign-projected + iterative softmax settle    (full Slate)

`slate_ns` is exactly `slate_full` with the settle turned off (max_cycles=0), so
the ONLY difference between them is the recurrent attractor dynamics.

If slate_full ~= slate_ns, the robustness comes from the projection + distributed
binary representation, NOT the settle -- the honest attribution. The sigma sweep
runs past the README's tested range (to 2.5) to look for a regime where the
settle earns its keep.

Standalone lab cube; no API key. Run: python bench_ablation.py
"""
import argparse
import json

import numpy as np
from core import Slate
from procedure import key, D

NBITS = 12
DIM = 2 * D


def div7():
    trans = {(st, b): (st * 2 + b) % 7 for st in range(7) for b in (0, 1)}
    out = {st: int(st == 0) for st in range(7)}
    return trans, out


class Knn:
    def __init__(self, seed):
        self.K, self.P = [], []
    def commit(self, v, p):
        v = v.astype(np.float32)
        self.K.append(v / (np.linalg.norm(v) + 1e-9)); self.P.append(p)
    def finalize(self):
        self.M = np.stack(self.K)
    def recall(self, v):
        q = v.astype(np.float32); q /= (np.linalg.norm(q) + 1e-9)
        return self.P[int(np.argmax(self.M @ q))]


class SlateN:
    """core.Slate with a fixed settle depth; cycles=0 => projected nearest pattern."""
    def __init__(self, seed, cycles):
        self.s = Slate(DIM, n_cells=2048, beta=35.0, seed=seed)
        self.c = cycles
    def commit(self, v, p):
        self.s.commit(v, payload=p)
    def recall(self, v):
        r = self.s.recall(v, max_cycles=self.c)
        return r["winner"]["payload"] if r else None


def build(mk, trans, out, seed):
    st = mk(seed)
    for (s, b), n in trans.items():
        st.commit(key(f"S{s}", f"B{b}"), n)
    for s, o in out.items():
        st.commit(key("OUT", f"S{s}"), 1000 + o)
    if hasattr(st, "finalize"):
        st.finalize()
    return st


def noisy(v, sig, rng):
    return v + sig * rng.standard_normal(v.shape).astype(np.float32)


def run_div7(store, x, sig, rng):
    s = 0
    for i in range(NBITS - 1, -1, -1):
        p = store.recall(noisy(key(f"S{s}", f"B{(x >> i) & 1}"), sig, rng))
        if p is None or not (0 <= p < 7):
            return -1
        s = p
    o = store.recall(noisy(key("OUT", f"S{s}"), sig, rng))
    return (o - 1000) if o in (1000, 1001) else -1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", type=int, default=30)
    ap.add_argument("--sigmas", default="0,0.5,1.0,1.5,2.0,2.5")
    ap.add_argument("--n-task", type=int, default=100)
    ap.add_argument("--out", default="results_ablation.json")
    a = ap.parse_args()
    sig = [float(x) for x in a.sigmas.split(",")]
    trans, out = div7()
    methods = {"knn": lambda s: Knn(s),
               "slate_ns": lambda s: SlateN(s, 0),
               "slate_full": lambda s: SlateN(s, 4)}
    res = {m: {s: [] for s in sig} for m in methods}
    for m, mk in methods.items():
        for seed in range(a.seeds):
            st = build(mk, trans, out, seed)
            rng = np.random.default_rng(500 + seed)
            for s in sig:
                nums = rng.integers(0, 4096, size=a.n_task)
                res[m][s].append(np.mean([run_div7(st, int(x), s, rng) == int(x % 7 == 0)
                                          for x in nums]))
    agg = {m: {str(s): [round(float(np.mean(v)), 3), round(float(np.std(v)), 3)]
               for s, v in d.items()} for m, d in res.items()}
    delta = {str(s): round(float(np.mean(res["slate_full"][s]) - np.mean(res["slate_ns"][s])), 3)
             for s in sig}
    with open(a.out, "w") as f:
        json.dump({"config": vars(a), "sigmas": sig, "task_acc": agg,
                   "settle_minus_noSettle": delta}, f, indent=1)

    print(f"\nSETTLE ABLATION - div-7, {a.seeds} seeds (end-to-end acc, mean±std)\n" + "=" * 66)
    print("  " + " " * 11 + " ".join(f"{s:>9}" for s in sig))
    for m in ("knn", "slate_ns", "slate_full"):
        print(f"  {m:<11}  " + " ".join(
            f"{agg[m][str(s)][0]:>4.0%}+-{agg[m][str(s)][1]:>2.0%}" for s in sig))
    print("\n  settle minus no-settle (isolates the attractor dynamics):")
    print("   " + "  ".join(f"s{s}:{delta[str(s)]:+.0%}" for s in sig))
    print(f"\nDONE -> {a.out}")


if __name__ == "__main__":
    main()
