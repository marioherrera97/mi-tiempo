// Acceso a las APIs públicas. Todo se pide en unidades métricas y se convierte en la interfaz.
import { load, save } from './state.js';

const mem = new Map();
// Al pulsar "Actualizar" se ignoran los datos guardados anteriores a este momento
let freshAfter = 0;
export const clearCache = () => { mem.clear(); freshAfter = Date.now(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Copia persistente de las respuestas (Cache API): al reabrir la app no se repiten descargas.
// Los modelos se actualizan cada pocas horas, así que los datos se reutilizan entre 45 min y 12 h según el tipo
// y, si la API falla o se agota la cuota gratuita, se muestran los últimos datos guardados.
const STORE = 'mitiempo-api-v1';
const MAX_STORED = 80;
async function storeGet(url) {
  try {
    const r = await (await caches.open(STORE)).match(url);
    return r ? { t: +r.headers.get('x-time'), d: await r.json() } : null;
  } catch { return null; }
}
async function storePut(url, data, t) {
  try {
    const c = await caches.open(STORE);
    await c.put(url, new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json', 'x-time': String(t) } }));
    const keys = await c.keys();
    for (let i = 0; i < keys.length - MAX_STORED; i++) await c.delete(keys[i]);
  } catch { /* sin Cache API (navegación privada) */ }
}

// ---------- Cuota gratuita de Open-Meteo (600 consultas/min, 5.000/h, 10.000/día por IP) ----------
// Open-Meteo no cuenta peticiones sino consultas: cada punto pedido cuenta una, y más si pide más de 10 variables
// (proporcional) o más de 2 semanas de datos (proporcional). Se lleva la cuenta en el móvil y, si una petición no
// cabe en el último minuto, se espera lo justo en vez de lanzarla y recibir «límite alcanzado».
const LEDGER = 'om:ledger', COOL = 'om:cool';
const BUDGET_MIN = 520, BUDGET_HOUR = 4600;
const isOM = (url) => /(^|\.)open-meteo\.com$/.test(new URL(url).hostname);
export function callWeight(url) {
  const q = new URL(url).searchParams;
  const n = (q.get('latitude') || '').split(',').length;
  const vars = ['hourly', 'daily', 'current', 'minutely_15', 'weekly', 'monthly', 'six_hourly']
    .reduce((s, k) => s + (q.get(k) || '').split(',').filter(Boolean).length, 0);
  const s = q.get('start_date'), e = q.get('end_date');
  const days = s && e ? (Date.parse(e) - Date.parse(s)) / 864e5 + 1 : (+q.get('forecast_days') || 7) + (+q.get('past_days') || 0);
  return n * Math.max(1, vars / 10) * Math.max(1, days / 14);
}
let ledger = load(LEDGER, []);
const spent = (now, ms) => ledger.reduce((sum, [t, w]) => (now - t < ms ? sum + w : sum), 0);
// Aviso a la interfaz (app.js) de que se está esperando a que haya cuota
const waiting = (ms) => globalThis.dispatchEvent?.(new CustomEvent('quota-wait', { detail: ms }));
const rateError = (msg) => Object.assign(new Error(msg), { fatal: true, rate: true });
// Las descargas de fondo (normales de 30 años) dejan siempre hueco para lo que se está mirando.
// Comprobar y apuntar van seguidos, sin esperas entre medias, así que dos peticiones a la vez no se cuelan en el mismo hueco
async function takeQuota(w, background = false) {
  const limit = BUDGET_MIN - (background ? 160 : 0);
  for (;;) {
    const now = Date.now();
    ledger = ledger.filter(([t]) => now - t < 3600e3);
    const cool = load(COOL, 0);
    if (now < cool) {
      if (cool - now > 70e3) throw rateError('Límite de Open-Meteo alcanzado. Prueba más tarde.');
      waiting(cool - now); await sleep(Math.min(cool - now, 3000)); continue;
    }
    if (spent(now, 3600e3) + w > BUDGET_HOUR) throw rateError('Límite de peticiones por hora casi agotado. Prueba más tarde.');
    const m = spent(now, 60e3);
    if (m === 0 || m + w <= limit) break;
    // Hay que esperar a que salgan del último minuto las consultas más antiguas
    let free = m + w - limit, until = now;
    for (const [t, wt] of ledger) { if (now - t >= 60e3) continue; free -= wt; until = t + 60e3; if (free <= 0) break; }
    if (!background) waiting(until - now);
    await sleep(Math.min(until - now + 250, 3000));
  }
  ledger.push([Date.now(), Math.round(w * 10) / 10]);
  save(LEDGER, ledger);
}

// Peticiones en curso: si dos vistas piden lo mismo a la vez, se descarga una sola vez
const inflight = new Map();
export function getJSON(url, opts) {
  if (!inflight.has(url)) inflight.set(url, fetchJSON(url, opts).finally(() => inflight.delete(url)));
  return inflight.get(url);
}
// Open-Meteo a veces tarda varios segundos en contestar una petición que suele tardar 0,1 s:
// si no ha respondido en `ms`, se lanza otra igual y se usa la que llegue antes
function hedgedFetch(url, signal, ms) {
  const ctls = [];
  const go = () => {
    const c = new AbortController();
    signal.addEventListener('abort', () => c.abort(), { once: true });
    ctls.push(c);
    return fetch(url, { signal: c.signal }).then((res) => { ctls.forEach((o) => o !== c && o.abort()); return res; });
  };
  return new Promise((resolve, reject) => {
    let pending = 1;
    const fail = (e) => { if (--pending === 0) reject(e); };
    const timer = setTimeout(() => { pending++; go().then(resolve, fail); }, ms);
    go().then(resolve, fail).finally(() => clearTimeout(timer));
  });
}

async function fetchJSON(url, { ttl = 10 * 60e3, persist = false, hedge = 0, background = false } = {}) {
  const now = Date.now();
  let hit = mem.get(url);
  if (hit && now - hit.t < ttl && hit.t >= freshAfter) return hit.d;
  if (persist) {
    const p = load('cache:' + url, null);
    if (p && now - p.t < ttl) { mem.set(url, p); return p.d; }
  }
  const stored = hit ? null : await storeGet(url);
  if (stored && now - stored.t < ttl && stored.t >= freshAfter) { mem.set(url, stored); return stored.d; }
  hit ||= stored;
  let lastErr;
  const om = isOM(url);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (om) await takeQuota(callWeight(url), background);
      // Si la red se queda colgada (cobertura móvil mala), se corta y se reintenta
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 25000);
      const res = await (hedge ? hedgedFetch(url, ctl.signal, hedge) : fetch(url, { signal: ctl.signal })).finally(() => clearTimeout(timer));
      let data = null;
      try { data = await res.json(); } catch { /* respuesta no JSON */ }
      if (res.status === 429) {
        // Límite gratuito de Open-Meteo pese a la cuenta (otras apps en la misma red, o la cuenta se borró):
        // se para todo un rato. El de minuto se espera y se reintenta solo; el de hora o día no
        const why = data?.reason || '';
        const hour = /hour/i.test(why), day = /dail/i.test(why);
        save(COOL, Date.now() + (day ? 6 * 3600e3 : hour ? 15 * 60e3 : 61e3));
        if (!hour && !day && attempt < 2) continue;
        throw rateError(day ? 'Límite diario de peticiones alcanzado. Vuelve mañana.' : hour ? 'Límite de peticiones por hora alcanzado. Prueba más tarde.'
          : 'Límite de peticiones por minuto alcanzado. Espera un minuto.');
      }
      if (!res.ok || (data && data.error)) {
        const err = new Error((data && data.reason) || `Error HTTP ${res.status}`);
        err.fatal = res.status === 400;
        throw err;
      }
      mem.set(url, { t: now, d: data });
      storePut(url, data, now);
      if (persist) save('cache:' + url, { t: now, d: data });
      return data;
    } catch (e) {
      lastErr = e;
      if (e.fatal) break;
      await sleep(700 * (attempt + 1));
    }
  }
  if (hit) return hit.d; // mejor datos viejos que nada (sin red o sin cuota)
  throw lastErr;
}

