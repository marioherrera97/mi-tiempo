// Vista "Aire": índice de calidad del aire, contaminantes, polen y UV
import { state } from '../state.js';
import * as api from '../api.js';
import * as f from '../format.js';
import { aqiLevel, css } from '../colors.js';
import { loading, errorBox } from '../ui.js';
import { makeChart, baseOptions, theme, alpha } from '../charts.js';

const POLLEN = [
  ['grass_pollen', 'Gramíneas'], ['olive_pollen', 'Olivo'], ['birch_pollen', 'Abedul'],
  ['alder_pollen', 'Aliso'], ['mugwort_pollen', 'Artemisa'], ['ragweed_pollen', 'Ambrosía'],
];
// Umbrales aproximados (granos/m³) para nivel bajo / moderado / alto
const pollenLevel = (v) => (!f.isNum(v) ? ['–', 'var(--text-3)', 0] : v < 10 ? ['Bajo', '#3ccf8e', v / 10 * 25] : v < 50 ? ['Moderado', '#ffd23f', 25 + (v - 10) / 40 * 35] : v < 200 ? ['Alto', '#ff8a5b', 60 + (v - 50) / 150 * 30] : ['Muy alto', '#ff4d6d', 100]);

export default {
  async render(el) {
    loading(el);
    try {
      const a = await api.airQuality(state.place);
      const c = a.current, h = a.hourly;
      const lv = aqiLevel(c.european_aqi);
      const now = c.time.slice(0, 13);
      let ni = h.time.findIndex((t) => t.slice(0, 13) === now);
      if (ni < 0) ni = 0;
      const hasPollen = POLLEN.some(([k]) => h[k]?.some((v) => v > 0));
      const pol = POLLEN.map(([k, name]) => {
        const next24 = (h[k] || []).slice(ni, ni + 24).filter(f.isNum);
        const max = next24.length ? Math.max(...next24) : null;
        const [lvl, color, pct] = pollenLevel(max);
        return `<div class="pollen-row"><span>${name}</span><div class="meter"><i style="width:${Math.min(100, pct)}%;background:${color}"></i></div><span class="small" style="text-align:right;color:${color}">${lvl}</span></div>`;
      }).join('');
      const item = (k, v, unit, lim) => `<div class="stat"><div class="k">${k}</div><div class="v">${f.fixed(v, v < 10 ? 1 : 0)} <span class="tiny">${unit}</span></div>${lim ? `<div class="meter" style="margin-top:6px"><i style="width:${Math.min(100, (v / lim) * 100)}%;background:${v > lim ? 'var(--danger)' : 'var(--ok)'}"></i></div>` : ''}</div>`;
      el.innerHTML = `
        <div class="card">
          <div class="aqi-big"><div class="ring" style="background:${lv.color}">${Math.round(c.european_aqi ?? 0)}</div>
            <div><h2>Calidad del aire: ${lv.name}</h2><span class="small muted">Índice europeo (EAQI) · EE. UU. AQI ${Math.round(c.us_aqi ?? 0)}</span></div></div>
        </div>
        <div class="section-title">Contaminantes ahora</div>
        <div class="grid3">
          ${item('PM2.5', c.pm2_5, 'µg/m³', 15)}
          ${item('PM10', c.pm10, 'µg/m³', 45)}
          ${item('Ozono O₃', c.ozone, 'µg/m³', 100)}
          ${item('NO₂', c.nitrogen_dioxide, 'µg/m³', 25)}
          ${item('SO₂', c.sulphur_dioxide, 'µg/m³', 40)}
          ${item('Polvo (calima)', c.dust, 'µg/m³', 50)}
        </div>
        <p class="note">Barras: comparación con las guías diarias de la OMS (2021).</p>
        <div class="card"><div class="card-head"><h2>Índice de calidad del aire (5 días)</h2></div>
          <div class="chart-box short"><canvas id="aqiChart"></canvas></div></div>
        ${hasPollen ? `<div class="card"><div class="card-head"><h2>Polen (próximas 24 h)</h2><span class="tiny">solo Europa</span></div>${pol}
          <div class="chart-box short" style="margin-top:10px"><canvas id="pollenChart"></canvas></div></div>`
          : '<div class="card"><h2>Polen</h2><p class="note">Sin datos de polen para este lugar ahora mismo (solo Europa y en temporada).</p></div>'}
        <div class="card"><div class="card-head"><h2>Índice UV</h2></div><div class="chart-box short"><canvas id="uvChart"></canvas></div></div>
        <p class="footer-note">Datos: CAMS (Copernicus Atmosphere Monitoring Service) vía Open-Meteo.</p>`;

      const t = theme();
      const idx = h.time.map((_, i) => i).filter((i) => i >= ni);
      const lab = idx.map((i) => f.hh(h.time[i]));
      const days = [], dayLabels = [];
      idx.forEach((i, j) => { if (j === 0 || f.hh(h.time[i]) === '00') { if (j) days.push(j); dayLabels.push([j, f.dayShort(h.time[i])]); } });
      const markers = { days, labels: dayLabels };
      const xs = { grid: { display: false }, ticks: { color: t.text3, maxRotation: 0, autoSkipPadding: 12 } };
      makeChart(document.getElementById('aqiChart'), {
        type: 'bar',
        data: { labels: lab, datasets: [{ label: 'EAQI', data: idx.map((i) => h.european_aqi[i]), backgroundColor: idx.map((i) => css('aqi', h.european_aqi[i])), barPercentage: 1, categoryPercentage: 1 }] },
        options: baseOptions({ plugins: { legend: { display: false }, tooltip: baseOptions().plugins.tooltip, markers }, scales: { x: xs, y: { beginAtZero: true, grid: { color: t.grid } } } }),
      });
      if (hasPollen) {
        const colors = ['#90be6d', '#c9b458', '#f4a261', '#e76f51', '#8ecae6', '#c77dff'];
        makeChart(document.getElementById('pollenChart'), {
          type: 'line',
          data: { labels: lab, datasets: POLLEN.filter(([k]) => h[k]?.some((v) => v > 0)).map(([k, name], n) => ({ label: name, data: idx.map((i) => h[k][i]), borderColor: colors[n], pointRadius: 0, borderWidth: 1.8, tension: 0.3 })) },
          options: baseOptions({ plugins: { ...baseOptions().plugins, legend: { ...baseOptions().plugins.legend, align: 'start' }, markers }, scales: { x: xs, y: { beginAtZero: true, grid: { color: t.grid } } } }),
        });
      }
      makeChart(document.getElementById('uvChart'), {
        type: 'line',
        data: { labels: lab, datasets: [{ label: 'UV', data: idx.map((i) => h.uv_index[i]), borderColor: '#ffb547', backgroundColor: alpha('#ffb547', 0.2), fill: 'origin', pointRadius: 0, tension: 0.3 }] },
        options: baseOptions({ plugins: { legend: { display: false }, tooltip: baseOptions().plugins.tooltip, markers }, scales: { x: xs, y: { beginAtZero: true, suggestedMax: 8, grid: { color: t.grid } } } }),
      });
    } catch (e) {
      errorBox(el, e, () => this.render(el));
    }
  },
};
