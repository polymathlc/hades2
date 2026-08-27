// Minimal dependency-free PNG decoder (8-bit RGB/RGBA, non-interlaced).
import zlib from 'node:zlib';
import fs from 'node:fs';
export function decodePNG(file){
  const buf = fs.readFileSync(file);
  if(buf.readUInt32BE(0)!==0x89504e47) throw new Error('not a png');
  let off=8, w=0,h=0,bd=0,ct=0, idat=[];
  while(off < buf.length){
    const len = buf.readUInt32BE(off); const type = buf.toString('ascii', off+4, off+8);
    const data = buf.subarray(off+8, off+8+len);
    if(type==='IHDR'){ w=data.readUInt32BE(0); h=data.readUInt32BE(4); bd=data[8]; ct=data[9];
      if(bd!==8) throw new Error('only 8-bit supported'); if(data[12]!==0) throw new Error('interlaced unsupported'); }
    else if(type==='IDAT') idat.push(data);
    else if(type==='IEND') break;
    off += 12+len;
  }
  const ch = ct===6?4: ct===2?3: ct===0?1: ct===4?2: 4;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w*ch;
  const out = Buffer.alloc(h*stride);
  let p=0;
  for(let y=0;y<h;y++){
    const f = raw[p++];
    const line = raw.subarray(p, p+stride); p+=stride;
    const cur = out.subarray(y*stride, y*stride+stride);
    const prev = y>0 ? out.subarray((y-1)*stride, y*stride) : null;
    for(let x=0;x<stride;x++){
      const a = x>=ch ? cur[x-ch] : 0;
      const b = prev ? prev[x] : 0;
      const c = (prev && x>=ch) ? prev[x-ch] : 0;
      let v = line[x];
      switch(f){
        case 0: break;
        case 1: v = (v+a)&255; break;
        case 2: v = (v+b)&255; break;
        case 3: v = (v + ((a+b)>>1))&255; break;
        case 4: { const pa=Math.abs(b-c), pb=Math.abs(a-c), pc=Math.abs(a+b-2*c);
                  const pr = (pa<=pb&&pa<=pc)?a:(pb<=pc?b:c); v=(v+pr)&255; break; }
        default: throw new Error('bad filter '+f);
      }
      cur[x]=v;
    }
  }
  return { width:w, height:h, channels:ch, data:out };
}

// Minimal PNG encoder (8-bit RGBA, no interlace).
import zlibE from 'node:zlib';
function crc32(buf){
  let c, table = crc32.t;
  if(!table){ table = crc32.t = new Int32Array(256);
    for(let n=0;n<256;n++){ c=n; for(let k=0;k<8;k++) c = c&1 ? 0xEDB88320 ^ (c>>>1) : c>>>1; table[n]=c; } }
  let crc = -1;
  for(let i=0;i<buf.length;i++) crc = (crc>>>8) ^ table[(crc^buf[i]) & 0xFF];
  return (crc ^ -1) >>> 0;
}
function chunk(type, data){
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type,'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function encodePNG({width, height, data}){ // data = RGBA Buffer
  const stride = width*4;
  const raw = Buffer.alloc(height*(stride+1));
  for(let y=0;y<height;y++){
    raw[y*(stride+1)] = 0; // filter none
    data.copy(raw, y*(stride+1)+1, y*stride, y*stride+stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width,0); ihdr.writeUInt32BE(height,4);
  ihdr[8]=8; ihdr[9]=6; ihdr[10]=0; ihdr[11]=0; ihdr[12]=0;
  return Buffer.concat([
    Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibE.deflateSync(raw, {level:6})),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
export function toRGBA(img){
  const {width:w, height:h, channels:ch, data} = img;
  if(ch===4) return Buffer.from(data);
  const out = Buffer.alloc(w*h*4);
  for(let p=0;p<w*h;p++){
    const s=p*ch, d=p*4;
    if(ch===3){ out[d]=data[s]; out[d+1]=data[s+1]; out[d+2]=data[s+2]; }
    else if(ch===1){ out[d]=out[d+1]=out[d+2]=data[s]; }
    else if(ch===2){ out[d]=out[d+1]=out[d+2]=data[s]; }
    out[d+3]=255;
  }
  return out;
}
export function resizeNearestFit(img, tw, th){
  const rgba = toRGBA(img); const {width:w, height:h} = img;
  const scale = Math.min(tw/w, th/h);
  const nw = Math.max(1, Math.round(w*scale)), nh = Math.max(1, Math.round(h*scale));
  const out = Buffer.alloc(tw*th*4);
  const ox = ((tw-nw)/2)|0, oy = ((th-nh)/2)|0;
  for(let y=0;y<nh;y++){
    const sy = Math.min(h-1, (y/scale)|0);
    for(let x=0;x<nw;x++){
      const sx = Math.min(w-1, (x/scale)|0);
      const s=(sy*w+sx)*4, d=(((y+oy)*tw)+(x+ox))*4;
      out[d]=rgba[s]; out[d+1]=rgba[s+1]; out[d+2]=rgba[s+2]; out[d+3]=255;
    }
  }
  return { width:tw, height:th, data:out };
}