function build(base, params) {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    u.searchParams.set(k, Array.isArray(v) ? v.join(',') : v);
  }
  return u.toString();
}

const coord = (p) => ({ latitude: p.lat.toFixed(4), longitude: p.lon.toFixed(4) });

// ---------- Modelos ----------
export const MODELS = [
  { id: 'best_match', name: 'Automático (mejor modelo)', short: 'Auto', days: 16 },
  { id: 'ecmwf_ifs', name: 'ECMWF IFS HRES 9 km', short: 'ECMWF', days: 15 },
  { id: 'ecmwf_aifs025_single', name: 'ECMWF AIFS (IA)', short: 'AIFS', days: 15 },
  { id: 'gfs_seamless', name: 'NOAA GFS', short: 'GFS', days: 16 },
  { id: 'icon_seamless', name: 'DWD ICON', short: 'ICON', days: 7.5 },
  { id: 'meteofrance_seamless', name: 'Météo-France AROME/ARPEGE', short: 'AROME', days: 4 },
  { id: 'ukmo_seamless', name: 'UK Met Office', short: 'UKMO', days: 7 },
  { id: 'gem_seamless', name: 'GEM Canadá', short: 'GEM', days: 10 },
  { id: 'jma_seamless', name: 'JMA Japón', short: 'JMA', days: 11 },
  { id: 'knmi_seamless', name: 'KNMI HARMONIE', short: 'KNMI', days: 2.5 },
  { id: 'dmi_seamless', name: 'DMI HARMONIE', short: 'DMI', days: 2.5 },
  { id: 'metno_seamless', name: 'MET Norway', short: 'MET No', days: 2.5 },
  { id: 'italia_meteo_arpae_icon_2i', name: 'ItaliaMeteo ICON-2I', short: 'ICON-2I', days: 3 },
  { id: 'cma_grapes_global', name: 'CMA GRAPES China', short: 'CMA', days: 10 },
  { id: 'bom_access_global', name: 'BOM ACCESS Australia', short: 'BOM', days: 10 },
];
export const modelName = (id) => (MODELS.find((m) => m.id === id) || { name: id }).name;

