// Encore's service worker on the online join page (sing.scriblio.co/sw.js).
// It only shows the "you're up" alerts the KJ's laptop sends while a phone is
// locked, and opens the page again when one is tapped. It doesn't cache or
// intercept anything.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = (event.data && event.data.json()) || {};
  } catch {
    // Not one of ours; still show something, as browsers require.
  }
  const called = data.kind === 'called';
  const title = typeof data.title === 'string' && data.title ? data.title.slice(0, 80) : 'Karaoke';
  const body = typeof data.body === 'string' ? data.body.slice(0, 200) : '';
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      // One alert at a time: "you're up next" turns into "it's your turn".
      tag: 'encore-turn',
      renotify: true,
      requireInteraction: called,
      icon: '/apple-touch-icon.png',
      vibrate: called ? [300, 120, 300, 120, 300] : [200, 100, 200],
      data: { url: ownPage(data.url) },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = ownPage(event.notification.data && event.notification.data.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((w) => w.url === url) || windows[0];
      if (open) return open.focus();
      return self.clients.openWindow(url);
    })(),
  );
});

/** Only ever open this site's own pages. */
function ownPage(url) {
  try {
    const u = new URL(String(url || '/'), self.location.origin);
    return u.origin === self.location.origin ? u.href : new URL('/', self.location.origin).href;
  } catch {
    return new URL('/', self.location.origin).href;
  }
}
