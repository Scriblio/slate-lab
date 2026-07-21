"""STEP 4 — Slate against the simplest COMPETENT alternatives.

The comparison that matters is not Slate vs a dict. A dict is a straw man: it
loses under any perturbation and everyone knows it. The alternatives a buyer
would actually reach for are:

  deterministic code   a human writes the policy as a function
  rules engine         an ordered rule list interpreted at runtime
  dict                 memoise every input (kept only for continuity)
  vector kNN           nearest neighbour over encoded records
  trained classifier   an MLP on labelled examples — the stand-in for a
                       fine-tuned small model on structured input
  small local LM       llama3.2:1b, the policy in the prompt, open weights
  frontier LLM         claude-haiku-4-5 / claude-opus-4-8 answering directly

Slate's honest counters are one-shot insertion, inspectable rules, verifiability
and no GPU. Those are CLAIMS until measured, so each gets an experiment:

  A. accuracy on realistic traffic, and how much labelled data it took
  B. does it know when it does not know? (the escalation head-to-head — the
     property that makes an autonomous system safe to deploy)
  C. amending the policy: a new enum value, and a priority change
  D. footprint, latency, GPU

NOT MEASURED, stated rather than implied: no LoRA/full fine-tune of a small
language model was run — no training pipeline or budget for one here. The MLP
is a stand-in for the structured-input case a fine-tune would be used for, and
where a fine-tuned LM would differ (free text in, transfer from pretraining) it
would differ in ITS favour. Read the classifier rows as a lower bound on that
rival, not a refutation of it.

  python bench_rivals.py --no-llm   # everything except the API baselines
  python bench_rivals.py            # adds haiku/opus/llama direct execution
"""
import argparse
import json
import time

import numpy as np

import authors
import preflight as pf
from preflight import (FIELDS, NAMES, N_RECORDS, POLICY_TEXT, VERDICTS,
                       all_records, gold, interpret, load_slate, reference_dfa,
                       sample_ood_record, sample_record, tokens, verify)

VIDX = {v: i for i, v in enumerate(VERDICTS)}


# ═════════════════════════════════════════════════════════════════════════════
# encoding shared by the learned baselines (unknown value -> all-zero block)
# ═════════════════════════════════════════════════════════════════════════════
BLOCKS, _o = {}, 0
for _n, _vals in FIELDS:
    BLOCKS[_n] = {v: _o + i for i, v in enumerate(_vals)}
    _o += len(_vals)
NFEAT = _o


def onehot(rec):
    x = np.zeros(NFEAT, np.float32)
    for n in NAMES:
        j = BLOCKS[n].get(rec[n])
        if j is not None:                 # unseen enum value -> all-zeros block
            x[j] = 1.0
    return x


# ═════════════════════════════════════════════════════════════════════════════
# the competitors — each returns (verdict, confidence). confidence is whatever
# native signal that approach offers for "should I escalate?"
# ═════════════════════════════════════════════════════════════════════════════
class DeterministicCode:
    name, needs_labels, gpu, inspectable = "deterministic code", 0, False, True
    authored_by = "human"
    def fit(self, *_): return self
    def predict(self, rec):
        # An unseen enum value does not raise — it falls through the if-chain
        # and yields a confident verdict for a record the policy never covered.
        return gold(rec), 1.0
    def footprint(self): return None


class RulesEngine:
    """An ordered rule list, as a business-rules engine would hold it."""
    name, needs_labels, gpu, inspectable = "rules engine", 0, False, True
    authored_by = "human"
    RULES = [
        ({"contract": {"pending", "none"}}, "BLOCK_CONTRACT"),
        ({"rights": {"unknown"}}, "BLOCK_RIGHTS"),
        ({"channel": {"print"}, "isbn": {"missing", "invalid"}}, "NEEDS_ISBN"),
        ({"channel": {"print"}, "length": {"micro"}}, "BLOCK_LENGTH"),
        ({"ai_art": {"yes"}}, "NEEDS_AI_DISCLOSURE"),
        ({"age_rating": {"mature"}, "channel": {"audio", "serial"}}, "NEEDS_AGE_GATE"),
        ({"art_status": {"draft"}}, "NEEDS_ART"),
        ({"rights": {"regional"}, "channel": {"ebook"}}, "NEEDS_TERRITORY_MAP"),
    ]
    def fit(self, *_): return self
    def predict(self, rec):
        for cond, verdict in self.RULES:
            if all(rec[f] in vals for f, vals in cond.items()):
                return verdict, 1.0
        return "PASS", 1.0                # unseen values fall to the default
    def footprint(self): return None


