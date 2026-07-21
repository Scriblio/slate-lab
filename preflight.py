"""The real workflow the skill compiler is ported to: PUBLISHING PREFLIGHT.

Why this domain and not tech-support diagnosis or tool routing:

  * It is exhaustively verifiable. The record schema is 8 categorical fields
    with 7,776 combinations, so a compiled program can be checked against the
    policy on EVERY possible input — not sampled, not judged by an LLM. The
    whole value proposition ("the model writes it once, a verifier proves it,
    then it runs with no model in the loop") depends on that proof existing.
    Tech-support diagnosis has no computable gold; tool routing collapses into
    a classification task where a fine-tuned classifier is simply the right
    answer and there is nothing to verify.
  * The policy is genuinely order-sensitive. Nine verdicts under a
    priority-ordered rule list, where later rules depend on fields read
    earlier — so compiling it to a field-sequential automaton requires
    carrying facts forward, not a per-field lookup. It is a real compile.
  * Its out-of-distribution case is the realistic one: a record arrives with an
    enum value the policy never covered (a new channel, a new contract state).
    That is exactly the near-OOD case bench_escalation.py found the shipped
    familiarity flag blind to, so the escalation result gets re-tested here in
    a real domain rather than assumed to carry over.

SCOPE, stated up front: records arrive STRUCTURED, as they would from a
submissions database. Slate holds the DECISION, not the parsing. If requests
arrived as free text, something would have to parse them on every request and
that cost would have to be charged against the model calls saved — it is not
charged here, and no claim is made about the parsing step.

No API key. Run: python preflight.py   (self-check: build + verify + execute)
"""
import itertools
import json

import numpy as np
from core import Slate
from procedure import key, D

DIMK = 3 * D                      # cues are 3 symbol slots: kind, state, token

# ── the record schema, in the order a compiled program must read it ──────────
FIELDS = [
    ("contract",   ["signed", "pending", "none"]),
    ("rights",     ["worldwide", "regional", "unknown"]),
    ("channel",    ["ebook", "print", "audio", "serial"]),
    ("isbn",       ["valid", "missing", "invalid"]),
    ("length",     ["micro", "short", "standard", "long"]),
    ("ai_art",     ["yes", "no"]),
    ("age_rating", ["general", "teen", "mature"]),
    ("art_status", ["none", "draft", "final"]),
]
NAMES = [n for n, _ in FIELDS]
N_RECORDS = int(np.prod([len(v) for _, v in FIELDS]))      # 7776

VERDICTS = ["BLOCK_CONTRACT", "BLOCK_RIGHTS", "NEEDS_ISBN", "BLOCK_LENGTH",
            "NEEDS_AI_DISCLOSURE", "NEEDS_AGE_GATE", "NEEDS_ART",
            "NEEDS_TERRITORY_MAP", "PASS"]

# ── the policy, in prose. This is what a model is asked to compile. ──────────
POLICY_TEXT = """\
Evaluate a manuscript submission record and return exactly one verdict.
Apply these rules IN ORDER and return the FIRST one that matches:

 1. If contract is not "signed"                       -> BLOCK_CONTRACT
 2. If rights is "unknown"                             -> BLOCK_RIGHTS
 3. If channel is "print" and isbn is not "valid"      -> NEEDS_ISBN
 4. If channel is "print" and length is "micro"        -> BLOCK_LENGTH
 5. If ai_art is "yes"                                 -> NEEDS_AI_DISCLOSURE
 6. If age_rating is "mature" and channel is "audio" or "serial"
                                                       -> NEEDS_AGE_GATE
 7. If art_status is "draft"                           -> NEEDS_ART
 8. If rights is "regional" and channel is "ebook"     -> NEEDS_TERRITORY_MAP
 9. Otherwise                                          -> PASS"""


def gold(rec):
    """The policy as executable ground truth. The verifier's oracle."""
    if rec["contract"] != "signed":
        return "BLOCK_CONTRACT"
    if rec["rights"] == "unknown":
        return "BLOCK_RIGHTS"
    if rec["channel"] == "print" and rec["isbn"] != "valid":
        return "NEEDS_ISBN"
    if rec["channel"] == "print" and rec["length"] == "micro":
        return "BLOCK_LENGTH"
    if rec["ai_art"] == "yes":
        return "NEEDS_AI_DISCLOSURE"
    if rec["age_rating"] == "mature" and rec["channel"] in ("audio", "serial"):
        return "NEEDS_AGE_GATE"
    if rec["art_status"] == "draft":
        return "NEEDS_ART"
    if rec["rights"] == "regional" and rec["channel"] == "ebook":
        return "NEEDS_TERRITORY_MAP"
    return "PASS"


def all_records():
    for combo in itertools.product(*[v for _, v in FIELDS]):
        yield dict(zip(NAMES, combo))


