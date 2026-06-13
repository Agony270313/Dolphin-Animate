const fs = require('fs');
let code = fs.readFileSync('src/renderer.ts', 'utf8');

let domRegex = /const \$ = id => document\.getElementById\(id\);[\s\S]*?octx\.imageSmoothingQuality = 'high';/;
code = code.replace(domRegex, "import { $, canvas, overlay, ctx, octx } from './core/DOM';");

let stateRegex = /let S = \{[\s\S]*?autoSmooth: false, pixelSnap: false,\n\};/;
code = code.replace(stateRegex, "import { S, Globals } from './core/State';\nimport { initAudioUI, renderAudioTimeline, playAudioAtFrame, pauseAudio, loopAudioPlay } from './timeline/AudioLayer';");

let updateTlRegex = /function updateTL\(\) \{[\s\S]*?tlContainer\.scrollLeft = Math\.max\(0, targetScroll\);\s*\}/;
code = code.replace(updateTlRegex, match => {
    return match + '\n  renderAudioTimeline(typeof tlZoom !== "undefined" ? tlZoom : 1, S.fps);';
});

let playStr = `function play() {
  S.playing = !S.playing;
  const tlBtn = $('tl-play-btn');
  if (tlBtn) tlBtn.innerHTML = S.playing ? icons.pause : icons.play;
  if (S.playing) {
    playAudioAtFrame(S.frameIdx, S.fps);
    _pi = setInterval(() => {
      if (S.frameIdx < S.frames.length - 1) S.frameIdx++;
      else if (S.loop) {
          S.frameIdx = 0;
          loopAudioPlay();
      }
      else { play(); return; }
      updateTL(); fullRender();
    }, 1000 / S.fps);
  } else { clearInterval(_pi); _pi = null; pauseAudio(); }
}`;
code = code.replace(/function play\(\) \{[\s\S]*?_pi = null; \}/, playStr);

code = code.replace(/function setupEvents\(\) \{/, 'function setupEvents() {\n  initAudioUI(updateTL);');

fs.writeFileSync('src/renderer.ts', code);
