# From a store of STATES to a model of TRANSITIONS

`cube_cause.py` · built 2026-07-21 · run it: `python cube_cause.py` (~2 min, no API key)
· tests: `pytest test_cause.py -q`

The previous rung (`cube_fuse.py`) could **describe, ground and judge** a world.
It could not **predict a consequence, explain a cause, or run a counterfactual**.
We took that as the operational definition of understanding, and this is the
build that buys it: stop storing what things *are* and start storing how they
*change*.

---

## The world

Every consequence is determined **jointly** by the action and by one causally
relevant attribute of the thing it is done to:

| action | reads | consequences |
|---|---|---|
| `EAT` | texture | soft → *it is gone* · hard → *it cracks* · bitter → *spat out* |
| `PUSH` | weight | light → *it moves* · heavy → *nothing* · rooted → *you strain* |
| `CHASE` | speed | slow → *caught* · fast → *runs off* · flying → *flies off* |
| `SEE` | — | nothing ever happens |

That "jointly" is the whole design. If an outcome depended on the action alone,
the benchmark would be a four-row lookup table and a held-out split over entities
would flatter it into meaninglessness. The attributes also **cross-cut**: a pear
is soft *and* heavy, a seed hard *and* light, so knowing what happens when you eat
a thing tells you nothing about what happens when you push it. A `colour`
attribute is present that nothing reads, purely as a distractor.

Nothing about any of this is given to the model. From `(scene, action, next_scene)`
triples alone it induces the selectional constraints, **which attribute each
action reads**, and the transitions themselves. Episodes are stored *concretely*,
exactly as experienced; generalisation happens at **read** time, by re-binding the
recalled episode's roles onto the query's participants. That is analogy, and it is
a general mechanism rather than a hand-coded answer — which is why the
no-re-binding baseline collapses to 34%.

## The hold-out

Whole `(action, patient)` **cells** are removed, so the model has never seen that
thing undergo that action at all — and no test entity has an exact profile twin
in training, so no cell is answerable by memorisation. Two whole **causal
branches** are removed as well: nothing bitter is ever eaten, nothing rooted is
ever pushed. Those are *unknowable*, not merely unseen, so the only correct answer
is "I don't know". **One branch calibrates the doubt threshold and the other one
tests it**, so the gate never sees its own exam.

## The scoreboard

96 held-out questions, 22 unknowable ones, seven substrate seeds (zero variance).

| | world 1 (one cause per action) | world 2 (`EAT` needs two, jointly) |
|---|---|---|
| **PREDICT** | 100% | 100% |
| **EXPLAIN** (exact preimage, set equality) | 100% | 100% |
| **COUNTERFACT** | 1338/1338 | 1330/1338 |
| **UNCERTAINTY** | declines 22/22, answers 96/96 | declines **21/22**, answers 96/96 |

What PREDICT had to beat, all ungated:

| rival | score |
|---|---|
| chance (uniform over the 9 outcomes) | 11% |
| "the action alone tells you the outcome" | 56% |
| recall nearest episode, **don't** re-bind roles | 34% |
| ablation: don't learn which attribute matters | 75% |
| ablation: entities as opaque symbols, no features | 51% |
| ablation: raw argmax, no attractor settle | **100%** |
| this model | 100% |

EXPLAIN is scored on **set equality** against the world's true preimage —
returning everything fails, returning one cause when there were two fails.
COUNTERFACT is scored in three categories: branch-flip, *impossible* (it can't be
done to that → nothing happens, on the grounds that the action does not apply),
and *unknowable* (must decline).

## What the substrate actually earns — the decisive comparison

A world where each action reads exactly one attribute is **a lookup table wearing
a costume**, and an attractor memory deserves no credit for tying one. So world 2
changes exactly one thing: `EAT` reads texture **and** weight jointly (a big soft
meal makes you `SLEEPY`, a hard heavy one makes you `SORE`). Same entities, same
splits, same model, same gate. On the `EAT` cells — the only ones that differ:

| | world 1 | world 2 |
|---|---|---|
| dict on the learned cause, no substrate | **22/22** | **0/22** |
| this model | 22/22 | 22/22 |

That is the real scope of the claim. Not "the Slate predicts" — a dict predicts
just as well when the cause is one column wide — but **"the Slate keeps working
when the cause stops being one column."**

