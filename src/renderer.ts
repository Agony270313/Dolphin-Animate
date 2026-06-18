const { ipcRenderer } = require('electron');
import { $, canvas, overlay, ctx, octx } from './core/DOM';
import { contours } from 'd3-contour';
import { getStroke } from 'perfect-freehand';

window.addEventListener('error', (e) => {
  alert('CRASH: ' + e.message + '\nAt: ' + e.filename + ':' + e.lineno);
});
window.addEventListener('unhandledrejection', (e) => {
  alert('PROMISE CRASH: ' + e.reason);
});

import { S, Globals, Symbols, IsolationMode, setIsolationMode } from './core/State';
import { initAudioUI, renderAudioTimeline, playAudioAtFrame, pauseAudio, loopAudioPlay, checkAudioFrame } from './timeline/AudioLayer';

export let savedState: any = null;
export let currentProjectPath: string | null = null;

export const defaultKeybindings: Record<string, string> = {
  'play_pause': ' ',
  'undo': 'Ctrl+z',
  'redo': 'Ctrl+y',
  'brush': 'b',
  'pencil': 'p',
  'eraser': 'e',
  'rect': 'r',
  'circle': 'o',
  'line': 'l',
  'fill': 'g',
  'select': 'v',
  'text': 't',
  'pen': 'a',
  'guide': 'm',
  'convert_to_symbol': 'F8',
  'group': 'g',
  'ungroup': 'Shift+G',
  'copy': 'Ctrl+c',
  'paste': 'Ctrl+v',
  'cut': 'Ctrl+x',
  'duplicate': 'Ctrl+d',
  'create_tween': 'Ctrl+t',
  'import_image': 'Ctrl+i',
  'zoom_in': 'Ctrl+=',
  'zoom_out': 'Ctrl+-',
  'zoom_reset': 'Ctrl+0',
  'new_project': 'Ctrl+n',
  'open_project': 'Ctrl+o',
  'save_project': 'Ctrl+s',
  'save_project_as': 'Ctrl+Shift+S',
};

export let KeyMap: Record<string, string> = { ...defaultKeybindings };
try {
  const savedKeys = localStorage.getItem('keybindings');
  if (savedKeys) KeyMap = { ...defaultKeybindings, ...JSON.parse(savedKeys) };
} catch(e) {}

export function showToast(msg: string) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const div = document.createElement('div');
  div.className = 'toast-msg';
  div.innerText = msg;
  container.appendChild(div);
  setTimeout(() => div.remove(), 3000);
}

export function matchKey(e: KeyboardEvent, shortcut: string): boolean {
  if (!shortcut) return false;
  const parts = shortcut.split('+').map(p => p.trim());
  const key = parts.pop();
  if (!key) return false;
  
  const requiresCtrl = parts.some(p => p.toLowerCase() === 'ctrl' || p.toLowerCase() === 'cmd');
  const requiresShift = parts.some(p => p.toLowerCase() === 'shift');
  const requiresAlt = parts.some(p => p.toLowerCase() === 'alt');

  if (e.ctrlKey !== requiresCtrl) return false;
  if (e.shiftKey !== requiresShift) return false;
  if (e.altKey !== requiresAlt) return false;
  
  if (key === ' ' && e.key === ' ') return true;
  return e.key.toLowerCase() === key.toLowerCase();
}

export function enterIsolationMode(symbolId: string, instanceRef?: {layerId: string, idx: number}) {
  if (IsolationMode) return;
  if (!Symbols[symbolId]) return;
  
  // Find the instance on stage to get its position (for Edit in Place)
  let instX = S.w / 2, instY = S.h / 2; // default to canvas center
  if (instanceRef) {
    const obj = obs(S.frameIdx, instanceRef.layerId)[instanceRef.idx];
    if (obj) { instX = obj.x || S.w / 2; instY = obj.y || S.h / 2; }
  } else {
    // Search for first instance of this symbol
    for (const l of S.layers) {
      const objs = obs(S.frameIdx, l.id);
      for (const o of objs) {
        if (o.type === 'symbol' && o.symbolId === symbolId) {
          instX = o.x || S.w / 2; instY = o.y || S.h / 2;
          break;
        }
      }
    }
  }

  savedState = {
    layers: S.layers,
    frames: S.frames,
    frameIdx: S.frameIdx,
    layerIdx: S.layerIdx,
    selObjs: S.selObjs,
    panX: S.panX,
    panY: S.panY,
    zoom: S.zoom,
    instX, instY,
  };
  setIsolationMode(symbolId);
  const breadcrumb = $('isolation-breadcrumb');
  if (breadcrumb) breadcrumb.style.display = 'flex';
  const symName = $('iso-sym-name');
  if (symName) symName.innerText = Symbols[symbolId].name;
  
  const sym = Symbols[symbolId];
  
  // Load symbol frames (multi-frame support)
  let symFrames: any[];
  if (sym.frames && sym.frames.length > 0) {
    // Symbol has saved frames — deep copy them
    symFrames = sym.frames.map(f => {
      const objs = (f.children || f.o?.['iso'] || []).map(c => cloneObj(c));
      // Offset by instance position for Edit in Place
      for (const c of objs) moveObjBy(c, instX, instY);
      return { o: { 'iso': objs }, key: f.key !== undefined ? f.key : true, _hist: [], _histIdx: -1 };
    });
  } else {
    // Legacy: single children array
    const children = (sym.children || []).map(c => cloneObj(c));
    for (const c of children) moveObjBy(c, instX, instY);
    symFrames = [{ o: { 'iso': children }, key: true, _hist: [], _histIdx: -1 }];
  }
  
  S.layers = [ { id: 'iso', name: 'Symbol', vis: true, lock: false, col: '#1aaeb0' } ];
  S.layerIdx = 0;
  S.frames = symFrames;
  S.frameIdx = 0;
  S.selObjs = [];
  
  setActiveLayerByIndex(0);
  updateTL();
  dirtyCache(); fullRender(); drawSelection();
}

export function exitIsolationMode() {
  if (!savedState) return;
  
  // Save ALL frames back to symbol (un-offset by instance position)
  const symId = IsolationMode;
  if (symId && Symbols[symId]) {
    const ix = savedState.instX || 0;
    const iy = savedState.instY || 0;
    
    const savedFrames = S.frames.map(f => {
      const objs = (f.o?.['iso'] || []).map(c => cloneObj(c));
      for (const c of objs) moveObjBy(c, -ix, -iy);
      return { children: objs, key: f.key };
    });
    
    Symbols[symId].frames = savedFrames;
    // Keep children as first frame for backward compat & thumbnail
    Symbols[symId].children = savedFrames[0]?.children || [];
  }
  
  setIsolationMode(null);
  const breadcrumb = $('isolation-breadcrumb');
  if (breadcrumb) breadcrumb.style.display = 'none';
  
  S.layers = savedState.layers;
  S.frames = savedState.frames;
  S.frameIdx = savedState.frameIdx;
  S.layerIdx = savedState.layerIdx;
  S.panX = savedState.panX;
  S.panY = savedState.panY;
  S.zoom = savedState.zoom;
  S.selObjs = [];
  savedState = null;
  
  if (typeof applyZoom === 'function') applyZoom();
  setActiveLayerByIndex(S.layerIdx);
  updateTL();
  refreshLibrary();
  dirtyCache(); fullRender(); drawSelection();
}

if ($('iso-exit-btn')) {
  $('iso-exit-btn').onclick = exitIsolationMode;
}
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
  
  const f = S.frames[S.frameIdx];
  if (f && f.cam) {
    const cx = S.w / 2, cy = S.h / 2;
    x -= cx; y -= cy;
    x /= f.cam.zoom; y /= f.cam.zoom;
    const rad = -f.cam.rotation * Math.PI / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const nx = x * cos - y * sin;
    const ny = x * sin + y * cos;
    x = nx + cx - f.cam.x;
    y = ny + cy - f.cam.y;
  }

  if (S.pixelSnap) { x = Math.round(x); y = Math.round(y); }
  return { x, y };
}

// ---- Frame / Layer helpers ----
function L() { 
  if (IsolationMode) return { id: 'iso', name: 'Symbol', visible: true, locked: false, opacity: 1 };
  return S.layers[S.layerIdx]; 
}
function F(i) { if (i === undefined) i = S.frameIdx; if (!S.frames[i]) S.frames[i] = { o: {}, key: true, _hist: [], _histIdx: -1 }; return S.frames[i]; }
function getExposureKeyframeIndexFor(frames: any[], fi: number): number {
  for (let i = fi; i >= 0; i--) {
    if (frames[i] && frames[i].key) return i;
  }
  return 0;
}
function getExposureKeyframeIndex(fi: number): number {
  return getExposureKeyframeIndexFor(S.frames, fi);
}
function toggleKeyframe(idx: number) {
  const f = S.frames[idx];
  if (!f) return;
  if (idx === 0) return; // Prevent removing keyframe on the first frame
  f.key = !f.key;
  if (f.key) {
    const prevKeyIdx = getExposureKeyframeIndex(idx - 1);
    const prevKeyFrame = S.frames[prevKeyIdx];
    if (prevKeyFrame) {
      for (const l of S.layers) {
        f.o[l.id] = prevKeyFrame.o[l.id] ? prevKeyFrame.o[l.id].map(o => cloneObj(o, true)) : [];
      }
    }
  } else {
    f.o = {};
  }
}
function obs(fi, li) {
  const fIdx = getExposureKeyframeIndex(fi);
  const f = F(fIdx);
  if (!f.o[li]) f.o[li] = [];
  return f.o[li];
}
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

function mkFrame() { return { o: {}, key: true, cam: { x: 0, y: 0, zoom: 1, rotation: 0 }, _hist: [], _histIdx: -1 }; }
function mkLayer(name) {
  const id = S.nextLayerId++;
  return { id, name, vis: true, lock: false, col: `hsl(${(id * 60) % 360}, 60%, 50%)` };
}

// ---- Vector draw primitives ----
function drawStroke(c, pts, color, size, opacity, composite, thinning, smoothing, simulatePressure) {
  if (!pts || pts.length < 2) return;
  c.save();
  c.globalAlpha = opacity;
  c.globalCompositeOperation = composite || 'source-over';
  c.strokeStyle = color;
  c.lineWidth = size;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  
  const level = S.aiHumanizeLevel ? parseInt(S.aiHumanizeLevel as any) : 0;
  const maxJitter = level === 1 ? 0.3 : (level === 2 ? 1.0 : (level >= 3 ? 2.5 : 0));
  
  // Use perfect-freehand for brush strokes (they contain 'p' values)
  const isFreehand = pts.some(p => p.p !== undefined);
  if (isFreehand && pts.length > 1) {
    const mappedPts = pts.map(p => {
      let px = p.x, py = p.y;
      if (maxJitter > 0) {
        const seed = Math.floor(px) * 1000 + Math.floor(py);
        px += ((Math.sin(seed * 12.9898) * 43758.5453) % 1) * maxJitter;
        py += ((Math.cos(seed * 78.233) * 43758.5453) % 1) * maxJitter;
      }
      return { x: px, y: py, pressure: p.p !== undefined ? p.p : 0.5 };
    });
    
    // Default to global settings ONLY if thinning/smoothing aren't explicitly provided
    const finalThinning = thinning !== undefined ? thinning : (S.thinning !== undefined ? S.thinning : 0.5);
    const finalSmoothing = smoothing !== undefined ? smoothing : (S.smoothing !== undefined ? S.smoothing : 0.5);
    const finalSimulatePressure = simulatePressure !== undefined ? simulatePressure : false;

    const outline = getStroke(mappedPts, {
      size: size,
      thinning: finalThinning,
      smoothing: finalSmoothing,
      streamline: 0.5,
      simulatePressure: finalSimulatePressure
    });
    
    if (outline.length > 0) {
      c.fillStyle = color;
      c.beginPath();
      c.moveTo(outline[0][0], outline[0][1]);
      for (let i = 1; i < outline.length; i++) {
        c.lineTo(outline[i][0], outline[i][1]);
      }
      c.closePath();
      c.fill();
    }
  } else {
    // Basic fallback for non-freehand strokes (like pen tool or simple dots)
    c.beginPath();
    let first = true;
    for (let i = 0; i < pts.length; i++) {
      let px = pts[i].x, py = pts[i].y;
      if (maxJitter > 0) {
        const seed = Math.floor(px) * 1000 + Math.floor(py);
        px += ((Math.sin(seed * 12.9898) * 43758.5453) % 1) * maxJitter;
        py += ((Math.cos(seed * 78.233) * 43758.5453) % 1) * maxJitter;
      }
      if (first) { c.moveTo(px, py); first = false; }
      else { c.lineTo(px, py); }
    }
    
    if (pts.length === 1) {
      c.fillStyle = color;
      c.beginPath(); c.arc(pts[0].x, pts[0].y, size / 2, 0, Math.PI * 2); c.fill();
    } else {
      c.stroke();
    }
  }
  c.restore();
}

