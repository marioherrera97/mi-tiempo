// Vista "Embalses y lluvia" (al estilo de embalses.net): reserva de agua de España, por cuencas y por embalse
// (Boletín Hidrológico semanal del MITECO, preparado en vendor/embalses.json) y lluvia caída en el lugar elegido
// en el año hidrológico comparada con la normal 1991–2020.
import { state, load, save } from '../state.js';
import * as api from '../api.js';
import * as f from '../format.js';
import { loading, errorBox } from '../ui.js';
import { makeChart, baseOptions, theme, alpha } from '../charts.js';

let data = null;
const getData = () => (data ||= fetch('vendor/embalses.json').then((r) => {
  if (!r.ok) throw new Error(`Error HTTP ${r.status}`);
  return r.json();
}).catch((e) => { data = null; throw e; }));

// Colores por porcentaje de llenado, como embalses.net (rojo vacío → azul lleno)
const fillColor = (p) => (p < 20 ? '#e5484d' : p < 40 ? '#f08c3c' : p < 60 ? '#e9c13b' : p < 80 ? '#4fa3ff' : '#2f6fe0');
const pc = (a, b) => (b ? (100 * a) / b : 0);
// Los datos vienen casi siempre en hm³ enteros: los decimales solo cuando los hay
const num = (v) => (Math.abs(v) >= 100 || Math.abs(v - Math.round(v)) < 0.05 ? Math.round(v).toLocaleString('es-ES') : v.toFixed(1).replace('.', ','));
const hm3 = (v) => num(v) + ' hm³';
const p1 = (v) => v.toFixed(1).replace('.', ',') + ' %';
// Variación con signo y color (verde si sube el agua, rojo si baja)
const delta = (d, unit = ' hm³') => {
  if (!f.isNum(d) || Math.abs(d) < 0.05) return '<span class="rv-d">=</span>';
  const v = num(Math.abs(d));
  return `<span class="rv-d ${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} ${v}${unit}</span>`;
};
// Nombres como en el boletín («Pardo, El», «Vellón,El-(Pedrezuela)») escritos de forma natural
const nice = (n) => n
  .replace(/^(.*?),\s*(El|La|Los|Las|As|Os|O|A|Nª Sª de)\b(.*)$/, '$2 $1$3')
  .replace(/-?\(/g, ' (').replace(/\s+/g, ' ').trim();
const bar = (p) => `<div class="rv-bar"><i style="width:${Math.min(100, Math.max(0, p)).toFixed(1)}%;background:${fillColor(p)}"></i></div>`;
const distKm = (a, b, c, d) => {
  const R = 6371, r = Math.PI / 180;
  const x = Math.sin(((c - a) * r) / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(((d - b) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};

// Mini gráfico de la última año de un embalse (SVG, sin Chart.js: hay cientos)
function spark(series, cap) {
  const pts = series.map((v, i) => [i, v]).filter(([, v]) => f.isNum(v));
  if (pts.length < 2) return '';
  const W = 300, H = 56, n = series.length - 1;
  const xy = pts.map(([i, v]) => `${((i / n) * W).toFixed(1)},${(H - 2 - (v / cap) * (H - 4)).toFixed(1)}`);
  const last = pts[pts.length - 1][1];
  const col = fillColor(pc(last, cap));
  return `<svg class="rv-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <polygon points="0,${H} ${xy.join(' ')} ${W},${H}" fill="${alpha(col, 0.18)}"/>
    <polyline points="${xy.join(' ')}" fill="none" stroke="${col}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
}

// Fila de un embalse; al tocarla se despliega su detalle
function resRow(r, basinName, dist) {
  const [name, , cap, cur, prev, year, avg10, elec, , , series] = r;
  const p = pc(cur, cap);
  return `<details class="rv-res">
    <summary>
      <div class="rv-top"><b>${f.esc(nice(name))}</b>${elec ? '<span class="rv-tag" title="Uso hidroeléctrico">⚡</span>' : ''}
        ${dist !== undefined ? `<span class="rv-km">${dist < 10 ? dist.toFixed(1).replace('.', ',') : Math.round(dist)} km</span>` : ''}
        <span class="rv-pct" style="color:${fillColor(p)}">${Math.round(p)} %</span></div>
      ${bar(p)}
      <div class="rv-sub"><span>${hm3(cur)} de ${hm3(cap)}</span>${delta(f.isNum(prev) ? cur - prev : null)}</div>
    </summary>
    <div class="rv-more">
      ${spark(series, cap)}
      <div class="rv-cmp">
        <span>Cuenca</span><b>${f.esc(basinName)}</b>
        <span>Hace un año</span><b>${f.isNum(year) ? `${p1(pc(year, cap))} · ${hm3(year)}` : '–'}</b>
        <span>Media 10 años</span><b>${f.isNum(avg10) ? `${p1(pc(avg10, cap))} · ${hm3(avg10)}` : '–'}</b>
        <span>Uso</span><b>${elec ? 'Hidroeléctrico' : 'Consuntivo (riego y abastecimiento)'}</b>
      </div>
    </div>
  </details>`;
}

function renderReservoirs(box, d) {
  const t = d.total;
  const p = pc(t.cur, t.cap);
  const upd = f.dateShort(d.updated) + ' ' + d.updated.slice(0, 4);
  const here = state.place;
  const near = d.res.filter((r) => f.isNum(r[8]))
    .map((r) => [r, distKm(here.lat, here.lon, r[8], r[9])])
    .sort((a, b) => a[1] - b[1]).slice(0, 6).filter(([, km]) => km < 250);
  const cmp = (label, v) => `<div class="stat"><div class="k">${label}</div><div class="v">${p1(pc(v, t.cap))}</div><div class="s">${hm3(v)} · ${delta(t.cur - v)}</div></div>`;
  box.innerHTML = `
    <div class="card rv-hero">
      <div class="card-head"><h2>Reserva de agua en España</h2><span class="tiny">semana del ${upd}</span></div>
      <div class="rv-big"><span style="color:${fillColor(p)}">${p1(p)}</span><small>${hm3(t.cur)} de ${hm3(t.cap)}</small></div>
      ${bar(p)}
      <div class="rv-week">Esta semana ${delta(t.cur - t.prev)} <span class="muted">(${p1(pc(t.cur - t.prev, t.cap)).replace(/^(?!-)/, '+')} de la capacidad)</span></div>
      <div class="grid3 rv-stats">
        ${cmp('Semana anterior', t.prev)}
        ${cmp('Hace un año', t.year)}
        ${cmp('Media 10 años', t.avg10)}
      </div>
      <div class="rv-split">
        <div><span>Uso consuntivo</span><b>${p1(pc(t.cons.cur, t.cons.cap))}</b>${bar(pc(t.cons.cur, t.cons.cap))}<small>${hm3(t.cons.cur)} de ${hm3(t.cons.cap)}</small></div>
        <div><span>Hidroeléctricos</span><b>${p1(pc(t.elec.cur, t.elec.cap))}</b>${bar(pc(t.elec.cur, t.elec.cap))}<small>${hm3(t.elec.cur)} de ${hm3(t.elec.cap)}</small></div>
      </div>
    </div>
    <div class="card"><div class="card-head"><h2>Este año y el anterior</h2><span class="tiny">% de capacidad</span></div>
      <div class="chart-box short"><canvas id="rvChart"></canvas></div></div>
    ${near.length ? `<div class="section-title">Embalses cerca de ${f.esc(here.name)}</div>
      <div class="card rv-list">${near.map(([r, km]) => resRow(r, d.basins[r[1]].name, km)).join('')}</div>` : ''}
    <div class="section-title">Por cuencas</div>
    <div class="card rv-list">${d.basins.map((b, i) => {
      const bp = pc(b.cur, b.cap);
      const list = d.res.filter((r) => r[1] === i).sort((a, c) => c[2] - a[2]);
      return `<details class="rv-basin">
        <summary>
          <div class="rv-top"><b>${f.esc(b.name)}</b><span class="rv-n">${b.n} embalses</span><span class="rv-pct" style="color:${fillColor(bp)}">${Math.round(bp)} %</span></div>
          ${bar(bp)}
          <div class="rv-sub"><span>${hm3(b.cur)} de ${hm3(b.cap)} · hace un año ${Math.round(pc(b.year, b.cap))} %</span>${delta(b.cur - b.prev)}</div>
        </summary>
        <div class="rv-inner">${list.map((r) => resRow(r, b.name)).join('')}</div>
      </details>`;
    }).join('')}</div>
`;

  // Gráfico: % de la capacidad este año (últimas 53 semanas) frente al año anterior en las mismas semanas
  const th = theme();
  const s = t.series.map((v) => pc(v, t.cap));
  const thisYear = s.slice(-53), lastYear = s.slice(-105, -52);
  const labels = d.weeks.slice(-53).map((w) => f.dateShort(w));
  makeChart(box.querySelector('#rvChart'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Este año', data: thisYear, borderColor: th.accent, backgroundColor: alpha(th.accent, 0.15), fill: true, borderWidth: 2.2, pointRadius: 0, tension: 0.3 },
        { label: 'Año anterior', data: lastYear, borderColor: th.text3, borderDash: [5, 4], borderWidth: 1.6, pointRadius: 0, tension: 0.3 },
      ],
    },
    options: baseOptions({
      plugins: {
        legend: { labels: { boxWidth: 12, boxHeight: 12, usePointStyle: true, color: th.text } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${p1(c.parsed.y)}` } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: th.text3, maxRotation: 0, autoSkip: true, autoSkipPadding: 18 } },
        y: { grid: { color: th.grid }, ticks: { color: th.text3, callback: (v) => v + ' %' }, suggestedMin: 30, suggestedMax: 80 },
      },
    }),
  });
}

