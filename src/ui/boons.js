// OWNER: AGENT-UI
// ---------------------------------------------------------------------------
// THE BOON CHOICE — the signature moment.
//
// Three cards, each an ornate obsidian plaque with a god-coloured edge light, a
// procedurally drawn emblem in a rarity ring, the boon name in the display
// serif and the rarity-scaled numbers in the body text. Cards stagger in with
// an ease-out overshoot and a specular sweep runs along their gold.
// ---------------------------------------------------------------------------

import {
  PAL, RARITY, frame, panelBody, plaqueRect, roundRect, goldGradient, meander,
  beadRule, laurel, laurelBranch, palmette, tracked, trackedWidth, wrap, rgba, mix, shade, lift,
  displayFont, bodyFont, ease, clamp01, lerp, LayerCache,
} from './ornament.js';
import { GOD_INFO, SLOTS, RARITY_LABEL, BoonState } from '../game/boons.js';
import { boonOfferComparison, advanceCardFocus, releaseGatedEdge } from './boon-choice.js';
import godPortraitsUrl from '../assets/ui/generated/god-portraits-v1.jpg';
import hephaestusAtlasUrl from '../assets/textures/generated/hephaestus-forge-gates-v6-atlas.png';

const PORTRAIT_GRID = { cols: 5, rows: 2 };
const PORTRAIT_CELL = {
  zeus: [0, 0], poseidon: [1, 0], athena: [2, 0], aphrodite: [3, 0], ares: [4, 0],
  artemis: [0, 1], dionysus: [1, 1], hermes: [2, 1], hecate: [3, 1], selene: [4, 1],
};
const godPortraits = typeof Image !== 'undefined' ? new Image() : null;
if (godPortraits) godPortraits.src = godPortraitsUrl;
const hephaestusAtlas = typeof Image !== 'undefined' ? new Image() : null;
if (hephaestusAtlas) hephaestusAtlas.src = hephaestusAtlasUrl;

function drawGodPortrait(g, cx, cy, r, god) {
  if (god === 'hephaestus' && hephaestusAtlas?.complete && hephaestusAtlas.naturalWidth) {
    const sw = hephaestusAtlas.naturalWidth / 3;
    const sh = hephaestusAtlas.naturalHeight / 2;
    g.save();
    g.beginPath(); g.arc(cx, cy, r, 0, 6.2832); g.clip();
    g.filter = 'brightness(1.55) saturate(1.02) contrast(1.04)';
    g.drawImage(hephaestusAtlas, 2, 2, sw - 4, sh - 4, cx - r, cy - r, r * 2, r * 2);
    g.filter = 'none';
    const veil = g.createLinearGradient(cx, cy - r, cx, cy + r);
    veil.addColorStop(0, 'rgba(8,4,14,0.01)'); veil.addColorStop(0.68, 'rgba(8,4,14,0.03)'); veil.addColorStop(1, 'rgba(8,4,14,0.45)');
    g.fillStyle = veil; g.fillRect(cx - r, cy - r, r * 2, r * 2);
    g.restore();
    return true;
  }
  const cell = PORTRAIT_CELL[god];
  if (!cell || !godPortraits?.complete || !godPortraits.naturalWidth) return false;
  const sw = godPortraits.naturalWidth / PORTRAIT_GRID.cols;
  const sh = godPortraits.naturalHeight / PORTRAIT_GRID.rows;
  const inset = 1.5;
  // The generated cells are vertical busts. A square crop from the upper cell
  // keeps the face, crown/helmet and shoulder silhouette inside the medallion.
  const sx = cell[0] * sw + inset;
  const sy = cell[1] * sh + inset;
  const ss = sw - inset * 2;
  g.save();
  g.beginPath(); g.arc(cx, cy, r, 0, 6.2832); g.clip();
  g.filter = 'saturate(0.92) contrast(1.06)';
  g.drawImage(godPortraits, sx, sy, ss, ss, cx - r, cy - r, r * 2, r * 2);
  g.filter = 'none';
  const veil = g.createLinearGradient(cx, cy - r, cx, cy + r);
  veil.addColorStop(0, 'rgba(8,4,14,0.02)');
  veil.addColorStop(0.64, 'rgba(8,4,14,0.04)');
  veil.addColorStop(1, 'rgba(8,4,14,0.48)');
  g.fillStyle = veil; g.fillRect(cx - r, cy - r, r * 2, r * 2);
  g.restore();
  return true;
}

