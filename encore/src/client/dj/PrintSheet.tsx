// Printable QR codes for tables and the bar: a folded table tent (the code
// on one side, how it works on the other), a poster, four cards to cut out,
// or the code on its own. The sheet goes straight into <body> and prints with
// the system print window (which can also save a PDF); while printing,
// everything else on the page is hidden (see .print-sheet in dj.css).

import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { desktop } from '../common/desktop.ts';

export type PrintLayout = 'tent' | 'poster' | 'cards' | 'qr';
/** Where the fold ends up: at the bottom in a sign holder, or on top for a tent that stands by itself. */
export type TentFold = 'bottom' | 'top';

interface Props {
  layout: PrintLayout;
  showName: string;
  /** Shown under the code only when someone could type it (the Wi-Fi link). */
  typedLink?: string;
  tip?: { text: string };
  /** Lock-screen alerts are available (only with the online link). */
  alerts: boolean;
  fold?: TentFold;
  onDone: () => void;
}

export function PrintSheet({ layout, showName, typedLink, tip, alerts, fold = 'bottom', onDone }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    window.addEventListener('afterprint', onDone, { once: true });
    // Print once the codes have loaded, or they come out blank.
    const imgs = [...(ref.current?.querySelectorAll('img') ?? [])];
    void Promise.all(imgs.map((img) => img.decode().catch(() => {}))).then(() => {
      if (cancelled) return;
      // The desktop app prints through Electron, and says when the print window closes.
      if (desktop?.print) void desktop.print().finally(onDone);
      else window.print();
    });
    return () => {
      cancelled = true;
      window.removeEventListener('afterprint', onDone);
    };
    // Prints once per sheet; a new print mounts a new sheet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A fresh image each time, in case the link changed since the last print.
  const stamp = useRef(Date.now()).current;
  const qr = <img className="print-qr" src={`/api/print-qr.svg?t=${stamp}`} alt="" />;
  const tipBox = tip && (
    <div className="print-tip">
      <img src={`/api/tip-qr.svg?t=${stamp}`} alt="" />
      <div>
        <strong>{tip.text}</strong>
        <span>Scan to send a tip</span>
      </div>
    </div>
  );
  const card = (big: boolean, key?: number) => (
    <div className={big ? 'print-poster' : 'print-card'} key={key}>
      <div className="print-show">{showName}</div>
      {qr}
      <div className="print-scan">Scan to sing</div>
      <p className="print-how">Point your phone’s camera at the code to pick a song and get in line. No app needed.</p>
      {typedLink && <p className="print-link">{typedLink}</p>}
      {tipBox}
    </div>
  );

  let body: ReactNode;
  if (layout === 'poster') body = card(true);
  else if (layout === 'cards') body = <div className="print-cards">{[0, 1, 2, 3].map((i) => card(false, i))}</div>;
  else if (layout === 'qr') body = <div className="print-qr-only">{qr}</div>;
  else {
    // Folded in half, both sides should read the right way up. With the fold at the bottom (in a holder), the
    // bottom half ends up upside down at the back, so it's printed upside down; with the fold on top (a tent),
    // it's the top half.
    const front = (
      <div className={`print-tent-half print-tent-front ${fold === 'top' ? 'flipped' : ''}`}>
        {qr}
        <div className="print-tent-words">
          <div className="print-show">{showName}</div>
          <div className="print-scan">Scan to sing</div>
          <p className="print-how">Point your phone’s camera at the code. No app needed.</p>
          {typedLink && <p className="print-link">{typedLink}</p>}
        </div>
      </div>
    );
    const back = (
      <div className={`print-tent-half print-tent-back ${fold === 'bottom' ? 'flipped' : ''}`}>
        <div className="print-steps-title">How karaoke works tonight</div>
        <ol className="print-steps">
          <li>
            <strong>Scan the code</strong> on the other side with your phone’s camera. No app to download.
          </li>
          <li>
            <strong>Pick your song.</strong> Enter your name, find a song and add it. <em>The line</em> shows when you’re up.
          </li>
          <li>
            <strong>Watch your phone.</strong> It tells you when you’re next and when it’s your turn
            {alerts ? <>. Turn on alerts in <em>My songs</em> to get them with your phone locked.</> : <>, so keep the page open.</>}
          </li>
          <li>
            <strong>Need a break?</strong> Turn on <em>Taking a break</em> in <em>My songs</em> and you keep your place. Called up but not ready? Tap <em>Can’t sing right now</em>.
          </li>
          <li>
            <strong>Heading home?</strong> Tap <em>Leave the list</em> in <em>My songs</em> so the KJ doesn’t call you. Back another time? Join with the same name and your 4-digit rejoin code.
          </li>
        </ol>
        {tipBox}
      </div>
    );
    // The code is always on the top half and how it works on the bottom half.
    body = (
      <div className="print-tent">
        {front}
        <div className="print-fold" aria-hidden="true" />
        {back}
      </div>
    );
  }

  return createPortal(
    <div className="print-sheet" ref={ref}>
      {body}
    </div>,
    document.body,
  );
}
