// Blind A/B comparison harness.
// Composites two images side by side with a randomised left/right assignment and writes a
// sealed key file, so a critic agent can judge which panel is better WITHOUT knowing which
// build (or which game) it is looking at.
//
//   node tools/ab.mjs <leftSource> <rightSource> <outDir> [seed]
//
// Sources may be single PNGs or directories. If both are directories, every filename present
// in both is paired. Writes <outDir>/<id>.png plus <outDir>/KEY.json (the answer sheet — the
// critic must NOT read this; only the orchestrator decodes it afterwards).
import fs from 'node:fs'; import path from 'node:path';
import { decodePNG, encodePNG, resizeNearestFit } from './png.mjs';

const FONT = {
  L:['10000','10000','10000','10000','10000','10000','11111'],
  E:['11111','10000','10000','11110','10000','10000','11111'],
  F:['11111','10000','10000','11110','10000','10000','10000'],
  T:['11111','00100','00100','00100','00100','00100','00100'],
  R:['11110','10001','10001','11110','10100','10010','10001'],
  I:['11111','00100','00100','00100','00100','00100','11111'],
  G:['01111','10000','10000','10111','10001','10001','01111'],
  H:['10001','10001','10001','11111','10001','10001','10001'],
};
function drawText(buf, W, text, x0, y0, s){
  let x = x0;
  for(const chr of text){
    const g = FONT[chr]; if(!g){ x += 6*s; continue; }
    for(let r=0;r<7;r++) for(let c=0;c<5;c++){
      if(g[r][c] !== '1') continue;
      for(let dy=0;dy<s;dy++) for(let dx=0;dx<s;dx++){
        const px = x + c*s + dx, py = y0 + r*s + dy;
        const d = (py*W + px)*4;
        buf[d]=242; buf[d+1]=193; buf[d+2]=78; buf[d+3]=255;
      }
    }
    x += 6*s;
  }
}

const [,, A, B, OUT = 'shots/ab', SEEDARG] = process.argv;
if(!A || !B){ console.error('usage: node tools/ab.mjs <a> <b> <outDir> [seed]'); process.exit(1); }
let seed = (SEEDARG ? +SEEDARG : 20260827) >>> 0;
const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;

const isDir = p => fs.existsSync(p) && fs.statSync(p).isDirectory();
// Skip measurement companions — they are data, not frames a critic should be shown.
const isFrame = f => f.endsWith('.png') && !f.endsWith('.depth.png') && !f.endsWith('.clean.png');
const pngs = p => isDir(p) ? fs.readdirSync(p).filter(isFrame).sort() : [path.basename(p)];

let pairs;
if(isDir(A) && isDir(B)){
  const a = new Set(pngs(A)), b = new Set(pngs(B));
  pairs = [...a].filter(f => b.has(f)).map(f => ({ id: f.replace(/\.png$/,''), a: path.join(A,f), b: path.join(B,f) }));
} else {
  pairs = [{ id: 'pair', a: A, b: B }];
}
if(!pairs.length){ console.error('no overlapping images to compare'); process.exit(1); }

fs.mkdirSync(OUT, { recursive: true });
const PANEL_W = 900, PANEL_H = 900, GUT = 24, LABEL = 44;
const key = { generated: new Date().toISOString(), left: {}, right: {}, sources: { A, B } };

for(const p of pairs){
  let ia, ib;
  try { ia = decodePNG(p.a); ib = decodePNG(p.b); }
  catch(e){ console.error('skip', p.id, String(e.message)); continue; }

  const flip = rnd() < 0.5;                       // randomised assignment — this is the blinding
  const leftImg  = flip ? ib : ia;
  const rightImg = flip ? ia : ib;
  key.left[p.id]  = flip ? 'B' : 'A';
  key.right[p.id] = flip ? 'A' : 'B';

  const L = resizeNearestFit(leftImg,  PANEL_W, PANEL_H);
  const R = resizeNearestFit(rightImg, PANEL_W, PANEL_H);

  const W = PANEL_W*2 + GUT, H = PANEL_H + LABEL;
  const out = Buffer.alloc(W*H*4, 0);
  for(let i=0;i<W*H;i++){ out[i*4]=10; out[i*4+1]=10; out[i*4+2]=14; out[i*4+3]=255; }
  const blit = (panel, ox) => {
    for(let y=0;y<PANEL_H;y++) for(let x=0;x<PANEL_W;x++){
      const s=(y*PANEL_W+x)*4, d=(((y+LABEL)*W)+(x+ox))*4;
      out[d]=panel.data[s]; out[d+1]=panel.data[s+1]; out[d+2]=panel.data[s+2]; out[d+3]=255;
    }
  };
  blit(L, 0); blit(R, PANEL_W+GUT);
  // draw a 5x7 bitmap "LEFT" / "RIGHT" label band so the critic can name the panel unambiguously
  drawText(out, W, 'LEFT',  (PANEL_W/2-70)|0, 14, 4);
  drawText(out, W, 'RIGHT', (PANEL_W+GUT+PANEL_W/2-88)|0, 14, 4);
  fs.writeFileSync(path.join(OUT, p.id+'.png'), encodePNG({ width:W, height:H, data:out }));
}
fs.writeFileSync(path.join(OUT,'KEY.json'), JSON.stringify(key,null,2));
console.log(JSON.stringify({ pairs: pairs.length, out: OUT, note: 'KEY.json holds the answer sheet — do not show it to the critic.' }, null, 1));