// ═══════════════════════════════════════════════════════ GOD EMBLEMS ══════
// Each emblem is authored in a unit circle and scaled by r. Every one draws
// undercut -> body -> highlight so it reads as struck metal, not clip art.
function emblemPath(g, kind, r) {
  const P = (x, y) => [x * r, y * r];
  g.beginPath();
  switch (kind) {
    case 'bolt': {                                   // Zeus
      const p = [[-.10, -.92], [.46, -.20], [.12, -.14], [.52, .90], [-.44, .06], [-.02, -.02], [-.40, -.44]];
      g.moveTo(...P(p[0][0], p[0][1])); for (let i = 1; i < p.length; i++) g.lineTo(...P(p[i][0], p[i][1])); g.closePath();
      break;
    }
    case 'trident': {                                // Poseidon
      g.rect(-.07 * r, -.30 * r, .14 * r, 1.18 * r);            // shaft
      g.moveTo(...P(-.68, -.72)); g.lineTo(...P(-.52, -.72)); g.lineTo(...P(-.52, -.16));
      g.lineTo(...P(.52, -.16)); g.lineTo(...P(.52, -.72)); g.lineTo(...P(.68, -.72));
      g.lineTo(...P(.68, -.02)); g.lineTo(...P(-.68, -.02)); g.closePath();
      g.moveTo(...P(-.60, -.72)); g.lineTo(...P(-.44, -1.00)); g.lineTo(...P(-.30, -.72));
      g.moveTo(...P(.60, -.72)); g.lineTo(...P(.44, -1.00)); g.lineTo(...P(.30, -.72));
      g.moveTo(...P(-.10, -.30)); g.lineTo(...P(0, -1.02)); g.lineTo(...P(.10, -.30));
      break;
    }
    case 'aegis': {                                  // Athena — shield + spear
      g.moveTo(...P(0, -.92));
      g.bezierCurveTo(...P(.72, -.80), ...P(.76, .10), ...P(0, .96));
      g.bezierCurveTo(...P(-.76, .10), ...P(-.72, -.80), ...P(0, -.92));
      g.closePath();
      break;
    }
    case 'rose': {                                   // Aphrodite — heart + petals
      g.moveTo(...P(0, .92));
      g.bezierCurveTo(...P(-1.02, .04), ...P(-.62, -.94), ...P(0, -.34));
      g.bezierCurveTo(...P(.62, -.94), ...P(1.02, .04), ...P(0, .92));
      g.closePath();
      break;
    }
    case 'blades': {                                 // Ares — crossed swords
      for (const s of [-1, 1]) {
        g.moveTo(s * .86 * r, -.86 * r); g.lineTo(s * .60 * r, -.94 * r);
        g.lineTo(-s * .52 * r, .70 * r); g.lineTo(-s * .30 * r, .92 * r);
        g.lineTo(-s * .70 * r, .84 * r); g.lineTo(-s * .78 * r, .48 * r);
        g.closePath();
      }
      break;
    }
    case 'bow': {                                    // Artemis
      g.moveTo(...P(-.30, -.94));
      g.bezierCurveTo(...P(.70, -.58), ...P(.70, .58), ...P(-.30, .94));
      g.lineTo(...P(-.14, .78));
      g.bezierCurveTo(...P(.48, .46), ...P(.48, -.46), ...P(-.14, -.78));
      g.closePath();
      g.moveTo(...P(-.36, -.86)); g.lineTo(...P(-.36, .86)); g.lineTo(...P(-.24, .86)); g.lineTo(...P(-.24, -.86)); g.closePath();
      g.moveTo(...P(-.86, 0)); g.lineTo(...P(.50, -.09)); g.lineTo(...P(.50, .09)); g.lineTo(...P(-.86, 0)); g.closePath();
      break;
    }
    case 'grapes': {                                 // Dionysus
      const rows = [[-.34, .22], [0, .22], [.34, .22], [-.17, -.10], [.17, -.10], [0, -.42], [-.50, .54], [-.17, .54], [.17, .54], [.50, .54]];
      for (const [x, y] of rows) { g.moveTo((x + .19) * r, y * r); g.arc(x * r, y * r, .19 * r, 0, 6.2832); }
      g.moveTo(...P(.02, -.56)); g.bezierCurveTo(...P(.34, -1.02), ...P(.86, -.86), ...P(.72, -.48));
      g.bezierCurveTo(...P(.46, -.34), ...P(.16, -.40), ...P(.02, -.56)); g.closePath();
      break;
    }
    case 'wing': {                                   // Hermes — swept wings + staff
      for (const sg of [-1, 1]) {
        g.save(); if (sg < 0) g.scale(-1, 1);
        g.moveTo(.08 * r, -.06 * r);
        g.bezierCurveTo(.52 * r, -.78 * r, 1.06 * r, -.64 * r, 1.00 * r, -.16 * r);
        g.bezierCurveTo(.80 * r, -.34 * r, .54 * r, -.24 * r, .34 * r, .02 * r);
        g.bezierCurveTo(.64 * r, -.06 * r, .84 * r, .02 * r, .88 * r, .22 * r);
        g.bezierCurveTo(.58 * r, .14 * r, .30 * r, .16 * r, .08 * r, .04 * r);
        g.closePath();
        g.restore();
      }
      g.rect(-.075 * r, -.26 * r, .15 * r, 1.18 * r);
      g.moveTo(.22 * r, -.42 * r); g.arc(0, -.42 * r, .22 * r, 0, 6.2832);
      break;
    }
    case 'moons': {                                  // Hecate — the triple moon
      const cres = (ox, R, flip) => {
        g.save(); g.translate(ox, 0); if (flip) g.scale(-1, 1);
        g.moveTo(Math.cos(-1.20) * R, Math.sin(-1.20) * R);
        g.arc(0, 0, R, -1.20, 1.20, false);
        g.arc(R * 0.70, 0, R * 0.84, 1.00, -1.00, true);
        g.closePath();
        g.restore();
      };
      g.moveTo(.44 * r, 0); g.arc(0, 0, .44 * r, 0, 6.2832);   // full moon
      cres(-0.74 * r, .40 * r, false);
      cres(0.74 * r, .40 * r, true);
      break;
    }
    case 'hammer': {                                 // Hephaestus — hammer + anvil
      g.save(); g.rotate(-0.54);
      g.rect(-.12 * r, -.18 * r, .24 * r, 1.08 * r);
      g.rect(-.58 * r, -.56 * r, 1.16 * r, .34 * r);
      g.restore();
      g.moveTo(...P(-.72, .42)); g.lineTo(...P(.72, .42));
      g.lineTo(...P(.48, .66)); g.lineTo(...P(.22, .72));
      g.lineTo(...P(.08, .94)); g.lineTo(...P(-.54, .94));
      g.lineTo(...P(-.68, .70)); g.closePath();
      break;
    }
    case 'wheat': {                                  // Demeter — grain and frost
      g.rect(-.055 * r, -.78 * r, .11 * r, 1.58 * r);
      for (const y of [-.54, -.26, .02, .30]) for (const s of [-1, 1]) {
        g.moveTo(...P(0, y));
        g.quadraticCurveTo(s * .46 * r, (y - .18) * r, s * .54 * r, (y + .05) * r);
        g.quadraticCurveTo(s * .25 * r, (y + .18) * r, 0, (y + .10) * r);
        g.closePath();
      }
      break;
    }
    case 'sun': {                                    // Apollo — radiant sun
      g.moveTo(.34 * r, 0); g.arc(0, 0, .34 * r, 0, 6.2832);
      for (let i = 0; i < 12; i++) {
        const a = i / 12 * 6.2832, da = .10;
        g.moveTo(Math.cos(a - da) * .46 * r, Math.sin(a - da) * .46 * r);
        g.lineTo(Math.cos(a) * .92 * r, Math.sin(a) * .92 * r);
        g.lineTo(Math.cos(a + da) * .46 * r, Math.sin(a + da) * .46 * r);
        g.closePath();
      }
      break;
    }
    case 'crown': {                                  // Hera — royal diadem
      const p = [[-.84,.58],[-.70,-.62],[-.28,-.20],[0,-.86],[.28,-.20],[.70,-.62],[.84,.58]];
      g.moveTo(...P(p[0][0], p[0][1])); for (let i = 1; i < p.length; i++) g.lineTo(...P(p[i][0], p[i][1]));
      g.lineTo(...P(.62,.82)); g.lineTo(...P(-.62,.82)); g.closePath();
      break;
    }
    case 'flame': {                                  // Hestia — hearth flame
      g.moveTo(...P(0, .94));
      g.bezierCurveTo(...P(-.82, .48), ...P(-.68, -.26), ...P(-.18, -.92));
      g.bezierCurveTo(...P(-.20, -.28), ...P(.08, -.16), ...P(.26, -.62));
      g.bezierCurveTo(...P(.86, .10), ...P(.72, .62), ...P(0, .94)); g.closePath();
      break;
    }
    case 'spiral': {                                 // Chaos — primordial spiral
      for (let i = 0; i < 4; i++) {
        const rr = (.18 + i * .18) * r;
        g.moveTo(rr, 0); g.arc(0, 0, rr, i * .38, 5.55 + i * .38);
        g.arc(0, 0, Math.max(.05 * r, rr - .075 * r), 5.55 + i * .38, i * .38, true);
        g.closePath();
      }
      break;
    }
    case 'helm': {                                   // Hades — helm of darkness
      g.moveTo(...P(-.72, .74)); g.lineTo(...P(-.72, -.10));
      g.quadraticCurveTo(0, -1.05 * r, .72 * r, -.10 * r);
      g.lineTo(...P(.72, .74)); g.lineTo(...P(.30, .74));
      g.lineTo(...P(.18, .10)); g.lineTo(...P(-.18, .10));
      g.lineTo(...P(-.30, .74)); g.closePath();
      break;
    }
    case 'crescent':                                 // Selene
    default: {
      g.moveTo(...P(.24, -.94));
      g.arc(0, 0, .94 * r, -1.31, 1.31);
      g.arc(.46 * r, 0, .74 * r, 1.12, -1.12, true);
      g.closePath();
      break;
    }
  }
}

