// Copy the built web app into desktop/app/ so electron-builder ships a self-contained bundle.
import fs from 'node:fs';
import path from 'node:path';
const SRC = 'dist', DST = 'desktop/app';
if (!fs.existsSync(SRC)) { console.error('run `npm run build` first — no dist/'); process.exit(1); }
fs.rmSync(DST, { recursive: true, force: true });
fs.cpSync(SRC, DST, { recursive: true });
const n = fs.readdirSync(DST, { recursive: true }).length;
console.log(`staged ${n} files -> ${DST}`);
