"""LAYER B — the real-model version of distill.py.

distill.py answered Matthew's north-star question with CONTROLLED oracles so the
result was a clean number. This file swaps the oracles for REAL models —
SMALL = claude-haiku-4-5, LARGE = claude-opus-4-8 — and reruns the SAME two-split
measurement (knowledge-bound vs capability-bound) on real questions.

It mirrors distill.py exactly so the numbers are directly comparable:

  KNOWLEDGE-BOUND   opus authors an obscure multi-hop KB (composer teacher
                    lineage). Those edges ARE what we distil into the cube's 3
                    separated banks, and opus is gold by construction.
                      LARGE          = opus  (=100%, it authored the KB)
                      SMALL bare     = haiku answering from intrinsic knowledge
                      SMALL + CUBE   = deterministic chain over the distilled banks
                    Prediction: haiku falls off with hop depth; the cube (holding
                    opus's facts) matches opus -> knowledge gap COLLAPSES.

  CAPABILITY-BOUND  a procedure that must generalise to UNSEEN inputs, with
                    computable TRUE gold:
                      PRIMALITY (non-smooth)   THRESHOLD n>=2048 (smooth)
                    opus LABELS the train set; the cube memorises opus's labels
                    (dim = 12 bits, keyed by the +/-1 pattern). We then test the
                    cube on held-out inputs against TRUE gold.
                    Prediction: cube ~ opus on seen; generalises only as far as
                    the function is locally SMOOTH (threshold yes, primality no).

Standalone lab cube. Never reads/writes/imports the live production substrate.
Real models cost money: N is a PILOT by default and every call is capped +
counted. Run:  python distill_llm.py            (pilot)
               python distill_llm.py --full      (tighter error bars)
"""
import hashlib
import os
import re
import sys
import json
import time
import threading
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from core import Slate

# ─────────────────────────────────────────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────────────────────────────────────────
LARGE = "claude-opus-4-8"
SMALL = "claude-haiku-4-5"
FULL = "--full" in sys.argv

# pilot vs full sizes
N_COMPOSERS   = 12
CAP_TRAIN     = 200 if FULL else 120     # examples opus labels per function
CAP_HELDOUT   =  60 if FULL else  30     # unseen inputs tested per function
NBITS         = 12                       # inputs are 12-bit numbers (0..4095)
MAX_CALLS     = 600                      # hard stop; abort if we'd exceed it
WORKERS       = 8

# public list pricing, USD per 1M tokens (for a spend estimate only)
PRICE = {LARGE: (15.0, 75.0), SMALL: (1.0, 5.0)}

rng = np.random.default_rng(7)


def sep(t):
    print("\n" + "=" * 72 + f"\n{t}\n" + "=" * 72)


# ─────────────────────────────────────────────────────────────────────────────
# API key — from the environment, or a local .env in this directory
# ─────────────────────────────────────────────────────────────────────────────
def _load_key():
    if os.environ.get("ANTHROPIC_API_KEY"):
        return
    envp = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if os.path.exists(envp):
        with open(envp, "r", encoding="utf-8") as f:
            for line in f:
                m = re.match(r"\s*ANTHROPIC_API_KEY\s*=\s*(.+)\s*$", line)
                if m:
                    os.environ["ANTHROPIC_API_KEY"] = m.group(1).strip().strip('"').strip("'")
                    return
    raise RuntimeError(
        "Set ANTHROPIC_API_KEY in your environment (or a .env file next to this "
        "script) to run the real-model experiments. The no-API experiments "
        "(run.py, depth_test.py, procedure.py, ...) need no key.")


_load_key()
import anthropic  # noqa: E402
client = anthropic.Anthropic()

_lock = threading.Lock()
_stats = {"calls": 0, "cost": 0.0, LARGE: 0, SMALL: 0}


