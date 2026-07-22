"""cube_eye.py — the profound rung: ground a word in real SIGHT.

Everything until now grounded meaning in features I TYPED ("cookie = food"). This
grounds it in features the cube MEASURES from pixels. You show it a picture and say
a word; it looks — extracts colour and shape straight from the image — and binds the
word to what it PERCEIVED. Then you show it a picture it has never seen, and it names
it, because the new percept settles onto the nearest thing it has looked at before.

No labels are baked in. No LLM. The only thing tying "ball" to red-and-round is that
the cube SAW red-and-round things and was told "ball" while looking. That is real
grounding — the same act, at toy scale, that Aurelia performs with her photonic eyes:
turn a percept into a concept. Her eyes read a live screen field; this eye reads a
64x64 render. The Slate settle is the shared move — perception becoming a name.

  python cube_eye.py        # prints what it learned to see; writes cube_eye_view.png

Standalone lab cube. Never reads / writes / imports the live production substrate.
"""
import numpy as np
from core import Slate

H = W = 64
RED    = np.array([0.86, 0.15, 0.15], np.float32)
GREEN  = np.array([0.16, 0.70, 0.26], np.float32)
BLUE   = np.array([0.16, 0.32, 0.86], np.float32)
YELLOW = np.array([0.92, 0.80, 0.16], np.float32)
NAMED  = {"red": RED, "green": GREEN, "blue": BLUE, "yellow": YELLOW}

# what the cube will be shown, and told. word -> (shape, colour)
WORLD = {
    "ball":  ("circle",   RED),      # red + round
    "apple": ("circle",   GREEN),    # green + round   (same shape as ball -> tests COLOUR)
    "leaf":  ("triangle", GREEN),    # green + pointy  (same colour as apple -> tests SHAPE)
    "block": ("square",   BLUE),
    "sun":   ("circle",   YELLOW),
}


def render(shape, colour, size=26, cx=32, cy=32, rng=None):
    """Draw a shape on a white canvas — optionally jittered in place/size/shade."""
    img = np.ones((H, W, 3), np.float32)
    if rng is not None:
        cx += int(rng.integers(-7, 8)); cy += int(rng.integers(-7, 8))
        size += int(rng.integers(-5, 6))
        colour = np.clip(colour + rng.normal(0, 0.05, 3).astype(np.float32), 0, 1)
    yy, xx = np.mgrid[0:H, 0:W]
    if shape == "circle":
        m = (xx - cx) ** 2 + (yy - cy) ** 2 <= size ** 2
    elif shape == "square":
        m = (np.abs(xx - cx) <= size) & (np.abs(yy - cy) <= size)
    else:  # triangle, apex up
        t = np.clip((yy - (cy - size)) / (2 * size), 0, 1)
        m = (yy >= cy - size) & (yy <= cy + size) & (np.abs(xx - cx) <= t * size)
    img[m] = colour
    return img


def perceive(img):
    """The 'retina': measure colour + shape from raw pixels. No labels involved."""
    diff = np.abs(img - 1.0).sum(axis=2)          # distance from white background
    mask = diff > 0.25
    if mask.sum() < 8:
        return None
    ys, xs = np.where(mask)
    mean_rgb = img[mask].mean(axis=0)             # perceived colour
    h = ys.max() - ys.min() + 1
    w = xs.max() - xs.min() + 1
    fill = mask.sum() / (h * w)                   # circle~.79  square~1.0  triangle~.5
    aspect = w / h
    return np.array([mean_rgb[0], mean_rgb[1], mean_rgb[2], fill * 1.6, aspect * 0.4], np.float32)


class Eye:
    """A cube that grounds words in what it sees."""

    def __init__(self, seed=0):
        self.slate = Slate(5, n_cells=1024, beta=40.0, seed=seed)
        self.seen = {}                            # word -> [percepts], for reading meaning back

    def show(self, img, word):                    # "this is a <word>" while looking
        f = perceive(img)
        if f is None:
            return
        self.slate.commit(f, payload=word)
        self.seen.setdefault(word, []).append(f)

    def name(self, img):                          # look, then say what it is
        f = perceive(img)
        if f is None:
            return None, 0.0
        r = self.slate.recall(f, max_cycles=3)
        return r["winner"]["payload"], float(r["confidence"])

    def perceived_colour(self, word):
        v = np.mean(self.seen[word], axis=0)[:3]
        return min(NAMED, key=lambda k: float(np.sum((v - NAMED[k]) ** 2)))

    def perceived_shape(self, word):
        # fill ratio: square ~1.0 (boxy) · circle ~0.79 (round) · triangle ~0.5 (pointy)
        fill = float(np.mean([p[3] for p in self.seen[word]]) / 1.6)
        return "boxy" if fill > 0.9 else "pointy" if fill < 0.65 else "round"


