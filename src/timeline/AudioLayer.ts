import { $ } from '../core/DOM';
import { S, Globals } from '../core/State';

// Icons 
const audioIcon = `<svg xmlns="http://www.svg.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:100%;height:100%"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`;
const trashIcon = `<svg xmlns="http://www.svg.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:100%;height:100%"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;

let audioBuffer: AudioBuffer | null = null;
let waveCanvas: HTMLCanvasElement | null = null;

export function initAudioUI(updateTL: () => void) {
    const btn = $('tl-add-audio');
    if (btn) {
        btn.innerHTML = audioIcon;
        btn.onclick = () => $('audio-input').click();
    }
    const removeBtn = $('tl-remove-audio');
    if (removeBtn) {
        removeBtn.innerHTML = trashIcon;
        removeBtn.onclick = () => {
            if (Globals.bgAudio) {
                Globals.bgAudio.pause();
                Globals.bgAudio = null;
            }
            Globals.bgAudioData = null;
            audioBuffer = null;
            $('tl-audio-label').style.display = 'none';
            $('tl-audio-row').style.display = 'none';
            updateTL();
        };
    }
    const iconSpan = $('tl-audio-icon-span');
    if (iconSpan) iconSpan.innerHTML = audioIcon;

    if ($('audio-input')) {
        $('audio-input').onchange = async (e: any) => {
            const file = e.target.files[0];
            if (file) {
                if (Globals.bgAudio) { Globals.bgAudio.pause(); Globals.bgAudio = null; }
                const url = URL.createObjectURL(file);
                Globals.bgAudio = new Audio(url);
                Globals.bgAudioOffset = S.frameIdx; 
                $('tl-audio-name').textContent = file.name;
                $('tl-audio-label').style.display = 'flex';
                $('tl-audio-row').style.display = 'block';
                updateTL();
                
                // Read duration metadata
                Globals.bgAudio.onloadedmetadata = () => {
                    updateTL();
                };

                // Decode for waveform
                const ctx = new window.AudioContext();
                const arrayBuffer = await file.arrayBuffer();
                
                // Store base64 for export
                const uint8 = new Uint8Array(arrayBuffer);
                let binary = '';
                for (let i = 0; i < uint8.byteLength; i++) {
                    binary += String.fromCharCode(uint8[i]);
                }
                Globals.bgAudioData = window.btoa(binary);

                audioBuffer = await ctx.decodeAudioData(arrayBuffer);
                drawWaveform();
            }
        };
    }

    // Dragging logic for the clip
    const clip = $('tl-audio-clip');
    if (clip) {
        clip.onmousedown = (e) => {
            e.stopPropagation();
            const startX = e.clientX;
            const startOff = Globals.bgAudioOffset;
            const cellW = 20 * (typeof tlZoom !== 'undefined' ? tlZoom : 1);
            
            const move = (me: MouseEvent) => {
                const dx = me.clientX - startX;
                const frameDx = Math.round(dx / cellW);
                Globals.bgAudioOffset = startOff + frameDx;
                updateTL();
            };
            const up = () => { 
                document.removeEventListener('mousemove', move); 
                document.removeEventListener('mouseup', up); 
            };
            document.addEventListener('mousemove', move);
            document.addEventListener('mouseup', up);
        };
    }
}

function drawWaveform() {
    if (!audioBuffer) return;
    const clip = $('tl-audio-clip');
    if (!clip) return;
    
    if (!waveCanvas) {
        waveCanvas = document.createElement('canvas');
        waveCanvas.style.position = 'absolute';
        waveCanvas.style.left = '0';
        waveCanvas.style.top = '0';
        waveCanvas.style.width = '100%';
        waveCanvas.style.height = '100%';
        waveCanvas.style.pointerEvents = 'none';
        waveCanvas.style.opacity = '0.5';
        clip.appendChild(waveCanvas);
    }
    
    const width = clip.clientWidth;
    const height = clip.clientHeight;
    
    // Avoid drawing if dimensions are zero
    if (width === 0 || height === 0) return;

    waveCanvas.width = width;
    waveCanvas.height = height;
    
    const ctx = waveCanvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    
    const data = audioBuffer.getChannelData(0);
    const step = Math.ceil(data.length / width);
    const amp = height / 2;
    
    ctx.fillStyle = '#1aaeb0';
    for (let i = 0; i < width; i++) {
        let min = 1.0;
        let max = -1.0;
        for (let j = 0; j < step; j++) {
            const datum = data[(i * step) + j];
            if (datum < min) min = datum;
            if (datum > max) max = datum;
        }
        ctx.fillRect(i, (1 + min) * amp, 1, Math.max(1, (max - min) * amp));
    }
}

export function renderAudioTimeline(tlZoom: number, fps: number) {
    if (!Globals.bgAudio) return;
    const cellW = 20 * tlZoom;
    const clip = $('tl-audio-clip');
    if (clip) {
        clip.style.left = (Globals.bgAudioOffset * cellW) + 'px';
        const durationFrames = Globals.bgAudio.duration ? Math.ceil(Globals.bgAudio.duration * fps) : 50;
        clip.style.width = (durationFrames * cellW) + 'px';
        drawWaveform(); // Redraw waveform if width changes
    }
}

export function playAudioAtFrame(frameIdx: number, fps: number) {
    if (Globals.bgAudio) {
        Globals.bgAudio.currentTime = Math.max(0, (frameIdx - Globals.bgAudioOffset) / fps);
        Globals.bgAudio.play().catch(e => console.log('Audio play error:', e));
    }
}

export function pauseAudio() {
    if (Globals.bgAudio) Globals.bgAudio.pause();
}

export function loopAudioPlay() {
    if (Globals.bgAudio) { 
        Globals.bgAudio.currentTime = 0; 
        Globals.bgAudio.play().catch(e=>{}); 
    }
}