export const ENSEMBLES = [
  { id: 'ecmwf_ifs025', name: 'ECMWF ENS', members: 51, days: 15, desc: '15 días · 51 escenarios' },
  { id: 'gfs05', name: 'GFS ENS extendido', members: 31, days: 35, desc: '35 días · 31 escenarios' },
  { id: 'gfs025', name: 'GFS ENS', members: 31, days: 16, desc: '16 días · 31 escenarios' },
  { id: 'icon_seamless', name: 'ICON EPS', members: 40, days: 7, desc: '7 días · 40 escenarios' },
  { id: 'ecmwf_aifs025', name: 'ECMWF AIFS ENS (IA)', members: 51, days: 15, desc: '15 días · 51 escenarios' },
];

// ---------- Pronóstico principal ----------
export const HOURLY_VARS = [
  'temperature_2m', 'apparent_temperature', 'relative_humidity_2m', 'dew_point_2m',
  'precipitation_probability', 'precipitation', 'rain', 'showers', 'snowfall', 'snow_depth',
  'weather_code', 'cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high',
  'pressure_msl', 'visibility', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m',
  'uv_index', 'is_day', 'cape', 'freezing_level_height', 'sunshine_duration',
];
export const DAILY_VARS = [
  'weather_code', 'temperature_2m_max', 'temperature_2m_min', 'apparent_temperature_max', 'apparent_temperature_min',
  'sunrise', 'sunset', 'daylight_duration', 'sunshine_duration', 'uv_index_max',
  'precipitation_sum', 'rain_sum', 'snowfall_sum', 'precipitation_hours', 'precipitation_probability_max',
  'wind_speed_10m_max', 'wind_gusts_10m_max', 'wind_direction_10m_dominant',
];
export const CURRENT_VARS = [
  'temperature_2m', 'apparent_temperature', 'relative_humidity_2m', 'is_day', 'precipitation',
  'weather_code', 'cloud_cover', 'pressure_msl', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m',
];

export async function forecast(p, model = 'best_match') {
  const url = build('https://api.open-meteo.com/v1/forecast', {
    ...coord(p),
    timezone: 'auto',
    forecast_days: 16,
    past_days: 1,
    hourly: HOURLY_VARS,
    daily: DAILY_VARS,
    current: CURRENT_VARS,
    minutely_15: model === 'best_match' ? 'precipitation' : undefined,
    forecast_minutely_15: model === 'best_match' ? 12 : undefined,
    past_minutely_15: model === 'best_match' ? 1 : undefined,
    models: model === 'best_match' ? undefined : model,
  });
  const d = await getJSON(url, { ttl: 45 * 60e3, hedge: 1500 });
  return trimNulls(d);
}

