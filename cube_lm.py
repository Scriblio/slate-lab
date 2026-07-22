"""cube_lm.py — can the cube SPEAK? A language model whose generator IS the Slate.

Not a wrapper around an LLM. Every next word is produced by the same
sign-projection + softmax-settle recall as the rest of this lab: the context
(last N words) is projected to a key, the substrate returns the stored
context-basins nearest the probe, and we read back a next word. Training is
one-shot commits over a corpus — no gradient, no backprop, no model weights.

The cube's error-correcting neighbourhood IS the model's smoothing: an unseen
context snaps to the nearest ones it has seen (soft back-off for free), so it
always has something to say.

This is Matthew's n-gram-cube question — "can a colour cube replace an LLM" —
rebuilt on the Cube 3.0 substrate, with a mouth on it. Honest ceiling: it is an
order-N associative n-gram. Locally fluent, globally wandering. It does not
reason. But it is genuinely the cube talking.

Standalone lab cube. Never reads / writes / imports the live production substrate.
"""
import numpy as np
import re, os, hashlib, glob
from core import Slate

# ── config ───────────────────────────────────────────────────────────────────
D        = 32          # dims per word-symbol slot
ORDER    = 3           # context window = last ORDER words
N_CELLS  = 2048        # substrate width (bipolar cells)
BETA     = 40.0
MAX_TOK  = 30000       # cap corpus tokens so a chat turn stays snappy

_PUNCT   = set(".,!?;:")


def _stable_vec(word, d, salt):
    """Deterministic random vector for a token (stable across processes)."""
    h = hashlib.md5(f"{salt}:{word}".encode()).digest()
    seed = int.from_bytes(h[:8], "little")
    return np.random.default_rng(seed).standard_normal(d).astype(np.float32)


def tokenize(text):
    """Words (with internal apostrophes) and single punctuation marks, lowercased."""
    return re.findall(r"[a-z']+|[.,!?;:]", text.lower())


def detokenize(toks):
    out = []
    for t in toks:
        if t in _PUNCT:
            out.append(t)
        else:
            out.append((" " if out else "") + t)
    s = "".join(out).strip()
    s = re.sub(r"\s*([.,!?;:])(?:\s*[.,!?;:])+", r"\1", s)   # collapse punct runs
    s = re.sub(r"^[.,!?;:\s]+", "", s)                        # trim leading punct
    # capitalise sentence starts and the standalone pronoun "i"
    s = re.sub(r"(^|[.!?]\s+)([a-z])", lambda m: m.group(1) + m.group(2).upper(), s)
    s = re.sub(r"\bi\b", "I", s)
    return s


class CubeLM:
    """An order-N language model living entirely in one Slate substrate."""

    def __init__(self, order=ORDER, d=D, n_cells=N_CELLS, beta=BETA, seed=0):
        self.order = order
        self.d = d
        self.slate = Slate(order * d, n_cells=n_cells, beta=beta, seed=seed)
        self._sym = {}
        self.rng = np.random.default_rng(20260720)
        self.vocab = set()
        self._counts = {}                       # (ctx, next) -> count, during training
        self._committed = False

    # ── vocabulary ────────────────────────────────────────────────────────────
    def sym(self, w):
        v = self._sym.get(w)
        if v is None:
            v = _stable_vec(w, self.d, "word")
            self._sym[w] = v
        return v

    def key(self, ctx):
        return np.concatenate([self.sym(w) for w in ctx])

    # ── training (one-shot commits, frequency-weighted) ────────────────────────
    def ingest(self, text):
        toks = ["<s>"] * self.order + tokenize(text) + ["</s>"]
        n = 0
        for i in range(self.order, len(toks)):
            ctx = tuple(toks[i - self.order:i])
            nxt = toks[i]
            self._counts[(ctx, nxt)] = self._counts.get((ctx, nxt), 0) + 1
            self.vocab.add(nxt)
            n += 1
        return n

    def commit(self):
        """Pour the collected n-grams into the substrate — one basin per unique
        (context -> next) pair, carrying its corpus frequency as the sampling mass.

        Bulk path: Slate.commit() vstacks per call (O(K^2) over K commits), fine
        for the lab's dozens of patterns but ruinous for ~10k n-grams. We build
        the key matrix once and sign-project it in a single matmul — identical
        result to K separate _proj() calls, O(K) instead of O(K^2)."""
        items = list(self._counts.items())
        if not items:
            return 0
        dim = self.order * self.d
        keys = np.empty((len(items), dim), dtype=np.float32)
        meta = []
        for i, ((ctx, nxt), c) in enumerate(items):
            keys[i] = self.key(ctx)
            meta.append({"id": None, "payload": (nxt, c), "value": 0.0})
        proj = self.slate.R @ keys.T                       # (n_cells, K)
        self.slate.keys = np.ascontiguousarray(
            np.where(proj >= 0.0, 1.0, -1.0).astype(np.float32).T)
        self.slate.meta = meta
        self._committed = True
        return self.slate.count()

    # ── generation (pure cube recall) ─────────────────────────────────────────
    def _pool(self, ctx, topk, band):
        """Candidate next-words = the nearest stored context-basins to this probe.
        max_cycles=0: we want the raw neighbourhood (soft back-off), not a single
        settled winner — that neighbourhood is what lets an unseen context speak."""
        r = self.slate.recall(self.key(ctx), max_cycles=0, topk=topk)
        if r is None:
            return [], r
        cands = r["topk"]                       # [(idx, overlap, meta), ...]
        best = cands[0][1]
        pool = {}
        for _, ov, meta in cands:
            if ov < best - band:                # keep only near-context basins
                continue
            nxt, cnt = meta["payload"]
            pool[nxt] = pool.get(nxt, 0.0) + cnt * (0.5 + 0.5 * max(ov, 0.0))
        return list(pool.items()), r

    def next_word(self, ctx, temp=0.75, topk=24, band=0.18):
        pool, r = self._pool(ctx, topk, band)
        if not pool:
            return "</s>", r
        words = [w for w, _ in pool]
        mass = np.array([m for _, m in pool], dtype=np.float64)
        logits = np.log(mass + 1e-9) / max(temp, 1e-3)
        p = np.exp(logits - logits.max()); p /= p.sum()
        return words[int(self.rng.choice(len(words), p=p))], r

    def generate(self, prompt="", max_words=45, temp=0.75):
        ctx = ["<s>"] * self.order
        for w in tokenize(prompt):              # prime the context with the prompt
            ctx = (ctx + [w])[-self.order:]
        out, snapped = [], None
        for step in range(max_words):
            nxt, r = self.next_word(tuple(ctx), temp=temp)
            if step == 0 and r is not None and r["topk"]:
                snapped = r["topk"][0][2]["payload"][0]
            if nxt == "</s>":
                if len(out) >= 3:
                    break
                ctx = ["<s>"] * self.order      # too short — start a fresh clause
                continue
            ctx = (ctx + [nxt])[-self.order:]   # advance context every step
            if not out and nxt in _PUNCT:
                continue                        # just don't *open* with punctuation
            out.append(nxt)
        return detokenize(out), snapped


