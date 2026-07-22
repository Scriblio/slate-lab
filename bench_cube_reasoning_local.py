"""bench_cube_reasoning_local.py — does Cube 3.0 make a TINY LOCAL model reason?

The RIGHT test (unlike a flashcard/worked-example store): distil an Opus-authored
METHOD — a step-table / DFA — into the Cube 3.0 substrate and let the cube
EXECUTE it, then compare against a tiny local Ollama model answering bare, and
against the fallen flashcard format, on inputs nobody has seen, vs TRUE gold.

  Skills (1-line true gold; a 1B model is weak at all four):
    DIV-7, DIV-3   divisibility  (non-smooth; MSB-first remainder DFA)
    PARITY         #1-bits parity (non-smooth; 4-rule XOR walk)  [procedure.py]
    ADDITION       exact sum      (8-rule full adder)            [procedure.py]

  Conditions, N unseen items each, graded vs computable gold:
    tiny_bare      llama3.2:1b answers directly            (its own reasoning)
    flashcard_cube memorise labels, recall nearest         (the fallen format)
    cube_recipe    Opus's method in substrate, cube runs   (capability transfer)
    tiny+cube_e2e  the local model EXTRACTS operands -> cube computes  (the mount)

Opus (this author) writes the recipes directly — no ANTHROPIC_API_KEY needed.
Substrate = slate-lab/core.Slate. Standalone; never touches the production cube.

Run: python bench_cube_reasoning_local.py        (needs Ollama on :11434)
"""
import argparse
import json
import re
import time
import urllib.error
import urllib.request

import numpy as np
from core import Slate
from procedure import (D, key, teach_parity, run_parity, teach_adder, run_add,
                       teach_parity_flashcards, flashcard_parity)

NBITS = 12
OLLAMA = "http://127.0.0.1:11434"
rng = np.random.default_rng(7)


