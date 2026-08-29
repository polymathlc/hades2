// OWNER: AGENT-UI
// ---------------------------------------------------------------------------
// WORLD-ANCHORED UI
//   · damage numbers  — bold serif, scale-punch then float and fade; crits
//     larger, gold, with a drop shadow and a struck ring
//   · enemy health bars — appear on damage, hold, fade, with a lag ghost
//   · the boss bar    — ornate, centred, with phase pips
//   · door reward sigils and interaction prompts
//
// Everything is pooled. Projection is a single Vector3.project per label per
// frame; nothing allocates after init.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import {
  PAL, RARITY, plaqueRect, roundRect, goldGradient, tracked, trackedWidth,
  rgba, mix, shade, lift, displayFont, bodyFont, ease, clamp01, meander, palmette,
} from './ornament.js';
import { godEmblem } from './boons.js';

const TYPE_COL = {
  physical:  '#fff1d8',
  fire:      '#ff9a3c',
  lightning: '#ffe14d',
  frost:     '#7fe2ff',
  poison:    '#7ee06a',
  arcane:    '#c9a0ff',
};

const NUM_POOL = 72, BAR_POOL = 24;

export class WorldLabels {
  constructor(ui) {
    this.ui = ui;
    this._v = new THREE.Vector3();
    this.nums = [];
    for (let i = 0; i < NUM_POOL; i++) this.nums.push({ live: false, p: new THREE.Vector3(), t0: 0, amount: 0, crit: false, type: 'physical', dx: 0, dy: 0, rise: 0, life: 1 });
    this.numHead = 0;

    this.bars = [];
    for (let i = 0; i < BAR_POOL; i++) this.bars.push({ live: false, ent: null, t: -9, hp: 1, ghost: 1, name: '', y: 1.7 });
    this.barBy = new Map();

    this.boss = null;         // {name, hp, max, phase, phases, t0, ghost}
    this.prompts = [];        // {p, text, key, until}
    this.sigils = [];         // {p, god, slot, rarity, t0}
  }

  clear() {
    for (const n of this.nums) n.live = false;
    for (const b of this.bars) { b.live = false; b.ent = null; }
    this.barBy.clear();
    this.prompts.length = 0; this.sigils.length = 0;
    this.boss = null;
    this.ui.dirty = true;
  }

  // ── API ──────────────────────────────────────────────────────────────────
  damageNumber(worldPos, amount, o = {}) {
    if (!worldPos) return;
    const n = this.nums[this.numHead];
    this.numHead = (this.numHead + 1) % NUM_POOL;
    n.live = true;
    n.p.set(worldPos.x || 0, (worldPos.y || 0) + (o.height != null ? o.height : 1.25), worldPos.z || 0);
    n.t0 = (o.at != null ? o.at : this.ui.now());
    n.amount = Math.max(0, Math.round(amount || 0));
    n.crit = !!o.crit;
    n.type = o.type && TYPE_COL[o.type] ? o.type : 'physical';
    const r = this.ui.rand();
    n.dx = (r - 0.5) * 46;
    n.dy = -8 - this.ui.rand() * 10;
    n.rise = n.crit ? 62 : 46;
    n.life = n.crit ? 1.25 : 1.0;
    this.ui.dirty = true;
  }

  /** Show/refresh an enemy's health bar. Called from damage.dealt. */
  enemyHealth(ent, hp, max, name) {
    if (!ent) return;
    let b = this.barBy.get(ent);
    if (!b) {
      b = this.bars.find(x => !x.live) || this.bars[0];
      if (b.ent) this.barBy.delete(b.ent);
      b.live = true; b.ent = ent; b.ghost = max ? hp / max : 1;
      this.barBy.set(ent, b);
    }
    b.t = this.ui.now();
    b.hp = max > 0 ? clamp01(hp / max) : 0;
    b.name = name || b.name || '';
    b.y = (ent.height || ent.radius * 3.2 || 1.7) + 0.35;
    this.ui.dirty = true;
  }

