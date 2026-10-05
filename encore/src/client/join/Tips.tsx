// Tipping the KJ from the phone: quick-amount buttons that open Venmo, Cash
// App or PayPal with the amount filled in, and a thank-you after the singer's
// own song. Encore only opens the KJ's link; the payment happens in that app.

import { formatTipAmount } from '../../shared/tips.ts';
import type { SingerView } from '../../shared/types.ts';
import * as I from '../common/icons.tsx';
import { safeGet, safeSet } from '../common/socket.ts';

type Tip = NonNullable<SingerView['tip']>;

const PROMPT_SEEN_KEY = 'encore.tipPromptSeen';

/** The amount buttons, then "Other amount"; or one button when the link can't take an amount. */
export function TipButtons({ tip, onTap }: { tip: Tip; onTap?: () => void }) {
  const open = { target: '_blank', rel: 'noopener noreferrer', onClick: onTap } as const;
  if (!tip.amounts.length) {
    return (
      <a className="btn block tip-button" href={tip.link} {...open}>
        <I.Heart /> {tip.text}
      </a>
    );
  }
  return (
    <div className="tip-amounts" style={{ gridTemplateColumns: `repeat(${tip.amounts.length}, 1fr)` }}>
      {tip.amounts.map((a) => (
        <a key={a.amount} className="btn tip-amount" href={a.link} {...open} aria-label={`${tip.text}: $${formatTipAmount(a.amount)}`}>
          ${formatTipAmount(a.amount)}
        </a>
      ))}
      <a className="btn tip-amount tip-other" href={tip.link} {...open}>
        Other amount
      </a>
    </div>
  );
}

/** In the line: the KJ's tip buttons under a heading. */
export function TipCard({ tip }: { tip: Tip }) {
  return (
    <section className="tip-card">
      <div className="tip-title">
        <I.Heart /> {tip.text}
      </div>
      <TipButtons tip={tip} />
    </section>
  );
}

/** Right after the singer's song: thanks, and the tip buttons. Shown once per song. */
export function TipPrompt({ view, onDone }: { view: SingerView; onDone: () => void }) {
  const tip = view.tip;
  const prompt = view.tipPrompt;
  if (!tip || !prompt || safeGet(PROMPT_SEEN_KEY) === prompt.id) return null;
  const done = () => {
    safeSet(PROMPT_SEEN_KEY, prompt.id);
    onDone();
  };
  return (
    <section className="tip-prompt" role="status">
      <button className="tip-close" onClick={done} aria-label="Close">
        <I.X />
      </button>
      <div className="tip-prompt-head">Thanks for singing{view.me ? `, ${view.me.name}` : ''}!</div>
      <p className="tip-prompt-sub">
        Enjoyed “{prompt.title}”? {/[.!?]$/.test(tip.text) ? tip.text : `${tip.text}.`}
      </p>
      <TipButtons tip={tip} onTap={done} />
      <button className="btn ghost block tip-later" onClick={done}>
        Not now
      </button>
    </section>
  );
}
