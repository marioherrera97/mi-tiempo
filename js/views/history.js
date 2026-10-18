// Vista "Histórico y clima": datos pasados (ERA5 desde 1940) y normales climáticas 1991–2020
import { state, load, save } from '../state.js';
import * as api from '../api.js';
import * as f from '../format.js';
import { loading, errorBox, chips } from '../ui.js';
import { makeChart, baseOptions, theme, alpha, mean } from '../charts.js';
import { getForecast } from '../data.js';

const view = { preset: '30', start: null, end: null };
const VARS = ['temperature_2m_max', 'temperature_2m_min', 'temperature_2m_mean', 'precipitation_sum', 'wind_speed_10m_max', 'sunshine_duration'];

function range() {
  const end = f.addDays(f.todayISO(), -6); // ERA5 llega con unos 5 días de retraso
  if (view.preset === 'custom' && view.start && view.end) return [view.start, view.end];
  const days = { 30: 30, 90: 90, 365: 365 }[view.preset] || 30;
  return [f.addDays(end, -days + 1), end];
}

async function renderPast(box) {
  const [start, end] = range();
  box.innerHTML = `
    <div class="toolbar" id="histPresets"></div>
    <div class="toolbar">
      <label class="field">Desde<input type="date" id="hStart" min="1940-01-01" max="${end}" value="${start}"></label>
      <label class="field">Hasta<input type="date" id="hEnd" min="1940-01-01" max="${end}" value="${end}"></label>
      <button class="btn ghost" id="hGo" style="align-self:flex-end">Ver</button>
    </div>
    <div id="histOut"><div class="loading"><div class="spinner"></div></div></div>`;
  box.querySelector('#histPresets').append(chips([['30', '30 días'], ['90', '3 meses'], ['365', '1 año']], view.preset, (v) => { view.preset = v; renderPast(box); }));
  box.querySelector('#hGo').onclick = () => {
    view.preset = 'custom';
    view.start = box.querySelector('#hStart').value;
    view.end = box.querySelector('#hEnd').value;
    if (view.start > view.end) [view.start, view.end] = [view.end, view.start];
    renderPast(box);
  };
  const out = box.querySelector('#histOut');
  try {
    const d = await api.archive(state.place, start, end, VARS);
    const dd = d.daily;
    const n = dd.time.length;
    const maxs = dd.temperature_2m_max, mins = dd.temperature_2m_min, rain = dd.precipitation_sum;
    const iMax = maxs.indexOf(Math.max(...maxs.filter(f.isNum)));
    const iMin = mins.indexOf(Math.min(...mins.filter(f.isNum)));
    const total = rain.filter(f.isNum).reduce((a, b) => a + b, 0);
    const rainy = rain.filter((v) => v >= 1).length;
    const stat = (k, v, s = '') => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
    out.innerHTML = `
      <div class="grid3" style="margin-bottom:12px">
        ${stat('Máx. media', f.temp(mean(maxs)), `Mín. media ${f.temp(mean(mins))}`)}
        ${stat('Día más cálido', f.temp(maxs[iMax]), f.dateShort(dd.time[iMax]) + ' ' + dd.time[iMax].slice(0, 4))}
        ${stat('Día más frío', f.temp(mins[iMin]), f.dateShort(dd.time[iMin]) + ' ' + dd.time[iMin].slice(0, 4))}
        ${stat('Lluvia total', f.precip(total, true), `${rainy} días con ≥1 mm`)}
        ${stat('Viento máx.', f.wind(Math.max(...dd.wind_speed_10m_max.filter(f.isNum)), true))}
        ${stat('Sol total', Math.round(dd.sunshine_duration.filter(f.isNum).reduce((a, b) => a + b, 0) / 3600) + ' h')}
      </div>
      <div class="card"><div class="card-head"><h2>Temperatura y lluvia</h2><span class="tiny">${n} días</span></div>
        <div class="chart-box tall"><canvas id="histChart"></canvas></div></div>`;
    const t = theme();
    makeChart(document.getElementById('histChart'), {
      data: {
        labels: dd.time.map((s) => (n > 400 ? s.slice(0, 7) : f.dateShort(s))),
        datasets: [
          { type: 'line', label: `Máx ${f.tempUnit()}`, data: maxs.map(f.tempVal), borderColor: '#ff8a5b', backgroundColor: alpha('#ff8a5b', 0.15), fill: '+1', pointRadius: 0, borderWidth: 1.4 },
          { type: 'line', label: `Mín ${f.tempUnit()}`, data: mins.map(f.tempVal), borderColor: '#4fa3ff', pointRadius: 0, borderWidth: 1.4 },
          { type: 'bar', label: `Lluvia ${f.precipUnit()}`, data: rain.map(f.precipVal), backgroundColor: alpha('#4aa8ff', 0.7), yAxisID: 'y1' },
        ],
      },
      options: baseOptions({
        scales: {
          x: { grid: { display: false }, ticks: { color: t.text3, maxRotation: 0, autoSkipPadding: 16 } },
          y: { grid: { color: t.grid }, ticks: { color: t.text3, callback: (v) => v + '°' } },
          y1: { position: 'right', beginAtZero: true, grid: { display: false }, ticks: { color: t.rain } },
        },
      }),
    });
  } catch (e) {
    errorBox(out, e, () => renderPast(box));
  }
}

