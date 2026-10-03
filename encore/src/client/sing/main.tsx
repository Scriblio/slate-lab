// The secure online join page (served from the join origin, e.g.
// https://sing.scriblio.co). The QR code's URL fragment says which KJ to
// reach and carries their public key; the page talks to that laptop through
// the encrypted relay and otherwise is the same singer app as on Wi-Fi.

import { createRoot } from 'react-dom/client';
import '../common/base.css';
import '../join/join.css';
import { CLOUD } from '../../shared/cloud.ts';
import { parseJoinFragment, supabaseTransport } from '../../shared/relay.ts';
import type { AppSocket } from '../common/socket.ts';
import { RelaySocket } from '../common/relay-socket.ts';
import * as I from '../common/icons.tsx';
import { ToastProvider } from '../common/ui.tsx';
import { JoinApp } from '../join/JoinApp.tsx';
import { browserAlerts } from './alerts.ts';

const target = parseJoinFragment(location.hash);
const root = createRoot(document.getElementById('root')!);

if (!target || !CLOUD.supabaseUrl) {
  root.render(
    <div className="splash">
      <div className="logo-mark big">
        <I.Mic />
      </div>
      <h1 className="scan-title">Scan the QR code to sing</h1>
      <p className="muted scan-copy">Point your phone camera at the code on the karaoke screen. It opens this page already connected to tonight’s show.</p>
    </div>,
  );
} else {
  const socket = new RelaySocket(supabaseTransport(CLOUD.supabaseUrl, CLOUD.supabaseKey), target) as unknown as AppSocket;
  root.render(
    <ToastProvider>
      <JoinApp
        socket={socket}
        tokenKey={`encore.token.${target.room}`}
        showConnectionErrors
        offlineHint="Can’t reach the KJ right now. Their laptop may be offline. Keep this page open; it reconnects on its own."
        alerts={browserAlerts()}
      />
    </ToastProvider>,
  );
}
