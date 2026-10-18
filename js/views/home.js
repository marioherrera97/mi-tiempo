// Vista "Hoy": condiciones actuales, próximas horas, 16 días, sol y luna
import { state, settings } from '../state.js';
import { getForecast, lastUpdate } from '../data.js';
import * as api from '../api.js';
import * as f from '../format.js';
import { wxIcon, wxDesc, moonPhase, moonSvg } from '../icons.js';
import { css, aqiLevel } from '../colors.js';
import { loading, errorBox, openSheet, $ } from '../ui.js';
import { makeChart, baseOptions, theme, alpha } from '../charts.js';

export function nowIndex(d) {
  const key = (d.current?.time || f.placeNow(d.utc_offset_seconds)).slice(0, 13);
  const i = d.hourly.time.findIndex((t) => t.slice(0, 13) === key);
  return i < 0 ? 0 : i;
}

function hero(d) {
  const c = d.current;
  const ti = d.daily.time.indexOf(c.time.slice(0, 10));
  const dmax = d.daily.temperature_2m_max[ti], dmin = d.daily.temperature_2m_min[ti];
  return `<div class="card hero">
    ${wxIcon(c.weather_code, c.is_day)}
    <div>
      <div class="hero-temp num">${f.temp(c.temperature_2m)}</div>
      <div class="hero-desc">${wxDesc(c.weather_code)}</div>
      <div class="hero-sub">Sensación ${f.temp(c.apparent_temperature)} · Máx ${f.temp(dmax)} · Mín ${f.temp(dmin)}</div>
    </div>
    <div class="hero-meta">
      <span>${f.arrow(c.wind_direction_10m)} ${f.wind(c.wind_speed_10m, true)}</span>
      <span>Rachas ${f.wind(c.wind_gusts_10m, true)}</span>
      <span>${f.pct(c.relative_humidity_2m)} hum.</span>
    </div>
  </div>`;
}

function nowcast(d) {
  const m = d.minutely_15;
  if (!m || !m.precipitation) return '';
  const nowKey = d.current.time;
  let start = m.time.findIndex((t) => t >= nowKey);
  if (start < 0) start = 0;
  const vals = m.precipitation.slice(start, start + 12);
  const times = m.time.slice(start, start + 12);
  if (!vals.length) return '';
  const total = vals.reduce((a, b) => a + (b || 0), 0);
  const max = Math.max(0.5, ...vals.map((v) => v || 0));
  let title;
  if (total < 0.05) title = 'Sin lluvia en las próximas 3 horas';
  else {
    const first = vals.findIndex((v) => v >= 0.05);
    const firstT = f.hhmm(times[first]);
    title = first === 0 ? `Lloviendo ahora · ${f.precip(total, true)} en 3 h` : `Lluvia a partir de las ${firstT} · ${f.precip(total, true)}`;
  }
  return `<div class="card">
    <div class="card-head"><h2>${title}</h2><span class="tiny">cada 15 min</span></div>
    <div class="nowcast-bars">${vals.map((v, i) => `<i style="height:${Math.max(2, ((v || 0) / max) * 100)}%" title="${f.hhmm(times[i])}: ${f.precip(v, true)}"></i>`).join('')}</div>
    <div class="nowcast-axis"><span>${f.hhmm(times[0])}</span><span>${f.hhmm(times[Math.floor(times.length / 2)])}</span><span>${f.hhmm(times[times.length - 1])}</span></div>
  </div>`;
}

