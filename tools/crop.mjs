// Crop and magnify a region of a PNG so detail can be inspected by eye.
// usage: node tools/crop.mjs <in.png> <out.png> <x> <y> <w> <h> [zoom]
import { decodePNG, encodePNG, toRGBA } from './png.mjs';
import fs from 'node:fs';
const [,, IN, OUT, X, Y, W, H, Z='4'] = process.argv;
const img = decodePNG(IN); const rgba = toRGBA(img);
const x0=+X, y0=+Y, cw=+W, chh=+H, z=+Z;
const ow=cw*z, oh=chh*z;
const out = Buffer.alloc(ow*oh*4, 255);
for(let y=0;y<oh;y++) for(let x=0;x<ow;x++){
  const sx = Math.min(img.width-1, x0 + ((x/z)|0));
  const sy = Math.min(img.height-1, y0 + ((y/z)|0));
  const s=(sy*img.width+sx)*4, d=(y*ow+x)*4;
  out[d]=rgba[s]; out[d+1]=rgba[s+1]; out[d+2]=rgba[s+2]; out[d+3]=255;
}
fs.writeFileSync(OUT, encodePNG({width:ow, height:oh, data:out}));
console.log(`cropped ${IN} [${x0},${y0} ${cw}x${chh}] x${z} -> ${OUT} (${ow}x${oh})`);
