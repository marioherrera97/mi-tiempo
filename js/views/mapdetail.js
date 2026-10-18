// Panel de pronóstico del punto sobre el mapa, con el aspecto del de Windy:
// resumen de días con la silueta de temperaturas, tabla clara y barra roja con los selectores.
import { state, settings, saveSettings } from '../state.js';
import { getForecast } from '../data.js';
import * as api from '../api.js';
import * as f from '../format.js';
import { wxIcon } from '../icons.js';
import { css, textOn } from '../colors.js';
import { makeChart, baseOptions, theme, alpha, PALETTE } from '../charts.js';

const VIEWS = [['basic', 'Básico'], ['meteo', 'Meteograma'], ['waves', 'Olas'], ['models', 'Modelos']];
const CMP_MODELS = ['ecmwf_ifs', 'gfs_seamless', 'icon_seamless', 'meteofrance_seamless', 'ukmo_seamless', 'ecmwf_aifs025_single', 'gem_seamless'];
const view = { tab: 'basic', step: 3, cmpVar: 'temperature_2m' };
let sheet = null;
const DIAS = ['DOMINGO', 'LUNES', 'MARTES', 'MIÉRCOLES', 'JUEVES', 'VIERNES', 'SÁBADO'];

const cell = (txt, style = '', cls = '') => `<td${cls ? ` class="${cls}"` : ''}${style ? ` style="${style}"` : ''}>${txt}</td>`;
const colored = (scale, v, txt, mul = 1) => (f.isNum(v) ? cell(txt, `background:${css(scale, v, mul)};color:${textOn(scale, v, mul)}`, 'cval') : cell('–'));

function hourIdx(times, nowKey, step, maxH) {
  let i0 = times.findIndex((t) => t.slice(0, 13) >= nowKey);
  if (i0 < 0) i0 = 0;
  // Con paso de 3 h, alinear a 2, 5, 8… como Windy
  if (step === 3) while (i0 > 0 && (+times[i0].slice(11, 13) + 1) % 3 !== 0) i0--;
  const out = [];
  for (let i = i0; i < Math.min(times.length, i0 + maxH); i += step) out.push(i);
  return out;
}

function headRows(times, idx) {
  let days = '';
  let k = 0;
  while (k < idx.length) {
    const day = times[idx[k]].slice(0, 10);
    let n = 0;
    while (k + n < idx.length && times[idx[k + n]].startsWith(day)) n++;
    const p = f.parts(day);
    days += `<td colspan="${n}" class="${k ? 'daystart' : ''}"><span>${n >= 3 ? DIAS[p.wd] + ' ' + p.D : p.D}</span></td>`;
    k += n;
  }
  const isStart = (j) => j > 0 && times[idx[j]].slice(0, 10) !== times[idx[j - 1]].slice(0, 10);
  const hours = idx.map((i, j) => `<td class="${isStart(j) ? 'daystart' : ''}">${+times[i].slice(11, 13)}</td>`).join('');
  return { html: `<tr class="r-day"><th class="rowlab"></th>${days}</tr><tr class="r-hour"><th class="rowlab">Horas</th>${hours}</tr>`, isStart };
}

function rowHtml(label, idx, isStart, fn, nowJ = -1) {
  const td = (html, j) => html.replace(/^<td( class="([^"]*)")?/, (m, a, c) => `<td class="${[c, isStart(j) ? 'daystart' : '', j === nowJ ? 'nowcol' : ''].filter(Boolean).join(' ')}"`);
  return `<tr><th class="rowlab">${label}</th>${idx.map((i, j) => td(fn(i), j)).join('')}</tr>`;
}

