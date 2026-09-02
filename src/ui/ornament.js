// OWNER: AGENT-UI
// ---------------------------------------------------------------------------
// EREBUS — THE ORNAMENT ENGINE
//
// Everything the UI is made of is drawn here, procedurally, into a 2D canvas
// context. No image files, no fonts to download, no SVG assets on disk.
//
// The single most important idea in this file is that GOLD IS A MATERIAL, not
// a colour. A flat #f2c14e rectangle reads as a web page. A gold that runs
// bronze-shadow -> gold-mid -> gold-core -> a thin near-white highlight ->
// back down to bronze, with a specular sweep that travels across it, reads as
// struck metal. Every gold surface in the game goes through goldGradient().
//
// The second idea is RELIEF. Carved ornament is never line-art: it has a dark
// undercut on the shadow side and a lit arris on the key side. Every ornament
// primitive here draws undercut -> body -> arris, in that order.
// ---------------------------------------------------------------------------

// ── palette (ART_DIRECTION §2, ink ramp + gold/bronze) ──────────────────────
export const PAL = {
  void:      '#07060f',
  deep:      '#120b1e',
  plum:      '#241238',
  violet:    '#3a1d52',

  goldHi:    '#ffe9a8',
  gold:      '#f2c14e',
  goldMid:   '#c98f2b',
  bronze:    '#6d4416',
  bronzeDark:'#3a2409',
  verdigris: '#3f8f7a',

  blood:     '#c81d3c',
  bloodDeep: '#5c0a1c',
  bloodHi:   '#ff6a72',

  magick:    '#5fd0ff',
  magickDeep:'#123a63',

  ink:       '#0b0714',
  parch:     '#e8dcc0',
  parchDim:  '#a2937a',
};

export const RARITY = {
  common:  { name: 'Common',  ring: ['#8a6a44', '#c9a476', '#5a4028'], text: '#c9a476' },
  rare:    { name: 'Rare',    ring: ['#8fa3bd', '#e6f0ff', '#4d5b70'], text: '#cfdcee' },
  epic:    { name: 'Epic',    ring: ['#c98f2b', '#ffe9a8', '#6d4416'], text: '#f2c14e' },
  heroic:  { name: 'Heroic',  ring: ['#ff8ad2', '#a8f0ff', '#ffe08a'], text: '#ffd6f0', prismatic: true },
  legendary: { name: 'Legendary', ring: ['#ff7a2a', '#ffe08a', '#8a2a06'], text: '#ffb070' },
  duo:     { name: 'Duo',     ring: ['#3fd9a0', '#8ef0d0', '#1a6a4e'], text: '#9af2d4', prismatic: true },
};

/** Colour-blind-safe alternates: hue AND value separated, per §2 registers. */
export const STATUS_COLORS = {
  normal: { life: '#c81d3c', lifeHi: '#e8506a', magick: '#5fd0ff', magickHi: '#9fe6ff', ghost: '#ff7a44', heal: '#9dffc0', danger: '#ff5a3c', ready: '#ffe9a8' },
  safe:   { life: '#e4572e', lifeHi: '#ffb27a', magick: '#3f8fff', magickHi: '#bfe0ff', ghost: '#ffffff', heal: '#ffffff', danger: '#ffd23f', ready: '#ffffff' },
};

// ── type ───────────────────────────────────────────────────────────────────
// The display stack lives in style.css so it is authored in one place; we read
// it back so canvas text and any DOM chrome can never drift apart.
let _display = null, _body = null;
function cssVar(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name);
    if (v && v.trim()) return v.trim();
  } catch (e) { /* headless before style applies */ }
  return fallback;
}
export function displayFont() {
  if (_display === null) _display = cssVar('--ui-display', '"Cinzel","Trajan Pro",Optima,"Palatino Linotype","Book Antiqua",Georgia,"Bitstream Charter","DejaVu Serif",serif');
  return _display;
}
export function bodyFont() {
  if (_body === null) _body = cssVar('--ui-body', 'Optima,"Palatino Linotype",Georgia,"Bitstream Charter","DejaVu Serif",serif');
  return _body;
}

/** Draw text with real letter-spacing (canvas has none we can rely on). */
export function tracked(g, text, x, y, o = {}) {
  const size = o.size || 16;
  const track = (o.track != null ? o.track : 0.12) * size;
  const font = `${o.weight || 600} ${size}px ${o.font || displayFont()}`;
  g.font = font;
  g.textBaseline = o.baseline || 'alphabetic';
  const s = o.caps === false ? text : String(text);
  const chars = [...s];
  let w = 0;
  for (const c of chars) w += g.measureText(c).width + track;
  w -= track;
  let cx = x;
  if (o.align === 'center') cx = x - w / 2;
  else if (o.align === 'right') cx = x - w;

  const paint = (fill, dx, dy) => {
    g.fillStyle = fill;
    let p = cx + dx;
    for (const c of chars) { g.fillText(c, p, y + dy); p += g.measureText(c).width + track; }
  };
  if (o.shadow) {
    g.save(); g.globalAlpha = (o.shadowAlpha != null ? o.shadowAlpha : 0.85) * (o.alpha != null ? o.alpha : 1);
    paint(o.shadow, o.shadowDx || 0, o.shadowDy != null ? o.shadowDy : 2);
    g.restore();
  }
  g.save();
  if (o.alpha != null) g.globalAlpha *= o.alpha;
  if (o.gradient) {
    g.fillStyle = o.gradient;
  } else if (o.gold) {
    g.fillStyle = goldGradient(g, cx, y - size * 0.78, cx, y + size * 0.18, o.sweep);
  } else {
    g.fillStyle = o.color || PAL.parch;
  }
  let p = cx;
  for (const c of chars) { g.fillText(c, p, y); p += g.measureText(c).width + track; }
  g.restore();
  return w;
}

