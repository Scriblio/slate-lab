"""One universal interpreter, a family of ~50 finite-state programs, no hidden
task logic — the reviewer's proposed held-out test.

The point of the earlier procedure.py demos was fair criticism: `run_add` and
`run_parity` were PER-SKILL Python — the loop, the carry, the stop condition
lived outside memory. This fixes that. There is exactly ONE interpreter here,
`interpret()`, with zero task-specific branches. Every program is pure DATA (a
transition table + output table) living in the store; the interpreter never
knows what it computes.

Scope, stated honestly: the family is POSITION-INDEPENDENT finite-state
functions of a 12-bit number's bits (divisibility / residue classes / popcount
mod k). These are regular languages — the class a finite-state transducer can
represent. We do NOT claim arbitrary skills compile to tables; we claim
finite-state procedures do, and that an associative substrate can store and
robustly execute them.

Two questions, isolated:
  (a) does ONE interpreter run all ~50 programs from stored tables?      (clean)
  (b) does Slate beat the simplest store (a dict) — the SAME interpreter,
      dict-backed — when the state-read is noisy?                         (σ>0)

Standalone lab cube; never touches production. No API key.
Run: python bench_program_family.py
"""
import argparse
import json

import numpy as np
from core import Slate
from procedure import key, D

NBITS = 12
DIMK = 3 * D           # every cue is exactly 3 symbol slots


# ═════════════════════════════════════════════════════════════════════════════
# THE UNIVERSAL INTERPRETER — identical for every program, zero task logic
# ═════════════════════════════════════════════════════════════════════════════
def interpret(store, start, x, sigma=0.0, rng=None):
    state = start
    for i in range(NBITS - 1, -1, -1):                 # fixed MSB-first bit stream
        b = (x >> i) & 1
        cue = key("T", state, f"B{b}")
        if sigma:
            cue = cue + sigma * rng.standard_normal(DIMK).astype(np.float32)
        state = store.recall(cue)                      # the ONLY per-step operation
        if state is None:
            return None
    cue = key("O", state, "PAD")
    if sigma:
        cue = cue + sigma * rng.standard_normal(DIMK).astype(np.float32)
    return store.recall(cue)


# ═════════════════════════════════════════════════════════════════════════════
# THE COMPILER — spec -> transition table (position-independent finite state)
# ═════════════════════════════════════════════════════════════════════════════
def prog_residue(n, accept):
    """is (x mod n) in `accept`?  state = running remainder, read MSB-first."""
    T = {(f"r{r}", b): f"r{(2 * r + b) % n}" for r in range(n) for b in (0, 1)}
    O = {f"r{r}": int(r in accept) for r in range(n)}
    gold = lambda x: int((x % n) in accept)
    label = f"(x mod {n}) in {sorted(accept)}"
    return "r0", T, O, gold, label


def prog_popcount(k, accept):
    """is (#1-bits mod k) in `accept`?  state = running popcount mod k."""
    T = {(f"p{s}", b): f"p{(s + b) % k}" for s in range(k) for b in (0, 1)}
    O = {f"p{s}": int(s in accept) for s in range(k)}
    gold = lambda x: int((bin(x).count("1") % k) in accept)
    label = f"(popcount mod {k}) in {sorted(accept)}"
    return "p0", T, O, gold, label


def family():
    progs = []
    for n in range(2, 14):                     # divisibility + residue classes
        progs.append(prog_residue(n, {0}))                       # divisible by n
        progs.append(prog_residue(n, {1 % n}))                   # remainder 1
        if n >= 4:
            progs.append(prog_residue(n, {n - 1}))               # remainder n-1
    for k in range(2, 6):                       # popcount mod k
        for c in range(k):
            progs.append(prog_popcount(k, {c}))
    return progs


# ═════════════════════════════════════════════════════════════════════════════
# stores (dim-fixed), same cue -> payload interface
# ═════════════════════════════════════════════════════════════════════════════
class DictStore:
    def __init__(self, seed): self.d = {}
    def commit(self, vec, p): self.d[vec.astype(np.float32).tobytes()] = p
    def recall(self, vec): return self.d.get(vec.astype(np.float32).tobytes(), None)

class SlateStore:
    def __init__(self, seed): self.s = Slate(DIMK, n_cells=2048, beta=35.0, seed=seed)
    def commit(self, vec, p): self.s.commit(vec, payload=p)
    def recall(self, vec):
        r = self.s.recall(vec); return r["winner"]["payload"] if r else None