/** Draw a god emblem, lit from the upper left, glowing in the god colour. */
export function godEmblem(g, cx, cy, r, godKey, o = {}) {
  const info = GOD_INFO[godKey] || GOD_INFO.zeus;
  const col = o.color || info.color;
  const kind = o.kind || info.emblem;
  g.save();
  g.translate(cx, cy);

  if (o.glow !== false) {                       // additive halo
    g.save(); g.globalCompositeOperation = 'lighter';
    const h = g.createRadialGradient(0, 0, r * 0.10, 0, 0, r * (o.glowR || 2.0));
    h.addColorStop(0, rgba(col, (o.glowA != null ? o.glowA : 0.34)));
    h.addColorStop(0.42, rgba(col, (o.glowA != null ? o.glowA : 0.34) * 0.30));
    h.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = h; g.beginPath(); g.arc(0, 0, r * (o.glowR || 2.0), 0, 6.2832); g.fill();
    g.restore();
  }

  const s = r * 0.055;
  g.save(); g.translate(s, s * 1.15);           // undercut
  emblemPath(g, kind, r); g.fillStyle = 'rgba(4,2,9,0.92)'; g.fill();
  g.restore();

  emblemPath(g, kind, r);                       // body
  const grd = g.createLinearGradient(-r * 0.7, -r, r * 0.6, r);
  grd.addColorStop(0, lift(col, 0.62));
  grd.addColorStop(0.30, lift(col, 0.14));
  grd.addColorStop(0.62, col);
  grd.addColorStop(1, shade(col, 0.58));
  g.fillStyle = grd; g.fill();

  g.save();                                     // lit arris
  g.clip();
  g.translate(-s * 0.9, -s * 1.1);
  emblemPath(g, kind, r);
  g.strokeStyle = rgba(lift(col, 0.82), 0.75); g.lineWidth = Math.max(0.9, r * 0.055);
  g.stroke();
  g.restore();

  emblemPath(g, kind, r);                       // contour
  g.strokeStyle = rgba('#1b0d1f', 0.6); g.lineWidth = Math.max(0.7, r * 0.030); g.stroke();
  g.restore();
}

