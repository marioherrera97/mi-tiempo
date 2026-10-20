// Avisos personalizados y previsión de atardeceres. Script clásico (no módulo) para poder usarlo
// tanto en la página como en el service worker (importScripts), que comprueba los avisos en segundo plano.
(function (g) {
  const OM = 'https://api.open-meteo.com/v1/forecast';
  const STORE = 'mitiempo-avisos';
  const KEY = './__avisos.json';
  const rad = Math.PI / 180;

  // ---------- Atardeceres ----------
  // Acimut del sol al ponerse (grados desde el norte): ~240° en invierno, ~300° en verano en España
  function sunsetAzimuth(lat, ymd) {
    const d = new Date(ymd + 'T12:00:00Z');
    const doy = Math.round((d - Date.UTC(d.getUTCFullYear(), 0, 0)) / 864e5);
    const dec = -23.44 * Math.cos((2 * Math.PI / 365) * (doy + 10));
    const c = Math.sin(dec * rad) / Math.cos(lat * rad);
    return 360 - Math.acos(Math.max(-1, Math.min(1, c))) / rad;
  }
  // Punto a `km` en la dirección `az`
  function offset(lat, lon, az, km) {
    const dLat = (km / 111.2) * Math.cos(az * rad);
    const dLon = (km / (111.2 * Math.cos(lat * rad))) * Math.sin(az * rad);
    return [+(lat + dLat).toFixed(3), +(lon + dLon).toFixed(3)];
  }
  // Puntos que se piden: el lugar y dos hacia donde se pone el sol (60 y 160 km), para ver si el horizonte está despejado
  function sunsetPoints(lat, lon) {
    const az = sunsetAzimuth(lat, new Date().toISOString().slice(0, 10));
    return [[lat, lon], offset(lat, lon, az, 60), offset(lat, lon, az, 160)];
  }
  // Nota de 0 a 10. Un atardecer espectacular necesita nubes medias o altas sobre el lugar (el «lienzo» que se tiñe),
  // pocas nubes bajas encima (taparían el cielo) y el horizonte del oeste despejado de nubes bajas (dejan pasar la luz).
  function sunsetScore(low, mid, high, lowW, midW, lowFar, rain) {
    const canvas = Math.max(mid, high * 0.9);
    let c;
    if (canvas < 8) c = 0.25;            // cielo limpio: bonito, pero sin colores en las nubes
    else if (canvas < 20) c = 0.25 + ((canvas - 8) / 12) * 0.65;
    else if (canvas <= 70) c = 0.9 + Math.min(0.1, (canvas - 20) / 300);
    else c = Math.max(0.3, 1 - ((canvas - 70) / 30) * 0.65); // muy cubierto: no queda hueco para la luz
    const local = Math.pow(1 - Math.min(100, low) / 100, 1.6);
    const horizon = (1 - Math.min(100, Math.max(lowW, lowFar * 0.8)) / 100) * (1 - Math.max(0, midW - 75) / 25 * 0.5);
    const wet = rain >= 1 ? 0.45 : rain >= 0.2 ? 0.8 : 1;
    return Math.round(10 * c * local * Math.pow(horizon, 0.8) * wet * 10) / 10;
  }
  const sunsetLabel = (s) => (s >= 7.5 ? 'Épico' : s >= 5.5 ? 'Muy bonito' : s >= 3.5 ? 'Bonito' : s >= 2 ? 'Normal' : 'Gris');
  // Atardeceres de los próximos días a partir de la respuesta multipunto de Open-Meteo
  function sunsets(resp) {
    const [a, w1, w2] = Array.isArray(resp) ? resp : [resp];
    const out = [];
    const h = a.hourly;
    const nowLocal = new Date(Date.now() + (a.utc_offset_seconds || 0) * 1000).toISOString().slice(0, 16);
    (a.daily?.sunset || []).forEach((ss, di) => {
      if (!ss) return;
      const key = ss.slice(0, 13);
      // La hora que contiene la puesta y la anterior (las nubes de la hora previa también cuentan)
      let i = h.time.findIndex((t) => t.slice(0, 13) === key);
      if (i < 0) return;
      const at = (arr, k) => {
        const v = [arr?.[k], arr?.[k - 1]].filter((x) => typeof x === 'number');
        return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0;
      };
      const low = at(h.cloud_cover_low, i), mid = at(h.cloud_cover_mid, i), high = at(h.cloud_cover_high, i);
      const lowW = w1 ? at(w1.hourly.cloud_cover_low, i) : low, midW = w1 ? at(w1.hourly.cloud_cover_mid, i) : mid;
      const lowFar = w2 ? at(w2.hourly.cloud_cover_low, i) : lowW;
      const rain = (h.precipitation?.[i] || 0) + (h.precipitation?.[i - 1] || 0);
      const score = sunsetScore(low, mid, high, lowW, midW, lowFar, rain);
      out.push({ day: a.daily.time[di], time: ss, past: ss < nowLocal, score, label: sunsetLabel(score), low, mid, high, lowW, lowFar, rain });
    });
    return out;
  }
  function sunsetURL(lat, lon) {
    const pts = sunsetPoints(lat, lon);
    return `${OM}?latitude=${pts.map((p) => p[0]).join(',')}&longitude=${pts.map((p) => p[1]).join(',')}`
      + '&hourly=cloud_cover_low,cloud_cover_mid,cloud_cover_high,precipitation&daily=sunset&timezone=auto&forecast_days=4';
  }

  // ---------- Avisos ----------
  // tipo: [nombre, unidad, umbral por defecto, texto de la condición]
  const TYPES = {
    lluvia: ['Lluvia fuerte', 'mm', 10, (v) => `más de ${v} mm en un día`],
    helada: ['Helada', '°C', 0, (v) => `mínima por debajo de ${v} °C`],
    viento: ['Viento fuerte', 'km/h', 60, (v) => `rachas de más de ${v} km/h`],
    calor: ['Calor', '°C', 35, (v) => `máxima de más de ${v} °C`],
    nieve: ['Nieve', 'cm', 1, (v) => `más de ${v} cm de nieve`],
    tormenta: ['Tormenta', '', null, () => 'tormenta prevista'],
    atardecer: ['Atardecer épico', '/10', 7, (v) => `atardecer de ${v}/10 o más`],
  };
  const fmt = (v, d = 0) => (Math.round(v * 10 ** d) / 10 ** d).toLocaleString('es-ES');
  const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  function dayWord(ymd, today) {
    if (ymd === today) return 'hoy';
    const t = new Date(today + 'T12:00:00Z');
    t.setUTCDate(t.getUTCDate() + 1);
    if (ymd === t.toISOString().slice(0, 10)) return 'mañana';
    return 'el ' + DIAS[new Date(ymd + 'T12:00:00Z').getUTCDay()];
  }

  function placeURL(p, days) {
    return `${OM}?latitude=${(+p.lat).toFixed(4)}&longitude=${(+p.lon).toFixed(4)}&timezone=auto&forecast_days=${days}`
      + '&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,snowfall_sum,wind_gusts_10m_max,weather_code';
  }

  // Comprueba los avisos: devuelve los que se cumplen [{ alert, key, day, title, body }]
  async function evaluate(alerts, fetcher = (u) => fetch(u).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))) {
    const hits = [];
    const byPlace = new Map();
    for (const a of alerts.filter((x) => x.on !== false)) {
      const k = `${(+a.place.lat).toFixed(3)},${(+a.place.lon).toFixed(3)}`;
      if (!byPlace.has(k)) byPlace.set(k, []);
      byPlace.get(k).push(a);
    }
    for (const list of byPlace.values()) {
      const p = list[0].place;
      const days = Math.max(...list.map((a) => a.days || 2));
      let d = null, ss = null;
      try { d = await fetcher(placeURL(p, Math.min(7, days + 1))); } catch { continue; }
      if (list.some((a) => a.type === 'atardecer')) {
        try { ss = sunsets(await fetcher(sunsetURL(p.lat, p.lon))); } catch { ss = null; }
      }
      const dd = d.daily;
      const today = dd.time[0];
      for (const a of list) {
        const n = Math.min(dd.time.length, a.days || 2);
        const [name, unit] = TYPES[a.type] || [];
        if (!name) continue;
        for (let i = 0; i < n; i++) {
          const day = dd.time[i];
          let v = null, ok = false, body = '';
          if (a.type === 'lluvia') { v = dd.precipitation_sum[i]; ok = v > a.value; body = `${fmt(v, 1)} mm previstos`; }
          else if (a.type === 'helada') { v = dd.temperature_2m_min[i]; ok = v < a.value; body = `mínima de ${fmt(v)} °C`; }
          else if (a.type === 'viento') { v = dd.wind_gusts_10m_max[i]; ok = v > a.value; body = `rachas de ${fmt(v)} km/h`; }
          else if (a.type === 'calor') { v = dd.temperature_2m_max[i]; ok = v > a.value; body = `máxima de ${fmt(v)} °C`; }
          else if (a.type === 'nieve') { v = dd.snowfall_sum[i]; ok = v >= a.value; body = `${fmt(v, 1)} cm de nieve`; }
          else if (a.type === 'tormenta') { v = dd.weather_code[i]; ok = v >= 95; body = 'posibles tormentas'; }
          else if (a.type === 'atardecer') {
            const s = ss?.find((x) => x.day === day);
            if (!s || s.past) continue;
            v = s.score; ok = v >= a.value; body = `atardecer ${s.label.toLowerCase()} (${fmt(v, 1)}/10) a las ${s.time.slice(11, 16)}`;
          }
          if (ok && typeof v === 'number') {
            hits.push({ alert: a, key: `${a.id}:${day}`, day, value: v, unit,
              title: `${name} ${dayWord(day, today)} en ${p.name}`, body: body.charAt(0).toUpperCase() + body.slice(1) });
          }
        }
      }
    }
    return hits;
  }

  // Avisos y registro de los ya notificados, guardados en Cache API (el service worker no puede leer localStorage)
  async function readStore() {
    try {
      const r = await (await caches.open(STORE)).match(KEY);
      return r ? await r.json() : { alerts: [], sent: {} };
    } catch { return { alerts: [], sent: {} }; }
  }
  async function writeStore(s) {
    try { await (await caches.open(STORE)).put(KEY, new Response(JSON.stringify(s), { headers: { 'content-type': 'application/json' } })); } catch { /* sin Cache API */ }
  }

  // Comprueba y notifica lo que no se haya notificado ya. `reg` es el registro del service worker.
  // `fetcher`: en la página se pasa el de js/api.js, que lleva la cuenta de la cuota de Open-Meteo
  async function run(reg, { notify = true, fetcher } = {}) {
    const s = await readStore();
    s.sent ||= {};
    if (!s.alerts?.length) return [];
    const hits = await evaluate(s.alerts, fetcher);
    const now = Date.now();
    for (const [k, t] of Object.entries(s.sent)) if (now - t > 4 * 864e5) delete s.sent[k];
    for (const h of hits) {
      if (s.sent[h.key]) continue;
      if (notify && reg && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try {
          await reg.showNotification(h.title, { body: h.body, tag: h.key, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { url: './#/avisos' } });
          s.sent[h.key] = now;
        } catch { /* sin permiso */ }
      }
    }
    s.checked = now;
    s.last = hits.map(({ key, title, body }) => ({ key, title, body }));
    await writeStore(s);
    return hits;
  }

  g.MTAlerts = { TYPES, evaluate, run, readStore, writeStore, sunsets, sunsetURL, sunsetAzimuth, sunsetScore, sunsetLabel };
})(typeof self !== 'undefined' ? self : globalThis);
