// Datos propios del ECMWF para el mapa: los genera cada 6 h el flujo de GitHub (pipeline/ecmwf.py)
// y se publican con la web, así que leerlos no gasta cuota de ninguna API.
// Cada hora son varias imágenes PNG con tres variables por imagen codificadas en los canales RGB.

const BASE = 'data/ecmwf/';
let metaPromise = null;

export function loadMeta(force = false) {
  if (!metaPromise || force) {
    metaPromise = fetch(BASE + 'meta.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((m) => { if (!m) metaPromise = null; return m; }); // si aún no hay datos, se vuelve a mirar más tarde
  }
  return metaPromise;
}

// Imágenes necesarias por capa y altitud (null = la capa no está en los datos propios)
const SUPPORT = {
  wind: { surface: ['a'], '850hPa': ['d'], '500hPa': ['e'] },
  gust: { surface: ['c'] },
  temp: { surface: ['a'], '850hPa': ['d'] },
  dew: { surface: ['c'] },
  humidity: { surface: ['c'] },
  rain: { surface: ['b'] },
  rainacc: { surface: ['b'] },
  clouds: { surface: ['b'] },
  pressure: { surface: ['b'] },
  cape: { surface: ['c'] },
};
// Siempre: 'a' (partículas de viento y temperatura de las ciudades) y 'b' (isobaras)
export function imagesFor(layer, level) {
  const s = SUPPORT[layer]?.[level];
  return s ? [...new Set(['a', 'b', ...s])] : null;
}

// Región de los datos: 'eu' (Europa, 0,5°) o 'world' (todo el mundo, 1°)
export const regionGrid = (meta, region) => (region === 'eu' ? meta.grid : meta.regions?.[region]);

export function createGrid(meta, region = 'eu') {
  const g = regionGrid(meta, region);
  return {
    own: true, run: meta.runId, meta, region, prefix: g.prefix || '', wrap: region === 'world', res: g.res,
    lat0: g.south, lon0: g.west, dlat: g.res, dlon: g.res, nx: g.nx, ny: g.ny,
    nt: meta.times.length, times: meta.times, vars: {}, groups: new Set(['own']), loaded: {},
  };
}

const isLoaded = (grid, img, t) => !!grid.loaded[img]?.has(t);
const pending = new Map();

function ensure(grid, name) {
  if (!grid.vars[name]) grid.vars[name] = new Float32Array(grid.nt * grid.nx * grid.ny).fill(NaN);
  return grid.vars[name];
}

async function readPixels(url, nx, ny) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(nx, ny) : Object.assign(document.createElement('canvas'), { width: nx, height: ny });
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  return ctx.getImageData(0, 0, nx, ny).data;
}

// Variables de cada imagen (nombre en meta.vars, en el orden de los canales R, G, B)
const CHANNELS = {
  a: ['u10', 'v10', 't2m'], b: ['msl', 'tp', 'tcc'], c: ['gust', 'd2m', 'cape'],
  d: ['u850', 'v850', 't850'], e: ['u500', 'v500', 'gh500'],
};

