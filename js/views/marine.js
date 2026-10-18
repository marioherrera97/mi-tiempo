// Vista "Mar": olas, mar de fondo, temperatura del agua, mareas y corrientes
import { state } from '../state.js';
import * as api from '../api.js';
import * as f from '../format.js';
import { css } from '../colors.js';
import { loading, errorBox } from '../ui.js';
import { makeChart, baseOptions, theme, alpha } from '../charts.js';

function distKm(a, b) {
  const R = 6371, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

export default {
  async render(el) {
    loading(el);
    try {
      const d = await api.marine(state.place);
      const h = d.hourly;
      const valid = h.wave_height.some(f.isNum);
      const dist = distKm(state.place, { lat: d.latitude, lon: d.longitude });
      if (!valid) {
        el.innerHTML = `<div class="card"><h2>Sin datos de mar</h2><p class="note">Este lugar está lejos del mar. Busca una playa o puerto, o toca un punto de la costa en el mapa.</p></div>`;
        return;
      }
      const now = f.placeNow(d.utc_offset_seconds).slice(0, 13);
      let ni = h.time.findIndex((t) => t.slice(0, 13) === now);
      if (ni < 0) ni = 0;
      const t = theme();
      const idx = [];
      for (let i = ni; i < h.time.length; i++) idx.push(i);
      const days = [], dayLabels = [];
      idx.forEach((i, j) => { if (j === 0 || f.hh(h.time[i]) === '00') { if (j) days.push(j); dayLabels.push([j, f.dayShort(h.time[i])]); } });
      const stat = (k, v, s = '') => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;

      // Mareas: máximos y mínimos locales del nivel del mar en las próximas 48 h
      const tides = [];
      const sl = h.sea_level_height_msl;
      for (let i = Math.max(ni, 1); i < Math.min(ni + 48, sl.length - 1); i++) {
        if (!f.isNum(sl[i])) continue;
        if (sl[i] > sl[i - 1] && sl[i] >= sl[i + 1]) tides.push(['Pleamar', h.time[i], sl[i]]);
        if (sl[i] < sl[i - 1] && sl[i] <= sl[i + 1]) tides.push(['Bajamar', h.time[i], sl[i]]);
      }

      const dd = d.daily;
      const today = h.time[ni].slice(0, 10);
      el.innerHTML = `
        <div class="card">
          <div class="card-head"><h2>Ahora en el mar</h2><span class="tiny">punto de rejilla a ${Math.round(dist)} km</span></div>
          <div class="grid3">
            ${stat('Oleaje total', f.waveHeight(h.wave_height[ni]), `${f.arrow(h.wave_direction[ni])} ${f.dirName(h.wave_direction[ni])} · ${f.fixed(h.wave_period[ni], 1)} s`)}
            ${stat('Mar de fondo', f.waveHeight(h.swell_wave_height[ni]), `${f.arrow(h.swell_wave_direction[ni])} ${f.dirName(h.swell_wave_direction[ni])} · ${f.fixed(h.swell_wave_period[ni], 1)} s`)}
            ${stat('Mar de viento', f.waveHeight(h.wind_wave_height[ni]), `${f.fixed(h.wind_wave_period[ni], 1)} s`)}
            ${stat('Agua', f.temp(h.sea_surface_temperature[ni], true), 'temperatura superficial')}
            ${stat('Corriente', f.isNum(h.ocean_current_velocity[ni]) ? f.wind(h.ocean_current_velocity[ni], true) : '–', `${f.arrow(h.ocean_current_direction[ni])} ${f.dirName(h.ocean_current_direction[ni])}`)}
            ${f.isNum(h.wave_peak_period[ni]) ? stat('Periodo pico', f.fixed(h.wave_peak_period[ni], 1) + ' s', '') : stat('2º mar de fondo', f.waveHeight(h.secondary_swell_wave_height[ni]), `${f.fixed(h.secondary_swell_wave_period[ni], 1)} s`)}
          </div>
        </div>
        ${tides.length ? `<div class="card"><div class="card-head"><h2>Mareas (48 h)</h2><span class="tiny">modelo, orientativo</span></div>
          <table class="simple"><tbody>${tides.map(([k, tm, v]) => `<tr><td>${k === 'Pleamar' ? '▲' : '▼'} ${k}</td><td>${f.dayName(tm, today)} ${f.hhmm(tm)}</td><td class="r">${v > 0 ? '+' : ''}${v.toFixed(2)} m</td></tr>`).join('')}</tbody></table></div>` : ''}
        <div class="card"><div class="card-head"><h2>Olas y mar de fondo</h2></div>
          <div class="chart-scroll"><div class="chart-box" style="min-width:${Math.max(600, idx.length * 4)}px"><canvas id="waveChart"></canvas></div></div></div>
        <div class="card"><div class="card-head"><h2>Nivel del mar y agua</h2></div>
          <div class="chart-scroll"><div class="chart-box short" style="min-width:${Math.max(600, idx.length * 4)}px"><canvas id="tideChart"></canvas></div></div></div>
        <div class="card"><div class="card-head"><h2>Por días</h2></div>
          <table class="simple"><thead><tr><th>Día</th><th class="r">Ola máx</th><th class="r">Fondo máx</th><th class="r">Periodo</th><th class="r">Dirección</th></tr></thead>
          <tbody>${dd.time.map((t2, i) => `<tr><td>${f.dayName(t2, today)} <span class="muted">${f.dateShort(t2)}</span></td>
            <td class="r"><span class="prob-cell" style="background:${css('waves', dd.wave_height_max[i], 0.85)};color:#0d141c">${f.waveHeight(dd.wave_height_max[i])}</span></td>
            <td class="r">${f.waveHeight(dd.swell_wave_height_max[i])}</td><td class="r">${f.fixed(dd.wave_period_max[i], 0)} s</td>
            <td class="r">${f.arrow(dd.wave_direction_dominant[i])} ${f.dirName(dd.wave_direction_dominant[i])}</td></tr>`).join('')}</tbody></table></div>
        <p class="footer-note">Datos marinos: Open-Meteo (ECMWF WAM, Météo-France MFWAM, DWD EWAM/GWAM, Copernicus). No usar para navegación.</p>`;

      const markers = { days, labels: dayLabels, now: 0 };
      const lab = idx.map((i) => f.hh(h.time[i]));
      const sel = (k) => idx.map((i) => h[k][i]);
      makeChart(document.getElementById('waveChart'), {
        type: 'line',
        data: {
          labels: lab,
          datasets: [
            { label: 'Ola total (m)', data: sel('wave_height'), borderColor: '#4fa3ff', backgroundColor: alpha('#4fa3ff', 0.2), fill: 'origin', borderWidth: 2, pointRadius: 0, tension: 0.3 },
            { label: 'Mar de fondo (m)', data: sel('swell_wave_height'), borderColor: '#2ec4b6', borderWidth: 1.6, pointRadius: 0, tension: 0.3 },
            { label: 'Mar de viento (m)', data: sel('wind_wave_height'), borderColor: '#c77dff', borderWidth: 1.2, borderDash: [4, 3], pointRadius: 0, tension: 0.3 },
            { label: 'Periodo (s)', data: sel('wave_period'), borderColor: alpha('#ffb547', 0.8), borderWidth: 1.2, pointRadius: 0, yAxisID: 'y1', tension: 0.3 },
          ],
        },
        options: baseOptions({
          plugins: { ...baseOptions().plugins, legend: { ...baseOptions().plugins.legend, align: 'start' }, markers },
          scales: { x: { grid: { display: false }, ticks: { color: t.text3, maxRotation: 0, autoSkipPadding: 12 } }, y: { beginAtZero: true, grid: { color: t.grid } }, y1: { position: 'right', grid: { display: false } } },
        }),
      });
      makeChart(document.getElementById('tideChart'), {
        type: 'line',
        data: {
          labels: lab,
          datasets: [
            { label: 'Nivel del mar (m)', data: sel('sea_level_height_msl'), borderColor: '#8ecae6', borderWidth: 2, pointRadius: 0, tension: 0.4 },
            { label: `Agua ${f.tempUnit()}`, data: idx.map((i) => f.tempVal(h.sea_surface_temperature[i])), borderColor: '#ff8a5b', borderWidth: 1.4, pointRadius: 0, yAxisID: 'y1' },
          ],
        },
        options: baseOptions({
          plugins: { ...baseOptions().plugins, legend: { ...baseOptions().plugins.legend, align: 'start' }, markers },
          scales: { x: { grid: { display: false }, ticks: { color: t.text3, maxRotation: 0, autoSkipPadding: 12 } }, y: { grid: { color: t.grid } }, y1: { position: 'right', grid: { display: false } } },
        }),
      });
    } catch (e) {
      errorBox(el, e, () => this.render(el));
    }
  },
};
