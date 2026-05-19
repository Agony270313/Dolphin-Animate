const { ipcRenderer } = require('electron');
const $ = id => document.getElementById(id);
const canvas = $('draw-canvas'), overlay = $('overlay-canvas');
const ctx = canvas.getContext('2d'), octx = overlay.getContext('2d');
ctx.imageSmoothingEnabled = true; octx.imageSmoothingEnabled = true;
ctx.imageSmoothingQuality = 'high'; octx.imageSmoothingQuality = 'high';

let S = {
  w: 800, h: 600,
  tool: 'brush',
  stroke: '#000000', fill: '#444444',
  size: 4, opacity: 1,
  layers: [], layerIdx: 0, nextLayerId: 1,
  frames: [], frameIdx: 0,
  fps: 12, loop: true, playing: false, onion: false, onionOpacity: 0.2, onionFrames: 1,
  drawing: false, lx: 0, ly: 0, sx: 0, sy: 0,
  hist: [], histIdx: -1,
  curStroke: null,
  zoom: 1, panX: 0, panY: 0,
  panning: false, pSX: 0, pSY: 0,
  bgColor: '#ffffff',
  bgImg: null, bgImgData: null,
  selObjs: [], selMode: null, resizeHandle: null, dragOff: null, dragStart: null, selPtIdx: -1,
  activeLayerId: null, selLayerIds: new Set(),
  rotateReadyCorner: null, rotateReadyMouse: null,
  tlDirty: true,
  smoothness: 0, spacing: 0, pressureSens: false, pressureCurve: 'soft', pressureExp: 2, pressureMin: 0, mergeMode: true,
  fillTolerance: 203.5,
  autoSmooth: false, pixelSnap: false,
};

// Pen tool path state
let _penPath = null; // { anchors: [{x, y, cpX?, cpY?}], closed: false }

// ---- Pressure curve: soft ease-in for natural brush feel ----
// Maps raw 0..1 pressure to output 0..1 with adjustable curve
function pressureCurve(p) {
  if (!S.pressureSens) return 1;
  const minF = Math.max(0.02, S.pressureMin / 100);
  if (p < minF) p = 0;
  else p = (p - minF) / (1 - minF);
  if (S.pressureCurve === 'linear') return p;
  if (S.pressureCurve === 'hard') return p < 0.5 ? 0 : 1;
  if (S.pressureCurve === 'custom') {
    const e = Math.max(0.2, Math.min(5, S.pressureExp));
    return Math.pow(p, e);
  }
  // default 'soft': quadratic ease-in
  return minF + (1 - minF) * (p * p);
}

// ---- Buffer scale: pixel size / base size (accounts for zoom + DPR) ----
function bufScale() {
  const c = $('canvas-container');
  if (!c) return 1;
  const r = c.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return 1;
  const fit = Math.min(r.width / S.w, r.height / S.h) * 0.9;
  const ds = fit * S.zoom;
  const dpr = window.devicePixelRatio || 1;
  const need = Math.round(S.w * ds * dpr);
  const maxDim = 16000;
  const pxPerUnit = Math.max(0.5, Math.min(need / S.w, maxDim / S.w));
  return pxPerUnit;
}

function resizeBuffers() {
  const bs = bufScale();
  const pw = Math.round(S.w * bs), ph = Math.round(S.h * bs);
  if (canvas.width !== pw) canvas.width = pw;
  if (canvas.height !== ph) canvas.height = ph;
  if (overlay.width !== pw) overlay.width = pw;
  if (overlay.height !== ph) overlay.height = ph;
  return bs;
}

// ---- Coords: mouse → base space ----
function m2b(e) {
  const r = canvas.getBoundingClientRect();
  const bs = bufScale();
  let x = (e.clientX - r.left) * (canvas.width / r.width) / bs;
  let y = (e.clientY - r.top) * (canvas.height / r.height) / bs;
  if (S.pixelSnap) { x = Math.round(x); y = Math.round(y); }
  return { x, y };
}

// ---- Frame / Layer helpers ----
function L() { return S.layers[S.layerIdx]; }
function F(i) { if (i === undefined) i = S.frameIdx; if (!S.frames[i]) S.frames[i] = { o: {}, key: true, _hist: [], _histIdx: -1 }; return S.frames[i]; }
function obs(fi, li) { const f = F(fi); if (!f.o[li]) f.o[li] = []; return f.o[li]; }
function getActiveLayerId() { const l = L(); return l ? l.id : null; }
function syncActiveLayer() { S.activeLayerId = getActiveLayerId(); }
function setActiveLayerByIndex(idx) {
  S.layerIdx = Math.max(0, Math.min(S.layers.length - 1, idx));
  syncActiveLayer();
  S.selLayerIds.clear();
  if (S.activeLayerId != null) S.selLayerIds.add(S.activeLayerId);
}
function toggleLayerSelection(id) {
  if (S.selLayerIds.has(id)) S.selLayerIds.delete(id);
  else S.selLayerIds.add(id);
  if (S.selLayerIds.size === 1) {
    const onlyId = [...S.selLayerIds][0];
    const idx = S.layers.findIndex(l => l.id === onlyId);
    if (idx >= 0) { S.layerIdx = idx; S.activeLayerId = onlyId; }
  }
}
// ---- Selection helpers (multi-select) ----
function selObj() { return S.selObjs.length > 0 ? S.selObjs[0] : null; }
function clearSel() { S.selObjs = []; S.selMode = null; S.selPtIdx = -1; S.selInit = null; S.selBounds = null; S.selBaseBounds = null; S.selPivotAnchor = null; S.selAnchorWorld = null; S.resizeHandle = null; S.rotateReadyCorner = null; S.rotateReadyMouse = null; _multiSelInits.clear(); updateObjPanel(); }
function setSel(ref) { S.selObjs = ref ? [ref] : []; updateObjPanel(); }
function addSel(ref) {
  const existing = S.selObjs.findIndex(s => s.layerId === ref.layerId && s.idx === ref.idx);
  if (existing >= 0) S.selObjs.splice(existing, 1);
  else S.selObjs.push(ref);
  if (!S.selObjs.length) S.selMode = null;
}
function getSelObjects() {
  return S.selObjs.map(ref => {
    const objs = obs(S.frameIdx, ref.layerId);
    return objs[ref.idx] || null;
  }).filter(Boolean);
}
function getMultiBounds() {
  if (!S.selObjs.length) return null;
  const bounds = S.selObjs.map(ref => {
    const objs = obs(S.frameIdx, ref.layerId);
    const o = objs[ref.idx];
    return o ? getObjBounds(o) : null;
  }).filter(Boolean);
  if (!bounds.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of bounds) { minX = Math.min(minX, b.x); minY = Math.min(minY, b.y); maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h); }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function mkFrame() { return { o: {}, key: true, _hist: [], _histIdx: -1 }; }
function mkLayer(name) {
  const id = S.nextLayerId++;
  return { id, name, vis: true, lock: false, col: `hsl(${(id * 60) % 360}, 60%, 50%)` };
}

// ---- Vector draw primitives ----
function drawStroke(c, pts, color, size, opacity, composite) {
  if (!pts || !pts.length) return;
  c.save();
  c.globalAlpha = opacity;
  c.globalCompositeOperation = composite || 'source-over';
  c.strokeStyle = color;
  c.lineWidth = size;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  // Check if per-point pressure data exists
  const hasPressure = pts.some(p => p.p !== undefined && Math.abs(p.p - 1) > 0.01);
  if (pts.length === 1) {
    c.fillStyle = color;
    c.beginPath(); c.arc(pts[0].x, pts[0].y, size / 2, 0, Math.PI * 2); c.fill();
  } else if (pts.length === 2 || (hasPressure && pts.length <= 4)) {
    c.beginPath(); c.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      const w = size * (pts[i].p !== undefined ? pts[i].p : 1);
      if (Math.abs(w - c.lineWidth) > 0.5) { c.stroke(); c.beginPath(); c.moveTo(pts[i-1].x, pts[i-1].y); c.lineWidth = w; }
      c.lineTo(pts[i].x, pts[i].y);
    }
    c.stroke();
  } else if (hasPressure) {
    // ---- Smooth variable-width stroke ----
    // Sample many small segments along Catmull-Rom→Bezier curves,
    // interpolating width smoothly for pro-quality rendering.
    const SEGS = 12; // samples per bezier segment
    for (let i = 0; i < pts.length - 1; i++) {
      const p_prev = pts[Math.max(0, i - 1)];
      const p_curr = pts[i];
      const p_next = pts[i + 1];
      const p_next2 = pts[Math.min(i + 2, pts.length - 1)];

      // Bezier control points (Catmull-Rom conversion)
      const cp1x = p_curr.x + (p_next.x - p_prev.x) / 6;
      const cp1y = p_curr.y + (p_next.y - p_prev.y) / 6;
      const cp2x = p_next.x - (p_next2.x - p_curr.x) / 6;
      const cp2y = p_next.y - (p_next2.y - p_curr.y) / 6;

      // Pressure at start and end of this segment
      const pStart = p_curr.p !== undefined ? p_curr.p : 1;
      const pEnd = p_next.p !== undefined ? p_next.p : 1;

      let prevX = p_curr.x, prevY = p_curr.y;
      let prevW = size * pStart;

      for (let s = 1; s <= SEGS; s++) {
        const t = s / SEGS;
        const mt = 1 - t;
        // Cubic bezier point at t
        const bx = mt*mt*mt*p_curr.x + 3*mt*mt*t*cp1x + 3*mt*t*t*cp2x + t*t*t*p_next.x;
        const by = mt*mt*mt*p_curr.y + 3*mt*mt*t*cp1y + 3*mt*t*t*cp2y + t*t*t*p_next.y;
        // Interpolated width
        const w = size * (pStart + (pEnd - pStart) * t);

        // Only stroke if width changed significantly (reduces draw calls)
        if (Math.abs(w - prevW) > 0.3 || s === SEGS) {
          c.lineWidth = (prevW + w) / 2; // average width for this micro-segment
          c.beginPath();
          c.moveTo(prevX, prevY);
          c.lineTo(bx, by);
          c.stroke();
          prevX = bx; prevY = by; prevW = w;
        }
      }
    }
  } else {
    c.beginPath();
    c.moveTo(pts[0].x, pts[0].y);
    for (let i = 0; i < pts.length - 1; i++) {
      const p_prev = pts[Math.max(0, i - 1)];
      const p_curr = pts[i];
      const p_next = pts[i + 1];
      const p_next2 = pts[Math.min(i + 2, pts.length - 1)];
      c.bezierCurveTo(
        p_curr.x + (p_next.x - p_prev.x) / 6,
        p_curr.y + (p_next.y - p_prev.y) / 6,
        p_next.x - (p_next2.x - p_curr.x) / 6,
        p_next.y - (p_next2.y - p_curr.y) / 6,
        p_next.x, p_next.y
      );
    }
    c.stroke();
  }
  c.restore();
}

function drawShape(c, t, x1, y1, x2, y2, color, fill, size, opacity) {
  c.save();
  c.globalAlpha = opacity;
  c.strokeStyle = color;
  c.lineWidth = size;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.fillStyle = fill || color;
  if (t === 'line') { c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke(); }
  else if (t === 'rect') {
    const l = Math.min(x1, x2), t = Math.min(y1, y2), w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
    c.fillRect(l, t, w, h); c.strokeRect(l, t, w, h);
  } else if (t === 'circle') {
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2, rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2;
    c.beginPath(); c.ellipse(cx, cy, rx || 1, ry || 1, 0, 0, Math.PI * 2); c.fill(); c.stroke();
  }
  c.restore();
}

function drawFill(c, fc, opacity) {
  if (!fc) return;
  c.save();
  c.globalAlpha = opacity;
  c.imageSmoothingEnabled = false;
  c.drawImage(fc, 0, 0);
  c.restore();
}

function renderFrame(c, fi, sc, noOnion) {
  const drawLayer = (ctx, fi, sc, layerId, baseAlpha = 1) => {
    if (sc !== 1) { ctx.save(); ctx.scale(sc, sc); }
    const f = S.frames[fi];
    if (!f) { if (sc !== 1) ctx.restore(); return; }
    const l = S.layers.find(l => l.id === layerId);
    if (!l || !l.vis) { if (sc !== 1) ctx.restore(); return; }
    const objs = f.o[l.id] || [];
      // --- First pass: draw fills BEHIND everything ---
      for (const o of objs) {
        if (o.angle) {
          const c = getObjCenter(o);
          ctx.save();
          ctx.translate(c.x, c.y);
          ctx.rotate(o.angle);
          ctx.translate(-c.x, -c.y);
        }
        if (o.type === 'fill') drawFill(ctx, o.fc, o.opacity * baseAlpha);
        else if (o.type === 'group' && o.children) {
          for (const child of o.children) {
            if (child.type === 'fill') drawFill(ctx, child.fc, child.opacity * baseAlpha);
          }
        }
        if (o.angle) ctx.restore();
      }
      // --- Second pass: draw strokes, shapes, text ON TOP ---
      for (const o of objs) {
        ctx.save();
        // Motion guide: temporarily translate object to follow guide path
        if (o.guideId && o.type !== 'guide' && o.type !== 'fill') {
          const guides = getAllGuides(fi);
          const guide = guides.find(g => g._guideId === o.guideId);
          if (guide) {
            const t = Math.max(0, Math.min(1, o.guidePos || 0));
            const pt = getGuidePoint(guide, t);
            if (pt) {
              const b = getObjBounds(o);
              ctx.translate(pt.x - (b.x + b.w / 2), pt.y - (b.y + b.h / 2));
            }
          }
        }
        if (hasTransform(o)) {
          const m = getObjMatrix(o);
          ctx.save();
          ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
        } else if (o.angle) {
          const c = getObjCenter(o);
          ctx.save();
          ctx.translate(c.x, c.y);
          ctx.rotate(o.angle);
          ctx.translate(-c.x, -c.y);
        }
        if (o.type === 'stroke') {
          const subs = o.subs && o.subs.length ? o.subs : (o.pts ? [{ pts: o.pts, size: o.size, color: o.color, opacity: o.opacity }] : []);
          const composite = o.composite || 'source-over';
          for (const sub of subs) {
            const color = sub.color || o.color;
            const size = sub.size !== undefined ? sub.size : o.size;
            const opacity = (sub.opacity !== undefined ? sub.opacity : o.opacity) * baseAlpha;
            drawStroke(ctx, sub.pts, color, size, opacity, composite);
          }
        } else if (o.type === 'guide') {
          ctx.save();
          ctx.setLineDash([4, 4]);
          ctx.lineDashOffset = 0;
          drawStroke(ctx, o.pts, o.color, o.size, o.opacity * baseAlpha, 'source-over');
          ctx.restore();
        } else if (o.type === 'text') {
          ctx.save();
          ctx.globalAlpha = o.opacity * baseAlpha;
          ctx.fillStyle = o.color;
          ctx.font = `bold ${o.size}px sans-serif`;
          ctx.textBaseline = 'top';
          const lines = (o.text || '').split('\n');
          for (let i = 0; i < lines.length; i++) {
            ctx.fillText(lines[i], o.x, o.y + i * o.size * 1.3);
          }
          ctx.restore();
        }
        else if (o.type === 'group' && o.children) {
          for (const child of o.children) {
            if (child.type === 'stroke') {
              const subs = child.subs && child.subs.length ? child.subs : (child.pts ? [{ pts: child.pts, size: child.size, color: child.color, opacity: child.opacity }] : []);
              for (const sub of subs) {
                drawStroke(ctx, sub.pts, sub.color || child.color, sub.size !== undefined ? sub.size : child.size, (sub.opacity !== undefined ? sub.opacity : child.opacity) * baseAlpha, child.composite || 'source-over');
              }
            } else if (child.type === 'text') {
              ctx.save();
              ctx.globalAlpha = child.opacity * baseAlpha;
              ctx.fillStyle = child.color;
              ctx.font = `bold ${child.size}px sans-serif`;
              ctx.textBaseline = 'top';
              const lines = (child.text || '').split('\n');
              for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], child.x, child.y + i * child.size * 1.3);
              ctx.restore();
            }
            else if (child.type !== 'fill') drawShape(ctx, child.type, child.x1, child.y1, child.x2, child.y2, child.color, child.fillColor, child.size, child.opacity * baseAlpha);
          }
        }
        else if (o.type !== 'fill') drawShape(ctx, o.type, o.x1, o.y1, o.x2, o.y2, o.color, o.fillColor, o.size, o.opacity * baseAlpha);
        if (hasTransform(o) || o.angle) ctx.restore();
        ctx.restore();
    }
    if (sc !== 1) ctx.restore();
  };
  // 1) Draw background
  c.save();
  if (sc !== 1) c.scale(sc, sc);
  if (S.bgImg) {
    c.drawImage(S.bgImg, 0, 0, S.w, S.h);
  } else {
    c.fillStyle = S.bgColor;
    c.fillRect(0, 0, S.w, S.h);
  }
  c.restore();
  // 2) Onion skin ghosts
  if (!noOnion && S.onion) {
    for (let i = 1; i <= S.onionFrames; i++) {
      if (fi - i < 0) break;
      const alpha = S.onionOpacity * (1 - (i - 1) / S.onionFrames);
      _roc = ensureSize(_roc, c.canvas.width, c.canvas.height);
      _rocCtx = _roc.getContext('2d');
      _rocCtx.clearRect(0, 0, _roc.width, _roc.height);
      for (const l of S.layers) {
        if (!l.vis) continue;
        _rlc = ensureSize(_rlc, c.canvas.width, c.canvas.height);
        _rlcCtx = _rlc.getContext('2d');
        _rlcCtx.clearRect(0, 0, _rlc.width, _rlc.height);
        drawLayer(_rlcCtx, fi - i, sc, l.id, Math.max(0.05, alpha));
        _rocCtx.drawImage(_rlc, 0, 0);
      }
      c.save();
      c.globalAlpha = 1;
      c.drawImage(_roc, 0, 0);
      c.restore();
    }
  }
  // 3) Draw each layer on its own canvas, composite bottom-up
  const f = S.frames[fi];
  if (f) {
    for (const l of S.layers) {
      if (!l.vis) continue;
      const objs = f.o[l.id] || [];
      if (!objs.length) continue;
      _rlc = ensureSize(_rlc, c.canvas.width, c.canvas.height);
      _rlcCtx = _rlc.getContext('2d');
      _rlcCtx.clearRect(0, 0, _rlc.width, _rlc.height);
      drawLayer(_rlcCtx, fi, sc, l.id, 1);
      c.drawImage(_rlc, 0, 0);
    }
  }
}

// ---- Render pipeline ----
let _cache = null, _cacheZoom = 0, _cacheFrame = -1, _cacheBs = 0;

// Reusable canvases for layer compositing (avoids createElement per layer per frame)
let _rlc = null, _rlcCtx = null;  // layer canvas (reused across all layers + onion)
let _roc = null, _rocCtx = null;  // onion composite canvas (reused across onion frames)

function ensureSize(cv, w, h) {
  if (!cv) { cv = document.createElement('canvas'); cv.width = w; cv.height = h; return cv; }
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  return cv;
}
let _thumbCache = {}, _thumbsDirty = true;

function buildCache(bs) {
  const pw = Math.round(S.w * bs), ph = Math.round(S.h * bs);
  const c = document.createElement('canvas');
  c.width = pw; c.height = ph;
  const cx = c.getContext('2d');
  cx.imageSmoothingEnabled = true;
  cx.imageSmoothingQuality = 'high';
  renderFrame(cx, S.frameIdx, bs);
  _cache = c;
  _cacheZoom = S.zoom;
  _cacheFrame = S.frameIdx;
  _cacheBs = bs;
  return c;
}

function render() {
  const bs = resizeBuffers();
  const pw = canvas.width, ph = canvas.height;

  // Rebuild cache only when frame or buffer scale changes (zoom alone doesn't trigger rebuild)
  if (_cacheFrame !== S.frameIdx || !_cache || _cacheBs !== bs) {
    buildCache(bs);
  }

  // Draw cache to display canvas (1:1)
  ctx.clearRect(0, 0, pw, ph);
  ctx.drawImage(_cache, 0, 0, pw, ph);

  renderOverlay();
}

// Draw current stroke on overlay (lightweight, called on every mousemove)
function renderOverlay() {
  const pw = overlay.width, ph = overlay.height;
  octx.clearRect(0, 0, pw, ph);
  if (!S.curStroke) return;
  const bs = bufScale();
  octx.save();
  if (bs !== 1) octx.scale(bs, bs);
  if (S.tool === 'eraser') {
    drawStroke(octx, S.curStroke.pts, '#ff6b6b', S.curStroke.size + 2, 0.4, 'source-over');
  } else {
    drawStroke(octx, S.curStroke.pts, S.curStroke.color, S.curStroke.size, S.curStroke.opacity, 'source-over');
  }
  octx.restore();
}

function dirtyCache() { _cache = null; _cacheZoom = -1; _thumbsDirty = true; _thumbCache = {}; }

function fullRender() {
  // Tween is no longer auto-generated; use right-click > Generate Tween(s)
  dirtyCache();
  render();
  if (S.tlDirty) { updateTL(); S.tlDirty = false; }
  updateFC();
}

// markTweenDirty removed — tween is now manual only via right-click menu

// ---- Simplify stroke (RDP) ----
function simplify(pts) {
  if (pts.length <= 3) return pts;
  function rdp(s, e, out) {
    let md = 0, mi = s;
    const sx = pts[s].x, sy = pts[s].y, ex = pts[e].x, ey = pts[e].y;
    const dx = ex - sx, dy = ey - sy;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    for (let i = s + 1; i < e; i++) {
      const t = Math.max(0, Math.min(1, ((pts[i].x - sx) * dx + (pts[i].y - sy) * dy) / (len * len)));
      const d = Math.sqrt((pts[i].x - sx - t * dx) ** 2 + (pts[i].y - sy - t * dy) ** 2);
      if (d > md) { md = d; mi = i; }
    }
    // Smoothness: higher = more aggressive simplification = smoother
    const thr = Math.max(0.05, 0.05 + S.smoothness * 0.034);
    if (md > thr) {
      if (mi - s > 1) rdp(s, mi, out);
      out.push(pts[mi]);
      if (e - mi > 1) rdp(mi, e, out);
    }
  }
  const r = [pts[0]];
  rdp(0, pts.length - 1, r);
  r.push(pts[pts.length - 1]);
  return r;
}

// ---- Auto-smooth: convert rough freehand to clean bezier curves ----
// Fits cubic beziers through anchor points for pro-quality strokes
function smoothStroke(pts) {
  if (!pts || pts.length < 4) return pts;
  // Step 1: aggressive RDP to get anchor points
  const origSmoothness = S.smoothness;
  S.smoothness = Math.min(100, origSmoothness + 40); // more aggressive
  const anchors = simplify(pts);
  S.smoothness = origSmoothness;
  if (anchors.length < 3) return pts;

  // Step 2: Generate smooth Catmull-Rom → Bezier points
  const result = [];
  const segsPerSpan = 8; // smoothness of curve sampling

  for (let i = 0; i < anchors.length - 1; i++) {
    const p_prev = anchors[Math.max(0, i - 1)];
    const p_curr = anchors[i];
    const p_next = anchors[i + 1];
    const p_next2 = anchors[Math.min(i + 2, anchors.length - 1)];

    // Catmull-Rom control points
    const cp1x = p_curr.x + (p_next.x - p_prev.x) / 6;
    const cp1y = p_curr.y + (p_next.y - p_prev.y) / 6;
    const cp2x = p_next.x - (p_next2.x - p_curr.x) / 6;
    const cp2y = p_next.y - (p_next2.y - p_curr.y) / 6;

    // Interpolate pressure if available
    const pStart = p_curr.p !== undefined ? p_curr.p : 1;
    const pEnd = p_next.p !== undefined ? p_next.p : 1;

    for (let s = 0; s <= segsPerSpan; s++) {
      const t = s / segsPerSpan;
      const mt = 1 - t;
      // Cubic bezier point
      const bx = mt*mt*mt*p_curr.x + 3*mt*mt*t*cp1x + 3*mt*t*t*cp2x + t*t*t*p_next.x;
      const by = mt*mt*mt*p_curr.y + 3*mt*mt*t*cp1y + 3*mt*t*t*cp2y + t*t*t*p_next.y;
      const bp = pStart + (pEnd - pStart) * t;
      if (s === 0 && result.length > 0) continue; // avoid duplicate
      result.push({ x: bx, y: by, p: bp });
    }
  }
  return result;
}

