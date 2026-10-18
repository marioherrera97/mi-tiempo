// Vista "Mapa" (pantalla principal, al estilo Windy): capas de modelo con partículas animadas,
// altitudes, isobaras, valores sobre el mapa, radar, satélite y pronóstico del punto seleccionado.
/* global L */
import { state, settings, saveSettings, setPlace, load, save, on, isFavorite, toggleFavorite } from '../state.js';
import * as api from '../api.js';
import * as f from '../format.js';
import { gradientCSS, colorAt } from '../colors.js';
import { FieldLayer, emptyGrid, mergePoints, addFlow, addAccum, fillGaps } from '../windlayer.js';
import { toast, debounce } from '../ui.js';
import { openDetail, closeDetail, detailOpen } from './mapdetail.js';
import { getForecast } from '../data.js';
import { wxIcon } from '../icons.js';
import * as own from '../owndata.js';
import { makeThumbs, thumbUrl } from '../thumbs.js';

// ---------- Altitudes ----------
const LEVELS = {
  surface: { label: 'Superficie', ws: 'wind_speed_10m', wd: 'wind_direction_10m', t: 'temperature_2m', rh: 'relative_humidity_2m', group: 'surface' },
  '100m': { label: '100 m', ws: 'wind_speed_100m', wd: 'wind_direction_100m', t: 'temperature_80m', rh: null, group: 'l100m' },
  '850hPa': { label: '1.500 m', ws: 'wind_speed_850hPa', wd: 'wind_direction_850hPa', t: 'temperature_850hPa', rh: 'relative_humidity_850hPa', group: 'l850hPa' },
  '700hPa': { label: '3.000 m', ws: 'wind_speed_700hPa', wd: 'wind_direction_700hPa', t: 'temperature_700hPa', rh: 'relative_humidity_700hPa', group: 'l700hPa' },
  '500hPa': { label: '5.500 m', ws: 'wind_speed_500hPa', wd: 'wind_direction_500hPa', t: 'temperature_500hPa', rh: 'relative_humidity_500hPa', group: 'l500hPa' },
  '300hPa': { label: '9.000 m', ws: 'wind_speed_300hPa', wd: 'wind_direction_300hPa', t: 'temperature_300hPa', rh: 'relative_humidity_300hPa', group: 'l300hPa' },
};
const lvVars = (p) => [`wind_speed_${p}`, `wind_direction_${p}`, `temperature_${p}`, `relative_humidity_${p}`, `geopotential_height_${p}`];

