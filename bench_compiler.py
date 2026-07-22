"""THE AGENT SKILL COMPILER — end to end, on a real workflow.

  1. a model receives the publishing-preflight policy in prose
  2. it emits a constrained transition program (JSON: start / transition / output)
  3. a verifier checks that program against the policy on ALL 7,776 records
  4. only a program that verifies EXACTLY is stored in Slate
  5. N repeated decisions then execute from the store with NO further model call
  6. requests carrying values the program never saw ESCALATE back to the model

Steps 1-4 are run for every model available here, because a compiler that only
works with one vendor's model is worth much less than one where the verifier,
not the author, is what makes the output trustworthy.

What is measured at scale: model calls avoided, latency (measured, not modelled),
cost (measured tokens x public list price), task accuracy against gold, and
escalation rate — split into requests correctly escalated and requests wrongly
answered. Escalated requests are charged a real model call at the real measured
per-call latency and cost, so the savings are net, not gross.

  python bench_compiler.py --smoke   # no API: reference program, full pipeline
  python bench_compiler.py           # full: every available model authors it
"""
import argparse
import json
import time

import numpy as np

import authors
import preflight as pf
from preflight import (FIELDS, NAMES, N_RECORDS, POLICY_TEXT, VERDICTS, gold,
                       interpret, load_slate, n_states, reference_dfa,
                       sample_ood_record, sample_record, tokens, verify)

PROMPT = """\
You are compiling a business policy into a deterministic finite automaton (DFA).

The automaton reads ONE RECORD as a sequence of exactly {nf} tokens, always in \
this field order:
{order}

Each token has the form "field=value". The complete token vocabulary is:
{vocab}

THE POLICY TO COMPILE:
{policy}

After reading all {nf} tokens the automaton must be in a state whose output is \
the verdict for that record. The valid verdicts are:
{verdicts}

Return a JSON object with exactly these keys:
  "start":      the start state (a string)
  "transition": an object mapping "STATE,field=value" -> "NEWSTATE".
                Every state must have a transition for EVERY value of the field \
it reads at that position.
  "output":     an object mapping each final state -> one verdict string.

The automaton must be EXACTLY correct for all {n} possible records. Remember \
that the rules are PRIORITY-ORDERED: an earlier rule wins over a later one, so \
a state must carry forward whatever earlier facts later rules still need.
Return the JSON object. Do not include commentary after it."""


def build_prompt():
    order = "\n".join(f"  {i + 1}. {n}   (values: {', '.join(v)})"
                      for i, (n, v) in enumerate(FIELDS))
    return PROMPT.format(nf=len(FIELDS), order=order,
                         vocab="  " + ", ".join(pf.VOCAB), policy=POLICY_TEXT,
                         verdicts="  " + ", ".join(VERDICTS), n=N_RECORDS)


def parse_program(obj):
    if not isinstance(obj, dict) or not {"start", "transition", "output"} <= set(obj):
        return None
    try:
        trans = {}
        for k, v in obj["transition"].items():
            st, tok = k.split(",", 1)
            trans[(st.strip(), tok.strip())] = str(v)
        return (str(obj["start"]), trans,
                {str(k): str(v) for k, v in obj["output"].items()})
    except Exception:  # noqa: BLE001
        return None


# ═════════════════════════════════════════════════════════════════════════════
# STEPS 1-4 — author, then verify exhaustively
# ═════════════════════════════════════════════════════════════════════════════
def author_and_verify(model, prompt, attempts):
    rows = []
    for i in range(attempts):
        rec = {"attempt": i}
        try:
            raw, tin, tout, secs = authors.ask(model, prompt)
        except Exception as e:  # noqa: BLE001
            rows.append({**rec, "status": "api_error", "error": str(e)[:200]})
            continue
        rec.update({"seconds": round(secs, 2), "in_tokens": tin,
                    "out_tokens": tout,
                    "usd": round(authors.cost(model["name"], tin, tout), 4)})
        prog = parse_program(authors.extract_json(raw))
        if prog is None:
            rows.append({**rec, "status": "malformed", "raw_head": (raw or "")[:400]})
            continue
        start, trans, out = prog
        ok, acc, bad = verify(start, trans, out)
        rec.update({"status": "verified" if ok else "wrong",
                    "exhaustive_accuracy": round(acc, 4),
                    "states": n_states(start, trans, out),
                    "rules": len(trans) + len(out)})
        if ok:
            rec["program"] = {"start": start,
                              "transition": {f"{s},{t}": n for (s, t), n in trans.items()},
                              "output": out}
        else:
            rec["counterexamples"] = bad
        rows.append(rec)
    return rows