// ---- Motion Guide helpers ----
function getGuidePoint(guide, t) {
  if (!guide || !guide.pts || guide.pts.length < 2) return null;
  const pts = guide.pts;
  // Compute cumulative distances
  const dists = [0];
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i-1].x, dy = pts[i].y - pts[i-1].y;
    dists.push(dists[dists.length - 1] + Math.sqrt(dx*dx + dy*dy));
  }
  const total = dists[dists.length - 1];
  if (total === 0) return pts[0];
  const target = t * total;
  // Find segment
  let seg = 0;
  for (let i = 1; i < dists.length; i++) {
    if (target <= dists[i]) { seg = i - 1; break; }
  }
  const segStart = pts[seg];
  const segEnd = pts[seg + 1] || pts[pts.length - 1];
  const segLen = dists[seg + 1] - dists[seg];
  const localT = segLen > 0 ? (target - dists[seg]) / segLen : 0;
  return {
    x: segStart.x + (segEnd.x - segStart.x) * localT,
    y: segStart.y + (segEnd.y - segStart.y) * localT,
  };
}

function getAllGuides(fi) {
  const guides = [];
  const f = S.frames[fi];
  if (!f) return guides;
  for (const l of S.layers) {
    for (const o of (f.o[l.id] || [])) {
      if (o.type === 'guide') guides.push(o);
    }
  }
  return guides;
}

// Apply motion guide position to an object during rendering
function applyGuidePosition(o, fi) {
  if (!o.guideId || o.type === 'guide' || o.type === 'fill') return;
  const guides = getAllGuides(fi);
  const guide = guides.find(g => g._guideId === o.guideId);
  if (!guide || !guide.pts || guide.pts.length < 2) return;
  const t = Math.max(0, Math.min(1, o.guidePos || 0));
  const pt = getGuidePoint(guide, t);
  if (!pt) return;
  // Offset object center to guide point
  const b = getObjBounds(o);
  const offX = pt.x - (b.x + b.w / 2);
  const offY = pt.y - (b.y + b.h / 2);
  if (o.type === 'text') { o.x += offX; o.y += offY; }
  else if (o.pts) {
    for (const p of o.pts) { p.x += offX; p.y += offY; }
  } else if (o.x1 !== undefined) { o.x1 += offX; o.y1 += offY; o.x2 += offX; o.y2 += offY; }
}

// ---- Undo (snapshots only the current frame) ----
function cloneFrameObjects(fi) {
  const f = S.frames[fi];
  if (!f) return {};
  const data = {};
  for (const l of S.layers) {
    data[l.id] = f.o[l.id] ? f.o[l.id].map(cloneObj) : [];
  }
  return data;
}
function saveSnapshot() {
  const f = F();
  f._hist = f._hist.slice(0, f._histIdx + 1);
  f._hist.push(cloneFrameObjects(S.frameIdx));
  if (f._hist.length > 100) f._hist.shift(); else f._histIdx = f._hist.length - 1;
}
function restoreSnapshot(fi) {
  const f = S.frames[fi];
  if (!f) return;
  const entry = f._hist[f._histIdx];
  if (!entry) return;
  for (const [lid, objs] of Object.entries(entry)) {
    const restored = objs.map(o => {
      if (o.fc) {
        const c = document.createElement('canvas');
        c.width = o.fc.width; c.height = o.fc.height;
        c.getContext('2d').drawImage(o.fc, 0, 0);
        return { ...o, fc: c };
      }
      const r = { ...o };
      if (r.pts) r.pts = r.pts.map(p => ({ x: p.x, y: p.y, ...(p.p !== undefined ? { p: p.p } : {}) }));
      if (r.subs) r.subs = r.subs.map(sub => ({ ...sub, pts: sub.pts.map(p => ({ x: p.x, y: p.y, ...(p.p !== undefined ? { p: p.p } : {}) })) }));
      if (r.children) r.children = r.children.map(child => {
        if (child.fc) {
          const cc = document.createElement('canvas');
          cc.width = child.fc.width; cc.height = child.fc.height;
          cc.getContext('2d').drawImage(child.fc, 0, 0);
          return { ...child, fc: cc };
        }
        return { ...child, pts: child.pts ? child.pts.map(p => ({ x: p.x, y: p.y, ...(p.p !== undefined ? { p: p.p } : {}) })) : undefined };
      });
      return r;
    });
    f.o[lid] = restored;
  }
}

function syncUI() {
  if ($('canvas-bg-color')) $('canvas-bg-color').value = S.bgColor;
  if ($('canvas-width')) $('canvas-width').value = S.w;
  if ($('canvas-height')) $('canvas-height').value = S.h;
  if ($('fps-input')) $('fps-input').value = S.fps;
  if ($('loop-toggle')) $('loop-toggle').checked = S.loop;
  if ($('onion-skin')) $('onion-skin').checked = S.onion;
  if ($('prop-onion')) $('prop-onion').checked = S.onion;
  if ($('prop-onion-opacity')) $('prop-onion-opacity').value = Math.round(S.onionOpacity * 100);
  if ($('prop-onion-opacity-label')) $('prop-onion-opacity-label').textContent = Math.round(S.onionOpacity * 100) + '%';
  if ($('prop-onion-frames')) $('prop-onion-frames').value = S.onionFrames;
  if ($('tl-onion-btn')) $('tl-onion-btn').classList.toggle('active', S.onion);
  if ($('tl-loop-btn')) $('tl-loop-btn').classList.toggle('active', S.loop);
  if ($('pan-stroke-color')) $('pan-stroke-color').value = S.stroke;
  if ($('pan-fill-color')) $('pan-fill-color').value = S.fill;
  if ($('prop-pressure')) $('prop-pressure').checked = S.pressureSens;
  if ($('prop-pressure-curve')) $('prop-pressure-curve').value = S.pressureCurve;
  if ($('prop-pressure-exp')) { $('prop-pressure-exp').value = Math.round(S.pressureExp * 10); }
  if ($('pressure-exp-label')) $('pressure-exp-label').textContent = S.pressureExp.toFixed(1);
  if ($('prop-pressure-min')) { $('prop-pressure-min').value = S.pressureMin; }
  if ($('pressure-min-label')) $('pressure-min-label').textContent = S.pressureMin + '%';
  const ps = $('pressure-settings');
  if (ps) ps.style.display = (S.pressureSens && S.tool === 'brush') ? '' : 'none';
}
function undo() {
  const f = S.frames[S.frameIdx];
  if (!f || f._histIdx <= 0) return;
  f._histIdx--;
  restoreSnapshot(S.frameIdx);
  syncUI(); updateObjPanel();
  dirtyCache(); S.tlDirty = true;
  fullRender(); updateLayerUI();
}

function redo() {
  const f = S.frames[S.frameIdx];
  if (!f || f._histIdx >= f._hist.length - 1) return;
  f._histIdx++;
  restoreSnapshot(S.frameIdx);
  syncUI(); updateObjPanel();
  dirtyCache(); S.tlDirty = true;
  fullRender(); updateLayerUI();
}

// ==================== DRAWING ====================
function startDraw(e) {
  if (e.button !== 0) return;
  const l = L();
  if (!l || l.lock) return;
  const p = m2b(e);
  S.drawing = true;
  S.lx = p.x; S.ly = p.y;
  S.sx = p.x; S.sy = p.y;

  if (S.tool === 'select') { selDown(p, e.ctrlKey, e.altKey); return; }
  if (S.tool === 'fill') { doFill(p); S.drawing = false; return; }
  if (S.tool === 'text') { e.preventDefault(); e.stopPropagation(); doText(e); S.drawing = false; return; }
  if (S.tool === 'pen') { startPen(p); return; }

  // Capture pointer so pen/mouse events always reach canvas even outside
  try { canvas.setPointerCapture(e.pointerId); } catch(_) {}

  if (['brush', 'pencil', 'eraser', 'guide'].includes(S.tool)) {
    const pressure = S.pressureSens ? pressureCurve(e.pressure || 0.5) : undefined;
    S.curStroke = {
      pts: [{ x: p.x, y: p.y, ...(pressure !== undefined ? { p: pressure } : {}) }],
      color: S.tool === 'guide' ? '#4fc3f7' : S.stroke,
      size: S.tool === 'pencil' ? 1 : (S.tool === 'guide' ? 2 : S.size),
      opacity: S.tool === 'guide' ? 0.6 : S.opacity,
      composite: S.tool === 'eraser' ? 'destination-out' : 'source-over',
      isGuide: S.tool === 'guide',
    };
    render();
  }
}

function draw(e) {
  if (!S.drawing) return;
  const p = m2b(e);
  if (S.tool === 'select') { selMove(p, e); return; }
  if (S.tool === 'pen') { drawPen(p); return; }

  if (['brush', 'pencil', 'eraser', 'guide'].includes(S.tool)) {
    if (S.curStroke) {
      const last = S.curStroke.pts[S.curStroke.pts.length - 1];
      if (S.spacing > 0 && last && S.tool !== 'guide') {
        const dx = p.x - last.x, dy = p.y - last.y;
        if (dx * dx + dy * dy < S.spacing * S.spacing) { S.lx = p.x; S.ly = p.y; return; }
      }
      const pressure = S.pressureSens ? pressureCurve(e.pressure || 0.5) : undefined;
      S.curStroke.pts.push({ x: p.x, y: p.y, ...(pressure !== undefined ? { p: pressure } : {}) });
      renderOverlay();
    }
    S.lx = p.x; S.ly = p.y;
  } else {
    const bs = bufScale();
    octx.clearRect(0, 0, overlay.width, overlay.height);
    octx.save();
    if (bs !== 1) octx.scale(bs, bs);
    octx.globalAlpha = 0.7;
    drawShape(octx, S.tool, S.sx, S.sy, p.x, p.y, S.stroke, S.fill, S.size, 1);
    octx.restore();
  }
}

function endDraw(e) {
  if (!S.drawing) return;
  if (e && e.button !== 0) return;
  // Release pointer capture
  try { if (e && e.pointerId) canvas.releasePointerCapture(e.pointerId); } catch(_) {}
  S.drawing = false;
  if (S.tool === 'select') { selUp(); return; }
  if (S.tool === 'pen') { endPen(e ? m2b(e) : null); return; }

  if (['brush', 'pencil', 'eraser', 'guide'].includes(S.tool) && S.curStroke) {
    // Only simplify when smoothness > 0 (0 = keep all points = preview matches final)
    if (S.smoothness > 0 && S.curStroke.pts.length > 3 && S.tool !== 'guide') {
      S.curStroke.pts = simplify(S.curStroke.pts);
    }
    // Auto-smooth: convert rough freehand to clean bezier curves
    if (S.autoSmooth && !S.pressureSens && S.curStroke.pts.length > 3 && S.tool !== 'eraser' && S.tool !== 'guide') {
      S.curStroke.pts = smoothStroke(S.curStroke.pts);
    }
    const l = L();
    if (l) {
      const isEraser = S.curStroke.composite === 'destination-out';
      const isGuide = S.curStroke.isGuide;
      if (isEraser) {
        // Eraser: remove overlapping points from existing strokes on this layer
        const eraserPts = S.curStroke.pts;
        const eraserSize = S.curStroke.size;
        if (!eraserPts || eraserPts.length < 2) { S.curStroke = null; render(); return; }
        const objs = obs(S.frameIdx, l.id);
        // Helper: check if point (x,y) is near eraser path
        const isNearEraser = (x, y, threshold) => {
          const th2 = threshold * threshold;
          for (const ep of eraserPts) {
            const dx = x - ep.x, dy = y - ep.y;
            if (dx*dx + dy*dy < th2) return true;
          }
          for (let si = 0; si < eraserPts.length - 1; si++) {
            const ax = eraserPts[si].x, ay = eraserPts[si].y;
            const bx = eraserPts[si+1].x, by = eraserPts[si+1].y;
            const dx = bx - ax, dy = by - ay;
            const len2 = dx*dx + dy*dy;
            if (len2 < 1) continue;
            let t = ((x - ax)*dx + (y - ay)*dy) / len2;
            t = Math.max(0, Math.min(1, t));
            const cx = ax + t*dx, cy = ay + t*dy;
            const d2 = (x-cx)*(x-cx) + (y-cy)*(y-cy);
            if (d2 < th2) return true;
          }
          return false;
        };
        // Remove points from a pts array where they overlap the eraser, split at gaps
        const removeErased = (pts, size) => {
          if (!pts || pts.length < 2) return { result: null, erased: false };
          const threshold = eraserSize / 2;
          const remaining = [];
          let erased = false;
          for (const pt of pts) {
            if (isNearEraser(pt.x, pt.y, threshold)) { erased = true; continue; }
            remaining.push(pt);
          }
          if (!erased) return { result: null, erased: false };
          if (remaining.length < 2) return { result: [], erased: true };
          // Split at gaps wider than threshold*2
          const gapTh2 = threshold * threshold * 4;
          const segments = [];
          let cur = [remaining[0]];
          for (let pi = 1; pi < remaining.length; pi++) {
            const dx = remaining[pi].x - remaining[pi-1].x;
            const dy = remaining[pi].y - remaining[pi-1].y;
            if (dx*dx + dy*dy > gapTh2) {
              if (cur.length >= 2) segments.push(cur);
              cur = [remaining[pi]];
            } else {
              cur.push(remaining[pi]);
            }
          }
          if (cur.length >= 2) segments.push(cur);
          return { result: segments.length > 0 ? segments : [], erased: true };
        };
        for (let i = objs.length - 1; i >= 0; i--) {
          const o = objs[i];
          if (o.type !== 'stroke' || o.composite === 'destination-out') continue;
          // Handle subs (merged strokes)
          if (o.subs && o.subs.length > 0) {
            const newSubs = [];
            for (const sub of o.subs) {
              const subSize = sub.size !== undefined ? sub.size : (o.size || 10);
              const { result, erased: subErased } = removeErased(sub.pts, subSize);
              if (!subErased) { newSubs.push(sub); continue; }
              if (result && result.length > 0) {
                for (const seg of result) newSubs.push({ ...sub, pts: seg });
              }
              // if result is [] or null, sub fully erased → skip it
            }
            if (newSubs.length === 0) { objs.splice(i, 1); }
            else { o.subs = newSubs; }
          } else {
            // Simple stroke with pts
            const { result, erased: strokeErased } = removeErased(o.pts, o.size);
            if (!strokeErased) continue;
            if (result && result.length > 0) {
              o.pts = result[0];
              for (let ri = 1; ri < result.length; ri++) {
                objs.splice(i + ri, 0, { ...o, pts: result[ri] });
              }
            } else {
              objs.splice(i, 1);
            }
          }
        }
      } else {
        const isGuide = S.curStroke.isGuide;
        const newObj = {
          type: isGuide ? 'guide' : 'stroke',
          pts: S.curStroke.pts.map(p => ({ x: p.x, y: p.y, ...(p.p !== undefined ? { p: p.p } : {}) })),
          color: isGuide ? '#4fc3f7' : S.curStroke.color,
          size: isGuide ? 2 : S.curStroke.size,
          opacity: isGuide ? 0.5 : S.curStroke.opacity,
          composite: 'source-over',
          ...(isGuide ? { _guideId: 'g_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) } : {}),
        };
        if (S.mergeMode && !isGuide) autoMerge(l.id, newObj);
        else obs(S.frameIdx, l.id).push(newObj);
      }
      dirtyCache();
    }
    S.curStroke = null;
    render();
     saveSnapshot();
    return;
  }

  if (['line', 'rect', 'circle'].includes(S.tool)) {
    octx.clearRect(0, 0, overlay.width, overlay.height);
    const p = m2b(e);
    const l = L();
    if (l) {
      obs(S.frameIdx, l.id).push({
        type: S.tool, x1: S.sx, y1: S.sy, x2: p.x, y2: p.y,
        color: S.stroke, fillColor: S.fill, size: S.size, opacity: S.opacity,
      });
      setSel({ layerId: l.id, idx: obs(S.frameIdx, l.id).length - 1 });
      dirtyCache();
      render();
       saveSnapshot();
    }
  }
}

// ==================== PEN TOOL ====================
function startPen(p) {
  if (!_penPath) {
    _penPath = { anchors: [{ x: p.x, y: p.y }], closed: false };
    renderPenOverlay(p);
    return;
  }
  // Check if clicking on first anchor to close path
  const first = _penPath.anchors[0];
  if (dist(p, first) < 10) {
    _penPath.closed = true;
    finishPenPath();
    return;
  }
  // Add new anchor
  _penPath.anchors.push({ x: p.x, y: p.y });
  renderPenOverlay(p);
}

function drawPen(p) {
  if (!_penPath || _penPath.anchors.length === 0) return;
  const last = _penPath.anchors[_penPath.anchors.length - 1];
  // Update control point based on drag
  last.cpX = p.x;
  last.cpY = p.y;
  renderPenOverlay(p);
}

function endPen(p) {
  if (!_penPath || !p) return;
  const last = _penPath.anchors[_penPath.anchors.length - 1];
  const dx = (last.cpX || p.x) - last.x;
  const dy = (last.cpY || p.y) - last.y;
  // If no significant drag, remove control point (straight line)
  if (Math.abs(dx) < 3 && Math.abs(dy) < 3) {
    delete last.cpX;
    delete last.cpY;
  }
  renderPenOverlay(null);
}

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function renderPenOverlay(mouseP) {
  octx.clearRect(0, 0, overlay.width, overlay.height);
  if (!_penPath || _penPath.anchors.length < 1) return;
  const bs = bufScale();
  octx.save();
  if (bs !== 1) octx.scale(bs, bs);
  octx.strokeStyle = '#0af';
  octx.fillStyle = '#0af';
  octx.lineWidth = 1;

  // Draw anchors
  for (const a of _penPath.anchors) {
    octx.fillRect(a.x - 3, a.y - 3, 6, 6);
    if (a.cpX !== undefined) {
      octx.strokeStyle = 'rgba(0,170,255,0.4)';
      octx.beginPath(); octx.moveTo(a.x, a.y); octx.lineTo(a.cpX, a.cpY); octx.stroke();
      octx.fillStyle = '#fff';
      octx.fillRect(a.cpX - 2, a.cpY - 2, 4, 4);
      octx.fillStyle = '#0af';
    }
  }

  // Draw path segments
  octx.strokeStyle = '#0af';
  octx.beginPath();
  octx.moveTo(_penPath.anchors[0].x, _penPath.anchors[0].y);
  for (let i = 1; i < _penPath.anchors.length; i++) {
    const prev = _penPath.anchors[i - 1];
    const curr = _penPath.anchors[i];
    if (curr.cpX !== undefined) {
      const cp = { x: curr.cpX, y: curr.cpY };
      octx.quadraticCurveTo(cp.x, cp.y, curr.x, curr.y);
    } else {
      octx.lineTo(curr.x, curr.y);
    }
  }
  octx.stroke();

  // Draw preview from last anchor to mouse
  if (mouseP && _penPath.anchors.length > 0) {
    const last = _penPath.anchors[_penPath.anchors.length - 1];
    let previewCp;
    if (last.cpX !== undefined) {
      previewCp = { x: last.x * 2 - last.cpX, y: last.y * 2 - last.cpY };
    } else {
      previewCp = mouseP;
    }
    octx.strokeStyle = 'rgba(0,170,255,0.5)';
    octx.setLineDash([4, 3]);
    octx.beginPath();
    octx.moveTo(last.x, last.y);
    octx.quadraticCurveTo(previewCp.x, previewCp.y, mouseP.x, mouseP.y);
    octx.stroke();
    octx.setLineDash([]);
  }

  octx.restore();
}

function sampleQuadraticBezier(p0, p1, p2, segments) {
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const mt = 1 - t;
    const x = mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x;
    const y = mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y;
    pts.push({ x, y });
  }
  return pts;
}

function finishPenPath() {
  if (!_penPath || _penPath.anchors.length < 2) {
    _penPath = null;
    octx.clearRect(0, 0, overlay.width, overlay.height);
    return;
  }
  const pts = [];
  const anchors = _penPath.anchors;
  for (let i = 1; i < anchors.length; i++) {
    const p0 = anchors[i - 1];
    const p2 = anchors[i];
    let cp;
    if (p2.cpX !== undefined) {
      cp = { x: p2.cpX, y: p2.cpY };
    } else {
      cp = { x: (p0.x + p2.x) / 2, y: (p0.y + p2.y) / 2 };
    }
    const seg = sampleQuadraticBezier(p0, cp, p2, 15);
    if (i === 1) pts.push(...seg);
    else pts.push(...seg.slice(1));
  }
  if (_penPath.closed && anchors.length > 2) {
    const p0 = anchors[anchors.length - 1];
    const p2 = anchors[0];
    const cp = { x: (p0.x + p2.x) / 2, y: (p0.y + p2.y) / 2 };
    const seg = sampleQuadraticBezier(p0, cp, p2, 15);
    pts.push(...seg.slice(1));
  }
  if (pts.length > 1) {
    const l = L();
    if (l) {
      obs(S.frameIdx, l.id).push({
        type: 'stroke',
        pts,
        color: S.stroke,
        size: S.size,
        opacity: S.opacity,
        composite: 'source-over',
      });
      dirtyCache(); render();  saveSnapshot();
    }
  }
  _penPath = null;
  octx.clearRect(0, 0, overlay.width, overlay.height);
}

function cancelPenPath() {
  _penPath = null;
  octx.clearRect(0, 0, overlay.width, overlay.height);
}

// ---- Auto-merge strokes (Adobe Animate Merge Drawing Mode) ----
function autoMerge(lid, newObj) {
  const objs = obs(S.frameIdx, lid);
  let prevIdx = -1;
  for (let i = objs.length - 1; i >= 0; i--) {
    if (objs[i].type === 'stroke') { prevIdx = i; break; }
  }
  if (prevIdx < 0) { objs.push(newObj); return; }
  const prev = objs[prevIdx];
  // Never merge guides, erasers, or different types
  if (prev.type !== newObj.type) { objs.push(newObj); return; }
  if (prev.type === 'guide' || newObj.type === 'guide') { objs.push(newObj); return; }
  // Never merge with eraser objects or into eraser strokes
  const isEraser = (o) => o.composite === 'destination-out';
  if (isEraser(prev) || isEraser(newObj)) { objs.push(newObj); return; }
  // Don't merge if composites differ (color and size can differ per sub-stroke)
  if (prev.composite !== newObj.composite) { objs.push(newObj); return; }
  // Check point-to-point proximity
  const prevPts = prev.subs ? prev.subs.flatMap(s => s.pts) : (prev.pts || []);
  const maxSize = Math.max(prev.size, newObj.size);
  const thresholdSq = (maxSize + 15) ** 2;
  let close = false;
  for (const a of prevPts) {
    for (const b of newObj.pts) {
      const dx = a.x - b.x, dy = a.y - b.y;
      if (dx * dx + dy * dy <= thresholdSq) { close = true; break; }
    }
    if (close) break;
  }
  if (!close) { objs.push(newObj); return; }
  // Merge: each sub-stroke keeps its own size/color/opacity
  const prevSubs = prev.subs && prev.subs.length
    ? prev.subs
    : [{ pts: prev.pts, size: prev.size, color: prev.color, opacity: prev.opacity }];
  const merged = {
    type: 'stroke',
    subs: [...prevSubs, { pts: newObj.pts, size: newObj.size, color: newObj.color, opacity: newObj.opacity }],
    color: newObj.color,
    size: newObj.size,
    opacity: newObj.opacity,
    composite: newObj.composite,
  };
  objs.splice(prevIdx, 1, merged);
}

// ---- Flood fill with tolerance: fills closed shapes properly ----
function doFill(c) {
  const l = L();
  if (!l) return;
  const w = S.w, h = S.h;

  // 1. Render frame (background + strokes/shapes, NO existing fills)
  const tmp = document.createElement('canvas');
  tmp.width = w; tmp.height = h;
  const tc = tmp.getContext('2d');

  tc.fillStyle = S.bgColor;
  tc.fillRect(0, 0, w, h);

  for (const layer of S.layers) {
    if (!layer.vis) continue;
    const f = S.frames[S.frameIdx];
    if (!f) continue;
    for (const o of (f.o[layer.id] || [])) {
        if (o.type === 'stroke') {
          const subs = o.subs && o.subs.length ? o.subs : (o.pts ? [{ pts: o.pts, size: o.size, color: o.color, opacity: o.opacity }] : []);
          for (const sub of subs) {
            const sz = sub.size !== undefined ? sub.size : o.size;
            drawStroke(tc, sub.pts, sub.color || o.color, sz, 1, 'source-over');
          }
        } else if (o.type === 'rect' || o.type === 'circle' || o.type === 'line') {
          drawShape(tc, o.type, o.x1, o.y1, o.x2, o.y2, o.color, o.fillColor, o.size, 1);
        } else if (o.type === 'pen' && o.pts) {
          drawStroke(tc, o.pts, o.color, o.size, 1, 'source-over');
      }
    }
  }

  // 2. Read pixels
  const id = tc.getImageData(0, 0, w, h);
  const d = id.data;
  const sx = Math.round(c.x), sy = Math.round(c.y);
  if (sx < 0 || sx >= w || sy < 0 || sy >= h) return;

  const baseIdx = (sy * w + sx) * 4;
  const sr = d[baseIdx], sg = d[baseIdx + 1], sb = d[baseIdx + 2], sa = d[baseIdx + 3];

  const hex = S.stroke.replace('#', '');
  const fr = parseInt(hex.substring(0, 2), 16);
  const fg = parseInt(hex.substring(2, 4), 16);
  const fb = parseInt(hex.substring(4, 6), 16);
  const fa = Math.round(S.opacity * 255);

  if (sr === fr && sg === fg && sb === fb && sa === fa) return;

  const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
  const TOL = S.fillTolerance; // tolerance: pixels within this range are "background"

  // Helper: is this pixel a STROKE (not background)?
  const isStroke = (idx) => {
    const pi = idx * 4;
    return Math.abs(d[pi] - sr) > TOL ||
           Math.abs(d[pi+1] - sg) > TOL ||
           Math.abs(d[pi+2] - sb) > TOL ||
           Math.abs(d[pi+3] - sa) > TOL;
  };

  // 3. Flood fill (stack-based, 8-dir)
  const filled = new Uint8Array(w * h);
  const stack = [[sx, sy]];

  while (stack.length > 0) {
    const [x, y] = stack.pop();
    if (x < 0 || x >= w || y < 0 || y >= h) continue;
    const idx = y * w + x;
    if (filled[idx]) continue;
    if (isStroke(idx)) continue; // wall — do not cross

    filled[idx] = 1;
    for (const [dx, dy] of dirs) stack.push([x + dx, y + dy]);
  }

  // 4. Dilate fill 8 times to reach anti-aliased stroke edges
  // Stroke pixels are NEVER crossed
  for (let iter = 0; iter < 8; iter++) {
    const tmpF = new Uint8Array(filled);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const idx = y * w + x;
        if (tmpF[idx]) continue;
        if (isStroke(idx)) continue; // never dilate through stroke
        for (const [dx, dy] of dirs) {
          if (tmpF[(y + dy) * w + (x + dx)]) { filled[idx] = 1; break; }
        }
      }
    }
  }

  // 5. Create fill canvas
  const fc = document.createElement('canvas');
  fc.width = w; fc.height = h;
  const fctx = fc.getContext('2d');
  const fillData = fctx.createImageData(w, h);
  const fd = fillData.data;
  for (let i = 0; i < filled.length; i++) {
    if (filled[i]) {
      const pi = i * 4;
      fd[pi] = fr; fd[pi + 1] = fg; fd[pi + 2] = fb; fd[pi + 3] = fa;
    }
  }
  fctx.putImageData(fillData, 0, 0);
  obs(S.frameIdx, l.id).push({ type: 'fill', fc, opacity: S.opacity });
  dirtyCache();
  render();
  saveSnapshot();
}

