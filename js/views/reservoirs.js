// Vista "Embalses y lluvia" (al estilo de embalses.net): reserva de agua de España, por cuencas y por embalse
// (Boletín Hidrológico semanal del MITECO, preparado en vendor/embalses.json) y lluvia caída en el lugar elegido
// en el año hidrológico comparada con la normal 1991–2020.
import { state, load, save } from '../state.js';
import * as api from '../api.js';
import * as f from '../format.js';
import { loading, errorBox } from '../ui.js';
import { makeChart, baseOptions, theme, alpha } from '../charts.js';
import { colorAt } from '../colors.js';
import { reservoirForecast, inflowForecast } from '../resforecast.js';
import { normals } from '../normals.js';
import { riverRow, renderRiverForecast, LVL, stationTitle, mainText, lvlStyle, getRivers } from '../rivers.js';

let data = null;
export const getData = () => (data ||= fetch('vendor/embalses.json').then((r) => {
  if (!r.ok) throw new Error(`Error HTTP ${r.status}`);
  return r.json();
}).catch((e) => { data = null; throw e; }));

// ---------- Pluviómetros de AEMET (data/pluviometros.json, se rehace cada hora en GitHub Actions) ----------
let gauges = null, gaugesAt = 0;
export const getGauges = () => {
  if (!gauges || Date.now() - gaugesAt > 20 * 60e3) {
    gaugesAt = Date.now();
    gauges = fetch('data/pluviometros.json').then((r) => {
      if (!r.ok) throw new Error('Todavía no hay datos de pluviómetros');
      return r.json();
    }).catch((e) => { gauges = null; throw e; });
  }
  return gauges;
};
// ---------- SAIH (confederaciones hidrográficas): embalses y pluviómetros en tiempo real (data/saih.json) ----------
let saih = null, saihAt = 0;
export const getSaih = () => {
  if (!saih || Date.now() - saihAt > 20 * 60e3) {
    saihAt = Date.now();
    saih = fetch('data/saih.json').then((r) => {
      if (!r.ok) throw new Error('Sin datos del SAIH');
      return r.json();
    }).then(async (d) => {
      // El SAIH Ebro bloquea a GitHub, pero permite que la app lo pida directamente: si no vino, se pide aquí
      if (!d.gauges.some((g) => g[10] === 'SAIH Ebro')) await ebroDirect(d).catch(() => {});
      return d;
    }).catch((e) => { saih = null; throw e; });
  }
  return saih;
};

// Tabla de pluviometría (última hora y 24 h) y volúmenes del día del SAIH Ebro, pedidos desde el móvil
async function ebroDirect(d) {
  const api = 'https://www.saihebro.com/api/';
  const get = (u) => {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 15000);
    return fetch(api + u, { signal: ctl.signal }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))));
  };
  const [plu, vol] = await Promise.all([get('pluviometrias/getTablaPluviometrias'), get('principal/getVolumenesEmbalsados')]);
  const cc = d.coords?.ebro || {};
  const t = new Date().toISOString().slice(0, 13) + ':00Z';
  const n = (v) => (f.isNum(v) && v >= 0 ? Math.round(v * 10) / 10 : null);
  for (const r of plu || []) {
    const ll = cc[r.codigo];
    if (ll) d.gauges.push([`E-${r.codigo}`, r.nombre, ll[0], ll[1], null, n(r.col1), null, null, n(r.col3), t, 'SAIH Ebro']);
  }
  for (const [k, v] of Object.entries(vol?.volumenes || {})) {
    const c = v.data?.[1];
    const vv = parseFloat(c?.volumen);
    if (k === 'cuenca' || !(vv > 0.5) || !f.isNum(c.y)) continue;
    d.reservoirs.push({ name: v.zona, basin: 'Ebro', lat: null, lon: null, vol: vv, pct: c.y, d24: null, t: `${v.fechaAnsi}T07:00Z`, src: 'SAIH Ebro' });
  }
}
// Pluviómetros de AEMET y del SAIH juntos, en el formato de AEMET más la fuente al final
export const getAllGauges = async () => {
  const [a, sh] = await Promise.all([getGauges().catch(() => null), getSaih().catch(() => null)]);
  if (!a && !sh) throw new Error('Todavía no hay datos de pluviómetros');
  const st = (a?.st || []).map((r) => [...r, 'AEMET']);
  // Las de las redes hidrológicas ya traen sus sumas de 1, 6, 12 y 24 h (con 24 en «horas con dato»)
  for (const g of sh?.gauges || []) st.push([g[0], g[1], g[2], g[3], g[4], g[5], g[6], g[7], g[8], 24, g[10]]);
  return { updated: a?.updated || sh?.updated, st, hasAemet: !!a };
};

