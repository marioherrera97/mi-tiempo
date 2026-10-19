// Vista "Planes": mejores horas de la semana para una actividad (correr, tender, regar, sulfatar, bici, barbacoa)
// y estado del agua en el suelo (seco, en su punto o encharcado).
import { state, load, save } from '../state.js';
import { getForecast } from '../data.js';
import * as api from '../api.js';
import * as f from '../format.js';
import { loading, errorBox, chips } from '../ui.js';
import { makeChart, baseOptions, theme, alpha } from '../charts.js';
import { nowIndex } from './home.js';
import { ACTIVITIES, scoreHours, bestWindows, scoreColor, soilBalance, soilState, CAP } from '../outdoor.js';

let act = load('act', 'correr');
let soilFrac = null;

const fmt1 = (v) => v.toFixed(1).replace('.', ',');
const range = (r) => {
  const a = +r.items[0].t.slice(11, 13), b = +r.items[r.items.length - 1].t.slice(11, 13) + 1;
  return `${a}–${b} h`;
};

function hourInfo(d, x) {
  const h = d.hourly, i = x.i;
  return `<b>${f.dayName(x.t, d.current?.time.slice(0, 10))} ${f.hh(x.t)} h</b> · nota <b style="color:${scoreColor(Math.max(2, x.s))}">${fmt1(x.s)}</b><br>
    <span class="small muted">Sensación ${f.temp(h.apparent_temperature[i], true)} · lluvia ${f.pct(h.precipitation_probability[i])}${h.precipitation[i] >= 0.1 ? ` (${f.precip(h.precipitation[i], true)})` : ''} · viento ${f.wind(h.wind_speed_10m[i], true)} · humedad ${f.pct(h.relative_humidity_2m[i])}</span>
    ${x.why.length ? `<br><span class="small">Lo que baja la nota: ${x.why.join(', ')}</span>` : ''}`;
}

function renderPlan(box, d) {
  const ni = nowIndex(d);
  const h = d.hourly;
  const today = d.current?.time.slice(0, 10) || h.time[ni].slice(0, 10);
  // Desde las 0 h de hoy hasta 7 días: las horas pasadas salen apagadas
  const start = h.time.findIndex((t) => t.startsWith(today));
  const all = scoreHours(d, act, start, 24 * 7, { soil: act === 'regar' ? soilFrac : null });
  const future = all.filter((x) => x.i >= ni);
  const best = bestWindows(future, act === 'tender' ? 6 : 6.5, 5, { tender: 4, regar: 2, sulfatar: 2 }[act] || 3);
  const days = [];
  for (let k = 0; k < all.length; k += 24) days.push(all.slice(k, k + 24));
  const A = ACTIVITIES[act];
  box.innerHTML = `
    <div class="card">
      <div class="card-head"><h2>Mejores momentos para ${A.name.toLowerCase()}</h2><span class="tiny">7 días</span></div>
      ${best.length ? `<div class="pl-best">${best.map((r) => `<div class="pl-b">
          <span class="pl-score" style="background:${scoreColor(r.mean)}">${fmt1(r.mean)}</span>
          <span class="pl-when"><b>${f.dayName(r.items[0].t, today)}</b> ${f.dateShort(r.items[0].t)}<small>${range(r)}</small></span>
          <span class="pl-wx">${f.temp(h.apparent_temperature[r.items[0].i], true)} · ${f.pct(Math.max(...r.items.map((x) => h.precipitation_probability[x.i] || 0)))} lluvia · ${f.wind(Math.max(...r.items.map((x) => h.wind_speed_10m[x.i] || 0)), true)}</span>
        </div>`).join('')}</div>`
        : '<p class="fl-ok" style="color:var(--text-2)">Esta semana no hay ningún buen momento. Mira abajo las horas menos malas.</p>'}
    </div>
    <div class="card">
      <div class="card-head"><h2>Hora a hora</h2><span class="tiny">toca una casilla</span></div>
      <div class="pl-grid">
        <div class="pl-hrs"><span></span>${Array.from({ length: 24 }, (_, k) => `<span>${k % 6 === 0 ? k : ''}</span>`).join('')}</div>
        ${days.map((row) => `<div class="pl-row"><span class="pl-day">${f.dayName(row[0].t, today).slice(0, 3)}<small>${+row[0].t.slice(8, 10)}</small></span>${row.map((x) => `<i data-k="${all.indexOf(x)}" class="${x.i < ni ? 'past' : ''}${x.i === ni ? ' now' : ''}" style="background:${scoreColor(x.s)}"></i>`).join('')}</div>`).join('')}
      </div>
      <div class="pl-scale"><span>Mal</span><i style="background:linear-gradient(90deg,${[2, 4, 5, 6.5, 8, 10].map(scoreColor).join(',')})"></i><span>Perfecto</span></div>
      <div class="pl-info" id="plInfo">${future[0] ? hourInfo(d, future[0]) : ''}</div>
    </div>`;
  box.querySelectorAll('.pl-row i').forEach((c) => {
    c.onclick = () => {
      box.querySelectorAll('.pl-row i.sel').forEach((x) => x.classList.remove('sel'));
      c.classList.add('sel');
      box.querySelector('#plInfo').innerHTML = hourInfo(d, all[+c.dataset.k]);
    };
  });
}

