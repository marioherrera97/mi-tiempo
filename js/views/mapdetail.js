// Panel de pronóstico del punto sobre el mapa, con el aspecto del de Windy:
// resumen de días con la silueta de temperaturas, tabla clara y barra roja con los selectores.
import { state, settings, saveSettings, load, save } from '../state.js';
import { getForecast } from '../data.js';
import * as api from '../api.js';
import * as f from '../format.js';
import { wxIcon } from '../icons.js';
import { css, textOn } from '../colors.js';
import { makeChart, baseOptions, theme, alpha, PALETTE } from '../charts.js';
import { roseSVG, series } from './windmodels.js';

const VIEWS = [['basic', 'Básico'], ['meteo', 'Meteograma'], ['waves', 'Olas'], ['wind', 'Viento'], ['models', 'Comparar previsiones']];
// Los modelos más conocidos y fiables, cada uno con su bloque al comparar
const CMP_MODELS = [
  { id: 'ecmwf_ifs', name: 'ECMWF', desc: 'Europa · 9 km · el de referencia' },
  { id: 'ecmwf_aifs025_single', name: 'ECMWF IA', desc: 'Inteligencia artificial (AIFS)' },
  { id: 'gfs_seamless', name: 'GFS', desc: 'EE. UU. (NOAA)' },
  { id: 'icon_seamless', name: 'ICON', desc: 'Alemania (DWD) · alta resolución en Europa' },
  { id: 'meteofrance_seamless', name: 'AROME / ARPEGE', desc: 'Francia · muy detallado, 4 días' },
  { id: 'ukmo_seamless', name: 'UKMO', desc: 'Reino Unido (Met Office)' },
  { id: 'gem_seamless', name: 'GEM', desc: 'Canadá' },
];
const CMP_VARS = ['weather_code', 'temperature_2m', 'precipitation', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'cloud_cover', 'is_day'];
const view = { tab: 'basic', step: 3, cmpMode: 'basic', cmpDays: 5 };
let sheet = null;
const BAR_IC = {
  clock: '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm.5-13H11v6l5.2 3.2.8-1.3-4.5-2.7z"/></svg>',
  eye: '<svg viewBox="0 0 24 24"><path d="M12 5C7 5 2.7 8.1 1 12.5 2.7 16.9 7 20 12 20s9.3-3.1 11-7.5C21.3 8.1 17 5 12 5zm0 12.5a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg>',
  layers: '<svg viewBox="0 0 24 24"><path d="M12 18.5l-7.4-5.7L3 14.1l9 7 9-7-1.6-1.3zM12 16l7.4-5.7L21 9l-9-7-9 7 1.6 1.3z"/></svg>',
};
const DIAS = ['DOMINGO', 'LUNES', 'MARTES', 'MIÉRCOLES', 'JUEVES', 'VIERNES', 'SÁBADO'];

// Colores de la fila de rachas de la tabla de Windy (más vivos que los del mapa)
const GUST = [[0, [255, 255, 255]], [5, [222, 246, 251]], [10, [160, 233, 244]], [15, [52, 218, 238]], [19, [34, 224, 180]], [22, [43, 220, 53]], [30, [95, 211, 26]], [40, [232, 229, 26]], [55, [245, 163, 26]], [70, [239, 59, 44]], [90, [194, 24, 91]]];
function gustRGB(kmh) {
  let k = 1;
  while (k < GUST.length - 1 && GUST[k][0] < kmh) k++;
  const [a, ca] = GUST[k - 1], [b, cb] = GUST[k];
  const t = Math.max(0, Math.min(1, (kmh - a) / (b - a)));
  return `rgb(${ca.map((v, i) => Math.round(v + (cb[i] - v) * t)).join(',')})`;
}
function gustCell(kmh) {
  if (!f.isNum(kmh)) return cell('–');
  return cell(f.wind(kmh), `background:${gustRGB(kmh)};color:${kmh >= 70 ? '#fff' : '#111'}`, 'gust');
}
const cell = (txt, style = '', cls = '') => `<td${cls ? ` class="${cls}"` : ''}${style ? ` style="${style}"` : ''}>${txt}</td>`;
const colored = (scale, v, txt, mul = 1) => (f.isNum(v) ? cell(txt, `background:${css(scale, v, mul)};color:${textOn(scale, v, mul)}`, 'cval') : cell('–'));

function hourIdx(times, nowKey, step, maxH) {
  let i0 = times.findIndex((t) => t.slice(0, 13) >= nowKey);
  if (i0 < 0) i0 = 0;
  // Con paso de 3 h, alinear a 2, 5, 8… como Windy
  // (desde el principio del día se alinea hacia delante, para no empezar con la víspera)
  if (step === 3 && nowKey.endsWith('T00')) while (i0 < times.length - 1 && (+times[i0].slice(11, 13) + 1) % 3 !== 0) i0++;
  else if (step === 3) while (i0 > 0 && (+times[i0].slice(11, 13) + 1) % 3 !== 0) i0--;
  const out = [];
  for (let i = i0; i < Math.min(times.length, i0 + maxH); i += step) out.push(i);
  return out;
}