export function trackedWidth(g, text, o = {}) {
  const size = o.size || 16;
  const track = (o.track != null ? o.track : 0.12) * size;
  g.font = `${o.weight || 600} ${size}px ${o.font || displayFont()}`;
  let w = 0; for (const c of [...String(text)]) w += g.measureText(c).width + track;
  return Math.max(0, w - track);
}

/** Greedy word wrap. Returns an array of lines. */
export function wrap(g, text, maxW, o = {}) {
  g.font = `${o.weight || 400} ${o.size || 15}px ${o.font || bodyFont()}`;
  const words = String(text).split(/\s+/);
  const lines = []; let line = '';
  for (const w of words) {
    const t = line ? line + ' ' + w : w;
    if (g.measureText(t).width > maxW && line) { lines.push(line); line = w; }
    else line = t;
  }
  if (line) lines.push(line);
  return lines;
}

// ── geometry helpers ───────────────────────────────────────────────────────
export function roundRect(g, x, y, w, h, r) {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.lineTo(x + w - rr, y); g.quadraticCurveTo(x + w, y, x + w, y + rr);
  g.lineTo(x + w, y + h - rr); g.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  g.lineTo(x + rr, y + h); g.quadraticCurveTo(x, y + h, x, y + h - rr);
  g.lineTo(x, y + rr); g.quadraticCurveTo(x, y, x + rr, y);
  g.closePath();
}

/** A chamfered plaque outline — the shape carved stone actually takes. */
export function plaqueRect(g, x, y, w, h, c) {
  const cc = Math.min(c, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + cc, y); g.lineTo(x + w - cc, y); g.lineTo(x + w, y + cc);
  g.lineTo(x + w, y + h - cc); g.lineTo(x + w - cc, y + h); g.lineTo(x + cc, y + h);
  g.lineTo(x, y + h - cc); g.lineTo(x, y + cc); g.closePath();
}

// ── GOLD ───────────────────────────────────────────────────────────────────
const GOLD_STOPS = [
  [0.00, '#4a2c0e'], [0.10, '#7a4f14'], [0.24, '#a5711f'],
  [0.40, '#d9a13a'], [0.50, '#f2c14e'], [0.58, '#e0ae3e'],
  [0.74, '#a5711f'], [0.88, '#6d4416'], [1.00, '#3a2409'],
];

/**
 * The gold material. `sweep` (0..1, or null) places a narrow near-white
 * specular band travelling along the gradient axis — this is what makes gold
 * read as metal catching a light rather than as a flat swatch.
 */
export function goldGradient(g, x0, y0, x1, y1, sweep = null, o = {}) {
  const grd = g.createLinearGradient(x0, y0, x1, y1);
  const tone = o.tone || 1;
  for (const [p, c] of GOLD_STOPS) grd.addColorStop(p, tone === 1 ? c : mix(c, o.toneColor || '#2a1a08', 1 - tone));
  if (sweep != null) {
    const s = sweep - Math.floor(sweep);
    const wdt = o.sweepWidth || 0.085;
    const a = Math.max(0.001, s - wdt), b = Math.min(0.999, s + wdt);
    if (b > a) {
      grd.addColorStop(a, sampleGold(a, tone));
      grd.addColorStop(Math.min(0.999, s), o.sweepColor || '#fff3cf');
      grd.addColorStop(b, sampleGold(b, tone));
    }
  }
  return grd;
}

function sampleGold(t, tone = 1) {
  let lo = GOLD_STOPS[0], hi = GOLD_STOPS[GOLD_STOPS.length - 1];
  for (let i = 0; i < GOLD_STOPS.length - 1; i++) {
    if (t >= GOLD_STOPS[i][0] && t <= GOLD_STOPS[i + 1][0]) { lo = GOLD_STOPS[i]; hi = GOLD_STOPS[i + 1]; break; }
  }
  const f = (t - lo[0]) / Math.max(1e-6, hi[0] - lo[0]);
  const c = mix(lo[1], hi[1], f);
  return tone === 1 ? c : mix(c, '#2a1a08', 1 - tone);
}

