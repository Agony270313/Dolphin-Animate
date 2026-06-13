const fs = require('fs');
let code = fs.readFileSync('src/renderer.ts', 'utf8');

// 1. startDraw
code = code.replace(/function startDraw\(e\) \{/, `function startDraw(e) {
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
  }`);

// 2. draw
code = code.replace(/function draw\(e\) \{/, `function draw(e) {
  if (!S.drawing) return;
  if (S.tool === 'camera') {
    const f = S.frames[S.frameIdx];
    const dx = (S.lx - e.clientX) / S.zoom / f.cam.zoom;
    const dy = (S.ly - e.clientY) / S.zoom / f.cam.zoom;
    f.cam.x = S._camStartX + (dx * Math.cos(-f.cam.rotation * Math.PI/180) - dy * Math.sin(-f.cam.rotation * Math.PI/180));
    f.cam.y = S._camStartY + (dx * Math.sin(-f.cam.rotation * Math.PI/180) + dy * Math.cos(-f.cam.rotation * Math.PI/180));
    S.tlDirty = true;
    renderThrottled();
    return;
  }`);

// 3. endDraw
code = code.replace(/function endDraw\(e\) \{/, `function endDraw(e) {
  if (!S.drawing) return;
  if (S.tool === 'camera') {
    S.drawing = false;
    saveSnapshot();
    return;
  }`);

// 4. Update wheel event
let wheelStr = `$('canvas-area').addEventListener('wheel', e => {
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
    if (e.ctrlKey) {`;

code = code.replace(/\$\('canvas-area'\)\.addEventListener\('wheel', e => \{\n\s*e\.preventDefault\(\);\n\s*if \(e\.ctrlKey\) \{/, wheelStr);

// 5. Update renderOverlay
let overlayStr = `function renderOverlay() {
  const pw = overlay.width, ph = overlay.height;
  octx.clearRect(0, 0, pw, ph);

  if (S.tool === 'camera') {
    const f = S.frames[S.frameIdx];
    if (f && f.cam) {
      octx.save();
      const bs = bufScale();
      if (bs !== 1) octx.scale(bs, bs);
      const cx = S.w / 2, cy = S.h / 2;
      
      // We want to fill the entire visible workspace bounds, not just the canvas
      octx.fillStyle = 'rgba(0,0,0,0.5)';
      octx.fillRect(-10000, -10000, 20000, 20000); 

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

  if (!S.curStroke) return;`;

code = code.replace(/function renderOverlay\(\) \{[\s\S]*?if \(!S\.curStroke\) return;/, overlayStr);

fs.writeFileSync('src/renderer.ts', code);