# ═════════════════════════════════════════════════════════════════════════════
# STEP 5-6 — the at-scale run
# ═════════════════════════════════════════════════════════════════════════════
def measure_model_baseline(model, n, rng, max_tokens=300):
    """What direct LLM execution actually costs — measured, not assumed.

    Run on a sample; the at-scale figures extrapolate from these measured
    per-call numbers and are labelled as extrapolations wherever reported.
    """
    recs = [sample_record(rng) for _ in range(n)]
    lat, usd, ok, err = [], [], [], 0
    for r in recs:
        q = (f"{POLICY_TEXT}\n\nRecord:\n"
             + "\n".join(f"  {k} = {r[k]}" for k in NAMES)
             + "\n\nReply with ONLY the verdict token, nothing else.")
        try:
            raw, tin, tout, secs = authors.ask(model, q, max_tokens=max_tokens)
        except Exception:  # noqa: BLE001
            err += 1
            continue
        lat.append(secs); usd.append(authors.cost(model["name"], tin, tout))
        pred = next((v for v in VERDICTS if v in (raw or "")), None)
        ok.append(pred == gold(r))
    return {"n": len(lat), "errors": err,
            "accuracy": round(float(np.mean(ok)), 4) if ok else None,
            "latency_ms_median": round(float(np.median(lat)) * 1000, 1) if lat else None,
            "latency_ms_p90": round(float(np.percentile(lat, 90)) * 1000, 1) if lat else None,
            "usd_per_call": round(float(np.mean(usd)), 6) if usd else None}


def at_scale(program, n, ood_share, thresh, rng, sigma, per_call):
    """N decisions through the compiled program, with escalation.

    `per_call` are the MEASURED direct-model latency/cost figures; escalated
    requests are charged them, so what is reported is the NET saving.
    """
    start, trans, out = program
    store = load_slate(start, trans, out, seed=0)
    n_ood = int(round(n * ood_share))
    recs = ([(sample_record(rng), True) for _ in range(n - n_ood)]
            + [(sample_ood_record(rng), False) for _ in range(n_ood)])
    rng.shuffle(recs)

    lat, escalated, answered_ok, answered = [], 0, 0, 0
    wrong_answered_ood, correctly_escalated, id_escalated = 0, 0, 0
    by_structure, by_margin = 0, 0
    t_all = time.perf_counter()
    for rec, is_id in recs:
        t0 = time.perf_counter()
        verdict, sig = interpret(store, start, tokens(rec), sigma, rng)
        lat.append(time.perf_counter() - t0)
        # Structural first: an uncommitted token is out of distribution as a
        # fact, so it never reaches the fitted threshold at all.
        novel = sig["unknown_symbols"] > 0
        if novel or sig["min_margin"] < thresh:        # -> escalate to the model
            escalated += 1
            by_structure += novel
            by_margin += (not novel)
            correctly_escalated += (not is_id)
            id_escalated += is_id
            continue
        answered += 1
        if is_id:
            answered_ok += (verdict == gold(rec))
        else:
            wrong_answered_ood += 1                    # answered a record it
            #                                            had no program for
    wall = time.perf_counter() - t_all

    slate_usd = 0.0                                    # CPU only, no per-call fee
    esc_usd = escalated * (per_call["usd_per_call"] or 0.0)
    baseline_usd = n * (per_call["usd_per_call"] or 0.0)
    esc_ms = (per_call["latency_ms_median"] or 0.0)
    return {
        "n_decisions": n, "ood_share": ood_share,
        "model_calls_made": escalated, "model_calls_avoided": n - escalated,
        "call_reduction": round(1 - escalated / n, 4),
        "escalation_rate": round(escalated / n, 4),
        "escalation_correct": correctly_escalated, "escalation_of_ood_traffic":
            round(correctly_escalated / max(n_ood, 1), 4),
        "escalated_by_unknown_symbol": by_structure,
        "escalated_by_margin_threshold": by_margin,
        "in_dist_escalated": id_escalated,
        "in_dist_escalation_rate": round(id_escalated / max(n - n_ood, 1), 4),
        "answered": answered,
        "answered_accuracy": round(answered_ok / max(answered, 1), 4),
        "ood_answered_without_a_program": wrong_answered_ood,
        "slate_latency_ms_median": round(float(np.median(lat)) * 1000, 4),
        "slate_latency_ms_p99": round(float(np.percentile(lat, 99)) * 1000, 4),
        "slate_decisions_per_second": round(len(lat) / wall, 1),
        "end_to_end_latency_ms_median": round(
            float(np.median(lat)) * 1000 * (1 - escalated / n)
            + esc_ms * (escalated / n), 2),
        "usd_total": round(slate_usd + esc_usd, 4),
        "usd_all_model_baseline_extrapolated": round(baseline_usd, 4),
        "usd_saved": round(baseline_usd - esc_usd, 4),
        "cost_reduction": round(1 - esc_usd / baseline_usd, 4) if baseline_usd else None,
    }