// Quita las horas/días finales en que el modelo ya no tiene datos
function trimNulls(d) {
  const cut = (block, key) => {
    if (!block || !block[key]) return;
    const arr = block[key];
    let n = arr.length;
    while (n > 0 && (arr[n - 1] === null || arr[n - 1] === undefined)) n--;
    if (n === arr.length) return;
    for (const k of Object.keys(block)) block[k] = block[k].slice(0, n);
  };
  cut(d.hourly, 'temperature_2m');
  cut(d.daily, 'temperature_2m_max');
  return d;
}

export async function compareModels(p, models, vars) {
  const url = build('https://api.open-meteo.com/v1/forecast', {
    ...coord(p), timezone: 'auto', forecast_days: 16, hourly: vars, models,
  });
  return getJSON(url, { ttl: 2 * 3600e3 });
}

// ---------- Ensembles (hasta 35 días) ----------
export async function ensemble(p, model, days, hourly, daily) {
  const url = build('https://ensemble-api.open-meteo.com/v1/ensemble', {
    ...coord(p), timezone: 'auto', models: model, forecast_days: days, hourly, daily,
  });
  return getJSON(url, { ttl: 3 * 3600e3 });
}

// ---------- Estacional ECMWF (EC46 + SEAS5, hasta 6 meses) ----------
export async function seasonal(p, block, vars) {
  const url = build('https://seasonal-api.open-meteo.com/v1/seasonal', {
    ...coord(p), timezone: 'auto', [block]: vars,
  });
  return getJSON(url, { ttl: 12 * 3600e3 });
}

// ---------- Mar ----------
export async function marine(p) {
  const url = build('https://marine-api.open-meteo.com/v1/marine', {
    ...coord(p), timezone: 'auto', forecast_days: 10, cell_selection: 'sea',
    hourly: [
      'wave_height', 'wave_direction', 'wave_period', 'wave_peak_period',
      'wind_wave_height', 'wind_wave_direction', 'wind_wave_period',
      'swell_wave_height', 'swell_wave_direction', 'swell_wave_period',
      'secondary_swell_wave_height', 'secondary_swell_wave_period',
      'sea_surface_temperature', 'sea_level_height_msl', 'ocean_current_velocity', 'ocean_current_direction',
    ],
    daily: ['wave_height_max', 'wave_direction_dominant', 'wave_period_max', 'swell_wave_height_max'],
  });
  return getJSON(url, { ttl: 60 * 60e3 });
}

// ---------- Calidad del aire y polen ----------
export async function airQuality(p) {
  const vars = ['european_aqi', 'us_aqi', 'pm10', 'pm2_5', 'carbon_monoxide', 'nitrogen_dioxide', 'sulphur_dioxide', 'ozone', 'dust', 'uv_index', 'aerosol_optical_depth'];
  const pollen = ['alder_pollen', 'birch_pollen', 'grass_pollen', 'mugwort_pollen', 'olive_pollen', 'ragweed_pollen'];
  const url = build('https://air-quality-api.open-meteo.com/v1/air-quality', {
    ...coord(p), timezone: 'auto', forecast_days: 5, current: vars, hourly: [...vars, ...pollen],
  });
  return getJSON(url, { ttl: 60 * 60e3 });
}

// ---------- Lluvia de los últimos 3 meses, hora a hora (para la vista de embalses y lluvia) ----------
export async function rainPast(p) {
  const url = build('https://api.open-meteo.com/v1/forecast', {
    ...coord(p), timezone: 'auto', past_days: 92, forecast_days: 1, hourly: 'precipitation', current: 'precipitation',
  });
  return getJSON(url, { ttl: 30 * 60e3 });
}

// ---------- Balance de agua del suelo: lluvia y evapotranspiración de 30 días atrás a 7 adelante ----------
export async function soilWater(p) {
  const url = build('https://api.open-meteo.com/v1/forecast', {
    ...coord(p), timezone: 'auto', past_days: 30, forecast_days: 8,
    daily: ['precipitation_sum', 'et0_fao_evapotranspiration'], hourly: 'soil_moisture_3_to_9cm',
  });
  return getJSON(url, { ttl: 60 * 60e3 });
}

// ---------- Atardeceres: el lugar y dos puntos hacia el oeste (js/alertcheck.js) ----------
export async function sunsetClouds(p) {
  return getJSON(globalThis.MTAlerts.sunsetURL(+p.lat.toFixed(3), +p.lon.toFixed(3)), { ttl: 60 * 60e3 });
}

