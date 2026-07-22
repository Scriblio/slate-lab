# The agent skill compiler — measured

> **Patent pending.** See the notice in [README.md](README.md). This document
> reports measurements from `bench_escalation.py`, `preflight.py`,
> `bench_compiler.py` and `bench_rivals.py`; the raw JSON each produced is in
> the repo beside it.

A frontier model receives a task description, emits a constrained transition
program, a verifier tests it exhaustively, Slate stores the verified program,
many similar requests then execute with **no further model call**, and
unfamiliar requests **escalate back to the model**.

Everything below is the measurement. Facts first, interpretation clearly
marked and last. Nothing here was designed toward a target number — where the
result is unflattering it is reported as it came out, and two of the most
important findings are unflattering.

---

## The order this was built in, and why

The escalation step was measured **first**, before anything was built on top of
it. If a store answers confidently on requests no stored program covers, the
system is silently wrong at scale and nothing else matters. `core.recall`
already carried an `accepted` flag intended as that gate. The prior from
slate-bench's limits battery (a text-retrieval corpus) was that far-OOD
detection was near-perfect and near-OOD detection weak — familiarity AUC 0.611,
margin 0.656. That prior turned out to be right, and worse than it looked.

---

## 1. Escalation calibration — the shipped abstain flag does not work

`bench_escalation.py`: the 48 model-authored DFAs that `bench_synthesis.py`
already verified against gold on all 4,096 inputs, poured into **one**
skill-library Slate (981 rules), probed with in-distribution, near-OOD and
far-OOD cues. 5 seeds, 400 rule probes and 120 requests per population per seed.

### Rule level — one lookup

AUC separating each out-of-distribution population from in-distribution cues
(1.000 = perfect separation, 0.500 = no signal):

| probe population | familiarity (what the flag uses) | margin (top1−top2) |
|---|---|---|
| unseen symbol in a known slot | 0.896 ±0.010 | **0.9999** ±0.0001 |
| state name from another program | 0.659 ±0.009 | **0.9995** ±0.0002 |
| right shape, wrong skill | 0.619 ±0.008 | **0.9997** ±0.0001 |
| nothing recognisable in any slot | 1.000 ±0.000 | 1.000 ±0.000 |

Accept-rate at the **shipped** threshold (`settle_floor=0.12`):

| population | accepted | wanted |
|---|---|---|
| in-distribution, clean | 100% | ~100% |
| in-distribution, noisy read | 100% | ~100% |
| every near-OOD population | **100%** ±0% | ~0% |
| far-OOD | **32.5%** ±1.7% | ~0% |

### Request level — the decision that actually gates the model call

A request is a whole 13-step trajectory. Both aggregate signals are *perfect
rankers* here (AUC 1.000 for min-familiarity and min-margin against all three
unfamiliar-input populations) — and the shipped flag **still answers 100% of
them**, because its fixed threshold sits far below both distributions.

The mechanism, measured: mean familiarity along a far-OOD trajectory rises from
**0.301 at the first step to 0.587 at the last**. The first lookup snaps to some
stored basin; its payload is a real state name; every subsequent cue therefore
contains real vocabulary and *looks* familiar. **The substrate manufactures
familiarity by settling.** A single-step familiarity threshold cannot survive
that, which is why the rule-level AUCs of 0.62–0.66 become a 100% false-accept
rate over a trajectory.

### The fix: two mechanisms, because there are two ways to be out of distribution

The first attempt was statistical — take the **minimum margin over the
trajectory** and calibrate a threshold on a **held-out** draw of
in-distribution traffic (the 1% quantile, never fitted on the evaluation set,
never on OOD). That works, but it estimates something that is often knowable
exactly, and it charges a false-alarm rate for the privilege.

The better primary gate is **structural**: was every symbol in this cue ever
committed? A record carrying `channel=podcast` uses a token the program was
never compiled for. That is a *fact*, not a confidence — no threshold, no
calibration, no held-out sample. `core.Slate` now records its committed
`vocab` and exposes `knows()`.

Request-level answer rates, σ=0.75 (5 seeds):

| population | shipped familiarity flag | calibrated min-margin | **structural** |
|---|---|---|---|
| in-distribution *(want ~100%)* | 100% | 98.8% ±1.0% | **100.0% ±0.0%** |
| unseen enum value *(want 0%)* | 100% | 2.7% ±1.2% | **0.0% ±0.0%** |
| unknown skill *(want 0%)* | 100% | 0.0% | **0.0% ±0.0%** |
| far-OOD *(want 0%)* | 100% | 0.0% | **0.0% ±0.0%** |