// ---- Text tool ----
let _textInput = null;
function doText(e) {
  const l = L();
  if (!l) return;
  if (_textInput) { finishText(); return; }
  const p = m2b(e);
  _textInput = document.createElement('input');
  _textInput.type = 'text';
  _textInput.placeholder = 'Type here...';
  _textInput.style.cssText = 'position:fixed;z-index:9999;background:#2d2d2d;color:#fff;border:2px solid #0af;padding:6px 10px;font:16px sans-serif;outline:none;min-width:80px;box-shadow:0 4px 12px rgba(0,0,0,0.4);border-radius:3px;';
  _textInput.style.left = (e.clientX - 4) + 'px';
  _textInput.style.top = (e.clientY - 4) + 'px';
  _textInput.dataset.x = p.x;
  _textInput.dataset.y = p.y;
  document.body.appendChild(_textInput);
  // Delay focus to ensure input is in DOM and ready
  requestAnimationFrame(() => {
    if (_textInput) _textInput.focus();
  });
  _textInput.onblur = finishText;
  _textInput.onkeydown = ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); if (_textInput) _textInput.blur(); }
    if (ev.key === 'Escape') { ev.preventDefault(); if (_textInput) { _textInput.value = ''; _textInput.blur(); } }
  };
}
function finishText() {
  if (!_textInput) return;
  const val = _textInput.value.trim();
  const x = parseFloat(_textInput.dataset.x);
  const y = parseFloat(_textInput.dataset.y);
  _textInput.remove();
  _textInput = null;
  if (!val) return;
  const l = L();
  if (!l) return;
  const size = Math.max(8, S.size * 3);
  obs(S.frameIdx, l.id).push({
    type: 'text',
    text: val,
    x, y,
    color: S.stroke,
    size,
    opacity: S.opacity,
  });
  dirtyCache(); render(); saveSnapshot();
}

// ---- Import Image ----
async function importImage() {
  const result = await window.api?.openFile?.({ filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }] });
  if (!result) return;
  const data = await window.api?.readFileBinary?.(result);
  if (!data) {
    // Fallback: use an <input type=file>
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/png,image/jpeg,image/gif,image/webp';
    inp.onchange = () => {
      const file = inp.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => {
        const img = new Image();
        img.onload = () => {
          const fc = document.createElement('canvas');
          fc.width = img.width; fc.height = img.height;
          fc.getContext('2d').drawImage(img, 0, 0);
          const l = L();
          if (l) {
            obs(S.frameIdx, l.id).push({ type: 'fill', fc, opacity: 1 });
            dirtyCache(); render();  saveSnapshot();
          }
        };
        img.src = ev.target.result;
      };
      reader.readAsDataURL(file);
    };
    inp.click();
    return;
  }
  const img = new Image();
  const blob = new Blob([data]);
  img.onload = () => {
    const fc = document.createElement('canvas');
    fc.width = img.width; fc.height = img.height;
    fc.getContext('2d').drawImage(img, 0, 0);
    const l = L();
    if (l) {
      obs(S.frameIdx, l.id).push({ type: 'fill', fc, opacity: 1 });
      dirtyCache(); render();  saveSnapshot();
    }
  };
  img.src = URL.createObjectURL(blob);
}

// ---- Auto-save ----
const AS_KEY = 'yunus_autosave';
function autoSave() {
  try {
    const data = { w: S.w, h: S.h, bgColor: S.bgColor, bgImgData: S.bgImgData, fps: S.fps, loop: S.loop, layerIdx: S.layerIdx, frameIdx: S.frameIdx };
    localStorage.setItem(AS_KEY + '_meta', JSON.stringify(data));
  } catch(e) {}
}
function checkAutoSave() {
  try {
    const meta = localStorage.getItem(AS_KEY + '_meta');
    if (meta) return JSON.parse(meta);
  } catch(e) {}
  return null;
}
function clearAutoSave() {
  try { localStorage.removeItem(AS_KEY + '_meta'); } catch(e) {}
}
function getObjBounds(o) {
  let b;
  if (o.type === 'stroke' && o.pts && o.pts.length) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of o.pts) { if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; }
    const pad = o.size / 2 + 2;
    b = { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
  } else if (o.type === 'stroke' && o.subs && o.subs.length) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const sub of o.subs) { for (const p of sub.pts) { if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; } }
    let maxPad = 0;
    for (const sub of o.subs) { const sz = sub.size !== undefined ? sub.size : o.size; if (sz / 2 + 2 > maxPad) maxPad = sz / 2 + 2; }
    b = { x: minX - maxPad, y: minY - maxPad, w: maxX - minX + maxPad * 2, h: maxY - minY + maxPad * 2 };
  } else if (o.type === 'line') {
    const x1 = Math.min(o.x1, o.x2), y1 = Math.min(o.y1, o.y2), x2 = Math.max(o.x1, o.x2), y2 = Math.max(o.y1, o.y2);
    const pad = o.size / 2 + 2;
    b = { x: x1 - pad, y: y1 - pad, w: x2 - x1 + pad * 2, h: y2 - y1 + pad * 2 };
  } else if (o.type === 'rect' || o.type === 'circle') {
    const x1 = Math.min(o.x1, o.x2), y1 = Math.min(o.y1, o.y2), x2 = Math.max(o.x1, o.x2), y2 = Math.max(o.y1, o.y2);
    const pad = (o.size || 0) / 2 + 2;
    b = { x: x1 - pad, y: y1 - pad, w: (x2 - x1 || 1) + pad * 2, h: (y2 - y1 || 1) + pad * 2 };
  } else if (o.type === 'fill') b = { x: 0, y: 0, w: S.w, h: S.h };
  else if (o.type === 'text') {
    const lines = (o.text || '').split('\n');
    const h = lines.length * o.size * 1.3;
    const w = Math.max(...lines.map(l => l.length)) * o.size * 0.6;
    b = { x: o.x - 2, y: o.y - 2, w: w + 4, h: h + 4 };
  } else if (o.type === 'group' && o.children) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of o.children) {
      const cb = getObjBounds(c);
      minX = Math.min(minX, cb.x); minY = Math.min(minY, cb.y);
      maxX = Math.max(maxX, cb.x + cb.w); maxY = Math.max(maxY, cb.y + cb.h);
    }
    b = { x: minX === Infinity ? 0 : minX, y: minY === Infinity ? 0 : minY, w: maxX === -Infinity ? 0 : maxX - minX, h: maxY === -Infinity ? 0 : maxY - minY };
  } else b = { x: 0, y: 0, w: 0, h: 0 };
  // Rotate bounds if object has angle
  if (o.angle) {
    const c = getObjCenter(o);
    const cos = Math.cos(o.angle), sin = Math.sin(o.angle);
    const corners = [
      { x: b.x, y: b.y }, { x: b.x + b.w, y: b.y },
      { x: b.x, y: b.y + b.h }, { x: b.x + b.w, y: b.y + b.h },
    ];
    let mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
    for (const cr of corners) {
      const rx = c.x + (cr.x - c.x) * cos - (cr.y - c.y) * sin;
      const ry = c.y + (cr.x - c.x) * sin + (cr.y - c.y) * cos;
      if (rx < mnX) mnX = rx; if (ry < mnY) mnY = ry;
      if (rx > mxX) mxX = rx; if (ry > mxY) mxY = ry;
    }
    b = { x: mnX, y: mnY, w: mxX - mnX, h: mxY - mnY };
  }
  return b;
}

function frameHash(fi, layerId) {
  const f = S.frames[fi];
  return f ? frameHashContent(f.o[layerId] || []) : 'empty';
}
function frameHashContent(objs) {
  if (!objs || !objs.length) return 'empty';
  const parts = [];
  parts.push('N' + objs.length);
  for (let oi = 0; oi < objs.length; oi++) {
    const o = objs[oi];
    parts.push(o.type);
    if (o.size != null) parts.push('sz' + o.size.toFixed(1));
    if (o.color) parts.push('c' + o.color);
    if (o.opacity != null) parts.push('op' + o.opacity.toFixed(2));
    if (o.text) parts.push('txt' + o.text);
    if (o.x1 != null) parts.push('x1' + o.x1.toFixed(1) + 'y1' + o.y1.toFixed(1) + 'x2' + o.x2.toFixed(1) + 'y2' + o.y2.toFixed(1));
    if (o.x != null) parts.push('x' + o.x.toFixed(1) + 'y' + o.y.toFixed(1));
    if (o.angle != null) parts.push('a' + o.angle.toFixed(3));
    if (o.pts && o.pts.length) {
      parts.push('P' + o.pts.length);
      parts.push('fp' + o.pts[0].x.toFixed(1) + ',' + o.pts[0].y.toFixed(1));
      parts.push('lp' + o.pts[o.pts.length - 1].x.toFixed(1) + ',' + o.pts[o.pts.length - 1].y.toFixed(1));
    }
    if (o.subs && o.subs.length) {
      parts.push('S' + o.subs.length);
      for (let si = 0; si < o.subs.length; si++) {
        const sub = o.subs[si];
        parts.push('ssz' + (sub.size != null ? sub.size.toFixed(1) : 'x'));
        parts.push('sc' + (sub.color || 'x'));
        if (sub.pts && sub.pts.length) {
          parts.push('sp' + sub.pts.length);
          parts.push('sfp' + sub.pts[0].x.toFixed(1) + ',' + sub.pts[0].y.toFixed(1));
        }
      }
    }
    if (o.fc) parts.push('F');
  }
  return parts.join('|');
}
function getObjCenter(o) {
  if (o.type === 'stroke' && o.pts && o.pts.length) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of o.pts) { if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; }
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  }
  if (o.type === 'stroke' && o.subs && o.subs.length) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const sub of o.subs) { for (const p of sub.pts) { if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; } }
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  }
  if (o.x1 != null) {
    const x1 = Math.min(o.x1, o.x2), x2 = Math.max(o.x1, o.x2);
    const y1 = Math.min(o.y1, o.y2), y2 = Math.max(o.y1, o.y2);
    return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
  }
  if (o.type === 'fill') return { x: S.w / 2, y: S.h / 2 };
  if (o.type === 'text') {
    const lines = (o.text || '').split('\n');
    const h = lines.length * o.size * 1.3;
    const w = Math.max(...lines.map(l => l.length)) * o.size * 0.6;
    return { x: o.x + w / 2, y: o.y + h / 2 };
  }
  return { x: 0, y: 0 };
}

let _mtxCanvas = null;
function getObjMatrix(o) {
  const c = getObjCenter(o);
  const px = o.pivotX != null ? o.pivotX : c.x;
  const py = o.pivotY != null ? o.pivotY : c.y;
  const sx = o.scaleX != null ? o.scaleX : 1;
  const sy = o.scaleY != null ? o.scaleY : 1;
  const angle = o.angle || 0;
  const skx = o.skewX || 0;
  const sky = o.skewY || 0;
  if (!angle && !skx && !sky && sx === 1 && sy === 1) {
    return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  }
  if (!_mtxCanvas) _mtxCanvas = document.createElement('canvas');
  const ctx = _mtxCanvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.translate(px, py);
  ctx.rotate(angle);
  ctx.transform(1, Math.tan(sky), Math.tan(skx), 1, 0, 0);
  ctx.scale(sx, sy);
  ctx.translate(-px, -py);
  const m = ctx.getTransform();
  return { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f };
}
function hasTransform(o) {
  return o && ((o.scaleX != null && o.scaleX !== 1) || (o.scaleY != null && o.scaleY !== 1) || (o.angle && o.angle !== 0) || (o.skewX && o.skewX !== 0) || (o.skewY && o.skewY !== 0) || (o.pivotX != null) || (o.pivotY != null));
}
function getObjBaseBounds(o) {
  let b;
  if (o.type === 'stroke' && o.pts && o.pts.length) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of o.pts) { if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; }
    const pad = o.size / 2 + 2;
    b = { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
  } else if (o.type === 'stroke' && o.subs && o.subs.length) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const sub of o.subs) { for (const p of sub.pts) { if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; } }
    let maxPad = 0;
    for (const sub of o.subs) { const sz = sub.size !== undefined ? sub.size : o.size; if (sz / 2 + 2 > maxPad) maxPad = sz / 2 + 2; }
    b = { x: minX - maxPad, y: minY - maxPad, w: maxX - minX + maxPad * 2, h: maxY - minY + maxPad * 2 };
  } else if (o.type === 'line') {
    const x1 = Math.min(o.x1, o.x2), y1 = Math.min(o.y1, o.y2), x2 = Math.max(o.x1, o.x2), y2 = Math.max(o.y1, o.y2);
    const pad = o.size / 2 + 2;
    b = { x: x1 - pad, y: y1 - pad, w: x2 - x1 + pad * 2, h: y2 - y1 + pad * 2 };
  } else if (o.type === 'rect' || o.type === 'circle') {
    const x1 = Math.min(o.x1, o.x2), y1 = Math.min(o.y1, o.y2), x2 = Math.max(o.x1, o.x2), y2 = Math.max(o.y1, o.y2);
    const pad = (o.size || 0) / 2 + 2;
    b = { x: x1 - pad, y: y1 - pad, w: (x2 - x1 || 1) + pad * 2, h: (y2 - y1 || 1) + pad * 2 };
  } else if (o.type === 'fill') b = { x: 0, y: 0, w: S.w, h: S.h };
  else if (o.type === 'text') {
    const lines = (o.text || '').split('\n');
    const h = lines.length * o.size * 1.3;
    const w = Math.max(...lines.map(l => l.length)) * o.size * 0.6;
    b = { x: o.x - 2, y: o.y - 2, w: w + 4, h: h + 4 };
  } else if (o.type === 'group' && o.children) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of o.children) {
      const cb = getObjBaseBounds(c);
      minX = Math.min(minX, cb.x); minY = Math.min(minY, cb.y);
      maxX = Math.max(maxX, cb.x + cb.w); maxY = Math.max(maxY, cb.y + cb.h);
    }
    b = { x: minX === Infinity ? 0 : minX, y: minY === Infinity ? 0 : minY, w: maxX === -Infinity ? 0 : maxX - minX, h: maxY === -Infinity ? 0 : maxY - minY };
  } else b = { x: 0, y: 0, w: 0, h: 0 };
  return b;
}
function getObjBounds(o) {
  let b = getObjBaseBounds(o);
  if (hasTransform(o)) {
    const m = getObjMatrix(o);
    const corners = [
      { x: b.x, y: b.y },
      { x: b.x + b.w, y: b.y },
      { x: b.x, y: b.y + b.h },
      { x: b.x + b.w, y: b.y + b.h },
    ];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const cr of corners) {
      const rx = m.a * cr.x + m.c * cr.y + m.e;
      const ry = m.b * cr.x + m.d * cr.y + m.f;
      if (rx < minX) minX = rx; if (ry < minY) minY = ry;
      if (rx > maxX) maxX = rx; if (ry > maxY) maxY = ry;
    }
    b = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  return b;
}

function inverseTransformPoint(p, m) {
  const det = m.a * m.d - m.b * m.c;
  if (Math.abs(det) < 1e-10) return p;
  const invDet = 1 / det;
  return {
    x: invDet * (m.d * (p.x - m.e) - m.c * (p.y - m.f)),
    y: invDet * (-m.b * (p.x - m.e) + m.a * (p.y - m.f))
  };
}

function hitTest(p) {
  // Check ALL visible layers, topmost layer first, topmost object first
  for (let li = S.layers.length - 1; li >= 0; li--) {
    const l = S.layers[li];
    if (!l.vis) continue;
    const objs = obs(S.frameIdx, l.id);
    for (let i = objs.length - 1; i >= 0; i--) {
      const o = objs[i];
      if (o.type === 'stroke' && o.composite === 'destination-out') continue;
      const b = getObjBounds(o);
      if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) {
        // For transformed objects, transform mouse to base coords for accurate hit test
        const m = hasTransform(o) ? getObjMatrix(o) : null;
        const tp = m ? inverseTransformPoint(p, m) : p;
        if (o.type === 'stroke') {
          const ptsArr = o.subs && o.subs.length ? o.subs.map(s => s.pts) : (o.pts ? [o.pts] : []);
          let hit = false;
          for (const pts of ptsArr) {
            for (let j = 0; j < pts.length - 1; j++) {
              const dx = pts[j + 1].x - pts[j].x;
              const dy = pts[j + 1].y - pts[j].y;
              const len = dx * dx + dy * dy;
              if (len === 0) { if (Math.abs(tp.x - pts[j].x) + Math.abs(tp.y - pts[j].y) < 8) { hit = true; break; } continue; }
              let t = ((tp.x - pts[j].x) * dx + (tp.y - pts[j].y) * dy) / len;
              t = Math.max(0, Math.min(1, t));
              const cx = pts[j].x + t * dx;
              const cy = pts[j].y + t * dy;
              if ((tp.x - cx) ** 2 + (tp.y - cy) ** 2 < 64) { hit = true; break; }
            }
            if (hit) break;
          }
          if (hit) return { layerId: l.id, idx: i };
        } else if (o.type === 'rect' || o.type === 'fill') {
          const tol = (o.size || 0) / 2 + 3;
          const x1 = Math.min(o.x1, o.x2), x2 = Math.max(o.x1, o.x2);
          const y1 = Math.min(o.y1, o.y2), y2 = Math.max(o.y1, o.y2);
          const inside = tp.x >= x1 - tol && tp.x <= x2 + tol && tp.y >= y1 - tol && tp.y <= y2 + tol;
          if (inside) return { layerId: l.id, idx: i };
        } else if (o.type === 'circle') {
          const cx = (o.x1 + o.x2) / 2, cy = (o.y1 + o.y2) / 2;
          const rx = Math.abs(o.x2 - o.x1) / 2, ry = Math.abs(o.y2 - o.y1) / 2;
          const tol = (o.size || 0) / 2 + 3;
          const d = ((tp.x - cx) / (rx + tol)) ** 2 + ((tp.y - cy) / (ry + tol)) ** 2;
          if (d <= 1) return { layerId: l.id, idx: i };
        } else if (o.type === 'line') {
          const dx = o.x2 - o.x1, dy = o.y2 - o.y1;
          const len2 = dx * dx + dy * dy;
          let t = len2 > 0 ? ((tp.x - o.x1) * dx + (tp.y - o.y1) * dy) / len2 : 0;
          t = Math.max(0, Math.min(1, t));
          const cx = o.x1 + t * dx, cy = o.y1 + t * dy;
          const tol = (o.size || 0) / 2 + 6;
          if ((tp.x - cx) ** 2 + (tp.y - cy) ** 2 < tol * tol) return { layerId: l.id, idx: i };
        } else if (o.type === 'text') {
          return { layerId: l.id, idx: i };
        } else if (o.type === 'group') {
          return { layerId: l.id, idx: i };
        } else {
          return { layerId: l.id, idx: i };
        }
      }
    }
  }
  return null;
}

const HANDLE_SIZE = 6;
const ROTATE_ZONE_RADIUS = 35;
const SKEW_ZONE_DISTANCE = 14;

function getObjTransformedCorners(o) {
  const bb = getObjBaseBounds(o);
  if (!hasTransform(o)) {
    return [
      { x: bb.x, y: bb.y },
      { x: bb.x + bb.w, y: bb.y },
      { x: bb.x + bb.w, y: bb.y + bb.h },
      { x: bb.x, y: bb.y + bb.h },
    ];
  }
  const m = getObjMatrix(o);
  const corners = [
    { x: bb.x, y: bb.y },
    { x: bb.x + bb.w, y: bb.y },
    { x: bb.x + bb.w, y: bb.y + bb.h },
    { x: bb.x, y: bb.y + bb.h },
  ];
  return corners.map(c => ({
    x: m.a * c.x + m.c * c.y + m.e,
    y: m.b * c.x + m.d * c.y + m.f,
  }));
}

function getTransformedHandles(o) {
  const tc = getObjTransformedCorners(o);
  const nw = tc[0], ne = tc[1], se = tc[2], sw = tc[3];
  return [
    { x: nw.x, y: nw.y, name: 'nw', type: 'corner' },
    { x: (nw.x + ne.x) / 2, y: (nw.y + ne.y) / 2, name: 'n', type: 'edge-h' },
    { x: ne.x, y: ne.y, name: 'ne', type: 'corner' },
    { x: (ne.x + se.x) / 2, y: (ne.y + se.y) / 2, name: 'e', type: 'edge-v' },
    { x: se.x, y: se.y, name: 'se', type: 'corner' },
    { x: (se.x + sw.x) / 2, y: (se.y + sw.y) / 2, name: 's', type: 'edge-h' },
    { x: sw.x, y: sw.y, name: 'sw', type: 'corner' },
    { x: (sw.x + nw.x) / 2, y: (sw.y + nw.y) / 2, name: 'w', type: 'edge-v' },
  ];
}

function getHandles(b) {
  return [
    { x: b.x, y: b.y, name: 'nw', type: 'corner' },
    { x: b.x + b.w / 2, y: b.y, name: 'n', type: 'edge-h' },
    { x: b.x + b.w, y: b.y, name: 'ne', type: 'corner' },
    { x: b.x + b.w, y: b.y + b.h / 2, name: 'e', type: 'edge-v' },
    { x: b.x + b.w, y: b.y + b.h, name: 'se', type: 'corner' },
    { x: b.x + b.w / 2, y: b.y + b.h, name: 's', type: 'edge-h' },
    { x: b.x, y: b.y + b.h, name: 'sw', type: 'corner' },
    { x: b.x, y: b.y + b.h / 2, name: 'w', type: 'edge-v' },
  ];
}