# ─────────────────────────────────────────────────────────────────────────────
# tiny local model (stdlib, self-contained)
# ─────────────────────────────────────────────────────────────────────────────
def ollama(prompt, system, model, num_predict=16, timeout=120):
    body = json.dumps({
        "model": model, "stream": False,
        "messages": [{"role": "system", "content": system},
                     {"role": "user", "content": prompt}],
        "options": {"temperature": 0.0, "num_predict": num_predict},
    }).encode("utf-8")
    req = urllib.request.Request(OLLAMA + "/api/chat", data=body,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            resp = json.loads(r.read().decode("utf-8"))
        return (resp.get("message") or {}).get("content", "").strip()
    except Exception:  # noqa: BLE001
        return ""


def ollama_up(model):
    try:
        with urllib.request.urlopen(OLLAMA + "/api/tags", timeout=4) as r:
            names = [m["name"] for m in json.loads(r.read())["models"]]
        return model in names or model + ":latest" in names
    except Exception:
        return False


# ─────────────────────────────────────────────────────────────────────────────
# Opus-authored divisibility DFA (MSB-first remainder automaton) + cube runner
# ─────────────────────────────────────────────────────────────────────────────
def opus_recipe_divn(n):
    """The method, emitted as a step-table: state = running remainder mod n,
    transition(state,bit) = (2*state+bit) % n, output(state)=1 iff remainder 0."""
    transition = {f"{st},{bit}": str((st * 2 + bit) % n)
                  for st in range(n) for bit in (0, 1)}
    output = {str(st): int(st == 0) for st in range(n)}
    return {"start": "0", "transition": transition, "output": output}


def pour_dfa(recipe, seed):
    cube = Slate(2 * D, n_cells=2048, beta=35.0, seed=seed)
    for k_, v in recipe["transition"].items():
        st, bit = k_.split(",")
        cube.commit(key(f"T:{st}", f"B{bit}"), payload=str(v), id=k_)
    for st, out in recipe["output"].items():
        cube.commit(key("OUT", f"T:{st}"), payload=int(out), id=f"OUT:{st}")
    return cube


def run_dfa(cube, recipe, x):
    state = str(recipe["start"])
    for i in range(NBITS - 1, -1, -1):                 # MSB first
        state = cube.recall(key(f"T:{state}", f"B{bit_at(x, i)}"))["winner"]["payload"]
    return int(cube.recall(key("OUT", f"T:{state}"))["winner"]["payload"])


def bit_at(x, i):
    return (x >> i) & 1


def flashcards_div(k, train, test):
    s = Slate(NBITS, n_cells=512, beta=35.0, seed=9)
    tv = lambda x: np.array([(x >> i) & 1 for i in range(NBITS)], np.float32) * 2 - 1
    for x in train:
        s.commit(tv(int(x)), payload=int(int(x) % k == 0))
    return [int(s.recall(tv(int(x)))["winner"]["payload"]) for x in test]


# ─────────────────────────────────────────────────────────────────────────────
# parsing the local model's replies
# ─────────────────────────────────────────────────────────────────────────────
def parse_bit(txt):
    m = re.match(r"[^01]*([01])", txt.strip())
    if m:
        return int(m.group(1))
    t = txt.lower()
    return 1 if ("yes" in t or ("divisible" in t and "not" not in t)) else 0


def parse_int(txt):
    nums = re.findall(r"-?\d+", txt.replace(",", ""))
    return int(nums[-1]) if nums else None


def parse_evenodd(txt):
    t = txt.lower()
    return 1 if "odd" in t else 0     # gold: 1 = odd number of 1-bits


def extract_ints(txt, k):
    nums = re.findall(r"-?\d+", txt.replace(",", ""))
    return [int(x) for x in nums[:k]] if len(nums) >= k else None


def all_ints(txt):
    return [int(v) for v in re.findall(r"-?\d+", txt.replace(",", ""))]


# ─────────────────────────────────────────────────────────────────────────────
# test sets (all disjoint from the flashcard train pool)
# ─────────────────────────────────────────────────────────────────────────────
def balanced_div(k, size, avoid):
    mult = [x for x in range(0, 4096, k) if x not in avoid]
    non = [x for x in range(4096) if x % k and x not in avoid]
    pick = lambda pool, m: [int(v) for v in rng.choice(pool, size=m, replace=False)]
    xs = pick(mult, size // 2) + pick(non, size - size // 2)
    rng.shuffle(xs)
    return xs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="llama3.2:1b")
    ap.add_argument("--n", type=int, default=40, help="unseen test items per skill")
    ap.add_argument("--train", type=int, default=400, help="flashcard train size")
    ap.add_argument("--no-llm", action="store_true", help="skip local-model legs")
    ap.add_argument("--out", default="results_cube_reasoning_local.json")
    args = ap.parse_args()

    use_llm = (not args.no_llm) and ollama_up(args.model)
    if not args.no_llm and not use_llm:
        print(f"WARNING: Ollama/{args.model} not reachable — running cube legs only")
    N, model = args.n, args.model
    SYS_BIT = "Reply with ONLY a single character: 1 or 0. No words."
    SYS_NUM = "Reply with ONLY the final integer. No words, no working."
    SYS_EO = "Reply with ONLY one word: even or odd."
    SYS_EX = "Reply with ONLY a JSON array of the integers in the question, in order."
    SYS_OP = "Reply with ONLY a single integer."

    train = [int(x) for x in rng.choice(4096, size=args.train, replace=False)]
    train_set = set(train)
    results = {"config": {"model": model, "n": N, "train": args.train,
                          "use_llm": use_llm}}
    print(f"local model: {model} | legs: {'tiny_bare, flashcard, cube, e2e' if use_llm else 'cube + flashcard only'} | N={N}/skill\n")

    # ── DIVISIBILITY skills (div-7, div-3) ───────────────────────────────
    for k in (7, 3):
        recipe = opus_recipe_divn(k)
        cube = pour_dfa(recipe, seed=k)
        test = balanced_div(k, N, train_set)
        gold = [int(x % k == 0) for x in test]

        cube_pred = [run_dfa(cube, recipe, x) for x in test]
        flash_pred = flashcards_div(k, train, test)
        row = {
            "rules_in_substrate": len(recipe["transition"]) + len(recipe["output"]),
            "cube_recipe": acc(cube_pred, gold),
            "flashcard_cube": acc(flash_pred, gold),
        }
        if use_llm:
            bare = [parse_bit(ollama(f"Is {x} divisible by {k}?", SYS_BIT, model, 8))
                    for x in test]
            row["tiny_bare"] = acc(bare, gold)
            e2e = []
            for x in test:
                reply = ollama(f"Which number is being tested in the request "
                               f"'is {x} divisible by {k}'? Reply ONLY that number.",
                               SYS_OP, model, 16)
                cands = [v for v in all_ints(reply) if v != k] or all_ints(reply)
                e2e.append(run_dfa(cube, recipe, cands[0]) if cands else -1)
            row["tiny_cube_e2e"] = acc(e2e, gold)
        results[f"DIV-{k}"] = row
        report_row(f"DIV-{k}", row)

    # ── PARITY (method = 4-rule XOR walk) ────────────────────────────────
    proc, n_rules = teach_parity()
    flash = teach_parity_flashcards(train)
    ptest = [int(x) for x in rng.choice([x for x in range(4096) if x not in train_set],
                                        size=N, replace=False)]
    pgold = [bin(x).count("1") % 2 for x in ptest]
    row = {
        "rules_in_substrate": n_rules,
        "cube_recipe": acc([run_parity(proc, x) for x in ptest], pgold),
        "flashcard_cube": acc([flashcard_parity(flash, x) for x in ptest], pgold),
    }
    if use_llm:
        bare = [parse_evenodd(ollama(
            f"In the binary representation of {x}, is the number of 1-bits even or odd?",
            SYS_EO, model, 8)) for x in ptest]
        row["tiny_bare"] = acc(bare, pgold)
        e2e = []
        for x in ptest:
            reply = ollama(f"Which number's bits are counted in 'parity of {x}'? "
                           f"Reply ONLY that number.", SYS_OP, model, 16)
            ints = all_ints(reply)
            e2e.append(run_parity(proc, ints[0]) if ints else -1)
        row["tiny_cube_e2e"] = acc(e2e, pgold)
    results["PARITY"] = row
    report_row("PARITY", row)

    # ── ADDITION (method = 8-rule full adder; flashcards are N/A) ─────────
    adder, n_rules = teach_adder()
    pairs = [(int(rng.integers(0, 4096)), int(rng.integers(0, 4096))) for _ in range(N)]
    agold = [x + y for x, y in pairs]
    row = {
        "rules_in_substrate": n_rules,
        "cube_recipe": acc([run_add(adder, x, y) for x, y in pairs], agold),
        "flashcard_cube": None,     # you cannot memorise sums meaningfully
    }
    if use_llm:
        bare = [parse_int(ollama(f"What is {x} + {y}?", SYS_NUM, model, 16))
                for x, y in pairs]
        row["tiny_bare"] = acc(bare, agold)
        e2e = []
        for (x, y) in pairs:
            ex = extract_ints(ollama(f"List the two numbers to add in '{x} + {y}' "
                                     f"as a JSON array.", SYS_EX, model, 32), 2)
            e2e.append(run_add(adder, ex[0], ex[1]) if ex else -1)
        row["tiny_cube_e2e"] = acc(e2e, agold)
    results["ADDITION"] = row
    report_row("ADDITION", row)

    with open(args.out, "w") as f:
        json.dump(results, f, indent=1)
    print(f"\nDONE -> {args.out}")


def acc(pred, gold):
    return round(float(np.mean([int(p == g) for p, g in zip(pred, gold)])), 3)


def report_row(name, row):
    parts = [f"cube_recipe {pct(row['cube_recipe'])}"]
    if row.get("flashcard_cube") is not None:
        parts.append(f"flashcard {pct(row['flashcard_cube'])}")
    else:
        parts.append("flashcard  n/a")
    if "tiny_bare" in row:
        parts.append(f"tiny_bare {pct(row['tiny_bare'])}")
        parts.append(f"tiny+cube {pct(row['tiny_cube_e2e'])}")
    print(f"  {name:<9} ({row['rules_in_substrate']:>2d} rules)  " + "  ".join(parts))


def pct(x):
    return "  -  " if x is None else f"{x:>4.0%}"


if __name__ == "__main__":
    main()