# ═════════════════════════════════════════════════════════════════════════════
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", action="store_true", help="no API; reference program")
    ap.add_argument("--reuse-program", action="store_true",
                    help="skip authoring; reuse the verified program on disk")
    ap.add_argument("--sweep", default="0.02,0.05,0.10,0.15,0.30,0.50",
                    help="ood shares to sweep, to show what sets call reduction")
    ap.add_argument("--attempts", type=int, default=5, help="authoring tries/model")
    ap.add_argument("--n", type=int, default=100_000, help="decisions at scale")
    ap.add_argument("--ood-share", type=float, default=0.15)
    ap.add_argument("--sigma", type=float, default=0.0, help="cue noise at scale")
    ap.add_argument("--n-cal", type=int, default=2000, help="threshold calibration")
    ap.add_argument("--q", type=float, default=0.01)
    ap.add_argument("--n-model-sample", type=int, default=60,
                    help="direct-LLM calls sampled for the latency/cost baseline")
    ap.add_argument("--baseline-model", default="claude-haiku-4-5")
    ap.add_argument("--out", default="results_compiler.json")
    a = ap.parse_args()
    rng = np.random.default_rng(11)
    results = {"config": vars(a), "domain": {
        "records": N_RECORDS, "fields": len(FIELDS), "verdicts": len(VERDICTS)}}

    # ── steps 1-4: author + verify ───────────────────────────────────────────
    prompt = build_prompt()
    results["prompt"] = prompt
    if a.smoke:
        start, trans, out = reference_dfa()
        ok, acc, _ = verify(start, trans, out)
        print(f"[smoke] reference program verifies exactly: {ok} ({acc:.1%})")
        results["authoring"] = {"reference": {"verified": ok}}
        program = (start, trans, out)
    elif a.reuse_program:
        prev = json.load(open(a.out))
        p = next(r["program"] for rows in prev["authoring"].values()
                 for r in rows["rows"] if r["status"] == "verified")
        program = (p["start"],
                   {tuple(k.split(",", 1)): v for k, v in p["transition"].items()},
                   p["output"])
        results["authoring"] = prev["authoring"]
        results["program_source"] = prev.get("program_source")
        results["skipped_models"] = prev.get("skipped_models")
        ok, acc, _ = verify(*program)
        print(f"reusing the {results['program_source']} program — "
              f"re-verified {acc:.1%} ({'EXACT' if ok else 'FAILED'})")
    else:
        runnable = [m for m in authors.MODELS if authors.available(m)]
        skipped = [m["name"] for m in authors.MODELS if m not in runnable]
        print(f"authoring with {len(runnable)} model(s): "
              f"{', '.join(m['name'] for m in runnable)}")
        if skipped:
            print(f"  NOT RUN (no credential/endpoint here): {', '.join(skipped)}")
        results["authoring"], best = {}, None
        for m in runnable:
            print(f"  {m['name']} x{a.attempts} ...", flush=True)
            rows = author_and_verify(m, prompt, a.attempts)
            n_ok = sum(r["status"] == "verified" for r in rows)
            results["authoring"][m["name"]] = {
                "org": m["org"], "where": m["where"], "attempts": a.attempts,
                "verified": n_ok, "reliability": round(n_ok / a.attempts, 3),
                "usd": round(sum(r.get("usd", 0) for r in rows), 4),
                "seconds_median": round(float(np.median(
                    [r["seconds"] for r in rows if "seconds" in r])), 2)
                    if any("seconds" in r for r in rows) else None,
                "rows": rows}
            st = {}
            for r in rows:
                st[r["status"]] = st.get(r["status"], 0) + 1
            print(f"    verified {n_ok}/{a.attempts}   {st}")
            if n_ok and best is None:
                best = next(r for r in rows if r["status"] == "verified")
                results["program_source"] = m["name"]
        if best is None:
            raise SystemExit("no model produced a program that verified — "
                             "nothing may be stored. That IS the result.")
        p = best["program"]
        program = (p["start"],
                   {tuple(k.split(",", 1)): v for k, v in p["transition"].items()},
                   p["output"])
        results["skipped_models"] = skipped

    start, trans, out = program
    print(f"\nstored program: {n_states(start, trans, out)} states, "
          f"{len(trans) + len(out)} rules (verified on all {N_RECORDS} records)")

    # ── escalation threshold, calibrated on held-out in-distribution traffic ──
    store = load_slate(start, trans, out, seed=0)
    cal = [interpret(store, start, tokens(sample_record(rng)), a.sigma, rng)[1]
           ["min_margin"] for _ in range(a.n_cal)]
    thresh = float(np.quantile(cal, a.q))
    print(f"escalation threshold (min-margin, {a.q:.0%} quantile of {a.n_cal} "
          f"held-out in-dist requests): {thresh:.4f}")
    results["escalation_threshold"] = thresh

    # ── the direct-model baseline, measured ──────────────────────────────────
    if a.smoke:
        per_call = {"accuracy": None, "latency_ms_median": 800.0,
                    "latency_ms_p90": None, "usd_per_call": 0.0004, "n": 0,
                    "errors": 0, "NOTE": "smoke: placeholder, not measured"}
    else:
        bm = next(m for m in authors.MODELS if m["name"] == a.baseline_model)
        print(f"measuring direct-{a.baseline_model} execution on "
              f"{a.n_model_sample} records ...", flush=True)
        per_call = measure_model_baseline(bm, a.n_model_sample, rng)
        print(f"  accuracy {per_call['accuracy']}  median "
              f"{per_call['latency_ms_median']} ms  ${per_call['usd_per_call']:.6f}/call")
    results["direct_model_per_call"] = {"model": a.baseline_model, **per_call}

    # ── the at-scale run ─────────────────────────────────────────────────────
    print(f"\nrunning {a.n:,} decisions ({a.ood_share:.0%} carrying an enum value "
          f"the program was never compiled for) ...", flush=True)
    sc = at_scale(program, a.n, a.ood_share, thresh, rng, a.sigma, per_call)
    results["at_scale"] = sc
    with open(a.out, "w") as f:
        json.dump(results, f, indent=1)

    W = 74
    print("\n" + "=" * W)
    print(f"AT SCALE — {sc['n_decisions']:,} preflight decisions")
    print("=" * W)
    print(f"  model calls avoided       {sc['model_calls_avoided']:,} / "
          f"{sc['n_decisions']:,}  ({sc['call_reduction']:.1%})")
    print(f"  escalation rate           {sc['escalation_rate']:.1%}  "
          f"(traffic was {sc['ood_share']:.0%} unfamiliar)")
    print(f"    unfamiliar escalated    {sc['escalation_of_ood_traffic']:.1%}   "
          f"(want ~100%)")
    print(f"    in-dist escalated       {sc['in_dist_escalation_rate']:.1%}   "
          f"(the false-alarm cost)")
    print(f"    unfamiliar ANSWERED     {sc['ood_answered_without_a_program']}   "
          f"(silent-wrong-answer count; want 0)")
    print(f"    caught by structure     {sc['escalated_by_unknown_symbol']:,}"
          f"   (uncommitted token — exact, no threshold)")
    print(f"    caught by margin        {sc['escalated_by_margin_threshold']:,}"
          f"   (all tokens known, combination/cue was not)")
    print(f"  accuracy on answered      {sc['answered_accuracy']:.2%}")
    print(f"  latency, Slate path       median {sc['slate_latency_ms_median']:.3f} ms  "
          f"p99 {sc['slate_latency_ms_p99']:.3f} ms")
    print(f"                            {sc['slate_decisions_per_second']:,.0f} "
          f"decisions/sec, single CPU core")
    print(f"  latency, end to end       {sc['end_to_end_latency_ms_median']:.1f} ms  "
          f"(vs {per_call['latency_ms_median']} ms all-model)")
    print(f"  cost                      ${sc['usd_total']:.2f}  vs "
          f"${sc['usd_all_model_baseline_extrapolated']:.2f} all-model "
          f"[extrapolated from {per_call['n']} measured calls]")
    if sc["cost_reduction"] is not None:
        print(f"                            {sc['cost_reduction']:.1%} cost reduction")

    # ── what actually sets the headline number ───────────────────────────────
    shares = [float(s) for s in a.sweep.split(",")] if a.sweep else []
    if shares:
        n_s = min(a.n, 20_000)
        print("\n" + "=" * W)
        print(f"CALL REDUCTION vs TRAFFIC MIX ({n_s:,} decisions each)")
        print("=" * W)
        print(f"  {'unfamiliar share':>18}{'call reduction':>17}{'accuracy':>11}"
              f"{'unfam. escalated':>18}{'silently answered':>19}")
        sweep = []
        for s in shares:
            r = at_scale(program, n_s, s, thresh, rng, a.sigma, per_call)
            sweep.append(r)
            print(f"  {s:>17.0%}{r['call_reduction']:>17.1%}"
                  f"{r['answered_accuracy']:>11.2%}"
                  f"{r['escalation_of_ood_traffic']:>18.1%}"
                  f"{r['ood_answered_without_a_program']:>19}")
        results["sweep_ood_share"] = sweep
        print("\n  Read this before quoting the headline: call reduction tracks "
              "1 - unfamiliar\n  share almost exactly, so it is set by the TRAFFIC "
              "MIX, not by Slate. What\n  Slate is responsible for is the two "
              "right-hand columns holding while it moves.")
        with open(a.out, "w") as f:
            json.dump(results, f, indent=1)
    print(f"\nDONE -> {a.out}")


if __name__ == "__main__":
    main()
