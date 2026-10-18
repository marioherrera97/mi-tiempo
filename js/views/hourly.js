// Vista "Por horas": tabla tipo Windy hora a hora (hasta 16 días) y meteograma
import { settings, saveSettings } from '../state.js';
import { getForecast } from '../data.js';
import { MODELS } from '../api.js';
import * as f from '../format.js';
import { wxIcon } from '../icons.js';
import { css } from '../colors.js';
import { loading, errorBox, chips, selectEl, segmented } from '../ui.js';
import { makeChart, baseOptions, theme, alpha } from '../charts.js';
import { nowIndex } from './home.js';

const view = { range: '7d', step: 1 };
const RANGES = [['48h', '48 h'], ['7d', '7 días'], ['all', 'Todo']];

// Cada fila devuelve celdas como objetos { t: texto, cls, style }
function buildRows(d, idx) {
  const h = d.hourly;
  const any = (key, th) => idx.some((i) => (h[key]?.[i] ?? 0) > th);
  const dot = { t: '·', cls: 'muted' };
  const rows = [];
  rows.push(['Temperatura', (i) => colored('temp', h.temperature_2m[i], f.temp(h.temperature_2m[i]))]);
  rows.push(['Sensación', (i) => ({ t: f.temp(h.apparent_temperature[i]) })]);
  rows.push(['sep']);
  rows.push([`Lluvia ${f.precipUnit()}`, (i) => {
    const v = h.precipitation[i];
    return v >= 0.1 ? colored('precip', v, f.precip(v), true) : dot;
  }]);
  rows.push(['Prob. lluvia', (i) => {
    const v = h.precipitation_probability[i];
    return { t: f.isNum(v) ? v + '%' : '–', style: `color:${v >= 50 ? 'var(--rain)' : 'var(--text-2)'}` };
  }]);
  if (any('snowfall', 0)) rows.push(['Nieve cm', (i) => (h.snowfall[i] > 0 ? { t: f.snow(h.snowfall[i], false) } : dot)]);
  if (any('snow_depth', 0.005)) rows.push(['Espesor nieve', (i) => (h.snow_depth[i] > 0 ? { t: f.snow(h.snow_depth[i] * 100, false) } : dot)]);
  rows.push(['sep']);
  rows.push(['Nubes total', (i) => cloud(h.cloud_cover[i])]);
  rows.push(['Nubes bajas', (i) => cloud(h.cloud_cover_low[i])]);
  rows.push(['Nubes medias', (i) => cloud(h.cloud_cover_mid[i])]);
  rows.push(['Nubes altas', (i) => cloud(h.cloud_cover_high[i])]);
  rows.push(['sep']);
  rows.push([`Viento ${f.windUnit()}`, (i) => colored('wind', h.wind_speed_10m[i], f.wind(h.wind_speed_10m[i]))]);
  rows.push(['Rachas', (i) => colored('wind', h.wind_gusts_10m[i], f.wind(h.wind_gusts_10m[i]))]);
  rows.push(['Dirección', (i) => ({ t: f.arrow(h.wind_direction_10m[i]) }), 'r-dir']);
  rows.push(['sep']);
  rows.push(['Humedad', (i) => ({ t: f.pct(h.relative_humidity_2m[i]) })]);
  rows.push(['Punto rocío', (i) => ({ t: f.temp(h.dew_point_2m[i]) })]);
  rows.push([`Presión ${f.pressureUnit()}`, (i) => ({ t: f.pressure(h.pressure_msl[i]) })]);
  rows.push(['Visibilidad', (i) => ({ t: visShort(h.visibility[i]) })]);
  rows.push(['Índice UV', (i) => {
    const v = h.uv_index[i];
    return v >= 0.5 ? colored('uv', v, f.fixed(v, 0)) : dot;
  }]);
  rows.push(['Sol (min)', (i) => {
    const v = h.sunshine_duration[i];
    return v > 0 ? { t: Math.round(v / 60), style: 'color:var(--warm)' } : dot;
  }]);
  rows.push(['Isocero', (i) => {
    const v = h.freezing_level_height[i];
    if (!f.isNum(v)) return { t: '–' };
    return { t: settings.distance === 'mi' ? (v * 3.28084 / 1000).toFixed(1) + 'k' : (v / 1000).toFixed(1) };
  }]);
  if (any('cape', 50)) rows.push(['CAPE (tormenta)', (i) => {
    const v = h.cape[i];
    return v >= 50 ? colored('cape', v, Math.round(v), true) : dot;
  }]);
  return rows;
}

