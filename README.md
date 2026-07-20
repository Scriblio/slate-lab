# slate-lab — does the cube think, not just remember?

> **Patent pending.** The substrate, its composition, in-substrate procedure
> execution, and the LLM knowledge/capability distillation methods shown here
> are the subject of U.S. provisional applications **64/109,622** (filed
> 2026-07-11) and **64/112,694** (filed 2026-07-15). Sole inventor:
> Matthew Lancaster · contact via the Scriblio GitHub org (github.com/Scriblio)
>
> **Start here (no API key needed):** `python procedure.py` — watch 4 memorised
> rules beat 400 memorised answers (100% vs 32% on unseen inputs), then an
> 8-rule lesson do exact arithmetic. Then `python transplant.py` (needs an
> `ANTHROPIC_API_KEY`) — watch a frontier model teach the memory a skill it
> keeps forever, for about three cents.

A standalone lab cube built to test, empirically, whether Slate — the one-shot
attractor memory — can be made to **compose, act, learn value, and run stored procedures** when
given depth, feedback, in-substrate value, and a router.

**Guardrail:** every file here is self-contained and re-implements the Slate
primitive from scratch (`core.py`). Nothing here reads, writes, or imports
the live production substrate. This is a lab cube; the production substrate is not this lab's to touch.

## What this is, in standard terms

Branded language is fine, but a skeptic needs the conventional name beside it.
Precisely, this project is:

> a random-projection associative memory (a modern-Hopfield / SimHash store)
> that holds model-authored **finite-state programs** as content-addressable
> transition tables, and executes them with a **fixed, task-agnostic
> interpreter** - so a procedure a frontier model writes once can be run
> cheaply and repeatedly, and tolerates noisy cues that break an exact table.

| this repo's word | conventional term |
|---|---|
| Slate substrate | random-projection associative memory (modern Hopfield / SimHash) |
| feedback / recall-as-set-point | recurrent application of retrieved transition rules |
| in-substrate value | mutable scalar metadata updated by temporal-difference learning |
| depth / bands | stacked / ensembled random projections |
| router | learned operator-selection policy (per-task RL) |
| skill transplant | a model-generated finite-state program, compiled into the store |
| "reason" / "think" | execute a stored procedure via memory + a generic controller |

**What we claim** (now measured against baselines, over many seeds):
1. One task-agnostic interpreter executes a family of ~50 finite-state programs
   from stored tables - the task logic lives in memory, not the interpreter
   (`bench_program_family.py`).
2. A procedure stored as **compact transition rules** generalises to unseen
   inputs where the same procedure stored as **example answers** (flashcards)
   does not (`procedure.py`).
3. The associative store gives **error-tolerant execution**: it recovers the
   right rule from a noisy cue where an exact lookup table collapses
   (`bench_vs_baselines.py`).

**What we do NOT claim:**
- Not that "memory thinks." The generalisation is done by a fixed interpreter
  *plus* the stored table - a content-addressable transition table inside a
  conventional controller, closer to microcode than to emergent reasoning.
- Not arbitrary skills. The transplant / program results are **finite-state
  (regular) procedures** - divisibility, residues, parity, popcount-mod-k.
  Divisibility is especially friendly to finite automata; success there does
  not show that any model skill compiles to a table.
- Not that Slate beats a vector index on accuracy. Under noise it *ties* a
  kNN / vector store; its differentiators are one-shot write, a unified value
  channel, and (in the production engine) bit-packed compactness - not accuracy.
- The router learns **per task**, not zero-shot; goal-conditioning is future work.

## Does it beat the simplest alternative?

The right question is not "does Slate work" but "what does it do better than a
dict?" We store the *same* div-7 transition table three ways and execute it,
clean and under noisy state-reads, over 30 seeds (`bench_vs_baselines.py`):

