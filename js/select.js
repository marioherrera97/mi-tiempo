// Desplegables propios en lugar de los nativos (en Android salía el cuadro antiguo con círculos).
// Cada <select> se queda oculto en su sitio (su valor y su evento "change" siguen funcionando igual)
// y se muestra un botón; al tocarlo sale una hoja desde abajo en el móvil o un menú junto al botón en el ordenador.
const valueProp = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
const indexProp = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
const CHECK = '<svg viewBox="0 0 24 24"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>';
const CHEVRON = '<svg viewBox="0 0 24 24"><path d="M7.4 8.6 12 13.2l4.6-4.6L18 10l-6 6-6-6z"/></svg>';
const sheetMode = () => !matchMedia('(min-width: 900px)').matches;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let open = null; // { close }

function enhance(sel) {
  if (sel.dataset.native !== undefined || sel._xsel) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `xsel ${sel.className}`.trim();
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.innerHTML = `<span class="xsel-txt"></span>${CHEVRON}`;
  const sync = () => {
    const o = sel.options[sel.selectedIndex];
    btn.querySelector('.xsel-txt').textContent = o ? o.textContent : '';
    btn.disabled = sel.disabled;
  };
  sel._xsel = { btn, sync };
  // Si el código cambia el valor a mano, el botón se actualiza también
  Object.defineProperty(sel, 'value', { configurable: true, get() { return valueProp.get.call(this); }, set(v) { valueProp.set.call(this, v); sync(); } });
  Object.defineProperty(sel, 'selectedIndex', { configurable: true, get() { return indexProp.get.call(this); }, set(v) { indexProp.set.call(this, v); sync(); } });
  sel.addEventListener('change', sync);
  sel.classList.add('xsel-native');
  sel.tabIndex = -1;
  sel.setAttribute('aria-hidden', 'true');
  sel.after(btn);
  sync();
  btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openFor(sel, btn); });
  // Toda la etiqueta que lo rodea (icono y texto) también abre el desplegable: más fácil de acertar con el dedo
  sel.closest('label')?.addEventListener('click', (e) => { if (!btn.contains(e.target)) { e.preventDefault(); btn.click(); } });
}

// Título de la hoja: el texto de la etiqueta que acompaña al desplegable, si lo hay
function titleOf(sel) {
  const lab = sel.closest('label');
  const prev = sel.previousElementSibling;
  const t = sel.getAttribute('aria-label') || lab?.querySelector('span')?.textContent || lab?.textContent.replace(sel.textContent, '')
    || (prev && !prev.matches('select, button') && prev.textContent.length < 40 ? prev.textContent : '') || '';
  return t.trim().replace(/:$/, '');
}

function openFor(sel, btn) {
  open?.close(true);
  const sheet = sheetMode();
  const title = titleOf(sel);
  const opts = [...sel.options];
  const wrap = document.createElement('div');
  wrap.className = `xsel-layer ${sheet ? 'is-sheet' : 'is-menu'}`;
  wrap.innerHTML = `
    <div class="xsel-backdrop"></div>
    <div class="xsel-panel" role="listbox" aria-label="${esc(title)}">
      ${sheet ? `<div class="xsel-grip"></div>${title ? `<div class="xsel-title">${esc(title)}</div>` : ''}` : ''}
      <div class="xsel-list">${opts.map((o, i) => `<button type="button" role="option" class="xsel-opt${i === sel.selectedIndex ? ' on' : ''}" data-i="${i}" aria-selected="${i === sel.selectedIndex}" ${o.disabled ? 'disabled' : ''}><span>${esc(o.textContent)}</span>${CHECK}</button>`).join('')}</div>
    </div>`;
  document.body.appendChild(wrap);
  const panel = wrap.querySelector('.xsel-panel');
  if (!sheet) {
    // Menú pegado al botón; se abre hacia arriba si abajo no cabe
    const r = btn.getBoundingClientRect();
    const w = Math.max(r.width + 24, 180);
    const left = Math.min(Math.max(8, r.left - 12), innerWidth - w - 8);
    panel.style.left = left + 'px';
    panel.style.minWidth = w + 'px';
    const h = Math.min(panel.offsetHeight, innerHeight - 16);
    if (r.bottom + 6 + h > innerHeight - 8 && r.top - 6 - h > 8) {
      panel.style.top = (r.top - 6 - h) + 'px';
      panel.classList.add('up');
    } else panel.style.top = Math.min(r.bottom + 6, innerHeight - h - 8) + 'px';
  }
  btn.classList.add('open');
  requestAnimationFrame(() => wrap.classList.add('show'));
  const cur = panel.querySelector('.xsel-opt.on');
  cur?.scrollIntoView({ block: 'nearest' });
  (cur || panel.querySelector('.xsel-opt'))?.focus({ preventScroll: true });

  const close = (instant) => {
    if (open?.close !== close) return;
    open = null;
    btn.classList.remove('open');
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    if (instant) { wrap.remove(); return; }
    wrap.classList.remove('show');
    setTimeout(() => wrap.remove(), 220);
    btn.focus({ preventScroll: true });
  };
  const pick = (i) => {
    const changed = i !== sel.selectedIndex;
    sel.selectedIndex = i;
    panel.querySelectorAll('.xsel-opt').forEach((b, k) => { b.classList.toggle('on', k === i); b.setAttribute('aria-selected', k === i); });
    // Se ve la marca un instante y se cierra
    setTimeout(() => {
      close();
      if (changed) sel.dispatchEvent(new Event('change', { bubbles: true }));
    }, 90);
  };
  const onKey = (e) => {
    const items = [...panel.querySelectorAll('.xsel-opt:not([disabled])')];
    const k = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[Math.max(0, Math.min(items.length - 1, k + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
    } else if (e.key === 'Tab') close();
  };
  const onResize = () => close(true);
  wrap.querySelector('.xsel-backdrop').addEventListener('click', () => close());
  panel.addEventListener('click', (e) => {
    const b = e.target.closest('.xsel-opt');
    if (b && !b.disabled) pick(+b.dataset.i);
  });
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onResize);
  open = { close };
}

// Cualquier desplegable que aparezca (las vistas se redibujan a menudo) se convierte solo
export function initSelects(root = document.body) {
  root.querySelectorAll('select').forEach(enhance);
  new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (n.tagName === 'SELECT') enhance(n);
      else n.querySelectorAll?.('select').forEach(enhance);
    }
  }).observe(root, { childList: true, subtree: true });
}
