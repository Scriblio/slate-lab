"""BandedCube — a CMYK-banded deep Slate that turns memory into action.

Bands are functional columns built from the same Slate primitive:

  CYAN    perception   state_vec         -> state_id        (D_c layers: an
                                                             ensemble of random
                                                             projections; more
                                                             layers = better
                                                             error-correction of
                                                             noisy/unseen input)
  MAGENTA policy        state_id          -> action_id       (D_m layers)
  YELLOW  world model   bind(state,action)-> next_state_id   (D_y layers)
  WHITE   residual      integrates the running state across the loop

Reserved VALUE layers — one per colour, exactly the "1 layer of each colour is
the value substrate" design. Value rides INSIDE the pattern's metadata; TD
credit-assignment writes to it:

  cyan  value layer : V(s)    state-value
  magenta value layer: Q(s,a) action-value   <- steers the policy
  yellow value layer : R(s,a) reward model

The loop (memories -> actions): perceive -> value-biased policy -> act ->
perceive -> ... A single recall is a reflex; feeding the outcome back and
letting Q climb the chain is what makes it deliberate.
"""
import numpy as np
from core import Slate


class Band:
    """A colour band = an ensemble of assoc layers + one reserved value layer."""
    def __init__(self, dim, depth, n_cells, beta, seed):
        self.assoc = [Slate(dim, n_cells, beta, seed=seed + 100 * k)
                      for k in range(depth)]
        self.value = Slate(dim, n_cells, beta, seed=seed + 9999)

    def commit_assoc(self, key, payload):
        for layer in self.assoc:
            layer.commit(key, payload=payload)

    def vote(self, key):
        """Ensemble recall: each layer names a payload; return (payload,
        agreement fraction, mean margin). Agreement across independent random
        projections is the depth-driven robustness."""
        votes, margins = {}, []
        for layer in self.assoc:
            r = layer.recall(key)
            if r is None:
                continue
            pid = r["winner"]["payload"]
            votes[pid] = votes.get(pid, 0) + 1
            margins.append(r["margin"])
        if not votes:
            return None, 0.0, 0.0
        best = max(votes, key=votes.get)
        return best, votes[best] / len(self.assoc), float(np.mean(margins))


