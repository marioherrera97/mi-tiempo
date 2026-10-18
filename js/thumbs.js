// Miniaturas del menú de capas: un pequeño mapa (oeste de Europa) pintado con la escala de color
// de cada capa, costas y un patrón inventado pero verosímil (borrascas, frentes, olas…), como en Windy.
// Se generan una vez en el móvil y se guardan como imagen.
import { lut } from './colors.js';

const W = 168, H = 126;
const LON0 = -13, LON1 = 13, LAT0 = 50.5, LAT1 = 34.5;

// Ruido suave (value noise) y su suma en varias escalas
function hash(x, y, s) {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function noise(x, y, s) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi, s), b = hash(xi + 1, yi, s), c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const fbm = (x, y, s) => (noise(x, y, s) * 0.55 + noise(x * 2.1, y * 2.1, s + 7) * 0.3 + noise(x * 4.3, y * 4.3, s + 13) * 0.15);
const gauss = (dx, dy, r) => Math.exp(-(dx * dx + dy * dy) / (r * r));
const clamp = (v) => Math.max(0, Math.min(1, v));

// Patrón de cada tipo de capa: devuelve la fracción (0-1) del rango de su escala de color.
// u, v: posición 0-1 en la miniatura; lat; land: 1 tierra, 0 mar; n(): ruido 0-1
const PATTERNS = {
  wind: (u, v, lat, land, n) => clamp(0.06 + 0.32 * n(3) + 0.42 * Math.exp(-(((Math.hypot(u - 0.22, (v - 0.3) * 0.75) - 0.13) / 0.07) ** 2)) - 0.08 * land),
  rain: (u, v, lat, land, n) => clamp((n(3.5) - 0.52) * 1.6) ** 1.6 * 0.7,
  rainacc: (u, v, lat, land, n) => clamp((n(2.5) - 0.42) * 1.5) ** 1.4 * 0.6,
  snow: (u, v, lat, land, n) => land * clamp((n(4) - 0.5) * 2 + (lat - 44) / 14) * 0.7,
  cape: (u, v, lat, land, n) => clamp((n(3) - 0.5) * 2.2) * (0.4 + 0.6 * land) * clamp((48 - lat) / 10),
  temp: (u, v, lat, land, n) => (8 + (LAT0 - lat) * 1.15 + land * 3 + (n(2.5) - 0.5) * 9),
  dew: (u, v, lat, land, n) => (4 + (LAT0 - lat) * 0.8 - land * 3 + (n(2.5) - 0.5) * 8),
  uv: (u, v, lat, land, n) => clamp(0.15 + (LAT0 - lat) / 16 * 0.55 + (n(2) - 0.5) * 0.25),
  freezing: (u, v, lat, land, n) => clamp(0.25 + (LAT0 - lat) / 16 * 0.5 + (n(2) - 0.5) * 0.2),
  humidity: (u, v, lat, land, n) => clamp(0.35 + (1 - land) * 0.25 + (n(3) - 0.5) * 0.8),
  clouds: (u, v, lat, land, n) => clamp((n(3) - 0.35) * 1.9),
  visibility: (u, v, lat, land, n) => clamp(1 - clamp((0.58 - n(4)) * 3) * (0.5 + 0.5 * land)),
  pressure: (u, v) => (1014 + 20 * gauss(u - 0.72, v - 0.62, 0.32) - 26 * gauss(u - 0.2, v - 0.28, 0.25)),
  waves: (u, v, lat, land, n) => land > 0.5 ? null : clamp(0.05 + 0.4 * n(3) + 0.3 * clamp(0.35 - u) + 0.15 * clamp((lat - 44) / 6)),
  period: (u, v, lat, land, n) => land > 0.5 ? null : clamp(0.3 + 0.35 * n(2) + 0.3 * clamp(0.4 - u)),
  sst: (u, v, lat, land, n) => land > 0.5 ? null : (13 + (LAT0 - lat) * 0.65 + (n(2) - 0.5) * 3),
  currents: (u, v, lat, land, n) => land > 0.5 ? null : clamp((n(5) - 0.45) * 0.9),
  aqi: (u, v, lat, land, n) => clamp(0.12 + 0.3 * n(3) + 0.25 * land * n(8)),
  pm25: (u, v, lat, land, n) => clamp(0.05 + 0.18 * n(3) + 0.15 * land * n(8)),
  dust: (u, v, lat, land, n) => clamp((40 - lat + n(3) * 8) / 9) ** 1.5 * 0.8,
};
// Qué patrón usa cada capa (las que no aparecen usan el de su escala o el de viento)
const LAYER_PATTERN = {
  gust: 'wind', snowacc: 'snow', snowdepth: 'snow', feels: 'temp', lowclouds: 'clouds', midclouds: 'clouds', highclouds: 'clouds',
  swell: 'waves', windwaves: 'waves', waveperiod: 'period',
};
// Valores en unidades reales (no fracción del rango)
const ABSOLUTE = new Set(['temp', 'dew', 'pressure', 'sst']);
// Capas que se pintan con trazos blancos de flujo
const STREAKS = new Set(['wind', 'gust', 'waves', 'swell', 'windwaves', 'currents']);

