// Panel de detalle del punto sobre el mapa (como el de Windy): Básico, Meteograma, Olas y Modelos
import { state } from '../state.js';
import { getForecast } from '../data.js';
import * as api from '../api.js';
import * as f from '../format.js';
import { wxIcon } from '../icons.js';
import { css, textOn } from '../colors.js';
import { makeChart, baseOptions, theme, alpha, PALETTE } from '../charts.js';

const TABS = [['basic', 'Básico'], ['meteo', 'Meteograma'], ['waves', 'Olas'], ['models', 'Modelos']];
const CMP_MODELS = ['ecmwf_ifs', 'gfs_seamless', 'icon_seamless', 'meteofrance_seamless', 'ukmo_seamless', 'ecmwf_aifs025_single', 'gem_seamless'];
const view = { tab: 'basic', step: 3, cmpVar: 'temperature_2m' };
let sheet = null;

const cell = (txt, style = '', cls = '') => `<td${cls ? ` class="${cls}"` : ''}${style ? ` style="${style}"` : ''}>${txt}</td>`;
const colored = (scale, v, txt, mul = 0.9) => (f.isNum(v) ? cell(txt, `background:${css(scale, v, mul)};color:${textOn(scale, v, mul)}`, 'cval') : cell('–'));

// Índices de horas a mostrar (desde ahora, cada `step` horas)
function hourIdx(times, nowKey, step, maxH) {
  let i0 = times.findIndex((t) => t.slice(0, 13) >= nowKey);
  if (i0 < 0) i0 = 0;
  const out = [];
  for (let i = i0; i < Math.min(times.length, i0 + maxH); i += step) out.push(i);
  return out;
}

// Cabecera de días y horas común a las tablas
function headRows(times, idx, today) {
  let days = '';
  let k = 0;
  while (k < idx.length) {
    const day = times[idx[k]].slice(0, 10);
    let n = 0;
    while (k + n < idx.length && times[idx[k + n]].startsWith(day)) n++;
    days += `<td colspan="${n}" class="${k ? 'daystart' : ''}"><span>${n * 40 > 70 ? f.dayName(day, today) + ' ' + f.parts(day).D : f.parts(day).D}</span></td>`;
    k += n;
  }
  const isStart = (j) => j > 0 && times[idx[j]].slice(0, 10) !== times[idx[j - 1]].slice(0, 10);
  const hours = idx.map((i, j) => `<td class="${isStart(j) ? 'daystart' : ''}">${f.hh(times[i])}</td>`).join('');
  return { html: `<tr class="r-day"><th class="rowlab"></th>${days}</tr><tr class="r-hour"><th class="rowlab"></th>${hours}</tr>`, isStart };
}

function rowHtml(label, idx, isStart, fn) {
  // Añade la clase "daystart" a la primera celda de cada día
  const td = (html, j) => html.replace(/^<td( class="([^"]*)")?/, (m, a, c) => `<td class="${[c, isStart(j) ? 'daystart' : ''].filter(Boolean).join(' ')}"`);
  return `<tr><th class="rowlab">${label}</th>${idx.map((i, j) => td(fn(i), j)).join('')}</tr>`;
}