  removeEnemy(ent) {
    const b = this.barBy.get(ent);
    if (b) { b.live = false; b.ent = null; this.barBy.delete(ent); }
  }

  setBoss(o) {
    if (!o) { this.boss = null; return; }
    if (!this.boss || this.boss.name !== o.name) this.boss = { name: o.name || 'THE WARDEN', hp: 1, ghost: 1, phase: 1, phases: o.phases || 3, t0: this.ui.now() };
    if (o.hp != null && o.max) this.boss.hp = clamp01(o.hp / o.max);
    else if (o.frac != null) this.boss.hp = clamp01(o.frac);
    if (o.phase) this.boss.phase = o.phase;
    if (o.phases) this.boss.phases = o.phases;
    this.ui.dirty = true;
  }

  prompt(worldPos, text, o = {}) {
    if (!worldPos) return;
    this.prompts.push({ p: new THREE.Vector3(worldPos.x, (worldPos.y || 0) + (o.height != null ? o.height : 1.6), worldPos.z), text: String(text), key: o.key || 'E', until: this.ui.now() + (o.dur || 1e9), t0: this.ui.now() });
    if (this.prompts.length > 8) this.prompts.shift();
    this.ui.dirty = true;
  }
  clearPrompts() { this.prompts.length = 0; this.ui.dirty = true; }

  sigil(worldPos, o = {}) {
    if (!worldPos) return;
    this.sigils.push({ p: new THREE.Vector3(worldPos.x, (worldPos.y || 0) + (o.height != null ? o.height : 2.6), worldPos.z), god: o.god || 'zeus', slot: o.slot || 'passive', rarity: o.rarity || 'common', t0: this.ui.now() });
    if (this.sigils.length > 6) this.sigils.shift();
    this.ui.dirty = true;
  }
  clearSigils() { this.sigils.length = 0; this.ui.dirty = true; }

  // ── update ───────────────────────────────────────────────────────────────
  update(dt, t) {
    let any = false;
    for (const n of this.nums) { if (n.live) { if (t - n.t0 > n.life) n.live = false; else any = true; } }
    for (const b of this.bars) {
      if (!b.live) continue;
      if (t - b.t > 2.8) { b.live = false; this.barBy.delete(b.ent); b.ent = null; continue; }
      if (b.ghost > b.hp) b.ghost = Math.max(b.hp, b.ghost - dt * (0.30 + (b.ghost - b.hp) * 2.6));
      else b.ghost = b.hp;
      any = true;
    }
    if (this.boss) {
      if (this.boss.ghost > this.boss.hp) this.boss.ghost = Math.max(this.boss.hp, this.boss.ghost - dt * (0.16 + (this.boss.ghost - this.boss.hp) * 1.4));
      else this.boss.ghost = this.boss.hp;
      any = true;
    }
    if (this.prompts.length) { const now = t; for (let i = this.prompts.length - 1; i >= 0; i--) if (this.prompts[i].until < now) this.prompts.splice(i, 1); any = true; }
    if (this.sigils.length) any = true;
    if (any) this.ui.dirty = true;
  }

  // ── project ──────────────────────────────────────────────────────────────
  _proj(p, cam, W, H, out) {
    this._v.copy(p).project(cam);
    out.x = (this._v.x * 0.5 + 0.5) * W;
    out.y = (-this._v.y * 0.5 + 0.5) * H;
    out.ok = this._v.z < 1 && out.x > -260 && out.x < W + 260 && out.y > -160 && out.y < H + 160;
    return out;
  }

