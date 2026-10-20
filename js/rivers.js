// Ríos: caudal y nivel de las estaciones de aforo de las redes hidrológicas (data/saih.json, cada hora) y
// previsión de caudal a 15 días con GloFAS (API de crecidas de Open-Meteo), ajustada al caudal medido ahora.
import { getJSON } from './api.js';
import * as f from './format.js';
import { getSaih } from './views/reservoirs.js';

export const getRivers = () => getSaih().then(async (d) => {
  const list = d.rivers || [];
  // El SAIH Ebro bloquea a GitHub pero deja que la app lo pida (CORS): si no vino en saih.json, se pide aquí
  return list.some((r) => r.src === 'SAIH Ebro') ? list : [...list, ...await ebroRivers().catch(() => [])];
});

// ---------- SAIH Ebro: aforos de sus 21 zonas (nivel y caudal, color de aviso y tendencia) ----------
const EBRO_ZONES = ['H1-alto-ebro-mi', 'H2-semi-alta-miranda', 'H3-aragon-irati', 'H4-medio-ebro-mi', 'H5-gallego', 'H6-bajo-cinca', 'H7-segre',
  'H8-bajo-ebro', 'H9-guadalope-martin', 'H10-bajo-jalon', 'H11-semi-alta-logrono', 'H12-arga', 'H13-nogueras', 'H15-alto-ebro-md',
  'H16-alto-aragon', 'H17-alto-cinca', 'H18-esera', 'H19-huerva-aguas-vivas', 'H20-alto-jalon', 'H21-medio-ebro-md', 'H22-garona'];
