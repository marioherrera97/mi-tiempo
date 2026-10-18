// Acceso a las APIs públicas. Todo se pide en unidades métricas y se convierte en la interfaz.
import { load, save } from './state.js';

const mem = new Map();
export const clearCache = () => mem.clear();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function getJSON(url, { ttl = 10 * 60e3, persist = false } = {}) {
  const now = Date.now();
  const hit = mem.get(url);
  if (hit && now - hit.t < ttl) return hit.d;
  if (persist) {
    const p = load('cache:' + url, null);
    if (p && now - p.t < ttl) { mem.set(url, p); return p.d; }
  }
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url);
      let data = null;
      try { data = await res.json(); } catch { /* respuesta no JSON */ }
      if (res.status === 429) {
        // Límite gratuito de Open-Meteo (600/min, 5.000/h, 10.000/día): no insistir
        const err = new Error(/minut/i.test(data?.reason || '') ? 'Límite de peticiones por minuto alcanzado. Espera un minuto.'
          : /hour/i.test(data?.reason || '') ? 'Límite de peticiones por hora alcanzado. Prueba más tarde.'
            : /dail/i.test(data?.reason || '') ? 'Límite diario de peticiones alcanzado. Vuelve mañana.' : 'Demasiadas peticiones. Espera un momento.');
        err.fatal = true;
        err.rate = true;
        throw err;
      }
      if (!res.ok || (data && data.error)) {
        const err = new Error((data && data.reason) || `Error HTTP ${res.status}`);
        err.fatal = res.status === 400;
        throw err;
      }
      mem.set(url, { t: now, d: data });
      if (persist) save('cache:' + url, { t: now, d: data });
      return data;
    } catch (e) {
      lastErr = e;
      if (e.fatal) break;
      await sleep(700 * (attempt + 1));
    }
  }
  if (hit) return hit.d; // mejor datos viejos que nada
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
  const d = await getJSON(url);
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
  return getJSON(url);
}

// ---------- Ensembles (hasta 35 días) ----------
export async function ensemble(p, model, days, hourly, daily) {
  const url = build('https://ensemble-api.open-meteo.com/v1/ensemble', {
    ...coord(p), timezone: 'auto', models: model, forecast_days: days, hourly, daily,
  });
  return getJSON(url, { ttl: 30 * 60e3 });
}

// ---------- Estacional ECMWF (EC46 + SEAS5, hasta 6 meses) ----------
export async function seasonal(p, block, vars) {
  const url = build('https://seasonal-api.open-meteo.com/v1/seasonal', {
    ...coord(p), timezone: 'auto', [block]: vars,
  });
  return getJSON(url, { ttl: 3 * 3600e3 });
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
  return getJSON(url);
}

// ---------- Calidad del aire y polen ----------
export async function airQuality(p) {
  const vars = ['european_aqi', 'us_aqi', 'pm10', 'pm2_5', 'carbon_monoxide', 'nitrogen_dioxide', 'sulphur_dioxide', 'ozone', 'dust', 'uv_index', 'aerosol_optical_depth'];
  const pollen = ['alder_pollen', 'birch_pollen', 'grass_pollen', 'mugwort_pollen', 'olive_pollen', 'ragweed_pollen'];
  const url = build('https://air-quality-api.open-meteo.com/v1/air-quality', {
    ...coord(p), timezone: 'auto', forecast_days: 5, current: vars, hourly: [...vars, ...pollen],
  });
  return getJSON(url);
}

// ---------- Histórico (ERA5 desde 1940) ----------
export async function archive(p, start, end, daily, opts = {}) {
  const url = build('https://archive-api.open-meteo.com/v1/archive', {
    ...coord(p), timezone: 'auto', start_date: start, end_date: end, daily,
  });
  return getJSON(url, { ttl: 24 * 3600e3, ...opts });
}

// ---------- Rejilla para el mapa (muchos puntos en una petición) ----------
export async function grid(lats, lons, vars, days, model) {
  const url = build('https://api.open-meteo.com/v1/forecast', {
    latitude: lats.map((v) => v.toFixed(2)),
    longitude: lons.map((v) => v.toFixed(2)),
    hourly: vars, forecast_days: days, timezone: 'GMT', cell_selection: 'nearest',
    models: model === 'best_match' ? undefined : model,
  });
  const d = await getJSON(url, { ttl: 30 * 60e3 });
  return Array.isArray(d) ? d : [d];
}

export async function marineGrid(lats, lons, vars, days) {
  const url = build('https://marine-api.open-meteo.com/v1/marine', {
    latitude: lats.map((v) => v.toFixed(2)),
    longitude: lons.map((v) => v.toFixed(2)),
    hourly: vars, forecast_days: days, timezone: 'GMT', cell_selection: 'sea', // la costa se recorta en el mapa
  });
  const d = await getJSON(url, { ttl: 30 * 60e3 });
  return Array.isArray(d) ? d : [d];
}

export async function airGrid(lats, lons, vars, days) {
  const url = build('https://air-quality-api.open-meteo.com/v1/air-quality', {
    latitude: lats.map((v) => v.toFixed(2)),
    longitude: lons.map((v) => v.toFixed(2)),
    hourly: vars, forecast_days: Math.min(days, 5), timezone: 'GMT', cell_selection: 'nearest',
  });
  const d = await getJSON(url, { ttl: 30 * 60e3 });
  return Array.isArray(d) ? d : [d];
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
