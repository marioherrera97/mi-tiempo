// Viento por modelo, como en Windy: rosa con una barra por modelo (de dónde viene y con qué fuerza)
// y tabla de 3 en 3 horas con dirección, viento medio y rachas; tocar una columna mueve la rosa a esa hora
import * as api from '../api.js';
import * as f from '../format.js';
import { css, textOn } from '../colors.js';

const STEP = 3;
const short = (id) => api.MODELS.find((x) => x.id === id)?.short || id;

// Series de cada modelo (con un solo modelo la API no añade el sufijo _modelo)
function series(h, models) {
  const get = (v, m) => h[models.length === 1 && h[v] ? v : `${v}_${m}`] || [];
  return models.map((m) => ({ id: m, ws: get('wind_speed_10m', m), wd: get('wind_direction_10m', m), wg: get('wind_gusts_10m', m) }));
}

// Reparte ángulos ordenados para que entre dos haya al menos `gap` grados: los que quedan juntos forman
// un grupo, centrado en su media, con sus barras a `gap` grados unas de otras
function spread(items, gap) {
  if (items.length < 2) return;
  // Empieza justo después del mayor hueco para no partir un grupo que cruce el norte
  let cut = 0, best = -1;
  items.forEach((p, k) => {
    const q = items[(k + 1) % items.length];
    const g = (q.a - p.a + 360) % 360;
    if (g > best) { best = g; cut = (k + 1) % items.length; }
  });
  const seq = [...items.slice(cut), ...items.slice(0, cut)];
  seq.forEach((p, k) => { if (k && p.a < seq[k - 1].a) p.a += 360; });
  let groups = seq.map((p) => ({ c: p.a, m: [p] }));
  for (let merged = true; merged;) {
    merged = false;
    for (let k = 0; k + 1 < groups.length; k++) {
      const g = groups[k], h = groups[k + 1];
      const gEnd = g.c + ((g.m.length - 1) * gap) / 2, hStart = h.c - ((h.m.length - 1) * gap) / 2;
      if (hStart - gEnd < gap) {
        const m = [...g.m, ...h.m];
        groups.splice(k, 2, { c: (g.c * g.m.length + h.c * h.m.length) / m.length, m });
        merged = true;
        break;
      }
    }
  }
  groups.forEach((g) => g.m.forEach((p, k) => { p.a = g.c + (k - (g.m.length - 1) / 2) * gap; }));
}

function rose(rows, i, time) {
  const S = 340, c = S / 2, R = 128;
  const vals = rows.map((r) => r.ws[i]).filter(f.isNum);
  // Escala: la barra más fuerte llega casi al círculo; mínimo 20 km/h para que la calma se vea corta
  const max = Math.max(20, ...vals) * 1.1;
  const ticks = [['N', 0], ['E', 90], ['S', 180], ['O', 270]].map(([t, a]) => {
    const r = (a * Math.PI) / 180, x = c + Math.sin(r) * (R + 16), y = c - Math.cos(r) * (R + 16);
    return `<text x="${x}" y="${y}" class="wm-cardinal">${t}</text>`;
  }).join('');
  // Los modelos que coinciden en dirección se separan un poco al dibujarlos para que no se tapen
  // (la dirección exacta queda en el título de cada barra)
  const items = rows.filter((r) => f.isNum(r.ws[i]) && f.isNum(r.wd[i])).map((r) => ({ r, a: r.wd[i] })).sort((p, q) => p.a - q.a);
  spread(items, 16);
  const bars = items.map(({ r, a }) => {
    const v = r.ws[i], d = ((a % 360) + 360) % 360;
    const R0 = 34, len = Math.max(18, (v / max) * (R - R0)); // las barras arrancan algo fuera del centro
    // La barra apunta hacia donde viene el viento (como la veleta de Windy)
    const rot = d - 180;
    const txt = `${f.wind(v)}${f.isNum(r.wg[i]) ? `·${f.wind(r.wg[i])}` : ''}`;
    const flip = d > 0 && d < 180; // texto siempre legible de izquierda a derecha
    return `<g transform="rotate(${rot.toFixed(1)} ${c} ${c})">
      <title>${f.esc(api.modelName(r.id))}: ${f.wind(v, true)} del ${f.dirName(r.wd[i])}${f.isNum(r.wg[i]) ? `, rachas ${f.wind(r.wg[i], true)}` : ''}</title>
      <rect x="${c - 6}" y="${c + R0}" width="12" height="${len.toFixed(1)}" rx="3" fill="${css('wind', v)}" stroke="rgba(0,0,0,.25)"/>
      <text class="wm-val" fill="${textOn('wind', v)}" transform="translate(${c} ${c + R0 + len / 2}) rotate(${flip ? 90 : -90})">${len > txt.length * 6 + 6 ? txt : ''}</text>
      <text class="wm-name" transform="translate(${c} ${c + R0 + len + 6}) rotate(${flip ? 90 : -90})" text-anchor="${flip ? 'start' : 'end'}">${f.esc(short(r.id))}</text>
    </g>`;
  }).join('');
  return `<svg viewBox="0 0 ${S} ${S}" class="wm-rose" role="img" aria-label="Viento por modelo">
    <circle cx="${c}" cy="${c}" r="${R}" class="wm-ring"/><circle cx="${c}" cy="${c}" r="${R / 2}" class="wm-ring thin"/>
    ${ticks}${bars}<circle cx="${c}" cy="${c}" r="5" class="wm-dot"/>
  </svg>
  <div class="wm-when">${f.dayShort(time)} · ${f.hhmm(time)} <span class="tiny">(${f.windUnit()} · medio·racha, escala hasta ${f.wind(max, true)})</span></div>`;
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
