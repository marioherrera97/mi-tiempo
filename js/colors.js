// Escalas de color compartidas por la tabla horaria y las capas del mapa (valores en unidades métricas)

// Colores de la temperatura, reutilizados en el resto de capas para que todo el mapa tenga los mismos tonos:
// azul, azul claro, verde, oliva, dorado, naranja, granate y morado (de menos a más)
const T = {
  blue: [93, 133, 198], sky: [100, 166, 189], green: [68, 125, 99], olive: [128, 147, 24],
  gold: [243, 183, 4], orange: [232, 83, 25], maroon: [140, 30, 5], purple: [143, 89, 169], lilac: [202, 172, 195],
};
const a = (c, alpha) => [...c, alpha];

const SCALES = {
  // Gama natural, como la de Windy: violetas en el frío extremo, azul hacia 0 °C, verde oliva hacia 10 °C,
  // dorado hacia 21 °C y naranja rojizo a partir de 30 °C (sin los verdes azulados saturados de antes)
  temp: [
    [-70, [115, 70, 105]], [-55, [202, 172, 195]], [-40, [162, 70, 145]], [-25, [143, 89, 169]],
    [-15, [157, 219, 217]], [-8, [106, 191, 181]], [-4, [100, 166, 189]], [0, [93, 133, 198]],
    [1, [68, 125, 99]], [10, [128, 147, 24]], [21, [243, 183, 4]], [30, [232, 83, 25]], [47, [71, 14, 0]],
  ],
  wind: [ // km/h
    [0, T.blue], [8, T.sky], [16, T.green], [26, T.olive], [38, T.gold], [55, T.orange], [80, T.maroon],
    [110, T.purple], [150, T.lilac],
  ],
  precip: [ // mm/h
    [0, a(T.blue, 0)], [0.1, a(T.blue, 0.35)], [0.6, a(T.blue, 0.75)], [2, a(T.green, 0.85)], [5, a(T.olive, 0.9)],
    [10, a(T.gold, 0.92)], [20, a(T.orange, 0.94)], [35, a(T.maroon, 0.95)], [60, a(T.purple, 0.95)],
  ],
  clouds: [ // % · como Windy: tierra parda sin nubes y grises cada vez más claros
    [0, [146, 130, 70, 0.35]], [10, [132, 119, 70, 0.4]], [30, [116, 116, 116, 0.55]], [60, [160, 160, 160, 0.72]], [90, [214, 214, 214, 0.85]], [100, [210, 210, 210, 0.88]],
  ],
  pressure: [ // hPa
    [970, T.purple], [990, T.blue], [1000, T.sky], [1008, T.green], [1014, T.olive], [1020, T.gold],
    [1028, T.orange], [1040, T.maroon],
  ],
  humidity: [ // % · del seco (cálido) al húmedo (frío)
    [0, T.maroon], [20, T.orange], [40, T.gold], [55, T.olive], [70, T.green], [85, T.sky], [95, T.blue], [100, T.purple],
  ],
  cape: [ // J/kg
    [0, a(T.blue, 0)], [100, a(T.blue, 0.3)], [500, a(T.green, 0.7)], [1000, a(T.olive, 0.8)], [1500, a(T.gold, 0.85)],
    [2000, a(T.orange, 0.9)], [3000, a(T.maroon, 0.95)], [4000, a(T.purple, 0.95)],
  ],
  waves: [ // m
    [0, T.blue], [0.5, T.sky], [1, T.green], [2, T.olive], [3, T.gold], [4.5, T.orange], [6, T.maroon], [9, T.purple],
  ],
  snow: [ // cm
    [0, [0, 0, 0, 0]], [0.5, [200, 220, 255, 0.4]], [5, [150, 190, 255, 0.6]], [20, [100, 140, 240, 0.75]],
    [50, [150, 90, 220, 0.85]], [150, [220, 120, 240, 0.9]],
  ],
  uv: [
    [0, T.green], [3, T.gold], [6, T.orange], [8, T.maroon], [11, T.purple],
  ],
  rainacc: [ // mm acumulados · misma gama que la lluvia
    [0, a(T.blue, 0)], [1, a(T.blue, 0.5)], [5, a(T.blue, 0.8)], [10, a(T.green, 0.88)], [25, a(T.olive, 0.9)],
    [50, a(T.gold, 0.92)], [100, a(T.orange, 0.94)], [200, a(T.maroon, 0.95)], [400, a(T.purple, 0.95)],
  ],
  freezing: [ // m · cota baja = frío
    [0, T.purple], [500, T.blue], [1000, T.sky], [2000, T.green], [3000, T.olive], [3500, T.gold], [4000, T.orange], [5000, T.maroon],
  ],
  visibility: [ // m (niebla = blanco)
    [0, [245, 245, 250, 0.9]], [500, [225, 228, 235, 0.8]], [1000, [200, 205, 215, 0.65]], [3000, [160, 170, 185, 0.45]],
    [8000, [110, 120, 140, 0.2]], [20000, [0, 0, 0, 0]],
  ],
  currents: [ // km/h
    [0, T.blue], [0.5, T.sky], [1, T.green], [2, T.olive], [3, T.gold], [5, T.orange], [8, T.maroon],
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
    [0, T.blue], [5, T.sky], [8, T.green], [11, T.olive], [14, T.gold], [18, T.orange], [22, T.maroon],
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
