// Vista "Largo plazo": ensembles (hasta 35 días), semanas (EC46) y meses (SEAS5, 6 meses)
import { state } from '../state.js';
import * as api from '../api.js';
import * as f from '../format.js';
import { css } from '../colors.js';
import { loading, errorBox, chips } from '../ui.js';
import { makeChart, baseOptions, theme, alpha, percentile, mean } from '../charts.js';

const view = { ens: 'ecmwf_ifs025', varName: 'temperature_2m', section: 'ens' };
const VARS = [
  ['temperature_2m', 'Temperatura'],
  ['precipitation', 'Lluvia'],
  ['wind_speed_10m', 'Viento'],
  ['cloud_cover', 'Nubes'],
];

function members(block, name) {
  return Object.keys(block).filter((k) => k === name || k.startsWith(name + '_member')).map((k) => block[k]);
}

const conv = {
  temperature_2m: f.tempVal, precipitation: f.precipVal, wind_speed_10m: f.windVal, cloud_cover: (v) => v,
  temperature_2m_max: f.tempVal, temperature_2m_min: f.tempVal, precipitation_sum: f.precipVal,
};
const unitOf = (n) => ({ temperature_2m: f.tempUnit(), precipitation: f.precipUnit(), wind_speed_10m: f.windUnit(), cloud_cover: '%' }[n]);

// ---------- Ensembles ----------
async function renderEnsemble(box) {
  const model = api.ENSEMBLES.find((m) => m.id === view.ens);
  box.innerHTML = `
    <div class="toolbar"><div id="ensModels" class="grow"></div></div>
    <div class="toolbar"><div id="ensVars"></div></div>
    <div class="card">
      <div class="card-head"><h2>${model.name} · ${unitOf(view.varName)}</h2><span class="tiny">${model.desc}</span></div>
      <div class="chart-scroll"><div class="chart-box tall" id="ensBox"><canvas id="ensChart"></canvas></div></div>
      <div class="legend-row"><span>Cada línea fina es un escenario posible</span><span>Banda: 10–90 %</span><span>Línea gruesa: mediana</span></div>
    </div>
    <div class="card"><div class="card-head"><h2>Resumen diario del ensemble</h2></div><div id="ensTable"><div class="loading"><div class="spinner"></div></div></div></div>
    <p class="note">Un <b>ensemble</b> ejecuta el mismo modelo muchas veces con condiciones iniciales ligeramente distintas. Si las líneas están juntas, el pronóstico es fiable; si se abren en abanico, hay mucha incertidumbre.</p>`;
  box.querySelector('#ensModels').append(chips(api.ENSEMBLES.map((m) => [m.id, m.name]), view.ens, (v) => { view.ens = v; renderEnsemble(box); }));
  box.querySelector('#ensVars').append(chips(VARS, view.varName, (v) => { view.varName = v; renderEnsemble(box); }));

  try {
    const d = await api.ensemble(state.place, model.id, model.days,
      [view.varName],
      ['temperature_2m_max', 'temperature_2m_min', 'precipitation_sum']);
    plume(d, model);
    dailyTable(d, box.querySelector('#ensTable'));
  } catch (e) {
    errorBox(box.querySelector('#ensTable'), e, () => renderEnsemble(box));
  }
}