// ---------- Pestañas ----------
async function basic(body) {
  const d = await getForecast();
  const h = d.hourly;
  const today = d.current.time.slice(0, 10);
  const idx = hourIdx(h.time, d.current.time.slice(0, 13), view.step, view.step === 1 ? 72 : h.time.length);
  const { html, isStart } = headRows(h.time, idx, today);
  body.innerHTML = `<div class="wtable-wrap detail-table"><table class="wtable">${html}
    <tr class="r-icon"><th class="rowlab"></th>${idx.map((i, j) => `<td class="${isStart(j) ? 'daystart' : ''}">${wxIcon(h.weather_code[i], h.is_day[i])}</td>`).join('')}</tr>
    ${rowHtml(f.tempUnit(), idx, isStart, (i) => colored('temp', h.temperature_2m[i], f.temp(h.temperature_2m[i])))}
    ${rowHtml(f.precipUnit(), idx, isStart, (i) => {
    // lluvia acumulada en el intervalo mostrado
    let sum = 0;
    for (let k = i; k < i + view.step && k < h.time.length; k++) sum += h.precipitation[k] || 0;
    return sum >= 0.1 ? colored('precip', sum / view.step, f.precip(sum), 1.3) : cell('', '', 'muted');
  })}
    ${rowHtml(f.windUnit(), idx, isStart, (i) => colored('wind', h.wind_speed_10m[i], `${f.arrow(h.wind_direction_10m[i])}${f.wind(h.wind_speed_10m[i])}`))}
    ${rowHtml('Rachas', idx, isStart, (i) => colored('wind', h.wind_gusts_10m[i], f.wind(h.wind_gusts_10m[i]), 0.6))}
    ${rowHtml('Nubes', idx, isStart, (i) => cell(f.isNum(h.cloud_cover[i]) ? Math.round(h.cloud_cover[i]) : '–', `background:rgba(170,180,195,${((h.cloud_cover[i] || 0) / 100 * 0.5).toFixed(2)})`))}
    ${rowHtml('Prob.', idx, isStart, (i) => cell(f.isNum(h.precipitation_probability[i]) ? h.precipitation_probability[i] + '%' : '–', h.precipitation_probability[i] >= 50 ? 'color:var(--rain)' : 'color:var(--text-3)'))}
  </table></div>`;
}

async function meteo(body) {
  const d = await getForecast();
  const h = d.hourly;
  const idx = hourIdx(h.time, d.current.time.slice(0, 13), 1, 24 * 7);
  const t = theme();
  const labels = idx.map((i) => f.hh(h.time[i]));
  const days = [], dayLabels = [];
  const today = d.current.time.slice(0, 10);
  idx.forEach((i, j) => { if (j === 0 || f.hh(h.time[i]) === '00') { if (j) days.push(j); dayLabels.push([j, f.dayName(h.time[i], today).slice(0, 3) + ' ' + f.parts(h.time[i]).D]); } });
  const markers = { days, labels: dayLabels, now: 0 };
  body.innerHTML = `<div class="chart-scroll"><div class="chart-box" style="min-width:1000px;height:190px"><canvas id="dtTemp"></canvas></div>
    <div class="chart-box" style="min-width:1000px;height:150px"><canvas id="dtWind"></canvas></div></div>`;
  const xs = { grid: { display: false }, ticks: { color: t.text3, maxRotation: 0, autoSkipPadding: 10 } };
  const legend = { ...baseOptions().plugins.legend, align: 'start' };
  makeChart(document.getElementById('dtTemp'), {
    data: {
      labels,
      datasets: [
        { type: 'line', label: f.tempUnit(), data: idx.map((i) => f.tempVal(h.temperature_2m[i])), borderColor: t.warm, backgroundColor: alpha('#ffb547', 0.12), fill: 'origin', tension: 0.3, pointRadius: 0, borderWidth: 2 },
        { type: 'line', label: 'Rocío', data: idx.map((i) => f.tempVal(h.dew_point_2m[i])), borderColor: '#3ccf8e', tension: 0.3, pointRadius: 0, borderWidth: 1.2 },
        { type: 'bar', label: f.precipUnit(), data: idx.map((i) => f.precipVal(h.precipitation[i])), backgroundColor: alpha('#4aa8ff', 0.8), yAxisID: 'y1', barPercentage: 1, categoryPercentage: 0.9 },
      ],
    },
    options: baseOptions({ plugins: { ...baseOptions().plugins, legend, markers }, scales: { x: xs, y: { grid: { color: t.grid }, ticks: { color: t.text3 } }, y1: { position: 'right', beginAtZero: true, suggestedMax: 3, grid: { display: false }, ticks: { color: t.rain } } } }),
  });
  makeChart(document.getElementById('dtWind'), {
    data: {
      labels,
      datasets: [
        { type: 'line', label: f.windUnit(), data: idx.map((i) => f.windVal(h.wind_speed_10m[i])), borderColor: '#4fa3ff', backgroundColor: alpha('#4fa3ff', 0.15), fill: 'origin', tension: 0.3, pointRadius: 0, borderWidth: 2 },
        { type: 'line', label: 'Rachas', data: idx.map((i) => f.windVal(h.wind_gusts_10m[i])), borderColor: '#c77dff', borderDash: [3, 3], tension: 0.3, pointRadius: 0, borderWidth: 1.4 },
        { type: 'line', label: f.pressureUnit(), data: idx.map((i) => f.pressureVal(h.pressure_msl[i])), borderColor: '#9aa5b5', tension: 0.3, pointRadius: 0, borderWidth: 1.2, yAxisID: 'y1' },
      ],
    },
    options: baseOptions({ plugins: { ...baseOptions().plugins, legend, markers }, scales: { x: xs, y: { beginAtZero: true, grid: { color: t.grid }, ticks: { color: t.text3 } }, y1: { position: 'right', grid: { display: false }, ticks: { color: t.text3 } } } }),
  });
}

