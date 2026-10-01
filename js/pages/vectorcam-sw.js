/* Vector Cam — offline service worker, scoped to /tools/vectorcam.
 *
 * The page is fetched network-first (a new deploy shows up on the next
 * launch), with the cached copy as the fallback offline. Scripts, styles and
 * icons are served from cache and refreshed in the background. Nothing outside
 * the tool is touched. */

const CACHE = 'vectorcam-v8';
const SHELL = [
  '/tools/vectorcam',
  '/js/pages/vectorcam.js?v=8',
  '/js/pages/vectorcam-worker.js?v=8',
  '/js/chrome.js',
  '/styles/site.css',
  '/tools/vectorcam.webmanifest',
  '/apple-touch-icon.png',
  '/icon-512.png',
  '/favicon-32.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('vectorcam-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const path = url.pathname + url.search;
  if (req.mode === 'navigate' && url.pathname === '/tools/vectorcam') {
    e.respondWith(fetch(req).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put('/tools/vectorcam', copy)); return r; })
      .catch(() => caches.match('/tools/vectorcam')));
    return;
  }
  if (!SHELL.includes(path)) return;
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(path);
    const fresh = fetch(req).then(r => { if (r.ok) c.put(path, r.clone()); return r; }).catch(() => hit);
    return hit || fresh;
  }));
});