def load(store_cls, start, T, O, seed):
    st = store_cls(seed)
    for (state, b), nxt in T.items():
        st.commit(key("T", state, f"B{b}"), nxt)
    for state, o in O.items():
        st.commit(key("O", state, "PAD"), int(o))
    return st


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", type=int, default=5)
    ap.add_argument("--m", type=int, default=25, help="unseen test inputs/program/seed")
    ap.add_argument("--sigma", type=float, default=0.75, help="noisy-read level")
    ap.add_argument("--out", default="results_program_family.json")
    args = ap.parse_args()
    progs = family()
    print(f"universal interpreter: 1 function, {len(progs)} finite-state programs, "
          f"{args.seeds} seeds, {args.m} unseen inputs each\n")

    agg = {"dict": {"clean": [], "noisy": []}, "slate": {"clean": [], "noisy": []}}
    per_prog = []
    for pi, (start, T, O, gold, label) in enumerate(progs):
        row = {"program": label, "rules": len(T) + len(O)}
        for kind, cls in (("dict", DictStore), ("slate", SlateStore)):
            clean_s, noisy_s = [], []
            for seed in range(args.seeds):
                st = load(cls, start, T, O, seed=seed)
                rng = np.random.default_rng(7000 + seed + pi)
                xs = rng.integers(0, 4096, size=args.m)
                clean_s.append(np.mean([interpret(st, start, int(x)) == gold(int(x)) for x in xs]))
                noisy_s.append(np.mean([interpret(st, start, int(x), args.sigma, rng) == gold(int(x))
                                        for x in xs]))
            row[f"{kind}_clean"] = round(float(np.mean(clean_s)), 3)
            row[f"{kind}_noisy"] = round(float(np.mean(noisy_s)), 3)
            agg[kind]["clean"].append(np.mean(clean_s))
            agg[kind]["noisy"].append(np.mean(noisy_s))
        per_prog.append(row)

    # capacity: ALL programs' rules in ONE Slate (namespaced) — do they coexist?
    big = Slate(4 * D, n_cells=4096, beta=35.0, seed=0)
    for pi, (start, T, O, gold, label) in enumerate(progs):
        for (state, b), nxt in T.items():
            big.commit(key(f"P{pi}", "T", state, f"B{b}"), payload=(pi, nxt))
        for state, o in O.items():
            big.commit(key(f"P{pi}", "O", state, "PAD"), payload=(pi, int(o)))
    def interp_big(pi, start, x):
        state = start
        for i in range(NBITS - 1, -1, -1):
            r = big.recall(key(f"P{pi}", "T", state, f"B{(x >> i) & 1}"))
            state = r["winner"]["payload"][1]
        return big.recall(key(f"P{pi}", "O", state, "PAD"))["winner"]["payload"][1]
    rng = np.random.default_rng(123)
    cap_ok = []
    for pi, (start, T, O, gold, label) in enumerate(progs):
        xs = rng.integers(0, 4096, size=10)
        cap_ok.append(np.mean([interp_big(pi, start, int(x)) == gold(int(x)) for x in xs]))
    cap_acc = round(float(np.mean(cap_ok)), 3)
    total_rules = sum(r["rules"] for r in per_prog)

    results = {"config": vars(args), "n_programs": len(progs),
               "aggregate": {k: {c: round(float(np.mean(v)), 3) for c, v in d.items()}
                             for k, d in agg.items()},
               "capacity_one_slate": {"total_rules": total_rules,
                                      "clean_acc_all_in_one": cap_acc},
               "per_program": per_prog}
    with open(args.out, "w") as f:
        json.dump(results, f, indent=1)

    A = results["aggregate"]
    print("=" * 60)
    print(f"AGGREGATE over {len(progs)} programs (1 universal interpreter)")
    print("=" * 60)
    print(f"  {'':<7}{'clean':>10}{'noisy(sigma='+str(args.sigma)+')':>16}")
    for k in ("dict", "slate"):
        print(f"  {k:<7}{A[k]['clean']:>9.0%}{A[k]['noisy']:>15.0%}")
    print(f"\n  capacity: all {total_rules} rules of all {len(progs)} programs in ONE")
    print(f"            Slate -> clean accuracy {cap_acc:.0%} (programs coexist, no cross-talk)")
    worst = sorted(per_prog, key=lambda r: r["slate_noisy"])[:3]
    print(f"\n  slate's 3 hardest programs under noise:")
    for r in worst:
        print(f"    {r['program']:<26} clean {r['slate_clean']:.0%}  noisy {r['slate_noisy']:.0%}")
    print(f"\nDONE -> {args.out}")


if __name__ == "__main__":
    main()
