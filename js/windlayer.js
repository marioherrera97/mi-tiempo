// Capa de Leaflet que pinta un campo meteorológico (colores con interpolación bicúbica), isolíneas,
// valores numéricos y partículas animadas que siguen el viento, las olas o las corrientes.
// Los datos son una rejilla regular lat/lon descargada de Open-Meteo.
//
// Los lienzos son mayores que la pantalla (margen PAD) y viven en un panel del mapa, así que al
// arrastrar se mueven solos y solo se redibujan al soltar; en el zoom se escalan como una imagen.
/* global L */
import { lut } from './colors.js';

const PAD = 0.25;
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
    this.tf = 0; // fracción de hora (animación suave)
    this.style = {};
    this.lutData = null;
    this.showField = true;
    this.showParticles = true;
    this.running = false;

    const pane = map.createPane('fieldPane');
    pane.style.zIndex = 350;
    pane.style.pointerEvents = 'none';
    this.fieldCanvas = L.DomUtil.create('canvas', 'field-canvas leaflet-zoom-animated', pane);
    this.windCanvas = L.DomUtil.create('canvas', 'wind-canvas leaflet-zoom-animated', pane);
    // Isolíneas y números por encima de nombres de ciudades y partículas
    const isoPane = map.createPane('isoPane');
    isoPane.style.zIndex = 390;
    isoPane.style.pointerEvents = 'none';
    this.isoCanvas = L.DomUtil.create('canvas', 'iso-canvas leaflet-zoom-animated', isoPane);
    this.canvases = [this.fieldCanvas, this.windCanvas, this.isoCanvas];
    this.small = document.createElement('canvas');

    // Durante el zoom los colores se estiran como una imagen, pero los textos (ciudades, isobaras)
    // se ocultan: estirados se desplazarían. Al terminar se redibujan en su sitio, como en Windy.
    const hideText = (on) => { this.isoCanvas.style.visibility = on ? 'hidden' : ''; };
    this._h = {
      movestart: () => this.clearParticles(),
      moveend: () => { this.redraw(); hideText(false); },
      resize: () => this.redraw(),
      zoomstart: () => { this.clearParticles(); hideText(true); },
      zoomanim: (e) => this._animateZoom(e),
      zoom: () => this._scaleToView(),
      // (se vuelven a mostrar en moveend, que Leaflet lanza siempre tras el zoom y ya con el redibujado hecho)
    };
    map.on(this._h);
  }

  setGrid(grid) { this.grid = grid; this.redraw(); }

  setTime(t, tf = 0) {
    this.t = t;
    this.tf = tf;
    this.drawField();
    this.drawIso();
  }

  // style: { var, scale, min, max, mask, flow: {u, v, k}, iso: {var, step, fmt, extrema}, values: {var, fmt} }
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

  // ---------- Muestreo ----------
  // Bilineal; si falta alguna esquina, media ponderada de las que tienen dato
  _bilinear(a, g, lat, lon, t) {
    const fx = (lon - g.lon0) / g.dlon, fy = (lat - g.lat0) / g.dlat;
    if (fx < 0 || fy < 0 || fx > g.nx - 1 || fy > g.ny - 1) return null;
    const x0 = Math.min(Math.floor(fx), g.nx - 2), y0 = Math.min(Math.floor(fy), g.ny - 2);
    const dx = fx - x0, dy = fy - y0;
    const i00 = t * g.nx * g.ny + y0 * g.nx + x0;
    const v00 = a[i00], v10 = a[i00 + 1], v01 = a[i00 + g.nx], v11 = a[i00 + g.nx + 1];
    if (v00 !== v00 || v10 !== v10 || v01 !== v01 || v11 !== v11) {
      let sum = 0, wsum = 0;
      const add = (v, w) => { if (v === v) { sum += v * w; wsum += w; } };
      add(v00, (1 - dx) * (1 - dy) + 1e-3); add(v10, dx * (1 - dy) + 1e-3); add(v01, (1 - dx) * dy + 1e-3); add(v11, dx * dy + 1e-3);
      return wsum ? sum / wsum : null;
    }
    return v00 * (1 - dx) * (1 - dy) + v10 * dx * (1 - dy) + v01 * (1 - dx) * dy + v11 * dx * dy;
  }

  // Bicúbica (Catmull-Rom): colores e isolíneas suaves
  _bicubic(a, g, lat, lon, t) {
    const fx = (lon - g.lon0) / g.dlon, fy = (lat - g.lat0) / g.dlat;
    if (fx < 0 || fy < 0 || fx > g.nx - 1 || fy > g.ny - 1) return null;
    const x1 = Math.min(Math.floor(fx), g.nx - 2), y1 = Math.min(Math.floor(fy), g.ny - 2);
    const dx = fx - x1, dy = fy - y1;
    const base = t * g.nx * g.ny, nx = g.nx, ny = g.ny;
    const xa = clamp(x1 - 1, 0, nx - 1), xd = clamp(x1 + 2, 0, nx - 1);
    const row = (y) => {
      const yy = clamp(y, 0, ny - 1) * nx + base;
      return cr(a[yy + xa], a[yy + x1], a[yy + x1 + 1], a[yy + xd], dx);
    };
    const v = cr(row(y1 - 1), row(y1), row(y1 + 1), row(y1 + 2), dy);
    return v !== v ? this._bilinear(a, g, lat, lon, t) : v;
  }

  // Interpola también entre la hora t y la siguiente cuando hay fracción de hora
  _sampleWith(fn, name, lat, lon, t) {
    const g = this.grid;
    const a = g?.vars[name];
    if (!a) return null;
    const v = fn.call(this, a, g, lat, lon, t);
    if (!this.tf || t !== this.t || t + 1 >= g.nt || v === null) return v;
    const w = fn.call(this, a, g, lat, lon, t + 1);
    return w === null ? v : v + (w - v) * this.tf;
  }
  sample(name, lat, lon, t = this.t) { return this._sampleWith(this._bilinear, name, lat, lon, t); }
  sampleSmooth(name, lat, lon, t = this.t) { return this._sampleWith(this._bicubic, name, lat, lon, t); }

  // ---------- Geometría ----------
  _prepare() {
    const map = this.map;
    const size = map.getSize();
    const ox = Math.round(size.x * PAD), oy = Math.round(size.y * PAD);
    const w = size.x + 2 * ox, h = size.y + 2 * oy;
    const topLeft = map.containerPointToLayerPoint([-ox, -oy]);
    // Textos y partículas a la resolución real de la pantalla (nítidos en móviles); los colores a 1x (son suaves)
    const dpr = window.devicePixelRatio || 1;
    const ratios = new Map([[this.fieldCanvas, 1], [this.windCanvas, Math.min(dpr, 2)], [this.isoCanvas, Math.min(dpr, 3)]]);
    for (const c of this.canvases) {
      const d = ratios.get(c);
      L.DomUtil.setPosition(c, topLeft);
      const W = Math.round(w * d), H = Math.round(h * d);
      if (c.width !== W || c.height !== H) {
        c.width = W; c.height = H;
        c.style.width = w + 'px'; c.style.height = h + 'px';
      }
      c.dpr = d;
    }
    // En Web Mercator la longitud solo depende de x y la latitud solo de y
    const lonOfX = new Float32Array(w);
    const latOfY = new Float32Array(h);
    for (let x = 0; x < w; x++) lonOfX[x] = map.containerPointToLatLng([x - ox, 0]).lng;
    for (let y = 0; y < h; y++) latOfY[y] = map.containerPointToLatLng([0, y - oy]).lat;
    this.geo = { w, h, ox, oy, lonOfX, latOfY };
    this.bounds = L.latLngBounds(map.containerPointToLatLng([-ox, h - oy]), map.containerPointToLatLng([w - ox, -oy]));
    this._buildMask();
  }
  // Coordenadas en el lienzo de un punto geográfico
  _toCanvas(lat, lon) {
    const p = this.map.latLngToContainerPoint([lat, lon]);
    return [p.x + this.geo.ox, p.y + this.geo.oy];
  }

  _animateZoom(e) {
    if (!this.bounds) return;
    const scale = this.map.getZoomScale(e.zoom);
    const offset = this.map._latLngBoundsToNewLayerBounds(this.bounds, e.zoom, e.center).min;
    for (const c of this.canvases) L.DomUtil.setTransform(c, offset, scale);
  }
  // Durante el pellizco (zoom táctil) escala los lienzos para que sigan al mapa
  _scaleToView() {
    if (!this.bounds || !this.geo) return;
    const nw = this.map.latLngToLayerPoint(this.bounds.getNorthWest());
    const se = this.map.latLngToLayerPoint(this.bounds.getSouthEast());
    const scale = (se.x - nw.x) / this.geo.w;
    for (const c of this.canvases) L.DomUtil.setTransform(c, nw, scale);
  }

  redraw() {
    if (!this.map._loaded) return;
    this._prepare();
    this.drawField();
    this.drawIso();
    this.startParticles();
  }

  // ---------- Máscara de tierra para capas marinas ----------
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
    const b = this.bounds;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    for (const ring of this.land) {
      if (ring.e < b.getWest() || ring.w > b.getEast() || ring.n < b.getSouth() || ring.s > b.getNorth()) continue;
      const r = ring.r;
      for (let i = 0; i < r.length; i += 2) {
        const [x, y] = this._toCanvas(r[i + 1], r[i]);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
    }
    ctx.fill();
    this.landAlpha = ctx.getImageData(0, 0, c.width, c.height).data;
  }

  // ---------- Campo de colores ----------
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
    ctx.setTransform(c.dpr || 1, 0, 0, c.dpr || 1, 0, 0);
    ctx.clearRect(0, 0, geo.w, geo.h);
    const g = this.grid || { vars: {} };
    if (this.style.iso && g.vars[this.style.iso.var]) this._isolines(ctx, this.style.iso);
    if (this.style.cities && this.cities) this._cityLabels(ctx);
    if (this.style.values && g.vars[this.style.values.var]) this._values(ctx, this.style.values);
  }

  // ---------- Ciudades con el valor de la capa (como en Windy) ----------
  // cities: [[nombre, lat, lon, minZoom], ...] ordenadas por importancia; extra: lugares propios (favoritos)
  setCities(cities) { this.cities = cities; this.drawIso(); }
  setPlaces(places) { this.places = places || []; this.drawIso(); }

  _cityLabels(ctx) {
    const geo = this.geo;
    const z = this.map.getZoom();
    const cfg = this.style.cities;
    const boxes = [];
    const fits = (x, y, w, h) => {
      if (x < 4 || y < 4 || x + w > geo.w - 4 || y + h > geo.h - 4) return false;
      for (const b of boxes) if (x < b[0] + b[2] && x + w > b[0] && y < b[1] + b[3] && y + h > b[1]) return false;
      boxes.push([x, y, w, h]);
      return true;
    };
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const shadow = 3.5 * (this.isoCanvas.dpr || 1);
    const FONT_NAME = (mine) => `${mine ? 700 : 500} 11px Roboto, "Segoe UI", system-ui, sans-serif`;
    const FONT_VAL = '500 12.5px Roboto, "Segoe UI", system-ui, sans-serif';
    // Texto blanco con halo difuso (dos pasadas de sombra), como las etiquetas de Windy
    const soft = (txt, x, y) => {
      ctx.shadowColor = 'rgba(0,0,0,0.9)';
      ctx.shadowBlur = shadow;
      ctx.fillText(txt, x, y);
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.fillText(txt, x, y);
      ctx.shadowBlur = 0;
    };
    const draw = (name, lat, lon, mine) => {
      const [x, y0] = this._toCanvas(lat, lon);
      const y = mine ? y0 + 26 : y0; // los lugares propios, debajo del marcador
      if (x < 0 || y < 0 || x > geo.w || y > geo.h) return false;
      let val = '';
      if (cfg.var && this.grid?.vars[cfg.var]) {
        const v = this.sample(cfg.var, lat, lon);
        if (v !== null && !(this.style.mask && this.landAlpha?.[((y | 0) * geo.w + (x | 0)) * 4 + 3])) val = cfg.fmt(v) || '';
      }
      ctx.font = FONT_NAME(mine);
      const wName = ctx.measureText(name).width;
      ctx.font = FONT_VAL;
      const wVal = val ? ctx.measureText(val).width : 0;
      const w = Math.max(wName, wVal) + 8, h = val ? 29 : 16;
      if (!fits(x - w / 2, y - 12, w, h)) return false;
      ctx.font = FONT_NAME(mine);
      ctx.fillStyle = mine ? '#ffd56b' : 'rgba(255,255,255,0.95)';
      soft(name, x, y);
      if (val) {
        ctx.font = FONT_VAL;
        ctx.fillStyle = '#ffffff';
        soft(val, x, y + 14);
      }
      return true;
    };
    // Primero los lugares propios (lugar elegido y favoritos), luego ciudades y pueblos por población
    const mine = this.places || [];
    for (const p of mine) draw(p.name, p.lat, p.lon, true);
    const b = this.bounds;
    let n = 0;
    for (const c of this.cities) {
      if (c[3] > z + 1 || !b.contains([c[1], c[2]])) continue;
      if (mine.some((p) => Math.abs(p.lat - c[1]) < 0.02 && Math.abs(p.lon - c[2]) < 0.03)) continue; // ya rotulado
      if (draw(c[0], c[1], c[2], false) && ++n >= 150) break;
    }
  }

  _isolines(ctx, iso) {
    const g = this.grid;
    const F = 4; // subdivisiones por celda para curvas suaves
    const NX = (g.nx - 1) * F + 1, NY = (g.ny - 1) * F + 1;
    const xs = new Float32Array(NX), ys = new Float32Array(NY);
    const lons = new Float32Array(NX), lats = new Float32Array(NY);
    for (let i = 0; i < NX; i++) { lons[i] = g.lon0 + (i * g.dlon) / F; xs[i] = this._toCanvas(g.lat0, lons[i])[0]; }
    for (let j = 0; j < NY; j++) { lats[j] = g.lat0 + (j * g.dlat) / F; ys[j] = this._toCanvas(lats[j], g.lon0)[1]; }
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
    const { w, h } = this.geo;
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
              if (mx > 20 && my > 20 && mx < w - 20 && my < h - 20 &&
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
    for (const [x, y, txt] of labels.slice(0, 60)) {
      const tw = ctx.measureText(txt).width + 8;
      ctx.fillStyle = 'rgba(15,20,28,0.75)';
      ctx.fillRect(x - tw / 2, y - 8, tw, 16);
      ctx.fillStyle = '#fff';
      ctx.fillText(txt, x, y);
    }
    if (iso.extrema) this._extrema(ctx, iso, vals, NX, NY, xs, ys);
  }

  // Altas (A) y bajas (B)
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
    ctx.shadowColor = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur = 4 * (this.isoCanvas.dpr || 1);
    for (const [x, y, k, v] of found.slice(0, 16)) {
      ctx.font = '800 22px Roboto, "Segoe UI", system-ui, sans-serif';
      ctx.fillStyle = k === 'A' ? '#ff6b6b' : '#5bb8ff';
      ctx.fillText(k, x, y);
      ctx.font = '600 11px Roboto, "Segoe UI", system-ui, sans-serif';
      ctx.fillStyle = '#fff';
      ctx.fillText(iso.fmt(v), x, y + 17);
    }
    ctx.shadowBlur = 0;
  }

  _values(ctx, val) {
    const geo = this.geo;
    const step = 78;
    ctx.font = '700 12.5px Roboto, "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = 3 * (this.isoCanvas.dpr || 1);
    // Rejilla anclada a la pantalla para que los números no bailen al soltar el mapa
    const x0 = (geo.ox % step) + step / 2, y0 = (geo.oy % step) + step / 2;
    for (let y = y0; y < geo.h - 10; y += step) {
      for (let x = x0; x < geo.w - 10; x += step) {
        const v = this.sample(val.var, geo.latOfY[y | 0], geo.lonOfX[x | 0]);
        if (v === null) continue;
        if (this.style.mask && this.landAlpha?.[((y | 0) * geo.w + (x | 0)) * 4 + 3]) continue;
        const txt = val.fmt(v);
        if (!txt) continue;
        ctx.fillText(txt, x, y);
      }
    }
    ctx.shadowBlur = 0;
  }

  // ---------- Partículas ----------
  clearParticles() {
    this.stop();
    const c = this.windCanvas;
    const ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
  }

  startParticles() {
    this.stop();
    const geo = this.geo;
    if (!geo) return;
    const c = this.windCanvas;
    const cctx = c.getContext('2d');
    cctx.setTransform(1, 0, 0, 1, 0, 0);
    cctx.clearRect(0, 0, c.width, c.height);
    const flow = this.style.flow;
    if (!this.grid || !this.showParticles || !flow || !this.grid.vars[flow.u]) return;
    // Densidad constante en pantalla (el lienzo incluye el margen)
    const n = Math.min(5000, Math.round((geo.w * geo.h) / 900));
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
    const d = this.windCanvas.dpr || 1;
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = 'rgba(0,0,0,0.92)';
    ctx.fillRect(0, 0, g.w, g.h);
    ctx.globalCompositeOperation = 'source-over';
    const k = 0.055 * (flow.k || 1); // píxeles por fotograma por km/h
    const mask = this.style.mask ? this.landAlpha : null;
    // Tres intensidades según la velocidad, como en Windy: el viento fuerte se ve más
    const paths = [new Path2D(), new Path2D(), new Path2D()];
    const t1 = 15 / (flow.k || 1), t2 = 40 / (flow.k || 1);
    for (const p of this.particles) {
      const xi = p.x | 0, yi = p.y | 0;
      if (p.age > 100 || xi < 0 || yi < 0 || xi >= g.w || yi >= g.h) { Object.assign(p, this._spawn(), { age: 0 }); continue; }
      if (mask && mask[(yi * g.w + xi) * 4 + 3]) { p.age = 999; continue; }
      const lat = g.latOfY[yi], lon = g.lonOfX[xi];
      const u = this.sample(flow.u, lat, lon), v = this.sample(flow.v, lat, lon);
      if (u === null || v === null) { p.age = 999; continue; }
      const sp = Math.hypot(u, v);
      const path = paths[sp < t1 ? 0 : sp < t2 ? 1 : 2];
      const nx = p.x + u * k, ny = p.y - v * k;
      path.moveTo(p.x, p.y);
      path.lineTo(nx, ny);
      p.x = nx; p.y = ny; p.age++;
    }
    const styles = [['rgba(255,255,255,0.55)', 1], ['rgba(255,255,255,0.8)', 1.25], ['rgba(255,255,255,0.97)', 1.6]];
    paths.forEach((path, i) => {
      ctx.strokeStyle = styles[i][0];
      ctx.lineWidth = styles[i][1];
      ctx.stroke(path);
    });
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
export function addFlow(grid, key, speedVar, dirVar, { mult = 1, towards = false } = {}) {
  if (grid.vars[key + '_u'] || !grid.vars[dirVar]) return;
  const s = grid.vars[speedVar], d = grid.vars[dirVar];
  const u = new Float32Array(d.length).fill(NaN), v = new Float32Array(d.length).fill(NaN);
  const sign = towards ? 1 : -1;
  for (let i = 0; i < d.length; i++) {
    const sp = s ? s[i] * mult : NaN;
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