// ---------- Histórico (ERA5 desde 1940) ----------
export async function archive(p, start, end, daily, opts = {}) {
  const url = build('https://archive-api.open-meteo.com/v1/archive', {
    ...coord(p), timezone: 'auto', start_date: start, end_date: end, daily,
  });
  return getJSON(url, { ttl: 24 * 3600e3, ...opts });
}

// ---------- Rejilla para el mapa (muchos puntos en una petición) ----------
// Las horas llegan como números (respuesta más ligera) y se pasan a texto ISO una sola vez
const isoCache = new Map();
function gridPoints(d) {
  const arr = Array.isArray(d) ? d : [d];
  for (const p of arr) {
    const h = p.hourly;
    if (h && typeof h.time?.[0] === 'number') {
      h.time = h.time.map((t) => {
        let s = isoCache.get(t);
        if (!s) { s = new Date(t * 1000).toISOString().slice(0, 16); isoCache.set(t, s); }
        return s;
      });
    }
  }
  return arr;
}
export async function grid(lats, lons, vars, days, model) {
  const url = build('https://api.open-meteo.com/v1/forecast', {
    latitude: lats.map((v) => v.toFixed(2)),
    longitude: lons.map((v) => v.toFixed(2)),
    hourly: vars, forecast_days: days, timezone: 'GMT', timeformat: 'unixtime', cell_selection: 'nearest',
    models: model === 'best_match' ? undefined : model,
  });
  return gridPoints(await getJSON(url, { ttl: 90 * 60e3 }));
}

export async function marineGrid(lats, lons, vars, days) {
  const url = build('https://marine-api.open-meteo.com/v1/marine', {
    latitude: lats.map((v) => v.toFixed(2)),
    longitude: lons.map((v) => v.toFixed(2)),
    hourly: vars, forecast_days: days, timezone: 'GMT', timeformat: 'unixtime', cell_selection: 'sea', // la costa se recorta en el mapa
  });
  return gridPoints(await getJSON(url, { ttl: 90 * 60e3 }));
}

export async function airGrid(lats, lons, vars, days) {
  const url = build('https://air-quality-api.open-meteo.com/v1/air-quality', {
    latitude: lats.map((v) => v.toFixed(2)),
    longitude: lons.map((v) => v.toFixed(2)),
    hourly: vars, forecast_days: Math.min(days, 5), timezone: 'GMT', timeformat: 'unixtime', cell_selection: 'nearest',
  });
  return gridPoints(await getJSON(url, { ttl: 90 * 60e3 }));
}

// ---------- Búsqueda de lugares ----------
export async function geocode(q) {
  const url = build('https://geocoding-api.open-meteo.com/v1/search', { name: q, count: 12, language: 'es', format: 'json' });
  const d = await getJSON(url, { ttl: 24 * 3600e3 });
  return (d.results || []).map((r) => ({
    name: r.name,
    admin: [r.admin2 && r.admin2 !== r.name ? r.admin2 : null, r.admin1].filter(Boolean).join(', '),
    country: r.country || '',
    cc: r.country_code || '',
    lat: r.latitude, lon: r.longitude, elevation: r.elevation,
  }));
}

export async function reverseGeocode(lat, lon) {
  try {
    const url = build('https://api.bigdatacloud.net/data/reverse-geocode-client', { latitude: lat, longitude: lon, localityLanguage: 'es' });
    const d = await getJSON(url, { ttl: 24 * 3600e3 });
    // En el mar BigDataCloud devuelve nombres como "Zona económica exclusiva de…"
    const sea = /zona econ|exclusive economic|oc[ée]ano|ocean|^mar |sea$/i;
    const locality = d.locality && !sea.test(d.locality) ? d.locality : '';
    const atSea = !d.city && !locality;
    return {
      name: d.city || locality || (atSea ? `Mar · ${lat.toFixed(2)}, ${lon.toFixed(2)}` : d.principalSubdivision) || `${lat.toFixed(2)}, ${lon.toFixed(2)}`,
      admin: d.principalSubdivision || '',
      country: d.countryName || '',
      cc: d.countryCode || '',
      lat, lon,
    };
  } catch {
    return { name: `${lat.toFixed(3)}, ${lon.toFixed(3)}`, admin: '', country: '', cc: '', lat, lon };
  }
}

// ---------- Radar (RainViewer) ----------
export async function radarFrames() {
  return getJSON('https://api.rainviewer.com/public/weather-maps.json', { ttl: 5 * 60e3 });
}
