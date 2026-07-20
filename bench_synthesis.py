"""Does a REAL large model synthesize the finite-state programs?

The reviewer's strongest ask: don't hand-author the transition tables - have a
frontier model compile each spec into the restricted DFA language, then

  (a) verify the model's DFA against TRUE gold on ALL 4096 inputs
      -> SYNTHESIS RELIABILITY (can the model reliably compile the spec?)
  (b) run the model-authored tables through the SAME universal interpreter on
      Slate vs a dict, clean + noisy
      -> EXECUTION + error tolerance on tables the model wrote, not CC.

The model returns ONLY a JSON DFA (states, transitions, outputs) - no code, so
no task logic can hide in Python (the interpreter is task-agnostic). This turns
"CC hand-wrote correct DFAs" into "a frontier model compiled them."

Needs ANTHROPIC_API_KEY (env or a .env next to this file) for the full run.

  python bench_synthesis.py --smoke   # no API: verify the pipeline on a known DFA
  python bench_synthesis.py           # full: opus compiles all 48 (~$3-4)
"""
import argparse
import json
import re

import numpy as np
from bench_program_family import interpret, DictStore, SlateStore, load, NBITS


# the SAME 48-program family, now as natural-language specs + true gold
def specs():
    out = []
    for n in range(2, 14):
        out.append((f"x is divisible by {n}",
                    (lambda x, n=n: int(x % n == 0)), f"div{n}"))
        r1 = 1 % n
        out.append((f"x leaves remainder {r1} when divided by {n}",
                    (lambda x, n=n, c=r1: int(x % n == c)), f"rem{n}_{r1}"))
        if n >= 4:
            out.append((f"x leaves remainder {n-1} when divided by {n}",
                        (lambda x, n=n, c=n-1: int(x % n == c)), f"rem{n}_{n-1}"))
    for k in range(2, 6):
        for c in range(k):
            out.append((f"the number of 1-bits in x is congruent to {c} modulo {k}",
                        (lambda x, k=k, c=c: int(bin(x).count("1") % k == c)),
                        f"pop{k}_{c}"))
    return out


PROMPT = (
    "You are compiling a decision procedure into a deterministic finite "
    "automaton (DFA) that reads the bits of a 12-bit unsigned integer x "
    "MOST-SIGNIFICANT-BIT FIRST (bit 11 down to bit 0). The DFA must decide: "
    "{nl}.\nReturn ONLY a JSON object (no prose, no code fence) with keys:\n"
    '  "start": the start state (a string),\n'
    '  "transition": an object mapping "STATE,BIT" -> "NEWSTATE" for every '
    "state and BIT in {{0,1}},\n"
    '  "output": an object mapping each STATE -> 1 (predicate holds) or 0.\n'
    "The automaton must be EXACTLY correct for all inputs 0..4095."
)


def parse_dfa(raw):
    raw = re.sub(r"^```(json)?|```$", "", (raw or "").strip(), flags=re.M).strip()
    m = re.search(r"\{.*\}", raw, re.S)
    if not m:
        return None
    try:
        obj = json.loads(m.group(0))
        start = str(obj["start"])
        trans = {}
        for k, v in obj["transition"].items():
            st, b = [p.strip() for p in k.split(",")]
            trans[(st, int(b))] = str(v)
        out = {str(k): int(v) for k, v in obj["output"].items()}
        return start, trans, out
    except Exception:  # noqa: BLE001
        return None


def run_pure(start, trans, out, x):
    s = start
    for i in range(NBITS - 1, -1, -1):
        s = trans.get((s, (x >> i) & 1))
        if s is None:
            return None
    return out.get(s)


def verify_all(start, trans, out, gold):
    """Exact: the model's DFA must match gold on every 12-bit input."""
    return all(run_pure(start, trans, out, x) == gold(x) for x in range(4096))


