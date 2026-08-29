// OWNER: AGENT-UI
// ---------------------------------------------------------------------------
// THE IN-RUN HUD
//
// Ink and gold. A bronze cradle at bottom-left holding the life bar with a
// damage-lag ghost fill, the magick bar under it, cast pips and dash chevrons,
// the weapon emblem with its cooldown sweep; a boon rail up the left edge; the
// depth/biome plaque top-left; obols and persistent Nectar top-right.
//
// §9 discipline: the HUD sits over a dark frame and must never become the
// brightest thing on screen. Gold here is a MID value with thin highlights —
// the wide bright areas belong to the game, not the interface.
// ---------------------------------------------------------------------------

import {
  PAL, RARITY, frame, panelBody, plaqueRect, roundRect, goldGradient, meander,
  beadRule, palmette, tracked, trackedWidth, rgba, mix, shade, lift,
  displayFont, bodyFont, ease, clamp01, lerp, LayerCache,
} from './ornament.js';
import { godEmblem } from './boons.js';
import { GOD_INFO } from '../game/boons.js';

/** A value that eases toward its target with a small, controlled overshoot. */
class Spring {
  constructor(v = 0, k = 190, z = 0.62) { this.v = v; this.t = v; this.vel = 0; this.k = k; this.z = z; }
  set(t) { this.t = t; }
  snap(t) { this.t = this.v = t; this.vel = 0; }
  step(dt) {
    const d = 2 * this.z * Math.sqrt(this.k);
    const a = (this.t - this.v) * this.k - this.vel * d;
    this.vel += a * dt; this.v += this.vel * dt;
    if (Math.abs(this.t - this.v) < 1e-4 && Math.abs(this.vel) < 1e-3) { this.v = this.t; this.vel = 0; }
    return this.v;
  }
}

const BIOME_TINT = { tartarus: '#ff5a3c', asphodel: '#ff8c1a', elysium: '#ffe6a3', styx: '#8ef0d0' };
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX'];
const roman = (n) => ROMAN[n] || String(n);

export class HUD {
  constructor(ui) {
    this.ui = ui;
    this.cache = new LayerCache();

    this.health = { cur: 100, max: 100 };
    this.mana = { cur: 100, max: 100 };
    this.cast = 3; this.castMax = 3;
    this.dash = 2; this.dashMax = 2;

    this.hpFill = new Spring(1);          // 0..1 displayed fill
    this.hpGhost = 1;                     // damage-lag ghost, drains behind
    this.hpGhostHold = 0;
    this.hpFlash = 0;                     // white kick on change
    this.mpFill = new Spring(1);
    this.hpPulse = 0;

    this.weapon = { id: 'blade', name: 'Stygian Blade' };
    this.weaponCd = 0;                    // 0..1 remaining
    this.specialCd = 0;
    this.castCd = 0;

    this.depth = 1; this.biome = 'tartarus';
    this.roomLabel = '';
    this.roomT = -9;

    this.obols = 0; this.nectar = 0;
    this.boons = [];                      // [{god, rarity, slot, name}]
    this.boonPop = new Map();

    this.alpha = new Spring(1, 120, 0.9);
    this.visible = true;
  }

  // ── contract setters ─────────────────────────────────────────────────────
  setHealth(cur, max) {
    if (max != null) this.health.max = Math.max(1, max);
    const prev = this.health.cur;
    this.health.cur = Math.max(0, Math.min(this.health.max, cur));
    const f = this.health.cur / this.health.max;
    this.hpFill.set(f);
    if (this.health.cur < prev) { this.hpGhostHold = 0.34; this.hpFlash = 1; }
    else if (this.health.cur > prev) { this.hpGhost = Math.max(this.hpGhost, f); this.hpPulse = 1; }
    this.ui.dirty = true;
  }
  setMana(cur, max) {
    if (max != null) this.mana.max = Math.max(1, max);
    this.mana.cur = Math.max(0, Math.min(this.mana.max, cur));
    this.mpFill.set(this.mana.cur / this.mana.max);
    this.ui.dirty = true;
  }
  setCast(n, max) { this.cast = n | 0; if (max) this.castMax = max; this.ui.dirty = true; }
  setDash(n, max) { this.dash = n | 0; if (max) this.dashMax = max; this.ui.dirty = true; }
  setRoom(depth, biome) {
    if (depth != null) this.depth = depth | 0;
    if (biome) this.biome = String(biome).toLowerCase();
    this.roomT = this.ui.now();
    this.ui.dirty = true;
  }
  setWeapon(w) { if (w) { this.weapon = { id: w.id || w, name: w.name || String(w) }; this.ui.dirty = true; } }
  addBoon(rec) {
    if (!rec) return;
    const god = rec.god || rec.boon?.god || (rec.gods && rec.gods[0]);
    if (!god) return;
    const e = { god, rarity: (rec.rarity || 'common'), slot: rec.slot || rec.boon?.slot || 'passive', name: rec.name || rec.boon?.name || '' };
    const i = this.boons.findIndex(b => b.god === e.god && b.slot === e.slot);
    if (i >= 0) this.boons[i] = e; else this.boons.push(e);
    if (this.boons.length > 8) this.boons.shift();
    this.boonPop.set(e.god + e.slot, this.ui.now());
    this.ui.dirty = true;
  }