export function mix(a, b, t) {
  const A = hex(a), B = hex(b);
  return `rgb(${Math.round(A[0] + (B[0] - A[0]) * t)},${Math.round(A[1] + (B[1] - A[1]) * t)},${Math.round(A[2] + (B[2] - A[2]) * t)})`;
}
export function hex(h) {
  if (h[0] !== '#') { const m = h.match(/[\d.]+/g); return m ? [+m[0], +m[1], +m[2]] : [255, 0, 255]; }
  let s = h.slice(1); if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  const n = parseInt(s, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function rgba(h, a) { const c = hex(h); return `rgba(${c[0]},${c[1]},${c[2]},${a})`; }
/** Perceptual-ish darkening that keeps hue — never lerp toward grey. */
export function shade(h, t) { return mix(h, '#160c22', t); }
export function lift(h, t) { return mix(h, '#fff4dc', t); }

// ── panel body: obsidian with a soft inner shadow and a warm top bounce ────
export function panelBody(g, x, y, w, h, o = {}) {
  const r = o.r != null ? o.r : 6;
  g.save();
  (o.chamfer ? plaqueRect : roundRect)(g, x, y, w, h, o.chamfer || r);
  const grd = g.createLinearGradient(x, y, x, y + h);
  grd.addColorStop(0, o.top || '#1c1229');
  grd.addColorStop(0.45, o.mid || '#130c1e');
  grd.addColorStop(1, o.bot || '#0a0613');
  g.fillStyle = grd; g.fill();

  // warm bounce from the arena, low on the panel
  g.save(); g.clip();
  const warm = g.createRadialGradient(x + w * 0.5, y + h * 1.25, 0, x + w * 0.5, y + h * 1.25, h * 1.5);
  warm.addColorStop(0, rgba(o.bounce || '#ff5a3c', 0.10));
  warm.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = warm; g.fillRect(x, y, w, h);

  // inner shadow — clip + blurred inward stroke
  g.shadowColor = 'rgba(0,0,0,0.85)';
  g.shadowBlur = Math.max(4, h * 0.16);
  g.shadowOffsetY = 2;
  g.lineWidth = Math.max(3, h * 0.1);
  g.strokeStyle = 'rgba(0,0,0,0.9)';
  (o.chamfer ? plaqueRect : roundRect)(g, x, y, w, h, o.chamfer || r);
  g.stroke();
  g.restore();
  g.restore();
}

// ── MEANDER (greek key) — carved bars, tiles cleanly on any length ─────────
/**
 * Draws a running fret along a horizontal (or vertical, via `vertical`) band.
 * The unit is re-derived from the length so the band ALWAYS ends on a whole
 * unit: `t` (the carved bar thickness) is len/(units*7).
 */
export function meander(g, x, y, len, h, o = {}) {
  if (len <= 2 || h <= 2) return;
  const flip = !!o.flip;
  const idealUnit = (7 / 5) * h;
  const n = Math.max(1, Math.round(len / idealUnit));
  const unit = len / n;
  const t = unit / 7;
  const bandH = 5 * t;
  const y0 = y + (h - bandH) / 2;
  const sweep = o.sweep;

  const bars = [];
  for (let i = 0; i < n; i++) {
    const ox = x + i * unit;
    // y measured DOWN from the top of the band; flip mirrors the spiral
    const Y = (a, b) => flip ? [bandH - b, bandH - a] : [a, b];
    const push = (bx, by0, by1, bw) => { const [A, B] = Y(by0, by1); bars.push([ox + bx, y0 + A, bw, B - A]); };
    push(0, 4 * t, 5 * t, 7 * t);      // rail (continuous across units)
    push(0, t, 4 * t, t);              // outer riser
    push(t, t, 2 * t, 4 * t);          // top bar
    push(4 * t, 2 * t, 3 * t, t);      // inner riser
    push(2 * t, 2 * t, 3 * t, 2 * t);  // inner return
  }

  const d = Math.max(1, t * 0.34);
  // 1. undercut — the dark channel the carving sits in
  g.fillStyle = o.undercut || 'rgba(6,3,12,0.92)';
  for (const b of bars) g.fillRect(b[0] + d, b[1] + d, b[2], b[3]);
  // 2. body
  g.fillStyle = o.color || goldGradient(g, x, y0, x, y0 + bandH, sweep, { tone: o.tone || 1 });
  for (const b of bars) g.fillRect(b[0], b[1], b[2], b[3]);
  // 3. lit arris on the key side
  g.fillStyle = o.arris || rgba(PAL.goldHi, 0.5);
  for (const b of bars) {
    g.fillRect(b[0], b[1], b[2], Math.max(0.75, d * 0.55));
    g.fillRect(b[0], b[1], Math.max(0.75, d * 0.55), b[3]);
  }
}

// ── BEADED INNER RULE ──────────────────────────────────────────────────────
export function beadRule(g, x, y, len, r, o = {}) {
  if (len <= 0 || r <= 0.3) return;
  const gap = r * 2.55;
  const n = Math.max(1, Math.round(len / gap));
  const step = len / n;
  const vert = !!o.vertical;
  for (let i = 0; i <= n; i++) {
    const p = i * step;
    const cx = vert ? x : x + p, cy = vert ? y + p : y;
    // seat
    g.beginPath(); g.arc(cx + r * 0.22, cy + r * 0.26, r * 1.02, 0, 6.2832);
    g.fillStyle = 'rgba(6,3,12,0.85)'; g.fill();
    // bead
    const grd = g.createRadialGradient(cx - r * 0.36, cy - r * 0.42, r * 0.08, cx, cy, r * 1.12);
    grd.addColorStop(0, o.hi || '#ffeec0');
    grd.addColorStop(0.36, o.mid || '#e2b349');
    grd.addColorStop(0.72, '#a5711f');
    grd.addColorStop(1, '#4d2f0d');
    g.beginPath(); g.arc(cx, cy, r, 0, 6.2832); g.fillStyle = grd; g.fill();
  }
}

// ── EGG AND DART ───────────────────────────────────────────────────────────
export function eggAndDart(g, x, y, len, h, o = {}) {
  if (len <= 4 || h <= 3) return;
  const n = Math.max(1, Math.round(len / (h * 1.15)));
  const step = len / n;
  const eggW = step * 0.56, eggH = h * 0.86;
  for (let i = 0; i < n; i++) {
    const cx = x + (i + 0.5) * step, cy = y + h * 0.5;
    // shell (the surround) — a slightly larger arc, darker
    g.beginPath(); g.ellipse(cx, cy, eggW * 0.62, eggH * 0.56, 0, 0, 6.2832);
    g.fillStyle = 'rgba(8,4,14,0.9)'; g.fill();
    // egg
    const grd = g.createRadialGradient(cx - eggW * 0.2, cy - eggH * 0.26, eggW * 0.05, cx, cy, eggW * 0.62);
    grd.addColorStop(0, '#ffe9a8'); grd.addColorStop(0.45, '#d9a13a');
    grd.addColorStop(0.8, '#8f5f1c'); grd.addColorStop(1, '#4a2c0e');
    g.beginPath(); g.ellipse(cx, cy, eggW * 0.5, eggH * 0.46, 0, 0, 6.2832);
    g.fillStyle = grd; g.fill();
    // dart between eggs
    const dx = x + (i + 1) * step;
    if (i < n - 1 || o.closeDarts) {
      g.beginPath();
      g.moveTo(dx, y + h * 0.06); g.lineTo(dx + h * 0.12, y + h * 0.36);
      g.lineTo(dx, y + h * 0.94); g.lineTo(dx - h * 0.12, y + h * 0.36);
      g.closePath();
      g.fillStyle = goldGradient(g, dx, y, dx, y + h, o.sweep);
      g.fill();
    }
  }
}

// ── LAUREL ─────────────────────────────────────────────────────────────────
/** A laurel spray along an arc. `arc` in radians, centred on -PI/2 (upward). */
export function laurel(g, cx, cy, r, o = {}) {
  const from = o.from != null ? o.from : Math.PI * 0.62;
  const to = o.to != null ? o.to : Math.PI * 0.38;
  const n = o.leaves || 9;
  const side = o.side || 1;
  const len = r * (o.leafLen || 0.42);
  g.save();
  // stem
  g.beginPath();
  g.arc(cx, cy, r, (side > 0 ? Math.PI - from : Math.PI + from), (side > 0 ? Math.PI - to : Math.PI + to), side < 0);
  g.strokeStyle = o.stem || rgba(PAL.bronze, 0.95);
  g.lineWidth = Math.max(1.2, r * 0.035); g.stroke();
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1);
    const a = (side > 0)
      ? (Math.PI - from) + f * ((Math.PI - to) - (Math.PI - from))
      : (Math.PI + from) + f * ((Math.PI + to) - (Math.PI + from));
    const px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r;
    const tang = a + Math.PI / 2 * (side > 0 ? 1 : -1);
    const scale = 0.55 + 0.45 * Math.sin(f * Math.PI);
    // a second, shorter leaf on the inside of the stem gives the spray body
    leaf(g, px, py, tang + (o.tilt || 0.62) * side, len * scale, len * 0.40 * scale, o);
    leaf(g, px, py, tang - (o.tilt || 0.62) * side * 0.55, len * scale * 0.58, len * 0.30 * scale, o);
  }
  g.restore();
}