// ---------- Cabecera: días con silueta de temperaturas y franja de lluvia ----------
function summary(d) {
  const dd = d.daily, h = d.hourly;
  const today = d.current.time.slice(0, 10);
  const ti = Math.max(0, dd.time.indexOf(today));
  const n = Math.min(7, dd.time.length - ti);
  const days = dd.time.slice(ti, ti + n);
  // Silueta: temperatura hora a hora de esos días
  const i0 = h.time.findIndex((t) => t.startsWith(days[0]));
  const temps = h.temperature_2m.slice(i0, i0 + n * 24).filter(f.isNum);
  const lo = Math.min(...temps), hi = Math.max(...temps);
  const W = n * 100, H = 60;
  const pts = temps.map((v, k) => `${((k / (temps.length - 1)) * W).toFixed(1)},${(H - 6 - ((v - lo) / Math.max(1, hi - lo)) * (H - 16)).toFixed(1)}`);
  const area = `M0,${H} L${pts.join(' L')} L${W},${H} Z`;
  // Lluvia: una barra por hora
  const rain = h.precipitation.slice(i0, i0 + n * 24).map((v, k) => (v >= 0.1 ? `<i style="left:${(k / (n * 24)) * 100}%;opacity:${Math.min(1, 0.35 + v / 3).toFixed(2)}"></i>` : '')).join('');
  return `<div class="wd-days" style="--n:${n}">
      <svg class="wd-mountain" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><path d="${area}"/></svg>
      ${days.map((day, k) => `<div class="wd-day${k === 0 ? ' today' : ''}">
        <span class="wd-dn">${DIAS[f.parts(day).wd].slice(0, 3)}</span>
        ${wxIcon(dd.weather_code[ti + k], 1)}
        <span class="wd-t">${f.temp(dd.temperature_2m_min[ti + k])} / <b>${f.temp(dd.temperature_2m_max[ti + k])}</b></span>
      </div>`).join('')}
    </div>
    <div class="wd-rainrow"><span class="wd-drops">💧</span><div class="wd-rain">${rain}</div></div>`;
}

// ---------- Vistas ----------
async function basic(body, d) {
  const h = d.hourly;
  const idx = hourIdx(h.time, d.current.time.slice(0, 13), view.step, view.step === 1 ? 72 : h.time.length);
  const nowKey = d.current.time.slice(0, 13);
  let nowJ = idx.findIndex((i) => h.time[i].slice(0, 13) >= nowKey);
  if (view.step === 3 && nowJ > 0 && h.time[idx[nowJ]].slice(0, 13) > nowKey) nowJ--;
  const { html, isStart } = headRows(h.time, idx);
  const R = (label, fn) => rowHtml(label, idx, isStart, fn, nowJ);
  body.innerHTML = `<div class="wd-table"><table>${html}
    <tr class="r-icon"><th class="rowlab"></th>${idx.map((i, j) => `<td class="${[isStart(j) ? 'daystart' : '', j === nowJ ? 'nowcol' : ''].join(' ')}">${wxIcon(h.weather_code[i], h.is_day[i])}</td>`).join('')}</tr>
    ${R(`Temperatura <small>${f.tempUnit()}</small>`, (i) => cell(f.temp(h.temperature_2m[i]), '', 'big'))}
    ${R(`Sens. térmica <small>${f.tempUnit()}</small>`, (i) => cell(f.temp(h.apparent_temperature[i]), '', 'soft'))}
    ${R(`Lluvia <small>${f.precipUnit()}</small>`, (i) => {
    let sum = 0;
    for (let k = i; k < i + view.step && k < h.time.length; k++) sum += h.precipitation[k] || 0;
    return cell(sum >= 0.1 ? f.precip(sum) : '', '', 'rainv');
  })}
    ${R(`Viento <small>${f.windUnit()}</small>`, (i) => colored('wind', h.wind_speed_10m[i], f.wind(h.wind_speed_10m[i])))}
    ${R(`Rachas <small>${f.windUnit()}</small>`, (i) => colored('wind', h.wind_gusts_10m[i], f.wind(h.wind_gusts_10m[i])))}
    ${R('Dirección', (i) => cell(f.arrow(h.wind_direction_10m[i])))}
    ${R('Nubes <small>%</small>', (i) => cell(f.isNum(h.cloud_cover[i]) ? Math.round(h.cloud_cover[i]) : '–', '', 'soft'))}
    ${R('Prob. lluvia', (i) => cell(f.isNum(h.precipitation_probability[i]) && h.precipitation_probability[i] >= 5 ? h.precipitation_probability[i] + '%' : '', '', 'rainv'))}
  </table></div>`;
  scrollToNow(body);
}

