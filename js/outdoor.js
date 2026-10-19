// Cálculos para planes al aire libre: nota de cada hora para una actividad, qué ropa ponerse según la sensación
// térmica y balance de agua del suelo (lluvia menos evapotranspiración).
import * as f from './format.js';

const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
// 1 entre b y c, baja en línea recta hasta 0 en a y en d
const tri = (x, a, b, c, d) => (x <= a || x >= d ? 0 : x < b ? (x - a) / (b - a) : x <= c ? 1 : (d - x) / (d - c));
const num = (v, def = 0) => (f.isNum(v) ? v : def);
// Déficit de presión de vapor (kPa): cuánto «chupa» agua el aire; con él se seca la ropa y se evapora el riego
const vpd = (t, rh) => 0.6108 * Math.exp((17.27 * t) / (t + 237.3)) * (1 - rh / 100);

function win(h, i, n, key, fn = Math.max) {
  const out = [];
  for (let k = i; k < Math.min(h.time.length, i + n); k++) out.push(num(h[key][k]));
  return out.length ? fn(...out) : 0;
}
const sum = (...a) => a.reduce((s, x) => s + x, 0);
function rainF(p, pp) {
  return (p >= 1 ? 0.08 : p >= 0.3 ? 0.3 : p >= 0.1 ? 0.7 : 1) * (1 - 0.65 * clamp(pp / 100));
}

