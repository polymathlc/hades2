import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
const CHROME='/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const URL_BASE = process.env.EREBUS_URL || 'http://localhost:4173/';
const OUT = process.argv[2] || 'shots/latest';
const ONLY = process.argv[3] ? process.argv[3].split(',') : null;
const W = +(process.env.SHOT_W||1600), H = +(process.env.SHOT_H||900);
const T = +(process.env.SHOT_TIMEOUT||300000); // page load / ready timeout; swiftshader under load needs headroom

const list = JSON.parse(fs.readFileSync(new URL('./shotlist.json', import.meta.url)));
fs.mkdirSync(OUT, { recursive:true });

const b = await chromium.launch({ executablePath: CHROME, args:[
  '--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist','--enable-webgl','--no-sandbox','--disable-dev-shm-usage',
  '--force-color-profile=srgb','--disable-lcd-text','--hide-scrollbars','--mute-audio']});
const pg = await b.newPage({ viewport:{width:W,height:H}, deviceScaleFactor:1 });
pg.setDefaultTimeout(T);
const errors=[];
pg.on('console', m=>{ if(m.type()==='error') errors.push(m.text()); });
pg.on('pageerror', e=>errors.push('PAGEERROR: '+e.message));

await pg.goto(URL_BASE+'?capture=1&seed=1337', { waitUntil:'load', timeout:T });
try { await pg.waitForFunction('window.__EREBUS_READY===true', { timeout:T }); }
catch(e){ const t = await pg.evaluate(()=>document.body.innerText.slice(0,2000)).catch(()=>'');
  console.log(JSON.stringify({fatal:'capture driver never became ready', body:t, errors},null,1)); await pg.screenshot({path:path.join(OUT,'00_FATAL.png')}); await b.close(); process.exit(2); }

const report = { shots:[], errors:[], perf:null };
let dirtyState = false;
for(const s of list.shots){
  if(ONLY && !ONLY.includes(s.id)) continue;
  const pose = list.poses[s.pose];
  // STATE LEAK: capture.state() sets up a scenario and nothing ever tears it down, so a modal
  // opened for 10_boons persisted into 11_relief_detail — the one shot written to prove the
  // carved-relief work captured a UI overlay instead, and the two shipped as near-duplicates.
  // A critic caught this, not the harness. Reload between shots so every scenario starts clean.
  if (dirtyState) {
    await pg.goto(URL_BASE+'?capture=1&seed=1337', { waitUntil:'load', timeout:T });
    await pg.waitForFunction('window.__EREBUS_READY===true', { timeout:T });
    dirtyState = false;
  }
  if (s.state) dirtyState = true;
  try{
    const dataUrl = await pg.evaluate(async ({s,pose})=>{
      const c = window.EREBUS.capture;
      c.seed(1337);
      c.state(s.state || 'play');   // always explicit; a missing state must never carry forward
      c.step(s.steps ?? 1.0);
      c.pose(pose);
      c.render();
      const cv = document.querySelector('canvas');
      return cv.toDataURL('image/png');
    }, {s,pose});
    const file = path.join(OUT, s.id+'.png');
    fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
    // linear depth companion so analyze.mjs can measure value bands by true depth
    try {
      const dUrl = await pg.evaluate(()=> window.EREBUS.capture.depth());
      fs.writeFileSync(path.join(OUT, s.id+'.depth.png'), Buffer.from(dUrl.split(',')[1],'base64'));
      // restore the colour frame so a later screenshot of the canvas is not the depth pass
      const cleanUrl = await pg.evaluate(()=> window.EREBUS.capture.clean());
      fs.writeFileSync(path.join(OUT, s.id+'.clean.png'), Buffer.from(cleanUrl.split(',')[1],'base64'));
      const meta = await pg.evaluate(()=> window.EREBUS.capture.sceneMeta());
      fs.writeFileSync(path.join(OUT, s.id+'.meta.json'), JSON.stringify(meta));
      await pg.evaluate(()=> window.EREBUS.capture.render());
    } catch(e){ /* depth pass optional */ }
    report.shots.push({ id:s.id, file, note:s.note });
  }catch(e){ report.shots.push({ id:s.id, error:String(e).slice(0,300) }); }
}
report.perf = await pg.evaluate(()=>window.EREBUS.capture.info()).catch(()=>null);
report.errors = [...new Set(errors)].slice(0,25);
fs.writeFileSync(path.join(OUT,'report.json'), JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,1));
await b.close();
