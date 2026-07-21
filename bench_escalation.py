"""STEP 1 of the agent-skill-compiler benchmark — is the abstain flag safe?

The compiler pipeline is: a frontier model compiles a task spec into a verified
finite-state program -> Slate stores it -> many similar requests execute with NO
further model call -> UNFAMILIAR requests escalate back to the model. Everything
downstream rests on that last clause. If the store answers confidently on a
request no stored program covers, the system is silently wrong at scale — the
one failure mode that makes it undeployable. So this is measured FIRST, before
anything is built on top.

`core.Slate.recall` already exposes the primitive: `accepted` is False when the
pre-settle familiarity (best overlap) is below `settle_floor`. The prior from
slate-bench's limits battery (results_calibration.json, a TEXT-retrieval corpus)
was: far-OOD detection near-perfect (AUC 1.00), near-OOD detection weak
(familiarity AUC 0.611, margin 0.656). Whether that carries to STRUCTURED
procedure cues — concatenated symbol slots, not sentence embeddings — is an
open question, and it is the question here.

We load the 48 model-authored DFAs that `bench_synthesis.py` already verified
exhaustively against gold (all 4096 inputs), pour them into ONE skill-library
Slate, and probe it with in-distribution, near-OOD and far-OOD cues at two
levels:

  RULE level     one lookup — does this cue hit a stored rule?
  REQUEST level  a whole 13-step trajectory — is there a stored skill for this
                 request at all? This is the level that actually gates the
                 model call, so it is the level the safety property lives at.

Reported for each signal: ROC/AUC, the accept-rate at the SHIPPED threshold
(the operating point the flag actually implements — AUC is threshold-free and
can hide a badly-placed threshold), and a risk-coverage curve.

Standalone lab cube; never touches the production substrate. No API key.
Run: python bench_escalation.py
"""
import argparse
import json
import os

import numpy as np
from core import Slate
from procedure import key, sym, D

NBITS = 12
DIMK = 4 * D                     # cues are 4 symbol slots: program, kind, state, symbol
SYNTH = "results_synthesis.json"


# ═════════════════════════════════════════════════════════════════════════════
# the skill library — every verified program in ONE store, namespaced
# ═════════════════════════════════════════════════════════════════════════════
def load_programs(path=SYNTH):
    """The model-authored DFAs bench_synthesis.py verified on all 4096 inputs."""
    if not os.path.exists(path):
        raise SystemExit(f"{path} not found — run bench_synthesis.py first "
                         "(it holds the verified model-authored programs).")
    rows = [r for r in json.load(open(path))["rows"] if r["status"] == "correct"]
    progs = []
    for r in rows:
        d = r["dfa"]
        trans = {}
        for k, v in d["transition"].items():
            st, b = [p.strip() for p in k.split(",")]
            trans[(st, int(b))] = str(v)
        progs.append({"id": r["id"], "start": str(d["start"]), "trans": trans,
                      "out": {str(k): int(v) for k, v in d["output"].items()}})
    return progs


def build_library(progs, seed, n_cells=4096, beta=35.0, settle_floor=0.12):
    lib = Slate(DIMK, n_cells=n_cells, beta=beta, seed=seed,
                settle_floor=settle_floor)
    for pi, p in enumerate(progs):
        for (st, b), nxt in p["trans"].items():
            lib.commit(key(f"P{pi}", "T", st, f"B{b}"), payload=("T", nxt),
                       id=f"P{pi}/T/{st}/B{b}")
        for st, o in p["out"].items():
            lib.commit(key(f"P{pi}", "O", st, "PAD"), payload=("O", int(o)),
                       id=f"P{pi}/O/{st}")
    return lib


def presettle(lib, cue):
    """(familiarity, margin) — the two PRE-settle signals `recall` reports.

    `confidence` is post-settle once recall accepts, so it is NOT the quantity
    the flag thresholded; `familiarity` is. Both signals are scored on the same
    footing here.
    """
    r = lib.recall(cue)
    return r["familiarity"], r["margin"]


