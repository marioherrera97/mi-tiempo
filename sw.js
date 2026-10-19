// Service worker: la app funciona sin conexión mostrando los últimos datos descargados.
const VERSION = 'v53';
const SHELL = `shell-${VERSION}`;
const DATA = 'data-v1';
const TILES = 'tiles-v1';
const ECMWF = 'ecmwf-v1';

const SHELL_FILES = [
  './', 'index.html', 'manifest.webmanifest', 'css/styles.css', 'css/windy.css',
  'vendor/leaflet.js', 'vendor/leaflet.css', 'vendor/chart.js', 'vendor/land.json', 'vendor/borders.json', 'vendor/regions.json', 'vendor/lakes.json', 'vendor/cities.json',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'js/app.js', 'js/state.js', 'js/api.js', 'js/data.js', 'js/format.js', 'js/icons.js', 'js/colors.js',
  'js/charts.js', 'js/ui.js', 'js/select.js', 'js/windlayer.js', 'js/owndata.js', 'js/metno.js', 'js/thumbs.js',
  'js/views/home.js', 'js/views/hourly.js', 'js/views/map.js', 'js/views/trend.js',
  'js/views/more.js', 'js/views/compare.js', 'js/views/marine.js', 'js/views/air.js',
  'js/views/history.js', 'js/views/settings.js', 'js/views/mapdetail.js', 'js/views/reservoirs.js',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' evita guardar copias viejas de la caché HTTP del navegador
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES.map((f) => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => ![SHELL, DATA, TILES, ECMWF].includes(k)).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

async function trimCache(name, max) {
  const c = await caches.open(name);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - max; i++) await c.delete(keys[i]);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Datos meteorológicos: primero red, si falla la copia guardada
  if (url.hostname.endsWith('open-meteo.com') || url.hostname === 'api.rainviewer.com') {
    e.respondWith(
      fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(DATA).then((c) => c.put(req, copy)).then(() => trimCache(DATA, 60));
        }
        return res;
      }).catch(() => caches.match(req).then((r) => r || Response.error()))
    );
    return;
  }

  // Datos propios del ECMWF: meta.json siempre de la red; las imágenes no cambian dentro de una pasada
  if (url.origin === self.location.origin && url.pathname.includes('/data/ecmwf/')) {
    if (url.pathname.endsWith('meta.json')) {
      e.respondWith(fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(ECMWF).then((c) => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req).then((r) => r || Response.error())));
    } else {
      e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(ECMWF).then((c) => c.put(req, copy)).then(() => trimCache(ECMWF, 700));
        }
        return res;
      })));
    }
    return;
  }

  // Embalses (cada semana) y pluviómetros (cada hora): primero red y, sin conexión, la última copia
  if (url.origin === self.location.origin && (url.pathname.endsWith('/vendor/embalses.json') || url.pathname.endsWith('/data/pluviometros.json') || url.pathname.endsWith('/data/saih.json'))) {
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(DATA).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((r) => r || Response.error())));
    return;
  }

  // Pueblos por zonas: no cambian, primero caché
  if (url.origin === self.location.origin && url.pathname.includes('/vendor/places/')) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(TILES).then((c) => c.put(req, copy)); }
      return res;
    })));
    return;
  }

  // Teselas del mapa base: primero caché
  if (url.hostname === 'server.arcgisonline.com' || url.hostname.endsWith('tile.openstreetmap.org') || url.hostname.endsWith('opentopomap.org')) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok || res.type === 'opaque') {
          const copy = res.clone();
          caches.open(TILES).then((c) => c.put(req, copy)).then(() => trimCache(TILES, 400));
        }
        return res;
      }))
    );
    return;
  }

  // Ficheros de la app: caché y actualización en segundo plano
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.open(SHELL).then(async (c) => {
        const hit = await c.match(req, { ignoreSearch: true });
        const net = fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => hit);
        return hit || net;
      })
    );
  }
});