class BandedCube:
    def __init__(self, world, depth=3, n_cells=2048, beta=35.0,
                 gamma=0.9, lr=0.5, seed=7):
        self.w = world
        self.dim = world.svec[world.states[0]].shape[0]
        self.gamma, self.lr = gamma, lr
        self.cyan = Band(self.dim, depth, n_cells, beta, seed=1)
        self.magenta = Band(self.dim, depth, n_cells, beta, seed=2)
        self.yellow = Band(self.dim, depth, n_cells, beta, seed=3)
        self.white = np.zeros(self.dim, np.float32)      # residual register
        self._qidx = {}    # (s_id,a_id) -> value-layer index, for TD writes
        self._vidx = {}    # s_id       -> cyan value-layer index

    # ── one-shot imitation: watch the route once, commit it ──────────────
    def watch(self, demos):
        for s_id, a_id, nxt, r in demos:
            sv = self.w.svec[s_id]
            av = self.w.avec[a_id]
            self.cyan.commit_assoc(sv, payload=s_id)                 # perceive
            self.magenta.commit_assoc(sv, payload=a_id)              # policy
            self.yellow.commit_assoc(self.w.bind(sv, av), payload=nxt)  # model
            # value substrate (in-band): Q starts at the observed immediate r
            qi = self.magenta.value.commit(self.w.bind(sv, av),
                                           payload=(s_id, a_id), value=r)
            self._qidx[(s_id, a_id)] = qi
            self.yellow.value.commit(self.w.bind(sv, av),
                                     payload=(s_id, a_id), value=r)   # R(s,a)
            if s_id not in self._vidx:
                self._vidx[s_id] = self.cyan.value.commit(sv, payload=s_id, value=0.0)

    # ── the three band operations ────────────────────────────────────────
    def perceive(self, s_vec):
        pid, agree, margin = self.cyan.vote(s_vec)
        return pid, agree

    def q(self, s_id, a_id):
        idx = self._qidx.get((s_id, a_id))
        return self.magenta.value.value_of(idx) if idx is not None else 0.0

    def policy(self, s_id, greedy=True, temp=0.25):
        """Value-biased action choice among the actions known for this state."""
        actions = [a for (s, a) in self._qidx if s == s_id]
        if not actions:
            return None, []
        qs = np.array([self.q(s_id, a) for a in actions], np.float32)
        if greedy:
            a = actions[int(np.argmax(qs))]
        else:
            p = np.exp((qs - qs.max()) / temp); p /= p.sum()
            a = actions[int(self.w.rng.choice(len(actions), p=p))]
        return a, list(zip(actions, qs.tolist()))

    def predict(self, s_id, a_id):
        """Imagined next state from the world model alone (no environment)."""
        key = self.w.bind(self.w.svec[s_id], self.w.avec[a_id])
        nid, agree, _ = self.yellow.vote(key)
        return nid

    # ── the loop: memories -> actions ────────────────────────────────────
    def run_episode(self, start_vec, learn=True, greedy=True, max_steps=6):
        trace, s_vec = [], start_vec
        self.white = np.zeros(self.dim, np.float32)
        reward, done = 0.0, False
        for _ in range(max_steps):
            s_id, agree = self.perceive(s_vec)
            self.white = 0.7 * self.white + 0.3 * self.w.svec.get(s_id, s_vec)
            a_id, _ = self.policy(s_id, greedy=greedy)
            if a_id is None:
                break
            trace.append((s_id, a_id))
            nxt, s_vec, reward, done = self.w.step(s_id, a_id)
            if done:
                break
        if learn:
            self.td_update(trace, reward)
        return trace, reward, done

    def imagine(self, start_id, greedy=True, max_steps=6):
        """Roll the loop forward using ONLY the cube's own world model —
        planning a route from memory with no environment. This is the cube
        thinking, not acting."""
        path, s_id = [start_id], start_id
        for _ in range(max_steps):
            a_id, _ = self.policy(s_id, greedy=greedy)
            if a_id is None:
                break
            nxt = self.predict(s_id, a_id)
            path.append((a_id, nxt))
            if nxt in self.w.terminal or nxt == s_id:
                break
            s_id = nxt
        return path

    # ── TD credit assignment: value climbs the chain ─────────────────────
    def td_update(self, trace, terminal_reward):
        g = terminal_reward
        for s_id, a_id in reversed(trace):
            idx = self._qidx.get((s_id, a_id))
            if idx is None:
                continue
            old = self.magenta.value.value_of(idx)
            self.magenta.value.set_value(idx, old + self.lr * (g - old))
            vi = self._vidx.get(s_id)
            if vi is not None:
                v = self.cyan.value.value_of(vi)
                self.cyan.value.set_value(vi, v + self.lr * (g - v))
            g = self.gamma * g            # discount as we move back up the chain


class FlatBaseline:
    """No bands, no ensemble, no residual — one Slate mapping state->action with
    a value field, greedy by value. Feedback still lets it chain; what it lacks
    is the perception ensemble (generalisation) the depth bands provide."""
    def __init__(self, world, n_cells=2048, beta=35.0, gamma=0.9, lr=0.5, seed=7):
        self.w = world
        self.dim = world.svec[world.states[0]].shape[0]
        self.gamma, self.lr = gamma, lr
        self.pol = Slate(self.dim, n_cells, beta, seed=seed)
        self._qidx = {}

    def watch(self, demos):
        for s_id, a_id, nxt, r in demos:
            sv = self.w.svec[s_id]
            i = self.pol.commit(sv, payload=(s_id, a_id), value=r)
            self._qidx[(s_id, a_id)] = i

    def perceive(self, s_vec):
        r = self.pol.recall(s_vec)
        return (r["winner"]["payload"][0] if r else None), (r["margin"] if r else 0.0)

    def q(self, s_id, a_id):
        i = self._qidx.get((s_id, a_id))
        return self.pol.value_of(i) if i is not None else 0.0

    def policy(self, s_id, greedy=True):
        actions = [a for (s, a) in self._qidx if s == s_id]
        if not actions:
            return None
        qs = [self.q(s_id, a) for a in actions]
        return actions[int(np.argmax(qs))]

    def run_episode(self, start_vec, learn=True, greedy=True, max_steps=6):
        trace, s_vec, reward, done = [], start_vec, 0.0, False
        for _ in range(max_steps):
            s_id, _ = self.perceive(s_vec)
            if s_id is None:
                break
            a_id = self.policy(s_id, greedy)
            if a_id is None:
                break
            trace.append((s_id, a_id))
            nxt, s_vec, reward, done = self.w.step(s_id, a_id)
            if done:
                break
        if learn:
            g = reward
            for s_id, a_id in reversed(trace):
                i = self._qidx.get((s_id, a_id))
                if i is not None:
                    old = self.pol.value_of(i)
                    self.pol.set_value(i, old + self.lr * (g - old))
                g *= self.gamma
        return trace, reward, done