// Embalse del boletín semanal ↔ embalse con dato en tiempo real (mismo nombre y a menos de 25 km)
// Sin art\u00edculos ni \u00abde\u00bb: \u00abTranco Beas\u00bb = \u00abTranco de Beas\u00bb
const STOP = new Set(['de', 'del', 'el', 'la', 'los', 'las', 'l', 'o', 'a', 'as', 'os', 'y', 'e', 'd', 'embalse', 'presa', 'pantano', 'embassament', 'encoro', 'azud']);
const plain = (n) => nice(n).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((w) => !STOP.has(w)).join(' ');
export function liveFor(d, sh) {
  const out = new Map();
  if (!sh?.reservoirs) return out;
  for (const L of sh.reservoirs) {
    const ln = plain(L.name);
    if (!ln) continue;
    let best = null, bd = Infinity;
    d.res.forEach((r, i) => {
      const rn = plain(r[0]);
      if (!rn || !(rn === ln || ln.startsWith(rn + ' ') || rn.startsWith(ln + ' '))) return;
      // Sin coordenadas propias (Ebro pedido desde la app) vale el mismo nombre en la misma cuenca
      if (!f.isNum(L.lat) && d.basins[r[1]].name !== L.basin) return;
      const km = f.isNum(r[8]) && f.isNum(L.lat) ? distKm(L.lat, L.lon, r[8], r[9]) : 0;
      if (km < 25 && km < bd) { best = i; bd = km; }
    });
    if (best !== null) {
      out.set(best, L);
      const r = d.res[best];
      if (!f.isNum(L.lat) && f.isNum(r[8])) { L.lat = r[8]; L.lon = r[9]; }
    }
  }
  return out;
}
const liveTime = (L) => new Date(L.t).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
// Línea «Ahora» con el dato en tiempo real de un embalse
export const liveLine = (L) => `<div class="rv-live"><span class="rv-dot"></span>Ahora <b style="color:${fillColor(L.pct)}">${p1(L.pct)}</b> · ${hm3(L.vol)}${f.isNum(L.d24) ? ` · 24 h ${delta(L.d24)}` : ''}<small>${f.esc(L.src)}, ${liveTime(L)}</small></div>`;

