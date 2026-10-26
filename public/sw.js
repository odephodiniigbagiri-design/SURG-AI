// SURG AI service worker: lets the app install, opens offline from the last visit, and shows reminders.
const C = 'surg-shell-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api') || u.pathname.startsWith('/backend_media')) return;
  if (r.mode === 'navigate') e.respondWith(fetch(r).then(x => { const c = x.clone(); caches.open(C).then(k => k.put('/', c)); return x; }).catch(() => caches.match('/')));
});
self.addEventListener('push', e => {
  let d = {}; try { d = e.data.json(); } catch (x) {}
  e.waitUntil(self.registration.showNotification(d.title || 'SURG AI', { body: d.body || '', icon: '/surg-ai-logo.png', badge: '/surg-ai-logo.png', data: { url: d.url || '/#today' } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window' }).then(l => l.length ? l[0].focus() : clients.openWindow(e.notification.data.url)));
});
