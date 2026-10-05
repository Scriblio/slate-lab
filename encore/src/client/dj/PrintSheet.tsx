// Printable QR codes for tables and the bar: one big poster, or four cards to
// a page to cut out. The sheet goes straight into <body> and prints with the
// browser's own print window (which can also save a PDF); while printing,
// everything else on the page is hidden (see .print-sheet in dj.css).

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { desktop } from '../common/desktop.ts';

export type PrintLayout = 'poster' | 'cards';

interface Props {
  layout: PrintLayout;
  showName: string;
  /** Shown under the code only when someone could type it (the Wi-Fi link). */
  typedLink?: string;
  tip?: { text: string };
  onDone: () => void;
}

export function PrintSheet({ layout, showName, typedLink, tip, onDone }: Props) {
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
  const card = (big: boolean, key?: number) => (
    <div className={big ? 'print-poster' : 'print-card'} key={key}>
      <div className="print-show">{showName}</div>
      <img className="print-qr" src={`/api/print-qr.svg?t=${stamp}`} alt="" />
      <div className="print-scan">Scan to sing</div>
      <p className="print-how">Point your phone’s camera at the code to pick a song and get in line. No app needed.</p>
      {typedLink && <p className="print-link">{typedLink}</p>}
      {tip && (
        <div className="print-tip">
          <img src={`/api/tip-qr.svg?t=${stamp}`} alt="" />
          <div>
            <strong>{tip.text}</strong>
            <span>Scan to send a tip</span>
          </div>
        </div>
      )}
    </div>
  );

  return createPortal(
    <div className="print-sheet" ref={ref}>
      {layout === 'poster' ? card(true) : <div className="print-cards">{[0, 1, 2, 3].map((i) => card(false, i))}</div>}
    </div>,
    document.body,
  );
}
