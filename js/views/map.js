// Vista "Mapa" (pantalla principal, al estilo Windy): capas de modelo con partículas animadas,
// altitudes, isobaras, valores sobre el mapa, radar, satélite y pronóstico del punto seleccionado.
/* global L */
import { state, settings, saveSettings, setPlace, load, save, on } from '../state.js';
import { getForecast } from '../data.js';
import { wxIcon, wxDesc } from '../icons.js';
import * as api from '../api.js';
import * as f from '../format.js';
import { gradientCSS } from '../colors.js';
import { FieldLayer, emptyGrid, mergePoints, addFlow, addAccum, fillGaps } from '../windlayer.js';
import { toast, debounce, selectEl } from '../ui.js';
import { openDetail, closeDetail, detailOpen } from './mapdetail.js';

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
const QUICK = ['wind', 'rain', 'temp', 'clouds', 'radar', 'sat', 'waves', 'pressure'];

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
  layer: load('map.layer', 'wind'), level: 'surface', borders: load('map.borders', true), cities: load('map.cities', true), particles: true, iso: load('map.iso', 'pressure'), values: load('map.values', false), sat: 'ir',
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
function setStatus(msg) { const s = el('mapStatusTxt'); if (s) s.textContent = msg; }

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

// Descarga la rejilla de la vista actual (si hace falta) y los grupos de datos que pide la capa
async function loadData(force = false) {
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
  setStatus(`Descargando ${spec.nx * spec.ny} puntos…`);
  try {
    for (const name of missing.sort((a, b) => (a === 'surface' ? -1 : b === 'surface' ? 1 : 0))) {
      const pts = await fetchGroup(name, spec);
      if (token !== S.token) return; // la vista cambió mientras tanto
      if (!S.grid) {
        S.grid = emptyGrid({ lat0: spec.south, lon0: spec.west, dlat: spec.dlat, dlon: spec.dlon, nx: spec.nx, ny: spec.ny }, pts[0].hourly.time);
        const nowKey = new Date().toISOString().slice(0, 13);
        S.t0 = Math.max(0, S.grid.times.findIndex((t) => t.slice(0, 13) === nowKey));
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
    setStatus(`${api.MODELS.find((m) => m.id === settings.model)?.short || settings.model} · ${spec.nx}×${spec.ny} puntos`);
  } catch (e) {
    setStatus(e.message);
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
  // Ciudades con el valor de la capa (en radar/satélite solo el nombre)
  if (S.cities) style.cities = style.var ? { var: style.var, fmt: UNITS[spec.unit].fmt } : { var: null };
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
    styleBorders();
    S.borderLayers.forEach((l) => { if (l !== S.regionLines) l.addTo(S.map); });
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
  const ink = dark ? '#10161d' : '#ffffff', halo = dark ? '#ffffff' : '#000000';
  S.borderInk[0].setStyle({ color: ink, weight: 1.5, opacity: dark ? 0.8 : 0.9 });
  S.borderInk[1].setStyle({ color: ink, weight: 1.4, opacity: dark ? 0.7 : 0.8 });
  S.borderHalo.forEach((l) => l.setStyle({ color: halo, weight: 3, opacity: dark ? 0.12 : 0.35 }));
  S.regionLines.setStyle({ color: ink, weight: 0.9, opacity: 0.5 });
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
  refreshPick();
}

function applyLayer() {
  const spec = LAYERS[S.layer];
  save('map.layer', S.layer);
  if (!spec.levels) S.level = 'surface';
  showRadarFrame();
  showSat();
  styleBorders();
  renderChips();
  el('mapSatSel').classList.toggle('hidden', S.layer !== 'sat');
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
    setStatus('Radar no disponible: ' + e.message);
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

// ---------- Leyenda (toca la unidad para cambiarla, como en Windy) ----------
function niceTicks(min, max) {
  const span = max - min;
  const raw = span / 5;
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
    box.innerHTML = `<span>Débil</span><div class="bar" style="flex:1;background:linear-gradient(90deg,#88ddee,#0099cc,#0077aa,#ffee00,#ff9900,#ff4400,#c10000,#ff00ff)"></div><span>Intensa</span>`;
    return;
  }
  if (spec.kind === 'sat') { box.innerHTML = ''; return; }
  const [min, max] = spec.range(S.level);
  const U = UNITS[spec.unit];
  const ticks = niceTicks(min, max);
  box.innerHTML = `<div style="flex:1;position:relative"><div class="bar" style="background:${gradientCSS(spec.scale, min, max)}"></div>
    <div class="ticks">${ticks.map((t) => `<span style="left:${((t - min) / (max - min)) * 100}%">${U.fmt(t) || '0'}</span>`).join('')}</div></div>
    <button class="unit-btn" id="unitBtn" ${U.next ? '' : 'disabled'}>${U.label()}</button>`;
  const ub = el('unitBtn');
  if (U.next) ub.onclick = () => { U.next(); toast('Unidad: ' + U.label()); };
}

// ---------- Línea de tiempo ----------
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

function buildDays() {
  const box = el('mapDays');
  const g = S.grid;
  if (!box || !g) return;
  const groups = [];
  for (let i = S.t0; i < g.nt; i++) {
    const d = new Date(g.times[i] + ':00Z');
    const key = d.toDateString();
    if (!groups.length || groups[groups.length - 1].key !== key) groups.push({ key, d, start: i, n: 0 });
    groups[groups.length - 1].n++;
  }
  const total = g.nt - S.t0;
  box.innerHTML = groups.map((gr) => `<button data-i="${gr.start}" data-n="${gr.n}" style="width:${(gr.n / total) * 100}%">${gr.n >= 6 ? `${DAYS_ES[gr.d.getDay()]} ${gr.d.getDate()}` : ''}</button>`).join('');
  box.querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      // Al tocar un día se va a su mediodía (o a ahora si es hoy)
      const start = +b.dataset.i, n = +b.dataset.n;
      let target = start;
      for (let i = start; i < start + n; i++) if (new Date(S.grid.times[i] + ':00Z').getHours() === 12) target = i;
      if (start === S.t0) target = S.t0;
      setTime(target);
    };
  });
}