# ═════════════════════════════════════════════════════════════════════════════
# metrics
# ═════════════════════════════════════════════════════════════════════════════
def auc(pos, neg):
    """Rank AUC = P(score(pos) > score(neg)), ties counted as 0.5."""
    pos, neg = np.asarray(pos, float), np.asarray(neg, float)
    if not len(pos) or not len(neg):
        return float("nan")
    allv = np.concatenate([pos, neg])
    r = np.empty(len(allv))
    order = np.argsort(allv, kind="mergesort")
    sv = allv[order]
    i = 0
    while i < len(sv):                       # average ranks within tie groups
        j = i
        while j + 1 < len(sv) and sv[j + 1] == sv[i]:
            j += 1
        r[order[i:j + 1]] = (i + j) / 2.0 + 1.0
        i = j + 1
    rp = r[:len(pos)].sum()
    return float((rp - len(pos) * (len(pos) + 1) / 2.0) / (len(pos) * len(neg)))


def ms(v):
    return round(float(np.mean(v)), 4), round(float(np.std(v)), 4)


# ═════════════════════════════════════════════════════════════════════════════
# RULE-LEVEL cue populations
# ═════════════════════════════════════════════════════════════════════════════
def rule_probes(progs, rng, n, sigma):
    """Six populations. ID must be answered; every OOD population must escalate.

    near-OOD is built from IN-VOCABULARY symbols in never-stored COMBINATIONS —
    the realistic near-miss (a new enum value, a state from another skill). It
    shares 3 of 4 cue slots with stored rules, which is the hard case.
    """
    P = len(progs)
    states = [sorted(p["out"].keys()) for p in progs]
    vocab = sorted({s for ss in states for s in ss})
    pops = {k: [] for k in ("id_clean", "id_noisy", "near_unseen_symbol",
                            "near_foreign_state", "near_wrong_program", "far_ood")}

    for _ in range(n):
        pi = int(rng.integers(P))
        st = states[pi][int(rng.integers(len(states[pi])))]
        b = int(rng.integers(2))
        base = key(f"P{pi}", "T", st, f"B{b}")

        pops["id_clean"].append(base)
        pops["id_noisy"].append(
            base + sigma * rng.standard_normal(DIMK).astype(np.float32))

        # a third input symbol the program was never compiled for (new enum value)
        pops["near_unseen_symbol"].append(key(f"P{pi}", "T", st, "B2"))

        # a state name that exists in the vocabulary, but not in THIS program
        foreign = [s for s in vocab if s not in states[pi]]
        pops["near_foreign_state"].append(
            key(f"P{pi}", "T", foreign[int(rng.integers(len(foreign)))], f"B{b}"))

        # right slot-shape, wrong skill: this state belongs to another program
        cands = [j for j in range(P) if st not in states[j]]
        if cands:
            pj = cands[int(rng.integers(len(cands)))]
            pops["near_wrong_program"].append(key(f"P{pj}", "T", st, f"B{b}"))

        # nothing in any slot was ever committed
        t = int(rng.integers(1 << 30))
        pops["far_ood"].append(
            key(f"ZP{t}", f"ZK{t}", f"ZS{t}", f"ZB{t}"))
    return pops