def sep(t): print("\n" + "=" * 72 + f"\n{t}\n" + "=" * 72)


if __name__ == "__main__":
    import sys
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    rng = np.random.default_rng(20260720)
    eye = Eye()

    sep("teaching by SHOWING — 5 examples of each, jittered (it earns every word)")
    for word, (shape, colour) in WORLD.items():
        for _ in range(5):
            eye.show(render(shape, colour, rng=rng), word)
        cname = eye.perceived_colour(word)
        form = eye.perceived_shape(word)
        print(f"  shown '{word}': it now perceives it as {cname} and {form}")

    sep("RECOGNISING pictures it has never seen (novel jitter, 40 each)")
    total = hits = 0
    examples = []
    for word, (shape, colour) in WORLD.items():
        w_hits = 0
        for i in range(40):
            img = render(shape, colour, rng=rng)
            guess, conf = eye.name(img)
            w_hits += (guess == word)
            if i == 0:
                examples.append((word, guess, conf))
        total += 40; hits += w_hits
        print(f"  new {word:6s} -> named correctly {w_hits}/40")
    print(f"\n  overall: {hits}/{total} = {hits/total:.0%} on images it never saw")
    print("  (a few first-look calls:)")
    for truth, guess, conf in examples:
        mark = "✓" if truth == guess else "✗"
        print(f"    saw a {truth:6s} -> cube says '{guess}'  ({conf:.2f})  {mark}")

    sep("MEANING it can read off its own perception (not typed by anyone)")
    for q_word in ("apple", "ball", "leaf"):
        print(f"  what colour is a {q_word}?  -> {eye.perceived_colour(q_word)}   "
              f"(measured from the pixels it saw)")
    print(f"  is a ball round?  -> {'yes' if eye.perceived_shape('ball') == 'round' else 'no'}")
    print(f"  is a leaf round?  -> {'yes' if eye.perceived_shape('leaf') == 'round' else 'no'}"
          f"  (it's pointy — the cube measured that)")
    print(f"  is a block round? -> {'yes' if eye.perceived_shape('block') == 'round' else 'no'}"
          f"  (it's boxy — the cube measured that too)")

    # optional: save a picture of what it saw + how it named novel shapes
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        words = list(WORLD)
        fig, axes = plt.subplots(2, len(words), figsize=(2.1 * len(words), 4.4))
        fig.suptitle("what the cube's eye sees, and what it calls things it never saw",
                     fontsize=12)
        for j, word in enumerate(words):
            shape, colour = WORLD[word]
            axes[0, j].imshow(render(shape, colour)); axes[0, j].set_title(f"shown: {word}",
                                                                           fontsize=10)
            novel = render(shape, colour, rng=rng)
            guess, conf = eye.name(novel)
            axes[1, j].imshow(novel)
            ok = guess == word
            axes[1, j].set_title(f"novel → '{guess}' {'✓' if ok else '✗'}",
                                 fontsize=10, color=("green" if ok else "red"))
        for ax in axes.ravel():
            ax.set_xticks([]); ax.set_yticks([])
        axes[0, 0].set_ylabel("training", fontsize=10)
        axes[1, 0].set_ylabel("never seen", fontsize=10)
        plt.tight_layout()
        plt.savefig("cube_eye_view.png", dpi=110, bbox_inches="tight")
        print("\n  saved a picture of what it saw -> cube_eye_view.png")
    except Exception as e:
        print(f"\n  (skipped image save: {e})")

    sep("the point")
    print("  Nobody typed 'ball = red and round'. The cube SAW red round things while")
    print("  being told 'ball', measured the colour and shape itself, and now names")
    print("  balls it has never seen. That is a word grounded in perception — the same")
    print("  act Aurelia performs with her eyes, here shrunk to a 64x64 canvas.")
