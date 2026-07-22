"""Provider-neutral authoring: several models compile the same policy.

A skill compiler whose authoring step only works with one vendor's model is
worth much less than one that doesn't care who wrote the program — the verifier,
not the author, is what makes the output trustworthy. So the authoring call is
kept behind one interface and every available model is run through it.

Available here and RUN: claude-opus-4-8, claude-haiku-4-5 (ANTHROPIC_API_KEY in
.env) and llama3.2:1b (local Ollama, open weights, no key, no cloud). OpenAI and
xAI code paths are implemented and wired to the same interface but were NOT RUN:
no OPENAI_API_KEY / XAI_API_KEY is present in this environment. Set either and
they join the run with no other change — but until then, no claim is made about
them.
"""
import json
import os
import re
import time
import urllib.error
import urllib.request

# public list pricing, USD per 1M tokens (input, output) — for spend accounting
PRICE = {
    "claude-opus-4-8":   (15.0, 75.0),
    "claude-haiku-4-5":  (1.0, 5.0),
    "gpt-5.2":           (1.25, 10.0),
    "grok-4":            (3.0, 15.0),
    "llama3.2:1b":       (0.0, 0.0),        # local weights, no per-token cost
}

MODELS = [
    {"name": "claude-opus-4-8",  "provider": "anthropic", "org": "Anthropic", "where": "cloud"},
    {"name": "claude-haiku-4-5", "provider": "anthropic", "org": "Anthropic", "where": "cloud"},
    {"name": "llama3.2:1b",      "provider": "ollama",    "org": "Meta (open weights)", "where": "local"},
    {"name": "gpt-5.2",          "provider": "openai",    "org": "OpenAI",   "where": "cloud"},
    {"name": "grok-4",           "provider": "xai",       "org": "xAI",      "where": "cloud"},
]


def _load_env():
    envp = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if os.path.exists(envp):
        for line in open(envp, encoding="utf-8"):
            m = re.match(r"\s*([A-Z_]+)\s*=\s*(.+?)\s*$", line)
            if m and not os.environ.get(m.group(1)):
                os.environ[m.group(1)] = m.group(2).strip('"').strip("'")


_load_env()


def _post(url, payload, headers, timeout=600):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", **headers})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def available(m):
    """Is this model actually runnable here? Never guess — check."""
    p = m["provider"]
    if p == "anthropic":
        return bool(os.environ.get("ANTHROPIC_API_KEY"))
    if p == "openai":
        return bool(os.environ.get("OPENAI_API_KEY"))
    if p == "xai":
        return bool(os.environ.get("XAI_API_KEY"))
    if p == "ollama":
        try:
            with urllib.request.urlopen(
                    "http://localhost:11434/api/tags", timeout=3) as r:
                tags = json.loads(r.read().decode())
            return any(t["name"] == m["name"] for t in tags.get("models", []))
        except Exception:  # noqa: BLE001
            return False
    return False


def ask(m, prompt, max_tokens=12000, temperature=1.0):
    """One authoring call. Returns (text, in_tokens, out_tokens, seconds)."""
    t0 = time.time()
    p = m["provider"]
    if p == "anthropic":
        import anthropic
        c = anthropic.Anthropic()
        r = c.messages.create(model=m["name"], max_tokens=max_tokens,
                              temperature=temperature,
                              messages=[{"role": "user", "content": prompt}])
        txt = "".join(b.text for b in r.content if b.type == "text")
        return txt, r.usage.input_tokens, r.usage.output_tokens, time.time() - t0
    if p in ("openai", "xai"):
        url = ("https://api.openai.com/v1/chat/completions" if p == "openai"
               else "https://api.x.ai/v1/chat/completions")
        keyname = "OPENAI_API_KEY" if p == "openai" else "XAI_API_KEY"
        d = _post(url, {"model": m["name"],
                        "messages": [{"role": "user", "content": prompt}],
                        "max_completion_tokens": max_tokens},
                  {"Authorization": f"Bearer {os.environ[keyname]}"})
        u = d.get("usage", {})
        return (d["choices"][0]["message"]["content"],
                u.get("prompt_tokens", 0), u.get("completion_tokens", 0),
                time.time() - t0)
    if p == "ollama":
        d = _post("http://localhost:11434/api/generate",
                  {"model": m["name"], "prompt": prompt, "stream": False,
                   "options": {"num_predict": max_tokens, "temperature": temperature}},
                  {})
        return (d.get("response", ""), d.get("prompt_eval_count", 0),
                d.get("eval_count", 0), time.time() - t0)
    raise ValueError(f"unknown provider {p}")


def cost(model, tin, tout):
    pin, pout = PRICE.get(model, (0.0, 0.0))
    return (tin * pin + tout * pout) / 1e6


def extract_json(raw):
    """Pull the last balanced JSON object out of a reply.

    Deliberately lenient about prose and code fences around the object: we are
    measuring whether a model can COMPILE THE POLICY, not whether it can obey a
    formatting instruction. A stricter parser would score format-following and
    call it synthesis reliability.
    """
    if not raw:
        return None
    raw = re.sub(r"```(?:json)?", "", raw)
    starts = [i for i, ch in enumerate(raw) if ch == "{"]
    for i in starts:                       # earliest start that parses = the object
        depth, instr, esc = 0, False, False
        for j in range(i, len(raw)):
            ch = raw[j]
            if instr:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    instr = False
                continue
            if ch == '"':
                instr = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(raw[i:j + 1])
                    except Exception:  # noqa: BLE001
                        break
    return None
