// Formato de unidades y fechas. Las fechas de la API vienen en hora local del lugar ("2026-10-18T09:00"),
// así que se tratan como texto para no mezclar la zona horaria del navegador.
import { settings } from './state.js';

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const DIAS_C = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MESES_C = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

export const isNum = (v) => typeof v === 'number' && !Number.isNaN(v);
const dash = '–';

// ---------- Unidades ----------
export function tempVal(c) {
  if (!isNum(c)) return null;
  return settings.temp === 'f' ? c * 9 / 5 + 32 : c;
}
export function temp(c, withUnit = false) {
  const v = tempVal(c);
  if (v === null) return dash;
  return Math.round(v) + (withUnit ? (settings.temp === 'f' ? '°F' : '°C') : '°');
}
export const tempUnit = () => (settings.temp === 'f' ? '°F' : '°C');
// Diferencias de temperatura (anomalías)
export function tempDelta(k) {
  if (!isNum(k)) return dash;
  const v = settings.temp === 'f' ? k * 9 / 5 : k;
  return (v > 0 ? '+' : '') + v.toFixed(1) + '°';
}

const BFT = [1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118];
export const beaufort = (kmh) => { let b = 0; while (b < BFT.length && kmh >= BFT[b]) b++; return b; };

export function windVal(kmh) {
  if (!isNum(kmh)) return null;
  switch (settings.wind) {
    case 'ms': return kmh / 3.6;
    case 'kn': return kmh / 1.852;
    case 'mph': return kmh / 1.609344;
    case 'bft': return beaufort(kmh);
    default: return kmh;
  }
}
export function wind(kmh, withUnit = false) {
  const v = windVal(kmh);
  if (v === null) return dash;
  const r = settings.wind === 'ms' && v < 10 ? v.toFixed(1) : Math.round(v);
  return withUnit ? `${r} ${windUnit()}` : String(r);
}
export const windUnit = () => ({ kmh: 'km/h', ms: 'm/s', kn: 'kt', mph: 'mph', bft: 'Bft' }[settings.wind]);

export function precipVal(mm) {
  if (!isNum(mm)) return null;
  return settings.precip === 'in' ? mm / 25.4 : mm;
}
export function precip(mm, withUnit = false, hideZero = false) {
  const v = precipVal(mm);
  if (v === null) return dash;
  if (hideZero && v < (settings.precip === 'in' ? 0.004 : 0.1)) return '';
  const r = (settings.precip === 'in' ? v.toFixed(2) : v < 10 ? v.toFixed(1) : String(Math.round(v))).replace('.', ',');
  return withUnit ? `${r} ${precipUnit()}` : String(r);
}
export const precipUnit = () => (settings.precip === 'in' ? 'in' : 'mm');

export function snow(cm, withUnit = true) {
  if (!isNum(cm)) return dash;
  if (settings.precip === 'in') return (cm / 2.54).toFixed(1) + (withUnit ? ' in' : '');
  return (cm < 10 ? cm.toFixed(1) : Math.round(cm)) + (withUnit ? ' cm' : '');
}

export function pressureVal(hpa) {
  if (!isNum(hpa)) return null;
  if (settings.pressure === 'inhg') return hpa * 0.02953;
  if (settings.pressure === 'mmhg') return hpa * 0.750062;
  return hpa;
}
export function pressure(hpa, withUnit = false) {
  const v = pressureVal(hpa);
  if (v === null) return dash;
  const r = settings.pressure === 'inhg' ? v.toFixed(2) : Math.round(v);
  return withUnit ? `${r} ${pressureUnit()}` : String(r);
}
export const pressureUnit = () => ({ hpa: 'hPa', inhg: 'inHg', mmhg: 'mmHg' }[settings.pressure]);

