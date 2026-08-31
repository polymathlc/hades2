// OWNER: ORCHESTRATOR (boot & contracts)
// ---------------------------------------------------------------------------
// loading.js — the descent gate.
//
// WHY THIS EXISTS. Everything in EREBUS is synthesised at runtime: 46 texture
// recipes, every shader program, every impulse response. The game used to bake
// only what the first chamber asked for and pay for the rest mid-run — a
// half-second of blocked main thread the first time the player crossed into
// Asphodel, and another one the first time a boss exploded. Preloading all of
// it is the fix, and it makes boot honestly longer. A longer boot with nothing
// on screen is a worse game than a shorter one, so the cost is paid in front of
// a real loading screen that says what it is doing and how far along it is.
//
// ART_DIRECTION §6: dark stone, gold filigree frame with corner palmettes and a
// beaded rule, carved serif display type. Never an HTML form. Everything here
// is drawn from markup + gradients — zero downloaded assets, same as the game.
//
// It is deliberately independent of ui/index.js: this has to be on screen
// before the renderer, the material library or the UI system exist.
// ---------------------------------------------------------------------------

const CSS = `
#erebus-load{position:fixed;inset:0;z-index:9000;display:grid;place-items:center;
  background:
    radial-gradient(120% 90% at 50% 42%, #241238 0%, #120b1e 46%, #07060f 100%);
  color:#e8dcc0;
  font-family:var(--ui-body,Optima,"Palatino Linotype","Book Antiqua",Palatino,Georgia,serif);
  opacity:1;transition:opacity .55s ease;pointer-events:none;overflow:hidden}
#erebus-load.gone{opacity:0}
/* the stone the plate is carved from — a slow vertical grain, not a flat fill */
#erebus-load::before{content:"";position:absolute;inset:0;pointer-events:none;
  background:
    repeating-linear-gradient(101deg, rgba(255,255,255,.014) 0 2px, rgba(0,0,0,.02) 2px 5px),
    radial-gradient(80% 60% at 50% 30%, rgba(242,193,78,.055), rgba(0,0,0,0) 70%);
  mix-blend-mode:screen}
/* the ink vignette every EREBUS frame carries */
#erebus-load::after{content:"";position:absolute;inset:0;pointer-events:none;
  background:radial-gradient(78% 70% at 50% 50%, rgba(0,0,0,0) 42%, rgba(7,6,15,.86) 100%)}
#erebus-load .plate{position:relative;z-index:2;width:min(620px,82vw);padding:40px 46px 42px;
  text-align:center}
/* width/height are explicit: an absolutely-positioned <svg> has an intrinsic
   aspect ratio, and with only inset:0 the ratio wins over the bottom edge —
   the frame then hung 96px below the plate it is supposed to enclose. */
#erebus-load .frame{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
#erebus-load .mark{font-family:var(--ui-display,"Cinzel","Trajan Pro",Optima,Georgia,serif);
  font-weight:700;letter-spacing:.34em;text-transform:uppercase;font-size:clamp(19px,2.5vw,30px);
  color:#f2c14e;margin:0 0 6px;
  text-shadow:0 2px 0 rgba(4,2,8,.95), 0 0 26px rgba(242,193,78,.30)}
#erebus-load .sub{font-size:11px;letter-spacing:.42em;text-transform:uppercase;
  color:#a2937a;margin:0 0 26px}
/* the rail: a carved channel with a gold pour in it */
#erebus-load .rail{position:relative;height:9px;margin:0 6px;border-radius:1px;
  background:linear-gradient(180deg,#08060e,#150e21 60%,#0c0916);
  box-shadow:inset 0 2px 4px rgba(0,0,0,.95), inset 0 -1px 0 rgba(242,193,78,.12),
             0 0 0 1px rgba(109,68,22,.75), 0 0 22px rgba(0,0,0,.6)}
#erebus-load .fill{position:absolute;left:0;top:0;bottom:0;width:0%;
  background:linear-gradient(180deg,#ffe9a8 0%,#f2c14e 38%,#c98f2b 72%,#6d4416 100%);
  box-shadow:0 0 14px rgba(242,193,78,.55), 0 0 3px rgba(255,233,168,.9);
  transition:width .28s cubic-bezier(.22,.9,.3,1)}
/* the light sweep across the gold (§6 motion) */
#erebus-load .fill::after{content:"";position:absolute;inset:0;
  background:linear-gradient(100deg,rgba(255,255,255,0) 30%,rgba(255,247,214,.55) 50%,rgba(255,255,255,0) 70%);
  background-size:280% 100%;animation:erebus-sweep 2.4s linear infinite}
@keyframes erebus-sweep{from{background-position:180% 0}to{background-position:-80% 0}}
#erebus-load .beads{display:flex;justify-content:space-between;margin:7px 6px 0;opacity:.8}
#erebus-load .beads i{width:3px;height:3px;border-radius:50%;background:#6d4416;
  box-shadow:0 0 4px rgba(242,193,78,.35)}
#erebus-load .beads i.lit{background:#f2c14e;box-shadow:0 0 7px rgba(242,193,78,.85)}
#erebus-load .row{display:flex;justify-content:space-between;align-items:baseline;
  margin:18px 6px 0;font-size:12px;letter-spacing:.2em;text-transform:uppercase}
#erebus-load .phase{color:#e8dcc0}
#erebus-load .pct{font-family:var(--ui-display,"Cinzel",Georgia,serif);font-weight:700;
  font-variant-numeric:lining-nums tabular-nums;font-size:16px;color:#f2c14e;
  text-shadow:0 0 14px rgba(242,193,78,.45)}
#erebus-load .note{margin:14px 6px 0;font-size:10.5px;letter-spacing:.16em;color:#6f6455;
  text-transform:uppercase;min-height:13px}
@media (prefers-reduced-motion: reduce){
  #erebus-load .fill::after{animation:none}
  #erebus-load .fill{transition:none}
}
`;