// [indicativo, nombre, lat, lon, altitud, 1 h, 6 h, 12 h, 24 h, horas con dato]
const GAUGE_COL = { 1: 5, 6: 6, 12: 7, 24: 8 };
export const gaugeVal = (r, w) => r[GAUGE_COL[w]];
// 24 h cuando la mayoría de pluviómetros ya las tiene completas (el proceso horario necesita un día para juntarlas)
export const gaugeWindow = (d) => (d.st.filter((r) => r[8] !== null).length > d.st.length * 0.5 ? 24 : 12);
// «IBIZA/ES CODOLÁ» -> «Ibiza/Es Codolá»
export const stationName = (n) => n.toLowerCase().replace(/(^|[\s/(-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase())
  .replace(/ (De|Del|La|Las|Los|El|Y|D'|L')(?= )/g, (m) => m.toLowerCase());
// Color de la escala de lluvia acumulada del mapa, opaco, y texto legible encima
export const rainColor = (mm) => {
  const [r, g, b] = colorAt('rainacc', Math.max(1, mm));
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return [`rgb(${r | 0},${g | 0},${b | 0})`, lum > 0.6 ? '#0d141c' : '#fff'];
};
export const gaugeTime = (d) => new Date(d.updated).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
const mm = (v) => (f.isNum(v) ? f.precip(v, false) : '–');

// SAIH Ebro (pedido desde la app): su tabla solo trae la última hora, el día y las 24 h, así que las 6 y 12 h
// quedan sin dato. La serie «PACUM» de la ficha de cada estación NO vale para completarlas: son totales diarios
// de los últimos 21 días, no horas (en Boixols sumaba 115 mm de «24 h» con 36 mm reales)

function renderGauges(box, d) {
  const here = state.place;
  const w = gaugeWindow(d);
  const near = d.st.map((r) => [r, distKm(here.lat, here.lon, r[2], r[3])]).sort((a, b) => a[1] - b[1]).slice(0, 4).filter(([, km]) => km < 60);
  const top = d.st.filter((r) => gaugeVal(r, w) > 0).sort((a, b) => gaugeVal(b, w) - gaugeVal(a, w)).slice(0, 8);
  const cell = (v) => {
    if (!f.isNum(v)) return '<td class="muted">–</td>';
    if (v < 0.1) return '<td class="muted">0</td>';
    const [bg, fg] = rainColor(v);
    return `<td><span class="pv-chip" style="background:${bg};color:${fg}">${mm(v)}</span></td>`;
  };
  box.innerHTML = `
    <div class="card">
      <div class="card-head"><h2>Pluviómetros cerca</h2><span class="tiny">hasta las ${gaugeTime(d)}</span></div>
      ${near.length ? `<div class="pv-table-wrap"><table class="pv-table">
        <thead><tr><th></th><th>1 h</th><th>6 h</th><th>12 h</th><th>24 h</th></tr></thead>
        <tbody>${near.map(([r, km]) => `<tr><th><b>${f.esc(stationName(r[1]))}</b><small>${km < 10 ? km.toFixed(1).replace('.', ',') : Math.round(km)} km · ${f.esc(r[10] || 'AEMET')}</small></th>
          ${cell(r[5])}${cell(r[6])}${cell(r[7])}${cell(r[8])}</tr>`).join('')}</tbody></table></div>`
        : '<p class="note">No hay ningún pluviómetro de AEMET a menos de 60 km de este lugar.</p>'}
      <p class="note">Lluvia medida en ${f.precipUnit() === 'mm' ? 'l/m²' : f.precipUnit()} por las estaciones de AEMET, de las redes SAIH de las confederaciones hidrográficas, de la ACA, de Hidrosur y de MeteoGalicia (datos sin validar).
        ${w === 12 ? 'Las 24 h estarán completas cuando el proceso horario lleve un día funcionando.' : ''}</p>
    </div>
    ${top.length ? `<div class="card"><div class="card-head"><h2>Donde más ha llovido</h2><span class="tiny">últimas ${w} h</span></div>
      <div class="pv-top">${top.map((r, i) => {
        const v = gaugeVal(r, w);
        const [bg, fg] = rainColor(v);
        return `<div class="pv-row"><span class="pv-n">${i + 1}</span><span class="pv-name">${f.esc(stationName(r[1]))}</span>
          <span class="pv-chip" style="background:${bg};color:${fg}">${mm(v)} ${f.precipUnit()}</span></div>`;
      }).join('')}</div></div>` : ''}`;
}

// Colores por porcentaje de llenado, como embalses.net (rojo vacío → azul lleno)
export const fillColor = (p) => (p < 20 ? '#e5484d' : p < 40 ? '#f08c3c' : p < 60 ? '#e9c13b' : p < 80 ? '#4fa3ff' : '#2f6fe0');
export const pc = (a, b) => (b ? (100 * a) / b : 0);
// Los datos vienen casi siempre en hm³ enteros: los decimales solo cuando los hay
const num = (v) => (Math.abs(v) >= 100 || Math.abs(v - Math.round(v)) < 0.05 ? Math.round(v).toLocaleString('es-ES') : v.toFixed(1).replace('.', ','));
export const hm3 = (v) => num(v) + ' hm³';
const p1 = (v) => v.toFixed(1).replace('.', ',') + ' %';
// Variación con signo y color (verde si sube el agua, rojo si baja)
export const delta = (d, unit = ' hm³') => {
  if (!f.isNum(d) || Math.abs(d) < 0.05) return '<span class="rv-d">=</span>';
  const v = num(Math.abs(d));
  return `<span class="rv-d ${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} ${v}${unit}</span>`;
};
// Nombres como en el boletín («Pardo, El», «Vellón,El-(Pedrezuela)») escritos de forma natural
export const nice = (n) => n
  .replace(/^(.*?),\s*(El|La|Los|Las|As|Os|O|A|Nª Sª de)\b(.*)$/, '$2 $1$3')
  .replace(/-?\(/g, ' (').replace(/\s+/g, ' ').trim();
export const bar = (p) => `<div class="rv-bar"><i style="width:${Math.min(100, Math.max(0, p)).toFixed(1)}%;background:${fillColor(p)}"></i></div>`;
const distKm = (a, b, c, d) => {
  const R = 6371, r = Math.PI / 180;
  const x = Math.sin(((c - a) * r) / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(((d - b) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};

// Mini gráfico de la última año de un embalse (SVG, sin Chart.js: hay cientos)
function spark(series, cap) {
  const pts = series.map((v, i) => [i, v]).filter(([, v]) => f.isNum(v));
  if (pts.length < 2) return '';
  const W = 300, H = 56, n = series.length - 1;
  const xy = pts.map(([i, v]) => `${((i / n) * W).toFixed(1)},${(H - 2 - (v / cap) * (H - 4)).toFixed(1)}`);
  const last = pts[pts.length - 1][1];
  const col = fillColor(pc(last, cap));
  return `<svg class="rv-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <polygon points="0,${H} ${xy.join(' ')} ${W},${H}" fill="${alpha(col, 0.18)}"/>
    <polyline points="${xy.join(' ')}" fill="none" stroke="${col}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
}

// Fila de un embalse; al tocarla se despliega su detalle
function resRow(r, basinName, dist, live, idx) {
  const [name, , cap, cur, prev, year, avg10, elec, lat, , series] = r;
  const p = pc(cur, cap);
  return `<details class="rv-res"${f.isNum(lat) ? ` data-i="${idx}"` : ''}>
    <summary>
      <div class="rv-top"><b>${f.esc(nice(name))}</b>${elec ? '<span class="rv-tag" title="Uso hidroeléctrico">⚡</span>' : ''}
        ${dist !== undefined ? `<span class="rv-km">${dist < 10 ? dist.toFixed(1).replace('.', ',') : Math.round(dist)} km</span>` : ''}
        <span class="rv-pct" style="color:${fillColor(p)}">${Math.round(p)} %</span></div>
      ${bar(p)}
      <div class="rv-sub"><span>${hm3(cur)} de ${hm3(cap)}</span>${delta(f.isNum(prev) ? cur - prev : null)}</div>
      ${live ? liveLine(live) : ''}
    </summary>
    <div class="rv-more">
      ${spark(series, cap)}
      <div class="rv-cmp">
        <span>Cuenca</span><b>${f.esc(basinName)}</b>
        <span>Hace un año</span><b>${f.isNum(year) ? `${p1(pc(year, cap))} · ${hm3(year)}` : '–'}</b>
        <span>Media 10 años</span><b>${f.isNum(avg10) ? `${p1(pc(avg10, cap))} · ${hm3(avg10)}` : '–'}</b>
        <span>Uso</span><b>${elec ? 'Hidroeléctrico' : 'Consuntivo (riego y abastecimiento)'}</b>
      </div>
      ${f.isNum(lat) ? '<div class="rv-fc"></div>' : ''}
    </div>
  </details>`;
}

function renderReservoirs(box, d, sh) {
  const live = liveFor(d, sh);
  const t = d.total;
  const p = pc(t.cur, t.cap);
  const upd = f.dateShort(d.updated) + ' ' + d.updated.slice(0, 4);
  const here = state.place;
  const near = d.res.filter((r) => f.isNum(r[8]))
    .map((r) => [r, distKm(here.lat, here.lon, r[8], r[9])])
    .sort((a, b) => a[1] - b[1]).slice(0, 6).filter(([, km]) => km < 250);
  const cmp = (label, v) => `<div class="stat"><div class="k">${label}</div><div class="v">${p1(pc(v, t.cap))}</div><div class="s">${hm3(v)} · ${delta(t.cur - v)}</div></div>`;
  box.innerHTML = `
    <div class="card rv-hero">
      <div class="card-head"><h2>Reserva de agua en España</h2><span class="tiny">semana del ${upd}</span></div>
      <div class="rv-big"><span style="color:${fillColor(p)}">${p1(p)}</span><small>${hm3(t.cur)} de ${hm3(t.cap)}</small></div>
      ${bar(p)}
      <div class="rv-week">Esta semana ${delta(t.cur - t.prev)} <span class="muted">(${p1(pc(t.cur - t.prev, t.cap)).replace(/^(?!-)/, '+')} de la capacidad)</span></div>
      <div class="grid3 rv-stats">
        ${cmp('Semana anterior', t.prev)}
        ${cmp('Hace un año', t.year)}
        ${cmp('Media 10 años', t.avg10)}
      </div>
      <div class="rv-split">
        <div><span>Uso consuntivo</span><b>${p1(pc(t.cons.cur, t.cons.cap))}</b>${bar(pc(t.cons.cur, t.cons.cap))}<small>${hm3(t.cons.cur)} de ${hm3(t.cons.cap)}</small></div>
        <div><span>Hidroeléctricos</span><b>${p1(pc(t.elec.cur, t.elec.cap))}</b>${bar(pc(t.elec.cur, t.elec.cap))}<small>${hm3(t.elec.cur)} de ${hm3(t.elec.cap)}</small></div>
      </div>
    </div>
    <div class="card"><div class="card-head"><h2>Este año y el anterior</h2><span class="tiny">% de capacidad</span></div>
      <div class="chart-box short"><canvas id="rvChart"></canvas></div></div>
    ${near.length ? `<div class="section-title">Embalses cerca de ${f.esc(here.name)}</div>
      <div class="card rv-list">${near.map(([r, km]) => resRow(r, d.basins[r[1]].name, km, live.get(d.res.indexOf(r)), d.res.indexOf(r))).join('')}</div>` : ''}
    ${sh?.reservoirs?.length ? `<div class="section-title">En tiempo real cerca de ${f.esc(here.name)}</div>
      <div class="card rv-list rv-livelist">${sh.reservoirs.filter((L) => f.isNum(L.lat)).map((L) => [L, distKm(here.lat, here.lon, L.lat, L.lon)]).sort((a, b) => a[1] - b[1]).slice(0, 8).map(([L, km]) => `<div class="rv-lrow">
        <div class="rv-top"><b>${f.esc(stationName(L.name))}</b><span class="rv-n">${km < 10 ? km.toFixed(1).replace('.', ',') : Math.round(km)} km · ${f.esc(L.basin)}</span><span class="rv-pct" style="color:${fillColor(L.pct)}">${Math.round(L.pct)} %</span></div>
        ${bar(L.pct)}
        <div class="rv-sub"><span>${hm3(L.vol)} · ${f.esc(L.src)}, ${liveTime(L)}</span>${f.isNum(L.d24) ? `<span>24 h ${delta(L.d24)}</span>` : ''}</div></div>`).join('')}</div>
      <p class="note rv-livenote">${sh.reservoirs.length} embalses con dato en tiempo real en toda España (redes SAIH, ACA e Hidrosur). Galicia Costa y las cuencas internas del País Vasco no publican el volumen en tiempo real: solo tienen el boletín semanal.</p>` : ''}
    <div class="section-title">Por cuencas</div>
    <div class="card rv-list">${d.basins.map((b, i) => {
      const bp = pc(b.cur, b.cap);
      const list = d.res.filter((r) => r[1] === i).sort((a, c) => c[2] - a[2]);
      return `<details class="rv-basin">
        <summary>
          <div class="rv-top"><b>${f.esc(b.name)}</b><span class="rv-n">${b.n} embalses</span><span class="rv-pct" style="color:${fillColor(bp)}">${Math.round(bp)} %</span></div>
          ${bar(bp)}
          <div class="rv-sub"><span>${hm3(b.cur)} de ${hm3(b.cap)} · hace un año ${Math.round(pc(b.year, b.cap))} %</span>${delta(b.cur - b.prev)}</div>
        </summary>
        <div class="rv-inner">${list.map((r) => resRow(r, b.name, undefined, live.get(d.res.indexOf(r)), d.res.indexOf(r))).join('')}</div>
      </details>`;
    }).join('')}</div>
`;

  // Al abrir un embalse se estima cuánto subirá con la lluvia (se calcula solo entonces: son dos peticiones)
  box.querySelectorAll('details.rv-res[data-i]').forEach((el) => el.addEventListener('toggle', () => {
    const fc = el.querySelector('.rv-fc');
    if (el.open && fc && !fc.dataset.done) { fc.dataset.done = 1; renderForecast(fc, d.res[+el.dataset.i], d.weeks, live.get(+el.dataset.i)); }
  }));

  // Gráfico: % de la capacidad este año (últimas 53 semanas) frente al año anterior en las mismas semanas
  const th = theme();
  const s = t.series.map((v) => pc(v, t.cap));
  const thisYear = s.slice(-53), lastYear = s.slice(-105, -52);
  const labels = d.weeks.slice(-53).map((w) => f.dateShort(w));
  makeChart(box.querySelector('#rvChart'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Este año', data: thisYear, borderColor: th.accent, backgroundColor: alpha(th.accent, 0.15), fill: true, borderWidth: 2.2, pointRadius: 0, tension: 0.3 },
        { label: 'Año anterior', data: lastYear, borderColor: th.text3, borderDash: [5, 4], borderWidth: 1.6, pointRadius: 0, tension: 0.3 },
      ],
    },
    options: baseOptions({
      plugins: {
        legend: { labels: { boxWidth: 12, boxHeight: 12, usePointStyle: true, color: th.text } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${p1(c.parsed.y)}` } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: th.text3, maxRotation: 0, autoSkip: true, autoSkipPadding: 18 } },
        y: { grid: { color: th.grid }, ticks: { color: th.text3, callback: (v) => v + ' %' }, suggestedMin: 30, suggestedMax: 80 },
      },
    }),
  });
}