/** The rarity ring around a medallion: bronze / silver / gold / prismatic. */
export function rarityRing(g, cx, cy, r, rarity, o = {}) {
  const R = RARITY[rarity] || RARITY.common;
  const w = o.w || Math.max(2.4, r * 0.11);
  const phase = o.phase || 0;
  g.save();
  // seat
  g.beginPath(); g.arc(cx, cy, r + w * 0.5, 0, 6.2832);
  g.strokeStyle = 'rgba(5,2,10,0.9)'; g.lineWidth = w * 1.9; g.stroke();

  if (R.prismatic) {
    const steps = 24;
    for (let i = 0; i < steps; i++) {
      const a0 = (i / steps) * 6.2832 + phase, a1 = ((i + 1.05) / steps) * 6.2832 + phase;
      const f = (i / steps + phase * 0.16) % 1;
      const c = f < 0.33 ? mix(R.ring[0], R.ring[1], f / 0.33)
        : f < 0.66 ? mix(R.ring[1], R.ring[2], (f - 0.33) / 0.33)
          : mix(R.ring[2], R.ring[0], (f - 0.66) / 0.34);
      g.beginPath(); g.arc(cx, cy, r, a0, a1);
      g.strokeStyle = c; g.lineWidth = w; g.stroke();
    }
  } else {
    const grd = g.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
    grd.addColorStop(0, R.ring[2]); grd.addColorStop(0.32, R.ring[0]);
    grd.addColorStop(0.5, R.ring[1]); grd.addColorStop(0.72, R.ring[0]);
    grd.addColorStop(1, R.ring[2]);
    g.beginPath(); g.arc(cx, cy, r, 0, 6.2832);
    g.strokeStyle = grd; g.lineWidth = w; g.stroke();
  }
  // specular pip travelling the ring
  const a = phase * 1.6;
  g.save(); g.globalCompositeOperation = 'lighter';
  g.beginPath(); g.arc(cx, cy, r, a - 0.16, a + 0.16);
  g.strokeStyle = rgba('#fff6dd', 0.75); g.lineWidth = w * 0.7; g.stroke();
  g.restore();

  // notch ticks — the ring reads as a setting, not a stroke
  const ticks = o.ticks != null ? o.ticks : 12;
  for (let i = 0; i < ticks; i++) {
    const t = (i / ticks) * 6.2832;
    g.beginPath();
    g.moveTo(cx + Math.cos(t) * (r + w * 0.55), cy + Math.sin(t) * (r + w * 0.55));
    g.lineTo(cx + Math.cos(t) * (r + w * 1.05), cy + Math.sin(t) * (r + w * 1.05));
    g.strokeStyle = rgba(PAL.goldMid, 0.55); g.lineWidth = Math.max(0.8, w * 0.3); g.stroke();
  }
  g.restore();
}

// ═══════════════════════════════════════════════════════ THE OVERLAY ══════
const CARD_W = 292, CARD_H = 430, CARD_GAP = 32;

export class BoonOverlay {
  constructor(ui) {
    this.ui = ui;
    this.cache = new LayerCache();
    this.active = false;
    this.options = [];
    this.t0 = 0;
    this.hover = -1;
    this.chosen = -1;
    this.chosenT = 0;
    this._resolve = null;
    this.title = 'A Boon of the Gods';
    this.subtitle = '';
    this.rects = [];
    this._inputWasEnabled = true;
    this._gamepadAcceptArmed = false;
  }

  /** ARCHITECTURE §2.9 — ui.showBoonChoice(options) -> Promise<chosenBoon> */
  open(options, o = {}) {
    const list = (options && options.length ? options : this._fallback(o)).slice(0, 3);
    this.options = list.map(x => normalise(x, this.ui.boonState));
    this.raw = list;
    this.active = true;
    const input = this.ui.ctx?.input;
    this._inputWasEnabled = input ? input.enabled !== false : true;
    if (input) input.enabled = false;
    this.t0 = this.ui.now();
    this.hover = -1; this.chosen = -1; this.chosenT = 0;
    this._gamepadAcceptArmed = false;
    const gods = [...new Set(this.options.map(x => x.god))];
    this.title = gods.length === 1 ? `A Boon of ${GOD_INFO[gods[0]]?.name || 'the Gods'}` : 'A Boon of the Gods';
    this.subtitle = gods.length === 1 ? (GOD_INFO[gods[0]]?.title || '') : 'The gods are watching';
    this.ui.hud?.alpha?.set?.(0.30);      // the HUD steps back for the offer
    this.ui.dirty = true;
    return new Promise(res => { this._resolve = res; });
  }

  _fallback(o) {
    const bs = this.ui.boonState;
    return bs ? bs.roll(this.ui.ctx?.rng?.fork ? this.ui.ctx.rng.fork('boonui') : this.ui.ctx?.rng, { count: 3, ...o }) : [];
  }

  choose(i) {
    if (!this.active || this.chosen >= 0) return;
    if (i < 0 || i >= this.options.length) return;
    this.chosen = i;
    this.chosenT = this.ui.now();
    const picked = this.raw[i];
    this.ui.ctx?.audio?.sfx?.('ui.boon', { gain: 0.8 });
    // grant into our own modifier state so combat has something to query even
    // if the run system never calls back
    try { this.ui.boonState?.grant?.(picked); } catch (e) { }
    this.ui.dirty = true;
    this.ui.hud?.alpha?.set?.(1);
    setTimeout(() => {
      this.active = false;
      this._restoreInput();
      const r = this._resolve; this._resolve = null;
      if (r) r(picked);
    }, 340);
  }

  _restoreInput() {
    const input = this.ui.ctx?.input;
    if (!input) return;
    const anotherModal = this.ui.nectarUI?.active || this.ui.menus?.screen !== 'game';
    input.enabled = this._inputWasEnabled && !anotherModal;
  }

  cancel() {
    this.ui.hud?.alpha?.set?.(1);
    const r = this._resolve; this._resolve = null; this.active = false;
    this._restoreInput();
    if (r) r(null);
  }

