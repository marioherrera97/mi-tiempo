// Escalas de color compartidas por la tabla horaria y las capas del mapa (valores en unidades métricas)
const SCALES = {
  // Gama natural, como la de Windy: violetas en el frío extremo, azul hacia 0 °C, verde oliva hacia 10 °C,
  // dorado hacia 21 °C y naranja rojizo a partir de 30 °C (sin los verdes azulados saturados de antes)
  temp: [
    [-70, [115, 70, 105]], [-55, [202, 172, 195]], [-40, [162, 70, 145]], [-25, [143, 89, 169]],
    [-15, [157, 219, 217]], [-8, [106, 191, 181]], [-4, [100, 166, 189]], [0, [93, 133, 198]],
    [1, [68, 125, 99]], [10, [128, 147, 24]], [21, [243, 183, 4]], [30, [232, 83, 25]], [47, [71, 14, 0]],
  ],
  wind: [ // km/h
    [0, [98, 113, 183]], [5, [57, 97, 159]], [10, [74, 148, 169]], [18, [77, 141, 123]],
    [26, [83, 165, 83]], [34, [53, 159, 53]], [42, [167, 157, 81]], [52, [159, 127, 58]],
    [62, [161, 108, 92]], [75, [129, 58, 78]], [90, [175, 80, 136]], [110, [117, 74, 147]],
    [140, [109, 97, 163]], [180, [68, 105, 141]],
  ],
  precip: [ // mm/h · gama de Windy: azul acero, turquesa, verde, oliva, granate y morado (sin chillones)
    [0, [111, 111, 111, 0]], [0.1, [90, 112, 140, 0.35]], [0.6, [60, 116, 160, 0.75]], [2, [59, 140, 162, 0.85]],
    [4, [59, 161, 161, 0.9]], [6, [59, 161, 61, 0.9]], [8, [130, 161, 59, 0.92]], [10, [161, 161, 59, 0.92]],
    [15, [161, 110, 59, 0.94]], [20, [161, 59, 59, 0.95]], [30, [161, 59, 161, 0.95]], [50, [168, 168, 168, 0.95]],
  ],
  clouds: [ // % · como Windy: tierra parda sin nubes y grises cada vez más claros
    [0, [146, 130, 70, 0.35]], [10, [132, 119, 70, 0.4]], [30, [116, 116, 116, 0.55]], [60, [160, 160, 160, 0.72]], [90, [214, 214, 214, 0.85]], [100, [210, 210, 210, 0.88]],
  ],
  pressure: [ // hPa · gama de Windy
    [970, [8, 16, 48]], [990, [0, 32, 96]], [995, [0, 52, 146]], [1001, [0, 90, 148]], [1006, [0, 117, 146]],
    [1011, [26, 140, 147]], [1016, [103, 162, 155]], [1021, [155, 183, 172]], [1026, [182, 182, 182]],
    [1031, [176, 174, 152]], [1036, [167, 147, 107]], [1041, [163, 112, 75]], [1046, [159, 72, 52]],
  ],
  humidity: [ // % · gama de Windy
    [0, [173, 85, 56]], [30, [173, 110, 56]], [40, [173, 146, 56]], [50, [105, 173, 56]], [60, [56, 173, 121]],
    [70, [56, 174, 173]], [80, [56, 157, 173]], [87, [56, 135, 173]], [93, [56, 123, 173]], [97, [56, 98, 157]], [100, [56, 70, 114]],
  ],
  cape: [ // J/kg · gama de Windy
    [0, [0, 0, 0, 0]], [100, [110, 110, 110, 0.3]], [500, [83, 141, 141, 0.7]], [1000, [143, 143, 74, 0.8]],
    [1500, [166, 130, 62, 0.85]], [2000, [166, 62, 62, 0.9]], [3000, [166, 62, 166, 0.95]],
  ],
  waves: [ // m
    [0, [60, 90, 160]], [0.5, [60, 140, 200]], [1, [70, 190, 190]], [2, [120, 200, 100]], [3, [230, 210, 60]],
    [4.5, [240, 140, 40]], [6, [220, 50, 50]], [9, [160, 30, 140]],
  ],
  snow: [ // cm
    [0, [0, 0, 0, 0]], [0.5, [200, 220, 255, 0.4]], [5, [150, 190, 255, 0.6]], [20, [100, 140, 240, 0.75]],
    [50, [150, 90, 220, 0.85]], [150, [220, 120, 240, 0.9]],
  ],
  uv: [
    [0, [90, 180, 90]], [3, [240, 220, 60]], [6, [245, 150, 40]], [8, [225, 50, 50]], [11, [160, 60, 190]],
  ],
  rainacc: [ // mm acumulados · misma gama que la lluvia
    [0, [111, 111, 111, 0]], [1, [60, 116, 160, 0.5]], [5, [60, 116, 160, 0.8]], [10, [59, 161, 161, 0.88]],
    [20, [59, 161, 61, 0.9]], [40, [130, 161, 59, 0.92]], [60, [161, 161, 59, 0.92]], [100, [161, 59, 59, 0.94]],
    [200, [161, 59, 161, 0.95]], [400, [168, 168, 168, 0.95]],
  ],
  freezing: [ // m
    [0, [120, 60, 200]], [500, [70, 110, 230]], [1000, [70, 170, 230]], [2000, [90, 200, 150]],
    [3000, [200, 210, 80]], [4000, [245, 150, 50]], [5000, [220, 60, 50]],
  ],
  visibility: [ // m (niebla = blanco)
    [0, [245, 245, 250, 0.9]], [500, [225, 228, 235, 0.8]], [1000, [200, 205, 215, 0.65]], [3000, [160, 170, 185, 0.45]],
    [8000, [110, 120, 140, 0.2]], [20000, [0, 0, 0, 0]],
  ],
  currents: [ // km/h
    [0, [40, 60, 120]], [0.5, [50, 110, 180]], [1, [60, 170, 200]], [2, [110, 210, 140]], [3, [240, 210, 70]], [5, [240, 110, 50]], [8, [200, 40, 90]],
  ],
  sst: [ // °C · tonos de la temperatura del aire, ajustados al rango del mar
    [-2, [93, 133, 198]], [5, [68, 125, 99]], [12, [100, 140, 40]], [17, [128, 147, 24]], [21, [243, 183, 4]],
    [26, [232, 120, 20]], [30, [232, 83, 25]], [34, [140, 30, 5]],
  ],
  pm25: [ // µg/m³
    [0, [80, 200, 170, 0.35]], [10, [80, 204, 170, 0.5]], [20, [240, 230, 65, 0.65]], [35, [255, 140, 60, 0.75]],
    [55, [255, 60, 60, 0.82]], [80, [150, 0, 50, 0.88]], [150, [125, 33, 129, 0.92]],
  ],
  dust: [ // µg/m³
    [0, [0, 0, 0, 0]], [10, [230, 200, 140, 0.3]], [50, [225, 175, 90, 0.55]], [150, [210, 140, 50, 0.72]],
    [400, [180, 90, 30, 0.85]], [1000, [120, 50, 20, 0.92]],
  ],
  period: [ // s
    [0, [60, 80, 150]], [5, [60, 150, 200]], [8, [80, 200, 150]], [11, [220, 210, 70]], [14, [240, 140, 50]], [18, [210, 50, 80]], [22, [150, 40, 140]],
  ],
  aqi: [ // índice europeo
    [0, [80, 240, 230]], [20, [80, 204, 170]], [40, [240, 230, 65]], [60, [255, 80, 80]], [80, [150, 0, 50]], [100, [125, 33, 129]],
  ],
};