class DictStore:
    name, needs_labels, gpu, inspectable = "dict (memoised)", N_RECORDS, False, False
    authored_by = "labels"
    def fit(self, *_):
        self.d = {tuple(r[n] for n in NAMES): gold(r) for r in all_records()}
        return self
    def predict(self, rec):
        k = tuple(rec[n] for n in NAMES)
        return (self.d[k], 1.0) if k in self.d else (None, 0.0)   # miss = abstain
    def footprint(self): return len(self.d) * (len(NAMES) * 8 + 24)


class KnnStore:
    name, gpu, inspectable, authored_by = "vector kNN", False, False, "labels"
    def __init__(self, n_train): self.n_train = n_train; self.needs_labels = n_train
    def fit(self, train):
        self.X = np.stack([onehot(r) for r in train])
        self.X /= (np.linalg.norm(self.X, axis=1, keepdims=True) + 1e-9)
        self.y = [gold(r) for r in train]
        return self
    def predict(self, rec):
        q = onehot(rec); q /= (np.linalg.norm(q) + 1e-9)
        s = self.X @ q
        i = int(np.argmax(s))
        return self.y[i], float(s[i])      # cosine to nearest = its confidence
    def footprint(self): return self.X.nbytes


class MLPClassifier_:
    """The fine-tuned-small-model stand-in: learns the policy from labels."""
    gpu, inspectable, authored_by = False, False, "labels"
    def __init__(self, n_train, hidden=(64, 64), seed=0):
        self.n_train, self.needs_labels, self.seed = n_train, n_train, seed
        self.hidden, self.name = hidden, f"trained classifier (n={n_train})"
    def fit(self, train):
        from sklearn.neural_network import MLPClassifier
        X = np.stack([onehot(r) for r in train])
        y = np.array([VIDX[gold(r)] for r in train])
        self.m = MLPClassifier(hidden_layer_sizes=self.hidden, max_iter=3000,
                               random_state=self.seed)
        t0 = time.time(); self.m.fit(X, y); self.train_seconds = time.time() - t0
        return self
    def predict(self, rec):
        p = self.m.predict_proba(onehot(rec)[None])[0]
        i = int(np.argmax(p))
        return VERDICTS[int(self.m.classes_[i])], float(p[i])   # max softmax
    def footprint(self):
        return int(sum(c.nbytes for c in self.m.coefs_)
                   + sum(b.nbytes for b in self.m.intercepts_))


class SlateProgram:
    """The compiled, exhaustively-verified program, executed from the store."""
    name, needs_labels, gpu, inspectable = "Slate (compiled program)", 0, False, True
    authored_by = "model+verifier"
    def __init__(self, program, seed=0):
        self.start, self.trans, self.out = program
        self.store = load_slate(self.start, self.trans, self.out, seed=seed)
    def fit(self, *_): return self
    def predict(self, rec):
        v, sig = interpret(self.store, self.start, tokens(rec))
        # A token that was never committed is out of distribution as a fact, so
        # it reports confidence 0 rather than being pushed through a fitted
        # threshold. Everything else falls back on the margin.
        return v, (0.0 if sig["unknown_symbols"] else sig["min_margin"])
    def footprint(self):
        self.store._ensure()
        return self.store.keys.nbytes


# ═════════════════════════════════════════════════════════════════════════════
# metrics
# ═════════════════════════════════════════════════════════════════════════════
def auc(pos, neg):
    pos, neg = np.asarray(pos, float), np.asarray(neg, float)
    if not len(pos) or not len(neg):
        return float("nan")
    a = np.concatenate([pos, neg]); r = np.empty(len(a))
    o = np.argsort(a, kind="mergesort"); sv = a[o]; i = 0
    while i < len(sv):
        j = i
        while j + 1 < len(sv) and sv[j + 1] == sv[i]:
            j += 1
        r[o[i:j + 1]] = (i + j) / 2.0 + 1.0
        i = j + 1
    return float((r[:len(pos)].sum() - len(pos) * (len(pos) + 1) / 2.0)
                 / (len(pos) * len(neg)))