async function meteo(body, d) {
  body.classList.add('dark');
  const h = d.hourly;
  const idx = hourIdx(h.time, d.current.time.slice(0, 13), 1, 24 * 7);
  const t = theme();
  const labels = idx.map((i) => f.hh(h.time[i]));
  const days = [], dayLabels = [];
  const today = d.current.time.slice(0, 10);
  idx.forEach((i, j) => { if (j === 0 || f.hh(h.time[i]) === '00') { if (j) days.push(j); dayLabels.push([j, f.dayName(h.time[i], today).slice(0, 3) + ' ' + f.parts(h.time[i]).D]); } });
  const markers = { days, labels: dayLabels, now: 0 };
  body.innerHTML = `<div class="chart-scroll"><div class="chart-box" style="min-width:1000px;height:180px"><canvas id="dtTemp"></canvas></div>
    <div class="chart-box" style="min-width:1000px;height:140px"><canvas id="dtWind"></canvas></div></div>`;
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
    body.innerHTML = '<p class="wd-note">Sin datos de mar para este punto. Toca un punto del mar o de la costa en el mapa.</p>';
    return;
  }
  const nowKey = f.placeNow(d.utc_offset_seconds).slice(0, 13);
  const idx = hourIdx(h.time, nowKey, view.step, h.time.length);
  const { html, isStart } = headRows(h.time, idx);
  const R = (label, fn) => rowHtml(label, idx, isStart, fn);
  body.innerHTML = `<div class="wd-table"><table>${html}
    ${R('Olas <small>m</small>', (i) => colored('waves', h.wave_height[i], f.fixed(h.wave_height[i], 1)))}
    ${R('Periodo <small>s</small>', (i) => cell(f.fixed(h.wave_period[i], 0)))}
    ${R('Dirección', (i) => cell(f.arrow(h.wave_direction[i])))}
    ${R('Mar de fondo <small>m</small>', (i) => colored('waves', h.swell_wave_height[i], f.fixed(h.swell_wave_height[i], 1), 0.7))}
    ${R('Periodo fondo <small>s</small>', (i) => cell(f.fixed(h.swell_wave_period[i], 0)))}
    ${R('Dir. fondo', (i) => cell(f.arrow(h.swell_wave_direction[i])))}
    ${R('Mar de viento <small>m</small>', (i) => cell(f.fixed(h.wind_wave_height[i], 1)))}
    ${R(`Agua <small>${f.tempUnit()}</small>`, (i) => colored('sst', h.sea_surface_temperature[i], f.temp(h.sea_surface_temperature[i]), 0.7))}
    ${R('Marea <small>m</small>', (i) => cell(f.isNum(h.sea_level_height_msl[i]) ? (h.sea_level_height_msl[i] > 0 ? '+' : '') + h.sea_level_height_msl[i].toFixed(1) : '–'))}
  </table></div>`;
}

