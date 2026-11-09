/* Legacy service worker location (scope /static/js/).
 * FileRoom now uses /sw.js with scope "/". If an old installation still updates this
 * worker, it removes its caches and unregisters itself.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  for (const name of await caches.keys()) {
    if (/^fileroom-(v\d+|runtime-v\d+)$/.test(name)) await caches.delete(name);
  }
  await self.registration.unregister();
})()));