# Verification enumerates the input space UNIFORMLY (all 7,776 records, so the
# proof covers everything). Benchmark TRAFFIC is drawn from this realistic mix
# instead — most real submissions are well-formed, and under the uniform product
# distribution rule 1 alone fires on 2/3 of records, which would make a
# constant "BLOCK_CONTRACT" predictor look 67% accurate and flatter every
# baseline equally. The two distributions are kept separate and both reported.
TRAFFIC = {
    "contract":   {"signed": .88, "pending": .09, "none": .03},
    "rights":     {"worldwide": .62, "regional": .30, "unknown": .08},
    "channel":    {"ebook": .45, "print": .25, "audio": .15, "serial": .15},
    "isbn":       {"valid": .70, "missing": .22, "invalid": .08},
    "length":     {"micro": .05, "short": .20, "standard": .55, "long": .20},
    "ai_art":     {"yes": .18, "no": .82},
    "age_rating": {"general": .45, "teen": .35, "mature": .20},
    "art_status": {"none": .25, "draft": .30, "final": .45},
}

# Enum values the policy was never compiled for — a new channel, a disputed
# contract, a rights state legal added last week. These MUST escalate.
UNSEEN_VALUES = {
    "channel":    ["podcast", "webtoon"],
    "contract":   ["disputed", "expired"],
    "rights":     ["reverted"],
    "age_rating": ["adult"],
    "isbn":       ["pending_agency"],
    "art_status": ["licensed"],
}


def sample_record(rng):
    return {n: rng.choice(list(TRAFFIC[n]), p=list(TRAFFIC[n].values()))
            for n in NAMES}


def sample_ood_record(rng):
    """A realistic record carrying one value the compiled policy never saw."""
    rec = sample_record(rng)
    f = str(rng.choice(list(UNSEEN_VALUES)))
    rec[f] = str(rng.choice(UNSEEN_VALUES[f]))
    return rec


def tokens(rec):
    """A record as the token stream a field-sequential program reads."""
    return [f"{n}={rec[n]}" for n in NAMES]


VOCAB = [f"{n}={v}" for n, vals in FIELDS for v in vals]


# ═════════════════════════════════════════════════════════════════════════════
# REFERENCE PROGRAM — the minimal automaton, built by residual equivalence.
# Used as a no-API control and to report how small the true program is; the
# benchmark's actual programs are authored by models and verified against gold.
# ═════════════════════════════════════════════════════════════════════════════
def _signature(prefix):
    """Verdicts over every completion of `prefix` — its Myhill-Nerode residual.

    Two prefixes with equal signatures are indistinguishable by any suffix, so
    they are the same state. Collapsing on this yields the MINIMAL automaton.
    """
    k = len(prefix)
    return tuple(gold(dict(zip(NAMES, prefix + suf)))
                 for suf in itertools.product(*[v for _, v in FIELDS[k:]]))


def reference_dfa():
    start_sig = _signature(())
    levels = [{start_sig: ()}]                 # signature -> a representative prefix
    trans, names = {}, {start_sig: "q0"}
    for k, (fname, values) in enumerate(FIELDS):
        nxt = {}
        for sig, prefix in levels[k].items():
            for v in values:
                child = _signature(prefix + (v,))
                if child not in nxt:
                    nxt[child] = prefix + (v,)
                    names[child] = f"q{k + 1}_{len(nxt) - 1}"
                trans[(names[sig], f"{fname}={v}")] = names[child]
        levels.append(nxt)
    out = {names[sig]: sig[0] for sig in levels[-1]}     # leaf: a single verdict
    return "q0", trans, out


# ═════════════════════════════════════════════════════════════════════════════
# VERIFIER — the model's program must match the policy on ALL 7,776 records
# ═════════════════════════════════════════════════════════════════════════════
def run_pure(start, trans, out, rec):
    """Execute a transition table directly (no store) — the verification path."""
    s = start
    for t in tokens(rec):
        s = trans.get((s, t))
        if s is None:
            return None
    return out.get(s)


def verify(start, trans, out, limit_examples=3):
    """Exhaustive check. Returns (ok, accuracy, counterexamples)."""
    bad, n_ok = [], 0
    for rec in all_records():
        got, want = run_pure(start, trans, out, rec), gold(rec)
        if got == want:
            n_ok += 1
        elif len(bad) < limit_examples:
            bad.append({"record": rec, "expected": want, "got": got})
    return n_ok == N_RECORDS, n_ok / N_RECORDS, bad