// Cada actividad: nombre, icono y función que da la nota (0–1) y los motivos que la bajan
export const ACTIVITIES = {
  correr: { name: 'Correr', icon: '🏃', score(h, i, hr) {
    const a = num(h.apparent_temperature[i]), w = num(h.wind_speed_10m[i]), uv = num(h.uv_index[i]);
    const why = [];
    const t = Math.pow(tri(a, -4, 7, 17, 31), 0.7); if (t < 0.8) why.push(a < 7 ? 'frío' : 'calor');
    const r = rainF(num(h.precipitation[i]), num(h.precipitation_probability[i])); if (r < 0.8) why.push('lluvia');
    const v = 1 - clamp((w - 20) / 30) * 0.7; if (v < 0.8) why.push('viento');
    const u = uv >= 8 ? 0.7 : uv >= 6 ? 0.88 : 1; if (u < 0.9) why.push('sol fuerte');
    const n = hr >= 23 || hr < 6 ? 0.25 : h.is_day[i] ? 1 : 0.85; if (n < 0.5) why.push('de madrugada');
    return [t * r * v * u * n, why];
  } },
  tender: { name: 'Tender ropa', icon: '👕', score(h, i, hr) {
    const why = [];
    if (!h.is_day[i] || hr < 8 || hr > 18) return [0, ['sin sol']];
    // La ropa tarda unas 4 horas: cuenta la lluvia de esas horas
    const p = win(h, i, 4, 'precipitation'), pp = win(h, i, 4, 'precipitation_probability');
    const r = rainF(p, pp); if (r < 0.8) why.push('lluvia');
    const t = num(h.temperature_2m[i]), rh = num(h.relative_humidity_2m[i], 70), w = num(h.wind_speed_10m[i]), cc = num(h.cloud_cover[i]);
    const dry = clamp(vpd(t, rh) / 1.6) * 0.6 + clamp(w / 15) * 0.25 + (1 - cc / 100) * 0.15;
    if (dry < 0.45) why.push(rh > 80 ? 'mucha humedad' : 'seca despacio');
    const g = num(h.wind_gusts_10m[i]) > 55 ? 0.5 : 1; if (g < 1) why.push('rachas fuertes');
    return [r * (0.25 + 0.75 * dry) * g, why];
  } },
  regar: { name: 'Regar', icon: '💧', score(h, i, hr, ctx) {
    const why = [];
    // Mejor a primera hora o al anochecer: se evapora menos y no quema las hojas
    const hf = hr >= 6 && hr <= 9 ? 1 : hr >= 19 && hr <= 22 ? 0.95 : hr === 10 || hr === 18 ? 0.65 : hr >= 11 && hr <= 17 ? 0.3 : 0.55;
    if (hf < 0.5) why.push(hr >= 11 && hr <= 17 ? 'pleno sol' : 'de noche');
    const r24 = win(h, i, 24, 'precipitation', sum);
    const r = r24 >= 6 ? 0.08 : r24 >= 3 ? 0.35 : r24 >= 1 ? 0.75 : 1; if (r < 0.8) why.push('va a llover');
    const w = num(h.wind_speed_10m[i]) > 20 ? 0.55 : 1; if (w < 1) why.push('viento');
    const t = num(h.temperature_2m[i]) < 3 ? 0.2 : 1; if (t < 1) why.push('riesgo de helada');
    // Si el suelo ya está húmedo no hace falta
    const s = ctx?.soil == null ? 1 : ctx.soil > 0.85 ? 0.15 : ctx.soil > 0.6 ? 0.55 : 1; if (s < 0.6) why.push('suelo húmedo');
    return [hf * r * w * t * s, why];
  } },
  sulfatar: { name: 'Sulfatar', icon: '🌿', score(h, i, hr) {
    const why = [];
    if (!h.is_day[i]) return [0, ['de noche']];
    const w = num(h.wind_speed_10m[i]), g = num(h.wind_gusts_10m[i]);
    // Con viento flojo (3–10 km/h) el producto no deriva; en calma total puede haber inversión térmica
    const v = tri(w, 0, 3, 10, 18) * (g > 25 ? 0.4 : 1); if (v < 0.7) why.push(w < 3 ? 'calma total' : 'viento');
    const p = win(h, i, 6, 'precipitation'), pp = win(h, i, 6, 'precipitation_probability');
    const r = p >= 0.2 ? 0.1 : 1 - 0.7 * clamp(pp / 100); if (r < 0.8) why.push('lluvia en 6 h');
    const t = tri(num(h.temperature_2m[i]), 4, 10, 25, 32); if (t < 0.8) why.push(num(h.temperature_2m[i]) > 25 ? 'calor' : 'frío');
    const rh = num(h.relative_humidity_2m[i], 60) < 40 ? 0.7 : 1; if (rh < 1) why.push('aire seco');
    return [v * r * t * rh, why];
  } },
  bici: { name: 'Bici', icon: '🚴', score(h, i, hr) {
    const why = [];
    const a = num(h.apparent_temperature[i]), w = num(h.wind_speed_10m[i]), g = num(h.wind_gusts_10m[i]);
    const t = Math.pow(tri(a, -1, 12, 24, 34), 0.7); if (t < 0.8) why.push(a < 12 ? 'frío' : 'calor');
    const v = (1 - clamp((w - 12) / 28) * 0.8) * (g > 50 ? 0.4 : 1); if (v < 0.8) why.push('viento');
    const r = rainF(num(h.precipitation[i]), num(h.precipitation_probability[i])); if (r < 0.8) why.push('lluvia');
    const n = h.is_day[i] ? 1 : hr >= 23 || hr < 6 ? 0.15 : 0.45; if (n < 0.6) why.push('de noche');
    const u = num(h.uv_index[i]) >= 8 ? 0.85 : 1;
    return [t * v * r * n * u, why];
  } },
  barbacoa: { name: 'Barbacoa', icon: '🍖', score(h, i, hr) {
    const why = [];
    const hf = (hr >= 13 && hr <= 15) || (hr >= 20 && hr <= 22) ? 1 : hr === 12 || hr === 16 || hr === 19 || hr === 23 ? 0.75 : hr >= 17 && hr <= 18 ? 0.6 : 0;
    if (!hf) return [0, ['fuera de hora']];
    const a = num(h.apparent_temperature[i]);
    const t = tri(a, 9, 18, 29, 37); if (t < 0.8) why.push(a < 18 ? 'fresco' : 'calor');
    const r = rainF(win(h, i, 3, 'precipitation'), win(h, i, 3, 'precipitation_probability')); if (r < 0.8) why.push('lluvia');
    const g = num(h.wind_gusts_10m[i]);
    const v = (1 - clamp((num(h.wind_speed_10m[i]) - 12) / 25) * 0.7) * (g > 45 ? 0.3 : 1); if (v < 0.8) why.push(g > 45 ? 'rachas: riesgo de incendio' : 'viento');
    return [hf * t * r * v, why];
  } },
};