function hitHandle(p) {
  if (!selObj()) return null;
  const objs = obs(S.frameIdx, selObj().layerId);
  const o = objs[selObj().idx];
  if (!o) return null;
  const c = getObjCenter(o);
  const px = o.pivotX != null ? o.pivotX : c.x;
  const py = o.pivotY != null ? o.pivotY : c.y;
  const m = hasTransform(o) ? getObjMatrix(o) : { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const pivotWorldX = m.a * px + m.c * py + m.e;
  const pivotWorldY = m.b * px + m.d * py + m.f;
  if ((p.x - pivotWorldX) ** 2 + (p.y - pivotWorldY) ** 2 < 64) return 'pivot';
  const handles = getTransformedHandles(o);
  const tc = getObjTransformedCorners(o);
  for (const h of handles) {
    const dx = p.x - h.x, dy = p.y - h.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (h.type === 'corner') {
      if (dist < HANDLE_SIZE) return h.name;
      if (dist < ROTATE_ZONE_RADIUS) return 'rotate:' + h.name;
    } else {
      const cornerIdx = { 'n': 0, 'e': 1, 's': 2, 'w': 3 };
      const ci = cornerIdx[h.name];
      const c1 = tc[ci], c2 = tc[(ci + 1) % 4];
      const ex = c2.x - c1.x, ey = c2.y - c1.y;
      const elen = Math.sqrt(ex * ex + ey * ey);
      if (elen < 0.1) continue;
      const t = ((p.x - c1.x) * ex + (p.y - c1.y) * ey) / (elen * elen);
      const clampedT = Math.max(0, Math.min(1, t));
      const projX = c1.x + clampedT * ex;
      const projY = c1.y + clampedT * ey;
      const perpDist = Math.sqrt((p.x - projX) ** 2 + (p.y - projY) ** 2);
      if (perpDist < HANDLE_SIZE) return h.name;
      if (perpDist < SKEW_ZONE_DISTANCE) return 'skew:' + h.name;
    }
  }
  return null;
}

function applyDelta(dx, dy) {
  if (!selObj()) return;
  const layerId = selObj().layerId || (L() && L().id);
  if (!layerId) return;
  const objs = obs(S.frameIdx, layerId);
  const o = objs[selObj().idx];
  if (!o) return;
  if (o.type === 'stroke' && o.pts) {
    for (const p of o.pts) { p.x += dx; p.y += dy; }
  } else if (o.x1 != null) {
    o.x1 += dx; o.y1 += dy; o.x2 += dx; o.y2 += dy;
  }
}

function applyResize(dx, dy, handle) {
  if (!selObj()) return;
  const layerId = selObj().layerId || (L() && L().id);
  if (!layerId) return;
  const objs = obs(S.frameIdx, layerId);
  const o = objs[selObj().idx];
  if (!o) return;
  
  const b = getObjBounds(o);
  let nx = b.x, ny = b.y, nw = b.w, nh = b.h;
  if (handle.includes('e')) { nw = Math.max(2, b.w + (handle === 'e' ? dx : handle === 'ne' || handle === 'se' ? dx : 0)); }
  if (handle.includes('w')) { nx = b.x + dx; nw = Math.max(2, b.w - dx); }
  if (handle.includes('s')) { nh = Math.max(2, b.h + (handle === 's' ? dy : handle === 'se' || handle === 'sw' ? dy : 0)); }
  if (handle.includes('n')) { ny = b.y + dy; nh = Math.max(2, b.h - dy); }

  const sx = b.w > 0 ? nw / b.w : 1, sy = b.h > 0 ? nh / b.h : 1;
  const scale = Math.max(sx, sy);
  if (o.type === 'stroke') {
    if (o.pts) for (const p of o.pts) { p.x = nx + (p.x - b.x) * sx; p.y = ny + (p.y - b.y) * sy; }
    if (o.subs) for (const sub of o.subs) {
      for (const p of sub.pts) { p.x = nx + (p.x - b.x) * sx; p.y = ny + (p.y - b.y) * sy; }
      if (sub.size != null) sub.size *= scale;
    }
    if (o.size != null) o.size *= scale;
  } else if (o.x1 != null) {
    o.x1 = nx + (o.x1 - b.x) * sx; o.y1 = ny + (o.y1 - b.y) * sy;
    o.x2 = nx + (o.x2 - b.x) * sx; o.y2 = ny + (o.y2 - b.y) * sy;
    if (o.size != null) o.size *= scale;
  }
}

function drawSelection() {
  octx.clearRect(0, 0, overlay.width, overlay.height);
  if (!S.selObjs.length) return;
  const bs = bufScale();
  octx.save();
  if (bs !== 1) octx.scale(bs, bs);
  for (const ref of S.selObjs) {
    const objs = obs(S.frameIdx, ref.layerId);
    const o = objs[ref.idx];
    if (!o) continue;
    // For single selection, draw transformed bounding box later; for multi, draw AABB
    if (S.selObjs.length > 1) {
      const b = getObjBounds(o);
      octx.strokeStyle = '#0f8';
      octx.lineWidth = 1;
      octx.setLineDash([4, 3]);
      octx.strokeRect(b.x, b.y, b.w, b.h);
      octx.setLineDash([]);
    }
  }
  if (S.selObjs.length !== 1) { octx.restore(); return; }
  const ref = S.selObjs[0];
  const objs = obs(S.frameIdx, ref.layerId);
  const o = objs[ref.idx];
  if (!o) { octx.restore(); return; }
  const tc = getObjTransformedCorners(o);
  // Draw transformed bounding box (quadrilateral)
  octx.strokeStyle = S.selObjs.length > 1 ? '#0f8' : '#0af';
  octx.lineWidth = 1;
  octx.setLineDash([4, 3]);
  octx.beginPath();
  octx.moveTo(tc[0].x, tc[0].y);
  for (let i = 1; i < tc.length; i++) octx.lineTo(tc[i].x, tc[i].y);
  octx.closePath();
  octx.stroke();
  octx.setLineDash([]);
  // Pivot point
  const c = getObjCenter(o);
  const px = o.pivotX != null ? o.pivotX : c.x;
  const py = o.pivotY != null ? o.pivotY : c.y;
  const m = hasTransform(o) ? getObjMatrix(o) : { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const pwx = m.a * px + m.c * py + m.e;
  const pwy = m.b * px + m.d * py + m.f;
  octx.strokeStyle = '#f80';
  octx.lineWidth = 1;
  octx.beginPath();
  octx.moveTo(pwx - 8, pwy); octx.lineTo(pwx + 8, pwy);
  octx.moveTo(pwx, pwy - 8); octx.lineTo(pwx, pwy + 8);
  octx.stroke();
  octx.beginPath();
  octx.arc(pwx, pwy, 3, 0, Math.PI * 2);
  octx.fillStyle = '#f80';
  octx.fill();
  // Corner handles + rotate zones (use transformed positions)
  const handles = getTransformedHandles(o);
  for (const h of handles) {
    if (h.type === 'corner') {
      octx.fillStyle = '#fff';
      octx.strokeStyle = '#0af';
      octx.lineWidth = 1;
      octx.fillRect(h.x - HANDLE_SIZE / 2, h.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
      octx.strokeRect(h.x - HANDLE_SIZE / 2, h.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
    } else {
      octx.fillStyle = '#fff';
      octx.strokeStyle = '#0af';
      octx.lineWidth = 1;
      const hw = Math.min(10, 12);
      const hh = HANDLE_SIZE;
      octx.fillRect(h.x - hw / 2, h.y - hh / 2, hw, hh);
      octx.strokeRect(h.x - hw / 2, h.y - hh / 2, hw, hh);
    }
  }
  if (S.rotateReadyCorner && !S.selMode) {
    const readyHandle = handles.find(h => h.name === S.rotateReadyCorner);
    if (readyHandle && S.rotateReadyMouse) {
      const mx = S.rotateReadyMouse.x;
      const my = S.rotateReadyMouse.y;
      const angle = Math.atan2(my - readyHandle.y, mx - readyHandle.x);
      const sweep = 0.35;
      const r = ROTATE_ZONE_RADIUS;
      octx.beginPath();
      octx.arc(readyHandle.x, readyHandle.y, r, angle - sweep, angle + sweep);
      octx.strokeStyle = 'rgba(0, 170, 255, 0.6)';
      octx.lineWidth = 2;
      octx.stroke();
    }
  }
  octx.restore();
}

// ---- Alignment tools ----
function alignObject(mode) {
  if (!selObj()) return;
  const l = L();
  if (!l) return;
  const objs = obs(S.frameIdx, l.id);
  const o = objs[selObj().idx];
  if (!o) return;
  const b = getObjBounds(o);
  let dx = 0, dy = 0;
  switch (mode) {
    case 'left': dx = -b.x; break;
    case 'center-h': dx = (S.w - b.w) / 2 - b.x; break;
    case 'right': dx = (S.w - b.w) - b.x; break;
    case 'top': dy = -b.y; break;
    case 'center-v': dy = (S.h - b.h) / 2 - b.y; break;
    case 'bottom': dy = (S.h - b.h) - b.y; break;
  }
  if (dx !== 0 || dy !== 0) {
    saveSnapshot();
    if (o.type === 'stroke' && o.pts) {
      for (const p of o.pts) { p.x += dx; p.y += dy; }
      if (o.subs) for (const sub of o.subs) for (const p of sub.pts) { p.x += dx; p.y += dy; }
    } else if (o.x1 != null) {
      o.x1 += dx; o.y1 += dy; o.x2 += dx; o.y2 += dy;
    }
    dirtyCache(); render(); drawSelection(); saveSnapshot();
  }
}

// Move object by (dx, dy) — handles all object types
function moveObjBy(o, dx, dy) {
  if (!o || (dx === 0 && dy === 0)) return;
  if (o.type === 'stroke') {
    if (o.pts) for (const p of o.pts) { p.x += dx; p.y += dy; }
    if (o.subs) for (const sub of o.subs) for (const p of sub.pts) { p.x += dx; p.y += dy; }
  } else if (o.type === 'text') {
    o.x += dx; o.y += dy;
  } else if (o.type === 'fill') {
    if (o.fc) { o.fc.x += dx; o.fc.y += dy; }
  } else if (o.type === 'group' && o.children) {
    for (const child of o.children) moveObjBy(child, dx, dy);
  } else if (o.pts) {
    for (const p of o.pts) { p.x += dx; p.y += dy; }
  }
  if (o.x1 != null) { o.x1 += dx; o.y1 += dy; o.x2 += dx; o.y2 += dy; }
  if (o.pivotX != null) o.pivotX += dx;
  if (o.pivotY != null) o.pivotY += dy;
}

function cloneObj(o) {
  const c = {};
  for (const k of Object.keys(o)) {
    if (k === 'pts') c.pts = o.pts.map(p => ({ x: p.x, y: p.y, ...(p.p !== undefined ? { p: p.p } : {}) }));
    else if (k === 'subs') c.subs = o.subs.map(sub => ({ ...sub, pts: sub.pts.map(p => ({ x: p.x, y: p.y, ...(p.p !== undefined ? { p: p.p } : {}) })) }));
    else if (k === 'children') c.children = o.children.map(child => cloneObj(child));
    else if (k === 'fc' && o.fc) {
      const canvas = document.createElement('canvas');
      canvas.width = o.fc.width; canvas.height = o.fc.height;
      canvas.getContext('2d').drawImage(o.fc, 0, 0);
      c.fc = canvas;
    }
    else c[k] = o[k];
  }
  return c;
}

let _marqueeStart = null, _marqueeEnd = null;

let _multiSelInits = new Map(); // key: "layerId:idx" -> cloned obj

function selDown(p, ctrl, alt) {
  S.rotateReadyCorner = null; S.rotateReadyMouse = null;
  // Handle hit only for single selection
  if (S.selObjs.length === 1) {
    const h = hitHandle(p);
    if (h) {
      S.dragStart = { x: p.x, y: p.y };
      const l = L(); const objs = obs(S.frameIdx, l.id);
      S.selInit = cloneObj(objs[selObj().idx]);
      if (h === 'pivot') {
        S.selMode = 'pivot';
        S.resizeHandle = null;
        return;
      }
      if (h.startsWith('rotate:')) {
        S.selMode = 'rotate';
        S.resizeHandle = h.split(':')[1];
        return;
      }
      if (h.startsWith('skew:')) {
        S.selMode = 'skew';
        S.resizeHandle = h.split(':')[1];
        const o = objs[selObj().idx];
        const c = getObjCenter(o);
        if (o.pivotX == null) { o.pivotX = c.x; o.pivotY = c.y; }
        S.selInit = cloneObj(o);
        return;
      }
      S.selMode = 'scale';
      S.resizeHandle = h;
      S.selBounds = getObjBounds(S.selInit);
      S.selBaseBounds = getObjBaseBounds(S.selInit);
      const bb = S.selBaseBounds;
      let anchorX = bb.x + bb.w / 2, anchorY = bb.y + bb.h / 2;
      if (!alt) {
        const rh = S.resizeHandle;
        if (rh.includes('w')) anchorX = bb.x + bb.w;
        if (rh.includes('e')) anchorX = bb.x;
        if (rh.includes('n')) anchorY = bb.y + bb.h;
        if (rh.includes('s')) anchorY = bb.y;
      }
      S.selPivotAnchor = { x: anchorX, y: anchorY };
      const initM = getObjMatrix(S.selInit);
      S.selAnchorWorld = {
        x: initM.a * anchorX + initM.c * anchorY + initM.e,
        y: initM.b * anchorX + initM.d * anchorY + initM.f
      };
      return;
    }
  }
  const hit = hitTest(p);
  if (hit) {
    if (ctrl) { addSel(hit); }
    else { setSel(hit); }
    // Switch to the layer that owns the hit object
    if (!ctrl) {
      const li = S.layers.findIndex(l => l.id === hit.layerId);
      if (li >= 0) { setActiveLayerByIndex(li); updateTL(); }
    } else {
      toggleLayerSelection(hit.layerId);
      updateTL();
    }
    S.selMode = 'move';
    S.dragStart = { x: p.x, y: p.y };
    // Store initial positions for all selected objects
    _multiSelInits = new Map();
    for (const ref of S.selObjs) {
      const objs = obs(S.frameIdx, ref.layerId);
      _multiSelInits.set(`${ref.layerId}:${ref.idx}`, cloneObj(objs[ref.idx]));
    }
    S.selInit = _multiSelInits.size ? cloneObj(obs(S.frameIdx, S.selObjs[0].layerId)[S.selObjs[0].idx]) : null;
    drawSelection();
    return;
  }
  // Start marquee selection
  clearSel();
  _marqueeStart = { x: p.x, y: p.y };
  octx.clearRect(0, 0, overlay.width, overlay.height);
}

function selMove(p, e) {
  if (S.selMode === 'move' && S.selObjs.length && _multiSelInits.size) {
    const dx = p.x - S.dragStart.x, dy = p.y - S.dragStart.y;
    for (const ref of S.selObjs) {
      const objs = obs(S.frameIdx, ref.layerId);
      const o = objs[ref.idx];
      const init = _multiSelInits.get(`${ref.layerId}:${ref.idx}`);
      if (!o || !init) continue;
      if (o.type === 'stroke') {
        if (init.pts) o.pts = init.pts.map(pt => ({ x: pt.x + dx, y: pt.y + dy, ...(pt.p !== undefined ? { p: pt.p } : {}) }));
        if (init.subs) o.subs = init.subs.map(sub => ({ ...sub, pts: sub.pts.map(pt => ({ x: pt.x + dx, y: pt.y + dy, ...(pt.p !== undefined ? { p: pt.p } : {}) })) }));
      } else if (o.type === 'group' && init.children) {
        for (let ci = 0; ci < o.children.length; ci++) {
          const child = o.children[ci];
          const cinit = init.children[ci];
          if (!child || !cinit) continue;
          if (child.type === 'stroke') {
            if (cinit.pts) child.pts = cinit.pts.map(pt => ({ x: pt.x + dx, y: pt.y + dy, ...(pt.p !== undefined ? { p: pt.p } : {}) }));
            if (cinit.subs) child.subs = cinit.subs.map(sub => ({ ...sub, pts: sub.pts.map(pt => ({ x: pt.x + dx, y: pt.y + dy, ...(pt.p !== undefined ? { p: pt.p } : {}) })) }));
          } else if (child.x1 != null) {
            child.x1 = cinit.x1 + dx; child.y1 = cinit.y1 + dy;
            child.x2 = cinit.x2 + dx; child.y2 = cinit.y2 + dy;
          } else if (child.type === 'text') {
            child.x = cinit.x + dx; child.y = cinit.y + dy;
          }
          if (cinit.pivotX != null) child.pivotX = cinit.pivotX + dx;
          if (cinit.pivotY != null) child.pivotY = cinit.pivotY + dy;
        }
      } else if (o.x1 != null) {
        o.x1 = init.x1 + dx; o.y1 = init.y1 + dy;
        o.x2 = init.x2 + dx; o.y2 = init.y2 + dy;
      } else if (o.type === 'text') {
        o.x = init.x + dx; o.y = init.y + dy;
      }
      if (init.pivotX != null) o.pivotX = init.pivotX + dx;
      if (init.pivotY != null) o.pivotY = init.pivotY + dy;
    }
    dirtyCache(); render(); drawSelection();
  } else if (S.selMode === 'scale' && selObj() && S.resizeHandle && S.selInit) {
    const l = L(); const objs = obs(S.frameIdx, l.id);
    const o = objs[selObj().idx];
    if (!o) return;
    const bb = S.selBaseBounds;
    const anchor = S.selPivotAnchor;
    const initM = getObjMatrix(S.selInit);
    const det = initM.a * initM.d - initM.b * initM.c;
    if (Math.abs(det) < 1e-10) return;
    const invDet = 1 / det;
    const mouseBaseX = invDet * (initM.d * (p.x - initM.e) - initM.c * (p.y - initM.f));
    const mouseBaseY = invDet * (-initM.b * (p.x - initM.e) + initM.a * (p.y - initM.f));
    const rh = S.resizeHandle;
    let hbx = bb.x + bb.w / 2, hby = bb.y + bb.h / 2;
    if (rh.includes('w')) hbx = bb.x;
    if (rh.includes('e')) hbx = bb.x + bb.w;
    if (rh.includes('n')) hby = bb.y;
    if (rh.includes('s')) hby = bb.y + bb.h;
    const dx = hbx - anchor.x, dy = hby - anchor.y;
    let sx = 1, sy = 1;
    if (Math.abs(dx) > 0.1) sx = (mouseBaseX - anchor.x) / dx;
    if (Math.abs(dy) > 0.1) sy = (mouseBaseY - anchor.y) / dy;
    sx = Math.max(0.01, Math.abs(sx));
    sy = Math.max(0.01, Math.abs(sy));
    if (e && e.shiftKey) {
      const s = Math.max(sx, sy);
      sx = sy = s;
    }
    o.scaleX = (S.selInit.scaleX || 1) * sx;
    o.scaleY = (S.selInit.scaleY || 1) * sy;
    const wa = S.selAnchorWorld;
    const a = anchor;
    const a11 = initM.a, a12 = initM.c, a21 = initM.b, a22 = initM.d;
    const m11 = 1 - a11 * sx;
    const m12 = -a12 * sy;
    const m21 = -a21 * sx;
    const m22 = 1 - a22 * sy;
    const rhsX = wa.x - (a11 * sx * a.x + a12 * sy * a.y);
    const rhsY = wa.y - (a21 * sx * a.x + a22 * sy * a.y);
    const mDet = m11 * m22 - m12 * m21;
    if (Math.abs(mDet) > 1e-10) {
      o.pivotX = (m22 * rhsX - m12 * rhsY) / mDet;
      o.pivotY = (-m21 * rhsX + m11 * rhsY) / mDet;
    } else {
      o.pivotX = a.x;
      o.pivotY = a.y;
    }
    dirtyCache(); render(); drawSelection();
  } else if (S.selMode === 'rotate' && selObj() && S.selInit) {
    const l = L(); const objs = obs(S.frameIdx, l.id);
    const o = objs[selObj().idx];
    if (!o) return;
    const c = getObjCenter(o);
    const px = o.pivotX != null ? o.pivotX : c.x;
    const py = o.pivotY != null ? o.pivotY : c.y;
    const m = getObjMatrix(o);
    const pivotWorldX = m.a * px + m.c * py + m.e;
    const pivotWorldY = m.b * px + m.d * py + m.f;
    const startAngle = Math.atan2(S.dragStart.y - pivotWorldY, S.dragStart.x - pivotWorldX);
    const currentAngle = Math.atan2(p.y - pivotWorldY, p.x - pivotWorldX);
    let da = currentAngle - startAngle;
    if (e && e.shiftKey) {
      const step = Math.PI / 4;
      da = Math.round(da / step) * step;
    }
    o.angle = (S.selInit.angle || 0) + da;
    dirtyCache(); render(); drawSelection();
  } else if (S.selMode === 'skew' && selObj() && S.selInit) {
    const l = L(); const objs = obs(S.frameIdx, l.id);
    const o = objs[selObj().idx];
    if (!o) return;
    o.pivotX = S.selInit.pivotX;
    o.pivotY = S.selInit.pivotY;
    const dx = p.x - S.dragStart.x, dy = p.y - S.dragStart.y;
    const rh = S.resizeHandle;
    const factor = 0.005;
    if (rh === 'n' || rh === 's') {
      o.skewX = (S.selInit.skewX || 0) + dx * factor;
    } else if (rh === 'e' || rh === 'w') {
      o.skewY = (S.selInit.skewY || 0) + dy * factor;
    }
    dirtyCache(); render(); drawSelection();
  } else if (S.selMode === 'pivot' && selObj() && S.selInit) {
    const l = L(); const objs = obs(S.frameIdx, l.id);
    const o = objs[selObj().idx];
    if (!o) return;
    // Convert world mouse to base coords using initial matrix inverse
    const initM = getObjMatrix(S.selInit);
    const det = initM.a * initM.d - initM.b * initM.c;
    if (Math.abs(det) < 1e-10) return;
    const invDet = 1 / det;
    const pbx = invDet * (initM.d * (p.x - initM.e) - initM.c * (p.y - initM.f));
    const pby = invDet * (-initM.b * (p.x - initM.e) + initM.a * (p.y - initM.f));
    o.pivotX = pbx;
    o.pivotY = pby;
    dirtyCache(); render(); drawSelection();
  } else if (_marqueeStart) {
    _marqueeEnd = { x: p.x, y: p.y };
    const bs = bufScale();
    octx.clearRect(0, 0, overlay.width, overlay.height);
    octx.save();
    if (bs !== 1) octx.scale(bs, bs);
    const x = Math.min(_marqueeStart.x, p.x), y = Math.min(_marqueeStart.y, p.y);
    const w = Math.abs(p.x - _marqueeStart.x), h = Math.abs(p.y - _marqueeStart.y);
    octx.strokeStyle = '#0af';
    octx.lineWidth = 1;
    octx.setLineDash([4, 3]);
    octx.strokeRect(x, y, w, h);
    octx.setLineDash([]);
    octx.fillStyle = 'rgba(0,170,255,0.08)';
    octx.fillRect(x, y, w, h);
    octx.restore();
  } else if (!selObj()) {
    octx.clearRect(0, 0, overlay.width, overlay.height);
  }
}

function selUp() {
  if (_marqueeStart) {
    const p1 = _marqueeStart, p2 = _marqueeEnd || p1;
    _marqueeStart = null; _marqueeEnd = null;
    octx.clearRect(0, 0, overlay.width, overlay.height);
    const mx = Math.min(p1.x, p2.x), my = Math.min(p1.y, p2.y);
    const mw = Math.abs(p2.x - p1.x), mh = Math.abs(p2.y - p1.y);
    // Only select if dragged more than 5px
    if (mw > 5 || mh > 5) {
      S.selObjs = [];
      for (const l of S.layers) {
        if (!l.vis) continue;
        const objs = obs(S.frameIdx, l.id);
        for (let i = 0; i < objs.length; i++) {
          const b = getObjBounds(objs[i]);
          if (b.x < mx + mw && b.x + b.w > mx && b.y < my + mh && b.y + b.h > my) {
            S.selObjs.push({ layerId: l.id, idx: i });
          }
        }
      }
      if (S.selObjs.length) {
        S.selMode = 'move';
        _multiSelInits = new Map();
        for (const ref of S.selObjs) {
          const objs = obs(S.frameIdx, ref.layerId);
          _multiSelInits.set(`${ref.layerId}:${ref.idx}`, cloneObj(objs[ref.idx]));
        }
        S.selInit = cloneObj(obs(S.frameIdx, S.selObjs[0].layerId)[S.selObjs[0].idx]);
        drawSelection();
        return;
      }
    }
    return;
  }
  if (S.selMode) {
    saveSnapshot();
    S.selMode = null; S.resizeHandle = null; S.dragStart = null;
    S.selInit = null; S.selBounds = null; S.selBaseBounds = null; S.selPivotAnchor = null; S.selAnchorWorld = null;
    S.rotateReadyCorner = null; S.rotateReadyMouse = null;
    dirtyCache(); render(); drawSelection();
  }
}

// ==================== LAYERS UI ====================
function updateLayerUI() { updateTL(); }

function addLayer() {
  S.layers.push(mkLayer(`Layer ${S.layers.length + 1}`));
  setActiveLayerByIndex(S.layers.length - 1);
  updateLayerUI(); dirtyCache(); render();
}

function delLayer() {
  if (S.layers.length <= 1) return;
  const lid = S.layers[S.layerIdx].id;
  S.layers.splice(S.layerIdx, 1);
  S.selLayerIds.delete(lid);
  if (S.layerIdx >= S.layers.length) S.layerIdx = S.layers.length - 1;
  syncActiveLayer();
  if (S.activeLayerId != null) S.selLayerIds.add(S.activeLayerId);
  dirtyCache(); S.tlDirty = true;
  updateLayerUI(); fullRender();
}

function moveUp() {
  const i = S.layerIdx;
  if (i >= S.layers.length - 1) return;
  [S.layers[i], S.layers[i + 1]] = [S.layers[i + 1], S.layers[i]];
  S.layerIdx = i + 1;
  syncActiveLayer();
  updateLayerUI(); dirtyCache(); render();
}

function moveDown() {
  const i = S.layerIdx;
  if (i <= 0) return;
  [S.layers[i], S.layers[i - 1]] = [S.layers[i - 1], S.layers[i]];
  S.layerIdx = i - 1;
  syncActiveLayer();
  updateLayerUI(); dirtyCache(); render();
}

// ==================== TIMELINE - Adobe Animate Exact Match ====================
const TL_CELL_BASE = 10;
let tlZoom = 1;
function cellW() { return TL_CELL_BASE * tlZoom; }
let _tlDrag = null;
let _tlScrub = false;
let _selectedFrames = new Set();
let _tlRangeAnchor = -1;

function updateTL() {
  const nf = S.frames.length;
  const curL = L();

  // --- Update toolbar displays ---
  $('tl-fps-display').textContent = S.fps.toFixed(2) + ' FPS';
  $('tl-frame-num').innerHTML = (S.frameIdx + 1) + ' <sup>F</sup>';

  // --- Left: Layer list ---
  const layerList = $('tl-layer-list');
  layerList.innerHTML = '';
  for (const l of S.layers) {
    const row = document.createElement('div');
    row.className = 'tl-layer-row' + (l.id === curL.id ? ' active' : '') + (S.selLayerIds.has(l.id) ? ' selected' : '');
    row.style.borderLeft = `3px solid ${l.col}`;

    const eye = document.createElement('span');
    eye.className = 'tl-layer-icon' + (l.vis ? ' on' : '');
    eye.innerHTML = l.vis ? icons.eyeOpen : icons.eyeClosed;
    eye.title = l.vis ? 'Hide Layer' : 'Show Layer';
    eye.onclick = e => { e.stopPropagation(); l.vis = !l.vis; thisLayerUpdate(); };

    const lock = document.createElement('span');
    lock.className = 'tl-layer-icon' + (l.lock ? ' on' : '');
    lock.innerHTML = l.lock ? icons.lockLocked : icons.lockUnlocked;
    lock.title = l.lock ? 'Unlock Layer' : 'Lock Layer';
    lock.onclick = e => { e.stopPropagation(); l.lock = !l.lock; thisLayerUpdate(); };

    const outline = document.createElement('span');
    outline.className = 'tl-layer-icon';
    outline.innerHTML = icons.outline;
    outline.title = 'Outline';

    const color = document.createElement('span');
    color.className = 'tl-layer-color';
    color.style.background = l.col;

    const name = document.createElement('span');
    name.className = 'tl-layer-name';
    name.textContent = l.name;
    name.ondblclick = () => {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.value = l.name;
      inp.onblur = () => { l.name = inp.value || l.name; updateTL(); };
      inp.onkeydown = ev => { if (ev.key === 'Enter') { l.name = inp.value || l.name; updateTL(); } };
      name.replaceWith(inp); inp.focus(); inp.select();
    };

    row.oncontextmenu = e => {
      e.preventDefault();
      e.stopPropagation();
      const idx = S.layers.indexOf(l);
      showCtxMenu([
        { label: `Layer: ${l.name}`, disabled: true },
        { sep: true },
        { label: 'Rename', action: () => { S.layerIdx = idx; const sp = row.querySelector('.tl-layer-name'); if (sp) sp.dblclick(); } },
        { label: l.vis ? 'Hide' : 'Show', action: () => { l.vis = !l.vis; thisLayerUpdate(); } },
        { label: l.lock ? 'Unlock' : 'Lock', action: () => { l.lock = !l.lock; thisLayerUpdate(); } },
        { sep: true },
        { label: 'Add Layer', action: addLayer },
        { label: 'Delete Layer', action: () => { S.layerIdx = idx; delLayer(); } },
        { label: 'Move Up', action: () => { S.layerIdx = idx; moveUp(); } },
        { label: 'Move Down', action: () => { S.layerIdx = idx; moveDown(); } },
      ], e.clientX, e.clientY);
    };
    row.onclick = e => {
      if (e.ctrlKey || e.metaKey) {
        toggleLayerSelection(l.id);
        updateTL(); dirtyCache(); render();
      } else {
        setActiveLayerByIndex(S.layers.indexOf(l));
        updateTL(); dirtyCache(); render();
      }
    };

    row.append(eye, lock, outline, color, name);
    layerList.appendChild(row);
  }

  // --- Right: Time Ruler ---
  const ruler = $('tl-ruler');
  ruler.innerHTML = '';
  for (let i = 0; i < nf; i++) {
    const cell = document.createElement('div');
    cell.className = 'tl-ruler-cell' + ((i + 1) % 5 === 0 ? ' major' : '');
    cell.style.width = cellW() + 'px';

    // Show frame number every 5 frames
    if ((i + 1) % 5 === 0 || i === 0) {
      const num = document.createElement('span');
      num.className = 'tl-ruler-num';
      num.textContent = i + 1;
      cell.appendChild(num);
    }

    // Show seconds label
    const sec = Math.floor(i / S.fps);
    const prevSec = Math.floor((i - 1) / S.fps);
    if (sec > 0 && i % S.fps === 0 && sec !== prevSec) {
      const secLabel = document.createElement('span');
      secLabel.className = 'tl-ruler-sec';
      secLabel.textContent = sec + 's';
      cell.appendChild(secLabel);
    }

    cell.onmousedown = e => { if (e.button === 0) { e.preventDefault(); _tlScrub = true; S.frameIdx = i; _selectedFrames.clear(); _tlRangeAnchor = -1; updateTL(); fullRender(); } };
    ruler.appendChild(cell);
  }

  // --- Right: Frame rows (per-cell rendering) ---
  const rows = $('tl-frame-rows');
  rows.innerHTML = '';
  for (const l of S.layers) {
    const row = document.createElement('div');
    row.className = 'tl-frame-row' + (l.id === curL.id ? ' active' : '') + (S.selLayerIds.has(l.id) ? ' selected' : '');
    row.style.borderLeft = `3px solid ${l.col}`;

    for (let i = 0; i < nf; i++) {
      const f = S.frames[i];
      const objs = f ? (f.o[l.id] || []) : [];
      const hasContent = objs.length > 0;
      const isKey = f ? f.key : false;

      // Determine if this frame is extended (same content as previous)
      let isExtended = false;
      if (!isKey && hasContent && i > 0) {
        const prevF = S.frames[i - 1];
        const prevObjs = prevF ? (prevF.o[l.id] || []) : [];
        const prevHash = prevObjs.length > 0 ? frameHashContent(prevObjs) : 'empty';
        const currHash = frameHashContent(objs);
        isExtended = prevHash !== 'empty' && currHash === prevHash;
      }

      const cell = document.createElement('div');
      cell.className = 'tl-frame-cell';
      cell.style.width = cellW() + 'px';
      cell.dataset.frame = i;

      if (isKey && hasContent) {
        cell.classList.add('keyframe');
      } else if (isKey && !hasContent) {
        cell.classList.add('blank-key');
      } else if (isExtended) {
        cell.classList.add('extended');
      } else {
        cell.classList.add('empty');
      }

      // Active frame
      if (i === S.frameIdx) cell.classList.add('active');

      // Multi-selection
      if (_selectedFrames.has(i)) cell.classList.add('selected');

      cell.onmousemove = e => {
        cell.style.cursor = e.offsetX > cell.clientWidth - 5 ? 'col-resize' : 'pointer';
      };
      cell.onmousedown = e => tlFrameCellDown(e, i);
      row.appendChild(cell);
    }
    rows.appendChild(row);
  }

  // --- Playhead ---
  const ph = $('tl-playhead');
  ph.style.left = ((S.frameIdx * cellW()) + (cellW() / 2)) + 'px';

  // --- Scroll sync ---
  const scroll = $('timeline-scroll');
  const targetScroll = S.frameIdx * cellW() - scroll.clientWidth / 2 + cellW() / 2;
  scroll.scrollLeft = Math.max(0, targetScroll);
}

function thisLayerUpdate() { updateLayerUI(); dirtyCache(); render(); }
function updateLayerUI() { updateTL(); }
function updateFC() { $('frame-counter').textContent = `Frame: ${S.frameIdx + 1} / ${S.frames.length}  ${Math.round(tlZoom * 100)}%`; }

// ---- Timeline cell click ----
function tlFrameCellDown(e, idx) {
  if (e.button !== 0) return;
  e.preventDefault();

  // Ctrl+click: toggle frame selection
  if (e.ctrlKey || e.metaKey) {
    if (_selectedFrames.has(idx)) _selectedFrames.delete(idx);
    else _selectedFrames.add(idx);
    _tlRangeAnchor = idx;
    S.frameIdx = idx;
    updateTL(); fullRender();
    return;
  }

  // Shift+click: range select from anchor
  if (e.shiftKey) {
    if (_tlRangeAnchor < 0) _tlRangeAnchor = idx;
    const from = Math.min(_tlRangeAnchor, idx);
    const to = Math.max(_tlRangeAnchor, idx);
    for (let i = from; i <= to; i++) _selectedFrames.add(i);
    S.frameIdx = idx;
    updateTL(); fullRender();
    return;
  }

  // Check if click is on the right edge (resize zone)
  const isEdge = e.offsetX > e.currentTarget.clientWidth - 5;

  // Edge click or Alt+click → extend mode (Adobe Animate: basılı tutup uzatma)
  if (isEdge || e.altKey) {
    _tlDrag = { mode: 'extend', from: idx, extent: 1 };
    showTlDragOverlay(idx, 1);
    return;
  }

  // Normal click
  if (!_selectedFrames.has(idx)) {
    _selectedFrames.clear();
    _tlRangeAnchor = idx;
    _selectedFrames.add(idx);
  }
  S.frameIdx = idx;
  _tlDrag = { mode: 'move', from: idx };
  updateTL(); fullRender();
}

function getTlCellAtX(clientX) {
  const scroll = $('timeline-scroll');
  const r = scroll.getBoundingClientRect();
  return Math.max(0, Math.floor((clientX - r.left + scroll.scrollLeft) / cellW()));
}

function showTlDragOverlay(from, extent, isMove) {
  let ov = document.getElementById('tl-drag-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'tl-drag-overlay';
    ov.style.cssText = 'position:absolute;top:18px;bottom:0;pointer-events:none;z-index:10;';
    $('timeline-scroll').appendChild(ov);
  }
  ov.style.display = 'block';
  ov.style.background = isMove ? 'rgba(0,120,215,0.25)' : 'rgba(255,59,48,0.2)';
  ov.style.borderRight = isMove ? '2px solid #0078d7' : '2px solid #ff3b30';
  ov.style.left = (from * cellW()) + 'px';
  ov.style.width = (extent * cellW()) + 'px';
}

function hideTlDragOverlay() {
  const ov = document.getElementById('tl-drag-overlay');
  if (ov) ov.style.display = 'none';
}

// Global timeline mouse events
document.addEventListener('mousemove', e => {
  if (!_tlDrag && !_tlScrub) return;
  const idx = getTlCellAtX(e.clientX);

  if (_tlScrub) {
    if (idx !== S.frameIdx && idx < S.frames.length) {
      S.frameIdx = idx;
      updateTL(); fullRender();
    }
  } else if (_tlDrag) {
    if (_tlDrag.mode === 'move') {
      const sorted = [..._selectedFrames].sort((a, b) => a - b);
      const span = sorted.length ? (sorted[sorted.length - 1] - sorted[0] + 1) : 1;
      let targetStart = idx;
      if (targetStart + span > S.frames.length) targetStart = S.frames.length - span;
      showTlDragOverlay(targetStart, span, true);
      S.frameIdx = idx;
      updateTL(); fullRender();
    } else if (_tlDrag.mode === 'extend' && idx !== _tlDrag.from + _tlDrag.extent - 1) {
      _tlDrag.extent = Math.max(1, idx - _tlDrag.from + 1);
      showTlDragOverlay(_tlDrag.from, _tlDrag.extent, false);
    }
  }
});

document.addEventListener('mouseup', e => {
  hideTlDragOverlay();
  if (_tlDrag) {
    if (_tlDrag.mode === 'move') {
      const toIdx = S.frameIdx;
      if (toIdx !== _tlDrag.from) {
        saveSnapshot();
        const sorted = [..._selectedFrames].sort((a, b) => a - b);
        if (sorted.length <= 1) {
          const [moved] = S.frames.splice(_tlDrag.from, 1);
          S.frames.splice(toIdx, 0, moved);
          S.frameIdx = toIdx;
        } else {
          const removed = sorted.map(i => S.frames[i]);
          for (let i = sorted.length - 1; i >= 0; i--) S.frames.splice(sorted[i], 1);
          let adj = toIdx;
          for (const si of sorted) { if (si < adj) adj--; }
          adj = Math.min(adj, S.frames.length);
          S.frames.splice(adj, 0, ...removed);
          _selectedFrames = new Set(removed.map((_, i) => adj + i));
          S.frameIdx = adj;
        }
         S.tlDirty = true;
        fullRender(); saveSnapshot();
      }
    } else if (_tlDrag.mode === 'extend' && _tlDrag.extent > 1) {
      saveSnapshot();
      const src = S.frames[_tlDrag.from];
      if (!src) { _tlDrag = null; return; }
      const needed = _tlDrag.from + _tlDrag.extent - S.frames.length;
      for (let i = 0; i < needed; i++) S.frames.push({ o: {}, key: false, _hist: [], _histIdx: -1 });
      for (let i = _tlDrag.from + 1; i < _tlDrag.from + _tlDrag.extent; i++) {
        const f = S.frames[i]; f.key = false;
        f.o = {};
        for (const [lid, objs] of Object.entries(src.o)) {
          f.o[lid] = objs.map(o => {
            if (o.fc) {
              const c = document.createElement('canvas');
              c.width = o.fc.width; c.height = o.fc.height;
              c.getContext('2d').drawImage(o.fc, 0, 0);
              return { type: 'fill', fc: c, opacity: o.opacity };
            }
            return JSON.parse(JSON.stringify(o, (k, v) => k === 'fc' ? null : v));
          });
        }
      }
      S.tlDirty = true;
      fullRender(); saveSnapshot();
    }
    document.querySelectorAll('.tl-extend-from').forEach(c => c.classList.remove('tl-extend-from'));
    _tlDrag = null;
  }
  _tlScrub = false;
});

function cloneFrameObjs(srcFrame) {
  if (!srcFrame) return {};
  const o = {};
  for (const [lid, objs] of Object.entries(srcFrame.o || {})) {
    o[lid] = objs.map(o => {
      const oc = {};
      for (const k of Object.keys(o)) {
        if (k === 'fc' && o.fc) {
          const c = document.createElement('canvas');
          c.width = o.fc.width; c.height = o.fc.height;
          c.getContext('2d').drawImage(o.fc, 0, 0);
          oc.fc = c;
        } else oc[k] = JSON.parse(JSON.stringify(o[k]));
      }
      return oc;
    });
  }
  return o;
}

function addFrame(onlyActiveLayer, isKeyframe) {
  const src = S.frames[S.frameIdx] || S.frames[0];
  const nf = { o: {}, key: !!isKeyframe, _hist: [], _histIdx: -1 };
  const targetLayers = onlyActiveLayer && S.activeLayerId != null
    ? new Set([S.activeLayerId])
    : S.selLayerIds;
  for (const lid of targetLayers) {
    nf.o[lid] = src.o[lid] ? src.o[lid].map(cloneObj) : [];
  }
  const insertAt = S.frameIdx + 1;
  S.frames.splice(insertAt, 0, nf);
  S.frameIdx++;
  saveSnapshot();
  dirtyCache(); S.tlDirty = true;
  fullRender();
}

function addEmptyFrame() {
  const nf = { o: {}, key: true, _hist: [], _histIdx: -1 };
  for (const lid of S.selLayerIds) {
    nf.o[lid] = [];
  }
  S.frames.splice(S.frameIdx + 1, 0, nf);
  S.frameIdx++;
  saveSnapshot();
  dirtyCache(); S.tlDirty = true;
  fullRender();
}

function dupFrame() {
  const src = S.frames[S.frameIdx] || S.frames[0];
  if (!src) return;
  const nf = { o: {}, key: src.key, _hist: [], _histIdx: -1 };
  for (const lid of S.selLayerIds) {
    nf.o[lid] = src.o[lid] ? src.o[lid].map(cloneObj) : [];
  }
  S.frames.splice(S.frameIdx + 1, 0, nf);
  S.frameIdx++;
  saveSnapshot();
  dirtyCache(); S.tlDirty = true;
  fullRender();
}

function delFrame() {
  if (S.frames.length <= 1) return;
  S.frames.splice(S.frameIdx, 1);
  if (S.frameIdx >= S.frames.length) S.frameIdx = S.frames.length - 1;
  dirtyCache(); S.tlDirty = true;
  fullRender(); saveSnapshot();
}

function delSelectedFrames() {
  if (_selectedFrames.size === 0) { delFrame(); return; }
  if (_selectedFrames.size >= S.frames.length) return;
  const sorted = [..._selectedFrames].sort((a, b) => b - a);
  for (const fi of sorted) {
    S.frames.splice(fi, 1);
  }
  if (S.frameIdx >= S.frames.length) S.frameIdx = S.frames.length - 1;
  _selectedFrames.clear();
  _tlRangeAnchor = -1;
  dirtyCache(); S.tlDirty = true;
  fullRender(); saveSnapshot();
}

function goFrame(i) {
  const maxF = S.frames.length;
  if (i < 0 || i >= maxF) return;
  S.frameIdx = i;
  octx.clearRect(0, 0, overlay.width, overlay.height);
  clearSel(); S.curStroke = null;
  cancelPenPath();
  updateTL(); fullRender();
}

function clearFrame() {
  const f = S.frames[S.frameIdx];
  if (!f) return;
  let hadContent = false;
  for (const lid of S.selLayerIds) {
    if (f.o[lid] && f.o[lid].length) hadContent = true;
  }
  if (!hadContent) return;
  saveSnapshot();
  for (const lid of S.selLayerIds) {
    f.o[lid] = [];
  }
  dirtyCache(); S.tlDirty = true;
  fullRender();
}

// ==================== TWEEN (Adobe Animate style) ====================
function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

function interpColor(c1, c2, t) {
  const r1 = parseInt(c1.slice(1,3), 16), g1 = parseInt(c1.slice(3,5), 16), b1 = parseInt(c1.slice(5,7), 16);
  const r2 = parseInt(c2.slice(1,3), 16), g2 = parseInt(c2.slice(3,5), 16), b2 = parseInt(c2.slice(5,7), 16);
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const b = Math.round(b1 + (b2 - b1) * t);
  return '#' + [r, g, b].map(c => Math.max(0, Math.min(255, c)).toString(16).padStart(2, '0')).join('');
}

function cloneObjDeep(o) {
  if (!o || typeof o !== 'object') return o;
  if (o.fc) {
    const c = document.createElement('canvas');
    c.width = o.fc.width; c.height = o.fc.height;
    c.getContext('2d').drawImage(o.fc, 0, 0);
    return { ...cloneObjDeep({ ...o }), fc: c };
  }
  if (Array.isArray(o)) return o.map(cloneObjDeep);
  const r = {};
  for (const k of Object.keys(o)) {
    if (k === 'pts') r.pts = o.pts.map(p => ({ x: p.x, y: p.y, ...(p.p !== undefined ? { p: p.p } : {}) }));
    else if (k === 'subs') r.subs = o.subs.map(sub => ({ ...sub, pts: sub.pts.map(p => ({ x: p.x, y: p.y, ...(p.p !== undefined ? { p: p.p } : {}) })) }));
    else if (k === 'fc') { /* handled above */ }
    else if (typeof o[k] === 'object' && o[k] !== null) r[k] = cloneObjDeep(o[k]);
    else r[k] = o[k];
  }
  return r;
}

function interpObj(a, b, t) {
  const o = {};
  for (const k of Object.keys(a)) {
    if (k === 'pts' && a.pts && b && b.pts) {
      const max = Math.max(a.pts.length, b.pts.length);
        o.pts = [];
        for (let i = 0; i < max; i++) {
          const ap = a.pts[Math.min(i, a.pts.length - 1)];
          const bp = b.pts[Math.min(i, b.pts.length - 1)];
          const pt = { x: ap.x + (bp.x - ap.x) * t, y: ap.y + (bp.y - ap.y) * t };
          if (ap.p !== undefined || bp.p !== undefined) pt.p = ((ap.p !== undefined ? ap.p : 1) + ((bp.p !== undefined ? bp.p : 1) - (ap.p !== undefined ? ap.p : 1)) * t);
          o.pts.push(pt);
        }
    } else if (k === 'color' || k === 'fillColor') {
      if (b && b[k]) o[k] = interpColor(a[k] || '#000000', b[k], t);
      else o[k] = a[k];
    } else if (k === 'subs') {
      // Interpolate each sub-stroke's points; keep per-sub size/color/opacity
      o.subs = a.subs.map((sub, idx) => {
        const bSub = b && b.subs && idx < b.subs.length ? b.subs[idx] : null;
        const max = Math.max(sub.pts.length, bSub ? bSub.pts.length : sub.pts.length);
        const pts = [];
        for (let i = 0; i < max; i++) {
          const ap = sub.pts[Math.min(i, sub.pts.length - 1)];
          const bp = bSub ? bSub.pts[Math.min(i, bSub.pts.length - 1)] : ap;
          const pi = { x: ap.x + (bp.x - ap.x) * t, y: ap.y + (bp.y - ap.y) * t };
          if (ap.p !== undefined || bp.p !== undefined) pi.p = ((ap.p !== undefined ? ap.p : 1) + ((bp.p !== undefined ? bp.p : 1) - (ap.p !== undefined ? ap.p : 1)) * t);
          pts.push(pi);
        }
        const r = { ...sub, pts };
        // Interpolate size if both have it
        if (bSub && bSub.size !== undefined && sub.size !== undefined) {
          r.size = sub.size + (bSub.size - sub.size) * t;
        }
        return r;
      });
    } else if (['x1','y1','x2','y2','size','opacity','angle'].includes(k)) {
      const av = a[k] || 0, bv = (b && b[k] != null) ? b[k] : av;
      o[k] = av + (bv - av) * t;
    } else if (k !== 'fc' && k !== 'composite') {
      o[k] = a[k];
    }
  }
  if (o.type === 'stroke' && o.pts && a.pts && a.pts.length > 1 && (!b || !b.pts)) {
    o.pts = a.pts.map(p => ({ x: p.x, y: p.y }));
  }
  return o;
}
function rebuildTweens() {
  const lid = L().id;
  const keys = [];
  for (let i = 0; i < S.frames.length; i++) {
    if (S.frames[i].key) keys.push(i);
  }
  if (keys.length < 2) return;

  for (let k = 0; k < keys.length - 1; k++) {
    const from = keys[k], to = keys[k + 1];
    if (to - from <= 1) continue;

    const fromF = S.frames[from];
    const toF = S.frames[to];
    const fObs = fromF.o[lid] || [];
    const tObs = toF.o[lid] || [];

    for (let fi = from + 1; fi < to; fi++) {
      const raw = (fi - from) / (to - from);
      const t = easeInOut(raw);
      const fr = S.frames[fi];
      fr.key = false;

      const mx = Math.max(fObs.length, tObs.length);
      const out = [];

      for (let oi = 0; oi < mx; oi++) {
        const fo = fObs[oi], to = tObs[oi];
        if (fo && to && fo.type === to.type) {
          if (fo.type === 'fill') {
            const c = document.createElement('canvas');
            c.width = fo.fc.width; c.height = fo.fc.height;
            const cx = c.getContext('2d');
            cx.globalAlpha = 1 - t; cx.drawImage(fo.fc, 0, 0);
            cx.globalAlpha = t; cx.drawImage(to.fc, 0, 0);
            out.push({ type: 'fill', fc: c, opacity: fo.opacity + (to.opacity - fo.opacity) * t });
          } else {
            out.push(interpObj(fo, to, t));
          }
        } else if (fo && !to) {
          out.push(fo.fc ? cloneFill(fo) : interpObj(fo, fo, 0));
        }
      }
      if (!fr.o[lid]) fr.o[lid] = [];
      fr.o[lid] = out;
    }
  }
}

function tweenAll() {
  const keys = [];
  for (let i = 0; i < S.frames.length; i++) {
    if (S.frames[i].key) keys.push(i);
  }
  if (keys.length < 2) { alert('At least 2 keyframes are required.'); return; }
  saveSnapshot();
  rebuildTweens();
  S.tlDirty = true;
  fullRender();
  saveSnapshot();
}
function cloneFill(o) {
  const c = document.createElement('canvas');
  c.width = o.fc.width; c.height = o.fc.height;
  c.getContext('2d').drawImage(o.fc, 0, 0);
  return { type: 'fill', fc: c, opacity: o.opacity };
}

// ==================== PLAYBACK ====================
let _pi = null;

// ---- SVG Icons (Adobe Animate style) ----
// Defined at top level so updateTL() can use them before setupEvents() runs
const icons = {
  select: '<svg viewBox="0 0 20 20"><path d="M3 1l15 9-7 2-3 7z" fill="currentColor"/></svg>',
  brush: '<svg viewBox="0 0 22 22"><rect x="9" y="2" width="4" height="7" rx="1" fill="currentColor"/><polygon points="7,9 15,9 16,14 6,14" fill="currentColor"/><line x1="8" y1="14" x2="8" y2="17" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="11" y1="14" x2="11" y2="17" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="14" y1="14" x2="14" y2="17" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  pencil: '<svg viewBox="0 0 22 22"><rect x="8" y="4" width="6" height="8" rx="1" fill="currentColor"/><polygon points="7,12 15,12 11,18" fill="currentColor"/><rect x="8" y="2" width="6" height="3" rx="1" fill="currentColor" opacity=".5"/></svg>',
  eraser: '<svg viewBox="0 0 22 22"><rect x="3" y="10" width="16" height="8" rx="2" fill="currentColor" transform="rotate(-30 11 14)"/></svg>',
  rect: '<svg viewBox="0 0 20 20"><rect x="2" y="2" width="16" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  circle: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  line: '<svg viewBox="0 0 20 20"><line x1="3" y1="17" x2="17" y2="3" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>',
  fill: '<svg viewBox="0 0 22 22"><path d="M4 6l16 2-4 13H8z" fill="currentColor"/><path d="M4 6Q12 1 20 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  text: '<svg viewBox="0 0 22 22"><rect x="4" y="4" width="14" height="2" rx="1" fill="currentColor"/><rect x="10" y="8" width="8" height="2" rx="1" fill="currentColor"/><rect x="10" y="12" width="6" height="2" rx="1" fill="currentColor"/><rect x="4" y="8" width="4" height="2" rx="1" fill="currentColor"/><rect x="4" y="12" width="4" height="2" rx="1" fill="currentColor"/></svg>',
  new: '<svg viewBox="0 0 20 20"><path d="M4 2h8l4 4v12H4z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M12 2v4h4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><line x1="8" y1="10" x2="14" y2="10" stroke="currentColor" stroke-width="1.5"/><line x1="11" y1="7" x2="11" y2="13" stroke="currentColor" stroke-width="1.5"/></svg>',
  open: '<svg viewBox="0 0 20 20"><path d="M2 4h6l2 2h6v10H2z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M2 10h16l-2 6H4z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  save: '<svg viewBox="0 0 22 22"><rect x="3" y="3" width="16" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><rect x="7" y="5" width="8" height="6" rx="1" fill="currentColor"/><rect x="5" y="14" width="12" height="4" rx="1" fill="currentColor"/></svg>',
  undo: '<svg viewBox="0 0 20 20"><path d="M4 9l4-4v3c4 0 7 1 9 4-2-2-5-3-9-3v3z" fill="currentColor"/></svg>',
  redo: '<svg viewBox="0 0 20 20"><path d="M16 9l-4-4v3c-4 0-7 1-9 4 2-2 5-3 9-3v3z" fill="currentColor"/></svg>',
  export: '<svg viewBox="0 0 20 20"><path d="M10 2l5 6h-3v5H8V8H5z" fill="currentColor"/><path d="M2 15v2h16v-2" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  keyframe: '<svg viewBox="0 0 16 16"><polygon points="8,1 15,8 8,15 1,8" fill="currentColor"/></svg>',
  tween: '<svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><polyline points="5,8 8,5 11,8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><polyline points="5,8 8,11 11,8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  onion: '<svg viewBox="0 0 16 16"><rect x="2" y="3" width="11" height="11" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="4" y="2" width="11" height="11" rx="1" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".5"/></svg>',
  play: '<svg viewBox="0 0 16 16"><polygon points="3,1 14,8 3,15" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 16 16"><rect x="3" y="2" width="4" height="12" rx="1" fill="currentColor"/><rect x="9" y="2" width="4" height="12" rx="1" fill="currentColor"/></svg>',
  prev: '<svg viewBox="0 0 16 16"><polygon points="12,2 4,8 12,14" fill="currentColor"/></svg>',
  next: '<svg viewBox="0 0 16 16"><polygon points="4,2 12,8 4,14" fill="currentColor"/></svg>',
  first: '<svg viewBox="0 0 16 16"><polygon points="10,2 3,8 10,14" fill="currentColor"/><line x1="13" y1="2" x2="13" y2="14" stroke="currentColor" stroke-width="1.5"/></svg>',
  last: '<svg viewBox="0 0 16 16"><polygon points="6,2 13,8 6,14" fill="currentColor"/><line x1="3" y1="2" x2="3" y2="14" stroke="currentColor" stroke-width="1.5"/></svg>',
  guide: '<svg viewBox="0 0 22 22"><path d="M3 11c4 0 4-6 8-6s4 6 8 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="11" cy="5" r="2" fill="currentColor"/><circle cx="19" cy="11" r="2" fill="currentColor"/></svg>',
  import: '<svg viewBox="0 0 20 20"><g transform="scale(1,-1) translate(0,-20)"><rect x="3" y="7" width="14" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><polyline points="7,3 10,0 13,3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><line x1="10" y1="0" x2="10" y2="7" stroke="currentColor" stroke-width="1.5"/></g></svg>',
  // Timeline icons
  eyeOpen: '<svg viewBox="0 0 16 16"><ellipse cx="8" cy="8" rx="6" ry="4" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg>',
  eyeClosed: '<svg viewBox="0 0 16 16"><line x1="2" y1="4" x2="14" y2="12" stroke="currentColor" stroke-width="1.5"/><line x1="14" y1="4" x2="2" y2="12" stroke="currentColor" stroke-width="1.5"/><ellipse cx="8" cy="8" rx="6" ry="4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  lockLocked: '<svg viewBox="0 0 16 16"><rect x="3" y="7" width="10" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5 7V5a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  lockUnlocked: '<svg viewBox="0 0 16 16"><rect x="3" y="7" width="10" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5 7V5a3 3 0 0 1 6 0" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  outline: '<svg viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  plus: '<svg viewBox="0 0 16 16"><line x1="8" y1="2" x2="8" y2="14" stroke="currentColor" stroke-width="1.5"/><line x1="2" y1="8" x2="14" y2="8" stroke="currentColor" stroke-width="1.5"/></svg>',
  trash: '<svg viewBox="0 0 16 16"><rect x="3" y="4" width="10" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="6" y1="2" x2="10" y2="2" stroke="currentColor" stroke-width="1.5"/><line x1="1" y1="4" x2="15" y2="4" stroke="currentColor" stroke-width="1.5"/></svg>',
  folder: '<svg viewBox="0 0 16 16"><path d="M1 3h5l2 2h7v8H1z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  tlStepBack: '<svg viewBox="0 0 16 16"><polygon points="10,2 2,8 10,14" fill="currentColor"/></svg>',
  tlStepFwd: '<svg viewBox="0 0 16 16"><polygon points="6,2 14,8 6,14" fill="currentColor"/></svg>',
  tlPrevKey: '<svg viewBox="0 0 16 16"><polygon points="10,2 2,8 10,14" fill="currentColor"/><line x1="13" y1="2" x2="13" y2="14" stroke="currentColor" stroke-width="1.5"/></svg>',
  tlNextKey: '<svg viewBox="0 0 16 16"><polygon points="6,2 14,8 6,14" fill="currentColor"/><line x1="3" y1="2" x2="3" y2="14" stroke="currentColor" stroke-width="1.5"/></svg>',
  tlOnion: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg>',
  tlLoop: '<svg viewBox="0 0 16 16"><path d="M12 4a5 5 0 0 0-8 0M4 12a5 5 0 0 0 8 0" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><polyline points="2,6 4,4 6,6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><polyline points="14,10 12,12 10,10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  tlCenter: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg>',
  tlDraw: '<svg viewBox="0 0 16 16"><path d="M2 14l3-3 3 3M5 11V4l9 3-4 2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  tlAddFrame: '<svg viewBox="0 0 16 16"><rect x="2" y="4" width="12" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="8" y1="6" x2="8" y2="10" stroke="currentColor" stroke-width="1.5"/><line x1="6" y1="8" x2="10" y2="8" stroke="currentColor" stroke-width="1.5"/></svg>',
  tlInsertKeyframe: '<svg viewBox="0 0 16 16"><polygon points="8,2 14,8 8,14 2,8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg>',
  tlDelFrame: '<svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="5" y1="6" x2="11" y2="12" stroke="currentColor" stroke-width="1.5"/><line x1="11" y1="6" x2="5" y2="12" stroke="currentColor" stroke-width="1.5"/></svg>',
  tlFirst: '<svg viewBox="0 0 16 16"><polygon points="10,2 3,8 10,14" fill="currentColor"/><line x1="13" y1="2" x2="13" y2="14" stroke="currentColor" stroke-width="1.5"/></svg>',
  tlLast: '<svg viewBox="0 0 16 16"><polygon points="6,2 13,8 6,14" fill="currentColor"/><line x1="3" y1="2" x2="3" y2="14" stroke="currentColor" stroke-width="1.5"/></svg>',
};

function play() {
  S.playing = !S.playing;
  const b = $('play-btn');
  if (b) {
    b.classList.toggle('active', S.playing);
    b.innerHTML = S.playing ? icons.pause : icons.play;
  }
  // Update new timeline play button too
  const tlBtn = $('tl-play-btn');
  if (tlBtn) tlBtn.innerHTML = S.playing ? icons.pause : icons.play;
  if (S.playing) {
    _pi = setInterval(() => {
      if (S.frameIdx < S.frames.length - 1) S.frameIdx++;
      else if (S.loop) S.frameIdx = 0;
      else { play(); return; }
      updateTL(); fullRender();
    }, 1000 / S.fps);
  } else { clearInterval(_pi); _pi = null; }
}

// ==================== ZOOM & PAN ====================
function applyZoom() {
  const c = $('canvas-container');
  if (!c) return;
  const r = c.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return;
  S.zoom = Math.max(1, Math.min(16, S.zoom));
  const fit = Math.min(r.width / S.w, r.height / S.h) * 0.9;
  const ds = fit * S.zoom;
  const cssW = Math.round(S.w * ds), cssH = Math.round(S.h * ds);

  resizeBuffers();

  // Clamp pan so canvas never goes completely off-screen
  const maxPanX = (r.width + cssW) / 2;
  const maxPanY = (r.height + cssH) / 2;
  S.panX = Math.max(-maxPanX, Math.min(maxPanX, S.panX));
  S.panY = Math.max(-maxPanY, Math.min(maxPanY, S.panY));

  canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
  overlay.style.width = cssW + 'px'; overlay.style.height = cssH + 'px';

  canvas.style.left = Math.round((r.width - cssW) / 2 + S.panX) + 'px';
  canvas.style.top = Math.round((r.height - cssH) / 2 + S.panY) + 'px';
  overlay.style.left = canvas.style.left;
  overlay.style.top = canvas.style.top;
  $('zoom-level').textContent = Math.round(S.zoom * 100) + '%';
  dirtyCache();
  render();
}

function zoomAt(d) { S.zoom *= Math.pow(1.1, d); applyZoom(); }
function zoomAtMouse(d, mx, my) {
  const c = $('canvas-container');
  if (!c) return;
  const r = c.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return;
  const fit = Math.min(r.width / S.w, r.height / S.h) * 0.9;
  const oldZoom = S.zoom;
  // Apply zoom (smaller step for smoother feel)
  let newZoom = oldZoom * Math.pow(1.05, d);
  newZoom = Math.max(1, Math.min(20, newZoom));
  S.zoom = newZoom;
  // Simpler mouse-centered zoom: keep document point under mouse stationary
  const oldScale = fit * oldZoom;
  const newScale = fit * newZoom;
  const docX = (mx - r.width / 2 - S.panX) / oldScale + S.w / 2;
  const docY = (my - r.height / 2 - S.panY) / oldScale + S.h / 2;
  S.panX = mx - r.width / 2 - (docX - S.w / 2) * newScale;
  S.panY = my - r.height / 2 - (docY - S.h / 2) * newScale;
  applyZoom();
}
function centerZoom() { S.zoom = 1; S.panX = 0; S.panY = 0; applyZoom(); }

// ==================== EXPORT ====================
$('export-btn').onclick = () => {
  $('export-modal').classList.remove('hidden');
  $('export-start').value = 1; $('export-end').value = S.frames.length; $('export-fps').value = S.fps;
};
document.querySelector('#export-modal .modal-close').onclick = () => $('export-modal').classList.add('hidden');
$('export-cancel').onclick = () => $('export-modal').classList.add('hidden');
$('export-start-btn').onclick = async () => {
  const f = $('export-format').value, fn = $('export-filename').value || 'anim';
  const s = parseInt($('export-start').value) - 1, e = parseInt($('export-end').value);
  if (isNaN(s) || isNaN(e) || s < 0 || e > S.frames.length || s >= e) {
    alert('Invalid export range');
    return;
  }
  const sc = parseFloat($('export-scale').value), ef = parseInt($('export-fps').value);
  $('export-modal').classList.add('hidden');
  if (f === 'png-sequence') await expPNG(fn, s, e, sc);
  else if (f === 'gif') await expGIF(fn, s, e, sc, ef);
  else if (f === 'webm') await expWebM(fn, s, e, sc, ef);
  else if (f === 'sprite-sheet') await expSpriteSheet(fn, s, e, sc);
};

function expFrame(fi, cx, sc) {
  renderFrame(cx, fi, sc, true);
}

async function expPNG(fn, s, e, sc) {
  const dir = await ipcRenderer.invoke('select-directory');
  if (!dir) return;
  const frames = [];
  for (let i = s; i < e; i++) {
    const ec = document.createElement('canvas');
    ec.width = S.w * sc; ec.height = S.h * sc;
    expFrame(i, ec.getContext('2d'), sc);
    frames.push(ec.toDataURL('image/png'));
  }
  const r = await ipcRenderer.invoke('export-png-sequence', { frames, dirPath: dir, fileName: fn });
  alert(r.success ? `PNG → ${dir}` : `Error: ${r.error}`);
}

async function expGIF(fn, s, e, sc, fps) {
  const fp = await ipcRenderer.invoke('save-file', { defaultName: `${fn}.gif`, filters: [{ name: 'GIF', extensions: ['gif'] }] });
  if (!fp) return;
  const GIF = require('gif.js/dist/gif.js');
  const w = Math.round(S.w * sc), h = Math.round(S.h * sc);
  const workerScript = require('url').pathToFileURL(require('path').join(__dirname, 'node_modules/gif.js/dist/gif.worker.js')).href;
  const gif = new GIF({ workers: 2, quality: 10, width: w, height: h, workerScript });
  for (let i = s; i < e; i++) {
    const ec = document.createElement('canvas');
    ec.width = w; ec.height = h;
    expFrame(i, ec.getContext('2d'), sc);
    gif.addFrame(ec, { copy: true, delay: 1000 / fps });
  }
  gif.on('finished', blob => {
    const r = new FileReader();
    r.onload = () => { require('fs').writeFileSync(fp, Buffer.from(r.result)); alert(`GIF → ${fp}`); };
    r.readAsArrayBuffer(blob);
  });
  gif.render();
}

async function expWebM(fn, s, e, sc, fps) {
  const fp = await ipcRenderer.invoke('save-file', { defaultName: `${fn}.webm`, filters: [{ name: 'WebM', extensions: ['webm'] }] });
  if (!fp) return;
  const w = S.w * sc, h = S.h * sc;
  const ec = document.createElement('canvas');
  ec.width = w; ec.height = h;
  const ecx = ec.getContext('2d');
  const stream = ec.captureStream(fps);
  const mr = new MediaRecorder(stream, { mimeType: 'video/webm' });
  const chunks = [];
  mr.ondataavailable = e => chunks.push(e.data);
  mr.onstop = () => {
    const r = new FileReader();
    r.onload = () => { require('fs').writeFileSync(fp, Buffer.from(r.result)); alert(`Video → ${fp}`); };
    r.readAsArrayBuffer(new Blob(chunks, { type: 'video/webm' }));
  };
  mr.start();
  for (let i = s; i < e; i++) {
    ecx.clearRect(0, 0, w, h);
    expFrame(i, ecx, sc);
    await new Promise(r => setTimeout(r, 1000 / fps));
  }
  mr.stop();
}

async function expSpriteSheet(fn, s, e, sc) {
  const dir = await ipcRenderer.invoke('select-directory');
  if (!dir) return;
  const frameCount = e - s;
  const fw = Math.round(S.w * sc), fh = Math.round(S.h * sc);
  // Determine grid size: aim for a roughly square sprite sheet
  const cols = Math.ceil(Math.sqrt(frameCount));
  const rows = Math.ceil(frameCount / cols);
  const sheetW = fw * cols, sheetH = fh * rows;
  // Cap at 8192x8192 for compatibility
  const maxSheet = 8192;
  const finalSc = Math.min(1, maxSheet / Math.max(sheetW, sheetH));
  const finalFW = Math.round(fw * finalSc), finalFH = Math.round(fh * finalSc);
  const finalSheetW = finalFW * cols, finalSheetH = finalFH * rows;

  const sheet = document.createElement('canvas');
  sheet.width = finalSheetW; sheet.height = finalSheetH;
  const sctx = sheet.getContext('2d');
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';

      const meta = { frames: {}, meta: { app: 'Dolphin Animate', version: '1.7.9', image: `${fn}.png`, size: { w: finalSheetW, h: finalSheetH } } };

  for (let i = s; i < e; i++) {
    const fc = document.createElement('canvas');
    fc.width = fw; fc.height = fh;
    expFrame(i, fc.getContext('2d'), sc);

    const idx = i - s;
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const dx = col * finalFW;
    const dy = row * finalFH;
    sctx.drawImage(fc, dx, dy, finalFW, finalFH);

    meta.frames[`${fn}_${String(idx).padStart(4, '0')}`] = {
      frame: { x: dx, y: dy, w: finalFW, h: finalFH },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: finalFW, h: finalFH },
      sourceSize: { w: finalFW, h: finalFH },
    };
  }

  const pngData = sheet.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
  const r = await ipcRenderer.invoke('export-sprite-sheet', {
    dirPath: dir,
    fileName: fn,
    pngData,
    meta: JSON.stringify(meta, null, 2),
  });
  alert(r.success ? `Sprite Sheet → ${dir}\n${cols}×${rows} grid, ${finalSheetW}×${finalSheetH}px` : `Error: ${r.error}`);
}

// ==================== PROJECT ====================
$('save-project').onclick = saveProj;
$('open-project').onclick = openProj;
$('new-project').onclick = newProj;

function serialize() {
  const d = {
    w: S.w, h: S.h, fps: S.fps, v: 7, bgColor: S.bgColor, bgImgData: S.bgImgData,
    layers: S.layers.map(l => ({ id: l.id, name: l.name, vis: l.vis, lock: l.lock, col: l.col })),
    frames: S.frames.map(f => {
      const o = {};
      for (const [lid, objs] of Object.entries(f.o || {})) {
        o[lid] = objs.map(obj => {
          const oc = {};
          for (const k of Object.keys(obj)) {
            if (k === 'pts') oc.pts = obj.pts.map(p => ({ x: p.x, y: p.y, ...(p.p !== undefined ? { p: p.p } : {}) }));
            else if (k === 'fc') oc.fcData = obj.fc.toDataURL();
            else oc[k] = obj[k];
          }
          return oc;
        });
      }
      return { key: f.key, o };
    })
  };
  return JSON.stringify(d);
}

async function saveProj() {
  const fp = await ipcRenderer.invoke('save-file', { defaultName: 'project.yunus', filters: [{ name: 'Yunus Project', extensions: ['yunus'] }] });
  if (!fp) return;
  const r = await ipcRenderer.invoke('write-file', { filePath: fp, data: serialize() });
  if (!r.success) alert('Save failed: ' + r.error);
}

async function openProj() {
  const fp = await ipcRenderer.invoke('open-file', { filters: [{ name: 'Yunus Project', extensions: ['yunus'] }] });
  if (!fp) return;
  const json = await ipcRenderer.invoke('read-file', fp);
  if (!json) { alert('Read failed'); return; }
  try {
    const d = JSON.parse(json);
    S.w = d.w || 800; S.h = d.h || 600; S.fps = d.fps || 12; S.bgColor = d.bgColor || '#ffffff';
    if (d.bgImgData) { const img = new Image(); img.onload = () => { S.bgImg = img; dirtyCache(); render(); }; img.src = d.bgImgData; S.bgImgData = d.bgImgData; if ($('pan-bgimg-row')) $('pan-bgimg-row').style.display = 'flex'; }
    const loadPromises = [];
    // Layers (just metadata, frames are in d.frames)
    S.layers = d.layers.map(l => ({ id: l.id, name: l.name, vis: l.vis, lock: l.lock, col: l.col }));
    S.nextLayerId = Math.max(...S.layers.map(l => l.id), 0) + 1;

    // Migration: v6 format (global frames in d.frames) or v7+ (per-layer frames in l.frames)
    if (d.frames && Array.isArray(d.frames)) {
      // v6 global frames format
      S.frames = d.frames.map(f => {
        const o = {};
        for (const [lid, objs] of Object.entries(f.o || {})) {
          o[lid] = objs.map(obj => {
            const oc = {};
            for (const k of Object.keys(obj)) {
              if (k === 'fcData') {
                const img = new Image();
                img.src = obj.fcData;
                const c = document.createElement('canvas'); c.width = S.w; c.height = S.h;
                loadPromises.push(new Promise(resolve => { img.onload = () => { c.getContext('2d').drawImage(img, 0, 0); resolve(); }; img.onerror = resolve; }));
                oc.fc = c;
              } else oc[k] = obj[k];
            }
            return oc;
          });
        }
        return { key: f.key != null ? f.key : true, o, _hist: [], _histIdx: -1 };
      });
    } else if (d.layers.some(l => l.frames)) {
      // v7+ per-layer frames format – convert to global frames
      const maxFrames = Math.max(...d.layers.map(l => (l.frames || []).length));
      S.frames = [];
      for (let fi = 0; fi < maxFrames; fi++) {
        const o = {};
        for (const layer of d.layers) {
          const lf = layer.frames && layer.frames[fi];
          if (lf && lf.objs) {
            o[layer.id] = lf.objs.map(obj => {
              const oc = {};
              for (const k of Object.keys(obj)) {
                if (k === 'fcData') {
                  const img = new Image();
                  img.src = obj.fcData;
                  const c = document.createElement('canvas'); c.width = S.w; c.height = S.h;
                  loadPromises.push(new Promise(resolve => { img.onload = () => { c.getContext('2d').drawImage(img, 0, 0); resolve(); }; img.onerror = resolve; }));
                  oc.fc = c;
                } else oc[k] = obj[k];
              }
              return oc;
            });
          }
        }
        S.frames.push({ key: d.frames ? d.frames[fi]?.key : true, o, _hist: [], _histIdx: -1 });
      }
    } else {
      S.frames = [mkFrame()];
    }
    await Promise.all(loadPromises);
    $('canvas-bg-color').value = S.bgColor;
    S.frameIdx = 0; S.curStroke = null;
    S.layerIdx = Math.min(S.layerIdx, S.layers.length - 1);
    syncActiveLayer();
    S.selLayerIds.clear();
    if (S.activeLayerId != null) S.selLayerIds.add(S.activeLayerId);
    _selectedFrames.clear(); _tlRangeAnchor = -1; _penPath = null;
    dirtyCache(); S.tlDirty = true;
    fullRender(); updateLayerUI(); saveSnapshot();
  } catch (err) { alert('Parse error: ' + err.message); }
}

function newProj() {
  if (!confirm('Are you sure you want to discard the current project?')) return;
  S.layers = [mkLayer('Layer 1')]; S.layerIdx = 0;
  syncActiveLayer();
  S.selLayerIds.clear();
  if (S.activeLayerId != null) S.selLayerIds.add(S.activeLayerId);
  S.frames = [mkFrame()]; S.frameIdx = 0; S.bgColor = '#ffffff';
  S.bgImg = null; S.bgImgData = null;
  S.curStroke = null;
  clearSel();
  _selectedFrames.clear(); _tlRangeAnchor = null; _penPath = null;
  $('canvas-bg-color').value = '#ffffff';
  if ($('pan-bgimg-row')) $('pan-bgimg-row').style.display = 'none';
  dirtyCache(); S.tlDirty = true;
  fullRender(); updateLayerUI(); saveSnapshot();
}

// ==================== CONTEXT MENU ====================
const ctxMenu = $('context-menu');
const ctxItems = ctxMenu.querySelector('.context-menu-items');

function showCtxMenu(items, x, y) {
  ctxItems.innerHTML = '';
  for (const item of items) {
    if (item.sep) {
      const d = document.createElement('div'); d.className = 'context-menu-separator'; ctxItems.appendChild(d);
    } else {
      const d = document.createElement('div');
      d.className = 'context-menu-item' + (item.disabled ? ' disabled' : '');
      d.textContent = item.label;
      if (item.shortcut) {
        const s = document.createElement('span'); s.className = 'shortcut'; s.textContent = item.shortcut; d.appendChild(s);
      }
      if (!item.disabled) d.onclick = () => { hideCtxMenu(); item.action(); };
      ctxItems.appendChild(d);
    }
  }
  ctxMenu.classList.remove('hidden');
  const mw = ctxMenu.offsetWidth, mh = ctxMenu.offsetHeight;
  const cw = window.innerWidth, ch = window.innerHeight;
  ctxMenu.style.left = Math.min(x, cw - mw - 5) + 'px';
  ctxMenu.style.top = Math.min(y, ch - mh - 5) + 'px';
}

function hideCtxMenu() { ctxMenu.classList.add('hidden'); }
document.addEventListener('click', hideCtxMenu);
document.addEventListener('contextmenu', hideCtxMenu);

// Canvas context menu
canvas.addEventListener('contextmenu', e => {
  e.preventDefault();
  e.stopPropagation();
  if (!selObj()) {
    showCtxMenu([
      { label: 'Select All (Ctrl+A)', action: () => {}, disabled: true },
      { label: 'Deselect (Esc)', action: () => { clearSel(); octx.clearRect(0, 0, overlay.width, overlay.height); } },
      { sep: true },
      { label: 'Paste', action: () => {}, disabled: true },
    ], e.clientX, e.clientY);
  } else {
    const isGroup = S.selObjs.length === 1 && (() => { const o = obs(S.frameIdx, S.selObjs[0].layerId)[S.selObjs[0].idx]; return o && o.type === 'group'; })();
    const items = [
      { label: 'Cut', shortcut: 'Ctrl+X', action: () => { cutSel(); } },
      { label: 'Copy', shortcut: 'Ctrl+C', action: () => { copySel(); } },
      { label: 'Delete', shortcut: 'Del', action: () => { delSel(); } },
      { sep: true },
    ];
    if (S.selObjs.length > 1) {
      items.push({ label: 'Group', shortcut: 'Ctrl+G', action: groupSelected });
    }
    if (isGroup) {
      items.push({ label: 'Ungroup', shortcut: 'Ctrl+Shift+G', action: ungroupSelected });
    }
    // Motion guide attach/detach options
    const guides = getAllGuides(S.frameIdx);
    if (guides.length > 0 && S.selObjs.length > 0) {
      items.push({ sep: true });
      const selObj0 = obs(S.frameIdx, S.selObjs[0].layerId)[S.selObjs[0].idx];
      if (selObj0 && selObj0.guideId) {
        items.push({ label: 'Detach from Guide', action: () => { saveSnapshot(); for (const ref of S.selObjs) { const o = obs(S.frameIdx, ref.layerId)[ref.idx]; if (o) { delete o.guideId; delete o.guidePos; } } dirtyCache(); render(); saveSnapshot(); } });
      } else {
        guides.forEach((g, i) => {
          items.push({ label: `Attach to Guide ${i + 1}`, action: () => { saveSnapshot(); for (const ref of S.selObjs) { const o = obs(S.frameIdx, ref.layerId)[ref.idx]; if (o && o.type !== 'guide' && o.type !== 'fill') { o.guideId = g._guideId; o.guidePos = 0; } } dirtyCache(); render(); saveSnapshot(); } });
        });
      }
      if (selObj0 && selObj0.guideId) {
        items.push({ label: 'Set Guide Position (0–1): ' + (selObj0.guidePos || 0).toFixed(2), action: () => {
          const val = prompt('Guide position (0 = start, 1 = end):', (selObj0.guidePos || 0).toFixed(2));
          if (val !== null) {
            saveSnapshot();
            const t = parseFloat(val);
            for (const ref of S.selObjs) { const o = obs(S.frameIdx, ref.layerId)[ref.idx]; if (o) o.guidePos = Math.max(0, Math.min(1, t)); }
            dirtyCache(); render(); saveSnapshot();
          }
        } });
      }
    }
    items.push({ label: 'Deselect', shortcut: 'Esc', action: () => { clearSel(); octx.clearRect(0, 0, overlay.width, overlay.height); } });
    showCtxMenu(items, e.clientX, e.clientY);
  }
});

function delSel() {
  if (!S.selObjs.length) return;
  saveSnapshot();
  // Group by layerId and sort by idx descending to avoid index shifting
  const byLayer = {};
  for (const ref of S.selObjs) {
    if (!byLayer[ref.layerId]) byLayer[ref.layerId] = [];
    byLayer[ref.layerId].push(ref.idx);
  }
  for (const [layerId, idxs] of Object.entries(byLayer)) {
    const objs = obs(S.frameIdx, layerId);
    const sorted = idxs.sort((a, b) => b - a);
    for (const idx of sorted) {
      objs.splice(idx, 1);
    }
  }
  clearSel();
  dirtyCache(); S.tlDirty = true;
  fullRender();
  octx.clearRect(0, 0, overlay.width, overlay.height);
}

let _clipboard = null;
let _frameClipboard = null; // copies entire frame content across layers
function copySel() {
  if (!S.selObjs.length) return;
  _clipboard = S.selObjs.map(ref => {
    const objs = obs(S.frameIdx, ref.layerId);
    return cloneObj(objs[ref.idx]);
  });
}
function copyFrameContent() {
  const f = S.frames[S.frameIdx];
  if (!f) return;
  const cur = L();
  _frameClipboard = (f.o[cur.id] || []).map(o => cloneObj(o));
}
function pasteFrameContent() {
  if (!_frameClipboard || !_frameClipboard.length) return;
  saveSnapshot();
  const cur = L();
  const objs = obs(S.frameIdx, cur.id);
  for (const item of _frameClipboard) {
    const c = cloneObj(item);
    if (c.pts) c.pts = c.pts.map(p => ({ x: p.x + 10, y: p.y + 10, ...(p.p !== undefined ? { p: p.p } : {}) }));
    if (c.x1 != null) { c.x1 += 10; c.y1 += 10; c.x2 += 10; c.y2 += 10; }
    if (c.type === 'text') { c.x += 10; c.y += 10; }
    objs.push(c);
  }
  dirtyCache(); fullRender(); saveSnapshot();
}
function cutSel() {
  copySel(); delSel();
}
function groupSelected() {
  if (S.selObjs.length < 2) return;
  saveSnapshot();
  const layerId = S.selObjs[0].layerId;
  const children = [];
  for (const ref of S.selObjs) {
    const objs = obs(S.frameIdx, ref.layerId);
    children.push(cloneObj(objs[ref.idx]));
  }
  delSel();
  const objs = obs(S.frameIdx, layerId);
  objs.push({ type: 'group', children, opacity: 1 });
  setSel({ layerId, idx: objs.length - 1 });
  dirtyCache(); fullRender(); drawSelection(); saveSnapshot();
}
function ungroupSelected() {
  if (S.selObjs.length !== 1) return;
  const ref = S.selObjs[0];
  const objs = obs(S.frameIdx, ref.layerId);
  const o = objs[ref.idx];
  if (!o || o.type !== 'group' || !o.children) return;
  saveSnapshot();
  const children = o.children.map(c => cloneObj(c));
  objs.splice(ref.idx, 1);
  const newRefs = [];
  for (const c of children) {
    objs.push(c);
    newRefs.push({ layerId: ref.layerId, idx: objs.length - 1 });
  }
  S.selObjs = newRefs;
  dirtyCache(); fullRender(); drawSelection(); saveSnapshot();
}

// Timeline context menu (new Animate-style frame cells)
const tlFrameRows = document.getElementById('tl-frame-rows');
if (tlFrameRows) {
  tlFrameRows.addEventListener('contextmenu', e => {
    const cell = e.target.closest('.tl-frame-cell');
    if (!cell) return;
    e.preventDefault();
    e.stopPropagation();
    const idx = parseInt(cell.dataset.frame);
    if (isNaN(idx)) return;
    const multi = _selectedFrames.size > 1;
    const items = [];
    const cur = L();
    if (!multi) {
      items.push({ label: `Frame ${idx + 1}${S.frames[idx] && S.frames[idx].key ? ' (Key)' : ''}`, disabled: true });
    } else {
      items.push({ label: `${_selectedFrames.size} frames selected`, disabled: true });
    }
    items.push({ sep: true });
    if (!multi) {
      items.push({ label: S.frames[idx] && S.frames[idx].key ? 'Remove Keyframe' : 'Add Keyframe', action: () => { saveSnapshot(); if (S.frames[idx]) { S.frames[idx].key = !S.frames[idx].key; } S.tlDirty = true; fullRender(); } });
      items.push({ sep: true });
    }
    items.push({ label: 'Duplicate Frame', shortcut: 'F5', action: () => { S.frameIdx = idx; dupFrame(); } });
    items.push({ label: 'Blank Frame', shortcut: 'F6', action: () => { S.frameIdx = idx; addEmptyFrame(); } });
    if (!multi) items.push({ label: 'Clear Frame', shortcut: 'Shift+F7', action: () => { S.frameIdx = idx; clearFrame(); } });
    if (multi) {
      items.push({ label: 'Delete Selected Frames', action: () => { delSelectedFrames(); } });
      items.push({ label: 'Key Selected Frames', action: () => { saveSnapshot(); for (const fi of _selectedFrames) { if (S.frames[fi]) { S.frames[fi].key = !S.frames[fi].key; } } S.tlDirty = true; fullRender(); } });
    } else {
      items.push({ label: 'Delete Frame', shortcut: 'Shift+F5', action: () => { S.frameIdx = idx; delFrame(); } });
    }
    items.push({ sep: true });
    items.push({ label: 'Generate Tweens', action: tweenAll });
    showCtxMenu(items, e.clientX, e.clientY);
  });
}

// Allow context menu on ruler cells too
const tlRuler = document.getElementById('tl-ruler');
if (tlRuler) {
  tlRuler.addEventListener('contextmenu', e => {
    const cell = e.target.closest('.tl-ruler-cell');
    if (!cell) return;
    const idx = Array.from(cell.parentNode.children).indexOf(cell);
    e.preventDefault();
    e.stopPropagation();
    const multi = _selectedFrames.size > 1;
    const items = [];
    if (!multi) items.push({ label: `Frame ${idx + 1}`, disabled: true });
    else items.push({ label: `${_selectedFrames.size} frames selected`, disabled: true });
    items.push({ sep: true });
    items.push({ label: 'Copy Frame', shortcut: 'Ctrl+C', action: () => { S.frameIdx = idx; copyFrameContent(); } });
    items.push({ label: 'Paste Frame', shortcut: 'Ctrl+V', action: () => { S.frameIdx = idx; pasteFrameContent(); } });
    items.push({ sep: true });
    items.push({ label: 'Duplicate Frame', shortcut: 'F5', action: () => { S.frameIdx = idx; dupFrame(); } });
    items.push({ label: 'Blank Frame', shortcut: 'F6', action: () => { S.frameIdx = idx; addEmptyFrame(); } });
    if (!multi) items.push({ label: 'Clear Frame', shortcut: 'Shift+F7', action: () => { S.frameIdx = idx; clearFrame(); } });
    if (multi) {
      items.push({ label: 'Delete Selected Frames', action: () => { delSelectedFrames(); } });
      items.push({ label: 'Key Selected Frames', action: () => { saveSnapshot(); for (const fi of _selectedFrames) { if (S.frames[fi]) { S.frames[fi].key = !S.frames[fi].key; } } S.tlDirty = true; fullRender(); } });
    } else {
      items.push({ label: 'Delete Frame', shortcut: 'Shift+F5', action: () => { S.frameIdx = idx; delFrame(); } });
    }
    items.push({ sep: true });
    items.push({ label: 'Generate Tweens', action: tweenAll });
    showCtxMenu(items, e.clientX, e.clientY);
  });
}

// ==================== EVENTS ====================
function setupEvents() {
  canvas.addEventListener('pointerdown', startDraw);
  canvas.addEventListener('pointerup', endDraw);
  // Handle pointercancel (pen lift, system interrupt) to release capture
  canvas.addEventListener('pointercancel', e => {
    if (!S.drawing) return;
    try { canvas.releasePointerCapture(e.pointerId); } catch(_) {}
    endDraw(e);
  });
  canvas.onmousemove = e => {
    S.lastME = e;
    const p = m2b(e);
    $('mouse-coords').textContent = `X: ${Math.round(p.x)} Y: ${Math.round(p.y)}`;
    if (S.tool === 'select' && selObj() && S.selObjs.length === 1 && !S.selMode) {
      const h = hitHandle(p);
      let cursor = 'default';
      if (h === 'pivot') cursor = 'move';
      else if (h && h.startsWith('rotate:')) {
        cursor = 'grab';
        S.rotateReadyCorner = h.split(':')[1];
        S.rotateReadyMouse = p;
      } else {
        S.rotateReadyCorner = null;
        S.rotateReadyMouse = null;
        if (h && h.startsWith('skew:')) {
          const edge = h.split(':')[1];
          if (edge === 'n' || edge === 's') cursor = 'ew-resize';
          else cursor = 'ns-resize';
        }
        else if (h) {
          if (h === 'nw' || h === 'se') cursor = 'nwse-resize';
          else if (h === 'ne' || h === 'sw') cursor = 'nesw-resize';
          else if (h === 'n' || h === 's') cursor = 'ns-resize';
          else if (h === 'e' || h === 'w') cursor = 'ew-resize';
        } else {
          const objs = obs(S.frameIdx, selObj().layerId);
          const o = objs[selObj().idx];
          if (o) {
            const b = getObjBounds(o);
            if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) cursor = 'move';
          }
        }
      }
      canvas.style.cursor = cursor;
    }
  };
  // Don't terminate stroke on mouseleave; use document-level pointermove with clamping
  document.addEventListener('pointermove', e => {
    if (!S.drawing) return;
    const r = canvas.getBoundingClientRect();
    draw({
      clientX: Math.max(r.left, Math.min(r.right, e.clientX)),
      clientY: Math.max(r.top, Math.min(r.bottom, e.clientY)),
      pressure: e.pressure,
    });
  });
  // End draw even if mouse is released outside the canvas
  document.addEventListener('pointerup', e => { endDraw(e); });
  canvas.ontouchstart = e => { e.preventDefault(); const t = e.touches[0]; canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: t.clientX, clientY: t.clientY, button: 0, pointerType: 'touch', pressure: t.force || 0.5 })); };
  canvas.ontouchmove = e => { e.preventDefault(); const t = e.touches[0]; canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: t.clientX, clientY: t.clientY, pointerType: 'touch', pressure: t.force || 0.5 })); };
  canvas.ontouchend = e => { e.preventDefault(); const t = e.changedTouches[0]; canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: t.clientX, clientY: t.clientY, pointerType: 'touch' })); };

  canvas.addEventListener('mousedown', e => {
    if (e.button === 1) { e.preventDefault(); S.panning = true; S.pSX = e.clientX - S.panX; S.pSY = e.clientY - S.panY; canvas.style.cursor = 'grabbing'; }
  });
  document.addEventListener('mousemove', e => { if (S.panning) { S.panX = e.clientX - S.pSX; S.panY = e.clientY - S.pSY; applyZoom(); } });
  document.addEventListener('mouseup', e => { if (e.button === 1 && S.panning) { S.panning = false; canvas.style.cursor = 'crosshair'; } });
  // Double-click on stroke path to insert a point
  $('canvas-area').addEventListener('wheel', e => {
    e.preventDefault();
    if (e.ctrlKey) {
      const cr = $('canvas-container').getBoundingClientRect();
      zoomAtMouse(-e.deltaY / 100, e.clientX - cr.left, e.clientY - cr.top);
    } else {
      S.panY -= e.deltaY * 0.5;
      applyZoom();
    }
  }, { passive: false });
  $('timeline-scroll').addEventListener('wheel', e => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const oldW = cellW();
      tlZoom = Math.max(0.3, Math.min(5, tlZoom - e.deltaY * 0.01));
      const newW = cellW();
      const scroll = e.currentTarget;
      // Keep mouse position stable during zoom
      const r = scroll.getBoundingClientRect();
      const mouseX = e.clientX - r.left;
      const ratio = newW / oldW;
      scroll.scrollLeft = scroll.scrollLeft * ratio + mouseX * (ratio - 1);
      S.tlDirty = true; updateTL(); updateFC();
    } else {
      e.currentTarget.scrollLeft += e.deltaY;
      e.preventDefault();
    }
  }, { passive: false });

  // Icons are already defined at top level, just use them here for tool buttons
  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.innerHTML = icons[btn.dataset.tool] || btn.innerHTML;
    btn.onclick = () => {
      document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      S.tool = btn.dataset.tool;
    };
  });
  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.addEventListener('click', updateToolProps);
  });
  // Property controls
  $('prop-size').oninput = e => { S.size = parseInt(e.target.value); $('brush-size').value = e.target.value; };
  $('prop-opacity').oninput = e => { S.opacity = parseInt(e.target.value) / 100; };
  $('prop-smoothness').oninput = e => { S.smoothness = parseInt(e.target.value); };
  $('prop-spacing').oninput = e => { S.spacing = parseInt(e.target.value); };
  $('prop-pressure').onchange = togglePressure;
  $('prop-pressure').onclick = togglePressure;
  function togglePressure() {
    S.pressureSens = $('prop-pressure').checked;
    const ps = $('pressure-settings');
    if (ps) ps.style.display = S.pressureSens ? '' : 'none';
  }
  $('prop-pressure-curve').onchange = e => {
    S.pressureCurve = e.target.value;
    const row = $('pressure-exp-row');
    if (row) row.style.display = e.target.value === 'custom' ? '' : 'none';
  };
  $('prop-pressure-exp').oninput = e => {
    S.pressureExp = parseInt(e.target.value) / 10;
    const lbl = $('pressure-exp-label');
    if (lbl) lbl.textContent = S.pressureExp.toFixed(1);
  };
  $('prop-pressure-min').oninput = e => {
    S.pressureMin = parseInt(e.target.value);
    const lbl = $('pressure-min-label');
    if (lbl) lbl.textContent = S.pressureMin + '%';
  };
  $('prop-merge').onchange = e => { S.mergeMode = e.target.checked; };
  $('prop-tolerance').oninput = e => { S.fillTolerance = parseFloat(e.target.value); };
  $('prop-auto-smooth').onchange = e => { S.autoSmooth = e.target.checked; };
  $('prop-pixel-snap').onchange = e => { S.pixelSnap = e.target.checked; };
  // Initial sync: top bar → prop panel
  $('prop-size').value = $('brush-size').value;
  $('prop-opacity').value = $('opacity').value;
  // Sync top bar size/opacity to prop panel
  $('brush-size').oninput = e => { S.size = parseInt(e.target.value); $('brush-size-label').textContent = e.target.value; $('prop-size').value = e.target.value; };
  $('opacity').oninput = e => { S.opacity = parseInt(e.target.value) / 100; $('prop-opacity').value = e.target.value; };

  // Properties panel tab switching
  document.querySelectorAll('.pan-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.pan-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.pan-body').forEach(b => {
        b.classList.remove('active');
        b.style.display = 'none';
      });
      const target = document.getElementById(tab.dataset.pan);
      if (target) {
        target.classList.add('active');
        target.style.display = '';
        if (tab.dataset.pan === 'pan-object') updateObjPanel();
      }
    });
  });

  // Collapsible sections
  document.querySelectorAll('.pan-section-header').forEach(hdr => {
    hdr.addEventListener('click', () => {
      const body = hdr.nextElementSibling;
      if (body && body.classList.contains('pan-section-body')) {
        body.classList.toggle('collapsed');
        hdr.classList.toggle('collapsed');
      }
    });
  });

  // Sync pan-stroke-color / pan-fill-color with main colors
  if ($('pan-stroke-color')) {
    $('pan-stroke-color').oninput = e => { S.stroke = e.target.value; if ($('stroke-color')) $('stroke-color').value = e.target.value; if ($('stroke-swatch')) $('stroke-swatch').style.background = e.target.value; };
  }
  if ($('pan-fill-color')) {
    $('pan-fill-color').oninput = e => { S.fill = e.target.value; if ($('fill-color')) $('fill-color').value = e.target.value; if ($('fill-swatch')) $('fill-swatch').style.background = e.target.value; };
  }

  updateToolProps();

  // Top bar icons
  $('new-project').innerHTML = icons.new;
  $('open-project').innerHTML = icons.open;
  $('save-project').innerHTML = icons.save;
  $('undo-btn').innerHTML = icons.undo;
  $('redo-btn').innerHTML = icons.redo;
  $('export-btn').innerHTML = icons.export;
  $('import-btn').innerHTML = icons.import;
  $('import-btn').onclick = importImage;

  $('stroke-color').oninput = e => { S.stroke = e.target.value; $('stroke-swatch').style.background = e.target.value; if ($('pan-stroke-color')) $('pan-stroke-color').value = e.target.value; };
  $('fill-color').oninput = e => { S.fill = e.target.value; $('fill-swatch').style.background = e.target.value; if ($('pan-fill-color')) $('pan-fill-color').value = e.target.value; };
  $('stroke-swatch').onclick = () => $('stroke-color').click();
  $('fill-swatch').onclick = () => $('fill-color').click();
  $('brush-size').oninput = e => { S.size = parseInt(e.target.value); $('brush-size-label').textContent = e.target.value; };
  $('opacity').oninput = e => S.opacity = parseInt(e.target.value) / 100;

  $('canvas-bg-color').value = S.bgColor;
  $('canvas-bg-color').oninput = e => { saveSnapshot(); S.bgColor = e.target.value; dirtyCache(); render(); };
  // Background image upload
  const bgInput = document.createElement('input');
  bgInput.type = 'file'; bgInput.accept = 'image/png,image/jpeg';
  bgInput.onchange = e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const img = new Image();
      img.onload = () => {
        saveSnapshot();
        S.bgImg = img;
        S.bgImgData = ev.target.result;
        $('pan-bgimg-row').style.display = 'flex';
        dirtyCache(); render();
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  };
  $('bg-img-btn').onclick = () => bgInput.click();
  $('bg-img-remove').onclick = () => {
    saveSnapshot();
    S.bgImg = null; S.bgImgData = null;
    if ($('pan-bgimg-row')) $('pan-bgimg-row').style.display = 'none';
    bgInput.value = '';
    dirtyCache(); render();
  };
  $('resize-canvas').onclick = () => {
    const nw = parseInt($('canvas-width').value), nh = parseInt($('canvas-height').value);
    if (nw > 0 && nh > 0) {
      saveSnapshot();
      const sx = nw / S.w, sy = nh / S.h;
      for (const f of S.frames) {
        for (const objs of Object.values(f.o || {})) {
          for (const o of objs) {
            if (o.pts) for (const p of o.pts) { p.x *= sx; p.y *= sy; }
            if (o.x1 != null) { o.x1 *= sx; o.y1 *= sy; o.x2 *= sx; o.y2 *= sy; }
            if (o.fc && o.fc.width) {
              const c = document.createElement('canvas');
              c.width = Math.round(o.fc.width * sx);
              c.height = Math.round(o.fc.height * sy);
              c.getContext('2d').drawImage(o.fc, 0, 0, c.width, c.height);
              o.fc = c;
            }
          }
        }
      }
      S.w = nw; S.h = nh;
      dirtyCache(); S.tlDirty = true;
      fullRender();
    }
  };

  // Old timeline controls (keep for compatibility)
  if ($('add-frame')) $('add-frame').onclick = addFrame;
  if ($('duplicate-frame')) $('duplicate-frame').onclick = dupFrame;
  if ($('delete-frame')) $('delete-frame').onclick = delFrame;
  if ($('add-keyframe')) {
    $('add-keyframe').innerHTML = icons.keyframe;
    $('add-keyframe').onclick = () => { saveSnapshot(); if (S.frames[S.frameIdx]) { S.frames[S.frameIdx].key = !S.frames[S.frameIdx].key; } S.tlDirty = true; fullRender(); };
  }
  if ($('tween-btn')) {
    $('tween-btn').innerHTML = icons.tween;
    $('tween-btn').onclick = tweenAll;
  }
  if ($('play-btn')) {
    $('play-btn').innerHTML = icons.play;
    $('play-btn').onclick = play;
  }
  if ($('first-frame')) $('first-frame').onclick = () => goFrame(0);
  if ($('prev-frame')) $('prev-frame').onclick = () => goFrame(S.frameIdx - 1);
  if ($('next-frame')) $('next-frame').onclick = () => goFrame(S.frameIdx + 1);
  if ($('last-frame')) $('last-frame').onclick = () => goFrame(S.frames.length - 1);

  // New Animate-style timeline toolbar buttons - set SVG icons
  if ($('tl-add-layer')) { $('tl-add-layer').innerHTML = icons.plus; $('tl-add-layer').onclick = addLayer; }
  if ($('tl-del-layer')) { $('tl-del-layer').innerHTML = icons.trash; $('tl-del-layer').onclick = () => { if (S.layers.length > 1) delLayer(); }; }
  if ($('tl-add-folder')) { $('tl-add-folder').innerHTML = icons.folder; $('tl-add-folder').onclick = () => alert('Folder layers not yet implemented'); }

  // Playback: step back/forward - set SVG icons
  if ($('tl-step-back')) { $('tl-step-back').innerHTML = icons.tlStepBack; $('tl-step-back').onclick = () => goFrame(S.frameIdx - 1); }
  if ($('tl-step-forward')) { $('tl-step-forward').innerHTML = icons.tlStepFwd; $('tl-step-forward').onclick = () => goFrame(S.frameIdx + 1); }

  // Previous/Next keyframe
  function prevKeyframe() {
    for (let i = S.frameIdx - 1; i >= 0; i--) {
      if (S.frames[i] && S.frames[i].key) { goFrame(i); return; }
    }
    goFrame(0);
  }
  function nextKeyframe() {
    const maxF = S.frames.length;
    for (let i = S.frameIdx + 1; i < maxF; i++) {
      if (S.frames[i] && S.frames[i].key) { goFrame(i); return; }
    }
    goFrame(maxF - 1);
  }
  if ($('tl-prev-keyframe')) { $('tl-prev-keyframe').innerHTML = icons.tlPrevKey; $('tl-prev-keyframe').onclick = prevKeyframe; }
  if ($('tl-next-keyframe')) { $('tl-next-keyframe').innerHTML = icons.tlNextKey; $('tl-next-keyframe').onclick = nextKeyframe; }

  // Play / Stop button
  if ($('tl-play-btn')) {
    $('tl-play-btn').innerHTML = S.playing ? icons.pause : icons.play;
    $('tl-play-btn').onclick = () => {
      play();
      $('tl-play-btn').innerHTML = S.playing ? icons.pause : icons.play;
    };
  }

  // First / Last frame
  if ($('tl-first-frame')) { $('tl-first-frame').innerHTML = icons.tlFirst; $('tl-first-frame').onclick = () => goFrame(0); }
  if ($('tl-last-frame')) { $('tl-last-frame').innerHTML = icons.tlLast; $('tl-last-frame').onclick = () => goFrame(S.frames.length - 1); }

  // Add / Insert / Delete frame buttons
  if ($('tl-add-frame')) { $('tl-add-frame').innerHTML = icons.tlAddFrame; $('tl-add-frame').onclick = () => addFrame(false); }
  if ($('tl-insert-keyframe')) {
    $('tl-insert-keyframe').innerHTML = icons.tlInsertKeyframe;
    $('tl-insert-keyframe').onclick = () => {
      saveSnapshot();
      if (S.frames[S.frameIdx]) S.frames[S.frameIdx].key = !S.frames[S.frameIdx].key;
      S.tlDirty = true;
      fullRender();
    };
  }
  if ($('tl-del-frame')) { $('tl-del-frame').innerHTML = icons.tlDelFrame; $('tl-del-frame').onclick = () => delFrame(); }
  if ($('tl-tween-btn')) { $('tl-tween-btn').innerHTML = icons.tween; $('tl-tween-btn').onclick = tweenAll; }

  // Onion skin toggle
  if ($('tl-onion-btn')) {
    $('tl-onion-btn').innerHTML = icons.tlOnion;
    $('tl-onion-btn').classList.toggle('active', S.onion);
    $('tl-onion-btn').onclick = () => {
      S.onion = !S.onion;
      $('tl-onion-btn').classList.toggle('active', S.onion);
      if ($('onion-skin')) $('onion-skin').checked = S.onion;
      if ($('prop-onion')) $('prop-onion').checked = S.onion;
      dirtyCache(); render();
    };
  }

  // Loop toggle
  if ($('tl-loop-btn')) {
    $('tl-loop-btn').innerHTML = icons.tlLoop;
    $('tl-loop-btn').classList.toggle('active', S.loop);
    $('tl-loop-btn').onclick = () => {
      S.loop = !S.loop;
      $('tl-loop-btn').classList.toggle('active', S.loop);
      if ($('loop-toggle')) $('loop-toggle').checked = S.loop;
    };
  }

  // Center frame
  if ($('tl-center-frame')) {
    $('tl-center-frame').innerHTML = icons.tlCenter;
    $('tl-center-frame').onclick = () => {
      const scroll = $('timeline-scroll');
      const target = S.frameIdx * cellW() - scroll.clientWidth / 2 + cellW() / 2;
      scroll.scrollLeft = Math.max(0, target);
    };
  }

  // Draw timeline (no-op placeholder)
  if ($('tl-draw-timeline')) { $('tl-draw-timeline').innerHTML = icons.tlDraw; $('tl-draw-timeline').onclick = () => {}; }

  if ($('fps-input')) $('fps-input').onchange = e => {
    saveSnapshot();
    S.fps = parseInt(e.target.value) || 12;
    if (S.playing) { clearInterval(_pi); _pi = setInterval(() => {
      if (S.frameIdx < S.frames.length - 1) S.frameIdx++;
      else if (S.loop) S.frameIdx = 0;
      else { play(); return; }
      updateTL(); fullRender();
    }, 1000 / S.fps); }
  };
  if ($('loop-toggle')) $('loop-toggle').onchange = e => { saveSnapshot(); S.loop = e.target.checked; };
  // Onion skin controls
  function setOnion(v) { saveSnapshot(); S.onion = v; if ($('onion-skin')) $('onion-skin').checked = v; if ($('prop-onion')) $('prop-onion').checked = v; dirtyCache(); render(); }
  if ($('onion-skin')) $('onion-skin').onchange = e => setOnion(e.target.checked);
  if ($('prop-onion')) $('prop-onion').onchange = e => setOnion(e.target.checked);
  if ($('prop-onion-opacity')) $('prop-onion-opacity').oninput = e => {
    saveSnapshot();
    S.onionOpacity = parseInt(e.target.value) / 100;
    if ($('prop-onion-opacity-label')) $('prop-onion-opacity-label').textContent = e.target.value + '%';
    dirtyCache(); render();
  };
  if ($('prop-onion-frames')) $('prop-onion-frames').onchange = e => {
    saveSnapshot();
    S.onionFrames = Math.max(1, parseInt(e.target.value) || 1);
    dirtyCache(); render();
  };
  // Sync property panel onion checkbox with timeline checkbox on init
  if ($('prop-onion')) $('prop-onion').checked = S.onion;
  if ($('prop-onion-opacity')) $('prop-onion-opacity').value = Math.round(S.onionOpacity * 100);
  if ($('prop-onion-opacity-label')) $('prop-onion-opacity-label').textContent = Math.round(S.onionOpacity * 100) + '%';
  if ($('prop-onion-frames')) $('prop-onion-frames').value = S.onionFrames;
  $('undo-btn').onclick = undo;
  // Layer buttons are now in timeline sidebar (updateTL)
  $('redo-btn').onclick = redo;
  $('zoom-level').ondblclick = centerZoom;
  // Alignment buttons
  if ($('align-left')) $('align-left').onclick = () => alignObject('left');
  if ($('align-center-h')) $('align-center-h').onclick = () => alignObject('center-h');
  if ($('align-right')) $('align-right').onclick = () => alignObject('right');
  if ($('align-top')) $('align-top').onclick = () => alignObject('top');
  if ($('align-center-v')) $('align-center-v').onclick = () => alignObject('center-v');
  if ($('align-bottom')) $('align-bottom').onclick = () => alignObject('bottom');

  // Object panel property controls
  if ($('obj-w')) $('obj-w').onchange = e => { const o = selObj(); if (!o) return; saveSnapshot(); const nw = parseFloat(e.target.value) || 1; for (const ref of S.selObjs) { const obj = obs(S.frameIdx, ref.layerId)[ref.idx]; if (!obj) continue; const bb = getObjBaseBounds(obj); if (bb.w > 0.1) { obj.scaleX = nw / bb.w; if (obj.pivotX == null) { const c = getObjCenter(obj); obj.pivotX = c.x; obj.pivotY = c.y; } } } dirtyCache(); render(); updateObjPanel(); };
  if ($('obj-h')) $('obj-h').onchange = e => { const o = selObj(); if (!o) return; saveSnapshot(); const nh = parseFloat(e.target.value) || 1; for (const ref of S.selObjs) { const obj = obs(S.frameIdx, ref.layerId)[ref.idx]; if (!obj) continue; const bb = getObjBaseBounds(obj); if (bb.h > 0.1) { obj.scaleY = nh / bb.h; if (obj.pivotY == null) { const c = getObjCenter(obj); obj.pivotX = c.x; obj.pivotY = c.y; } } } dirtyCache(); render(); updateObjPanel(); };
  if ($('obj-x')) $('obj-x').onchange = e => { if (!selObj()) return; saveSnapshot(); const b = getMultiBounds(); if (!b) return; const dx = parseFloat(e.target.value) - b.x; for (const ref of S.selObjs) { const obj = obs(S.frameIdx, ref.layerId)[ref.idx]; if (!obj) continue; if (obj.type === 'rect' || obj.type === 'circle' || obj.type === 'line') { obj.x1 += dx; obj.x2 += dx; } else if (obj.type === 'text') { obj.x += dx; } if (obj.pivotX != null) obj.pivotX += dx; } dirtyCache(); render(); updateObjPanel(); };
  if ($('obj-y')) $('obj-y').onchange = e => { if (!selObj()) return; saveSnapshot(); const b = getMultiBounds(); if (!b) return; const dy = parseFloat(e.target.value) - b.y; for (const ref of S.selObjs) { const obj = obs(S.frameIdx, ref.layerId)[ref.idx]; if (!obj) continue; if (obj.type === 'rect' || obj.type === 'circle' || obj.type === 'line') { obj.y1 += dy; obj.y2 += dy; } else if (obj.type === 'text') { obj.y += dy; } if (obj.pivotY != null) obj.pivotY += dy; } dirtyCache(); render(); updateObjPanel(); };
  if ($('obj-stroke-size')) $('obj-stroke-size').oninput = e => { const o = selObj(); if (!o) return; saveSnapshot(); const v = parseInt(e.target.value); for (const ref of S.selObjs) { const obj = obs(S.frameIdx, ref.layerId)[ref.idx]; if (obj) obj.size = v; } dirtyCache(); render(); updateObjPanel(); };


  document.addEventListener('keydown', e => {
    // Space: play/pause, but never when typing in text/number inputs
    if (e.key === ' ') {
      const tag = e.target.tagName;
      const type = e.target.type;
      if (tag === 'TEXTAREA' || (tag === 'INPUT' && (type === 'text' || type === 'number' || type === 'search'))) return;
      e.preventDefault(); play(); return;
    }
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    const k = e.key;
    if (S.playing) return;
    if (e.ctrlKey) {
      if (k === 'z') { e.preventDefault(); undo(); return; }
      if (k === 'y') { e.preventDefault(); redo(); return; }
      if (k === '0') { e.preventDefault(); centerZoom(); return; }
      if (k === '=') { e.preventDefault(); zoomAt(1); return; }
      if (k === '-') { e.preventDefault(); zoomAt(-1); return; }
      if (k === 'c') {
        e.preventDefault();
        if (S.selObjs.length) copySel();
        else copyFrameContent();
        return;
      }
      if (k === 'x') { e.preventDefault(); cutSel(); return; }
      if (k === 't') { e.preventDefault(); tweenAll(); return; }
      if (k === 'v') {
        e.preventDefault();
        if (_clipboard) {
          const l = L();
          if (l) {
            saveSnapshot();
            const objs = obs(S.frameIdx, l.id);
            const items = Array.isArray(_clipboard) ? _clipboard : [_clipboard];
            const newRefs = [];
            for (const item of items) {
              const c = cloneObj(item);
              if (c.pts) c.pts = c.pts.map(p => ({ x: p.x + 10, y: p.y + 10, ...(p.p !== undefined ? { p: p.p } : {}) }));
              if (c.x1 != null) { c.x1 += 10; c.y1 += 10; c.x2 += 10; c.y2 += 10; }
              if (c.type === 'text') { c.x += 10; c.y += 10; }
              objs.push(c);
              newRefs.push({ layerId: l.id, idx: objs.length - 1 });
            }
            S.selObjs = newRefs;
            dirtyCache(); fullRender(); drawSelection(); saveSnapshot();
          }
        } else if (_frameClipboard) {
          pasteFrameContent();
        }
        return;
      }
      if (k === 'g' && !e.shiftKey) { e.preventDefault(); groupSelected(); return; }
      if (k === 'g' && e.shiftKey) { e.preventDefault(); ungroupSelected(); return; }
      if (k === 'i') { e.preventDefault(); importImage(); return; }
    }
    const tm = { b: 'brush', p: 'pencil', e: 'eraser', r: 'rect', o: 'circle', l: 'line', g: 'fill', v: 'select', t: 'text', a: 'pen', m: 'guide' };
    if (tm[k]) { e.preventDefault(); switchTool(tm[k]); return; }
    // Arrow keys: move selected objects (if any), else navigate timeline
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(k)) {
      if (S.selObjs.length > 0) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        let dx = 0, dy = 0;
        if (k === 'ArrowLeft') dx = -step;
        else if (k === 'ArrowRight') dx = step;
        else if (k === 'ArrowUp') dy = -step;
        else if (k === 'ArrowDown') dy = step;
        saveSnapshot();
        for (const ref of S.selObjs) {
          const obj = obs(S.frameIdx, ref.layerId)[ref.idx];
          moveObjBy(obj, dx, dy);
        }
        dirtyCache(); render(); drawSelection(); saveSnapshot();
        return;
      }
    }
    // Arrow keys: navigate timeline (Animate style) — only when no selection
    if (k === 'ArrowLeft') { e.preventDefault(); goFrame(Math.max(0, S.frameIdx - 1)); return; }
    if (k === 'ArrowRight') { e.preventDefault(); goFrame(Math.min(S.frames.length - 1, S.frameIdx + 1)); return; }
    if (k === 'ArrowUp') { e.preventDefault(); const li = Math.max(0, S.layerIdx - 1); if (li !== S.layerIdx) { setActiveLayerByIndex(li); updateTL(); dirtyCache(); render(); } return; }
    if (k === 'ArrowDown') { e.preventDefault(); const li = Math.min(S.layers.length - 1, S.layerIdx + 1); if (li !== S.layerIdx) { setActiveLayerByIndex(li); updateTL(); dirtyCache(); render(); } return; }
    if (k === 'F5' && e.shiftKey) { e.preventDefault(); delFrame(); return; }
    if (k === 'F5') { e.preventDefault(); dupFrame(); return; }
    if (k === 'F6') { e.preventDefault(); addEmptyFrame(); return; }
    if (k === 'F7' && e.shiftKey) { e.preventDefault(); clearFrame(); return; }
    if (k === 'F7') { e.preventDefault(); saveSnapshot(); if (S.frames[S.frameIdx]) { S.frames[S.frameIdx].key = !S.frames[S.frameIdx].key; } S.tlDirty = true; fullRender(); return; }
    if ((k === 'Delete' || k === 'Backspace') && !selObj()) {
      e.preventDefault(); delSelectedFrames(); return;
    }
    if ((k === 'Delete' || k === 'Backspace') && selObj()) {
      const l = L();
      if (l) {
        delSel();
      }
    }
    if (k === 'Enter' && _penPath) { e.preventDefault(); finishPenPath(); return; }
    if (k === 'Escape') { clearSel(); octx.clearRect(0, 0, overlay.width, overlay.height); _tlScrub = false; _tlDrag = null; hideTlDragOverlay(); cancelPenPath(); }
  });
}

