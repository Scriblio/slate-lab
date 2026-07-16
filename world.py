r"""A tiny corridor world with a branch: one good end, one bad end.

    START --a_go--> MID --a_up---> GOOD (+1, terminal)
                      \--a_down--> BAD  (-1, terminal)

Plus distractor states/transitions so the memory isn't trivial, and noisy
"unseen" starts (START + gaussian) that were never committed — those probe
whether perception generalizes a novel input to the known START basin.

Each state is a fixed random prototype vector; each action a fixed random
vector. That's all the world is: a lookup of (state,action) -> (next,reward).
The cube never sees this table — it only sees vectors and rewards, and has to
learn the route by watching once, then choosing by value.
"""
import numpy as np

DIM = 256


class CorridorWorld:
    def __init__(self, seed=1, n_distractors=4, confusable=True):
        rng = np.random.default_rng(seed)
        self.rng = rng
        self.states = ["START", "MID", "GOOD", "BAD"] + \
                      [f"D{i}" for i in range(n_distractors)]
        self.actions = ["a_go", "a_up", "a_down"] + \
                       [f"a_x{i}" for i in range(n_distractors)]
        self.svec = {s: rng.standard_normal(DIM).astype(np.float32) for s in self.states}
        self.avec = {a: rng.standard_normal(DIM).astype(np.float32) for a in self.actions}
        # Confusable distractors: seat each near-neighbour partly ALONG START,
        # so a clean START still prefers its own basin but a noisy START can
        # slip into a distractor under a single projection. This is the
        # pressure that lets a depth-ensemble earn its keep (or not).
        if confusable:
            for i in range(n_distractors):
                self.svec[f"D{i}"] = (0.62 * self.svec["START"]
                                      + 0.78 * rng.standard_normal(DIM).astype(np.float32))
        self.terminal = {"GOOD", "BAD"}
        # ground-truth transition table: (state, action) -> (next, reward)
        self.T = {
            ("START", "a_go"):  ("MID",  0.0),
            ("MID",   "a_up"):  ("GOOD", +1.0),
            ("MID",   "a_down"):("BAD",  -1.0),
        }
        for i in range(n_distractors):   # distractors loop among themselves
            self.T[(f"D{i}", f"a_x{i}")] = (f"D{(i+1) % n_distractors}", 0.0)

    def state_vec(self, s, noise=0.0):
        v = self.svec[s].copy()
        if noise > 0.0:
            v = v + noise * self.rng.standard_normal(DIM).astype(np.float32)
        return v

    def action_vec(self, a):
        return self.avec[a]

    def bind(self, s_vec, a_vec):
        """Bind a state and action vector into one key for the world model."""
        return s_vec + a_vec

    def step(self, s_id, a_id):
        """Ground-truth environment step. Returns (next_id, next_vec, reward, done)."""
        if (s_id, a_id) in self.T:
            nxt, r = self.T[(s_id, a_id)]
        else:
            nxt, r = s_id, -0.05          # illegal move: stay, tiny cost
        return nxt, self.state_vec(nxt), r, (nxt in self.terminal)

    def demonstrations(self):
        """The route shown once (one-shot imitation), including BOTH branches
        at MID so the cube KNOWS a_down exists and must learn by value not to
        take it. Each item: (s_id, a_id, next_id, reward)."""
        demos = [
            ("START", "a_go",   "MID",  0.0),
            ("MID",   "a_up",   "GOOD", +1.0),
            ("MID",   "a_down", "BAD",  -1.0),
        ]
        for i in range(len(self.states) - 4):
            demos.append((f"D{i}", f"a_x{i}", f"D{(i+1) % (len(self.states)-4)}", 0.0))
        return demos