// Con el respaldo de MET Noruega faltan algunas variables: sensación = temperatura y el resto vacías
const KEYS = ['temperature_2m', 'relative_humidity_2m', 'precipitation', 'precipitation_probability', 'wind_speed_10m', 'wind_gusts_10m', 'uv_index', 'cloud_cover', 'is_day'];
export function norm(h) {
  if (h._norm) return h;
  const o = { ...h, _norm: true };
  for (const k of KEYS) o[k] ||= [];
  o.apparent_temperature ||= o.temperature_2m;
  return o;
}

// Notas (0–10) de cada hora desde `start`
export function scoreHours(d, act, start, n, ctx) {
  const h = norm(d.hourly), A = ACTIVITIES[act];
  const out = [];
  for (let i = start; i < Math.min(h.time.length, start + n); i++) {
    const [s, why] = A.score(h, i, +h.time[i].slice(11, 13), ctx);
    out.push({ i, t: h.time[i], s: Math.round(clamp(s) * 100) / 10, why });
  }
  return out;
}

// Mejores ventanas: tramos seguidos con nota alta (de hasta `len` horas, el mejor trozo de cada tramo largo),
// ordenados por nota media y duración
export function bestWindows(scores, min = 6.5, maxN = 5, len = 3) {
  const runs = [];
  let cur = null;
  for (const x of scores) {
    const sameDay = cur && cur[cur.length - 1].t.slice(0, 10) === x.t.slice(0, 10);
    if (x.s >= min && sameDay) cur.push(x);
    else if (x.s >= min) { cur = [x]; runs.push(cur); }
    else cur = null;
  }
  const mean = (a) => a.reduce((s, x) => s + x.s, 0) / a.length;
  return runs.map((items) => {
    let best = items.slice(0, len);
    for (let k = 1; k + len <= items.length; k++) {
      const w = items.slice(k, k + len);
      if (mean(w) > mean(best)) best = w;
    }
    const m = mean(best);
    return { items: best, mean: m, rank: m * Math.sqrt(best.length) };
  }).sort((a, b) => b.rank - a.rank).slice(0, maxN);
}

// Color de la nota: rojo → amarillo → verde
export function scoreColor(s) {
  if (s < 1.5) return 'rgba(229, 72, 77, .35)';
  const stops = [[1.5, [229, 72, 77]], [5, [233, 193, 59]], [7.5, [60, 207, 142]], [10, [30, 170, 110]]];
  for (let k = 1; k < stops.length; k++) {
    if (s <= stops[k][0]) {
      const [a, ca] = stops[k - 1], [b, cb] = stops[k];
      const t = (s - a) / (b - a);
      return `rgb(${ca.map((c, j) => Math.round(c + (cb[j] - c) * t)).join(',')})`;
    }
  }
  return 'rgb(30,170,110)';
}

