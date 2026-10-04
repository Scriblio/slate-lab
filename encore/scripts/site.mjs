// The public pages on the join site: Encore's page (/encore), and the Privacy
// Policy and Terms of Use (/privacy, /terms), rendered from PRIVACY.md and
// TERMS.md so there's one copy of each. Plain static HTML: no scripts, so the
// site's strict CSP applies unchanged.

/** The small slice of Markdown those files use: headings, paragraphs, nested lists, bold, italics and links. */
export function renderMarkdown(md) {
  const out = [];
  const lists = []; // indent of each open <ul>
  let para = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };
  const closeLists = (indent = -1) => {
    while (lists.length && lists[lists.length - 1] > indent) {
      out.push('</li></ul>');
      lists.pop();
    }
  };
  for (const raw of md.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    const item = /^(\s*)- (.*)$/.exec(line);
    const heading = /^(#{1,3}) (.*)$/.exec(line);
    if (!line.trim()) {
      flushPara();
      continue;
    }
    if (heading) {
      flushPara();
      closeLists();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
    } else if (item) {
      flushPara();
      const indent = item[1].length;
      const top = lists[lists.length - 1];
      if (top === undefined || indent > top) {
        out.push('<ul><li>');
        lists.push(indent);
      } else {
        closeLists(indent);
        out.push('</li><li>');
      }
      out.push(inline(item[2]));
    } else if (lists.length && /^\s+/.test(line)) {
      // A paragraph continuing inside a list item.
      out.push(`<p>${inline(line.trim())}</p>`);
    } else {
      closeLists();
      para.push(line.trim());
    }
  }
  flushPara();
  closeLists();
  return out.join('\n');
}

function inline(text) {
  return escape(text)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => `<a href="${href}">${label}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/(^|[\s(])(https:\/\/[\w./-]+[\w/])/g, '$1<a href="$2">$2</a>');
}

export function escape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const STYLE = `
:root { color-scheme: light dark; --bg: #ffffff; --fg: #1b1b24; --muted: #5b5b6b; --line: #e4e4ec; --accent: #7c3aed; --card: #f6f5fb; }
@media (prefers-color-scheme: dark) { :root { --bg: #07070c; --fg: #ececf3; --muted: #a3a3b5; --line: #262633; --accent: #b794ff; --card: #12121b; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 17px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
header, main, footer { max-width: 760px; margin: 0 auto; padding: 0 16px; }
header { display: flex; align-items: center; gap: 12px; padding-top: 28px; }
header img { width: 40px; height: 40px; border-radius: 10px; }
header a { color: var(--fg); text-decoration: none; font-weight: 700; font-size: 20px; }
main { padding-bottom: 32px; }
h1 { font-size: 34px; line-height: 1.2; margin: 28px 0 8px; }
h2 { font-size: 22px; margin: 32px 0 8px; }
a { color: var(--accent); }
ul { padding-left: 22px; }
li { margin: 6px 0; }
li > p { margin: 6px 0; }
.lede { font-size: 20px; color: var(--muted); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 16px 20px; margin: 20px 0; }
.shot { width: 100%; height: auto; border-radius: 12px; border: 1px solid var(--line); margin: 16px 0; }
footer { border-top: 1px solid var(--line); padding-top: 16px; padding-bottom: 40px; color: var(--muted); font-size: 15px; }
footer a { color: var(--muted); }
`;

/** A whole page: header, content and the footer with the policy links. */
export function page({ title, description, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${escape(description)}">
<link rel="icon" href="/favicon.ico" sizes="any">
<title>${escape(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header><img src="/icon-256.png" alt=""><a href="/encore">Encore Karaoke</a></header>
<main>
${body}
</main>
<footer>
<a href="/encore">Encore Karaoke</a> · <a href="/privacy">Privacy Policy</a> · <a href="/terms">Terms of Use</a> · <a href="https://www.youtube.com/t/terms">YouTube Terms of Service</a> · <a href="https://policies.google.com/privacy">Google Privacy Policy</a><br>
Scriblio, a brand of ALM Partners LLC · <a href="mailto:mattclancaster@gmail.com">mattclancaster@gmail.com</a>
</footer>
</body>
</html>
`;
}

/** Encore's own page: what it is, how it uses YouTube, and where the policies are. */
export function encorePage() {
  return page({
    title: 'Encore Karaoke: KJ software for Windows',
    description: 'Encore Karaoke runs a karaoke night from one laptop: a fair singer rotation, phone sign-ups, your own song library and YouTube karaoke videos.',
    body: `
<h1>Run the whole karaoke night from one laptop.</h1>
<p class="lede">Encore Karaoke is software for karaoke hosts (KJs). Singers sign up from their phones, the rotation stays fair, and songs play from your own library or from YouTube.</p>
<img class="shot" src="/encore-console.png" alt="Encore's KJ console: the singer rotation, the song search with YouTube results, and the stage card." width="1600" height="1000">
<h2>What it does</h2>
<ul>
<li><strong>Phone sign-ups.</strong> Singers scan a QR code, type their name and pick a song. No app or account needed.</li>
<li><strong>A fair rotation.</strong> Everyone gets a turn before anyone sings twice, with holds, pins and a clear "you're up next" alert.</li>
<li><strong>Your library.</strong> MP3+G (CD+G) and video karaoke files from your own folders, with key change.</li>
<li><strong>YouTube karaoke videos</strong>, searched right from Encore and played on the venue screen.</li>
</ul>
<h2>How Encore uses YouTube</h2>
<div class="card">
<p>Encore uses <strong>YouTube API Services</strong> to search YouTube for karaoke videos, and plays them in <strong>YouTube's own embedded player</strong>:</p>
<ul>
<li>Search results are shown as YouTube provides them, with a link to the YouTube Terms of Service.</li>
<li>Videos play unaltered in YouTube's player, ads included. Nothing is drawn over the player, and nothing is downloaded or recorded.</li>
<li>KJs never need a YouTube account or API key, and Encore never asks anyone to sign in with Google.</li>
<li>YouTube data is kept for no more than 30 days.</li>
</ul>
<p>By using Encore's YouTube features you agree to the <a href="https://www.youtube.com/t/terms">YouTube Terms of Service</a>. See also the <a href="https://policies.google.com/privacy">Google Privacy Policy</a>, and Encore's <a href="/privacy">Privacy Policy</a> and <a href="/terms">Terms of Use</a>.</p>
</div>
<h2>Get Encore</h2>
<p>Encore is coming to the Microsoft Store for Windows 10 and 11. Until then, a preview is available: <a href="https://github.com/Scriblio/slate-lab/releases/download/encore-v0.1.0-preview/Encore-Karaoke-Setup-0.1.0.exe">download the Windows installer</a> (<a href="https://github.com/Scriblio/slate-lab/releases/tag/encore-v0.1.0-preview">release notes</a>). It isn't code-signed yet, so Windows may show a SmartScreen warning: choose <strong>More info → Run anyway</strong>. Demo songs are included.</p>
<p>Questions: <a href="mailto:mattclancaster@gmail.com">mattclancaster@gmail.com</a>.</p>
`,
  });
}