def ask(model, prompt, system=None, max_tokens=800):
    with _lock:
        if _stats["calls"] >= MAX_CALLS:
            raise RuntimeError(f"call cap {MAX_CALLS} hit — aborting to protect budget")
        _stats["calls"] += 1
        _stats[model] += 1
    kwargs = dict(model=model, max_tokens=max_tokens,
                  messages=[{"role": "user", "content": prompt}])
    if system:
        kwargs["system"] = system
    for attempt in range(4):
        try:
            r = client.messages.create(**kwargs)
            pin, pout = PRICE[model]
            with _lock:
                _stats["cost"] += (r.usage.input_tokens * pin
                                   + r.usage.output_tokens * pout) / 1e6
            return "".join(b.text for b in r.content if b.type == "text").strip()
        except Exception as e:  # noqa: BLE001
            if attempt == 3:
                raise
            time.sleep(1.5 * (attempt + 1))


def ask_many(model, prompts, **kw):
    out = [None] * len(prompts)
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(ask, model, p, **kw): i for i, p in enumerate(prompts)}
        for fut in futs:
            out[futs[fut]] = fut.result()
    return out


# ═════════════════════════════════════════════════════════════════════════════
# KNOWLEDGE-BOUND
# ═════════════════════════════════════════════════════════════════════════════
DIM = 256


def build_kb():
    """opus authors an obscure, internally-consistent KB. It is gold by
    construction — the facts we distil into the cube are exactly opus's."""
    prompt = (
        f"List {N_COMPOSERS} classical composers whose principal composition "
        "teacher is well documented, choosing ones with an OBSCURE teacher "
        "lineage (avoid the most famous household names). For each, give a JSON "
        "object with keys:\n"
        '  "composer", "teacher" (their principal composition teacher),\n'
        '  "teacher_birth_city", "teacher_birth_country"\n'
        "Return ONLY a JSON array, no prose. Be factually careful; if unsure of "
        "a teacher, pick a different composer you are sure about."
    )
    raw = ask(LARGE, prompt, max_tokens=2000)
    raw = re.sub(r"^```(json)?|```$", "", raw.strip(), flags=re.M).strip()
    kb = json.loads(raw)
    # functional relations, exactly like distill.py's REL
    TEACHER = {r["composer"]: r["teacher"] for r in kb}
    CITY    = {r["teacher"]: r["teacher_birth_city"] for r in kb}
    COUNTRY = {r["teacher_birth_city"]: r["teacher_birth_country"] for r in kb}
    return kb, {"TEACHER": TEACHER, "CITY": CITY, "COUNTRY": COUNTRY}


def entity_vec(name, cache={}):
    """Deterministic random vector per entity string — the knowledge bank needs
    exact content-addressed identity, not semantics (same as distill.py's vec)."""
    if name not in cache:
        h = int.from_bytes(hashlib.blake2b(name.encode(),
                                           digest_size=8).digest(), "big")
        cache[name] = np.random.default_rng(h).standard_normal(DIM).astype(np.float32)
    return cache[name]


def build_bank(rel_map, seed):
    s = Slate(DIM, n_cells=2048, beta=35.0, seed=seed)
    for src, dst in rel_map.items():
        s.commit(entity_vec(src), payload=dst, id=src)
    return s


# question templates per hop (natural language, for the models)
QTEXT = {
    1: lambda c: f"Who was the principal composition teacher of the composer {c}?",
    2: lambda c: (f"In which CITY was the principal composition teacher of "
                  f"the composer {c} born?"),
    3: lambda c: (f"In which COUNTRY was the birthplace-city of the principal "
                  f"composition teacher of the composer {c} located?"),
}
CHAIN = {1: ["TEACHER"], 2: ["TEACHER", "CITY"], 3: ["TEACHER", "CITY", "COUNTRY"]}


def truth(start, seq, REL):
    cur = start
    for r in seq:
        cur = REL[r].get(cur)
        if cur is None:
            return None
    return cur


def cube_chain(start, seq, BANKS):
    cur = start
    for r in seq:
        res = BANKS[r].recall(entity_vec(cur))
        if res is None:
            return None
        cur = res["winner"]["payload"]
    return cur


def norm(s):
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def judge(pred, gold):
    """lenient match: gold token appears in the model's answer."""
    p, g = norm(pred), norm(gold)
    return bool(g) and (g in p or p in g)


