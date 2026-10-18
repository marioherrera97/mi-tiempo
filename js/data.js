// Pronóstico compartido entre vistas (una sola petición por lugar y modelo)
import { state, settings, emit } from './state.js';
import * as api from './api.js';

let promise = null;
let key = '';
export let lastUpdate = 0;

export function getForecast(model = settings.model) {
  const k = `${state.place.lat},${state.place.lon},${model}`;
  if (k !== key || !promise) {
    key = k;
    promise = api.forecast(state.place, model)
      .then((d) => { lastUpdate = Date.now(); return d; })
      .catch((e) => { promise = null; throw e; });
  }
  return promise;
}

export function refresh() {
  api.clearCache();
  promise = null;
  emit('refresh');
}
