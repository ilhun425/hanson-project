// 프로젝트 관리 — 오프라인 캐시. 파일을 고치면 VERSION을 올려 주세요.
const VERSION = 'v06';
const FILES = ['./', 'index.html', 'app.js', 'config.js', 'xlsx.full.min.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// 앱 파일은 새 버전을 먼저 받아 보고, 인터넷이 없으면 저장해 둔 것을 씁니다. 데이터(Apps Script)는 저장하지 않습니다.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) {
    if (!/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) return;
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); return res; }).catch(() => new Response('', { status: 504 }))));
    return;
  }
  // 브라우저 캐시를 건너뛰고 서버에 새 버전이 있는지 매번 확인 (고친 파일이 바로 반영되도록)
  e.respondWith(fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).then((res) => { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); return res; })
    .catch(() => caches.match(req).then((hit) => hit || caches.match('index.html'))));
});