/**
 * A laurel BRANCH: a bowed stem with paired leaves whose length follows a sine
 * envelope, and a terminal berry. Reads as laurel at header sizes where a
 * wreath arc just reads as a squiggle.
 */
export function laurelBranch(g, x, y, len, dir = 1, o = {}) {
  const n = o.leaves || 7;
  const bow = o.bow != null ? o.bow : 0.30;
  const ex = x + dir * len, ey = y - len * bow * 0.42;
  const cx = x + dir * len * 0.52, cy = y + len * bow * 0.42;
  const P = (t) => { const m = 1 - t; return [m * m * x + 2 * m * t * cx + t * t * ex, m * m * y + 2 * m * t * cy + t * t * ey]; };
  g.save();
  g.beginPath();
  for (let i = 0; i <= 22; i++) { const q = P(i / 22); i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]); }
  g.strokeStyle = o.stem || rgba(PAL.bronze, 0.95);
  g.lineWidth = Math.max(1.1, len * 0.020); g.lineCap = 'round'; g.stroke();
  for (let i = 0; i < n; i++) {
    const t = 0.08 + (i / (n - 1)) * 0.88;
    const a = P(t), b = P(Math.min(1, t + 0.03));
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const env = 0.42 + 0.58 * Math.sin(t * Math.PI);
    const L = len * (o.leafLen || 0.30) * env, W = L * 0.36;
    leaf(g, a[0], a[1], ang - 0.92, L, W, o);
    leaf(g, a[0], a[1], ang + 0.92, L * 0.88, W * 0.92, o);
  }
  const e = P(1);
  const bg = g.createRadialGradient(e[0] - len * 0.012, e[1] - len * 0.014, 0, e[0], e[1], len * 0.05);
  bg.addColorStop(0, '#ffe9a8'); bg.addColorStop(0.6, '#c98f2b'); bg.addColorStop(1, '#4a2c0e');
  g.beginPath(); g.arc(e[0], e[1], len * 0.045, 0, 6.2832); g.fillStyle = bg; g.fill();
  g.restore();
}