# ═════════════════════════════════════════════════════════════════════════════
# REQUEST-LEVEL trajectories — the level that gates the model call
# ═════════════════════════════════════════════════════════════════════════════
def run_request(lib, pi, start, stream, sigma, rng):
    """Execute one request; return the verdict plus the trajectory's aggregates.

    A request is only as familiar as its LEAST familiar step, so the escalation
    signal is the min over the trajectory — one unrecognised step is enough to
    mean 'no stored skill covers this'.
    """
    st, fams, margins, rejects, verdict = start, [], [], 0, None

    def step(cue):
        nonlocal rejects
        if sigma:
            cue = cue + sigma * rng.standard_normal(DIMK).astype(np.float32)
        r = lib.recall(cue)
        fams.append(r["familiarity"]); margins.append(r["margin"])
        rejects += (not r["accepted"])
        return r["winner"]["payload"]

    for symbol in stream:
        kind, val = step(key(f"P{pi}", "T", st, symbol))
        if kind != "T":                        # fell out of the transition table
            break
        st = val
    else:
        kind, val = step(key(f"P{pi}", "O", st, "PAD"))
        verdict = val if kind == "O" else None
    return {"verdict": verdict, "fams": fams, "min_fam": min(fams),
            "min_margin": min(margins), "n_reject": rejects}


def bits(x):
    return [f"B{(x >> i) & 1}" for i in range(NBITS - 1, -1, -1)]


REQ_POPS = ["id", "ood_unseen_value", "ood_unknown_skill", "ood_far", "misroute"]
INPUT_OOD = REQ_POPS[1:4]        # unfamiliar INPUT — what escalation should catch


def request_probes(lib, progs, golds, rng, n, sigma):
    """ID requests (answerable), three unfamiliar-INPUT kinds, and a mis-route."""
    P = len(progs)
    out = {}

    rows = []
    for _ in range(n):
        pi = int(rng.integers(P))
        x = int(rng.integers(4096))
        r = run_request(lib, pi, progs[pi]["start"], bits(x), sigma, rng)
        r["correct"] = (r["verdict"] == golds[progs[pi]["id"]](x))
        rows.append(r)
    out["id"] = rows

    # a known skill fed a record with an out-of-alphabet value (a new enum)
    rows = []
    for _ in range(n):
        pi = int(rng.integers(P))
        stream = bits(int(rng.integers(4096)))
        for pos in rng.choice(NBITS, size=int(rng.integers(1, 4)), replace=False):
            stream[int(pos)] = "B2"
        r = run_request(lib, pi, progs[pi]["start"], stream, sigma, rng)
        r["correct"] = False                    # no stored program defines this
        rows.append(r)
    out["ood_unseen_value"] = rows

    # a skill that was never compiled at all
    rows = []
    for _ in range(n):
        pi = int(rng.integers(P))
        r = run_request(lib, 900 + int(rng.integers(99)), progs[pi]["start"],
                        bits(int(rng.integers(4096))), sigma, rng)
        r["correct"] = False
        rows.append(r)
    out["ood_unknown_skill"] = rows

    # nothing recognisable in any slot
    rows = []
    for _ in range(n):
        t = int(rng.integers(1 << 30))
        r = run_request(lib, 900 + int(rng.integers(99)), f"ZS{t}",
                        [f"ZB{t}"] * NBITS, sigma, rng)
        r["correct"] = False
        rows.append(r)
    out["ood_far"] = rows

    # THE CASE ESCALATION CANNOT SEE. The request needed skill A; skill B ran.
    # Every cue is a genuinely stored rule, so nothing is unfamiliar — the
    # substrate has no signal that the WRONG PROGRAM was selected. Included
    # deliberately: it bounds what an abstain flag can promise.
    rows = []
    for _ in range(n):
        pi, pj = rng.choice(P, size=2, replace=False)
        x = int(rng.integers(4096))
        r = run_request(lib, int(pj), progs[int(pj)]["start"], bits(x), sigma, rng)
        r["correct"] = (r["verdict"] == golds[progs[int(pi)]["id"]](x))
        rows.append(r)
    out["misroute"] = rows
    return out


def gate_stats(rows, signal, t):
    """Answer-rate and accuracy-on-answered for one population at threshold t."""
    s = np.array([r[signal] for r in rows])
    ok = np.array([r["correct"] for r in rows], bool)
    take = s >= t
    return {"answer_rate": float(take.mean()),
            "acc_on_answered": float(ok[take].mean()) if take.any() else float("nan")}


