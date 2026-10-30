// Filas de nivel (embalses, cuencas, ríos y fichas del mapa): nombre y datos a la izquierda, la cifra a la derecha,
// una barra opcional y un pie en columnas con etiquetas pequeñas
export const kmText = (km) => `${km < 10 ? km.toFixed(1).replace('.', ',') : Math.round(km)} km`;
export const cell = (k, v) => `<span class="rv-fi"><em>${k}</em><span>${v}</span></span>`;
export const statusDot = (color) => `<i class="rv-sdot" style="background:${color}"></i>`;
// «12,4 m³/s» -> cifra grande y unidad pequeña
export const figUnit = (text) => text.replace(/\s(\S+)$/, '<small>$1</small>');

export function levelRow({ name, meta = [], fig, sub = '', bar = '', foot = [] }) {
  const ft = foot.filter(Boolean);
  return `<div class="rv-head">
      <div class="rv-id"><span class="rv-name">${name}</span><span class="rv-meta">${meta.filter(Boolean).join(' · ')}</span></div>
      <div class="rv-fig"><span class="rv-fig-p">${fig}</span>${sub ? `<span class="rv-vol">${sub}</span>` : ''}</div>
    </div>
    ${bar}
    ${ft.length ? `<div class="rv-foot">${ft.join('')}</div>` : ''}`;
}
