import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
const CHROME='/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const URL_BASE = process.env.EREBUS_URL || 'http://localhost:4173/';
const OUT = process.argv[2] || 'shots/latest';
const ONLY = process.argv[3] ? process.argv[3].split(',') : null;
const W = +(process.env.SHOT_W||1600), H = +(process.env.SHOT_H||900);

const list = JSON.parse(fs.readFileSync(new URL('./shotlist.json', import.meta.url)));
fs.mkdirSync(OUT, { recursive:true });

const b = await chromium.launch({ executablePath: CHROME, args:[
  '--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist','--enable-webgl','--no-sandbox','--disable-dev-shm-usage',
  '--force-color-profile=srgb','--disable-lcd-text','--hide-scrollbars','--mute-audio']});
const pg = await b.newPage({ viewport:{width:W,height:H}, deviceScaleFactor:1 });
pg.setDefaultTimeout(180000);
const errors=[];
pg.on('console', m=>{ if(m.type()==='error') errors.push(m.text()); });
pg.on('pageerror', e=>errors.push('PAGEERROR: '+e.message));

await pg.goto(URL_BASE+'?capture=1&seed=1337', { waitUntil:'load', timeout:90000 });
try { await pg.waitForFunction('window.__EREBUS_READY===true', { timeout:90000 }); }
catch(e){ const t = await pg.evaluate(()=>document.body.innerText.slice(0,2000)).catch(()=>'');
  console.log(JSON.stringify({fatal:'capture driver never became ready', body:t, errors},null,1)); await pg.screenshot({path:path.join(OUT,'00_FATAL.png')}); await b.close(); process.exit(2); }

const report = { shots:[], errors:[], perf:null };
for(const s of list.shots){
  if(ONLY && !ONLY.includes(s.id)) continue;
  const pose = list.poses[s.pose];
  try{
    const dataUrl = await pg.evaluate(async ({s,pose})=>{
      const c = window.EREBUS.capture;
      c.seed(1337);
      if(s.state) c.state(s.state);
      c.step(s.steps ?? 1.0);
      c.pose(pose);
      c.render();
      const cv = document.querySelector('canvas');
      return cv.toDataURL('image/png');
    }, {s,pose});
    const file = path.join(OUT, s.id+'.png');
    fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
    report.shots.push({ id:s.id, file, note:s.note });
  }catch(e){ report.shots.push({ id:s.id, error:String(e).slice(0,300) }); }
}
report.perf = await pg.evaluate(()=>window.EREBUS.capture.info()).catch(()=>null);
report.errors = [...new Set(errors)].slice(0,25);
fs.writeFileSync(path.join(OUT,'report.json'), JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,1));
await b.close();