// ---------- ¿Qué me pongo? ----------
const LEVELS = [
  [26, 'Camiseta y pantalón corto', 'tshirt', 'shorts'],
  [21, 'Camiseta y pantalón largo', 'tshirt', 'pants'],
  [16, 'Manga larga o camisa', 'long', 'pants'],
  [11, 'Sudadera o chaqueta ligera', 'jacket', 'pants'],
  [5, 'Chaqueta de abrigo y jersey', 'coat', 'pants'],
  [0, 'Abrigo y bufanda', 'longcoat', 'pants'],
  [-99, 'Abrigo, gorro, bufanda y guantes', 'longcoat', 'pants'],
];
export function outfit(h, i) {
  h = norm(h);
  const a = num(h.apparent_temperature[i]);
  const lv = LEVELS.find(([t]) => a >= t);
  const pp = Math.max(num(h.precipitation_probability[i]), num(h.precipitation_probability[i + 1]));
  const p = Math.max(num(h.precipitation[i]), num(h.precipitation[i + 1]));
  const w = num(h.wind_speed_10m[i]), g = num(h.wind_gusts_10m[i]);
  const uv = num(h.uv_index[i]);
  const o = { a, text: lv[1], top: lv[2], legs: lv[3], extras: [] };
  o.scarf = a < 5;
  o.beanie = a < 0;
  o.gloves = a < 0;
  const rainy = pp >= 50 || p >= 0.4;
  if (rainy && (w > 30 || g > 50)) { o.raincoat = true; o.extras.push('chubasquero (con este viento el paraguas no sirve)'); }
  else if (rainy) { o.umbrella = true; o.extras.push('paraguas'); }
  else if (pp >= 30) o.extras.push('paraguas pequeño por si acaso');
  if (uv >= 6 && h.is_day[i]) { o.sun = true; o.extras.push('gafas de sol, gorra y crema'); }
  if (w > 30 && !o.raincoat && a < 21) o.extras.push('algo que corte el viento');
  return o;
}

// Figura vestida en SVG
export function figure(o) {
  const skin = '#f1c7a0', hair = '#4a3426';
  const C = { tshirt: '#4fa3ff', long: '#6c8cff', jacket: '#3ccf8e', coat: '#e0894a', longcoat: '#8a96a8' };
  const top = o.raincoat ? '#f2c230' : C[o.top];
  const pants = o.legs === 'shorts' ? '#3a5a80' : '#33465e';
  const long = o.top !== 'tshirt';
  const coatLen = o.raincoat || o.top === 'longcoat' ? 122 : 88;
  let s = '';
  if (o.umbrella) s += `<path d="M44 0 Q76 -26 108 0 Q100 -4 92 0 Q84 -4 76 0 Q68 -4 60 0 Q52 -4 44 0Z" fill="#c45bd1"/><path d="M76 -12V86" stroke="#555" stroke-width="2"/>`;
  // Piernas
  if (o.legs === 'shorts') {
    s += `<path d="M36 108h10v36h-10zM54 108h10v36H54z" fill="${skin}"/><path d="M31 84h38l1 28H52l-2-10-2 10H30z" fill="${pants}"/>`;
  } else {
    s += `<path d="M31 84h38l-2 62H54l-4-44-4 44H33z" fill="${pants}"/>`;
  }
  s += `<ellipse cx="40" cy="147" rx="8" ry="4" fill="#2b2b2b"/><ellipse cx="60" cy="147" rx="8" ry="4" fill="#2b2b2b"/>`;
  // Brazos
  const armL = 'M32 41 L23 46 L17 84 L25 86 L31 56Z', armR = 'M68 41 L77 46 L83 84 L75 86 L69 56Z';
  s += `<path d="${armL}" fill="${long ? top : skin}"/><path d="${armR}" fill="${long ? top : skin}"/>`;
  if (!long) s += `<path d="M32 41 L23 46 L21 58 L30 60Z" fill="${top}"/><path d="M68 41 L77 46 L79 58 L70 60Z" fill="${top}"/>`;
  const hand = o.gloves ? '#c0392b' : skin;
  s += `<circle cx="21" cy="88" r="4.5" fill="${hand}"/><circle cx="79" cy="88" r="4.5" fill="${hand}"/>`;
  // Cuerpo
  s += `<path d="M32 40 L68 40 L${coatLen > 90 ? 73 : 70} ${coatLen} L${coatLen > 90 ? 27 : 30} ${coatLen} Z" fill="${top}"/>`;
  if (o.top === 'jacket' || o.top === 'coat' || o.top === 'longcoat' || o.raincoat) s += `<path d="M50 41V${coatLen}" stroke="rgba(0,0,0,.3)" stroke-width="1.5"/>`;
  if (o.raincoat) s += `<path d="M38 26 Q50 2 62 26 L62 34 Q50 30 38 34Z" fill="${top}"/>`;
  // Cabeza
  s += `<rect x="46" y="32" width="8" height="8" fill="${skin}"/><circle cx="50" cy="22" r="12" fill="${skin}"/>`;
  if (!o.beanie && !o.raincoat) s += `<path d="M38 20 Q40 8 50 9 Q61 8 62 20 Q56 14 50 15 Q43 14 38 20Z" fill="${hair}"/>`;
  if (o.beanie) s += `<path d="M37 21 Q38 6 50 6 Q62 6 63 21Z" fill="#c0392b"/><circle cx="50" cy="5" r="3.5" fill="#e8e8e8"/>`;
  else if (o.sun && !o.raincoat) s += `<path d="M37 18 Q38 7 50 7 Q62 7 63 18Z" fill="#e5484d"/><path d="M58 17h12v3H58z" fill="#e5484d"/>`;
  if (o.sun) s += `<rect x="41" y="19" width="7" height="4" rx="1.5" fill="#1b1b1b"/><rect x="52" y="19" width="7" height="4" rx="1.5" fill="#1b1b1b"/><path d="M48 21h4" stroke="#1b1b1b"/>`;
  else s += `<circle cx="45.5" cy="22" r="1.4" fill="#333"/><circle cx="54.5" cy="22" r="1.4" fill="#333"/>`;
  s += `<path d="M46 28 Q50 30.5 54 28" stroke="#9a5b45" stroke-width="1.3" fill="none"/>`;
  if (o.scarf) s += `<path d="M40 34h20v7H40z" fill="#d64545"/><path d="M53 40h6v20h-6z" fill="#d64545"/>`;
  return `<svg class="wear-fig" viewBox="0 -28 112 180" aria-hidden="true">${s}</svg>`;
}