function colored(scale, v, text, translucent = false) {
  if (!f.isNum(v)) return { t: '–' };
  return { t: text, cls: 'cval', style: `background:${css(scale, v, translucent ? 1.3 : 0.9)}` };
}
function cloud(v) {
  if (!f.isNum(v)) return { t: '–' };
  return { t: v >= 5 ? Math.round(v) : '·', style: `background:rgba(170,180,195,${((v / 100) * 0.55).toFixed(2)})` };
}
function visShort(m) {
  if (!f.isNum(m)) return '–';
  if (settings.distance === 'mi') return (m / 1609).toFixed(m < 16000 ? 1 : 0);
  return m >= 10000 ? Math.round(m / 1000) : (m / 1000).toFixed(1);
}

function table(d, idx, ni) {
  const h = d.hourly;
  const today = d.current?.time.slice(0, 10);
  // fila de días
  let dayRow = '';
  let k = 0;
  while (k < idx.length) {
    const day = h.time[idx[k]].slice(0, 10);
    let n = 0;
    while (k + n < idx.length && h.time[idx[k + n]].startsWith(day)) n++;
    const di = d.daily.time.indexOf(day);
    const mm = di >= 0 ? ` · ${f.temp(d.daily.temperature_2m_max[di])}/${f.temp(d.daily.temperature_2m_min[di])}` : '';
    dayRow += `<td colspan="${n}" class="${k ? 'daystart' : ''}"><span>${f.dayName(day, today)} ${f.dateShort(day)}${n >= 4 ? mm : ''}</span></td>`;
    k += n;
  }
  const isDayStart = (j) => j > 0 && f.hh(h.time[idx[j]]) < f.hh(h.time[idx[j - 1]]);
  const colCls = (j) => [isDayStart(j) ? 'daystart' : '', idx[j] === ni ? 'nowcol' : ''].join(' ').trim();
  const hourRow = idx.map((i, j) => `<td class="${colCls(j)}">${i === ni ? 'ahora' : f.hh(h.time[i])}</td>`).join('');
  const iconRow = idx.map((i, j) => `<td class="${colCls(j)}">${wxIcon(h.weather_code[i], h.is_day[i])}</td>`).join('');
  const rows = buildRows(d, idx);
  const body = rows.map(([label, fn, rowCls]) => {
    if (label === 'sep') return `<tr class="r-sep"><th class="rowlab"></th><td colspan="${idx.length}"></td></tr>`;
    const tds = idx.map((i, j) => {
      const c = fn(i);
      const cls = [c.cls, colCls(j)].join(' ').trim();
      return `<td${cls ? ` class="${cls}"` : ''}${c.style ? ` style="${c.style}"` : ''}>${c.t}</td>`;
    }).join('');
    return `<tr${rowCls ? ` class="${rowCls}"` : ''}><th class="rowlab">${label}</th>${tds}</tr>`;
  }).join('');
  return `<div class="wtable-wrap" id="wtableWrap"><table class="wtable">
    <tr class="r-day"><th class="rowlab"></th>${dayRow}</tr>
    <tr class="r-hour"><th class="rowlab">Hora</th>${hourRow}</tr>
    <tr class="r-icon"><th class="rowlab"></th>${iconRow}</tr>
    ${body}
  </table></div>`;
}

