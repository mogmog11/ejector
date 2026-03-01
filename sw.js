const CACHE_NAME = 'ejector-v2';

// ネットワーク優先戦略：常に最新を取得し、オフライン時のみキャッシュを使う
self.addEventListener('install', e => {
  self.skipWaiting(); // 即座にアクティブ化
});

self.addEventListener('activate', e => {
  // 古いキャッシュを全削除
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Cloudflare Workers APIはSWをスキップ
  if (e.request.url.includes('workers.dev')) return;
  // Google Fontsもネットワーク優先
  if (e.request.url.includes('fonts.googleapis') || e.request.url.includes('fonts.gstatic')) {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(e.request))
    );
    return;
  }

  // ネットワーク優先、失敗時にキャッシュ
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