def slate_vs_dict(start, trans, out, gold, seeds=3, m=25, sigma=0.75):
    """Run the MODEL's table through the universal interpreter on both stores."""
    res = {}
    for kind, cls in (("dict", DictStore), ("slate", SlateStore)):
        clean, noisy = [], []
        for seed in range(seeds):
            st = load(cls, start, trans, out, seed=seed)
            rng = np.random.default_rng(seed)
            xs = rng.integers(0, 4096, size=m)
            clean.append(np.mean([interpret(st, start, int(x)) == gold(int(x)) for x in xs]))
            noisy.append(np.mean([interpret(st, start, int(x), sigma, rng) == gold(int(x))
                                  for x in xs]))
        res[kind] = (round(float(np.mean(clean)), 3), round(float(np.mean(noisy)), 3))
    return res


def known_div7():
    n = 7
    trans = {(f"r{r}", b): f"r{(2 * r + b) % n}" for r in range(n) for b in (0, 1)}
    out = {f"r{r}": int(r == 0) for r in range(n)}
    return "r0", trans, out, (lambda x: int(x % 7 == 0))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", action="store_true")
    ap.add_argument("--exec-seeds", type=int, default=3)
    ap.add_argument("--out", default="results_synthesis.json")
    a = ap.parse_args()
    sp = specs()

    if a.smoke:
        start, trans, out, gold = known_div7()
        ok = verify_all(start, trans, out, gold)
        sv = slate_vs_dict(start, trans, out, gold, seeds=a.exec_seeds)
        good = ok and sv["slate"][1] > 0.9 and sv["dict"][1] == 0.0
        print(f"[smoke] known div-7 DFA: verify_all={ok}; exec {sv}")
        print("pipeline OK" if good else "pipeline PROBLEM")
        return

    from distill_llm import ask_many, LARGE, _stats     # loads .env key at import
    print(f"synthesising {len(sp)} DFAs with {LARGE} (parallel)...", flush=True)
    raws = ask_many(LARGE, [PROMPT.format(nl=nl) for nl, _, _ in sp], max_tokens=1600)

    rows, correct, malformed = [], 0, 0
    for (nl, gold, pid), raw in zip(sp, raws):
        parsed = parse_dfa(raw)
        if parsed is None:
            rows.append({"id": pid, "nl": nl, "status": "malformed"})
            malformed += 1
            continue
        start, trans, out = parsed
        ok = verify_all(start, trans, out, gold)
        row = {"id": pid, "nl": nl, "status": "correct" if ok else "wrong",
               "states": len(out), "rules": len(trans) + len(out)}
        if ok:
            correct += 1
            row["exec"] = slate_vs_dict(start, trans, out, gold, seeds=a.exec_seeds)
        rows.append(row)

    cr = [r for r in rows if r["status"] == "correct"]
    def agg(store, idx):
        v = [r["exec"][store][idx] for r in cr if "exec" in r]
        return round(float(np.mean(v)), 3) if v else None
    results = {
        "model": LARGE, "n_specs": len(sp),
        "synthesis": {"correct": correct, "wrong": len(sp) - correct - malformed,
                      "malformed": malformed, "reliability": round(correct / len(sp), 3)},
        "execution_on_model_tables": {
            "dict": {"clean": agg("dict", 0), "noisy": agg("dict", 1)},
            "slate": {"clean": agg("slate", 0), "noisy": agg("slate", 1)}},
        "spend": {"calls": _stats["calls"], "usd": round(_stats["cost"], 2)},
        "rows": rows}
    with open(a.out, "w") as f:
        json.dump(results, f, indent=1)

    s = results["synthesis"]
    print(f"\nSYNTHESIS RELIABILITY: {correct}/{len(sp)} exactly correct "
          f"({s['reliability']:.0%})  | wrong {s['wrong']}  malformed {malformed}")
    miss = [r for r in rows if r["status"] != "correct"]
    if miss:
        print("  misses:", ", ".join(f"{r['id']}({r['status']})" for r in miss))
    ex = results["execution_on_model_tables"]
    print(f"EXECUTION on the model's OWN tables (correct DFAs), {a.exec_seeds} seeds:")
    print(f"  dict : clean {ex['dict']['clean']:.0%}  noisy {ex['dict']['noisy']:.0%}")
    print(f"  slate: clean {ex['slate']['clean']:.0%}  noisy {ex['slate']['noisy']:.0%}")
    print(f"spend: {_stats['calls']} opus calls  ~${_stats['cost']:.2f}")
    print(f"DONE -> {a.out}")


if __name__ == "__main__":
    main()
