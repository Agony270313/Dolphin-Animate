export const S: any = {
  w: 800, h: 600,
  tool: 'brush',
  stroke: '#000000', fill: '#444444',
  size: 4, opacity: 1, smoothing: 0.5,
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
  fillTolerance: 10,
  autoSmooth: false, pixelSnap: false,
};

export const Globals = { bgAudio: null as any, bgAudioOffset: 0, bgAudioStartTrim: 0, bgAudioEndTrim: 0, bgAudioData: null as any, _penPath: null as any };
export const Symbols = {} as Record<string, any>;
export let IsolationMode: string | null = null;
export function setIsolationMode(id: string | null) { IsolationMode = id; }