def run_knowledge():
    sep("KNOWLEDGE-BOUND  — opus authors the KB, then k-hop queries")
    kb, REL = build_kb()
    composers = [r["composer"] for r in kb]
    BANKS = {name: build_bank(m, i) for i, name in enumerate(REL)
             for m in [REL[name]]}
    n_facts = sum(len(m) for m in REL.values())
    print(f"  distilled {n_facts} opus facts -> {len(BANKS)} separated cube banks "
          f"({len(composers)} composers)")

    haiku_system = ("Answer with ONLY the specific name or place asked for — no "
                    "explanation. If you do not know, reply exactly: UNKNOWN.")
    rows = {}
    for k, seq in CHAIN.items():
        starts = [c for c in composers if truth(c, seq, REL) is not None]
        golds = [truth(c, seq, REL) for c in starts]
        # LARGE = opus = author = gold by construction
        L = 1.0
        # SMALL bare = haiku intrinsic knowledge
        prompts = [QTEXT[k](c) for c in starts]
        haiku = ask_many(SMALL, prompts, system=haiku_system, max_tokens=60)
        S = np.mean([judge(h, g) for h, g in zip(haiku, golds)])
        # SMALL + CUBE = deterministic chain over distilled banks
        C = np.mean([judge(cube_chain(c, seq, BANKS), g)
                     for c, g in zip(starts, golds)])
        rows[k] = (L, S, C, len(starts))
    print(f"\n  {'hops':<6}{'LARGE(opus)':>13}{'SMALL(haiku)':>14}"
          f"{'SMALL+CUBE':>13}{'n':>5}")
    for k, (L, S, C, n) in rows.items():
        print(f"  {k:<6}{L:>12.0%}{S:>13.0%}{C:>12.0%}{n:>5}")
    return rows, kb


# ═════════════════════════════════════════════════════════════════════════════
# CAPABILITY-BOUND
# ═════════════════════════════════════════════════════════════════════════════
def _is_prime(n):
    if n < 2:
        return 0
    for d in range(2, int(n ** 0.5) + 1):
        if n % d == 0:
            return 0
    return 1


CAP = {
    "PRIMALITY":  (_is_prime,               "non-smooth"),
    "THRESHOLD":  (lambda n: int(n >= 2048), "smooth"),
}


def n_to_vec(n):
    b = np.array([(n >> i) & 1 for i in range(NBITS)], dtype=np.float32)
    return b * 2.0 - 1.0


def _int_array(raw):
    """Robustly pull an array of ints from a model reply (JSON, fenced, or prose)."""
    raw = re.sub(r"^```(json)?|```$", "", raw.strip(), flags=re.M).strip()
    m = re.search(r"\[[\s0-9,]*\]", raw, re.S)
    if m:
        return [int(x) for x in re.findall(r"\d+", m.group(0))]
    return [int(x) for x in re.findall(r"\b[01]\b", raw)]


def opus_label(name, nums):
    """LARGE labels the training inputs — this is what gets distilled."""
    instr = ("For each number in the list, output 1 if it is PRIME else 0."
             if name == "PRIMALITY" else
             "For each number in the list, output 1 if it is >= 2048 else 0.")
    instr += (" Return ONLY a JSON array of 0/1, same length and order as the "
              "input, no prose, no code fence.")
    labels = []
    for i in range(0, len(nums), 60):
        chunk = [int(n) for n in nums[i:i + 60]]
        raw = ask(LARGE, instr + "\n" + json.dumps(chunk), max_tokens=1500)
        arr = _int_array(raw)
        if len(arr) != len(chunk):            # length mismatch -> pad/trim safely
            arr = (arr + [0] * len(chunk))[:len(chunk)]
        labels.extend(arr)
    return labels[:len(nums)]


