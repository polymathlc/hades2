import { chromium } from 'playwright';
const url = process.argv[2] || 'http://localhost:4173/';
const out = process.argv[3] || 'shots/shot.png';
const wait = +(process.argv[4] || 2500);
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:[
  '--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist','--enable-webgl','--no-sandbox','--disable-dev-shm-usage'
]});
const pg = await b.newPage({ viewport:{width:1600,height:900}, deviceScaleFactor:1 });
const errs=[]; pg.on('console',m=>{ if(m.type()==='error') errs.push(m.text()); });
pg.on('pageerror',e=>errs.push('PAGEERROR: '+e.message));
await pg.goto(url,{waitUntil:'load',timeout:60000});
await pg.waitForTimeout(wait);
const info = await pg.evaluate(()=>{ const c=document.querySelector('canvas'); const gl=c&&(c.getContext('webgl2')||true);
  return {hasCanvas:!!c, frames:window.__frames||0, w:c?c.width:0, h:c?c.height:0}; });
await pg.screenshot({path:out});
console.log(JSON.stringify({info, errors:errs.slice(0,10)},null,1));
await b.close();