let landMask = null, coastPaths = null;
function prepareLand(rings) {
  const toXY = (lon, lat) => [((lon - LON0) / (LON1 - LON0)) * W, ((lat - LAT0) / (LAT1 - LAT0)) * H];
  coastPaths = new Path2D();
  for (const r of rings) {
    let inside = false;
    for (let i = 0; i < r.length; i += 2) if (r[i] > LON0 - 3 && r[i] < LON1 + 3 && r[i + 1] > LAT1 - 3 && r[i + 1] < LAT0 + 3) { inside = true; break; }
    if (!inside) continue;
    for (let i = 0; i < r.length; i += 2) {
      const [x, y] = toXY(r[i], r[i + 1]);
      if (i) coastPaths.lineTo(x, y); else coastPaths.moveTo(x, y);
    }
    coastPaths.closePath();
  }
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fill(coastPaths);
  const a = ctx.getImageData(0, 0, W, H).data;
  landMask = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) landMask[i] = a[i * 4 + 3] / 255;
}

function render(key, spec, seed) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H);
  const d = img.data;
  const kind = spec.kind;
  const pat = kind ? null : PATTERNS[LAYER_PATTERN[key] || key] || PATTERNS[spec.scale] || PATTERNS.wind;
  const patName = kind ? null : (PATTERNS[LAYER_PATTERN[key] || key] ? LAYER_PATTERN[key] || key : PATTERNS[spec.scale] ? spec.scale : 'wind');
  const [min, max] = kind ? [0, 20] : spec.range('surface');
  const table = kind === 'sat' ? null : lut(kind === 'radar' ? 'precip' : spec.scale, min, max);
  for (let y = 0; y < H; y++) {
    const v = y / H, lat = LAT0 + (LAT1 - LAT0) * v;
    for (let x = 0; x < W; x++) {
      const u = x / W, i = y * W + x, land = landMask[i];
      const n = (f) => fbm(u * f, v * f * 0.75, seed);
      // Fondo oscuro: tierra algo más clara que el mar
      let r = 38 + land * 22, g = 44 + land * 22, b = 54 + land * 14;
      let val = null;
      if (kind === 'sat' || spec.sat) {
        r = 20 + land * 60; g = 38 + land * 62; b = 62 + land * 8;
        const cl = clamp((n(3) - 0.42) * 2.4);
        r += (235 - r) * cl; g += (238 - g) * cl; b += (242 - b) * cl;
      }
      if (kind === 'radar') {
        const p = clamp((n(4) - 0.55) * 2.2) * land;
        if (p > 0.02) val = p ** 1.3 * 16;
      } else if (!kind) {
        const p = pat(u, v, lat, land, n);
        val = p === null ? null : ABSOLUTE.has(patName) ? p : min + (max - min) * p;
        // Isobaras: líneas blancas cada 4 hPa
        if (patName === 'pressure' && val !== null && Math.abs(((val % 4) + 4) % 4 - 2) > 1.82) { r = g = b = 235; val = null; }
      }
      if (val !== null) {
        const k = Math.max(0, Math.min(255, Math.round(((val - min) / (max - min)) * 255))) * 4;
        const a = table[k + 3] / 255;
        r += (table[k] - r) * a; g += (table[k + 1] - g) * a; b += (table[k + 2] - b) * a;
      }
      d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // Trazos de flujo
  if (STREAKS.has(key)) {
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 0.9;
    ctx.lineCap = 'round';
    for (let k = 0; k < 90; k++) {
      const x = hash(k, 1, seed) * W, y = hash(k, 2, seed) * H;
      if ((key === 'wind' || key === 'gust') ? false : landMask[(y | 0) * W + (x | 0)] > 0.5) continue;
      // Giro alrededor de la borrasca
      const ang = Math.atan2(y / H - 0.3, x / W - 0.22) + Math.PI / 2 + 0.3;
      const len = 4 + hash(k, 3, seed) * 6;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len); ctx.stroke();
    }
  }
  // Costas
  ctx.strokeStyle = kind === 'sat' ? 'rgba(255,255,255,0.35)' : 'rgba(10,14,20,0.6)';
  ctx.lineWidth = 0.8;
  ctx.stroke(coastPaths);
  return c.toDataURL('image/jpeg', 0.82);
}

const cache = {};
// Genera (una sola vez) las miniaturas de todas las capas. land: anillos de vendor/land.json
export function makeThumbs(layers, land) {
  if (!landMask) prepareLand(land);
  Object.entries(layers).forEach(([key, spec], idx) => {
    if (!cache[key]) cache[key] = render(key, spec, 11 + idx * 7);
  });
  return cache;
}
export const thumbUrl = (key) => cache[key] || null;
