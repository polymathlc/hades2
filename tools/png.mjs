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