  layout(W, H, S) {
    const cw = CARD_W * S, ch = CARD_H * S, gap = CARD_GAP * S;
    const n = this.options.length || 3;
    const total = n * cw + (n - 1) * gap;
    const x0 = (W - total) / 2;
    const y = H * 0.5 - ch * 0.42;
    this.rects.length = 0;
    for (let i = 0; i < n; i++) this.rects.push({ x: x0 + i * (cw + gap), y, w: cw, h: ch });
    return { cw, ch, gap, x0, y };
  }

  hitTest(px, py) {
    for (let i = 0; i < this.rects.length; i++) {
      const r = this.rects[i];
      if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return i;
    }
    return -1;
  }

  /** One navigation path for keyboard and gamepad, including first focus. */
  moveSelection(dir) {
    const n = this.options.length;
    if (!this.active || !n) return;
    this.hover = advanceCardFocus(this.hover, dir, n);
    this.ui.ctx?.audio?.sfx?.('ui.move', { gain: 0.32 });
    this.ui.dirty = true;
  }

  gamepad(action) {
    if (!this.active) return;
    if (action === 'left') this.moveSelection(-1);
    else if (action === 'right') this.moveSelection(1);
    else if (action === 'accept') this.choose(this.hover < 0 ? 0 : this.hover);
  }

  pollGamepadAccept(down, edge) {
    const next = releaseGatedEdge(this._gamepadAcceptArmed, down, edge);
    this._gamepadAcceptArmed = next.armed;
    if (next.trigger) this.gamepad('accept');
    return next.trigger;
  }

  draw(g, W, H, S, t) {
    if (!this.active) return;
    const age = t - this.t0;

    // ── scrim: darken outward, keep the centre readable ──
    const sc = clamp01(age / 0.30);
    g.save();
    const sg = g.createRadialGradient(W * 0.5, H * 0.48, H * 0.12, W * 0.5, H * 0.5, H * 0.95);
    sg.addColorStop(0, rgba('#0a0614', 0.46 * sc));
    sg.addColorStop(0.55, rgba('#08040f', 0.72 * sc));
    sg.addColorStop(1, rgba('#050309', 0.92 * sc));
    g.fillStyle = sg; g.fillRect(0, 0, W, H);
    g.restore();

    const L = this.layout(W, H, S);

    // the light the offer arrives in — a warm pool behind the trio, tinted by
    // the gods present. Without it the modal is a dark sheet and the frame
    // never reaches a highlight value.
    g.save(); g.globalCompositeOperation = 'lighter'; g.globalAlpha = sc;
    const pool = g.createRadialGradient(W / 2, L.y + L.ch * 0.34, L.ch * 0.06, W / 2, L.y + L.ch * 0.42, L.ch * 1.35);
    pool.addColorStop(0, rgba('#ffe9a8', 0.30));
    pool.addColorStop(0.30, rgba('#f2c14e', 0.145));
    pool.addColorStop(0.66, rgba('#8a5aa8', 0.055));
    pool.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = pool; g.fillRect(0, 0, W, H);
    g.restore();

    // ── header ──
    const ha = ease.out(clamp01((age - 0.05) / 0.4));
    const hy = L.y - 78 * S + (1 - ha) * 22 * S;
    g.save(); g.globalAlpha = ha;
    // laurel sprays flanking the title
    const tw = trackedWidth(g, this.title.toUpperCase(), { size: 30 * S, track: 0.18, weight: 700 });
    const cx = W / 2;
    laurelBranch(g, cx - tw * 0.5 - 24 * S, hy - 7 * S, 86 * S, -1, { leaves: 7, leafLen: 0.28, bow: 0.30 });
    laurelBranch(g, cx + tw * 0.5 + 24 * S, hy - 7 * S, 86 * S, 1, { leaves: 7, leafLen: 0.28, bow: 0.30 });
    tracked(g, this.title.toUpperCase(), cx, hy, {
      size: 30 * S, track: 0.18, weight: 700, align: 'center', gold: true,
      sweep: (t * 0.22) % 1, shadow: '#050309', shadowDy: 3 * S,
    });
    if (this.subtitle) tracked(g, this.subtitle.toUpperCase(), cx, hy + 22 * S, {
      size: 12 * S, track: 0.40, weight: 600, align: 'center', color: rgba('#f0dfbc', 0.92), shadow: '#06030c', shadowDy: 1.6 * S,
    });
    // rule under the header
    const rw = Math.max(tw + 140 * S, 380 * S);
    const rg = g.createLinearGradient(cx - rw / 2, 0, cx + rw / 2, 0);
    rg.addColorStop(0, 'rgba(0,0,0,0)'); rg.addColorStop(0.5, rgba(PAL.gold, 0.75)); rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg; g.fillRect(cx - rw / 2, hy + 34 * S, rw, Math.max(1, 1.2 * S));
    g.restore();

    // ── cards ──
    for (let i = 0; i < this.options.length; i++) {
      const o = this.options[i], r = this.rects[i];
      const d = 0.10 + i * 0.085;
      const p = clamp01((age - d) / 0.46);
      if (p <= 0) continue;
      const e = ease.overshoot(p, 1.35);
      const hovered = (this.hover === i && this.chosen < 0);
      const picked = this.chosen === i;
      const rejected = this.chosen >= 0 && !picked;

      g.save();
      let alpha = p < 1 ? p : 1;
      let lift0 = (1 - e) * 46 * S;
      let scale = 1;
      if (picked) {
        const q = clamp01((t - this.chosenT) / 0.34);
        scale = 1 + 0.06 * ease.out(q);
        lift0 -= 8 * S * ease.out(q);
      } else if (rejected) {
        const q = clamp01((t - this.chosenT) / 0.30);
        alpha *= 1 - 0.75 * q; scale = 1 - 0.05 * q;
      } else if (hovered) {
        lift0 -= 9 * S;
      }
      g.globalAlpha = alpha;
      g.translate(r.x + r.w / 2, r.y + r.h / 2 + lift0);
      g.scale(scale, scale);
      g.translate(-r.w / 2, -r.h / 2);
      this._card(g, 0, 0, r.w, r.h, o, S, t, { hovered, picked, index: i });
      g.restore();
    }

    // ── footer hint ──
    const fa = ease.out(clamp01((age - 0.55) / 0.4));
    g.save(); g.globalAlpha = fa * 0.8;
    tracked(g, '1 · 2 · 3  OR CLICK   ·   ARROWS + ENTER   ·   GAMEPAD A', W / 2, L.y + L.ch + 42 * S, {
      size: 10.5 * S, track: 0.28, weight: 600, align: 'center', color: rgba('#e8d8b6', 0.86), shadow: '#06030c', shadowDy: 1.4 * S,
    });
    g.restore();
  }

