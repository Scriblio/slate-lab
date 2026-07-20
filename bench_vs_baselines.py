"""What does Slate do better than the simplest alternative?

The crux question a skeptic asks. We store ONE transition table (the div-7
automaton) in three content-addressable ways, then execute the automaton with
each, under CLEAN and NOISY state-reads, over many seeds. This isolates what the
attractor substrate adds over ordinary storage — it does NOT flatter Slate.

  dict   exact hashmap on the key vector          (a normal lookup table / DFA)
  knn    nearest-cosine over stored key vectors    (a vector index / "RAG")
  slate  sign-projection + softmax settle          (core.Slate)

All three receive the SAME vector cue key(state,bit); the payload is next_state.
The noise model = a noisy READ of the current state (Gaussian on the cue vector),
i.e. the substrate is asked to recover the right rule from an imperfect cue.

Metrics (mean +/- std over --seeds runs):
  per-lookup accuracy vs sigma      (can it fetch the right rule from a noisy cue)
  end-to-end task accuracy vs sigma (does the 12-step div-7 verdict survive noise)
  bytes/rule, write ms/rule         (footprint + one-shot write cost)

Standalone lab cube; never touches the production substrate. No API key.
Run: python bench_vs_baselines.py
"""
import argparse
import json
import time

import numpy as np
from core import Slate
from procedure import key, D

NBITS = 12
DIM = 2 * D


def div7_recipe():
    trans = {(st, b): (st * 2 + b) % 7 for st in range(7) for b in (0, 1)}
    out = {st: int(st == 0) for st in range(7)}
    return trans, out


# ── three stores, identical (cue_vec -> payload) interface ───────────────────
class DictStore:
    kind = "dict"
    def __init__(self, seed): self.d = {}
    def commit(self, vec, payload): self.d[vec.astype(np.float32).tobytes()] = payload
    def recall(self, vec): return self.d.get(vec.astype(np.float32).tobytes(), None)
    def bytes_per_rule(self): return DIM * 4          # stores the key vector + tiny payload

class KnnStore:
    kind = "knn"
    def __init__(self, seed):
        self.K, self.P = [], []
    def commit(self, vec, payload):
        v = vec.astype(np.float32); self.K.append(v / (np.linalg.norm(v) + 1e-9)); self.P.append(payload)
    def finalize(self): self.M = np.stack(self.K)
    def recall(self, vec):
        q = vec.astype(np.float32); q /= (np.linalg.norm(q) + 1e-9)
        return self.P[int(np.argmax(self.M @ q))]
    def bytes_per_rule(self): return DIM * 4          # float32 key vector

class SlateStore:
    kind = "slate"
    def __init__(self, seed): self.s = Slate(DIM, n_cells=2048, beta=35.0, seed=seed)
    def commit(self, vec, payload): self.s.commit(vec, payload=payload)
    def recall(self, vec):
        r = self.s.recall(vec); return r["winner"]["payload"] if r else None
    def bytes_per_rule(self): return self.s.n * 4     # lab stores float32 cells (unpacked)
    def bytes_per_rule_packed(self): return self.s.n // 8   # production bit-packs 32x


def build(store_cls, trans, out, seed):
    st = store_cls(seed)
    for (state, b), nxt in trans.items():
        st.commit(key(f"S{state}", f"B{b}"), nxt)
    for state, o in out.items():
        st.commit(key("OUT", f"S{state}"), 1000 + o)   # tag outputs distinctly
    if hasattr(st, "finalize"):
        st.finalize()
    return st


def noisy(vec, sigma, rng):
    return vec + sigma * rng.standard_normal(vec.shape).astype(np.float32)


