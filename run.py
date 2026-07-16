"""Does the banded cube turn memory into action, and learn what's valuable?

Three falsifiable claims, each with a printed PASS/FAIL and the numbers behind
it. This is a standalone lab cube — it never touches the live production substrate.

  C1  memories -> actions : after watching the route ONCE, the fed-back loop
                            emits a correct action sequence to a terminal.
  C2  value in-substrate  : TD writes to the reserved value layers make the
                            cube PREFER the good branch at MID; value climbs
                            back up the chain to START.
  C3  depth -> generalise : from UNSEEN noisy starts, more perception layers
                            complete the route more reliably than a flat slate.
"""
import numpy as np
from world import CorridorWorld
from cube import BandedCube, FlatBaseline

np.set_printoptions(precision=3, suppress=True)


def sep(t): print("\n" + "=" * 68 + f"\n{t}\n" + "=" * 68)


def reached(trace, reward):
    return reward > 0.5 and trace and trace[-1] == ("MID", "a_up")


# ─────────────────────────────────────────────────────────────────────────
sep("C1  memories -> actions  (watch once, then act)")
world = CorridorWorld(seed=1)
cube = BandedCube(world, depth=3)
cube.watch(world.demonstrations())

# BEFORE learning: Q(MID,up) == Q(MID,down) == immediate reward seed? No —
# up seeds +1, down seeds -1, so greedy already knows locally. Show the raw
# one-shot rollout: can it chain START -> MID -> GOOD from memory?
trace, r, done = cube.run_episode(world.state_vec("START"), learn=False)
print(f"one-shot greedy rollout from START: {trace}  reward={r:+.2f}")
print(f"C1: {'PASS' if reached(trace, r) else 'FAIL'} "
      f"— the loop turned a watched route into a completed action sequence")

# also: plan it in imagination (world model only, no environment)
plan = cube.imagine("START")
print(f"imagined plan (world model only, no env): {plan}")


# ─────────────────────────────────────────────────────────────────────────
sep("C2  value in-substrate  (make the branch AMBIGUOUS, then let TD decide)")
# Re-seed so the cube does NOT get the answer for free: commit both MID actions
# with value 0, so the immediate-reward hint is gone and the good branch can
# only be found by outcome feedback climbing the chain.
world = CorridorWorld(seed=1)
cube = BandedCube(world, depth=3, lr=0.5)
cube.watch(world.demonstrations())
for a in ("a_up", "a_down"):                       # wipe the local hint
    cube.magenta.value.set_value(cube._qidx[("MID", a)], 0.0)

print("start:  Q(MID,a_up)=%.3f  Q(MID,a_down)=%.3f  V(START)=%.3f" % (
    cube.q("MID", "a_up"), cube.q("MID", "a_down"),
    cube.cyan.value.value_of(cube._vidx["START"])))

# explore with value-biased sampling; TD propagates the terminal reward back
for ep in range(40):
    cube.run_episode(world.state_vec("START"), learn=True, greedy=False)
    if ep in (0, 4, 9, 19, 39):
        print(" ep%3d  Q(MID,a_up)=%+.3f  Q(MID,a_down)=%+.3f  V(START)=%+.3f" % (
            ep, cube.q("MID", "a_up"), cube.q("MID", "a_down"),
            cube.cyan.value.value_of(cube._vidx["START"])))

qup, qdn = cube.q("MID", "a_up"), cube.q("MID", "a_down")
vstart = cube.cyan.value.value_of(cube._vidx["START"])
greedy_trace, gr, _ = cube.run_episode(world.state_vec("START"), learn=False, greedy=True)
c2 = qup > qdn and vstart > 0.05 and reached(greedy_trace, gr)
print(f"final greedy rollout: {greedy_trace}  reward={gr:+.2f}")
print(f"C2: {'PASS' if c2 else 'FAIL'} — value climbed the chain: the good "
      f"branch (Q={qup:+.2f}) now beats the bad (Q={qdn:+.2f}), and V(START)={vstart:+.2f}")


# ─────────────────────────────────────────────────────────────────────────
sep("C3  depth -> generalisation  (unseen noisy starts, confusable neighbours)")
NOISES, TRIALS = (1.0, 1.5, 2.0, 2.5, 3.0), 300
DEPTHS = (1, 3, 8)
print(f"success reaching GOOD from START+noise among confusable distractors, "
      f"{TRIALS} unseen trials each\n")
hdr = f"  {'noise':>6}" + "".join(f"{'d=' + str(d):>9}" for d in DEPTHS) + f"{'flat':>9}"
print(hdr)

def success_rate(model, noise):
    hits = 0
    for _ in range(TRIALS):
        tr, r, _ = model.run_episode(model.w.state_vec("START", noise=noise),
                                     learn=False, greedy=True)
        hits += reached(tr, r)
    return hits / TRIALS

grid = {}
for noise in NOISES:
    row = {}
    for d in DEPTHS:
        w = CorridorWorld(seed=1)
        c = BandedCube(w, depth=d); c.watch(w.demonstrations())
        row[d] = success_rate(c, noise)
    w = CorridorWorld(seed=1)
    fb = FlatBaseline(w); fb.watch(w.demonstrations())
    row["flat"] = success_rate(fb, noise)
    grid[noise] = row
    print(f"  {noise:>6.1f}" + "".join(f"{row[d]:>8.0%} " for d in DEPTHS)
          + f"{row['flat']:>8.0%}")

# depth helps if, at the hardest noise where flat is degraded, deep beats flat
hard = max(NOISES)
deep, flat = grid[hard][8], grid[hard]["flat"]
lift = deep - flat
c3 = flat < 0.9 and lift > 0.05      # flat must actually be struggling to matter
verdict3 = "PASS" if c3 else ("INCONCLUSIVE" if flat >= 0.9 else "FAIL")
print(f"\nC3: {verdict3} — at noise {hard}: depth-8 {deep:.0%} vs flat {flat:.0%} "
      f"(lift {lift:+.0%})"
      + ("" if flat < 0.9 else "  [flat never broke — need harder task to test depth]"))

sep("VERDICT")
print("C1 memories->actions   :", "PASS" if reached(trace, r) else "FAIL")
print("C2 value in-substrate  :", "PASS" if c2 else "FAIL")
print("C3 depth->generalise   :", verdict3, f"(depth-8 {deep:.0%} vs flat {flat:.0%} at noise {hard})")