// ---------- Previsión a 7 días (js/resforecast.js) ----------
const pts1 = (v) => (Math.abs(v) < 0.05 ? 'sin cambio' : `${v > 0 ? '+' : ''}${v.toFixed(1).replace('.', ',')} puntos`);
const CONF = { alta: 'var(--ok)', media: 'var(--warm)', baja: 'var(--danger)' };
const confHead = (c) => `<div class="rv-fc-head">Previsión 7 días <span class="rv-conf" style="color:${CONF[c]}">fiabilidad ${c}</span></div>`;

// Caudal que entra: últimas 8 semanas y los próximos 15 días con la banda de los escenarios (25–75 %)
function inflowChart(m) {
  const pts = m.chart.filter((p) => f.isNum(p.q));
  if (pts.length < 10) return '';
  const W = 300, H = 64, n = pts.length - 1;
  const top = Math.max(1, ...pts.map((p) => Math.max(p.q, p.d > m.today && f.isNum(p.hi) ? p.hi : 0))) * 1.08;
  const X = (i) => ((i / n) * W).toFixed(1), Y = (v) => (H - 2 - (v / top) * (H - 6)).toFixed(1);
  const ti = pts.findIndex((p) => p.d >= m.today);
  const fut = pts.map((p, i) => [p, i]).filter(([p]) => p.d >= m.today && f.isNum(p.lo) && f.isNum(p.hi));
  const band = fut.length > 1 ? `<polygon points="${fut.map(([p, i]) => `${X(i)},${Y(p.hi)}`).join(' ')} ${fut.reverse().map(([p, i]) => `${X(i)},${Y(p.lo)}`).join(' ')}" fill="var(--rain)" opacity=".22"/>` : '';
  const line = (a, b) => pts.slice(a, b).map((p, i) => `${X(i + a)},${Y(p.q)}`).join(' ');
  return `<div class="rv-fc-chart"><svg class="rv-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${band}
      <polyline points="${line(0, ti + 1)}" fill="none" stroke="var(--rain)" stroke-width="2" vector-effect="non-scaling-stroke"/>
      <polyline points="${line(ti, pts.length)}" fill="none" stroke="var(--rain)" stroke-width="2" stroke-dasharray="4 3" vector-effect="non-scaling-stroke"/>
      ${ti > 0 ? `<line x1="${X(ti)}" x2="${X(ti)}" y1="0" y2="${H}" stroke="var(--text-3)" stroke-width="1" vector-effect="non-scaling-stroke" opacity=".6"/>` : ''}</svg>
    <div class="rv-fc-axis"><span>hace 8 semanas</span>${ti > 0 ? `<span class="rv-fc-today" style="left:${((ti / n) * 100).toFixed(1)}%">hoy</span>` : ''}<span>+15 días</span></div>
    <div class="rv-fc-cap">Agua que traen los ríos (m³/s) · máx. ${num(top / 1.08)}</div></div>`;
}