function headRows(times, idx, night = null) {
  let days = '';
  let k = 0;
  while (k < idx.length) {
    const day = times[idx[k]].slice(0, 10);
    let n = 0;
    while (k + n < idx.length && times[idx[k + n]].startsWith(day)) n++;
    const p = f.parts(day);
    days += `<td colspan="${n}" class="${k ? 'daystart' : ''}" data-day="${day}"><span>${n >= 3 ? DIAS[p.wd] + ' ' + p.D : p.D}</span></td>`;
    k += n;
  }
  const isStart = (j) => j > 0 && times[idx[j]].slice(0, 10) !== times[idx[j - 1]].slice(0, 10);
  const hours = idx.map((i, j) => `<td class="${[isStart(j) ? 'daystart' : '', night?.(i) ? 'night' : ''].join(' ')}">${+times[i].slice(11, 13)}</td>`).join('');
  return { html: `<tr class="r-day"><th class="rowlab"></th>${days}</tr><tr class="r-hour"><th class="rowlab">Horas</th>${hours}</tr>`, isStart };
}

function rowHtml(label, idx, isStart, fn, nowJ = -1, night = null) {
  const td = (html, j) => html.replace(/^<td( class="([^"]*)")?/, (m, a, c) => `<td class="${[c, isStart(j) ? 'daystart' : '', j === nowJ ? 'nowcol' : '', night?.(idx[j]) ? 'night' : ''].filter(Boolean).join(' ')}"`);
  return `<tr><th class="rowlab">${label}</th>${idx.map((i, j) => td(fn(i), j)).join('')}</tr>`;
}

// ---------- Cabecera: días con silueta de temperaturas y franja de lluvia ----------
function summary(d) {
  const dd = d.daily, h = d.hourly;
  const today = d.current.time.slice(0, 10);
  const ti = Math.max(0, dd.time.indexOf(today));
  const n = Math.min(16, dd.time.length - ti); // todos los días (se deslizan en horizontal)
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
      ${days.map((day, k) => `<div class="wd-day${k === 0 ? ' today' : ''}" data-day="${day}">
        <span class="wd-dn">${DIAS[f.parts(day).wd].slice(0, 3)}</span>
        ${wxIcon(dd.weather_code[ti + k], 1)}
        <span class="wd-t">${f.temp(dd.temperature_2m_min[ti + k])} / <b>${f.temp(dd.temperature_2m_max[ti + k])}</b></span>
      </div>`).join('')}
    </div>
    <div class="wd-rainrow" style="--n:${n}"><span class="wd-drops">💧</span><div class="wd-rain">${rain}<b class="wd-win"></b></div></div>`;
}

// ---------- Acerca de la ubicación (columna derecha en pantallas grandes) ----------
function about(d) {
  const dms = (v, pos, neg) => {
    const a = Math.abs(v), g = Math.floor(a), m = Math.floor((a - g) * 60), s = Math.round(((a - g) * 60 - m) * 60);
    return `${v >= 0 ? pos : neg}${g}°${m}'${s}"`;
  };
  const off = (d.utc_offset_seconds || 0) / 3600;
  const ti = Math.max(0, d.daily.time.indexOf(d.current.time.slice(0, 10)));
  const hm = (t) => (t ? t.slice(11, 16) : '–');
  const rows = [
    `${dms(state.place.lat, 'N', 'S')}, ${dms(state.place.lon, 'E', 'W')}`,
    `${d.timezone || ''} (${off >= 0 ? '+' : '−'}${String(Math.abs(off)).padStart(2, '0')}:00)`,
    `Amanecer: ${hm(d.daily.sunrise?.[ti])}`,
    `Atardecer: ${hm(d.daily.sunset?.[ti])}`,
  ];
  if (f.isNum(d.elevation)) rows.push(`Elevación del modelo: ${Math.round(d.elevation)} m`);
  return `<h4>Acerca de la ubicación</h4>${rows.map((r) => `<p>${r}</p>`).join('')}`;
}