// ---------- Lluvia caída en el lugar (año hidrológico, desde el 1 de octubre) ----------
const hydroStart = (ymd) => `${+ymd.slice(5, 7) >= 10 ? ymd.slice(0, 4) : +ymd.slice(0, 4) - 1}-10-01`;
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const normKey = () => `rainnorm:${state.place.lat.toFixed(2)},${state.place.lon.toFixed(2)}`;

// Lluvia media de cada día del año (MM-DD) en 1991–2020 (ERA5); se calcula una vez por lugar y se guarda
async function rainNormals() {
  const saved = load(normKey(), null);
  if (saved) return saved;
  const d = await api.archive(state.place, '1991-01-01', '2020-12-31', ['precipitation_sum'], { ttl: 0 });
  const sum = {}, n = {};
  d.daily.time.forEach((t, i) => {
    const v = d.daily.precipitation_sum[i];
    if (!f.isNum(v)) return;
    const k = t.slice(5, 10);
    sum[k] = (sum[k] || 0) + v;
    n[k] = (n[k] || 0) + 1;
  });
  const res = Object.fromEntries(Object.keys(sum).map((k) => [k, +(sum[k] / n[k]).toFixed(2)]));
  save(normKey(), res);
  return res;
}

async function renderRain(box) {
  const p = state.place;
  box.innerHTML = `<div class="card"><div class="card-head"><h2>Lluvia caída en ${f.esc(p.name)}</h2></div><div class="loading"><div class="spinner"></div>Cargando lluvia…</div></div>`;
  const r = await api.rainPast(p);
  const h = r.hourly;
  const now = r.current.time.slice(0, 13);
  // Solo las horas ya pasadas (la API también trae lo previsto para el resto del día)
  let last = h.time.findIndex((t) => t.slice(0, 13) > now);
  if (last < 0) last = h.time.length;
  const daily = new Map();
  for (let i = 0; i < last; i++) {
    const day = h.time[i].slice(0, 10);
    daily.set(day, (daily.get(day) || 0) + (h.precipitation[i] || 0));
  }
  const sumH = (n) => h.precipitation.slice(Math.max(0, last - n), last).reduce((a, b) => a + (b || 0), 0);
  const today = now.slice(0, 10);
  const start = hydroStart(today);
  // Más de ~90 días atrás: se completa con el archivo histórico (ERA5)
  if (daysBetween(start, today) > 88) {
    try {
      const a = await api.archive(p, start, f.addDays(today, -8), ['precipitation_sum']);
      a.daily.time.forEach((t, i) => { if (!daily.has(t) && f.isNum(a.daily.precipitation_sum[i])) daily.set(t, a.daily.precipitation_sum[i]); });
    } catch { /* se muestra lo que haya */ }
  }
  const days = [];
  for (let d = start; d <= today; d = f.addDays(d, 1)) days.push(d);
  const cum = [];
  let acc = 0;
  for (const d of days) { acc += daily.get(d) || 0; cum.push(acc); }
  // Últimos n días naturales (hoy incluido), aunque empiecen antes del 1 de octubre
  const sumDays = (n) => { let t = 0; for (let k = 0; k < n; k++) t += daily.get(f.addDays(today, -k)) || 0; return t; };
  const item = (k, v, s = '') => `<div class="stat"><div class="k">${k}</div><div class="v">${f.precip(v, true)}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
  box.innerHTML = `
    <div class="card">
      <div class="card-head"><h2>Lluvia caída en ${f.esc(p.name)}</h2></div>
      <div class="grid2 rv-rain">
        ${item('Últimas 24 h', sumH(24))}
        ${item('Últimos 7 días', sumDays(7))}
        ${item('Últimos 30 días', sumDays(30))}
        <div class="stat" id="rvHydro"><div class="k">Año hidrológico (desde el 1 oct)</div><div class="v">${f.precip(acc, true)}</div><div class="s">calculando lo normal…</div></div>
      </div>
      <div class="chart-box short" style="margin-top:12px"><canvas id="rvRainChart"></canvas></div>
      <p class="note">Estimación del modelo para este punto (Open-Meteo), no de un pluviómetro. Lo normal es la media 1991–2020 (ERA5).</p>
    </div>`;

  const th = theme();
  const labels = days.map((d) => f.dateShort(d));
  const chart = makeChart(box.querySelector('#rvRainChart'), {
    data: {
      labels,
      datasets: [
        { type: 'line', label: 'Acumulada este año', data: cum, borderColor: th.rain, backgroundColor: alpha(th.rain, 0.15), fill: true, borderWidth: 2.2, pointRadius: 0, tension: 0.2, yAxisID: 'y' },
        { type: 'bar', label: 'Cada día', data: days.map((d) => f.precipVal(daily.get(d) || 0)), backgroundColor: alpha(th.rain, 0.55), yAxisID: 'y1', barPercentage: 1, categoryPercentage: 0.9 },
      ],
    },
    options: baseOptions({
      plugins: { legend: { labels: { boxWidth: 12, boxHeight: 12, usePointStyle: true, color: th.text } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${f.precip(c.dataset.yAxisID === 'y1' ? (daily.get(days[c.dataIndex]) || 0) : c.parsed.y, true)}` } } },
      scales: {
        x: { grid: { display: false }, ticks: { color: th.text3, maxRotation: 0, autoSkip: true, autoSkipPadding: 18 } },
        y: { position: 'left', beginAtZero: true, grid: { color: th.grid }, ticks: { color: th.text3 } },
        y1: { position: 'right', beginAtZero: true, grid: { display: false }, ticks: { color: th.text3 } },
      },
    }),
  });
  // El acumulado se convierte a la unidad elegida (mm o pulgadas)
  chart.data.datasets[0].data = cum.map((v) => f.precipVal(v));
  chart.update();

  // Lo normal llega después (la primera vez son 30 años de datos)
  try {
    const norm = await rainNormals();
    let nacc = 0;
    const ncum = days.map((d) => (nacc += norm[d.slice(5, 10)] || 0));
    const ratio = nacc > 0.5 ? (100 * acc) / nacc : null;
    const s = box.querySelector('#rvHydro .s');
    if (s) s.innerHTML = `normal ${f.precip(nacc, true)}${ratio !== null ? ` · <b style="color:${ratio >= 100 ? 'var(--ok)' : ratio >= 75 ? 'var(--warm)' : 'var(--danger)'}">${Math.round(ratio)} %</b>` : ''}`;
    chart.data.datasets.splice(1, 0, { type: 'line', label: 'Normal 1991–2020', data: ncum.map((v) => f.precipVal(v)), borderColor: th.text3, borderDash: [5, 4], borderWidth: 1.6, pointRadius: 0, tension: 0.2, yAxisID: 'y' });
    chart.update();
  } catch {
    const s = box.querySelector('#rvHydro .s');
    if (s) s.textContent = 'normal no disponible ahora';
  }
}

export default {
  async render(el) {
    el.innerHTML = `<div id="rvRes"></div><div class="section-title">Lluvia</div><div id="rvRain"></div>
      <p class="footer-note">Embalses: <a href="https://www.miteco.gob.es/es/agua/temas/evaluacion-de-los-recursos-hidricos/boletin-hidrologico.html" target="_blank" rel="noopener">Boletín Hidrológico del MITECO</a>
      (embalses peninsulares de más de 5 hm³; datos provisionales que se actualizan cada semana).
      Ubicación de los embalses: Wikidata y OpenStreetMap. Lluvia: Open-Meteo y ERA5 (Copernicus).</p>`;
    const resBox = el.querySelector('#rvRes'), rainBox = el.querySelector('#rvRain');
    loading(resBox, 'Cargando embalses…');
    const res = getData().then((d) => renderReservoirs(resBox, d)).catch((e) => errorBox(resBox, e, () => this.render(el)));
    const rain = renderRain(rainBox).catch((e) => errorBox(rainBox, e, () => renderRain(rainBox)));
    await Promise.all([res, rain]);
  },
};
