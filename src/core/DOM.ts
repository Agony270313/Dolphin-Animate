export const $ = (id: string) => document.getElementById(id) as HTMLElement;
export const canvas = $('draw-canvas') as HTMLCanvasElement;
export const overlay = $('overlay-canvas') as HTMLCanvasElement;
export const ctx = canvas.getContext('2d')!;
export const octx = overlay.getContext('2d')!;

ctx.imageSmoothingEnabled = true;
octx.imageSmoothingEnabled = true;
ctx.imageSmoothingQuality = 'high';
octx.imageSmoothingQuality = 'high';
