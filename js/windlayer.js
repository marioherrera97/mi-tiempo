// Capa de Leaflet que pinta un campo meteorológico (colores con interpolación bicúbica), isolíneas,
// valores numéricos y partículas animadas que siguen el viento, las olas o las corrientes.
// Los datos son una rejilla regular lat/lon descargada de Open-Meteo.
/* global L */
import { lut } from './colors.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
// Interpolación Catmull-Rom de 4 valores
const cr = (p0, p1, p2, p3, t) =>
  0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (3 * p1 - p0 - 3 * p2 + p3) * t * t * t);

// Pares de aristas cortadas por la isolínea según qué esquinas superan el nivel (marching squares)
const MS = [[], [[3, 0]], [[0, 1]], [[3, 1]], [[1, 2]], [[0, 3], [1, 2]], [[0, 2]], [[3, 2]],
  [[2, 3]], [[0, 2]], [[0, 1], [2, 3]], [[1, 2]], [[1, 3]], [[0, 1]], [[0, 3]], []];

export class FieldLayer {
  constructor(map) {
    this.map = map;
    this.grid = null;
    this.t = 0;
    this.style = {};
    this.lutData = null;
    this.showField = true;
    this.showParticles = true;
    this.running = false;

    const pane = map.createPane('fieldPane');
    pane.style.zIndex = 350;
    pane.style.pointerEvents = 'none';
    this.pane = pane;
    this.fieldCanvas = L.DomUtil.create('canvas', 'field-canvas', pane);
    this.windCanvas = L.DomUtil.create('canvas', 'wind-canvas', pane);
    // Isolíneas y números por encima de nombres de ciudades y partículas
    const isoPane = map.createPane('isoPane');
    isoPane.style.zIndex = 390;
    isoPane.style.pointerEvents = 'none';
    this.isoPane = isoPane;
    this.isoCanvas = L.DomUtil.create('canvas', 'iso-canvas', isoPane);
    this.small = document.createElement('canvas');

    this._onMove = () => this.redraw(true);
    this._onZoomStart = () => { pane.style.visibility = 'hidden'; isoPane.style.visibility = 'hidden'; this.stop(); };
    this._onZoomEnd = () => { pane.style.visibility = ''; isoPane.style.visibility = ''; this.redraw(); };
    this._onMoveStart = () => this.clearParticles();
    this._onMoveEnd = () => this.redraw();
    map.on('move', this._onMove);
    map.on('movestart', this._onMoveStart);
    map.on('moveend', this._onMoveEnd);
    map.on('zoomstart', this._onZoomStart);
    map.on('zoomend', this._onZoomEnd);
    map.on('resize', this._onMoveEnd);
  }

  setGrid(grid) { this.grid = grid; this.redraw(); }

  // Contornos de tierra (Natural Earth) para recortar las capas marinas en la costa
  setLand(rings) {
    this.land = rings.map((r) => {
      let w = 180, e = -180, s = 90, n = -90;
      for (let i = 0; i < r.length; i += 2) {
        if (r[i] < w) w = r[i]; if (r[i] > e) e = r[i];
        if (r[i + 1] < s) s = r[i + 1]; if (r[i + 1] > n) n = r[i + 1];
      }
      return { r, w, e, s, n };
    });
    this._buildMask();
    this.drawField();
  }

