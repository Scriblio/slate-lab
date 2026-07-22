# Working out what someone believes, by watching what they reach for

`cube_say.py` was **handed** the listener's mind. That is the cheat in it, and
this removes it. Here the speaker gets no privileged access to anyone: it sees
behaviour, and works backwards to what someone must believe for that to have been
a sensible thing to do. `cube_mind.py`, run it directly.

That backwards step is **EXPLAIN from `cube_cause.py`, pointed at a mind instead
of a world.** There: given this outcome, what caused it. Here: given this choice,
what would someone have to believe. Same abduction, different target. The
surviving-hypotheses machinery is `cube_hypothesis_learner.py`'s.

## The premise, checked before the harness was written

If one reach had one explanation, the inference would be a lookup table and none
of this would mean anything. It doesn't. Reaching for the herb is equally
consistent with three minds:

```
no-rule            needs  "eating soft things -> GONE"     a RULE
thinks-good/HERB   needs  "the herb is bitter"             a WARNING
thinks-bad/MELON   needs  "the melon is soft"              a RECOMMENDATION
```

Behaviourally identical, and — measured in `cube_say.py` — each needs a different
sentence. No single sentence works for all three. So the speaker has to earn the
right to speak: **watch longer**, or **ask**.

## 1. Does watching tell you what someone believes?

| prior scenes watched | survivors left | pinned exactly | true mind survives |
|---|---|---|---|
| 0 | 4.33 | 33% | 100% |
| 1 | 3.56 | 38% | 100% |
| 2 | 3.00 | 43% | 100% |
| 3 | 2.53 | 47% | 100% |
| 4 | 2.36 | 50% | 100% |

`true mind survives` is the soundness guard: inference may stay uncertain, it may
never rule out the truth. If that column ever drops, the hypothesis space is wrong
and every number under it is meaningless.

## 2 & 3. Speaking without privileged access, and the cost of asking

| speaker | k=0 | k=2 | k=4 |
|---|---|---|---|
| **infers, asks when it must** | **100%**, 24 asked | **100%**, 13 asked | **100%**, 6 asked |
| handed the mind (`cube_say`) | 100%, 0 asked | 100%, 0 asked | 100%, 0 asked |
| infers, will not ask | 77% | 90% | 95% |
| asks every time | 100%, 72 asked | 100%, 54 asked | 100%, 42 asked |
| assumes the usual mistake | 77% | 77% | 77% |

It reaches the handed-the-mind upper bound by spending questions, and spends fewer
the longer it has watched. Asking is disciplined:

| prior scenes | asked | needed to | **asked & needed** | asked, didn't need |
|---|---|---|---|---|
| 0 | 24/72 | 16/72 | **16/16** | 8 |
| 2 | 13/72 | 7/72 | **7/7** | 6 |
| 4 | 6/72 | 3/72 | **3/3** | 3 |

Every question that was genuinely required got asked. The waste is questions it
could have skipped — never a listener it failed to help.

## What went wrong first

**The "upper bound" wasn't one.** `OracleMind` was supposed to be handed the true
mind, and I never wired it — it received the same inferred survivors as the
never-ask baseline and scored identically to it (77/90/95). A baseline labelled
*upper bound* that silently isn't one is the worst kind, because everything above
it looks earned.

**The speaker never looked at what the listener was about to do.** It advised
people without seeing them reach — the single most informative observation
available, and the one this whole build is premised on. So it couldn't tell a
listener in trouble from one that was perfectly fine, and asked all 72 of them.
With the current reach used as evidence: 24 asks, and zero words spoken to a
listener that needed none.

**The success separation depends on the listener's tie-break, and I nearly
captioned over it.** All three failing minds are *tied* in the target scene — a
false belief about the herb makes it look exactly as good as the melon, not
better. So a listener that resolves ties the other way stumbles onto the right
answer unaided, and under `ties → last` **every** speaker scores 100%, including
the one that infers nothing. My first draft of that section said "the ordering
changes how many questions get spent, but not the conclusion: inferring beats
committing." The table directly below it said otherwise. That is the third time in
this session I have caught a caption asserting something its own measurement
contradicted, and it is the failure mode to watch for above all others.

So: **the inference is the result here; the success rate is its illustration.**
Soundness (100%) and survivor shrinkage hold under both orderings. The success
separation holds only for an unlucky listener, which is a limit of the setup, not
a property of the speaker. Pinned by `test_tie_break_dependence_is_declared_not_hidden`.

## Honest scope

One action. The listener's mind is a **single standing error drawn from a space
the speaker already knows** — so it infers *which* known way a mind is wrong, not
that minds exist or what kinds there could be. The listener answers questions
truthfully and believes what it is told; no deception, no scepticism, no
disagreement. Questions are a fixed form ("what do you think happens if you eat
X?") rather than composed language.

Standalone lab cube. Never reads, writes or imports the live production substrate.
