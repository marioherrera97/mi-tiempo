// Respaldo del pronóstico con MET Noruega (api.met.no, gratuito, sin clave ni límite diario).
// Se usa cuando Open-Meteo no responde o se agota su cuota. La respuesta se convierte al mismo
// formato que Open-Meteo para que todas las pantallas funcionen igual.
import { HOURLY_VARS, DAILY_VARS, getJSON } from './api.js';

// Símbolos de MET Noruega -> códigos WMO que usa la app
function symbolToWmo(sym) {
  if (!sym) return null;
  const s = sym.replace(/_(day|night|polartwilight)$/, '');
  if (s.includes('thunder')) return s.includes('snow') || s.includes('sleet') ? 96 : 95;
  const table = {
    clearsky: 0, fair: 1, partlycloudy: 2, cloudy: 3, fog: 45,
    lightrain: 61, rain: 63, heavyrain: 65,
    lightrainshowers: 80, rainshowers: 81, heavyrainshowers: 82,
    lightsleet: 66, sleet: 66, heavysleet: 67, lightsleetshowers: 66, sleetshowers: 66, heavysleetshowers: 67,
    lightsnow: 71, snow: 73, heavysnow: 75, lightsnowshowers: 85, snowshowers: 85, heavysnowshowers: 86,
  };
  return table[s] ?? 3;
}
const SEVERITY = (c) => (c >= 95 ? 9 : [75, 86, 65, 82, 67].includes(c) ? 8 : [73, 85, 63, 81, 66].includes(c) ? 7 : [71, 61, 80].includes(c) ? 6 : c === 45 ? 4 : c === 3 ? 3 : c === 2 ? 2 : c === 1 ? 1 : 0);

// Amanecer y atardecer (ecuación del ortocaso) en milisegundos UTC
function sunTimes(lat, lon, dayUtcMs) {
  const rad = Math.PI / 180;
  const jd = dayUtcMs / 864e5 + 2440587.5 + 0.5; // mediodía UTC de ese día
  const n = Math.ceil(jd - 2451545.0 + 0.0008);
  const jStar = n - lon / 360;
  const M = (357.5291 + 0.98560028 * jStar) % 360;
  const C = 1.9148 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 0.0003 * Math.sin(3 * M * rad);
  const lambda = (M + C + 180 + 102.9372) % 360;
  const jTransit = 2451545 + jStar + 0.0053 * Math.sin(M * rad) - 0.0069 * Math.sin(2 * lambda * rad);
  const decl = Math.asin(Math.sin(lambda * rad) * Math.sin(23.4397 * rad));
  const cosW = (Math.sin(-0.833 * rad) - Math.sin(lat * rad) * Math.sin(decl)) / (Math.cos(lat * rad) * Math.cos(decl));
  if (cosW > 1 || cosW < -1) return [null, null]; // noche o día polar
  const w = Math.acos(cosW) / rad;
  const toMs = (j) => (j - 2440587.5) * 864e5;
  return [toMs(jTransit - w / 360), toMs(jTransit + w / 360)];
}

const lerp = (a, b, f) => (a == null || b == null ? (a ?? b) : a + (b - a) * f);
// Sensación térmica (fórmula australiana de temperatura aparente)
function apparent(t, rh, windMs) {
  if (t == null || rh == null) return t;
  const e = (rh / 100) * 6.105 * Math.exp((17.27 * t) / (237.7 + t));
  return t + 0.33 * e - 0.7 * (windMs || 0) - 4;
}