Two more honest deflations in the same table: the **attractor settle earns
nothing here** (turning it off scores identically; it changes the retrieved
outcome 0/96 times), and a dict on the *whole* profile scores 0% — pure
memorisation, defeated by the `colour` distractor.

## Where it is weakest

**The doubt only partly transfers.** The gate is calibrated on one action and
applied to another. When a rule needs two attributes the evidence splits between
them, every margin under that action shrinks, and a floor calibrated on a
one-attribute action sits too high — world 2 catches only 11/22 on the margin
alone. Scaling the margin by what a *known* case scores under the same action was
the obvious fix and **it did not work**; it is reported rather than quietly
dropped. Familiarity survives the change (21/22), so the gate requires **both**
signals and answers only when neither objects — which costs zero in-model answers
in either world. The calibration data rates margin and familiarity identically, so
it cannot justify picking either, and picking by exam score would be tuning on the
test set.

Also worth stating: prior work here (`bench_escalation.py`) found that familiarity
accepts near-OOD cues and only the margin catches them. **That does not reproduce
on this world** — they tie. The one signal that is consistently useless is Slate's
raw top1–top2 margin (0.81 balanced accuracy, answers 63/96), because hundreds of
stored episodes share a handful of outcomes and the top two entries are
near-duplicates of each other. That is the gap `overlaps_for()` and the decision
margin exist to close.

## Every number that lied the first time

Per the standing rule — attack every number before believing it. Each of these
looked like a result:

1. **`PUSH/LOG` scored 0/7 while `PUSH/ROCK` scored 7/7 — with identical feature
   profiles.** Both of LOG's legal appearances had been held out, so LOG vanished
   from training entirely; 14 "held-out" cases were structurally unanswerable and
   the model had correctly declined every one. Now guarded.
2. **`CHASE` reported reading `speed` *and* `weight`, tied at 1.00.** Gain ratio
   divides by attribute entropy, which exactly cancelled the advantage of the
   fully-predictive attribute. Switched to the uncertainty coefficient.
3. **EXPLAIN returned 18 causes where the truth was 7** — selectional constraints
   were learned for the patient only, so the model thought an apple could push a
   ball.
4. **`colour` scored 1.00 under `CHASE`, tying the true cause.** With only three
   training patients, the distractor was *perfectly confounded* with speed. A
   defect in the sample, not the learner: three examples cannot separate two
   attributes that agree on all three. The first confound guard missed it because
   it only checked the runner-up.
5. **The familiarity control printed "familiarity does not separate — the margin
   does" while its own measurement showed them identical.** A prior finding
   carried forward as a caption over data that did not support it.
6. **The learning curve was non-monotonic** (100% at 64 episodes, 88% at 128) —
   a fresh permutation was drawn at each size, so it measured subsample luck
   rather than learning. Nested prefixes, averaged over 5 shuffles.
7. **A test reported 74/96 for a model that scores 96/96** — `use_world()` mutates
   module globals, and a module-scoped fixture left world 1's model being scored
   against world 2's rules.

`test_cause.py` pins all of these so they cannot come back silently, and
`verify_splits()` + `identifiability()` now fail loudly rather than producing a
number.

## How much exposure it needs

Nested subsets, averaged over 5 shuffles:

| episodes seen | causes found | held-out prediction |
|---|---|---|
| 8 | 0.8/3 | 3.5% |
| 32 | 1.8/3 | 43.1% |
| 64 | 3.0/3 | 76.2% |
| 128 | 3.0/3 | 93.1% |
| 256 | 3.0/3 | 100.0% |
| 687 | 3.0/3 | 100.0% |

The causes are pinned early. What the extra episodes buy is *coverage of the
branches* — the same property that makes it decline the bitter foods.

## Honest scope

This is understanding of **a world**: 4 actions over 29 things, where the causes
are attributes the model can perceive. On the world whose rules are one column
wide, a plain lookup table does just as well. The calibrated doubt only partly
transfers between the two worlds. And none of it is pragmatics or open-ended
language — **knowing what happens next still does not tell it what is worth
saying.** That is a further rung.

Standalone lab cube. Never reads, writes, or imports the live production
substrate.
