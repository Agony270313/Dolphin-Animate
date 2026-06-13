# Dolphin Animate

A free, open-source 2D animation tool for frame-by-frame animation.

![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)
![License](https://img.shields.io/badge/license-MIT-green)
![Electron](https://img.shields.io/badge/electron-28-blue)

## Features

- **Drawing Tools:** Brush, pencil, eraser, fill, rectangle, circle, line, text, pen
- **Onion Skinning:** See previous/next frames while drawing
- **Pressure-Sensitive Brush:** Works with drawing tablets
- **Layers & Groups:** Organize your animation
- **Auto-Merge:** Strokes merge as you draw for fluid animation
- **Free Transform:** Move, scale, rotate, skew with pivot point control
- **Timeline:** Multi-layer timeline, frame management (F5, F7)
- **Fill Tool:** Flood fill with anti-aliasing support
- **Eraser:** Clean stroke splitting and bitmap fill erasing
- **Export:** GIF, sprite sheet, PNG sequence
- **Project Save/Load:** Save and continue your work anytime

## Quick Start

```bash
npm install
npx electron .
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| V | Selection tool |
| B | Brush |
| P | Pencil |
| E | Eraser |
| G | Fill |
| R | Rectangle |
| O | Circle |
| L | Line |
| T | Text |
| A | Pen |
| M | Guide line |
| F5 | Add frame |
| F7 | Empty frame |
| Delete | Delete selected |
| Ctrl+Z | Undo |
| Ctrl+Y | Redo |
| Ctrl+N | New project |
| Ctrl+O | Open project |
| Ctrl+S | Save project |
| Space / Enter | Play/Pause |
| Arrow Keys | Move 1px (Shift+10px) |

## Build

```bash
npm run build
```

## Tech Stack

- **Electron** - Desktop app framework
- **HTML5 Canvas** - Rendering engine
- **Pure JavaScript** - No external dependencies

## License

MIT - Free to use, modify, and distribute.