export async function metForecast(place) {
  const lat = place.lat.toFixed(4), lon = place.lon.toFixed(4);
  // Se guarda en el móvil como el resto de respuestas (MET actualiza cada hora aprox.)
  const json = await getJSON(`https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${lat}&lon=${lon}`, { ttl: 45 * 60e3 });
  const ts = json.properties.timeseries.map((e) => ({ ...e, ms: Date.parse(e.time) }));
  const off = -new Date().getTimezoneOffset() * 60; // MET no da la zona horaria: se usa la del dispositivo
  const local = (ms) => new Date(ms + off * 1000).toISOString().slice(0, 16);

  // Rejilla horaria: MET da horas sueltas hasta ~60 h y luego cada 6 h; se interpola a cada hora
  const hourly = Object.fromEntries(['time', ...HOURLY_VARS].map((k) => [k, []]));
  const start = Math.ceil(ts[0].ms / 3600e3) * 3600e3, end = ts[ts.length - 1].ms;
  let k = 0;
  for (let ms = start; ms <= end; ms += 3600e3) {
    while (k < ts.length - 2 && ts[k + 1].ms <= ms) k++;
    const a = ts[k], b = ts[Math.min(k + 1, ts.length - 1)];
    const f = b.ms > a.ms ? (ms - a.ms) / (b.ms - a.ms) : 0;
    const A = a.data.instant.details, B = b.data.instant.details;
    const I = (key) => lerp(A[key], B[key], f);
    // Precipitación y símbolo del periodo que contiene esta hora
    const exact = ts.find((e) => e.ms === ms);
    let precip = null, prob = null, sym = null;
    if (exact?.data.next_1_hours) {
      precip = exact.data.next_1_hours.details?.precipitation_amount ?? null;
      prob = exact.data.next_1_hours.details?.probability_of_precipitation ?? null;
      sym = exact.data.next_1_hours.summary?.symbol_code;
    } else {
      const p6 = [...ts].reverse().find((e) => e.ms <= ms && e.data.next_6_hours && e.ms + 6 * 3600e3 > ms);
      if (p6) {
        precip = (p6.data.next_6_hours.details?.precipitation_amount ?? 0) / 6;
        prob = p6.data.next_6_hours.details?.probability_of_precipitation ?? null;
        sym = p6.data.next_6_hours.summary?.symbol_code;
      }
    }
    const t = I('air_temperature'), rh = I('relative_humidity'), wind = I('wind_speed');
    const cloud = I('cloud_area_fraction');
    const dirA = A.wind_from_direction, dirB = B.wind_from_direction;
    const dir = dirA == null ? dirB : dirB == null ? dirA : (dirA + ((((dirB - dirA) % 360) + 540) % 360 - 180) * f + 360) % 360;
    const [rise, set] = sunTimes(place.lat, place.lon, Math.floor(ms / 864e5) * 864e5);
    const isDay = sym ? (sym.endsWith('_night') ? 0 : sym.endsWith('_day') ? 1 : (rise && ms > rise && ms < set ? 1 : 0)) : (rise && ms > rise && ms < set ? 1 : 0);
    const uvClear = I('ultraviolet_index_clear_sky');
    const push = (key, v) => hourly[key].push(v ?? null);
    hourly.time.push(local(ms));
    push('temperature_2m', t);
    push('apparent_temperature', A.apparent_air_temperature != null ? I('apparent_air_temperature') : apparent(t, rh, wind));
    push('relative_humidity_2m', rh);
    push('dew_point_2m', I('dew_point_temperature'));
    push('precipitation_probability', prob);
    push('precipitation', precip);
    push('rain', precip);
    push('showers', 0);
    push('snowfall', sym && /snow|sleet/.test(sym) && precip ? precip * 0.7 : 0);
    push('snow_depth', null);
    push('weather_code', symbolToWmo(sym) ?? (cloud > 85 ? 3 : cloud > 40 ? 2 : cloud > 15 ? 1 : 0));
    push('cloud_cover', cloud);
    push('cloud_cover_low', I('cloud_area_fraction_low'));
    push('cloud_cover_mid', I('cloud_area_fraction_medium'));
    push('cloud_cover_high', I('cloud_area_fraction_high'));
    push('pressure_msl', I('air_pressure_at_sea_level'));
    push('visibility', I('fog_area_fraction') > 50 ? 800 : null);
    push('wind_speed_10m', wind != null ? wind * 3.6 : null);
    push('wind_direction_10m', dir);
    push('wind_gusts_10m', A.wind_speed_of_gust != null ? I('wind_speed_of_gust') * 3.6 : null);
    push('uv_index', uvClear != null ? uvClear * (1 - 0.6 * (cloud || 0) / 100) : null);
    push('is_day', isDay);
    push('cape', null);
    push('freezing_level_height', null);
    push('sunshine_duration', isDay ? Math.max(0, 1 - (cloud || 0) / 100) * 3600 : 0);
  }

  // Resumen diario a partir de las horas (en hora local)
  const daily = Object.fromEntries(['time', ...DAILY_VARS].map((key) => [key, []]));
  const days = [...new Set(hourly.time.map((t) => t.slice(0, 10)))];
  for (const day of days) {
    const idx = hourly.time.map((t, i) => (t.startsWith(day) ? i : -1)).filter((i) => i >= 0);
    if (idx.length < 6 && day !== days[0]) continue; // día incompleto al final (hoy siempre se incluye)
    const col = (key) => idx.map((i) => hourly[key][i]).filter((v) => v != null);
    const max = (key) => (col(key).length ? Math.max(...col(key)) : null);
    const min = (key) => (col(key).length ? Math.min(...col(key)) : null);
    const sum = (key) => col(key).reduce((a, b) => a + b, 0);
    const codes = col('weather_code');
    const [rise, set] = sunTimes(place.lat, place.lon, Date.parse(day + 'T00:00:00Z'));
    let ux = 0, uy = 0;
    for (const i of idx) {
      const d = hourly.wind_direction_10m[i], s = hourly.wind_speed_10m[i];
      if (d != null && s != null) { ux += s * Math.sin(d * Math.PI / 180); uy += s * Math.cos(d * Math.PI / 180); }
    }
    daily.time.push(day);
    daily.weather_code.push(codes.length ? codes.reduce((a, b) => (SEVERITY(b) > SEVERITY(a) ? b : a)) : null);
    daily.temperature_2m_max.push(max('temperature_2m'));
    daily.temperature_2m_min.push(min('temperature_2m'));
    daily.apparent_temperature_max.push(max('apparent_temperature'));
    daily.apparent_temperature_min.push(min('apparent_temperature'));
    daily.sunrise.push(rise ? local(rise) : day + 'T00:00');
    daily.sunset.push(set ? local(set) : day + 'T23:59');
    daily.daylight_duration.push(rise ? (set - rise) / 1000 : null);
    daily.sunshine_duration.push(sum('sunshine_duration'));
    daily.uv_index_max.push(max('uv_index'));
    daily.precipitation_sum.push(sum('precipitation'));
    daily.rain_sum.push(sum('rain'));
    daily.snowfall_sum.push(sum('snowfall'));
    daily.precipitation_hours.push(col('precipitation').filter((v) => v >= 0.1).length);
    daily.precipitation_probability_max.push(max('precipitation_probability'));
    daily.wind_speed_10m_max.push(max('wind_speed_10m'));
    daily.wind_gusts_10m_max.push(max('wind_gusts_10m'));
    daily.wind_direction_10m_dominant.push(ux || uy ? (Math.atan2(ux, uy) * 180 / Math.PI + 360) % 360 : null);
  }

  const h = hourly;
  const nowKey = local(Date.now()).slice(0, 13);
  const ci = Math.max(0, h.time.findIndex((t) => t.slice(0, 13) === nowKey));
  const current = {
    time: h.time[ci], temperature_2m: h.temperature_2m[ci], apparent_temperature: h.apparent_temperature[ci],
    relative_humidity_2m: h.relative_humidity_2m[ci], is_day: h.is_day[ci], precipitation: h.precipitation[ci],
    weather_code: h.weather_code[ci], cloud_cover: h.cloud_cover[ci], pressure_msl: h.pressure_msl[ci],
    wind_speed_10m: h.wind_speed_10m[ci], wind_direction_10m: h.wind_direction_10m[ci], wind_gusts_10m: h.wind_gusts_10m[ci],
  };
  return {
    source: 'met', latitude: place.lat, longitude: place.lon,
    elevation: json.geometry?.coordinates?.[2] ?? null, utc_offset_seconds: off,
    current, hourly, daily,
  };
}
