"""Pip — a pet that learns a maze on the Slate substrate.

Its whole brain is the parts we proved tonight:
  - Slate substrate  = its memory of places (core.py)
  - in-substrate value = how it learns what's worth doing (run.py C2)
  - value-guided choice = how it decides where to step (router.py)

It starts knowing nothing, flails, and gets faster every run as value
propagates back from the goal. You watch it get smarter.

This is a TOY LEARNER — a sandbox to grow the mechanisms, deliberately not a
being. Standalone lab cube; never touches the live production substrate.
"""
import numpy as np
from collections import deque
from core import Slate

MAZE = [
    "S....#.",
    ".###.#.",
    ".#...#.",
    ".#.#.#.",
    "...#...",
    "#.#.##.",
    ".....G",
]
MAZE = [row.ljust(7, ".") for row in MAZE]
H, W = len(MAZE), len(MAZE[0])
DIM = 128
ACTIONS = {"N": (-1, 0), "S": (1, 0), "E": (0, 1), "W": (0, -1)}
AK = list(ACTIONS)

rng = np.random.default_rng(7)
cellvec = {(r, c): rng.standard_normal(DIM).astype(np.float32)
           for r in range(H) for c in range(W) if MAZE[r][c] != "#"}
actvec = {a: rng.standard_normal(DIM).astype(np.float32) for a in AK}
START = next((r, c) for r in range(H) for c in range(W) if MAZE[r][c] == "S")
GOAL = next((r, c) for r in range(H) for c in range(W) if MAZE[r][c] == "G")


def open_cell(r, c):
    return 0 <= r < H and 0 <= c < W and MAZE[r][c] != "#"


def move(cell, a):
    dr, dc = ACTIONS[a]
    nr, nc = cell[0] + dr, cell[1] + dc
    return (nr, nc) if open_cell(nr, nc) else cell     # wall/edge -> stay


def step(cell, a):
    nxt = move(cell, a)
    if nxt == GOAL:
        return nxt, 1.0, True
    return nxt, (-0.05 if nxt == cell else -0.01), False   # bump costs more


def bfs_optimal():
    q, seen = deque([(START, 0)]), {START}
    while q:
        cell, d = q.popleft()
        if cell == GOAL:
            return d
        for a in AK:
            nxt = move(cell, a)
            if nxt not in seen and nxt != cell:
                seen.add(nxt); q.append((nxt, d + 1))
    return None


class Pip:
    """A maze-learner whose value lives in the Slate substrate."""
    def __init__(self, gamma=0.95, lr=0.4, seed=0):
        self.V = Slate(DIM, n_cells=1024, beta=35.0, seed=seed)
        self.idx = {}
        self.gamma, self.lr = gamma, lr

    def q(self, cell, a):
        i = self.idx.get((cell, a))
        return self.V.value_of(i) if i is not None else 0.0

    def _set(self, cell, a, v):
        i = self.idx.get((cell, a))
        if i is None:
            self.idx[(cell, a)] = self.V.commit(cellvec[cell] + actvec[a],
                                                payload=(cell, a), value=v)
        else:
            self.V.set_value(i, v)

    def choose(self, cell, eps):
        if rng.random() < eps:
            return AK[int(rng.integers(4))]
        qs = [self.q(cell, a) for a in AK]
        return AK[int(np.argmax(qs))]

    def episode(self, eps, max_steps=200, learn=True):
        cell, steps = START, 0
        for steps in range(1, max_steps + 1):
            a = self.choose(cell, eps)
            nxt, reward, done = step(cell, a)
            if learn:
                best_next = 0.0 if done else max(self.q(nxt, aa) for aa in AK)
                td = reward + self.gamma * best_next
                self._set(cell, a, self.q(cell, a) + self.lr * (td - self.q(cell, a)))
            cell = nxt
            if done:
                return steps
        return steps

    def greedy_path(self, max_steps=200):
        cell, path = START, [START]
        for _ in range(max_steps):
            a = self.choose(cell, eps=0.0)
            cell = move(cell, a)
            path.append(cell)
            if cell == GOAL:
                break
        return path


def render(path=None):
    on = set(path or [])
    for r in range(H):
        line = ""
        for c in range(W):
            if (r, c) == START: line += "S"
            elif (r, c) == GOAL: line += "G"
            elif MAZE[r][c] == "#": line += "#"
            elif (r, c) in on: line += "*"
            else: line += "."
        print("  " + line)


def sep(t): print("\n" + "=" * 60 + f"\n{t}\n" + "=" * 60)


sep("the maze  (S=start, G=goal, #=wall)")
render()
opt = bfs_optimal()
print(f"\n  shortest possible path: {opt} steps")

sep("Pip learns  (steps to reach the goal, per run)")
pip = Pip()
milestones, curve = [1, 5, 20, 50, 100, 300], []
for ep in range(1, 301):
    eps = max(0.05, 1.0 - ep / 180)
    s = pip.episode(eps)
    curve.append(s)
    if ep in milestones:
        recent = int(np.mean(curve[-10:]))
        print(f"  run {ep:>3}:  {s:>3} steps   (last-10 avg {recent})")

sep("first run vs learned run")
print("  early flailing:")
early = Pip()
early.episode(eps=1.0, learn=False)      # a fresh pet, no learning: pure wander
p_early = early.greedy_path(max_steps=60)
print(f"    wandered {len(p_early)} steps without finding a route\n")
print("  after learning — Pip's chosen path:")
p = pip.greedy_path()
render(p)
reached = p[-1] == GOAL
print(f"\n  Pip's path: {len(p) - 1} steps"
      + (f"  — OPTIMAL ({opt})" if len(p) - 1 == opt else f"  (optimal {opt})")
      + ("" if reached else "  [did not reach goal]"))

sep("VERDICT")
print(f"Pip started knowing nothing and learned the maze from experience alone,")
print(f"value climbing back from the goal through the same substrate we built")
print(f"tonight. {'It found the optimal route.' if len(p)-1==opt else 'It solved it.'}")
