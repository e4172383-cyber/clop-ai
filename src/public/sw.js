// Минимальный service worker: нужен, чтобы приложение считалось
// устанавливаемым и показывало понятный экран без сети.
// Ответы ИИ и данные аккаунта НЕ кэшируем — они всегда идут с сервера.
const SHELL = 'clop-shell-v3';
const WORKSPACE_CSS = '/workspace.css?v=20260906-6';
const ASSETS = ['/chat', WORKSPACE_CSS, '/icon-192.png', '/icon-512.png', '/manifest.webmanifest'];
const CACHEABLE_PATHS = new Set(['/chat', '/workspace.css', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest']);

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Всё, что касается данных и входа, — только по сети, без кэша
  if (e.request.method !== 'GET' || url.pathname.startsWith('/chat/api/') || url.pathname.startsWith('/internal/')) return;
  // Оболочку отдаём из сети, но при её отсутствии — из кэша
  e.respondWith((async () => {
    try {
      const response = await fetch(e.request);
      if (response.ok && CACHEABLE_PATHS.has(url.pathname)) {
        const cache = await caches.open(SHELL);
        await cache.put(e.request, response.clone());
      }
      return response;
    } catch {
      const cached = await caches.match(e.request, { ignoreSearch: url.pathname === '/workspace.css' });
      if (cached) return cached;
      if (e.request.mode === 'navigate') return (await caches.match('/chat')) || Response.error();
      return Response.error();
    }
  })());
});
