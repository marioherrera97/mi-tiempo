// Normales climáticas 1991–2020 (ERA5) de un lugar, compartidas por Histórico y Embalses.
// Son 30 años de datos diarios: para Open-Meteo, unas 780 consultas (cuenta una cada 2 semanas de datos), más que
// todo el límite de un minuto. Por eso se piden en 6 tramos de 5 años (~130 consultas cada uno, que js/api.js espacia
// si hace falta), una sola vez por celda de ERA5 (0,25°, ~25 km: los puntos cercanos la reutilizan), y se guardan.
import * as api from './api.js';
import { load, save } from './state.js';
import * as f from './format.js';

const CELL = 0.25;
const cellOf = (p) => ({ lat: Math.round(p.lat / CELL) * CELL, lon: Math.round(p.lon / CELL) * CELL });
const key = (c) => `clim:${c.lat.toFixed(2)},${c.lon.toFixed(2)}`;
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);

export const savedNormals = (p) => load(key(cellOf(p)), null);
export const forgetNormals = (p) => save(key(cellOf(p)), null);

const running = new Map();
// onProgress(0..1) mientras se descarga. Devuelve:
// { months: [{ mx, mn, pr, rainy }] × 12, days: { 'MM-DD': { mx, mn, pr, recMax: [v, año], recMin: [v, año] } } }
export function normals(p, onProgress = () => {}) {
  const c = cellOf(p), k = key(c);
  const saved = load(k, null);
  if (saved) return Promise.resolve(saved);
  if (running.has(k)) return running.get(k);
  const job = (async () => {
    const months = Array.from({ length: 12 }, () => ({ mx: [], mn: [], pr: 0, rainy: 0 }));
    const byDoy = {};
    for (let y = 1991, i = 0; y <= 2016; y += 5, i++) {
      onProgress(i / 6);
      const d = (await api.archive(c, `${y}-01-01`, `${y + 4}-12-31`, ['temperature_2m_max', 'temperature_2m_min', 'precipitation_sum'], { ttl: 30 * 864e5, background: true })).daily;
      d.time.forEach((t, j) => {
        const m = +t.slice(5, 7) - 1, md = t.slice(5, 10);
        const mx = d.temperature_2m_max[j], mn = d.temperature_2m_min[j], pr = d.precipitation_sum[j];
        const b = (byDoy[md] ||= { mx: [], mn: [], pr: 0, npr: 0, recMax: [-99, ''], recMin: [99, ''] });
        if (f.isNum(mx)) { months[m].mx.push(mx); b.mx.push(mx); if (mx > b.recMax[0]) b.recMax = [mx, t.slice(0, 4)]; }
        if (f.isNum(mn)) { months[m].mn.push(mn); b.mn.push(mn); if (mn < b.recMin[0]) b.recMin = [mn, t.slice(0, 4)]; }
        if (f.isNum(pr)) { months[m].pr += pr; if (pr >= 1) months[m].rainy++; b.pr += pr; b.npr++; }
      });
    }
    onProgress(1);
    const res = {
      months: months.map((m) => ({ mx: mean(m.mx), mn: mean(m.mn), pr: m.pr / 30, rainy: m.rainy / 30 })),
      days: Object.fromEntries(Object.entries(byDoy).map(([md, b]) => [md, {
        mx: mean(b.mx), mn: mean(b.mn), pr: b.npr ? +(b.pr / b.npr).toFixed(2) : null, recMax: b.recMax, recMin: b.recMin,
      }])),
    };
    save(k, res);
    return res;
  })().finally(() => running.delete(k));
  running.set(k, job);
  return job;
}