async function waves(body) {
  const d = await api.marine(state.place);
  const h = d.hourly;
  if (!h.wave_height.some(f.isNum)) {
    body.innerHTML = '<p class="note" style="padding:12px">Sin datos de mar para este punto. Toca un punto del mar o de la costa en el mapa.</p>';
    return;
  }
  const nowKey = f.placeNow(d.utc_offset_seconds).slice(0, 13);
  const idx = hourIdx(h.time, nowKey, view.step, h.time.length);
  const { html, isStart } = headRows(h.time, idx, nowKey.slice(0, 10));
  body.innerHTML = `<div class="wtable-wrap detail-table"><table class="wtable">${html}
    ${rowHtml('Olas m', idx, isStart, (i) => colored('waves', h.wave_height[i], f.fixed(h.wave_height[i], 1)))}
    ${rowHtml('Periodo s', idx, isStart, (i) => cell(f.fixed(h.wave_period[i], 0)))}
    ${rowHtml('Dirección', idx, isStart, (i) => cell(f.arrow(h.wave_direction[i])))}
    ${rowHtml('Fondo m', idx, isStart, (i) => colored('waves', h.swell_wave_height[i], f.fixed(h.swell_wave_height[i], 1), 0.6))}
    ${rowHtml('Per. fondo', idx, isStart, (i) => cell(f.fixed(h.swell_wave_period[i], 0)))}
    ${rowHtml('Dir. fondo', idx, isStart, (i) => cell(f.arrow(h.swell_wave_direction[i])))}
    ${rowHtml('Mar viento', idx, isStart, (i) => cell(f.fixed(h.wind_wave_height[i], 1)))}
    ${rowHtml('Agua', idx, isStart, (i) => colored('sst', h.sea_surface_temperature[i], f.temp(h.sea_surface_temperature[i]), 0.6))}
    ${rowHtml('Marea m', idx, isStart, (i) => cell(f.isNum(h.sea_level_height_msl[i]) ? (h.sea_level_height_msl[i] > 0 ? '+' : '') + h.sea_level_height_msl[i].toFixed(1) : '–'))}
  </table></div>`;
}

