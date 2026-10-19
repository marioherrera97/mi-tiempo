// Vista "Mis avisos": avisos personalizados (lluvia, helada, viento, calor, nieve, tormenta, atardecer épico)
// que se comprueban al abrir la app y, donde el navegador lo permite, en segundo plano con el service worker.
import { state } from '../state.js';
import * as f from '../format.js';
import { toast, selectEl } from '../ui.js';

const A = () => globalThis.MTAlerts;
const ICON = { lluvia: '🌧️', helada: '❄️', viento: '💨', calor: '🌡️', nieve: '🌨️', tormenta: '⛈️', atardecer: '🌅' };
const DAYS = [[1, 'Hoy'], [2, 'Hoy y mañana'], [3, 'Próximos 3 días'], [5, 'Próximos 5 días']];

const canNotify = () => 'Notification' in window && 'serviceWorker' in navigator;
const reg = () => (navigator.serviceWorker ? navigator.serviceWorker.getRegistration() : Promise.resolve(null));

// Comprobación en segundo plano (solo Chrome/Edge en Android con la app instalada)
async function registerPeriodic() {
  try {
    const r = await navigator.serviceWorker.ready;
    if (!('periodicSync' in r)) return 'no';
    const st = await navigator.permissions.query({ name: 'periodic-background-sync' });
    if (st.state !== 'granted') return 'denied';
    await r.periodicSync.register('mitiempo-avisos', { minInterval: 3 * 3600e3 });
    return 'ok';
  } catch { return 'no'; }
}

// Al abrir la app (y al volver a ella) se comprueban los avisos, como mucho cada 30 minutos
export async function checkAlerts(force = false) {
  if (!A()) return [];
  const s = await A().readStore();
  if (!s.alerts?.length) return [];
  if (!force && s.checked && Date.now() - s.checked < 30 * 60e3) return null;
  const hits = await A().run(await reg());
  // Sin permiso de notificaciones se avisa dentro de la app
  if (hits.length && (!canNotify() || Notification.permission !== 'granted') && !force) toast(`🔔 ${hits[0].title}${hits.length > 1 ? ` y ${hits.length - 1} más` : ''}`, 5000);
  return hits;
}
export function initAlerts() {
  if (!A()) return;
  setTimeout(() => checkAlerts().catch(() => {}), 4000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkAlerts().catch(() => {}); });
  if (canNotify() && Notification.permission === 'granted') registerPeriodic();
}

function alertText(a) {
  const [name, , , cond] = A().TYPES[a.type];
  return { name, cond: cond(a.value), when: (DAYS.find(([d]) => d === a.days) || DAYS[1])[1].toLowerCase() };
}