def evaluate(model, id_recs, ood_recs, fpr=0.01):
    t0 = time.perf_counter()
    id_out = [model.predict(r) for r in id_recs]
    lat = (time.perf_counter() - t0) / len(id_recs)
    ood_out = [model.predict(r) for r in ood_recs]
    acc = float(np.mean([p == gold(r) for (p, _), r in zip(id_out, id_recs)]))
    exh = float(np.mean([model.predict(r)[0] == gold(r) for r in all_records()]))

    # Escalation compared at a MATCHED cost: each approach's threshold is set so
    # it escalates the same 1% of in-distribution traffic. Then "how much
    # unfamiliar traffic does it catch?" is comparable across approaches whose
    # confidence signals are on completely different scales. An approach whose
    # confidence is constant everywhere (deterministic code, a rules engine)
    # lands at 0% by construction — it has nothing to threshold on.
    idc = np.array([c for _, c in id_out], float)
    oodc = np.array([c for _, c in ood_out], float)
    t = float(np.quantile(idc, fpr))
    caught = float(np.mean(oodc < t))
    return {"traffic_accuracy": round(acc, 4), "exhaustive_accuracy": round(exh, 4),
            "ood_detect_auc": round(auc(idc, oodc), 4),
            "ood_caught_at_1pct_false_alarm": round(caught, 4),
            "hard_abstain_rate": round(float(np.mean(oodc == 0.0)), 4),
            "latency_us": round(lat * 1e6, 1),
            "labels_needed": model.needs_labels, "gpu": model.gpu,
            "inspectable": model.inspectable, "authored_by": model.authored_by,
            "footprint_bytes": model.footprint()}


# ═════════════════════════════════════════════════════════════════════════════
# C. AMENDING THE POLICY
# ═════════════════════════════════════════════════════════════════════════════
def amend_new_value(program, seed=0):
    """A new channel `podcast` is introduced; it behaves exactly like `serial`.

    Slate: commit the new token's transitions one-shot. The claim under test is
    not just that it is cheap but that it is SAFE — that no previously verified
    decision changes. Measured by re-running all 7,776 old records after.
    """
    start, trans, out = program
    before = {}
    store = load_slate(start, trans, out, seed=seed)
    for rec in all_records():
        before[tuple(rec[n] for n in NAMES)] = interpret(store, start, tokens(rec))[0]

    src = [(st, tok) for (st, tok) in trans if tok == "channel=serial"]
    t0 = time.perf_counter()
    for st, tok in src:                     # one-shot writes, no retraining
        store.commit(pf.key("T", st, "channel=podcast"),
                     payload=("T", trans[(st, tok)]),
                     id=f"T/{st}/channel=podcast")
    write_s = time.perf_counter() - t0

    changed = 0
    for rec in all_records():
        if interpret(store, start, tokens(rec))[0] != before[tuple(rec[n] for n in NAMES)]:
            changed += 1
    rng = np.random.default_rng(5)
    new_ok = []
    for _ in range(600):
        r = sample_record(rng); r["channel"] = "podcast"
        want = gold({**r, "channel": "serial"})
        new_ok.append(interpret(store, start, tokens(r))[0] == want)
    return {"writes": len(src), "seconds": round(write_s, 4),
            "old_decisions_changed": changed,
            "new_value_accuracy": round(float(np.mean(new_ok)), 4),
            "retraining_needed": False, "labels_needed": 0}


