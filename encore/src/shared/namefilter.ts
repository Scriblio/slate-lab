// Keeps rude names off the venue screen. Singers type any name, and it goes
// up on a TV in a bar. This is a baseline, not a guarantee: the KJ can add
// their own words in Settings, and can always remove or rename a singer.
//
// Words are matched whole, so names like "Cassie", "Hancock" and
// "Scunthorpe" are fine. Only a few unmistakable words also match inside a
// longer one ("fuckface"). Simple disguises are seen through: "f u c k",
// "sh!t", "f.u.c.k" and "FÜCK".

/** Unmistakable words that are blocked even inside a longer one. */
const STEMS = ['fuck', 'shit', 'bitch', 'whore', 'slut', 'nigger', 'nigga', 'faggot', 'asshole', 'bastard', 'cocksuck', 'dickhead', 'jizz', 'blowjob', 'handjob', 'wanker', 'twat'];

/** Words blocked only on their own (many are fine inside other words and names). */
const WORDS = new Set([
  'ass', 'arse', 'cunt', 'cunts', 'tit', 'tits', 'titty', 'titties', 'cum', 'cums', 'anal', 'porn', 'piss', 'pissed', 'pussy', 'pussies', 'penis', 'vagina', 'boner', 'dildo', 'rape', 'rapist',
  'fag', 'fags', 'tranny', 'retard', 'retarded', 'spic', 'chink', 'kike', 'gook', 'wetback', 'nazi', 'hitler',
]);

const LEET: Record<string, string> = { '0': 'o', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', $: 's', '!': 'i', '+': 't' };

function tokens(name: string, oneAs: 'i' | 'l'): string[] {
  const plain = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[01@$!+3-578]/g, (c) => (c === '1' ? oneAs : (LEET[c] ?? c)));
  // Leetspeak characters are letters here, so split on anything else.
  const parts = plain.split(/[^a-z]+/).filter(Boolean);
  // "f u c k" and "f.u.c.k": runs of single letters are one word.
  const out: string[] = [];
  let run = '';
  for (const p of parts) {
    if (p.length === 1) run += p;
    else {
      if (run) out.push(run), (run = '');
      out.push(p);
    }
  }
  if (run) out.push(run);
  return out;
}

/** Split the KJ's own list (commas or new lines) into lowercase words. */
export function parseWords(text: string | undefined): string[] {
  return (text ?? '')
    .split(/[\n,;]+/)
    .map((w) => w.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ''))
    .filter((w) => w.length >= 2)
    .slice(0, 100);
}

/** Would this name be blocked? `extra` are the KJ's own words. */
export function isBlockedName(name: string, extra: string[] = []): boolean {
  const custom = extra.map((w) => w.toLowerCase());
  for (const oneAs of ['i', 'l'] as const) {
    const toks = tokens(name, oneAs);
    const squished = toks.join('');
    for (const t of toks) {
      if (WORDS.has(t)) return true;
      if (STEMS.some((s) => t.includes(s))) return true;
    }
    for (const w of custom) {
      // Short words only on their own, so a name isn't blocked for containing them by accident.
      if (toks.includes(w) || (w.length >= 4 && squished.includes(w))) return true;
    }
  }
  return false;
}
