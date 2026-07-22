# The cheapest thing that would tie each rung

Three builds on 2026-07-21 all turned on the same discovery, and it was never the
one I set out to make:

- **`cube_cause`** — a two-column dict ties the attractor substrate, until the
  cause stops being one column wide.
- **`cube_say`** — "always warn about the worst thing" ties a full model of the
  listener's mind, until warning is the wrong move.
- **`cube_mind`** — every speaker ties, including the one that infers nothing,
  until the listener is unlucky.

That is one finding recurring, not three: **the sophisticated thing only earns its
place in the case where the simple thing is wrong, and I only found that case
because I went looking each time.** The rungs below `cube_cause` were written
without anybody going looking. `deflate.py` does that, for the two with the most
suspicious numbers. Three claims, three different outcomes.

---

## DEFLATED — `cube_eye`: "200/200 = 100% on images it never saw"

| method | correct |
|---|---|
| the Slate eye, as shipped | 200/200 = 100% |
| **nearest centroid, same 5 features** | **200/200 = 100%** |
| 1-NN on raw pixels, no percept at all | 187/200 = 93% |
| nearest centroid, colour only | 163/200 = 81% |
| nearest centroid, shape only | 125/200 = 62% |
| chance | 20% |

A class average ties it exactly, and raw pixels get within 7 points with no
perceptual front-end at all. The 100% is a fact about the **task**: five words
over four distinct colours, and the single colour-clash pair (apple/leaf, both
green) is separated by shape. Colour-only scoring 81% is exactly right — perfect
on the three unambiguous words, a coin-flip on the green pair.

Turning the jitter up is worse for the substrate, not better:

| jitter | Slate | centroid | raw pixels | colour only |
|---|---|---|---|---|
| ×1 | 99% | **100%** | 95% | 81% |
| ×2 | 94% | **99%** | 70% | 81% |
| ×3 | 85% | **97%** | 58% | 81% |
| ×4 | 78% | **92%** | 47% | 79% |
| ×6 | 62% | **74%** | 35% | 68% |

**The class average beats the Slate at every noise level, by up to 12 points.**
The reason isn't subtle: the Slate commits every exemplar and recalls the nearest
one, so a noisy training example survives as its own basin, while a mean averages
the noise away. On this task the attractor substrate isn't merely tied by an
average — it *loses* to one, and by more the harder the task gets.

**What does survive** is the other half of the story, and the sweep supports it
cleanly: raw pixels collapse fastest (95% → 35%) because position jitter moves
every pixel, while the percept is translation-invariant by construction. So the
honest claim is not "the substrate recognises things" but **"the percept is
translation-invariant and raw pixels are not."** That is a real result about the
retina. It is not a result about the Slate.

## REFRAMED — `cube_structure_learner`: "coverage 7% → 100%"

`rule_coverage` asks what fraction of the shapes it *heard* the grammar can still
produce. That is recall, and there is no precision term anywhere in the file — so
a grammar that permits anything also scores 100%. Supplying the missing half:

| grammar | rules | coverage | precision | F1 |
|---|---|---|---|---|
| shipped (optional + agreement) | 1 | 100% | **100%** | 100% |
| optional only, no agreement | 4 | 100% | 100% | 100% |
| raw templates, memorised | 16 | 100% | 100% | 100% |
| null: anything goes | 1 | **100%** | **0%** | 0% |

Two things follow. The shipped grammar **survives** — it says only grammatical
things, including the number agreement it would have been easy to lose silently
while coverage sat at a perfect 100%. But memorising the raw templates scores
100/100 as well, because it *is* the data. So what the collapse actually buys is
**compression — 16 rules to 1 — not correctness.** That is still a real result;
it is not the result the file claims. (The agreement step specifically buys
nothing beyond what optionality already got, except shrinking 4 rules to 1.)

## SURVIVED, AND GOT STRONGER — "unseen depth 0% → 100%"

The shipped test *generates* a depth-3 sentence from the learned rule and checks
it came out grammatical. But the sentence is built by drawing words from the
induced categories — so that test can only fail if a category is impure. All 4
induced categories are pure, so it could not have failed. It is a purity
measurement wearing a recursion label.

A generator is not a grammar; a grammar draws a line. Turned into an **acceptor**
(base + block × n for any n) and fed corruptions:

| depth | accepts good | rej. wrong-word | rej. half-block | rej. reordered |
|---|---|---|---|---|
| 1 (heard) | 120/120 | 120/120 | 120/120 | 120/120 |
| 2 (never heard) | 120/120 | 120/120 | 120/120 | 120/120 |
| 3 (never heard) | 120/120 | 120/120 | 120/120 | 120/120 |
| 4 (never heard) | 120/120 | 120/120 | 120/120 | 120/120 |

The last two corruption types keep every word legal and break only the
*structure*. It rejects them at depths it never heard. **That is a bigger claim
than the one the file made** — not merely emitting unseen depths, but drawing a
line at them.

---

## What to carry forward

Neither rung was fabricated. Both were reported without the one measurement that
would have located their limits — and in one case that measurement made the claim
*stronger*, which is the argument for running it even when you expect it to hurt.

The rule this session earned, five separate times: **write the cheapest rival
before believing your own number, and if it ties, the interesting result is
wherever it stops tying.** Findings pinned in `test_deflate.py`, deliberately
written to fail if a flattering version of any of these is ever restored.

Still unaudited: `cube_language_induction` (would frequency clustering tie the
induced categories?), `cube_hypothesis_learner` (is the hypothesis space doing the
work, or is one dumb rule enough?), `cube_fuse` (what does a plain co-occurrence
counter score without mutual exclusivity?).

Standalone lab cube. Never reads, writes or imports the live production substrate.