function plume(d, model) {
  const h = d.hourly;
  const name = view.varName;
  const mem = members(h, name);
  const c = conv[name];
  // Para horizontes largos se agrupa cada 6 h para que el gráfico sea legible
  const step = model.days > 16 ? 6 : name === 'precipitation' ? 3 : 1;
  const idx = [];
  for (let i = 0; i < h.time.length; i += step) idx.push(i);
  const agg = (arr, i) => {
    const slice = arr.slice(i, i + step).filter(f.isNum);
    if (!slice.length) return null;
    return name === 'precipitation' ? slice.reduce((a, b) => a + b, 0) : slice.reduce((a, b) => a + b, 0) / slice.length;
  };
  const series = mem.map((arr) => idx.map((i) => c(agg(arr, i))));
  const stat = (p) => idx.map((_, j) => percentile(series.map((s) => s[j]), p));
  const t = theme();
  const labels = idx.map((i) => h.time[i]);
  const days = [], dayLabels = [];
  labels.forEach((s, j) => {
    if (j === 0 || s.slice(11, 13) < labels[j - 1].slice(11, 13)) { if (j) days.push(j); dayLabels.push([j, f.dayShort(s)]); }
  });
  // etiquetas cada pocos días si hay muchos
  const every = model.days > 16 ? 4 : model.days > 8 ? 2 : 1;
  const shownLabels = dayLabels.filter((_, k) => k % every === 0);
  const width = Math.max(700, idx.length * (model.days > 16 ? 6 : 4));
  document.getElementById('ensBox').style.minWidth = width + 'px';
  const memberColor = alpha(name === 'precipitation' ? '#4aa8ff' : name === 'temperature_2m' ? '#ffb547' : name === 'wind_speed_10m' ? '#7fb7ff' : '#b8c2d0', 0.22);
  makeChart(document.getElementById('ensChart'), {
    type: 'line',
    data: {
      labels: labels.map((s) => f.hh(s)),
      datasets: [
        { label: 'P90', data: stat(0.9), borderColor: 'transparent', backgroundColor: alpha('#4fa3ff', 0.18), fill: '+1', pointRadius: 0 },
        { label: 'P10', data: stat(0.1), borderColor: 'transparent', pointRadius: 0, fill: false },
        { label: 'Mediana', data: stat(0.5), borderColor: t.text, borderWidth: 2.4, pointRadius: 0, fill: false, tension: 0.25 },
        ...series.map((s, k) => ({ label: k === 0 ? 'Control' : `Miembro ${k}`, data: s, borderColor: memberColor, borderWidth: 1, pointRadius: 0, fill: false, tension: 0.25 })),
      ],
    },
    options: baseOptions({
      plugins: {
        legend: { display: false },
        tooltip: { ...baseOptions().plugins.tooltip, filter: (item) => item.datasetIndex < 3, callbacks: { title: (it) => `${f.dayShort(labels[it[0].dataIndex])} ${f.hh(labels[it[0].dataIndex])}h` } },
        markers: { days, labels: shownLabels },
      },
      scales: {
        x: { grid: { display: false }, ticks: { display: false } },
        y: { grid: { color: t.grid }, ticks: { color: t.text3 }, beginAtZero: name !== 'temperature_2m' },
      },
    }),
  });
}

function dailyTable(d, el) {
  const dd = d.daily;
  if (!dd) { el.innerHTML = ''; return; }
  const mx = members(dd, 'temperature_2m_max');
  const mn = members(dd, 'temperature_2m_min');
  const pr = members(dd, 'precipitation_sum');
  const today = f.todayISO();
  const rows = dd.time.map((day, i) => {
    const maxs = mx.map((a) => a[i]), mins = mn.map((a) => a[i]), rains = pr.map((a) => a[i]).filter(f.isNum);
    const pRain = rains.length ? Math.round((rains.filter((v) => v >= 1).length / rains.length) * 100) : null;
    const pHeavy = rains.length ? Math.round((rains.filter((v) => v >= 10).length / rains.length) * 100) : null;
    const spread = percentile(maxs, 0.9) - percentile(maxs, 0.1);
    const conf = spread < 3 ? ['Alta', 'var(--ok)'] : spread < 6 ? ['Media', 'var(--warm)'] : ['Baja', 'var(--danger)'];
    return `<tr>
      <td style="white-space:nowrap"><b>${f.dayName(day, today).slice(0, 3)}</b> ${f.parts(day).D}</td>
      <td class="r" style="white-space:nowrap"><b style="color:${css('temp', percentile(maxs, 0.5))}">${f.temp(percentile(maxs, 0.5))}</b> <span class="tiny">${f.temp(percentile(maxs, 0.1))}–${f.temp(percentile(maxs, 0.9))}</span></td>
      <td class="r" style="white-space:nowrap">${f.temp(percentile(mins, 0.5))} <span class="tiny">${f.temp(percentile(mins, 0.1))}–${f.temp(percentile(mins, 0.9))}</span></td>
      <td class="r"><span class="prob-cell" title="${pHeavy}% de escenarios con 10 mm o más" style="background:rgba(74,168,255,${(pRain / 100 * 0.7).toFixed(2)})">${pRain ?? '–'}%</span></td>
      <td class="r" style="white-space:nowrap">${f.precip(mean(rains))}</td>
      <td class="r" title="Confianza ${conf[0].toLowerCase()}"><span style="color:${conf[1]}">●</span></td>
    </tr>`;
  }).join('');
  el.innerHTML = `<div style="overflow-x:auto"><table class="simple">
    <thead><tr><th>Día</th><th class="r">Máx (10–90%)</th><th class="r">Mín</th><th class="r">Lluvia</th><th class="r">${f.precipUnit()}</th><th class="r">Fiab.</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    <p class="note" style="margin:8px 0 0">Lluvia = % de escenarios con ≥1 mm. Fiabilidad: <span style="color:var(--ok)">●</span> alta, <span style="color:var(--warm)">●</span> media, <span style="color:var(--danger)">●</span> baja (según la dispersión de la máxima).</p>`;
}