function updateObjPanel() {
  const ref = selObj();
  const objPanel = $('pan-object');
  const empty = $('obj-empty');
  if (!objPanel) return;
  if (!ref) {
    objPanel.querySelectorAll('.pan-section').forEach(s => s.style.display = 'none');
    if (empty) empty.style.display = '';
    return;
  }
  if (empty) empty.style.display = 'none';
  const objs = obs(S.frameIdx, ref.layerId);
  const o = objs ? objs[ref.idx] : null;
  const b = o ? getObjBounds(o) : null;
  objPanel.querySelectorAll('.pan-section').forEach(s => s.style.display = '');
  if (b) {
    if ($('obj-w')) $('obj-w').value = b.w.toFixed(2);
    if ($('obj-h')) $('obj-h').value = b.h.toFixed(2);
    if ($('obj-x')) $('obj-x').value = b.x.toFixed(2);
    if ($('obj-y')) $('obj-y').value = b.y.toFixed(2);
  }
  if (!o) return;
  // Type label in Drawing Object header
  const typeLabels = { stroke: 'Stroke', line: 'Line', rect: 'Rectangle', circle: 'Oval', fill: 'Fill', text: 'Text', group: 'Group', guide: 'Motion Guide' };
  const typeSpan = objPanel.querySelector('.pan-section-header .pan-obj-icon + span');
  if (typeSpan) typeSpan.textContent = typeLabels[o.type] || o.type;
  // Fill / Stroke colors
  const fillSwatch = $('obj-fill-swatch');
  const strokeSwatch = $('obj-stroke-swatch');
  if (o.fillColor && fillSwatch) { fillSwatch.style.background = o.fillColor; fillSwatch.style.color = 'transparent'; }
  else if (fillSwatch) { fillSwatch.style.background = 'transparent'; fillSwatch.style.color = '#555'; }
  if (o.color && strokeSwatch) { strokeSwatch.style.background = o.color; strokeSwatch.style.color = 'transparent'; }
  else if (strokeSwatch) { strokeSwatch.style.background = 'transparent'; strokeSwatch.style.color = '#555'; }
  // Opacity
  const op = o.opacity !== undefined ? o.opacity : 1;
  if ($('obj-fill-opacity-thumb')) $('obj-fill-opacity-thumb').style.left = Math.round(op * 100) + '%';
  if ($('obj-fill-opacity-pct')) $('obj-fill-opacity-pct').textContent = Math.round(op * 100) + '%';
  if ($('obj-stroke-opacity-thumb')) $('obj-stroke-opacity-thumb').style.left = Math.round(op * 100) + '%';
  if ($('obj-stroke-opacity-pct')) $('obj-stroke-opacity-pct').textContent = Math.round(op * 100) + '%';
  // Stroke size
  const sz = o.size !== undefined ? o.size : 0;
  if ($('obj-stroke-size')) $('obj-stroke-size').value = sz;
  // Miter
  if ($('obj-miter')) $('obj-miter').value = o.miterLimit !== undefined ? o.miterLimit : 3;
  // Hinting
  if ($('obj-hinting')) $('obj-hinting').checked = !!o.hinting;
}