  _card(g, x, y, w, h, o, S, t, st) {
    const col = o.color;
    const R = RARITY[o.rarity] || RARITY.common;
    const sweep = ((t * 0.30) + (st.index || 0) * 0.19) % 1;

    // frame + panel
    frame(g, {
      x, y, w, h, weight: 1.15 * S, r: 9 * S, pad: 7,
      edge: col, edgeAlpha: st.hovered || st.picked ? 0.95 : 0.62,
      glowAlpha: st.hovered || st.picked ? 0.50 : 0.32,
      meander: true, meanderH: 13, beadR: 1.7, palmetteS: 16,
      sweep,
      fill: { top: mix('#3c2757', col, 0.26), mid: '#241734', bot: '#140d22', bounce: col },
    });

    // god-colour wash from the top of the card
    g.save();
    roundRect(g, x + 5 * S, y + 5 * S, w - 10 * S, h - 10 * S, 6 * S); g.clip();
    const wash = g.createRadialGradient(x + w / 2, y + h * 0.24, 2, x + w / 2, y + h * 0.24, w * 0.86);
    wash.addColorStop(0, rgba(col, 0.44)); wash.addColorStop(0.40, rgba(col, 0.16)); wash.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = wash; g.fillRect(x, y, w, h);
    g.restore();

    const cx = x + w / 2;
    // The card number is an affordance, not just a footer instruction. It
    // keeps the direct-key choice discoverable while the eye compares cards.
    const keyX = x + 22 * S, keyY = y + 23 * S, keyR = 11 * S;
    g.save();
    g.beginPath(); g.arc(keyX, keyY, keyR, 0, 6.2832);
    g.fillStyle = rgba('#090512', 0.90); g.fill();
    g.strokeStyle = rgba(st.hovered ? lift(col, 0.42) : PAL.goldMid, st.hovered ? 0.95 : 0.72);
    g.lineWidth = 1.2 * S; g.stroke();
    tracked(g, String((st.index || 0) + 1), keyX, keyY + 3.5 * S, {
      size: 10.5 * S, track: 0, weight: 700, align: 'center', color: st.hovered ? '#fff3c7' : rgba(PAL.parch, 0.84),
    });
    g.restore();

    // ── medallion ──
    const mr = 49 * S, my = y + 102 * S;
    g.save();
    g.beginPath(); g.arc(cx, my, mr, 0, 6.2832);
    const mg = g.createRadialGradient(cx - mr * 0.3, my - mr * 0.4, mr * 0.05, cx, my, mr);
    mg.addColorStop(0, mix('#2e1a4a', col, 0.30)); mg.addColorStop(0.7, '#180f28'); mg.addColorStop(1, '#0b0715');
    g.fillStyle = mg; g.fill();
    g.restore();
    const hasPortrait = drawGodPortrait(g, cx, my, mr * 0.94, o.god);
    if (!hasPortrait) {
      godEmblem(g, cx, my, mr * 0.64, o.god, { color: col, glowA: st.hovered ? 0.72 : 0.60, glowR: 2.4 });
    } else {
      // Preserve the fast-read emblem as a small seal without covering the
      // generated portrait that gives the divine audience its identity.
      const er = 15 * S, ex = cx + mr * 0.70, ey = my + mr * 0.66;
      g.save(); g.beginPath(); g.arc(ex, ey, er, 0, 6.2832);
      g.fillStyle = '#0b0715'; g.fill();
      g.strokeStyle = rgba(PAL.goldHi, 0.88); g.lineWidth = 1.5 * S; g.stroke(); g.restore();
      godEmblem(g, ex, ey, er * 0.58, o.god, { color: col, glowA: 0.48, glowR: 1.5 });
    }
    rarityRing(g, cx, my, mr, o.rarity, { w: 4.6 * S, phase: t * 0.5 + (st.index || 0) });

    // duo badge
    if (o.duo && o.gods && o.gods.length > 1) {
      const br = 15 * S;
      for (let k = 0; k < 2; k++) {
        const bx = cx + (k ? 1 : -1) * (mr + 16 * S), by = my + mr * 0.72;
        g.save(); g.beginPath(); g.arc(bx, by, br, 0, 6.2832);
        g.fillStyle = '#0c0715'; g.fill();
        g.strokeStyle = rgba(PAL.goldMid, 0.8); g.lineWidth = 1.4 * S; g.stroke(); g.restore();
        godEmblem(g, bx, by, br * 0.58, o.gods[k], { glowA: 0.3, glowR: 1.6 });
      }
    }

    // ── god name + epithet ──
    tracked(g, (GOD_INFO[o.god]?.name || o.god || '').toUpperCase(), cx, y + 176 * S, {
      size: 13 * S, track: 0.32, weight: 700, align: 'center', color: lift(col, 0.34),
      shadow: '#07040d', shadowDy: 1.6 * S,
    });
    const epithet = o.comparison?.kind === 'replace' ? 'SLOT TRANSMUTATION'
      : o.comparison?.kind === 'upgrade' ? 'RARITY UPGRADE'
        : o.duo ? 'A DUO BOON' : (GOD_INFO[o.god]?.title || '').toUpperCase();
    if (epithet) tracked(g, epithet, cx, y + 190 * S, {
      size: 8.6 * S, track: 0.30, weight: 600, align: 'center', color: rgba(PAL.parchDim, 0.72),
    });

    // ── divider ──
    const dy = y + 203 * S, dw = w - 66 * S;
    const dg = g.createLinearGradient(cx - dw / 2, 0, cx + dw / 2, 0);
    dg.addColorStop(0, 'rgba(0,0,0,0)'); dg.addColorStop(0.5, rgba(PAL.gold, 0.65)); dg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = dg; g.fillRect(cx - dw / 2, dy, dw, Math.max(1, 1.1 * S));
    palmette(g, cx, dy - 1 * S, 10 * S, { rot: Math.PI, lobes: 5 });

    // ── boon name (display serif, gold, up to two lines) ──
    let size = 24 * S;
    const maxW = w - 40 * S;
    let nameLines = [o.name];
    if (trackedWidth(g, o.name, { size, track: 0.06, weight: 700 }) > maxW) {
      const words = o.name.split(' ');
      if (words.length > 1) {
        let best = 1, bestScore = 1e9;
        for (let k = 1; k < words.length; k++) {
          const a = trackedWidth(g, words.slice(0, k).join(' '), { size, track: 0.06, weight: 700 });
          const b = trackedWidth(g, words.slice(k).join(' '), { size, track: 0.06, weight: 700 });
          const sc2 = Math.max(a, b);
          if (sc2 < bestScore) { bestScore = sc2; best = k; }
        }
        nameLines = [words.slice(0, best).join(' '), words.slice(best).join(' ')];
        if (bestScore > maxW) size *= maxW / bestScore;
      } else size *= maxW / trackedWidth(g, o.name, { size, track: 0.06, weight: 700 });
    }
    let ny = y + 234 * S;
    for (const ln of nameLines) {
      tracked(g, ln, cx, ny, {
        size, track: 0.055, weight: 700, align: 'center', gold: true, sweep,
        shadow: '#07040d', shadowDy: 2.2 * S,
      });
      ny += size * 1.04;
    }

    // ── slot pill ──
    const slotName = (SLOTS[o.slot]?.name || o.slot || 'Boon').toUpperCase();
    const pw = trackedWidth(g, slotName, { size: 10.5 * S, track: 0.30, weight: 600 }) + 28 * S;
    const py = ny - 8 * S, ph = 20 * S;
    g.save();
    plaqueRect(g, cx - pw / 2, py, pw, ph, 5 * S);
    g.fillStyle = rgba(shade(col, 0.58), 0.9); g.fill();
    g.strokeStyle = rgba(PAL.goldMid, 0.8); g.lineWidth = 1.2 * S; g.stroke();
    g.restore();
    tracked(g, slotName, cx, py + ph * 0.70, {
      size: 10.5 * S, track: 0.30, weight: 600, align: 'center', color: lift(col, 0.50),
    });

    // Hades-style decision clarity: action-slot choices disclose the boon that
    // will be displaced (or improved) before the player commits. The rarity
    // transition is repeated in text so colour is never the only signal.
    let effectTop = py + ph;
    if (o.comparison) {
      const cmp = o.comparison;
      const bh = 37 * S, by = effectTop + 5 * S, bw = w - 42 * S;
      g.save();
      plaqueRect(g, cx - bw / 2, by, bw, bh, 4 * S);
      g.fillStyle = rgba(cmp.kind === 'replace' ? shade(col, 0.72) : '#181026', 0.88); g.fill();
      g.strokeStyle = rgba(cmp.kind === 'replace' ? col : R.text, 0.55); g.lineWidth = 1 * S; g.stroke();
      g.restore();
      const prefix = cmp.kind === 'replace' ? 'REPLACES' : 'IMPROVES';
      const decision = `${prefix}  ${cmp.fromName}`.toUpperCase();
      let ds = 8.8 * S;
      const decisionW = trackedWidth(g, decision, { size: ds, track: 0.18, weight: 700 });
      if (decisionW > bw - 16 * S) ds *= (bw - 16 * S) / decisionW;
      tracked(g, decision, cx, by + 14 * S, {
        size: ds, track: 0.18, weight: 700, align: 'center', color: rgba(PAL.parch, 0.90), shadow: '#05030a', shadowDy: 1,
      });
      const from = (RARITY_LABEL[cmp.fromRarity] || cmp.fromRarity || 'Common').toUpperCase();
      const to = (RARITY_LABEL[cmp.toRarity] || cmp.toRarity || 'Common').toUpperCase();
      tracked(g, `${from}   →   ${to}`, cx, by + 29 * S, {
        size: 9.4 * S, track: 0.22, weight: 700, align: 'center', color: R.text, shadow: '#05030a', shadowDy: 1,
      });
      effectTop = by + bh;
    }

    // ── effect text, optically centred in whatever room is left ──
    const tw2 = w - 44 * S;
    const lines = wrap(g, o.text, tw2, { size: 14.4 * S, weight: 400, font: bodyFont() });
    const lh = 20 * S;
    const availTop = effectTop, availBot = y + h - 52 * S;
    const shown = lines.slice(0, 4);
    let ty = availTop + Math.max(6 * S, (availBot - availTop - shown.length * lh) / 2) + lh * 0.74;
    g.font = `400 ${14.4 * S}px ${bodyFont()}`;
    g.textBaseline = 'alphabetic';
    for (const ln of shown) { drawMixed(g, ln, cx, ty, 14.4 * S, tw2, col); ty += lh; }

    // ── rarity footer: label, arms, and one pip per tier ──
    const fy = y + h - 24 * S;
    const label = (RARITY_LABEL[o.rarity] || 'Common').toUpperCase();
    const lw = trackedWidth(g, label, { size: 11 * S, track: 0.34, weight: 600 });
    const armW = (w - lw) / 2 - 34 * S;
    for (const sgn of [-1, 1]) {
      const ax = cx + sgn * (lw / 2 + 13 * S);
      const ag = g.createLinearGradient(ax, 0, ax + sgn * armW, 0);
      ag.addColorStop(0, rgba(R.text, 0.75)); ag.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = ag; g.fillRect(Math.min(ax, ax + sgn * armW), fy - 4 * S, armW, Math.max(1, 1.1 * S));
    }
    tracked(g, label, cx, fy, { size: 11 * S, track: 0.34, weight: 600, align: 'center', color: R.text, shadow: '#07040d', shadowDy: 1.4 * S });
    const tier = ['common', 'rare', 'epic', 'heroic'].indexOf(o.rarity) + 1;
    const pipGap = 11 * S, pipY = fy + 13 * S;
    for (let k = 0; k < 4; k++) {
      const px2 = cx + (k - 1.5) * pipGap;
      g.save(); g.translate(px2, pipY); g.rotate(Math.PI / 4);
      const ps = 3.1 * S;
      if (k < tier) { g.fillStyle = R.text; g.fillRect(-ps, -ps, ps * 2, ps * 2); }
      else { g.strokeStyle = rgba(PAL.bronze, 0.7); g.lineWidth = 1 * S; g.strokeRect(-ps * 0.8, -ps * 0.8, ps * 1.6, ps * 1.6); }
      g.restore();
    }

    // ── travelling light sweep across the whole card face ──
    g.save();
    roundRect(g, x + 3 * S, y + 3 * S, w - 6 * S, h - 6 * S, 7 * S); g.clip();
    g.globalCompositeOperation = 'lighter';
    const sp = ((t * 0.30 + (st.index || 0) * 0.24) % 1.6) - 0.3;
    const sx = x - w * 0.4 + sp * w * 1.8;
    const sg2 = g.createLinearGradient(sx - w * 0.28, y, sx + w * 0.28, y + h);
    sg2.addColorStop(0, 'rgba(0,0,0,0)');
    sg2.addColorStop(0.5, rgba('#ffeec4', st.hovered ? 0.11 : 0.065));
    sg2.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = sg2; g.fillRect(x, y, w, h);
    g.restore();

    // ── selection chevron ──
    if (st.hovered || st.picked) {
      g.save(); g.globalCompositeOperation = 'lighter';
      g.beginPath();
      g.moveTo(cx - 9 * S, y - 15 * S); g.lineTo(cx, y - 5 * S); g.lineTo(cx + 9 * S, y - 15 * S);
      g.strokeStyle = rgba(lift(col, 0.4), 0.9); g.lineWidth = 2.4 * S; g.lineJoin = 'round'; g.stroke();
      g.restore();
    }
  }
}