// ---------- Grupos de datos (cada uno es una petición; se descargan solo cuando hacen falta) ----------
const GROUPS = {
  surface: { api: 'forecast', vars: ['temperature_2m', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'precipitation', 'cloud_cover', 'pressure_msl', 'relative_humidity_2m'] },
  extra: { api: 'forecast', vars: ['cape', 'dew_point_2m', 'snowfall', 'snow_depth', 'freezing_level_height', 'visibility', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high'] },
  l100m: { api: 'forecast', vars: ['wind_speed_100m', 'wind_direction_100m', 'temperature_80m'] },
  l850hPa: { api: 'forecast', vars: lvVars('850hPa') },
  l700hPa: { api: 'forecast', vars: lvVars('700hPa') },
  l500hPa: { api: 'forecast', vars: lvVars('500hPa') },
  l300hPa: { api: 'forecast', vars: lvVars('300hPa') },
  marine: { api: 'marine', vars: ['wave_height', 'wave_direction', 'wave_period', 'swell_wave_height', 'swell_wave_direction', 'swell_wave_period', 'sea_surface_temperature', 'ocean_current_velocity', 'ocean_current_direction', 'wind_wave_height'] },
  comfort: { api: 'forecast', vars: ['apparent_temperature', 'uv_index'] },
  air: { api: 'air', vars: ['european_aqi', 'pm2_5', 'pm10', 'dust', 'nitrogen_dioxide', 'ozone'] },
};

// ---------- Unidades de cada capa ----------
const cycle = (key, list) => { settings[key] = list[(list.indexOf(settings[key]) + 1) % list.length]; saveSettings(); };
const UNITS = {
  wind: { label: f.windUnit, fmt: (v) => f.wind(v), next: () => cycle('wind', ['kmh', 'ms', 'kn', 'mph', 'bft']) },
  temp: { label: f.tempUnit, fmt: (v) => f.temp(v), next: () => cycle('temp', ['c', 'f']) },
  rate: { label: () => f.precipUnit() + '/h', fmt: (v) => (v < 0.1 ? '' : f.precip(v)), next: () => cycle('precip', ['mm', 'in']) },
  precip: { label: f.precipUnit, fmt: (v) => (v < 0.5 ? '' : f.precip(v)), next: () => cycle('precip', ['mm', 'in']) },
  snow: { label: () => (settings.precip === 'in' ? 'in' : 'cm'), fmt: (v) => (v < 0.5 ? '' : f.snow(v, false)), next: () => cycle('precip', ['mm', 'in']) },
  hpa: { label: f.pressureUnit, fmt: (v) => f.pressure(v), next: () => cycle('pressure', ['hpa', 'mmhg', 'inhg']) },
  pct: { label: () => '%', fmt: (v) => String(Math.round(v)) },
  jkg: { label: () => 'J/kg', fmt: (v) => (v < 50 ? '' : String(Math.round(v))) },
  height: { label: () => (settings.distance === 'mi' ? 'ft' : 'm'), fmt: (v) => String(Math.round(settings.distance === 'mi' ? v * 3.28084 : v)), next: () => cycle('distance', ['km', 'mi']) },
  vis: { label: () => (settings.distance === 'mi' ? 'mi' : 'km'), fmt: (v) => (settings.distance === 'mi' ? (v / 1609).toFixed(1) : (v / 1000).toFixed(v < 10000 ? 1 : 0)), next: () => cycle('distance', ['km', 'mi']) },
  wave: { label: () => (settings.distance === 'mi' ? 'ft' : 'm'), fmt: (v) => (settings.distance === 'mi' ? (v * 3.28084).toFixed(0) : v.toFixed(1)), next: () => cycle('distance', ['km', 'mi']) },
  uvi: { label: () => 'UV', fmt: (v) => (v < 0.5 ? '' : String(Math.round(v))) },
  sec: { label: () => 's', fmt: (v) => String(Math.round(v)) },
  aqi: { label: () => 'EAQI', fmt: (v) => String(Math.round(v)) },
  ugm3: { label: () => 'µg/m³', fmt: (v) => (v < 1 ? '' : String(Math.round(v))) },
};

// ---------- Catálogo de capas ----------
// var/group pueden depender de la altitud (lv). flow: qué mueven las partículas.
const LAYERS = {
  wind: { label: 'Viento', cat: 'Viento', levels: true, src: (lv) => [LEVELS[lv].group, LEVELS[lv].ws], scale: 'wind', range: (lv) => [0, lv === '300hPa' || lv === '500hPa' ? 250 : lv === 'surface' ? 110 : 160], unit: 'wind' },
  gust: { label: 'Rachas', cat: 'Viento', src: () => ['surface', 'wind_gusts_10m'], scale: 'wind', range: () => [0, 130], unit: 'wind' },
  rain: { label: 'Lluvia y tormentas', short: 'Lluvia', cat: 'Lluvia y nieve', src: () => ['surface', 'precipitation'], scale: 'precip', range: () => [0, 20], unit: 'rate' },
  rainacc: { label: 'Lluvia acumulada', cat: 'Lluvia y nieve', src: () => ['surface', 'acc_precip'], scale: 'rainacc', range: () => [0, 400], unit: 'precip' },
  snowacc: { label: 'Nieve nueva', cat: 'Lluvia y nieve', src: () => ['extra', 'acc_snow'], scale: 'snow', range: () => [0, 150], unit: 'snow' },
  snowdepth: { label: 'Espesor de nieve', cat: 'Lluvia y nieve', src: () => ['extra', 'snow_depth_cm'], scale: 'snow', range: () => [0, 150], unit: 'snow' },
  cape: { label: 'Tormentas (CAPE)', cat: 'Lluvia y nieve', src: () => ['extra', 'cape'], scale: 'cape', range: () => [0, 3500], unit: 'jkg' },
  temp: { label: 'Temperatura', short: 'Temp.', cat: 'Temperatura', levels: true, src: (lv) => [LEVELS[lv].group, LEVELS[lv].t], scale: 'temp', range: (lv) => (lv === '300hPa' ? [-70, 0] : lv === '500hPa' ? [-50, 10] : [-30, 45]), unit: 'temp' },
  feels: { label: 'Sensación térmica', cat: 'Temperatura', src: () => ['comfort', 'apparent_temperature'], scale: 'temp', range: () => [-30, 45], unit: 'temp' },
  uv: { label: 'Índice UV', cat: 'Temperatura', src: () => ['comfort', 'uv_index'], scale: 'uv', range: () => [0, 11], unit: 'uvi' },
  dew: { label: 'Punto de rocío', cat: 'Temperatura', src: () => ['extra', 'dew_point_2m'], scale: 'temp', range: () => [-30, 35], unit: 'temp' },
  freezing: { label: 'Isocero (0 °C)', cat: 'Temperatura', src: () => ['extra', 'freezing_level_height'], scale: 'freezing', range: () => [0, 5000], unit: 'height' },
  humidity: { label: 'Humedad', cat: 'Temperatura', levels: true, src: (lv) => (LEVELS[lv].rh ? [LEVELS[lv].group, LEVELS[lv].rh] : ['surface', 'relative_humidity_2m']), scale: 'humidity', range: () => [0, 100], unit: 'pct' },
  clouds: { label: 'Nubes', cat: 'Nubes', src: () => ['surface', 'cloud_cover'], scale: 'clouds', range: () => [0, 100], unit: 'pct' },
  lowclouds: { label: 'Nubes bajas', cat: 'Nubes', src: () => ['extra', 'cloud_cover_low'], scale: 'clouds', range: () => [0, 100], unit: 'pct' },
  midclouds: { label: 'Nubes medias', cat: 'Nubes', src: () => ['extra', 'cloud_cover_mid'], scale: 'clouds', range: () => [0, 100], unit: 'pct' },
  highclouds: { label: 'Nubes altas', cat: 'Nubes', src: () => ['extra', 'cloud_cover_high'], scale: 'clouds', range: () => [0, 100], unit: 'pct' },
  visibility: { label: 'Visibilidad / niebla', cat: 'Nubes', src: () => ['extra', 'visibility'], scale: 'visibility', range: () => [0, 20000], unit: 'vis' },
  pressure: { label: 'Presión', cat: 'Presión', src: () => ['surface', 'pressure_msl'], scale: 'pressure', range: () => [960, 1045], unit: 'hpa', iso: true },
  waves: { label: 'Olas', cat: 'Mar', src: () => ['marine', 'wave_height'], scale: 'waves', range: () => [0, 9], unit: 'wave', flow: 'waves' },
  swell: { label: 'Mar de fondo', cat: 'Mar', src: () => ['marine', 'swell_wave_height'], scale: 'waves', range: () => [0, 9], unit: 'wave', flow: 'swell' },
  windwaves: { label: 'Mar de viento', cat: 'Mar', src: () => ['marine', 'wind_wave_height'], scale: 'waves', range: () => [0, 9], unit: 'wave', flow: 'waves' },
  waveperiod: { label: 'Periodo de olas', cat: 'Mar', src: () => ['marine', 'wave_period'], scale: 'period', range: () => [0, 20], unit: 'sec', flow: 'waves' },
  sst: { label: 'Temperatura del mar', cat: 'Mar', src: () => ['marine', 'sea_surface_temperature'], scale: 'sst', range: () => [-2, 33], unit: 'temp' },
  currents: { label: 'Corrientes', cat: 'Mar', src: () => ['marine', 'ocean_current_velocity'], scale: 'currents', range: () => [0, 8], unit: 'wind', flow: 'currents' },
  aqi: { label: 'Calidad del aire', cat: 'Aire', src: () => ['air', 'european_aqi'], scale: 'aqi', range: () => [0, 100], unit: 'aqi' },
  pm25: { label: 'PM2.5', cat: 'Aire', src: () => ['air', 'pm2_5'], scale: 'pm25', range: () => [0, 150], unit: 'ugm3' },
  dust: { label: 'Calima (polvo)', cat: 'Aire', src: () => ['air', 'dust'], scale: 'dust', range: () => [0, 1000], unit: 'ugm3' },
  radar: { label: 'Radar de lluvia', short: 'Radar', cat: 'Observación', kind: 'radar' },
  radarsat: { label: 'Radar + satélite', cat: 'Observación', kind: 'radar', sat: true },
  sat: { label: 'Satélite', cat: 'Observación', kind: 'sat' },
};

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
const BASES = {
  dark: [ESRI + 'Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', 'Esri, HERE, OpenStreetMap', ESRI + 'Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', 16],
  light: [ESRI + 'Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', 'Esri, HERE, OpenStreetMap', ESRI + 'Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}', 16],
  osm: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png', '&copy; OpenStreetMap', null, 19],
  topo: ['https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', '&copy; OpenStreetMap, SRTM &copy; OpenTopoMap', null, 17],
  imagery: [ESRI + 'World_Imagery/MapServer/tile/{z}/{y}/{x}', 'Esri, Maxar, Earthstar', ESRI + 'Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', 18],
};
const SATS = {
  ir: { label: 'Infrarrojo Meteosat (Europa/África, 15 min)', wms: 'msg_fes:ir108' },
  vis: { label: 'Color natural Meteosat (de día)', wms: 'msg_fes:rgb_naturalenhncd' },
  modis: { label: 'Color real NASA MODIS (global, diario)', gibs: true },
};
const ISO_MODES = [['off', 'Sin isolíneas'], ['pressure', 'Isobaras'], ['temp', 'Isotermas']];

const S = {
  map: null, field: null, base: null, labels: null, marker: null,
  layer: load('map.layer', 'wind'), level: 'surface', borders: load('map.borders', true), cities: load('map.cities', true), particles: true, relief: load('map.relief', true), water: load('map.water', true), iso: load('map.iso', 'off'), values: load('map.values', false), sat: 'ir',
  grid: null, spec: null, loading: 0, token: 0,
  t: 0, t0: 0, playing: null, pick: null,
  radar: { frames: [], layers: [], idx: 0 },
  satFrames: [], satIdx: 0, days: 3,
};
if (!LAYERS[S.layer]) S.layer = 'wind';

const ICON = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>',
};
const el = (id) => document.getElementById(id);
const clampInt = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------- Rejilla ----------
function gridDims(size) {
  const total = { low: 70, normal: 120, high: 250 }[settings.mapGrid] || 120;
  const nx = Math.max(6, Math.round(Math.sqrt((total * size.x) / size.y)));
  const ny = Math.max(6, Math.round(total / nx));
  return { nx, ny };
}

function neededGroups() {
  const spec = LAYERS[S.layer];
  const g = new Set(['surface']);
  if (!spec.kind) g.add(spec.src(S.level)[0]);
  if (spec.levels) g.add(LEVELS[S.level].group);
  return [...g];
}

async function fetchGroup(name, spec) {
  const G = GROUPS[name];
  const args = [spec.lats, spec.lons, G.vars, S.days];
  if (G.api === 'marine') return api.marineGrid(...args);
  if (G.api === 'air') return api.airGrid(...args);
  return api.grid(...args, settings.model);
}

// ---------- Datos propios del ECMWF (sin cuota, generados por GitHub cada 6 h) ----------
const OWN_MODELS = ['best_match', 'ecmwf_ifs', 'ecmwf_ifs025'];
const timeMs = (g, t) => Date.parse(g.times[t] + ':00Z');
// Índice de la hora más cercana a un instante (para no perder la hora al cambiar de fuente)
function nearestIndex(g, ms) {
  let best = 0;
  for (let i = 0; i < g.nt; i++) if (Math.abs(timeMs(g, i) - ms) < Math.abs(timeMs(g, best) - ms)) best = i;
  return best;
}
function currentMs() { return S.grid ? timeMs(S.grid, Math.min(S.t, S.grid.nt - 1)) : null; }

async function ownUsable() {
  if (!OWN_MODELS.includes(settings.model)) return null;
  const imgs = own.imagesFor(S.layer, S.level);
  if (!imgs) return null;
  const meta = await own.loadMeta();
  if (!meta) return null;
  // Europa con detalle si la vista cabe en ella; si no, la rejilla mundial
  const g = meta.grid, b = S.map.getBounds();
  const north = g.south + (g.ny - 1) * g.res, east = g.west + (g.nx - 1) * g.res;
  const inEu = b.getSouth() >= g.south - 1 && b.getNorth() <= north + 1 && b.getWest() >= g.west - 1 && b.getEast() <= east + 1;
  if (inEu || !meta.regions?.world) {
    const c = S.map.getCenter();
    if (c.lat < g.south || c.lat > north || c.lng < g.west || c.lng > east) return null;
    return { meta, imgs, region: 'eu' };
  }
  return { meta, imgs, region: 'world' };
}

async function loadOwn({ meta, imgs, region }) {
  const gen = `${meta.runId}|${region}|${imgs.join('')}`;
  if (!S.grid?.own || S.grid.run !== meta.runId || S.grid.region !== region) {
    const prev = currentMs();
    S.grid = own.createGrid(meta, region);
    S.spec = null;
    const now = Date.now();
    S.t0 = 0;
    for (let i = 0; i < S.grid.nt; i++) if (timeMs(S.grid, i) <= now) S.t0 = i;
    S.t = prev ? Math.max(S.t0, nearestIndex(S.grid, prev)) : S.t0;
    S.tf = 0;
    S.ownGen = null;
  }
  if (S.ownGen === gen) { if (S.layer === 'rainacc') own.updateAccum(S.grid, S.t0); prepareLayer(); return; }
  S.ownGen = gen;
  const grid = S.grid;
  S.loading++;
  setStatus('Descargando ECMWF…');
  try {
    // Primero la hora que se está viendo (y la siguiente, para la animación)
    await Promise.all(imgs.flatMap((img) => [S.t, Math.min(S.t + 1, grid.nt - 1)].map((t) => own.loadStep(grid, t, img))));
    if (S.grid !== grid) return;
    if (S.layer === 'rainacc') own.updateAccum(grid, S.t0);
    S.field.t = S.t;
    S.field.setGrid(grid);
    prepareLayer();
    buildDays();
    placeBubble();
    const run = new Date(meta.run);
    setStatus(`ECMWF (${String(grid.res).replace('.', ',')}°) · datos propios · pasada ${run.getUTCDate()}/${run.getUTCMonth() + 1} ${String(run.getUTCHours()).padStart(2, '0')}z UTC`, 'ok');
  } catch (e) {
    S.ownGen = null;
    setStatus('No se pudieron leer los datos propios: ' + e.message, 'error');
    return;
  } finally {
    S.loading--;
  }
  // El resto de horas, en segundo plano
  own.prefetch(grid, imgs, S.t, 24, () => S.grid === grid && S.ownGen === gen, (t, img) => {
    if (img === 'b' && S.layer === 'rainacc') own.updateAccum(grid, S.t0);
    if (t === S.t || t === S.t + 1) S.field.setTime(S.t, S.tf || 0);
  });
}

// Al saltar a una hora que aún no se ha descargado, se pide con prioridad
function ensureOwnStep(t) {
  const g = S.grid;
  if (!g?.own) return;
  const imgs = own.imagesFor(S.layer, S.level) || ['a', 'b'];
  for (const tt of [t, Math.min(t + 1, g.nt - 1)]) {
    if (own.stepLoaded(g, imgs, tt)) continue;
    Promise.all(imgs.map((img) => own.loadStep(g, tt, img))).then(() => {
      if (S.grid === g && (S.t === tt || S.t + 1 === tt)) S.field.setTime(S.t, S.tf || 0);
    }).catch(() => {});
  }
}

// Descarga la rejilla de la vista actual (si hace falta) y los grupos de datos que pide la capa
async function loadData(force = false) {
  const o = await ownUsable();
  if (o) { await loadOwn(o); return; }
  // Fuera de Europa, otra capa u otro modelo: rejilla de Open-Meteo
  if (S.grid?.own) { S.prevMs = currentMs(); S.grid = null; S.spec = null; S.ownGen = null; force = true; }
  const map = S.map;
  const b = map.getBounds().pad(0.25);
  const south = Math.max(-80, b.getSouth()), north = Math.min(80, b.getNorth());
  const west = Math.max(-180, b.getWest()), east = Math.min(180, b.getEast());
  const z = map.getZoom();
  const sp = S.spec;
  const covers = sp && south >= sp.south && north <= sp.north && west >= sp.west && east <= sp.east && z - sp.zoom < 2;
  const token = ++S.token;
  if (force || !covers) {
    // Rejilla encajada en múltiplos "redondos": vistas parecidas piden los mismos puntos y se reaprovecha la caché
    const t = gridDims(map.getSize());
    const NICE = [0.05, 0.1, 0.125, 0.2, 0.25, 0.4, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 15];
    const nice = (v) => NICE.find((x) => x >= v) || 15;
    const dlat = nice((north - south) / (t.ny - 1)), dlon = nice((east - west) / (t.nx - 1));
    const s0 = Math.max(-80, Math.floor(south / dlat) * dlat), w0 = Math.max(-180, Math.floor(west / dlon) * dlon);
    const ny = Math.ceil((north - s0) / dlat - 1e-9) + 1, nx = Math.ceil((east - w0) / dlon - 1e-9) + 1;
    const lats = [], lons = [];
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { lats.push(s0 + j * dlat); lons.push(w0 + i * dlon); }
    S.spec = { south: s0, north: s0 + (ny - 1) * dlat, west: w0, east: w0 + (nx - 1) * dlon, zoom: z, nx, ny, dlat, dlon, lats, lons };
    S.grid = null;
  }
  const spec = S.spec;
  const missing = neededGroups().filter((g) => !S.grid?.groups.has(g));
  if (!missing.length) { prepareLayer(); return; }
  // El grupo de superficie define los tiempos: siempre va primero
  if (!S.grid && !missing.includes('surface')) missing.unshift('surface');
  S.loading++;
  setStatus('Descargando datos del modelo…');
  try {
    for (const name of missing.sort((a, b) => (a === 'surface' ? -1 : b === 'surface' ? 1 : 0))) {
      const pts = await fetchGroup(name, spec);
      if (token !== S.token) return; // la vista cambió mientras tanto
      if (!S.grid) {
        S.grid = emptyGrid({ lat0: spec.south, lon0: spec.west, dlat: spec.dlat, dlon: spec.dlon, nx: spec.nx, ny: spec.ny }, pts[0].hourly.time);
        const nowKey = new Date().toISOString().slice(0, 13);
        S.t0 = Math.max(0, S.grid.times.findIndex((t) => t.slice(0, 13) === nowKey));
        if (S.prevMs) { S.t = Math.max(S.t0, nearestIndex(S.grid, S.prevMs)); S.prevMs = null; }
        if (S.t < S.t0 || S.t >= S.grid.nt) S.t = S.t0;
      }
      mergePoints(S.grid, pts, GROUPS[name].vars);
      // En el mar se extienden los valores hacia la costa; la tierra se tapa luego con la máscara
      if (name === 'marine') fillGaps(S.grid, GROUPS.marine.vars.filter((v) => !v.includes('direction')), 4);
      S.grid.groups.add(name);
    }
    derive(S.grid);
    S.field.t = S.t;
    S.field.setGrid(S.grid);
    prepareLayer();
    buildDays();
    placeBubble();
    setStatus(`${api.modelName(settings.model)} · rejilla ${spec.nx}×${spec.ny} puntos`, 'ok');
  } catch (e) {
    setStatus(e.message, 'error');
    if (e.rate && /minuto/.test(e.message) && !S.retryTimer) {
      S.retryTimer = setTimeout(() => { S.retryTimer = null; loadData(); }, 65000);
      toast(e.message + ' Reintento automático en 1 minuto.', 5000);
    }
  } finally {
    S.loading--;
  }
}
const loadDebounced = debounce(() => loadData(), 450);

// Variables calculadas: acumulados, nieve en cm y vectores para las partículas
function derive(g) {
  if (g.vars.precipitation && !g.vars.acc_precip) addAccum(g, 'acc_precip', 'precipitation', S.t0);
  if (g.vars.snowfall && !g.vars.acc_snow) addAccum(g, 'acc_snow', 'snowfall', S.t0);
  if (g.vars.snow_depth && !g.vars.snow_depth_cm) g.vars.snow_depth_cm = g.vars.snow_depth.map((v) => v * 100);
  for (const [k, lv] of Object.entries(LEVELS)) if (g.vars[lv.wd]) addFlow(g, 'f_' + k, lv.ws, lv.wd);
  if (g.vars.wave_direction) addFlow(g, 'f_waves', 'wave_height', 'wave_direction', { mult: 9 });
  if (g.vars.swell_wave_direction) addFlow(g, 'f_swell', 'swell_wave_height', 'swell_wave_direction', { mult: 9 });
  if (g.vars.ocean_current_direction) addFlow(g, 'f_currents', 'ocean_current_velocity', 'ocean_current_direction', { mult: 8, towards: true });
  // Las direcciones no se pueden promediar: se rellenan los vectores u/v
  if (g.groups.has('marine') && !g.marineFilled) {
    fillGaps(g, ['f_waves_u', 'f_waves_v', 'f_swell_u', 'f_swell_v', 'f_currents_u', 'f_currents_v'], 4);
    g.marineFilled = true;
  }
}

// ---------- Estilo de la capa activa ----------
function currentStyle() {
  const spec = LAYERS[S.layer];
  const style = {};
  if (!spec.kind) {
    const [, v] = spec.src(S.level);
    const [min, max] = spec.range(S.level);
    Object.assign(style, { var: v, scale: spec.scale, min, max });
    if (spec.cat === 'Mar') { style.mask = true; loadLand(); }
  }
  // Partículas
  const flowKey = spec.flow ? 'f_' + spec.flow : spec.levels ? 'f_' + S.level : 'f_surface';
  if (S.particles && S.layer !== 'sat') style.flow = { u: flowKey + '_u', v: flowKey + '_v', k: S.level === '300hPa' || S.level === '500hPa' ? 0.5 : 1 };
  // Isolíneas
  const isoMode = spec.iso ? 'pressure' : S.iso;
  if (isoMode === 'pressure') {
    // En altura, como en Windy, se dibujan isohipsas (altura geopotencial, en dam) en vez de isobaras
    if (spec.levels && S.level.endsWith('hPa')) {
      style.iso = { var: `geopotential_height_${S.level}`, step: S.level === '850hPa' || S.level === '700hPa' ? 30 : 60, fmt: (v) => String(Math.round(v / 10)), extrema: true };
    } else {
      style.iso = { var: 'pressure_msl', step: 4, fmt: (v) => f.pressure(v), extrema: true };
    }
  }
  if (isoMode === 'temp') style.iso = { var: spec.levels ? LEVELS[S.level].t : 'temperature_2m', step: 5, fmt: (v) => f.temp(v) };
  // Números sobre el mapa
  if (S.values && style.var) style.values = { var: style.var, fmt: UNITS[spec.unit].fmt };
  // Ciudades con su temperatura, sea cual sea la capa (como en Windy)
  if (S.cities) style.cities = { var: 'temperature_2m', fmt: (v) => f.temp(v) };
  return style;
}

const geoCache = {};
const geoData = (name) => (geoCache[name] ||= fetch(`vendor/${name}.json`).then((r) => r.json()).catch((e) => { delete geoCache[name]; throw e; }));

let landLoaded = false;
function loadLand() {
  if (landLoaded) return;
  landLoaded = true;
  geoData('land').then((rings) => S.field.setLand(rings)).catch(() => { landLoaded = false; });
}

// ---------- Zoom con la rueda, continuo y suave ----------
// El de Leaflet anima cada golpe de rueda por separado y descarta los que llegan mientras anima,
// así que iba lento y a saltos. Aquí cada golpe mueve un objetivo y el mapa se acerca a él fotograma
// a fotograma con el mismo mecanismo que el pellizco (sin recalcular capas hasta que se para).
function smoothWheel(map) {
  let wz = null;
  const step = () => {
    const d = wz.target - wz.z;
    wz.z = Math.abs(d) < 0.004 ? wz.target : wz.z + d * 0.3;
    // El punto bajo el ratón se queda quieto
    const half = map.getSize().divideBy(2);
    const center = map.unproject(map.project(wz.ll, wz.z).subtract(wz.pt.subtract(half)), wz.z);
    map._move(center, wz.z, { pinch: true, round: false });
    if (wz.z !== wz.target) { wz.raf = requestAnimationFrame(step); return; }
    wz = null;
    map._moveEnd(true);
  };
  map.getContainer().addEventListener('wheel', (e) => {
    e.preventDefault();
    let px = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * 800 : e.deltaY;
    if (e.ctrlKey) px *= 2.5; // pellizco en el panel táctil del portátil
    if (!wz) {
      map._stop();
      map._moveStart(true, false);
      wz = { z: map.getZoom(), target: map.getZoom(), raf: 0 };
    }
    wz.target = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), wz.target - px / 200));
    wz.pt = map.mouseEventToContainerPoint(e);
    wz.ll = map.containerPointToLatLng(wz.pt);
    if (!wz.raf) wz.raf = requestAnimationFrame(step);
  }, { passive: false });
}