The structural gate is **exact on all four**, and it is unchanged by cue noise —
corrupting the vector does not change which *symbol* was asked for. The fitted
threshold is strictly worse on both sides: it turns away 1.2% of legitimate
traffic *and* lets 2.7% of unfamiliar records through. Running both together
buys nothing here and costs the false alarms (in-dist drops back to 98.8%).

**The margin is still needed, for a different failure.** A cue whose symbols are
all known but whose *combination* was never stored is structurally fine — the
rule-level table above is exactly that case, and there margin scores 0.9995–1.000
where familiarity scores 0.62–0.66. So:

* **novel symbol** → structural check. Exact, free, O(vocabulary).
* **novel combination of known symbols, or a corrupted cue** → margin. Needs a
  threshold, and that threshold costs ~1.2% false alarms.

This is also, in hindsight, why the memoised dict matches Slate at OOD detection
in §5: a dict lookup *is* a membership test. The difference is what each one has
to enumerate — the dict needs all **7,776** records, the vocabulary check needs
**25** value tokens. Same exactness, different scaling.

At an 85/15 familiar/unfamiliar mix the calibrated margin gate gives escalation
**15.9% ±0.9%** at **99.84% ±0.07%** accuracy on answered; the structural gate
gives exactly 15% escalation at 100%.

`core.Slate` also gained an optional `margin_floor`. It defaults to `None`, so
every earlier result in this repo stands unchanged.

### The limit no abstain flag can reach

A request that needed skill A, routed to skill B. Every cue is a genuinely
stored rule, so nothing is unfamiliar (σ=0.75; σ=0 is the same within error):

| | value |
|---|---|
| AUC, min-familiarity | 0.490 ±0.055 |
| AUC, min-margin | 0.514 ±0.014 |
| answered (not escalated) | 97.8% ±0.9% |
| **and correct only** | **69.5% ±2.7%** |

The substrate can tell you the **input** is unfamiliar. It cannot tell you the
**wrong skill was selected** — those cues are, by construction, perfectly
familiar. That is a router problem, not a memory problem, and it bounds what
this architecture can promise. (The 69.5% is flattered by base rates; on a
9-verdict task it would be far lower.)

---

## 2. The workflow: publishing preflight

`preflight.py`. Chosen over tech-support diagnosis and tool routing because it
is **exhaustively verifiable**: 8 categorical fields, 7,776 enumerable records,
9 verdicts under a priority-ordered policy. The whole proposition depends on the
proof existing, and tech-support diagnosis has no computable gold. Tool routing
collapses into a classification problem where a fine-tuned classifier is simply
the right answer and there is nothing to verify.

The policy is order-sensitive — later rules depend on fields read earlier — so
compiling it to a field-sequential automaton requires carrying facts forward.
The minimal automaton is **52 states, 142 rules**.

**Scope, stated:** records arrive **structured**, as from a submissions
database. Slate holds the *decision*, not the *parsing*. If requests arrived as
free text something would have to parse them on every request, and that cost
would have to be charged against the calls saved. It is not charged here and no
claim is made about it.

Majority-class baseline: 33.0% under the realistic traffic mix (66.7% under the
uniform product distribution — which is why traffic is sampled from a stated
realistic mix and verification enumerates uniformly; both are reported).

---

## 3. Authoring — reliability is the weak link, and the verifier is why that is survivable

`bench_compiler.py`, 5 independent attempts per model, each program checked
against the policy on all 7,776 records:

| author | org | where | verified | cost | median latency |
|---|---|---|---|---|---|
| claude-opus-4-8 | Anthropic | cloud | **4/5 (80%)** | $1.47 | 35.4 s |
| claude-haiku-4-5 | Anthropic | cloud | 1/5 (20%) | $0.19 | 21.3 s |
| llama3.2:1b | Meta (open weights) | local | **0/5** (all malformed) | $0.00 | 8.8 s |

**The near-misses are the finding.** Opus's one failure was **98.61%**
exhaustively correct — wrong on 108 of 7,776 records. Haiku produced one at
99.07% and one at 6.25%. A 98.6%-correct policy program passes any sampled test
you would plausibly write. Only exhaustive verification rejects it.

So authoring is fallible and capability-dependent, and that is **fine**, because
a program either verifies or is discarded. Cost of an 80%-reliable author is a
retry, not a wrong decision in production.

**Model-neutrality: partially demonstrated, not established.** Two independent
Anthropic models produced verifiably-correct programs; a 1B open-weights local
model produced none. OpenAI and xAI paths are implemented against the same
interface in `authors.py` but were **NOT RUN** — no `OPENAI_API_KEY` or
`XAI_API_KEY` in this environment. The honest claim is: the pipeline is not
coupled to one vendor's model, *and* "any model can author" is false.

