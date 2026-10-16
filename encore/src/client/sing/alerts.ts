// Lock-screen alerts on the online join page: Web Push through this site's
// service worker (/sw.js). The KJ's laptop sends the alerts itself and the
// key phones subscribe with is that laptop's own (see src/server/push.ts).

import type { PushSubscriptionRef } from '../../shared/protocol.ts';
import { b64url, unb64url } from '../../shared/relay.ts';

export type AlertSupport =
  /** Push works in this browser. */
  | 'ready'
  /** iPhone or iPad in Safari: push works only from a home-screen web app. */
  | 'home-screen'
  /** No push here (an old browser, or an app's built-in browser). */
  | 'none';

export interface LockScreenAlerts {
  support: AlertSupport;
  permission(): NotificationPermission;
  /** Ask for permission (call straight from a tap) and subscribe with the laptop's key. */
  enable(key: string): Promise<PushSubscriptionRef>;
  /** This browser's subscription for that key, if it still has one. */
  current(key: string): Promise<PushSubscriptionRef | null>;
  disable(): Promise<void>;
}

export function browserAlerts(): LockScreenAlerts {
  const nav = navigator as Navigator & { standalone?: boolean };
  const ready = window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const ios = /iPhone|iPad|iPod/.test(nav.userAgent) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
  const standalone = nav.standalone === true || matchMedia('(display-mode: standalone)').matches;
  const support: AlertSupport = ready ? 'ready' : ios && !standalone ? 'home-screen' : 'none';

  // Registered on every visit, so a phone that turned alerts on keeps getting them.
  const registered = ready ? navigator.serviceWorker.register('/sw.js') : Promise.reject(new Error('This browser can’t show alerts.'));
  registered.catch(() => {});
  const registration = async () => {
    await registered;
    return navigator.serviceWorker.ready;
  };
  const subscribedWith = (sub: PushSubscription, key: string) => {
    const k = sub.options.applicationServerKey;
    return Boolean(k) && b64url(new Uint8Array(k!)) === key;
  };

  return {
    support,
    permission: () => (ready ? Notification.permission : 'denied'),
    async enable(key) {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        throw new Error(
          permission === 'denied'
            ? 'Alerts are blocked for this site. You can allow them in your browser’s settings.'
            : 'Alerts weren’t turned on. Try again and tap Allow.',
        );
      }
      const reg = await registration();
      let sub = await reg.pushManager.getSubscription();
      // Subscribed for a different KJ's laptop: one subscription per site, so swap it.
      if (sub && !subscribedWith(sub, key)) {
        await sub.unsubscribe();
        sub = null;
      }
      sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64url(key) });
      return toRef(sub);
    },
    async current(key) {
      if (!ready) return null;
      const sub = await (await registration()).pushManager.getSubscription();
      return sub && subscribedWith(sub, key) ? toRef(sub) : null;
    },
    async disable() {
      if (!ready) return;
      const sub = await (await registration()).pushManager.getSubscription();
      await sub?.unsubscribe();
    },
  };
}

function toRef(sub: PushSubscription): PushSubscriptionRef {
  const json = sub.toJSON();
  return {
    endpoint: sub.endpoint,
    expirationTime: json.expirationTime ?? null,
    keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
  };
}