async function renderForecast(box, r, weeks, live) {
  box.innerHTML = '<div class="rv-fc-load"><div class="spinner"></div>Calculando previsión…</div>';
  try {
    const g = await inflowForecast(r, weeks, live).catch(() => null);
    if (g && !g.passThrough) return renderInflow(box, g);
    // Si por sus ríos entra cada semana mucho más de lo que cabe, o es un embalse de paso (su nivel lo fija la presa)
    // o, a 5 km de resolución, GloFAS lo confunde con un río mayor que pasa al lado: se usa la lluvia local
    const why = g ? `<p class="note">No se usa el caudal de los ríos: según GloFAS le entrarían de media ${hm3(g.meanIn)} por semana, mucho más de lo que cabe (${hm3(r[2])}). O es un embalse de paso, cuyo nivel decide la presa, o a la resolución de GloFAS (5 km) su río se confunde con uno mayor que pasa al lado.</p>` : '';
    const m = await reservoirForecast(r, weeks);
    const conf = m.r2 >= 0.5 ? 'alta' : m.r2 >= 0.2 ? 'media' : 'baja';
    const responds = m.b > 0 || m.c > 0;
    // Se parte del dato en tiempo real si lo hay (el boletín puede tener una semana)
    const v0 = live && f.isNum(live.vol) ? live.vol : m.cur;
    const after = Math.min(m.cap, Math.max(0, v0 + m.change));
    box.innerHTML = `${confHead(conf)}
      <div class="rv-fc-main">${delta(after - v0)} <span class="muted">→ ${p1(pc(after, m.cap))} (${pts1(pc(after - v0, m.cap))})</span></div>
      <div class="rv-cmp">
        <span>Lluvia últimos 7 días</span><b>${f.precip(m.past7, true)}</b>
        <span>Lluvia prevista 7 días</span><b>${f.precip(m.next7, true)}</b>
        <span>Aporte por la lluvia</span><b>${responds ? delta(m.rainPart) : 'apenas responde'}</b>
        <span>Sin lluvia, cada semana</span><b>${delta(m.a)}</b>
      </div>
      <p class="note">Estimación con la respuesta del embalse a la lluvia en el último año (${m.n} semanas; la lluvia explica el ${Math.round(m.r2 * 100)} % de sus cambios).
        ${responds ? `Por cada 10 mm en la zona suele subir unos ${num(10 * (m.b + m.c))} hm³.` : 'La lluvia local apenas explica sus cambios: lo mandan los desembalses o su cuenca está lejos.'}
        No tiene en cuenta el deshielo, los desembalses previstos ni la lluvia lejos de la presa. Orientativo.</p>${why}`;
  } catch (e) {
    box.innerHTML = `<p class="note">No se pudo calcular la previsión (${f.esc(e.message)}).</p>`;
  }
}