# ═════════════════════════════════════════════════════════════════════════════
# THE STORE — same task-agnostic interpreter shape as bench_program_family
# ═════════════════════════════════════════════════════════════════════════════
def load_slate(start, trans, out, seed=0, n_cells=2048, margin_floor=None):
    s = Slate(DIMK, n_cells=n_cells, beta=35.0, seed=seed, margin_floor=margin_floor)
    for (st, tok), nxt in trans.items():
        s.commit(key("T", st, tok), payload=("T", nxt), id=f"T/{st}/{tok}",
                 symbols=("T", st, tok))
    for st, v in out.items():
        s.commit(key("O", st, "PAD"), payload=("O", v), id=f"O/{st}",
                 symbols=("O", st, "PAD"))
    return s


def interpret(store, start, toks, sigma=0.0, rng=None):
    """ONE interpreter, zero policy logic. Returns (verdict, escalation signals).

    Two independent escalation signals come back, because there are two
    different ways a request can be out of distribution:

      unknown_symbols  a field value the program was never compiled for. This
                       is a FACT — the token was never committed — so it is
                       checked exactly, with no threshold and no calibration.
      min_margin       every symbol is known but their COMBINATION is not, or
                       the cue arrived corrupted. Nothing structural is wrong,
                       so this one genuinely needs a threshold.
    """
    st, margins, fams, rejects, unknown = start, [], [], 0, 0
    for tok in list(toks) + [None]:
        syms = ("O", st, "PAD") if tok is None else ("T", st, tok)
        unknown += (not store.knows(*syms))
        cue = key(*syms)
        if sigma:
            cue = cue + sigma * rng.standard_normal(DIMK).astype(np.float32)
        r = store.recall(cue)
        margins.append(r["margin"]); fams.append(r["familiarity"])
        rejects += (not r["accepted"])
        kind, val = r["winner"]["payload"]
        sig = {"min_margin": min(margins), "min_fam": min(fams),
               "n_reject": rejects, "unknown_symbols": unknown}
        if tok is None:
            return (val if kind == "O" else None), sig
        if kind != "T":
            return None, sig
        st = val


# ═════════════════════════════════════════════════════════════════════════════
def n_states(start, trans, out):
    return len({start} | {s for s, _ in trans} | set(trans.values()) | set(out))


if __name__ == "__main__":
    print(f"schema: {len(FIELDS)} fields, {N_RECORDS} enumerable records, "
          f"{len(VERDICTS)} verdicts, {len(VOCAB)} value tokens")
    rng = np.random.default_rng(0)
    uni, traf = {}, {}
    for rec in all_records():
        uni[gold(rec)] = uni.get(gold(rec), 0) + 1
    for _ in range(200_000):
        g = gold(sample_record(rng))
        traf[g] = traf.get(g, 0) + 1
    print(f"{'verdict':<24}{'uniform':>12}{'traffic mix':>14}")
    for v in VERDICTS:
        print(f"  {v:<22}{uni.get(v, 0) / N_RECORDS:>10.1%}"
              f"{traf.get(v, 0) / 200_000:>13.1%}")
    maj_u = max(uni.values()) / N_RECORDS
    maj_t = max(traf.values()) / 200_000

    start, trans, out = reference_dfa()
    ok, acc, bad = verify(start, trans, out)
    print(f"\nminimal reference automaton: {n_states(start, trans, out)} states, "
          f"{len(trans) + len(out)} rules")
    print(f"  exhaustive verification vs the policy: {acc:.1%} "
          f"({'EXACT' if ok else 'FAILED'})")
    print(f"  majority-class baseline: uniform {maj_u:.1%} / traffic {maj_t:.1%}")

    store = load_slate(start, trans, out, seed=0)
    sample = [sample_record(rng) for _ in range(400)]
    clean = np.mean([interpret(store, start, tokens(r))[0] == gold(r) for r in sample])
    noisy = np.mean([interpret(store, start, tokens(r), 0.75, rng)[0] == gold(r)
                     for r in sample])
    ood = [sample_ood_record(rng) for _ in range(400)]
    om = [interpret(store, start, tokens(r))[1]["min_margin"] for r in ood]
    im = [interpret(store, start, tokens(r))[1]["min_margin"] for r in sample]
    print(f"  executed from the Slate store, 400 records: clean {clean:.1%}  "
          f"noisy(sigma=0.75) {noisy:.1%}")
    print(f"  min-margin: in-distribution {np.mean(im):.3f}  "
          f"unseen-enum records {np.mean(om):.3f}  (separation is what gates "
          f"escalation)")
    json.dump({"n_records": N_RECORDS, "uniform_base_rates": uni,
               "traffic_base_rates": {k: v / 200_000 for k, v in traf.items()},
               "majority_uniform": maj_u, "majority_traffic": maj_t,
               "reference_states": n_states(start, trans, out),
               "reference_rules": len(trans) + len(out),
               "reference_verified": ok}, open("results_preflight_domain.json", "w"),
              indent=1)