function drawShape(c, t, x1, y1, x2, y2, color, fill, size, opacity) {
  c.save();
  c.globalAlpha = opacity;
  c.strokeStyle = color;
  c.lineWidth = size;
  c.lineCap = 'round';

  let dx1 = x1, dy1 = y1, dx2 = x2, dy2 = y2;
  const level = S.aiHumanizeLevel ? parseInt(S.aiHumanizeLevel as any) : 0;
  if (level > 0) {
    const maxJitter = level === 1 ? 0.3 : (level === 2 ? 1.0 : 2.5);
    const seed = Math.floor(x1) * 1000 + Math.floor(y1);
    const nx1 = (Math.sin(seed * 12.9898) * 43758.5453) % 1;
    const ny1 = (Math.cos(seed * 78.233) * 43758.5453) % 1;
    const nx2 = (Math.sin((seed+1) * 12.9898) * 43758.5453) % 1;
    const ny2 = (Math.cos((seed+1) * 78.233) * 43758.5453) % 1;
    dx1 += nx1 * maxJitter; dy1 += ny1 * maxJitter;
    dx2 += nx2 * maxJitter; dy2 += ny2 * maxJitter;
  }
  c.lineJoin = 'round';
  c.fillStyle = fill || color;
  if (t === 'line') { c.beginPath(); c.moveTo(dx1, dy1); c.lineTo(dx2, dy2); c.stroke(); }
  else if (t === 'rect') {
    const l = Math.min(dx1, dx2), t = Math.min(dy1, dy2), w = Math.abs(dx2 - dx1), h = Math.abs(dy2 - dy1);
    c.fillRect(l, t, w, h); c.strokeRect(l, t, w, h);
  } else if (t === 'circle') {
    const cx = (dx1 + dx2) / 2, cy = (dy1 + dy2) / 2, rx = Math.abs(dx2 - dx1) / 2, ry = Math.abs(dy2 - dy1) / 2;
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
  const drawLayer = (ctx, fi, sc, layerId, baseAlpha = 1, customFrames = S.frames, customLayers = S.layers) => {
    ctx.save();
    if (sc !== 1) ctx.scale(sc, sc);
    const f = customFrames[fi];
    if (f && f.cam) {
      const cx = S.w / 2, cy = S.h / 2;
      ctx.translate(cx, cy);
      ctx.scale(f.cam.zoom, f.cam.zoom);
      ctx.rotate(f.cam.rotation * Math.PI / 180);
      ctx.translate(-cx - f.cam.x, -cy - f.cam.y);
    }
    if (!f) { ctx.restore(); return; }
    const l = customLayers.find(l => l.id === layerId);
    if (!l || !l.vis) { ctx.restore(); return; }
    const targetFi = getExposureKeyframeIndexFor(customFrames, fi);
    const targetF = customFrames[targetFi] || f;
    const objs = targetF.o[l.id] || [];
      // --- First pass: draw fills BEHIND everything ---
      for (const o of objs) {
        if (o.type === 'fillPath' && o.layerId) continue;
        if (hasTransform(o) || o.angle) {
          const m = getObjMatrix(o);
          ctx.save();
          ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
        }

        const isSym = o.type === 'symbol';
        const isGrp = o.type === 'group';

        // Translate symbol instances to their x,y position
        if (isSym && (o.x || o.y)) {
          ctx.save();
          ctx.translate(o.x || 0, o.y || 0);
        }
        
        if (o.type === 'fill') {
          ctx.save();
          ctx.translate(o.x || 0, o.y || 0);
          drawFill(ctx, o.fc, o.opacity * baseAlpha);
          ctx.restore();
        } else if (o.type === 'fillPath') {
          drawFillPathObj(ctx, o, baseAlpha);
        }
        if (isSym && (o.x || o.y)) ctx.restore();
        if (hasTransform(o) || o.angle) ctx.restore();
      }
      // --- Second pass: draw strokes, shapes, text ON TOP ---
      for (const o of objs) {
        ctx.save();
        // Motion guide: temporarily translate object to follow guide path
        if (o.guideId && o.type !== 'guide' && o.type !== 'fill' && o.type !== 'fillPath') {
          const guides = getAllGuides(fi);
          const guide = guides.find(g => g._guideId === o.guideId);
          if (guide && guide.pts && guide.pts.length > 1) {
            const p1 = guide.pts[0], p2 = guide.pts[guide.pts.length - 1];
            const t = S.frames[fi]._tweenPct !== undefined ? S.frames[fi]._tweenPct : 0;
            const pt = getPointOnPath(guide.pts, t);
            const cx = (p1.x + p2.x) / 2;
            const cy = (p1.y + p2.y) / 2;
            ctx.translate(pt.x - cx, pt.y - cy);
          }
        }
        if (hasTransform(o) || o.angle) {
          const m = getObjMatrix(o);
          ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
        }

        const isSym = o.type === 'symbol';
        const isGrp = o.type === 'group';

        // Translate symbol instances to their x,y position
        if (isSym && (o.x || o.y)) {
          ctx.translate(o.x || 0, o.y || 0);
        }

        if (o.type === 'stroke') {
          const subs = o.subs && o.subs.length ? o.subs : (o.pts ? [{ pts: o.pts, size: o.size, color: o.color, opacity: o.opacity }] : []);
          for (const sub of subs) {
            const color = sub.color || o.color;
            const size = sub.size !== undefined ? sub.size : o.size;
            const opacity = (sub.opacity !== undefined ? sub.opacity : o.opacity) * baseAlpha;
            drawStroke(ctx, sub.pts, color, size, opacity, o.composite || 'source-over', o.thinning, o.smoothing, o.simulatePressure);
          }
        } else if (o.type === 'text') {
          ctx.save();
          ctx.font = `${o.bold ? 'bold ' : ''}${o.italic ? 'italic ' : ''}${o.size}px "${o.font}"`;
          ctx.fillStyle = o.color;
          ctx.globalAlpha = o.opacity * baseAlpha;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';
          const lines = o.text.split('\n');
          for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], o.x, o.y + i * (o.size * 1.2));
          ctx.restore();
        } else if ((isGrp || isSym)) {
          let children;
          if (isSym) {
            const sym = Symbols[o.symbolId];
            if (sym.frames && sym.frames.length > 1) {
              const symFi = fi % sym.frames.length;
              children = sym.frames[symFi]?.children || sym.children;
            } else {
              children = sym.children;
            }
          } else {
            children = o.children;
          }
          if (children) {
            const renderGroupUnified = (groupChildren) => {
              for (const child of groupChildren) {
                if (child.type === 'fill') {
                  ctx.save();
                  ctx.translate(child.x || 0, child.y || 0);
                  drawFill(ctx, child.fc, child.opacity * baseAlpha);
                  ctx.restore();
                } else if (child.type === 'fillPath') {
                  const hasTx = hasTransform(child) || child.angle;
                  if (hasTx) {
                    const m = getObjMatrix(child);
                    ctx.save();
                    ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
                  }
                  drawFillPathObj(ctx, child, baseAlpha);
                  if (hasTx) ctx.restore();
                } else if (child.type === 'stroke') {
                  const hasTx = hasTransform(child) || child.angle;
                  if (hasTx) {
                    const m = getObjMatrix(child);
                    ctx.save();
                    ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
                  }
                  const subs = child.subs && child.subs.length ? child.subs : (child.pts ? [{ pts: child.pts, size: child.size, color: child.color, opacity: child.opacity }] : []);
                  for (const sub of subs) {
                    const color = sub.color || child.color;
                    const size = sub.size !== undefined ? sub.size : child.size;
                    const opacity = (sub.opacity !== undefined ? sub.opacity : child.opacity) * baseAlpha;
                    drawStroke(ctx, sub.pts, color, size, opacity, child.composite || 'source-over', child.thinning, child.smoothing, child.simulatePressure);
                  }
                  if (hasTx) ctx.restore();
                } else if (child.type === 'text') {
                  const hasTx = hasTransform(child) || child.angle;
                  if (hasTx) {
                    const m = getObjMatrix(child);
                    ctx.save();
                    ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
                  }
                  ctx.save();
                  ctx.font = `${child.bold ? 'bold ' : ''}${child.italic ? 'italic ' : ''}${child.size}px "${child.font}"`;
                  ctx.fillStyle = child.color;
                  ctx.globalAlpha = child.opacity * baseAlpha;
                  ctx.textAlign = 'left';
                  ctx.textBaseline = 'top';
                  const lines = child.text.split('\n');
                  for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], child.x, child.y + i * (child.size * 1.2));
                  ctx.restore();
                  if (hasTx) ctx.restore();
                } else if (child.type === 'group') {
                  const hasTx = hasTransform(child) || child.angle;
                  if (hasTx) {
                    const m = getObjMatrix(child);
                    ctx.save();
                    ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
                  }
                  if (child.children) renderGroupUnified(child.children);
                  if (hasTx) ctx.restore();
                } else if (child.type === 'symbol') {
                  const hasTx = hasTransform(child) || child.angle;
                  if (hasTx) {
                    const m = getObjMatrix(child);
                    ctx.save();
                    ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
                  }
                  if (child.x || child.y) {
                    if (!hasTx) ctx.save();
                    ctx.translate(child.x || 0, child.y || 0);
                  }
                  if (Symbols[child.symbolId] && Symbols[child.symbolId].children) renderGroupUnified(Symbols[child.symbolId].children);
                  if (hasTx || child.x || child.y) ctx.restore();
                } else if (child.type !== 'fill' && child.type !== 'fillPath') {
                  drawShape(ctx, child.type, child.x1, child.y1, child.x2, child.y2, child.color, child.fillColor, child.size, child.opacity * baseAlpha);
                }
              }
            };
            renderGroupUnified(children);
          }
        }
        else if (o.type !== 'fill' && o.type !== 'fillPath') drawShape(ctx, o.type, o.x1, o.y1, o.x2, o.y2, o.color, o.fillColor, o.size, o.opacity * baseAlpha);
        ctx.restore();
    }
    ctx.restore();
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

  if (IsolationMode && savedState) {
    c.save();
    c.globalAlpha = 0.3; // Dim the main scene
    for (const l of savedState.layers) {
      if (!l.vis) continue;
      drawLayer(c, savedState.frameIdx, sc, l.id, 0.3, savedState.frames, savedState.layers);
    }
    c.restore();
  }

  // 2) Onion skin ghosts
  if (!noOnion && S.onion) {
    // Past frames (Red)
    for (let i = S.onionFrames; i >= 1; i--) {
      if (fi - i < 0) continue;
      const alpha = S.onionOpacity * (1 - (i - 1) / S.onionFrames);
      _roc = ensureSize(_roc, c.canvas.width, c.canvas.height);
      _rocCtx = _roc.getContext('2d');
      _rocCtx.clearRect(0, 0, _roc.width, _roc.height);
      for (const l of S.layers) {
        if (!l.vis) continue;
        _rlc = ensureSize(_rlc, c.canvas.width, c.canvas.height);
        _rlcCtx = _rlc.getContext('2d');
        _rlcCtx.clearRect(0, 0, _rlc.width, _rlc.height);
        drawLayer(_rlcCtx, fi - i, sc, l.id, 1);
        _rocCtx.drawImage(_rlc, 0, 0);
      }
      _rocCtx.save();
      _rocCtx.globalCompositeOperation = 'source-in';
      _rocCtx.fillStyle = '#ff4b4b'; // Red for past
      _rocCtx.fillRect(0, 0, _roc.width, _roc.height);
      _rocCtx.restore();

      c.save();
      c.globalAlpha = alpha;
      c.drawImage(_roc, 0, 0);
      c.restore();
    }
    
    // Future frames (Green)
    for (let i = S.onionFrames; i >= 1; i--) {
      if (fi + i >= S.frames.length) continue;
      const alpha = S.onionOpacity * (1 - (i - 1) / S.onionFrames);
      _roc = ensureSize(_roc, c.canvas.width, c.canvas.height);
      _rocCtx = _roc.getContext('2d');
      _rocCtx.clearRect(0, 0, _roc.width, _roc.height);
      for (const l of S.layers) {
        if (!l.vis) continue;
        _rlc = ensureSize(_rlc, c.canvas.width, c.canvas.height);
        _rlcCtx = _rlc.getContext('2d');
        _rlcCtx.clearRect(0, 0, _rlc.width, _rlc.height);
        drawLayer(_rlcCtx, fi + i, sc, l.id, 1);
        _rocCtx.drawImage(_rlc, 0, 0);
      }
      _rocCtx.save();
      _rocCtx.globalCompositeOperation = 'source-in';
      _rocCtx.fillStyle = '#4caf50'; // Green for future
      _rocCtx.fillRect(0, 0, _roc.width, _roc.height);
      _rocCtx.restore();

      c.save();
      c.globalAlpha = alpha;
      c.drawImage(_roc, 0, 0);
      c.restore();
    }
  }
  // 3) Draw each layer on its own canvas, composite bottom-up
  const f = S.frames[fi];
  if (f) {
    for (const l of S.layers) {
      if (!l.vis) continue;
      const targetFi = getExposureKeyframeIndexFor(S.frames, fi);
      const targetF = S.frames[targetFi] || f;
      const objs = targetF.o[l.id] || [];
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
let _eraserCanvas = null, _eraserCtx = null; // temp canvas for per-stroke eraser rendering
let _roc = null, _rocCtx = null;  // onion composite canvas (reused across onion frames)



function ensureSize(cv, w, h) {
  if (!cv) {
    if (typeof OffscreenCanvas !== 'undefined') cv = new OffscreenCanvas(w, h);
    else { cv = document.createElement('canvas'); cv.width = w; cv.height = h; }
    return cv;
  }
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  return cv;
}
let _thumbCache = {}, _thumbsDirty = true;

let _cacheCanvas = null;
function buildCache(bs) {
  const pw = Math.round(S.w * bs), ph = Math.round(S.h * bs);
  if (!_cacheCanvas) _cacheCanvas = document.createElement('canvas');
  _cacheCanvas.width = pw; _cacheCanvas.height = ph;
  const cx = _cacheCanvas.getContext('2d');
  cx.imageSmoothingEnabled = true;
  cx.imageSmoothingQuality = 'high';
  renderFrame(cx, S.frameIdx, bs);
  _cache = _cacheCanvas;
  _cacheZoom = S.zoom;
  _cacheFrame = S.frameIdx;
  _cacheBs = bs;
  return _cacheCanvas;
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

let _renderPending = false;
function renderThrottled() {
  if (_renderPending) return;
  _renderPending = true;
  requestAnimationFrame(() => { _renderPending = false; render(); drawSelection(); });
}

// Draw current stroke on overlay (lightweight, called on every mousemove)
function renderOverlay() {
  const pw = overlay.width, ph = overlay.height;
  octx.clearRect(0, 0, pw, ph);

  const f = S.frames[S.frameIdx];
  const cam = f && f.cam ? f.cam : { x: 0, y: 0, zoom: 1, rotation: 0 };

  if (S.tool === 'camera') {
    if (f && f.cam) {
      octx.save();
      const bs = bufScale();
      if (bs !== 1) octx.scale(bs, bs);
      const cx = S.w / 2, cy = S.h / 2;
      
      octx.fillStyle = 'rgba(0,0,0,0.6)';
      octx.fillRect(-S.w * 2, -S.h * 2, S.w * 5, S.h * 5); 

      octx.globalCompositeOperation = 'destination-out';
      octx.translate(cx, cy);
      octx.scale(f.cam.zoom, f.cam.zoom);
      octx.rotate(f.cam.rotation * Math.PI / 180);
      octx.translate(-cx - f.cam.x, -cy - f.cam.y);
      octx.fillRect(0, 0, S.w, S.h); 

      octx.globalCompositeOperation = 'source-over';
      octx.strokeStyle = '#a134eb'; 
      octx.lineWidth = 2 / f.cam.zoom;
      octx.strokeRect(0, 0, S.w, S.h);
      octx.restore();
    }
  }

  const bs = bufScale();

  // Draw cursor size
  if (['brush', 'eraser', 'pencil'].includes(S.tool) && S.lastME && !S.drawing) {
    const p = m2b(S.lastME);
    const size = S.tool === 'pencil' ? 1 : S.size;
    octx.save();
    if (bs !== 1) octx.scale(bs, bs);
    
    // Apply camera
    const cx = S.w / 2, cy = S.h / 2;
    octx.translate(cx, cy);
    octx.scale(cam.zoom, cam.zoom);
    octx.rotate(cam.rotation * Math.PI / 180);
    octx.translate(-cx - cam.x, -cy - cam.y);

    octx.beginPath();
    octx.arc(p.x, p.y, size / 2, 0, Math.PI * 2);
    octx.strokeStyle = S.tool === 'eraser' ? '#ff6b6b' : 'rgba(128,128,128,0.8)';
    octx.lineWidth = 1 / cam.zoom;
    octx.stroke();
    octx.restore();
  }

  if (!S.curStroke) return;
  octx.save();
  if (bs !== 1) octx.scale(bs, bs);
  
  // Apply camera to active stroke too!
  const cx = S.w / 2, cy = S.h / 2;
  octx.translate(cx, cy);
  octx.scale(cam.zoom, cam.zoom);
  octx.rotate(cam.rotation * Math.PI / 180);
  octx.translate(-cx - cam.x, -cy - cam.y);

  if (S.tool === 'eraser') {
    drawStroke(octx, S.curStroke.pts, '#ff6b6b', S.curStroke.size + 2, 0.4, 'source-over', S.curStroke.thinning, S.curStroke.smoothing, S.curStroke.simulatePressure);
  } else {
    drawStroke(octx, S.curStroke.pts, S.curStroke.color, S.curStroke.size, S.curStroke.opacity, 'source-over', S.curStroke.thinning, S.curStroke.smoothing, S.curStroke.simulatePressure);
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

// Densify path so no segment exceeds maxLen (prevents long line segments from causing wide erasure)
function densifyPath(pts, maxLen) {
  if (!pts || pts.length < 2) return pts || [];
  const r = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = r[r.length - 1], b = pts[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > maxLen && dist > 0) {
      const steps = Math.ceil(dist / maxLen);
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        const np = { x: a.x + dx * t, y: a.y + dy * t };
        if (a.p !== undefined && b.p !== undefined) np.p = a.p + (b.p - a.p) * t;
        r.push(np);
      }
    }
    r.push(b);
  }
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
  const targetFi = getExposureKeyframeIndex(fi);
  const f = S.frames[targetFi];
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
  const fIdx = getExposureKeyframeIndex(fi);
  const f = S.frames[fIdx];
  if (!f) return {};
  const data = {};
  for (const l of S.layers) {
    data[l.id] = f.o[l.id] ? f.o[l.id].map(cloneObj) : [];
  }
  return data;
}
function saveSnapshot() {
  const fIdx = getExposureKeyframeIndex(S.frameIdx);
  const f = F(fIdx);
  f._hist = f._hist.slice(0, f._histIdx + 1);
  f._hist.push(cloneFrameObjects(fIdx));
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
      if (r.eraserFc) {
        const ec = document.createElement('canvas');
        ec.width = r.eraserFc.width; ec.height = r.eraserFc.height;
        ec.getContext('2d').drawImage(r.eraserFc, 0, 0);
        r.eraserFc = ec;
      }
      if (r.children) r.children = r.children.map(child => {
        if (child.fc) {
          const cc = document.createElement('canvas');
          cc.width = child.fc.width; cc.height = child.fc.height;
          cc.getContext('2d').drawImage(child.fc, 0, 0);
          return { ...child, fc: cc };
        }
        const rc = { ...child, pts: child.pts ? child.pts.map(p => ({ x: p.x, y: p.y, ...(p.p !== undefined ? { p: p.p } : {}) })) : undefined };
        if (child.eraserFc) {
          const ec = document.createElement('canvas');
          ec.width = child.eraserFc.width; ec.height = child.eraserFc.height;
          ec.getContext('2d').drawImage(child.eraserFc, 0, 0);
          rc.eraserFc = ec;
        }
        return rc;
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
  const fIdx = getExposureKeyframeIndex(S.frameIdx);
  const f = S.frames[fIdx];
  if (!f || f._histIdx <= 0) return;
  f._histIdx--;
  restoreSnapshot(fIdx);
  syncUI(); updateObjPanel();
  dirtyCache(); S.tlDirty = true;
  fullRender(); updateLayerUI();
}

function redo() {
  const fIdx = getExposureKeyframeIndex(S.frameIdx);
  const f = S.frames[fIdx];
  if (!f || f._histIdx >= f._hist.length - 1) return;
  f._histIdx++;
  restoreSnapshot(fIdx);
  syncUI(); updateObjPanel();
  dirtyCache(); S.tlDirty = true;
  fullRender(); updateLayerUI();
}

// ==================== DRAWING ====================
function startDraw(e) {
  if (S.tool === 'camera') {
    if (e.button !== 0) return;
    const f = S.frames[S.frameIdx];
    if (f && !f.cam) f.cam = { x: 0, y: 0, zoom: 1, rotation: 0 };
    S.drawing = true;
    S._camStartX = f.cam.x;
    S._camStartY = f.cam.y;
    S.lx = e.clientX;
    S.ly = e.clientY;
    return;
  }
  if (e.button !== 0) return;
  const l = L();
  if (!l || l.lock) return;
  const p = m2b(e);
  S.drawing = true;
  S.lx = p.x; S.ly = p.y;
  S.sx = p.x; S.sy = p.y;

  if (S.tool === 'select') { selDown(p, e.ctrlKey, e.altKey); return; }
  if (S.tool === 'fill') { doFill(p); S.drawing = false; return; }
  if (S.tool === 'picker') {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) * (canvas.width / rect.width));
    const y = Math.floor((e.clientY - rect.top) * (canvas.height / rect.height));
    const px = ctx.getImageData(x, y, 1, 1).data;
    if (px[3] > 0) {
      const hex = '#' + [px[0], px[1], px[2]].map(v => v.toString(16).padStart(2, '0')).join('');
      S.stroke = hex; S.fill = hex;
      if ($('stroke-color')) $('stroke-color').value = hex;
      if ($('fill-color')) $('fill-color').value = hex;
      if ($('stroke-swatch')) $('stroke-swatch').style.background = hex;
      if ($('fill-swatch')) $('fill-swatch').style.background = hex;
    }
    S.drawing = false;
    return;
  }
  if (S.tool === 'text') { e.preventDefault(); e.stopPropagation(); doText(e); S.drawing = false; return; }
  if (S.tool === 'pen') { startPen(p); return; }
  // Capture pointer so pen/mouse events always reach canvas even outside
  try { canvas.setPointerCapture(e.pointerId); } catch(_) {}

  if (['brush', 'pencil', 'eraser', 'guide'].includes(S.tool)) {
    const pressure = S.pressureSens ? pressureCurve(e.pressure || 0.5) : 0.5;
    S.curStroke = {
      pts: [{ x: p.x, y: p.y, p: pressure }],
      color: S.tool === 'guide' ? '#4fc3f7' : S.stroke,
      size: S.tool === 'pencil' ? 1 : (S.tool === 'guide' ? 2 : S.size),
      opacity: S.tool === 'guide' ? 0.6 : S.opacity,
      composite: S.tool === 'eraser' ? 'destination-out' : 'source-over',
      thinning: S.thinning,
      smoothing: S.smoothing,
      isGuide: S.tool === 'guide',
      simulatePressure: S.pressureSens && e.pointerType === 'mouse',
    };
    render();
  }
}

function draw(e) {
  if (!S.drawing) return;
  if (S.tool === 'camera') {
    const f = S.frames[S.frameIdx];
    const dx = (S.lx - e.clientX) / S.zoom / f.cam.zoom;
    const dy = (S.ly - e.clientY) / S.zoom / f.cam.zoom;
    const rad = -f.cam.rotation * Math.PI / 180;
    f.cam.x = S._camStartX + (dx * Math.cos(rad) - dy * Math.sin(rad));
    f.cam.y = S._camStartY + (dx * Math.sin(rad) + dy * Math.cos(rad));
    S.tlDirty = true;
    renderThrottled();
    return;
  }
  const p = m2b(e);
  if (S.tool === 'select') { selMove(p, e); return; }
  if (S.tool === 'pen') { drawPen(p); return; }

  if (['brush', 'pencil', 'eraser', 'guide'].includes(S.tool)) {
      if (S.curStroke) {
        const last = S.curStroke.pts[S.curStroke.pts.length - 1];
        if (last && S.tool !== 'guide') {
          const dx = p.x - last.x, dy = p.y - last.y;
          const minSp = S.tool === 'brush' ? 1.5 : 0.5;
          const spacingVal = S.spacing || 0;
          // Apply zoom correction to spacing threshold so drawing density is consistent in screen pixels
          const f = S.frames[S.frameIdx];
          const totalZoom = S.zoom * ((f && f.cam) ? f.cam.zoom : 1);
          const limit = Math.max(minSp, spacingVal) / totalZoom;
          if (dx * dx + dy * dy < limit * limit) { return; }
        }
        
        let nx = p.x, ny = p.y;
        if (last && S.smoothing > 0 && S.tool !== 'guide' && S.tool !== 'eraser') {
          const alpha = 1.0 - (S.smoothing * 0.85); // Max 85% smoothing to prevent extreme trailing
          nx = last.x + (p.x - last.x) * alpha;
          ny = last.y + (p.y - last.y) * alpha;
        }

        const pressure = S.pressureSens ? pressureCurve(e.pressure || 0.5) : 0.5;
        S.curStroke.pts.push({ x: nx, y: ny, p: pressure });
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
  if (S.tool === 'camera') {
    S.drawing = false;
    saveSnapshot();
    return;
  }
  if (e && e.button !== 0) return;
  // Release pointer capture
  try { if (e && e.pointerId) canvas.releasePointerCapture(e.pointerId); } catch(_) {}
  S.drawing = false;
  if (S.tool === 'select') { selUp(e); return; }
  if (S.tool === 'pen') { endPen(e ? m2b(e) : null); return; }

  if (['brush', 'pencil', 'eraser', 'guide'].includes(S.tool) && S.curStroke) {
    // Real-time smoothing via Laplacian pass
    if (S.smoothing > 0 && S.curStroke.pts.length > 3 && S.tool !== 'guide' && S.tool !== 'eraser') {
      const iterations = Math.ceil(S.smoothing * 3); // 1 to 3 iterations
      S.curStroke.pts = smoothPath(S.curStroke.pts, iterations, true);
      
      // Auto-simplify to reduce point count drastically without losing shape
      // DO NOT SIMPLIFY IF USING PERFECT-FREEHAND (brush/eraser) as it makes it jagged
      if (S.tool !== 'brush' && S.tool !== 'eraser') {
        const epsilon = 1.0 + (S.smoothing * 1.5); // more smoothing = higher simplification
        S.curStroke.pts = simplifyPath(S.curStroke.pts, epsilon);
      }
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
        const eraserPtsWorld = densifyPath(S.curStroke.pts, 1);
        const eraserSizeWorld = S.curStroke.size + 2;
        if (!eraserPtsWorld || eraserPtsWorld.length < 2) { S.curStroke = null; render(); return; }
        const objs = obs(S.frameIdx, l.id);
        let erasedAny = false;

        function distSq(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }
        function distToSegment(px, py, ax, ay, bx, by) {
          const dx = bx - ax, dy = by - ay;
          const lenSq = dx * dx + dy * dy;
          if (lenSq === 0) return distSq(px, py, ax, ay);
          let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
          t = Math.max(0, Math.min(1, t));
          return distSq(px, py, ax + t * dx, ay + t * dy);
        }
        function closestPtOnSeg(px, py, ax, ay, bx, by) {
          const dx = bx - ax, dy = by - ay;
          const lenSq = dx * dx + dy * dy;
          if (lenSq === 0) return { x: ax, y: ay };
          let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
          t = Math.max(0, Math.min(1, t));
          return { x: ax + t * dx, y: ay + t * dy };
        }
        function segToSegDist(ax, ay, bx, by, cx, cy, dx, dy) {
          const p = closestPtOnSeg(ax, ay, cx, cy, dx, dy);
          const q = closestPtOnSeg(bx, by, cx, cy, dx, dy);
          const p2 = closestPtOnSeg(cx, cy, ax, ay, bx, by);
          const q2 = closestPtOnSeg(dx, dy, ax, ay, bx, by);
          let best = distSq(p.x, p.y, ax, ay);
          best = Math.min(best, distSq(q.x, q.y, bx, by));
          best = Math.min(best, distSq(p2.x, p2.y, cx, cy));
          best = Math.min(best, distSq(q2.x, q2.y, dx, dy));
          return best;
        }
        function isErased(px, py) {
          const r2 = (eraserSizeWorld / 2) * (eraserSizeWorld / 2);
          for (let j = 0; j < eraserPtsWorld.length - 1; j++) {
            if (distToSegment(px, py, eraserPtsWorld[j].x, eraserPtsWorld[j].y, eraserPtsWorld[j+1].x, eraserPtsWorld[j+1].y) <= r2) return true;
          }
          return false;
        }

        function performErasure(objList, parentEraserPts, parentEraserSize) {
          let erasedSomething = false;
          for (let i = objList.length - 1; i >= 0; i--) {
            const o = objList[i];
            
            let localEraserPts = parentEraserPts;
            let localEraserSize = parentEraserSize;
            if (hasTransform(o)) {
              const m = getObjMatrix(o);
              const inv = invertMatrix(m);
              if (inv) {
                localEraserPts = parentEraserPts.map(ep => ({ x: inv.a * ep.x + inv.c * ep.y + inv.e, y: inv.b * ep.x + inv.d * ep.y + inv.f }));
                const scaleX = Math.sqrt(m.a * m.a + m.b * m.b);
                const scaleY = Math.sqrt(m.c * m.c + m.d * m.d);
                localEraserSize = parentEraserSize / Math.max(scaleX, scaleY, 0.001);
              }
            }

            if (o.type === 'group') {
              if (performErasure(o.children, localEraserPts, localEraserSize)) erasedSomething = true;
              if (o.children.length === 0) { objList.splice(i, 1); erasedSomething = true; }
              continue;
            }

            if (o.type === 'fill') {
              if (!o.fc) continue;
              const fx = o.x || 0, fy = o.y || 0;
              const fctx = o.fc.getContext('2d');
              fctx.save();
              fctx.globalCompositeOperation = 'destination-out';
              fctx.lineCap = 'round';
              fctx.lineJoin = 'round';
              fctx.lineWidth = localEraserSize;
              fctx.beginPath();
              let hasValid = false;
              for (const ep of localEraserPts) {
                const lx = ep.x - fx, ly = ep.y - fy;
                if (!hasValid) { fctx.moveTo(lx, ly); hasValid = true; }
                else { fctx.lineTo(lx, ly); }
              }
              if (hasValid) fctx.stroke();
              fctx.restore();
              const idata = fctx.getImageData(0, 0, o.fc.width, o.fc.height).data;
              let hasVisible = false;
              for (let pi = 3; pi < idata.length; pi += 4) { if (idata[pi] > 0) { hasVisible = true; break; } }
              if (!hasVisible) { objList.splice(i, 1); erasedSomething = true; }
              continue;
            }

            if (o.type === 'fillPath') {
              let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
              for (const p of o.pts) { if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; }
              const pad = localEraserSize + 5;
              let hit = false;
              for (const ep of localEraserPts) {
                if (ep.x >= minX - pad && ep.x <= maxX + pad && ep.y >= minY - pad && ep.y <= maxY + pad) {
                  hit = true; break;
                }
              }
              if (!hit) continue;
              if (!o.erasers) o.erasers = [];
              o.erasers.push({ pts: localEraserPts, size: localEraserSize });
              erasedSomething = true;
              continue;
            }

            if (o.type !== 'stroke' || o.composite === 'destination-out') continue;

            const subStrokes = (o.subs && o.subs.length) ? o.subs.map(s => s.pts) : (o.pts ? [o.pts] : []);
            const finalSegments = [];
            let objectErased = false;

            for (const rawPts of subStrokes) {
              const strokePts = densifyPath(rawPts, 1);
              const marked = new Uint8Array(strokePts.length);
              let subErased = false;
              
              for (let pi = 0; pi < strokePts.length; pi++) {
                const pt = strokePts[pi];
                const ptRadius = ((o.size || 0) / 2) * (pt.p !== undefined ? pt.p : 1);
                for (let ej = 0; ej < localEraserPts.length - 1; ej++) {
                  const ep = localEraserPts[ej];
                  const eraserPtRadius = (localEraserSize / 2) * (ep.p !== undefined ? ep.p : 1);
                  const collisionRadius = eraserPtRadius + ptRadius;
                  const eR2 = collisionRadius * collisionRadius;
                  if (distToSegment(pt.x, pt.y, ep.x, ep.y, localEraserPts[ej+1].x, localEraserPts[ej+1].y) <= eR2) {
                    marked[pi] = 1; 
                    subErased = true;
                    objectErased = true;
                    break;
                  }
                }
              }

              if (!subErased) {
                finalSegments.push(rawPts);
                continue;
              }

              let seg = [];
              for (let pi = 0; pi < strokePts.length; pi++) {
                if (marked[pi]) {
                  if (seg.length >= 2) finalSegments.push(simplifyPath(seg, 0.2));
                  else if (seg.length === 1) finalSegments.push(seg);
                  seg = [];
                } else {
                  seg.push({ ...strokePts[pi] });
                }
              }
              if (seg.length >= 2) finalSegments.push(simplifyPath(seg, 0.2));
              else if (seg.length === 1) finalSegments.push(seg);
            }

            if (!objectErased) continue;
            
            objList.splice(i, 1);
            erasedSomething = true;
            for (let segI = finalSegments.length - 1; segI >= 0; segI--) {
              objList.splice(i, 0, {
                type: 'stroke',
                pts: finalSegments[segI],
                color: o.color,
                size: o.size,
                opacity: o.opacity,
                composite: o.composite || 'source-over',
              });
            }
          }
          return erasedSomething;
        }

        if (performErasure(objs, eraserPtsWorld, eraserSizeWorld)) {
          erasedAny = true;
        }
        if (erasedAny && S.selObjs.length) clearSel();
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
      obs(S.frameIdx, l.id).push({ uid: Math.random().toString(36).substr(2, 9),
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
      obs(S.frameIdx, l.id).push({ uid: Math.random().toString(36).substr(2, 9),
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
  if (prev.type !== newObj.type) { objs.push(newObj); return; }
  if (prev.type === 'guide' || newObj.type === 'guide') { objs.push(newObj); return; }
  const isEraser = (o) => o.composite === 'destination-out';
  if (isEraser(prev) || isEraser(newObj)) { objs.push(newObj); return; }
  if (prev.composite !== newObj.composite) { objs.push(newObj); return; }
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

// ---- RDP path simplification ----
function smoothPath(pts, iterations = 1, isOpen = false) {
  if (pts.length <= 2) return pts;
  let result = pts;
  for (let iter = 0; iter < iterations; iter++) {
    const smoothed = [];
    const len = result.length;
    for (let i = 0; i < len; i++) {
      if (isOpen && (i === 0 || i === len - 1)) {
        smoothed.push({ ...result[i] });
      } else {
        const p0 = result[(i - 1 + len) % len];
        const p1 = result[i];
        const p2 = result[(i + 1) % len];
        smoothed.push({
          x: p1.x * 0.5 + p0.x * 0.25 + p2.x * 0.25,
          y: p1.y * 0.5 + p0.y * 0.25 + p2.y * 0.25,
          ...(p1.p !== undefined ? { p: p1.p * 0.5 + p0.p * 0.25 + p2.p * 0.25 } : {})
        });
      }
    }
    result = smoothed;
  }
  return result;
}

function simplifyPath(pts, eps) {
  if (pts.length <= 2) return pts;
  let maxDist = 0, maxIdx = 0;
  const first = pts[0], last = pts[pts.length - 1];
  const dx = last.x - first.x, dy = last.y - first.y;
  const lenSq = dx * dx + dy * dy;
  for (let i = 1; i < pts.length - 1; i++) {
    let d;
    if (lenSq === 0) {
      const ex = pts[i].x - first.x, ey = pts[i].y - first.y;
      d = Math.sqrt(ex * ex + ey * ey);
    } else {
      const t = Math.max(0, Math.min(1, ((pts[i].x - first.x) * dx + (pts[i].y - first.y) * dy) / lenSq));
      const px = first.x + t * dx, py = first.y + t * dy;
      const ex = pts[i].x - px, ey = pts[i].y - py;
      d = Math.sqrt(ex * ex + ey * ey);
    }
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }
  if (maxDist > eps) {
    const left = simplifyPath(pts.slice(0, maxIdx + 1), eps);
    const right = simplifyPath(pts.slice(maxIdx), eps);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}

// ---- Build vector polygon from filled binary mask ----
function buildFillPath(filled, w, h) {
  const leftEdge = [], rightEdge = [];
  for (let y = 0; y < h; y++) {
    let lx = -1, rx = -1;
    for (let x = 0; x < w; x++) {
      if (filled[y * w + x]) {
        if (lx < 0) lx = x;
        rx = x;
      }
    }
    if (lx >= 0) {
      leftEdge.push({ x: lx, y });
      rightEdge.push({ x: rx, y });
    }
  }
  if (leftEdge.length < 2) return [];
  const path = leftEdge.concat(rightEdge.reverse());
  return path;
}

// ---- Marching squares contour extraction (sub-pixel precision) ----
function marchingSquares(filled, w, h) {
  const contours = [];
  const visited = new Uint8Array(w * h);

  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const tl = filled[y * w + x] ? 1 : 0;
      const tr = filled[y * w + x + 1] ? 1 : 0;
      const bl = filled[(y + 1) * w + x] ? 1 : 0;
      const br = filled[(y + 1) * w + x + 1] ? 1 : 0;
      const idx = tl * 8 + tr * 4 + br * 2 + bl;
      if (idx === 0 || idx === 15) continue;

      const top = { x: x + 0.5, y };
      const right = { x: x + 1, y: y + 0.5 };
      const bottom = { x: x + 0.5, y: y + 1 };
      const left = { x, y: y + 0.5 };

      let segments;
      switch (idx) {
        case 1: case 14: segments = [[left, bottom]]; break;
        case 2: case 13: segments = [[bottom, right]]; break;
        case 3: case 12: segments = [[left, right]]; break;
        case 4: case 11: segments = [[top, right]]; break;
        case 5: segments = [[left, top], [bottom, right]]; break;
        case 6: case 9: segments = [[top, bottom]]; break;
        case 7: case 8: segments = [[left, top]]; break;
        case 10: segments = [[top, right], [left, bottom]]; break;
        default: continue;
      }
      for (const seg of segments) contours.push(seg);
    }
  }

  if (contours.length === 0) return [];

  const connected = [];
  const used = new Uint8Array(contours.length);
  let current = contours[0];
  connected.push(current[0], current[1]);
  used[0] = 1;

  let changed = true;
  while (changed) {
    changed = false;
    const lastPt = connected[connected.length - 1];
    for (let i = 0; i < contours.length; i++) {
      if (used[i]) continue;
      const seg = contours[i];
      const d0 = Math.abs(seg[0].x - lastPt.x) + Math.abs(seg[0].y - lastPt.y);
      const d1 = Math.abs(seg[1].x - lastPt.x) + Math.abs(seg[1].y - lastPt.y);
      if (d0 < 0.6) {
        connected.push(seg[1]);
        used[i] = 1;
        changed = true;
        break;
      } else if (d1 < 0.6) {
        connected.push(seg[0]);
        used[i] = 1;
        changed = true;
        break;
      }
    }
  }

  return connected;
}

// ---- Fill: alpha-mask flood fill → bitmap fill ----
function doFill(c) {
  const l = L();
  if (!l || l.locked || !l.vis) return;
  const w = S.w, h = S.h;

  const tpWorld = { x: c.x, y: c.y };
  const objs = obs(S.frameIdx, l.id);
  
  // Vector-aware fill: Check if we clicked inside a shape/fill or exactly on a stroke
  function checkVectorFill(objList, currentTp) {
    for (let i = objList.length - 1; i >= 0; i--) {
      const o = objList[i];
      const m = hasTransform(o) ? getObjMatrix(o) : null;
      const tp = m ? inverseTransformPoint(currentTp, m) : currentTp;

      if (o.type === 'group' && o.children) {
        if (checkVectorFill(o.children, tp)) {
          // If it's a fill group (contains a fillPath and only strokes/fillPaths), color the entire group!
          const isAutoGroup = o.autoGroup || (o.children.some(c => c.type === 'fillPath') && o.children.every(c => c.type === 'stroke' || c.type === 'fillPath'));
          if (isAutoGroup) {
            for (const c of o.children) {
              if (c.type === 'stroke' || c.type === 'fillPath') c.color = S.stroke;
              if (c.type === 'circle' || c.type === 'rect') { c.color = S.stroke; c.fillColor = S.stroke; }
            }
          }
          return true;
        }
        continue;
      }
      if (o.type === 'symbol' && o.symbolId) {
        const sym = Symbols[o.symbolId];
        if (sym && sym.children) {
          let symTp = tp;
          if (o.x || o.y) symTp = { x: tp.x - (o.x || 0), y: tp.y - (o.y || 0) };
          if (checkVectorFill(sym.children, symTp)) return true;
        }
        continue;
      }

      if (o.type === 'circle') {
        const cx = (o.x1 + o.x2) / 2, cy = (o.y1 + o.y2) / 2;
        const rx = Math.abs(o.x2 - o.x1) / 2, ry = Math.abs(o.y2 - o.y1) / 2;
        if (rx > 0 && ry > 0) {
          const d = ((tp.x - cx) / rx) ** 2 + ((tp.y - cy) / ry) ** 2;
          // Click exactly on the stroke
          if (Math.abs(d - 1) < 0.2) {
            o.color = S.stroke;
            return true;
          }
          // Click inside the circle
          if (d <= 1) {
            if (o.fillColor && o.fillColor !== 'transparent' && o.fillColor !== '') {
              o.color = S.stroke;
              o.fillColor = S.stroke;
            } else {
              o.fillColor = S.stroke;
            }
            return true;
          }
        }
      } else if (o.type === 'rect') {
        const tol = (o.size || 0) / 2 + 3;
        const x1 = Math.min(o.x1, o.x2), x2 = Math.max(o.x1, o.x2);
        const y1 = Math.min(o.y1, o.y2), y2 = Math.max(o.y1, o.y2);
        // Check if click is on the edge (stroke)
        const onEdge = (Math.abs(tp.x - x1) < tol || Math.abs(tp.x - x2) < tol || Math.abs(tp.y - y1) < tol || Math.abs(tp.y - y2) < tol) && tp.x >= x1 - tol && tp.x <= x2 + tol && tp.y >= y1 - tol && tp.y <= y2 + tol;
        if (onEdge) {
          o.color = S.stroke;
          return true;
        }
        // Click inside the rect
        if (tp.x >= x1 && tp.x <= x2 && tp.y >= y1 && tp.y <= y2) {
          if (o.fillColor && o.fillColor !== 'transparent' && o.fillColor !== '') {
            o.color = S.stroke;
            o.fillColor = S.stroke;
          } else {
            o.fillColor = S.stroke;
          }
          return true;
        }
      } else if (o.type === 'fillPath' && o.pts) {
        let inside = pointInPolygon(tp, o.pts);
        if (inside && o.holes) {
          for (const hole of o.holes) {
            if (pointInPolygon(tp, hole)) { inside = false; break; }
          }
        }
        if (inside) {
          o.color = S.stroke;
          return true;
        }
      } else if (o.type === 'stroke') {
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
        if (hit) {
          o.color = S.stroke;
          return true;
        }
      }
    }
    return false;
  }
  
  if (checkVectorFill(objs, tpWorld)) {
    dirtyCache(); render(); saveSnapshot();
    return;
  }

  // 1. Render strokes/shapes to a transparent canvas (NO background)
  const wall = document.createElement('canvas');
  wall.width = w; wall.height = h;
  const wc = wall.getContext('2d');

  for (const layer of S.layers) {
    if (!layer.vis) continue;
    const f = S.frames[S.frameIdx];
    if (!f) continue;

    function renderWallObjs(objList, parentOpacity = 1) {
      for (const o of objList) {
        const opacity = (o.opacity !== undefined ? o.opacity : 1) * parentOpacity;
        if (o.type === 'stroke') {
          const subs = o.subs && o.subs.length ? o.subs : (o.pts ? [{ pts: o.pts, size: o.size, color: o.color, opacity }] : []);
          for (const sub of subs) {
            const sz = sub.size !== undefined ? sub.size : o.size;
            drawStroke(wc, sub.pts, sub.color || o.color, sz, 1, 'source-over', o.thinning, o.smoothing, o.simulatePressure);
          }
        } else if (o.type === 'rect' || o.type === 'circle' || o.type === 'line') {
          drawShape(wc, o.type, o.x1, o.y1, o.x2, o.y2, o.color, o.fillColor, o.size, opacity);
        } else if (o.type === 'fillPath' && o.pts && o.pts.length > 2) {
          wc.save();
          wc.fillStyle = o.color;
          wc.globalAlpha = opacity;
          wc.beginPath();
          wc.moveTo(o.pts[0].x, o.pts[0].y);
          for (let i = 1; i < o.pts.length; i++) wc.lineTo(o.pts[i].x, o.pts[i].y);
          wc.closePath();
          wc.fill();
          wc.lineWidth = 1.5;
          wc.strokeStyle = o.color;
          wc.stroke();
          wc.restore();
        } else if (o.type === 'fill' && o.fc) {
          wc.save();
          wc.globalAlpha = opacity;
          if (o.erasers && o.erasers.length > 0) {
            const tmpCv = document.createElement('canvas');
            tmpCv.width = o.fc.width; tmpCv.height = o.fc.height;
            const tmpCtx = tmpCv.getContext('2d');
            tmpCtx.drawImage(o.fc, 0, 0);
            tmpCtx.globalCompositeOperation = 'destination-out';
            tmpCtx.lineCap = 'round';
            tmpCtx.lineJoin = 'round';
            const fox2 = o.x || 0, foy2 = o.y || 0;
            for (const er of o.erasers) {
              tmpCtx.lineWidth = er.size;
              tmpCtx.beginPath();
              if (er.pts.length > 0) {
                tmpCtx.moveTo(er.pts[0].x - fox2, er.pts[0].y - foy2);
                for (let i = 1; i < er.pts.length; i++) tmpCtx.lineTo(er.pts[i].x - fox2, er.pts[i].y - foy2);
                tmpCtx.stroke();
              }
            }
            wc.drawImage(tmpCv, o.x || 0, o.y || 0);
          } else {
            wc.drawImage(o.fc, o.x || 0, o.y || 0);
          }
          wc.restore();
        } else if (o.type === 'pen' && o.pts) {
          drawStroke(wc, o.pts, o.color, o.size, 1, 'source-over', o.thinning, o.smoothing, o.simulatePressure);
        } else if (o.type === 'group' && o.children) {
          const hasTx = hasTransform(o) || o.angle;
          if (hasTx) {
            const m = getObjMatrix(o);
            wc.save();
            wc.transform(m.a, m.b, m.c, m.d, m.e, m.f);
          }
          renderWallObjs(o.children, opacity);
          if (hasTx) wc.restore();
        } else if (o.type === 'symbol') {
          const sym = Symbols[o.symbolId];
          if (sym && sym.children) {
            const hasTx = hasTransform(o) || o.angle;
            if (hasTx) {
              const m = getObjMatrix(o);
              wc.save();
              wc.transform(m.a, m.b, m.c, m.d, m.e, m.f);
            }
            if (o.x || o.y) {
              if (!hasTx) wc.save();
              wc.translate(o.x || 0, o.y || 0);
            }
            renderWallObjs(sym.children, opacity);
            if (hasTx || o.x || o.y) wc.restore();
          }
        }
      }
    }
    
    renderWallObjs(obs(S.frameIdx, layer.id));
  }

  // 2. Extract pixel data
  const wd = wc.getImageData(0, 0, w, h).data;

  // Reduced WALL_TOL to prevent leaking through 1px anti-aliased lines
  const WALL_TOL = typeof S.fillTolerance === 'number' ? S.fillTolerance : 80;

  const sx = Math.round(c.x), sy = Math.round(c.y);
  if (sx <= 0 || sx >= w - 1 || sy <= 0 || sy >= h - 1) return;

  // If clicking on a wall pixel, bail
  const seedIdx = (sy * w + sx) * 4;
  // 2.5 Gap closing - virtual walls
  const closeGaps = S.closeGaps || 0;
  const vWall = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (wd[i * 4 + 3] > WALL_TOL) vWall[i] = 1;
  }
  
  if (closeGaps > 0) {
    const vWallNew = new Uint8Array(vWall);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (vWall[y * w + x] === 1) {
          for (let dy = -closeGaps; dy <= closeGaps; dy++) {
            for (let dx = -closeGaps; dx <= closeGaps; dx++) {
              if (dx * dx + dy * dy <= closeGaps * closeGaps) {
                const ny = y + dy, nx = x + dx;
                if (ny >= 0 && ny < h && nx >= 0 && nx < w) {
                  vWallNew[ny * w + nx] = 1;
                }
              }
            }
          }
        }
      }
    }
    for (let i = 0; i < w * h; i++) vWall[i] = vWallNew[i];
  }

  // 3. Flood fill using alpha mask as wall boundary
  const filled = new Uint8Array(w * h);
  const stack = [[sx, sy]];
  const dirs = [[1,0],[-1,0],[0,1],[0,-1]]; // 4-way fill to prevent diagonal leaking through anti-aliased corners

  let hitEdge = false;
  while (stack.length > 0) {
    const [x, y] = stack.pop();
    // 1px margin prevents d3-contour from creating unclosed boundary squares
    if (x <= 0 || y <= 0 || x >= w - 1 || y >= h - 1) {
      hitEdge = true;
      continue;
    }
    const idx = y * w + x;
    if (filled[idx]) continue;
    if (vWall[idx] === 1) continue; // Use virtual wall instead of direct wd array
    filled[idx] = 1;
    for (const [dx, dy] of dirs) stack.push([x + dx, y + dy]);
  }

  if (hitEdge) {
    return;
  }

  // 4. Dilate to cover anti-aliased edge pixels (more passes = less gaps)
  const DILATE_TOL = Math.min(250, Math.max(200, WALL_TOL + 50));
  // Add extra dilation passes if gap closing was used, to fill the temporary virtual walls
  const passes = 6 + (closeGaps > 0 ? closeGaps : 0);
  for (let iter = 0; iter < passes; iter++) {
    const tmpF = new Uint8Array(filled);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const idx = y * w + x;
        if (tmpF[idx]) continue;
        if (wd[idx * 4 + 3] > DILATE_TOL) continue;
        for (const [dx, dy] of dirs) {
          if (tmpF[(y + dy) * w + (x + dx)]) { filled[idx] = 1; break; }
        }
      }
    }
  }



  // 5. Build vector polygon instead of bitmap
  // contours expects a flat array of numbers. `filled` is a Uint8Array of 1s and 0s.
  const contourPolys = contours().size([w, h]).thresholds([0.5])(Array.from(filled));
  if (!contourPolys || contourPolys.length === 0 || !contourPolys[0].coordinates.length) return;

  // contourPolys[0] contains the MultiPolygon for value 0.5.
  // The first Polygon in the MultiPolygon represents the largest filled connected component.
  const coords = contourPolys[0].coordinates[0];
  if (!coords || coords.length === 0) return;

  // The first ring is the outer boundary
  let outerPts = coords[0].map(p => ({ x: p[0], y: p[1] }));
  outerPts = simplifyPath(outerPts, 0.5);

  // Subsequent rings are holes
  const holes = [];
  for (let i = 1; i < coords.length; i++) {
    let holePts = coords[i].map(p => ({ x: p[0], y: p[1] }));
    holePts = simplifyPath(holePts, 0.5);
    if (holePts.length > 2) holes.push(holePts);
  }

  const fillObj = {
    uid: Math.random().toString(36).substr(2, 9),
    type: 'fillPath',
    pts: outerPts,
    holes: holes.length > 0 ? holes : undefined,
    color: S.stroke,
    opacity: S.opacity
  };

  const touchingStrokes = [];
  const fillBb = getObjBounds(fillObj);
  
  for (let i = 0; i < objs.length; i++) {
    const o = objs[i];
    if (o.type === 'stroke') {
      const b = getObjBounds(o);
      if (b.x <= fillBb.x + fillBb.w && b.x + b.w >= fillBb.x && b.y <= fillBb.y + fillBb.h && b.y + b.h >= fillBb.y) {
        let touches = false;
        const ptsArr = o.subs && o.subs.length ? o.subs.map(s => s.pts) : (o.pts ? [o.pts] : []);
        for (const pts of ptsArr) {
          for (let j = 0; j < pts.length; j += Math.max(1, Math.floor(pts.length / 50))) {
             if (pointInOrNearPolygon(pts[j], outerPts, 15)) { touches = true; break; }
          }
          if (touches) break;
        }
        if (touches) touchingStrokes.push(i);
      }
    }
  }

  if (touchingStrokes.length > 0) {
    const children = [];
    touchingStrokes.sort((a,b) => b - a);
    for (const i of touchingStrokes) {
      children.push(objs.splice(i, 1)[0]);
    }
    children.unshift(fillObj);
    objs.push({
      uid: Math.random().toString(36).substr(2, 9),
      type: 'group',
      children: children,
      opacity: 1
    });
  } else {
    objs.push(fillObj);
  }

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
  obs(S.frameIdx, l.id).push({ uid: Math.random().toString(36).substr(2, 9),
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
            obs(S.frameIdx, l.id).push({ uid: Math.random().toString(36).substr(2, 9), type: 'fill', fc, opacity: 1 });
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
      obs(S.frameIdx, l.id).push({ uid: Math.random().toString(36).substr(2, 9), type: 'fill', fc, opacity: 1 });
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

// ---- Object bounds (with rotation) ----


function frameHash(fi, layerId) {
  return frameHashContent(obs(fi, layerId));
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
  if (o.type === 'fill' || o.type === 'fillPath' || o.type === 'group') {
    const bb = getObjBaseBounds(o);
    return { x: bb.x + bb.w / 2, y: bb.y + bb.h / 2 };
  }
  if (o.type === 'symbol') {
    return { x: o.x || 0, y: o.y || 0 };
  }
  if (o.type === 'text') {
    const lines = (o.text || '').split('\n');
    const h = lines.length * o.size * 1.3;
    const w = Math.max(...lines.map(l => l.length)) * o.size * 0.6;
    return { x: o.x + w / 2, y: o.y + h / 2 };
  }
  if (o.type === 'symbol') {
    const bb = getObjBaseBounds(o);
    return { x: bb.x + bb.w / 2, y: bb.y + bb.h / 2 };
  }
  if (o.type === 'group' && o.children) {
    const bb = getObjBaseBounds(o);
    return { x: bb.x + bb.w / 2, y: bb.y + bb.h / 2 };
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
function invertMatrix(m) {
  const det = m.a * m.d - m.b * m.c;
  if (Math.abs(det) < 1e-10) return null;
  const a = m.d / det, b = -m.b / det, c = -m.c / det, d = m.a / det;
  const e = -(a * m.e + c * m.f), f = -(b * m.e + d * m.f);
  return { a, b, c, d, e, f };
}
function hasTransform(o) {
  return o && ((o.scaleX != null && o.scaleX !== 1) || (o.scaleY != null && o.scaleY !== 1) || (o.angle && o.angle !== 0) || (o.skewX && o.skewX !== 0) || (o.skewY && o.skewY !== 0));
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
  } else if (o.type === 'fill') {
    const fw = o.fc ? o.fc.width : S.w;
    const fh = o.fc ? o.fc.height : S.h;
    b = { x: o.x || 0, y: o.y || 0, w: fw, h: fh };
  } else if (o.type === 'fillPath' && o.pts && o.pts.length) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of o.pts) { if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; }
    b = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  } else if (o.type === 'group' && o.children) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of o.children) {
      const cb = getObjBaseBounds(c);
      if (cb && cb.w !== undefined) {
        if (cb.x < minX) minX = cb.x; if (cb.y < minY) minY = cb.y;
        if (cb.x + cb.w > maxX) maxX = cb.x + cb.w; if (cb.y + cb.h > maxY) maxY = cb.y + cb.h;
      }
    }
    b = { x: minX === Infinity ? 0 : minX, y: minY === Infinity ? 0 : minY, w: maxX === -Infinity ? 0 : maxX - minX, h: maxY === -Infinity ? 0 : maxY - minY };
  } else if (o.type === 'text') {
    const lines = (o.text || '').split('\n');
    const h = lines.length * o.size * 1.3;
    const w = Math.max(...lines.map(l => l.length)) * o.size * 0.6;
    b = { x: o.x - 2, y: o.y - 2, w: w + 4, h: h + 4 };
  } else if (o.type === 'symbol') {
    const sym = Symbols[o.symbolId];
    if (sym && sym.children && sym.children.length) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const c of sym.children) {
        const cb = getObjBaseBounds(c);
        minX = Math.min(minX, cb.x); minY = Math.min(minY, cb.y);
        maxX = Math.max(maxX, cb.x + cb.w); maxY = Math.max(maxY, cb.y + cb.h);
      }
      const ox = o.x || 0, oy = o.y || 0;
      b = { x: minX + ox, y: minY + oy, w: maxX === -Infinity ? 0 : maxX - minX, h: maxY === -Infinity ? 0 : maxY - minY };
    } else {
      b = { x: o.x || 0, y: o.y || 0, w: 0, h: 0 };
    }
  } else if (o.type === 'group' && o.children) {
    if (o.children.length) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const c of o.children) {
        const cb = getObjBaseBounds(c);
        minX = Math.min(minX, cb.x); minY = Math.min(minY, cb.y);
        maxX = Math.max(maxX, cb.x + cb.w); maxY = Math.max(maxY, cb.y + cb.h);
      }
      b = { x: minX, y: minY, w: maxX === -Infinity ? 0 : maxX - minX, h: maxY === -Infinity ? 0 : maxY - minY };
    } else {
      b = { x: 0, y: 0, w: 0, h: 0 };
    }
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
        } else if (o.type === 'fillPath') {
          if (o.pts) {
            let inside = pointInPolygon(tp, o.pts);
            if (inside && o.holes) {
              for (const hole of o.holes) {
                if (pointInPolygon(tp, hole)) { inside = false; break; }
              }
            }
            if (inside) return { layerId: l.id, idx: i };
          }
        } else if (o.type === 'fill') {
          return { layerId: l.id, idx: i };
        } else if (o.type === 'rect') {
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

const HANDLE_SIZE = 12;
const HANDLE_VISUAL_SIZE = 8;
const ROTATE_ZONE_RADIUS = 35;
const SKEW_ZONE_DISTANCE = 14;

function pointInPolygon(p, poly) {
  let isInside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersect = ((yi > p.y) !== (yj > p.y)) &&
      (p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi);
    if (intersect) isInside = !isInside;
  }
  return isInside;
}

function distToSegment(p, v, w) {
  const l2 = (w.x - v.x)**2 + (w.y - v.y)**2;
  if (l2 === 0) return Math.sqrt((p.x - v.x)**2 + (p.y - v.y)**2);
  let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.sqrt((p.x - (v.x + t * (w.x - v.x)))**2 + (p.y - (v.y + t * (w.y - v.y)))**2);
}

function pointInOrNearPolygon(p, tc, padding) {
  if (pointInPolygon(p, tc)) return true;
  for (let i = 0; i < tc.length; i++) {
    const p1 = tc[i], p2 = tc[(i + 1) % tc.length];
    if (distToSegment(p, p1, p2) <= padding) return true;
  }
  return false;
}

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

  const bb = getObjBaseBounds(o);
  const minDim = Math.min(bb.w * Math.abs(o.scaleX || 1), bb.h * Math.abs(o.scaleY || 1));
  const f = S.frames[S.frameIdx];
  const camZoom = f && f.cam ? f.cam.zoom : 1;

  let hs = HANDLE_SIZE / camZoom;
  if (minDim * camZoom < HANDLE_SIZE * 3) {
    hs = Math.max(3 / camZoom, minDim / 3);
  }
  let rz = ROTATE_ZONE_RADIUS / camZoom;
  if (minDim * camZoom < ROTATE_ZONE_RADIUS * 3) {
    rz = Math.max(8 / camZoom, minDim / 2);
  }

  const handles = getTransformedHandles(o);
  const tc = getObjTransformedCorners(o);
  for (const h of handles) {
    const dx = p.x - h.x, dy = p.y - h.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (h.type === 'corner') {
      if (dist < hs) return h.name;
      if (dist < rz) return 'rotate:' + h.name;
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
      if (perpDist < hs) return h.name;
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
    if (o.erasers) for (const er of o.erasers) {
      for (const p of er.pts) { p.x = nx + (p.x - b.x) * sx; p.y = ny + (p.y - b.y) * sy; }
      er.size *= scale;
    }
    if (o.size != null) o.size *= scale;
  } else if (o.type === 'fillPath') {
    if (o.pts) for (const p of o.pts) { p.x = nx + (p.x - b.x) * sx; p.y = ny + (p.y - b.y) * sy; }
    if (o.holes) for (const hole of o.holes) for (const p of hole) { p.x = nx + (p.x - b.x) * sx; p.y = ny + (p.y - b.y) * sy; }
    if (o.erasers) for (const er of o.erasers) {
      for (const p of er.pts) { p.x = nx + (p.x - b.x) * sx; p.y = ny + (p.y - b.y) * sy; }
      er.size *= scale;
    }
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
  const f = S.frames[S.frameIdx];
  const camZoom = f && f.cam ? f.cam.zoom : 1;
  if (f && f.cam) {
    const cx = S.w / 2, cy = S.h / 2;
    octx.translate(cx, cy);
    octx.scale(f.cam.zoom, f.cam.zoom);
    octx.rotate(f.cam.rotation * Math.PI / 180);
    octx.translate(-cx + f.cam.x, -cy + f.cam.y);
  }
  for (const ref of S.selObjs) {
    const objs = obs(S.frameIdx, ref.layerId);
    const o = objs[ref.idx];
    if (!o) continue;
    // For single selection, draw transformed bounding box later; for multi, draw AABB
    if (S.selObjs.length > 1) {
      const b = getObjBounds(o);
      octx.strokeStyle = '#0af';
      octx.lineWidth = 1 / camZoom;
      octx.setLineDash([4 / camZoom, 3 / camZoom]);
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
  octx.lineWidth = 1 / camZoom;
  octx.setLineDash([4 / camZoom, 3 / camZoom]);
  octx.beginPath();
  octx.moveTo(tc[0].x, tc[0].y);
  for (let i = 1; i < tc.length; i++) octx.lineTo(tc[i].x, tc[i].y);
  octx.closePath();
  octx.stroke();
  octx.setLineDash([]);
  const bb = getObjBaseBounds(o);
  const minDim = Math.min(bb.w * Math.abs(o.scaleX || 1), bb.h * Math.abs(o.scaleY || 1));
  
  let hvs = HANDLE_VISUAL_SIZE / camZoom;
  if (minDim * camZoom < HANDLE_VISUAL_SIZE * 3) {
    hvs = Math.max(2 / camZoom, minDim / 3);
  }

  // Corner handles + rotate zones (use transformed positions)
  const handles = getTransformedHandles(o);
  for (const h of handles) {
    if (h.type === 'corner') {
      octx.fillStyle = '#fff';
      octx.strokeStyle = '#0af';
      octx.lineWidth = 1 / camZoom;
      octx.fillRect(h.x - hvs / 2, h.y - hvs / 2, hvs, hvs);
      octx.strokeRect(h.x - hvs / 2, h.y - hvs / 2, hvs, hvs);
    } else {
      octx.fillStyle = '#fff';
      octx.strokeStyle = '#0af';
      octx.lineWidth = 1 / camZoom;
      const hw = hvs;
      const hh = hvs;
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
      const r = ROTATE_ZONE_RADIUS / camZoom;
      octx.beginPath();
      octx.arc(readyHandle.x, readyHandle.y, r, angle - sweep, angle + sweep);
      octx.strokeStyle = 'rgba(0, 170, 255, 0.6)';
      octx.lineWidth = 2 / camZoom;
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
    if (o.erasers) for (const er of o.erasers) for (const p of er.pts) { p.x += dx; p.y += dy; }
  } else if (o.type === 'text') {
    o.x += dx; o.y += dy;
  } else if (o.type === 'fill') {
    o.x = (o.x || 0) + dx;
    o.y = (o.y || 0) + dy;
  } else if (o.type === 'fillPath') {
    if (o.pts) for (const p of o.pts) { p.x += dx; p.y += dy; }
    if (o.holes) for (const hole of o.holes) for (const p of hole) { p.x += dx; p.y += dy; }
    if (o.eraserX !== undefined) o.eraserX += dx;
    if (o.eraserY !== undefined) o.eraserY += dy;
    if (o.erasers) for (const er of o.erasers) for (const p of er.pts) { p.x += dx; p.y += dy; }
  } else if (o.type === 'group' && o.children) {
    for (const child of o.children) moveObjBy(child, dx, dy);
  } else if (o.type === 'symbol') {
    // You cannot move children of a symbol directly, you move the instance!
    o.x = (o.x || 0) + dx;
    o.y = (o.y || 0) + dy;
  } else if (o.pts) {
    for (const p of o.pts) { p.x += dx; p.y += dy; }
  }
  if (o.x1 != null) { o.x1 += dx; o.y1 += dy; o.x2 += dx; o.y2 += dy; }
  if (o.pivotX != null) o.pivotX += dx;
  if (o.pivotY != null) o.pivotY += dy;
}

function cloneObj(o, keepUid = false) {
  const c = {};
  for (const k of Object.keys(o)) {
    if (k === 'uid') continue;
    if (k === 'pts' && o.pts) c.pts = o.pts.map(p => ({ x: p.x, y: p.y, ...(p.p !== undefined ? { p: p.p } : {}) }));
    else if (k === 'holes' && o.holes) c.holes = o.holes.map(hole => hole.map(p => ({ x: p.x, y: p.y })));
    else if (k === 'subs' && o.subs) c.subs = o.subs.map(sub => ({ ...sub, pts: sub.pts.map(p => ({ x: p.x, y: p.y, ...(p.p !== undefined ? { p: p.p } : {}) })) }));
    else if (k === 'children' && o.children) c.children = o.children.map(child => cloneObj(child));
    else if (k === 'fc' && o.fc) {
      const canvas = document.createElement('canvas');
      canvas.width = o.fc.width; canvas.height = o.fc.height;
      canvas.getContext('2d').drawImage(o.fc, 0, 0);
      c.fc = canvas;
    }
    else if (k === 'eraserFc' && o.eraserFc) {
      const canvas = document.createElement('canvas');
      canvas.width = o.eraserFc.width; canvas.height = o.eraserFc.height;
      canvas.getContext('2d').drawImage(o.eraserFc, 0, 0);
      c.eraserFc = canvas;
    }
    else if (k === 'erasers' && o.erasers) c.erasers = o.erasers.map(e => ({ ...e, pts: e.pts.map(p => ({ x: p.x, y: p.y })) }));
    else c[k] = o[k];
  }
    c.uid = keepUid && o.uid ? o.uid : Math.random().toString(36).substr(2, 9);
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
  let hit = hitTest(p);
  if (!hit && S.selObjs.length === 1) {
    const objs = obs(S.frameIdx, selObj().layerId);
    const o = objs[selObj().idx];
    if (o) {
      const tc = getObjTransformedCorners(o);
      const f = S.frames[S.frameIdx];
      const camZoom = f && f.cam ? f.cam.zoom : 1;
      if (pointInOrNearPolygon(p, tc, 15 / camZoom)) {
        hit = { layerId: selObj().layerId, idx: selObj().idx };
      }
    }
  }
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

function applyMoveToChild(child, cinit, dx, dy) {
  if (!child || !cinit) return;
  if (child.type === 'stroke' || child.type === 'fillPath') {
    if (cinit.pts) child.pts = cinit.pts.map(pt => ({ x: pt.x + dx, y: pt.y + dy, ...(pt.p !== undefined ? { p: pt.p } : {}) }));
    if (cinit.holes) child.holes = cinit.holes.map(hole => hole.map(pt => ({ x: pt.x + dx, y: pt.y + dy })));
    if (cinit.subs) child.subs = cinit.subs.map(sub => ({ ...sub, pts: sub.pts.map(pt => ({ x: pt.x + dx, y: pt.y + dy, ...(pt.p !== undefined ? { p: pt.p } : {}) })) }));
    if (cinit.erasers) child.erasers = cinit.erasers.map(er => ({ ...er, pts: er.pts.map(pt => ({ x: pt.x + dx, y: pt.y + dy, ...(pt.p !== undefined ? { p: pt.p } : {}) })) }));
    if (cinit.eraserX !== undefined) child.eraserX = cinit.eraserX + dx;
    if (cinit.eraserY !== undefined) child.eraserY = cinit.eraserY + dy;
  } else if (child.type === 'symbol') {
    child.x = (cinit.x || 0) + dx;
    child.y = (cinit.y || 0) + dy;
  } else if (child.type === 'group' && cinit.children) {
    for (let i = 0; i < child.children.length; i++) {
      applyMoveToChild(child.children[i], cinit.children[i], dx, dy);
    }
  } else if (child.x1 != null) {
    child.x1 = cinit.x1 + dx; child.y1 = cinit.y1 + dy;
    child.x2 = cinit.x2 + dx; child.y2 = cinit.y2 + dy;
  } else if (child.type === 'text') {
    child.x = cinit.x + dx; child.y = cinit.y + dy;
  } else if (child.type === 'fill') {
    child.x = (cinit.x || 0) + dx;
    child.y = (cinit.y || 0) + dy;
  }
  if (cinit.pivotX != null) child.pivotX = cinit.pivotX + dx;
  if (cinit.pivotY != null) child.pivotY = cinit.pivotY + dy;
}

function selMove(p, e) {
  if (S.selMode === 'move' && S.selObjs.length && _multiSelInits.size) {
    const dx = p.x - S.dragStart.x, dy = p.y - S.dragStart.y;
    for (const ref of S.selObjs) {
      const objs = obs(S.frameIdx, ref.layerId);
      const o = objs[ref.idx];
      const init = _multiSelInits.get(`${ref.layerId}:${ref.idx}`);
      if (!o || !init) continue;
      applyMoveToChild(o, init, dx, dy);
    }
    dirtyCache(); renderThrottled();
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
    dirtyCache(); renderThrottled();
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
    dirtyCache(); renderThrottled();
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
    dirtyCache(); renderThrottled();

  } else if (_marqueeStart) {
    _marqueeEnd = { x: p.x, y: p.y };
    const bs = bufScale();
    octx.clearRect(0, 0, overlay.width, overlay.height);
    octx.save();
    if (bs !== 1) octx.scale(bs, bs);
    const f = S.frames[S.frameIdx];
    if (f && f.cam) {
      const cx = S.w / 2, cy = S.h / 2;
      octx.translate(cx, cy);
      octx.scale(f.cam.zoom, f.cam.zoom);
      octx.rotate(f.cam.rotation * Math.PI / 180);
      octx.translate(-cx + f.cam.x, -cy + f.cam.y);
    }
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

function selUp(e) {
  if (_marqueeStart) {
    const p1 = _marqueeStart, p2 = _marqueeEnd || p1;
    _marqueeStart = null; _marqueeEnd = null;
    octx.clearRect(0, 0, overlay.width, overlay.height);
    const mx = Math.min(p1.x, p2.x), my = Math.min(p1.y, p2.y);
    const mw = Math.abs(p2.x - p1.x), mh = Math.abs(p2.y - p1.y);
    // Only select if dragged more than 5px
    if (mw > 5 || mh > 5) {
      if (!e || (!e.shiftKey && !e.altKey)) {
        S.selObjs = [];
      }
      
      for (const l of S.layers) {
        if (!l.vis) continue;
        const objs = obs(S.frameIdx, l.id);
        for (let i = 0; i < objs.length; i++) {
          const b = getObjBounds(objs[i]);
          if (b.x < mx + mw && b.x + b.w > mx && b.y < my + mh && b.y + b.h > my) {
            const existingIdx = S.selObjs.findIndex(r => r.layerId === l.id && r.idx === i);
            if (e && e.altKey) {
              if (existingIdx >= 0) S.selObjs.splice(existingIdx, 1);
            } else {
              if (existingIdx === -1) S.selObjs.push({ layerId: l.id, idx: i });
            }
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
  if (S.playing) { updateTLPlayback(); return; }
  const nf = S.frames.length;
  const curL = L();

  // --- Update toolbar displays ---
  if ($('tl-fps-inline')) $('tl-fps-inline').value = S.fps;
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
      const isKey = f ? f.key : false;
      const hasUniqueContent = f && f.o[l.id] && f.o[l.id].length > 0;
      
      const targetFi = getExposureKeyframeIndexFor(S.frames, i);
      const parentF = S.frames[targetFi];
      const hasParentContent = parentF && parentF.o[l.id] && parentF.o[l.id].length > 0;

      const cell = document.createElement('div');
      cell.className = 'tl-frame-cell';
      cell.style.width = cellW() + 'px';
      cell.dataset.frame = i;

      let cellType = 'empty';
      if (isKey) {
        cellType = hasUniqueContent ? 'keyframe' : 'blank-key';
      } else {
        if (hasUniqueContent) {
          cellType = 'tween';
        } else {
          cellType = hasParentContent ? 'extended' : 'extended-blank';
        }
      }
      cell.classList.add(cellType);

      if (cellType === 'tween') {
        const arrow = document.createElement('div');
        arrow.style.position = 'absolute';
        arrow.style.top = '50%';
        arrow.style.left = '50%';
        arrow.style.transform = 'translate(-50%, -50%)';
        arrow.style.color = '#333';
        arrow.style.fontSize = '8px';
        arrow.style.pointerEvents = 'none';
        arrow.innerHTML = '→';
        cell.appendChild(arrow);
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
  renderAudioTimeline(tlZoom, S.fps);
}

function thisLayerUpdate() { updateLayerUI(); dirtyCache(); render(); }

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
    : new Set(S.selLayerIds);
  // Always include the active layer
  if (S.activeLayerId != null) targetLayers.add(S.activeLayerId);
  console.log(`[addFrame] activeLayerId: ${S.activeLayerId}, targetLayers:`, [...targetLayers], 'isKeyframe:', isKeyframe);
  if (isKeyframe) {
    for (const lid of targetLayers) {
      nf.o[lid] = src.o[lid] ? src.o[lid].map(o => cloneObj(o, true)) : [];
    }
  }
  const insertAt = S.frameIdx + 1;
  S.frames.splice(insertAt, 0, nf);
  S.frameIdx++;
  
  if (S.frames.length > 0 && !S.frames[0].key) {
    S.frames[0].key = true;
  }

  saveSnapshot();
  dirtyCache(); S.tlDirty = true;
  fullRender();
}

function addEmptyFrame() {
  const lastF = S.frames[S.frameIdx];
  const nf = { o: {}, key: true, cam: lastF && lastF.cam ? {...lastF.cam} : { x: 0, y: 0, zoom: 1, rotation: 0 }, _hist: [], _histIdx: -1 };
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
  const nf = { o: {}, key: src.key, cam: src.cam ? {...src.cam} : { x: 0, y: 0, zoom: 1, rotation: 0 }, _hist: [], _histIdx: -1 };
  for (const lid of S.selLayerIds) {
    nf.o[lid] = src.o[lid] ? src.o[lid].map(o => cloneObj(o, true)) : [];
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
  const fIdx = getExposureKeyframeIndex(S.frameIdx);
  const f = S.frames[fIdx];
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
    if (k === 'pts' && o.pts) r.pts = o.pts.map(p => ({ x: p.x, y: p.y, ...(p.p !== undefined ? { p: p.p } : {}) }));
    else if (k === 'holes' && o.holes) r.holes = o.holes.map(hole => hole.map(p => ({ x: p.x, y: p.y })));
    else if (k === 'subs' && o.subs) r.subs = o.subs.map(sub => ({ ...sub, pts: sub.pts.map(p => ({ x: p.x, y: p.y, ...(p.p !== undefined ? { p: p.p } : {}) })) }));
    else if (k === 'fc') { /* handled above */ }
    else if (typeof o[k] === 'object' && o[k] !== null) r[k] = cloneObjDeep(o[k]);
    else r[k] = o[k];
  }
  return r;
}

function interpObj(a, b, t) {
  const o = {};
  // Merge keys from both objects to catch properties that exist only on one side
  const allKeys = new Set([...Object.keys(a), ...(b ? Object.keys(b) : [])]);
  for (const k of allKeys) {
    if (k === 'pts' && (a.pts || (b && b.pts))) {
      const aPts = a.pts || (b && b.pts) || [];
      const bPts = (b && b.pts) || aPts;
      const max = Math.max(aPts.length, bPts.length);
        o.pts = [];
        for (let i = 0; i < max; i++) {
          const ap = aPts[Math.min(i, aPts.length - 1)];
          const bp = bPts[Math.min(i, bPts.length - 1)];
          const pt = { x: ap.x + (bp.x - ap.x) * t, y: ap.y + (bp.y - ap.y) * t };
          if (ap.p !== undefined || bp.p !== undefined) pt.p = ((ap.p !== undefined ? ap.p : 1) + ((bp.p !== undefined ? bp.p : 1) - (ap.p !== undefined ? ap.p : 1)) * t);
          o.pts.push(pt);
        }
    } else if (k === 'color' || k === 'fillColor') {
      if (k === 'fillColor' && !a[k] && (!b || !b[k])) {
        o[k] = null;
      } else {
        const ac = a[k] || '#000000', bc = (b && b[k]) || ac;
        o[k] = interpColor(ac, bc, t);
      }
    } else if (k === 'holes' && (a.holes || (b && b.holes))) {
      const aHoles = a.holes || [];
      const bHoles = (b && b.holes) || aHoles;
      const maxHoles = Math.max(aHoles.length, bHoles.length);
      o.holes = [];
      for (let hi = 0; hi < maxHoles; hi++) {
        const aHole = aHoles[Math.min(hi, aHoles.length - 1)] || [];
        const bHole = bHoles[Math.min(hi, bHoles.length - 1)] || aHole;
        const maxPts = Math.max(aHole.length, bHole.length);
        const pts = [];
        for (let i = 0; i < maxPts; i++) {
          const ap = aHole[Math.min(i, aHole.length - 1)];
          const bp = bHole[Math.min(i, bHole.length - 1)];
          if (ap && bp) pts.push({ x: ap.x + (bp.x - ap.x) * t, y: ap.y + (bp.y - ap.y) * t });
          else if (ap) pts.push({ x: ap.x, y: ap.y });
          else if (bp) pts.push({ x: bp.x, y: bp.y });
        }
        if (pts.length > 2) o.holes.push(pts);
      }
    } else if (k === 'subs') {
      const aSubs = a.subs || [];
      const bSubs = (b && b.subs) || [];
      const maxSubs = Math.max(aSubs.length, bSubs.length);
      o.subs = [];
      for (let si = 0; si < maxSubs; si++) {
        const sub = aSubs[Math.min(si, aSubs.length - 1)];
        const bSub = bSubs[si] || null;
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
        if (bSub && bSub.size !== undefined && sub.size !== undefined) {
          r.size = sub.size + (bSub.size - sub.size) * t;
        }
        o.subs.push(r);
      }
    } else if (['x1','y1','x2','y2','size','opacity','angle','sx','sy','rot','x','y','scaleX','scaleY','rotation','pivotX','pivotY','skewX','skewY'].includes(k)) {
      // Numeric interpolation with proper defaults (scaleX/scaleY default to 1)
      const defaultVal = (k === 'scaleX' || k === 'scaleY' || k === 'sx' || k === 'sy') ? 1 : 0;
      const av = a[k] != null ? a[k] : defaultVal;
      const bv = (b && b[k] != null) ? b[k] : defaultVal;
      o[k] = av + (bv - av) * t;
    } else if (k !== 'fc' && k !== 'composite' && k !== 'uid') {
      o[k] = a[k] != null ? a[k] : (b ? b[k] : undefined);
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
  console.log(`[rebuildTweens] lid: ${lid}, keys:`, keys, 'total frames:', S.frames.length);
  if (keys.length < 2) return;

  for (let k = 0; k < keys.length - 1; k++) {
    const from = keys[k], to = keys[k + 1];
    if (to - from <= 1) continue;

    const fromF = S.frames[from];
    const toF = S.frames[to];
    const fObs = fromF.o[lid] || [];
    const tObs = toF.o[lid] || [];
    console.log(`[rebuildTweens] from: ${from}, to: ${to}, fObs.length: ${fObs.length}, tObs.length: ${tObs.length}`);
    if (fObs.length > 0) {
      const fo = fObs[0], to2 = tObs[0];
      console.log(`[rebuildTweens] fObs[0]: type=${fo.type}, uid=${fo.uid}`);
      if (to2) console.log(`[rebuildTweens] tObs[0]: type=${to2.type}, uid=${to2.uid}`);
      // Show first point of each to verify they differ
      if (fo.pts?.length) console.log(`[rebuildTweens] FROM pts[0]: x=${fo.pts[0].x.toFixed(1)}, y=${fo.pts[0].y.toFixed(1)}, last: x=${fo.pts[fo.pts.length-1].x.toFixed(1)}, y=${fo.pts[fo.pts.length-1].y.toFixed(1)}`);
      if (to2?.pts?.length) console.log(`[rebuildTweens] TO pts[0]: x=${to2.pts[0].x.toFixed(1)}, y=${to2.pts[0].y.toFixed(1)}, last: x=${to2.pts[to2.pts.length-1].x.toFixed(1)}, y=${to2.pts[to2.pts.length-1].y.toFixed(1)}`);
      if (fo.subs?.length) console.log(`[rebuildTweens] FROM has ${fo.subs.length} subs, subs[0].pts[0]: x=${fo.subs[0].pts[0].x.toFixed(1)}, y=${fo.subs[0].pts[0].y.toFixed(1)}`);
      if (to2?.subs?.length) console.log(`[rebuildTweens] TO has ${to2.subs.length} subs, subs[0].pts[0]: x=${to2.subs[0].pts[0].x.toFixed(1)}, y=${to2.subs[0].pts[0].y.toFixed(1)}`);
      // Are they the same reference?
      console.log(`[rebuildTweens] same reference? ${fObs[0] === tObs[0]}, pts same ref? ${fObs[0].pts === tObs[0]?.pts}`);
    }

    for (let fi = from + 1; fi < to; fi++) {
      const raw = (fi - from) / (to - from);
      const t = easeInOut(raw);
      const fr = S.frames[fi];
      fr.key = false;

      const out = [];
      for (let oi = 0; oi < fObs.length; oi++) {
        const fo = fObs[oi];
        let toObj = tObs.find(o => fo.uid && o.uid === fo.uid);
        if (!toObj && (!fo.uid || !fo.uid.startsWith('ai_'))) {
           // Only fallback to index matching for non-AI objects
           toObj = tObs[oi];
        }
        if (fo && toObj && fo.type === toObj.type) {
          if (fo.type === 'fill') {
            const c = document.createElement('canvas');
            c.width = fo.fc.width; c.height = fo.fc.height;
            const cx = c.getContext('2d');
            cx.globalAlpha = 1 - t; cx.drawImage(fo.fc, 0, 0);
            cx.globalAlpha = t; cx.drawImage(toObj.fc, 0, 0);
            out.push({ uid: fo.uid, type: 'fill', fc: c, x: fo.x || 0, y: fo.y || 0, opacity: fo.opacity + (toObj.opacity - fo.opacity) * t });
          } else {
            const io = interpObj(fo, toObj, t);
            io.uid = fo.uid;
            out.push(io);
            console.log(`[rebuildTweens] interpolated frame ${fi}: type=${io.type}`);
          }
        } else if (fo) {
          const cloned = fo.fc ? cloneFill(fo) : interpObj(fo, fo, 0);
          cloned.uid = fo.uid;
          out.push(cloned);
        }
      }
      
      // Also tween the camera!
      if (fromF.cam && toF.cam) {
         fr.cam = {
            x: fromF.cam.x + (toF.cam.x - fromF.cam.x) * t,
            y: fromF.cam.y + (toF.cam.y - fromF.cam.y) * t,
            zoom: fromF.cam.zoom + (toF.cam.zoom - fromF.cam.zoom) * t,
            rotation: fromF.cam.rotation + (toF.cam.rotation - fromF.cam.rotation) * t
         };
      }
      if (!fr.o[lid]) fr.o[lid] = [];
      fr.o[lid] = out;
      console.log(`[rebuildTweens] frame ${fi}: out.length=${out.length}`);
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
  return { type: 'fill', fc: c, x: o.x || 0, y: o.y || 0, opacity: o.opacity };
}

// ==================== PLAYBACK ====================
let _pi = null;
let _playbackStartTime = 0;
let _startFrameIdx = 0;

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
  camera: '<svg viewBox="0 0 24 24"><path d="M15 8h4v8h-4z" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="3" y="6" width="12" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="9" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="19" y1="12" x2="22" y2="12" stroke="currentColor" stroke-width="1.5"/></svg>',
  symbol: '<svg viewBox="0 0 16 16"><path d="M8 2l4 2v4l-4 2-4-2V4z" fill="none" stroke="currentColor" stroke-width="1.5"/><polyline points="8,10 8,6" fill="none" stroke="currentColor" stroke-width="1.5"/><polyline points="4,4 8,6 12,4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
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

function updateTLPlayback() {
  const fNum = $('tl-frame-num');
  if (fNum) fNum.innerHTML = (S.frameIdx + 1) + ' <sup>F</sup>';
  
  const ph = $('tl-playhead');
  const cw = typeof cellW === 'function' ? cellW() : Math.max(10, S.tlZoom * 20);
  if (ph) ph.style.left = ((S.frameIdx * cw) + (cw / 2)) + 'px';
  
  const scroll = $('timeline-scroll');
  if (scroll) {
    const targetScroll = S.frameIdx * cw - scroll.clientWidth / 2 + cw / 2;
    scroll.scrollLeft = Math.max(0, targetScroll);
  }
}

function playbackLoop(timestamp) {
  if (!S.playing) return;
  
  if (_playbackStartTime === 0) _playbackStartTime = timestamp;
  const elapsed = timestamp - _playbackStartTime;
  const expectedFrame = _startFrameIdx + Math.floor(elapsed * S.fps / 1000);
  
  if (expectedFrame !== S.frameIdx) {
    if (expectedFrame >= S.frames.length) {
      if (S.loop) {
        S.frameIdx = 0;
        _startFrameIdx = 0;
        _playbackStartTime = timestamp;
        loopAudioPlay();
      } else {
        S.frameIdx = S.frames.length - 1;
        play(); // stops playback
        return;
      }
    } else {
      S.frameIdx = expectedFrame;
    }
    
    checkAudioFrame(S.frameIdx, S.fps);
    updateTLPlayback();
    fullRender();
  }
  
  _pi = requestAnimationFrame(playbackLoop);
}

function play() {
  S.playing = !S.playing;
  const tlBtn = $('tl-play-btn');
  if (tlBtn) tlBtn.innerHTML = S.playing ? icons.pause : icons.play;
  if (S.playing) {
    if (!S.loop && S.frameIdx >= S.frames.length - 1 && S.frames.length > 0) {
      S.frameIdx = 0;
      updateTL();
      fullRender();
    }
    _startFrameIdx = S.frameIdx;
    _playbackStartTime = performance.now();
    playAudioAtFrame(S.frameIdx, S.fps);
    if (_pi) cancelAnimationFrame(_pi);
    _pi = requestAnimationFrame(playbackLoop);
  } else { 
    if (_pi) cancelAnimationFrame(_pi); 
    _pi = null; 
    pauseAudio(); 
    updateTL(); // refresh full DOM on stop
    fullRender();
  }
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
  else if (f === 'mp4') await expMP4(fn, s, e, sc, ef);
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
  try {
    const fp = await ipcRenderer.invoke('save-file', { defaultName: `${fn}.gif`, filters: [{ name: 'GIF', extensions: ['gif'] }] });
    if (!fp) return;
    
    // Show a small progress indicator on screen
    const usEl = $('update-status');
    if (usEl) { usEl.textContent = 'Rendering GIF...'; usEl.style.color = '#fff'; }

    const GIF = require('gif.js/dist/gif.js');
    const w = Math.round(S.w * sc), h = Math.round(S.h * sc);
    
    // In production (Vite dist), __dirname is /dist, so node_modules is in ../node_modules
    let workerPath = require('path').join(__dirname, '../node_modules/gif.js/dist/gif.worker.js');
    if (!require('fs').existsSync(workerPath)) {
      // Dev mode fallback
      workerPath = require('path').join(__dirname, 'node_modules/gif.js/dist/gif.worker.js');
    }
    const workerScript = require('url').pathToFileURL(workerPath).href;
    
    const gif = new GIF({ workers: 2, quality: 10, width: w, height: h, workerScript });
    for (let i = s; i < e; i++) {
      const ec = document.createElement('canvas');
      ec.width = w; ec.height = h;
      expFrame(i, ec.getContext('2d'), sc);
      gif.addFrame(ec, { copy: true, delay: 1000 / fps });
    }
    
    gif.on('finished', blob => {
      const r = new FileReader();
      r.onload = () => { 
        require('fs').writeFileSync(fp, Buffer.from(r.result)); 
        if (usEl) usEl.textContent = '';
        alert(`GIF → ${fp}`); 
      };
      r.readAsArrayBuffer(blob);
    });
    
    gif.render();
  } catch (err) {
    console.error("GIF Export error:", err);
    alert(`Failed to export GIF: ${err.message || err}`);
    const usEl = $('update-status');
    if (usEl) usEl.textContent = '';
  }
}

async function expMP4(fn, s, e, sc, fps) {
  const fp = await ipcRenderer.invoke('save-file', { defaultName: `${fn}.mp4`, filters: [{ name: 'MP4 Video', extensions: ['mp4'] }] });
  if (!fp) return;
  const frames = [];
  const ec = document.createElement('canvas');
  ec.width = S.w * sc; ec.height = S.h * sc;
  const ecx = ec.getContext('2d');
  
  // Create an overlay to show progress since this might take a while
  const overlay = document.createElement('div');
  overlay.style.position = 'fixed';
  overlay.style.top = '0'; overlay.style.left = '0';
  overlay.style.width = '100vw'; overlay.style.height = '100vh';
  overlay.style.background = 'rgba(0,0,0,0.8)';
  overlay.style.color = 'white';
  overlay.style.display = 'flex';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';
  overlay.style.zIndex = '999999';
  overlay.style.fontSize = '24px';
  overlay.innerText = 'Rendering Frames...';
  document.body.appendChild(overlay);

  // Use a timeout to allow DOM to update
  await new Promise(r => setTimeout(r, 50));

  for (let i = s; i < e; i++) {
    ecx.clearRect(0, 0, ec.width, ec.height);
    // Draw white background for MP4 since alpha transparency isn't supported in standard h264
    ecx.fillStyle = '#ffffff';
    ecx.fillRect(0, 0, ec.width, ec.height);
    expFrame(i, ecx, sc);
    frames.push(ec.toDataURL('image/png'));
  }

  overlay.innerText = 'Encoding Video... This may take a minute.';
  await new Promise(r => setTimeout(r, 50));

  const audioBase64 = Globals.bgAudioData || null;

  const r = await ipcRenderer.invoke('export-mp4', { frames, fps, filePath: fp, audioBase64 });
  document.body.removeChild(overlay);
  if (r.success) {
    alert(`Video → ${fp}`);
  } else {
    alert(`Error: ${r.error}`);
  }
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

      const meta = { frames: {}, meta: { app: 'Dolphin Animate', version: '1.9.2', image: `${fn}.png`, size: { w: finalSheetW, h: finalSheetH } } };

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
if ($('home-btn')) {
  $('home-btn').onclick = () => {
    const startScreen = $('start-screen');
    if (startScreen) startScreen.style.display = 'flex';
  };
}
$('save-project').onclick = saveProj;
$('open-project').onclick = openProj;
$('new-project').onclick = () => {
  if (!confirm('Are you sure you want to discard the current project?')) return;
  const startScreen = $('start-screen');
  if (startScreen) startScreen.style.display = 'flex';
};

function serialize() {
  const d = {
    w: S.w, h: S.h, fps: S.fps, v: 8, bgColor: S.bgColor, bgImgData: S.bgImgData,
    bgAudioData: Globals.bgAudioData,
    symbols: (() => {
      const syms = {};
      for (const id in Symbols) {
        const sym = Symbols[id];
        const serializeChildren = (children) => (children || []).map(obj => {
          const oc = {};
          for (const k of Object.keys(obj)) {
            if (k === 'pts') oc.pts = obj.pts ? obj.pts.map(p => ({ x: p.x, y: p.y, ...(p.p !== undefined ? { p: p.p } : {}) })) : undefined;
            else if (k === 'fc') oc.fcData = obj.fc.toDataURL();
            else if (k === 'children') oc.children = serializeChildren(obj.children);
            else oc[k] = obj[k];
          }
          return oc;
        });
        syms[id] = {
          id: sym.id, name: sym.name, regPoint: sym.regPoint,
          children: serializeChildren(sym.children),
          frames: sym.frames ? sym.frames.map(f => ({
            children: serializeChildren(f.children),
            key: f.key,
          })) : undefined,
        };
      }
      return syms;
    })(),
    layers: S.layers.map(l => ({ id: l.id, name: l.name, vis: l.vis, lock: l.lock, col: l.col })),
    frames: S.frames.map(f => {
      const o = {};
      for (const [lid, objs] of Object.entries(f.o || {})) {
        o[lid] = (objs || []).map(obj => {
          const oc = {};
          for (const k of Object.keys(obj)) {
            if (k === 'pts') oc.pts = obj.pts ? obj.pts.map(p => ({ x: p.x, y: p.y, ...(p.p !== undefined ? { p: p.p } : {}) })) : undefined;
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

async function saveProj(saveAs: boolean | Event = false): Promise<boolean> {
  const isSaveAs = saveAs === true;
  let fp = currentProjectPath;
  if (!fp || isSaveAs) {
    fp = await ipcRenderer.invoke('save-file', { defaultName: 'project.yunus', filters: [{ name: 'Yunus Project', extensions: ['yunus'] }] });
  }
  if (!fp) return false;
  currentProjectPath = fp;
  const r = await ipcRenderer.invoke('write-file', { filePath: fp, data: serialize() });
  if (!r.success) {
    alert('Save failed: ' + r.error);
    return false;
  } else {
    try {
      let recents = JSON.parse(localStorage.getItem('recentProjects') || '[]');
      recents = recents.filter((p: any) => p.path !== fp);
      recents.unshift({ name: fp.split('\\').pop() || fp, path: fp, date: Date.now() });
      if (recents.length > 10) recents.pop();
      localStorage.setItem('recentProjects', JSON.stringify(recents));
    } catch (e) {}
    return true;
  }
}

async function openProj(providedPath?: string): Promise<boolean> {
  let fp = providedPath;
  if (!fp || typeof fp !== 'string') {
    fp = await ipcRenderer.invoke('open-file', { filters: [{ name: 'Yunus Project', extensions: ['yunus'] }] });
  }
  if (!fp) return false;
  currentProjectPath = fp;
  const json = await ipcRenderer.invoke('read-file', fp);
  if (!json) { alert('Read failed'); return false; }
  
  // Add to recent projects
  try {
    let recents = JSON.parse(localStorage.getItem('recentProjects') || '[]');
    recents = recents.filter((p: any) => p.path !== fp);
    recents.unshift({ name: fp.split('\\').pop() || fp, path: fp, date: Date.now() });
    if (recents.length > 10) recents.pop();
    localStorage.setItem('recentProjects', JSON.stringify(recents));
  } catch (e) {}

  try {
    const d = JSON.parse(json);
    S.w = d.w || 800; S.h = d.h || 600; S.fps = d.fps || 12; S.bgColor = d.bgColor || '#ffffff';
    if (d.bgImgData) { const img = new Image(); img.onload = () => { S.bgImg = img; dirtyCache(); render(); }; img.src = d.bgImgData; S.bgImgData = d.bgImgData; if ($('pan-bgimg-row')) $('pan-bgimg-row').style.display = 'flex'; }
    if (d.bgAudioData) { Globals.bgAudioData = d.bgAudioData; renderAudioTimeline(); }
    else { Globals.bgAudioData = null; renderAudioTimeline(); }
    
    // Load Symbols
    for (const key in Symbols) delete Symbols[key];
    if (d.symbols) {
      const deserializeChildren = (children, promises) => (children || []).map(obj => {
        const oc = {};
        for (const k of Object.keys(obj)) {
          if (k === 'fcData') {
            const img = new Image();
            img.src = obj.fcData;
            const c = document.createElement('canvas'); c.width = S.w; c.height = S.h;
            promises.push(new Promise(resolve => { img.onload = () => { c.getContext('2d').drawImage(img, 0, 0); resolve(); }; img.onerror = resolve; }));
            oc.fc = c;
          } else if (k === 'children') {
            oc.children = deserializeChildren(obj.children, promises);
          } else {
            oc[k] = obj[k];
          }
        }
        return oc;
      });
      const symLoadPromises = [];
      for (const key in d.symbols) {
        const symData = d.symbols[key];
        Symbols[key] = {
          id: symData.id, name: symData.name, regPoint: symData.regPoint,
          children: deserializeChildren(symData.children, symLoadPromises),
          frames: symData.frames ? symData.frames.map(f => ({
            children: deserializeChildren(f.children, symLoadPromises),
            key: f.key,
          })) : undefined,
        };
      }
      Promise.all(symLoadPromises).then(() => { refreshLibrary(); dirtyCache(); render(); });
    }
    refreshLibrary();
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
    fullRender(); updateLayerUI(); centerZoom(); saveSnapshot();
    return true;
  } catch (err) { alert('Parse error: ' + err.message); return false; }
}

function newProj(skipConfirm = false) {
  if (!skipConfirm && !confirm('Are you sure you want to discard the current project?')) return;
  currentProjectPath = null;
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
  fullRender(); updateLayerUI(); centerZoom(); saveSnapshot();
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
    
    // Z-Order Options
    items.push({ label: 'Bring to Front', action: () => changeZOrder('front') });
    items.push({ label: 'Bring Forward', action: () => changeZOrder('forward') });
    items.push({ label: 'Send Backward', action: () => changeZOrder('backward') });
    items.push({ label: 'Send to Back', action: () => changeZOrder('back') });
    items.push({ sep: true });

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
  saveSnapshot();
}

function changeZOrder(action: 'front' | 'back' | 'forward' | 'backward') {
  if (!S.selObjs.length) return;
  const layerGroups = {};
  for (const ref of S.selObjs) {
    if (!layerGroups[ref.layerId]) layerGroups[ref.layerId] = [];
    layerGroups[ref.layerId].push(ref.idx);
  }
  
  const newSel = [];
  
  for (const lid in layerGroups) {
    const arr = obs(S.frameIdx, lid);
    const indices = layerGroups[lid].sort((a,b) => a - b);
    
    if (action === 'front') {
      const moved = indices.map(i => arr[i]);
      for (let i = indices.length - 1; i >= 0; i--) arr.splice(indices[i], 1);
      for (const m of moved) {
        newSel.push({ layerId: lid, idx: arr.length });
        arr.push(m);
      }
    } else if (action === 'back') {
      const moved = indices.map(i => arr[i]);
      for (let i = indices.length - 1; i >= 0; i--) arr.splice(indices[i], 1);
      for (let i = 0; i < moved.length; i++) {
        arr.unshift(moved[i]);
        newSel.push({ layerId: lid, idx: i });
      }
    } else if (action === 'forward') {
      for (let i = indices.length - 1; i >= 0; i--) {
        const idx = indices[i];
        if (idx < arr.length - 1) {
          const temp = arr[idx];
          arr[idx] = arr[idx + 1];
          arr[idx + 1] = temp;
          newSel.push({ layerId: lid, idx: idx + 1 });
          for (let j = i - 1; j >= 0; j--) {
            if (indices[j] === idx + 1) indices[j] = idx;
          }
        } else {
          newSel.push({ layerId: lid, idx });
        }
      }
    } else if (action === 'backward') {
      for (let i = 0; i < indices.length; i++) {
        const idx = indices[i];
        if (idx > 0) {
          const temp = arr[idx];
          arr[idx] = arr[idx - 1];
          arr[idx - 1] = temp;
          newSel.push({ layerId: lid, idx: idx - 1 });
          for (let j = i + 1; j < indices.length; j++) {
             if (indices[j] === idx - 1) indices[j] = idx;
          }
        } else {
          newSel.push({ layerId: lid, idx });
        }
      }
    }
  }
  
  S.selObjs = newSel;
  dirtyCache();
  fullRender();
  drawSelection();
  saveSnapshot();
}

function drawFillPathObj(ctx, o, baseAlpha = 1) {
  if (o.eraserFc || (o.erasers && o.erasers.length > 0)) {
    if (typeof ensureSize !== 'undefined') {
      _eraserCanvas = ensureSize(_eraserCanvas, ctx.canvas.width, ctx.canvas.height);
      _eraserCtx = _eraserCanvas.getContext('2d');
    } else {
      if (!_eraserCanvas) _eraserCanvas = document.createElement('canvas');
      if (_eraserCanvas.width !== ctx.canvas.width || _eraserCanvas.height !== ctx.canvas.height) {
        _eraserCanvas.width = ctx.canvas.width;
        _eraserCanvas.height = ctx.canvas.height;
      }
      _eraserCtx = _eraserCanvas.getContext('2d');
    }
    _eraserCtx.clearRect(0, 0, _eraserCanvas.width, _eraserCanvas.height);
    
    const m = ctx.getTransform();
    _eraserCtx.setTransform(m);
    _eraserCtx.fillStyle = o.color;
    
    if (o.pathData) {
      _eraserCtx.fill(new Path2D(o.pathData), o.rule || 'evenodd');
    } else if (o.pts && o.pts.length > 2) {
      _eraserCtx.beginPath();
      _eraserCtx.moveTo(o.pts[0].x, o.pts[0].y);
      for (let i = 1; i < o.pts.length; i++) _eraserCtx.lineTo(o.pts[i].x, o.pts[i].y);
      _eraserCtx.closePath();
      if (o.holes) {
        for (const hole of o.holes) {
          if (!hole || hole.length < 3) continue;
          _eraserCtx.moveTo(hole[0].x, hole[0].y);
          for (let i = 1; i < hole.length; i++) _eraserCtx.lineTo(hole[i].x, hole[i].y);
          _eraserCtx.closePath();
        }
      }
      _eraserCtx.fill(o.rule || 'evenodd');
      _eraserCtx.lineWidth = 1.0;
      _eraserCtx.strokeStyle = o.color;
      _eraserCtx.stroke();
    }

    _eraserCtx.globalCompositeOperation = 'destination-out';
    if (o.eraserFc) {
      _eraserCtx.drawImage(o.eraserFc, o.eraserX, o.eraserY);
    }
    if (o.erasers && o.erasers.length > 0) {
      _eraserCtx.lineCap = 'round';
      _eraserCtx.lineJoin = 'round';
      for (const er of o.erasers) {
        if (!er.pts || er.pts.length === 0) continue;
        _eraserCtx.lineWidth = er.size;
        _eraserCtx.beginPath();
        _eraserCtx.moveTo(er.pts[0].x, er.pts[0].y);
        for (let i = 1; i < er.pts.length; i++) _eraserCtx.lineTo(er.pts[i].x, er.pts[i].y);
        _eraserCtx.stroke();
      }
    }
    _eraserCtx.globalCompositeOperation = 'source-over';
    _eraserCtx.resetTransform();

    ctx.save();
    ctx.resetTransform();
    ctx.globalAlpha = (o.opacity !== undefined ? o.opacity : 1) * baseAlpha;
    ctx.drawImage(_eraserCanvas, 0, 0);
    ctx.restore();
    return;
  }

  ctx.save();
  ctx.globalAlpha = (o.opacity !== undefined ? o.opacity : 1) * baseAlpha;
  ctx.fillStyle = o.color;
  if (o.pathData) {
    ctx.fill(new Path2D(o.pathData), o.rule || 'evenodd');
  } else if (o.pts && o.pts.length > 2) {
    ctx.beginPath();
    ctx.moveTo(o.pts[0].x, o.pts[0].y);
    for (let i = 1; i < o.pts.length; i++) ctx.lineTo(o.pts[i].x, o.pts[i].y);
    ctx.closePath();
    if (o.holes) {
      for (const hole of o.holes) {
        if (!hole || hole.length < 3) continue;
        ctx.moveTo(hole[0].x, hole[0].y);
        for (let i = 1; i < hole.length; i++) ctx.lineTo(hole[i].x, hole[i].y);
        ctx.closePath();
      }
    }
    ctx.fill(o.rule || 'evenodd');
    ctx.lineWidth = 1.0;
    ctx.strokeStyle = o.color;
    ctx.stroke();
  }
  ctx.restore();
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
function groupSelected(silent = false) {
  if (S.selObjs.length < 2) {
    if (!silent) alert('At least 2 objects must be selected to group them.');
    return;
  }
  const layerId = S.selObjs[0].layerId;
  const children = [];
  for (const ref of S.selObjs) {
    const objs = obs(S.frameIdx, ref.layerId);
    children.push(cloneObj(objs[ref.idx]));
  }
  delSel();
  const objs = obs(S.frameIdx, layerId);
  objs.push({ uid: Math.random().toString(36).substr(2, 9), type: 'group', children, opacity: 1 });
  setSel({ layerId, idx: objs.length - 1 });
  dirtyCache(); fullRender(); drawSelection(); saveSnapshot();
}
function ungroupSelected() {
  if (S.selObjs.length !== 1) return;
  const ref = S.selObjs[0];
  const objs = obs(S.frameIdx, ref.layerId);
  const o = objs[ref.idx];
  if (!o || o.type !== 'group' || !o.children) return;
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
      items.push({ label: S.frames[idx] && S.frames[idx].key ? 'Remove Keyframe' : 'Add Keyframe', action: () => { saveSnapshot(); toggleKeyframe(idx); S.tlDirty = true; fullRender(); } });
      items.push({ sep: true });
    }
    items.push({ label: 'Duplicate Frame', shortcut: 'F5', action: () => { S.frameIdx = idx; dupFrame(); } });
    items.push({ label: 'Blank Frame', shortcut: 'F6', action: () => { S.frameIdx = idx; addEmptyFrame(); } });
    if (!multi) items.push({ label: 'Clear Frame', shortcut: 'Shift+F7', action: () => { S.frameIdx = idx; clearFrame(); } });
    if (multi) {
      items.push({ label: 'Delete Selected Frames', action: () => { delSelectedFrames(); } });
      items.push({ label: 'Key Selected Frames', action: () => { saveSnapshot(); for (const fi of _selectedFrames) { toggleKeyframe(fi); } S.tlDirty = true; fullRender(); } });
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
      items.push({ label: 'Key Selected Frames', action: () => { saveSnapshot(); for (const fi of _selectedFrames) { toggleKeyframe(fi); } S.tlDirty = true; fullRender(); } });
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
  initAudioUI(updateTL);
  initAudioUI(updateTL);
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
    if (['brush', 'eraser', 'pencil'].includes(S.tool)) {
      renderOverlay();
    }
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
            const tc = getObjTransformedCorners(o);
            const f = S.frames[S.frameIdx];
            const camZoom = f && f.cam ? f.cam.zoom : 1;
            if (pointInOrNearPolygon(p, tc, 15 / camZoom)) cursor = 'move';
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
  canvas.addEventListener('dblclick', e => {
    if (S.tool === 'select') {
      const p = m2b(e);
      const hit = hitTest(p);
      if (hit) {
        const o = obs(S.frameIdx, hit.layerId)[hit.idx];
        if (o && o.type === 'symbol') {
          enterIsolationMode(o.symbolId, { layerId: hit.layerId, idx: hit.idx });
          return;
        }
      }
      // Double-click on empty area exits isolation mode (Adobe Animate behavior)
      if (IsolationMode && !hit) {
        exitIsolationMode();
      }
    }
  });
  // Double-click on stroke path to insert a point
  $('canvas-area').addEventListener('wheel', e => {
    e.preventDefault();
    if (S.tool === 'camera') {
      const f = S.frames[S.frameIdx];
      if (f && f.cam) {
         if (e.shiftKey) { 
            f.cam.rotation += e.deltaY > 0 ? 5 : -5;
         } else { 
            f.cam.zoom = Math.max(0.1, f.cam.zoom - e.deltaY * 0.001);
         }
         S.tlDirty = true;
         fullRender();
      }
      return;
    }
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
    btn.onclick = () => switchTool(btn.dataset.tool);
  });
  // Property controls
  $('prop-size').oninput = e => { 
    const v = Math.max(1, Math.min(100, parseInt(e.target.value) || 1));
    S.size = v; 
    if ($('brush-size')) $('brush-size').value = v.toString(); 
    if ($('brush-size-label')) $('brush-size-label').textContent = v.toString();
    const o = selObj();
    if (o) {
      saveSnapshot();
      for (const ref of S.selObjs) {
        const obj = obs(S.frameIdx, ref.layerId)[ref.idx];
        if (obj) obj.size = v;
      }
      dirtyCache(); render(); updateObjPanel();
    }
  };
  $('prop-size').onchange = e => {
    e.target.value = Math.max(1, Math.min(100, parseInt(e.target.value) || 1));
  };
  $('prop-opacity').oninput = e => { 
    const v = Math.max(0, Math.min(100, parseInt(e.target.value) || 0)) / 100;
    S.opacity = v; 
    if ($('opacity')) $('opacity').value = Math.round(v * 100).toString();
    const o = selObj();
    if (o) {
      saveSnapshot();
      for (const ref of S.selObjs) {
        const obj = obs(S.frameIdx, ref.layerId)[ref.idx];
        if (obj) obj.opacity = v;
      }
      dirtyCache(); render(); updateObjPanel();
    }
  };
  $('prop-opacity').onchange = e => {
    e.target.value = Math.max(0, Math.min(100, parseInt(e.target.value) || 0));
  };
  $('prop-smoothness').oninput = e => { 
    const val = Math.max(0, Math.min(100, parseInt(e.target.value) || 0));
    S.smoothness = val; 
    S.smoothing = val / 100;
    if ($('smoothing')) {
      $('smoothing').value = S.smoothing;
      $('smoothing-label').textContent = Math.round(S.smoothing * 100) + '%';
    }
  };
  $('prop-smoothness').onchange = e => {
    e.target.value = Math.max(0, Math.min(100, parseInt(e.target.value) || 0));
  };
  $('prop-spacing').oninput = e => { S.spacing = Math.max(0, Math.min(20, parseInt(e.target.value) || 0)); };
  $('prop-spacing').onchange = e => {
    e.target.value = Math.max(0, Math.min(20, parseInt(e.target.value) || 0));
  };
  $('prop-thinning').oninput = e => { S.thinning = Math.max(0, Math.min(100, parseInt(e.target.value) || 0)) / 100; };
  $('prop-thinning').onchange = e => {
    e.target.value = Math.max(0, Math.min(100, parseInt(e.target.value) || 0));
  };
  $('prop-close-gaps').onchange = e => { S.closeGaps = parseInt(e.target.value); };
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
  // Initial sync: top bar -> prop panel
  $('prop-size').value = $('brush-size').value;
  $('prop-opacity').value = $('opacity').value;
  if ($('prop-smoothness')) $('prop-smoothness').value = S.smoothness || 0;
  if ($('prop-spacing')) $('prop-spacing').value = S.spacing || 0;
  if ($('prop-thinning')) $('prop-thinning').value = Math.round((S.thinning || 0) * 100);
  if ($('prop-close-gaps')) $('prop-close-gaps').value = S.closeGaps || 0;
  // Sync top bar size/opacity to prop panel and selected objects
  $('brush-size').oninput = e => { 
    const v = parseInt(e.target.value);
    S.size = v; 
    $('brush-size-label').textContent = e.target.value; 
    if ($('prop-size')) $('prop-size').value = e.target.value; 
    // Update selected objects if any
    const o = selObj();
    if (o) {
      saveSnapshot();
      for (const ref of S.selObjs) {
        const obj = obs(S.frameIdx, ref.layerId)[ref.idx];
        if (obj) obj.size = v;
      }
      dirtyCache(); render(); updateObjPanel();
    }
  };
  $('opacity').oninput = e => { 
    const v = parseInt(e.target.value) / 100;
    S.opacity = v; 
    if ($('prop-opacity')) $('prop-opacity').value = e.target.value; 
    // Update selected objects if any
    const o = selObj();
    if (o) {
      saveSnapshot();
      for (const ref of S.selObjs) {
        const obj = obs(S.frameIdx, ref.layerId)[ref.idx];
        if (obj) obj.opacity = v;
      }
      dirtyCache(); render(); updateObjPanel();
    }
  };

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
  $('stroke-swatch').onclick = () => { try { ($('stroke-color') as any).showPicker(); } catch(e) { $('stroke-color').click(); } };
  $('fill-swatch').onclick = () => { try { ($('fill-color') as any).showPicker(); } catch(e) { $('fill-color').click(); } };
  $('brush-size').oninput = e => { S.size = parseInt(e.target.value); $('brush-size-label').textContent = e.target.value; };
  $('opacity').oninput = e => S.opacity = parseInt(e.target.value) / 100;
  if ($('smoothing')) $('smoothing').oninput = e => { 
    S.smoothing = parseFloat(e.target.value); 
    $('smoothing-label').textContent = Math.round(S.smoothing * 100) + '%'; 
    S.smoothness = Math.round(S.smoothing * 100);
    if ($('prop-smoothness')) $('prop-smoothness').value = S.smoothness;
  };

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
    $('add-keyframe').onclick = () => { saveSnapshot(); toggleKeyframe(S.frameIdx); S.tlDirty = true; fullRender(); };
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
      toggleKeyframe(S.frameIdx);
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
    let fps = parseInt(e.target.value) || 12;
    if (fps < 1) fps = 1;
    if (fps > 120) fps = 120;
    S.fps = fps;
    e.target.value = fps.toString();
    if (S.playing) {
      _startFrameIdx = S.frameIdx;
      _playbackStartTime = performance.now();
      playAudioAtFrame(S.frameIdx, S.fps);
    }
  };
  
  if ($('tl-fps-inline')) $('tl-fps-inline').onchange = e => {
    let fps = parseInt(e.target.value);
    if (!isNaN(fps)) {
      if (fps < 1) fps = 1;
      if (fps > 120) fps = 120;
      saveSnapshot();
      S.fps = fps;
      e.target.value = fps.toString();
      if ($('fps-input')) $('fps-input').value = fps.toString();
      
      if (S.playing) { 
        _startFrameIdx = S.frameIdx;
        _playbackStartTime = performance.now();
        playAudioAtFrame(S.frameIdx, S.fps);
      } else {
        updateTL();
      }
    }
  };
  
  if ($('loop-toggle')) $('loop-toggle').onchange = e => { saveSnapshot(); S.loop = e.target.checked; };
  // Onion skin controls
  function setOnion(v) { saveSnapshot(); S.onion = v; if ($('onion-skin')) $('onion-skin').checked = v; if ($('prop-onion')) $('prop-onion').checked = v; dirtyCache(); render(); }
  if ($('onion-skin')) $('onion-skin').onchange = e => setOnion(e.target.checked);
  if ($('prop-onion')) $('prop-onion').onchange = e => setOnion(e.target.checked);
  if ($('prop-onion-opacity')) {
    $('prop-onion-opacity').oninput = e => {
      saveSnapshot();
      const val = Math.max(5, Math.min(80, parseInt(e.target.value) || 20));
      S.onionOpacity = val / 100;
      if ($('prop-onion-opacity-label')) $('prop-onion-opacity-label').textContent = val + '%';
      dirtyCache(); render();
    };
    $('prop-onion-opacity').onchange = e => {
      e.target.value = Math.max(5, Math.min(80, parseInt(e.target.value) || 20));
    };
  }
  if ($('prop-onion-frames')) {
    $('prop-onion-frames').onchange = e => {
      saveSnapshot();
      const val = Math.max(1, Math.min(10, parseInt(e.target.value) || 1));
      S.onionFrames = val;
      e.target.value = val.toString();
      dirtyCache(); render();
    };
  }
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
  if ($('obj-x')) $('obj-x').onchange = e => { 
    if (!selObj()) return; 
    saveSnapshot(); 
    const b = getMultiBounds(); 
    if (!b) return; 
    const dx = parseFloat(e.target.value) - b.x; 
    for (const ref of S.selObjs) { 
        const obj = obs(S.frameIdx, ref.layerId)[ref.idx]; 
        if (obj) moveObjBy(obj, dx, 0); 
    } 
    dirtyCache(); render(); updateObjPanel(); 
  };
  if ($('obj-y')) $('obj-y').onchange = e => { 
    if (!selObj()) return; 
    saveSnapshot(); 
    const b = getMultiBounds(); 
    if (!b) return; 
    const dy = parseFloat(e.target.value) - b.y; 
    for (const ref of S.selObjs) { 
        const obj = obs(S.frameIdx, ref.layerId)[ref.idx]; 
        if (obj) moveObjBy(obj, 0, dy); 
    } 
    dirtyCache(); render(); updateObjPanel(); 
  };
  if ($('obj-stroke-size')) $('obj-stroke-size').oninput = e => { const o = selObj(); if (!o) return; saveSnapshot(); const v = parseInt(e.target.value); for (const ref of S.selObjs) { const obj = obs(S.frameIdx, ref.layerId)[ref.idx]; if (obj) obj.size = v; } dirtyCache(); render(); updateObjPanel(); };
  
  if ($('obj-fill-swatch')) $('obj-fill-swatch').onclick = () => { 
    const i = $('obj-fill-input'); 
    if (i) {
      try { i.showPicker(); } catch(e) { i.click(); }
    }
  };
  if ($('obj-fill-input')) $('obj-fill-input').oninput = e => {
    if (!selObj()) return;
    saveSnapshot();
    const col = e.target.value;
    for (const ref of S.selObjs) {
      const obj = obs(S.frameIdx, ref.layerId)[ref.idx];
      if (obj) obj.fillColor = col;
    }
    dirtyCache(); render(); updateObjPanel();
  };
  
  if ($('obj-stroke-swatch')) $('obj-stroke-swatch').onclick = () => { 
    const i = $('obj-stroke-input'); 
    if (i) {
      try { i.showPicker(); } catch(e) { i.click(); }
    }
  };
  if ($('obj-stroke-input')) $('obj-stroke-input').oninput = e => {
    if (!selObj()) return;
    saveSnapshot();
    const col = e.target.value;
    for (const ref of S.selObjs) {
      const obj = obs(S.frameIdx, ref.layerId)[ref.idx];
      if (obj) obj.color = col;
    }
    dirtyCache(); render(); updateObjPanel();
  };

  const handleOpacityInput = (e: Event) => {
    if (!selObj()) return;
    saveSnapshot();
    const pct = parseFloat((e.target as HTMLInputElement).value);
    for (const ref of S.selObjs) {
      const obj = obs(S.frameIdx, ref.layerId)[ref.idx];
      if (obj) obj.opacity = pct;
    }
    dirtyCache(); render(); updateObjPanel();
  };
  if ($('obj-fill-opacity')) $('obj-fill-opacity').oninput = handleOpacityInput;
  if ($('obj-stroke-opacity')) $('obj-stroke-opacity').oninput = handleOpacityInput;

  if ($('lib-convert-btn')) $('lib-convert-btn').onclick = convertToSymbol;

  // Drop symbol onto canvas
  canvas.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  canvas.addEventListener('drop', e => {
    e.preventDefault();
    try {
      const data = JSON.parse(e.dataTransfer.getData('text/plain'));
      if (data.type === 'symbol_drag') {
        const pt = m2b(e);
        const l = L();
        if (!l) return;
        saveSnapshot();
        const inst = {
          type: 'symbol',
          symbolId: data.symbolId,
          x: pt.x,
          y: pt.y,
          sx: 1, sy: 1, rot: 0
        };
        obs(S.frameIdx, l.id).push(inst);
        S.selObjs = [{ layerId: l.id, idx: obs(S.frameIdx, l.id).length - 1 }];
        refreshLibrary();
        dirtyCache(); fullRender(); drawSelection();
      }
    } catch(err) {}
  });

  document.addEventListener('keydown', e => {
    // Check if we are focusing an input inside the Settings tab specifically for keybinding
    if ((e.target as HTMLElement).classList && (e.target as HTMLElement).classList.contains('keycap-btn')) {
      e.preventDefault();
      return;
    }
    
    // Play/pause: never when typing in text/number inputs
    if (matchKey(e, KeyMap['play_pause'])) {
      const tag = (e.target as HTMLElement).tagName;
      const type = (e.target as HTMLInputElement).type;
      if (tag === 'TEXTAREA' || (tag === 'INPUT' && (type === 'text' || type === 'number' || type === 'search'))) return;
      e.preventDefault(); play(); return;
    }
    if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return;
    
    // Top Bar shortcuts
    if (matchKey(e, KeyMap['new_project'])) { e.preventDefault(); $('new-project').click(); return; }
    if (matchKey(e, KeyMap['open_project'])) { e.preventDefault(); $('open-project').click(); return; }
    if (matchKey(e, KeyMap['save_project_as'])) { e.preventDefault(); saveProj(true); return; }
    if (matchKey(e, KeyMap['save_project'])) { e.preventDefault(); $('save-project').click(); return; }
    
    if (S.playing) return;

    if (matchKey(e, KeyMap['undo'])) { e.preventDefault(); undo(); return; }
    if (matchKey(e, KeyMap['redo'])) { e.preventDefault(); redo(); return; }
    if (matchKey(e, KeyMap['zoom_reset'])) { e.preventDefault(); centerZoom(); return; }
    if (matchKey(e, KeyMap['zoom_in'])) { e.preventDefault(); zoomAt(1); return; }
    if (matchKey(e, KeyMap['zoom_out'])) { e.preventDefault(); zoomAt(-1); return; }
    
    if (matchKey(e, KeyMap['copy'])) {
      e.preventDefault();
      if (S.selObjs.length) copySel();
      else copyFrameContent();
      return;
    }
    if (matchKey(e, KeyMap['cut'])) { e.preventDefault(); cutSel(); return; }
    
    if (matchKey(e, KeyMap['duplicate'])) {
      e.preventDefault();
      if (S.selObjs.length) {
        const newRefs = [];
        for (const ref of S.selObjs) {
          const obj = obs(S.frameIdx, ref.layerId)[ref.idx];
          const c = cloneObj(obj);
          if (c.pts) c.pts = c.pts.map(p => ({ x: p.x + 10, y: p.y + 10, ...(p.p !== undefined ? { p: p.p } : {}) }));
          if (c.x1 != null) { c.x1 += 10; c.y1 += 10; c.x2 += 10; c.y2 += 10; }
          if (c.type === 'text') { c.x += 10; c.y += 10; }
          if (c.type === 'group' && c.children) {
            for (const ch of c.children) {
              if (ch.pts) ch.pts = ch.pts.map(p => ({ x: p.x + 10, y: p.y + 10, ...(p.p !== undefined ? { p: p.p } : {}) }));
              if (ch.x1 != null) { ch.x1 += 10; ch.y1 += 10; ch.x2 += 10; ch.y2 += 10; }
              if (ch.type === 'text') { ch.x += 10; ch.y += 10; }
            }
          }
          const objs = obs(S.frameIdx, ref.layerId);
          objs.push(c);
          newRefs.push({ layerId: ref.layerId, idx: objs.length - 1 });
        }
        S.selObjs = newRefs;
        dirtyCache(); fullRender(); drawSelection(); saveSnapshot();
      }
      return;
    }
    
    if (matchKey(e, KeyMap['create_tween'])) { e.preventDefault(); tweenAll(); return; }
    
    if (matchKey(e, KeyMap['paste'])) {
      e.preventDefault();
      if (_clipboard) {
        const l = L();
        if (l) {
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
    
    if (matchKey(e, KeyMap['convert_to_symbol'])) { e.preventDefault(); convertToSymbol(); return; }
    if (matchKey(e, KeyMap['group'])) { e.preventDefault(); groupSelected(); return; }
    if (matchKey(e, KeyMap['ungroup'])) { e.preventDefault(); ungroupSelected(); return; }
    if (matchKey(e, KeyMap['import_image'])) { e.preventDefault(); importImage(); return; }

    const tools = ['brush', 'pencil', 'eraser', 'rect', 'circle', 'line', 'fill', 'select', 'text', 'pen', 'guide'];
    for (const t of tools) {
      if (matchKey(e, KeyMap[t])) {
        e.preventDefault();
        switchTool(t as any);
        return;
      }
    }

    const k = e.key;
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
    if (k === 'F7') { e.preventDefault(); saveSnapshot(); toggleKeyframe(S.frameIdx); S.tlDirty = true; fullRender(); return; }
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

export function renderSymbolThumb(symId: string, size = 60): HTMLCanvasElement {
  const sym = Symbols[symId];
  const tc = document.createElement('canvas');
  tc.width = size; tc.height = size;
  const tctx = tc.getContext('2d');
  if (!sym || !sym.children || !sym.children.length) return tc;

  // Calculate bounding box of all children
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of sym.children) {
    const bb = getObjBounds(c);
    if (bb.w === 0 && bb.h === 0) continue;
    minX = Math.min(minX, bb.x); minY = Math.min(minY, bb.y);
    maxX = Math.max(maxX, bb.x + bb.w); maxY = Math.max(maxY, bb.y + bb.h);
  }
  if (minX === Infinity) return tc;

  const cw = maxX - minX || 1;
  const ch = maxY - minY || 1;
  const padding = 4;
  const availW = size - padding * 2;
  const availH = size - padding * 2;
  const scale = Math.min(availW / cw, availH / ch, 2);
  const offX = padding + (availW - cw * scale) / 2 - minX * scale;
  const offY = padding + (availH - ch * scale) / 2 - minY * scale;

  tctx.fillStyle = '#ffffff';
  tctx.fillRect(0, 0, size, size);
  tctx.save();
  tctx.translate(offX, offY);
  tctx.scale(scale, scale);

  // Draw fills first
  for (const child of sym.children) {
    if (child.type === 'fill' && child.fc) {
      tctx.save();
      tctx.translate(child.x || 0, child.y || 0);
      tctx.globalAlpha = child.opacity || 1;
      tctx.imageSmoothingEnabled = false;
      tctx.drawImage(child.fc, 0, 0);
      tctx.restore();
    } else if (child.type === 'fillPath') {
      drawFillPathObj(tctx, child, 1);
    }
  }
  // Draw strokes, shapes, text
  for (const child of sym.children) {
    if (child.type === 'stroke') {
      const subs = child.subs && child.subs.length ? child.subs : (child.pts ? [{ pts: child.pts, size: child.size, color: child.color, opacity: child.opacity }] : []);
      for (const sub of subs) {
        drawStroke(tctx, sub.pts, sub.color || child.color, sub.size !== undefined ? sub.size : child.size, (sub.opacity !== undefined ? sub.opacity : child.opacity) || 1, 'source-over', child.thinning, child.smoothing, child.simulatePressure);
      }
    } else if (child.type === 'text') {
      tctx.save();
      tctx.font = `${child.bold ? 'bold ' : ''}${child.italic ? 'italic ' : ''}${child.size}px "${child.font}"`;
      tctx.fillStyle = child.color;
      tctx.globalAlpha = child.opacity || 1;
      tctx.textBaseline = 'top';
      const lines = (child.text || '').split('\n');
      for (let i = 0; i < lines.length; i++) tctx.fillText(lines[i], child.x, child.y + i * (child.size * 1.2));
      tctx.restore();
    } else if (child.type === 'rect' || child.type === 'circle' || child.type === 'line') {
      drawShape(tctx, child.type, child.x1, child.y1, child.x2, child.y2, child.color, child.fillColor, child.size, child.opacity || 1);
    } else if (child.type === 'group' && child.children) {
      // Simple recursive draw for groups
      const drawGroupThumb = (children) => {
        for (const gc of children) {
          if (gc.type === 'stroke') {
            const subs = gc.subs && gc.subs.length ? gc.subs : (gc.pts ? [{ pts: gc.pts, size: gc.size, color: gc.color, opacity: gc.opacity }] : []);
            for (const sub of subs) drawStroke(tctx, sub.pts, sub.color || gc.color, sub.size !== undefined ? sub.size : gc.size, (sub.opacity !== undefined ? sub.opacity : gc.opacity) || 1, 'source-over', gc.thinning, gc.smoothing, gc.simulatePressure);
          } else if (gc.type === 'fill' && gc.fc) {
            tctx.save(); tctx.translate(gc.x || 0, gc.y || 0); tctx.drawImage(gc.fc, 0, 0); tctx.restore();
          } else if (gc.type === 'fillPath') {
            drawFillPathObj(tctx, gc, 1);
          } else if (gc.type !== 'fill' && gc.type !== 'fillPath' && gc.x1 != null) {
            drawShape(tctx, gc.type, gc.x1, gc.y1, gc.x2, gc.y2, gc.color, gc.fillColor, gc.size, gc.opacity || 1);
          } else if (gc.type === 'group' && gc.children) {
            drawGroupThumb(gc.children);
          }
        }
      };
      drawGroupThumb(child.children);
    }
  }

  tctx.restore();

  // Border
  tctx.strokeStyle = '#333';
  tctx.lineWidth = 1;
  tctx.strokeRect(0.5, 0.5, size - 1, size - 1);

  return tc;
}

function countSymbolUsages(symId: string): number {
  let count = 0;
  for (const f of S.frames) {
    for (const lid in f.o) {
      for (const o of f.o[lid]) {
        if (o.type === 'symbol' && o.symbolId === symId) count++;
      }
    }
  }
  return count;
}

export function refreshLibrary() {
  const list = $('lib-item-list');
  if (!list) return;
  list.innerHTML = '';
  for (const id in Symbols) {
    const sym = Symbols[id];
    const item = document.createElement('div');
    item.className = 'lib-item';

    // Thumbnail
    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'lib-item-thumb';
    const thumbCanvas = renderSymbolThumb(id, 50);
    thumbCanvas.style.cssText = 'width:100%;height:100%;border-radius:3px;';
    thumbWrap.appendChild(thumbCanvas);

    // Info
    const info = document.createElement('div');
    info.className = 'lib-item-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'lib-item-name';
    nameEl.innerHTML = `<span style="margin-right: 5px; vertical-align: middle; width: 14px; height: 14px; display: inline-block;">${icons.symbol}</span><span class="lib-name-text">${sym.name}</span>`;
    const usageEl = document.createElement('div');
    usageEl.className = 'lib-item-usage';
    const uses = countSymbolUsages(id);
    usageEl.innerText = `${uses} uses`;
    usageEl.style.cssText = 'font-size:10px;color:#888;';
    info.appendChild(nameEl);
    info.appendChild(usageEl);

    item.appendChild(thumbWrap);
    item.appendChild(info);

    // Double click to enter isolation
    item.ondblclick = () => { enterIsolationMode(id); };

    // Drag to stage
    item.draggable = true;
    item.ondragstart = (e) => {
      e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'symbol_drag', symbolId: id }));
    };

    // Context menu for delete/rename
    item.oncontextmenu = (e) => {
      e.preventDefault();
      showContextMenu([
        { label: 'Rename', action: () => {
          const newName = item.querySelector('.lib-name-text');
          if (newName) {
            newName.contentEditable = 'true';
            newName.focus();
            const range = document.createRange();
            range.selectNodeContents(newName);
            window.getSelection().removeAllRanges();
            window.getSelection().addRange(range);
            newName.onblur = () => { sym.name = newName.innerText.trim() || sym.name; newName.contentEditable = 'false'; refreshLibrary(); dirtyCache(); fullRender(); };
            newName.onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); newName.blur(); } };
          }
        }},
        { label: 'Delete', action: () => {
          delete Symbols[id];
          refreshLibrary();
          dirtyCache(); fullRender();
        }},
      ], e.clientX, e.clientY);
    };

    list.appendChild(item);
  }
}

export function convertToSymbol() {
  if (S.selObjs.length < 1) return;
  saveSnapshot();
  
  // Custom prompt since Electron doesn't support native prompt()
  const defaultName = `Symbol ${Object.keys(Symbols).length + 1}`;
  
  const promptOverlay = document.createElement('div');
  promptOverlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:9999;';
  
  const promptBox = document.createElement('div');
  promptBox.style.cssText = 'background:#2c2c2c;padding:20px;border-radius:8px;border:1px solid #444;display:flex;flex-direction:column;gap:12px;min-width:320px;box-shadow:0 4px 15px rgba(0,0,0,0.3);';
  
  const title = document.createElement('div');
  title.innerText = 'Convert to Symbol';
  title.style.cssText = 'color:#fff;font-weight:bold;font-size:14px;';
  
  // Name row
  const nameLabel = document.createElement('div');
  nameLabel.innerText = 'Name:';
  nameLabel.style.cssText = 'color:#aaa;font-size:11px;';
  const input = document.createElement('input');
  input.type = 'text';
  input.value = defaultName;
  input.style.cssText = 'background:#1a1a1a;color:#fff;border:1px solid #444;padding:8px;border-radius:4px;outline:none;width:100%;box-sizing:border-box;';
  
  // Type row
  const typeRow = document.createElement('div');
  typeRow.style.cssText = 'display:flex;align-items:center;gap:8px;';
  const typeLabel = document.createElement('div');
  typeLabel.innerText = 'Type:';
  typeLabel.style.cssText = 'color:#aaa;font-size:11px;';
  const typeVal = document.createElement('div');
  typeVal.innerHTML = `<span style="margin-right: 4px; vertical-align: middle; width: 14px; height: 14px; display: inline-block;">${icons.symbol}</span> Graphic`;
  typeVal.style.cssText = 'color:#1aaeb0;font-size:12px;font-weight:bold;display:flex;align-items:center;';
  typeRow.appendChild(typeLabel);
  typeRow.appendChild(typeVal);
  
  // Registration point grid (3x3)
  let regPoint = 'center'; // default
  const regLabel = document.createElement('div');
  regLabel.innerText = 'Registration:';
  regLabel.style.cssText = 'color:#aaa;font-size:11px;';
  const regGrid = document.createElement('div');
  regGrid.style.cssText = 'display:grid;grid-template-columns:repeat(3,18px);grid-template-rows:repeat(3,18px);gap:2px;width:fit-content;';
  const positions = ['tl','tc','tr','ml','center','mr','bl','bc','br'];
  for (const pos of positions) {
    const cell = document.createElement('div');
    cell.style.cssText = `width:18px;height:18px;border:1px solid #555;border-radius:2px;cursor:pointer;display:flex;align-items:center;justify-content:center;background:${pos === 'center' ? '#1aaeb0' : '#1a1a1a'};transition:background 0.1s;`;
    cell.innerHTML = `<div style="width:6px;height:6px;border-radius:50%;background:${pos === 'center' ? '#000' : '#555'};"></div>`;
    cell.onclick = () => {
      regPoint = pos;
      regGrid.querySelectorAll('div').forEach((d: any) => {
        if (d.parentElement === regGrid) {
          d.style.background = '#1a1a1a';
          d.querySelector('div').style.background = '#555';
        }
      });
      cell.style.background = '#1aaeb0';
      cell.querySelector('div').style.background = '#000';
    };
    regGrid.appendChild(cell);
  }
  
  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;margin-top:6px;';
  
  const cancelBtn = document.createElement('button');
  cancelBtn.innerText = 'Cancel';
  cancelBtn.style.cssText = 'background:#444;color:#fff;border:none;padding:6px 15px;border-radius:4px;cursor:pointer;';
  
  const okBtn = document.createElement('button');
  okBtn.innerText = 'OK';
  okBtn.style.cssText = 'background:#1aaeb0;color:#000;border:none;padding:6px 15px;border-radius:4px;cursor:pointer;font-weight:bold;';
  
  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(okBtn);
  promptBox.appendChild(title);
  promptBox.appendChild(nameLabel);
  promptBox.appendChild(input);
  promptBox.appendChild(typeRow);
  promptBox.appendChild(regLabel);
  promptBox.appendChild(regGrid);
  promptBox.appendChild(btnRow);
  promptOverlay.appendChild(promptBox);
  document.body.appendChild(promptOverlay);
  
  input.focus();
  input.select();
  
  const closePrompt = () => { document.body.removeChild(promptOverlay); };
  
  const confirmPrompt = () => {
    const name = input.value.trim() || defaultName;
    closePrompt();
    finishConvertToSymbol(name, regPoint);
  };
  
  cancelBtn.onclick = closePrompt;
  okBtn.onclick = confirmPrompt;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') confirmPrompt();
    if (e.key === 'Escape') closePrompt();
  };
}

function finishConvertToSymbol(name: string, regPoint: string = 'center') {
  const symId = 'sym_' + Date.now();
  
  const layerMap = new Map();
  let firstLayerId = null;
  let minLayerIdx = Infinity;
  for (const ref of S.selObjs) {
    if (!layerMap.has(ref.layerId)) layerMap.set(ref.layerId, []);
    layerMap.get(ref.layerId).push(ref.idx);
    const lIdx = S.layers.findIndex(l => l.id === ref.layerId);
    if (lIdx < minLayerIdx) { minLayerIdx = lIdx; firstLayerId = ref.layerId; }
  }

  const children = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [lId, indices] of layerMap.entries()) {
    const sorted = [...indices].sort((a, b) => b - a);
    const objs = obs(S.frameIdx, lId);
    for (const i of sorted) {
      const o = objs[i];
      children.unshift(cloneObj(o));
      const b = getObjBounds(o);
      minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
      objs.splice(i, 1);
    }
  }

  // Calculate registration point based on selected position
  const bw = maxX - minX, bh = maxY - minY;
  let rx = minX + bw / 2, ry = minY + bh / 2; // default center
  if (regPoint.includes('l')) rx = minX;
  else if (regPoint.includes('r')) rx = maxX;
  if (regPoint.startsWith('t')) ry = minY;
  else if (regPoint.startsWith('b')) ry = maxY;

  for (const ch of children) {
    moveObjBy(ch, -rx, -ry);
  }

  Symbols[symId] = { id: symId, name: name, children: children, regPoint };

  const symInst = {
    type: 'symbol',
    symbolId: symId,
    x: rx,
    y: ry,
    sx: 1, sy: 1, rot: 0
  };

  obs(S.frameIdx, firstLayerId).push(symInst);
  S.selObjs = [{ layerId: firstLayerId, idx: obs(S.frameIdx, firstLayerId).length - 1 }];
  refreshLibrary();
  dirtyCache(); fullRender(); drawSelection();
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
  const typeLabels = { stroke: 'Stroke', line: 'Line', rect: 'Rectangle', circle: 'Oval', fill: 'Fill', fillPath: 'Fill', text: 'Text', group: 'Group', guide: 'Motion Guide' };
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
  if ($('obj-fill-opacity')) {
    ($('obj-fill-opacity') as HTMLInputElement).value = op.toString();
  }
  if ($('obj-fill-opacity-pct')) $('obj-fill-opacity-pct').textContent = Math.round(op * 100) + '%';
  
  if ($('obj-stroke-opacity')) {
    ($('obj-stroke-opacity') as HTMLInputElement).value = op.toString();
  }
  if ($('obj-stroke-opacity-pct')) $('obj-stroke-opacity-pct').textContent = Math.round(op * 100) + '%';
  
  // Sync opacity with Top bar and Properties Panel
  if ($('opacity')) $('opacity').value = Math.round(op * 100).toString();
  if ($('prop-opacity')) $('prop-opacity').value = Math.round(op * 100).toString();

  // Stroke size
  const sz = o.size !== undefined ? o.size : 0;
  if ($('obj-stroke-size')) $('obj-stroke-size').value = sz;
  
  // Sync size with Top bar and Properties Panel
  if ($('brush-size')) $('brush-size').value = sz.toString();
  if ($('brush-size-label')) $('brush-size-label').textContent = sz.toString();
  if ($('prop-size')) $('prop-size').value = sz.toString();
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
      title.textContent = 'Brush'; show('size'); show('opacity'); show('smoothness'); show('thinning'); show('spacing'); show('pressure'); show('auto-smooth'); show('pixel-snap'); break;
    case 'pencil':
      title.textContent = 'Pencil'; show('smoothness'); show('pixel-snap'); break;
    case 'eraser':
      title.textContent = 'Eraser'; show('size'); show('opacity'); show('pixel-snap'); break;
    case 'rect': case 'circle': case 'line':
      title.textContent = S.tool.charAt(0).toUpperCase() + S.tool.slice(1); show('size'); show('opacity'); show('pixel-snap'); break;
    case 'fill':
      title.textContent = 'Fill'; show('tolerance'); show('close-gaps'); break;
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
  S.rotateReadyCorner = null;
  S.rotateReadyMouse = null;
  if (canvas) {
    if (['select', 'camera', 'fill'].includes(t)) canvas.style.cursor = 'default';
    else canvas.style.cursor = 'crosshair';
  }
  updateToolProps();
  renderOverlay();
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
  else if (status === 'error') {
    usEl.textContent = '';
  }
});
ipcRenderer.on('update-progress', (e, pct) => {
  usEl.textContent = `Downloading... ${Math.round(pct)}%`;
});

// ==================== START SCREEN ====================
function renderRecentProjects() {
  const list = $('ss-recent-list');
  if (!list) return;
  list.innerHTML = '';
  try {
    const recents = JSON.parse(localStorage.getItem('recentProjects') || '[]');
    if (recents.length === 0) {
      list.innerHTML = '<div style="color:#888; font-size:12px; padding:10px;">No recent projects</div>';
      return;
    }
    recents.forEach((p: any) => {
      const item = document.createElement('div');
      item.className = 'ss-recent-item';
      item.innerHTML = `
        <div>
          <div class="ss-recent-name">${p.name}</div>
          <div class="ss-recent-path">${p.path}</div>
        </div>
        <div class="ss-recent-del" title="Remove from list" style="padding: 5px; cursor: pointer; color: #888; display: flex; align-items: center; justify-content: center;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </div>
      `;
      const delBtn = item.querySelector('.ss-recent-del');
      if (delBtn) {
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const updated = recents.filter((r: any) => r.path !== p.path);
          localStorage.setItem('recentProjects', JSON.stringify(updated));
          renderRecentProjects();
        });
        delBtn.addEventListener('mouseover', () => (delBtn as HTMLElement).style.color = '#ff5555');
        delBtn.addEventListener('mouseout', () => (delBtn as HTMLElement).style.color = '#888');
      }

      item.onclick = async () => {
        const success = await openProj(p.path);
        if (success) {
          const startScreen = $('start-screen');
          if (startScreen) startScreen.style.display = 'none';
        }
      };
      list.appendChild(item);
    });
  } catch(e) {}
}

function setupStartScreen() {
  const startScreen = $('start-screen');
  if (!startScreen) return;
  
  // Tabs
  const navBtns = document.querySelectorAll('.ss-nav-btn');
  const mainSec = document.querySelector('.ss-main > h1'); // "Create New" section indicator
  
  navBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      navBtns.forEach(b => b.classList.remove('active'));
      const target = e.currentTarget as HTMLElement;
      target.classList.add('active');
      const tab = target.dataset.tab;
      
      const customSec = document.querySelector('.ss-custom') as HTMLElement;
      const presetSec = document.querySelector('.ss-presets') as HTMLElement;
      const createTitle = document.querySelector('.ss-title') as HTMLElement;
      const recentSec = document.querySelector('.ss-recent-section') as HTMLElement;
      const settingsSec = document.querySelector('.ss-settings-section') as HTMLElement;
      
      if (tab === 'recent') {
        if(presetSec) presetSec.style.display = 'none';
        if(customSec) customSec.style.display = 'none';
        if(createTitle) createTitle.style.display = 'none';
        if(settingsSec) settingsSec.style.display = 'none';
        if(recentSec) recentSec.style.display = 'block';
        renderRecentProjects();
      } else if (tab === 'settings') {
        if(presetSec) presetSec.style.display = 'none';
        if(customSec) customSec.style.display = 'none';
        if(createTitle) createTitle.style.display = 'none';
        if(recentSec) recentSec.style.display = 'none';
        if(settingsSec) settingsSec.style.display = 'block';
      } else {
        if(presetSec) presetSec.style.display = 'grid';
        if(customSec) customSec.style.display = 'block';
        if(createTitle) createTitle.style.display = 'block';
        if(recentSec) recentSec.style.display = 'none';
        if(settingsSec) settingsSec.style.display = 'none';
      }
    });
  });

  const themeSelect = $('setting-timeline-theme') as HTMLSelectElement;
  if (themeSelect) {
    const currentTheme = localStorage.getItem('timelineTheme') || 'classic';
    themeSelect.value = currentTheme;
    document.body.classList.toggle('theme-adobe', currentTheme === 'adobe');
    document.body.classList.toggle('theme-classic', currentTheme === 'classic');
    
    themeSelect.addEventListener('change', () => {
      localStorage.setItem('timelineTheme', themeSelect.value);
      document.body.classList.toggle('theme-adobe', themeSelect.value === 'adobe');
      document.body.classList.toggle('theme-classic', themeSelect.value === 'classic');
    });
  }

  const autosaveSelect = $('setting-autosave') as HTMLSelectElement;
  if (autosaveSelect) {
    autosaveSelect.value = localStorage.getItem('autoSaveInterval') || '0';
    autosaveSelect.addEventListener('change', () => {
      localStorage.setItem('autoSaveInterval', autosaveSelect.value);
      setupAutoSave();
    });
  }

  const aiEnableCheckbox = $('setting-enable-ai') as HTMLInputElement;
  const aiGenerateBtn = $('ai-generate-btn');
  if (aiEnableCheckbox && aiGenerateBtn) {
    const isAiEnabled = localStorage.getItem('enableAiMenu') === 'true';
    aiEnableCheckbox.checked = isAiEnabled;
    aiGenerateBtn.style.display = isAiEnabled ? 'flex' : 'none';
    
    aiEnableCheckbox.addEventListener('change', () => {
      localStorage.setItem('enableAiMenu', aiEnableCheckbox.checked.toString());
      aiGenerateBtn.style.display = aiEnableCheckbox.checked ? 'flex' : 'none';
    });
  }

  renderKeybindingsUI();

  // Open button
  $('ss-open-btn').onclick = async () => {
    const success = await openProj();
    if (success) startScreen.style.display = 'none';
  };

  // Presets
  // Presets
  document.querySelectorAll('.ss-preset').forEach(el => {
    el.addEventListener('click', (e) => {
      document.querySelectorAll('.ss-preset').forEach(p => p.classList.remove('active'));
      const p = e.currentTarget as HTMLElement;
      p.classList.add('active');
      const w = parseInt(p.dataset.w || '1920');
      const h = parseInt(p.dataset.h || '1080');
      const fps = parseInt(p.dataset.fps || '24');
      
      if ($('ss-width')) ($('ss-width') as HTMLInputElement).value = w.toString();
      if ($('ss-height')) ($('ss-height') as HTMLInputElement).value = h.toString();
      if ($('ss-fps')) ($('ss-fps') as HTMLInputElement).value = fps.toString();
    });
  });

  // Custom Create
  $('ss-create-btn').onclick = () => {
    const w = parseInt(($('ss-width') as HTMLInputElement).value) || 1920;
    const h = parseInt(($('ss-height') as HTMLInputElement).value) || 1080;
    const fps = parseInt(($('ss-fps') as HTMLInputElement).value) || 24;
    
    S.w = w; S.h = h; S.fps = fps;
    if ($('canvas-width')) $('canvas-width').value = w.toString();
    if ($('canvas-height')) $('canvas-height').value = h.toString();
    if ($('fps-input')) $('fps-input').value = fps.toString();
    
    newProj(true);
    startScreen.style.display = 'none';
  };
}

// ==================== INIT ====================

let autoSaveTimer: any = null;
export function setupAutoSave() {
  if (autoSaveTimer) clearInterval(autoSaveTimer);
  const intervalStr = localStorage.getItem('autoSaveInterval') || '0';
  const minutes = parseInt(intervalStr);
  if (minutes > 0) {
    autoSaveTimer = setInterval(() => {
      if (currentProjectPath) {
        saveProj(false);
        showToast(`Auto-saved at ${new Date().toLocaleTimeString()}`);
      }
    }, minutes * 60 * 1000);
  }
}

export function renderKeybindingsUI() {
  const container = $('keybindings-list');
  if (!container) return;
  container.innerHTML = '';
  
  const labelMap: Record<string, string> = {
    'play_pause': 'Play / Pause', 'undo': 'Undo', 'redo': 'Redo',
    'brush': 'Brush Tool', 'pencil': 'Pencil Tool', 'eraser': 'Eraser Tool',
    'rect': 'Rectangle', 'circle': 'Circle', 'line': 'Line', 'fill': 'Fill Bucket',
    'select': 'Selection Tool', 'text': 'Text Tool', 'pen': 'Pen Tool', 'guide': 'Motion Guide',
    'convert_to_symbol': 'Convert to Symbol', 'group': 'Group', 'ungroup': 'Ungroup',
    'copy': 'Copy', 'paste': 'Paste', 'cut': 'Cut', 'duplicate': 'Duplicate',
    'create_tween': 'Create Classic Tween', 'import_image': 'Import Image',
    'zoom_in': 'Zoom In', 'zoom_out': 'Zoom Out', 'zoom_reset': 'Reset Zoom',
    'new_project': 'New Project', 'open_project': 'Open Project', 'save_project': 'Save', 'save_project_as': 'Save As'
  };

  for (const cmd of Object.keys(defaultKeybindings)) {
    const item = document.createElement('div');
    item.className = 'keybinding-item';
    
    const label = document.createElement('span');
    label.className = 'keybinding-label';
    label.innerText = labelMap[cmd] || cmd;
    
    const btn = document.createElement('button');
    btn.className = 'keycap-btn';
    btn.innerText = KeyMap[cmd];
    btn.dataset.cmd = cmd;
    
    btn.onclick = () => {
      document.querySelectorAll('.keycap-btn').forEach(b => b.classList.remove('listening'));
      btn.classList.add('listening');
      btn.innerText = 'Press key...';
      
      const onKeyDown = (e: KeyboardEvent) => {
        e.preventDefault();
        if (e.key === 'Escape') {
          btn.classList.remove('listening');
          btn.innerText = KeyMap[cmd];
          document.removeEventListener('keydown', onKeyDown);
          return;
        }
        
        let newShortcut = '';
        if (e.ctrlKey || e.metaKey) newShortcut += 'Ctrl+';
        if (e.shiftKey) newShortcut += 'Shift+';
        if (e.altKey) newShortcut += 'Alt+';
        
        const k = e.key;
        if (['Control', 'Shift', 'Alt', 'Meta'].includes(k)) return; // Wait for actual key
        
        if (k === ' ') newShortcut += ' ';
        else newShortcut += k.length === 1 ? k.toLowerCase() : k;
        
        KeyMap[cmd] = newShortcut;
        localStorage.setItem('keybindings', JSON.stringify(KeyMap));
        btn.innerText = newShortcut;
        btn.classList.remove('listening');
        document.removeEventListener('keydown', onKeyDown);
      };
      
      document.addEventListener('keydown', onKeyDown);
    };
    
    item.appendChild(label);
    item.appendChild(btn);
    container.appendChild(item);
  }
}

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
  let hasAutoSave = false;
  if (saved) {
    const s = saved;
    S.w = s.w; S.h = s.h; S.fps = s.fps; S.loop = s.loop;
    if (s.bgImgData) { const img = new Image(); img.onload = () => { S.bgImg = img; dirtyCache(); render(); }; img.src = s.bgImgData; S.bgImgData = s.bgImgData; if ($('pan-bgimg-row')) $('pan-bgimg-row').style.display = 'flex'; }
    if ($('canvas-width')) $('canvas-width').value = s.w.toString();
    if ($('canvas-height')) $('canvas-height').value = s.h.toString();
    if ($('canvas-bg-color')) $('canvas-bg-color').value = S.bgColor;
    if ($('fps-input')) $('fps-input').value = s.fps.toString();
    if ($('loop-toggle')) ($('loop-toggle') as HTMLInputElement).checked = s.loop;
    hasAutoSave = true;
  }
  
  setupStartScreen();
  if (hasAutoSave && $('ss-resume-btn')) {
    $('ss-resume-btn').style.display = 'block';
    $('ss-resume-btn').onclick = () => {
      $('start-screen').style.display = 'none';
    };
  }
  
  fullRender();
  setupEvents();
  saveSnapshot();
  // Auto-save every 30 seconds
  setInterval(autoSave, 30000);
  setupAutoSave();

  // Hide loading screen
  setTimeout(() => {
    const loading = $('app-loading');
    if (loading) {
      loading.style.opacity = '0';
      loading.style.transition = 'opacity 0.3s ease';
      setTimeout(() => loading.remove(), 300);
    }
  }, 300);
}
try { init(); } catch (e) { console.error('Init error:', e); alert('Init error: ' + e.message + '\n' + e.stack); }
hr();

ipcRenderer.on('request-close', async () => {
  // If we are on the start screen, do not prompt for saving
  const startScreen = $('start-screen');
  if (startScreen && startScreen.style.display !== 'none') {
    ipcRenderer.invoke('quit-app');
    return;
  }

  // Check if project is essentially empty
  let empty = false;
  if (S.frames.length <= 1) {
    const f = S.frames[0];
    if (!f || !f.o) empty = true;
    else if (Object.keys(f.o).length === 0) empty = true;
    else if (Object.values(f.o).every(arr => (arr as any[]).length === 0)) empty = true;
  }
  
  if (empty) {
    ipcRenderer.invoke('quit-app');
    return;
  }
  
  const res = await ipcRenderer.invoke('show-save-prompt');
  // 0: Save, 1: Don't Save, 2: Cancel
  if (res === 0) {
    const success = await saveProj();
    if (success) ipcRenderer.invoke('quit-app');
  } else if (res === 1) {
    ipcRenderer.invoke('quit-app');
  }
});

// ==================== AI GENERATOR (BETA) ====================
const aiGenerateBtn = $('ai-generate-btn');
const aiModal = $('ai-modal');
const aiClose = $('ai-close');
const aiCancel = $('ai-cancel');
const aiStartBtn = $('ai-start-btn');
const aiPrompt = $('ai-prompt') as HTMLTextAreaElement;
const aiApiKey = $('ai-api-key') as HTMLInputElement;
const aiModel = $('ai-model') as HTMLSelectElement;
const aiFrameCount = $('ai-frame-count') as HTMLSelectElement;
const aiKeyframeCount = $('ai-keyframe-count') as HTMLSelectElement;
const aiHumanizeLevel = $('ai-humanize-level') as HTMLSelectElement;
const aiAutoTween = $('ai-auto-tween') as HTMLInputElement;
const settingAiHumanize = $('setting-ai-humanize') as HTMLSelectElement;

if (settingAiHumanize) {
  settingAiHumanize.value = localStorage.getItem('aiHumanizeLevel') || '2';
  S.aiHumanizeLevel = settingAiHumanize.value;
  settingAiHumanize.addEventListener('change', () => {
    localStorage.setItem('aiHumanizeLevel', settingAiHumanize.value);
    S.aiHumanizeLevel = settingAiHumanize.value;
    dirtyCache();
    fullRender();
  });
}

if (aiGenerateBtn && aiModal) {
  aiGenerateBtn.addEventListener('click', () => {
    document.body.style.pointerEvents = 'auto';
    if (aiModal) aiModal.style.pointerEvents = 'auto';
    const progressOverlay = $('ai-progress-overlay');
    if (progressOverlay) progressOverlay.style.display = 'none';
    
    if (aiHumanizeLevel) aiHumanizeLevel.value = S.aiHumanizeLevel || '2';
    if (aiApiKey) aiApiKey.value = localStorage.getItem('geminiApiKey') || '';
    if (aiModel) aiModel.value = localStorage.getItem('geminiModel') || 'gemini-3.5-flash';
    if (aiFrameCount) aiFrameCount.value = localStorage.getItem('geminiFrameCount') || '12';
    if (aiKeyframeCount) aiKeyframeCount.value = localStorage.getItem('geminiKeyframeCount') || '3';
    if (aiAutoTween) aiAutoTween.checked = localStorage.getItem('geminiAutoTween') !== 'false';
    aiModal.classList.remove('hidden');
    setTimeout(() => { if (aiPrompt) aiPrompt.focus(); }, 100);
  });
  
  const closeAiModal = () => aiModal.classList.add('hidden');
  if (aiClose) aiClose.addEventListener('click', closeAiModal);
  if (aiCancel) aiCancel.addEventListener('click', closeAiModal);
  
  if (aiStartBtn) aiStartBtn.addEventListener('click', async () => {
    const prompt = aiPrompt.value.trim();
    if (!prompt) {
      alert('Please enter a prompt for the AI to generate.');
      return;
    }
    
    if (!aiApiKey || !aiApiKey.value.trim()) {
      alert('Please enter your Gemini API Key. You can get one for free from Google AI Studio.');
      return;
    }
    
    // Set humanize level and Gemini settings globally from modal
    if (aiHumanizeLevel) {
      S.aiHumanizeLevel = aiHumanizeLevel.value;
      if (settingAiHumanize) settingAiHumanize.value = aiHumanizeLevel.value;
      localStorage.setItem('aiHumanizeLevel', aiHumanizeLevel.value);
    }
    localStorage.setItem('geminiApiKey', aiApiKey.value.trim());
    if (aiModel) localStorage.setItem('geminiModel', aiModel.value);
    
    let frameCount = 12;
    if (aiFrameCount) {
      localStorage.setItem('geminiFrameCount', aiFrameCount.value);
      frameCount = parseInt(aiFrameCount.value) || 12;
    }
    
    let keyframeCount = 3;
    if (aiKeyframeCount) {
      localStorage.setItem('geminiKeyframeCount', aiKeyframeCount.value);
      keyframeCount = parseInt(aiKeyframeCount.value) || 3;
    }
    
    let autoTween = true;
    if (aiAutoTween) {
      localStorage.setItem('geminiAutoTween', aiAutoTween.checked.toString());
      autoTween = aiAutoTween.checked;
    }
    
    aiStartBtn.disabled = true;
    closeAiModal();
    const overlay = $('ai-progress-overlay');
    const fill = $('ai-progress-fill');
    const text = $('ai-progress-text');
    let progress = 0;
    let progressInterval: any = null;
    const abortController = new AbortController();
    
    const cancelBtn = $('ai-progress-cancel');
    const onCancel = () => {
      abortController.abort();
      if (cancelBtn) cancelBtn.removeEventListener('click', onCancel);
    };
    if (cancelBtn) cancelBtn.addEventListener('click', onCancel);

    if (overlay && fill && text) {
      overlay.style.display = 'flex';
      fill.style.width = '0%';
      text.innerText = '0%';
      progressInterval = setInterval(() => {
        progress += (90 - progress) * 0.05; // ease towards 90%
        fill.style.width = `${progress}%`;
        text.innerText = `${Math.round(progress)}%`;
      }, 100);
    }
    
    const aiModeAnimate = $('ai-mode-animate') as HTMLInputElement;
    const isAnimateMode = aiModeAnimate && aiModeAnimate.checked;

    let baseFrameJSON = undefined;
    let rawBaseFrameObj = undefined;
    if (isAnimateMode && S.frames[S.frameIdx]) {
      const baseObjs = [];
      const fObj = S.frames[S.frameIdx].o;
      rawBaseFrameObj = fObj;
      for (const lid in fObj) {
        for (const obj of fObj[lid]) {
          if (!['circle', 'line', 'rect', 'pen', 'stroke', 'fillPath', 'fill'].includes(obj.type)) continue;
          
          let type = obj.type;
          let filled = false;
          if (type === 'stroke') { type = 'pen'; filled = false; }
          else if (type === 'fillPath' || type === 'fill') { type = 'pen'; filled = true; }
          
          obj.uid = obj.uid || `ai_base_${Math.random()}`; // Give it a UID immediately

          // Calculate bounding box and center for the AI
          const b = getObjBounds(obj);
          const cx = b.x + b.w / 2;
          const cy = b.y + b.h / 2;

          const aiObj: any = {
            id: obj.uid,
            type,
            cx: Math.round(cx),
            cy: Math.round(cy),
            w: Math.round(b.w),
            h: Math.round(b.h),
            color: obj.color || '#000000'
          };
          if (type === 'pen' && obj.pts) {
             const simplified = simplifyPath(obj.pts, 2.0);
             aiObj.pts = simplified.map((p: any) => ({x: Math.round(p.x), y: Math.round(p.y)}));
          } else if (type === 'circle') {
            const r = Math.abs(obj.x2 - obj.x1) / 2;
            aiObj.r = Math.round(r);
          } else if (obj.x1 !== undefined) {
            aiObj.x1 = Math.round(obj.x1); aiObj.y1 = Math.round(obj.y1);
            aiObj.x2 = Math.round(obj.x2); aiObj.y2 = Math.round(obj.y2);
          }
          baseObjs.push(aiObj);
        }
      }
      if (baseObjs.length > 0) baseFrameJSON = JSON.stringify(baseObjs);
    }

    try {
      await generateProceduralAnimation(prompt, frameCount, abortController.signal, autoTween, keyframeCount, baseFrameJSON, rawBaseFrameObj);
      if (fill && text) {
        fill.style.width = '100%';
        text.innerText = '100%';
      }
      setTimeout(() => {
        if (overlay) overlay.style.display = 'none';
        showToast('✅ AI Generation Complete!');
      }, 500);
      
      updateTL();
      dirtyCache();
      fullRender();
    } catch (e: any) {
      if (overlay) overlay.style.display = 'none';
      if (progressInterval) clearInterval(progressInterval);
      if (e.name === 'AbortError') {
        showToast('🛑 AI Generation Cancelled');
      } else {
        console.error(e);
        setTimeout(() => {
          document.body.style.pointerEvents = 'auto';
          alert('AI Generation failed: ' + e.message);
        }, 50);
      }
    } finally {
      aiStartBtn.disabled = false;
      document.body.style.pointerEvents = 'auto';
      if (aiModal) aiModal.style.pointerEvents = 'auto';
      if (progressInterval) clearInterval(progressInterval);
      const progressOverlay = $('ai-progress-overlay');
      if (progressOverlay) progressOverlay.style.display = 'none';
    }
  });
}

// Real Gemini AI Generator
async function generateProceduralAnimation(prompt: string, frameCount: number = 12, signal?: AbortSignal, autoTween: boolean = true, aiKeyframeCount: number = 3, baseFrameJSON?: string, rawBaseFrameObj?: any) {
  const apiKey = localStorage.getItem('geminiApiKey');
  const model = localStorage.getItem('geminiModel') || 'gemini-3.5-flash';
  if (!apiKey) throw new Error('Gemini API Key is missing.');

  const canvasWidth = S.w || 800;
  const canvasHeight = S.h || 600;

  let systemInstruction = `You are a professional generative vector animation AI.
Task: Generate exactly ${aiKeyframeCount} KEYFRAMES of vector shapes for: "${prompt}".
Canvas: ${canvasWidth}x${canvasHeight}.
OUTPUT ONLY RAW JSON. NO MARKDOWN. NO BACKTICKS. NO CONVERSATION.
Format: JSON Array of exactly ${aiKeyframeCount} arrays. (Each sub-array is a KEYFRAME in chronological order). The application will automatically interpolate the missing frames.
Shape schema: {"id": "string", "type": "circle"|"line"|"rect"|"pen", "x1": num, "y1": num, "x2": num, "y2": num, "r": num, "pts": [{"x":num,"y":num}], "color": "#hex", "filled": boolean, "size": num}
COORDINATE RULES:
- "size" is ALWAYS stroke thickness (usually 2-5). It is NEVER the radius!
- For lines: x1,y1 is start, x2,y2 is end.
- For rects: x1,y1 is top-left, x2,y2 is bottom-right.
- For circles: x1,y1 is the CENTER point, and "r" is the RADIUS. (Leave x2, y2 empty).
- For pen (complex shapes): provide an array of points in "pts" (e.g. [{"x":10,"y":20}, {"x":30,"y":40}]). Set "filled": true for solid objects (like a car body), or false for just outlines! Use this for complex, non-simple characters!
OPTIMIZATION RULES:
1. Tracking: Assign a unique "id" (e.g., "head", "left_leg", "sword") to EVERY shape and keep it consistent across ALL ${aiKeyframeCount} KEYFRAMES. This is CRITICAL for the tweening engine to interpolate them!
2. Complexity: Since you only generate ${aiKeyframeCount} frames, use your token budget to create highly detailed, complex characters (dragons, cars, detailed people) using the "pen" tool with many points! Max 25 shapes per frame.
3. Consistency: Background objects/obstacles MUST have the EXACT same coordinates in every frame to prevent jitter.
4. Anatomy: Keep body parts strictly connected!
5. Animation: Focus on extreme poses for the keyframes (Start Pose -> Anticipation/Action Pose -> Final Pose).
6. Bounds: NO coordinate outside 0-${canvasWidth} or 0-${canvasHeight}. Round to integers.`;

  if (baseFrameJSON) {
    systemInstruction = `You are a professional 2D animation AI doing "Rigging-Free Transform Animation".
Task: Animate the user's base frame to do: "${prompt}".
OUTPUT ONLY RAW JSON. NO MARKDOWN. NO BACKTICKS.
Format: JSON Array of exactly ${aiKeyframeCount} arrays.
USER'S BASE FRAME OBJECTS (JSON):
${baseFrameJSON}
CRITICAL RULES:
1. You must ONLY output transformations ("tx", "ty", "angle", "scaleX", "scaleY") for the EXACT same "id"s provided in the base frame.
2. Analyze the provided "pts" or coordinates in the base frame to understand the anatomy (e.g., figure out which ID is the left arm, right leg, head, etc., based on their relative positions and shapes).
3. DO NOT output "pts", "x1", "y1" or any absolute coordinates! Output Schema: {"id": "string", "tx": num, "ty": num, "angle": num, "scaleX": num, "scaleY": num}. (tx/ty are translation offsets from their original position. angle is rotation in degrees).
4. Frame 1 should be the start pose (usually near tx:0, ty:0, angle:0), and Frame ${aiKeyframeCount} should be the final pose.`;
  }

  let requestBody: any = {
    contents: [{ parts: [{ text: prompt }] }],
    systemInstruction: { parts: [{ text: systemInstruction }] },
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json"
    }
  };

  let response;
  let lastErr = null;
  const versions = ['v1beta', 'v1alpha', 'v1'];
  
  for (let i = 0; i < versions.length; i++) {
    const v = versions[i];
    try {
      response = await fetch(`https://generativelanguage.googleapis.com/${v}/models/${model}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal
      });
      
      if (response.ok) break;
      
      const err = await response.json().catch(() => ({}));
      lastErr = new Error(err.error?.message || 'API request failed with status ' + response.status);
      
      // If it's an API key error, don't try other versions
      if (response.status === 400 && lastErr.message.toLowerCase().includes('api key')) {
        break;
      }
      
      // If the API complains about the new schema (systemInstruction or responseMimeType), downgrade and retry
      if (lastErr.message.includes('systemInstruction') || lastErr.message.includes('responseMimeType') || lastErr.message.includes('generation_config')) {
        if (requestBody.systemInstruction) {
          console.warn(`API ${v} rejected modern schema. Downgrading to legacy prompt format...`);
          requestBody = {
            contents: [{ parts: [{ text: `SYSTEM INSTRUCTION:\n${systemInstruction}\n\nUSER PROMPT:\n${prompt}\n\nIMPORTANT: YOU MUST RETURN ONLY VALID RAW JSON. NO MARKDOWN.` }] }],
            generationConfig: { temperature: 0.2 }
          };
          i--; // Retry the same version with the new payload
          continue;
        }
      }
      
      // For any other error (including 404), keep trying the next version just in case
      continue;
    } catch (e: any) {
      if (e.name === 'AbortError') throw e;
      lastErr = e;
    }
  }

  if (!response || !response.ok) {
    throw lastErr || new Error('API request failed');
  }

  const data = await response.json();
  let jsonText = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!jsonText) throw new Error('No content returned from AI.');

  // Clean up potential markdown formatting and conversational text safely using regex
  const jsonMatch = jsonText.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    jsonText = jsonMatch[0];
  } else {
    jsonText = jsonText.replace(/```json/gi, '').replace(/```/g, '').trim();
  }

  let frames;
  try {
    frames = JSON.parse(jsonText);
  } catch (e) {
    console.error("Failed JSON:", jsonText);
    throw new Error('AI returned invalid JSON formatting. See console.');
  }

  if (!Array.isArray(frames)) throw new Error('AI output is not an array of frames.');
  
  if (frames.length > 0 && !Array.isArray(frames[0])) {
    frames = [frames];
  }

  const numAiFrames = Math.min(frames.length, aiKeyframeCount);
  let targetTotalFrames = frameCount;
  if (baseFrameJSON) targetTotalFrames = S.frameIdx + frameCount;

  // Ensure timeline has enough frames
  while (S.frames.length < targetTotalFrames) {
    S.frames.push({ o: {}, key: false, _hist: [], _histIdx: -1 });
  }

  // Calculate target indices for the keyframes
  const indices = [];
  if (baseFrameJSON) {
    const startIdx = S.frameIdx + 1;
    const availableFrames = targetTotalFrames - startIdx;
    if (numAiFrames === 1) {
      indices.push(Math.min(targetTotalFrames - 1, startIdx + Math.floor(availableFrames / 2)));
    } else {
      for (let i = 0; i < numAiFrames; i++) {
        indices.push(startIdx + Math.floor((i / (numAiFrames - 1)) * (availableFrames - 1)));
      }
    }
  } else {
    if (numAiFrames === 1) {
      indices.push(0);
    } else {
      for (let i = 0; i < numAiFrames; i++) {
        indices.push(Math.floor((i / (numAiFrames - 1)) * (targetTotalFrames - 1)));
      }
    }
  }

  let flatRawBaseFrameObjs: any[] = [];
  if (rawBaseFrameObj) {
    for (const lid in rawBaseFrameObj) {
      for (const obj of rawBaseFrameObj[lid]) {
        flatRawBaseFrameObjs.push(obj);
      }
    }
  }

  for (let i = 0; i < numAiFrames; i++) {
    const objs = frames[i];
    if (!Array.isArray(objs)) continue;
    
    const targetIdx = indices[i];
    
    // Ensure the timeline has this frame
    S.frames[targetIdx].key = true;
    if (!S.frames[targetIdx].o) S.frames[targetIdx].o = {};
    
    // Process and validate objects
    const validObjs = [];
    for (const raw of objs) {
      if (rawBaseFrameObj) {
        const baseObj = flatRawBaseFrameObjs.find(o => o.uid === raw.id);
        if (baseObj) {
          const newObj = JSON.parse(JSON.stringify(baseObj));
          newObj.x = (newObj.x || 0) + (Number(raw.tx) || 0);
          newObj.y = (newObj.y || 0) + (Number(raw.ty) || 0);
          newObj.angle = (newObj.angle || 0) + (Number(raw.angle) || 0);
          if (raw.scaleX !== undefined) newObj.scaleX = (newObj.scaleX || 1) * Number(raw.scaleX);
          if (raw.scaleY !== undefined) newObj.scaleY = (newObj.scaleY || 1) * Number(raw.scaleY);
          validObjs.push(newObj);
        }
        continue;
      }
      
      if (!raw || !['circle', 'line', 'rect', 'pen'].includes(raw.type)) continue;
      
      let pts = [];
      if (raw.type === 'pen' && Array.isArray(raw.pts)) {
         pts = raw.pts.map(p => ({ x: Number(p.x) || 0, y: Number(p.y) || 0 }));
      }
      
      let finalX1 = Number(raw.x1) || 0;
      let finalY1 = Number(raw.y1) || 0;
      let finalX2 = Number(raw.x2) || 0;
      let finalY2 = Number(raw.y2) || 0;
      
      // If AI provided center and radius for a circle, convert to bounding box
      const r = Number(raw.r) || Number(raw.radius) || 0;
      if (raw.type === 'circle' && r > 0) {
        finalX1 = (Number(raw.x1) || 0) - r;
        finalY1 = (Number(raw.y1) || 0) - r;
        finalX2 = (Number(raw.x1) || 0) + r;
        finalY2 = (Number(raw.y1) || 0) + r;
      } else if (raw.type === 'circle' && finalX1 === finalX2) {
        // Fallback: AI used 'size' as radius instead of 'r'
        const fallbackR = Number(raw.size) || 10;
        finalX1 = (Number(raw.x1) || 0) - fallbackR;
        finalY1 = (Number(raw.y1) || 0) - fallbackR;
        finalX2 = (Number(raw.x1) || 0) + fallbackR;
        finalY2 = (Number(raw.y1) || 0) + fallbackR;
      }
      
      validObjs.push({
        uid: raw.id ? String(raw.id) : `ai_auto_${Math.random()}`, // Map semantic ID to UID for Tween engine
        type: raw.type === 'pen' ? (raw.filled ? 'fillPath' : 'stroke') : raw.type,
        x1: finalX1,
        y1: finalY1,
        x2: finalX2,
        y2: finalY2,
        pts: pts.length > 0 ? pts : undefined,
        color: raw.color || '#000000',
        size: Number(raw.size) || 3,
        fillColor: raw.fillColor !== undefined ? raw.fillColor : null,
        opacity: 1,
        key: true
      });
    }

    // Insert AI shapes to current layer
    const lid = S.layers[S.layerIdx].id;
    if (!S.frames[targetIdx].o[lid]) S.frames[targetIdx].o[lid] = [];
    S.frames[targetIdx].o[lid].push(...validObjs);
  }
  
  // Auto-trigger Tweening or implement Stop Motion (Hold interpolation)
  if (numAiFrames >= 2) {
    if (autoTween) {
      rebuildTweens();
    } else {
      // Hold previous keyframe for empty frames
      for (let i = 0; i < targetTotalFrames; i++) {
        if (!S.frames[i].key) {
           let prevKey = 0;
           for(let j = i; j >= 0; j--) { if (S.frames[j].key) { prevKey = j; break; } }
           S.frames[i].o[lid] = cloneObjDeep(S.frames[prevKey].o[lid] || []);
        }
      }
    }
  }
  
  S.tlDirty = true;
  fullRender();
  S.frameIdx = 0; // Rewind to start to preview
}