let ebro = null, ebroAt = 0;
function ebroRivers() {
  if (!ebro || Date.now() - ebroAt > 20 * 60e3) {
    ebroAt = Date.now();
    ebro = Promise.all(EBRO_ZONES.map((z) => {
      const ctl = new AbortController();
      setTimeout(() => ctl.abort(), 15000);
      return fetch(`https://www.saihebro.com/api/mapa/getDatosMapa?slug=mapa-aforos-${z}`, { signal: ctl.signal })
        .then((r) => (r.ok ? r.json() : null)).catch(() => null);
    })).then((zones) => {
      const out = new Map();
      for (const z of zones) for (const x of z?.DATOS || []) {
        if (x.CW_AMBITO !== 'A' || out.has(x.CW_REMOTA_TXT) || !x.LR_UTM_X) continue;
        const tag = (k) => (x.TAGS || []).find((t) => t.LS_TIPO_SENAL === k);
        const val = (t) => (t && t.LS_CALIDAD === 0 ? parseFloat(String(t.VALOR).replace(/\./g, '').replace(',', '.')) : null);
        const q = val(tag('QRIO')), n = val(tag('NRIO'));
        if (!f.isNum(q) && !f.isNum(n)) continue;
        const [lat, lon] = utmToLatLon(x.LR_UTM_X, x.LR_UTM_Y, 30);
        const desc = (tag('NRIO') || tag('QRIO')).LS_DESCRIPCION.replace(/^(NIVEL|CAUDAL)\s+(R[IÍ]O\s+)?/i, '');
        const t = new Date(x.ULTIMA_FECHA.replace(' ', 'T')); // hora peninsular: la del móvil en España
        out.set(x.CW_REMOTA_TXT, {
          id: `E-${x.CW_REMOTA_TXT}`, name: titleEs(desc), river: null, lat, lon, q: f.isNum(q) ? q : null, n: f.isNum(n) ? n : null,
          t: Number.isNaN(+t) ? new Date().toISOString() : t.toISOString(), src: 'SAIH Ebro', thr: null, thv: null,
          lvl: colorLevel(x.COLOR_ESTACION), tend: { arriba: 1, abajo: -1 }[x.LS_TENDENCIA] || 0, h: [],
        });
      }
      if (!out.size) throw new Error('sin datos');
      return [...out.values()];
    }).catch((e) => { ebro = null; throw e; });
  }
  return ebro;
}
// Color de la estación en el visor del SAIH Ebro → nivel de aviso (verde normal, amarillo, naranja, rojo)
function colorLevel(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  if (!m) return null;
  const [r, g, b] = m.slice(1).map((v) => parseInt(v, 16));
  if (g > 100 && r < 100 && b < 100) return 0;
  if (r > 180 && g < 90) return 3;
  if (r > 180 && g < 180 && b < 100) return 2;
  if (r > 180 && g >= 180 && b < 120) return 1;
  return null;
}
const titleEs = (s) => s.toLowerCase().replace(/(^|[\s/(-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase())
  .replace(/ (De|Del|La|Las|Los|El|En|Y|A)(?= )/g, (m) => m.toLowerCase());
// UTM (ETRS89, hemisferio norte) a latitud y longitud
function utmToLatLon(x, y, zone) {
  const a = 6378137, fl = 1 / 298.257223563, k0 = 0.9996, e2 = fl * (2 - fl), ep2 = e2 / (1 - e2);
  x -= 500000;
  const mu = y / k0 / (a * (1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const p = mu + ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) + ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu)
    + ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) + ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const n1 = a / Math.sqrt(1 - e2 * Math.sin(p) ** 2), t1 = Math.tan(p) ** 2, c1 = ep2 * Math.cos(p) ** 2;
  const r1 = (a * (1 - e2)) / (1 - e2 * Math.sin(p) ** 2) ** 1.5, d = x / (n1 * k0);
  const lat = p - ((n1 * Math.tan(p)) / r1) * (d ** 2 / 2 - ((5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * ep2) * d ** 4) / 24
    + ((61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * ep2 - 3 * c1 ** 2) * d ** 6) / 720);
  const lon = (d - ((1 + 2 * t1 + c1) * d ** 3) / 6 + ((5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * ep2 + 24 * t1 ** 2) * d ** 5) / 120) / Math.cos(p);
  return [(lat * 180) / Math.PI, (zone - 1) * 6 - 180 + 3 + (lon * 180) / Math.PI];
}

// Nivel de aviso según los umbrales de cada red: 0 normal, 1 seguimiento, 2 prealerta, 3 alerta
export const LVL = [
  { name: 'Normal', bg: '#2f6fe0', fg: '#fff' },
  { name: 'Seguimiento', bg: '#e9c13b', fg: '#0d141c' },
  { name: 'Prealerta', bg: '#f08c3c', fg: '#0d141c' },
  { name: 'Alerta', bg: '#e5484d', fg: '#fff' },
];
const UNKNOWN = { bg: '#5b7a99', fg: '#fff' };
export const lvlStyle = (r) => (f.isNum(r.lvl) ? LVL[r.lvl] : UNKNOWN);

const dec = (v) => (v >= 100 ? Math.round(v).toLocaleString('es-ES') : v >= 10 ? v.toFixed(1).replace('.', ',') : v.toFixed(2).replace('.', ','));
export const qText = (v) => (f.isNum(v) ? `${dec(v)} m³/s` : '–');
export const nText = (v) => (f.isNum(v) ? `${v.toFixed(2).replace('.', ',')} m` : '–');
// Lo que se enseña de una estación: el caudal si lo da; si no, el nivel
export const mainText = (r) => (f.isNum(r.q) ? qText(r.q) : nText(r.n));

// Tendencia de las últimas horas: compara la media de las 3 últimas con la de 3 a 6 horas antes
export function trend(r) {
  const h = (r.h || []).filter(f.isNum);
  if (h.length < 5) return r.tend || 0; // sin historia propia, la tendencia que da la fuente (Ebro)
  const m = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const now = m(h.slice(-3)), before = m(h.slice(-6, -3));
  const d = now - before, base = Math.max(Math.abs(before), f.isNum(r.q) ? 0.5 : 0.05);
  return d / base > 0.08 ? 1 : d / base < -0.08 ? -1 : 0;
}
export const trendIcon = (t) => (t > 0 ? '▲' : t < 0 ? '▼' : '');
export const trendText = (t) => (t > 0 ? 'subiendo' : t < 0 ? 'bajando' : 'estable');

// «Órbigo en Santa Marina del Rey»; sin repetir el río si el nombre ya lo lleva («Guadiana en La Cubeta»)
const bare = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
export const stationTitle = (r) => (r.river && !/\ben\b/i.test(r.name) && !bare(r.name).includes(bare(r.river)) ? `${r.river} en ${r.name}` : r.name);
export const riverTime = (r) => new Date(r.t).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });

// Umbrales en texto («seguimiento 20 · prealerta 50 · alerta 150 m³/s»)
export function thrText(r) {
  if (!r.thr) return '';
  const u = r.thv === 'q' ? ' m³/s' : ' m';
  const fmt = (v) => (r.thv === 'q' ? dec(v) : v.toFixed(2).replace('.', ','));
  return r.thr.map((v, i) => `${LVL[i + 1].name.toLowerCase()} ${fmt(v)}`).join(' · ') + u;
}

