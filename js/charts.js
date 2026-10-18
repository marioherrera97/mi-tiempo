// Utilidades para Chart.js con colores del tema activo
/* global Chart */
const registry = new Map();

export function theme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  return { text: v('--text-2'), text3: v('--text-3'), grid: v('--line'), card: v('--card'), accent: v('--accent'), warm: v('--warm'), rain: v('--rain') };
}

// Plugin: línea de "ahora" y separadores de día
const markers = {
  id: 'markers',
  beforeDatasetsDraw(chart, _args, opts) {
    const { ctx, chartArea: a, scales: { x } } = chart;
    if (!x || !a) return;
    const t = theme();
    ctx.save();
    if (opts.days) {
      ctx.strokeStyle = t.grid;
      ctx.lineWidth = 1;
      for (const i of opts.days) {
        const px = x.getPixelForValue(i);
        if (px < a.left || px > a.right) continue;
        ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.stroke();
      }
    }
    if (opts.labels) {
      ctx.fillStyle = t.text3;
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.textBaseline = 'top';
      for (const [i, txt] of opts.labels) {
        const px = x.getPixelForValue(i);
        if (px < a.left - 2 || px > a.right - 20) continue;
        ctx.fillText(txt, px + 4, a.top + 2);
      }
    }
    if (opts.now !== undefined && opts.now !== null) {
      const px = x.getPixelForValue(opts.now);
      if (px >= a.left && px <= a.right) {
        ctx.strokeStyle = t.accent;
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.stroke();
      }
    }
    ctx.restore();
  },
};

let registered = false;
function ensure() {
  if (registered || typeof Chart === 'undefined') return;
  Chart.register(markers);
  Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  Chart.defaults.font.size = 11;
  Chart.defaults.maintainAspectRatio = false;
  Chart.defaults.animation = false;
  registered = true;
}

export function makeChart(canvas, config) {
  ensure();
  const t = theme();
  Chart.defaults.color = t.text;
  Chart.defaults.borderColor = t.grid;
  const key = canvas.id || canvas;
  if (registry.has(key)) registry.get(key).destroy();
  const ch = new Chart(canvas, config);
  registry.set(key, ch);
  return ch;
}

export function destroyAll() {
  for (const ch of registry.values()) ch.destroy();
  registry.clear();
}

export function baseOptions(extra = {}) {
  const t = theme();
  return {
    responsive: true,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { labels: { boxWidth: 12, boxHeight: 12, usePointStyle: true, color: t.text } },
      tooltip: { backgroundColor: 'rgba(15,20,28,.92)', titleColor: '#fff', bodyColor: '#dde', padding: 10, cornerRadius: 8 },
      markers: {},
    },
    scales: {
      x: { grid: { display: false }, ticks: { color: t.text3, maxRotation: 0, autoSkip: true, autoSkipPadding: 14 } },
      y: { grid: { color: t.grid }, ticks: { color: t.text3 } },
    },
    ...extra,
  };
}

// Percentil de un array (ignora nulos)
export function percentile(values, p) {
  const v = values.filter((x) => x !== null && x !== undefined && !Number.isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const idx = (v.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return v[lo] + (v[hi] - v[lo]) * (idx - lo);
}
export function mean(values) {
  const v = values.filter((x) => x !== null && x !== undefined && !Number.isNaN(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

export const alpha = (hex, a) => {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

export const PALETTE = ['#4fa3ff', '#ff8a5b', '#3ccf8e', '#c77dff', '#ffd23f', '#ff5d8f', '#2ec4b6', '#a0a0ff', '#f4a261', '#90be6d', '#e76f51', '#8ecae6', '#bdb2ff', '#ffadad', '#caffbf'];