// ---------- Vistas ----------
async function basic(body, d) {
  const h = d.hourly;
  // Como Windy: el día de hoy entero (también las horas pasadas), con la hora actual marcada
  const nowKey = d.current.time.slice(0, 13);
  const idx = hourIdx(h.time, d.current.time.slice(0, 10) + 'T00', view.step, view.step === 1 ? 96 : h.time.length);
  let nowJ = idx.findIndex((i) => h.time[i].slice(0, 13) >= nowKey);
  if (view.step === 3 && nowJ > 0 && h.time[idx[nowJ]].slice(0, 13) > nowKey) nowJ--;
  const night = (i) => h.is_day?.[i] === 0;
  const { html, isStart } = headRows(h.time, idx, night);
  const R = (label, fn) => rowHtml(label, idx, isStart, fn, nowJ, night);
  body.innerHTML = `<div class="wd-table"><svg class="wd-curve" aria-hidden="true"></svg><table>${html}
    <tr class="r-icon"><th class="rowlab"></th>${idx.map((i, j) => `<td class="${[isStart(j) ? 'daystart' : '', j === nowJ ? 'nowcol' : '', night(i) ? 'night' : ''].join(' ')}">${wxIcon(h.weather_code[i], h.is_day[i])}</td>`).join('')}</tr>
    ${R(`Temperatura <small>${f.tempUnit()}</small>`, (i) => cell(f.temp(h.temperature_2m[i]), '', 'big'))}
    ${R(`Sens. térmica <small>${f.tempUnit()}</small>`, (i) => cell(f.temp(h.apparent_temperature[i]), '', 'soft'))}
    ${R(`Lluvia <small>${f.precipUnit()}</small>`, (i) => {
    let sum = 0;
    for (let k = i; k < i + view.step && k < h.time.length; k++) sum += h.precipitation[k] || 0;
    return cell(sum >= 0.1 ? f.precip(sum) : '', '', 'rainv');
  })}
    ${R(`Viento <small>${f.windUnit()}</small>`, (i) => cell(f.wind(h.wind_speed_10m[i])))}
    ${R(`Rachas <small>${f.windUnit()}</small>`, (i) => gustCell(h.wind_gusts_10m[i])).replace('<tr>', '<tr class="r-gust">')}
    ${R('Dirección', (i) => cell(f.arrow(h.wind_direction_10m[i])))}
    ${R('Nubes <small>%</small>', (i) => cell(f.isNum(h.cloud_cover[i]) ? Math.round(h.cloud_cover[i]) : '–', '', 'soft'))}
    ${R('Prob. lluvia', (i) => cell(f.isNum(h.precipitation_probability[i]) && h.precipitation_probability[i] >= 5 ? h.precipitation_probability[i] + '%' : '', '', 'rainv'))}
  </table></div>`;
  drawCurve(body, idx.map((i) => h.temperature_2m[i]));
  scrollToNow(body);
  // Instante (UTC) de cada columna: tocar una lleva el mapa a esa hora
  const off = (d.utc_offset_seconds || 0) * 1000;
  sheet.colMs = idx.map((i) => Date.parse(h.time[i] + ':00Z') - off);
  sheet.colSpan = view.step * 3600e3;
  body.querySelector('table').addEventListener('click', (e) => {
    const td = e.target.closest('td');
    if (!td || td.parentElement.classList.contains('r-day')) return;
    const j = td.cellIndex - 1;
    if (j >= 0 && sheet.colMs[j]) window.dispatchEvent(new CustomEvent('wd-pick-time', { detail: sheet.colMs[j] }));
  });
  markMapTime();
}

// Línea roja discontinua en la columna de la hora que muestra el mapa
let mapMs = null;
window.addEventListener('map-time', (e) => {
  mapMs = e.detail;
  // La hora tocada en la tabla de viento se mantiene mientras el mapa siga en su tramo de 3 h
  if (roseMs !== null && Math.abs(mapMs - roseMs) > 3 * 3600e3) roseMs = null;
  markMapTime();
  if (rose && view.tab === 'wind') drawRose();
});
function markMapTime() {
  const wrap = sheet?.querySelector('.wd-table');
  if (!wrap || !sheet.colMs || mapMs === null) return;
  const j = sheet.colMs.findIndex((t) => mapMs >= t && mapMs < t + sheet.colSpan);
  wrap.querySelectorAll('.mapcol').forEach((c) => c.classList.remove('mapcol'));
  if (j < 0) return;
  wrap.querySelectorAll('tr:not(.r-day)').forEach((tr) => tr.cells[j + 1]?.classList.add('mapcol'));
}