  // ── draw ─────────────────────────────────────────────────────────────────
  draw(g, W, H, S, t, cam) {
    if (!cam) return;
    const o = this._out || (this._out = { x: 0, y: 0, ok: false });

    // ── enemy bars (behind everything else world-space) ──
    for (const b of this.bars) {
      if (!b.live || !b.ent || !b.ent.position) continue;
      const p = b.ent.position;
      this._v.set(p.x, (p.y || 0) + b.y, p.z);
      this._proj(this._v, cam, W, H, o);
      if (!o.ok) continue;
      const age = t - b.t;
      const a = age < 0.12 ? age / 0.12 : age > 2.2 ? 1 - (age - 2.2) / 0.6 : 1;
      this._enemyBar(g, o.x, o.y, clamp01(a), b, S);
    }

    // ── reward sigils above doors ──
    for (const s of this.sigils) {
      this._proj(s.p, cam, W, H, o);
      if (!o.ok) continue;
      this._sigil(g, o.x, o.y, S, t, s);
    }

    // ── interaction prompts ──
    for (const pr of this.prompts) {
      this._proj(pr.p, cam, W, H, o);
      if (!o.ok) continue;
      this._prompt(g, o.x, o.y, S, t, pr);
    }

    // ── damage numbers (always on top) ──
    for (const n of this.nums) {
      if (!n.live) continue;
      const age = t - n.t0;
      if (age < 0) continue;
      this._proj(n.p, cam, W, H, o);
      if (!o.ok) continue;
      this._number(g, o.x, o.y, S, n, age);
    }

    // ── boss bar ──
    if (this.boss) this._bossBar(g, W, H, S, t);
  }

  _number(g, x, y, S, n, age) {
    const f = clamp01(age / n.life);
    // fast pop, hold, slow float; fade only in the last third
    const pop = age < 0.13 ? ease.out(age / 0.13) * 1.28 : 1.28 - 0.28 * ease.out(clamp01((age - 0.13) / 0.24));
    const rise = ease.outQuint(f) * n.rise * S;
    const alpha = f < 0.62 ? 1 : 1 - ease.out((f - 0.62) / 0.38);
    const drift = n.dx * S * (0.35 + f * 0.65);
    const px = x + drift, py = y + n.dy * S - rise;
    const size = (n.crit ? 33 : 22) * S * pop;
    const col = n.crit ? null : TYPE_COL[n.type];

    g.save();
    g.globalAlpha *= alpha;
    const txt = String(n.amount);
    if (n.crit) {
      // struck ring behind the crit
      g.save(); g.globalCompositeOperation = 'lighter'; g.globalAlpha *= 0.5 * (1 - f);
      const rr = size * (0.7 + f * 1.5);
      const rg = g.createRadialGradient(px, py - size * 0.32, rr * 0.2, px, py - size * 0.32, rr);
      rg.addColorStop(0, rgba('#ffe9a8', 0.45)); rg.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = rg; g.beginPath(); g.arc(px, py - size * 0.32, rr, 0, 6.2832); g.fill();
      g.restore();
      tracked(g, txt, px, py, {
        size, track: 0.02, weight: 800, align: 'center', gold: true, sweep: 0.5,
        shadow: 'rgba(20,4,2,0.95)', shadowDy: 3.4 * S, shadowAlpha: 1,
      });
      tracked(g, '!', px + trackedWidth(g, txt, { size, track: 0.02, weight: 800 }) / 2 + size * 0.20, py, {
        size: size * 0.8, track: 0, weight: 800, align: 'center', color: '#ffe9a8', shadow: 'rgba(20,4,2,0.9)', shadowDy: 3 * S,
      });
    } else {
      tracked(g, txt, px, py, {
        size, track: 0.02, weight: 700, align: 'center', color: col,
        shadow: 'rgba(8,2,10,0.9)', shadowDy: 2.4 * S, shadowAlpha: 0.9,
      });
    }
    g.restore();
  }

