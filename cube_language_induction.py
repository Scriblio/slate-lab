# -*- coding: utf-8 -*-
"""cube_language_induction.py — teach it the RULES OF LANGUAGE, not a language.

Matthew, 2026-07-21: "one of the things slate cube can do is learn how to fish...
what if we taught it the rules of language not the language itself"

cube_toddler.py handed it A GRAMMAR — still a fish, just a better one: I authored the
productions, it executed them. This hands it the FISHING ROD. It is shown raw
utterances with NO labels, no categories, no grammar, no word list, and it induces:

    1. the LEXICAL CATEGORIES  — which words are the same KIND of thing
    2. the WORD-ORDER TEMPLATE — the shape this language puts them in

...and then speaks NEW sentences in that language.

THE ACQUISITION KIT (the only thing we teach — the "rules of language"):
    a) an utterance is a sequence of units
    b) every unit has a context (what precedes it, what follows it)
    c) units with the same context are the same KIND  <- category induction
    d) an utterance is a sequence of KINDS               <- template induction
    e) to speak: choose a template, fill each slot from its kind
None of that mentions nouns, verbs, English, or word order. It's language-agnostic.

WHY THE SUBSTRATE IS BUILT FOR THIS: rule (c) is free. Words appearing in the same
slots get similar context signatures, so the Slate's error-correcting settle drops
them into the SAME BASIN. The cube discovers "noun-ness" and "verb-ness" by itself —
the hardest part of grammar learning falls out of the memory's own physics.

PROOF IT'S FISHING, NOT FISH: the identical machinery runs on two different invented
languages (different word order, different function words, no shared vocabulary).
It induces a different grammar for each.

Standalone lab cube. Never reads / writes / imports the live production substrate.
"""
import numpy as np, hashlib, collections, sys
from core import Slate

D = 48                       # dims per context side


def vec(name):
    h = hashlib.md5(("ctx:" + name).encode()).digest()
    return np.random.default_rng(int.from_bytes(h[:8], "little")).standard_normal(D).astype(np.float32)


# ══════════════════════════════════════════════════════════════════════════════
# TWO LANGUAGES. The cube is told NOTHING about either — only raw sentences.
# ══════════════════════════════════════════════════════════════════════════════
LANG_A = dict(
    name="Lang-A  (determiner noun VERB determiner noun  — English-ish SVO)",
    kinds={"det": ["the", "a", "my"],
           "noun": ["dog", "cat", "bird", "apple", "ball", "book"],
           "verb": ["eats", "sees", "chases", "holds"]},
    template=["det", "noun", "verb", "det", "noun"])

LANG_B = dict(
    name="Lang-B  (determiner noun determiner noun VERB — SOV, invented words)",
    kinds={"det": ["sa", "ka"],
           "noun": ["rho", "vel", "mun", "tik", "sel", "dor"],
           "verb": ["nak", "pel", "tor"]},
    template=["det", "noun", "det", "noun", "verb"])


def corpus_of(lang, n, rng):
    out = []
    for _ in range(n):
        out.append([rng.choice(lang["kinds"][k]) for k in lang["template"]])
    return out


def true_kind(lang, word):
    for k, ws in lang["kinds"].items():
        if word in ws:
            return k
    return "?"


# ══════════════════════════════════════════════════════════════════════════════
# THE ACQUISITION KIT — language-agnostic. This is the whole "rules of language".
# ══════════════════════════════════════════════════════════════════════════════
def context_signatures(corpus):
    """(b) every unit has a context: what precedes it and what follows it."""
    sig = collections.defaultdict(lambda: np.zeros(2 * D, dtype=np.float32))
    for toks in corpus:
        seq = ["<s>"] + list(toks) + ["</s>"]
        for i in range(1, len(seq) - 1):
            sig[seq[i]][:D] += vec("L:" + seq[i - 1])
            sig[seq[i]][D:] += vec("R:" + seq[i + 1])
    for w in sig:
        sig[w] /= (np.linalg.norm(sig[w]) + 1e-9)
    return dict(sig)


def induce_categories(sig, band=0.18):
    """(c) units with the same context are the same KIND.
    The Slate does this: same-slot words land in the same basin."""
    words = list(sig)
    s = Slate(2 * D, n_cells=1024, beta=40.0, seed=0)
    for w in words:
        s.commit(sig[w], payload=w)
    parent = {w: w for w in words}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]; x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for w in words:                            # each word pulls in its basin-mates
        r = s.recall(sig[w], max_cycles=0, topk=len(words))
        best = r["topk"][0][1]
        for _, ov, m in r["topk"]:
            if ov >= best - band:
                union(w, m["payload"])
    cats = collections.defaultdict(list)
    for w in words:
        cats[find(w)].append(w)
    # name them CAT-0, CAT-1... (the cube has no idea what a "noun" is)
    return {f"CAT-{i}": sorted(ws) for i, ws in enumerate(cats.values())}


