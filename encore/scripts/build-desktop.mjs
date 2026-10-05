// Bundles the desktop app's main process (with the Encore server inside it)
// and its preload script, so the packaged app needs no node_modules.
import { build } from 'esbuild';

const common = { bundle: true, platform: 'node', target: 'node22', sourcemap: false, logLevel: 'warning' };

await build({
  ...common,
  entryPoints: ['src/desktop/main.ts'],
  outfile: 'dist-desktop/main.mjs',
  format: 'esm',
  // Optional native speedups for ws, and Vite (dev mode only).
  external: ['electron', 'vite', 'bufferutil', 'utf-8-validate'],
  // Some bundled CommonJS dependencies call require(); give ESM one.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});

await build({
  ...common,
  entryPoints: ['src/desktop/preload.cts'],
  outfile: 'dist-desktop/preload.cjs',
  format: 'cjs',
  external: ['electron'],
});

console.log('Built dist-desktop/');