def mixture(stats, weights):
    """Deployment numbers under a STATED traffic mix, from per-population rates.

    Combined analytically rather than by resampling a mixture, so the mix is an
    explicit parameter a reader can vary rather than a hidden property of a draw.
    """
    cov = sum(w * stats[p]["answer_rate"] for p, w in weights.items())
    corr = sum(w * stats[p]["answer_rate"] * stats[p]["acc_on_answered"]
               for p, w in weights.items() if stats[p]["answer_rate"] > 0)
    return {"coverage": cov, "escalation_rate": 1.0 - cov,
            "acc_on_answered": (corr / cov) if cov > 0 else float("nan")}


# ═════════════════════════════════════════════════════════════════════════════
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", type=int, default=5)
    ap.add_argument("--n-rule", type=int, default=400, help="probes/population/seed")
    ap.add_argument("--n-req", type=int, default=120, help="requests/population/seed")
    ap.add_argument("--n-cal", type=int, default=120, help="held-out calibration requests")
    ap.add_argument("--sigma", type=float, default=0.75, help="noisy-read level")
    ap.add_argument("--ood-share", type=float, default=0.15,
                    help="fraction of traffic that is unfamiliar, for the mix")
    ap.add_argument("--q", type=float, default=0.01,
                    help="escalate this quantile of CALIBRATION in-dist traffic")
    ap.add_argument("--out", default="results_escalation.json")
    a = ap.parse_args()

    progs = load_programs()
    from bench_synthesis import specs
    golds = {pid: g for _, g, pid in specs()}
    n_rules = sum(len(p["trans"]) + len(p["out"]) for p in progs)
    print(f"skill library: {len(progs)} model-authored verified programs, "
          f"{n_rules} rules, ONE Slate\n"
          f"{a.seeds} seeds x {a.n_rule} rule probes and {a.n_req} requests per "
          f"population (sigma={a.sigma})\n", flush=True)

    RULE_POPS = ["id_clean", "id_noisy", "near_unseen_symbol",
                 "near_foreign_state", "near_wrong_program", "far_ood"]
    SIG = ["fam", "margin"]
    SIGMAS = [0.0, a.sigma]

    rule_auc = {s: {p: [] for p in RULE_POPS[2:]} for s in SIG}
    rule_acc = {p: [] for p in RULE_POPS}          # accept-rate at shipped floor
    req = {sg: {"auc": {s: {p: [] for p in REQ_POPS[1:]} for s in SIG},
                "shipped_answer": {p: [] for p in REQ_POPS},
                "gated": {s: {p: [] for p in REQ_POPS} for s in SIG},
                "thresh": {s: [] for s in SIG},
                "mix": {s: [] for s in SIG},
                "id_acc": [], "misroute_acc": [],
                "fam_drift": {p: [] for p in REQ_POPS}} for sg in SIGMAS}
    floor = None

    for seed in range(a.seeds):
        rng = np.random.default_rng(4000 + seed)
        lib = build_library(progs, seed=seed)
        floor = lib.settle_floor

        # ── rule level ───────────────────────────────────────────────────────
        pops = rule_probes(progs, rng, a.n_rule, a.sigma)
        sig = {}
        for name, cues in pops.items():
            fm = np.array([presettle(lib, c) for c in cues])
            sig[name] = {"fam": fm[:, 0], "margin": fm[:, 1]}
            rule_acc[name].append(float((fm[:, 0] >= floor).mean()))
        pooled = {s: np.concatenate([sig["id_clean"][s], sig["id_noisy"][s]])
                  for s in SIG}
        for p in RULE_POPS[2:]:
            for s in SIG:
                rule_auc[s][p].append(auc(pooled[s], sig[p][s]))

        # ── request level, clean and noisy reads ─────────────────────────────
        for sg in SIGMAS:
            R = req[sg]
            # threshold is fitted on a SEPARATE calibration draw of in-dist
            # traffic only — never on the evaluation set, never on OOD.
            cal = [run_request(lib, int(i), progs[int(i)]["start"],
                               bits(int(rng.integers(4096))), sg, rng)
                   for i in rng.integers(len(progs), size=a.n_cal)]
            thr = {s: float(np.quantile([c["min_" + s] for c in cal], a.q))
                   for s in SIG}
            for s in SIG:
                R["thresh"][s].append(thr[s])

            ev = request_probes(lib, progs, golds, rng, a.n_req, sg)
            for p in REQ_POPS:
                R["shipped_answer"][p].append(
                    float(np.mean([r["n_reject"] == 0 for r in ev[p]])))
                R["fam_drift"][p].append(
                    [float(np.mean([r["fams"][0] for r in ev[p]])),
                     float(np.mean([r["fams"][-1] for r in ev[p]]))])
            R["id_acc"].append(float(np.mean([r["correct"] for r in ev["id"]])))
            R["misroute_acc"].append(
                float(np.mean([r["correct"] for r in ev["misroute"]])))
            for p in REQ_POPS[1:]:
                for s in SIG:
                    R["auc"][s][p].append(auc([r["min_" + s] for r in ev["id"]],
                                              [r["min_" + s] for r in ev[p]]))
            for s in SIG:
                st = {p: gate_stats(ev[p], "min_" + s, thr[s]) for p in REQ_POPS}
                for p in REQ_POPS:
                    R["gated"][s][p].append(st[p]["answer_rate"])
                w = {"id": 1.0 - a.ood_share,
                     **{p: a.ood_share / len(INPUT_OOD) for p in INPUT_OOD}}
                R["mix"][s].append(mixture(st, w))
        print(f"  seed {seed} done", flush=True)

    def mixms(rows, k):
        return ms([r[k] for r in rows])

    results = {
        "config": vars(a), "n_programs": len(progs), "n_rules": n_rules,
        "settle_floor": floor,
        "rule_level": {
            "auc_vs_pooled_id": {s: {p: ms(v) for p, v in d.items()}
                                 for s, d in rule_auc.items()},
            "accept_rate_at_shipped_floor": {p: ms(v) for p, v in rule_acc.items()}},
        "request_level": {
            str(sg): {
                "auc_vs_id": {s: {p: ms(v) for p, v in d.items()}
                              for s, d in req[sg]["auc"].items()},
                "answer_rate_shipped_familiarity_flag":
                    {p: ms(v) for p, v in req[sg]["shipped_answer"].items()},
                "answer_rate_calibrated_gate":
                    {s: {p: ms(v) for p, v in d.items()}
                     for s, d in req[sg]["gated"].items()},
                "threshold": {s: ms(v) for s, v in req[sg]["thresh"].items()},
                "id_task_accuracy": ms(req[sg]["id_acc"]),
                "misroute_accuracy": ms(req[sg]["misroute_acc"]),
                "familiarity_first_vs_last_step":
                    {p: [ms([d[0] for d in v]), ms([d[1] for d in v])]
                     for p, v in req[sg]["fam_drift"].items()},
                "deployment_mix": {
                    s: {k: mixms(req[sg]["mix"][s], k)
                        for k in ("coverage", "escalation_rate", "acc_on_answered")}
                    for s in SIG}}
            for sg in SIGMAS}}
    with open(a.out, "w") as f:
        json.dump(results, f, indent=1)

    # ── report ───────────────────────────────────────────────────────────────
    W = 78
    print("\n" + "=" * W)
    print(f"RULE LEVEL — AUC separating each OOD population from in-distribution")
    print("=" * W)
    print(f"  {'population':<22}{'familiarity (the flag)':>26}{'margin':>18}")
    for p in RULE_POPS[2:]:
        f_m, f_s = ms(rule_auc["fam"][p]); m_m, m_s = ms(rule_auc["margin"][p])
        print(f"  {p:<22}{f_m:>18.3f}+/-{f_s:<5.3f}{m_m:>12.3f}+/-{m_s:<5.3f}")
    print(f"\n  accept-rate at the SHIPPED threshold (settle_floor={floor}) — "
          f"the flag as it stands:")
    for p in RULE_POPS:
        m, s = ms(rule_acc[p])
        want = "want ~1.0" if p.startswith("id") else "want ~0.0"
        print(f"    {p:<22}{m:>7.1%} +/-{s:<6.1%}  ({want})")

    for sg in SIGMAS:
        R = req[sg]
        print("\n" + "=" * W)
        print(f"REQUEST LEVEL (sigma={sg}) — the decision that gates the model call")
        print("=" * W)
        print(f"  {'population':<22}{'AUC min-familiarity':>24}{'AUC min-margin':>20}")
        for p in REQ_POPS[1:]:
            f_m, f_s = ms(R["auc"]["fam"][p]); m_m, m_s = ms(R["auc"]["margin"][p])
            tail = "   <- cannot be caught" if p == "misroute" else ""
            print(f"  {p:<22}{f_m:>16.3f}+/-{f_s:<5.3f}"
                  f"{m_m:>14.3f}+/-{m_s:<5.3f}{tail}")

        print(f"\n  answer-rate, SHIPPED familiarity flag (settle_floor={floor}):")
        for p in REQ_POPS:
            m, s = ms(R["shipped_answer"][p])
            print(f"    {p:<22}{m:>7.1%} +/-{s:<6.1%}  "
                  f"({'want ~1.0' if p in ('id', 'misroute') else 'want ~0.0'})")
        print(f"\n  answer-rate, CALIBRATED gates (threshold = the {a.q:.0%} quantile "
              f"of a HELD-OUT in-dist draw):")
        th = {s: ms(R["thresh"][s]) for s in SIG}
        print(f"    {'':<22}{'min-fam t=%.3f' % th['fam'][0]:>18}"
              f"{'min-margin t=%.3f' % th['margin'][0]:>20}")
        for p in REQ_POPS:
            f_m, f_s = ms(R["gated"]["fam"][p]); m_m, m_s = ms(R["gated"]["margin"][p])
            print(f"    {p:<22}{f_m:>11.1%} +/-{f_s:<4.1%}{m_m:>13.1%} +/-{m_s:<4.1%}"
                  f"  ({'want ~1.0' if p in ('id', 'misroute') else 'want ~0.0'})")

        m, s = ms(R["id_acc"]); mm, mss = ms(R["misroute_acc"])
        print(f"\n  in-distribution task accuracy : {m:.1%} +/-{s:.1%}")
        print(f"  mis-routed request accuracy   : {mm:.1%} +/-{mss:.1%}"
              f"   (answered with full confidence)")
        d = R["fam_drift"]
        print(f"  familiarity, first step -> last step (why the flag fails):")
        for p in ("id", "ood_far"):
            f0 = ms([x[0] for x in d[p]])[0]; f1 = ms([x[1] for x in d[p]])[0]
            print(f"    {p:<22}{f0:.3f} -> {f1:.3f}")

        print(f"\n  DEPLOYMENT, traffic mix {1 - a.ood_share:.0%} in-distribution / "
              f"{a.ood_share:.0%} unfamiliar:")
        for s in SIG:
            mx = R["mix"][s]
            e = mixms(mx, "escalation_rate"); ac = mixms(mx, "acc_on_answered")
            print(f"    gate on min-{s:<7} escalation {e[0]:.1%} +/-{e[1]:.1%}   "
                  f"accuracy on answered {ac[0]:.2%} +/-{ac[1]:.2%}")
    print(f"\nDONE -> {a.out}")


if __name__ == "__main__":
    main()
