// Pequeñas utilidades de interfaz
import { esc } from './format.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function html(el, s) { el.innerHTML = s; return el; }

export function loading(el, msg = 'Cargando datos…') {
  el.innerHTML = `<div class="loading"><div class="spinner"></div>${esc(msg)}</div>`;
}

export function errorBox(el, err, retry) {
  el.innerHTML = `<div class="error"><b>No se pudieron cargar los datos.</b><br><span class="small">${esc(err?.message || err)}</span>
    ${retry ? '<div style="margin-top:10px"><button class="btn ghost" data-retry>Reintentar</button></div>' : ''}</div>`;
  if (retry) el.querySelector('[data-retry]').onclick = retry;
}

let toastTimer;
export function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

export function openSheet(id) {
  const s = document.getElementById(id);
  s.hidden = false;
  document.body.style.overflow = 'hidden';
}
export function closeSheet(id) {
  const s = document.getElementById(id);
  s.hidden = true;
  document.body.style.overflow = '';
}
export function initSheets() {
  $$('.sheet-backdrop').forEach((b) => {
    b.addEventListener('click', (e) => {
      if (e.target === b || e.target.closest('[data-close]')) closeSheet(b.id);
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $$('.sheet-backdrop').forEach((b) => { if (!b.hidden) closeSheet(b.id); });
  });
}

// Grupo de botones segmentados: options = [[valor, etiqueta], ...]
export function segmented(options, value, onChange, cls = 'seg', btnCls = '') {
  const wrap = document.createElement('div');
  wrap.className = cls;
  for (const [v, label] of options) {
    const b = document.createElement('button');
    b.type = 'button';
    if (btnCls) b.className = btnCls;
    b.textContent = label;
    b.dataset.v = v;
    if (String(v) === String(value)) b.classList.add('on');
    b.onclick = () => {
      wrap.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      onChange(v);
    };
    wrap.appendChild(b);
  }
  return wrap;
}

export function chips(options, value, onChange) {
  return segmented(options, value, onChange, 'chips', 'chip');
}

export function selectEl(options, value, onChange) {
  const s = document.createElement('select');
  s.className = 'sel';
  for (const [v, label] of options) {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    if (String(v) === String(value)) o.selected = true;
    s.appendChild(o);
  }
  s.onchange = () => onChange(s.value);
  return s;
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
