# -*- coding: utf-8 -*-
"""cube_learner_chat.py — a chat with a cube that LEARNS YOUR GRAMMAR while you talk.

Matthew, 2026-07-21: "can you make me another chat with this new understanding —
would it be able to talk to me?"

What's different from the earlier two windows:
  :8899  cube_lm      — memorised a corpus. Sounds fluent, understands nothing.
  :8900  cube_talk    — hand-given grammar + hand-given meaning. Understands a world.
  :8901  THIS         — starts with NO grammar at all. It induces categories and word
                        order from the sentences YOU type, then speaks in YOUR pattern.

Honest about what it is: this learns STRUCTURE, not MEANING. Distributional induction
tells it two words are the same KIND; it never tells it what they mean. So it can
speak your grammar back at you — it cannot hold a conversation. It will also tell you
plainly when it hasn't heard enough to crystallise, which is the real lesson: free
English at chat volume will NOT crystallise. Feed it simple, consistent sentences (or
use a seed) and watch the grammar snap into place.

  python cube_learner_chat.py     # then open http://127.0.0.1:8901

Standalone lab cube. Never reads / writes / imports the live production substrate.
"""
import re, json, threading, collections, sys
import numpy as np
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from cube_language_induction import (context_signatures, induce_categories,
                                     induce_templates, LANG_A, LANG_B, corpus_of)

HOST, PORT = "127.0.0.1", 8901
MIN_SENTENCES = 8


def tokenize(t):
    return re.findall(r"[a-z']+", t.lower())


class LearnerMind:
    """Hears sentences. Induces categories + word order. Speaks what it induced."""

    def __init__(self):
        self.corpus, self.cats, self.templates = [], {}, collections.Counter()
        self.rng = np.random.default_rng(20260721)
        self.dirty = False

    def listen(self, text):
        toks = tokenize(text)
        if len(toks) >= 2:
            self.corpus.append(toks)
            self.dirty = True
            return True
        return False

    def refresh(self):
        if not self.dirty or len(self.corpus) < MIN_SENTENCES:
            return
        self.cats = induce_categories(context_signatures(self.corpus))
        self.templates = induce_templates(self.corpus, self.cats)
        self.dirty = False

    def dominant(self):
        if not self.templates:
            return None, 0.0
        tpl, hits = self.templates.most_common(1)[0]
        return tpl, hits / sum(self.templates.values())

    def crystallised(self):
        tpl, cov = self.dominant()
        return bool(tpl) and len(self.corpus) >= 40 and cov >= 0.30 and len(self.cats) >= 2

    def speak(self):
        tpl, _ = self.dominant()
        if not tpl:
            return None
        return " ".join(str(self.rng.choice(self.cats[c])) for c in tpl if c in self.cats)

    def learned(self):
        tpl, cov = self.dominant()
        if not tpl:
            return "nothing stable yet"
        shown = []
        for c in tpl:
            ws = self.cats.get(c, [])
            shown.append("{" + "/".join(sorted(ws)[:3]) + ("…" if len(ws) > 3 else "") + "}")
        return " ".join(shown) + f"   ({cov*100:.0f}% of what I've heard)"

    def state(self):
        tpl, cov = self.dominant()
        return dict(heard=len(self.corpus), cats=len(self.cats),
                    templates=len(self.templates), dominant=round(cov * 100),
                    crystallised=self.crystallised())

    # ── the reply ─────────────────────────────────────────────────────────────
    def respond(self, text):
        t = text.strip().lower()
        if t.startswith("seed"):
            lang = LANG_B if ("b" in t or "sov" in t or "invent" in t) else LANG_A
            self.corpus += [list(s) for s in corpus_of(lang, 400, self.rng)]
            self.dirty = True
            self.refresh()
            return (f"Listened to 400 sentences of {lang['name'].split('(')[0].strip()}. "
                    f"{self._status()}\n\n{self._grammar_note()}")
        if "learn" in t and ("what" in t or "have" in t):
            return self._grammar_note()
        if t.startswith(("say", "talk", "speak")):
            s = self.speak()
            return (f"{s}\n\n(I built that from the pattern I induced — not a sentence "
                    f"I stored.)") if s else "I have no stable pattern yet. Say more to me."

        heard = self.listen(text)
        self.refresh()
        if not heard:
            return "That was too short to learn from. Give me a whole sentence."
        if not self.crystallised():
            return (f"Heard it. {self._status()}\n\nI can't speak yet — I don't have a "
                    f"stable pattern. Keep going with simple, consistent sentences, or "
                    f"type 'seed' and I'll listen to 400 at once.")
        s = self.speak()
        return f"{s}\n\n{self._status()}  ·  your pattern: {self.learned()}"

    def _status(self):
        st = self.state()
        return (f"[heard {st['heard']} · {st['cats']} categories · "
                f"{st['templates']} patterns · dominant {st['dominant']}% · "
                f"{'CRYSTALLISED' if st['crystallised'] else 'not yet crystallised'}]")

    def _grammar_note(self):
        if not self.cats:
            return "I haven't induced anything yet."
        lines = [f"I sorted your words into {len(self.cats)} kinds, unprompted:"]
        for c, ws in list(self.cats.items())[:6]:
            lines.append(f"   {c}: {', '.join(sorted(ws)[:8])}"
                         + ("…" if len(ws) > 8 else ""))
        lines.append(f"\nAnd your sentences seem to go:  {self.learned()}")
        return "\n".join(lines)