async function renderSoil(box) {
  const p = state.place;
  const r = await api.soilWater(p);
  const dd = r.daily;
  const today = f.placeNow(r.utc_offset_seconds).slice(0, 10);
  const ti = Math.max(0, dd.time.indexOf(today));
  const s = soilBalance(dd, ti);
  const st = soilState(s, ti);
  soilFrac = st.frac;
  // ¿Cuándo se queda seco si no llueve lo previsto?
  const dryDay = s.slice(ti + 1).find((x) => x.w / CAP < 0.3);
  const fut = s.slice(ti + 1);
  const rainNext = fut.reduce((a, x) => a + x.p, 0), etNext = fut.reduce((a, x) => a + x.et, 0);
  const past14 = s.slice(Math.max(0, ti - 13), ti + 1);
  const bal14 = past14.reduce((a, x) => a + x.p - x.et, 0);
  const h = r.hourly;
  let sm = null;
  if (h?.soil_moisture_3_to_9cm) {
    const k = h.time.findIndex((t) => t.slice(0, 13) === f.placeNow(r.utc_offset_seconds).slice(0, 13));
    sm = h.soil_moisture_3_to_9cm[k >= 0 ? k : 0];
  }
  box.innerHTML = `<div class="card">
    <div class="card-head"><h2>Agua en el suelo</h2><span class="tiny">${f.esc(p.name)}</span></div>
    <div class="sl-top">
      <div class="sl-gauge"><i style="height:${Math.round(st.frac * 100)}%;background:${st.color}"></i></div>
      <div><b class="sl-state" style="color:${st.color}">${st.label}</b><br><span class="small">${st.text}</span>
      ${dryDay && st.key !== 'dry' ? `<br><span class="small muted">Si se cumple la previsión, estará seco el ${f.dayName(dryDay.t, today).toLowerCase()}.</span>` : ''}</div>
    </div>
    <div class="grid3 rv-stats">
      <div class="stat"><div class="k">Balance 14 días</div><div class="v">${bal14 >= 0 ? '+' : ''}${f.precip(bal14, true)}</div><div class="s">lluvia − evaporación</div></div>
      <div class="stat"><div class="k">Próx. 7 días</div><div class="v">${f.precip(rainNext, true)}</div><div class="s">se evaporarán ${f.precip(etNext, true)}</div></div>
      <div class="stat"><div class="k">Humedad (modelo)</div><div class="v">${f.isNum(sm) ? Math.round(sm * 100) + ' %' : '–'}</div><div class="s">a 3–9 cm, en volumen</div></div>
    </div>
    <div class="chart-box short" style="margin-top:10px"><canvas id="slChart"></canvas></div>
    <p class="note">Balance diario de un suelo medio que guarda hasta ${CAP} mm de agua útil: entra la lluvia y sale la evapotranspiración de referencia (ET0 FAO-56, Open-Meteo).
      Es orientativo: un suelo arenoso se seca antes y uno arcilloso aguanta más. La humedad del modelo viene de Open-Meteo.</p>
  </div>`;
  const th = theme();
  makeChart(box.querySelector('#slChart'), {
    data: {
      labels: s.map((x) => f.dateShort(x.t)),
      datasets: [
        { type: 'line', label: 'Agua en el suelo (%)', data: s.map((x) => Math.round((x.w / CAP) * 100)), borderColor: th.accent, backgroundColor: alpha(th.accent, 0.12), fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2,
          segment: { borderDash: (c) => (c.p1DataIndex > ti ? [5, 4] : undefined) }, yAxisID: 'y' },
        { type: 'bar', label: 'Lluvia', data: s.map((x) => f.precipVal(x.p)), backgroundColor: alpha(th.rain, 0.7), yAxisID: 'y1' },
        { type: 'bar', label: 'Evaporación', data: s.map((x) => -f.precipVal(x.et)), backgroundColor: alpha('#ffb547', 0.6), yAxisID: 'y1' },
      ],
    },
    options: baseOptions({
      plugins: { legend: { labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true, color: th.text } } },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { color: th.text3, maxRotation: 0, autoSkip: true, autoSkipPadding: 16 } },
        y: { min: 0, max: 100, position: 'left', grid: { color: th.grid }, ticks: { color: th.text3, callback: (v) => v + ' %' } },
        y1: { stacked: true, position: 'right', grid: { display: false }, ticks: { color: th.text3 } },
      },
    }),
  });
}

export default {
  async render(el) {
    el.innerHTML = `<div class="toolbar pl-acts" id="plActs"></div><div id="plBody"></div><div id="plSoil"></div>
      <p class="footer-note">Notas de 0 a 10 calculadas con el pronóstico por horas (temperatura y sensación térmica, lluvia, viento, humedad y UV).
      Datos: <a href="https://open-meteo.com" target="_blank" rel="noopener">Open-Meteo</a> (CC BY 4.0).</p>`;
    const body = el.querySelector('#plBody'), soil = el.querySelector('#plSoil');
    loading(body);
    let d = null;
    el.querySelector('#plActs').append(chips(Object.entries(ACTIVITIES).map(([k, a]) => [k, `${a.icon} ${a.name}`]), act, (v) => {
      act = v; save('act', v);
      if (d) renderPlan(body, d);
    }));
    const soilP = renderSoil(soil).catch((e) => errorBox(soil, e, () => renderSoil(soil)));
    try {
      d = await getForecast();
      await soilP; // el riego tiene en cuenta lo húmedo que está el suelo
      renderPlan(body, d);
    } catch (e) {
      errorBox(body, e, () => this.render(el));
    }
  },
};
