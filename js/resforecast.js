// Previsión del volumen de un embalse a 7 días.
//
// Método principal (inflowForecast): agua que traen los ríos según GloFAS (Copernicus), con la API de crecidas de
// Open-Meteo, en las celdas por donde le entran los ríos a cada embalse (vendor/entradas.json, pipeline/entradas.py).
// Lo que cambia un embalse lo decide sobre todo cuánto sueltan, y eso no se publica de antemano, así que:
//   cambio de cada día = ritmo actual del embalse + k · (entrada de ese día − entrada reciente)
// El ritmo actual sale del dato en tiempo real (SAIH) o del último boletín; k es la parte de un aumento de entrada que
// suele quedarse en el embalse (el resto lo sueltan), ajustada con el último año. Se comprueba semana a semana contra
// el boletín (validación cruzada) y se compara con «cambiará igual que la semana pasada» para dar la fiabilidad.
//
// Método de respaldo (reservoirForecast), si no hay entradas o falla la API: respuesta del embalse a la lluvia local.
// Es una heurística explicada, no un modelo hidrológico:
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

// ---------- Entradas por los ríos (GloFAS) ----------
let entradas = null;
const getEntradas = () => (entradas ||= fetch('vendor/entradas.json').then((r) => (r.ok ? r.json() : {})).catch(() => { entradas = null; return {}; }));

// r = fila del boletín; weeks = fechas del boletín; live = dato en tiempo real del SAIH (opcional)
// Devuelve null si el embalse no tiene entradas calculadas (se usa entonces el método de la lluvia)
export async function inflowForecast(r, weeks, live) {
  const E = (await getEntradas())[r[0]];
  if (!E) return null;
  const [, fac, cells] = E;
  const [, , cap, cur, , , , , , , series] = r;
  const wk = weeks.slice(-series.length);
  const today = f.todayISO();
  const url = `https://flood-api.open-meteo.com/v1/flood?latitude=${cells.map((c) => c[0]).join(',')}&longitude=${cells.map((c) => c[1]).join(',')}`
    + `&daily=river_discharge,river_discharge_p25,river_discharge_p75&start_date=${f.addDays(wk[0], -14)}&end_date=${f.addDays(today, 15)}`;
  const resp = await getJSON(url, { ttl: 3 * 3600e3 });
  const arr = Array.isArray(resp) ? resp : [resp];
  // Caudal que entra cada día (m³/s, todos los ríos, con lo de arroyos y laderas) y en hm³/día
  const days = arr[0].daily.time;
  const sum = (k, i) => fac * arr.reduce((s, x) => s + (x.daily[k]?.[i] ?? x.daily.river_discharge[i] ?? 0), 0);
  const Q = new Map(), Qlo = new Map(), Qhi = new Map();
  days.forEach((t, i) => { Q.set(t, sum('river_discharge', i)); Qlo.set(t, sum('river_discharge_p25', i)); Qhi.set(t, sum('river_discharge_p75', i)); });
  const HM3 = 86400 / 1e6;
  const inHm3 = (from, to, M = Q) => { let s = 0; for (let d = f.addDays(from, 1); d <= to; d = f.addDays(d, 1)) s += (M.get(d) || 0) * HM3; return s; };

  // Semanas del boletín: cambio de volumen y agua que entró esa semana
  const rows = [];
  for (let k = 1; k < wk.length; k++) {
    if (f.isNum(series[k]) && f.isNum(series[k - 1])) rows.push({ dv: series[k] - series[k - 1], I: inHm3(wk[k - 1], wk[k]) });
  }
  if (rows.length < 20) throw new Error('Pocos datos para estimar');
  const meanIn = rows.reduce((s, x) => s + x.I, 0) / rows.length;
  // k por mínimos cuadrados (entre 0 y 1) y error de cada semana con k ajustado sin ella
  const xs = rows.slice(1).map((x, i) => x.I - rows[i].I), ys = rows.slice(1).map((x, i) => x.dv - rows[i].dv);
  const fitK = (skip) => {
    let sxy = 0, sxx = 0;
    xs.forEach((x, j) => { if (j !== skip) { sxy += x * ys[j]; sxx += x * x; } });
    return sxx > 0 ? Math.min(1, Math.max(0, sxy / sxx)) : 0;
  };
  const kk = fitK(-1);
  let eNew = 0, ePers = 0, eZero = 0;
  xs.forEach((x, j) => {
    const real = rows[j + 1].dv, last = rows[j].dv;
    eNew += Math.abs(real - (last + fitK(j) * x)); ePers += Math.abs(real - last); eZero += Math.abs(real);
  });
  const n = xs.length;
  const skill = { mae: eNew / n, pers: ePers / n, zero: eZero / n, weeks: n };

  // Punto de partida: el dato en tiempo real si es posterior al boletín (con su capacidad: algunas redes usan otra curva).
  // Ritmo actual: el cambio en 7 días del propio SAIH; si no lo hay, la última semana del boletín. Nunca se resta uno
  // del otro: el boletín redondea a hm³ y algunas redes miden distinto, y la diferencia parecería un ritmo
  const wkLast = wk[wk.length - 1];
  const liveDay = live && f.isNum(live.vol) && live.t.slice(0, 10) >= wkLast ? live.t.slice(0, 10) : null;
  let base = wkLast, V0 = cur, capV = cap, src = 'boletín', rateLive = false;
  const last = rows[rows.length - 1];
  let rate = last.dv / 7, inRate = last.I / 7;
  if (liveDay) {
    base = liveDay; V0 = live.vol; src = live.src;
    if (live.pct > 0) capV = Math.max(live.vol, (live.vol / live.pct) * 100);
    if (f.isNum(live.d7) && live.d7n > 0) {
      rate = live.d7 / live.d7n; inRate = inHm3(f.addDays(liveDay, -live.d7n), liveDay) / live.d7n; rateLive = true;
    }
  }
  // Se avanza día a día hasta dentro de 7 días; lo que no cabe se vierte y no se puede soltar más de lo que hay
  const run = (M) => {
    let V = V0, now = V0;
    for (let d = f.addDays(base, 1); d <= f.addDays(today, 7); d = f.addDays(d, 1)) {
      V = Math.min(capV, Math.max(0, V + rate + kk * ((M.get(d) ?? Q.get(d) ?? 0) * HM3 - inRate)));
      if (d === today) now = V;
    }
    return { now: base >= today ? V0 : now, end: V };
  };
  const mid = run(Q), lo = run(Qlo), hi = run(Qhi);
  const now = mid.now;
  // Gráfico: caudal de entrada de las últimas 8 semanas y los próximos 15 días
  const chart = days.filter((d) => d >= f.addDays(today, -56)).map((d) => ({ d, q: Q.get(d), lo: Qlo.get(d), hi: Qhi.get(d) }));
  return {
    cap: capV, cur, now, after: mid.end, change: mid.end - now, range: [lo.end - lo.now, hi.end - hi.now].sort((a, b) => a - b),
    in7: inHm3(today, f.addDays(today, 7)), in7lo: inHm3(today, f.addDays(today, 7), Qlo), in7hi: inHm3(today, f.addDays(today, 7), Qhi),
    inPast7: inHm3(f.addDays(today, -7), today), rate: rate * 7, k: kk, skill, src, base, wkLast, rateLive,
    passThrough: meanIn > 2 * cap, meanIn, rivers: cells.length, chart, today,
  };
}