  // ── sim ──────────────────────────────────────────────────────────────────
  update(dt) {
    this.hpFill.step(dt); this.mpFill.step(dt); this.alpha.step(dt);
    const f = this.hpFill.v;
    if (this.hpGhostHold > 0) this.hpGhostHold -= dt;
    else if (this.hpGhost > f) this.hpGhost = Math.max(f, this.hpGhost - dt * (0.35 + (this.hpGhost - f) * 2.4));
    else this.hpGhost = f;
    if (this.hpFlash > 0) this.hpFlash = Math.max(0, this.hpFlash - dt * 3.6);
    if (this.hpPulse > 0) this.hpPulse = Math.max(0, this.hpPulse - dt * 2.4);
    this.weaponCd = Math.max(0, this.weaponCd - dt);
    if (this.hpFill.v !== this.hpFill.t || this.mpFill.v !== this.mpFill.t || this.hpFlash > 0 || this.hpGhost > f + 1e-4) this.ui.dirty = true;
  }

  // ── draw ─────────────────────────────────────────────────────────────────
  draw(g, W, H, S, t) {
    const a = this.alpha.v;
    if (a <= 0.01) return;
    g.save();
    g.globalAlpha *= a;
    this._cluster(g, W, H, S, t);
    this._depthPlaque(g, W, H, S, t);
    this._boonRail(g, W, H, S, t);
    this._resources(g, W, H, S, t);
    this._roomBanner(g, W, H, S, t);
    g.restore();
  }

  // ═══════════════════════════════════════ bottom-left combat cluster ═════
  _cluster(g, W, H, S, t) {
    const bx = 24 * S, by = H - 24 * S;

    // ---- the life cradle is the anchor of the whole interface ----
    const cw = 398 * S, chh = 74 * S;
    const cx0 = bx + 66 * S;                  // the medallion overlaps its left end
    const cy0 = by - 128 * S;
    this._cradle(g, cx0, cy0, cw, chh, S, t);

    const bw = cw - 76 * S, bh = 30 * S;
    this._lifeBar(g, cx0 + 58 * S, cy0 + 30 * S, bw, bh, S, t);

    // ---- weapon medallion, half over the cradle ----
    this._medallion(g, bx + 42 * S, cy0 + chh * 0.50, 40 * S, S, t);

    // ---- magick, cast pips, dash chevrons ----
    const my0 = cy0 + chh + 9 * S;
    this._magickBar(g, cx0 + 44 * S, my0, 232 * S, 17 * S, S, t);
    this._castPips(g, cx0 + 304 * S, my0 + 8.5 * S, S, t);
    this._dashPips(g, cx0 + 380 * S, my0 + 8.5 * S, S, t);
  }

  _medallion(g, cx, cy, r, S, t) {
    const key = 'med|' + this.weapon.id;
    const pad = r * 1.5;
    const lay = this.cache.get(key + '|' + Math.round(S * 100), pad * 2, pad * 2, (q, w, h) => {
      const c = w / 2;
      // outer bronze setting
      q.beginPath(); q.arc(c, c, r * 1.14, 0, 6.2832);
      q.fillStyle = '#150c07'; q.fill();
      q.beginPath(); q.arc(c, c, r * 1.06, 0, 6.2832);
      q.strokeStyle = goldGradient(q, c - r, c - r, c + r, c + r, 0.32);
      q.lineWidth = r * 0.15; q.stroke();
      // beaded rim
      const n = 26;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * 6.2832;
        const px = c + Math.cos(a) * r * 1.19, py = c + Math.sin(a) * r * 1.19;
        const bg = q.createRadialGradient(px - r * 0.02, py - r * 0.03, 0, px, py, r * 0.075);
        bg.addColorStop(0, '#ffe9a8'); bg.addColorStop(0.6, '#c98f2b'); bg.addColorStop(1, '#4a2c0e');
        q.beginPath(); q.arc(px, py, r * 0.068, 0, 6.2832); q.fillStyle = bg; q.fill();
      }
      // well
      q.beginPath(); q.arc(c, c, r * 0.94, 0, 6.2832);
      const wg = q.createRadialGradient(c - r * 0.3, c - r * 0.4, r * 0.05, c, c, r);
      wg.addColorStop(0, '#241238'); wg.addColorStop(0.7, '#130c1e'); wg.addColorStop(1, '#08050f');
      q.fillStyle = wg; q.fill();
      // four palmette lugs
      for (let i = 0; i < 4; i++) palmette(q, c + Math.cos(i * 1.5708 + 0.7854) * r * 1.2, c + Math.sin(i * 1.5708 + 0.7854) * r * 1.2, r * 0.36, { rot: i * 1.5708 + 0.7854 + Math.PI / 2, lobes: 5 });
      weaponGlyph(q, c, c, r * 0.62, this.weapon.id);
    });
    g.drawImage(lay, cx - pad, cy - pad);

