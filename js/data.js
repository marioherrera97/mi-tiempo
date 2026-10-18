// Pronóstico compartido entre vistas (una sola petición por lugar y modelo).
// Si Open-Meteo falla o se agota su cuota, se usa MET Noruega como respaldo.
import { state, settings, emit } from './state.js';
import * as api from './api.js';
import { metForecast } from './metno.js';

let promise = null;
let key = '';
export let lastUpdate = 0;

export function getForecast(model = settings.model) {
  const k = `${state.place.lat},${state.place.lon},${model}`;
  if (k !== key || !promise) {
    key = k;
    promise = api.forecast(state.place, model)
      .catch(async (e) => {
        try {
          const d = await metForecast(state.place);
          d.fallbackReason = e.message;
          return d;
        } catch {
          throw e; // sin respaldo: se muestra el error original
        }
      })
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