// ---------- Balance de agua del suelo ----------
// Modelo de «cubo»: el suelo guarda hasta CAP mm de agua útil (un suelo medio en los primeros ~40 cm). Cada día entra
// la lluvia y sale la evapotranspiración de referencia ET0 (FAO-56, la de un césped bien regado). Lo que rebosa no se queda.
export const CAP = 50;
export function soilBalance(daily, todayIdx) {
  let w = CAP * 0.5;
  const series = [];
  daily.time.forEach((t, i) => {
    const p = num(daily.precipitation_sum[i]), et = num(daily.et0_fao_evapotranspiration[i]);
    const before = w;
    w = clamp(w + p - et, 0, CAP);
    series.push({ t, p, et, w, over: Math.max(0, before + p - et - CAP), past: i <= todayIdx });
  });
  return series;
}
export function soilState(series, todayIdx) {
  const s = series[todayIdx];
  const frac = s.w / CAP;
  const last3 = series.slice(Math.max(0, todayIdx - 2), todayIdx + 1);
  const surplus = last3.reduce((a, x) => a + x.over, 0);
  if (frac >= 0.95 && surplus >= 12) return { frac, key: 'wet', label: 'Encharcado', color: 'var(--accent)', text: 'Le sobra agua: no riegues y evita pisar la tierra o labrarla hasta que escurra.' };
  if (frac >= 0.6) return { frac, key: 'ok', label: 'Húmedo', color: 'var(--ok)', text: 'Tiene agua de sobra para unos días: no hace falta regar.' };
  if (frac >= 0.3) return { frac, key: 'ok', label: 'En su punto', color: 'var(--ok)', text: 'Humedad correcta. Si no llueve, pronto habrá que regar.' };
  return { frac, key: 'dry', label: 'Seco', color: 'var(--warm)', text: 'Le falta agua: conviene regar, mejor a primera hora o al anochecer.' };
}
