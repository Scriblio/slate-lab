// The KJ's plan in the console: signing in, the free trial, unlock codes, buying, and the
// notice when Encore isn't unlocked. Only the console ever shows any of this; singers
// are never shown plans, prices or upgrade buttons (their phone just says the show
// isn't open yet).

import { useState, type FormEvent, type ReactNode } from 'react';
import type { DjAction } from '../../shared/protocol.ts';
import { formatDay, MONTHS_TO_BREAK_EVEN, offersOf, planSentence, PRICES } from '../../shared/license.ts';
import * as I from '../common/icons.tsx';
import { request } from '../common/socket.ts';
import { useDj } from './context.ts';

const openSettings = () => window.dispatchEvent(new Event('encore:settings'));

/** Send an account action and keep its error to show right beside the form (not as a toast that fades). */
function useAccountAction() {
  const { socket } = useDj();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(action: DjAction): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await request(socket, 'dj:action', action);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, run };
}

function Problem({ text }: { text: string | null | undefined }) {
  return text ? (
    <p className="settings-error" role="alert">
      <I.Alert /> {text}
    </p>
  ) : null;
}

/** Email, then the 6-digit code. Signing in changes the plan the console is told about, which closes this form. */
export function SignInForm() {
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const { busy, error, setError, run } = useAccountAction();

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const address = (sentTo ?? email).trim();
    if (!address || busy) return;
    if (await run({ type: 'accountSendCode', email: address })) {
      setSentTo(address);
      setCode('');
    }
  };

  const verify = async (e: FormEvent) => {
    e.preventDefault();
    if (!sentTo || code.length < 6 || busy) return;
    await run({ type: 'accountVerify', email: sentTo, code });
  };

  if (!sentTo) {
    return (
      <form className="account-form" onSubmit={send}>
        <label className="field">
          <span className="field-label">Your email</span>
          <input className="input" type="email" autoComplete="email" inputMode="email" placeholder="you@example.com" value={email} maxLength={254} onChange={(e) => setEmail(e.target.value)} />
          <span className="field-hint">We’ll email you a 6-digit code. There’s no password to remember.</span>
        </label>
        <div className="account-actions">
          <button className="btn primary" disabled={!email.trim() || busy}>
            {busy ? <I.Loader /> : null} Send code
          </button>
        </div>
        <Problem text={error} />
      </form>
    );
  }

  return (
    <form className="account-form" onSubmit={verify}>
      <p>
        We emailed a code to <strong>{sentTo}</strong>. It can take a minute, and it may land in your spam folder.
      </p>
      <label className="field">
        <span className="field-label">Code from the email</span>
        <input
          className="input code-input"
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="••••••"
          maxLength={10}
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
        />
      </label>
      <div className="account-actions">
        <button className="btn primary" disabled={code.length < 6 || busy}>
          {busy ? <I.Loader /> : <I.Check />} Sign in
        </button>
        <button type="button" className="btn ghost" disabled={busy} onClick={() => void send()}>
          Send a new code
        </button>
        <button
          type="button"
          className="btn ghost"
          onClick={() => {
            setSentTo(null);
            setError(null);
          }}
        >
          Use a different email
        </button>
      </div>
      <Problem text={error} />
    </form>
  );
}

/** A box for an unlock code. */
export function UnlockForm() {
  const [code, setCode] = useState('');
  const [done, setDone] = useState(false);
  const { busy, error, run } = useAccountAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!code.trim() || busy) return;
    if (await run({ type: 'redeemCode', code })) {
      setCode('');
      setDone(true);
    }
  };
  return (
    <form className="account-form" onSubmit={submit}>
      <div className="settings-row">
        <input
          className="input mono"
          aria-label="Unlock code"
          placeholder="ENC-XXXX-XXXX-XXXX"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={40}
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            setDone(false);
          }}
        />
        <button className="btn" disabled={!code.trim() || busy}>
          {busy ? <I.Loader /> : <I.Lock />} Unlock
        </button>
      </div>
      {done && (
        <p className="guide-status ok" role="status">
          <I.Check /> Unlocked.
        </p>
      )}
      <Problem text={error} />
    </form>
  );
}

