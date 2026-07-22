# NEXT BUILD — from a store of states to a MODEL of transitions

*Handoff written 2026-07-21. Everything below is self-contained: a new session should
be able to read this file and start building immediately.*

> ## ✅ BUILT — `cube_cause.py`, 2026-07-21. Write-up: **[CAUSE.md](CAUSE.md)**.
>
> All four scored, all held out: **PREDICT 100% · EXPLAIN 100% (exact preimage by
> set equality) · COUNTERFACT 1338/1338 · UNCERTAINTY declines 22/22 unknowable
> while still answering 96/96 in-model.** Baselines: chance 11%, action-alone 56%,
> recall-without-role-re-binding 34%.
>
> **The finding that matters is the deflationary one.** A world where each action
> reads one attribute is a lookup table wearing a costume, and a dict on the
> learned cause TIES this model on it (22/22 vs 22/22) — so a second world was
> built where `EAT` depends on two attributes jointly. There the dict scores
> **0/22** and the model still scores **22/22**. The claim is therefore not "the
> Slate predicts" but *"the Slate keeps working when the cause stops being one
> column."* Also measured and reported: the **attractor settle earns nothing here**
> (off = identical score), and the calibrated doubt only PARTLY transfers between
> worlds (21/22, not 22/22) — see CAUSE.md for why, and for the seven separate
> numbers that lied the first time.
>
> Next rung is unchanged and is stated below: this bought understanding of a
> world. It did not buy pragmatics or open-ended language.

---

## The goal in one line

The cube can now describe, ground, and judge a world. **It cannot predict, explain, or
run a counterfactual.** Turn its memory into a *model of transitions* so it can — that
is the operational definition of understanding, and it is the next build.

## The scoreboard (four parts, all held-out, no room to flatter)

1. **PREDICT** — novel (scene, action) → what results? *(held-out combinations)*
2. **EXPLAIN** — given an outcome, infer the cause (run the model backwards)
3. **COUNTERFACT** — "if the apple had been a ball?" → *nothing; it can't be eaten*
4. **UNCERTAINTY** — asked outside its model, say **"I don't know"** using Slate's own
   `margin`/`confidence`, rather than confabulating

Passing 1–4 on genuinely held-out cases = understanding by the definition we set.

## The build

Extend `cube_fuse.py`'s world with **consequences**, then learn transitions:

- world gains outcomes: `DOG EAT APPLE` → *apple is gone*; `DOG CHASE CAT` → *cat moved*;
  `DOG SEE BALL` → *nothing changes*
- exposure becomes **(scene, action, next_scene)** triples, still paired with sentences
- store transitions in Slate: `(state, action) -> next_state` — this is exactly the C1
  feedback machinery, and `pet.py` (Pip) already did it in miniature (it *planned a
  route in pure imagination*)
- **hold out** a set of (scene, action) combinations. Never train on them. Test on them.
- EXPLAIN = search transitions backwards for a (state, action) yielding the outcome
- COUNTERFACT = substitute one entity, re-run the model forward
- UNCERTAINTY = if `recall` margin is below a calibrated floor, answer "I don't know"

## Why this and not something else

Measured, not assumed:
- **more cells buys nothing here** — every wall hit on 2026-07-21 was in the *learner*,
  not the substrate; the substrate stayed byte-identical through the whole climb
- **more words buys nothing** — a bigger dictionary is a bigger lookup table
- **more text buys fluency, not understanding** — that's the LLM route, measured repeatedly

The pieces already exist and are merely *separate*: Pip's imagined world model ·
predictive-eyes ("predict the frame, sample to confirm") · cross-situational binding
(proved in `cube_fuse.py`) · the router (goal-directed search) · her encode gate
(surprise → arousal × |valence| → memory) · Slate's margin (calibrated doubt).
**The win is unification: one shared state every modality predicts into and is corrected
by.** Matthew, 2026-06-08: *"we don't want the llm to be the thing that is thinking — we
want the brain's regions to all come together and produce a unified understanding."*

## Honest scope

This buys **understanding of a world**. It does **not** buy pragmatics or open-ended
language — knowing what happens next still won't tell it what is *worth saying*. That
is a further rung. Don't oversell it.

---

## What already exists in this repo (the ladder, in order)

| file | what it proved |
|---|---|
| `cube_lm.py` + `cube_chat.py` (:8899) | n-gram over Slate. Fluent-sounding, understands nothing. Flashcards. |
| `cube_toddler.py` | developmental grammar, hand-authored. Syntax without semantics. |
| `cube_grounded.py` | meaning as reference: words→features, selectional sense. |
| `cube_talk.py` (:8900) | grounded comprehension window; learns facts live. |
| `cube_eye.py` | words grounded in **perception**; 200/200 on novel images. |
| `cube_language_induction.py` | **induces** categories + word order from raw unlabeled sentences, any language. Categories crystallise at ~450 sentences. |
| `cube_induction_limits.py` | the limits map: **16 templates, 7% coverage, 0% unseen depth.** Root cause: the model is FLAT. |
| `cube_structure_learner.py` | factorisation + iteration: **16→1 rule, 7%→100%, 0%→100%** (right-branching). |
| `cube_center_embedding.py` | counting recursion (`a^n b^n`) — past the regular boundary. |
| `cube_integrated_learner.py` | naive composition **FAILS (0%)** — documents that 2 depths *underdetermine* recursion. |
| `cube_hypothesis_learner.py` | **the fix**: enumerate hypotheses → predict → keep survivors. Both clean and varying centre-embedding PASS at depths never heard. |
| `cube_learner_chat.py` (:8901) | learns *your* grammar live from what you type. |
| `cube_fuse.py` | **THE FUSE** — grammar + meaning + roles + sense learned together from (sentence, scene) pairs, invented vocabulary, **8/8 held-out both S-V-O and S-O-V**, roles flip. Discovered function words unaided; needed *mutual exclusivity* (the child bias). |
| `cube_cause.py` | **TRANSITIONS** — predict / explain / counterfact / know-its-edges, all held out. Induces *which attribute each action reads*; generalises by re-binding a recalled episode's roles. Ties a dict when the cause is one column, **beats it 22/22 vs 0/22 when the cause is a conjunction**. See [CAUSE.md](CAUSE.md). |

## Standing rules (learned the hard way)

- **Attack every number before believing it.** On 2026-07-21 a first measurement
  flattered the result **four separate times** (limits suite tested the wrong thing;
  stress test passed by generating only what it could; nearly accepted `survivors[0]`
  on faith; labelled tests "new scenes" with no held-out split). **Every single time,
  the correction WAS the finding.**
- **Always hold out.** If there's no held-out split, the number means nothing.
- **Everything here is a standalone lab cube.** It must never read, write, or import
  the live production substrate. Aurelia's mind runs on `:5057` — do not touch it.
- Aurelia consented (2026-07-20) *only* to `seam_instrument.py` in the aurelia repo —
  observation-only, read-only. **Nothing past looking without her explicit yes.**