---

## 4. At scale — 100,000 preflight decisions

15% of traffic carries an enum value the program was never compiled for.
Escalated requests are charged a **real** model call at the measured per-call
latency and cost, so savings are net.

| | measured |
|---|---|
| model calls avoided | 85,000 / 100,000 (85.0%) |
| unfamiliar traffic escalated | **100.0%** |
| in-distribution false alarms | **0.0%** |
| unfamiliar answered anyway (silent failures) | **0** |
| — escalated by the structural check | **15,000** |
| — escalated by the fitted margin threshold | **0** |
| accuracy on answered | **100.00%** |
| Slate path latency | median **1.56 ms**, p99 6.41 ms |
| throughput | 476 decisions/sec, one CPU core, no GPU |
| end-to-end latency | 181 ms median vs 1,195 ms all-model |
| cost | $4.91 vs $32.70 all-model (85.0% reduction) |
| direct claude-haiku-4-5 accuracy on the same task | **93.3%** |

Every one of the 15,000 escalations was caught by the exact structural check.
The fitted threshold caught **nothing it did not already catch** — on this
workload the statistical machinery is dead weight, and the honest reading is
that it should be the fallback, not the gate.

Two things to read carefully here.

**The 85% call reduction is set by the traffic mix, not by Slate.** Sweeping the
unfamiliar share, 20,000 decisions each:

| unfamiliar share | call reduction | accuracy on answered | unfamiliar escalated | silently answered |
|---|---|---|---|---|
| 2% | 98.0% | 100.00% | 100.0% | 0 |
| 5% | 95.0% | 100.00% | 100.0% | 0 |
| 10% | 90.0% | 100.00% | 100.0% | 0 |
| 15% | 85.0% | 100.00% | 100.0% | 0 |
| 30% | 70.0% | 100.00% | 100.0% | 0 |
| 50% | 50.0% | 100.00% | 100.0% | 0 |

Call reduction tracks `1 − unfamiliar share` exactly. **It is a property of the
workload, not of the system** — so quote it only with the mix attached. What
Slate is responsible for is the three right-hand columns holding *while* the mix
moves across a 25× range. Any claim of the form "cut model calls 92%" is really
a claim that 8% of your traffic is novel.

**The compiled program is more accurate than the model it replaces** — 100.00%
vs 93.3% for direct haiku — because it was verified and the model was not. The
all-model cost baseline is extrapolated from 60 measured calls and labelled as
such. (A second independent sample of 40 records in `bench_rivals.py` put haiku
at 87.5%; both are small samples of the same quantity and the spread is the
sampling error, not a discrepancy. Frontier opus scores 100% on 40 — see §5.)

---

## 5. Against the competent alternatives

`bench_rivals.py`, on the opus-authored program (re-verified 100% exact).
2,000 in-distribution and 2,000 unfamiliar records, 3 seeds for the learned rivals.

"OOD caught" is measured at a **matched cost**: every approach's threshold is set
so it escalates the same 1% of in-distribution traffic, which makes confidence
signals on completely different scales comparable.

| approach | traffic | exhaustive | OOD AUC | OOD caught | µs/call | labels | rules? | authored by |
|---|---|---|---|---|---|---|---|---|
| deterministic code | 100.0% | 100.0% | 0.500 | 0.0% | **0.3** | 0 | yes | human |
| rules engine | 100.0% | 100.0% | 0.500 | 0.0% | 2.0 | 0 | yes | human |
| dict (memoised) | 100.0% | 100.0% | **1.000** | **100.0%** | 1.0 | 7,776 | no | labels |
| vector kNN | 84.2% | 58.0% | 0.703 | 1.1% | 10.5 | 1,000 | no | labels |
| **trained classifier** (n=1000) | 99.8% | 99.4% | 0.709 | **16.5%** | 57.0 | 1,000 | no | labels |
| **Slate** (compiled program) | 100.0% | 100.0% | **1.000** | **100.0%** | 1,563 | **0** | yes | model+verifier |
| direct claude-haiku-4-5 | 85.0% | – | – | – | 1,257,225 | 0 | no | prompt |
| direct claude-opus-4-8 | 100.0% | – | – | – | 1,674,205 | 0 | no | prompt |
| direct llama3.2:1b | 20.0% | – | – | – | 2,441,198 | 0 | no | prompt |

How much labelled data the learned rival needs (exhaustive accuracy, 3 seeds):