// ---------- Pueblos (GeoNames, >1.000 hab.) por zonas de 5°, cargados al ampliar ----------
const placeTiles = new Map();
let placeIndex = null;
function updateCities() {
  const extra = [...placeTiles.values()].flat();
  const all = (S.baseCities || []).concat(extra);
  if (extra.length) all.sort((a, b) => b[4] - a[4]);
  S.field?.setCities(all);
}
async function loadPlaceTiles() {
  if (!S.cities || S.map.getZoom() < 6) return;
  try {
    placeIndex ||= new Set(await fetch('vendor/places/index.json').then((r) => r.json()));
  } catch { placeIndex = null; return; }
  const b = S.map.getBounds();
  const keys = [];
  for (let la = Math.floor(b.getSouth() / 5); la <= Math.floor(b.getNorth() / 5); la++) {
    for (let lo = Math.floor(b.getWest() / 5); lo <= Math.floor(b.getEast() / 5); lo++) {
      const k = `${la}_${lo}`;
      if (placeIndex.has(k) && !placeTiles.has(k)) keys.push(k);
    }
  }
  if (!keys.length) return;
  const got = await Promise.all(keys.map((k) => fetch(`vendor/places/${k}.json`).then((r) => r.json()).then((rows) => [k, rows]).catch(() => null)));
  for (const g of got) if (g) placeTiles.set(g[0], g[1]);
  updateCities();
}

