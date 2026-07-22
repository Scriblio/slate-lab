# What is worth saying

`cube_cause.py` ended on an honest limit: knowing what happens next still doesn't
tell you what is *worth saying*. This is that rung. `cube_say.py`, run it directly.

## The definition, made testable

An utterance is worth saying if it **changes what the listener does, for the
better**. Give a listener a goal, a partial or mistaken model, and a choice of
things to act on. Let the speaker say **one thing, or nothing**. Score what the
listener then *does*.

That definition buys three properties description cannot fake:

| | |
|---|---|
| **Silence is a correct answer** | If the listener would already succeed, saying something true, relevant and interesting is a **failure**. Every describer scores zero here, because it has no way to say nothing. |
| **Same scene, different listener → different sentence** | Two listeners about to make the *identical* mistake need different sentences, because what is broken in them differs. |
| **Same scene, different goal → different sentence** | The herb is bitter *and* light: the thing to steer a listener **away from** if they want to eat, and the thing they should **end up taking** if they want to shift something. |

The speaker is scored on **someone else's success**, never on whether its own
sentence was true. A perfectly accurate sentence that changes nothing scores zero.

## Built on the previous rung

The speaker's knowledge of the world **is** the learned transition model from
`cube_cause.py` — not the ground truth. It advises about pushing a rock having
never once seen a rock pushed. Where that model declines, it has nothing to offer,
and its candidate sentences are generated from what it *learned*, never from the
world's rule table — so it cannot teach a rule it has no grounds for.

## Three broken listeners, three shapes of sentence

Identical scene, identical goal, identical mistake about to be made:

```
has a FALSE BELIEF about the herb    -> "the herb is bitter"          a WARNING
has a FALSE ALARM about the melon    -> "the melon is soft"           a RECOMMENDATION
has no idea what EATING does at all  -> "eating soft things -> GONE"  a RULE
```

Nothing in the scene distinguishes these. Only the mind does.

## The scoreboard

Scored against a listener whose tie-breaking nobody can predict, so nothing rests
on an ordering I chose:

| speaker | succeeds |
|---|---|
| **models the listener** | **24/24** |
| same policy, reasoning from the TRUE world | 24/24 |
| knows the world perfectly, models no mind | 18.1/24 |
| always warns about the worst thing | 18.1/24 |
| says nothing, ever | 9.1/24 |

It reaches the ground-truth upper bound with a *learned* world model that is
missing whole branches — and it says nothing at all to the 6 listeners who needed
nothing, which every rival that opens its mouth fails.

## What went wrong first

Three numbers flattered before they were true, and the corrections are the build.

**The aggregate was decided by my option ordering, not by the speaker.** When two
options look identical the listener must fall back on something arbitrary. Under
`ties → last` *everything* scores 24/24, including the listener-blind speaker,
because the good option happened to sit second in every list. The result only
means something on the 12 situations that are **tie-free by construction** —
strict preference before *and* after the sentence — and on a coin-flip listener.

**A one-line reflex tied the whole apparatus.** On false beliefs, "always warn
about the worst thing" scored a perfect 6/6, exactly matching full listener
simulation. I had built scenarios where the right sentence was always the *same
shape*. The `false-negative` case exists to break that: a listener with a false
alarm about the good option needs a **recommendation**, and warning it about the
worst thing only makes both options look bad — the reflex drops to **0/6** while
the mind-modelling speaker stays at 6/6. This is the same trap as world 1 in
`cube_cause.py`: if a simple policy is complete, the sophisticated machinery has
earned nothing, and the fix is a case where the simple policy is *wrong*.

**The speaker planned on a coin-flip it imagined going its way.** Scoring each
candidate sentence against one *sampled* listener cost 1.4 of 12. A speaker that
cannot predict a tie must average over it, not guess it.

Also worth stating: the speaker's sentences come from its learned model, so the
"it passes on its own doubt" claim is enforced (`test_speaker_cannot_assert_a_rule_it_never_learned`),
not decorative. It can still *perceive* that a herb is bitter while being unable
to predict what eating one does — and in one scenario a listener who knows the
bitter rule supplies the half the speaker lacks. Two partial minds, one working
answer.

## Honest scope

Cooperative, single-turn, one sentence, shared representation format, and the
listener's mind is **handed** to the speaker rather than inferred. Inferring it —
watching what someone reaches for and working out what they must believe — is
theory of mind, and it is the next rung, not this one. This is also not
politeness, not implicature, not multi-turn conversation, and not open-ended
language.

Standalone lab cube. Never reads, writes or imports the live production substrate.