| store | clean | noisy cue (sigma up to 1.5) | bytes/rule (lab) | write |
|---|---|---|---|---|
| dict (exact table / DFA) | 100% | **-> 0%** (any perturbation misses) | 512 | 0.004 ms |
| kNN (vector index) | 100% | ~100% | 512 | 0.008 ms |
| **Slate** | 100% | **98-100%** | 8192* | 0.21 ms |

\* the *lab* substrate stores unpacked float32 cells; the production engine
bit-packs 32x (-> 256 B/rule).

Across a family of **48 finite-state programs run by one universal interpreter**
(`bench_program_family.py`), 5 seeds:

| interpreter store | clean (48 progs) | noisy (sigma=0.75) | capacity |
|---|---|---|---|
| dict | 100% | 0% | - |
| **Slate** | 100% | **100%** | all 957 rules of all 48 programs in one Slate -> 100% clean, no cross-talk |

**Read-out:** on clean cues Slate ties a dict (a dict is simpler - no advantage
there). Its specific, isolable contribution is **error-tolerant procedural
execution** - matching a vector index, and beating a brittle exact table when
the cue is imperfect - shown across a program family, not one cherry-picked case.

## Anatomy - what lives in the substrate vs in Python

| demo | stored in Slate | external machinery (Python) | baseline | seeds | result |
|---|---|---|---|---|---|
| addition (`procedure.py`) | 8 full-adder rules | bit loop + carry register | flashcards n/a (unbounded output) | 1 (deterministic) | 100% exact on unseen |
| div-7 (`transplant.py`) | 21-rule remainder DFA | MSB bit loop | flashcards 48% / haiku 57% | 1 (det.) | 100% |
| program family (`bench_program_family.py`) | 48 tables, 957 rules | ONE universal interpreter | identical dict-backed interpreter | 5 | Slate 100% clean+noisy; dict 0% noisy |
| store baseline (`bench_vs_baselines.py`) | div-7 table | the interpreter | dict, kNN | 30 | ties clean; beats dict under noise; ~= kNN |

Deterministic demos have variance 0 by construction (a DFA is exact); the seeds
matter for the stochastic store / noise comparisons.

## The primitive (`core.py`)
`Slate` = sign-projection onto bipolar cells + softmax-attention settle.
`key -> payload`, one-shot `commit`, `recall` settles a noisy/unseen key into
the nearest stored basin (error-correction) and reads the bound payload. The
`value` field is the in-substrate value channel TD writes to.

## The experiments