function charts(d, idx, ni) {
  const h = d.hourly;
  const t = theme();
  const labels = idx.map((i) => f.hh(h.time[i]));
  const days = [], dayLabels = [];
  const today = d.current?.time.slice(0, 10);
  idx.forEach((i, j) => {
    if (j === 0 || f.hh(h.time[i]) === '00') {
      if (j > 0) days.push(j);
      dayLabels.push([j, f.dayName(h.time[i], today).slice(0, 3) + ' ' + f.parts(h.time[i]).D]);
    }
  });
  const nowJ = idx.indexOf(ni);
  const markers = { days, labels: dayLabels, now: nowJ >= 0 ? nowJ : null };
  const width = Math.max(idx.length * (view.step === 1 ? 7 : 16), 600);
  document.querySelectorAll('.meteo-box').forEach((b) => { b.style.minWidth = width + 'px'; });

  makeChart(document.getElementById('meteoTemp'), {
    data: {
      labels,
      datasets: [
        { type: 'line', label: `Temperatura ${f.tempUnit()}`, data: idx.map((i) => f.tempVal(h.temperature_2m[i])), borderColor: t.warm, backgroundColor: alpha('#ffb547', 0.12), fill: 'origin', tension: 0.3, pointRadius: 0, borderWidth: 2, yAxisID: 'y' },
        { type: 'line', label: 'Sensación', data: idx.map((i) => f.tempVal(h.apparent_temperature[i])), borderColor: '#ff7a59', borderDash: [4, 4], tension: 0.3, pointRadius: 0, borderWidth: 1.4, yAxisID: 'y' },
        { type: 'line', label: 'Punto de rocío', data: idx.map((i) => f.tempVal(h.dew_point_2m[i])), borderColor: '#3ccf8e', tension: 0.3, pointRadius: 0, borderWidth: 1.2, yAxisID: 'y' },
        { type: 'bar', label: `Lluvia ${f.precipUnit()}`, data: idx.map((i) => f.precipVal(h.precipitation[i])), backgroundColor: alpha('#4aa8ff', 0.8), yAxisID: 'y1', barPercentage: 1, categoryPercentage: 0.9 },
        { type: 'line', label: 'Prob. lluvia %', data: idx.map((i) => h.precipitation_probability[i]), borderColor: alpha('#4aa8ff', 0.5), pointRadius: 0, borderWidth: 1, stepped: true, yAxisID: 'y2', hidden: true },
      ],
    },
    options: baseOptions({
      plugins: { ...baseOptions().plugins, markers },
      scales: {
        x: { grid: { display: false }, ticks: { color: t.text3, maxRotation: 0, autoSkipPadding: 10 } },
        y: { grid: { color: t.grid }, ticks: { color: t.text3, callback: (v) => v + '°' } },
        y1: { position: 'right', beginAtZero: true, suggestedMax: 3, grid: { display: false }, ticks: { color: t.rain } },
        y2: { display: false, min: 0, max: 100 },
      },
    }),
  });

  makeChart(document.getElementById('meteoWind'), {
    data: {
      labels,
      datasets: [
        { type: 'line', label: `Viento ${f.windUnit()}`, data: idx.map((i) => f.windVal(h.wind_speed_10m[i])), borderColor: '#4fa3ff', backgroundColor: alpha('#4fa3ff', 0.15), fill: 'origin', tension: 0.3, pointRadius: 0, borderWidth: 2, yAxisID: 'y' },
        { type: 'line', label: 'Rachas', data: idx.map((i) => f.windVal(h.wind_gusts_10m[i])), borderColor: '#c77dff', tension: 0.3, pointRadius: 0, borderWidth: 1.4, borderDash: [3, 3], yAxisID: 'y' },
        { type: 'line', label: `Presión ${f.pressureUnit()}`, data: idx.map((i) => f.pressureVal(h.pressure_msl[i])), borderColor: '#9aa5b5', tension: 0.3, pointRadius: 0, borderWidth: 1.4, yAxisID: 'y1' },
        { type: 'bar', label: 'Nubes %', data: idx.map((i) => h.cloud_cover[i]), backgroundColor: alpha('#aab4c3', 0.18), yAxisID: 'y2', barPercentage: 1, categoryPercentage: 1 },
      ],
    },
    options: baseOptions({
      plugins: { ...baseOptions().plugins, markers },
      scales: {
        x: { grid: { display: false }, ticks: { color: t.text3, maxRotation: 0, autoSkipPadding: 10 } },
        y: { beginAtZero: true, grid: { color: t.grid }, ticks: { color: t.text3 } },
        y1: { position: 'right', grid: { display: false }, ticks: { color: t.text3 } },
        y2: { display: false, min: 0, max: 100 },
      },
    }),
  });
}

export default {
  async render(el) {
    loading(el);
    try {
      const d = await getForecast();
      const ni = nowIndex(d);
      const total = d.hourly.time.length;
      const span = view.range === '48h' ? 48 : view.range === '7d' ? 168 : total;
      const idx = [];
      for (let i = ni; i < Math.min(total, ni + span); i += view.step) idx.push(i);
      const lastDay = d.hourly.time[total - 1];

      el.innerHTML = `
        <div class="toolbar" id="hTools"></div>
        <p class="note" style="margin:0 4px 10px">Datos hasta el ${f.dayLong(lastDay)} · ${f.isNum(d.elevation) ? 'altitud de la rejilla ' + Math.round(d.elevation) + ' m' : ''}. Desliza la tabla en horizontal.</p>
        ${table(d, idx, ni)}
        <div class="legend-row"><span>Nubes: B&lt;2 km, M 2–6 km, A&gt;6 km</span><span>Isocero en km</span><span>Visibilidad en ${settings.distance === 'mi' ? 'mi' : 'km'}</span></div>
        <div class="section-title">Meteograma</div>
        <div class="card"><div class="chart-scroll"><div class="chart-box meteo-box"><canvas id="meteoTemp"></canvas></div></div></div>
        <div class="card"><div class="chart-scroll"><div class="chart-box meteo-box"><canvas id="meteoWind"></canvas></div></div></div>`;

      const tools = el.querySelector('#hTools');
      tools.append(
        selectEl(MODELS.map((m) => [m.id, m.name]), settings.model, (v) => { settings.model = v; saveSettings(); }),
        chips(RANGES, view.range, (v) => { view.range = v; this.render(el); }),
        segmented([[1, '1 h'], [3, '3 h']], view.step, (v) => { view.step = +v; this.render(el); }),
      );
      charts(d, idx, ni);
    } catch (e) {
      errorBox(el, e, () => this.render(el));
    }
  },
};
