// Vista "Más": acceso al resto de secciones
const ITEMS = [
  ['modelos', 'Comparar modelos', 'ECMWF, GFS, ICON, AROME, UKMO, IA… en el mismo gráfico', '<path d="M3 13h2v8H3zm4-6h2v14H7zm4 3h2v11h-2zm4-7h2v18h-2zm4 9h2v9h-2z"/>'],
  ['mar', 'Mar y olas', 'Oleaje, mar de fondo, mareas, corrientes y temperatura del agua', '<path d="M2 16c2 0 2-1.5 4-1.5S8 16 10 16s2-1.5 4-1.5 2 1.5 4 1.5 2-1.5 4-1.5V18c-2 0-2 1.5-4 1.5S16 18 14 18s-2 1.5-4 1.5S8 18 6 18s-2 1.5-4 1.5zm0-5c2 0 2-1.5 4-1.5S8 11 10 11s2-1.5 4-1.5 2 1.5 4 1.5 2-1.5 4-1.5V13c-2 0-2 1.5-4 1.5S16 13 14 13s-2 1.5-4 1.5S8 13 6 13s-2 1.5-4 1.5z"/>'],
  ['aire', 'Calidad del aire y polen', 'PM2.5, ozono, calima, polen por especies e índice UV', '<path d="M12 3a4 4 0 0 0-4 4H4v2h4.5A4 4 0 1 0 12 3zm0 6a2 2 0 1 1 0-4 2 2 0 0 1 0 4zM3 13h12a3 3 0 1 1-3 3h2a1 1 0 1 0 1-1H3zm0 4h6v2H3z"/>'],
  ['historico', 'Histórico y clima', 'Tiempo pasado desde 1940, normales 1991–2020 y récords', '<path d="M13 3a9 9 0 0 0-9 9H1l4 4 4-4H6a7 7 0 1 1 2.1 5l-1.4 1.4A9 9 0 1 0 13 3zm-1 5v5l4.3 2.5.7-1.2-3.5-2.1V8z"/>'],
  ['embalses', 'Embalses y lluvia', 'Agua embalsada en España, por cuencas y embalses, y lluvia caída este año', '<path d="M12 2.5S5 10.2 5 14.5a7 7 0 0 0 14 0C19 10.2 12 2.5 12 2.5zm0 17a5 5 0 0 1-5-5h2a3 3 0 0 0 3 3z"/><path d="M2 21h20v1.5H2z"/>'],
  ['lluvia', 'Lluvia en directo', 'Dónde llueve más ahora en España y aviso de crecida en ríos y embalses', '<path d="M7 14a1.5 1.5 0 0 1-1.5-1.5C5.5 11 7 9 7 9s1.5 2 1.5 3.5A1.5 1.5 0 0 1 7 14zm5 6a2 2 0 0 1-2-2c0-2 2-4.5 2-4.5s2 2.5 2 4.5a2 2 0 0 1-2 2zm5-8a1.5 1.5 0 0 1-1.5-1.5C15.5 9 17 7 17 7s1.5 2 1.5 3.5A1.5 1.5 0 0 1 17 12zM3 4h2v6H3zm16-2h2v4h-2zM11 2h2v8h-2z"/>'],
  ['planes', 'Planes y huerto', 'Mejores horas para correr, tender, regar, sulfatar, bici o barbacoa, y agua en el suelo', '<path d="M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 16H5V9h14zm-9.5-3.5L6 13l1.4-1.4 2.1 2.1 5.1-5.1L16 10z"/>'],
  ['avisos', 'Mis avisos', 'Te avisa si va a llover mucho, helar, soplar fuerte… o si habrá un atardecer épico', '<path d="M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6V11a6 6 0 0 0-4.5-5.8V4.5a1.5 1.5 0 0 0-3 0v.7A6 6 0 0 0 6 11v5l-2 2v1h16v-1z"/>'],
  ['relieve', 'Mapa 3D', 'Inclina el mapa y mira la lluvia y las nubes sobre las montañas', '<path d="M2 20 9 7l4 7 3-4 6 10z"/><path d="M15.5 4.5a2 2 0 1 1 0 .1z"/>'],
  ['ajustes', 'Ajustes', 'Unidades, modelo por defecto, tema y datos', '<path d="M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7 7 0 0 0-1.7-1L15 3h-4l-.4 2.7a7 7 0 0 0-1.7 1l-2.5-1-2 3.5L6.5 11a7.5 7.5 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7 7 0 0 0 1.7 1L11 21h4l.4-2.7a7 7 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/>'],
];

export default {
  render(el) {
    el.innerHTML = `<div class="menu">${ITEMS.map(([r, t, d, icon]) => `
      <a class="menu-item" href="#/${r}">
        <span class="mi-ico"><svg viewBox="0 0 24 24">${icon}</svg></span>
        <span><b>${t}</b><small>${d}</small></span>
      </a>`).join('')}</div>
      <p class="footer-note">Mi Tiempo · app personal con datos abiertos<br>
      <a href="https://open-meteo.com" target="_blank" rel="noopener">Open-Meteo</a> (CC BY 4.0) ·
      <a href="https://www.ecmwf.int/en/forecasts/datasets/open-data" target="_blank" rel="noopener">ECMWF</a> (CC BY 4.0) ·
      <a href="https://api.met.no" target="_blank" rel="noopener">MET Noruega</a> ·
      <a href="https://www.rainviewer.com" target="_blank" rel="noopener">RainViewer</a> ·
      <a href="https://www.eumetsat.int" target="_blank" rel="noopener">EUMETSAT</a> · NASA GIBS · Esri · OpenStreetMap</p>`;
  },
};