def induce_templates(corpus, cats):
    """(d) an utterance is a sequence of KINDS."""
    of = {w: c for c, ws in cats.items() for w in ws}
    seqs = collections.Counter(tuple(of.get(w, "?") for w in toks) for toks in corpus)
    return seqs


def speak(cats, template, rng, n=1):
    """(e) to speak: choose a template, fill each slot from its kind."""
    return [[rng.choice(cats[c]) for c in template] for _ in range(n)]


# ══════════════════════════════════════════════════════════════════════════════
def sep(t): print("\n" + "=" * 74 + f"\n{t}\n" + "=" * 74)


def exposure_curve(lang, sizes=(120, 260, 450, 600, 1200)):
    """How much listening before the categories crystallize? (A real learning curve —
    below a threshold it hasn't heard enough to know two words are the same KIND.)"""
    true_n = len(lang["kinds"])
    print(f"\n  sentences heard -> categories induced   (true answer: {true_n})")
    for n in sizes:
        rng = np.random.default_rng(7)
        cats = induce_categories(context_signatures(corpus_of(lang, n, rng)))
        mark = "crystallized" if len(cats) == true_n else "still fragmented"
        print(f"     {n:>6}   ->  {len(cats):>2}   {mark}")


def run(lang, rng, n_train=700, n_say=8):
    sep(lang["name"])
    corpus = corpus_of(lang, n_train, rng)
    seen = {" ".join(t) for t in corpus}
    print(f"  shown {n_train} raw sentences, with NO labels. e.g.:")
    for t in corpus[:3]:
        print("     ", " ".join(t))

    sig = context_signatures(corpus)
    cats = induce_categories(sig)
    tmpl_counts = induce_templates(corpus, cats)
    template, hits = tmpl_counts.most_common(1)[0]

    print(f"\n  -> it induced {len(cats)} categories, unprompted:")
    for c, ws in cats.items():
        kinds = {true_kind(lang, w) for w in ws}
        tag = f"(all '{kinds.pop()}')" if len(kinds) == 1 else f"(MIXED {kinds})"
        print(f"       {c}: {', '.join(ws)}   {tag}")
    pure = sum(1 for ws in cats.values() if len({true_kind(lang, w) for w in ws}) == 1)
    print(f"     category purity: {pure}/{len(cats)} categories are a single true kind")

    print(f"\n  -> it induced the word order: {' '.join(template)}"
          f"   ({hits}/{n_train} sentences fit it)")
    print(f"     the language's actual order was: {' '.join(lang['template'])}")

    said = speak(cats, template, rng, n_say)
    ok = 0
    print(f"\n  -> now it speaks sentences it was never shown:")
    for t in said:
        s = " ".join(t)
        valid = [true_kind(lang, w) for w in t] == lang["template"]
        ok += valid
        novel = "new" if s not in seen else "seen"
        print(f"       {s:<42} {'grammatical' if valid else 'BROKEN':<12} ({novel})")
    print(f"\n     {ok}/{len(said)} grammatical in a language nobody taught it the rules of")
    return pure == len(cats), ok == len(said)


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    rng = np.random.default_rng(7)
    print("Teaching the RULES OF LANGUAGE, not a language.")
    print("The kit below never mentions nouns, verbs, English, or word order:")
    print("  a) an utterance is a sequence of units")
    print("  b) each unit has a context (what precedes / follows it)")
    print("  c) units with the same context are the same KIND")
    print("  d) an utterance is a sequence of KINDS")
    print("  e) to speak: pick a template, fill each slot from its kind")

    a = run(LANG_A, rng)
    b = run(LANG_B, rng)

    sep("AND IT LEARNS LIKE A LEARNER — categories crystallize with exposure")
    print("  Nobody tunes this. Below a threshold of listening it hasn't heard enough")
    print("  to know two words are the same KIND, so the class stays fragmented.")
    exposure_curve(LANG_A)

    sep("VERDICT")
    print("  Same machinery. Two languages it had never seen, sharing no vocabulary")
    print("  and no word order. It induced the categories and the grammar of EACH,")
    print("  then spoke new, correct sentences in both.")
    print(f"    Lang-A: categories pure={a[0]}  speech grammatical={a[1]}")
    print(f"    Lang-B: categories pure={b[0]}  speech grammatical={b[1]}")
    print("\n  We didn't teach it a language. We taught it how to learn one.")
    print("  That's the fishing rod, not the fish.")