// Descarga y decodifica una imagen de una hora; devuelve true si se ha cargado algo nuevo
export function loadStep(grid, t, img) {
  if (isLoaded(grid, img, t)) return Promise.resolve(false);
  const key = `${grid.run}|${grid.prefix}${img}|${t}`;
  if (pending.has(key)) return pending.get(key);
  const p = (async () => {
    const { nx, ny, meta } = grid;
    const n = nx * ny;
    const url = `${BASE}${meta.runId}/${grid.prefix}${img}${String(meta.steps[t]).padStart(3, '0')}.png`;
    const px = await readPixels(url, nx, ny);
    const dec = CHANNELS[img].map((name) => {
      const v = meta.vars[name];
      return (q) => v.min + (v.sqrt ? (q / 255) ** 2 : q / 255) * (v.max - v.min);
    });
    // Las filas del PNG van de norte a sur; la rejilla del mapa, de sur a norte
    const raw = CHANNELS[img].map(() => new Float32Array(n));
    for (let r = 0; r < ny; r++) {
      const j = ny - 1 - r;
      for (let i = 0; i < nx; i++) {
        const o = (r * nx + i) * 4, k = j * nx + i;
        raw[0][k] = dec[0](px[o]); raw[1][k] = dec[1](px[o + 1]); raw[2][k] = dec[2](px[o + 2]);
      }
    }
    const base = t * n;
    const put = (name, arr, f = (x) => x) => { const out = ensure(grid, name); for (let k = 0; k < n; k++) out[base + k] = f(arr[k], k); };
    const KMH = 3.6;
    if (img === 'a') {
      put('f_surface_u', raw[0], (x) => x * KMH);
      put('f_surface_v', raw[1], (x) => x * KMH);
      put('wind_speed_10m', raw[0], (x, k) => Math.hypot(x, raw[1][k]) * KMH);
      put('temperature_2m', raw[2]);
    } else if (img === 'b') {
      put('pressure_msl', raw[0]);
      put('precipitation', raw[1]);
      put('cloud_cover', raw[2]);
    } else if (img === 'c') {
      put('wind_gusts_10m', raw[0], (x) => x * KMH);
      put('dew_point_2m', raw[1]);
      put('cape', raw[2]);
    } else if (img === 'd') {
      put('f_850hPa_u', raw[0], (x) => x * KMH);
      put('f_850hPa_v', raw[1], (x) => x * KMH);
      put('wind_speed_850hPa', raw[0], (x, k) => Math.hypot(x, raw[1][k]) * KMH);
      put('temperature_850hPa', raw[2]);
    } else if (img === 'e') {
      put('f_500hPa_u', raw[0], (x) => x * KMH);
      put('f_500hPa_v', raw[1], (x) => x * KMH);
      put('wind_speed_500hPa', raw[0], (x, k) => Math.hypot(x, raw[1][k]) * KMH);
      put('geopotential_height_500hPa', raw[2]);
    }
    (grid.loaded[img] ||= new Set()).add(t);
    // Humedad relativa a partir de temperatura y punto de rocío (fórmula de Magnus)
    if ((img === 'a' || img === 'c') && isLoaded(grid, 'a', t) && isLoaded(grid, 'c', t)) {
      const T = grid.vars.temperature_2m, D = grid.vars.dew_point_2m;
      const rh = ensure(grid, 'relative_humidity_2m');
      for (let k = base; k < base + n; k++) {
        rh[k] = Math.min(100, 100 * Math.exp((17.625 * D[k]) / (243.04 + D[k]) - (17.625 * T[k]) / (243.04 + T[k])));
      }
    }
    return true;
  })().finally(() => pending.delete(key));
  pending.set(key, p);
  return p;
}

// Lluvia acumulada desde la hora t0 (mm), con los intervalos reales entre horas
export function updateAccum(grid, t0) {
  const rate = grid.vars.precipitation;
  if (!rate) return;
  const n = grid.nx * grid.ny;
  const acc = ensure(grid, 'acc_precip');
  acc.fill(0, 0, (t0 + 1) * n);
  for (let t = t0 + 1; t < grid.nt; t++) {
    const hours = (Date.parse(grid.times[t] + ':00Z') - Date.parse(grid.times[t - 1] + ':00Z')) / 3600e3;
    const ok = isLoaded(grid, 'b', t);
    for (let k = 0; k < n; k++) {
      const add = ok ? rate[t * n + k] * hours : 0;
      acc[t * n + k] = acc[(t - 1) * n + k] + (add === add ? add : 0);
    }
  }
}

// Carga en segundo plano las horas cercanas a la que se ve (las demás, al mover la barra de tiempo)
export async function prefetch(grid, imgs, from, ahead, isCurrent, onStep, concurrency = 3) {
  const order = [];
  for (let d = 0; d <= ahead; d++) {
    if (from + d < grid.nt) order.push(from + d);
    if (d && from - d >= 0) order.push(from - d);
  }
  const jobs = [];
  for (const t of order) for (const img of imgs) if (!isLoaded(grid, img, t)) jobs.push([t, img]);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length && isCurrent()) {
      const [t, img] = jobs[next++];
      try {
        if (await loadStep(grid, t, img)) onStep(t, img);
      } catch { /* sin red: se reintentará al volver */ }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}

export const stepLoaded = (grid, imgs, t) => imgs.every((img) => isLoaded(grid, img, t));