function updateToolProps() {
  const title = $('tool-prop-title');
  const controls = $('tool-props');
  if (!controls) return;
  const rows = controls.querySelectorAll('.pan-row, .pan-check');
  rows.forEach(r => {
    if (r.closest('#pressure-settings')) return;
    r.style.display = 'none';
  });
  // Always show stroke/fill color rows
  const always = ['pan-stroke-color', 'pan-fill-color'];
  always.forEach(id => { const el = $(id); if (el) { const p = el.closest('.pan-row'); if (p) p.style.display = 'flex'; }});
  const show = id => { const el = $('prop-' + id); if (el) {
    const p = el.closest('.pan-row') || el.closest('.pan-check');
    if (p) p.style.display = 'flex';
  }};
  switch (S.tool) {
    case 'brush':
      title.textContent = 'Brush'; show('size'); show('opacity'); show('smoothness'); show('spacing'); show('pressure'); show('auto-smooth'); show('pixel-snap'); break;
    case 'pencil':
      title.textContent = 'Pencil'; show('smoothness'); show('pixel-snap'); break;
    case 'eraser':
      title.textContent = 'Eraser'; show('size'); show('opacity'); show('pixel-snap'); break;
    case 'rect': case 'circle': case 'line':
      title.textContent = S.tool.charAt(0).toUpperCase() + S.tool.slice(1); show('size'); show('opacity'); show('pixel-snap'); break;
    case 'fill':
      title.textContent = 'Fill'; show('tolerance'); break;
    case 'select':
      title.textContent = 'Select'; break;
    case 'text':
      title.textContent = 'Text'; show('size'); show('opacity'); show('pixel-snap'); break;
    case 'guide':
      title.textContent = 'Motion Guide'; show('size'); show('pixel-snap'); break;
    case 'pen':
      title.textContent = 'Pen'; show('pixel-snap'); break;
  }
  // Show/hide pressure settings sub-controls
  const ps = $('pressure-settings');
  if (ps) {
    ps.style.display = (S.tool === 'brush' && S.pressureSens) ? '' : 'none';
  }
}

