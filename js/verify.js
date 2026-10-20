// ¿Qué modelo acierta aquí? Lo que cada modelo pronosticó con 1 y 3 días de antelación (API de ejecuciones
// anteriores de Open-Meteo) frente a lo que pasó: ERA5 de Copernicus en los últimos 30 días que ya tiene (llega con
// ~5 días de retraso) y, para la lluvia de las últimas 24 h, el pluviómetro más cercano si lo hay.
import { getJSON } from './api.js';
import * as f from './format.js';
import { getAllGauges } from './views/reservoirs.js';

// Solo modelos que cubren la Península de verdad (los regionales del norte de Europa aquí rellenan con otro global)
export const VERIFY_MODELS = ['ecmwf_ifs', 'ecmwf_aifs025_single', 'gfs_seamless', 'icon_seamless', 'meteofrance_seamless', 'ukmo_seamless', 'gem_seamless', 'jma_seamless'];
const DAYS = 30;
const coord = (p) => `latitude=${p.lat.toFixed(2)}&longitude=${p.lon.toFixed(2)}`;
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);

export async function verifyModels(p, models = VERIFY_MODELS) {
  const end = f.addDays(f.todayISO(), -6), start = f.addDays(end, -(DAYS - 1));
  const vars = ['temperature_2m_previous_day1', 'temperature_2m_previous_day3', 'precipitation_previous_day1', 'precipitation_previous_day3', 'wind_speed_10m_previous_day1'];
  const [fc, ref] = await Promise.all([
    getJSON(`https://previous-runs-api.open-meteo.com/v1/forecast?${coord(p)}&hourly=${vars.join(',')}&models=${models.join(',')}&start_date=${start}&end_date=${end}&timezone=auto`, { ttl: 12 * 3600e3 }),
    getJSON(`https://archive-api.open-meteo.com/v1/archive?${coord(p)}&hourly=temperature_2m,precipitation,wind_speed_10m&models=era5_seamless&start_date=${start}&end_date=${end}&timezone=auto`, { ttl: 12 * 3600e3 }),
  ]);
  const R = ref.hourly, H = fc.hourly;
  const idx = new Map(H.time.map((t, i) => [t, i]));
  const rows = models.map((m) => {
    const get = (v) => H[`${v}_${m}`] || [];
    const T1 = get('temperature_2m_previous_day1'), T3 = get('temperature_2m_previous_day3');
    const P1 = get('precipitation_previous_day1'), P3 = get('precipitation_previous_day3');
    const W1 = get('wind_speed_10m_previous_day1');
    const e = { t1: [], t3: [], w1: [], bias: [] };
    const days = new Map(); // día → [ref, pron. 1 día, pron. 3 días, horas]
    R.time.forEach((t, k) => {
      const i = idx.get(t);
      if (i === undefined) return;
      const rt = R.temperature_2m[k], rp = R.precipitation[k], rw = R.wind_speed_10m[k];
      if (f.isNum(rt) && f.isNum(T1[i])) { e.t1.push(Math.abs(T1[i] - rt)); e.bias.push(T1[i] - rt); }
      if (f.isNum(rt) && f.isNum(T3[i])) e.t3.push(Math.abs(T3[i] - rt));
      if (f.isNum(rw) && f.isNum(W1[i])) e.w1.push(Math.abs(W1[i] - rw));
      if (f.isNum(rp) && f.isNum(P1[i]) && f.isNum(P3[i])) {
        const d = days.get(t.slice(0, 10)) || [0, 0, 0, 0];
        d[0] += rp; d[1] += P1[i]; d[2] += P3[i]; d[3]++;
        days.set(t.slice(0, 10), d);
      }
    });
    const full = [...days.values()].filter((d) => d[3] >= 22);
    // Acierto de «llueve o no» (1 mm o más en el día) y error en mm de cada día
    const hit = (j) => (full.length ? full.filter((d) => (d[0] >= 1) === (d[j] >= 1)).length / full.length : null);
    return {
      id: m, t1: mean(e.t1), t3: mean(e.t3), w1: mean(e.w1), bias: mean(e.bias),
      p1: mean(full.map((d) => Math.abs(d[1] - d[0]))), p3: mean(full.map((d) => Math.abs(d[2] - d[0]))),
      hit1: hit(1), hit3: hit(2), n: full.length, rainyDays: full.filter((d) => d[0] >= 1).length,
    };
  }).filter((r) => f.isNum(r.t1));
  // Nota: cada error dividido por la mediana de todos los modelos (1 = normal, menos es mejor), media de todo
  const med = (k) => {
    const v = rows.map((r) => r[k]).filter(f.isNum).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : null;
  };
  const keys = ['t1', 't3', 'w1', 'p1', 'p3'];
  const M = Object.fromEntries(keys.map((k) => [k, med(k)]));
  rows.forEach((r) => {
    const parts = keys.filter((k) => f.isNum(r[k]) && M[k] > 0).map((k) => r[k] / M[k]);
    r.score = parts.length ? mean(parts) : null;
  });
  rows.sort((a, b) => a.score - b.score);
  return { rows, start, end };
}

// Lluvia de las últimas 24 h: el pluviómetro más cercano (≤ 15 km) frente a lo que cada modelo dijo el día antes
export async function rainYesterday(p, models = VERIFY_MODELS) {
  const d = await getAllGauges();
  const km = (r) => {
    const rad = Math.PI / 180;
    const x = Math.sin(((r[2] - p.lat) * rad) / 2) ** 2 + Math.cos(p.lat * rad) * Math.cos(r[2] * rad) * Math.sin(((r[3] - p.lon) * rad) / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(x));
  };
  const g = d.st.filter((r) => f.isNum(r[8])).map((r) => [r, km(r)]).sort((a, b) => a[1] - b[1])[0];
  if (!g || g[1] > 15) return null;
  const fc = await getJSON(`https://previous-runs-api.open-meteo.com/v1/forecast?${coord(p)}&hourly=precipitation_previous_day1&models=${models.join(',')}`
    + '&past_days=2&forecast_days=1&timezone=GMT', { ttl: 3600e3 });
  // Horas UTC que cubren las 24 h del pluviómetro
  const endH = new Date().toISOString().slice(0, 13);
  const end = fc.hourly.time.findIndex((t) => t.slice(0, 13) === endH);
  if (end < 24) return null;
  const sum = (arr) => {
    const v = arr.slice(end - 24, end);
    return v.every(f.isNum) ? v.reduce((s, x) => s + x, 0) : null;
  };
  return {
    gauge: g[0], km: g[1], measured: g[0][8],
    models: models.map((m) => ({ id: m, mm: sum(fc.hourly[`precipitation_previous_day1_${m}`] || []) })).filter((x) => f.isNum(x.mm)),
  };
}