  _enemyBar(g, x, y, a, b, S) {
    const w = 56 * S, h = 5.4 * S;
    const bx = x - w / 2, by = y;
    g.save(); g.globalAlpha *= a;
    // backing
    g.fillStyle = 'rgba(6,3,12,0.82)'; g.fillRect(bx - 1.4 * S, by - 1.4 * S, w + 2.8 * S, h + 2.8 * S);
    // ghost
    if (b.ghost > b.hp + 0.002) { g.fillStyle = rgba('#ffb27a', 0.55); g.fillRect(bx + w * b.hp, by, w * (b.ghost - b.hp), h); }
    // fill
    const fg = g.createLinearGradient(bx, by, bx, by + h);
    fg.addColorStop(0, '#ff7a86'); fg.addColorStop(0.4, '#c81d3c'); fg.addColorStop(1, '#6b0c1e');
    g.fillStyle = fg; g.fillRect(bx, by, w * b.hp, h);
    // rim
    g.strokeStyle = rgba(PAL.goldMid, 0.75); g.lineWidth = Math.max(0.8, 1 * S);
    g.strokeRect(bx - 1.4 * S, by - 1.4 * S, w + 2.8 * S, h + 2.8 * S);
    // end caps
    g.fillStyle = rgba(PAL.gold, 0.85);
    g.fillRect(bx - 3.2 * S, by - 1.4 * S, 2 * S, h + 2.8 * S);
    g.fillRect(bx + w + 1.2 * S, by - 1.4 * S, 2 * S, h + 2.8 * S);
    g.restore();
  }

  _bossBar(g, W, H, S, t) {
    const b = this.boss;
    const w = Math.min(W * 0.46, 660 * S), h = 19 * S;
    const x = (W - w) / 2, y = 44 * S;
    const age = t - b.t0;
    const intro = ease.out(clamp01(age / 0.6));
    g.save(); g.globalAlpha *= intro;
    g.translate(0, (1 - intro) * -18 * S);

    // name
    tracked(g, b.name.toUpperCase(), W / 2, y - 12 * S, {
      size: 17 * S, track: 0.30, weight: 700, align: 'center', gold: true, sweep: (t * 0.16) % 1,
      shadow: '#06030c', shadowDy: 2.4 * S,
    });

    // well
    plaqueRect(g, x, y, w, h, 6 * S);
    const wg = g.createLinearGradient(x, y, x, y + h);
    wg.addColorStop(0, '#1c0810'); wg.addColorStop(1, '#0a0410');
    g.fillStyle = wg; g.fill();

    g.save(); plaqueRect(g, x, y, w, h, 6 * S); g.clip();
    if (b.ghost > b.hp + 0.002) { g.fillStyle = rgba('#ffb27a', 0.6); g.fillRect(x + w * b.hp, y, w * (b.ghost - b.hp), h); }
    const fg = g.createLinearGradient(x, y, x, y + h);
    fg.addColorStop(0, '#ff6a72'); fg.addColorStop(0.2, '#c81d3c');
    fg.addColorStop(0.62, '#83102a'); fg.addColorStop(1, '#420615');
    g.fillStyle = fg; g.fillRect(x, y, w * b.hp, h);
    g.fillStyle = rgba('#ff9aa6', 0.4); g.fillRect(x, y + 1.2 * S, w * b.hp, 1.6 * S);
    g.fillStyle = rgba('#ffd0c0', 0.85); g.fillRect(x + w * b.hp - 2.4 * S, y, 2.4 * S, h);
    // phase divisions
    for (let i = 1; i < b.phases; i++) {
      const px = x + (w * i) / b.phases;
      g.fillStyle = 'rgba(6,3,12,0.8)'; g.fillRect(px - 1.2 * S, y, 2.4 * S, h);
      g.fillStyle = rgba(PAL.gold, 0.5); g.fillRect(px + 1.2 * S, y, 0.8 * S, h);
    }
    g.restore();

    plaqueRect(g, x, y, w, h, 6 * S);
    g.strokeStyle = goldGradient(g, x, y, x, y + h, (t * 0.2) % 1); g.lineWidth = 2 * S; g.stroke();
    // ornate ends
    palmette(g, x - 4 * S, y + h / 2, 13 * S, { rot: -Math.PI / 2, lobes: 6 });
    palmette(g, x + w + 4 * S, y + h / 2, 13 * S, { rot: Math.PI / 2, lobes: 6 });
    // phase pips under the bar
    const pr = 4.6 * S, gap = 15 * S, n = b.phases;
    for (let i = 0; i < n; i++) {
      const px = W / 2 + (i - (n - 1) / 2) * gap, py = y + h + 11 * S;
      const on = i < b.phase;
      g.beginPath(); g.arc(px, py, pr, 0, 6.2832);
      if (on) { const pg = g.createRadialGradient(px - pr * 0.3, py - pr * 0.4, 0, px, py, pr); pg.addColorStop(0, '#ffe9a8'); pg.addColorStop(1, '#c98f2b'); g.fillStyle = pg; }
      else g.fillStyle = 'rgba(40,26,14,0.9)';
      g.fill();
      g.strokeStyle = rgba(PAL.bronze, 0.9); g.lineWidth = 1 * S; g.stroke();
    }
    g.restore();
  }

