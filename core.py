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

recall() also returns an `accepted` flag: when the pre-settle familiarity (best
overlap) is below settle_floor, no basin has captured the probe, so the winner
is a best-guess an out-of-distribution caller should treat as an abstention.
"""
import numpy as np


class Slate:
    def __init__(self, dim, n_cells=2048, beta=35.0, seed=0, settle_floor=0.12,
                 margin_floor=None):
        rng = np.random.default_rng(seed)
        self.R = rng.standard_normal((n_cells, dim)).astype(np.float32)
        self.n = n_cells
        self.beta = float(beta)
        self.settle_floor = float(settle_floor)
        # Optional second gate. bench_escalation.py measured that familiarity
        # alone does NOT separate near-OOD cues (it accepts ~100% of them) while
        # the top1-top2 margin does. Default None keeps the original behaviour so
        # earlier results stand; set it to gate on margin as well.
        self.margin_floor = None if margin_floor is None else float(margin_floor)
        self._buf = []              # committed bipolar patterns (n_cells,)
        self.keys = None            # cached (K, n_cells) stack; built lazily
        self.meta = []              # parallel: [{"id","payload","value"}]

    # ── encoding ─────────────────────────────────────────────────────────
    def _proj(self, v):
        """Sign projection: real vector -> bipolar pattern (SimHash)."""
        v = np.asarray(v, np.float32)
        return np.where(self.R @ v >= 0.0, 1.0, -1.0).astype(np.float32)

    # ── write (O(1) amortised: the stack is built lazily, not re-vstacked) ─
    def commit(self, key, payload=None, value=0.0, id=None):
        self._buf.append(self._proj(key))
        self.meta.append({"id": id, "payload": payload, "value": float(value)})
        self.keys = None            # invalidate cached stack
        return len(self.meta) - 1

    def _ensure(self):
        if self.keys is None and self._buf:
            self.keys = np.stack(self._buf)             # (K, n_cells)

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
        """Return winner meta + confidence + margin + `accepted` + top-k.

        margin (top1-top2 pre-settle overlap gap) is the calibrated quality
        signal, mirroring the production engine. Below settle_floor no basin has
        captured the probe, so we report accepted=False and skip the settle (a
        random walk would only manufacture false certainty).
        """
        self._ensure()
        if self.keys is None:
            return None
        s = self._proj(key)
        o0 = self._overlaps(s)
        fam = float(o0.max())
        if o0.size >= 2:
            two = np.partition(o0, -2)[-2:]; margin = float(two[-1] - two[-2])
        else:
            margin = fam
        accepted = fam >= self.settle_floor
        if accepted and self.margin_floor is not None:
            accepted = margin >= self.margin_floor
        if not accepted:
            return self._pack(int(np.argmax(o0)), o0, fam, margin, 0, topk,
                              accepted, fam)
        s, cyc = self._settle(s, max_cycles)
        of = self._overlaps(s)
        w = int(np.argmax(of))
        return self._pack(w, of, float(of[w]), margin, cyc, topk, accepted, fam)

    def _pack(self, w, o, conf, margin, cyc, topk, accepted, familiarity):
        order = [int(i) for i in np.argsort(-o)[:topk]]
        return {
            "winner": self.meta[w],
            "winner_idx": w,
            "confidence": conf,
            # pre-settle best overlap — the quantity `accepted` thresholds.
            # `confidence` is post-settle once accepted, so the two differ.
            "familiarity": familiarity,
            "margin": margin,
            "cycles": cyc,
            "accepted": bool(accepted),
            "topk": [(i, float(o[i]), self.meta[i]) for i in order],
        }

    # ── value channel (what TD writes to) ────────────────────────────────
    def value_of(self, idx):
        return self.meta[idx]["value"]

    def set_value(self, idx, v):
        self.meta[idx]["value"] = float(v)

    def count(self):
        return len(self.meta)