async function render(el, preset) {
  const s = await A().readStore();
  const alerts = s.alerts || [];
  const perm = canNotify() ? Notification.permission : 'unsupported';
  const places = [state.place, ...state.favorites.filter((p) => Math.abs(p.lat - state.place.lat) > 0.01 || Math.abs(p.lon - state.place.lon) > 0.01)];
  const bg = 'periodicSync' in (await navigator.serviceWorker?.getRegistration().catch(() => null) || {}) ? 'sí' : 'no';
  el.innerHTML = `
    <div class="card">
      <div class="card-head"><h2>Mis avisos</h2><span class="tiny">${alerts.length || 'ninguno'}</span></div>
      ${alerts.length ? `<div class="al-list">${alerts.map((a) => {
        const t = alertText(a);
        return `<div class="al-row${a.on === false ? ' off' : ''}" data-id="${a.id}">
          <span class="al-ico">${ICON[a.type]}</span>
          <span class="al-main"><b>${t.name} en ${f.esc(a.place.name)}</b><small>${t.cond} · ${t.when}</small></span>
          <label class="al-sw"><input type="checkbox" data-on ${a.on === false ? '' : 'checked'}><i></i></label>
          <button class="al-del" data-del aria-label="Borrar">✕</button>
        </div>`;
      }).join('')}</div>` : '<p class="note">Todavía no tienes avisos. Crea uno abajo: por ejemplo, «avísame si van a caer más de 10 mm» o «si va a helar esta noche».</p>'}
    </div>
    <div class="card">
      <div class="card-head"><h2>Nuevo aviso</h2></div>
      <div class="al-form">
        <label>Avisarme de<span id="alType"></span></label>
        <label id="alValWrap">Umbral<span class="al-val"><input type="number" id="alVal" inputmode="decimal" step="any"><em id="alUnit"></em></span></label>
        <label>En<span id="alPlace"></span></label>
        <label>Cuándo<span id="alDays"></span></label>
        <p class="tiny" id="alHint"></p>
        <button class="btn" id="alAdd">Añadir aviso</button>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h2>Notificaciones</h2></div>
      <div class="al-perm">
        ${perm === 'granted' ? '<span class="al-ok">✓ Activadas en este dispositivo</span>'
          : perm === 'denied' ? '<span class="al-bad">Bloqueadas: actívalas en los ajustes del navegador para esta web</span>'
            : perm === 'unsupported' ? '<span class="al-bad">Este navegador no admite notificaciones</span>'
              : '<button class="btn" id="alPerm">Activar notificaciones</button>'}
        <button class="btn ghost" id="alCheck">Comprobar ahora</button>
      </div>
      <div id="alHits">${(s.last || []).length ? `<div class="list-label">Se cumplen ahora</div>${s.last.map((h) => `<div class="al-hit">🔔 <b>${f.esc(h.title)}</b><small>${f.esc(h.body)}</small></div>`).join('')}` : ''}</div>
      <p class="tiny">${s.checked ? `Última comprobación ${f.relTime(s.checked)}` : 'Aún no se ha comprobado'} · Comprobación en segundo plano: ${bg}</p>
      <p class="note"><b>Cómo funciona:</b> la app no tiene servidor propio, así que no puede enviar avisos «push» desde fuera.
        Los avisos se comprueban <b>cada vez que abres la app</b> y, en <b>Chrome o Edge para Android con la app instalada</b>, también en segundo plano
        cada pocas horas (el sistema decide cuándo, según el uso y la batería). En iPhone hay que añadir la app a la pantalla de inicio (iOS 16.4 o posterior)
        para recibir notificaciones, pero Safari no permite comprobarlas en segundo plano: solo al abrirla. Cada aviso se notifica una vez por día.</p>
    </div>`;

  const type = selectEl(Object.entries(A().TYPES).map(([k, t]) => [k, `${ICON[k]} ${t[0]}`]), preset || 'lluvia', (v) => syncType(v));
  el.querySelector('#alType').append(type);
  const place = selectEl(places.map((p, i) => [i, p.name + (i === 0 ? ' (actual)' : '')]), 0, () => {});
  el.querySelector('#alPlace').append(place);
  const days = selectEl(DAYS, 2, () => {});
  el.querySelector('#alDays').append(days);
  const val = el.querySelector('#alVal');
  const HINT = {
    lluvia: 'Total del día según el pronóstico. 10 mm es una lluvia moderada; 30 mm, fuerte.',
    helada: '0 °C para heladas; −3 °C para heladas fuertes.',
    viento: 'Rachas máximas del día. 70 km/h ya puede romper ramas.',
    calor: 'Temperatura máxima del día.',
    nieve: 'Nieve acumulada en el día.',
    tormenta: 'Se avisa si el pronóstico da tormenta algún día.',
    atardecer: 'Nota de 0 a 10 del atardecer (7 = muy bonito o épico).',
  };
  function syncType(v) {
    const t = A().TYPES[v];
    el.querySelector('#alValWrap').hidden = t[2] === null;
    val.value = t[2] ?? '';
    el.querySelector('#alUnit').textContent = t[1];
    el.querySelector('#alHint').textContent = HINT[v];
    if (v === 'atardecer' || v === 'helada') days.value = '2';
  }
  syncType(type.value);

  el.querySelector('#alAdd').onclick = async () => {
    const t = type.value;
    const v = A().TYPES[t][2] === null ? null : parseFloat(String(val.value).replace(',', '.'));
    if (A().TYPES[t][2] !== null && !Number.isFinite(v)) { toast('Escribe un número'); return; }
    const p = places[+place.value];
    const cur = await A().readStore();
    cur.alerts = [...(cur.alerts || []), { id: Date.now().toString(36), type: t, value: v, days: +days.value, on: true,
      place: { name: p.name, lat: +p.lat.toFixed(4), lon: +p.lon.toFixed(4) } }];
    cur.checked = 0;
    await A().writeStore(cur);
    toast('Aviso creado');
    if (canNotify() && Notification.permission === 'default') await askPermission();
    await checkAlerts(true).catch(() => {});
    render(el);
  };
  el.querySelectorAll('.al-row').forEach((row) => {
    const id = row.dataset.id;
    row.querySelector('[data-del]').onclick = async () => {
      const cur = await A().readStore();
      cur.alerts = cur.alerts.filter((a) => a.id !== id);
      await A().writeStore(cur);
      render(el);
    };
    row.querySelector('[data-on]').onchange = async (e) => {
      const cur = await A().readStore();
      const a = cur.alerts.find((x) => x.id === id);
      if (a) a.on = e.target.checked;
      await A().writeStore(cur);
      row.classList.toggle('off', !e.target.checked);
    };
  });
  const pb = el.querySelector('#alPerm');
  if (pb) pb.onclick = async () => { await askPermission(); render(el); };
  el.querySelector('#alCheck').onclick = async (e) => {
    e.target.disabled = true;
    try {
      const hits = await checkAlerts(true);
      toast(hits?.length ? `Se cumplen ${hits.length} aviso${hits.length > 1 ? 's' : ''}` : 'Ningún aviso se cumple ahora');
    } catch { toast('No se pudo comprobar (¿sin conexión?)'); }
    render(el);
  };
}

async function askPermission() {
  try {
    const p = await Notification.requestPermission();
    if (p === 'granted') {
      const ok = await registerPeriodic();
      toast(ok === 'ok' ? 'Notificaciones activadas, también en segundo plano' : 'Notificaciones activadas');
    }
  } catch { /* el usuario cerró el diálogo */ }
}

export default {
  async render(el) {
    if (!A()) { el.innerHTML = '<div class="error">No se pudo cargar el módulo de avisos.</div>'; return; }
    const q = new URLSearchParams(location.hash.split('?')[1] || '');
    await render(el, q.get('nuevo'));
  },
  show(el) { this.render(el); },
};