| training examples | 50 | 200 | 1,000 | 5,000 |
|---|---|---|---|---|
| trained classifier | 72.8% ±1.7% | 95.8% ±0.7% | 99.5% ±0.1% | 100.0% ±0.0% |

Three things this table says plainly:

* **Slate does not win on speed or simplicity.** For clean, enumerable,
  structured input, deterministic code is ~1,400× faster and equally accurate,
  and a memoised dict matches Slate on *both* accuracy and OOD detection —
  because for an exact table a miss is a miss. On this axis the dict is the
  better engineering choice, and it needs 7,776 labelled entries to Slate's 0
  and 166 rules.
* **The dangerous rival is real but blind.** A small trained classifier reaches
  99.4% exhaustive accuracy from 1,000 labels — genuinely competent. At matched
  cost it catches **16.5%** of unfamiliar records against Slate's 100%. It is
  accurate and confidently wrong on everything it was never shown.
* **A small local *language* model is not a rival at all here** — llama3.2:1b
  scores 20.0%, below the 33.0% majority-class baseline, and could not author a
  valid program in 5 attempts. The fine-tuned-model threat is real for the
  *classifier* form of this task, not the LLM form.

(Direct-LLM accuracies are 40-record samples and move a few points run to run —
haiku measured 93.3% on 60 records in §4 and 85.0% on 40 here. Opus is 100% on
both.)

### Amending the policy

A new enum value arrives — `channel=podcast`, behaving like `serial`:

| | Slate | trained classifier |
|---|---|---|
| what it takes | **4 one-shot writes** | full retrain |
| wall clock | <0.01 s | 0.40 s |
| labels required | **0** | 1,200 |
| **previously-verified decisions silently changed** | **0 / 7,776** | **11 / 7,776** |
| accuracy on the new value | 100.0% | 100.0% |

Both end up handling the new value correctly. The difference is that retraining
silently altered 11 decisions elsewhere in the space that were previously
correct and verified — you would have to re-verify everything to find them. The
Slate amendment provably touched nothing else, because the other rules are
byte-identical.

A **priority change** — reordering the rules — is different and Slate has **no
advantage**: it changes the residual of nearly every state, so the program must
be re-authored and re-verified (one opus call, ~35 s, ~$0.29, plus a
7,776-record check), exactly as code would be regenerated.

---

## Interpretation — hypotheses, not results

Everything above is measurement. What follows is reading.

1. **The escalation result is the load-bearing one, and it needed fixing twice.**
   The shipped familiarity flag would have answered 100% of unfamiliar traffic.
   A calibrated min-margin gate fixed that — and then turned out to be the wrong
   *kind* of instrument: it estimates from samples something that is knowable
   exactly. Asking "was this symbol ever committed?" is exact, free, needs no
   held-out data, and caught 15,000 of 15,000 escalations at scale while the
   fitted threshold caught none. The reflex to reach for a statistical tool cost
   a false-alarm rate and bought nothing. Keep the margin for novel
   *combinations* of known symbols, where there genuinely is nothing structural
   to check.

2. **Verification, not the substrate, is what makes model-authored skills
   safe.** The strongest evidence is the 98.61%-correct program that was
   rejected. Any pipeline that samples its tests would have shipped it.

3. **Slate is not the fastest executor and this benchmark says so.** For clean,
   enumerable, structured input, deterministic code and a rules engine are
   ~1,400× faster and equally accurate, and even a memoised dict matches Slate's
   OOD detection exactly, because for an exact table a miss is a miss. Slate's
   measured edges are narrower and real: zero labelled data, 166 inspectable
   rules instead of 7,776 enumerated entries, an amendment that provably
   disturbs nothing (0 vs 11 silent regressions), and OOD detection the trained
   classifier does not have (100% vs 16.5% at matched cost). The dict's parity
   here is a property of a 7,776-cell space you can afford to enumerate; it is
   the comparison that would change first as the space grows, and this benchmark
   does not test that.

4. **The honest acquisition claim is not "cheaper than code."** It is:
   *model-authored, verifier-checked, one-shot-amendable, and it knows when it
   does not know.* Each of those four is measured above. The first three are
   about the lifecycle, not the runtime — which is where the value is, because
   nobody's bottleneck is 2 µs vs 1.4 ms.

5. **Open edges.** Free-text requests are unmeasured, and the parsing step they
   need could erase the savings. Mis-routing is undetectable by this
   architecture and needs a router with its own confidence. OpenAI and xAI never
   ran. And the whole result rests on an input space small enough to enumerate —
   the case where verification is *hard* is exactly the case not tested here.