function leaf(g, x, y, ang, L, W, o = {}) {
  g.save(); g.translate(x, y); g.rotate(ang);
  g.beginPath();
  g.moveTo(0, 0);
  g.quadraticCurveTo(L * 0.42, -W, L, 0);
  g.quadraticCurveTo(L * 0.42, W, 0, 0);
  g.closePath();
  const grd = g.createLinearGradient(0, -W, L, W);
  grd.addColorStop(0, o.leafHi || '#ffe9a8');
  grd.addColorStop(0.5, o.leafMid || '#c98f2b');
  grd.addColorStop(1, o.leafLo || '#5a370f');
  g.fillStyle = grd; g.fill();
  g.beginPath(); g.moveTo(0, 0); g.lineTo(L * 0.94, 0);
  g.strokeStyle = 'rgba(20,10,4,0.55)'; g.lineWidth = Math.max(0.6, W * 0.14); g.stroke();
  g.restore();
}

// ── ACANTHUS SCROLL / VOLUTE ───────────────────────────────────────────────
/** A tapering spiral — the backbone of every corner ornament. */
export function acanthusScroll(g, x, y, s, o = {}) {
  const turns = o.turns || 1.65, steps = 46;
  const dir = o.flipX ? -1 : 1, dy = o.flipY ? -1 : 1;
  const a0 = o.a0 != null ? o.a0 : -Math.PI * 0.15;
  g.save(); g.translate(x, y);
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const a = a0 + f * turns * Math.PI * 2;
    const rr = s * (1 - f * 0.86);
    pts.push([dir * Math.cos(a) * rr, dy * Math.sin(a) * rr, (1 - f)]);
  }
  // undercut
  for (let pass = 0; pass < 2; pass++) {
    g.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const ox = pass === 0 ? s * 0.05 : 0, oy = pass === 0 ? s * 0.05 : 0;
      if (i === 0) g.moveTo(p[0] + ox, p[1] + oy); else g.lineTo(p[0] + ox, p[1] + oy);
    }
    g.lineCap = 'round'; g.lineJoin = 'round';
    if (pass === 0) { g.strokeStyle = 'rgba(6,3,12,0.9)'; g.lineWidth = s * 0.20; g.stroke(); }
    else {
      // tapering body: stroke in segments with decreasing width
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i - 1], q = pts[i];
        g.beginPath(); g.moveTo(p[0], p[1]); g.lineTo(q[0], q[1]);
        g.lineWidth = s * (0.05 + 0.13 * p[2]);
        g.strokeStyle = sampleGold(0.28 + 0.5 * p[2]);
        g.stroke();
      }
    }
  }
  g.restore();
}

// ── PALMETTE — the corner ornament ─────────────────────────────────────────
/**
 * A fan of lobes over a pair of opposed volutes. `s` is the overall radius,
 * `rot` orients it (corners use 45°, edges use 90° multiples).
 */
export function palmette(g, x, y, s, o = {}) {
  const rot = o.rot || 0;
  const lobes = o.lobes || 7;
  const spread = o.spread || Math.PI * 0.86;
  g.save(); g.translate(x, y); g.rotate(rot);
  if (o.mirror) g.scale(-1, 1);

  // volute base
  acanthusScroll(g, -s * 0.30, s * 0.16, s * 0.30, { flipX: true, turns: 1.35, a0: Math.PI * 0.2 });
  acanthusScroll(g, s * 0.30, s * 0.16, s * 0.30, { turns: 1.35, a0: Math.PI * 0.8 });

  // fan of lobes
  for (let i = 0; i < lobes; i++) {
    const f = lobes === 1 ? 0.5 : i / (lobes - 1);
    const a = -Math.PI / 2 + (f - 0.5) * spread;
    const scale = 0.55 + 0.45 * Math.sin(f * Math.PI);
    const L = s * (o.lobeLen || 0.92) * scale;
    const W = s * 0.155 * scale;
    // undercut
    g.save(); g.translate(s * 0.035, s * 0.045);
    petal(g, 0, s * 0.05, a, L, W, 'rgba(6,3,12,0.9)');
    g.restore();
    petal(g, 0, s * 0.05, a, L, W, null, o.sweep);
  }
  // heart / seed at the base
  g.beginPath(); g.ellipse(0, s * 0.13, s * 0.13, s * 0.10, 0, 0, 6.2832);
  const seed = g.createRadialGradient(-s * 0.04, s * 0.09, s * 0.01, 0, s * 0.13, s * 0.15);
  seed.addColorStop(0, '#ffe9a8'); seed.addColorStop(0.6, '#c98f2b'); seed.addColorStop(1, '#4a2c0e');
  g.fillStyle = seed; g.fill();
  g.restore();
}

function petal(g, ox, oy, ang, L, W, flat, sweep) {
  g.save(); g.translate(ox, oy); g.rotate(ang + Math.PI / 2);
  g.beginPath();
  g.moveTo(0, 0);
  g.bezierCurveTo(W * 1.5, -L * 0.30, W * 0.95, -L * 0.80, 0, -L);
  g.bezierCurveTo(-W * 0.95, -L * 0.80, -W * 1.5, -L * 0.30, 0, 0);
  g.closePath();
  if (flat) { g.fillStyle = flat; g.fill(); g.restore(); return; }
  const grd = g.createLinearGradient(-W, 0, W, -L);
  grd.addColorStop(0, '#5a370f'); grd.addColorStop(0.34, '#c98f2b');
  grd.addColorStop(0.62, sweep != null ? '#ffe9a8' : '#e6b849'); grd.addColorStop(1, '#8f5f1c');
  g.fillStyle = grd; g.fill();
  // central rib
  g.beginPath(); g.moveTo(0, -L * 0.08); g.lineTo(0, -L * 0.9);
  g.strokeStyle = 'rgba(24,12,4,0.5)'; g.lineWidth = Math.max(0.6, W * 0.22); g.stroke();
  g.restore();
}

