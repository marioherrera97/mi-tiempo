// Previsión de cuánto subirá un embalse con la lluvia. Es una heurística explicada, no un modelo hidrológico:
// 1. Se mira cómo respondió el embalse a la lluvia el último año: cambio de volumen de cada semana del boletín frente a la
//    lluvia de esa semana y de la anterior, de media en 5 puntos de su entorno (la presa y 4 puntos a 20 km), con ERA5.
// 2. Se ajusta una recta: cambio semanal = base + b·lluvia de la semana + c·lluvia de la semana anterior (b y c ≥ 0).
//    «base» recoge lo que el embalse pierde o gana sin llover (riegos, abastecimiento, desembalses, evaporación).
// 3. Se aplica a la lluvia de los últimos 7 días y a la prevista para los próximos 7.
import { getJSON } from './api.js';
import * as f from './format.js';

const OFF = [[0, 0], [0.18, 0], [-0.18, 0], [0, 0.23], [0, -0.23]]; // ~20 km al N, S, E y O
const pts = (lat, lon) => OFF.map(([a, b]) => [+(lat + a).toFixed(2), +(lon + b).toFixed(2)]);
const q = (P) => `latitude=${P.map((p) => p[0]).join(',')}&longitude=${P.map((p) => p[1]).join(',')}`;

// Lluvia diaria media de los 5 puntos: Map(día → mm)
function meanDaily(resp, key = 'precipitation_sum') {
  const arr = Array.isArray(resp) ? resp : [resp];
  const out = new Map();
  arr[0].daily.time.forEach((t, i) => {
    const v = arr.map((r) => r.daily[key][i]).filter(f.isNum);
    if (v.length) out.set(t, v.reduce((a, b) => a + b, 0) / v.length);
  });
  return out;
}

// Mínimos cuadrados con 1 a 3 variables (ecuaciones normales)
function ols(X, y) {
  const k = X[0].length;
  const A = Array.from({ length: k }, () => new Array(k + 1).fill(0));
  X.forEach((x, n) => {
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < k; j++) A[i][j] += x[i] * x[j];
      A[i][k] += x[i] * y[n];
    }
  });
  for (let i = 0; i < k; i++) {
    let p = i;
    for (let r = i + 1; r < k; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]];
    if (Math.abs(A[i][i]) < 1e-9) return null;
    for (let r = 0; r < k; r++) {
      if (r === i) continue;
      const m = A[r][i] / A[i][i];
      for (let c = i; c <= k; c++) A[r][c] -= m * A[i][c];
    }
  }
  return A.map((row, i) => row[k] / row[i]);
}

function fit(dv, r0, r1) {
  // Se prueba con las dos lluvias; si alguna sale negativa (sin sentido físico) se quita
  let cols = [0, 1];
  for (let t = 0; t < 3; t++) {
    const X = dv.map((_, n) => [1, ...cols.map((c) => (c === 0 ? r0[n] : r1[n]))]);
    const w = ols(X, dv);
    if (!w) return null;
    const neg = cols.findIndex((_, j) => w[j + 1] < 0);
    if (neg < 0 || !cols.length) {
      const coef = { a: w[0], b: 0, c: 0 };
      cols.forEach((c, j) => { coef[c === 0 ? 'b' : 'c'] = w[j + 1]; });
      const mean = dv.reduce((s, v) => s + v, 0) / dv.length;
      const pred = dv.map((_, n) => coef.a + coef.b * r0[n] + coef.c * r1[n]);
      const ssr = dv.reduce((s, v, n) => s + (v - pred[n]) ** 2, 0), sst = dv.reduce((s, v) => s + (v - mean) ** 2, 0);
      coef.r2 = sst > 0 ? Math.max(0, 1 - ssr / sst) : 0;
      return coef;
    }
    cols = cols.filter((_, j) => j !== neg);
  }
  return null;
}

// r = fila del boletín [nombre, cuenca, capacidad, actual, semana anterior, hace un año, media 10 años, eléctrico, lat, lon, serie]
// weeks = fechas de las semanas del boletín (las últimas 53 corresponden a la serie de cada embalse)
export async function reservoirForecast(r, weeks) {
  const [, , cap, cur, , , , , lat, lon, series] = r;
  const wk = weeks.slice(-series.length);
  const P = pts(lat, lon);
  const today = f.todayISO();
  const end = f.addDays(today, -6); // ERA5 llega con unos 5 días de retraso
  const [arch, fc] = await Promise.all([
    getJSON(`https://archive-api.open-meteo.com/v1/archive?${q(P)}&start_date=${f.addDays(wk[0], -14)}&end_date=${end}&daily=precipitation_sum&timezone=auto`, { ttl: 24 * 3600e3 }),
    getJSON(`https://api.open-meteo.com/v1/forecast?${q(P)}&past_days=7&forecast_days=7&daily=precipitation_sum&timezone=auto`, { ttl: 60 * 60e3 }),
  ]);
  const rain = meanDaily(arch);
  const weekRain = (to) => { let s = 0, n = 0; for (let k = 0; k < 7; k++) { const v = rain.get(f.addDays(to, -k)); if (f.isNum(v)) { s += v; n++; } } return n >= 6 ? (s * 7) / n : null; };
  const dv = [], r0 = [], r1 = [];
  for (let k = 1; k < wk.length; k++) {
    const a = series[k - 1], b = series[k];
    const x0 = weekRain(wk[k]), x1 = weekRain(f.addDays(wk[k], -7));
    if (!f.isNum(a) || !f.isNum(b) || x0 === null || x1 === null) continue;
    dv.push(b - a); r0.push(x0); r1.push(x1);
  }
  if (dv.length < 20) throw new Error('Pocos datos para estimar');
  const m = fit(dv, r0, r1);
  if (!m) throw new Error('No se pudo ajustar');
  const fd = meanDaily(fc);
  const days = [...fd.keys()];
  const ti = Math.max(0, days.indexOf(today));
  const past7 = days.slice(Math.max(0, ti - 7), ti).reduce((s, d) => s + fd.get(d), 0);
  const next7 = days.slice(ti, ti + 7).reduce((s, d) => s + fd.get(d), 0);
  const rainPart = m.b * next7 + m.c * past7;
  let change = m.a + rainPart;
  if (cur + change > cap) change = cap - cur; // lo que no cabe se desembalsa o vierte
  if (cur + change < 0) change = -cur;
  // La semana más lluviosa del año y cuánto subió, como referencia
  let wi = 0;
  r0.forEach((v, n) => { if (v > r0[wi]) wi = n; });
  return { ...m, past7, next7, rainPart, change, after: cur + change, cap, cur, n: dv.length, wetWeek: { rain: r0[wi], dv: dv[wi] } };
}
