// Vista "Ajustes": unidades, modelo, tema y gestión de datos guardados
import { settings, saveSettings, DEFAULT_SETTINGS } from '../state.js';
import { MODELS } from '../api.js';
import { segmented, selectEl, toast } from '../ui.js';

function applyTheme() {
  if (settings.theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = settings.theme;
}
applyTheme();

const ROWS = [
  ['temp', 'Temperatura', [['c', '°C'], ['f', '°F']]],
  ['wind', 'Viento', [['kmh', 'km/h'], ['ms', 'm/s'], ['kn', 'nudos'], ['mph', 'mph'], ['bft', 'Beaufort']]],
  ['precip', 'Precipitación', [['mm', 'mm'], ['in', 'pulgadas']]],
  ['pressure', 'Presión', [['hpa', 'hPa'], ['mmhg', 'mmHg'], ['inhg', 'inHg']]],
  ['distance', 'Distancia', [['km', 'km / m'], ['mi', 'millas / pies']]],
  ['theme', 'Tema', [['auto', 'Automático'], ['dark', 'Oscuro'], ['light', 'Claro']]],
];

export default {
  render(el) {
    el.innerHTML = `<div class="card" id="setUnits"><div class="card-head"><h2>Unidades y aspecto</h2></div></div>
      <div class="card"><div class="card-head"><h2>Modelo meteorológico por defecto</h2></div><div id="setModel"></div>
        <p class="note" style="margin:8px 0 0">"Automático" combina el modelo de más resolución disponible para tu zona con modelos globales para los días lejanos.</p></div>
      <div class="card"><div class="card-head"><h2>Datos</h2></div>
        <div class="toolbar"><button class="btn ghost" id="clearCache">Borrar caché sin conexión</button><button class="btn ghost" id="resetSet">Restablecer ajustes</button></div>
        <p class="note">Favoritos, ajustes y normales climáticas se guardan solo en este dispositivo. No hay cuentas ni servidores propios.</p></div>
      <div class="card"><div class="card-head"><h2>Instalar en el móvil</h2></div>
        <p class="note"><b>Android (Chrome):</b> menú ⋮ → "Instalar aplicación" o "Añadir a pantalla de inicio".<br>
        <b>iPhone (Safari):</b> botón compartir → "Añadir a pantalla de inicio".<br>
        Necesita estar publicada con HTTPS (por ejemplo en GitHub Pages). Consulta el README.</p></div>`;
    const box = el.querySelector('#setUnits');
    for (const [key, label, opts] of ROWS) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:8px 0;border-top:1px solid var(--line)';
      row.innerHTML = `<span>${label}</span>`;
      row.append(segmented(opts, settings[key], (v) => {
        settings[key] = v;
        if (key === 'theme') applyTheme();
        saveSettings();
      }));
      box.append(row);
    }
    el.querySelector('#setModel').append(selectEl(MODELS.map((m) => [m.id, m.name]), settings.model, (v) => { settings.model = v; saveSettings(); toast('Modelo cambiado'); }));
    el.querySelector('#clearCache').onclick = async () => {
      if ('caches' in window) for (const k of await caches.keys()) if (!k.startsWith('shell')) await caches.delete(k);
      toast('Caché borrada');
    };
    el.querySelector('#resetSet').onclick = () => { Object.assign(settings, DEFAULT_SETTINGS); applyTheme(); saveSettings(); toast('Ajustes restablecidos'); };
  },
};