MIND = LearnerMind()
LOCK = threading.Lock()

PAGE = """<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cube · learning your language</title><style>
:root{--bg:#0b0e14;--panel:#121722;--ink:#e6edf3;--dim:#8b98a9;--cube:#c9a3ff;--you:#8ab4ff;--line:#1f2733}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);
font:16px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;height:100vh;display:flex;flex-direction:column}
header{padding:14px 20px;border-bottom:1px solid var(--line);background:var(--panel)}
header h1{margin:0;font-size:16px}header .sub{color:var(--dim);font-size:12.5px;margin-top:3px}
header .sub b{color:var(--cube)}
#log{flex:1;overflow-y:auto;padding:22px;display:flex;flex-direction:column;gap:14px;max-width:900px;width:100%;margin:0 auto}
.msg{display:flex;gap:10px;align-items:flex-start}.who{flex:0 0 46px;font-size:11px;text-transform:uppercase;
letter-spacing:.5px;padding-top:3px;color:var(--dim)}.msg.you .who{color:var(--you)}.msg.cube .who{color:var(--cube)}
.bubble{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:9px 13px;max-width:80%;white-space:pre-wrap}
.msg.cube .bubble{border-color:#2e2340}
.chips{display:flex;flex-wrap:wrap;gap:7px;padding:0 22px 6px;max-width:900px;width:100%;margin:0 auto}
.chip{background:#171226;border:1px solid #3a2d55;color:#c9a3ff;border-radius:20px;padding:5px 11px;font-size:12px;cursor:pointer}
form{display:flex;gap:10px;padding:14px 20px;border-top:1px solid var(--line);background:var(--panel);max-width:900px;width:100%;margin:0 auto}
input{flex:1;background:#0b0e14;border:1px solid #243247;border-radius:8px;color:var(--ink);padding:11px 13px;font:inherit;outline:none}
button{background:var(--cube);color:#1d1030;border:0;border-radius:8px;padding:0 18px;font-weight:700;cursor:pointer}
</style></head><body>
<header><h1>Cube · learning your language</h1>
<div class="sub">starts with <b>no grammar at all</b> — it induces the categories and word order from what you type, then speaks in <b>your</b> pattern. it learns structure, not meaning.</div></header>
<div id="log"></div>
<div class="chips" id="chips"></div>
<form id="f"><input id="q" placeholder="type simple, consistent sentences…" autocomplete="off" autofocus>
<button>send</button></form>
<script>
const log=document.getElementById('log'),q=document.getElementById('q');
const EX=["seed","seed b (invented SOV)","what have you learned","say something",
          "the dog eats the apple","the cat sees the ball"];
function bubble(w,t){const m=document.createElement('div');m.className='msg '+w;
 m.innerHTML='<div class="who">'+w+'</div><div class="bubble"></div>';
 m.querySelector('.bubble').textContent=t;log.appendChild(m);log.scrollTop=log.scrollHeight;return m;}
async function ask(t){bubble('you',t);const p=bubble('cube','…');
 try{const r=await fetch('/gen',{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({text:t})});p.querySelector('.bubble').textContent=(await r.json()).reply;}
 catch(e){p.querySelector('.bubble').textContent='(error '+e+')';}log.scrollTop=log.scrollHeight;}
document.getElementById('f').onsubmit=e=>{e.preventDefault();const v=q.value.trim();
 if(!v)return;q.value='';ask(v);};
const c=document.getElementById('chips');
EX.forEach(x=>{const d=document.createElement('div');d.className='chip';d.textContent=x;
 d.onclick=()=>ask(x);c.appendChild(d);});
bubble('cube',"I don't have a grammar. I've never heard a sentence.\\n\\nTalk to me in simple, consistent sentences and I'll try to work out the kinds of words you use and the order you put them in. When I've heard enough, I'll start speaking your pattern back.\\n\\nImpatient? Type 'seed' and I'll listen to 400 sentences at once.");
</script></body></html>"""


class H(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json"):
        b = body.encode("utf-8")
        self.send_response(code); self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b))); self.end_headers()
        self.wfile.write(b)

    def log_message(self, *a):
        pass

    def do_GET(self):
        self._send(200, PAGE, "text/html; charset=utf-8") if self.path in ("/", "/index.html") \
            else self._send(404, "{}")

    def do_POST(self):
        if self.path != "/gen":
            self._send(404, "{}"); return
        n = int(self.headers.get("Content-Length", 0))
        try:
            data = json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            data = {}
        with LOCK:
            reply = MIND.respond(str(data.get("text", ""))[:300])
        self._send(200, json.dumps({"reply": reply}))


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    srv = ThreadingHTTPServer((HOST, PORT), H)
    print(f"[cube_learner_chat] learning-your-language cube at http://{HOST}:{PORT}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()
