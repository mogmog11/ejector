// EJECTOR Service Worker - ネットワークファーストキャッシュ + Web Push通知
const CACHE_NAME = 'ejector-v4';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.url.includes('workers.dev')) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-store' })
      .catch(() => caches.match(e.request))
  );
});

// ── Push通知受信 ──────────────────────────────────────
self.addEventListener('push', e => {
  if (!e.data) return;

  let payload;
  try {
    payload = e.data.json();
  } catch {
    payload = { title: 'EJECTOR', body: e.data.text() };
  }

  e.waitUntil(
    self.registration.showNotification(payload.title || 'EJECTOR', {
      body:    payload.body  || '',
      icon:    payload.icon  || './icon-192.png',
      badge:   payload.badge || './icon-192.png',
      tag:     payload.tag   || 'ejector',
      renotify: true,
      data:    { url: self.location.origin + '/ejector/ejector.html' },
    })
  );
});

// ── 通知タップ → アプリを開く ─────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const targetUrl = e.notification.data?.url || './ejector.html';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes('ejector') && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow(targetUrl);
    })
  );
});