// ── THE FRAME — wrap any panel in a full ornate border ─────────────────────
/**
 * frame(target, opts)
 *   target: a CanvasRenderingContext2D (drawn in place) or an HTMLElement
 *           (rendered offscreen and applied as a background-image).
 *   opts:   { x,y,w,h, weight, r, meander:true, bead:true, eggDart:false,
 *             palmettes:'corners'|'top'|false, edge:'#hex' (god edge light),
 *             glow, sweep, fill:{top,mid,bot,bounce}, body:true }
 */
export function frame(target, opts = {}) {
  if (target && target.nodeType === 1) return frameElement(target, opts);
  const g = target;
  const o = opts;
  const x = o.x || 0, y = o.y || 0, w = o.w || 100, h = o.h || 100;
  const W = o.weight || 1;                      // ornament scale
  const r = o.r != null ? o.r : 5 * W;
  const edge = o.edge || null;
  const sweep = o.sweep;

  g.save();

  // 0. outer glow — warm, low, never a bloom bath (§9)
  if (o.glow !== false) {
    g.save();
    g.shadowColor = rgba(edge || PAL.gold, o.glowAlpha != null ? o.glowAlpha : 0.28);
    g.shadowBlur = 22 * W;
    roundRect(g, x, y, w, h, r);
    g.fillStyle = 'rgba(0,0,0,0.65)'; g.fill();
    g.restore();
  }

  // 1. panel body
  if (o.body !== false) panelBody(g, x, y, w, h, { r, ...(o.fill || {}) });

  // 2. outer bronze bevel — two strokes, dark under, lit over
  g.lineJoin = 'miter';
  roundRect(g, x - 1.5 * W, y - 1.5 * W, w + 3 * W, h + 3 * W, r + 1.5 * W);
  g.strokeStyle = '#1a1006'; g.lineWidth = 3.5 * W; g.stroke();

  roundRect(g, x, y, w, h, r);
  g.strokeStyle = goldGradient(g, x, y, x + w * 0.35, y + h, sweep);
  g.lineWidth = 2.6 * W; g.stroke();

  // a hairline highlight along the top-left arris only
  g.save();
  roundRect(g, x + 0.9 * W, y + 0.9 * W, w - 1.8 * W, h - 1.8 * W, Math.max(0, r - W));
  g.strokeStyle = rgba(PAL.goldHi, 0.45); g.lineWidth = Math.max(0.7, 0.8 * W); g.stroke();
  g.restore();

  // 3. god-colour edge light
  if (edge) {
    g.save();
    g.globalCompositeOperation = 'lighter';
    roundRect(g, x - 0.6 * W, y - 0.6 * W, w + 1.2 * W, h + 1.2 * W, r + 0.6 * W);
    g.strokeStyle = rgba(edge, o.edgeAlpha != null ? o.edgeAlpha : 0.5);
    g.lineWidth = 1.6 * W; g.stroke();
    g.restore();
  }

  const pad = (o.pad != null ? o.pad : 6) * W;

  // 4. meander band along the top (and bottom if asked)
  if (o.meander) {
    const bh = (o.meanderH || 9) * W;
    const inset = pad + 2 * W;
    meander(g, x + inset, y + pad, w - inset * 2, bh, { sweep });
    if (o.meander === 'both')
      meander(g, x + inset, y + h - pad - bh, w - inset * 2, bh, { sweep, flip: true });
  }

  // 5. egg-and-dart moulding (used on hero panels)
  if (o.eggDart) {
    const eh = (o.eggDartH || 11) * W;
    eggAndDart(g, x + pad + 2 * W, y + h - pad - eh, w - (pad + 2 * W) * 2, eh, { sweep });
  }

  // 6. beaded inner rule
  if (o.bead !== false) {
    const br = (o.beadR || 1.6) * W;
    const ix = x + pad + br, iy = y + pad + br;
    const iw = w - (pad + br) * 2, ih = h - (pad + br) * 2;
    const top = (o.meander ? y + pad + (o.meanderH || 9) * W + 3 * W : iy);
    const bot = iy + ih;
    g.save();
    beadRule(g, ix, top, iw, br);
    beadRule(g, ix, bot, iw, br);
    beadRule(g, ix, top, bot - top, br, { vertical: true });
    beadRule(g, ix + iw, top, bot - top, br, { vertical: true });
    g.restore();
  }

  // 7. corner palmettes
  if (o.palmettes !== false) {
    const s = (o.palmetteS || 15) * W;
    const k = r * 0.55;
    const corners = [
      [x + k, y + k, Math.PI * 0.75, false],
      [x + w - k, y + k, -Math.PI * 0.75, true],
      [x + k, y + h - k, Math.PI * 0.25, true],
      [x + w - k, y + h - k, -Math.PI * 0.25, false],
    ];
    for (const c of corners) palmette(g, c[0], c[1], s, { rot: c[2], mirror: c[3], sweep });
    if (o.palmettes === 'crest') {
      palmette(g, x + w / 2, y - s * 0.32, s * 1.5, { rot: 0, sweep });
    }
  }

  g.restore();
  return g;
}

