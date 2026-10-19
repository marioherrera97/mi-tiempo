// Vista "Mapa 3D": el relieve en tres dimensiones (MapLibre GL con el modelo de elevación de AWS Terrain Tiles)
// con el radar de lluvia de RainViewer y las nubes de Meteosat encima. Se inclina con dos dedos o con el botón.
import { state, load, save } from '../state.js';
import * as api from '../api.js';
import { toast } from '../ui.js';

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
const DEM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const BASES = {
  sat: [ESRI + 'World_Imagery/MapServer/tile/{z}/{y}/{x}', 'Esri, Maxar, Earthstar'],
  topo: [ESRI + 'World_Topo_Map/MapServer/tile/{z}/{y}/{x}', 'Esri, HERE, OpenStreetMap'],
  dark: [ESRI + 'Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', 'Esri, HERE, OpenStreetMap'],
};
const S = { map: null, opts: { base: 'sat', radar: true, clouds: true, ...load('relief.opts', {}) } };

// MapLibre solo se descarga al abrir esta vista (pesa ~800 kB)
let lib = null;
function loadLib() {
  return (lib ||= new Promise((res, rej) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'vendor/maplibre/maplibre-gl.css';
    document.head.append(css);
    const s = document.createElement('script');
    s.src = 'vendor/maplibre/maplibre-gl.js';
    s.onload = () => res(window.maplibregl);
    s.onerror = () => { lib = null; rej(new Error('No se pudo cargar el mapa 3D')); };
    document.head.append(s);
  }));
}

