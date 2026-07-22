"""cube_talk.py — the comprehension rung, in a window you can talk to.

cube_toddler gave it syntax; cube_grounded gave it meaning. This gives it the turn
from talking-AT-you to talking-WITH-you: it understands what YOU say, checks it
against the small world it holds, and answers, agrees, corrects — or learns.

No LLM in the loop. Understanding here is grounded template comprehension over the
same world cube_grounded teaches: entities with features, verbs with selectional
frames. What it "gets" it gets by reference, not by having read a trillion words.

Four things you can do in the window:
  ASK      "can a dog eat a cookie?"   "what is food?"   "what can a bird do?"
  ASSERT   "the dog is eating a book"  -> it checks:  "No — a book isn't food."
  COMMAND  "say something"             -> it speaks a grounded sentence
  TEACH    "a frog is an animal"       -> it learns, then uses it immediately

  python cube_talk.py     # then open http://127.0.0.1:8900

Standalone lab cube. Never reads / writes / imports the live production substrate.
"""
import re, json, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import numpy as np

from cube_grounded import ENTITIES, VERBS, ADJS, _has

HOST, PORT = "127.0.0.1", 8900

# category word -> the feature bundle it grants when you teach "X is a <category>"
CAT_FEATURES = {
    "animal": {"animate", "animal"}, "person": {"animate", "person"},
    "food": {"thing", "food"}, "drink": {"thing", "food", "drink"},
    "toy": {"thing", "toy"}, "thing": {"thing"}, "book": {"thing", "readable"},
    "fruit": {"thing", "food", "round"},
}
BARE_FEATURES = {"soft", "red", "blue", "round", "big", "little", "happy",
                 "colorable", "animate", "food", "animal"}


def _verb_forms(verbs):
    forms = {}
    for v in verbs:
        cand = {v, v + "s", v + "ing", v + "es"}
        if len(v) >= 3 and v[-1] not in "aeiou" and v[-2] in "aeiou" and v[-3] not in "aeiou":
            cand.add(v + v[-1] + "ing")          # run->running, hug->hugging
        for f in cand:
            forms[f] = v
    return forms