/** DOM convenience: bake the same frame into a background-image. */
export function frameElement(el, opts = {}) {
  const w = opts.w || el.clientWidth || 240, h = opts.h || el.clientHeight || 120;
  const dpr = Math.min(2, (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1));
  const c = document.createElement('canvas');
  c.width = Math.ceil(w * dpr); c.height = Math.ceil(h * dpr);
  const g = c.getContext('2d'); g.scale(dpr, dpr);
  frame(g, { ...opts, x: 4, y: 4, w: w - 8, h: h - 8 });
  el.style.backgroundImage = `url(${c.toDataURL('image/png')})`;
  el.style.backgroundSize = '100% 100%';
  return el;
}

// ── KEY CAP — a carved bronze key with its label, for prompts and hints ───
export function keyCap(g, x, y, w, h, label, o = {}) {
  const r = o.r != null ? o.r : Math.min(4, h * 0.22);
  const pad = !!o.pad;                    // gamepad glyphs are round, keys are square
  g.save();
  if (pad) { g.beginPath(); g.arc(x + w / 2, y + h / 2, Math.min(w, h) / 2, 0, 6.2832); }
  else plaqueRect(g, x, y, w, h, r);
  const kg = g.createLinearGradient(x, y, x, y + h);
  kg.addColorStop(0, o.top || '#3a2b16'); kg.addColorStop(1, o.bot || '#160e08');
  g.fillStyle = kg; g.fill();
  g.strokeStyle = o.edge || rgba(PAL.gold, o.edgeAlpha != null ? o.edgeAlpha : 0.8); g.lineWidth = o.lineWidth || 1.1; g.stroke();
  // a lit top arris so the cap reads as raised
  g.save(); g.clip();
  g.fillStyle = rgba(PAL.goldHi, 0.22); g.fillRect(x, y, w, Math.max(1, h * 0.12));
  g.restore();
  const size = o.size || Math.min(h * 0.58, w * 0.9 / Math.max(1, String(label).length * 0.62));
  tracked(g, String(label), x + w / 2, y + h * 0.5 + size * 0.36, {
    size, track: 0.02, weight: 700, align: 'center', color: o.color || '#ffe9a8', font: o.font,
  });
  g.restore();
  return w;
}

/**
 * A cooldown ring: a full gold ring when ready, otherwise a dark wedge that
 * empties clockwise as `frac` (remaining 0..1) falls. `ready` pulses once.
 */
export function cooldownRing(g, cx, cy, r, frac, o = {}) {
  const w = o.width || Math.max(1.5, r * 0.16);
  g.save();
  g.beginPath(); g.arc(cx, cy, r, 0, 6.2832);
  g.strokeStyle = 'rgba(5,2,10,0.85)'; g.lineWidth = w * 1.8; g.stroke();
  if (frac > 0.002) {
    // the spent arc, dim bronze
    g.beginPath(); g.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + 6.2832 * frac);
    g.strokeStyle = rgba(PAL.bronze, 0.75); g.lineWidth = w; g.stroke();
    // the recovered arc in the accent colour
    g.beginPath(); g.arc(cx, cy, r, -Math.PI / 2 + 6.2832 * frac, -Math.PI / 2 + 6.2832);
    g.strokeStyle = o.color || PAL.gold; g.lineWidth = w; g.stroke();
    // the leading edge, bright
    const a = -Math.PI / 2 + 6.2832 * frac;
    g.beginPath(); g.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, w * 0.55, 0, 6.2832);
    g.fillStyle = rgba(o.hi || PAL.goldHi, 0.95); g.fill();
  } else {
    g.beginPath(); g.arc(cx, cy, r, 0, 6.2832);
    g.strokeStyle = o.readyGradient || goldGradient(g, cx - r, cy - r, cx + r, cy + r, o.sweep); g.lineWidth = w; g.stroke();
    if (o.pulse > 0) {
      g.save(); g.globalCompositeOperation = 'lighter'; g.globalAlpha *= o.pulse;
      g.beginPath(); g.arc(cx, cy, r + w * (1 + (1 - o.pulse) * 3), 0, 6.2832);
      g.strokeStyle = rgba(o.hi || PAL.goldHi, 0.8); g.lineWidth = w * 0.8; g.stroke();
      g.restore();
    }
  }
  g.restore();
}