function stats(d, ni) {
  const h = d.hourly;
  const c = d.current;
  const ti = d.daily.time.indexOf(c.time.slice(0, 10));
  const item = (k, v, s = '') => `<div class="stat"><div class="k">${k}</div><div class="v num">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
  return `<div class="grid3 stats">
    ${item('Prob. lluvia', f.pct(h.precipitation_probability[ni]), `Hoy ${f.precip(d.daily.precipitation_sum[ti], true)}`)}
    ${item('Presión', f.pressure(c.pressure_msl), f.pressureUnit() + ' ' + pressureTrend(h, ni))}
    ${item('Nubes', f.pct(c.cloud_cover), `B ${f.pct(h.cloud_cover_low[ni])} · A ${f.pct(h.cloud_cover_high[ni])}`)}
    ${item('Punto de rocío', f.temp(h.dew_point_2m[ni]), `Humedad ${f.pct(c.relative_humidity_2m)}`)}
    ${item('Índice UV', f.fixed(h.uv_index[ni], 0), `Máx hoy ${f.fixed(d.daily.uv_index_max[ti], 0)}`)}
    ${item('Visibilidad', f.distance(h.visibility[ni]), `Isocero ${f.height(h.freezing_level_height[ni])}`)}
  </div>`;
}

function pressureTrend(h, i) {
  const a = h.pressure_msl[Math.max(0, i - 3)], b = h.pressure_msl[i];
  if (!f.isNum(a) || !f.isNum(b)) return '';
  const diff = b - a;
  if (diff > 1) return '↑ subiendo';
  if (diff < -1) return '↓ bajando';
  return '→ estable';
}

function hourStrip(d, ni) {
  const h = d.hourly;
  let out = '';
  for (let i = ni; i < Math.min(ni + 48, h.time.length); i++) {
    const t = h.time[i];
    const isNew = f.hh(t) === '00' && i !== ni;
    const p = h.precipitation[i];
    const pp = h.precipitation_probability[i];
    out += `<div class="hcell ${i === ni ? 'now' : ''} ${isNew ? 'daystart' : ''}">
      <span class="h">${i === ni ? 'Ahora' : isNew ? f.dayShort(t) : f.hh(t) + 'h'}</span>
      ${wxIcon(h.weather_code[i], h.is_day[i])}
      <span class="t num">${f.temp(h.temperature_2m[i])}</span>
      <span class="p num">${p >= 0.1 ? f.precip(p) + f.precipUnit() : f.isNum(pp) && pp >= 10 ? pp + '%' : ''}</span>
      <span class="w num">${f.arrow(h.wind_direction_10m[i])}${f.wind(h.wind_speed_10m[i])}</span>
    </div>`;
  }
  return `<div class="card">
    <div class="card-head"><h2>Próximas 48 horas</h2><a href="#/horas" class="small">Todas las horas →</a></div>
    <div class="hstrip">${out}</div>
  </div>`;
}

function dailyList(d) {
  const dd = d.daily;
  const today = d.current.time.slice(0, 10);
  const start = Math.max(0, dd.time.indexOf(today));
  const idx = [];
  for (let i = start; i < dd.time.length; i++) idx.push(i);
  const lo = Math.min(...idx.map((i) => dd.temperature_2m_min[i]).filter(f.isNum));
  const hi = Math.max(...idx.map((i) => dd.temperature_2m_max[i]).filter(f.isNum));
  const span = Math.max(1, hi - lo);
  const rows = idx.map((i, n) => {
    const t = dd.time[i];
    const mn = dd.temperature_2m_min[i], mx = dd.temperature_2m_max[i];
    const left = ((mn - lo) / span) * 100, width = Math.max(4, ((mx - mn) / span) * 100);
    const prob = dd.precipitation_probability_max[i];
    const sum = dd.precipitation_sum[i];
    return `<button class="drow ${n >= 10 ? 'uncertain' : ''}" data-day="${i}">
      <span class="d">${f.dayName(t, today)}<small>${f.dateShort(t)}</small></span>
      ${wxIcon(dd.weather_code[i], 1)}
      <span class="rp num">${f.isNum(prob) ? prob + '%' : ''}<small>${f.precip(sum, true, true)}</small></span>
      <span class="temps">
        <span class="tmin num">${f.temp(mn)}</span>
        <span class="tbar"><i style="left:${left}%;width:${width}%;background:linear-gradient(90deg,${css('temp', mn)},${css('temp', mx)})"></i></span>
        <span class="tmax num">${f.temp(mx)}</span>
      </span>
      <span class="wind num">${f.arrow(dd.wind_direction_10m_dominant[i])} ${f.wind(dd.wind_speed_10m_max[i])}<small title="Rachas">${f.wind(dd.wind_gusts_10m_max[i])}</small></span>
    </button>`;
  }).join('');
  return `<div class="card">
    <div class="card-head"><h2>Próximos ${idx.length} días</h2><a href="#/tendencia" class="small">Más allá →</a></div>
    <div class="legend-row" style="margin:-4px 0 6px"><span>Lluvia: prob. y cantidad</span><span>Viento medio y rachas (${f.windUnit()})</span></div>
    <div class="dlist">${rows}</div>
    <p class="note" style="margin:8px 4px 0">A partir del día 10 la fiabilidad baja: consulta <a href="#/tendencia">Largo plazo</a> para ver la dispersión entre escenarios.</p>
  </div>`;
}

function sunMoon(d) {
  const dd = d.daily;
  const ti = dd.time.indexOf(d.current.time.slice(0, 10));
  const rise = dd.sunrise[ti], set = dd.sunset[ti];
  const now = d.current.time;
  const toMin = (s) => +s.slice(11, 13) * 60 + +s.slice(14, 16);
  const r = toMin(rise), s = toMin(set), n = toMin(now);
  const frac = Math.min(1, Math.max(0, (n - r) / (s - r)));
  const ang = Math.PI * (1 - frac);
  const sx = 150 + Math.cos(ang) * 120, sy = 100 - Math.sin(ang) * 80;
  const up = n >= r && n <= s;
  const prevLen = ti > 0 ? dd.daylight_duration[ti - 1] : null;
  const diff = f.isNum(prevLen) ? Math.round((dd.daylight_duration[ti] - prevLen) / 60) : null;
  const mp = moonPhase(new Date());
  const t = theme();
  return `<div class="card">
    <div class="card-head"><h2>Sol y luna</h2></div>
    <svg class="sunarc" viewBox="0 0 300 110">
      <path d="M30 100 A120 80 0 0 1 270 100" fill="none" stroke="${t.grid}" stroke-width="2" stroke-dasharray="4 5"/>
      <line x1="10" y1="100" x2="290" y2="100" stroke="${t.grid}" stroke-width="1.5"/>
      ${up ? `<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="9" fill="#ffc44d"/>` : ''}
    </svg>
    <div class="astro">
      <span>Amanecer<br><b>${f.hhmm(rise)}</b></span>
      <span style="text-align:center">Luz de día<br><b>${f.duration(dd.daylight_duration[ti])}</b>${diff !== null ? `<br><span class="tiny">${diff >= 0 ? '+' : ''}${diff} min vs ayer</span>` : ''}</span>
      <span style="text-align:right">Atardecer<br><b>${f.hhmm(set)}</b></span>
    </div>
    <div class="moon" style="margin-top:14px">
      ${moonSvg(mp.phase)}
      <div><b>${mp.name}</b> · ${Math.round(mp.illum * 100)}% iluminada<br>
      <span class="small muted">Luna llena en ${Math.round(mp.nextFull)} días · Nueva en ${Math.round(mp.nextNew)} días</span></div>
    </div>
    <p class="note" style="margin:10px 0 0">Horas de sol previstas hoy: <b>${f.hoursFromSec(dd.sunshine_duration[ti])}</b></p>
  </div>`;
}

async function airCard(el) {
  try {
    const a = await api.airQuality(state.place);
    const c = a.current;
    const lv = aqiLevel(c.european_aqi);
    el.innerHTML = `<a class="card" href="#/aire" style="display:block;color:inherit">
      <div class="card-head"><h2>Calidad del aire</h2><span class="small" style="color:var(--accent)">Detalles →</span></div>
      <div class="aqi-big"><div class="ring" style="background:${lv.color}">${Math.round(c.european_aqi ?? 0)}</div>
      <div><b>${lv.name}</b><br><span class="small muted">PM2.5 ${f.fixed(c.pm2_5, 1)} · PM10 ${f.fixed(c.pm10, 1)} · O₃ ${f.fixed(c.ozone, 0)} µg/m³</span></div></div>
    </a>`;
  } catch { el.innerHTML = ''; }
}

// ---------- Hoja de detalle del día ----------
export function openDay(d, di) {
  const dd = d.daily, h = d.hourly;
  const day = dd.time[di];
  $('#daySheetTitle').textContent = f.dayLong(day);
  const idx = h.time.map((t, i) => (t.startsWith(day) ? i : -1)).filter((i) => i >= 0);
  const rows = idx.map((i) => `<tr>
    <td>${f.hh(h.time[i])}h</td>
    <td style="width:34px">${wxIcon(h.weather_code[i], h.is_day[i])}</td>
    <td class="r"><b>${f.temp(h.temperature_2m[i])}</b><br><span class="tiny">${f.temp(h.apparent_temperature[i])}</span></td>
    <td class="r" style="color:var(--rain)">${f.precip(h.precipitation[i], false, true)}<br><span class="tiny">${f.isNum(h.precipitation_probability[i]) ? h.precipitation_probability[i] + '%' : ''}</span></td>
    <td class="r">${f.arrow(h.wind_direction_10m[i])} ${f.wind(h.wind_speed_10m[i])}<br><span class="tiny">${f.wind(h.wind_gusts_10m[i])}</span></td>
    <td class="r">${f.pct(h.cloud_cover[i])}<br><span class="tiny">${f.pct(h.relative_humidity_2m[i])}</span></td>
  </tr>`).join('');
  $('#daySheetBody').innerHTML = `
    <div class="grid3" style="margin-bottom:12px">
      <div class="stat"><div class="k">Máx / mín</div><div class="v">${f.temp(dd.temperature_2m_max[di])} / ${f.temp(dd.temperature_2m_min[di])}</div><div class="s">Sens. ${f.temp(dd.apparent_temperature_max[di])} / ${f.temp(dd.apparent_temperature_min[di])}</div></div>
      <div class="stat"><div class="k">Precipitación</div><div class="v">${f.precip(dd.precipitation_sum[di], true)}</div><div class="s">${f.pct(dd.precipitation_probability_max[di])} · ${f.fixed(dd.precipitation_hours[di])} h${dd.snowfall_sum[di] > 0 ? ` · nieve ${f.snow(dd.snowfall_sum[di])}` : ''}</div></div>
      <div class="stat"><div class="k">Viento</div><div class="v">${f.wind(dd.wind_speed_10m_max[di], true)}</div><div class="s">Rachas ${f.wind(dd.wind_gusts_10m_max[di])} · ${f.dirName(dd.wind_direction_10m_dominant[di])}</div></div>
      <div class="stat"><div class="k">Sol</div><div class="v">${f.hhmm(dd.sunrise[di])}–${f.hhmm(dd.sunset[di])}</div><div class="s">${f.hoursFromSec(dd.sunshine_duration[di])} de sol</div></div>
      <div class="stat"><div class="k">UV máx</div><div class="v">${f.fixed(dd.uv_index_max[di], 0)}</div></div>
      <div class="stat"><div class="k">Tiempo</div><div class="v" style="font-size:14px;white-space:normal">${wxDesc(dd.weather_code[di])}</div></div>
    </div>
    <div class="chart-box short"><canvas id="dayChart"></canvas></div>
    <table class="simple" style="margin-top:10px">
      <thead><tr><th>Hora</th><th></th><th class="r">Temp<br>sens.</th><th class="r">${f.precipUnit()}<br>prob.</th><th class="r">Viento<br>rachas</th><th class="r">Nubes<br>hum.</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  openSheet('daySheet');
  const t = theme();
  makeChart($('#dayChart'), {
    data: {
      labels: idx.map((i) => f.hh(h.time[i])),
      datasets: [
        { type: 'line', label: `Temp ${f.tempUnit()}`, data: idx.map((i) => f.tempVal(h.temperature_2m[i])), borderColor: t.warm, backgroundColor: alpha('#ffb547', 0.15), fill: true, tension: 0.35, pointRadius: 0, yAxisID: 'y' },
        { type: 'bar', label: `Lluvia ${f.precipUnit()}`, data: idx.map((i) => f.precipVal(h.precipitation[i])), backgroundColor: alpha('#4aa8ff', 0.75), yAxisID: 'y1' },
      ],
    },
    options: baseOptions({
      scales: {
        x: { grid: { display: false }, ticks: { color: t.text3, maxRotation: 0 } },
        y: { position: 'left', grid: { color: t.grid }, ticks: { color: t.text3 } },
        y1: { position: 'right', beginAtZero: true, suggestedMax: 2, grid: { display: false }, ticks: { color: t.rain } },
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
      el.innerHTML = `
        ${hero(d)}
        ${nowcast(d)}
        ${hourStrip(d, ni)}
        ${dailyList(d)}
        <div class="grid-wide">
          <div class="card"><div class="card-head"><h2>Detalles ahora</h2></div>${stats(d, ni)}</div>
          ${sunMoon(d)}
        </div>
        <div id="homeAir" style="margin-top:12px"></div>
        <p class="footer-note">Modelo: ${api.modelName(settings.model)} · Altitud ${Math.round(d.elevation)} m<br>
        Actualizado ${f.relTime(lastUpdate)} · Datos: <a href="https://open-meteo.com" target="_blank" rel="noopener">Open-Meteo</a> (CC BY 4.0)</p>`;
      el.querySelectorAll('.drow').forEach((b) => { b.onclick = () => openDay(d, +b.dataset.day); });
      airCard(el.querySelector('#homeAir'));
    } catch (e) {
      errorBox(el, e, () => this.render(el));
    }
  },
};