/** Body text with the numerals lifted into gold so the card reads as a stat block. */
function drawMixed(g, line, cx, y, size, maxW, col) {
  const parts = line.split(/(\d+(?:\.\d+)?%?|Shock|Chill|Doom|Weak|Hangover|Critical|Exposed?)/g).filter(s => s !== '');
  let total = 0;
  for (const p of parts) total += g.measureText(p).width;
  let px = cx - total / 2;
  for (const p of parts) {
    const isNum = /^\d/.test(p);
    const isKey = /^(Shock|Chill|Doom|Weak|Hangover|Critical|Expose|Exposed)$/.test(p);
    g.fillStyle = isNum ? PAL.goldHi : isKey ? lift(col, 0.35) : rgba(PAL.parch, 0.80);
    if (isNum || isKey) { g.save(); g.shadowColor = 'rgba(0,0,0,0.8)'; g.shadowBlur = 3; g.fillText(p, px, y); g.restore(); }
    else g.fillText(p, px, y);
    px += g.measureText(p).width;
  }
}

/** Accept whatever shape the run system hands us and make it renderable. */
function normalise(x, boonState) {
  if (!x) return { name: 'Unknown', text: '', god: 'zeus', rarity: 'common', slot: 'passive', color: PAL.gold };
  const god = x.god || (x.boon && x.boon.god) || (x.gods && x.gods[0]) || 'zeus';
  const rarity = (x.rarity || 'common').toLowerCase();
  let text = x.text || x.desc || x.description || '';
  if (typeof text === 'function') { try { text = text(x.values || {}); } catch (e) { text = ''; } }
  return {
    name: x.name || (x.boon && x.boon.name) || 'Boon',
    text: String(text),
    god,
    gods: x.gods || (x.boon && x.boon.gods) || [god],
    duo: !!(x.duo || (x.boon && x.boon.gods)),
    upgrade: !!x.upgrade,
    comparison: boonOfferComparison(x, boonState),
    rarity: RARITY[rarity] ? rarity : 'common',
    slot: x.slot || (x.boon && x.boon.slot) || 'passive',
    color: x.color || GOD_INFO[god]?.color || PAL.gold,
  };
}

export { BoonState };
