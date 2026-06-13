import { defineConfig } from 'vite';
import electron from 'vite-plugin-electron-renderer';

export default defineConfig({
  plugins: [electron()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  base: './', // important for electron
});
