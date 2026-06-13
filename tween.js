const fs = require('fs');
let code = fs.readFileSync('src/renderer.ts', 'utf8');

// 1. Add UID to all pushes
code = code.replace(/obs\(S\.frameIdx, l\.id\)\.push\(\{/g, 'obs(S.frameIdx, l.id).push({ uid: Math.random().toString(36).substr(2, 9),');

// Wait, what about group push?
code = code.replace(/objs\.push\(\{ type: 'group',/g, 'objs.push({ uid: Math.random().toString(36).substr(2, 9), type: \'group\',');

// 2. cloneObj
code = code.replace(/function cloneObj\(o\) \{/, 'function cloneObj(o, keepUid = false) {');
code = code.replace(/for \(const k of Object\.keys\(o\)\) \{/, 'for (const k of Object.keys(o)) {\n    if (k === \'uid\') continue;');
code = code.replace(/return c;\n\}/, '  c.uid = keepUid && o.uid ? o.uid : Math.random().toString(36).substr(2, 9);\n  return c;\n}');

// 3. dupFrame
code = code.replace(/nf\.o\[lid\] = src\.o\[lid\] \? src\.o\[lid\]\.map\(cloneObj\) : \[\];/g, 'nf.o[lid] = src.o[lid] ? src.o[lid].map(o => cloneObj(o, true)) : [];');

// 4. rebuildTweens
let innerLoop = `for (let oi = 0; oi < fObs.length; oi++) {
        const fo = fObs[oi];
        const to = tObs.find(o => fo.uid && o.uid === fo.uid) || tObs[oi];
        if (fo && to && fo.type === to.type) {
          if (fo.type === 'fill') {
            const c = document.createElement('canvas');
            c.width = fo.fc.width; c.height = fo.fc.height;
            const cx = c.getContext('2d');
            cx.globalAlpha = 1 - t; cx.drawImage(fo.fc, 0, 0);
            cx.globalAlpha = t; cx.drawImage(to.fc, 0, 0);
            out.push({ uid: fo.uid, type: 'fill', fc: c, x: fo.x || 0, y: fo.y || 0, opacity: fo.opacity + (to.opacity - fo.opacity) * t });
          } else {
            const io = interpObj(fo, to, t);
            io.uid = fo.uid;
            out.push(io);
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
      }`;

code = code.replace(/const mx = Math\.max\(fObs\.length, tObs\.length\);[\s\S]*?if \(!fr\.o\[lid\]\) fr\.o\[lid\] = \[\];/, innerLoop + '\n      if (!fr.o[lid]) fr.o[lid] = [];');

fs.writeFileSync('src/renderer.ts', code);
console.log('Done');