// ---------- Normales climáticas 1991–2020 ----------
const normKey = () => `normals:${state.place.lat.toFixed(2)},${state.place.lon.toFixed(2)}`;

async function computeNormals() {
  const d = await api.archive(state.place, '1991-01-01', '2020-12-31', ['temperature_2m_max', 'temperature_2m_min', 'precipitation_sum'], { ttl: 0 });
  const dd = d.daily;
  const months = Array.from({ length: 12 }, () => ({ mx: [], mn: [], pr: 0, rainy: 0 }));
  const byDoy = {}; // "MM-DD" → { mx: [], mn: [], recMax, recMin }
  dd.time.forEach((t, i) => {
    const m = +t.slice(5, 7) - 1, md = t.slice(5, 10);
    const mx = dd.temperature_2m_max[i], mn = dd.temperature_2m_min[i], pr = dd.precipitation_sum[i];
    if (f.isNum(mx)) months[m].mx.push(mx);
    if (f.isNum(mn)) months[m].mn.push(mn);
    if (f.isNum(pr)) { months[m].pr += pr; if (pr >= 1) months[m].rainy++; }
    const b = (byDoy[md] ||= { mx: [], mn: [], recMax: [-99, ''], recMin: [99, ''] });
    if (f.isNum(mx)) { b.mx.push(mx); if (mx > b.recMax[0]) b.recMax = [mx, t.slice(0, 4)]; }
    if (f.isNum(mn)) { b.mn.push(mn); if (mn < b.recMin[0]) b.recMin = [mn, t.slice(0, 4)]; }
  });
  const res = {
    months: months.map((m) => ({ mx: mean(m.mx), mn: mean(m.mn), pr: m.pr / 30, rainy: m.rainy / 30 })),
    days: Object.fromEntries(Object.entries(byDoy).map(([k, b]) => [k, { mx: mean(b.mx), mn: mean(b.mn), recMax: b.recMax, recMin: b.recMin }])),
  };
  save(normKey(), res);
  return res;
}