function renderInflow(box, m) {
  const s = m.skill;
  const inLine = `${hm3(m.in7)}${m.in7hi - m.in7lo > 0.05 * m.in7 + 0.05 ? ` <span class="muted">(${num(m.in7lo)}–${num(m.in7hi)})</span>` : ''}`;
  const rivers = `${m.rivers === 1 ? 'el río que le entra' : `los ${m.rivers} ríos que le entran`}`;
  // Fiabilidad: error medio de cada semana del último año comparado con lo que cambia el embalse en una semana normal
  const rel = s.zero > 0 ? s.mae / s.zero : 1;
  const conf = rel < 0.5 ? 'alta' : rel < 0.8 ? 'media' : 'baja';
  const [a, b] = m.range;
  const range = b - a > 0.05 * Math.abs(m.change) + 0.1 ? ` <span class="muted">(entre ${num(a).replace(/^(?!-)/, '+')} y ${num(b).replace(/^(?!-)/, '+')})</span>` : '';
  const live = m.src !== 'boletín';
  box.innerHTML = `${confHead(conf)}
    <div class="rv-fc-main">${delta(m.change)} <span class="muted">→ ${p1(pc(m.after, m.cap))} (${pts1(pc(m.change, m.cap))})</span>${range}</div>
    ${inflowChart(m)}
    <div class="rv-cmp">
      <span>Entrará en 7 días</span><b>${inLine}</b>
      <span>Entró los últimos 7 días</span><b>${hm3(m.inPast7)}</b>
      <span>Ritmo actual</span><b>${delta(m.rate)}<small class="muted"> /semana</small></b>
      <span>Se queda de lo que entra de más</span><b>${Math.round(m.k * 100)} %</b>
    </div>
    <p class="note">Sigue el ritmo actual del embalse (${m.rateLive ? `últimos 7 días de ${f.esc(m.src)}` : `semana del boletín hasta el ${f.dateShort(m.wkLast)}`}) y le suma la parte del cambio de entrada que suele quedarse:
      aquí el ${Math.round(m.k * 100)} %; el resto lo sueltan. ${live ? `Parte del último dato de ${f.esc(m.src)}. ` : `Parte del boletín del ${f.dateShort(m.base)}. `}
      Comprobado con el último año (${s.weeks} semanas): se equivoca de media en ${hm3(s.mae)} por semana, frente a ${hm3(s.pers)} si se dice «cambiará igual que la semana pasada»
      (en una semana normal cambia ${hm3(s.zero)}).
      Agua que entra: GloFAS (Copernicus) en ${rivers}, con el rango del 25 al 75 % de sus escenarios. No sabe de desembalses decididos de antemano.</p>`;
}

// ---------- Lluvia caída en el lugar (año hidrológico, desde el 1 de octubre) ----------
const hydroStart = (ymd) => `${+ymd.slice(5, 7) >= 10 ? ymd.slice(0, 4) : +ymd.slice(0, 4) - 1}-10-01`;
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
// Lluvia media de cada día del año (MM-DD) en 1991–2020 (ERA5), compartida con Histórico (js/normals.js)
const rainNormals = async () => {
  const old = load(`rainnorm:${state.place.lat.toFixed(2)},${state.place.lon.toFixed(2)}`, null); // guardadas por versiones anteriores
  if (old) return old;
  const n = await normals(state.place);
  return Object.fromEntries(Object.entries(n.days).map(([k, v]) => [k, v.pr || 0]));
};