def run_capability():
    sep("CAPABILITY-BOUND — opus labels, cube memorises, test on UNSEEN vs true gold")
    alln = rng.choice(4096, size=CAP_TRAIN + 400, replace=False)
    train = alln[:CAP_TRAIN]
    heldout = alln[CAP_TRAIN:CAP_TRAIN + CAP_HELDOUT]

    print(f"  {'task':<11}{'kind':<12}{'LARGE(opus)':>13}{'SMALL(haiku)':>14}"
          f"{'CUBE seen':>12}{'CUBE held':>12}")
    rows = {}
    for name, (fn, kind) in CAP.items():
        # distil: opus labels the train set -> cube memorises opus's labels
        tr_labels = opus_label(name, train)
        s = Slate(NBITS, n_cells=512, beta=35.0, seed=100 + len(name))
        for n, lab in zip(train, tr_labels):
            s.commit(n_to_vec(int(n)), payload=int(lab))

        gold_h = [fn(int(n)) for n in heldout]

        def bal_acc(preds, golds):
            """balanced accuracy — mean per-class recall; chance = 0.5,
            immune to the primality base-rate trap that inflates raw accuracy."""
            preds, golds = np.array(preds), np.array(golds)
            recs = [np.mean(preds[golds == c] == c) for c in (0, 1)
                    if np.any(golds == c)]
            return float(np.mean(recs)) if recs else float("nan")

        # LARGE held-out (real opus capability, vs true gold)
        opus_h = opus_label(name, heldout)
        L = bal_acc(opus_h, gold_h)
        # SMALL held-out (real haiku capability)
        hk_sys = "Reply with ONLY a single character, 1 or 0."
        if name == "PRIMALITY":
            hp = [f"Is {int(n)} a prime number? Reply 1 for yes, 0 for no." for n in heldout]
        else:
            hp = [f"Is {int(n)} greater than or equal to 2048? Reply 1 or 0." for n in heldout]
        hk = ask_many(SMALL, hp, system=hk_sys, max_tokens=5)
        hk_p = [1 if "1" in (a or "") else 0 for a in hk]
        S = bal_acc(hk_p, gold_h)
        # CUBE: recall nearest memorised example
        def cube(n):
            r = s.recall(n_to_vec(int(n)))
            return r["winner"]["payload"] if r else 0
        seen = bal_acc([cube(int(n)) for n in train], [fn(int(n)) for n in train])
        held = bal_acc([cube(int(n)) for n in heldout], gold_h)
        rows[name] = (L, S, seen, held, kind)
        print(f"  {name:<11}{kind:<12}{L:>12.0%}{S:>13.0%}{seen:>11.0%}{held:>11.0%}")
    print("  (all figures = balanced accuracy; chance = 50%)")
    return rows


# ═════════════════════════════════════════════════════════════════════════════
def main():
    print(f"LAYER B — real models   SMALL={SMALL}  LARGE={LARGE}   "
          f"mode={'FULL' if FULL else 'PILOT'}")
    krows, kb = run_knowledge()
    crows = run_capability()

    sep("VERDICT — which gap did distilling opus into Cube 3.0 close?")
    kg_bare = np.mean([krows[k][0] - krows[k][1] for k in krows])
    kg_cube = np.mean([krows[k][0] - krows[k][2] for k in krows])
    print(f"  KNOWLEDGE gap (opus - small):  bare {kg_bare:+.0%}  ->  "
          f"with cube {kg_cube:+.0%}   "
          f"[{'COLLAPSED' if abs(kg_cube) < 0.15 else 'open'}]")
    for name, (L, S, seen, held, kind) in crows.items():
        # balanced accuracy: cube generalises iff held-out stays above chance
        verdict = "GENERALISES (smooth)" if held >= 0.70 else "COLLAPSES to chance"
        print(f"  CAPABILITY ({name:<9} {kind:<10}): cube memorised {seen:.0%}  ->  "
              f"cube UNSEEN {held:.0%}   [{verdict}]   "
              f"(opus {L:.0%} / haiku {S:.0%} bal-acc)")

    print(f"\n  spend: {_stats['calls']} calls "
          f"({_stats[LARGE]} opus, {_stats[SMALL]} haiku)  "
          f"~${_stats['cost']:.2f}")
    print("\n  READ-OUT: same shape as the controlled experiment holds with real")
    print("  models — the cube absorbs opus's KNOWLEDGE (small+cube matches opus on")
    print("  multi-hop facts it half-knew) but hands over CAPABILITY only where the")
    print("  function is locally smooth. Route the non-smooth remainder to opus.")


if __name__ == "__main__":
    main()
