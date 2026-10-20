// Rayos: Lightning Imager del Meteosat de tercera generación (MTG-I, EUMETSAT), producto «Accumulated Flash Area»:
// zonas donde ha habido rayos cada 5 minutos, por el servicio WMS público de EUMETView (con CORS, se puede leer
// píxel a píxel). Llega con unos 30–45 minutos de retraso.
const WMS = 'https://view.eumetsat.int/geoserver/wms';
const LAYER = 'mtg_fd:li_afa';
const STEP = 5 * 60e3;
export const FRAMES = 6; // media hora

// Hora del último fotograma publicado (de las capacidades de la capa, ~7 KB)
let latest = null, latestAt = 0;
export function latestTime() {
  if (!latest || Date.now() - latestAt > 4 * 60e3) {
    latestAt = Date.now();
    latest = fetch('https://view.eumetsat.int/geoserver/mtg_fd/li_afa/ows?service=WMS&request=GetCapabilities&version=1.3.0')
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`Error HTTP ${r.status}`))))
      .then((x) => {
        const m = x.match(/<Dimension name="time" default="([^"]+)"/);
        if (!m) throw new Error('sin hora');
        return Date.parse(m[1]);
      })
      // Sin capacidades: se calcula con el retraso habitual
      .catch(() => Math.floor((Date.now() - 40 * 60e3) / STEP) * STEP);
  }
  return latest;
}
export const frameTimes = (t0) => Array.from({ length: FRAMES }, (_, k) => t0 - (FRAMES - 1 - k) * STEP);
const isoZ = (t) => new Date(t).toISOString().slice(0, 19) + 'Z';

// Capas para Leaflet: los 6 fotogramas apilados, los más viejos más transparentes
export function mapLayers(L, t0) {
  return frameTimes(t0).map((t, k) => L.tileLayer.wms(WMS, {
    layers: LAYER, format: 'image/png', transparent: true, version: '1.3.0', zIndex: 320,
    opacity: 0.35 + (0.65 * (k + 1)) / FRAMES, attribution: 'EUMETSAT (MTG Lightning Imager)', time: isoZ(t),
  }));
}

// ---------- Rayos cerca de un lugar ----------
const R = 1.1; // grados de latitud a cada lado (~120 km)
const PX = 112;
const rad = Math.PI / 180;
const distKm = (a, b, c, d) => {
  const x = Math.sin(((c - a) * rad) / 2) ** 2 + Math.cos(a * rad) * Math.cos(c * rad) * Math.sin(((d - b) * rad) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(x));
};
const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
const bearing = (a, b, c, d) => {
  const y = Math.sin((d - b) * rad) * Math.cos(c * rad);
  const x = Math.cos(a * rad) * Math.sin(c * rad) - Math.sin(a * rad) * Math.cos(c * rad) * Math.cos((d - b) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
};

async function frame(p, t) {
  const rl = R / Math.cos(p.lat * rad);
  const box = [p.lat - R, p.lon - rl, p.lat + R, p.lon + rl];
  const url = `${WMS}?service=WMS&request=GetMap&version=1.3.0&layers=${LAYER}&styles=&crs=EPSG:4326&bbox=${box.map((v) => v.toFixed(3)).join(',')}`
    + `&width=${PX}&height=${PX}&format=image/png&transparent=true&time=${isoZ(t)}`;
  // El servidor de EUMETView da a veces un 502 suelto: un reintento
  let res = await fetch(url).catch(() => null);
  if (!res?.ok) res = await new Promise((ok) => setTimeout(ok, 800)).then(() => fetch(url));
  if (!res.ok) throw new Error(`Error HTTP ${res.status}`);
  const img = await createImageBitmap(await res.blob());
  const c = new OffscreenCanvas(PX, PX);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, PX, PX).data;
  const hits = [];
  for (let j = 0; j < PX; j++) {
    for (let i = 0; i < PX; i++) {
      if (px[(j * PX + i) * 4 + 3] < 40) continue;
      const lat = box[2] - ((j + 0.5) / PX) * 2 * R, lon = box[1] + ((i + 0.5) / PX) * 2 * rl;
      hits.push([lat, lon]);
    }
  }
  return hits;
}

// { km, dir, t (último fotograma), age (min), trend: -1 alejándose / 0 / 1 acercándose, cells } o null si no hay rayos
export async function nearby(p, maxKm = 100) {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return null;
  const t0 = await latestTime();
  const times = frameTimes(t0);
  const frames = await Promise.all(times.map((t) => frame(p, t).catch(() => [])));
  const near = (hits) => hits.reduce((best, h) => {
    const km = distKm(p.lat, p.lon, h[0], h[1]);
    return km < best.km ? { km, h } : best;
  }, { km: Infinity, h: null });
  const all = near(frames.flat());
  if (!all.h || all.km > maxKm) return null;
  const old = near(frames.slice(0, 3).flat()), recent = near(frames.slice(3).flat());
  const trend = !Number.isFinite(old.km) || !Number.isFinite(recent.km) ? 0 : recent.km < old.km - 6 ? 1 : recent.km > old.km + 6 ? -1 : 0;
  // Si los más cercanos son de los últimos fotogramas, ahí está ahora la tormenta
  const now = Number.isFinite(recent.km) ? recent : all;
  return {
    km: now.km, dir: DIRS[Math.round(bearing(p.lat, p.lon, now.h[0], now.h[1]) / 45) % 8], t: t0,
    age: Math.max(0, Math.round((Date.now() - t0) / 60e3)), trend, cells: frames.flat().length,
  };
}
