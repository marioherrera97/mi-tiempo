// Vista "Comparar modelos": la misma variable en varios modelos a la vez
import { state } from '../state.js';
import * as api from '../api.js';
import * as f from '../format.js';
import { loading, errorBox, chips } from '../ui.js';
import { makeChart, baseOptions, theme, PALETTE } from '../charts.js';

const DEFAULT = ['ecmwf_ifs', 'gfs_seamless', 'icon_seamless', 'meteofrance_seamless', 'ukmo_seamless', 'ecmwf_aifs025_single'];
const view = { models: [...DEFAULT], v: 'temperature_2m', days: 7 };
const VARS = [
  ['temperature_2m', 'Temperatura', f.tempVal, f.tempUnit],
  ['precipitation', 'Lluvia', f.precipVal, () => f.precipUnit()],
  ['wind_speed_10m', 'Viento', f.windVal, f.windUnit],
  ['wind_gusts_10m', 'Rachas', f.windVal, f.windUnit],
  ['cloud_cover', 'Nubes', (v) => v, () => '%'],
  ['pressure_msl', 'Presión', f.pressureVal, f.pressureUnit],
];

export default {
  async render(el) {
    el.innerHTML = `
      <div class="toolbar" id="cmpVars"></div>
      <div class="toolbar" id="cmpDays"></div>
      <div class="card">
        <div class="card-head"><h2 id="cmpTitle"></h2></div>
        <div class="chart-scroll"><div class="chart-box tall" id="cmpBox"><canvas id="cmpChart"></canvas></div></div>
      </div>
      <div class="card" id="cmpSum"></div>
      <div class="card">
        <div class="card-head"><h2>Modelos</h2><span class="tiny">toca para añadir o quitar</span></div>
        <div class="chips" id="cmpModels" style="flex-wrap:wrap"></div>
        <p class="note" style="margin:10px 0 0">Los modelos regionales (AROME, HARMONIE, ICON-2I…) tienen más resolución pero solo cubren su zona y unos pocos días.</p>
      </div>`;
    el.querySelector('#cmpVars').append(chips(VARS.map(([k, l]) => [k, l]), view.v, (v) => { view.v = v; this.render(el); }));
    el.querySelector('#cmpDays').append(chips([[3, '3 días'], [7, '7 días'], [16, '16 días']], view.days, (v) => { view.days = +v; this.render(el); }));
    const mbox = el.querySelector('#cmpModels');
    api.MODELS.filter((m) => m.id !== 'best_match').forEach((m) => {
      const b = document.createElement('button');
      b.className = 'chip' + (view.models.includes(m.id) ? ' on' : '');
      b.textContent = m.short;
      b.title = m.name;
      b.onclick = () => {
        view.models = view.models.includes(m.id) ? view.models.filter((x) => x !== m.id) : [...view.models, m.id];
        this.render(el);
      };
      mbox.append(b);
    });
    const [vk, vl, conv, unit] = VARS.find((x) => x[0] === view.v);
    el.querySelector('#cmpTitle').textContent = `${vl} (${unit()})`;
    if (!view.models.length) { el.querySelector('#cmpSum').innerHTML = '<p class="note">Elige al menos un modelo.</p>'; return; }

    const sum = el.querySelector('#cmpSum');
    loading(sum);
    try {
      const d = await api.compareModels(state.place, view.models, [vk]);
      const h = d.hourly;
      const now = d.utc_offset_seconds !== undefined ? f.placeNow(d.utc_offset_seconds).slice(0, 13) : '';
      let start = h.time.findIndex((t) => t.slice(0, 13) === now);
      if (start < 0) start = 0;
      const end = Math.min(h.time.length, start + view.days * 24);
      const labels = h.time.slice(start, end);
      const t = theme();
      const days = [], dayLabels = [];
      labels.forEach((s, j) => { if (j === 0 || f.hh(s) === '00') { if (j) days.push(j); dayLabels.push([j, f.dayShort(s)]); } });
      const datasets = view.models.map((m, k) => {
        const key = view.models.length === 1 && h[vk] ? vk : `${vk}_${m}`;
        const arr = (h[key] || []).slice(start, end).map(conv);
        return {
          label: api.MODELS.find((x) => x.id === m)?.short || m,
          data: arr, borderColor: PALETTE[k % PALETTE.length], backgroundColor: PALETTE[k % PALETTE.length],
          borderWidth: 1.8, pointRadius: 0, tension: 0.25, spanGaps: false,
          type: vk === 'precipitation' ? 'bar' : 'line',
        };
      });
      el.querySelector('#cmpBox').style.minWidth = Math.max(600, labels.length * 6) + 'px';
      makeChart(el.querySelector('#cmpChart'), {
        type: 'line',
        data: { labels: labels.map((s) => f.hh(s)), datasets },
        options: baseOptions({
          plugins: { ...baseOptions().plugins, legend: { ...baseOptions().plugins.legend, align: 'start' }, markers: { days, labels: dayLabels } },
          scales: { x: { grid: { display: false }, ticks: { color: t.text3, maxRotation: 0, autoSkipPadding: 12 } }, y: { grid: { color: t.grid }, ticks: { color: t.text3 } } },
        }),
      });
      // Resumen: total/medias por día y modelo
      const dayKeys = [...new Set(labels.map((s) => s.slice(0, 10)))];
      const agg = (arr, day) => {
        const v = labels.map((s, i) => (s.startsWith(day) ? arr[i] : null)).filter(f.isNum);
        if (!v.length) return '–';
        if (vk === 'precipitation') return v.reduce((a, b) => a + b, 0).toFixed(f.precipUnit() === 'in' ? 2 : 1);
        if (vk === 'temperature_2m') return `${Math.round(Math.max(...v))}°/${Math.round(Math.min(...v))}°`;
        return Math.round(Math.max(...v));
      };
      sum.innerHTML = `<div class="card-head"><h2>${vk === 'temperature_2m' ? 'Máx/mín' : vk === 'precipitation' ? 'Total diario' : 'Máximo diario'} por modelo</h2></div>
        <div style="overflow-x:auto"><table class="simple"><thead><tr><th>Modelo</th>${dayKeys.map((k) => `<th class="r">${f.dayShort(k)}</th>`).join('')}</tr></thead>
        <tbody>${datasets.map((ds) => `<tr><td><span style="color:${ds.borderColor}">●</span> ${ds.label}</td>${dayKeys.map((k) => `<td class="r">${agg(ds.data, k)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    } catch (e) {
      errorBox(sum, e, () => this.render(el));
    }
  },
};