def amend_new_value_mlp(n_train, n_new, seed=0):
    """The same amendment for the trained classifier: it must be retrained."""
    rng = np.random.default_rng(100 + seed)
    base = [sample_record(rng) for _ in range(n_train)]
    m0 = MLPClassifier_(n_train, seed=seed).fit(base)
    before = {tuple(r[n] for n in NAMES): m0.predict(r)[0] for r in all_records()}

    new = []
    for _ in range(n_new):                  # freshly LABELLED examples required
        r = sample_record(rng); r["channel"] = "podcast"
        new.append(r)
    from sklearn.neural_network import MLPClassifier
    X = np.stack([onehot(r) for r in base + new])
    y = np.array([VIDX[gold(r)] for r in base]
                 + [VIDX[gold({**r, "channel": "serial"})] for r in new])
    t0 = time.time()
    m = MLPClassifier(hidden_layer_sizes=(64, 64), max_iter=3000, random_state=seed)
    m.fit(X, y)
    secs = time.time() - t0

    def pred(rec):
        return VERDICTS[int(m.classes_[int(np.argmax(m.predict_proba(onehot(rec)[None])[0]))])]
    changed = sum(pred(r) != before[tuple(r[n] for n in NAMES)] for r in all_records())
    rng2 = np.random.default_rng(5)
    new_ok = []
    for _ in range(600):
        r = sample_record(rng2); r["channel"] = "podcast"
        new_ok.append(pred(r) == gold({**r, "channel": "serial"}))
    return {"writes": None, "seconds": round(secs, 4),
            "old_decisions_changed": changed,
            "new_value_accuracy": round(float(np.mean(new_ok)), 4),
            "retraining_needed": True, "labels_needed": n_train + n_new}