    // cooldown sweep — a dark wedge eating the medallion anticlockwise
    if (this.weaponCd > 0) {
      g.save();
      g.beginPath(); g.moveTo(cx, cy);
      g.arc(cx, cy, r * 0.96, -Math.PI / 2, -Math.PI / 2 + 6.2832 * clamp01(this.weaponCd), false);
      g.closePath();
      g.fillStyle = 'rgba(6,3,12,0.72)'; g.fill();
      g.restore();
    }
    // ready glint
    g.save(); g.globalCompositeOperation = 'lighter';
    const gl = 0.13 + 0.05 * Math.sin(t * 1.6);
    const rg = g.createRadialGradient(cx, cy, r * 0.2, cx, cy, r * 1.5);
    rg.addColorStop(0, rgba(PAL.gold, gl * 0.5)); rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg; g.beginPath(); g.arc(cx, cy, r * 1.5, 0, 6.2832); g.fill();
    g.restore();

    tracked(g, this.weapon.name.toUpperCase(), cx, cy + r * 1.62, {
      size: 8.4 * S, track: 0.20, weight: 600, align: 'center', color: rgba(PAL.parchDim, 0.85),
      shadow: '#05030b', shadowDy: 1,
    });
  }

  _cradle(g, x, y, w, h, S, t) {
    const lay = this.cache.get('cradle2|' + Math.round(S * 100), w + 34 * S, h + 34 * S, (q) => {
      const ox = 17 * S, oy = 17 * S;
      frame(q, {
        x: ox, y: oy, w, h, weight: 1.15 * S, r: 7 * S, pad: 5,
        meander: false, bead: false, palmettes: false, glow: false,
        fill: { top: '#22162e', mid: '#170f22', bot: '#0c0716', bounce: '#ff5a3c' },
      });
      // the meander starts clear of the medallion and runs to the right cap
      meander(q, ox + 50 * S, oy + 4.5 * S, w - 66 * S, 11.5 * S, { sweep: 0.30 });
      beadRule(q, ox + 52 * S, oy + h - 7 * S, w - 68 * S, 2.1 * S);
      palmette(q, ox + w - 7 * S, oy + h * 0.54, 17 * S, { rot: Math.PI / 2, lobes: 7 });
      // a beaded vertical rule where the medallion lands, so the two read as
      // one fitting rather than a bar bolted to a disc
      beadRule(q, ox + 40 * S, oy + 12 * S, h - 24 * S, 2.3 * S, { vertical: true });
    });
    g.drawImage(lay, x - 17 * S, y - 17 * S);
  }

  _well(g, x, y, w, h, S, tintDark) {
    plaqueRect(g, x, y, w, h, Math.min(h * 0.42, 8 * S));
    const wg = g.createLinearGradient(x, y, x, y + h);
    wg.addColorStop(0, tintDark[0]); wg.addColorStop(1, tintDark[1]);
    g.fillStyle = wg; g.fill();
    g.save(); g.clip();
    g.shadowColor = 'rgba(0,0,0,0.95)'; g.shadowBlur = h * 0.5; g.shadowOffsetY = 1.5 * S;
    g.lineWidth = h * 0.30; g.strokeStyle = 'rgba(0,0,0,0.9)';
    plaqueRect(g, x, y, w, h, Math.min(h * 0.42, 8 * S)); g.stroke();
    g.restore();
  }

  _lifeBar(g, x, y, w, h, S, t) {
    const f = clamp01(this.hpFill.v);
    const r = Math.min(h * 0.42, 8 * S);
    this._well(g, x, y, w, h, S, ['#1a0710', '#0a0410']);

    g.save();
    plaqueRect(g, x, y, w, h, r); g.clip();

    // damage-lag ghost
    if (this.hpGhost > f + 0.0015) {
      const gw = w * this.hpGhost, gx = x + w * f;
      const gg = g.createLinearGradient(x, y, x, y + h);
      gg.addColorStop(0, rgba('#ffd0a0', 0.66)); gg.addColorStop(0.45, rgba('#ff7a44', 0.55));
      gg.addColorStop(1, rgba('#8e2a12', 0.45));
      g.fillStyle = gg; g.fillRect(gx, y, gw - w * f, h);
      g.save(); g.globalAlpha = 0.16; g.strokeStyle = '#fff0d0'; g.lineWidth = 1.1 * S;
      for (let px = gx - h; px < x + gw; px += 6 * S) { g.beginPath(); g.moveTo(px, y + h); g.lineTo(px + h, y); g.stroke(); }
      g.restore();
      g.fillStyle = rgba('#fff3dc', 0.85); g.fillRect(x + gw - 1.8 * S, y, 1.8 * S, h);
    }

    // fill
    const fw = w * f;
    if (fw > 0.5) {
      const fg = g.createLinearGradient(x, y, x, y + h);
      fg.addColorStop(0, '#e8506a'); fg.addColorStop(0.16, '#c81d3c');
      fg.addColorStop(0.62, '#8e1029'); fg.addColorStop(1, '#4c0718');
      g.fillStyle = fg; g.fillRect(x, y, fw, h);
      // painted hatch so it is not a flat swatch
      g.save(); g.globalAlpha = 0.10; g.strokeStyle = '#ff9aa6'; g.lineWidth = 1.1 * S;
      for (let px = x - h; px < x + fw; px += 7 * S) { g.beginPath(); g.moveTo(px, y + h); g.lineTo(px + h, y); g.stroke(); }
      g.restore();
      // top sheen
      g.fillStyle = rgba('#ff9aa6', 0.42); g.fillRect(x, y + 1 * S, fw, Math.max(1, 1.6 * S));
      // leading cap
      g.fillStyle = rgba('#ffd0c0', 0.85); g.fillRect(x + fw - 2.2 * S, y, 2.2 * S, h);
      if (this.hpFlash > 0) { g.fillStyle = rgba('#fff2e0', 0.30 * this.hpFlash); g.fillRect(x, y, fw, h); }
      if (this.hpPulse > 0) { g.fillStyle = rgba('#9dffc0', 0.22 * this.hpPulse); g.fillRect(x, y, fw, h); }
    }

    // segment ticks every 40 life — a read of scale, not a loading bar
    const seg = Math.max(1, Math.round(this.health.max / 40));
    for (let i = 1; i < seg; i++) {
      const px = x + (w * i) / seg;
      g.fillStyle = 'rgba(8,3,12,0.55)'; g.fillRect(px - 0.6 * S, y, 1.2 * S, h);
      g.fillStyle = rgba(PAL.bronze, 0.30); g.fillRect(px + 0.6 * S, y, 0.6 * S, h);
    }
    g.restore();

    // rim
    plaqueRect(g, x, y, w, h, r);
    g.strokeStyle = goldGradient(g, x, y, x, y + h, 0.28); g.lineWidth = 1.5 * S; g.stroke();
    plaqueRect(g, x + 1.2 * S, y + 1.2 * S, w - 2.4 * S, h - 2.4 * S, Math.max(0, r - 1 * S));
    g.strokeStyle = 'rgba(8,3,14,0.65)'; g.lineWidth = 1 * S; g.stroke();

    // numerals
    const cur = Math.round(this.health.cur), mx = Math.round(this.health.max);
    const nx = x + w - 9 * S;
    const nw = tracked(g, String(mx), nx, y + h * 0.755, {
      size: 12.5 * S, track: 0.06, weight: 600, align: 'right', color: rgba(PAL.parchDim, 0.85), shadow: '#08030d', shadowDy: 1.2 * S,
    });
    tracked(g, ' / ', nx - nw, y + h * 0.755, { size: 11 * S, track: 0.02, weight: 500, align: 'right', color: rgba(PAL.parchDim, 0.5) });
    tracked(g, String(cur), nx - nw - 12 * S, y + h * 0.755, {
      size: 19 * S, track: 0.04, weight: 700, align: 'right',
      color: f < 0.3 ? '#ff9c8a' : '#fff0d8', shadow: '#12020a', shadowDy: 1.6 * S,
    });
    tracked(g, 'LIFE', x + 9 * S, y + h * 0.755, {
      size: 10.5 * S, track: 0.34, weight: 600, align: 'left', color: rgba('#ffc0ac', 0.78), shadow: '#08030d', shadowDy: 1,
    });
  }

  _magickBar(g, x, y, w, h, S, t) {
    const f = clamp01(this.mpFill.v);
    const r = Math.min(h * 0.45, 6 * S);
    this._well(g, x, y, w, h, S, ['#0c1526', '#070a16']);
    g.save(); plaqueRect(g, x, y, w, h, r); g.clip();
    const fw = w * f;
    if (fw > 0.5) {
      const fg = g.createLinearGradient(x, y, x, y + h);
      fg.addColorStop(0, '#9fe6ff'); fg.addColorStop(0.22, '#5fd0ff');
      fg.addColorStop(0.65, '#2b7fc4'); fg.addColorStop(1, '#123a63');
      g.fillStyle = fg; g.fillRect(x, y, fw, h);
      g.fillStyle = rgba('#dff6ff', 0.5); g.fillRect(x, y + 0.8 * S, fw, Math.max(1, 1.2 * S));
      // slow arcane shimmer
      g.save(); g.globalCompositeOperation = 'lighter'; g.globalAlpha = 0.16;
      const sx = x + ((t * 26 * S) % (w + 60 * S)) - 30 * S;
      const sg = g.createLinearGradient(sx - 22 * S, 0, sx + 22 * S, 0);
      sg.addColorStop(0, 'rgba(0,0,0,0)'); sg.addColorStop(0.5, '#dff6ff'); sg.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = sg; g.fillRect(x, y, fw, h); g.restore();
      g.fillStyle = rgba('#eafaff', 0.8); g.fillRect(x + fw - 1.8 * S, y, 1.8 * S, h);
    }
    g.restore();
    plaqueRect(g, x, y, w, h, r);
    g.strokeStyle = goldGradient(g, x, y, x, y + h, 0.7); g.lineWidth = 1.2 * S; g.stroke();
    tracked(g, 'MAGICK', x + 8 * S, y + h * 0.76, {
      size: 8 * S, track: 0.32, weight: 600, align: 'left', color: rgba('#bfe8ff', 0.65), shadow: '#04060f', shadowDy: 1,
    });
    tracked(g, String(Math.round(this.mana.cur)), x + w - 8 * S, y + h * 0.76, {
      size: 10.5 * S, track: 0.05, weight: 700, align: 'right', color: '#e6f6ff', shadow: '#04060f', shadowDy: 1,
    });
  }

  _castPips(g, x, y, S, t) {
    const n = this.castMax, s = 10 * S, gap = 25 * S;
    for (let i = 0; i < n; i++) {
      const cx = x + i * gap, on = i < this.cast;
      // setting
      g.save(); g.translate(cx, y); g.rotate(Math.PI / 4);
      g.fillStyle = '#120a1c'; g.fillRect(-s * 1.14, -s * 1.14, s * 2.28, s * 2.28);
      g.strokeStyle = goldGradient(g, -s, -s, s, s, 0.35); g.lineWidth = 1.5 * S;
      g.strokeRect(-s * 1.05, -s * 1.05, s * 2.1, s * 2.1);
      if (on) {
        const gg = g.createLinearGradient(-s, -s, s, s);
        gg.addColorStop(0, '#eafaff'); gg.addColorStop(0.4, '#5fd0ff'); gg.addColorStop(1, '#1d5c94');
        g.fillStyle = gg; g.fillRect(-s * 0.74, -s * 0.74, s * 1.48, s * 1.48);
      } else {
        g.fillStyle = 'rgba(20,34,54,0.8)'; g.fillRect(-s * 0.74, -s * 0.74, s * 1.48, s * 1.48);
      }
      g.restore();
      if (on) {
        g.save(); g.globalCompositeOperation = 'lighter';
        const rg = g.createRadialGradient(cx, y, 0, cx, y, s * 2.6);
        rg.addColorStop(0, rgba('#5fd0ff', 0.30)); rg.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = rg; g.beginPath(); g.arc(cx, y, s * 2.6, 0, 6.2832); g.fill(); g.restore();
      }
    }
    tracked(g, 'CAST', x - 5 * S, y + 20 * S, { size: 7.6 * S, track: 0.30, weight: 600, color: rgba(PAL.parchDim, 0.6) });
  }

  _dashPips(g, x, y, S, t) {
    const n = this.dashMax, gap = 23 * S, s = 10 * S;
    for (let i = 0; i < n; i++) {
      const cx = x + i * gap, on = i < this.dash;
      g.save(); g.translate(cx, y);
      // seat, so a spent charge still reads as a socket rather than as nothing
      g.save(); g.rotate(Math.PI / 4);
      g.fillStyle = 'rgba(14,9,24,0.85)'; g.fillRect(-s * 0.82, -s * 0.82, s * 1.64, s * 1.64);
      g.strokeStyle = rgba(PAL.bronze, 0.85); g.lineWidth = 1.2 * S; g.strokeRect(-s * 0.82, -s * 0.82, s * 1.64, s * 1.64);
      g.restore();
      g.beginPath();
      g.moveTo(-s * 0.7, -s); g.lineTo(s * 0.32, 0); g.lineTo(-s * 0.7, s);
      g.lineTo(-s * 0.16, 0); g.closePath();
      if (on) {
        const gg = g.createLinearGradient(-s, -s, s, s);
        gg.addColorStop(0, '#fff4dc'); gg.addColorStop(0.42, '#d8c4ff'); gg.addColorStop(1, '#6a53a8');
        g.fillStyle = gg;
      } else g.fillStyle = 'rgba(34,24,50,0.9)';
      g.fill();
      g.strokeStyle = on ? rgba('#ffe9a8', 0.6) : 'rgba(90,70,120,0.5)'; g.lineWidth = 1 * S; g.stroke();
      g.restore();
    }
    tracked(g, 'DASH', x - 6 * S, y + 20 * S, { size: 7.6 * S, track: 0.30, weight: 600, color: rgba(PAL.parchDim, 0.6) });
  }

  // ═══════════════════════════════════════════════ depth / biome plaque ═══
  _depthPlaque(g, W, H, S, t) {
    const w = 216 * S, h = 50 * S, x = 26 * S, y = 24 * S;
    const tint = BIOME_TINT[this.biome] || PAL.gold;
    const lay = this.cache.get('depth|' + this.biome + '|' + Math.round(S * 100), w + 24 * S, h + 24 * S, (q) => {
      frame(q, {
        x: 12 * S, y: 12 * S, w, h, weight: 0.9 * S, r: 5 * S, pad: 4,
        meander: false, bead: false, palmettes: false, glow: false, edge: tint, edgeAlpha: 0.32,
        fill: { top: '#1b1226', mid: '#120b1c', bot: '#0a0612', bounce: tint },
      });
      meander(q, 12 * S + 12 * S, 12 * S + h - 11 * S, w - 24 * S, 7.5 * S, { sweep: 0.5, flip: true });
      palmette(q, 12 * S + w / 2, 12 * S - 3 * S, 13 * S, { rot: Math.PI, lobes: 7 });
    });
    g.drawImage(lay, x - 12 * S, y - 12 * S);
    tracked(g, (this.biome || 'tartarus').toUpperCase(), x + w / 2, y + 24 * S, {
      size: 17 * S, track: 0.24, weight: 700, align: 'center', gold: true, sweep: (t * 0.14) % 1,
      shadow: '#07040d', shadowDy: 2 * S,
    });
    tracked(g, 'CHAMBER ' + roman(this.depth), x + w / 2, y + 38 * S, {
      size: 9 * S, track: 0.36, weight: 600, align: 'center', color: rgba(PAL.parchDim, 0.85),
    });
  }

  // ═════════════════════════════════════════════════════════ boon rail ════
  _boonRail(g, W, H, S, t) {
    if (!this.boons.length) return;
    const x = 54 * S, y0 = 112 * S, step = 56 * S, r = 22 * S;
    // rail
    const railH = (this.boons.length - 1) * step + r * 2.4;
    const rg = g.createLinearGradient(x, y0 - r, x, y0 + railH);
    rg.addColorStop(0, 'rgba(0,0,0,0)'); rg.addColorStop(0.12, rgba(PAL.bronze, 0.55));
    rg.addColorStop(0.88, rgba(PAL.bronze, 0.55)); rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg; g.fillRect(x - 1 * S, y0 - r, 2 * S, railH);

    for (let i = 0; i < this.boons.length; i++) {
      const b = this.boons[i];
      const cy = y0 + i * step;
      const info = GOD_INFO[b.god]; if (!info) continue;
      const pop = this.boonPop.get(b.god + b.slot);
      const pa = pop != null ? clamp01((t - pop) / 0.45) : 1;
      const sc = pop != null && pa < 1 ? ease.overshoot(pa, 1.6) : 1;
      g.save(); g.translate(x, cy); g.scale(sc, sc);
      // hex setting
      g.beginPath();
      for (let k = 0; k < 6; k++) { const a = k * 1.0472 + 0.5236; const px = Math.cos(a) * r, py = Math.sin(a) * r; k ? g.lineTo(px, py) : g.moveTo(px, py); }
      g.closePath();
      const bg = g.createRadialGradient(-r * 0.3, -r * 0.4, r * 0.05, 0, 0, r);
      bg.addColorStop(0, mix('#241238', info.color, 0.18)); bg.addColorStop(1, '#0b0714');
      g.fillStyle = bg; g.fill();
      g.strokeStyle = goldGradient(g, -r, -r, r, r, (t * 0.2 + i * 0.2) % 1); g.lineWidth = 2.2 * S; g.stroke();
      // god-colour bloom so the rail reads in colour, not as grey chips
      g.save(); g.globalCompositeOperation = 'lighter';
      const bl = g.createRadialGradient(0, 0, r * 0.15, 0, 0, r * 1.9);
      bl.addColorStop(0, rgba(info.color, 0.30)); bl.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = bl; g.beginPath(); g.arc(0, 0, r * 1.9, 0, 6.2832); g.fill(); g.restore();
      const R = RARITY[b.rarity] || RARITY.common;
      g.strokeStyle = rgba(R.text, 0.75); g.lineWidth = 0.9 * S;
      g.beginPath();
      for (let k = 0; k < 6; k++) { const a = k * 1.0472 + 0.5236; const px = Math.cos(a) * r * 0.72, py = Math.sin(a) * r * 0.72; k ? g.lineTo(px, py) : g.moveTo(px, py); }
      g.closePath(); g.stroke();
      godEmblem(g, 0, 0, r * 0.52, b.god, { glowA: 0.40, glowR: 1.7 });
      g.restore();
    }
  }

  // ══════════════════════════════════════════════════ obols / Nectar ═══════
  _resources(g, W, H, S, t) {
    const items = [
      { v: this.obols, c: PAL.gold, glyph: 'obol', label: 'OBOLS' },
      { v: this.nectar, c: '#b884ff', glyph: 'nectar', label: 'NECTAR' },
    ];
    let x = W - 26 * S;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      const txt = String(it.v);
      const tw = trackedWidth(g, txt, { size: 13 * S, track: 0.06, weight: 700 });
      const w = tw + 46 * S, h = 26 * S, y = 26 * S;
      const bx = x - w;
      plaqueRect(g, bx, y, w, h, 5 * S);
      g.fillStyle = 'rgba(12,7,20,0.72)'; g.fill();
      g.strokeStyle = rgba(PAL.bronze, 0.8); g.lineWidth = 1.1 * S; g.stroke();
      // coin / gem
      const gcx = bx + 15 * S, gcy = y + h / 2;
      if (it.glyph === 'obol') {
        const cg = g.createRadialGradient(gcx - 2 * S, gcy - 2.5 * S, 0.5 * S, gcx, gcy, 8 * S);
        cg.addColorStop(0, '#ffe9a8'); cg.addColorStop(0.5, '#f2c14e'); cg.addColorStop(1, '#6d4416');
        g.beginPath(); g.arc(gcx, gcy, 7.4 * S, 0, 6.2832); g.fillStyle = cg; g.fill();
        g.beginPath(); g.arc(gcx, gcy, 4 * S, 0, 6.2832); g.strokeStyle = 'rgba(60,34,8,0.7)'; g.lineWidth = 1.1 * S; g.stroke();
      } else {
        g.save(); g.translate(gcx, gcy);
        const cg = g.createLinearGradient(-7 * S, -8 * S, 7 * S, 8 * S);
        cg.addColorStop(0, '#f0dcff'); cg.addColorStop(0.48, '#b884ff'); cg.addColorStop(1, '#56218f');
        plaqueRect(g, -5.5 * S, -5.2 * S, 11 * S, 13 * S, 3 * S); g.fillStyle = cg; g.fill();
        g.fillStyle = '#f2c14e'; g.fillRect(-3.2 * S, -8.0 * S, 6.4 * S, 3.1 * S);
        g.strokeStyle = 'rgba(242,222,255,0.55)'; g.lineWidth = 0.9 * S; g.stroke();
        g.restore();
      }
      tracked(g, txt, bx + w - 10 * S, y + h * 0.68, {
        size: 13 * S, track: 0.06, weight: 700, align: 'right', color: '#f6ecd6', shadow: '#07040d', shadowDy: 1.3 * S,
      });
      x = bx - 10 * S;
    }
  }

  // ══════════════════════════════════════════════ room-entered banner ═════
  _roomBanner(g, W, H, S, t) {
    const age = t - this.roomT;
    if (age < 0 || age > 3.4) return;
    const a = age < 0.4 ? ease.out(age / 0.4) : age > 2.6 ? 1 - ease.out((age - 2.6) / 0.8) : 1;
    const label = this.roomLabel || ((this.biome || '').toUpperCase() + '  ·  CHAMBER ' + roman(this.depth));
    g.save(); g.globalAlpha *= a * 0.95;
    const y = H * 0.155 + (1 - a) * 8 * S;
    const w = trackedWidth(g, label, { size: 15 * S, track: 0.34, weight: 600 });
    const rg = g.createLinearGradient(W / 2 - w, y + 9 * S, W / 2 + w, y + 9 * S);
    rg.addColorStop(0, 'rgba(0,0,0,0)'); rg.addColorStop(0.5, rgba(PAL.gold, 0.55)); rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg; g.fillRect(W / 2 - w, y + 9 * S, w * 2, Math.max(1, 1 * S));
    tracked(g, label, W / 2, y, {
      size: 15 * S, track: 0.34, weight: 600, align: 'center', gold: true, sweep: (t * 0.3) % 1,
      shadow: '#06030c', shadowDy: 2 * S,
    });
    g.restore();
  }
}