async function models(body) {
  const VARS = [['temperature_2m', 'Temperatura'], ['precipitation', 'Lluvia'], ['wind_speed_10m', 'Viento'], ['cloud_cover', 'Nubes']];
  body.innerHTML = `<div class="wd-chips">${VARS.map(([k, l]) => `<button class="${k === view.cmpVar ? 'on' : ''}" data-v="${k}">${l}</button>`).join('')}</div><div id="dtCmp"><div class="loading"><div class="spinner"></div></div></div>`;
  body.querySelectorAll('[data-v]').forEach((b) => { b.onclick = () => { view.cmpVar = b.dataset.v; models(body); }; });
  const v = view.cmpVar;
  const d = await api.compareModels(state.place, CMP_MODELS, [v]);
  const h = d.hourly;
  const nowKey = f.placeNow(d.utc_offset_seconds).slice(0, 13);
  const idx = hourIdx(h.time, nowKey, 3, 24 * 7);
  const { html, isStart } = headRows(h.time, idx);
  const fmt = (val, i, key) => {
    if (v === 'temperature_2m') return colored('temp', val, f.temp(val), 0.8);
    if (v === 'wind_speed_10m') return colored('wind', val, f.wind(val));
    if (v === 'cloud_cover') return cell(f.isNum(val) ? Math.round(val) : '–', `background:rgba(120,130,145,${((val || 0) / 100 * 0.45).toFixed(2)})`);
    let sum = 0, any = false;
    for (let k = i; k < i + 3; k++) if (f.isNum(h[key][k])) { sum += h[key][k]; any = true; }
    return !any ? cell('–') : cell(sum >= 0.1 ? f.precip(sum) : '', '', 'rainv');
  };
  const rows = CMP_MODELS.map((m, n) => {
    const key = `${v}_${m}`;
    if (!h[key]?.some(f.isNum)) return '';
    const name = api.MODELS.find((x) => x.id === m)?.short || m;
    return rowHtml(`<span style="color:${PALETTE[n]}">●</span> ${name}`, idx, isStart, (i) => fmt(h[key][i], i, key));
  }).join('');
  body.querySelector('#dtCmp').innerHTML = `<div class="wd-table"><table>${html}${rows}</table></div>
    <p class="wd-note">Si los modelos coinciden, el pronóstico es fiable; si discrepan, hay incertidumbre.</p>`;
}

function scrollToNow(body) {
  const now = body.querySelector('td.nowcol');
  const wrap = body.querySelector('.wd-table');
  if (now && wrap) wrap.scrollLeft = Math.max(0, now.offsetLeft - 120);
}

const RENDER = { basic, meteo, waves, models };

async function renderAll() {
  const top = sheet.querySelector('.wd-top');
  const body = sheet.querySelector('.wd-body');
  body.classList.remove('dark');
  body.innerHTML = '<div class="loading"><div class="spinner"></div>Cargando…</div>';
  try {
    const d = await getForecast();
    top.innerHTML = summary(d) + `<a class="wd-15" href="#/inicio">Pronóstico de 15 días ›</a>`;
    await RENDER[view.tab](body, d);
  } catch (e) {
    body.innerHTML = `<p class="wd-note">${f.esc(e.message)}</p>`;
  }
}

export function openDetail(root) {
  if (!sheet) {
    sheet = document.createElement('div');
    sheet.className = 'wdetail';
    root.appendChild(sheet);
  }
  sheet.innerHTML = `
    <button class="w-close wd-close" data-close aria-label="Cerrar"><svg viewBox="0 0 24 24"><path d="M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg></button>
    <div class="wd-top"></div>
    <div class="wd-body"></div>
    <div class="wd-bar">
      <label><span>pronóstico</span><select data-step>${[[1, '1 hora'], [3, '3 horas']].map(([v, l]) => `<option value="${v}" ${v === view.step ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label><span>Mostrar como:</span><select data-view>${VIEWS.map(([v, l]) => `<option value="${v}" ${v === view.tab ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label><span>Fuente:</span><select data-model>${api.MODELS.map((m) => `<option value="${m.id}" ${m.id === settings.model ? 'selected' : ''}>${m.short}</option>`).join('')}</select></label>
    </div>`;
  sheet.classList.add('open');
  sheet.querySelector('[data-close]').onclick = closeDetail;
  sheet.querySelector('[data-step]').onchange = (e) => { view.step = +e.target.value; renderAll(); };
  sheet.querySelector('[data-view]').onchange = (e) => { view.tab = e.target.value; renderAll(); };
  // Cambiar la fuente cambia el modelo de toda la app (y vuelve a abrir este panel)
  sheet.querySelector('[data-model]').onchange = (e) => { settings.model = e.target.value; saveSettings(); };
  renderAll();
}

export function closeDetail() { sheet?.classList.remove('open'); }
export const detailOpen = () => !!sheet?.classList.contains('open');