function switchTool(t) {
  if (S.tool === 'pen' && _penPath) cancelPenPath();
  S.tool = t;
  document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
  const el = document.querySelector(`.tool-btn[data-tool="${t}"]`);
  if (el) el.classList.add('active');
  updateToolProps();
}

// ==================== RESIZE ====================
function hr() { applyZoom(); }
window.addEventListener('resize', hr);
const ro = new ResizeObserver(hr);
const ce = $('canvas-container');
if (ce) ro.observe(ce);

// ==================== AUTO-UPDATE ====================
const usEl = $('update-status');
usEl.onclick = () => {
  if (usEl.textContent.includes('restart')) ipcRenderer.send('restart-app');
};
ipcRenderer.on('update-status', (e, status) => {
  if (status === 'checking') usEl.textContent = 'Checking for updates...';
  else if (status === 'available') usEl.textContent = 'Downloading update...';
  else if (status === 'up-to-date') { usEl.textContent = ''; usEl.style.color = ''; }
  else if (status === 'downloaded') { usEl.textContent = 'Restart to update'; usEl.style.color = '#4fc3f7'; }
});
ipcRenderer.on('update-progress', (e, pct) => {
  usEl.textContent = `Downloading... ${Math.round(pct)}%`;
});

// ==================== INIT ====================
function init() {
  applyZoom();
  S.layers = [mkLayer('Layer 1')];
  S.layerIdx = 0;
  syncActiveLayer();
  if (S.activeLayerId != null) S.selLayerIds.add(S.activeLayerId);
  S.frames = [mkFrame()];
  S.frameIdx = 0;
  S.tlDirty = true;
  // Auto-save: check for saved state
  const saved = checkAutoSave();
  if (saved) {
    const s = saved;
    S.w = s.w; S.h = s.h; S.fps = s.fps; S.loop = s.loop;
    if (s.bgImgData) { const img = new Image(); img.onload = () => { S.bgImg = img; dirtyCache(); render(); }; img.src = s.bgImgData; S.bgImgData = s.bgImgData; if ($('pan-bgimg-row')) $('pan-bgimg-row').style.display = 'flex'; }
    if ($('canvas-width')) $('canvas-width').value = s.w;
    if ($('canvas-height')) $('canvas-height').value = s.h;
    if ($('canvas-bg-color')) $('canvas-bg-color').value = S.bgColor;
    if ($('fps-input')) $('fps-input').value = s.fps;
    if ($('loop-toggle')) $('loop-toggle').checked = s.loop;
  }
  fullRender();
  setupEvents();
  saveSnapshot();
  // Auto-save every 30 seconds
  setInterval(autoSave, 30000);
}
init();
hr();