async function models(body) {
  const VARS = [['temperature_2m', 'Temperatura'], ['precipitation', 'Lluvia'], ['wind_speed_10m', 'Viento'], ['cloud_cover', 'Nubes']];
  body.innerHTML = `<div class="chips" id="dtCmpVars" style="margin-bottom:8px">${VARS.map(([k, l]) => `<button class="chip${k === view.cmpVar ? ' on' : ''}" data-v="${k}">${l}</button>`).join('')}</div><div id="dtCmp"><div class="loading"><div class="spinner"></div></div></div>`;
  body.querySelectorAll('[data-v]').forEach((b) => { b.onclick = () => { view.cmpVar = b.dataset.v; models(body); }; });
  const v = view.cmpVar;
  const d = await api.compareModels(state.place, CMP_MODELS, [v]);
  const h = d.hourly;
  const nowKey = f.placeNow(d.utc_offset_seconds).slice(0, 13);
  const idx = hourIdx(h.time, nowKey, 3, 24 * 7);
  const { html, isStart } = headRows(h.time, idx, nowKey.slice(0, 10));
  const fmt = (val, i, key) => {
    if (v === 'temperature_2m') return colored('temp', val, f.temp(val));
    if (v === 'wind_speed_10m') return colored('wind', val, f.wind(val));
    if (v === 'cloud_cover') return cell(f.isNum(val) ? Math.round(val) : '–', `background:rgba(170,180,195,${((val || 0) / 100 * 0.55).toFixed(2)})`);
    let sum = 0, any = false;
    for (let k = i; k < i + 3; k++) if (f.isNum(h[key][k])) { sum += h[key][k]; any = true; }
    return !any ? cell('–') : sum >= 0.1 ? colored('precip', sum / 3, f.precip(sum), 1.3) : cell('', '', 'muted');
  };
  const rows = CMP_MODELS.map((m, n) => {
    const key = `${v}_${m}`;
    if (!h[key]?.some(f.isNum)) return '';
    const name = api.MODELS.find((x) => x.id === m)?.short || m;
    return rowHtml(`<span style="color:${PALETTE[n]}">●</span> ${name}`, idx, isStart, (i) => fmt(h[key][i], i, key));
  }).join('');
  body.querySelector('#dtCmp').innerHTML = `<div class="wtable-wrap detail-table"><table class="wtable">${html}${rows}</table></div>
    <p class="note" style="margin:8px 4px 0">Si los modelos coinciden, el pronóstico es fiable; si discrepan, hay incertidumbre.</p>`;
}

const RENDER = { basic, meteo, waves, models };

async function renderBody() {
  const body = sheet.querySelector('.dt-body');
  body.innerHTML = '<div class="loading"><div class="spinner"></div>Cargando…</div>';
  try {
    await RENDER[view.tab](body);
  } catch (e) {
    body.innerHTML = `<div class="error" style="margin:8px">${f.esc(e.message)}</div>`;
  }
}

export function openDetail(root) {
  if (!sheet) {
    sheet = document.createElement('div');
    sheet.className = 'detail-sheet';
    root.appendChild(sheet);
  }
  const p = state.place;
  sheet.innerHTML = `
    <div class="dt-head">
      <div class="dt-title"><b>${f.esc(p.name)}</b><span class="tiny">${f.esc([p.admin, p.country].filter(Boolean).join(' · ') || `${p.lat.toFixed(3)}, ${p.lon.toFixed(3)}`)}</span></div>
      <a class="small" href="#/horas">Todo →</a>
      <button class="icon-btn" data-close aria-label="Cerrar"><svg class="ico" viewBox="0 0 24 24"><path d="M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg></button>
    </div>
    <div class="dt-tabs">
      <div class="chips">${TABS.map(([k, l]) => `<button class="chip${k === view.tab ? ' on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>
      <div class="seg dt-step">${[1, 3].map((s) => `<button class="${s === view.step ? 'on' : ''}" data-step="${s}">${s} h</button>`).join('')}</div>
    </div>
    <div class="dt-body"></div>`;
  sheet.classList.add('open');
  sheet.querySelector('[data-close]').onclick = closeDetail;
  sheet.querySelectorAll('[data-tab]').forEach((b) => {
    b.onclick = () => {
      view.tab = b.dataset.tab;
      sheet.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x === b));
      renderBody();
    };
  });
  sheet.querySelectorAll('[data-step]').forEach((b) => {
    b.onclick = () => {
      view.step = +b.dataset.step;
      sheet.querySelectorAll('[data-step]').forEach((x) => x.classList.toggle('on', x === b));
      renderBody();
    };
  });
  renderBody();
}

export function closeDetail() { sheet?.classList.remove('open'); }
export const detailOpen = () => !!sheet?.classList.contains('open');