class Mind:
    """A small grounded mind that understands, answers, speaks, and can be taught."""

    def __init__(self):
        self.world = {w: set(t) for w, t in ENTITIES.items()}   # mutable: teachable
        self.verbs = {v: dict(f) for v, f in VERBS.items()}
        self.vforms = _verb_forms(self.verbs)
        self.rng = np.random.default_rng(5)

    # ── meaning lookups ────────────────────────────────────────────────────────
    def tags(self, word):
        if word in ("i", "you", "we", "me"):     # speaker/listener are animate persons
            return {"animate", "person"}
        return self.world.get(word, set())

    def can_agent(self, agent, verb):
        f = self.verbs.get(verb)
        return bool(f) and _has(self.tags(agent), f["agent"])

    def licensed(self, agent, verb, obj=None):
        f = self.verbs.get(verb)
        if not f or not _has(self.tags(agent), f["agent"]):
            return False
        if f["obj"] is None:
            return obj is None
        return obj is not None and _has(self.tags(obj), f["obj"])

    # ── grounded generation (taught entities show up here too) ─────────────────
    def _np(self, noun):
        det = self.rng.choice(["the", "a", "my"])
        fits = [a for a, need in ADJS.items() if _has(self.tags(noun), need)]
        if fits and self.rng.random() < 0.5:
            return f"{det} {self.rng.choice(fits)} {noun}"
        return f"{det} {noun}"

    def say(self):
        animates = [w for w, t in self.world.items() if "animate" in t]
        for _ in range(40):
            verb = self.rng.choice(list(self.verbs))
            f = self.verbs[verb]
            agents = [a for a in animates if _has(self.tags(a), f["agent"])]
            if not agents:
                continue
            agent = self.rng.choice(agents)
            if f["obj"] is None:
                s = f"{self._np(agent)} {verb}"
            else:
                objs = [o for o in self.world if self.licensed(agent, verb, o) and o != agent]
                if not objs:
                    continue
                s = f"{self._np(agent)} {verb} {self._np(self.rng.choice(objs))}"
            return s[0].upper() + s[1:] + "."
        return "I want more words."

    # ── comprehension: parse an assertion into (agent, verb, object) ───────────
    def _svo(self, toks):
        vi = next((i for i, w in enumerate(toks) if w in self.vforms), None)
        if vi is None:
            return None
        verb = self.vforms[toks[vi]]
        agent = next((w for w in reversed(toks[:vi]) if w in self.world or w in ("i", "you", "we")), None)
        obj = next((w for w in toks[vi + 1:] if w in self.world), None)
        return agent, verb, obj

    def _verify(self, agent, verb, obj):
        if agent is None:
            return f"I'm not sure who you mean — I know about {self._known_animates()}."
        f = self.verbs[verb]
        if not _has(self.tags(agent), f["agent"]):
            return f"No — a {agent} isn't {f['agent']}, so it can't {verb}."
        if f["obj"] is None:
            return f"Yes — a {agent} can {verb}. That's true."
        if obj is None:
            return f"A {agent} can {verb} — but {verb} what?"
        if _has(self.tags(obj), f["obj"]):
            return f"Yes — a {agent} can {verb} a {obj}. That's true."
        return f"No — a {obj} isn't {f['obj']}, so a {agent} can't {verb} it."

    # ── comprehension: answer a question about the world ───────────────────────
    def _ask(self, toks):
        w = [x for x in toks if x not in ("a", "an", "the", "my", "your", "does", "do", "could")]
        w = [self.vforms.get(x, x) for x in w]           # normalise verb forms
        if w[:1] == ["can"] and len(w) == 3:
            return "Yes." if self.can_agent(w[1], w[2]) else "No."
        if w[:1] == ["can"] and len(w) == 4:
            if self.licensed(w[1], w[2], w[3]):
                return "Yes."
            f = self.verbs.get(w[2])
            if f and f["obj"] and not _has(self.tags(w[3]), f["obj"]):
                return f"No — a {w[3]} isn't {f['obj']}."
            return "No."
        if w[:1] == ["is"] and len(w) == 3:
            return "Yes." if w[2] in self.tags(w[1]) else "No."
        if w[:2] == ["what", "can"] and len(w) == 3:
            hits = [e for e in self.world if self.can_agent(e, w[2])]
            return (", ".join(hits) + ".") if hits else "Nothing I know of."
        if w[:2] == ["what", "is"] and len(w) == 3:
            hits = [e for e in self.world if w[2] in self.tags(e)]
            return (", ".join(hits) + ".") if hits else "Nothing I know of."
        return None

    # ── comprehension: learn a new fact ────────────────────────────────────────
    def _teach(self, text):
        m = re.match(r"(?:a |an |the )?([a-z]+) (?:is|are) (?:a |an )?([a-z]+)", text)
        if not m:
            return None
        subj, pred = m.group(1), m.group(2)
        if pred in CAT_FEATURES:
            feats = set(CAT_FEATURES[pred])
        elif pred in BARE_FEATURES:
            feats = {pred}
        else:
            return f"I don't know what “{pred}” means yet. Try: a {subj} is an animal / is food / is soft."
        self.world[subj] = self.world.get(subj, set()) | feats
        if "food" in feats:
            demo = f"So — is a {subj} food? {'Yes.' if 'food' in self.tags(subj) else 'No.'}"
        elif "animate" in feats:
            demo = f"So — can a {subj} run? {'Yes.' if self.can_agent(subj, 'run') else 'No.'}"
        else:
            demo = f"So now a {subj} is {', '.join(sorted(self.tags(subj)))}."
        label = ("an " if pred[0] in "aeiou" else "a ") + pred if pred in CAT_FEATURES else pred
        return f"Okay — I'll remember a {subj} is {label}. {demo}"

    def _describe(self, entity):
        feats = self.tags(entity)
        if not feats:
            return f"I don't know a {entity} yet. You could teach me: “a {entity} is a ...”"
        can = [v for v in self.verbs if self.can_agent(entity, v)]
        return f"A {entity} is {', '.join(sorted(feats))}. It can {', '.join(can)}."

    def _known_animates(self):
        return ", ".join(w for w, t in self.world.items() if "animate" in t)

    # ── the router ─────────────────────────────────────────────────────────────
    def respond(self, text):
        raw = text.strip()
        t = raw.lower().rstrip("?.!")
        toks = re.findall(r"[a-z]+", t)
        if not toks:
            return "Say something — a question, a statement, or teach me something."
        if toks[0] in ("hi", "hello", "hey", "yo"):
            return "Hi. Ask me about my little world, tell me something and I'll check it, or teach me a new word."
        if toks[0] in ("bye", "goodbye"):
            return "Bye. Come back and teach me more."
        if "say something" in t or "tell me something" in t or toks[0] in ("say", "talk", "speak"):
            return self.say() + "  (I built that from what I know.)"
        if ("what can you do" in t) or ("help" == toks[0]):
            return ("I know a small world. Ask: “can a dog eat a cookie?”, “what is food?”. "
                    "Tell me: “the dog is eating a book” and I'll check it. Teach me: “a frog is an animal.”")
        m = re.match(r"(?:tell me about|what can) (?:a |an |the )?([a-z]+)", t)
        if m and (m.group(1) in self.world):
            return self._describe(m.group(1))
        if toks[0] in ("can", "is", "are", "what", "who", "does", "do"):
            a = self._ask(toks)
            if a is not None:
                return a
        svo = self._svo(toks)                 # an assertion with a real verb?
        if svo and svo[1] in self.verbs:
            return self._verify(*svo)
        taught = self._teach(t)               # "X is a Y" -> learn
        if taught is not None:
            return taught
        return ("I don't follow that yet. I understand questions (“can a cat eat?”), "
                "statements (“a dog is eating milk”), and lessons (“a frog is an animal”).")