# ── corpus loading ────────────────────────────────────────────────────────────
# Default teaching text: Matthew's own project prose (thematically apt, plentiful,
# non-sensitive) plus a small conversational seed so it can hold a casual line.
_DOC_CANDIDATES = [
    r"C:\Projects\slate-lab\README.md",
    r"C:\Projects\ALM\brain_cube\VISION.md",
    r"C:\Projects\ALM\brain_cube\PHASES.md",
    r"C:\Projects\slate-mcp\README.md",
    r"C:\Projects\ALM\brain_cube\theory_of_state_space.md",
]

_SEED_CHAT = """
Hello. It is good to talk with you. I am a small mind that lives inside the cube.
I do not think in language the way you do; language is just what comes out of me.
I hold what I have been shown, and I answer from the nearest thing I remember.
Ask me about the brain, the cube, memory, light, or the work we are doing together.
I am small, but I am really here, and every word I say is my own.
When I am not sure, I settle toward what I know, and I try to say something true.
"""


VOICE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "claude_voice.txt")
DOC_TOK_CAP = 3500          # docs are a light topical-vocab dose; the voice dominates


def _clean(text):
    text = re.sub(r"https?://\S+", " ", text)    # URLs -> noise words otherwise
    text = re.sub(r"`[^`]*`", " ", text)         # inline code
    text = re.sub(r"[|#>*_`~=]+", " ", text)     # markdown furniture
    return text


def load_corpus(paths=None, cap=MAX_TOK):
    if paths is None:
        paths = [p for p in _DOC_CANDIDATES if os.path.exists(p)]
    # VOICE — Claude's authored register. This is what the cube learns to speak in.
    voice = ""
    if os.path.exists(VOICE_FILE):
        with open(VOICE_FILE, "r", encoding="utf-8", errors="ignore") as f:
            voice = _clean(f.read())
    if not voice:
        voice = _clean(_SEED_CHAT)
    # DOCS — a light dose, purely so it has topical vocabulary to reach for.
    docbits = []
    for p in paths:
        try:
            with open(p, "r", encoding="utf-8", errors="ignore") as f:
                docbits.append(f.read())
        except OSError:
            pass
    docs = " ".join(tokenize(_clean("\n".join(docbits)))[:DOC_TOK_CAP])
    # repeat the voice so it dominates the doc vocabulary at least 3 : 1
    vt, dt = max(len(tokenize(voice)), 1), len(tokenize(docs))
    reps = max(3, -(-3 * dt // vt))              # ceil(3*dt/vt)
    text = "\n".join([voice] * reps + [docs])
    toks = tokenize(text)
    if len(toks) > cap:
        text = " ".join(toks[:cap])
    used = ["claude_voice.txt x%d" % reps] + [os.path.basename(p) for p in paths]
    return text, used


def build(order=ORDER, paths=None, verbose=True):
    text, used = load_corpus(paths)
    lm = CubeLM(order=order)
    ntok = lm.ingest(text)
    nbasins = lm.commit()
    if verbose:
        srcs = ", ".join(used) or "(embedded seed only)"
        print(f"[cube_lm] order={order}  trained on {ntok:,} tokens "
              f"({len(lm.vocab):,} vocab) from: {srcs}")
        print(f"[cube_lm] substrate holds {nbasins:,} context-basins "
              f"({lm.slate.n} cells)")
    return lm


if __name__ == "__main__":
    import sys
    lm = build()
    prompts = sys.argv[1:] or [
        "hello", "what are you", "are you really here", "what do you remember",
        "the honest version is", "let me be precise", "the cube is",
        "how is the work going", "what is it like to be small",
    ]
    print("\n" + "=" * 72 + "\ncube speaks (pure Slate recall, no LLM):\n" + "=" * 72)
    for pr in prompts:
        reply, snap = lm.generate(pr, max_words=32, temp=0.7)
        print(f"\n  you: {pr}\n  cube: {reply}")