def run_div7(store, trans_keys, n, sigma, rng):
    """Execute the automaton with noisy state-reads; return predicted verdict."""
    state = 0
    for i in range(NBITS - 1, -1, -1):
        b = (n >> i) & 1
        p = store.recall(noisy(key(f"S{state}", f"B{b}"), sigma, rng))
        if p is None or not (0 <= p < 7):
            return -1                       # dict miss / invalid -> wrong
        state = p
    o = store.recall(noisy(key("OUT", f"S{state}"), sigma, rng))
    return (o - 1000) if (o is not None and o in (1000, 1001)) else -1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", type=int, default=30)
    ap.add_argument("--sigmas", default="0,0.25,0.5,0.75,1.0,1.5")
    ap.add_argument("--n-lookup", type=int, default=200, help="noisy probes/rule/seed")
    ap.add_argument("--n-task", type=int, default=100, help="numbers/seed for end-to-end")
    ap.add_argument("--out", default="results_vs_baselines.json")
    args = ap.parse_args()
    sigmas = [float(s) for s in args.sigmas.split(",")]
    trans, out = div7_recipe()
    rule_keys = [(key(f"S{s}", f"B{b}"), nxt) for (s, b), nxt in trans.items()]
    stores = [DictStore, KnnStore, SlateStore]

    # footprint + write cost (one representative seed)
    foot, wcost = {}, {}
    for cls in stores:
        t0 = time.time(); st = build(cls, trans, out, seed=0)
        wcost[cls.kind] = round((time.time() - t0) * 1000 / (len(trans) + len(out)), 3)
        foot[cls.kind] = st.bytes_per_rule()
    foot["slate_packed_projection"] = SlateStore(0).bytes_per_rule_packed()

    results = {"config": vars(args), "sigmas": sigmas,
               "bytes_per_rule": foot, "write_ms_per_rule": wcost,
               "lookup_acc": {}, "task_acc": {}}

    for cls in stores:
        look = {sig: [] for sig in sigmas}
        task = {sig: [] for sig in sigmas}
        for seed in range(args.seeds):
            st = build(cls, trans, out, seed=seed)
            rng = np.random.default_rng(1000 + seed)
            for sig in sigmas:
                # per-lookup accuracy
                ok = 0
                for _ in range(args.n_lookup):
                    kv, gold = rule_keys[rng.integers(len(rule_keys))]
                    ok += int(st.recall(noisy(kv, sig, rng)) == gold)
                look[sig].append(ok / args.n_lookup)
                # end-to-end task accuracy
                nums = rng.integers(0, 4096, size=args.n_task)
                tok = np.mean([run_div7(st, trans, int(x), sig, rng) == int(x % 7 == 0)
                               for x in nums])
                task[sig].append(tok)
        results["lookup_acc"][cls.kind] = {
            sig: [round(float(np.mean(v)), 3), round(float(np.std(v)), 3)]
            for sig, v in look.items()}
        results["task_acc"][cls.kind] = {
            sig: [round(float(np.mean(v)), 3), round(float(np.std(v)), 3)]
            for sig, v in task.items()}

    with open(args.out, "w") as f:
        json.dump(results, f, indent=1)

    # ── report ──────────────────────────────────────────────────────────────
    print(f"\nSLATE vs DICT vs KNN — div-7 automaton, {args.seeds} seeds "
          f"(mean±std)\n" + "=" * 68)
    print("\nfootprint / write cost per rule:")
    for k in ("dict", "knn", "slate"):
        print(f"  {k:<6} {foot[k]:>6d} bytes   {wcost[k]:>6.3f} ms/write")
    print(f"  slate (production bit-packed would be) "
          f"{foot['slate_packed_projection']:>4d} bytes")
    for metric, title in (("task_acc", "END-TO-END div-7 accuracy (12 noisy steps)"),
                          ("lookup_acc", "per-lookup accuracy")):
        print(f"\n{title}  —  noisy state-reads, sigma =")
        hdr = "  " + " ".join(f"{s:>10}" for s in sigmas)
        print(f"  {'':<6}{hdr}")
        for k in ("dict", "knn", "slate"):
            cells = " ".join(f"{results[metric][k][s][0]:>4.0%}±{results[metric][k][s][1]:>3.0%}"
                             for s in sigmas)
            print(f"  {k:<6}  {cells}")
    print(f"\nDONE -> {args.out}")


if __name__ == "__main__":
    main()
