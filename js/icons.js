// Códigos meteorológicos WMO → descripción en español e icono SVG propio
const DESC = {
  0: 'Despejado', 1: 'Casi despejado', 2: 'Parcialmente nuboso', 3: 'Cubierto',
  45: 'Niebla', 48: 'Niebla con escarcha',
  51: 'Llovizna débil', 53: 'Llovizna', 55: 'Llovizna intensa',
  56: 'Llovizna helada', 57: 'Llovizna helada intensa',
  61: 'Lluvia débil', 63: 'Lluvia', 65: 'Lluvia fuerte',
  66: 'Lluvia helada', 67: 'Lluvia helada fuerte',
  71: 'Nieve débil', 73: 'Nieve', 75: 'Nieve intensa', 77: 'Granizo fino',
  80: 'Chubascos débiles', 81: 'Chubascos', 82: 'Chubascos fuertes',
  85: 'Chubascos de nieve', 86: 'Chubascos de nieve fuertes',
  95: 'Tormenta', 96: 'Tormenta con granizo', 99: 'Tormenta con granizo fuerte',
};
export const wxDesc = (code) => DESC[code] ?? '—';

const SUN_C = '#ffc44d';
const sun = (cx, cy, r) => {
  let rays = '';
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    const x1 = cx + Math.cos(a) * (r + 4), y1 = cy + Math.sin(a) * (r + 4);
    const x2 = cx + Math.cos(a) * (r + 9), y2 = cy + Math.sin(a) * (r + 9);
    rays += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
  }
  return `<g stroke="${SUN_C}" stroke-width="3" stroke-linecap="round">${rays}</g><circle cx="${cx}" cy="${cy}" r="${r}" fill="${SUN_C}"/>`;
};
const moon = (cx, cy, s) =>
  `<path transform="translate(${cx - 32 * s} ${cy - 32 * s}) scale(${s})" d="M40 14a20 20 0 1 0 12 30A17 17 0 0 1 40 14z" fill="#cfdcf0"/>`;
const cloud = (fill, dy = 0) =>
  `<path transform="translate(0 ${dy})" d="M19 48h28a10.5 10.5 0 0 0 .8-21A15 15 0 0 0 19.6 25 11.6 11.6 0 0 0 19 48z" fill="${fill}"/>`;
const drops = (n, color = '#4aa8ff') => {
  const xs = n === 1 ? [32] : n === 2 ? [26, 38] : [22, 32, 42];
  return xs.map((x) => `<line x1="${x}" y1="47" x2="${x - 3}" y2="57" stroke="${color}" stroke-width="3.2" stroke-linecap="round"/>`).join('');
};
const flakes = (n) => {
  const xs = n === 1 ? [32] : n === 2 ? [25, 39] : [22, 32, 42];
  return xs.map((x, i) => `<circle cx="${x}" cy="${i % 2 ? 56 : 52}" r="2.8" fill="#e6f2ff" stroke="#8fc3ff" stroke-width="1"/>`).join('');
};
const bolt = `<path d="M34 42l-7 11h6l-3 9 9-13h-6l3-7z" fill="#ffd34d"/>`;
const fogLines = `<g stroke="#a9b6c6" stroke-width="3.2" stroke-linecap="round"><line x1="14" y1="46" x2="50" y2="46"/><line x1="18" y1="53" x2="46" y2="53"/><line x1="14" y1="60" x2="40" y2="60"/></g>`;

