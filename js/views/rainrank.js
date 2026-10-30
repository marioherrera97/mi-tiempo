// Vista "Lluvia en directo": dónde está lloviendo más ahora en España (unos 2.000 pluviómetros de AEMET,
// las redes SAIH, la ACA, Hidrosur y MeteoGalicia) y aviso de crecida en ríos y embalses por lluvia intensa aguas arriba.
import { state } from '../state.js';
import * as f from '../format.js';
import { loading, errorBox, chips } from '../ui.js';
import { getAllGauges, getData, getSaih, gaugeVal, gaugeWindow, stationName, rainColor, gaugeTime, nice, fillColor } from './reservoirs.js';
import { getJSON } from '../api.js';
import { levelRow, cell, statusDot, figUnit, rankRow } from '../levelrow.js';

const distKm = (a, b, c, d) => {
  const R = 6371, r = Math.PI / 180;
  const x = Math.sin(((c - a) * r) / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(((d - b) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};
const km = (v) => (v < 10 ? v.toFixed(1).replace('.', ',') : Math.round(v)) + ' km';
const mm = (v) => (f.isNum(v) ? f.precip(v, false) : '–');
const val = (v) => (f.isNum(v) ? f.precip(v, true) : '–');

let win = null;
let showAll = false;

// Cuenca de cada pluviómetro: la del embalse con coordenadas más cercano (a menos de 60 km)
function basinOf(g, res, basins) {
  let best = null, bd = 60;
  for (const r of res) {
    const d = Math.abs(r[8] - g[2]) * 111 + Math.abs(r[9] - g[3]) * 85;
    if (d < bd * 1.4) {
      const k = distKm(g[2], g[3], r[8], r[9]);
      if (k < bd) { bd = k; best = r[1]; }
    }
  }
  return best === null ? null : basins[best].name;
}

// ---------- Aviso de crecida ----------
// No hay datos de caudal en tiempo real para toda España, así que se estima con la lluvia: para cada embalse se miran
// los pluviómetros a menos de 30 km (su cuenca próxima, sobre todo aguas arriba en zonas de montaña) y la lluvia
// prevista para las próximas 24 h. Umbrales orientativos, parecidos a los de los avisos de lluvia de AEMET:
// vigilar con 20 mm en 6 h o 40 mm en 24 h; riesgo alto con 40 mm en 6 h u 80 mm en 24 h.
const R_CATCH = 30;
function catchment(lat, lon, st) {
  const near = st.filter((g) => Math.abs(g[2] - lat) < 0.4 && Math.abs(g[3] - lon) < 0.5 && distKm(lat, lon, g[2], g[3]) < R_CATCH);
  const v24 = near.map((g) => g[8]).filter(f.isNum), v6 = near.map((g) => g[6]).filter(f.isNum), v1 = near.map((g) => g[5]).filter(f.isNum);
  if (!v24.length && !v6.length) return null;
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const top = near.filter((g) => f.isNum(g[8])).sort((a, b) => b[8] - a[8])[0];
  return { n: near.length, mean24: mean(v24), max24: v24.length ? Math.max(...v24) : 0, max6: v6.length ? Math.max(...v6) : 0, max1: v1.length ? Math.max(...v1) : 0, top };
}
function level(c, fc = 0) {
  const s = c.mean24 * 0.6 + c.max24 * 0.4 + fc * 0.6;
  if (c.max6 >= 40 || s >= 80) return [2, 'Riesgo alto', 'var(--danger)'];
  if (c.max6 >= 20 || s >= 40) return [1, 'Vigilar', 'var(--warm)'];
  return [0, 'Normal', 'var(--ok)'];
}

async function forecast24(pts) {
  if (!pts.length) return [];
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${pts.map((p) => p[0].toFixed(2)).join(',')}&longitude=${pts.map((p) => p[1].toFixed(2)).join(',')}`
    + '&hourly=precipitation&forecast_hours=24&timezone=GMT';
  const d = await getJSON(u, { ttl: 60 * 60e3 });
  return (Array.isArray(d) ? d : [d]).map((x) => (x.hourly?.precipitation || []).reduce((s, v) => s + (v || 0), 0));
}

async function renderFlood(box, g, em, sh) {
  const st = g.st;
  // Embalses del boletín con coordenadas y los del tiempo real que no estén ya
  const list = em.res.filter((r) => f.isNum(r[8])).map((r) => ({ name: nice(r[0]), basin: em.basins[r[1]].name, lat: r[8], lon: r[9], pct: (100 * r[3]) / r[2] }));
  for (const L of sh?.reservoirs || []) {
    if (!f.isNum(L.lat) || list.some((x) => distKm(x.lat, x.lon, L.lat, L.lon) < 3)) continue;
    list.push({ name: stationName(L.name), basin: L.basin, lat: L.lat, lon: L.lon, pct: L.pct });
  }
  for (const x of list) x.c = catchment(x.lat, x.lon, st);
  const wet = list.filter((x) => x.c && (x.c.mean24 > 2 || x.c.max6 > 5)).sort((a, b) => (b.c.mean24 + b.c.max24) - (a.c.mean24 + a.c.max24)).slice(0, 25);
  const here = state.place;
  const hc = catchment(here.lat, here.lon, st);
  let fc = [];
  try { fc = await forecast24([[here.lat, here.lon], ...wet.map((x) => [x.lat, x.lon])]); } catch { /* sin previsión: solo lo medido */ }
  const fcHere = fc[0] || 0;
  wet.forEach((x, i) => { x.fc = fc[i + 1] || 0; x.lv = level(x.c, x.fc); });
  wet.sort((a, b) => b.lv[0] - a.lv[0] || (b.c.mean24 + b.c.max24 + b.fc) - (a.c.mean24 + a.c.max24 + a.fc));
  const alerts = wet.filter((x) => x.lv[0] > 0);
  const hl = hc ? level(hc, fcHere) : null;
  const row = (x) => `<div class="rv-row fl-row">${levelRow({
    name: f.esc(x.name), meta: [f.esc(x.basin), `${x.c.n} ${x.c.n === 1 ? 'pluviómetro' : 'pluviómetros'}`],
    fig: figUnit(val(x.c.mean24)), sub: `media 24 h · ${statusDot(x.lv[2])}${x.lv[1]}`,
    foot: [cell('Máx. en 24 h', val(x.c.max24)), cell('Máx. en 6 h', val(x.c.max6)), cell('Previsto 24 h', val(x.fc))],
  })}</div>`;
  box.innerHTML = `
    <div class="card">
      <div class="card-head"><h2>Aviso de crecida</h2><span class="tiny">lluvia aguas arriba</span></div>
      ${hl ? `<div class="fl-here" style="border-color:${hl[2]}">
        <div><b style="color:${hl[2]}">${hl[1]}</b> en ríos y embalses cerca de ${f.esc(here.name)}</div>
        <small>Media de ${hc.n} pluviómetros a menos de ${R_CATCH} km: ${f.precip(hc.mean24, true)} en 24 h · máximo en 6 h ${f.precip(hc.max6, true)} · previsto 24 h ${f.precip(fcHere, true)}</small>
      </div>` : `<p class="note">No hay pluviómetros a menos de ${R_CATCH} km de ${f.esc(here.name)}.</p>`}
      ${alerts.length ? `<div class="list-label">${alerts.length} embalses con lluvia intensa en su cuenca</div>${alerts.slice(0, 8).map(row).join('')}
        ${alerts.length > 8 ? `<details class="fl-more"><summary>Ver los otros ${alerts.length - 8}</summary>${alerts.slice(8).map(row).join('')}</details>` : ''}`
        : `<p class="fl-ok">Sin lluvias intensas en las cuencas de ningún embalse ahora mismo.</p>`}
      ${wet.length > alerts.length ? `<details class="fl-more"><summary>Otros embalses donde está entrando lluvia (${wet.length - alerts.length})</summary>${wet.filter((x) => !x.lv[0]).map(row).join('')}</details>` : ''}
      <p class="note">Estimación hecha solo con la lluvia: media y máximo de los pluviómetros a menos de ${R_CATCH} km del embalse y lluvia prevista (Open-Meteo).
        «Vigilar» desde 20 mm en 6 h o 40 mm en 24 h; «riesgo alto» desde 40 mm en 6 h u 80 mm en 24 h. No tiene en cuenta caudales, nieve,
        lo húmedo que esté el suelo ni los desembalses. <b>Para avisos oficiales consulta AEMET, Protección Civil y el SAIH de tu confederación.</b></p>
    </div>`;
}

function renderRank(box, g, em) {
  const w = win || gaugeWindow(g);
  const here = state.place;
  const rows = g.st.filter((r) => f.isNum(gaugeVal(r, w)));
  const wetRows = rows.filter((r) => gaugeVal(r, w) >= 0.1).sort((a, b) => gaugeVal(b, w) - gaugeVal(a, w));
  const top = wetRows.slice(0, showAll ? 100 : 25);
  const total = rows.length;
  // Resumen por cuencas
  const res = em ? em.res.filter((r) => f.isNum(r[8])) : [];
  const byBasin = new Map();
  if (res.length) {
    for (const r of rows) {
      const b = basinOf(r, res, em.basins) || 'Otras zonas';
      if (!byBasin.has(b)) byBasin.set(b, []);
      byBasin.get(b).push(gaugeVal(r, w));
    }
  }
  const basins = [...byBasin.entries()].map(([b, v]) => ({ b, n: v.length, wet: v.filter((x) => x >= 0.1).length, mean: v.reduce((s, x) => s + x, 0) / v.length, max: Math.max(...v) }))
    .filter((x) => x.n >= 5).sort((a, b) => b.mean - a.mean);
  const maxMean = Math.max(1, ...basins.map((x) => x.mean));
  const head = box.querySelector('#rrWin');
  box.querySelector('#rrBody').innerHTML = `
    <div class="card rr-hero">
      <div class="rr-sum">
        <div><b class="num">${wetRows.length}</b><small>de ${total} pluviómetros con lluvia</small></div>
        <div><b class="num">${wetRows[0] ? figUnit(f.precip(gaugeVal(wetRows[0], w), true)) : '0'}</b><small>máximo · ${wetRows[0] ? f.esc(stationName(wetRows[0][1])) : '–'}</small></div>
      </div>
      <p class="tiny" style="margin:6px 0 0">Últimas ${w} h hasta las ${gaugeTime(g)}</p>
    </div>
    ${top.length ? `<div class="card"><div class="card-head"><h2>Dónde llueve más</h2><span class="tiny">${w} h</span></div>
      <div class="rk-list">${top.map((r, i) => {
        const d = distKm(here.lat, here.lon, r[2], r[3]), v = gaugeVal(r, w);
        return rankRow({ n: i + 1, name: f.esc(stationName(r[1])),
          meta: `${f.esc(r[10] || 'AEMET')} · a ${km(d)}${f.isNum(r[5]) && r[5] >= 0.1 && w > 1 ? ` · ahora ${mm(r[5])} mm/h` : ''}`,
          fig: figUnit(f.precip(v, true)), frac: v / gaugeVal(top[0], w), color: rainColor(v)[0] });
      }).join('')}</div>
      ${!showAll && wetRows.length > 25 ? `<button class="btn ghost rr-all" id="rrAll">Ver los 100 primeros</button>` : ''}
    </div>` : `<div class="card"><p class="fl-ok">No ha llovido en ningún pluviómetro en las últimas ${w} h.</p></div>`}
    ${basins.length ? `<div class="card"><div class="card-head"><h2>Por cuencas</h2><span class="tiny">media de los pluviómetros</span></div>
      <div class="rk-list">${basins.map((x) => rankRow({ name: f.esc(x.b), meta: `${x.wet} de ${x.n} con lluvia · máx. ${mm(x.max)}`,
        fig: figUnit(f.precip(x.mean, true)), frac: x.mean / maxMean, color: rainColor(Math.max(0.5, x.mean))[0] })).join('')}</div>
      <p class="note">Cada pluviómetro se asigna a la cuenca del embalse más cercano. Valores en ${f.precipUnit() === 'mm' ? 'l/m²' : f.precipUnit()}.</p></div>` : ''}`;
  head.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', +c.dataset.v === w));
  const all = box.querySelector('#rrAll');
  if (all) all.onclick = () => { showAll = true; renderRank(box, g, em); };
}

export default {
  async render(el) {
    el.innerHTML = `<div id="rrRank"><div class="toolbar" id="rrWin"></div><div id="rrBody"></div></div><div id="rrFlood"></div>
      <p class="footer-note">Pluviómetros: AEMET OpenData, redes SAIH de las confederaciones hidrográficas, ACA, Hidrosur y MeteoGalicia (datos en tiempo real sin validar).
      Se actualizan cada hora.</p>`;
    const rank = el.querySelector('#rrRank'), body = el.querySelector('#rrBody'), flood = el.querySelector('#rrFlood');
    loading(body, 'Cargando pluviómetros…');
    try {
      const [g, em, sh] = await Promise.all([getAllGauges(), getData().catch(() => null), getSaih().catch(() => null)]);
      win ||= gaugeWindow(g);
      el.querySelector('#rrWin').append(chips([[1, '1 hora'], [6, '6 horas'], [12, '12 horas'], [24, '24 horas']], win, (v) => { win = +v; showAll = false; renderRank(rank, g, em); }));
      renderRank(rank, g, em);
      if (em) {
        loading(flood, 'Calculando lluvia en las cuencas…');
        renderFlood(flood, g, em, sh).catch((e) => errorBox(flood, e));
      }
    } catch (e) {
      errorBox(body, e, () => this.render(el));
    }
  },
};