async function renderRain(box) {
  const p = state.place;
  box.innerHTML = `<div class="card"><div class="card-head"><h2>Lluvia caída en ${f.esc(p.name)}</h2></div><div class="loading"><div class="spinner"></div>Cargando lluvia…</div></div>`;
  const r = await api.rainPast(p);
  const h = r.hourly;
  const now = r.current.time.slice(0, 13);
  // Solo las horas ya pasadas (la API también trae lo previsto para el resto del día)
  let last = h.time.findIndex((t) => t.slice(0, 13) > now);
  if (last < 0) last = h.time.length;
  const daily = new Map();
  for (let i = 0; i < last; i++) {
    const day = h.time[i].slice(0, 10);
    daily.set(day, (daily.get(day) || 0) + (h.precipitation[i] || 0));
  }
  const sumH = (n) => h.precipitation.slice(Math.max(0, last - n), last).reduce((a, b) => a + (b || 0), 0);
  const today = now.slice(0, 10);
  const start = hydroStart(today);
  // Más de ~90 días atrás: se completa con el archivo histórico (ERA5)
  if (daysBetween(start, today) > 88) {
    try {
      const a = await api.archive(p, start, f.addDays(today, -8), ['precipitation_sum']);
      a.daily.time.forEach((t, i) => { if (!daily.has(t) && f.isNum(a.daily.precipitation_sum[i])) daily.set(t, a.daily.precipitation_sum[i]); });
    } catch { /* se muestra lo que haya */ }
  }
  const days = [];
  for (let d = start; d <= today; d = f.addDays(d, 1)) days.push(d);
  const cum = [];
  let acc = 0;
  for (const d of days) { acc += daily.get(d) || 0; cum.push(acc); }
  // Últimos n días naturales (hoy incluido), aunque empiecen antes del 1 de octubre
  const sumDays = (n) => { let t = 0; for (let k = 0; k < n; k++) t += daily.get(f.addDays(today, -k)) || 0; return t; };
  const item = (k, v, s = '') => `<div class="stat"><div class="k">${k}</div><div class="v">${f.precip(v, true)}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
  box.innerHTML = `
    <div class="card">
      <div class="card-head"><h2>Lluvia caída en ${f.esc(p.name)}</h2></div>
      <div class="grid2 rv-rain">
        ${item('Últimas 24 h', sumH(24))}
        ${item('Últimos 7 días', sumDays(7))}
        ${item('Últimos 30 días', sumDays(30))}
        <div class="stat" id="rvHydro"><div class="k">Año hidrológico (desde el 1 oct)</div><div class="v">${f.precip(acc, true)}</div><div class="s">calculando lo normal…</div></div>
      </div>
      <div class="chart-box short" style="margin-top:12px"><canvas id="rvRainChart"></canvas></div>
      <p class="note">Estimación del modelo para este punto (Open-Meteo), no de un pluviómetro. Lo normal es la media 1991–2020 (ERA5).</p>
    </div>`;

  const th = theme();
  const labels = days.map((d) => f.dateShort(d));
  const chart = makeChart(box.querySelector('#rvRainChart'), {
    data: {
      labels,
      datasets: [
        { type: 'line', label: 'Acumulada este año', data: cum, borderColor: th.rain, backgroundColor: alpha(th.rain, 0.15), fill: true, borderWidth: 2.2, pointRadius: 0, tension: 0.2, yAxisID: 'y' },
        { type: 'bar', label: 'Cada día', data: days.map((d) => f.precipVal(daily.get(d) || 0)), backgroundColor: alpha(th.rain, 0.55), yAxisID: 'y1', barPercentage: 1, categoryPercentage: 0.9 },
      ],
    },
    options: baseOptions({
      plugins: { legend: { labels: { boxWidth: 12, boxHeight: 12, usePointStyle: true, color: th.text } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${f.precip(c.dataset.yAxisID === 'y1' ? (daily.get(days[c.dataIndex]) || 0) : c.parsed.y, true)}` } } },
      scales: {
        x: { grid: { display: false }, ticks: { color: th.text3, maxRotation: 0, autoSkip: true, autoSkipPadding: 18 } },
        y: { position: 'left', beginAtZero: true, grid: { color: th.grid }, ticks: { color: th.text3 } },
        y1: { position: 'right', beginAtZero: true, grid: { display: false }, ticks: { color: th.text3 } },
      },
    }),
  });
  // El acumulado se convierte a la unidad elegida (mm o pulgadas)
  chart.data.datasets[0].data = cum.map((v) => f.precipVal(v));
  chart.update();

  // Lo normal llega después (la primera vez son 30 años de datos)
  try {
    const norm = await rainNormals();
    let nacc = 0;
    const ncum = days.map((d) => (nacc += norm[d.slice(5, 10)] || 0));
    const ratio = nacc > 0.5 ? (100 * acc) / nacc : null;
    const s = box.querySelector('#rvHydro .s');
    if (s) s.innerHTML = `normal ${f.precip(nacc, true)}${ratio !== null ? ` · <b style="color:${ratio >= 100 ? 'var(--ok)' : ratio >= 75 ? 'var(--warm)' : 'var(--danger)'}">${Math.round(ratio)} %</b>` : ''}`;
    chart.data.datasets.splice(1, 0, { type: 'line', label: 'Normal 1991–2020', data: ncum.map((v) => f.precipVal(v)), borderColor: th.text3, borderDash: [5, 4], borderWidth: 1.6, pointRadius: 0, tension: 0.2, yAxisID: 'y' });
    chart.update();
  } catch {
    const s = box.querySelector('#rvHydro .s');
    if (s) s.textContent = 'normal no disponible ahora';
  }
}

// ---------- Ríos: estaciones de aforo cerca del lugar y las que están en aviso ----------
function renderRivers(box, all, focusId) {
  if (!all.length) { box.innerHTML = ''; return; }
  const here = state.place;
  const focus = focusId ? all.find((r) => r.id === focusId) : null;
  const near = all.filter((r) => r !== focus).map((r) => [r, distKm(here.lat, here.lon, r.lat, r.lon)])
    .sort((a, b) => a[1] - b[1]).slice(0, 6).filter(([, km]) => km < 60);
  const warn = all.filter((r) => r.lvl >= 1).sort((a, b) => b.lvl - a.lvl);
  box.innerHTML = `<div class="section-title">Ríos</div>
    ${focus ? `<div class="card rv-list">${riverRow(focus, distKm(here.lat, here.lon, focus.lat, focus.lon))}</div>` : ''}
    ${warn.length ? `<div class="card"><div class="card-head"><h2>Ríos en aviso</h2><span class="tiny">${warn.length} ${warn.length === 1 ? 'estación' : 'estaciones'}</span></div>
      <div class="pv-top">${warn.slice(0, 10).map((r) => `<a class="pv-row" href="#/embalses?r=${encodeURIComponent(r.id)}"><span class="pv-name">${f.esc(stationTitle(r))}</span>
        <span class="pv-chip" style="background:${lvlStyle(r).bg};color:${lvlStyle(r).fg}">${LVL[r.lvl].name} · ${mainText(r)}</span></a>`).join('')}</div></div>` : ''}
    ${near.length ? `<div class="card rv-list"><div class="card-head"><h2>Cerca de ${f.esc(here.name)}</h2><span class="tiny">caudal medido ahora</span></div>
      ${near.map(([r, km]) => riverRow(r, km)).join('')}</div>`
      : `<p class="note">No hay estaciones de aforo con datos públicos a menos de 60 km. ${warn.length ? '' : 'Ningún río de las redes con umbrales está en aviso ahora.'}</p>`}
    <p class="note rv-livenote">${all.length} estaciones de aforo en tiempo real (SAIH Tajo, Ebro, Duero, Miño-Sil, Júcar y Guadalquivir, SIRA Guadiana, SAI Cantábrico, ACA e Hidrosur). Los avisos usan los umbrales de cada confederación. Tajo, Miño-Sil e Hidrosur solo dan el nivel del río, no el caudal. El Segura no lo publica de forma accesible.</p>`;
  box.querySelectorAll('details.rv-river').forEach((el) => el.addEventListener('toggle', () => {
    const fc = el.querySelector('.rv-fc');
    const r = all.find((x) => x.id === el.dataset.r);
    if (el.open && fc && r && !fc.dataset.done) { fc.dataset.done = 1; renderRiverForecast(fc, r); }
  }));
}