const cache = new Map();
export function wxIcon(code, isDay = 1, cls = 'wx-ico') {
  const key = `${code}|${isDay}|${cls}`;
  if (cache.has(key)) return cache.get(key);
  const light = '#e3eaf4', mid = '#b6c2d2', dark = '#8996a8';
  const behind = isDay ? sun(22, 22, 9) : moon(24, 22, 0.55);
  let body;
  switch (code) {
    case 0: body = isDay ? sun(32, 32, 13) : moon(32, 32, 0.9); break;
    case 1: body = (isDay ? sun(26, 26, 11) : moon(28, 28, 0.75)) + `<path transform="translate(14 14) scale(.72)" d="M19 48h28a10.5 10.5 0 0 0 .8-21A15 15 0 0 0 19.6 25 11.6 11.6 0 0 0 19 48z" fill="${light}"/>`; break;
    case 2: body = behind + cloud(light); break;
    case 3: body = cloud(mid, -2) + `<path transform="translate(-8 -10) scale(.7)" d="M19 48h28a10.5 10.5 0 0 0 .8-21A15 15 0 0 0 19.6 25 11.6 11.6 0 0 0 19 48z" fill="${dark}" opacity=".7"/>`; break;
    case 45: case 48: body = cloud(mid, -10) + fogLines; break;
    case 51: case 53: case 55: body = cloud(light, -6) + drops(code === 55 ? 3 : 2, '#7cc0ff'); break;
    case 56: case 57: body = cloud(light, -6) + drops(1, '#7cc0ff') + flakes(1); break;
    case 61: body = behind + cloud(light, -6) + drops(1); break;
    case 63: body = cloud(mid, -6) + drops(2); break;
    case 65: body = cloud(dark, -6) + drops(3); break;
    case 66: case 67: body = cloud(mid, -6) + drops(2) + flakes(1); break;
    case 71: body = behind + cloud(light, -6) + flakes(2); break;
    case 73: case 77: body = cloud(light, -6) + flakes(2); break;
    case 75: body = cloud(mid, -6) + flakes(3); break;
    case 80: body = behind + cloud(light, -6) + drops(2); break;
    case 81: body = behind + cloud(mid, -6) + drops(3); break;
    case 82: body = cloud(dark, -6) + drops(3, '#2f8fff'); break;
    case 85: body = behind + cloud(light, -6) + flakes(2); break;
    case 86: body = cloud(mid, -6) + flakes(3); break;
    case 95: body = cloud(dark, -8) + bolt + drops(1); break;
    case 96: case 99: body = cloud(dark, -8) + bolt + flakes(2); break;
    default: body = cloud(mid);
  }
  const svg = `<svg class="${cls}" viewBox="0 0 64 64" aria-label="${wxDesc(code)}" role="img">${body}</svg>`;
  cache.set(key, svg);
  return svg;
}

// Fase lunar (0 = luna nueva, 0.5 = llena) según el ciclo sinódico
export function moonPhase(date = new Date()) {
  const synodic = 29.530588853;
  const ref = Date.UTC(2000, 0, 6, 18, 14); // luna nueva de referencia
  const days = (date.getTime() - ref) / 86400000;
  const phase = ((days % synodic) + synodic) % synodic / synodic;
  const illum = (1 - Math.cos(2 * Math.PI * phase)) / 2;
  const names = ['Luna nueva', 'Luna creciente', 'Cuarto creciente', 'Gibosa creciente', 'Luna llena', 'Gibosa menguante', 'Cuarto menguante', 'Luna menguante'];
  const name = names[Math.round(phase * 8) % 8];
  const nextFull = ((0.5 - phase + 1) % 1) * synodic;
  const nextNew = ((1 - phase) % 1) * synodic;
  return { phase, illum, name, nextFull, nextNew };
}

export function moonSvg(phase) {
  // Dibuja la parte iluminada con dos semielipses
  const r = 20, cx = 24, cy = 24;
  const k = Math.cos(2 * Math.PI * phase); // 1 nueva, -1 llena
  const waxing = phase < 0.5;
  const rx = Math.abs(k) * r;
  const outerSweep = waxing ? 1 : 0;
  const innerSweep = k > 0 ? (waxing ? 0 : 1) : (waxing ? 1 : 0);
  const d = `M${cx} ${cy - r} A${r} ${r} 0 0 ${outerSweep} ${cx} ${cy + r} A${rx} ${r} 0 0 ${innerSweep} ${cx} ${cy - r}z`;
  return `<svg viewBox="0 0 48 48"><circle cx="${cx}" cy="${cy}" r="${r}" fill="#2a3442"/><path d="${d}" fill="#e9edf3"/></svg>`;
}
