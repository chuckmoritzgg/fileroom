/**
 * FileRoom Service Worker
 * Enables offline functionality and PWA features
 * 
 * Update Service Worker Version:
 * When you deploy updates, increment the cache version:
 * const CACHE_NAME = 'fileroom-v2';  // Change v1 → v2 ...
 */

const CACHE_NAME = 'fileroom-v1';
const RUNTIME_CACHE = 'fileroom-runtime-v1';

// Files to cache on install
const STATIC_ASSETS = [
  '/',
  '/static/css/styles.css',
  '/static/js/app.js',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap',
  'https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css',
  'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.0/font/bootstrap-icons.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

// Install event - cache static assets
self.addEventListener('install', event => {
  console.log('[SW] Installing service worker...');
  
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW] Caching static assets');
        return cache.addAll(STATIC_ASSETS.map(url => new Request(url, { cache: 'no-cache' })));
      })
      .then(() => self.skipWaiting())
      .catch(err => console.error('[SW] Cache failed:', err))
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', event => {
  console.log('[SW] Activating service worker...');
  
  event.waitUntil(
    caches.keys()
      .then(cacheNames => {
        return Promise.all(
          cacheNames
            .filter(name => name !== CACHE_NAME && name !== RUNTIME_CACHE)
            .map(name => {
              console.log('[SW] Deleting old cache:', name);
              return caches.delete(name);
            })
        );
      })
      .then(() => self.clients.claim())
  );
});

// Fetch event - serve from cache, fallback to network
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') {
    return;
  }

  // Skip WebSocket connections
  if (url.protocol === 'ws:' || url.protocol === 'wss:') {
    return;
  }

  // Skip API calls for uploads and messages (always use network)
  if (url.pathname.startsWith('/api/upload') || 
      url.pathname.startsWith('/api/message') ||
      url.pathname.startsWith('/api/download') ||
      url.pathname.startsWith('/ws/')) {
    return;
  }

  // For static assets and pages, use cache-first strategy
  event.respondWith(
    caches.match(request)
      .then(cachedResponse => {
        if (cachedResponse) {
          console.log('[SW] Serving from cache:', request.url);
          return cachedResponse;
        }

        // Not in cache, fetch from network
        return fetch(request)
          .then(response => {
            // Don't cache if not a valid response
            if (!response || response.status !== 200 || response.type === 'error') {
              return response;
            }

            // Clone the response
            const responseToCache = response.clone();

            // Cache external resources and our own resources
            if (url.origin === location.origin || 
                url.hostname.includes('googleapis.com') ||
                url.hostname.includes('jsdelivr.net') ||
                url.hostname.includes('unpkg.com')) {
              
              caches.open(RUNTIME_CACHE)
                .then(cache => {
                  cache.put(request, responseToCache);
                });
            }

            return response;
          })
          .catch(err => {
            console.error('[SW] Fetch failed:', err);
            
            // Return offline page for navigation requests
            if (request.mode === 'navigate') {
              return caches.match('/');
            }
            
            throw err;
          });
      })
  );
});

// Handle messages from clients
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});