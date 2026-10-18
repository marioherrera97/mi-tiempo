// Arranque de la app: navegación, cabecera y buscador de lugares
import { state, on, setPlace, toggleFavorite, isFavorite, removeRecent } from './state.js';
import * as api from './api.js';
import { refresh } from './data.js';
import { $, $$, openSheet, closeSheet, initSheets, toast, debounce } from './ui.js';
import { flag, esc } from './format.js';
import home from './views/home.js';
import hourly from './views/hourly.js';
import map from './views/map.js';
import trend from './views/trend.js';
import more from './views/more.js';
import compare from './views/compare.js';
import marine from './views/marine.js';
import air from './views/air.js';
import history from './views/history.js';
import settingsView from './views/settings.js';

const VIEWS = {
  inicio: home, horas: hourly, mapa: map, tendencia: trend, mas: more,
  modelos: compare, mar: marine, aire: air, historico: history, ajustes: settingsView,
};
const PARENT_TAB = { modelos: 'mas', mar: 'mas', aire: 'mas', historico: 'mas', ajustes: 'mas' };

let current = null;
const dirty = new Set(Object.keys(VIEWS));

function viewEl(name) { return $(`.view[data-route="${name}"]`); }

function route() {
  const r = (location.hash.replace(/^#\/?/, '') || 'mapa').split('?')[0];
  const name = VIEWS[r] ? r : 'mapa';
  if (current && current !== name) VIEWS[current].hide?.();
  $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.route === name));
  // El mapa ocupa toda la pantalla, como Windy (sin barra superior ni pestañas)
  document.body.classList.toggle('map-mode', name === 'mapa');
  $$('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === (PARENT_TAB[name] || name)));
  const changed = current !== name;
  current = name;
  if (dirty.has(name)) {
    dirty.delete(name);
    VIEWS[name].render(viewEl(name));
  } else {
    VIEWS[name].show?.(viewEl(name));
  }
  if (changed && name !== 'mapa') window.scrollTo(0, 0);
}

function invalidateAll() {
  Object.keys(VIEWS).forEach((k) => dirty.add(k));
  if (current) {
    dirty.delete(current);
    VIEWS[current].render(viewEl(current));
  }
}

function updateHeader() {
  const p = state.place;
  $('#placeName').textContent = p.name;
  $('#placeSub').textContent = [p.admin, p.country].filter(Boolean).join(' · ') || `${p.lat.toFixed(3)}, ${p.lon.toFixed(3)}`;
  $('#favBtn').classList.toggle('on', isFavorite());
  document.title = `${p.name} · Mi Tiempo`;
}

// ---------- Buscador de lugares ----------
function placeItem(p, kind) {
  const sub = [p.admin, p.country].filter(Boolean).join(', ');
  return `<button class="place-item" data-kind="${kind}" data-p='${esc(JSON.stringify(p))}'>
    <span class="flag">${flag(p.cc)}</span>
    <span class="pi-main"><b>${esc(p.name)}</b><small>${esc(sub)}${p.elevation != null ? ` · ${Math.round(p.elevation)} m` : ''}</small></span>
    ${kind !== 'result' ? `<span class="del" data-del title="Quitar">✕</span>` : ''}
  </button>`;
}

function renderSavedPlaces() {
  const box = $('#placeResults');
  let h = '';
  if (state.favorites.length) h += `<div class="list-label">Favoritos</div>` + state.favorites.map((p) => placeItem(p, 'fav')).join('');
  if (state.recents.length) h += `<div class="list-label">Recientes</div>` + state.recents.map((p) => placeItem(p, 'recent')).join('');
  if (!h) h = `<p class="note" style="padding:12px 8px">Busca cualquier lugar del mundo. También puedes tocar el mapa para ver el pronóstico de un punto exacto.</p>`;
  box.innerHTML = h;
}

const doSearch = debounce(async (q) => {
  const box = $('#placeResults');
  if (q.trim().length < 2) { renderSavedPlaces(); return; }
  box.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  try {
    const res = await api.geocode(q.trim());
    box.innerHTML = res.length ? res.map((p) => placeItem(p, 'result')).join('') : '<p class="note" style="padding:12px 8px">Sin resultados.</p>';
  } catch (e) {
    box.innerHTML = `<p class="note" style="padding:12px 8px">Error al buscar: ${esc(e.message)}</p>`;
  }
}, 300);

function initPlaceSheet() {
  $('#placeBtn').onclick = () => {
    $('#placeSearch').value = '';
    renderSavedPlaces();
    openSheet('placeSheet');
    setTimeout(() => $('#placeSearch').focus(), 50);
  };
  $('#placeSearch').addEventListener('input', (e) => doSearch(e.target.value));
  $('#placeResults').addEventListener('click', (e) => {
    const item = e.target.closest('.place-item');
    if (!item) return;
    const p = JSON.parse(item.dataset.p);
    if (e.target.closest('[data-del]')) {
      if (item.dataset.kind === 'fav') toggleFavorite(p); else removeRecent(p);
      renderSavedPlaces();
      return;
    }
    closeSheet('placeSheet');
    setPlace(p);
  });
  $('#gpsBtn').onclick = locate;
}

export function locate() {
  if (!navigator.geolocation) { toast('Tu navegador no permite la geolocalización'); return; }
  toast('Buscando tu ubicación…');
  navigator.geolocation.getCurrentPosition(async (pos) => {
    const { latitude, longitude } = pos.coords;
    const p = await api.reverseGeocode(latitude, longitude);
    closeSheet('placeSheet');
    setPlace(p);
    toast(`Ubicación: ${p.name}`);
  }, (err) => {
    toast(err.code === 1 ? 'Permiso de ubicación denegado' : 'No se pudo obtener la ubicación (necesita HTTPS)');
  }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 });
}

// ---------- Inicio ----------
function init() {
  initSheets();
  initPlaceSheet();
  updateHeader();

  $('#favBtn').onclick = () => {
    toggleFavorite();
    toast(isFavorite() ? 'Guardado en favoritos' : 'Quitado de favoritos');
  };
  $('#refreshBtn').onclick = () => {
    const b = $('#refreshBtn');
    b.classList.add('spin');
    refresh();
    setTimeout(() => b.classList.remove('spin'), 900);
  };

  on('place', () => { updateHeader(); invalidateAll(); });
  on('favorites', updateHeader);
  on('settings', invalidateAll);
  on('refresh', invalidateAll);

  window.addEventListener('hashchange', route);
  route();

  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if ('serviceWorker' in navigator && (!isLocal || location.search.includes('sw'))) {
    // Cuando se publica una versión nueva, el service worker se activa y la app se recarga sola
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) location.reload(); });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => reg.update()).catch(() => {});
  }
}

init();