export function distance(m) {
  if (!isNum(m)) return dash;
  if (settings.distance === 'mi') {
    const mi = m / 1609.344;
    return mi < 10 ? mi.toFixed(1) + ' mi' : Math.round(mi) + ' mi';
  }
  return m < 1000 ? Math.round(m) + ' m' : m < 10000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m / 1000) + ' km';
}
export function height(m) {
  if (!isNum(m)) return dash;
  if (settings.distance === 'mi') return Math.round(m * 3.28084) + ' ft';
  return Math.round(m) + ' m';
}
export function waveHeight(m) {
  if (!isNum(m)) return dash;
  if (settings.distance === 'mi') return (m * 3.28084).toFixed(1) + ' ft';
  return m.toFixed(1) + ' m';
}
export const pct = (v) => (isNum(v) ? Math.round(v) + '%' : dash);
export const fixed = (v, d = 0) => (isNum(v) ? v.toFixed(d) : dash);

export function duration(sec) {
  if (!isNum(sec)) return dash;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return `${h} h ${String(m).padStart(2, '0')} min`;
}
export const hoursFromSec = (sec) => (isNum(sec) ? (sec / 3600).toFixed(1) + ' h' : dash);

// ---------- Viento ----------
const DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
export const dirName = (deg) => (isNum(deg) ? DIRS[Math.round(deg / 22.5) % 16] : dash);
// Flecha que apunta hacia donde sopla el viento (la API da de dónde viene)
export function arrow(deg, cls = 'arrow') {
  if (!isNum(deg)) return '';
  return `<span class="${cls}" title="${dirName(deg)} (${Math.round(deg)}°)"><svg viewBox="0 0 24 24" style="transform:rotate(${(deg + 180) % 360}deg)"><path d="M12 2l6 18-6-4-6 4z"/></svg></span>`;
}

const BFT_NAMES = ['Calma', 'Ventolina', 'Brisa muy débil', 'Brisa débil', 'Brisa moderada', 'Brisa fresca', 'Brisa fuerte',
  'Viento fuerte', 'Temporal', 'Temporal fuerte', 'Temporal duro', 'Temporal muy duro', 'Huracán'];
export const beaufortName = (kmh) => (isNum(kmh) ? BFT_NAMES[beaufort(kmh)] : dash);

// ---------- Fechas ----------
export function parts(s) {
  const [d, t = '00:00'] = s.split('T');
  const [Y, M, D] = d.split('-').map(Number);
  const [h, m] = t.split(':').map(Number);
  return { Y, M, D, h, m, wd: new Date(Date.UTC(Y, M - 1, D)).getUTCDay() };
}
export const hh = (s) => s.slice(11, 13);
export const hhmm = (s) => (s ? s.slice(11, 16) : dash);
export function dayShort(s) { const p = parts(s); return `${DIAS_C[p.wd]} ${p.D}`; }
export function dayName(s, today) {
  const d = s.slice(0, 10);
  if (today) {
    if (d === today) return 'Hoy';
    if (d === addDays(today, 1)) return 'Mañana';
    if (d === addDays(today, -1)) return 'Ayer';
  }
  const p = parts(s);
  return DIAS[p.wd][0].toUpperCase() + DIAS[p.wd].slice(1);
}
export function dayLong(s) { const p = parts(s); return `${DIAS[p.wd]}, ${p.D} de ${MESES[p.M - 1]}`; }
export function dateShort(s) { const p = parts(s); return `${p.D} ${MESES_C[p.M - 1]}`; }
export function monthName(s, short = false) { const p = parts(s); return (short ? MESES_C : MESES)[p.M - 1]; }
export function addDays(ymd, n) {
  const [Y, M, D] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(Y, M - 1, D + n));
  return dt.toISOString().slice(0, 10);
}
export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// Fecha local del lugar a partir del desfase horario devuelto por la API
export function placeNow(utcOffsetSec) {
  const d = new Date(Date.now() + utcOffsetSec * 1000);
  return d.toISOString().slice(0, 16);
}
export function relTime(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'ahora mismo';
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  return `hace ${h} h`;
}
export function localTimeFromUnix(sec) {
  const d = new Date(sec * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function flag(cc) {
  if (!cc || cc.length !== 2) return '📍';
  return String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0)));
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