# ═════════════════════════════════════════════════════════════════════════════
def llm_direct(model, recs, max_tokens=200):
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
        ok.append(next((v for v in VERDICTS if v in (raw or "")), None) == gold(r))
    return {"n": len(ok), "errors": err,
            "traffic_accuracy": round(float(np.mean(ok)), 4) if ok else None,
            "latency_us": round(float(np.median(lat)) * 1e6, 1) if lat else None,
            "usd_per_call": round(float(np.mean(usd)), 6) if usd else None,
            "labels_needed": 0, "gpu": model["where"] == "local",
            "inspectable": False, "footprint_bytes": None}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-llm", action="store_true")
    ap.add_argument("--n-eval", type=int, default=2000)
    ap.add_argument("--n-llm", type=int, default=40)
    ap.add_argument("--seeds", type=int, default=3)
    ap.add_argument("--out", default="results_rivals.json")
    a = ap.parse_args()
    rng = np.random.default_rng(3)

    prog_src = "reference (no verified model program on disk)"
    try:
        d = json.load(open("results_compiler.json"))
        p = next(r["program"] for rows in d["authoring"].values()
                 for r in rows["rows"] if r["status"] == "verified")
        program = (p["start"],
                   {tuple(k.split(",", 1)): v for k, v in p["transition"].items()},
                   p["output"])
        prog_src = f"model-authored ({d.get('program_source')}), verified"
    except Exception:  # noqa: BLE001
        program = reference_dfa()
    ok, acc, _ = verify(*program)
    print(f"program under test: {prog_src} — re-verified {acc:.1%} "
          f"({'EXACT' if ok else 'FAILED'})\n")

    id_recs = [sample_record(rng) for _ in range(a.n_eval)]
    ood_recs = [sample_ood_record(rng) for _ in range(a.n_eval)]
    train_pool = [sample_record(rng) for _ in range(5000)]

    rows, results = {}, {"program_source": prog_src, "config": vars(a)}
    for m in [DeterministicCode(), RulesEngine(), DictStore(),
              KnnStore(1000), MLPClassifier_(1000), SlateProgram(program)]:
        m.fit(train_pool[:getattr(m, "n_train", 0)] or train_pool)
        rows[m.name] = evaluate(m, id_recs, ood_recs)
        print(f"  {m.name:<28} traffic {rows[m.name]['traffic_accuracy']:.1%}  "
              f"exhaustive {rows[m.name]['exhaustive_accuracy']:.1%}  "
              f"OOD-AUC {rows[m.name]['ood_detect_auc']:.3f}", flush=True)

    # A. how much labelled data the learned rival needs
    curve = {}
    for n in (50, 200, 1000, 5000):
        accs = [MLPClassifier_(n, seed=s).fit(train_pool[:n])
                for s in range(a.seeds)]
        e = [float(np.mean([m.predict(r)[0] == gold(r) for r in all_records()]))
             for m in accs]
        t = [float(np.mean([m.predict(r)[0] == gold(r) for r in id_recs]))
             for m in accs]
        curve[n] = {"exhaustive": [round(float(np.mean(e)), 4), round(float(np.std(e)), 4)],
                    "traffic": [round(float(np.mean(t)), 4), round(float(np.std(t)), 4)]}
        print(f"  classifier n={n:<5} exhaustive {curve[n]['exhaustive'][0]:.1%} "
              f"+/-{curve[n]['exhaustive'][1]:.1%}", flush=True)
    results["classifier_sample_efficiency"] = curve

    # C. amendments
    print("\namendment A — a new enum value (channel=podcast, behaves like serial):",
          flush=True)
    am = {"slate": amend_new_value(program),
          "trained classifier": amend_new_value_mlp(1000, 200)}
    for k, v in am.items():
        how = (f"{v['writes']} one-shot writes" if v["writes"] is not None
               else "full retrain")
        print(f"  {k:<20} {how:<22} {v['seconds']:.2f}s  "
              f"old decisions changed {v['old_decisions_changed']}/{N_RECORDS}  "
              f"new-value accuracy {v['new_value_accuracy']:.1%}  "
              f"labels {v['labels_needed']}")
    results["amendment_new_value"] = am
    results["amendment_priority_change"] = {
        "note": "Reordering rule priorities changes the residual of nearly every "
                "state, so the program must be RE-AUTHORED and re-verified — "
                "Slate has no advantage here over regenerating code. Measured "
                "cost of that recompile, from results_compiler.json: one "
                "authoring call and a full 7,776-record verification.",
        "reauthor_usd_per_attempt_opus": 0.294, "reauthor_seconds_opus": 35.38,
        "verification_records": N_RECORDS}

    # D. LLM baselines
    if not a.no_llm:
        print("\ndirect LLM execution:", flush=True)
        for name in ("claude-haiku-4-5", "claude-opus-4-8", "llama3.2:1b"):
            m = next(x for x in authors.MODELS if x["name"] == name)
            if not authors.available(m):
                continue
            r = llm_direct(m, id_recs[:a.n_llm])
            r["ood_detect_auc"] = None
            r["exhaustive_accuracy"] = None
            r["authored_by"] = "prompt"
            rows[f"direct {name}"] = r
            print(f"  {name:<22} traffic {r['traffic_accuracy']:.1%}  "
                  f"{r['latency_us'] / 1000:.0f} ms/call  "
                  f"${r['usd_per_call'] or 0:.6f}/call", flush=True)

    results["comparison"] = rows
    with open(a.out, "w") as f:
        json.dump(results, f, indent=1)

    W = 104
    print("\n" + "=" * W)
    print("SLATE vs THE COMPETENT ALTERNATIVES — publishing preflight")
    print("=" * W)
    print(f"  {'approach':<28}{'traffic':>9}{'exhaust':>9}{'OOD AUC':>9}"
          f"{'OOD caught':>12}{'us/call':>10}{'labels':>8}{'rules?':>7}"
          f"{'authored by':>15}")
    for k, r in rows.items():
        f_ = lambda v, p="{:.1%}": p.format(v) if v is not None else "-"  # noqa: E731
        print(f"  {k:<28}{f_(r['traffic_accuracy']):>9}"
              f"{f_(r.get('exhaustive_accuracy')):>9}"
              f"{(('%.3f' % r['ood_detect_auc']) if r.get('ood_detect_auc') is not None else '-'):>9}"
              f"{f_(r.get('ood_caught_at_1pct_false_alarm')):>12}"
              f"{(('%.1f' % r['latency_us']) if r.get('latency_us') is not None else '-'):>10}"
              f"{str(r.get('labels_needed', '-')):>8}"
              f"{('yes' if r.get('inspectable') else 'no'):>7}"
              f"{r.get('authored_by', '-'):>15}")
    print("\n  OOD = records carrying an enum value the policy never covered. "
          "'OOD caught' is\n  measured at a MATCHED cost: each approach's "
          "threshold escalates the same 1% of\n  in-distribution traffic. "
          "Answering an OOD record confidently is the silent-failure\n  mode; "
          "AUC 0.500 means the approach has no signal at all that it is out of "
          "its depth.")
    print(f"\nDONE -> {a.out}")


if __name__ == "__main__":
    main()