function style() {
  const [url, attr] = BASES[S.opts.base];
  return {
    version: 8,
    sources: {
      base: { type: 'raster', tiles: [url], tileSize: 256, maxzoom: 18, attribution: attr },
      places: { type: 'raster', tiles: [ESRI + 'Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 18 },
      dem: { type: 'raster-dem', tiles: [DEM], tileSize: 256, maxzoom: 14, encoding: 'terrarium', attribution: 'Relieve: AWS Terrain Tiles (Mapzen)' },
      shade: { type: 'raster-dem', tiles: [DEM], tileSize: 256, maxzoom: 12, encoding: 'terrarium' },
      clouds: {
        type: 'raster', tileSize: 256, attribution: 'Nubes: EUMETSAT',
        tiles: ['https://view.eumetsat.int/geoserver/wms?service=WMS&request=GetMap&version=1.3.0&layers=msg_fes:ir108&styles=&format=image/png&transparent=true&crs=EPSG:3857&width=256&height=256&bbox={bbox-epsg-3857}'],
      },
    },
    layers: [
      { id: 'base', type: 'raster', source: 'base', paint: { 'raster-fade-duration': 0 } },
      { id: 'shade', type: 'hillshade', source: 'shade', paint: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#0b1220' } },
      { id: 'clouds', type: 'raster', source: 'clouds', layout: { visibility: S.opts.clouds ? 'visible' : 'none' },
        paint: { 'raster-opacity': 0.55, 'raster-contrast': 0.5, 'raster-brightness-min': 0.05, 'raster-fade-duration': 0 } },
      { id: 'places', type: 'raster', source: 'places', paint: { 'raster-opacity': 0.9 } },
    ],
    terrain: { source: 'dem', exaggeration: 1.5 },
    sky: { 'sky-color': '#7fb3e8', 'horizon-color': '#cfe3f5', 'fog-color': '#cfe3f5', 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.4 },
  };
}

async function addRadar() {
  const m = S.map;
  if (m.getLayer('radar')) m.removeLayer('radar');
  if (m.getSource('radar')) m.removeSource('radar');
  if (!S.opts.radar) { S.timeEl.textContent = ''; return; }
  try {
    const d = await api.radarFrames();
    const fr = d.radar?.past?.[d.radar.past.length - 1];
    if (!fr) return;
    m.addSource('radar', { type: 'raster', tiles: [`${d.host}${fr.path}/256/{z}/{x}/{y}/2/1_1.png`], tileSize: 256, maxzoom: 7, attribution: 'Radar: RainViewer' });
    m.addLayer({ id: 'radar', type: 'raster', source: 'radar', paint: { 'raster-opacity': 0.85, 'raster-fade-duration': 0 } }, 'places');
    const t = new Date(fr.time * 1000);
    S.timeEl.textContent = `Radar ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  } catch {
    S.timeEl.textContent = 'Radar no disponible';
  }
}

function setOpt(k, v) {
  S.opts[k] = v;
  save('relief.opts', S.opts);
  const m = S.map;
  if (k === 'base') { m.setStyle(style()); m.once('style.load', addRadar); }
  if (k === 'clouds') m.setLayoutProperty('clouds', 'visibility', v ? 'visible' : 'none');
  if (k === 'radar') addRadar();
  syncButtons();
}
function syncButtons() {
  S.root.querySelectorAll('[data-base]').forEach((b) => b.classList.toggle('on', b.dataset.base === S.opts.base));
  S.root.querySelector('[data-t="radar"]').classList.toggle('on', S.opts.radar);
  S.root.querySelector('[data-t="clouds"]').classList.toggle('on', S.opts.clouds);
}

export default {
  async render(root) {
    S.root = root;
    if (S.map) { this.show(); S.map.flyTo({ center: [state.place.lon, state.place.lat], zoom: Math.max(S.map.getZoom(), 8), essential: true }); return; }
    root.innerHTML = `<div id="relief3d" class="r3-map"></div>
      <div class="r3-bar">
        <div class="r3-group"><button data-base="sat">Satélite</button><button data-base="topo">Mapa</button><button data-base="dark">Oscuro</button></div>
        <div class="r3-group"><button data-t="radar">🌧️ Radar</button><button data-t="clouds">☁️ Nubes</button></div>
      </div>
      <div class="r3-side"><button id="r3Tilt" title="Inclinar">3D</button><button id="r3Here" title="Ir a mi lugar"><svg viewBox="0 0 24 24"><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm9 3h-2.1A7 7 0 0 0 13 5.1V3h-2v2.1A7 7 0 0 0 5.1 11H3v2h2.1a7 7 0 0 0 5.9 5.9V21h2v-2.1a7 7 0 0 0 5.9-5.9H21z"/></svg></button></div>
      <div class="r3-time" id="r3Time"></div>
      <div class="r3-load" id="r3Load"><div class="spinner"></div>Cargando relieve…</div>`;
    S.timeEl = root.querySelector('#r3Time');
    let gl;
    try { gl = await loadLib(); } catch (e) { root.querySelector('#r3Load').textContent = e.message; return; }
    const probe = document.createElement('canvas');
    if (!(probe.getContext('webgl2') || probe.getContext('webgl'))) {
      root.querySelector('#r3Load').textContent = 'Este navegador no puede mostrar mapas 3D (WebGL desactivado).';
      return;
    }
    const v = load('relief.view', null);
    const map = new gl.Map({
      container: root.querySelector('#relief3d'),
      style: style(),
      center: v ? [v[0], v[1]] : [state.place.lon, state.place.lat],
      zoom: v ? v[2] : 8.5, pitch: v ? v[3] : 62, bearing: v ? v[4] : -15,
      maxPitch: 80, maxZoom: 16, minZoom: 3,
      pixelRatio: Math.min(window.devicePixelRatio || 1, 2), // en móviles de pantalla 3x se nota mucho en fluidez
      fadeDuration: 0, attributionControl: { compact: true },
    });
    S.map = map;
    map.addControl(new gl.NavigationControl({ visualizePitch: true, showZoom: false }), 'bottom-right');
    map.on('load', () => {
      root.querySelector('#r3Load')?.remove();
      addRadar();
      // Créditos plegados en la «i» para que no tapen el mapa
      root.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
    });
    map.on('error', (e) => { if (/WebGL/i.test(e?.error?.message || '')) toast('Problema con el mapa 3D'); });
    map.on('moveend', () => { const c = map.getCenter(); save('relief.view', [c.lng, c.lat, map.getZoom(), map.getPitch(), map.getBearing()]); });
    root.querySelectorAll('[data-base]').forEach((b) => { b.onclick = () => setOpt('base', b.dataset.base); });
    root.querySelectorAll('[data-t]').forEach((b) => { b.onclick = () => setOpt(b.dataset.t, !S.opts[b.dataset.t]); });
    root.querySelector('#r3Tilt').onclick = () => map.easeTo({ pitch: map.getPitch() > 20 ? 0 : 62, duration: 700 });
    root.querySelector('#r3Here').onclick = () => map.flyTo({ center: [state.place.lon, state.place.lat], zoom: 9.5, pitch: 62, essential: true });
    syncButtons();
    // El radar se renueva cada 10 minutos
    setInterval(() => { if (S.map && S.root.classList.contains('active') && S.opts.radar) addRadar(); }, 10 * 60e3);
  },
  show() { S.map?.resize(); },
};