// #/embalses?r=estación (desde el mapa): se abre su ficha arriba de la sección de ríos
function focusRiver(el, all) {
  const id = new URLSearchParams(location.hash.split('?')[1] || '').get('r');
  const box = el.querySelector('#rvRivers');
  if (!id || !box) return;
  if (box.dataset.focus !== id) { box.dataset.focus = id; renderRivers(box, all, id); }
  const row = box.querySelector(`details.rv-river[data-r="${CSS.escape(id)}"]`);
  if (!row) return;
  row.open = true;
  pinScroll(el, row);
}

// Mantiene un elemento arriba mientras termina de cargar lo de encima (cambia de altura), hasta 3 s o hasta que el
// usuario toque o desplace la página
function pinScroll(el, target) {
  const go = () => target.scrollIntoView({ block: 'start' });
  const ro = new ResizeObserver(go);
  const stop = () => { ro.disconnect(); ['wheel', 'touchstart', 'keydown', 'pointerdown'].forEach((t) => removeEventListener(t, stop)); };
  ['wheel', 'touchstart', 'keydown', 'pointerdown'].forEach((t) => addEventListener(t, stop, { passive: true }));
  setTimeout(() => { go(); ro.observe(el); }, 60);
  setTimeout(stop, 3000);
  target.classList.add('rv-flash');
  setTimeout(() => target.classList.remove('rv-flash'), 1600);
}

// #/embalses?e=índice (desde el mapa): se abre ese embalse en su cuenca, con su ficha y su previsión
function focusReservoir(el) {
  const i = new URLSearchParams(location.hash.split('?')[1] || '').get('e');
  const res = i !== null && el.querySelector(`.rv-basin details.rv-res[data-i="${CSS.escape(i)}"]`);
  if (!res) return;
  res.closest('details.rv-basin').open = true;
  res.open = true;
  pinScroll(el, res);
}

export default {
  show(el) { focusReservoir(el); getRivers().then((all) => focusRiver(el, all)).catch(() => {}); },
  async render(el) {
    el.innerHTML = `<div id="rvRes"></div><div id="rvRivers"></div><div class="section-title">Lluvia</div><div id="rvGauges"></div><div id="rvRain"></div>
      <p class="footer-note">Embalses: <a href="https://www.miteco.gob.es/es/agua/temas/evaluacion-de-los-recursos-hidricos/boletin-hidrologico.html" target="_blank" rel="noopener">Boletín Hidrológico del MITECO</a>
      (embalses peninsulares de más de 5 hm³; datos provisionales que se actualizan cada semana).
      Tiempo real: redes SAIH de las confederaciones del Tajo, Guadiana, Ebro, Duero, Guadalquivir, Júcar, Miño-Sil y Segura (Confederación Hidrográfica del Segura), SAI del Cantábrico (CH Cantábrico), ACA, Hidrosur y MeteoGalicia.
      Ubicación de los embalses: Wikidata y OpenStreetMap. Pluviómetros: AEMET OpenData y las redes anteriores.
      Lluvia del año: Open-Meteo y ERA5 (Copernicus).
      Ríos: estaciones de aforo de las mismas redes; previsión de caudal con GloFAS.
      Agua que entra a los embalses: GloFAS (Copernicus Emergency Management Service) por la API de crecidas de Open-Meteo, con la red de drenaje de GloFAS v4 del JRC (CC BY 4.0).</p>`;
    const resBox = el.querySelector('#rvRes'), rainBox = el.querySelector('#rvRain');
    loading(resBox, 'Cargando embalses…');
    const res = Promise.all([getData(), getSaih().catch(() => null)]).then(([d, sh]) => {
      renderReservoirs(resBox, d, sh);
      focusReservoir(el);
      getRivers().then((all) => { renderRivers(el.querySelector('#rvRivers'), all); focusRiver(el, all); }).catch(() => {});
    }).catch((e) => errorBox(resBox, e, () => this.render(el)));
    const rain = renderRain(rainBox).catch((e) => errorBox(rainBox, e, () => renderRain(rainBox)));
    const gBox = el.querySelector('#rvGauges');
    // Sin datos de pluviómetros (aún no publicados) la sección simplemente no aparece
    const gau = getAllGauges().then((d) => renderGauges(gBox, d)).catch(() => { gBox.innerHTML = ''; });
    await Promise.all([res, rain, gau]);
  },
};
