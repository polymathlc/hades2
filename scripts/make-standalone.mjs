// Fold the IIFE build into ONE double-clickable play.html.
import fs from 'node:fs';
import path from 'node:path';
const B = '.standalone-build', OUT = 'standalone/play.html';
if (!fs.existsSync(B)) { console.error('run the standalone vite build first'); process.exit(1); }
let html = fs.readFileSync(path.join(B, 'index.html'), 'utf8');
const files = fs.readdirSync(B, { recursive: true }).filter(f => typeof f === 'string');
const js  = files.find(f => f.endsWith('bundle.js'));
const css = files.find(f => f.endsWith('.css'));
if (!js) { console.error('no bundle.js emitted'); process.exit(1); }
const jsSrc  = fs.readFileSync(path.join(B, js), 'utf8');
const cssSrc = css ? fs.readFileSync(path.join(B, css), 'utf8') : '';
// Drop every emitted <script>/<link>, then re-add one classic inline script.
html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
           .replace(/<link\b[^>]*rel=["']?stylesheet["']?[^>]*>/g, '');
if (cssSrc) html = html.replace('</head>', `<style>${cssSrc}</style>\n</head>`);
// </script> inside the source would close the tag early; the escape is mandatory, not cosmetic.
html = html.replace('</body>', `<script>${jsSrc.replace(/<\/script>/gi, '<\\/script>')}</script>\n</body>`);
fs.mkdirSync('standalone', { recursive: true });
fs.writeFileSync(OUT, html);
console.log(`${OUT}  ${(fs.statSync(OUT).size/1048576).toFixed(1)} MB`);
