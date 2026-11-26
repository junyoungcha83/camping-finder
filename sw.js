// 앱 껍데기는 캐시 우선, 데이터(camps.json)는 네트워크 우선 — 데이터 갱신이 바로 보이도록.
const CACHE = 'camping-v5';
const SHELL = ['./', 'index.html', 'assets/app.css?v=5', 'assets/app.js?v=5', 'assets/gear.js?v=5', 'assets/icon.svg', 'manifest.webmanifest', 'data/camps.json'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return; // 지도·API·날씨는 그대로 네트워크
  if (/\/data\/(camps|detail)\.json$/.test(u.pathname) || e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then((r) => { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); return r; })
      .catch(() => caches.match(e.request, { ignoreSearch: true })));
    return;
  }
  e.respondWith(caches.match(e.request).then((m) => m || fetch(e.request)));
});