// ── weapon glyphs, drawn like the god emblems ──────────────────────────────
function weaponGlyph(q, cx, cy, r, id) {
  q.save(); q.translate(cx, cy);
  const P = (x, y) => [x * r, y * r];
  q.beginPath();
  switch (id) {
    case 'spear':
      q.moveTo(...P(0, -1.0)); q.lineTo(...P(.20, -.60)); q.lineTo(...P(.09, -.52));
      q.lineTo(...P(.09, .86)); q.lineTo(...P(-.09, .86)); q.lineTo(...P(-.09, -.52));
      q.lineTo(...P(-.20, -.60)); q.closePath();
      q.moveTo(...P(-.30, -.44)); q.lineTo(...P(.30, -.44)); q.lineTo(...P(.30, -.32)); q.lineTo(...P(-.30, -.32)); q.closePath();
      break;
    case 'bow':
      q.moveTo(...P(-.30, -.94)); q.bezierCurveTo(...P(.72, -.58), ...P(.72, .58), ...P(-.30, .94));
      q.lineTo(...P(-.14, .78)); q.bezierCurveTo(...P(.50, .46), ...P(.50, -.46), ...P(-.14, -.78)); q.closePath();
      q.moveTo(...P(-.36, -.88)); q.lineTo(...P(-.28, -.88)); q.lineTo(...P(-.28, .88)); q.lineTo(...P(-.36, .88)); q.closePath();
      break;
    case 'shield':
      q.moveTo(...P(0, -.96)); q.bezierCurveTo(...P(.80, -.82), ...P(.82, .16), ...P(0, .96));
      q.bezierCurveTo(...P(-.82, .16), ...P(-.80, -.82), ...P(0, -.96)); q.closePath();
      break;
    default: // blade
      q.moveTo(...P(0, -1.0)); q.lineTo(...P(.17, -.72)); q.lineTo(...P(.17, .40));
      q.lineTo(...P(0, .56)); q.lineTo(...P(-.17, .40)); q.lineTo(...P(-.17, -.72)); q.closePath();
      q.moveTo(...P(-.52, .40)); q.lineTo(...P(.52, .40)); q.lineTo(...P(.52, .54)); q.lineTo(...P(-.52, .54)); q.closePath();
      q.moveTo(...P(-.09, .54)); q.lineTo(...P(.09, .54)); q.lineTo(...P(.09, .96)); q.lineTo(...P(-.09, .96)); q.closePath();
      break;
  }
  const gr = q.createLinearGradient(-r, -r, r * 0.6, r);
  gr.addColorStop(0, '#fff2d4'); gr.addColorStop(0.34, '#e0cfae');
  gr.addColorStop(0.62, '#9d8b74'); gr.addColorStop(1, '#403247');
  q.save(); q.translate(r * 0.06, r * 0.07);
  q.fillStyle = 'rgba(4,2,9,0.9)'; q.fill(); q.restore();
  q.fillStyle = gr; q.fill();
  q.strokeStyle = 'rgba(255,233,168,0.35)'; q.lineWidth = Math.max(0.7, r * 0.04); q.stroke();
  q.restore();
}