  _prompt(g, x, y, S, t, pr) {
    const bob = Math.sin(t * 2.4) * 2 * S;
    const size = 12 * S;
    const tw = trackedWidth(g, pr.text.toUpperCase(), { size, track: 0.22, weight: 600 });
    const kw = 20 * S, w = tw + kw + 30 * S, h = 26 * S;
    const bx = x - w / 2, by = y - h / 2 + bob;
    g.save();
    plaqueRect(g, bx, by, w, h, 5 * S);
    g.fillStyle = 'rgba(10,6,18,0.86)'; g.fill();
    g.strokeStyle = goldGradient(g, bx, by, bx + w, by + h, (t * 0.4) % 1); g.lineWidth = 1.4 * S; g.stroke();
    // key cap
    const kx = bx + 9 * S, ky = by + (h - kw) / 2;
    plaqueRect(g, kx, ky, kw, kw, 3 * S);
    const kg = g.createLinearGradient(kx, ky, kx, ky + kw);
    kg.addColorStop(0, '#3a2b16'); kg.addColorStop(1, '#160e08');
    g.fillStyle = kg; g.fill();
    g.strokeStyle = rgba(PAL.gold, 0.8); g.lineWidth = 1.1 * S; g.stroke();
    tracked(g, pr.key, kx + kw / 2, ky + kw * 0.72, { size: 11 * S, track: 0, weight: 700, align: 'center', color: '#ffe9a8' });
    tracked(g, pr.text.toUpperCase(), bx + kw + 20 * S, by + h * 0.66, {
      size, track: 0.22, weight: 600, align: 'left', color: '#efe2c6', shadow: '#07040d', shadowDy: 1.4 * S,
    });
    g.restore();
  }

  _sigil(g, x, y, S, t, s) {
    const r = 20 * S;
    const bob = Math.sin(t * 1.6 + x * 0.01) * 2.4 * S;
    const cy = y + bob;
    const R = RARITY[s.rarity] || RARITY.common;
    g.save();
    g.beginPath(); g.arc(x, cy, r * 1.06, 0, 6.2832);
    g.fillStyle = 'rgba(9,5,16,0.85)'; g.fill();
    g.strokeStyle = goldGradient(g, x - r, cy - r, x + r, cy + r, (t * 0.25) % 1); g.lineWidth = 2 * S; g.stroke();
    g.beginPath(); g.arc(x, cy, r * 0.82, 0, 6.2832);
    g.strokeStyle = rgba(R.text, 0.7); g.lineWidth = 1 * S; g.stroke();
    godEmblem(g, x, cy, r * 0.5, s.god, { glowA: 0.4, glowR: 2.2 });
    g.restore();
  }
}
