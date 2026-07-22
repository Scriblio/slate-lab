"""Unit tests for the Slate primitive. Run: pytest -q   (or: python test_core.py)

These pin the two properties the rest of the lab relies on: exact recall of a
stored key, and error-correcting recall of a noisy/never-exact cue (the property
a plain dict lacks). No API key, no network.
"""
import numpy as np
from core import Slate


def _bank(seed=0, dim=64, n=10, n_cells=1024):
    rng = np.random.default_rng(seed)
    keys = [rng.standard_normal(dim).astype(np.float32) for _ in range(n)]
    s = Slate(dim, n_cells=n_cells, beta=35.0, seed=1)
    for i, k in enumerate(keys):
        s.commit(k, payload=i)
    return s, keys


def test_exact_recall():
    s, keys = _bank()
    for i, k in enumerate(keys):
        assert s.recall(k)["winner"]["payload"] == i


def test_noisy_recall_is_error_correcting():
    s, keys = _bank()
    rng = np.random.default_rng(2)
    hits = sum(s.recall(k + 0.4 * rng.standard_normal(k.shape).astype(np.float32)
                        )["winner"]["payload"] == i
               for i, k in enumerate(keys))
    assert hits >= 8          # recovers the bound rule from a corrupted cue


def test_value_channel_roundtrip():
    s, _ = _bank()
    s.set_value(3, 0.75)
    assert abs(s.value_of(3) - 0.75) < 1e-6


def test_empty_store_returns_none():
    assert Slate(16, n_cells=128, seed=0).recall(np.zeros(16, np.float32)) is None


def test_familiarity_is_the_quantity_accepted_gates_on():
    """`confidence` is post-settle once accepted; `familiarity` is what the
    flag actually thresholded. bench_escalation.py depends on the difference."""
    s, keys = _bank()
    r = s.recall(keys[0])
    assert r["accepted"] == (r["familiarity"] >= s.settle_floor)


def test_margin_floor_is_opt_in_and_rejects_ambiguous_cues():
    """The escalation fix: an ambiguous cue (two stored patterns equidistant)
    passes the familiarity floor but must fail a margin floor."""
    dim = 64
    rng = np.random.default_rng(5)
    a, b = (rng.standard_normal(dim).astype(np.float32) for _ in range(2))
    for floor, want in ((None, True), (0.10, False)):
        s = Slate(dim, n_cells=2048, beta=35.0, seed=1, margin_floor=floor)
        s.commit(a, payload="a")
        s.commit(b, payload="b")
        r = s.recall((a + b) / 2.0)                 # equidistant from both
        assert r["familiarity"] >= s.settle_floor   # familiarity says "fine"
        assert r["margin"] < 0.10                   # margin says "ambiguous"
        assert r["accepted"] is want


if __name__ == "__main__":
    for _name, _fn in list(globals().items()):
        if _name.startswith("test_") and callable(_fn):
            _fn()
            print(f"ok  {_name}")
    print("all tests passed")