  _buildMask() {
    this.landAlpha = null;
    if (!this.style.mask || !this.land || !this.geo) return;
    const c = (this.landCanvas ||= document.createElement('canvas'));
    c.width = this.geo.w; c.height = this.geo.h;
    const ctx = c.getContext('2d');
    const b = this.map.getBounds();
    ctx.fillStyle = '#000';
    ctx.beginPath();
    for (const ring of this.land) {
      if (ring.e < b.getWest() || ring.w > b.getEast() || ring.n < b.getSouth() || ring.s > b.getNorth()) continue;
      const r = ring.r;
      for (let i = 0; i < r.length; i += 2) {
        const p = this.map.latLngToContainerPoint([r[i + 1], r[i]]);
        if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
    }
    ctx.fill();
    this.landAlpha = ctx.getImageData(0, 0, c.width, c.height).data;
  }
  setTime(t) { this.t = t; this.drawField(); this.drawIso(); }

  // style: { var, scale, min, max, flow: {u, v, k}, iso: {var, step, fmt}, values: {var, fmt} }
  setStyle(style) {
    const flowChanged = JSON.stringify(style.flow) !== JSON.stringify(this.style.flow);
    const maskChanged = !!style.mask !== !!this.style.mask;
    this.style = style;
    if (maskChanged) this._buildMask();
    this.lutData = style.var ? lut(style.scale, style.min, style.max) : null;
    this.drawField();
    this.drawIso();
    if (flowChanged) this.startParticles();
  }
  setVisible(field, particles) {
    this.showField = field;
    this.showParticles = particles;
    this.redraw();
  }

  // Interpolación bilineal; cerca de la costa (datos marinos con huecos) usa la esquina más cercana
  sample(name, lat, lon, t = this.t) {
    const g = this.grid;
    const a = g?.vars[name];
    if (!a) return null;
    const fx = (lon - g.lon0) / g.dlon, fy = (lat - g.lat0) / g.dlat;
    if (fx < 0 || fy < 0 || fx > g.nx - 1 || fy > g.ny - 1) return null;
    const x0 = Math.min(Math.floor(fx), g.nx - 2), y0 = Math.min(Math.floor(fy), g.ny - 2);
    const dx = fx - x0, dy = fy - y0;
    const base = t * g.nx * g.ny;
    const i00 = base + y0 * g.nx + x0;
    const v00 = a[i00], v10 = a[i00 + 1], v01 = a[i00 + g.nx], v11 = a[i00 + g.nx + 1];
    if (v00 !== v00 || v10 !== v10 || v01 !== v01 || v11 !== v11) { // algún hueco: media ponderada de las esquinas con dato
      let sum = 0, wsum = 0;
      const add = (v, w) => { if (v === v) { sum += v * w; wsum += w; } };
      add(v00, (1 - dx) * (1 - dy) + 1e-3); add(v10, dx * (1 - dy) + 1e-3); add(v01, (1 - dx) * dy + 1e-3); add(v11, dx * dy + 1e-3);
      return wsum ? sum / wsum : null;
    }
    return v00 * (1 - dx) * (1 - dy) + v10 * dx * (1 - dy) + v01 * (1 - dx) * dy + v11 * dx * dy;
  }

  // Interpolación bicúbica (Catmull-Rom): colores e isolíneas más suaves, como en Windy
  sampleSmooth(name, lat, lon, t = this.t) {
    const g = this.grid;
    const a = g?.vars[name];
    if (!a) return null;
    const fx = (lon - g.lon0) / g.dlon, fy = (lat - g.lat0) / g.dlat;
    if (fx < 0 || fy < 0 || fx > g.nx - 1 || fy > g.ny - 1) return null;
    const x1 = Math.min(Math.floor(fx), g.nx - 2), y1 = Math.min(Math.floor(fy), g.ny - 2);
    const dx = fx - x1, dy = fy - y1;
    const base = t * g.nx * g.ny, nx = g.nx, ny = g.ny;
    const row = (y) => {
      const yy = clamp(y, 0, ny - 1) * nx + base;
      return cr(a[yy + clamp(x1 - 1, 0, nx - 1)], a[yy + x1], a[yy + x1 + 1], a[yy + clamp(x1 + 2, 0, nx - 1)], dx);
    };
    const v = cr(row(y1 - 1), row(y1), row(y1 + 1), row(y1 + 2), dy);
    return v !== v ? this.sample(name, lat, lon, t) : v;
  }

  _prepare() {
    const size = this.map.getSize();
    const topLeft = this.map.containerPointToLayerPoint([0, 0]);
    for (const c of [this.fieldCanvas, this.windCanvas, this.isoCanvas]) {
      L.DomUtil.setPosition(c, topLeft);
      if (c.width !== size.x || c.height !== size.y) {
        c.width = size.x; c.height = size.y;
        c.style.width = size.x + 'px'; c.style.height = size.y + 'px';
      }
    }
    // En Web Mercator la longitud solo depende de x y la latitud solo de y
    const lonOfX = new Float32Array(size.x);
    const latOfY = new Float32Array(size.y);
    for (let x = 0; x < size.x; x++) lonOfX[x] = this.map.containerPointToLatLng([x, 0]).lng;
    for (let y = 0; y < size.y; y++) latOfY[y] = this.map.containerPointToLatLng([0, y]).lat;
    this.geo = { w: size.x, h: size.y, lonOfX, latOfY };
    this._buildMask();
  }

  redraw(fieldOnly = false) {
    if (!this.map._loaded) return;
    this._prepare();
    this.drawField();
    this.drawIso();
    if (!fieldOnly) this.startParticles();
  }

  drawField() {
    const c = this.fieldCanvas, geo = this.geo;
    if (!geo) return;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    if (!this.grid || !this.showField || !this.style.var || !this.lutData) return;
    const name = this.style.var;
    const step = 4;
    const sw = Math.ceil(geo.w / step), sh = Math.ceil(geo.h / step);
    const s = this.small;
    s.width = sw; s.height = sh;
    const sctx = s.getContext('2d');
    const img = sctx.createImageData(sw, sh);
    const data = img.data, L8 = this.lutData;
    const { min, max } = this.style;
    const k = 255 / (max - min);
    for (let y = 0; y < sh; y++) {
      const lat = geo.latOfY[Math.min(geo.h - 1, y * step + 2)];
      for (let x = 0; x < sw; x++) {
        const v = this.sampleSmooth(name, lat, geo.lonOfX[Math.min(geo.w - 1, x * step + 2)]);
        if (v === null) continue;
        const li = clamp(Math.round((v - min) * k), 0, 255) * 4;
        const o = (y * sw + x) * 4;
        data[o] = L8[li]; data[o + 1] = L8[li + 1]; data[o + 2] = L8[li + 2]; data[o + 3] = L8[li + 3];
      }
    }
    sctx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(s, 0, 0, sw * step, sh * step);
    if (this.style.mask && this.landAlpha) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(this.landCanvas, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  // ---------- Isolíneas, máximos/mínimos y números ----------
  drawIso() {
    const c = this.isoCanvas, geo = this.geo;
    if (!geo) return;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    const g = this.grid;
    if (!g) return;
    if (this.style.iso && g.vars[this.style.iso.var]) this._isolines(ctx, this.style.iso);
    if (this.style.values && g.vars[this.style.values.var]) this._values(ctx, this.style.values);
  }

  _isolines(ctx, iso) {
    const g = this.grid, map = this.map;
    const F = 4; // subdivisiones por celda para curvas suaves
    const NX = (g.nx - 1) * F + 1, NY = (g.ny - 1) * F + 1;
    const xs = new Float32Array(NX), ys = new Float32Array(NY);
    const lons = new Float32Array(NX), lats = new Float32Array(NY);
    for (let i = 0; i < NX; i++) { lons[i] = g.lon0 + (i * g.dlon) / F; xs[i] = map.latLngToContainerPoint([g.lat0, lons[i]]).x; }
    for (let j = 0; j < NY; j++) { lats[j] = g.lat0 + (j * g.dlat) / F; ys[j] = map.latLngToContainerPoint([lats[j], g.lon0]).y; }
    const vals = new Float32Array(NX * NY);
    let vmin = Infinity, vmax = -Infinity;
    for (let j = 0; j < NY; j++) {
      for (let i = 0; i < NX; i++) {
        const v = this.sampleSmooth(iso.var, lats[j], lons[i]);
        vals[j * NX + i] = v === null ? NaN : v;
        if (v !== null) { if (v < vmin) vmin = v; if (v > vmax) vmax = v; }
      }
    }
    if (!Number.isFinite(vmin)) return;
    const labels = [];
    const placed = [];
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 2;
    for (let L0 = Math.ceil(vmin / iso.step) * iso.step; L0 <= vmax; L0 += iso.step) {
      ctx.beginPath();
      let segCount = 0;
      for (let j = 0; j < NY - 1; j++) {
        for (let i = 0; i < NX - 1; i++) {
          const v0 = vals[j * NX + i], v1 = vals[j * NX + i + 1], v2 = vals[(j + 1) * NX + i + 1], v3 = vals[(j + 1) * NX + i];
          if (v0 !== v0 || v1 !== v1 || v2 !== v2 || v3 !== v3) continue;
          const idx = (v0 > L0 ? 1 : 0) | (v1 > L0 ? 2 : 0) | (v2 > L0 ? 4 : 0) | (v3 > L0 ? 8 : 0);
          const segs = MS[idx];
          if (!segs.length) continue;
          const pt = (e) => {
            switch (e) {
              case 0: { const t = (L0 - v0) / (v1 - v0); return [xs[i] + (xs[i + 1] - xs[i]) * t, ys[j]]; }
              case 1: { const t = (L0 - v1) / (v2 - v1); return [xs[i + 1], ys[j] + (ys[j + 1] - ys[j]) * t]; }
              case 2: { const t = (L0 - v3) / (v2 - v3); return [xs[i] + (xs[i + 1] - xs[i]) * t, ys[j + 1]]; }
              default: { const t = (L0 - v0) / (v3 - v0); return [xs[i], ys[j] + (ys[j + 1] - ys[j]) * t]; }
            }
          };
          for (const [ea, eb] of segs) {
            const a = pt(ea), b = pt(eb);
            ctx.moveTo(a[0], a[1]);
            ctx.lineTo(b[0], b[1]);
            segCount++;
            // Etiqueta cada cierto número de segmentos, lejos de otras
            if (segCount % 18 === 9) {
              const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
              if (mx > 20 && my > 20 && mx < this.geo.w - 20 && my < this.geo.h - 20 &&
                placed.every(([px, py]) => (px - mx) ** 2 + (py - my) ** 2 > 110 * 110)) {
                placed.push([mx, my]);
                labels.push([mx, my, iso.fmt(L0)]);
              }
            }
          }
        }
      }
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const [x, y, txt] of labels.slice(0, 40)) {
      const w = ctx.measureText(txt).width + 8;
      ctx.fillStyle = 'rgba(15,20,28,0.75)';
      ctx.fillRect(x - w / 2, y - 8, w, 16);
      ctx.fillStyle = '#fff';
      ctx.fillText(txt, x, y);
    }
    if (iso.extrema) this._extrema(ctx, iso, vals, NX, NY, xs, ys);
  }

  // Altas (A) y bajas (B) de presión
  _extrema(ctx, iso, vals, NX, NY, xs, ys) {
    const R = 8; // radio de búsqueda en nodos finos
    const found = [];
    for (let j = R; j < NY - R; j += 2) {
      for (let i = R; i < NX - R; i += 2) {
        const v = vals[j * NX + i];
        if (v !== v) continue;
        let isMax = true, isMin = true;
        for (let dj = -R; dj <= R && (isMax || isMin); dj += 2) {
          for (let di = -R; di <= R; di += 2) {
            if (!di && !dj) continue;
            const w = vals[(j + dj) * NX + i + di];
            if (w !== w) continue;
            if (w >= v) isMax = false;
            if (w <= v) isMin = false;
          }
        }
        if (isMax || isMin) found.push([xs[i], ys[j], isMax ? 'A' : 'B', v]);
      }
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const [x, y, k, v] of found.slice(0, 12)) {
      ctx.font = '800 22px system-ui, sans-serif';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.strokeText(k, x, y);
      ctx.fillStyle = k === 'A' ? '#ff6b6b' : '#5bb8ff';
      ctx.fillText(k, x, y);
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.strokeText(iso.fmt(v), x, y + 17);
      ctx.fillStyle = '#fff';
      ctx.fillText(iso.fmt(v), x, y + 17);
    }
  }

  _values(ctx, val) {
    const geo = this.geo;
    const step = 78;
    ctx.font = '700 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.fillStyle = '#fff';
    for (let y = step / 2 + 30; y < geo.h - 20; y += step) {
      for (let x = step / 2; x < geo.w - 10; x += step) {
        const v = this.sample(val.var, geo.latOfY[y | 0], geo.lonOfX[x | 0]);
        if (v === null) continue;
        const txt = val.fmt(v);
        if (txt === '' || txt === null) continue;
        ctx.strokeText(txt, x, y);
        ctx.fillText(txt, x, y);
      }
    }
  }

  // ---------- Partículas ----------
  clearParticles() {
    this.stop();
    const c = this.windCanvas;
    c.getContext('2d').clearRect(0, 0, c.width, c.height);
  }

  startParticles() {
    this.stop();
    const geo = this.geo;
    if (!geo) return;
    const c = this.windCanvas;
    c.getContext('2d').clearRect(0, 0, c.width, c.height);
    const flow = this.style.flow;
    if (!this.grid || !this.showParticles || !flow || !this.grid.vars[flow.u]) return;
    const n = Math.min(3500, Math.round((geo.w * geo.h) / 750));
    this.particles = Array.from({ length: n }, () => this._spawn());
    this.running = true;
    let last = 0;
    const frame = (ts) => {
      if (!this.running) return;
      if (ts - last >= 30) { this._step(); last = ts; }
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  _spawn() {
    const g = this.geo;
    return { x: Math.random() * g.w, y: Math.random() * g.h, age: Math.floor(Math.random() * 90) };
  }

  _step() {
    const ctx = this.windCanvas.getContext('2d');
    const g = this.geo;
    const flow = this.style.flow;
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = 'rgba(0,0,0,0.93)';
    ctx.fillRect(0, 0, g.w, g.h);
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    const k = 0.055 * (flow.k || 1); // píxeles por fotograma por km/h
    const mask = this.style.mask ? this.landAlpha : null;
    for (const p of this.particles) {
      const xi = p.x | 0, yi = p.y | 0;
      if (p.age > 100 || xi < 0 || yi < 0 || xi >= g.w || yi >= g.h) { Object.assign(p, this._spawn(), { age: 0 }); continue; }
      if (mask && mask[(yi * g.w + xi) * 4 + 3]) { p.age = 999; continue; }
      const lat = g.latOfY[yi], lon = g.lonOfX[xi];
      const u = this.sample(flow.u, lat, lon), v = this.sample(flow.v, lat, lon);
      if (u === null || v === null) { p.age = 999; continue; }
      const nx = p.x + u * k, ny = p.y - v * k;
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(nx, ny);
      p.x = nx; p.y = ny; p.age++;
    }
    ctx.stroke();
  }
}

// ---------- Construcción de la rejilla ----------
// Crea una rejilla vacía con los tiempos del grupo principal
export function emptyGrid(spec, times) {
  return { ...spec, nt: times.length, times, vars: {}, groups: new Set() };
}

// Añade a la rejilla las variables de una respuesta multi-punto (puede tener otro horizonte temporal)
export function mergePoints(grid, points, varNames) {
  const n = grid.nx * grid.ny;
  const tIndex = new Map(grid.times.map((t, i) => [t, i]));
  for (const name of varNames) grid.vars[name] = new Float32Array(grid.nt * n).fill(NaN);
  points.forEach((p, idx) => {
    const h = p.hourly;
    if (!h) return;
    h.time.forEach((t, k) => {
      const ti = tIndex.get(t);
      if (ti === undefined) return;
      const o = ti * n + idx;
      for (const name of varNames) {
        const val = h[name]?.[k];
        if (val !== null && val !== undefined) grid.vars[name][o] = val;
      }
    });
  });
}

// Componentes u/v (km/h) a partir de velocidad y dirección.
// towards = true cuando la dirección indica hacia dónde va (corrientes); mult escala la velocidad visual.
export function addFlow(grid, key, speedVar, dirVar, { mult = 1, towards = false, constSpeed = null } = {}) {
  if (grid.vars[key + '_u'] || !grid.vars[dirVar]) return;
  const s = grid.vars[speedVar], d = grid.vars[dirVar];
  const u = new Float32Array(d.length).fill(NaN), v = new Float32Array(d.length).fill(NaN);
  const sign = towards ? 1 : -1;
  for (let i = 0; i < d.length; i++) {
    const sp = constSpeed ?? (s ? s[i] * mult : NaN);
    if (sp !== sp || d[i] !== d[i]) continue;
    const r = (d[i] * Math.PI) / 180;
    u[i] = sign * sp * Math.sin(r);
    v[i] = sign * sp * Math.cos(r);
  }
  grid.vars[key + '_u'] = u;
  grid.vars[key + '_v'] = v;
}

// Rellena huecos (p. ej. puntos de tierra en capas marinas) con la media de sus vecinos, varias pasadas
export function fillGaps(grid, names, passes = 3) {
  const { nx, ny, nt } = grid;
  const n = nx * ny;
  for (const name of names) {
    const a = grid.vars[name];
    if (!a) continue;
    for (let t = 0; t < nt; t++) {
      for (let p = 0; p < passes; p++) {
        const src = a.slice(t * n, (t + 1) * n);
        let changed = false;
        for (let j = 0; j < ny; j++) {
          for (let i = 0; i < nx; i++) {
            if (src[j * nx + i] === src[j * nx + i]) continue;
            let sum = 0, c = 0;
            for (let dj = -1; dj <= 1; dj++) {
              for (let di = -1; di <= 1; di++) {
                const x = i + di, y = j + dj;
                if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
                const v = src[y * nx + x];
                if (v === v) { sum += v; c++; }
              }
            }
            if (c) { a[t * n + j * nx + i] = sum / c; changed = true; }
          }
        }
        if (!changed) break;
      }
    }
  }
}

// Acumulado desde la hora t0 (lluvia o nieve)
export function addAccum(grid, key, srcVar, t0) {
  const src = grid.vars[srcVar];
  if (!src) return;
  const n = grid.nx * grid.ny;
  const out = new Float32Array(src.length).fill(0);
  for (let t = t0 + 1; t < grid.nt; t++) {
    for (let i = 0; i < n; i++) {
      const add = src[t * n + i];
      out[t * n + i] = out[(t - 1) * n + i] + (add === add ? add : 0);
    }
  }
  grid.vars[key] = out;
}
