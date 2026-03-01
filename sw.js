// キャッシュを一切使わず、常にネットワークから取得する
// これによりGitHubへのプッシュが即座にアプリに反映される
const CACHE_NAME = 'ejector-v3';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => {
  // 全キャッシュ削除
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Cloudflare Workers はそのまま通す
  if (e.request.url.includes('workers.dev')) return;

  // 常にネットワークから取得（キャッシュなし）
  // オフライン時のみキャッシュにフォールバック
  e.respondWith(
    fetch(e.request, { cache: 'no-store' })
      .catch(() => caches.match(e.request))
  );
});