// Silueta rosada de la temperatura por detrás de las horas, iconos y temperaturas (como Windy)
function drawCurve(body, temps) {
  const wrap = body.querySelector('.wd-table');
  const svg = wrap?.querySelector('.wd-curve');
  const hourCells = wrap?.querySelectorAll('tr.r-hour td');
  const tempRow = wrap?.querySelector('td.big')?.parentElement;
  if (!svg || !hourCells?.length || !tempRow) return;
  const ok = temps.filter(f.isNum);
  if (!ok.length) return;
  const lo = Math.min(...ok), hi = Math.max(...ok);
  const top = hourCells[0].offsetTop, bottom = tempRow.offsetTop + tempRow.offsetHeight;
  const x0 = hourCells[0].offsetLeft, last = hourCells[hourCells.length - 1];
  const W = last.offsetLeft + last.offsetWidth - x0, H = bottom - top;
  const pts = [...hourCells].map((c, j) => (f.isNum(temps[j]) ? [c.offsetLeft - x0 + c.offsetWidth / 2, H - 8 - ((temps[j] - lo) / Math.max(1, hi - lo)) * (H * 0.75)] : null)).filter(Boolean);
  Object.assign(svg.style, { left: x0 + 'px', top: top + 'px', width: W + 'px', height: H + 'px' });
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L');
  svg.innerHTML = `<defs><linearGradient id="wdCurveG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f08a7e" stop-opacity=".5"/><stop offset="1" stop-color="#f08a7e" stop-opacity=".06"/></linearGradient></defs>
    <path d="M0,${H} L0,${pts[0][1].toFixed(1)} L${line} L${W},${pts[pts.length - 1][1].toFixed(1)} L${W},${H} Z" fill="url(#wdCurveG)"/>`;
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

// Viento, como la pestaña de Windy: una fila por modelo con dirección, viento medio y racha, y la rosa de los
// modelos dibujada sobre el punto del mapa a la hora que marca la línea de tiempo
const WIND_VARS = ['wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m'];
let rose = null; // { rows, ms } del punto abierto
let roseMs = null; // hora tocada en la tabla (el mapa va de 3 en 3 h y puede quedarse a una hora de ella)
let roseHost = null;
export function setRoseHost(fn) { roseHost = fn; }
function drawRose() {
  if (!roseHost) return;
  if (!rose || !sheet?.classList.contains('open') || view.tab !== 'wind') { roseHost(null); return; }
  const t = roseMs ?? mapMs ?? Date.now();
  // La hora del modelo más cercana a la del mapa
  let i = 0;
  rose.ms.forEach((m, k) => { if (Math.abs(m - t) < Math.abs(rose.ms[i] - t)) i = k; });
  // Barras con los colores vivos de la tabla, que destacan sobre los del mapa
  roseHost(roseSVG(rose.rows, i, { size: ROSE_SIZE(), cls: 'map-rose', fill: (v) => gustRGB(Math.max(8, v)), ink: (v) => (v >= 70 ? '#fff' : '#111') }));
}
export const ROSE_SIZE = () => (window.innerWidth < 600 ? 250 : 300);

async function wind(body) {
  const d = await api.compareModels(state.place, CMP_MODELS.map((m) => m.id), WIND_VARS);
  const h = d.hourly;
  const rows = series(h, CMP_MODELS.map((m) => m.id));
  const off = (d.utc_offset_seconds || 0) * 1000;
  rose = { rows, ms: h.time.map((t) => Date.parse(t + ':00Z') - off) };
  const nowKey = f.placeNow(d.utc_offset_seconds).slice(0, 13);
  // Desde el principio de hoy, como la pestaña Básico, y hasta donde llegue algún modelo
  const idx = hourIdx(h.time, nowKey.slice(0, 10) + 'T00', view.step, h.time.length).filter((i) => rows.some((r) => f.isNum(r.ws[i])));
  let nowJ = idx.findIndex((i) => h.time[i].slice(0, 13) >= nowKey);
  if (view.step === 3 && nowJ > 0 && h.time[idx[nowJ]].slice(0, 13) > nowKey) nowJ--;
  const { html, isStart } = headRows(h.time, idx);
  const name = (id) => CMP_MODELS.find((m) => m.id === id).name;
  const windCell = (r) => (i) => {
    const v = r.ws[i], g = r.wg[i];
    if (!f.isNum(v)) return cell('', '', 'wcell empty');
    // Fondo con la racha (como los colores de la fila de rachas de Windy)
    const k = f.isNum(g) ? g : v, bg = `background:${gustRGB(k)};color:${k >= 70 ? '#fff' : '#111'}`;
    return cell(`<b>${f.arrow(r.wd[i])}${f.wind(v)}</b><small>${f.isNum(g) ? f.wind(g) : ''}</small>`, bg, 'wcell');
  };
  body.innerHTML = `<div class="wd-table wd-windt"><table>${html}
    ${rows.map((r) => rowHtml(`${name(r.id)} <small>${f.windUnit()}</small>`, idx, isStart, windCell(r), nowJ)).join('')}
  </table></div>
  <p class="wd-note">Arriba el viento medio a 10 m con su dirección y abajo las rachas. En el mapa, cada barra sale del punto hacia donde viene el viento según cada modelo, con su largo y color según la fuerza (G = racha). Toca una hora para verla en el mapa.</p>`;
  scrollToNow(body);
  sheet.colMs = idx.map((i) => rose.ms[i]);
  sheet.colSpan = view.step * 3600e3;
  body.querySelector('table').addEventListener('click', (e) => {
    const td = e.target.closest('td');
    if (!td || td.parentElement.classList.contains('r-day')) return;
    const j = td.cellIndex - 1;
    if (j < 0 || !sheet.colMs[j]) return;
    roseMs = sheet.colMs[j];
    window.dispatchEvent(new CustomEvent('wd-pick-time', { detail: roseMs }));
    drawRose();
  });
  markMapTime();
  drawRose();
}

async function models(body) {
  const hidden = load('cmp.hidden', []), pinned = load('cmp.pinned', []);
  const chips = (key, opts) => `<div class="wd-chips">${opts.map(([v, l]) => `<button class="${view[key] === v ? 'on' : ''}" data-${key}="${v}">${l}</button>`).join('')}</div>`;
  body.innerHTML = `<div class="cmp-head"><h3>Comparar previsiones</h3>
    ${chips('cmpMode', [['basic', 'Básico'], ['clouds', 'Nubes y lluvia']])}
    ${chips('cmpDays', [[5, '5 días'], [10, '10 días'], [16, '16 días']])}</div>
    <div id="dtCmp"><div class="loading"><div class="spinner"></div>Cargando modelos…</div></div>`;
  body.querySelectorAll('[data-cmpmode]').forEach((b) => { b.onclick = () => { view.cmpMode = b.dataset.cmpmode; models(body); }; });
  body.querySelectorAll('[data-cmpdays]').forEach((b) => { b.onclick = () => { view.cmpDays = +b.dataset.cmpdays; models(body); }; });
  const d = await api.compareModels(state.place, CMP_MODELS.map((m) => m.id), CMP_VARS);
  const h = d.hourly;
  const get = (v, m) => h[`${v}_${m}`] || h[v] || [];
  const nowKey = f.placeNow(d.utc_offset_seconds).slice(0, 13);
  const all = hourIdx(h.time, nowKey, view.step, view.cmpDays * 24);
  const order = [...CMP_MODELS].sort((a, b) => pinned.includes(b.id) - pinned.includes(a.id));
  const block = (m) => {
    const temp = get('temperature_2m', m.id);
    // Cada modelo solo hasta donde llega su pronóstico
    const idx = all.filter((i) => f.isNum(temp[i]));
    if (!idx.length) return `<div class="cmp-model"><div class="cmp-title"><b>${m.name}</b><span>Sin datos para este punto</span></div></div>`;
    const { html, isStart } = headRows(h.time, idx);
    const R = (label, fn) => rowHtml(label, idx, isStart, fn);
    const code = get('weather_code', m.id), day = get('is_day', m.id), rain = get('precipitation', m.id);
    const wind = get('wind_speed_10m', m.id), dir = get('wind_direction_10m', m.id), gust = get('wind_gusts_10m', m.id), cloud = get('cloud_cover', m.id);
    const rainSum = (i) => {
      let sum = 0;
      for (let k = i; k < i + view.step && k < h.time.length; k++) sum += rain[k] || 0;
      return cell(sum >= 0.1 ? f.precip(sum) : '', '', 'rainv');
    };
    const rows = view.cmpMode === 'basic' ? `
      ${R(`Temperatura <small>${f.tempUnit()}</small>`, (i) => (f.isNum(temp[i]) ? cell(f.temp(temp[i]), `background:${css('temp', temp[i], 0.45)}`, 'big') : cell('–')))}
      ${R(`Lluvia <small>${f.precipUnit()}</small>`, rainSum)}
      ${R(`Viento <small>${f.windUnit()}</small>`, (i) => cell(f.isNum(wind[i]) ? `${f.arrow(dir[i])} ${f.wind(wind[i])}` : '–', '', 'windc'))}` : `
      ${R(`Lluvia <small>${f.precipUnit()}</small>`, rainSum)}
      ${R('Nubes <small>%</small>', (i) => cell(f.isNum(cloud[i]) ? Math.round(cloud[i]) : '–', `background:rgba(120,130,145,${((cloud[i] || 0) / 100 * 0.5).toFixed(2)})`))}
      ${R(`Rachas <small>${f.windUnit()}</small>`, (i) => colored('wind', gust[i], f.wind(gust[i])))}`;
    const isPin = pinned.includes(m.id);
    return `<div class="cmp-model">
      <div class="cmp-title"><b>${m.name}</b><span>${m.desc}</span>
        <button data-hide="${m.id}">Ocultar</button><button data-pin="${m.id}" class="${isPin ? 'on' : ''}">${isPin ? 'Fijado' : 'Fijar arriba'}</button></div>
      <div class="wd-table cmp-table"><table>${html}
        <tr class="r-icon"><th class="rowlab"></th>${idx.map((i, j) => `<td class="${isStart(j) ? 'daystart' : ''}">${wxIcon(code[i], day[i] ?? 1)}</td>`).join('')}</tr>
        ${rows}
      </table></div></div>`;
  };
  const shown = order.filter((m) => !hidden.includes(m.id));
  const off = CMP_MODELS.filter((m) => hidden.includes(m.id));
  const box = body.querySelector('#dtCmp');
  box.innerHTML = daySummary(h, get, shown, nowKey) + shown.map(block).join('') +
    (off.length ? `<div class="cmp-off">Ocultos: ${off.map((m) => `<button data-show="${m.id}">${m.name} ＋</button>`).join('')}</div>` : '') +
    '<p class="wd-note">Si los modelos coinciden, el pronóstico es fiable; si discrepan, hay incertidumbre. Desliza una tabla y las demás la siguen.</p>';
  const toggle = (key, list, id) => { save(key, list.includes(id) ? list.filter((x) => x !== id) : [...list, id]); models(body); };
  box.querySelectorAll('[data-hide]').forEach((b) => { b.onclick = () => toggle('cmp.hidden', hidden, b.dataset.hide); });
  box.querySelectorAll('[data-show]').forEach((b) => { b.onclick = () => toggle('cmp.hidden', hidden, b.dataset.show); });
  // Tocar un día del resumen lleva todas las tablas a ese día
  box.querySelectorAll('.cmp-sum [data-goday]').forEach((el) => {
    el.onclick = () => {
      box.querySelectorAll('.cmp-model').forEach((m) => goDay(m, el.dataset.goday));
      box.querySelector('.cmp-model')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
  });
  box.querySelectorAll('[data-pin]').forEach((b) => { b.onclick = () => toggle('cmp.pinned', pinned, b.dataset.pin); });
  // Desplazar una tabla mueve todas a la vez (mismas horas en columna)
  const tables = [...box.querySelectorAll('.cmp-table')];
  let syncing = false;
  tables.forEach((t) => t.addEventListener('scroll', () => {
    if (syncing) return;
    syncing = true;
    tables.forEach((o) => { if (o !== t) o.scrollLeft = t.scrollLeft; });
    requestAnimationFrame(() => { syncing = false; });
  }, { passive: true }));
}

// Resumen por días: máxima/mínima, lluvia y un icono por modelo, más una fila de acuerdo entre modelos
function dayIcon(codes, rainMm) {
  const day = codes.filter(f.isNum);
  if (!day.length) return null;
  // Con lluvia apreciable, el código de precipitación más intenso; si no, el más repetido
  if (rainMm >= 1) return Math.max(...day);
  const count = {};
  day.forEach((c) => { if (c < 50) count[c] = (count[c] || 0) + 1; });
  const best = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
  return best ? +best[0] : Math.max(...day);
}
function daySummary(h, get, shown, nowKey) {
  const today = nowKey.slice(0, 10);
  const days = [...new Set(h.time.map((t) => t.slice(0, 10)))].filter((d) => d >= today).slice(0, view.cmpDays);
  const stats = shown.map((m) => days.map((day) => {
    const temp = get('temperature_2m', m.id), rain = get('precipitation', m.id), code = get('weather_code', m.id);
    const ii = h.time.map((t, i) => (t.startsWith(day) ? i : -1)).filter((i) => i >= 0 && f.isNum(temp[i]));
    if (ii.length < 12) return null;
    const ts = ii.map((i) => temp[i]);
    const mm = ii.reduce((a, i) => a + (rain[i] || 0), 0);
    const daytime = ii.filter((i) => { const hr = +h.time[i].slice(11, 13); return hr >= 8 && hr <= 20; });
    return { max: Math.max(...ts), min: Math.min(...ts), mm, code: dayIcon(daytime.map((i) => code[i]), mm) };
  }));
  const head = days.map((day) => { const p = f.parts(day); return `<th data-goday="${day}">${DIAS[p.wd].slice(0, 3)} ${p.D}</th>`; }).join('');
  const rows = shown.map((m, r) => `<tr><th class="rowlab">${m.name}</th>${stats[r].map((x) => (x ? `<td>
      ${f.isNum(x.code) ? wxIcon(x.code, 1) : ''}<b>${f.temp(x.max)}</b> <span>${f.temp(x.min)}</span>${x.mm >= 0.5 ? `<i>${f.precip(x.mm)}</i>` : ''}</td>` : '<td class="none">–</td>')).join('')}</tr>`).join('');
  // Acuerdo: cuántos modelos dan lluvia (≥ 1 mm) y diferencia entre la máxima más alta y la más baja
  const agree = days.map((_, c) => {
    const col = stats.map((row) => row[c]).filter(Boolean);
    if (col.length < 2) return '<td class="none">–</td>';
    const wet = col.filter((x) => x.mm >= 1).length;
    const spread = Math.round(Math.max(...col.map((x) => x.max)) - Math.min(...col.map((x) => x.max)));
    const sure = spread <= 2 && (wet === 0 || wet === col.length);
    return `<td class="${sure ? 'ok' : spread >= 5 || (wet && wet < col.length) ? 'doubt' : ''}"><i>☔ ${wet}/${col.length}</i><span>±${Math.ceil(spread / 2)}°</span></td>`;
  }).join('');
  return `<div class="cmp-sum"><div class="wd-table"><table>
    <tr class="r-head"><th class="rowlab"></th>${head}</tr>${rows}
    <tr class="r-agree"><th class="rowlab">Acuerdo</th>${agree}</tr>
  </table></div><p class="wd-note">«☔ 4/7»: cuatro de siete modelos dan lluvia ese día. «±2°»: lo que se separan sus máximas. Verde = coinciden; naranja = hay dudas. Toca un día para verlo por horas.</p></div>`;
}

function scrollToNow(body) {
  const now = body.querySelector('td.nowcol');
  const wrap = body.querySelector('.wd-table');
  if (!now || !wrap) return;
  // Se ve el principio del día; solo se desplaza si la hora actual quedaría fuera
  wrap.scrollLeft = Math.max(0, now.offsetLeft + now.offsetWidth + 4 - wrap.clientWidth);
}

// Recuadro rojo en la franja de lluvia con el tramo que se ve en la tabla (como Windy)
function trackWindow() {
  const wrap = sheet.querySelector('.wd-table');
  const win = sheet.querySelector('.wd-win');
  const cells = wrap?.querySelectorAll('tr.r-hour td');
  const times = sheet.colTimes;
  if (!wrap || !win || !cells?.length || !times || !sheet.days?.length) { if (win) win.style.display = 'none'; return; }
  win.style.display = '';
  const lab = wrap.querySelector('th.rowlab')?.offsetWidth || 0;
  const a = wrap.scrollLeft + lab, b = wrap.scrollLeft + wrap.clientWidth;
  let first = -1, lastJ = -1;
  cells.forEach((c, j) => { if (c.offsetLeft + c.offsetWidth > a + 2 && c.offsetLeft < b - 2) { if (first < 0) first = j; lastJ = j; } });
  if (first < 0) return;
  const ms = (t) => Date.parse(t + ':00Z');
  const t0 = ms(sheet.days[0] + 'T00:00'), span = sheet.days.length * 24 * 3600e3;
  const step = times[1] ? ms(times[1]) - ms(times[0]) : 3600e3;
  const l = Math.max(0, (ms(times[first]) - t0) / span), r = Math.min(1, (ms(times[lastJ]) + step - t0) / span);
  win.style.left = (l * 100).toFixed(2) + '%';
  win.style.width = (Math.max(0.01, r - l) * 100).toFixed(2) + '%';
}

// La franja de días y la tabla se desplazan juntas: lo que queda en el borde izquierdo de una
// (en fracción de los días mostrados) se lleva al borde izquierdo de la otra
function syncScroll() {
  const wrap = sheet.querySelector('.wd-table');
  const top = sheet.querySelector('.wd-top');
  const strip = top?.querySelector('.wd-days');
  const times = sheet.colTimes;
  if (!wrap || !strip || !times?.length || !sheet.days?.length) return;
  const ms = (t) => Date.parse(t + ':00Z');
  const t0 = ms(sheet.days[0] + 'T00:00'), span = sheet.days.length * 24 * 3600e3;
  const cols = () => [...wrap.querySelectorAll('tr.r-hour td')];
  const labW = () => wrap.querySelector('th.rowlab')?.offsetWidth || 0;
  // Mueve `el` sin que su propio evento de scroll vuelva a mover a la otra
  const set = (el, x) => {
    const v = Math.max(0, Math.min(el.scrollWidth - el.clientWidth, Math.round(x)));
    if (Math.abs(el.scrollLeft - v) < 1) return;
    el._expect = v;
    el.scrollLeft = v;
  };
  const ours = (el) => { if (el._expect === undefined) return false; const hit = Math.abs(el.scrollLeft - el._expect) < 2; el._expect = undefined; return hit; };
  wrap.addEventListener('scroll', () => {
    if (ours(wrap)) return;
    const c = cols(), x = wrap.scrollLeft + labW();
    let j = c.findIndex((td) => td.offsetLeft + td.offsetWidth > x);
    if (j < 0) j = c.length - 1;
    const step = times[j + 1] ? ms(times[j + 1]) - ms(times[j]) : 3600e3;
    const t = ms(times[j]) + Math.max(0, Math.min(1, (x - c[j].offsetLeft) / c[j].offsetWidth)) * step;
    set(top, strip.offsetLeft + ((t - t0) / span) * strip.offsetWidth);
  }, { passive: true });
  top.onscroll = () => {
    if (ours(top)) return;
    const t = t0 + ((top.scrollLeft - strip.offsetLeft) / strip.offsetWidth) * span;
    const c = cols();
    let j = times.findIndex((s, k) => ms(s) <= t && (!times[k + 1] || ms(times[k + 1]) > t));
    if (j < 0) j = ms(times[0]) > t ? 0 : c.length - 1;
    const step = times[j + 1] ? ms(times[j + 1]) - ms(times[j]) : 3600e3;
    const frac = Math.max(0, Math.min(1, (t - ms(times[j])) / step));
    set(wrap, c[j].offsetLeft + frac * c[j].offsetWidth - labW());
  };
}

function goDay(body, day) {
  const wrap = body.querySelector('.wd-table');
  const td = wrap?.querySelector(`tr.r-day td[data-day="${day}"]`);
  const lab = wrap?.querySelector('th.rowlab');
  if (td) wrap.scrollLeft = Math.max(0, td.offsetLeft - (lab?.offsetWidth || 0));
}

const RENDER = { basic, meteo, waves, wind, models };

async function renderAll() {
  const top = sheet.querySelector('.wd-top');
  const body = sheet.querySelector('.wd-body');
  body.classList.remove('dark');
  sheet.classList.toggle('tall', view.tab === 'models');
  rose = null;
  roseMs = null;
  drawRose();
  sheet.querySelector('[data-view]').value = view.tab;
  sheet.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === view.tab));
  body.innerHTML = '<div class="loading"><div class="spinner"></div>Cargando…</div>';
  try {
    const d = await getForecast();
    top.innerHTML = summary(d);
    sheet.querySelector('.wd-about').innerHTML = about(d);
    const ti = Math.max(0, d.daily.time.indexOf(d.current.time.slice(0, 10)));
    sheet.days = d.daily.time.slice(ti, ti + 16);
    sheet.querySelector('.wd-srcwrap').innerHTML = d.source === 'met' ? '<p class="wd-src">Datos de MET Noruega (respaldo: Open-Meteo no disponible ahora)</p>' : '';
    // Tocar un día lleva la tabla a ese día, como en Windy
    top.querySelectorAll('[data-day]').forEach((el) => { el.onclick = () => goDay(sheet.querySelector('.wd-body'), el.dataset.day); });
    await RENDER[view.tab](body, d);
    // Fecha y hora de cada columna de la tabla (para el recuadro de la franja de lluvia)
    const wrap = body.querySelector('.wd-table');
    const hrs = [...(wrap?.querySelectorAll('tr.r-hour td') || [])].map((c) => +c.textContent);
    sheet.colTimes = null;
    if (wrap && hrs.length) {
      const times = [];
      wrap.querySelectorAll('tr.r-day td[data-day]').forEach((c) => {
        for (let k = 0; k < c.colSpan; k++) times.push(`${c.dataset.day}T${String(hrs[times.length]).padStart(2, '0')}:00`);
      });
      sheet.colTimes = times;
      wrap.addEventListener('scroll', trackWindow, { passive: true });
    } else top.onscroll = null;
    trackWindow();
    syncScroll();
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
    <div class="wd-head"><div class="wd-top"></div><a class="wd-15" href="#/inicio">Pronóstico de 15 días ›</a><button class="wd-cmp" data-cmp>Comparar ›</button></div>
    <div class="wd-srcwrap"></div>
    <div class="wd-main"><div class="wd-body"></div><a class="wd-15v" href="#/inicio">Pronóstico de 15 días ›</a><aside class="wd-about"></aside></div>
    <div class="wd-bar">
      <div class="wd-tabs">${VIEWS.map(([v, l]) => `<button data-tab="${v}">${l}</button>`).join('')}</div>
      <label>${BAR_IC.clock}<span>pronóstico</span><select data-step>${[[1, '1 hora'], [3, '3 horas']].map(([v, l]) => `<option value="${v}" ${v === view.step ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>${BAR_IC.eye}<span>Mostrar como:</span><select data-view>${VIEWS.map(([v, l]) => `<option value="${v}" ${v === view.tab ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>${BAR_IC.layers}<span>Fuente:</span><select data-model>${api.MODELS.map((m) => `<option value="${m.id}" ${m.id === settings.model ? 'selected' : ''}>${m.short}</option>`).join('')}</select></label>
    </div>`;
  sheet.classList.add('open');
  root.classList.add('detail-open');
  sheet.querySelector('[data-close]').onclick = closeDetail;
  sheet.querySelector('[data-step]').onchange = (e) => { view.step = +e.target.value; renderAll(); };
  sheet.querySelector('[data-view]').onchange = (e) => { view.tab = e.target.value; renderAll(); };
  sheet.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => { view.tab = b.dataset.tab; renderAll(); }; });
  sheet.querySelector('[data-cmp]').onclick = () => { view.tab = view.tab === 'models' ? 'basic' : 'models'; renderAll(); };
  // Cambiar la fuente cambia el modelo de toda la app (y vuelve a abrir este panel)
  sheet.querySelector('[data-model]').onchange = (e) => { settings.model = e.target.value; saveSettings(); };
  renderAll();
}

export function closeDetail() {
  sheet?.classList.remove('open');
  rose = null;
  roseMs = null;
  drawRose();
  sheet?.parentElement?.classList.remove('detail-open');
}
export const detailOpen = () => !!sheet?.classList.contains('open');