// Gold filigree: corner palmettes + a meander band along the top and bottom
// rules. Drawn as one SVG so it scales with the plate and costs nothing.
const FRAME_SVG = (() => {
  const meander = (y, flip) => {
    // a real Greek key, unrolled: 5 strokes per unit, repeated by <pattern>
    const d = 'M0 6 H4 V2 H8 V10 H2 V6';
    return `<g transform="translate(0 ${y}) ${flip ? 'scale(1,-1)' : ''}">
      <path d="${d}" fill="none" stroke="url(#eg)" stroke-width="1.15" opacity=".85"/></g>`;
  };
  return `
<svg class="frame" viewBox="0 0 300 160" preserveAspectRatio="none" aria-hidden="true" stroke-linecap="round">
  <defs>
    <linearGradient id="eg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffe9a8"/><stop offset=".45" stop-color="#f2c14e"/>
      <stop offset="1" stop-color="#6d4416"/>
    </linearGradient>
    <pattern id="ekey" width="10" height="12" patternUnits="userSpaceOnUse">${meander(1, false)}</pattern>
  </defs>
  <rect x="3" y="3" width="294" height="154" fill="none" stroke="url(#eg)" stroke-width="1.4" vector-effect="non-scaling-stroke" opacity=".6"/>
  <rect x="6" y="6" width="288" height="148" fill="none" stroke="url(#eg)" stroke-width=".8" vector-effect="non-scaling-stroke" opacity=".4"/>
  <rect x="10" y="7" width="280" height="12" fill="url(#ekey)" opacity=".55"/>
  <rect x="10" y="141" width="280" height="12" fill="url(#ekey)" opacity=".55"/>
  <g fill="none" stroke="url(#eg)" stroke-width="1.6" vector-effect="non-scaling-stroke" opacity=".95">
    <!-- corner palmettes: a fan of five fronds springing from each corner -->
    <path d="M3 3 q10 0 14 8 M3 3 q6 6 6 14 M3 3 q11 3 12 12 M3 3 q3 10 1 16 M3 3 q14 1 17 5"/>
    <path d="M297 3 q-10 0 -14 8 M297 3 q-6 6 -6 14 M297 3 q-11 3 -12 12 M297 3 q-3 10 -1 16 M297 3 q-14 1 -17 5"/>
    <path d="M3 157 q10 0 14 -8 M3 157 q6 -6 6 -14 M3 157 q11 -3 12 -12 M3 157 q3 -10 1 -16 M3 157 q14 -1 17 -5"/>
    <path d="M297 157 q-10 0 -14 -8 M297 157 q-6 -6 -6 -14 M297 157 q-11 -3 -12 -12 M297 157 q-3 -10 -1 -16 M297 157 q-14 -1 -17 -5"/>
  </g>
</svg>`;
})();

const BEADS = 24;

export class LoadingScreen {
  constructor() {
    this.el = null; this.fill = null; this.pctEl = null; this.phaseEl = null;
    this.noteEl = null; this.beads = null;
    this.p = 0;
  }

  /** Put the gate on screen. Safe to call before anything else exists. */
  mount() {
    if (this.el || typeof document === 'undefined') return this;
    const style = document.createElement('style');
    style.id = 'erebus-load-css';
    style.textContent = CSS;
    document.head.appendChild(style);

    const el = document.createElement('div');
    el.id = 'erebus-load';
    el.innerHTML = `<div class="plate">${FRAME_SVG}
      <h1 class="mark">Erebus</h1>
      <p class="sub">Descent</p>
      <div class="rail"><div class="fill"></div></div>
      <div class="beads">${'<i></i>'.repeat(BEADS)}</div>
      <div class="row"><span class="phase">Kindling the forge</span><span class="pct">0%</span></div>
      <p class="note"></p>
    </div>`;
    document.body.appendChild(el);
    this.el = el;
    this.fill = el.querySelector('.fill');
    this.pctEl = el.querySelector('.pct');
    this.phaseEl = el.querySelector('.phase');
    this.noteEl = el.querySelector('.note');
    this.beads = [...el.querySelectorAll('.beads i')];
    return this;
  }

  /** progress in 0..1, a phase label, and an optional detail line. */
  set(p, phase, note) {
    if (!this.el) return this;
    this.p = Math.max(this.p, Math.min(1, p || 0));       // never runs backwards
    const pct = Math.round(this.p * 100);
    this.fill.style.width = pct + '%';
    this.pctEl.textContent = pct + '%';
    if (phase) this.phaseEl.textContent = phase;
    if (note !== undefined) this.noteEl.textContent = note || '';
    const lit = Math.round(this.p * BEADS);
    for (let i = 0; i < this.beads.length; i++) this.beads[i].classList.toggle('lit', i < lit);
    return this;
  }

  /**
   * Yield to the browser so the paint actually happens. Without this every
   * `set()` between two synchronous phases is invisible — the whole point of a
   * progress bar is that the frame in between gets drawn.
   */
  flush() {
    if (!this.el) return Promise.resolve();
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  }

  done() {
    if (!this.el) return this;
    this.set(1, 'Descend', '');
    const el = this.el, style = document.getElementById('erebus-load-css');
    el.classList.add('gone');
    setTimeout(() => { el.remove(); if (style) style.remove(); }, 700);
    this.el = null;
    return this;
  }
}

export default LoadingScreen;