function updateSlider() {
  const r = el('mapRange');
  if (!r) return;
  const spec = LAYERS[S.layer];
  el('mapDays').classList.toggle('hidden', !!spec.kind);
  const o = obs();
  if (o) {
    r.min = 0; r.max = Math.max(0, o.times.length - 1); r.value = o.idx; r.disabled = o.times.length < 2;
  } else if (S.grid) {
    r.disabled = false; r.min = S.t0; r.max = S.grid.nt - 1; r.value = S.t;
  }
  el('mapTime').textContent = timeLabel();
  placeBubble();
  highlightStrip();
}

function setTime(i, frac = 0) {
  const o = obs();
  if (o) o.set(i); else { S.t = i; S.tf = frac; S.field.setTime(i, frac); if (!frac) refreshPick(); }
  const r = el('mapRange');
  if (r) r.value = i;
  el('mapTime').textContent = timeLabel();
  placeBubble();
  if (!frac) highlightStrip();
}

// Burbuja con la hora encima del deslizador, como en Windy
function placeBubble() {
  const r = el('mapRange'), b = el('tlBubble');
  if (!r || !b) return;
  const spec = LAYERS[S.layer];
  if (r.disabled) { b.classList.add('hidden'); return; }
  b.classList.remove('hidden');
  const min = +r.min, max = +r.max;
  const pos = max > min ? (+r.value + (S.tf || 0) - min) / (max - min) : 0;
  const w = r.clientWidth - 16;
  b.dataset.pos = pos;
  const o = obs();
  if (o) {
    b.textContent = o.times[o.idx] ? hhmmLocal(o.times[o.idx]) : '';
  } else if (S.grid) {
    const d = new Date(S.grid.times[S.t] + ':00Z');
    const mins = Math.round((S.tf || 0) * 60);
    b.textContent = `${DAYS_ES[d.getDay()]} ${String(d.getHours()).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
  }
  // Sin salirse por los lados
  const half = b.offsetWidth / 2;
  b.style.left = Math.max(half, Math.min(r.clientWidth - half, 8 + pos * w)) + 'px';
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

// ---------- Picker: valores del punto tocado, se actualiza al mover el tiempo ----------
function pickHtml(latlng) {
  const spec = LAYERS[S.layer];
  const s = (n) => S.field.sample(n, latlng.lat, latlng.lng);
  let main = '';
  if (!spec.kind) {
    const [, v] = spec.src(S.level);
    const val = s(v);
    const U = UNITS[spec.unit];
    let dir = '';
    if (spec.flow || S.layer === 'wind' || S.layer === 'gust') {
      const fk = spec.flow ? 'f_' + spec.flow : spec.levels ? 'f_' + S.level : 'f_surface';
      const u = s(fk + '_u'), w = s(fk + '_v');
      if (u !== null && w !== null) dir = f.arrow(spec.flow === 'currents' ? (Math.atan2(u, w) * 180 / Math.PI + 360) % 360 + 180 : (Math.atan2(-u, -w) * 180 / Math.PI + 360) % 360);
    }
    main = `<div class="pick-main">${dir}<b>${val === null ? '–' : (U.fmt(val) || '0')}</b> <span>${U.label()}</span></div>
      <div class="tiny">${spec.label}${spec.levels && S.level !== 'surface' ? ' · ' + LEVELS[S.level].label : ''}</div>`;
  }
  const u = s('f_surface_u'), w = s('f_surface_v');
  const dir = u !== null ? (Math.atan2(-u, -w) * 180 / Math.PI + 360) % 360 : null;
  return `${main}<div class="pick-sub">${f.temp(s('temperature_2m'), true)} · ${f.arrow(dir)} ${f.wind(s('wind_speed_10m'), true)} · ${f.precip(s('precipitation'), true)}/h</div>
    <button class="pick-more" data-detail>Pronóstico detallado ›</button>`;
}
function refreshPick() {
  if (!S.pick || !S.popup || !S.map.hasLayer(S.popup)) return;
  S.popup.setContent(pickHtml(S.pick));
}
function pickAt(latlng) {
  S.pick = latlng;
  const panelH = document.querySelector('.map-panel')?.offsetHeight || 200;
  S.popup = L.popup({ maxWidth: 260, autoPan: true, closeButton: false, autoPanPaddingTopLeft: [10, 110], autoPanPaddingBottomRight: [60, panelH + 16], className: 'pick-pop' }).setLatLng(latlng).setContent(pickHtml(latlng)).openOn(S.map);
  // El punto tocado pasa a ser el lugar seleccionado (como en Windy)
  S.marker.setLatLng(latlng);
  api.reverseGeocode(latlng.lat, latlng.lng).then((p) => {
    p.lat = latlng.lat; p.lon = latlng.lng;
    S.keepView = true;
    setPlace(p);
  });
}

// ---------- Pronóstico del punto (panel inferior) ----------
let fcData = null;
async function renderForecastStrip() {
  const box = el('mapFc');
  if (!box) return;
  const p = state.place;
  box.innerHTML = `<div class="fc-head"><span class="fc-title"><b>${f.esc(p.name)}</b><span class="tiny">Cargando pronóstico…</span></span></div>`;
  try {
    const d = await getForecast();
    fcData = d;
    const h = d.hourly;
    const key = d.current.time.slice(0, 13);
    let ni = h.time.findIndex((t) => t.slice(0, 13) === key);
    if (ni < 0) ni = 0;
    const c = d.current;
    let cells = '';
    for (let i = ni; i < Math.min(h.time.length, ni + 168); i++) {
      const t = h.time[i];
      const newDay = f.hh(t) === '00';
      const pr = h.precipitation[i];
      cells += `<button class="fc-cell${newDay ? ' daystart' : ''}${h.is_day[i] ? '' : ' night'}" data-t="${t}" title="${f.dayLong(t)} ${f.hhmm(t)}">
        <span class="fh">${newDay ? f.dayShort(t) : f.hh(t)}</span>
        ${wxIcon(h.weather_code[i], h.is_day[i])}
        <span class="ft">${f.temp(h.temperature_2m[i])}</span>
        <span class="fr">${pr >= 0.1 ? f.precip(pr) : ''}</span>
        <span class="fw">${f.arrow(h.wind_direction_10m[i])}${f.wind(h.wind_speed_10m[i])}</span>
      </button>`;
    }
    // Resumen de días (como la cabecera de Windy)
    const dd = d.daily;
    const ti = Math.max(0, dd.time.indexOf(c.time.slice(0, 10)));
    const days = dd.time.slice(ti, ti + 7).map((day, k) => `<button class="fc-day" data-day="${day}">
      <span class="tiny">${k === 0 ? 'Hoy' : f.dayShort(day)}</span>${wxIcon(dd.weather_code[ti + k], 1)}
      <span class="small"><b>${f.temp(dd.temperature_2m_max[ti + k])}</b> ${f.temp(dd.temperature_2m_min[ti + k])}</span></button>`).join('');
    box.innerHTML = `<div class="fc-head" id="fcHead">
        <span class="fc-now">${wxIcon(c.weather_code, c.is_day)}<b class="num">${f.temp(c.temperature_2m)}</b></span>
        <span class="fc-title"><b>${f.esc(p.name)}</b><span class="tiny">${wxDesc(c.weather_code)} · ${f.arrow(c.wind_direction_10m)} ${f.wind(c.wind_speed_10m, true)} · rachas ${f.wind(c.wind_gusts_10m)}</span></span>
        <button class="small fc-detail" id="fcDetail">Detalle</button>
        <button class="fc-toggle" id="fcToggle" aria-label="Plegar"><svg viewBox="0 0 24 24"><path d="M7 14l5-5 5 5z"/></svg></button>
      </div>
      <div class="fc-days">${days}</div>
      <div class="fc-strip" id="fcStrip">${cells}</div>`;
    box.querySelectorAll('.fc-cell').forEach((b) => { b.onclick = () => jumpToLocal(b.dataset.t); });
    el('fcDetail').onclick = () => openDetail(el('view-map'));
    box.querySelector('.fc-title').onclick = () => openDetail(el('view-map'));
    box.querySelectorAll('.fc-day').forEach((b) => { b.onclick = () => jumpToLocal(b.dataset.day + (b.dataset.day === c.time.slice(0, 10) ? c.time.slice(10, 13) + ':00' : 'T12:00')); });
    // Por defecto compacto (como Windy): días; al desplegar, también hora a hora
    el('fcToggle').onclick = () => {
      const open = !box.classList.contains('expanded');
      box.classList.toggle('expanded', open);
      save('map.fcExpanded', open);
    };
    box.classList.toggle('expanded', load('map.fcExpanded', false));
    highlightStrip();
  } catch (e) {
    box.innerHTML = `<div class="fc-head"><span class="fc-title"><b>${f.esc(p.name)}</b><span class="tiny">Sin datos: ${f.esc(e.message)}</span></span></div>`;
  }
}

// Hora local del lugar → índice de la rejilla del mapa (UTC)
function jumpToLocal(localT) {
  if (!S.grid || !fcData) return;
  const utc = new Date(Date.parse(localT + ':00Z') - fcData.utc_offset_seconds * 1000).toISOString().slice(0, 13);
  const i = S.grid.times.findIndex((t) => t.slice(0, 13) === utc);
  if (i < 0) { toast('Esa hora queda fuera del horizonte del mapa (amplíalo en opciones)'); return; }
  if (LAYERS[S.layer].kind) { S.layer = 'wind'; applyLayer(); }
  setTime(Math.max(S.t0, i));
  const strip = el('fcStrip');
  if (strip) {
    const cell = strip.querySelector(`[data-t="${localT}"]`);
    if (cell) strip.scrollTo({ left: cell.offsetLeft - 8, behavior: 'smooth' });
  }
}

function highlightStrip() {
  const g = S.grid;
  const strip = el('fcStrip');
  if (!strip || !g || !fcData || LAYERS[S.layer].kind) return;
  const local = new Date(Date.parse(g.times[S.t] + ':00Z') + fcData.utc_offset_seconds * 1000).toISOString().slice(0, 13);
  let target = null;
  strip.querySelectorAll('.fc-cell').forEach((c) => {
    const on = c.dataset.t.slice(0, 13) === local;
    c.classList.toggle('sel', on);
    if (on) target = c;
  });
  if (target && S.playing) strip.scrollTo({ left: target.offsetLeft - strip.clientWidth / 2 + target.clientWidth / 2, behavior: 'smooth' });
}

// ---------- Interfaz ----------
function renderChips() {
  const box = el('mapLayers');
  const list = QUICK.includes(S.layer) ? QUICK : [S.layer, ...QUICK];
  box.innerHTML = `<div class="chips">
    <button class="chip chip-layers" id="openLayers"><svg viewBox="0 0 24 24"><path d="M12 16l-7.4-5.7L3 11.5 12 18.5l9-7-1.6-1.2zm0-2.5l7.4-5.7L21 6.5 12-.5 3 6.5l1.6 1.3z" transform="translate(0 3)"/></svg>Capas</button>
    ${list.map((k) => `<button class="chip${k === S.layer ? ' on' : ''}" data-v="${k}">${LAYERS[k].short || LAYERS[k].label}</button>`).join('')}
  </div>
  ${LAYERS[S.layer].levels ? `<div class="chips levels">${Object.entries(LEVELS).map(([k, v]) => `<button class="chip${k === S.level ? ' on' : ''}" data-lv="${k}">${v.label}</button>`).join('')}</div>` : ''}`;
  box.querySelectorAll('[data-v]').forEach((b) => { b.onclick = () => selectLayer(b.dataset.v); });
  box.querySelectorAll('[data-lv]').forEach((b) => {
    b.onclick = () => { S.level = b.dataset.lv; applyLayer(); };
  });
  el('openLayers').onclick = () => el('layerSheet').classList.toggle('hidden');
  const on = box.querySelector('.chip.on');
  if (on) on.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

function selectLayer(k) {
  S.layer = k;
  stopPlay();
  el('layerSheet').classList.add('hidden');
  applyLayer();
}

function buildLayerSheet() {
  const cats = {};
  for (const [k, v] of Object.entries(LAYERS)) (cats[v.cat] ||= []).push(k);
  el('layerSheet').innerHTML = `<div class="ls-head"><b>Capas</b><button class="icon-btn" id="closeLayers">✕</button></div>
    ${Object.entries(cats).map(([cat, keys]) => `<h3>${cat}</h3><div class="ls-grid">${keys.map((k) => `<button class="ls-item${k === S.layer ? ' on' : ''}" data-v="${k}">${LAYERS[k].label}</button>`).join('')}</div>`).join('')}
    <p class="tiny">Las capas de mar y aire solo muestran datos sobre el mar o donde hay modelo de calidad del aire (CAMS).</p>`;
  el('layerSheet').querySelectorAll('[data-v]').forEach((b) => { b.onclick = () => { selectLayer(b.dataset.v); buildLayerSheet(); }; });
  el('closeLayers').onclick = () => el('layerSheet').classList.add('hidden');
}

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
    <div class="map-layers" id="mapLayers"></div>
    <div class="map-side">
      <button id="mapMenuBtn" title="Opciones del mapa"><svg viewBox="0 0 24 24"><path d="M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7 7 0 0 0-1.7-1L15 3h-4l-.4 2.7a7 7 0 0 0-1.7 1l-2.5-1-2 3.5L6.5 11a7.5 7.5 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7 7 0 0 0 1.7 1L11 21h4l.4-2.7a7 7 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/></svg></button>
      <button id="mapParticles" title="Partículas animadas"><svg viewBox="0 0 24 24"><path d="M3 8h10.5A2.5 2.5 0 1 0 11 5.5h-2A4.5 4.5 0 1 1 13.5 10H3zm0 4h15.5a3.5 3.5 0 1 1-3.5 3.5h2a1.5 1.5 0 1 0 1.5-1.5H3zm0-8h4v2H3z"/></svg></button>
      <button id="mapIso" title="Isolíneas"><svg viewBox="0 0 24 24"><path d="M12 4C7 4 3 7.6 3 12s4 8 9 8 9-3.6 9-8-4-8-9-8zm0 14c-3.9 0-7-2.7-7-6s3.1-6 7-6 7 2.7 7 6-3.1 6-7 6zm0-10c-2.2 0-4 1.8-4 4s1.8 4 4 4 4-1.8 4-4-1.8-4-4-4zm0 6a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/></svg></button>
      <button id="mapValues" title="Valores en el mapa"><svg viewBox="0 0 24 24"><text x="12" y="16.5" text-anchor="middle" font-size="11" font-weight="800" font-family="system-ui">123</text></svg></button>
      <button id="mapHome" title="Ir a mi lugar"><svg viewBox="0 0 24 24"><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm9 3h-2.1A7 7 0 0 0 13 5.1V3h-2v2.1A7 7 0 0 0 5.1 11H3v2h2.1a7 7 0 0 0 5.9 5.9V21h2v-2.1a7 7 0 0 0 5.9-5.9H21z"/></svg></button>
    </div>
    <div class="map-menu hidden" id="mapMenu"></div>
    <div class="layer-sheet hidden" id="layerSheet"></div>
    <div class="map-panel">
      <div class="map-fc" id="mapFc"></div>
      <div class="map-time">
        <button class="play-btn" id="mapPlay">${ICON.play}</button>
        <div class="tl">
          <span class="tl-bubble hidden" id="tlBubble"></span>
          <input type="range" id="mapRange" min="0" max="0" value="0">
          <div class="tl-days" id="mapDays"></div>
        </div>
      </div>
      <div class="map-legend" id="mapLegend"></div>
      <div id="mapSatSel" class="hidden" style="margin-top:6px"></div>
      <button class="map-status" id="mapStatus"><span id="mapTime">—</span> · <span id="mapStatusTxt"></span> ▾</button>
    </div>`;

  renderChips();
  buildLayerSheet();
  el('mapSatSel').append(selectEl(Object.entries(SATS).map(([k, v]) => [k, v.label]), S.sat, (v) => { S.sat = v; stopPlay(); showSat(); updateSlider(); }));
  el('mapRange').addEventListener('input', (e) => setTime(+e.target.value));
  // Atajos: ← → hora anterior/siguiente, espacio reproducir
  document.addEventListener('keydown', (e) => {
    if (!root.classList.contains('active') || e.target.closest('input[type=search], select, textarea')) return;
    const r = el('mapRange');
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const v = clampInt(+r.value + (e.key === 'ArrowRight' ? 1 : -1), +r.min, +r.max);
      setTime(v);
    } else if (e.key === ' ') {
      e.preventDefault();
      togglePlay();
    }
  });
  window.addEventListener('resize', placeBubble);
  el('mapPlay').onclick = togglePlay;
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
  el('mapMenuBtn').onclick = () => el('mapMenu').classList.toggle('hidden');
  el('mapStatus').onclick = () => el('mapMenu').classList.toggle('hidden');
  sideState();
  buildMenu();
}

