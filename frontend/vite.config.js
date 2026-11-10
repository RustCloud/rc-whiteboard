import { cpSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

/**
 * Excalidraw's fonts next to the board (`/whiteboard/fonts/…`): it loads them
 * from window.EXCALIDRAW_ASSET_PATH, else from a CDN the cloud may not reach.
 */
function excalidrawFonts() {
  return {
    name: 'excalidraw-fonts',
    apply: 'build',
    closeBundle() {
      const fonts = here('./node_modules/@excalidraw/excalidraw/dist/prod/fonts');
      if (!existsSync(fonts)) throw new Error(`no fonts at ${fonts}`);
      cpSync(fonts, here('./dist/fonts'), { recursive: true });
    },
  };
}

/**
 * Excalidraw adds a CDN (esm.sh) after EXCALIDRAW_ASSET_PATH to every font's
 * sources. The board's CSP blocks it anyway, but Chrome still tries it for
 * each of ~230 font faces (an error each in the console). The fallback becomes
 * the service's own path: no address outside the cloud is left.
 */
function noFontCdn() {
  const FALLBACK = /("ASSETS_FALLBACK_URL",)`https:\/\/esm\.sh\/.*?\/dist\/prod\/`/s;
  let replaced = false;
  return {
    name: 'excalidraw-no-font-cdn',
    apply: 'build',
    transform(code, id) {
      if (!id.includes('@excalidraw/excalidraw/dist/') || !code.includes('esm.sh')) return null;
      const out = code.replace(FALLBACK, '$1`${window.location.origin}/whiteboard/`');
      if (out === code) return null;
      replaced = true;
      return { code: out, map: null };
    },
    buildEnd() {
      if (!replaced) this.error('Excalidraw’s font CDN fallback not found: check noFontCdn() after an upgrade');
    },
  };
}

export default defineConfig({
  // The service serves the board under /whiteboard/ (the plugin's [[proxy]] path).
  base: '/whiteboard/',
  plugins: [react(), noFontCdn(), excalidrawFonts()],
  define: {
    'process.env.IS_PREACT': JSON.stringify('false'),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Excalidraw is large; one chunk per language and the main one are fine.
    chunkSizeWarningLimit: 4096,
    sourcemap: false,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.js'],
  },
});