// Últimas 24 h (SVG ligero)
export function spark24(r) {
  const h = r.h || [];
  const pts = h.map((v, i) => [i, v]).filter(([, v]) => f.isNum(v));
  if (pts.length < 3) return '';
  const W = 300, H = 50, n = h.length - 1;
  const vs = pts.map(([, v]) => v);
  const lo = Math.min(...vs), hi = Math.max(...vs);
  const span = Math.max(hi - lo, Math.abs(hi) * 0.1, 0.01);
  const y0 = lo - span * 0.15, y1 = hi + span * 0.15;
  const xy = pts.map(([i, v]) => `${((i / n) * W).toFixed(1)},${(H - 2 - ((v - y0) / (y1 - y0)) * (H - 4)).toFixed(1)}`);
  const col = lvlStyle(r).bg;
  return `<div class="rv-fc-chart"><svg class="rv-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <polyline points="${xy.join(' ')}" fill="none" stroke="${col}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>
    <div class="rv-fc-axis"><span>hace 24 h</span><span>ahora</span></div>
    <div class="rv-fc-cap">${f.isNum(r.q) ? 'Caudal' : 'Nivel'} hora a hora · de ${f.isNum(r.q) ? qText(lo) : nText(lo)} a ${f.isNum(r.q) ? qText(hi) : nText(hi)}</div></div>`;
}

// ---------- Previsión de caudal (GloFAS) ----------
// GloFAS va en celdas de 5 km: la estación puede caer en la celda de otro río o de un afluente. Se piden la celda
// de la estación y sus 8 vecinas y se elige la que ayer llevaba un caudal más parecido al medido; luego se escala
// la previsión para que hoy coincida con lo medido (GloFAS no sabe de presas ni de captaciones).
const G = 0.05;
export async function riverForecast(r) {
  const cells = [];
  for (const dy of [0, -1, 1]) for (const dx of [0, -1, 1]) cells.push([+(r.lat + dy * G).toFixed(3), +(r.lon + dx * G).toFixed(3)]);
  const today = f.todayISO();
  const url = `https://flood-api.open-meteo.com/v1/flood?latitude=${cells.map((c) => c[0]).join(',')}&longitude=${cells.map((c) => c[1]).join(',')}`
    + `&daily=river_discharge,river_discharge_p25,river_discharge_p75&start_date=${f.addDays(today, -10)}&end_date=${f.addDays(today, 15)}`;
  const arr = await getJSON(url, { ttl: 3 * 3600e3 }).then((x) => (Array.isArray(x) ? x : [x]));
  const t = arr[0].daily.time;
  const ti = Math.max(0, t.indexOf(today));
  const obs = f.isNum(r.q) ? meanLast(r) : null;
  const at = (x, i) => x.daily.river_discharge[i];
  let best = arr[0], why = 'celda de la estación';
  if (obs !== null && obs > 0.01) {
    // Distancia en escala logarítmica (un río de 2 m³/s no se parece a uno de 200), la propia celda con ventaja
    const score = (x, k) => {
      const v = at(x, Math.max(0, ti - 1));
      return f.isNum(v) && v > 0 ? Math.abs(Math.log(v / obs)) - (k === 0 ? 0.15 : 0) : Infinity;
    };
    let bs = Infinity;
    arr.forEach((x, k) => { const s = score(x, k); if (s < bs) { bs = s; best = x; why = k === 0 ? 'celda de la estación' : 'celda vecina con un caudal parecido'; } });
  }
  const g0 = at(best, ti);
  // Factor para que GloFAS empiece hoy en lo medido (acotado: si difiere muchísimo, la celda no es ese río)
  let k = 1;
  if (obs !== null && f.isNum(g0) && g0 > 0.01) k = Math.min(10, Math.max(0.1, obs / g0));
  const off = obs !== null && f.isNum(g0) && g0 > 0.01 ? Math.abs(Math.log(obs / g0)) : 0;
  const days = t.map((d, i) => ({ d, q: scale(at(best, i), k), lo: scale(best.daily.river_discharge_p25?.[i], k), hi: scale(best.daily.river_discharge_p75?.[i], k) }));
  const fut = days.filter((p) => p.d > today && f.isNum(p.q));
  const peak = fut.reduce((m, p) => (!m || p.q > m.q ? p : m), null);
  return { days, today, obs, k, why, off, peak, raw: g0, scaled: obs !== null };
}
const scale = (v, k) => (f.isNum(v) ? v * k : null);
const meanLast = (r) => {
  const h = (r.h || []).filter(f.isNum).slice(-6);
  return h.length ? h.reduce((s, v) => s + v, 0) / h.length : r.q;
};

