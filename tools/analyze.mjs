// Objective frame metrics so the critic loop is grounded in data, not vibes.
// Usage: node tools/analyze.mjs <dir-or-png> [--json]
import fs from 'node:fs'; import path from 'node:path';
import { decodePNG } from './png.mjs';
const srgb2lin = v => { v/=255; return v<=0.04045 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); };

function rgb2hsl(r,g,b){
  r/=255;g/=255;b/=255; const mx=Math.max(r,g,b), mn=Math.min(r,g,b), l=(mx+mn)/2;
  let h=0,s=0; const d=mx-mn;
  if(d){ s = l>0.5 ? d/(2-mx-mn) : d/(mx+mn);
    h = mx===r ? ((g-b)/d + (g<b?6:0)) : mx===g ? ((b-r)/d+2) : ((r-g)/d+4); h*=60; }
  return [h,s,l];
}

export function analyze(file){
  const img = decodePNG(file);
  const { width:w, height:h, channels:ch, data } = img;
  const N = w*h;
  const hist = new Array(64).fill(0);
  let satSum=0, satN=0, crushed=0, blown=0;
  let shadowH=[0,0,0], shadowN=0, highH=[0,0,0], highN=0;
  const lum = new Float32Array(N);
  for(let i=0,px=0;px<N;px++,i+=ch){
    const r=data[i],g=data[i+1],b=data[i+2];
    const L = 0.2126*srgb2lin(r)+0.7152*srgb2lin(g)+0.0722*srgb2lin(b);
    lum[px]=L;
    const Ls = Math.pow(L, 1/2.2);
    hist[Math.min(63, (Ls*64)|0)]++;
    const [hh,ss] = rgb2hsl(r,g,b);
    satSum+=ss; satN++;
    if(Ls<0.02) crushed++; if(Ls>0.98) blown++;
    if(Ls<0.18){ shadowH[0]+=r; shadowH[1]+=g; shadowH[2]+=b; shadowN++; }
    if(Ls>0.7){ highH[0]+=r; highH[1]+=g; highH[2]+=b; highN++; }
  }
  const band = (a,b)=> hist.slice(a,b).reduce((s,v)=>s+v,0)/N;
  // RMS contrast on perceptual luminance
  let mean=0; for(let i=0;i<N;i++) mean+=Math.pow(lum[i],1/2.2); mean/=N;
  let varr=0; for(let i=0;i<N;i++){ const d=Math.pow(lum[i],1/2.2)-mean; varr+=d*d; } varr/=N;
  // detail density: mean |gradient| (Sobel-lite) on a subsample
  let grad=0, gn=0;
  for(let y=1;y<h-1;y+=2) for(let x=1;x<w-1;x+=2){
    const a=lum[y*w+x-1], b=lum[y*w+x+1], c=lum[(y-1)*w+x], d=lum[(y+1)*w+x];
    grad += Math.abs(a-b)+Math.abs(c-d); gn++;
  }
  const sh = shadowN? shadowH.map(v=>v/shadowN) : [0,0,0];
  const hi = highN? highH.map(v=>v/highN) : [0,0,0];
  const shHue = rgb2hsl(sh[0],sh[1],sh[2]);
  const hiHue = rgb2hsl(hi[0],hi[1],hi[2]);
  // tiling: find a PROMINENT PERIODIC PEAK in the horizontal autocorrelation.
  // Raw autocorrelation is monotonically high for any smooth image, so we detrend against a
  // local baseline and look for a genuine local maximum standing above it. A smooth gradient
  // has no such peak; a repeating texture has one at its period.
  let bestLag=0, bestCorr=0;
  {
    const y0=(h*0.62)|0; const row=new Float32Array(w);
    for(let x=0;x<w;x++){ let s2=0; for(let dy=-3;dy<=3;dy++) s2+=lum[(y0+dy)*w+x]; row[x]=s2/7; }
    let m=0; for(let x=0;x<w;x++) m+=row[x]; m/=w;
    for(let x=0;x<w;x++) row[x]-=m;
    let denom=0; for(let x=0;x<w;x++) denom+=row[x]*row[x];
    const LAG0=8, LAG1=Math.floor(w/3);
    const corr=new Float32Array(LAG1);
    for(let lag=LAG0; lag<LAG1; lag++){
      let s2=0; for(let x=0;x+lag<w;x++) s2+=row[x]*row[x+lag];
      corr[lag] = s2/(denom||1);
    }
    // local baseline = moving average over a wide window
    const WIN=40;
    for(let lag=LAG0+2; lag<LAG1-2; lag++){
      let acc=0, n2=0;
      for(let k=lag-WIN;k<=lag+WIN;k++){ if(k<LAG0||k>=LAG1) continue; acc+=corr[k]; n2++; }
      const base = acc/(n2||1);
      const prom = corr[lag]-base;
      // must be a local maximum to count as a period, not just a high plateau
      if(corr[lag]>corr[lag-1] && corr[lag]>=corr[lag+1] && prom>bestCorr){ bestCorr=prom; bestLag=lag; }
    }
    bestCorr = Math.max(0, Math.min(1, bestCorr*2.5)); // calibrated so a hard tile repeat lands near 1
  }
  // ground plane proxy: bottom 40% of frame, central 70% horizontally (where the floor sits in our poses)
  // Sample the FULL width of the lower frame. An earlier version sampled only the central 70%,
  // which a dark vignetted centre could satisfy while the actual floor blazed at the edges —
  // the metric passed while the eye said the floor still dominated. We also track the 90th
  // percentile so a floor that is dark on average but has large blown-out regions still fails.
  const allSorted = Array.from(lum).map(v=>Math.pow(v,1/2.2)).sort((a,b)=>a-b);
  const frameMedian = allSorted[(allSorted.length/2)|0];
  const bandMed = (y0,y1)=>{ const v=[]; for(let y=y0;y<y1;y+=3) for(let x=0;x<w;x+=3) v.push(Math.pow(lum[y*w+x],1/2.2));
    v.sort((a,b)=>a-b); return v[(v.length/2)|0]; };
  const dTop=bandMed(0,(h/3)|0), dMid=bandMed((h/3)|0,(2*h/3)|0), dBot=bandMed((2*h/3)|0,h);
  const screenSpread = Math.max(dTop,dMid,dBot)-Math.min(dTop,dMid,dBot);

  // TRUE value bands, bucketed by WORLD-SPACE RADIUS from the arena centre.
  //
  // An earlier version split the depth samples into pixel-count terciles. That collapses in a close
  // pose: when ~78% of a frame is floor between 10 and 20 units, all three terciles land on floor
  // and the "far" band ends up being the focal architecture rather than the background void — so
  // the metric asked for the focal architecture to be darkened, the opposite of the art direction.
  // An agent caught this and produced the depth-mask evidence for it.
  //
  // We now reconstruct each pixel's world position from the linear depth pass plus the camera
  // parameters written beside it, then classify by radius against the arena:
  //     play area  r <  0.75R      perimeter architecture  0.75R <= r < 1.35R      void  r >= 1.35R
  // This is pose-independent and matches what ART_DIRECTION actually legislates.
  let trueBands = null;
  let floorSamples = null;
  const depthFile = file.replace(/\.png$/, '.depth.png');
  const metaFile  = file.replace(/\.png$/, '.meta.json');
  if (fs.existsSync(depthFile) && fs.existsSync(metaFile)) {
    try {
      const dimg = decodePNG(depthFile);
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      if (dimg.width === w && dimg.height === h && meta && meta.matrixWorld) {
        const dd = dimg.data, dch = dimg.channels;
        const m = meta.matrixWorld;                       // column-major THREE.Matrix4
        const tanHalf = Math.tan((meta.fov * Math.PI / 180) / 2);
        const R = meta.arenaR || 16;
        const rNear = 0.75 * R, rMid = 1.35 * R;
        const buckets = [[], [], []];
        floorSamples = [];
        for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
          const p2 = y * w + x;
          const dn = dd[p2 * dch] / 255;
          if (dn >= 0.999) { buckets[2].push(Math.pow(lum[p2], 1/2.2)); continue; }  // nothing = void
          const vd = meta.near + dn * (meta.far - meta.near);   // linear view depth
          const ndcX = (x / w) * 2 - 1, ndcY = -((y / h) * 2 - 1);
          const vx = ndcX * vd * tanHalf * meta.aspect, vy = ndcY * vd * tanHalf, vz = -vd;
          const wx = m[0]*vx + m[4]*vy + m[8]*vz  + m[12];
          const wy = m[1]*vx + m[5]*vy + m[9]*vz  + m[13];
          const wz = m[2]*vx + m[6]*vy + m[10]*vz + m[14];
          const r = Math.hypot(wx, wz);
          const L = Math.pow(lum[p2], 1/2.2);
          buckets[r < rNear ? 0 : (r < rMid ? 1 : 2)].push(L);
          // TRUE floor sampling: a pixel is ground only if its world position is on the floor
          // plane. Sampling a screen region instead swept in the hero and their own VFX burst,
          // so a combat frame's "ground" P90 was really the character — an agent proved this by
          // measuring the same band with the hero's column excluded (0.758 vs 0.332).
          if (wy > -0.75 && wy < 0.75 && r < rMid) floorSamples.push(L);
        }
        const med = (a)=>{ if(!a.length) return null; a.sort((p3,q)=>p3-q); return a[(a.length/2)|0]; };
        const near = med(buckets[0]), mid = med(buckets[1]), far = med(buckets[2]);
        if (near !== null && mid !== null && far !== null) {
          const tot = buckets[0].length + buckets[1].length + buckets[2].length;
          trueBands = {
            near:+near.toFixed(3), mid:+mid.toFixed(3), far:+far.toFixed(3),
            spread:+(Math.max(near,mid,far)-Math.min(near,mid,far)).toFixed(3),
            pixelShare: [ +(buckets[0].length/tot).toFixed(2), +(buckets[1].length/tot).toFixed(2), +(buckets[2].length/tot).toFixed(2) ],
          };
        }
      }
    } catch(e){ /* companions optional */ }
  }

  // Prefer TRUE floor samples (world-space, from the depth companion). Fall back to the crude
  // lower-frame region only when no depth companion exists, and say which was used.
  let gvals, groundSource;
  if (floorSamples && floorSamples.length > 500) {
    gvals = floorSamples; groundSource = 'world-plane';
  } else {
    gvals = []; const gy0=(h*0.55)|0;
    for(let y=gy0;y<h;y+=2) for(let x=0;x<w;x+=2) gvals.push(Math.pow(lum[y*w+x],1/2.2));
    groundSource = 'screen-region(approx)';
  }
  gvals.sort((a,b)=>a-b);
  const groundLuma = gvals.length? gvals[(gvals.length/2)|0] : 0;
  const groundP90  = gvals.length? gvals[Math.min(gvals.length-1,(gvals.length*0.90)|0)] : 0;

  // hue diversity: share of saturated pixels outside the dominant 60-degree hue span
  const hueBins=new Array(12).fill(0); let satPix=0;
  for(let i=0,px=0;px<N;px++,i+=ch){ const [hh,ss,ll]=rgb2hsl(data[i],data[i+1],data[i+2]);
    if(ss>0.22 && ll>0.08){ hueBins[Math.min(11,(hh/30)|0)]++; satPix++; } }
  let domBin=0; for(let i=1;i<12;i++) if(hueBins[i]>hueBins[domBin]) domBin=i;
  const nearHue = (hueBins[domBin]+hueBins[(domBin+11)%12]+hueBins[(domBin+1)%12]);
  const secondaryHueFrac = satPix? (satPix-nearHue)/satPix : 0;

  return {
    file: path.basename(file), w, h,
    groundLuma: +groundLuma.toFixed(3),
    groundP90: +groundP90.toFixed(3),
    groundSource,
    frameMedian: +frameMedian.toFixed(3),
    groundVsFrame: +(groundLuma/(frameMedian||1e-6)).toFixed(2),
    screenThirds: { top:+dTop.toFixed(3), mid:+dMid.toFixed(3), bottom:+dBot.toFixed(3), spread:+screenSpread.toFixed(3) },
    depthBands: trueBands,
    secondaryHueFrac: +secondaryHueFrac.toFixed(3),
    bands: { shadow: +band(0,16).toFixed(3), mid: +band(16,44).toFixed(3), highlight: +band(44,64).toFixed(3) },
    deepShadowPresent: +band(0,6).toFixed(4),
    brightPresent: +band(58,64).toFixed(4),
    crushedPct: +(crushed/N*100).toFixed(2),
    blownPct: +(blown/N*100).toFixed(2),
    meanSaturation: +(satSum/satN).toFixed(3),
    rmsContrast: +Math.sqrt(varr).toFixed(3),
    detailDensity: +(grad/gn).toFixed(4),
    shadowTint: { rgb: sh.map(v=>Math.round(v)), hue: +shHue[0].toFixed(0), sat: +shHue[1].toFixed(3) },
    highlightTint:{ rgb: hi.map(v=>Math.round(v)), hue: +hiHue[0].toFixed(0), sat: +hiHue[1].toFixed(3) },
    tiling: { periodPx: bestLag, strength: +bestCorr.toFixed(3) },
  };
}