// Lugar elegido y favoritos, rotulados en el mapa con su valor
function updatePlaces() {
  const seen = new Set();
  const list = [state.place, ...state.favorites].filter((p) => {
    const k = p.lat.toFixed(2) + p.lon.toFixed(2);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).map((p) => ({ name: p.name.length > 22 ? p.name.slice(0, 21) + '…' : p.name, lat: p.lat, lon: p.lon }));
  S.field?.setPlaces(list);
}

// ---------- Costas, fronteras y provincias por encima de los colores (como en Windy) ----------
const toLatLngs = (flat, close) => {
  const out = [];
  for (let i = 0; i < flat.length; i += 2) out.push([flat[i + 1], flat[i]]);
  if (close && out.length) out.push(out[0]);
  return out;
};
async function showBorders() {
  if (S.borderLayers) S.borderLayers.forEach((l) => S.map.removeLayer(l));
  S.borderLayers = null;
  if (!S.borders) return;
  try {
    const [land, borders, regions] = await Promise.all([geoData('land'), geoData('borders'), geoData('regions')]);
    if (!S.borders) return;
    const renderer = L.canvas({ pane: 'bordersPane', padding: 0.4 });
    const opt = { renderer, interactive: false, smoothFactor: 1.2, lineJoin: 'round' };
    const coast = land.map((r) => toLatLngs(r, true));
    const countries = borders.map((r) => toLatLngs(r));
    S.borderHalo = [L.polyline(coast, opt), L.polyline(countries, opt)];
    S.borderInk = [L.polyline(coast, opt), L.polyline(countries, opt)];
    S.regionLines = L.polyline(regions.map((r) => toLatLngs(r)), { ...opt, dashArray: '3 4' });
    S.borderLayers = [...S.borderHalo, ...S.borderInk, S.regionLines];
    S.borderInk.forEach((l) => l.addTo(S.map));
    styleBorders();
    toggleRegions();
  } catch { /* sin conexión: se queda sin líneas */ }
}
// Sobre los colores del modelo, líneas oscuras (como Windy) para no confundirlas con las isobaras blancas;
// sin colores (radar, satélite) líneas claras sobre el mapa oscuro
function styleBorders() {
  if (!S.borderInk) return;
  const field = !LAYERS[S.layer].kind;
  const lightBase = ['light', 'osm', 'topo'].includes(settings.mapBase);
  const dark = field || lightBase;
  // Sobre colores, como Windy: sin raya dura en la costa (la marca la sombra del mar) y fronteras finas y tenues
  const ink = dark ? '#262626' : '#ffffff', halo = '#000000';
  S.borderInk[0].setStyle({ color: ink, weight: dark ? 0.8 : 1.5, opacity: dark ? 0.35 : 0.9 });
  S.borderInk[1].setStyle({ color: ink, weight: dark ? 0.9 : 1.4, opacity: dark ? 0.32 : 0.8 });
  // El halo solo hace falta con líneas claras (radar, satélite); sobre colores ni se dibuja ni se calcula
  S.borderHalo.forEach((l) => {
    l.setStyle({ color: halo, weight: 3, opacity: 0.35 });
    if (dark && S.map.hasLayer(l)) S.map.removeLayer(l);
    if (!dark && !S.map.hasLayer(l)) l.addTo(S.map);
  });
  S.borderInk.forEach((l) => { if (S.map.hasLayer(l)) l.bringToFront(); });
  S.regionLines.setStyle({ color: ink, weight: 0.8, opacity: dark ? 0.22 : 0.5 });
}

// ---------- Lagos y embalses en tono oscuro sobre los colores (como en Windy) ----------
// Embalses y lagos (pipeline/hydro.py)
async function showWater() {
  if (S.waterLayers) S.waterLayers.forEach((l) => S.map.removeLayer(l));
  S.waterLayers = null;
  if (!S.water) return;
  try {
    // Solo lagos y embalses: los ríos de Natural Earth están tan simplificados que salían
    // como rayas rectas que no siguen el cauce (Windy tampoco los dibuja)
    const lakes = await geoData('lakes');
    if (!S.water || S.waterLayers) return;
    const renderer = L.canvas({ pane: 'waterPane', padding: 0.4 });
    const opt = { renderer, interactive: false, smoothFactor: 1, lineJoin: 'round', lineCap: 'round' };
    // Como Windy: de lejos solo los grandes; los embalses pequeños aparecen al acercarse
    const size = (r) => {
      let x0 = 180, x1 = -180, y0 = 90, y1 = -90;
      for (let i = 0; i < r.length; i += 2) { x0 = Math.min(x0, r[i]); x1 = Math.max(x1, r[i]); y0 = Math.min(y0, r[i + 1]); y1 = Math.max(y1, r[i + 1]); }
      return Math.max(x1 - x0, y1 - y0);
    };
    const poly = (rings, tier) => Object.assign(L.polygon(rings.map((r) => [toLatLngs(r)]), { ...opt, stroke: true, weight: 0.8, fill: true, fillRule: 'nonzero' }), { tier });
    S.lakeLayer = poly(lakes.filter((r) => size(r) >= 0.25), { zoom: 0 });
    S.riverLayers = [poly(lakes.filter((r) => size(r) >= 0.08 && size(r) < 0.25), { zoom: 8 }), poly(lakes.filter((r) => size(r) < 0.08), { zoom: 10 })];
    S.waterLayers = [S.lakeLayer, ...S.riverLayers];
    styleWater();
    S.lakeLayer.addTo(S.map);
    toggleRivers();
  } catch { /* sin conexión: sin ríos */ }
}
// Oscuros sobre los colores del modelo; con radar o satélite, azulados sobre el mapa base
function styleWater() {
  if (!S.lakeLayer) return;
  const field = !LAYERS[S.layer].kind;
  const c = field ? '#06212e' : '#4d8fb3';
  S.lakeLayer.setStyle({ color: c, opacity: field ? 0.45 : 0.6, fillColor: c, fillOpacity: field ? 0.38 : 0.35 });
  S.riverLayers.forEach((l) => l.setStyle({ color: c, opacity: field ? 0.45 : 0.6, fillColor: c, fillOpacity: field ? 0.38 : 0.35 }));
}
function toggleRivers() {
  if (!S.riverLayers) return;
  const z = S.map.getZoom();
  S.riverLayers.forEach((l) => {
    const on = z >= l.tier.zoom;
    if (on && !S.map.hasLayer(l)) l.addTo(S.map);
    if (!on && S.map.hasLayer(l)) S.map.removeLayer(l);
  });
}

// Las provincias solo al acercarse, para no saturar el mapa
function toggleRegions() {
  if (!S.regionLines) return;
  const on = S.map.getZoom() >= 6;
  if (on && !S.map.hasLayer(S.regionLines)) S.regionLines.addTo(S.map);
  if (!on && S.map.hasLayer(S.regionLines)) S.map.removeLayer(S.regionLines);
}

function prepareLayer() {
  const spec = LAYERS[S.layer];
  S.field.showField = !spec.kind;
  S.field.showParticles = S.particles;
  S.field.setStyle(currentStyle());
  updateLegend();
  updateSlider();
  updatePicker();
}

function applyLayer() {
  const spec = LAYERS[S.layer];
  save('map.layer', S.layer);
  if (!spec.levels) S.level = 'surface';
  showRadarFrame();
  showSat();
  styleBorders();
  styleWater();
  buildMenu();
  buildQuick();
  prepareLayer();
  loadData();
}

// ---------- Radar (RainViewer) ----------
async function loadRadar() {
  try {
    const d = await api.radarFrames();
    S.radar.layers.forEach((l) => S.map.removeLayer(l));
    S.radar.frames = [...(d.radar?.past || []), ...(d.radar?.nowcast || [])];
    S.radar.layers = S.radar.frames.map((fr) => L.tileLayer(`${d.host}${fr.path}/256/{z}/{x}/{y}/2/1_1.png`, {
      opacity: 0, zIndex: 300, maxNativeZoom: 7, maxZoom: 18, attribution: '<a href="https://www.rainviewer.com" target="_blank">RainViewer</a>',
    }));
    S.radar.idx = S.radar.frames.length - 1;
    showRadarFrame();
    updateSlider();
  } catch (e) {
    // Solo se avisa si se está viendo el radar
    if (LAYERS[S.layer].kind === 'radar') setStatus('Radar no disponible: ' + e.message, 'error');
  }
}
function showRadarFrame() {
  S.radar.layers.forEach((l, i) => {
    if (LAYERS[S.layer].kind !== 'radar') { if (S.map.hasLayer(l)) S.map.removeLayer(l); return; }
    if (!S.map.hasLayer(l)) l.addTo(S.map);
    l.setOpacity(i === S.radar.idx ? 0.8 : 0);
  });
}

// ---------- Satélite (animado: últimas 2 h cada 15 min) ----------
function satTimes(n) {
  // Meteosat publica cada 15 min con unos 20-30 min de retraso
  const step = 15 * 60e3;
  const last = Math.floor((Date.now() - 30 * 60e3) / step) * step;
  return Array.from({ length: n }, (_, k) => last - (n - 1 - k) * step);
}
function showSat() {
  (S.satFrames || []).forEach((fr) => S.map.removeLayer(fr.layer));
  S.satFrames = [];
  const spec = LAYERS[S.layer];
  if (spec.kind !== 'sat' && !spec.sat) return;
  const s = spec.sat ? SATS.ir : SATS[S.sat];
  if (s.gibs) {
    const d = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    S.satFrames = [{
      time: Date.parse(d + 'T12:00:00Z'),
      layer: L.tileLayer(`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/${d}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`, {
        maxNativeZoom: 9, maxZoom: 18, opacity: 0, zIndex: 300, attribution: 'NASA GIBS',
      }),
    }];
  } else {
    // Con radar + satélite basta la última imagen; solo con satélite se anima
    S.satFrames = satTimes(spec.sat ? 1 : 9).map((t) => ({
      time: t,
      layer: L.tileLayer.wms('https://view.eumetsat.int/geoserver/wms', {
        layers: s.wms, format: 'image/png', transparent: true, version: '1.3.0', opacity: 0, zIndex: 300, attribution: 'EUMETSAT',
        time: new Date(t).toISOString().slice(0, 19) + 'Z',
      }),
    }));
  }
  S.satIdx = S.satFrames.length - 1;
  S.satFrames.forEach((fr) => fr.layer.addTo(S.map));
  showSatFrame();
}
function showSatFrame() {
  (S.satFrames || []).forEach((fr, i) => fr.layer.setOpacity(i === S.satIdx ? 0.88 : 0));
}

// Fotogramas observados (radar o satélite) que maneja la línea de tiempo; null si es una capa de modelo
function obs() {
  const kind = LAYERS[S.layer].kind;
  if (kind === 'radar') return { times: S.radar.frames.map((fr) => fr.time * 1000), idx: S.radar.idx, set: (i) => { S.radar.idx = i; showRadarFrame(); } };
  if (kind === 'sat') return { times: (S.satFrames || []).map((fr) => fr.time), idx: S.satIdx, set: (i) => { S.satIdx = i; showSatFrame(); } };
  return null;
}
const hhmmLocal = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

// ---------- Iconos y miniaturas de capas (menú estilo Windy) ----------
const SVG = (p, cls = '') => `<svg viewBox="0 0 24 24"${cls ? ` class="${cls}"` : ''}>${p}</svg>`;
const IC = {
  wind: '<path d="M3 8h10.5A2.5 2.5 0 1 0 11 5.5h-2A4.5 4.5 0 1 1 13.5 10H3zm0 4h15.5a3.5 3.5 0 1 1-3.5 3.5h2a1.5 1.5 0 1 0 1.5-1.5H3zm0-8h4v2H3z"/>',
  drop: '<path d="M12 2.5C8.5 7 6 10.3 6 13.5a6 6 0 0 0 12 0c0-3.2-2.5-6.5-6-11z"/>',
  snow: '<path d="M11 2h2v4.6l3.2-1.9 1 1.7L14 8.3V11h2.7l1.9-3.2 1.7 1-1.9 3.2H22v2h-4.6l1.9 3.2-1.7 1-1.9-3.2H13v2.7l3.2 1.9-1 1.7L13 17.4V22h-2v-4.6l-3.2 1.9-1-1.7 3.2-1.9V13H7.3l-1.9 3.2-1.7-1 1.9-3.2H2v-2h4.6L4.7 7.8l1.7-1L8.3 11H11V8.3L7.8 6.4l1-1.7L11 6.6z"/>',
  bolt: '<path d="M13 2L4 14h7l-2 8 9-12h-7z"/>',
  temp: '<path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0zM12 20a2 2 0 0 1-1-3.7V9h2v7.3a2 2 0 0 1-1 3.7z"/>',
  sun: '<circle cx="12" cy="12" r="5"/><path d="M11 1h2v3h-2zm0 19h2v3h-2zM1 11h3v2H1zm19 0h3v2h-3zM4.2 5.6l1.4-1.4 2.1 2.1-1.4 1.4zm12.1 12.1 1.4-1.4 2.1 2.1-1.4 1.4zM4.2 18.4l2.1-2.1 1.4 1.4-2.1 2.1zM16.3 6.3l2.1-2.1 1.4 1.4-2.1 2.1z"/>',
  cloud: '<path d="M6.8 18.5h10.4a4.3 4.3 0 0 0 .5-8.6A6 6 0 0 0 6.2 11a3.8 3.8 0 0 0 .6 7.5z"/>',
  eye: '<path d="M12 5C6 5 2 12 2 12s4 7 10 7 10-7 10-7-4-7-10-7zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8z"/>',
  gauge: '<path d="M12 4a10 10 0 0 0-10 10h3a7 7 0 0 1 14 0h3A10 10 0 0 0 12 4zm1 10.7L16.5 8 11 13.3a1.5 1.5 0 1 0 2 1.4z"/>',
  wave: '<path d="M2 15c2 0 2-1.6 4-1.6S8 15 10 15s2-1.6 4-1.6 2 1.6 4 1.6 2-1.6 4-1.6v2.2c-2 0-2 1.6-4 1.6s-2-1.6-4-1.6-2 1.6-4 1.6-2-1.6-4-1.6-2 1.6-4 1.6zm0-6c2 0 2-1.6 4-1.6S8 9 10 9s2-1.6 4-1.6S16 9 18 9s2-1.6 4-1.6v2.2c-2 0-2 1.6-4 1.6s-2-1.6-4-1.6-2 1.6-4 1.6-2-1.6-4-1.6-2 1.6-4 1.6z"/>',
  leaf: '<path d="M20 3S9 3 5.5 9.5C3 14 5 19 5 19l1.5-1.3C8 12 13 9 13 9s-4 4-5.5 10.5C15 21 21 15 20 3z"/>',
  radar: '<path d="M12 2a10 10 0 1 0 10 10h-2a8 8 0 1 1-8-8zm0 4a6 6 0 1 0 6 6h-2a4 4 0 1 1-4-4zm0 4a2 2 0 1 0 2 2l7-7-1.4-1.4-7 7A2 2 0 0 0 12 10z"/>',
  sat: '<path d="M7.5 3.5 4.7 6.3l2.8 2.8L5.6 11 2.8 8.2 0 11l6.4 6.4 2.8-2.8-2.8-2.8 1.9-1.9 2.8 2.8 2.8-2.8zM14.5 13l-1.4 1.4a4 4 0 0 1 0 5.6l1.4 1.4a6 6 0 0 0 0-8.4zm2.8-2.8-1.4 1.4a8 8 0 0 1 0 11.3l1.4 1.4a10 10 0 0 0 0-14.1z"/>',
  search: '<path d="M10 3a7 7 0 1 0 4.2 12.6l5.1 5.1 1.4-1.4-5.1-5.1A7 7 0 0 0 10 3zm0 2a5 5 0 1 1 0 10 5 5 0 0 1 0-10z"/>',
  gps: '<path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm9 3h-2.1A7 7 0 0 0 13 5.1V3h-2v2.1A7 7 0 0 0 5.1 11H3v2h2.1a7 7 0 0 0 5.9 5.9V21h2v-2.1a7 7 0 0 0 5.9-5.9H21zm-9 6a5 5 0 1 1 0-10 5 5 0 0 1 0 10z"/>',
  heart: '<path d="M12 20.3l-1.4-1.3C5.4 14.4 2 11.3 2 7.5A4.6 4.6 0 0 1 6.6 3 5 5 0 0 1 12 5.6 5 5 0 0 1 17.4 3 4.6 4.6 0 0 1 22 7.5c0 3.8-3.4 6.9-8.6 11.5z"/>',
  heartO: '<path d="M16.5 3A5.5 5.5 0 0 0 12 5.1 5.5 5.5 0 0 0 7.5 3 4.6 4.6 0 0 0 2 7.6c0 3.8 3.4 6.9 8.6 11.5L12 20.3l1.4-1.3C18.6 14.4 22 11.4 22 7.6A4.6 4.6 0 0 0 16.5 3zm-4.4 14.6-.1.1-.1-.1C7.1 13.3 4 10.5 4 7.6A2.6 2.6 0 0 1 6.6 5c1.5 0 3 1 3.6 2.3h3.6A4.1 4.1 0 0 1 17.4 5 2.6 2.6 0 0 1 20 7.6c0 2.9-3.1 5.7-7.9 10z"/>',
  home: '<path d="M12 3 2 12h3v8h5v-6h4v6h5v-8h3z"/>',
  menu: '<path d="M3 6h18v2.4H3zm0 4.8h18v2.4H3zm0 4.8h18V18H3z"/>',
  close: '<path d="M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/>',
  target: '<path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm9 3h-2.1A7 7 0 0 0 13 5.1V3h-2v2.1A7 7 0 0 0 5.1 11H3v2h2.1a7 7 0 0 0 5.9 5.9V21h2v-2.1a7 7 0 0 0 5.9-5.9H21z"/>',
  iso: '<path d="M12 4C7 4 3 7.6 3 12s4 8 9 8 9-3.6 9-8-4-8-9-8zm0 14c-3.9 0-7-2.7-7-6s3.1-6 7-6 7 2.7 7 6-3.1 6-7 6zm0-10c-2.2 0-4 1.8-4 4s1.8 4 4 4 4-1.8 4-4-1.8-4-4-4zm0 6a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/>',
  num: '<text x="12" y="16.5" text-anchor="middle" font-size="10.5" font-weight="800" font-family="Roboto,system-ui,sans-serif">123</text>',
  clock: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm.5-13H11v6l5.2 3.2.8-1.3-4.5-2.7z"/>',
  trend: '<path d="M3 17l6-6 4 4 8-8v4h2V3h-8v2h4l-6 6-4-4-7.4 7.4z"/>',
  gear: '<path d="M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7 7 0 0 0-1.7-1L15 3h-4l-.4 2.7a7 7 0 0 0-1.7 1l-2.5-1-2 3.5L6.5 11a7.5 7.5 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7 7 0 0 0 1.7 1L11 21h4l.4-2.7a7 7 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/>',
  grid: '<path d="M4 4h7v7H4zm9 0h7v7h-7zM4 13h7v7H4zm9 0h7v7h-7z"/>',
};
const LAYER_ICON = {
  wind: 'wind', gust: 'wind', rain: 'drop', rainacc: 'drop', snowacc: 'snow', snowdepth: 'snow', cape: 'bolt',
  temp: 'temp', feels: 'temp', uv: 'sun', dew: 'temp', freezing: 'snow', humidity: 'drop',
  clouds: 'cloud', lowclouds: 'cloud', midclouds: 'cloud', highclouds: 'cloud', visibility: 'eye', pressure: 'gauge',
  waves: 'wave', swell: 'wave', windwaves: 'wave', waveperiod: 'wave', sst: 'temp', currents: 'wave',
  aqi: 'leaf', pm25: 'leaf', dust: 'leaf', radar: 'radar', radarsat: 'radar', sat: 'sat',
};
const CATS = ['Todo', 'Viento', 'Temperatura', 'Lluvia y nieve', 'Nubes', 'Presión', 'Mar', 'Aire', 'Observación'];
const DAYS_LONG = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

// Miniatura de la capa: degradado con sus propios colores y un icono, como las del menú de Windy
function thumb(k) {
  const spec = LAYERS[k];
  let bg;
  if (spec.kind === 'radar') bg = 'radial-gradient(circle at 38% 42%, #ffe14d 0 7%, #ff8a2b 12%, #2f8fff 22%, #1d4f86 38%, #2a333e 62%)';
  else if (spec.kind === 'sat') bg = 'linear-gradient(135deg,#eef1f4,#8b949e 40%,#3a424b 75%,#20262d)';
  else {
    const [min, max] = spec.range('surface');
    const c = (p) => {
      const [r, g, b, a] = colorAt(spec.scale, min + (max - min) * p);
      return `rgba(${r | 0},${g | 0},${b | 0},${Math.max(a, 0.6).toFixed(2)})`;
    };
    bg = `linear-gradient(135deg, ${c(0.1)}, ${c(0.32)} 35%, ${c(0.58)} 65%, ${c(0.9)}), #2b3440`;
  }
  const url = thumbUrl(k);
  if (url) bg = `center / cover url(${url})`;
  return `<span class="w-thumb" data-th="${k}" style="background:${bg}">${SVG(IC[LAYER_ICON[k]] || IC.wind)}</span>`;
}
// Lista de capas a la derecha en pantallas grandes (como la de Windy): nombre y miniatura redonda
const QUICK = ['radar', 'sat', 'wind', 'rain', 'temp', 'clouds', 'waves', 'rainacc', 'cape', 'gust', 'pressure'];
function buildQuick() {
  const box = el('wQuick');
  if (!box) return;
  box.innerHTML = QUICK.filter((k) => LAYERS[k]).map((k) => `<button class="${k === S.layer ? 'on' : ''}" data-layer="${k}"><span>${LAYERS[k].short || LAYERS[k].label}</span>${thumb(k)}</button>`).join('');
  box.querySelectorAll('[data-layer]').forEach((b) => { b.onclick = () => selectLayer(b.dataset.layer); });
  if (getComputedStyle(box).display !== 'none') loadThumbs();
}

// Las miniaturas tipo mapa se generan la primera vez que se abre el menú (hacen falta las costas)
let thumbsBusy = false;
function loadThumbs() {
  if (thumbsBusy || thumbUrl('wind')) return;
  thumbsBusy = true;
  geoData('land').then((land) => setTimeout(() => {
    makeThumbs(LAYERS, land);
    document.querySelectorAll('.w-thumb[data-th]').forEach((el) => { el.style.background = `center / cover url(${thumbUrl(el.dataset.th)})`; });
  }, 30)).catch(() => { thumbsBusy = false; });
}

// ---------- Leyenda a todo lo ancho (toca la unidad para cambiarla, como en Windy) ----------
function niceTicks(min, max) {
  const span = max - min;
  const raw = span / 6;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}
function updateLegend() {
  const spec = LAYERS[S.layer];
  const box = el('mapLegend');
  if (spec.kind === 'radar') {
    box.innerHTML = `<span class="w-unit">mm/h</span><div class="w-lbar" style="background:linear-gradient(90deg,#88ddee,#0099cc,#0077aa,#ffee00,#ff9900,#ff4400,#c10000,#ff00ff)">
      <span style="left:8%">débil</span><span style="left:50%">moderada</span><span style="left:92%">intensa</span></div>`;
    return;
  }
  if (spec.kind === 'sat') {
    box.innerHTML = `<span class="w-unit">IR</span><div class="w-lbar" style="background:linear-gradient(90deg,#20262d,#6d7680,#f2f4f6)">
      <span style="left:50%">${S.sat === 'modis' ? 'NASA MODIS (imagen de ayer)' : 'Meteosat · nubes altas en blanco'}</span></div>`;
    return;
  }
  const [min, max] = spec.range(S.level);
  const U = UNITS[spec.unit];
  const ticks = niceTicks(min, max).filter((t, i, a) => a.length < 9 || i % 2 === 0);
  box.innerHTML = `<button class="w-unit" id="unitBtn">${U.label()}</button>
    <div class="w-lbar" style="background:${gradientCSS(spec.scale, min, max)}">${ticks.map((t) => `<span style="left:${(4 + ((t - min) / (max - min)) * 92).toFixed(1)}%">${U.fmt(t) || '0'}</span>`).join('')}</div>`;
  if (U.next) el('unitBtn').onclick = () => { U.next(); toast('Unidad: ' + U.label()); };
}

// ---------- Línea de tiempo (barra oscura con los días y burbuja naranja) ----------
const DAYS_ES = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
function timeLabel() {
  const spec = LAYERS[S.layer];
  const o = obs();
  if (o) {
    const t = o.times[o.idx];
    if (!t) return '—';
    if (S.sat === 'modis' && spec.kind === 'sat') return 'Imagen de ayer (NASA MODIS)';
    const mins = Math.round((Date.now() - t) / 60000);
    return `${hhmmLocal(t)} · ${mins <= 2 ? 'ahora' : `hace ${mins} min`}`;
  }
  const g = S.grid;
  if (!g) return '—';
  const d = new Date(g.times[S.t] + ':00Z');
  const rel = S.t - S.t0;
  return `${DAYS_ES[d.getDay()]} ${d.getDate()} · ${String(d.getHours()).padStart(2, '0')}:00${rel === 0 ? ' · ahora' : ''}`;
}

// Con modelo, como en Windy: la marca de la hora queda fija en el centro y se arrastra
// por debajo una tira de días (cada día, PXH píxeles por hora). Con radar/satélite, deslizador normal.
const PXH = 160 / 24;
const stripMode = () => !obs() && !!S.grid;
function buildDays() {
  const box = el('mapDays');
  if (!box) return;
  const tl = el('wTl');
  const o = obs();
  tl.classList.toggle('strip', stripMode());
  if (o) {
    box.innerHTML = `<div class="w-day" style="width:100%"><span>${LAYERS[S.layer].kind === 'sat' ? 'Satélite' : 'Radar'} · últimas 2 horas</span></div>`;
    el('wStrip').scrollLeft = 0;
    return;
  }
  const g = S.grid;
  if (!g) { box.innerHTML = ''; return; }
  const half = el('wStrip').clientWidth / 2;
  const ms0 = timeMs(g, S.t0), ms1 = timeMs(g, g.nt - 1);
  const blocks = [];
  for (let a = ms0; a < ms1;) {
    const d = new Date(a);
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    const b = Math.min(next, ms1);
    blocks.push({ d, w: ((b - a) / 3600e3) * PXH });
    a = b;
  }
  if (!blocks.length) blocks.push({ d: new Date(ms0), w: 0 });
  // Margen de media tira a cada lado para poder llevar cualquier hora al centro
  blocks[0].w += half;
  blocks[blocks.length - 1].w += half;
  box.innerHTML = blocks.map((bl, k) => {
    const label = bl.w > 125 ? `${DAYS_LONG[bl.d.getDay()]} ${bl.d.getDate()}` : bl.w > 58 ? `${DAYS_ES[bl.d.getDay()]} ${bl.d.getDate()}` : bl.w > 22 ? String(bl.d.getDate()) : '';
    return `<div class="w-day${k % 2 ? ' alt' : ''}" style="width:${bl.w.toFixed(1)}px"><span>${label}</span></div>`;
  }).join('');
}

// Instante (ms) que corresponde a la posición de la tira, y al revés
function stripMs() {
  const g = S.grid;
  const ms = timeMs(g, S.t0) + (el('wStrip').scrollLeft / PXH) * 3600e3;
  return Math.max(timeMs(g, S.t0), Math.min(timeMs(g, g.nt - 1), ms));
}
function msToStep(ms) {
  const g = S.grid;
  let i = S.t0;
  while (i + 1 < g.nt && timeMs(g, i + 1) <= ms) i++;
  const span = i + 1 < g.nt ? timeMs(g, i + 1) - timeMs(g, i) : 1;
  return [i, i + 1 < g.nt ? Math.max(0, Math.min(1, (ms - timeMs(g, i)) / span)) : 0];
}
let snapTimer = null;
function onStripScroll() {
  if (!stripMode() || performance.now() < (S.progScroll || 0)) return;
  stopPlay();
  const ms = stripMs();
  const [i, fr] = msToStep(ms);
  S.t = i; S.tf = fr;
  ensureOwnStep(i);
  S.field.setTime(i, fr);
  el('mapRange').value = i;
  placeBubble(false);
  // Al soltar, se ajusta a la hora en punto más cercana
  clearTimeout(snapTimer);
  snapTimer = setTimeout(() => {
    const st = el('wStrip');
    const hrs = Math.round((stripMs() - timeMs(S.grid, S.t0)) / 3600e3);
    const x = hrs * PXH;
    if (Math.abs(st.scrollLeft - x) > 0.5) st.scrollLeft = x; else updatePicker();
  }, 160);
}

function updateSlider() {
  const r = el('mapRange');
  if (!r) return;
  const o = obs();
  if (o) {
    r.min = 0; r.max = Math.max(0, o.times.length - 1); r.value = o.idx; r.disabled = o.times.length < 2;
  } else if (S.grid) {
    r.disabled = false; r.min = S.t0; r.max = S.grid.nt - 1; r.value = S.t;
  }
  buildDays();
  placeBubble();
  updatePicker();
}

function setTime(i, frac = 0) {
  const o = obs();
  if (o) o.set(i); else { S.t = i; S.tf = frac; ensureOwnStep(i); S.field.setTime(i, frac); if (!frac) updatePicker(); }
  const r = el('mapRange');
  if (r) r.value = i;
  placeBubble();
}

// Burbuja naranja con la hora y línea vertical sobre los días, como en Windy
function placeBubble(scroll = true) {
  const r = el('mapRange'), b = el('tlBubble'), line = el('tlLine');
  if (!r || !b) return;
  if (r.disabled) { b.classList.add('hidden'); line.classList.add('hidden'); return; }
  b.classList.remove('hidden');
  line.classList.remove('hidden');
  const W = el('wTl').clientWidth;
  const o = obs();
  if (o) {
    b.textContent = o.times[o.idx] ? hhmmLocal(o.times[o.idx]) : '';
    const min = +r.min, max = +r.max;
    const x = (max > min ? (+r.value - min) / (max - min) : 0) * W;
    line.style.left = x + 'px';
    const half = b.offsetWidth / 2;
    b.style.left = Math.max(half, Math.min(W - half, x)) + 'px';
    return;
  }
  if (!S.grid) return;
  const g = S.grid, t = Math.min(S.t, g.nt - 1);
  const ms = timeMs(g, t) + (S.tf && t + 1 < g.nt ? S.tf * (timeMs(g, t + 1) - timeMs(g, t)) : 0);
  const d = new Date(Math.round(ms / 900e3) * 900e3);
  b.textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  window.dispatchEvent(new CustomEvent('map-time', { detail: ms }));
  // La marca queda en el centro; se mueve la tira
  line.style.left = W / 2 + 'px';
  b.style.left = W / 2 + 'px';
  if (scroll) {
    const st = el('wStrip');
    const x = ((ms - timeMs(g, S.t0)) / 3600e3) * PXH;
    if (Math.abs(st.scrollLeft - x) > 0.5) {
      S.progScroll = performance.now() + 120;
      st.scrollLeft = x;
    }
  }
}

function togglePlay() {
  const btn = el('mapPlay');
  if (S.playing) {
    clearInterval(S.playing);
    S.playing = null;
    btn.innerHTML = ICON.play;
    if (S.tf) setTime(S.t, 0);
    return;
  }
  btn.innerHTML = ICON.pause;
  const radar = !!obs();
  // Con modelo avanza en cuartos de hora interpolados para que la animación sea fluida
  S.playing = setInterval(() => {
    const r = el('mapRange');
    if (r.disabled) return;
    if (radar) {
      let v = +r.value + 1;
      if (v > +r.max) v = +r.min;
      setTime(v);
      return;
    }
    let t = S.t, fr = (S.tf || 0) + 0.25;
    if (fr >= 1) { t++; fr = 0; }
    if (t >= +r.max) { t = +r.min; fr = 0; }
    setTime(t, fr);
  }, radar ? 550 : 170);
}
function stopPlay() { if (S.playing) togglePlay(); }

// ---------- Barra superior: búsqueda o valores del punto tocado (picker de Windy) ----------
function updateTopBar() {
  const p = state.place;
  const name = el('wPlaceName');
  if (name) name.textContent = p.name;
  updateNow();
  const fav = el('wFav');
  if (fav) {
    const on = isFavorite();
    fav.innerHTML = SVG(on ? IC.heart : IC.heartO);
    fav.classList.toggle('on', on);
  }
}

// Tarjeta bajo el buscador: temperatura actual y 4 días con la silueta de temperaturas (como Windy)
const DAYS_UP = ['DOM', 'LUN', 'MAR', 'MIÉ', 'JUE', 'VIE', 'SÁB'];
function updateNow() {
  const box = el('wNow');
  if (!box) return;
  const key = `${state.place.lat},${state.place.lon},${settings.model}`;
  getForecast().then((d) => {
    if (key !== `${state.place.lat},${state.place.lon},${settings.model}`) return;
    const c = d.current, dd = d.daily, h = d.hourly;
    const today = c.time.slice(0, 10);
    const ti = Math.max(0, dd.time.indexOf(today));
    const days = dd.time.slice(ti, ti + 4);
    if (!days.length) { box.innerHTML = ''; return; }
    // Silueta y lluvia desde la hora actual hasta el final del cuarto día;
    // la columna de hoy es más estrecha (solo quedan unas horas), como en Windy
    const i0 = Math.max(0, h.time.findIndex((t) => t.slice(0, 13) >= c.time.slice(0, 13)));
    const left = Math.max(1, 24 - +h.time[i0].slice(11, 13));
    const flex = days.map((_, k) => (k === 0 ? Math.max(0.6, left / 24) : 1));
    const total = flex.reduce((x, y) => x + y, 0);
    const W = 400, H = 60;
    // Posición horizontal (0..W) de la hora i, repartida en las columnas de su día
    const xOf = (i) => {
      const k = days.indexOf(h.time[i].slice(0, 10));
      if (k < 0) return null;
      const before = flex.slice(0, k).reduce((x, y) => x + y, 0);
      const frac = k === 0 ? (i - i0) / left : +h.time[i].slice(11, 13) / 24;
      return ((before + frac * flex[k]) / total) * W;
    };
    const idx = [];
    for (let i = i0; i < h.time.length && days.includes(h.time[i].slice(0, 10)); i++) if (f.isNum(h.temperature_2m[i])) idx.push(i);
    const temps = idx.map((i) => h.temperature_2m[i]);
    const lo = Math.min(...temps), hi = Math.max(...temps);
    const pts = idx.map((i, k) => `${xOf(i).toFixed(1)},${(H - 4 - ((temps[k] - lo) / Math.max(1, hi - lo)) * (H - 22)).toFixed(1)}`);
    const rain = idx.filter((i) => h.precipitation[i] >= 0.1).map((i) => `<i style="left:${(xOf(i) / W * 100).toFixed(2)}%;width:${(100 / (total * 24)).toFixed(2)}%;opacity:${Math.min(1, 0.4 + h.precipitation[i] / 2).toFixed(2)}"></i>`);
    box.innerHTML = `
      <div class="wn-now"><big>${f.isNum(c.temperature_2m) ? Math.round(f.tempVal(c.temperature_2m)) : '–'}<sup>°</sup></big>
        <small>${wxIcon(c.weather_code, c.is_day, 'wn-ico')} ${f.wind(c.wind_speed_10m, true)}</small></div>
      <div class="wn-fc">
        <svg class="wn-mount" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><path d="M0,${H} L${pts.join(' L')} L${W},${H} Z"/></svg>
        <ul class="wn-days">${days.map((day, k) => `<li style="flex:${flex[k]}"><span>${DAYS_UP[f.parts(day).wd]}</span>
          ${wxIcon(dd.weather_code[ti + k], 1)}
          <em>${k === 0 ? '' : `${f.temp(dd.temperature_2m_min[ti + k])} / `}<b>${f.temp(dd.temperature_2m_max[ti + k])}</b></em></li>`).join('')}</ul>
        <div class="wn-rain">${rain.join('')}</div>
      </div>`;
  }).catch(() => { box.innerHTML = ''; });
}

function pickValue(ll) {
  const spec = LAYERS[S.layer];
  const s = (n) => S.field.sample(n, ll.lat, ll.lng);
  if (spec.kind) {
    // En radar/satélite se muestra el viento del modelo
    const u = s('f_surface_u'), v = s('f_surface_v');
    const dir = u !== null && v !== null ? (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360 : null;
    return { label: 'Viento', val: f.wind(s('wind_speed_10m')), unit: f.windUnit(), dir };
  }
  const [, vName] = spec.src(S.level);
  const U = UNITS[spec.unit];
  const val = s(vName);
  let dir = null;
  if (spec.flow || S.layer === 'wind' || S.layer === 'gust') {
    const fk = spec.flow ? 'f_' + spec.flow : spec.levels ? 'f_' + S.level : 'f_surface';
    const u = s(fk + '_u'), v = s(fk + '_v');
    if (u !== null && v !== null) dir = spec.flow === 'currents' ? (Math.atan2(u, v) * 180 / Math.PI + 540) % 360 : (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360;
  }
  return { label: spec.label, val: val === null ? '–' : (U.fmt(val) || '0'), unit: U.label(), dir };
}

function updatePicker() {
  const box = el('wPicker');
  if (!box || !S.pick) return;
  const spec = LAYERS[S.layer];
  const v = pickValue(S.pick);
  const model = api.MODELS.find((m) => m.id === settings.model)?.short || settings.model;
  const sub = spec.kind ? 'modelo ' + model : `${model}, ${spec.levels ? LEVELS[S.level].label : 'Superficie'}`;
  box.querySelector('.wp-label').innerHTML = `<b>${v.label}</b><small>${sub}</small>`;
  box.querySelector('.wp-val').innerHTML = `${v.val}<small>${v.unit}</small>${v.dir !== null ? `<span class="wp-dir">${f.arrow(v.dir)}${f.dirName(v.dir)}</span>` : ''}`;
  // Burbuja con el valor junto al punto, como en Windy
  const bubble = S.marker.getElement()?.querySelector('.pin-val');
  if (bubble) {
    bubble.innerHTML = `${v.dir !== null ? f.arrow(v.dir) + ' ' : ''}${v.val} <small>${v.unit}</small>`;
    bubble.classList.remove('hidden');
  }
}

function pickAt(latlng) {
  S.pick = latlng;
  el('wSearch').classList.add('hidden');
  el('wNow').classList.add('hidden');
  el('wPicker').classList.remove('hidden');
  updatePicker();
  S.marker.setLatLng(latlng);
  // El punto tocado pasa a ser el lugar seleccionado (como en Windy)
  api.reverseGeocode(latlng.lat, latlng.lng).then((p) => {
    p.lat = latlng.lat; p.lon = latlng.lng;
    S.keepView = true;
    setPlace(p);
  });
}
function openPlace(hit) {
  // El lugar ya elegido: solo se abre su pronóstico
  if (Math.abs(hit.lat - state.place.lat) < 1e-4 && Math.abs(hit.lon - state.place.lon) < 1e-4) { closePicker(); openDetail(el('view-map')); return; }
  const go = (extra) => setPlace({ ...extra, name: hit.name, lat: hit.lat, lon: hit.lon });
  api.reverseGeocode(hit.lat, hit.lon).then(go).catch(() => go({}));
}
function closePicker() {
  S.pick = null;
  S.marker.getElement()?.querySelector('.pin-val')?.classList.add('hidden');
  el('wPicker').classList.add('hidden');
  el('wSearch').classList.remove('hidden');
  el('wNow').classList.remove('hidden');
}
function highlightStrip() { /* el panel de horas ahora está en el detalle */ }

// ---------- Estado y avisos ----------
let statusTimer = null;
function setStatus(msg, kind = 'info') {
  const s = el('mapStatusTxt');
  if (s) s.textContent = msg;
  const pill = el('wStatus');
  if (!pill) return;
  clearTimeout(statusTimer);
  if (kind === 'ok') { pill.classList.add('hidden'); return; }
  pill.textContent = msg;
  pill.classList.toggle('err', kind === 'error');
  pill.classList.remove('hidden');
  if (kind === 'error') statusTimer = setTimeout(() => pill.classList.add('hidden'), 7000);
}

// ---------- Menú lateral (botón rojo): capas con miniaturas, secciones y opciones ----------
let menuCat = 'Todo';
function selectLayer(k) {
  S.layer = k;
  stopPlay();
  applyLayer();
}

function buildMenu() {
  const m = el('wMenu');
  if (!m) return;
  const keys = Object.keys(LAYERS).filter((k) => menuCat === 'Todo' || LAYERS[k].cat === menuCat);
  const spec = LAYERS[S.layer];
  const sel = (name, opts, cur) => `<select class="wm-select" name="${name}">${opts.map(([v, l]) => `<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  const tog = (name, label, on) => `<label class="wm-toggle"><span>${label}</span><input type="checkbox" name="${name}" ${on ? 'checked' : ''}><i></i></label>`;
  m.innerHTML = `
    <button class="w-close wm-close" data-close aria-label="Cerrar">${SVG(IC.close)}</button>
    <div class="wm-nav">
      <a href="#/inicio">${SVG(IC.cloud)}<span>Pronóstico</span></a>
      <a href="#/horas">${SVG(IC.clock)}<span>Por horas</span></a>
      <a href="#/tendencia">${SVG(IC.trend)}<span>Largo plazo</span></a>
      <button data-favs>${SVG(IC.heart)}<span>Mis favoritos</span></button>
      <a href="#/mas">${SVG(IC.grid)}<span>Más</span></a>
      <a href="#/ajustes">${SVG(IC.gear)}<span>Configuración</span></a>
    </div>
    <div class="wm-cats">${CATS.map((c) => `<button class="${c === menuCat ? 'on' : ''}" data-cat="${c}">${c}</button>`).join('')}</div>
    <div class="wm-grid">${keys.map((k) => `<button class="wm-tile${k === S.layer ? ' on' : ''}" data-layer="${k}">${thumb(k)}<span>${LAYERS[k].label}</span></button>`).join('')}</div>
    ${spec.levels ? `<h3>Altitud</h3><div class="wm-cats">${Object.entries(LEVELS).map(([k, v]) => `<button class="${k === S.level ? 'on' : ''}" data-level="${k}">${v.label}</button>`).join('')}</div>` : ''}
    ${spec.kind === 'sat' ? `<h3>Imagen de satélite</h3>${sel('sat', Object.entries(SATS).map(([k, v]) => [k, v.label]), S.sat)}` : ''}
    <h3>Modelo</h3>${sel('model', api.MODELS.map((x) => [x.id, x.name]), settings.model)}
    <h3>En el mapa</h3>
    ${tog('particles', 'Partículas animadas', S.particles)}
    ${tog('cities', 'Ciudades con su valor', S.cities)}
    ${tog('values', 'Números en rejilla', S.values)}
    ${tog('relief', 'Relieve del terreno', S.relief)}
    ${tog('borders', 'Costas, fronteras y provincias', S.borders)}
    ${tog('water', 'Lagos y embalses', S.water)}
    <div class="wm-row"><span>Isolíneas</span>${sel('iso', ISO_MODES, S.iso)}</div>
    <div class="wm-row"><span>Mapa base</span>${sel('base', [['dark', 'Oscuro'], ['light', 'Claro'], ['imagery', 'Satélite (foto)'], ['osm', 'OpenStreetMap'], ['topo', 'Topográfico']], settings.mapBase)}</div>
    <div class="wm-row"><span>Horizonte</span>${sel('days', [[2, '2 días'], [3, '3 días'], [5, '5 días'], [7, '7 días'], [10, '10 días']], S.days)}</div>
    <div class="wm-row"><span>Resolución</span>${sel('grid', [['low', 'Baja'], ['normal', 'Normal'], ['high', 'Alta']], settings.mapGrid)}</div>
    <p class="wm-status" id="mapStatusTxt"></p>
    <p class="wm-note">Datos: ECMWF (datos abiertos, CC BY 4.0) procesados por la propia app para Europa; Open-Meteo (NOAA, DWD, Météo-France…), MET Noruega, RainViewer, EUMETSAT y NASA. Más resolución u horizonte gastan más cuota gratuita (10.000 consultas/día).</p>`;
  m.querySelector('[data-close]').onclick = closeMenu;
  m.querySelector('[data-favs]').onclick = () => { closeMenu(); el('placeBtn').click(); };
  m.querySelectorAll('a').forEach((a) => { a.addEventListener('click', closeMenu); });
  m.querySelectorAll('[data-cat]').forEach((b) => { b.onclick = () => { menuCat = b.dataset.cat; buildMenu(); }; });
  m.querySelectorAll('[data-layer]').forEach((b) => { b.onclick = () => { selectLayer(b.dataset.layer); closeMenu(); }; });
  m.querySelectorAll('[data-level]').forEach((b) => { b.onclick = () => { S.level = b.dataset.level; applyLayer(); }; });
  m.onchange = (e) => {
    const { name, value, checked } = e.target;
    if (name === 'model') { settings.model = value; saveSettings(); }
    if (name === 'sat') { S.sat = value; stopPlay(); showSat(); updateSlider(); updateLegend(); }
    if (name === 'base') { settings.mapBase = value; saveSettings(); }
    if (name === 'grid') { settings.mapGrid = value; saveSettings(); }
    if (name === 'days') { S.days = +value; loadData(true); }
    if (name === 'iso') { S.iso = value; save('map.iso', value); sideState(); prepareLayer(); }
    if (name === 'particles') { S.particles = checked; sideState(); prepareLayer(); }
    if (name === 'values') { S.values = checked; save('map.values', checked); sideState(); prepareLayer(); }
    if (name === 'relief') { S.relief = checked; save('map.relief', checked); if (checked) S.reliefLayer.addTo(S.map); else S.map.removeLayer(S.reliefLayer); }
    if (name === 'borders') { S.borders = checked; save('map.borders', checked); showBorders(); }
    if (name === 'water') { S.water = checked; save('map.water', checked); showWater(); }
    if (name === 'cities') {
      S.cities = checked;
      save('map.cities', checked);
      if (S.labels) { if (S.cities) S.map.removeLayer(S.labels); else S.labels.addTo(S.map); }
      prepareLayer();
      loadPlaceTiles();
    }
  };
  const st = el('mapStatusTxt');
  if (st && S.spec) st.textContent = `${api.modelName(settings.model)} · rejilla ${S.spec.nx}×${S.spec.ny} puntos`;
}
function openMenu() { buildMenu(); loadThumbs(); el('wMenu').classList.add('open'); el('wMenuShade').classList.add('open'); }
function closeMenu() { el('wMenu').classList.remove('open'); el('wMenuShade').classList.remove('open'); }

function sideState() {
  el('mapParticles').classList.toggle('on', S.particles);
  el('mapValues').classList.toggle('on', S.values);
  const iso = el('mapIso');
  iso.classList.toggle('on', S.iso !== 'off');
  iso.title = ISO_MODES.find(([k]) => k === S.iso)[1];
}

function buildUI(root) {
  root.innerHTML = `
    <div id="map"></div>
    <div class="w-top">
      <div class="w-search" id="wSearch">
        <button class="w-sb-main" id="wSearchBtn">${SVG(IC.search)}<span id="wPlaceName"></span></button>
        <button class="w-sb-ico" id="wGps" title="Mi ubicación">${SVG(IC.gps)}</button>
        <button class="w-sb-ico" id="wFav" title="Favorito"></button>
      </div>
      <button class="w-now" id="wNow" aria-label="Pronóstico del lugar"></button>
      <div class="w-picker hidden" id="wPicker">
        <div class="wp-row"><div class="wp-label"></div><div class="wp-val"></div></div>
        <div class="wp-actions">
          <button class="w-pill yellow" id="wpDetail">${SVG(IC.target)}<span>Pronóstico<small>para este punto</small></span></button>
          <button class="w-pill" id="wpFav">${SVG(IC.heart)}<span>Guardar<small>en favoritos</small></span></button>
        </div>
        <button class="w-close wp-close" id="wpClose" aria-label="Cerrar">${SVG(IC.close)}</button>
      </div>
      <div class="w-status hidden" id="wStatus"></div>
    </div>
    <div class="w-side">
      <button id="mapIso" title="Isolíneas">${SVG(IC.iso)}</button>
      <button id="mapParticles" title="Partículas animadas">${SVG(IC.wind)}</button>
      <button id="mapValues" title="Números en el mapa">${SVG(IC.num)}</button>
      <button id="mapHome" title="Ir a mi lugar">${SVG(IC.home)}</button>
      <button id="mapSearch" title="Buscar">${SVG(IC.search)}</button>
    </div>
    <button class="w-menu-btn" id="wMenuBtn" aria-label="Menú y capas">${SVG(IC.menu)}</button>
    <div class="w-quick" id="wQuick"></div>
    <div class="w-shade" id="wMenuShade"></div>
    <aside class="w-menu" id="wMenu"></aside>
    <div class="w-bottom" id="wBottom">
      <div class="w-timeline">
        <button class="w-play" id="mapPlay">${ICON.play}</button>
        <div class="w-tl" id="wTl">
          <div class="w-strip" id="wStrip"><div class="w-days" id="mapDays"></div></div>
          <span class="w-bubble hidden" id="tlBubble"></span>
          <span class="w-tline hidden" id="tlLine"></span>
          <input type="range" id="mapRange" min="0" max="0" value="0" aria-label="Hora">
        </div>
      </div>
      <div class="w-legend" id="mapLegend"></div>
    </div>`;

  updateTopBar();
  el('mapRange').addEventListener('input', (e) => setTime(+e.target.value));
  // Atajos: ← → hora anterior/siguiente, espacio reproducir
  document.addEventListener('keydown', (e) => {
    if (!root.classList.contains('active') || e.target.closest('input[type=search], select, textarea')) return;
    const r = el('mapRange');
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      setTime(clampInt(+r.value + (e.key === 'ArrowRight' ? 1 : -1), +r.min, +r.max));
    } else if (e.key === ' ') {
      e.preventDefault();
      togglePlay();
    } else if (e.key === 'Escape') {
      closeMenu();
    }
  });
  window.addEventListener('resize', () => { buildDays(); placeBubble(); });
  // Tocar una columna del panel del punto lleva el mapa a esa hora (como Windy)
  window.addEventListener('wd-pick-time', (e) => {
    if (!S.grid || obs()) return;
    stopPlay();
    setTime(Math.max(S.t0, nearestIndex(S.grid, e.detail)));
    updatePicker();
  });
  // Tira de días: se arrastra con el dedo, con el ratón o con la rueda
  const strip = el('wStrip');
  strip.addEventListener('scroll', onStripScroll, { passive: true });
  strip.addEventListener('wheel', (e) => {
    if (!stripMode() || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    e.preventDefault();
    strip.scrollLeft += e.deltaY;
  }, { passive: false });
  strip.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || !stripMode()) return;
    const x0 = e.clientX, s0 = strip.scrollLeft;
    const move = (ev) => { strip.scrollLeft = s0 - (ev.clientX - x0); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  el('mapPlay').onclick = togglePlay;
  el('wSearchBtn').onclick = () => el('placeBtn').click();
  el('mapSearch').onclick = () => el('placeBtn').click();
  el('wGps').onclick = () => el('gpsBtn').click();
  el('wFav').onclick = () => { toggleFavorite(); toast(isFavorite() ? 'Guardado en favoritos' : 'Quitado de favoritos'); };
  el('wpFav').onclick = () => { if (!isFavorite()) toggleFavorite(); toast('Guardado en favoritos'); };
  el('wpDetail').onclick = () => { closePicker(); openDetail(el('view-map')); };
  el('wpClose').onclick = closePicker;
  el('wNow').onclick = () => openDetail(el('view-map'));
  el('wMenuBtn').onclick = openMenu;
  el('wMenuShade').onclick = closeMenu;
  el('mapParticles').onclick = () => { S.particles = !S.particles; sideState(); prepareLayer(); };
  el('mapIso').onclick = () => {
    const i = ISO_MODES.findIndex(([k]) => k === S.iso);
    S.iso = ISO_MODES[(i + 1) % ISO_MODES.length][0];
    save('map.iso', S.iso);
    sideState();
    toast(ISO_MODES.find(([k]) => k === S.iso)[1]);
    prepareLayer();
  };
  el('mapValues').onclick = () => { S.values = !S.values; save('map.values', S.values); sideState(); prepareLayer(); };
  el('mapHome').onclick = () => S.map.setView([state.place.lat, state.place.lon], Math.max(S.map.getZoom(), 7));
  sideState();
}

function setBase() {
  if (S.base && S.baseKey === settings.mapBase) return;
  S.baseKey = settings.mapBase;
  if (S.base) S.map.removeLayer(S.base);
  if (S.labels) S.map.removeLayer(S.labels);
  const [url, attr, labels, maxNative] = BASES[settings.mapBase] || BASES.dark;
  S.base = L.tileLayer(url, { attribution: attr, maxZoom: 18, maxNativeZoom: maxNative, subdomains: 'abc' }).addTo(S.map);
  // Fronteras y nombres de ciudades por encima de los colores, como en Windy
  S.labels = labels ? L.tileLayer(labels, { pane: 'labelsPane', maxZoom: 18, maxNativeZoom: maxNative }) : null;
  if (S.labels && !S.cities) S.labels.addTo(S.map);
}

export default {
  render(root) {
    if (!S.map) {
      buildUI(root);
      const view = load('map.view', null);
      const map = L.map('map', { zoomControl: false, zoomSnap: 0, zoomDelta: 0.5, scrollWheelZoom: false, worldCopyJump: false, minZoom: 2, maxBounds: [[-85, -200], [85, 200]] })
        .setView(view ? [view[0], view[1]] : [state.place.lat, state.place.lon], view ? view[2] : 6);
      S.map = map;
      map.createPane('labelsPane').style.zIndex = 380;
      map.createPane('bordersPane').style.zIndex = 365;
      map.getPane('bordersPane').style.pointerEvents = 'none';
      map.getPane('labelsPane').style.pointerEvents = 'none';
      // Agua entre los colores (350) y el relieve (356); multiply la oscurece sin tapar el color de debajo
      Object.assign(map.createPane('waterPane').style, { zIndex: 353, pointerEvents: 'none', mixBlendMode: 'multiply' });
      // Relieve sombreado sobre los colores (se mezcla con ellos como en Windy)
      const relief = map.createPane('reliefPane');
      // Las teselas de Esri son casi blancas: brillo + contraste acentúan las sombras sin oscurecer lo llano.
      // Son filtros CSS (los acelera la GPU); el filtro SVG de antes se recalculaba en cada fotograma del zoom.
      Object.assign(relief.style, { zIndex: 356, pointerEvents: 'none', mixBlendMode: 'multiply', opacity: 0.7, filter: 'brightness(0.68) contrast(2.8)' });
      S.reliefLayer = L.tileLayer(ESRI + 'Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}', { pane: 'reliefPane', maxZoom: 18, maxNativeZoom: 13, attribution: 'Relieve: Esri' });
      if (S.relief) S.reliefLayer.addTo(map);
      // La atribución va justo encima del panel inferior, que cambia de altura
      const panel = root.querySelector('.w-bottom');
      const fitAttribution = () => {
        const br = map.getContainer().querySelector('.leaflet-bottom.leaflet-right');
        if (br) br.style.bottom = panel.offsetHeight + 10 + 'px';
      };
      new ResizeObserver(fitAttribution).observe(panel);
      fitAttribution();
      setBase();
      S.field = new FieldLayer(map);
      smoothWheel(map);
      loadLand(); // costas para la sombra del mar
      // Los nombres de ciudades no se ponen debajo de los botones ni de las barras
      const avoidUI = () => {
        const m = map.getContainer().getBoundingClientRect();
        S.field.avoid = [...root.querySelectorAll('.w-top, .w-side button, .w-menu-btn, .w-quick button, .w-bottom')]
          .map((b) => b.getBoundingClientRect()).filter((r) => r.width)
          .map((r) => [r.left - m.left - 4, r.top - m.top - 4, r.width + 8, r.height + 8]);
        S.field.drawIso();
      };
      new ResizeObserver(avoidUI).observe(map.getContainer());
      new ResizeObserver(avoidUI).observe(root.querySelector('.w-top'));
      showBorders();
      showWater();
      map.on('zoomend', toggleRegions);
      map.on('zoomend', toggleRivers);
      geoData('cities').then((c) => { S.baseCities = c; updateCities(); }).catch(() => {});
      map.on('moveend', loadPlaceTiles);
      map.whenReady(() => loadPlaceTiles());
      updatePlaces();
      on('favorites', updatePlaces);
      // El punto se puede arrastrar: el valor de la burbuja cambia mientras se mueve
      S.marker = L.marker([state.place.lat, state.place.lon], { draggable: true, autoPan: true, icon: L.divIcon({ className: '', html: '<div class="pin"></div><div class="pin-val hidden"></div>', iconSize: [16, 16] }) }).addTo(map);
      S.marker.on('drag', () => { S.pick = S.marker.getLatLng(); updatePicker(); });
      S.marker.on('dragend', () => pickAt(S.marker.getLatLng()));
      // Créditos del mapa plegados en una «i» para que no tapen la hora
      const attr = map.attributionControl.getContainer();
      attr.classList.add('folded');
      attr.addEventListener('click', (e) => { if (e.target.tagName !== 'A') attr.classList.toggle('folded'); });
      map.on('moveend', loadDebounced);
      map.on('moveend', () => save('map.view', [map.getCenter().lat, map.getCenter().lng, map.getZoom()]));
      // Un toque elige el punto; si llega un segundo toque (doble toque = zoom) se cancela
      let clickTimer = null;
      map.on('click', (e) => {
        clearTimeout(clickTimer);
        // Tocar el nombre de una localidad abre su pronóstico
        const hit = S.cities ? S.field.labelAt(e.containerPoint) : null;
        clickTimer = setTimeout(() => (hit ? openPlace(hit) : pickAt(e.latlng)), 280);
      });
      // Manita sobre los nombres, para que se vea que se pueden tocar
      map.on('mousemove', (e) => {
        map.getContainer().style.cursor = S.cities && S.field.labelAt(e.containerPoint) ? 'pointer' : '';
      });
      map.on('dblclick', () => clearTimeout(clickTimer));
      map.whenReady(() => { S.field.redraw(); loadData(true); });
      loadRadar();
      applyLayer();
      setInterval(() => {
        if (S.playing) return;
        if (LAYERS[S.layer].kind === 'radar') loadRadar();
        if (LAYERS[S.layer].kind === 'sat' || LAYERS[S.layer].sat) { showSat(); updateSlider(); }
      }, 5 * 60e3);
      return;
    }
    // Re-render por cambio de lugar o de ajustes
    const baseChanged = S.baseKey !== settings.mapBase;
    setBase();
    if (baseChanged) showBorders();
    S.marker.setLatLng([state.place.lat, state.place.lon]);
    S.map.invalidateSize();
    const ll = L.latLng(state.place.lat, state.place.lon);
    const placeKey = `${state.place.lat.toFixed(3)},${state.place.lon.toFixed(3)}`;
    const placeChanged = placeKey !== S.placeKey;
    S.placeKey = placeKey;
    if (!S.keepView && !S.map.getBounds().pad(-0.1).contains(ll)) S.map.setView(ll, S.map.getZoom());
    const modelChanged = S.modelKey && S.modelKey !== settings.model;
    S.modelKey = settings.model;
    // Como en Windy: al elegir un lugar en el buscador se abre su pronóstico
    const fromSearch = placeChanged && !S.keepView;
    S.keepView = false;
    if (fromSearch) { closePicker(); S.map.setView(ll, Math.max(S.map.getZoom(), 7)); }
    buildMenu();
    updateTopBar();
    if (detailOpen() || fromSearch) openDetail(root);
    updatePlaces();
    prepareLayer();
    loadData(modelChanged || settings.mapGrid !== S.gridRes);
    S.gridRes = settings.mapGrid;
  },
  show() {
    if (!S.map) return;
    S.map.invalidateSize();
    S.field.redraw();
    buildDays();
    placeBubble();
  },
  hide() {
    stopPlay();
    closeDetail();
    S.field?.stop();
  },
};
S.modelKey = settings.model;
S.gridRes = settings.mapGrid;
S.placeKey = `${state.place.lat.toFixed(3)},${state.place.lon.toFixed(3)}`;
on('favorites', () => updateTopBar());
