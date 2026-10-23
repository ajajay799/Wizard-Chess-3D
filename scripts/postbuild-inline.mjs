import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const distHtmlPath = path.join(rootDir, 'dist', 'index.html');
const standaloneJsPath = path.join(rootDir, 'public', 'standalone-app.js');
const standaloneCssPath = path.join(rootDir, 'public', 'standalone-styles.css');

if (fs.existsSync(distHtmlPath) && fs.existsSync(standaloneJsPath) && fs.existsSync(standaloneCssPath)) {
  let html = fs.readFileSync(distHtmlPath, 'utf8');
  const css = fs.readFileSync(standaloneCssPath, 'utf8');
  const js = fs.readFileSync(standaloneJsPath, 'utf8').replace(/<\/script/gi, '<\\/script');

  // Remove Vite's external <script type="module" ...> and <link rel="stylesheet" ...> tags
  // and inline the self-contained CSS + classic IIFE bundle directly inside dist/index.html
  // so saving the webpage as a single .html file (or opening dist/index.html via file://) works anywhere.
  html = html.replace(/<script\s+type="module"\s+crossorigin\s+src="[^"]+"><\/script>\s*/g, '');
  html = html.replace(/<link\s+rel="stylesheet"\s+crossorigin\s+href="[^"]+">\s*/g, '');

  html = html.replace('</head>', () => `  <style>${css}</style>\n</head>`);
  html = html.replace('</body>', () => `  <script>${js}</script>\n</body>`);

  fs.writeFileSync(distHtmlPath, html, 'utf8');
  console.log('Inlined self-contained CSS and IIFE bundle into dist/index.html');
}