MIND = Mind()
LOCK = threading.Lock()

PAGE = """<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cube · a little grounded mind</title>
<style>
  :root{--bg:#0b0e14;--panel:#121722;--ink:#e6edf3;--dim:#8b98a9;--cube:#7ee3c7;--you:#8ab4ff;--line:#1f2733}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;height:100vh;display:flex;flex-direction:column}
  header{padding:14px 20px;border-bottom:1px solid var(--line);background:var(--panel)}
  header h1{margin:0;font-size:16px;font-weight:600}
  header .sub{color:var(--dim);font-size:12.5px;margin-top:3px}
  header .sub b{color:var(--cube);font-weight:600}
  #log{flex:1;overflow-y:auto;padding:22px;display:flex;flex-direction:column;gap:14px;max-width:900px;width:100%;margin:0 auto}
  .msg{display:flex;gap:10px;align-items:flex-start;animation:f .2s ease}
  @keyframes f{from{opacity:0;transform:translateY(4px)}to{opacity:1}}
  .who{flex:0 0 46px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;padding-top:3px;color:var(--dim)}
  .msg.you .who{color:var(--you)}.msg.cube .who{color:var(--cube)}
  .bubble{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:9px 13px;max-width:80%}
  .msg.cube .bubble{border-color:#1c3a33}
  .chips{display:flex;flex-wrap:wrap;gap:7px;padding:0 22px 6px;max-width:900px;width:100%;margin:0 auto}
  .chip{background:#111a26;border:1px solid #26405a;color:#9fc3ff;border-radius:20px;padding:5px 11px;font-size:12px;cursor:pointer}
  .chip:hover{background:#16263a}
  form{display:flex;gap:10px;padding:14px 20px;border-top:1px solid var(--line);background:var(--panel);max-width:900px;width:100%;margin:0 auto}
  input[type=text]{flex:1;background:#0b0e14;border:1px solid #243247;border-radius:8px;color:var(--ink);padding:11px 13px;font:inherit;outline:none}
  input[type=text]:focus{border-color:var(--you)}
  button{background:var(--cube);color:#06231b;border:0;border-radius:8px;padding:0 18px;font-weight:700;cursor:pointer}
</style></head>
<body>
<header>
  <h1>Cube · a little grounded mind</h1>
  <div class="sub">it knows a small world — it <b>means</b> what it says, <b>understands</b> what you say, and you can <b>teach</b> it. no LLM in the loop.</div>
</header>
<div id="log"></div>
<div class="chips" id="chips"></div>
<form id="f">
  <input type="text" id="q" placeholder="ask, tell it something, or teach it…" autocomplete="off" autofocus>
  <button id="send">send</button>
</form>
<script>
const log=document.getElementById('log'),q=document.getElementById('q');
const EX=["can a dog eat a cookie?","the dog is eating a book","what is food?","a frog is an animal","say something","what can a bird do?"];
function bubble(who,text){const m=document.createElement('div');m.className='msg '+who;
  m.innerHTML='<div class="who">'+who+'</div><div class="bubble"></div>';
  m.querySelector('.bubble').textContent=text;log.appendChild(m);log.scrollTop=log.scrollHeight;return m;}
async function ask(text){bubble('you',text);const p=bubble('cube','…');
  try{const r=await fetch('/gen',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})});
    const d=await r.json();p.querySelector('.bubble').textContent=d.reply;}
  catch(e){p.querySelector('.bubble').textContent='(error: '+e+')';}
  log.scrollTop=log.scrollHeight;}
document.getElementById('f').onsubmit=e=>{e.preventDefault();const v=q.value.trim();if(!v)return;q.value='';ask(v);};
const chips=document.getElementById('chips');
EX.forEach(x=>{const c=document.createElement('div');c.className='chip';c.textContent=x;c.onclick=()=>ask(x);chips.appendChild(c);});
bubble('cube',"Hi. I'm a small mind, and I know a little world — some animals, some things, some food. Ask me a question, tell me something and I'll check it against what I know, or teach me a new word.");
</script>
</body></html>"""


class H(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json"):
        b = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code); self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b))); self.end_headers()
        self.wfile.write(b)

    def log_message(self, *a):
        pass

    def do_GET(self):
        self._send(200, PAGE, "text/html; charset=utf-8") if self.path in ("/", "/index.html") else self._send(404, "{}")

    def do_POST(self):
        if self.path != "/gen":
            self._send(404, "{}"); return
        n = int(self.headers.get("Content-Length", 0))
        try:
            data = json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            data = {}
        with LOCK:
            reply = MIND.respond(str(data.get("text", ""))[:200])
        self._send(200, json.dumps({"reply": reply}))


if __name__ == "__main__":
    srv = ThreadingHTTPServer((HOST, PORT), H)
    print(f"[cube_talk] a little grounded mind, live at  http://{HOST}:{PORT}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()
