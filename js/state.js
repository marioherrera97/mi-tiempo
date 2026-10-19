// Estado global: ajustes, ubicación actual, favoritos y recientes (guardados en localStorage)
const PREFIX = 'mitiempo.';

export function load(key, def) {
  try {
    const v = localStorage.getItem(PREFIX + key);
    return v ? JSON.parse(v) : def;
  } catch { return def; }
}
export function save(key, value) {
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* sin espacio o modo privado */ }
}

export const DEFAULT_SETTINGS = {
  temp: 'c',          // c | f
  wind: 'kmh',        // kmh | ms | kn | mph | bft
  precip: 'mm',       // mm | in
  pressure: 'hpa',    // hpa | inhg | mmhg
  distance: 'km',     // km | mi
  model: 'best_match',
  theme: 'auto',      // auto | dark | light
  mapGrid: 'normal',  // low | normal | high
  mapBase: 'dark',    // dark | light | osm | topo
};

export const settings = Object.assign({}, DEFAULT_SETTINGS, load('settings', {}));

export const state = {
  place: load('place', {
    name: 'Madrid', admin: 'Comunidad de Madrid', country: 'España', cc: 'ES', lat: 40.4168, lon: -3.7038,
  }),
  favorites: load('favorites', []),
  recents: load('recents', []),
};

const listeners = {};
export function on(evt, fn) { (listeners[evt] ||= []).push(fn); }
export function emit(evt, data) { (listeners[evt] || []).forEach((fn) => fn(data)); }

export function saveSettings() {
  save('settings', settings);
  emit('settings');
}

const samePlace = (a, b) => Math.abs(a.lat - b.lat) < 0.01 && Math.abs(a.lon - b.lon) < 0.01;

export function setPlace(p, { recent = true } = {}) {
  state.place = p;
  save('place', p);
  if (recent) {
    state.recents = [p, ...state.recents.filter((r) => !samePlace(r, p))].slice(0, 8);
    save('recents', state.recents);
  }
  emit('place', p);
}

// Completa datos del lugar (provincia, país) sin volver a cargar las vistas
export function updatePlaceInfo(p, info) {
  const same = (r) => samePlace(r, p);
  for (const r of [state.place, ...state.recents].filter(same)) Object.assign(r, info);
  if (!same(state.place)) return;
  save('place', state.place);
  save('recents', state.recents);
  emit('placeinfo', state.place);
}

export function isFavorite(p = state.place) {
  return state.favorites.some((f) => samePlace(f, p));
}
export function toggleFavorite(p = state.place) {
  if (isFavorite(p)) state.favorites = state.favorites.filter((f) => !samePlace(f, p));
  else state.favorites = [...state.favorites, p];
  save('favorites', state.favorites);
  emit('favorites');
}
export function removeRecent(p) {
  state.recents = state.recents.filter((r) => !samePlace(r, p));
  save('recents', state.recents);
}