function buildMenu() {
  const m = el('mapMenu');
  const radio = (name, opts, cur) => opts.map(([v, l]) => `<label><input type="radio" name="${name}" value="${v}" ${v === cur ? 'checked' : ''}> ${l}</label>`).join('');
  m.innerHTML = `
    <h3>Modelo</h3><div id="mapModelSel"></div>
    <h3>Mapa base</h3>${radio('base', [['dark', 'Oscuro'], ['light', 'Claro'], ['imagery', 'Satélite (foto)'], ['osm', 'OpenStreetMap'], ['topo', 'Topográfico']], settings.mapBase)}
    <h3>Horizonte</h3>${radio('days', [['2', '2 días'], ['3', '3 días'], ['5', '5 días'], ['7', '7 días'], ['10', '10 días']], String(S.days))}
    <h3>Isolíneas</h3>${radio('iso', ISO_MODES, S.iso)}
    <h3>Líneas y nombres</h3><label><input type="checkbox" name="borders" ${S.borders ? 'checked' : ''}> Costas, fronteras y provincias</label>
    <label><input type="checkbox" name="cities" ${S.cities ? 'checked' : ''}> Ciudades con su valor</label>
    <h3>Resolución</h3>${radio('grid', [['low', 'Baja (menos datos)'], ['normal', 'Normal'], ['high', 'Alta (más peticiones)']], settings.mapGrid)}
    <p class="tiny" style="margin:8px 0 0">El mapa interpola una rejilla de puntos del modelo. Más resolución u horizonte = más detalle, pero consume más cuota gratuita (10.000 llamadas/día).</p>`;
  m.querySelector('#mapModelSel').append(selectEl(api.MODELS.map((x) => [x.id, x.name]), settings.model, (v) => {
    settings.model = v; saveSettings();
  }));
  m.onchange = (e) => {
    const { name, value } = e.target;
    if (name === 'base') { settings.mapBase = value; saveSettings(); }
    if (name === 'grid') { settings.mapGrid = value; saveSettings(); }
    if (name === 'days') { S.days = +value; loadData(true); }
    if (name === 'iso') { S.iso = value; save('map.iso', value); sideState(); prepareLayer(); }
    if (name === 'borders') { S.borders = e.target.checked; save('map.borders', S.borders); showBorders(); }
    if (name === 'cities') {
      S.cities = e.target.checked;
      save('map.cities', S.cities);
      if (S.labels) { if (S.cities) S.map.removeLayer(S.labels); else S.labels.addTo(S.map); }
      prepareLayer();
    }
  };
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
      const map = L.map('map', { zoomControl: true, worldCopyJump: false, minZoom: 2, maxBounds: [[-85, -200], [85, 200]] })
        .setView(view ? [view[0], view[1]] : [state.place.lat, state.place.lon], view ? view[2] : 6);
      S.map = map;
      map.createPane('labelsPane').style.zIndex = 380;
      map.createPane('bordersPane').style.zIndex = 365;
      map.getPane('bordersPane').style.pointerEvents = 'none';
      map.getPane('labelsPane').style.pointerEvents = 'none';
      // La atribución va justo encima del panel inferior, que cambia de altura
      const panel = root.querySelector('.map-panel');
      const fitAttribution = () => {
        const br = map.getContainer().querySelector('.leaflet-bottom.leaflet-right');
        if (br) br.style.bottom = panel.offsetHeight + 10 + 'px';
      };
      new ResizeObserver(fitAttribution).observe(panel);
      fitAttribution();
      setBase();
      S.field = new FieldLayer(map);
      showBorders();
      map.on('zoomend', toggleRegions);
      geoData('cities').then((c) => S.field.setCities(c)).catch(() => {});
      updatePlaces();
      on('favorites', updatePlaces);
      S.marker = L.marker([state.place.lat, state.place.lon], { icon: L.divIcon({ className: '', html: '<div class="pin"></div>', iconSize: [16, 16] }) }).addTo(map);
      map.on('moveend', loadDebounced);
      map.on('moveend', () => save('map.view', [map.getCenter().lat, map.getCenter().lng, map.getZoom()]));
      // Un toque elige el punto; si llega un segundo toque (doble toque = zoom) se cancela
      let clickTimer = null;
      map.on('click', (e) => {
        el('mapMenu').classList.add('hidden');
        el('layerSheet').classList.add('hidden');
        clearTimeout(clickTimer);
        clickTimer = setTimeout(() => pickAt(e.latlng), 280);
      });
      map.on('dblclick', () => clearTimeout(clickTimer));
      map.getContainer().addEventListener('click', (e) => {
        if (e.target.closest('[data-detail]')) { e.stopPropagation(); S.map.closePopup(); openDetail(el('view-map')); }
      }, true);
      map.whenReady(() => { S.field.redraw(); loadData(true); });
      renderForecastStrip();
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
    if (!S.keepView && !S.map.getBounds().pad(-0.1).contains(ll)) S.map.setView(ll, S.map.getZoom());
    const modelChanged = S.modelKey && S.modelKey !== settings.model;
    S.modelKey = settings.model;
    S.keepView = false;
    buildMenu();
    renderForecastStrip();
    if (detailOpen()) openDetail(root);
    updatePlaces();
    prepareLayer();
    loadData(modelChanged || settings.mapGrid !== S.gridRes);
    S.gridRes = settings.mapGrid;
  },
  show() {
    if (!S.map) return;
    S.map.invalidateSize();
    S.field.redraw();
  },
  hide() {
    stopPlay();
    closeDetail();
    S.field?.stop();
  },
};
S.modelKey = settings.model;
S.gridRes = settings.mapGrid;