export function forecastChart(m) {
  const pts = m.days.filter((p) => f.isNum(p.q));
  if (pts.length < 5) return '';
  const W = 300, H = 64, n = pts.length - 1;
  const top = Math.max(0.1, ...pts.map((p) => Math.max(p.q, p.d > m.today && f.isNum(p.hi) ? p.hi : 0))) * 1.08;
  const X = (i) => ((i / n) * W).toFixed(1), Y = (v) => (H - 2 - (v / top) * (H - 6)).toFixed(1);
  const ti = pts.findIndex((p) => p.d >= m.today);
  const fut = pts.map((p, i) => [p, i]).filter(([p]) => p.d >= m.today && f.isNum(p.lo) && f.isNum(p.hi));
  const band = fut.length > 1 ? `<polygon points="${fut.map(([p, i]) => `${X(i)},${Y(p.hi)}`).join(' ')} ${fut.reverse().map(([p, i]) => `${X(i)},${Y(p.lo)}`).join(' ')}" fill="var(--rain)" opacity=".22"/>` : '';
  const line = (a, b) => pts.slice(a, b).map((p, i) => `${X(i + a)},${Y(p.q)}`).join(' ');
  return `<div class="rv-fc-chart"><svg class="rv-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${band}
      <polyline points="${line(0, ti + 1)}" fill="none" stroke="var(--rain)" stroke-width="2" vector-effect="non-scaling-stroke"/>
      <polyline points="${line(ti, pts.length)}" fill="none" stroke="var(--rain)" stroke-width="2" stroke-dasharray="4 3" vector-effect="non-scaling-stroke"/>
      ${ti > 0 ? `<line x1="${X(ti)}" x2="${X(ti)}" y1="0" y2="${H}" stroke="var(--text-3)" stroke-width="1" vector-effect="non-scaling-stroke" opacity=".6"/>` : ''}</svg>
    <div class="rv-fc-axis"><span>hace 10 días</span>${ti > 0 ? `<span class="rv-fc-today" style="left:${((ti / n) * 100).toFixed(1)}%">hoy</span>` : ''}<span>+15 días</span></div>
    <div class="rv-fc-cap">Caudal (m³/s) · máx. ${dec(top / 1.08)}</div></div>`;
}

// Bloque de previsión para la ficha de una estación
export async function renderRiverForecast(box, r) {
  box.innerHTML = '<div class="rv-fc-load"><div class="spinner"></div>Calculando previsión…</div>';
  try {
    const m = await riverForecast(r);
    if (!m.peak) throw new Error('GloFAS no tiene datos en este punto');
    const now = m.days.find((p) => p.d === m.today)?.q;
    const ratio = f.isNum(now) && now > 0 ? m.peak.q / now : 1;
    const head = ratio >= 3 ? 'Crecida importante prevista' : ratio >= 1.5 ? 'Subida prevista' : ratio <= 0.7 ? 'Bajará' : 'Sin grandes cambios';
    const doubt = m.off > Math.log(5);
    box.innerHTML = `<div class="rv-fc-head">Previsión 15 días <span class="rv-conf" style="color:${doubt ? 'var(--danger)' : ratio >= 1.5 ? 'var(--warm)' : 'var(--ok)'}">${doubt ? 'fiabilidad baja' : head.toLowerCase()}</span></div>
      <div class="rv-fc-main">Máximo ${qText(m.peak.q)} <span class="muted">el ${f.dayShort(m.peak.d)}${f.isNum(m.peak.hi) && m.peak.hi > m.peak.q * 1.1 ? ` (hasta ${qText(m.peak.hi)})` : ''}</span></div>
      ${forecastChart(m)}
      <p class="note">GloFAS (Copernicus), ${m.why}${m.scaled ? `, ajustado para que hoy coincida con lo medido (×${m.k.toFixed(2).replace('.', ',')})` : ' (esta estación solo da el nivel: caudal sin ajustar)'}.
        Banda: del 25 al 75 % de sus escenarios. No sabe de desembalses ni captaciones${doubt ? '; aquí GloFAS y lo medido difieren mucho, así que probablemente su celda de 5 km no es este río' : ''}. Orientativo.</p>`;
  } catch (e) {
    box.innerHTML = `<p class="note">No se pudo calcular la previsión (${f.esc(e.message)}).</p>`;
  }
}

// Fila desplegable de una estación (vista de embalses y lluvia)
export function riverRow(r, km) {
  const st = lvlStyle(r), tr = trend(r);
  return `<details class="rv-res rv-river" data-r="${f.esc(r.id)}">
    <summary>
      <div class="rv-top"><b>${f.esc(stationTitle(r))}</b>${f.isNum(km) ? `<span class="rv-km">${km < 10 ? km.toFixed(1).replace('.', ',') : Math.round(km)} km</span>` : ''}
        <span class="pv-chip" style="background:${st.bg};color:${st.fg}">${mainText(r)} ${trendIcon(tr)}</span></div>
      <div class="rv-sub"><span>${f.isNum(r.q) && f.isNum(r.n) ? `${nText(r.n)} · ` : ''}${f.esc(r.src)}, ${riverTime(r)}</span><span>${f.isNum(r.lvl) ? LVL[r.lvl].name : ''}${f.isNum(r.lvl) && tr ? ' · ' : ''}${tr ? trendText(tr) : ''}</span></div>
    </summary>
    <div class="rv-more">
      ${spark24(r)}
      ${r.thr ? `<p class="note" style="margin:6px 0">Umbrales: ${thrText(r)}</p>` : ''}
      <div class="rv-fc"></div>
    </div>
  </details>`;
}
