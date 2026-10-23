import fs from 'node:fs';
import path from 'node:path';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

const rootDir = process.cwd();
const glbDir = path.join(rootDir, 'public', 'assets', 'glb');

// 1. Generate classic <script> wrapper files (.glb.b64.js) for every .glb.gz.b64 model
// so opening index.html directly via file:// can load all 3D models without fetch() CORS errors.
if (fs.existsSync(glbDir)) {
  const files = fs.readdirSync(glbDir).filter((f) => f.endsWith('.glb.gz.b64'));
  for (const file of files) {
    const baseName = file.replace('.glb.gz.b64', '');
    const b64Path = path.join(glbDir, file);
    const outJsPath = path.join(glbDir, `${baseName}.glb.b64.js`);
    const rawB64 = fs.readFileSync(b64Path, 'utf8').trim();
    const jsContent = `window.__WIZARD_CHESS_B64_ASSETS = window.__WIZARD_CHESS_B64_ASSETS || {};\nwindow.__WIZARD_CHESS_B64_ASSETS[${JSON.stringify(baseName)}] = ${JSON.stringify(rawB64)};\n`;
    fs.writeFileSync(outJsPath, jsContent, 'utf8');
  }
}

// 2. Copy src/styles.css to public/standalone-styles.css for direct file:// opening
const stylesSrc = path.join(rootDir, 'src', 'styles.css');
const stylesDest = path.join(rootDir, 'public', 'standalone-styles.css');
if (fs.existsSync(stylesSrc)) {
  fs.copyFileSync(stylesSrc, stylesDest);
}

// 3. Bundle src/main.tsx into a single classic non-module IIFE script (public/standalone-app.js)
// so opening index.html or dist/index.html directly in a browser via file:// works immediately.
await build({
  configFile: false,
  root: rootDir,
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(rootDir, 'src'),
    },
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  publicDir: false,
  build: {
    outDir: path.join(rootDir, 'public'),
    emptyOutDir: false,
    sourcemap: false,
    minify: true,
    lib: {
      entry: path.join(rootDir, 'src', 'main.tsx'),
      name: 'WizardChessStandaloneApp',
      formats: ['iife'],
      fileName: () => 'standalone-app.js',
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});

console.log('Standalone file:// bundle and 3D asset script wrappers generated.');