/** Ask for one of Stripe's pages and open it in the browser. A failure is kept to show beside the buttons. */
function useStripePage() {
  const { socket } = useDj();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ url: string; which: string } | null>(null);
  async function open(action: Extract<DjAction, { type: 'checkout' | 'billing' }>, which: string) {
    setBusy(which);
    setError(null);
    setLink(null);
    try {
      const { url } = await request<{ url: string }>(socket, 'dj:action', action);
      // The desktop app sends this to the default browser. Whatever opens it, the address is kept in case it doesn't.
      window.open(url, '_blank');
      setLink({ url, which });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  return { busy, error, link, open };
}

/**
 * Buying Encore, subscribing to Encore Monthly, or keeping Cloud going, on Stripe's own page, which
 * opens in the browser; Encore notices by itself when the payment goes through. Nothing here
 * unlocks anything: the license service does, once Stripe says it's paid. Only the console shows
 * this; singers never see prices.
 */
export function Offers() {
  const { view } = useDj();
  const l = view.license;
  const offers = offersOf(l, Date.now());
  const page = useStripePage();
  if (!offers.app && !offers.monthly && !offers.cloud && !offers.manage && !l.buying) return null;
  const busy = Boolean(page.busy);
  return (
    <div className="offers">
      {offers.app && (
        <div className="offer">
          <button className="btn primary" disabled={busy} onClick={() => void page.open({ type: 'checkout', kind: 'app' }, 'app')}>
            {page.busy === 'app' ? <I.Loader /> : <I.Card />} Buy Encore · {PRICES.app}
          </button>
          <span className="muted small">
            {l.source === 'subscription'
              ? 'One payment, yours to keep. Your monthly subscription stops renewing when you buy, and you keep the month you paid for.'
              : 'One payment, yours to keep. It includes a year of Encore Cloud: singers can join from any network, with a QR code that never changes, and get lock-screen alerts.'}
          </span>
        </div>
      )}
      {offers.monthly && (
        <div className="offer">
          <button className="btn" disabled={busy} onClick={() => void page.open({ type: 'checkout', kind: 'monthly' }, 'monthly')}>
            {page.busy === 'monthly' ? <I.Loader /> : <I.Card />} Subscribe · {PRICES.monthly} a month
          </button>
          <span className="muted small">
            Encore and Cloud for as long as you’re subscribed. Cancel any time in Manage billing; it keeps working to the end of the month you paid for. Buying Encore once costs less if you’ll use it for more than {MONTHS_TO_BREAK_EVEN} months.
          </span>
        </div>
      )}
      {offers.cloud && (
        <div className="offer">
          <button className={`btn ${l.cloud ? '' : 'primary'}`} disabled={busy} onClick={() => void page.open({ type: 'checkout', kind: 'cloud' }, 'cloud')}>
            {page.busy === 'cloud' ? <I.Loader /> : <I.Card />} {l.cloud ? 'Keep Cloud going' : 'Add Cloud'} · {PRICES.cloud} a year
          </button>
          <span className="muted small">
            Cloud lets singers join from any network, with a QR code that never changes, and get lock-screen alerts. Without it they join over this laptop’s Wi-Fi. It renews every year, and you can stop it any time in Manage billing; it keeps working to the end of the year you paid for.
          </span>
        </div>
      )}
      {offers.manage && (
        <div className="offer">
          <button className="btn sm" disabled={busy} onClick={() => void page.open({ type: 'billing' }, 'billing')}>
            {page.busy === 'billing' ? <I.Loader /> : <I.Card />} Manage billing
          </button>
          <span className="muted small">See your payments, update your card, or stop {l.source === 'subscription' ? 'Encore Monthly' : 'Cloud'} renewing.</span>
        </div>
      )}
      {/* Microsoft Store policy 10.8.2: the app names who takes the payment. */}
      {(offers.app || offers.monthly || offers.cloud || offers.manage) && <p className="muted small">Payments are taken by Stripe, on its own secure page. Encore never sees your card.</p>}
      {l.buying && (
        <p className="guide-status" role="status">
          <I.Loader /> Finish paying in your browser. Encore updates by itself when it goes through.
        </p>
      )}
      {/* A payment page that is still being waited on, or the billing page just asked for. Once the payment lands, the link goes. */}
      {page.link && (l.buying || page.link.which === 'billing') && (
        <p className="muted small">
          The page opens in your browser. If it didn’t,{' '}
          <a href={page.link.url} target="_blank" rel="noreferrer">
            open it here
          </a>
          .
        </p>
      )}
      <Problem text={page.error} />
    </div>
  );
}

/**
 * What Encore Cloud does and doesn't do, in the words a KJ would use. It is the online join link (the
 * secure page, with the same QR code every show) and the lock-screen alerts that need it; nothing
 * else is Cloud. In particular YouTube is in every plan, so nothing here is something that is paid for.
 */
export function CloudExplainer({ open }: { open?: boolean }) {
  return (
    <details className="cloud-explainer" open={open}>
      <summary>What does Cloud do?</summary>
      <div className="cloud-notes">
        <strong>With Cloud</strong>
        <ul>
          <li>
            <b>Singers can join from any network,</b> even mobile data. The QR code opens a secure page, so phones don’t warn “not secure”.
          </li>
          <li>
            <b>The QR code is the same at every show.</b> Print it once, put it on the tables, and it keeps working.
          </li>
          <li>
            <b>Lock-screen alerts.</b> Singers can turn on a nudge on their phone for when they’re up next, and when they’re called.
          </li>
        </ul>
        <strong>Without Cloud</strong>
        <ul>
          <li>
            <b>Singers join over your venue’s Wi-Fi,</b> so their phones must be on the same network as this laptop.
          </li>
          <li>
            <b>The QR code holds this laptop’s Wi-Fi address,</b> which can change on another night or at another venue, so printed codes can stop working.
          </li>
          <li>
            <b>No lock-screen alerts.</b>
          </li>
        </ul>
        <p className="muted small">
          Either way, the show, the queue, the big screen, your song library, printing, and YouTube search and playback all work the same. Cloud needs this laptop to be online: if the internet drops, the code on the big screen switches to the Wi-Fi link by itself. If Cloud runs out in the middle of a show, tonight’s show keeps it until you start a new list or close Encore.
        </p>
      </div>
    </details>
  );
}

/** "4 October 2026, 11:44 PM", in the KJ's own time zone. */
const when = (iso: string) => `${formatDay(iso)}, ${new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;

/** Settings → Your Encore: who is signed in, the plan in words, and what can be done about it. */
export function YourEncore() {
  const { view, act } = useDj();
  const l = view.license;
  const [confirmOut, setConfirmOut] = useState(false);

  if (l.state === 'off') return <p className="muted small">{planSentence(l)}</p>;

  if (!l.email) {
    return (
      <>
        <p className="muted small">Sign in with your email to start your free 14-day trial. Your plan belongs to your email, so a new computer is just a sign-in.</p>
        <Problem text={l.problem} />
        <SignInForm />
      </>
    );
  }

  return (
    <>
      <div className="plan-card">
        <strong>{planSentence(l)}</strong>
        <span className="muted small">Signed in as {l.email}</span>
        {(l.state === 'trial' || l.state === 'licensed' || l.state === 'owner') && (
          <span className="muted small">
            {l.cloud
              ? 'Encore Cloud is on: singers can join from any network, the QR code never changes, and they can get lock-screen alerts.'
              : 'Encore Cloud isn’t part of your plan. Singers join over this laptop’s Wi-Fi, a printed QR code can go stale at another venue, and there are no lock-screen alerts.'}
          </span>
        )}
        {/* Microsoft Store policy 10.8.4: say in advance what a trial's end changes. */}
        {l.state === 'trial' && (
          <span className="muted small">
            After the trial, Encore still opens and your library, settings and printing keep working. To start new shows you’ll need{' '}
            {l.payments ? (l.monthly ? 'to buy Encore, subscribe or use an unlock code' : 'to buy Encore or use an unlock code') : 'an unlock code'}.
          </span>
        )}
        {l.validUntil && l.state !== 'offline-expired' && (
          <span className="muted small">
            {l.checkedAt ? `Checked ${when(l.checkedAt)}. ` : ''}Works without internet until {formatDay(l.validUntil)}.
          </span>
        )}
      </div>
      <Problem text={l.problem} />
      {/* Open while Cloud is being offered, so the KJ sees what it is before deciding. */}
      {(l.state === 'trial' || l.state === 'licensed' || l.state === 'ended') && <CloudExplainer open={offersOf(l, Date.now()).cloud} />}
      {l.trialAvailable && (
        <div className="settings-row">
          <button className="btn primary" onClick={() => act({ type: 'startTrial' }, 'Your free trial has started')}>
            <I.Sparkle /> Start my free 14-day trial
          </button>
        </div>
      )}
      <Offers />
      {l.state !== 'owner' && (
        <div className="field">
          <span className="field-label">Have an unlock code?</span>
          <UnlockForm />
        </div>
      )}
      {confirmOut ? (
        <div className="danger-zone">
          <span>Sign out of {l.email}? A show that’s running carries on, but you’ll need to sign in again to start a new one.</span>
          <button className="btn sm" onClick={() => setConfirmOut(false)}>
            Cancel
          </button>
          <button
            className="btn sm danger"
            onClick={async () => {
              await act({ type: 'accountSignOut' }, 'Signed out');
              setConfirmOut(false);
            }}
          >
            Sign out
          </button>
        </div>
      ) : (
        <div className="settings-row">
          <button className="btn sm" onClick={() => act({ type: 'refreshLicense' }, 'Checked')}>
            <I.Restart /> Check again
          </button>
          <button className="btn sm ghost" onClick={() => setConfirmOut(true)}>
            <I.Logout /> Sign out
          </button>
        </div>
      )}
    </>
  );
}

/** The notice across the console while Encore isn't unlocked: what happened, and the one thing to do. */
export function LicensePanel() {
  const { view, act } = useDj();
  const l = view.license;
  if (l.state !== 'ended' && l.state !== 'signed-out' && l.state !== 'offline-expired') return null;

  let title: string;
  let body: string;
  let action: ReactNode;
  if (l.state === 'offline-expired') {
    title = 'Encore needs to check your license';
    body = 'Connect this laptop to the internet, then check again. Your library, settings and printing work in the meantime.';
    action = (
      <button className="btn primary" onClick={() => act({ type: 'refreshLicense' }, 'Checked')}>
        <I.Restart /> Check again
      </button>
    );
  } else if (!l.email) {
    title = 'Start your free trial';
    body = l.problem ?? 'Sign in with your email to get 14 days of everything. Your library, settings and printing work without it.';
    action = <SignInForm />;
  } else if (l.trialAvailable) {
    title = 'Start your free trial';
    body = 'You’re signed in. Start your 14 days of everything.';
    action = (
      <button className="btn primary" onClick={() => act({ type: 'startTrial' }, 'Your free trial has started')}>
        <I.Sparkle /> Start my free 14-day trial
      </button>
    );
  } else if (l.state === 'signed-out') {
    title = 'Checking your license';
    body = l.problem ?? 'Encore is checking your account.';
    action = (
      <button className="btn" onClick={() => act({ type: 'refreshLicense' }, 'Checked')}>
        <I.Restart /> Check again
      </button>
    );
  } else {
    title = l.trialEndsAt ? 'Your free trial has ended' : 'This computer has already had its free trial';
    body = `${l.payments ? (l.monthly ? 'Buy Encore, subscribe, or enter an unlock code,' : 'Buy Encore, or enter an unlock code,') : 'Enter an unlock code'} to keep running shows. Your library, settings and printing still work.`;
    action = (
      <div className="offers">
        <Offers />
        <UnlockForm />
      </div>
    );
  }

  return (
    <section className={`license-panel ${l.showOpen ? 'soft' : ''}`} aria-label="Your Encore">
      <div className="license-panel-text">
        <h2>{title}</h2>
        <p>{body}</p>
        {l.showOpen && <p>Tonight’s show carries on until you start a new list or close Encore.</p>}
        {!l.showOpen && l.email && (
          <p>
            <button className="link-btn" onClick={openSettings}>
              Open Your Encore in Settings
            </button>
          </p>
        )}
      </div>
      <div className="license-panel-action">{action}</div>
    </section>
  );
}

/** "Trial: 9 days left", in the top bar, opening Settings. */
export function TrialBadge() {
  const { view } = useDj();
  const l = view.license;
  if (l.state !== 'trial') return null;
  const days = l.trialDaysLeft ?? 0;
  return (
    <button className={`badge badge-btn ${days <= 3 ? 'amber' : 'violet'}`} onClick={openSettings} title="Your free trial. Open Your Encore in Settings">
      Trial: {days} {days === 1 ? 'day' : 'days'} left
    </button>
  );
}