// Composition laws apply to shots that FRAME the game. Deliberate close-up texture-inspection
// shots (04_material, 05_floor, anything with 'detail') are lit and posed to show a surface, so the
// ground-plane law does not apply — their whole subject IS the ground.
const INSPECTION = /(material|floor|detail|texture)/i;
function verdict(m){
  const bad=[];
  const inspection = INSPECTION.test(m.file);
  if(m.bands.shadow < 0.12) bad.push('too few dark pixels — no ink shadow band');
  if(m.bands.highlight < 0.02) bad.push('no highlight band — frame never reaches bright values');
  if(m.deepShadowPresent < 0.01) bad.push('no true blacks');
  if(m.rmsContrast < 0.14) bad.push('LOW CONTRAST — milky/muddy frame');
  if(m.meanSaturation < 0.18) bad.push('DESATURATED — greyness, violates the palette bible');
  if(m.shadowTint.sat < 0.10 && m.shadowTint.rgb[0]>6) bad.push('shadows are NEUTRAL GREY — hard ban §7');
  if(m.crushedPct > 22) bad.push('blacks crushed to nothing over >22% of frame');
  if(m.blownPct > 4) bad.push('highlights blown out');
  if(m.detailDensity < 0.004) bad.push('almost no surface detail — flat/untextured');
  if(m.tiling.strength > 0.55) bad.push(`strong tiling repetition at ~${m.tiling.periodPx}px`);
  if(!inspection){
    if(m.groundVsFrame > 1.0) bad.push(`VALUE LAW BROKEN: ground plane (${m.groundLuma}) is BRIGHTER than the frame median (${m.frameMedian}) — the floor must be the dark stage`);
    if(m.groundLuma > 0.18) bad.push(`VALUE LAW: ground luma ${m.groundLuma} exceeds 0.18 — darken the floor`);
    if(m.groundP90 > 0.42) bad.push(`VALUE LAW: the brightest tenth of the floor reaches ${m.groundP90} — large regions of the ground are still blazing even if the median passes`);
  }
  if(m.bands.highlight < 0.04) bad.push('VALUE LAW: no highlight band (<4%) — frame never reaches bright');
  if(m.depthBands){
    const b = m.depthBands;
    if(b.spread < 0.18) bad.push(`VALUE LAW: true-depth luma spread only ${b.spread} (near ${b.near} / mid ${b.mid} / far ${b.far}) — no separated value bands (need >=0.18)`);
    // ART_DIRECTION §1.1: background is LOW value and hazed; the mid-ground focal architecture
    // carries the light. A background brighter than the mid-ground is inverted aerial perspective
    // and pulls the eye out of the play space.
    if(b.far > b.mid) bad.push(`VALUE LAW: INVERTED AERIAL PERSPECTIVE — background (${b.far}) is brighter than the mid-ground (${b.mid}). The background must be the darkest, least saturated band; the mid-ground focal architecture must carry the light.`);
    if(b.mid < b.near) bad.push(`VALUE LAW: the mid-ground (${b.mid}) is darker than the near play area (${b.near}) — the focal architecture should be the lit band.`);
  } // no depth companion captured -> the screen-thirds proxy is NOT used as a gate, it lies too often
  if(m.secondaryHueFrac < 0.08) bad.push(`MONOCHROME: only ${(m.secondaryHueFrac*100).toFixed(0)}% of saturated pixels sit outside the dominant hue — needs an opposing accent hue`);
  return bad;
}

const target = process.argv[2] || 'shots/latest';
const files = fs.statSync(target).isDirectory()
  ? fs.readdirSync(target).filter(f=>f.endsWith('.png') && !f.endsWith('.depth.png')).sort().map(f=>path.join(target,f))
  : [target];
const out = files.map(f=>{ try{ const m=analyze(f); return {...m, shotKind: INSPECTION.test(path.basename(f))?'inspection':'composition', warnings:verdict(m)}; }
  catch(e){ return { file:path.basename(f), error:String(e.message) }; } });
console.log(JSON.stringify(out, null, 1));