// ---------- Semanas (EC46) y meses (SEAS5) ----------
async function renderSeasonal(box) {
  box.innerHTML = `
    <div class="card"><div class="card-head"><h2>Próximas semanas (ECMWF EC46)</h2><span class="tiny">anomalía vs. clima normal</span></div>
      <div id="weekly"><div class="loading"><div class="spinner"></div></div></div></div>
    <div class="card"><div class="card-head"><h2>Próximos meses (ECMWF SEAS5)</h2></div>
      <div id="monthly"><div class="loading"><div class="spinner"></div></div></div></div>
    <div class="card"><div class="card-head"><h2>Día a día hasta 6 meses</h2><span class="tiny">51 escenarios</span></div>
      <div class="chart-scroll"><div class="chart-box tall" style="min-width:1100px"><canvas id="seasChart"></canvas></div></div>
      <p class="note" style="margin:8px 0 0">Previsión diaria extendida del ECMWF. Más allá de 3–4 semanas no indica el tiempo de un día concreto, sino la <b>tendencia</b>: si la banda está por encima o por debajo de lo normal.</p></div>
    <p class="note"><b>Cómo leerlo:</b> la anomalía es la diferencia respecto a la media climática de esas fechas. +1,5° significa "un poco más cálido de lo habitual". Es información de tendencia, no un pronóstico exacto.</p>`;

  try {
    const w = await api.seasonal(state.place, 'weekly', ['temperature_2m_mean', 'temperature_2m_anomaly', 'precipitation_mean', 'precipitation_anomaly', 'temperature_2m_efi', 'precipitation_efi']);
    const wk = w.weekly;
    const rows = wk.time.map((t, i) => {
      if (!f.isNum(wk.temperature_2m_mean[i])) return '';
      const ta = wk.temperature_2m_anomaly[i], pa = wk.precipitation_anomaly[i];
      return `<tr><td><b>${f.dateShort(t)}</b> <span class="tiny">– ${f.dateShort(f.addDays(t, 6))}</span></td>
        <td class="r">${f.temp(wk.temperature_2m_mean[i])}</td>
        <td class="r ${ta > 0 ? 'anom-pos' : 'anom-neg'}"><b>${f.tempDelta(ta)}</b></td>
        <td class="r">${f.precip(wk.precipitation_mean[i], true)}</td>
        <td class="r ${pa > 0 ? 'anom-neg' : 'anom-pos'}">${pa > 0 ? '+' : ''}${f.precip(pa)}</td>
        <td class="r">${anomWord(ta, pa)}</td></tr>`;
    }).join('');
    document.getElementById('weekly').innerHTML = `<div style="overflow-x:auto"><table class="simple">
      <thead><tr><th>Semana</th><th class="r">Temp. media</th><th class="r">Anom.</th><th class="r">Lluvia</th><th class="r">Anom.</th><th class="r">Tendencia</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  } catch (e) { errorBox(document.getElementById('weekly'), e); }

  try {
    const m = await api.seasonal(state.place, 'monthly', ['temperature_2m_mean', 'temperature_2m_anomaly', 'precipitation_mean', 'precipitation_anomaly', 'sunshine_duration_mean']);
    const mo = m.monthly;
    const rows = mo.time.map((t, i) => {
      const ta = mo.temperature_2m_anomaly[i], pa = mo.precipitation_anomaly[i];
      return `<tr><td><b>${f.monthName(t)[0].toUpperCase() + f.monthName(t).slice(1)}</b></td>
        <td class="r">${f.temp(mo.temperature_2m_mean[i])}</td>
        <td class="r ${ta > 0 ? 'anom-pos' : 'anom-neg'}"><b>${f.tempDelta(ta)}</b></td>
        <td class="r">${f.precip(mo.precipitation_mean[i], true)}</td>
        <td class="r ${pa > 0 ? 'anom-neg' : 'anom-pos'}">${pa > 0 ? '+' : ''}${f.precip(pa)}</td>
        <td class="r">${f.isNum(mo.sunshine_duration_mean[i]) ? Math.round(mo.sunshine_duration_mean[i] / 3600) + ' h' : '–'}</td></tr>`;
    }).join('');
    document.getElementById('monthly').innerHTML = `<div style="overflow-x:auto"><table class="simple">
      <thead><tr><th>Mes</th><th class="r">Temp. media</th><th class="r">Anom.</th><th class="r">Lluvia</th><th class="r">Anom.</th><th class="r">Sol</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  } catch (e) { errorBox(document.getElementById('monthly'), e); }

  try {
    const s = await api.seasonal(state.place, 'daily', ['temperature_2m_max', 'precipitation_sum']);
    const dd = s.daily;
    const mem = members(dd, 'temperature_2m_max');
    const t = theme();
    const vals = mem.map((a) => a.map((v) => f.tempVal(v)));
    const n = dd.time.length;
    const p = (q) => Array.from({ length: n }, (_, i) => percentile(vals.map((a) => a[i]), q));
    // media móvil de 7 días para ver la tendencia
    const smooth = (arr) => arr.map((_, i) => mean(arr.slice(Math.max(0, i - 3), i + 4)));
    const monthStarts = [], monthLabels = [];
    dd.time.forEach((d, i) => { if (i === 0 || d.endsWith('-01')) { if (i) monthStarts.push(i); monthLabels.push([i, f.monthName(d, true)]); } });
    makeChart(document.getElementById('seasChart'), {
      type: 'line',
      data: {
        labels: dd.time.map((d) => f.dateShort(d)),
        datasets: [
          { label: 'P90', data: smooth(p(0.9)), borderColor: 'transparent', backgroundColor: alpha('#ffb547', 0.2), fill: '+1', pointRadius: 0 },
          { label: 'P10', data: smooth(p(0.1)), borderColor: 'transparent', pointRadius: 0 },
          { label: `Máxima mediana ${f.tempUnit()}`, data: smooth(p(0.5)), borderColor: t.warm, borderWidth: 2.2, pointRadius: 0, tension: 0.3 },
          { label: 'Máxima diaria (mediana)', data: p(0.5), borderColor: alpha('#ffb547', 0.35), borderWidth: 1, pointRadius: 0 },
        ],
      },
      options: baseOptions({
        plugins: { legend: { display: false }, tooltip: baseOptions().plugins.tooltip, markers: { days: monthStarts, labels: monthLabels } },
        scales: {
          x: { grid: { display: false }, ticks: { display: false } },
          y: { grid: { color: t.grid }, ticks: { color: t.text3, callback: (v) => v + '°' } },
        },
      }),
    });
  } catch (e) { /* el gráfico es opcional */ }
}

function anomWord(ta, pa) {
  const t = ta > 1 ? 'más cálida' : ta < -1 ? 'más fría' : 'normal';
  const p = pa > 5 ? ', más húmeda' : pa < -5 ? ', más seca' : '';
  return `<span class="small">${t}${p}</span>`;
}

export default {
  render(el) {
    el.innerHTML = `<div class="toolbar" id="trendTabs"></div><div id="trendBody"></div>`;
    const body = el.querySelector('#trendBody');
    const go = () => {
      loading(body);
      if (view.section === 'ens') renderEnsemble(body); else renderSeasonal(body);
    };
    el.querySelector('#trendTabs').append(chips([['ens', 'Escenarios (hasta 35 días)'], ['seas', 'Semanas y meses (hasta 6 meses)']], view.section, (v) => { view.section = v; go(); }));
    go();
  },
};
