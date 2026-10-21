// Viento por modelo, como en Windy: rosa con una barra por modelo (de dónde viene y con qué fuerza)
// y tabla de 3 en 3 horas con dirección, viento medio y rachas; tocar una columna mueve la rosa a esa hora
import * as api from '../api.js';
import * as f from '../format.js';
import { css, textOn } from '../colors.js';

const STEP = 3;
const short = (id) => api.MODELS.find((x) => x.id === id)?.short || id;

// Series de cada modelo (con un solo modelo la API no añade el sufijo _modelo)
export function series(h, models) {
  const get = (v, m) => h[models.length === 1 && h[v] ? v : `${v}_${m}`] || [];
  return models.map((m) => ({ id: m, ws: get('wind_speed_10m', m), wd: get('wind_direction_10m', m), wg: get('wind_gusts_10m', m) }));
}

// Rosa de Windy: una barra por modelo que sale del centro hacia donde viene el viento, con el largo y el
// color de su fuerza. Cada barra va en su dirección exacta: si dos modelos coinciden, se solapan.
// `max` fija la escala (km/h en el borde del círculo); por defecto, la del modelo más fuerte
export function roseSVG(rows, i, { size = 340, cls = 'wm-rose', max, fill = (v) => css('wind', v), ink = (v) => textOn('wind', v) } = {}) {
  const c = size / 2, R = size * 0.37, R0 = size * 0.03;
  const vals = rows.map((r) => r.ws[i]).filter(f.isNum);
  const top = max || Math.max(20, ...vals) * 1.1;
  const ticks = [['N', 0], ['E', 90], ['S', 180], ['O', 270]].map(([t, a]) => {
    const r = (a * Math.PI) / 180, x = c + Math.sin(r) * (R + 14), y = c - Math.cos(r) * (R + 14);
    return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" class="wm-cardinal">${t}</text>`;
  }).join('');
  const bars = rows.filter((r) => f.isNum(r.ws[i]) && f.isNum(r.wd[i])).map((r) => {
    const v = r.ws[i], d = r.wd[i], g = r.wg[i];
    const len = Math.max(size * 0.06, Math.min(1.08, v / top) * (R - R0));
    const txt = `${f.wind(v)}${f.isNum(g) ? ` G:${f.wind(g)}` : ''}`;
    const flip = d > 0 && d < 180; // texto siempre legible de izquierda a derecha
    const inside = len > txt.length * 5.6 + 6; // si no cabe en la barra, va tras el nombre
    return `<g transform="rotate(${(d - 180).toFixed(1)} ${c} ${c})">
      <title>${f.esc(api.modelName(r.id))}: ${f.wind(v, true)} del ${f.dirName(d)} (${Math.round(d)}°)${f.isNum(g) ? `, rachas ${f.wind(g, true)}` : ''}</title>
      <rect x="${c - 7}" y="${c + R0}" width="14" height="${len.toFixed(1)}" rx="2" fill="${fill(v)}" class="wm-bar"/>
      <text class="wm-val" fill="${ink(v)}" transform="translate(${c} ${(c + R0 + len / 2).toFixed(1)}) rotate(${flip ? 90 : -90})">${inside ? txt : ''}</text>
      <text class="wm-name" transform="translate(${c} ${(c + R0 + len + 5).toFixed(1)}) rotate(${flip ? 90 : -90})" text-anchor="${flip ? 'start' : 'end'}">${f.esc(short(r.id))}${inside ? '' : ` ${txt}`}</text>
    </g>`;
  }).join('');
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" class="${cls}" role="img" aria-label="Viento por modelo">
    <circle cx="${c}" cy="${c}" r="${R}" class="wm-ring"/>
    ${ticks}${bars}<circle cx="${c}" cy="${c}" r="5" class="wm-dot"/>
    <text x="${c}" y="${(c + R + 30).toFixed(1)}" class="wm-unit">${f.windUnit()}</text>
  </svg>`;
}

function rose(rows, i, time) {
  return `${roseSVG(rows, i)}
  <div class="wm-when">${f.dayShort(time)} · ${f.hhmm(time)} <span class="tiny">(${f.windUnit()} · medio y racha G)</span></div>`;
}

function table(rows, h, idx, sel, nowI) {
  let dayRow = '';
  for (let k = 0; k < idx.length;) {
    const day = h.time[idx[k]].slice(0, 10);
    let n = 0;
    while (k + n < idx.length && h.time[idx[k + n]].startsWith(day)) n++;
    dayRow += `<td colspan="${n}" class="${k ? 'daystart' : ''}"><span>${f.dayShort(day)}</span></td>`;
    k += n;
  }
  const colCls = (j) => [j > 0 && h.time[idx[j]].slice(0, 10) !== h.time[idx[j - 1]].slice(0, 10) ? 'daystart' : '',
    idx[j] === sel ? 'wm-sel' : '', idx[j] === nowI ? 'nowcol' : ''].join(' ').trim();
  const hourRow = idx.map((i, j) => `<td class="${colCls(j)} wm-col" data-i="${i}">${f.hh(h.time[i])}</td>`).join('');
  const body = rows.map((r) => {
    const tds = idx.map((i, j) => {
      const v = r.ws[i];
      if (!f.isNum(v)) return `<td class="${colCls(j)} wm-col wm-empty" data-i="${i}"></td>`;
      const g = r.wg[i];
      return `<td class="${colCls(j)} wm-col wm-cell" data-i="${i}" style="background:${css('wind', v, 0.85)};color:${textOn('wind', v, 0.85)}">
        <div>${f.arrow(r.wd[i])}${f.wind(v)}</div><small>${f.isNum(g) ? f.wind(g) : ''}</small></td>`;
    }).join('');
    return `<tr><th class="rowlab" title="${f.esc(api.modelName(r.id))}">${f.esc(short(r.id))}</th>${tds}</tr>`;
  }).join('');
  return `<div class="wtable-wrap"><table class="wtable wm-table">
    <tr class="r-day"><th class="rowlab"></th>${dayRow}</tr>
    <tr class="r-hour"><th class="rowlab">Hora</th>${hourRow}</tr>
    ${body}
  </table></div>`;
}

export async function windModelsCard(box, place, models, days) {
  box.innerHTML = `<div class="card-head"><h2>Viento por modelo</h2></div><div class="loading"><div class="spinner"></div>Cargando viento de los modelos…</div>`;
  try {
    const d = await api.compareModels(place, models, ['wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m']);
    const h = d.hourly;
    const rows = series(h, models);
    const now = f.placeNow(d.utc_offset_seconds ?? 0).slice(0, 13);
    let start = h.time.findIndex((t) => t.slice(0, 13) === now);
    if (start < 0) start = 0;
    const end = Math.min(h.time.length, start + days * 24);
    // Columnas a horas redondas de 3 en 3 (2, 5, 8… como Windy) y la hora actual al principio
    const idx = [start];
    for (let i = start + 1; i < end; i++) if (+f.hh(h.time[i]) % STEP === 2) idx.push(i);
    const has = (i) => rows.some((r) => f.isNum(r.ws[i]));
    const cols = idx.filter(has);
    let sel = cols[0];
    const draw = () => {
      box.innerHTML = `<div class="card-head"><h2>Viento por modelo</h2><span class="tiny">toca una hora para verla en la rosa</span></div>
        <div class="wm-rose-wrap">${rose(rows, sel, h.time[sel])}</div>
        ${table(rows, h, cols, sel, start)}
        <p class="note">Cada barra sale del centro hacia donde viene el viento; su largo y color marcan la fuerza. En la tabla, arriba el viento medio a 10 m y abajo las rachas (${f.windUnit()}); la flecha apunta hacia donde sopla. Las casillas vacías son horas que ese modelo ya no cubre.</p>`;
      const wrap = box.querySelector('.wtable-wrap');
      wrap.scrollLeft = scrollLeft;
      wrap.onscroll = () => { scrollLeft = wrap.scrollLeft; };
      box.querySelectorAll('.wm-col').forEach((td) => {
        td.onclick = () => { sel = +td.dataset.i; draw(); };
      });
    };
    let scrollLeft = 0;
    if (!cols.length) throw new Error('sin datos de viento');
    draw();
  } catch (e) {
    box.innerHTML = `<div class="card-head"><h2>Viento por modelo</h2></div><p class="note">No se pudo cargar ahora (${f.esc(e.message)}).</p>`;
  }
}