/** Small UI icons for toasts and banners, drawn in one colour at radius r. */
export function uiIcon(g, kind, cx, cy, r, color) {
  g.save(); g.translate(cx, cy);
  g.fillStyle = color; g.strokeStyle = color; g.lineWidth = Math.max(1, r * 0.18); g.lineJoin = 'round'; g.lineCap = 'round';
  switch (kind) {
    case 'skull':
      g.beginPath(); g.arc(0, -r * 0.15, r * 0.62, Math.PI, 0); g.lineTo(r * 0.45, r * 0.5); g.lineTo(-r * 0.45, r * 0.5); g.closePath(); g.fill();
      g.fillStyle = 'rgba(5,2,10,0.9)';
      g.beginPath(); g.arc(-r * 0.25, -r * 0.15, r * 0.16, 0, 6.2832); g.fill();
      g.beginPath(); g.arc(r * 0.25, -r * 0.15, r * 0.16, 0, 6.2832); g.fill();
      g.fillRect(-r * 0.3, r * 0.5, r * 0.6, r * 0.32);
      g.fillStyle = color; for (let i = -1; i <= 1; i++) g.fillRect(i * r * 0.2 - r * 0.06, r * 0.5, r * 0.12, r * 0.32);
      break;
    case 'laurel':
      for (const s of [-1, 1]) {
        for (let i = 0; i < 4; i++) {
          const a = -Math.PI / 2 + s * (0.35 + i * 0.42);
          const px = Math.cos(a) * r * 0.75, py = Math.sin(a) * r * 0.75 + r * 0.2;
          g.save(); g.translate(px, py); g.rotate(a + s * 0.9);
          g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(r * 0.22, -r * 0.16, r * 0.42, 0); g.quadraticCurveTo(r * 0.22, r * 0.16, 0, 0); g.fill();
          g.restore();
        }
      }
      break;
    case 'coin':
      g.beginPath(); g.arc(0, 0, r * 0.8, 0, 6.2832); g.fill();
      g.strokeStyle = 'rgba(5,2,10,0.7)'; g.beginPath(); g.arc(0, 0, r * 0.45, 0, 6.2832); g.stroke();
      break;
    case 'heart':
      g.beginPath(); g.moveTo(0, r * 0.85); g.bezierCurveTo(-r * 1.0, r * 0.05, -r * 0.6, -r * 0.85, 0, -r * 0.3);
      g.bezierCurveTo(r * 0.6, -r * 0.85, r * 1.0, r * 0.05, 0, r * 0.85); g.closePath(); g.fill();
      break;
    case 'bolt':
      g.beginPath(); g.moveTo(-r * 0.1, -r * 0.9); g.lineTo(r * 0.45, -r * 0.2); g.lineTo(r * 0.1, -r * 0.14); g.lineTo(r * 0.5, r * 0.9);
      g.lineTo(-r * 0.45, r * 0.05); g.lineTo(0, 0); g.lineTo(-r * 0.4, -r * 0.45); g.closePath(); g.fill();
      break;
    case 'door':
      g.beginPath(); g.moveTo(-r * 0.6, r * 0.9); g.lineTo(-r * 0.6, -r * 0.3); g.arc(0, -r * 0.3, r * 0.6, Math.PI, 0); g.lineTo(r * 0.6, r * 0.9); g.closePath(); g.stroke();
      g.beginPath(); g.arc(r * 0.25, r * 0.25, r * 0.1, 0, 6.2832); g.fill();
      break;
    case 'star':
      g.beginPath();
      for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5; const rr = i % 2 ? r * 0.4 : r * 0.95; i ? g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : g.moveTo(Math.cos(a) * rr, Math.sin(a) * rr); }
      g.closePath(); g.fill();
      break;
    case 'hammer':
      g.save(); g.rotate(-0.6); g.fillRect(-r * 0.1, -r * 0.1, r * 0.2, r * 1.0); g.fillRect(-r * 0.55, -r * 0.55, r * 1.1, r * 0.36); g.restore();
      break;
    case 'gear':
      g.beginPath(); g.arc(0, 0, r * 0.5, 0, 6.2832); g.stroke();
      for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; g.beginPath(); g.moveTo(Math.cos(a) * r * 0.55, Math.sin(a) * r * 0.55); g.lineTo(Math.cos(a) * r * 0.9, Math.sin(a) * r * 0.9); g.stroke(); }
      break;
    case 'info':
    default:
      g.beginPath(); g.arc(0, 0, r * 0.85, 0, 6.2832); g.stroke();
      g.fillRect(-r * 0.1, -r * 0.15, r * 0.2, r * 0.65); g.beginPath(); g.arc(0, -r * 0.42, r * 0.12, 0, 6.2832); g.fill();
      break;
  }
  g.restore();
}

// ── offscreen layer cache ──────────────────────────────────────────────────
/**
 * Ornament is expensive and mostly static. Everything that does not change
 * every frame is baked once into an offscreen canvas keyed by its geometry.
 */
export class LayerCache {
  constructor() { this.map = new Map(); }
  get(key, w, h, draw) {
    w = Math.max(1, Math.ceil(w)); h = Math.max(1, Math.ceil(h));
    const k = key + '|' + w + 'x' + h;
    let e = this.map.get(k);
    if (e) return e;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    draw(g, w, h);
    e = c;
    this.map.set(k, e);
    if (this.map.size > 96) { const first = this.map.keys().next().value; this.map.delete(first); }
    return e;
  }
  clear() { this.map.clear(); }
}

// ── easing ─────────────────────────────────────────────────────────────────
export const ease = {
  out: (t) => 1 - Math.pow(1 - t, 3),
  outQuint: (t) => 1 - Math.pow(1 - t, 5),
  inOut: (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
  /** ease-out with a small, controlled overshoot — the UI's signature motion */
  overshoot: (t, s = 1.42) => { const p = t - 1; return 1 + (s + 1) * p * p * p + s * p * p; },
  back: (t) => { const c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); },
  pop: (t) => t < 0.34 ? ease.out(t / 0.34) * 1.18 : 1.18 - 0.18 * ease.out((t - 0.34) / 0.66),
};
export const clamp01 = (t) => t < 0 ? 0 : t > 1 ? 1 : t;
export const lerp = (a, b, t) => a + (b - a) * t;