export function colorAt(scale, v) {
  const s = SCALES[scale];
  if (v === null || v === undefined || Number.isNaN(v)) return [0, 0, 0, 0];
  if (v <= s[0][0]) return withAlpha(s[0][1]);
  for (let i = 1; i < s.length; i++) {
    if (v <= s[i][0]) {
      const [v0, c0] = s[i - 1], [v1, c1] = s[i];
      const t = (v - v0) / (v1 - v0);
      const a0 = withAlpha(c0), a1 = withAlpha(c1);
      return a0.map((c, k) => c + (a1[k] - c) * t);
    }
  }
  return withAlpha(s[s.length - 1][1]);
}
const withAlpha = (c) => (c.length === 4 ? c : [...c, 1]);

export function css(scale, v, alphaMul = 1) {
  const [r, g, b, a] = colorAt(scale, v);
  return `rgba(${r | 0},${g | 0},${b | 0},${(a * alphaMul).toFixed(2)})`;
}

// Color de texto legible sobre el color de la escala (oscuro sobre claros, blanco sobre oscuros)
export function textOn(scale, v, alphaMul = 1) {
  const [r, g, b, a] = colorAt(scale, v);
  const alpha = Math.min(1, a * alphaMul);
  // Mezcla aproximada con el fondo oscuro de la tarjeta
  const mix = (c) => c * alpha + 30 * (1 - alpha);
  const lum = (0.299 * mix(r) + 0.587 * mix(g) + 0.114 * mix(b)) / 255;
  return lum > 0.55 ? '#0d141c' : '#ffffff';
}

// Gradiente CSS para leyendas
export function gradientCSS(scale, min, max) {
  const steps = 12;
  const stops = [];
  for (let i = 0; i <= steps; i++) {
    const v = min + ((max - min) * i) / steps;
    const [r, g, b, a] = colorAt(scale, v);
    stops.push(`rgba(${r | 0},${g | 0},${b | 0},${Math.max(a, 0.25).toFixed(2)}) ${(i / steps) * 100}%`);
  }
  return `linear-gradient(90deg, ${stops.join(',')})`;
}

// Tabla de colores precalculada (rápida para pintar el mapa píxel a píxel)
export function lut(scale, min, max, n = 256) {
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const c = colorAt(scale, min + ((max - min) * i) / (n - 1));
    out[i * 4] = c[0]; out[i * 4 + 1] = c[1]; out[i * 4 + 2] = c[2]; out[i * 4 + 3] = c[3] * 255;
  }
  return out;
}

export const aqiLevel = (v) => {
  if (v === null || v === undefined) return { name: '—', color: '#888' };
  const lv = [[20, 'Buena'], [40, 'Aceptable'], [60, 'Moderada'], [80, 'Mala'], [100, 'Muy mala'], [Infinity, 'Extremadamente mala']];
  const name = lv.find(([t]) => v <= t)[1];
  return { name, color: css('aqi', v) };
};
