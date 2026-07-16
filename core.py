"""Minimal associative attractor memory — the Slate primitive, transparent.

This is a self-contained re-implementation of the shipped slate_engine recall
math (sign-projection onto bipolar cells + softmax-attention settle). It is
deliberately NOT imported from the production engine: this whole lab is a
standalone cube that must never read, write, or touch the live production substrate.

A Slate is a key -> payload store. commit() writes one-shot. recall() settles a
(possibly noisy / never-seen) key into the nearest stored basin — that settle is
the error-correction that lets a novel input snap to a known symbol — then reads
the payload bound to the winner. The `value` field on each entry is the
in-substrate value channel: it rides inside the pattern's metadata and is what
TD credit-assignment writes to.
"""
import numpy as np


class Slate:
    def __init__(self, dim, n_cells=2048, beta=35.0, seed=0, settle_floor=0.12):
        rng = np.random.default_rng(seed)
        self.R = rng.standard_normal((n_cells, dim)).astype(np.float32)
        self.n = n_cells
        self.beta = float(beta)
        self.settle_floor = float(settle_floor)
        self.keys = None            # (K, n_cells) bipolar +1/-1
        self.meta = []              # parallel: [{"id","payload","value"}]

    # ── encoding ─────────────────────────────────────────────────────────
    def _proj(self, v):
        """Sign projection: real vector -> bipolar pattern (SimHash)."""
        v = np.asarray(v, np.float32)
        return np.where(self.R @ v >= 0.0, 1.0, -1.0).astype(np.float32)

    # ── write ────────────────────────────────────────────────────────────
    def commit(self, key, payload=None, value=0.0, id=None):
        p = self._proj(key)[None, :]
        self.keys = p.copy() if self.keys is None else np.vstack([self.keys, p])
        self.meta.append({"id": id, "payload": payload, "value": float(value)})
        return len(self.meta) - 1

    # ── read ─────────────────────────────────────────────────────────────
    def _overlaps(self, s):
        return (self.keys @ s) / self.n

    def _settle(self, s, max_cycles):
        cyc = 0
        for _ in range(max_cycles):
            o = self._overlaps(s)
            a = np.exp(self.beta * (o - o.max())); a /= a.sum()
            s_new = np.where(a @ self.keys >= 0.0, 1.0, -1.0).astype(np.float32)
            cyc += 1
            if np.array_equal(s_new, s):
                break
            s = s_new
        return s, cyc

    def recall(self, key, max_cycles=4, topk=4):
        """Return winner meta + confidence + margin + top-k candidates.

        margin (top1-top2 pre-settle overlap gap) is the calibrated quality
        signal, mirroring the production engine. Below settle_floor no basin
        has captured the probe, so we report honestly-low confidence and skip
        the settle (a random walk would only manufacture false certainty).
        """
        if self.keys is None:
            return None
        s = self._proj(key)
        o0 = self._overlaps(s)
        fam = float(o0.max())
        if o0.size >= 2:
            two = np.partition(o0, -2)[-2:]; margin = float(two[-1] - two[-2])
        else:
            margin = fam
        if fam < self.settle_floor:
            return self._pack(int(np.argmax(o0)), o0, fam, margin, 0, topk)
        s, cyc = self._settle(s, max_cycles)
        of = self._overlaps(s)
        w = int(np.argmax(of))
        return self._pack(w, of, float(of[w]), margin, cyc, topk)

    def _pack(self, w, o, conf, margin, cyc, topk):
        order = [int(i) for i in np.argsort(-o)[:topk]]
        return {
            "winner": self.meta[w],
            "winner_idx": w,
            "confidence": conf,
            "margin": margin,
            "cycles": cyc,
            "topk": [(i, float(o[i]), self.meta[i]) for i in order],
        }

    # ── value channel (what TD writes to) ────────────────────────────────
    def value_of(self, idx):
        return self.meta[idx]["value"]

    def set_value(self, idx, v):
        self.meta[idx]["value"] = float(v)

    def count(self):
        return len(self.meta)