async function renderClimate(box) {
  const norms = load(normKey(), null);
  if (!norms) {
    box.innerHTML = `<div class="card"><h2>Normales climáticas 1991–2020</h2>
      <p class="note">Calcula las medias de 30 años para este lugar: temperatura normal de cada mes, lluvia media y récords de cada día del año.
      Es una descarga grande (≈11.000 días), así que se hace una vez y se guarda en el móvil.</p>
      <button class="btn" id="calcNorm">Calcular normales</button></div>`;
    box.querySelector('#calcNorm').onclick = async () => {
      loading(box, 'Descargando 30 años de datos… (puede tardar unos segundos)');
      try { await computeNormals(); renderClimate(box); } catch (e) { errorBox(box, e, () => renderClimate(box)); }
    };
    return;
  }
  const today = f.todayISO();
  const md = today.slice(5, 10);
  const nd = norms.days[md];
  let fcCmp = '';
  try {
    const d = await getForecast();
    const ti = d.daily.time.indexOf(d.current.time.slice(0, 10));
    const rows = d.daily.time.slice(ti, ti + 16).map((day, k) => {
      const i = ti + k;
      const n = norms.days[day.slice(5, 10)];
      if (!n) return '';
      const diff = d.daily.temperature_2m_max[i] - n.mx;
      return `<tr><td>${f.dayName(day, today).slice(0, 3)} ${f.dateShort(day)}</td><td class="r">${f.temp(d.daily.temperature_2m_max[i])}</td><td class="r muted">${f.temp(n.mx)}</td>
        <td class="r ${diff > 0 ? 'anom-pos' : 'anom-neg'}"><b>${f.tempDelta(diff)}</b></td><td class="r tiny">${f.temp(n.recMax[0])} (${n.recMax[1]})</td></tr>`;
    }).join('');
    fcCmp = `<div class="card"><div class="card-head"><h2>Pronóstico vs. normal</h2></div>
      <div style="overflow-x:auto"><table class="simple"><thead><tr><th>Día</th><th class="r">Máx prevista</th><th class="r">Normal</th><th class="r">Diferencia</th><th class="r">Récord 91–20</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  } catch { /* sin pronóstico */ }
  const MES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  box.innerHTML = `
    ${nd ? `<div class="card"><div class="card-head"><h2>Un ${f.parts(today).D} de ${f.monthName(today)} normal</h2></div>
      <div class="kv"><span>Máxima normal</span><span>${f.temp(nd.mx)}</span><span>Mínima normal</span><span>${f.temp(nd.mn)}</span>
      <span>Récord de calor (1991–2020)</span><span>${f.temp(nd.recMax[0])} en ${nd.recMax[1]}</span><span>Récord de frío</span><span>${f.temp(nd.recMin[0])} en ${nd.recMin[1]}</span></div></div>` : ''}
    ${fcCmp}
    <div class="card"><div class="card-head"><h2>Climograma 1991–2020</h2></div><div class="chart-box tall"><canvas id="climChart"></canvas></div>
      <table class="simple" style="margin-top:10px"><thead><tr><th>Mes</th><th class="r">Máx</th><th class="r">Mín</th><th class="r">Lluvia</th><th class="r">Días lluvia</th></tr></thead>
      <tbody>${norms.months.map((m, i) => `<tr><td>${MES[i]}</td><td class="r">${f.temp(m.mx)}</td><td class="r">${f.temp(m.mn)}</td><td class="r">${f.precip(m.pr, true)}</td><td class="r">${m.rainy.toFixed(0)}</td></tr>`).join('')}</tbody></table>
      <button class="btn ghost" id="recalc" style="margin-top:10px">Recalcular</button></div>
    <p class="note">Fuente: reanálisis ERA5 (Copernicus/ECMWF) vía Open-Meteo. Es un modelo de rejilla (~25 km), puede diferir de una estación local.</p>`;
  box.querySelector('#recalc').onclick = async () => { loading(box); await computeNormals(); renderClimate(box); };
  const t = theme();
  makeChart(document.getElementById('climChart'), {
    data: {
      labels: MES,
      datasets: [
        { type: 'line', label: `Máx ${f.tempUnit()}`, data: norms.months.map((m) => f.tempVal(m.mx)), borderColor: '#ff8a5b', pointRadius: 3, tension: 0.35, yAxisID: 'y' },
        { type: 'line', label: `Mín ${f.tempUnit()}`, data: norms.months.map((m) => f.tempVal(m.mn)), borderColor: '#4fa3ff', pointRadius: 3, tension: 0.35, yAxisID: 'y' },
        { type: 'bar', label: `Lluvia ${f.precipUnit()}`, data: norms.months.map((m) => f.precipVal(m.pr)), backgroundColor: alpha('#4aa8ff', 0.6), yAxisID: 'y1' },
      ],
    },
    options: baseOptions({
      scales: {
        x: { grid: { display: false }, ticks: { color: t.text3 } },
        y: { grid: { color: t.grid }, ticks: { color: t.text3, callback: (v) => v + '°' } },
        y1: { position: 'right', beginAtZero: true, grid: { display: false }, ticks: { color: t.rain } },
      },
    }),
  });
}

export default {
  section: 'past',
  render(el) {
    el.innerHTML = `<div class="toolbar" id="histTabs"></div><div id="histBody"></div>`;
    const body = el.querySelector('#histBody');
    const go = () => { loading(body); if (this.section === 'past') renderPast(body); else renderClimate(body); };
    el.querySelector('#histTabs').append(chips([['past', 'Tiempo pasado (desde 1940)'], ['clim', 'Clima normal y récords']], this.section, (v) => { this.section = v; go(); }));
    go();
  },
};