| file | claim | result |
|------|-------|--------|
| `run.py` C1 | feedback turns memory into action | PASS — watched a route once, chained it, and planned it in pure imagination |
| `run.py` C2 | value lives *in* the substrate | PASS — both branches seeded 0; TD climbed good→+1.0, bad→−0.5, propagated to V(START)=+0.9 |
| `run.py` C3 | width (redundancy) helps generalisation | PASS but modest — depth-8 96% vs flat 89% only once inputs are corrupted enough to confuse |
| `depth_test.py` | stacked *different* transforms compose | PASS decisively — solves K-relation queries iff depth ≥ K; flat single layer = 0%; reversed order = 0% (ordered composition) |
| `noise_ceiling.py` | is "50 deep" real? | YES if the alphabet stays separated. Accuracy ≈ (per-hop)^depth, so the ceiling is set by **alphabet crowding**, not depth. dim-48 → 50 deep free; crowd it → cliff |
| `router.py` | the cube chooses its own transforms | PASS — from P13→L2 it discovers the optimal `SIBLING→LIVES`, dodging the 1-hop `LIVES` trap, from reward alone |
| `pet.py` | assemble the parts into a creature that learns | Pip — a maze-learner whose whole brain is substrate + in-substrate value + routing; starts blind (200 steps), learns the optimal path (11 steps) from experience |
| `distill.py` | distil a LARGE model's knowledge into the cube so a SMALL model performs like it | the KNOWLEDGE gap collapses (LARGE−SMALL +89% → **+0%** with cube); the CAPABILITY gap does NOT transfer — it persists for non-smooth functions (parity +54% → +85%, *below chance*: memorising misleads) and only closes for locally-smooth ones (majority interpolates). Memory absorbs the smooth part of reasoning; the non-smooth part stays LARGE's job |
| `distill_llm.py` (**layer B**) | the same experiment with REAL models — SMALL=`claude-haiku-4-5`, LARGE=`claude-opus-4-8` | thesis reproduced on real questions. KNOWLEDGE (opus authors an obscure composer-lineage KB → distilled to 3 cube banks): haiku bare 17/33/8% at 1/2/3 hops → **cube 100/100/100%** = matches opus; gap −85% → **+0%**. CAPABILITY (opus labels, cube memorises, *balanced-acc* on unseen, chance=50%): PRIMALITY (non-smooth) cube seen 98% → **unseen 50% (chance)**; THRESHOLD (smooth) seen 100% → **unseen 82%**. Balanced-acc also exposed haiku's real primality skill = 48%≈chance (its 87% raw was pure base-rate) vs opus 96% — a genuine capability gap the cube provably cannot hand over. Whole run < $1 |
| `procedure.py` | teach the cube the METHOD, not the answers (Matthew's question, 2026-07-15) | **the distill wall falls.** Parity — the function flashcards fail at (400 memorised answers → 32% on unseen, ≈chance) — hits **100% on unseen inputs from a 4-rule lesson** ((state,bit)→state, looped over bits via the C1 feedback machinery). And an **8-rule full-adder lesson gives 100% exact ADDITION** on 400 never-seen pairs (e.g. 2779+2534=5313). The capability rides in compact rules run by a generic loop (loop control in Python, task rules in the substrate) — when distilled as composable steps + feedback, not examples. The distill.py boundary was about the lesson's FORMAT, not the substrate |
| `transplant.py` | the first AUTOMATIC skill transplant — opus authors the recipe, no human writes a rule | opus emits a skill as a step-table (DFA over bits), every rule — transitions AND outputs — poured into substrate, feedback loop executes it, verified vs TRUE gold on balanced unseen sets. **div-3: flashcards 35% / haiku 92% / cube 100%. div-7: flashcards 48% / haiku 57% (can't do it) / cube 100%.** 2 opus calls + 80 haiku calls ≈ **$0.03**. Layer B (facts) + procedure.py (methods) fused: automatic distillation of both substances of knowledge. Pay the large model once to write the lesson; own the skill forever, token-free |

## The picture these add up to
1. **Substrate** — a write-time million-ary, content-addressed, error-correcting alphabet.
2. **Feedback** — recall-as-set-point, fed back, becomes behaviour over time.
3. **Value, in-substrate** — one reserved layer per colour; TD makes it prefer the good; generalises for free. (The Seed/affect lane never needed to be a separate module.)
4. **Depth** — stacking different transforms composes inference a single layer can't; affordable to 50 deep while the alphabet stays separated.
5. **Router** — value-guided selection of *which* transform to fire, toward a goal it was never shown a path to.

## Honest open edges
- The error-correcting **settle bought ~nothing** on the depth ceiling — the failure there is *between*-basin misassignment, which cleanup can't fix. Separation is the depth lever, not the settle. (Settle should help in a different regime: confusable stored patterns probed by a corrupted *clean* symbol — untested.)
- The router learns **per-task**, not zero-shot. One value function handling new goals needs **goal-conditioning** (goal folded into the value key). Next step.
- Everything is small-scale and clean. Real scale + real noise is the next frontier.

## Run
```
python run.py            # C1 action, C2 value, C3 width
python depth_test.py     # stacked composition
python noise_ceiling.py  # the depth ceiling vs alphabet crowding
python router.py         # value-guided operator selection (per-task RL)
python bench_vs_baselines.py    # Slate vs dict vs kNN (the crux baseline)
python bench_program_family.py  # one interpreter, 48 finite-state programs
```
