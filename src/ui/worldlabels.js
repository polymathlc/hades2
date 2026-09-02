// OWNER: AGENT-UI
// ---------------------------------------------------------------------------
// WORLD-ANCHORED UI
//   · damage numbers  — bold serif, scale-punch then float and fade; crits
//     larger, gold, with a drop shadow and a struck ring. Repeated hits on
//     one target inside 0.4 s fold into the number in flight (it grows and
//     re-pops); a differently-styled hit fans out to its own lane instead of
//     landing on top of the first.
//   · enemy health bars — appear on damage, hold, fade, with a lag ghost;
//     colour-banded green / amber / red (or the safe set), a guard meter
//     where the enemy exposes one, an armour mark and an elite affix tag
//   · the boss plate   — ornate, centred, live from `boss.spawned`, with a
//     name plate, phase pips and an enrage state
//   · door reward sigils and interaction prompts
//
// Everything is pooled. Projection is a single Vector3.project per label per
// frame; nothing allocates after init.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import {
  PAL, RARITY, plaqueRect, roundRect, goldGradient, tracked, trackedWidth,
  rgba, mix, shade, lift, displayFont, bodyFont, ease, clamp01, meander, palmette, keyCap,
} from './ornament.js';
import { godEmblem } from './boons.js';
import {
  damageColor, DAMAGE_TYPE_COLORS, DAMAGE_TYPE_GLYPH,
  damageStackRule, fanOffset, stackScale, healthBand, guardFrac, bossModel, DAMAGE_STACK_WINDOW,
} from './hud-boons.js';

const TYPE_COL = DAMAGE_TYPE_COLORS.normal;

const NUM_POOL = 72, BAR_POOL = 24;
const NUM_RISE_T = 1.0;                 // seconds the float takes; fade is timed from the LAST hit
const ELITE_COLOR = { armoured: '#c9b8ff', swift: '#7ee06a', volatile: '#ff9a3c', warded: '#8ef0d0' };

export class WorldLabels {
  constructor(ui) {
    this.ui = ui;
    this._v = new THREE.Vector3();
    this.nums = [];
    for (let i = 0; i < NUM_POOL; i++) this.nums.push({
      live: false, p: new THREE.Vector3(), t0: 0, until: 0, lastHit: 0, popT: 0, amount: 0, lastAmount: 0, crit: false, type: 'physical',
      dx: 0, dy: 0, rise: 0, life: 1, target: null, hits: 1, lane: 0, fan: 0,
    });
    this.numHead = 0;
    this.numBy = new Map();   // target -> the number most recently struck on it

    this.bars = [];
    for (let i = 0; i < BAR_POOL; i++) this.bars.push({ live: false, ent: null, t: -9, hp: 1, ghost: 1, name: '', y: 1.7, born: 0 });
    this.barBy = new Map();

    this.boss = null;         // bossModel() + {ghost, t0, hitT}
    this.prompts = [];        // {p, text, key, until}
    this.sigils = [];         // {p, god, slot, rarity, t0}
  }

  clear() {
    for (const n of this.nums) { n.live = false; n.target = null; }
    this.numBy.clear();
    for (const b of this.bars) { b.live = false; b.ent = null; }
    this.barBy.clear();
    this.prompts.length = 0; this.sigils.length = 0;
    this.boss = null;
    this.ui.dirty = true;
  }

  // ── API ──────────────────────────────────────────────────────────────────
  damageNumber(worldPos, amount, o = {}) {
    if (!worldPos) return null;
    const now = (o.at != null ? o.at : this.ui.now());
    const amt = Math.max(0, Math.round(amount || 0));
    const target = o.target || null;
    const px = worldPos.x || 0, py = (worldPos.y || 0) + (o.height != null ? o.height : 1.25), pz = worldPos.z || 0;
    // the number this hit belongs with: the target's own, or — the direct
    // ui.damageNumber paths carry no target — the nearest one in flight. A
    // far-ish neighbour (the enemy's own call reports from its centre, the
    // combat system from the contact point) only counts when it is the SAME
    // hit reported twice; a real second hit must be close to fold.
    let prev = target ? this.numBy.get(target) : null;
    let far = false;
    if (!prev) { prev = this._nearestNumber(px, pz, now, 2.4); far = !!prev && this._nearD > 1.2 * 1.2; }
    let rule = damageStackRule(prev, { crit: o.crit, type: o.type, amount: amt }, now);
    if (far && rule.mode !== 'dupe') { prev = null; rule = { mode: 'new', lane: 0 }; }
    // two foes struck by one swing must never share a number: a neighbour's
    // number only decides the fan lane, so the new one lands beside it
    if (prev && target && prev.target && prev.target !== target) rule = { mode: 'fan', lane: (prev.fan | 0) + 1 };
    if (rule.mode === 'dupe') { if (target && !prev.target) { prev.target = target; this.numBy.set(target, prev); } return prev; }
    if (rule.mode === 'merge') {
      // fold into the number in flight: it grows, re-pops and follows the target
      prev.amount += amt; prev.hits++; prev.lastAmount = amt;
      prev.lastHit = now; prev.popT = now;
      prev.until = now + prev.life;
      prev.p.set(px, py, pz);
      if (target && !prev.target) { prev.target = target; this.numBy.set(target, prev); }
      this.ui.dirty = true;
      return prev;
    }
    const n = this.nums[this.numHead];
    this.numHead = (this.numHead + 1) % NUM_POOL;
    if (n.target && this.numBy.get(n.target) === n) this.numBy.delete(n.target);
    n.live = true;
    n.p.set(px, py, pz);
    n.t0 = now; n.lastHit = now; n.popT = now;
    n.amount = amt; n.lastAmount = amt;
    n.hits = 1;
    n.crit = !!o.crit;
    n.type = o.type && TYPE_COL[o.type] ? o.type : 'physical';
    n.target = target;
    n.lane = rule.lane; n.fan = rule.lane;
    const r = this.ui.rand();
    n.dx = fanOffset(rule.lane) + (r - 0.5) * (rule.lane ? 6 : 26);
    n.dy = -8 - this.ui.rand() * 10;
    n.rise = n.crit ? 62 : 46;
    n.life = n.crit ? 1.25 : 1.0;
    n.until = now + n.life;
    if (target) { if (prev && prev.live) prev.fan = rule.lane; this.numBy.set(target, n); }
    this.ui.dirty = true;
    return n;
  }

  /** The most recently struck live number within `r` world units on the ground plane. */
  _nearestNumber(x, z, now, r) {
    let best = null, bestD = r * r;
    for (const n of this.nums) {
      if (!n.live || now - n.lastHit > DAMAGE_STACK_WINDOW) continue;
      const dx = n.p.x - x, dz = n.p.z - z, d = dx * dx + dz * dz;
      if (d < bestD || (d === bestD && best && n.lastHit > best.lastHit)) { best = n; bestD = d; }
    }
    this._nearD = bestD;
    return best;
  }

  /** Show/refresh an enemy's health bar. Called from damage.dealt. */
  enemyHealth(ent, hp, max, name) {
    if (!ent) return;
    let b = this.barBy.get(ent);
    if (!b) {
      b = this.bars.find(x => !x.live) || this.bars[0];
      if (b.ent) this.barBy.delete(b.ent);
      b.live = true; b.ent = ent; b.ghost = max ? hp / max : 1; b.born = this.ui.now();
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
    const n = this.numBy.get(ent);
    if (n) this.numBy.delete(ent);
  }

  /**
   * setBoss({name, hp, max | frac, phases, phase, enraged}) — any subset. The
   * plate lands the first time it is called (boss.spawned) and updates in
   * place after that; setBoss(null) removes it.
   */
  setBoss(o) {
    if (!o) { this.boss = null; this.ui.dirty = true; return; }
    const fresh = !this.boss || (o.name && this.boss.name !== o.name);
    const prev = fresh ? null : this.boss;
    const m = bossModel(prev, o);
    if (fresh) this.boss = { ...m, ghost: m.hp, t0: this.ui.now(), hitT: -9, enrageT: -9 };
    else {
      if (m.hp < this.boss.hp - 0.0005) this.boss.hitT = this.ui.now();
      if (m.enraged && !this.boss.enraged) this.boss.enrageT = this.ui.now();
      Object.assign(this.boss, m);
    }
    this.ui.dirty = true;
  }

  prompt(worldPos, text, o = {}) {
    if (!worldPos) return;
    // `key` may be a literal cap ("W") or an ACTION name ("interact") — an
    // action resolves to the live binding and to the pad glyph when a pad is
    // in use, so a remapped key never leaves a stale prompt in the world.
    const key = o.key || 'interact';
    const action = o.action || ({ E: 'interact', F: 'interact', Q: 'cast', R: 'summon', SPACE: 'dash' }[String(key).toUpperCase()] || null);
    this.prompts.push({ p: new THREE.Vector3(worldPos.x, (worldPos.y || 0) + (o.height != null ? o.height : 1.6), worldPos.z),
      world: new THREE.Vector3(worldPos.x, worldPos.y || 0, worldPos.z),
      text: String(text), key, action, until: this.ui.now() + (o.dur || 1e9), t0: this.ui.now(), maxDistance: o.maxDistance ?? Infinity, near: 0 });
    if (this.prompts.length > 24) this.prompts.shift();
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
    for (const n of this.nums) {
      if (!n.live) continue;
      if (t > n.until) { n.live = false; if (n.target && this.numBy.get(n.target) === n) this.numBy.delete(n.target); n.target = null; }
      else any = true;
    }
    for (const b of this.bars) {
      if (!b.live) continue;
      if (t - b.t > 2.8 || (b.ent && b.ent.dead)) { b.live = false; this.barBy.delete(b.ent); b.ent = null; continue; }
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
      this._enemyBar(g, o.x, o.y, clamp01(a), b, S, t);
    }

    // ── reward sigils above doors ──
    for (const s of this.sigils) {
      this._proj(s.p, cam, W, H, o);
      if (!o.ok) continue;
      this._sigil(g, o.x, o.y, S, t, s);
    }

    // ── interaction prompts ──
    // In range: the full plaque with its key cap. Out of range but nearby: a
    // small gold marker so the player knows something can be used there. The
    // marker eases up into the plaque as they approach — no popping.
    for (const pr of this.prompts) {
      const player = this.ui.ctx?.player?.position;
      let near = 1;
      if (player && Number.isFinite(pr.maxDistance)) {
        const d = Math.hypot(player.x - pr.world.x, player.z - pr.world.z);
        if (d > pr.maxDistance * 3.2) continue;
        near = d <= pr.maxDistance ? 1 : clamp01(1 - (d - pr.maxDistance) / (pr.maxDistance * 0.9));
      }
      this._proj(pr.p, cam, W, H, o);
      if (!o.ok) continue;
      if (near >= 0.999) this._prompt(g, o.x, o.y, S, t, pr);
      else this._marker(g, o.x, o.y, S, t, pr, near);
    }

    // ── damage numbers (always on top) ──
    for (const n of this.nums) {
      if (!n.live) continue;
      const age = t - n.t0;
      if (age < 0) continue;
      this._proj(n.p, cam, W, H, o);
      if (!o.ok) continue;
      this._number(g, o.x, o.y, S, n, age, t);
    }

    // ── boss bar ──
    if (this.boss) this._bossBar(g, W, H, S, t);
  }

  _number(g, x, y, S, n, age, t) {
    // fast pop (replayed on every merged hit), hold, slow float; the fade is
    // timed from the last hit so a growing number never dies mid-combo
    const pa = t - n.popT;
    const pop = pa < 0.13 ? ease.out(pa / 0.13) * 1.28 : 1.28 - 0.28 * ease.out(clamp01((pa - 0.13) / 0.24));
    const rise = ease.outQuint(clamp01(age / NUM_RISE_T)) * n.rise * S;
    const left = n.until - t;
    const alpha = left > 0.38 ? 1 : ease.out(clamp01(left / 0.38));
    const drift = n.dx * S * (0.55 + clamp01(age / NUM_RISE_T) * 0.45);
    const px = x + drift, py = y + n.dy * S - rise;
    const size = (n.crit ? 33 : 22) * S * pop * stackScale(n.hits);
    const cb = !!this.ui.settings?.colorBlind;
    const col = n.crit ? null : damageColor(n.type, cb);
    // with the safe palette a type also carries a glyph, so hue is never the
    // only channel telling the player what kind of damage that was
    const suffix = cb && DAMAGE_TYPE_GLYPH[n.type] ? DAMAGE_TYPE_GLYPH[n.type] : '';

    g.save();
    g.globalAlpha *= alpha;
    const txt = String(n.amount);
    let w;
    if (n.crit) {
      // struck ring behind the crit
      const f = clamp01(age / n.life);
      g.save(); g.globalCompositeOperation = 'lighter'; g.globalAlpha *= 0.5 * (1 - f);
      const rr = size * (0.7 + f * 1.5);
      const rg = g.createRadialGradient(px, py - size * 0.32, rr * 0.2, px, py - size * 0.32, rr);
      rg.addColorStop(0, rgba('#ffe9a8', 0.45)); rg.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = rg; g.beginPath(); g.arc(px, py - size * 0.32, rr, 0, 6.2832); g.fill();
      g.restore();
      w = tracked(g, txt, px, py, {
        size, track: 0.02, weight: 800, align: 'center', gold: true, sweep: 0.5,
        shadow: 'rgba(20,4,2,0.95)', shadowDy: 3.4 * S, shadowAlpha: 1,
      });
      tracked(g, '!', px + w / 2 + size * 0.20, py, {
        size: size * 0.8, track: 0, weight: 800, align: 'center', color: '#ffe9a8', shadow: 'rgba(20,4,2,0.9)', shadowDy: 3 * S,
      });
    } else {
      w = tracked(g, txt, px, py, {
        size, track: 0.02, weight: 700, align: 'center', color: col,
        shadow: 'rgba(8,2,10,0.9)', shadowDy: 2.4 * S, shadowAlpha: 0.9,
      });
      if (suffix) tracked(g, suffix, px + w / 2 + size * 0.34, py, {
        size: size * 0.6, track: 0, weight: 700, align: 'center', color: col, shadow: 'rgba(8,2,10,0.9)', shadowDy: 2 * S,
      });
    }
    // a merged number says how many hits it is — small, above the tail
    if (n.hits > 1) tracked(g, `×${n.hits}`, px + w / 2 + size * (n.crit ? 0.55 : 0.36) + (suffix ? size * 0.5 : 0), py - size * 0.55, {
      size: size * 0.38, track: 0.02, weight: 700, align: 'left', color: n.crit ? '#ffe9a8' : rgba(col || '#fff1d8', 0.9), shadow: 'rgba(8,2,10,0.9)', shadowDy: 1.5 * S,
    });
    g.restore();
  }

  /** The out-of-range affordance: a bobbing gold lozenge with a faint tether. */
  _marker(g, x, y, S, t, pr, near) {
    const bob = Math.sin(t * 2.4 + x * 0.02) * 2 * S;
    const s = (5 + 5 * near) * S;
    g.save(); g.globalAlpha *= 0.35 + 0.65 * near;
    g.translate(x, y + bob);
    g.beginPath(); g.moveTo(0, -s * 1.4); g.lineTo(s * 0.8, 0); g.lineTo(0, s * 1.4); g.lineTo(-s * 0.8, 0); g.closePath();
    g.fillStyle = 'rgba(10,6,18,0.85)'; g.fill();
    g.strokeStyle = goldGradient(g, -s, -s, s, s, (t * 0.4) % 1); g.lineWidth = 1.3 * S; g.stroke();
    g.beginPath(); g.arc(0, 0, s * 0.28, 0, 6.2832); g.fillStyle = rgba(PAL.goldHi, 0.85); g.fill();
    g.restore();
  }

  _enemyBar(g, x, y, a, b, S, t) {
    const ent = b.ent;
    const elite = ent && ent.elite ? String(ent.elite) : null;
    const armour = ent && ent.armour > 0;
    const guard = guardFrac(ent);
    const broken = !!(ent && ent.mem && ent.mem.guardBroken > 0 && ent.shielded === false);
    const cb = !!this.ui.settings?.colorBlind;
    const band = healthBand(b.hp, cb);
    const w = (elite ? 104 : 84) * S, h = 8 * S;
    const bx = x - w / 2, by = y;
    g.save(); g.globalAlpha *= a;
    // backing
    g.fillStyle = 'rgba(6,3,12,0.84)'; g.fillRect(bx - 1.6 * S, by - 1.6 * S, w + 3.2 * S, h + 3.2 * S);
    // ghost — the damage-lag trail, hatched under the safe palette
    if (b.ghost > b.hp + 0.002) {
      g.fillStyle = rgba(cb ? '#ffffff' : '#ffb27a', cb ? 0.75 : 0.55); g.fillRect(bx + w * b.hp, by, w * (b.ghost - b.hp), h);
    }
    // fill in the band colour, a lit top and a leading cap
    const fw = w * b.hp;
    if (fw > 0.5) {
      const fg = g.createLinearGradient(bx, by, bx, by + h);
      fg.addColorStop(0, lift(band.color, 0.35)); fg.addColorStop(0.4, band.color); fg.addColorStop(1, shade(band.color, 0.55));
      g.fillStyle = fg; g.fillRect(bx, by, fw, h);
      g.fillStyle = rgba('#fff4dc', 0.28); g.fillRect(bx, by + 0.8 * S, fw, Math.max(1, 1.1 * S));
      g.fillStyle = rgba('#fff4dc', 0.85); g.fillRect(bx + fw - 1.6 * S, by, 1.6 * S, h);
      // the low band also hatches so the state is not carried by hue alone
      if (band.key === 'low') {
        g.save(); g.globalAlpha *= 0.45; g.strokeStyle = '#2a0810'; g.lineWidth = 1 * S;
        for (let px = bx - h; px < bx + fw; px += 4.5 * S) { g.beginPath(); g.moveTo(px, by + h); g.lineTo(px + h, by); g.stroke(); }
        g.restore();
      }
    }
    // quarter ticks — the band thresholds are readable as marks
    for (let i = 1; i < 4; i++) {
      const px = bx + (w * i) / 4;
      g.fillStyle = 'rgba(6,3,12,0.7)'; g.fillRect(px - 0.6 * S, by, 1.2 * S, h);
    }
    // rim + end caps
    g.strokeStyle = rgba(elite ? (ELITE_COLOR[elite] || PAL.goldHi) : PAL.goldMid, 0.8); g.lineWidth = Math.max(0.8, 1 * S);
    g.strokeRect(bx - 1.6 * S, by - 1.6 * S, w + 3.2 * S, h + 3.2 * S);
    g.fillStyle = rgba(PAL.gold, 0.85);
    g.fillRect(bx - 3.6 * S, by - 1.6 * S, 2 * S, h + 3.2 * S);
    g.fillRect(bx + w + 1.6 * S, by - 1.6 * S, 2 * S, h + 3.2 * S);

    // ── the guard meter (brute): a thin gold bar under the life bar ──
    let below = by + h + 3.2 * S;
    if (guard != null || broken) {
      const gh = 3.6 * S;
      g.fillStyle = 'rgba(6,3,12,0.84)'; g.fillRect(bx - 1.6 * S, below, w + 3.2 * S, gh + 2 * S);
      if (broken) {
        const blink = 0.55 + 0.45 * Math.sin(t * 9);
        g.fillStyle = rgba(PAL.goldHi, 0.25 * blink); g.fillRect(bx, below + 1 * S, w, gh);
        tracked(g, 'GUARD BROKEN', x, below + gh + 12 * S, { size: 8.5 * S, track: 0.22, weight: 700, align: 'center', color: rgba(PAL.goldHi, 0.6 + 0.4 * blink), shadow: '#05030b', shadowDy: 1.2 * S });
        below += gh + 16 * S;
      } else {
        g.fillStyle = goldGradient(g, bx, below, bx + w * guard, below + gh, 0.35); g.fillRect(bx, below + 1 * S, w * guard, gh);
        g.strokeStyle = rgba(PAL.bronze, 0.9); g.lineWidth = Math.max(0.7, 0.8 * S); g.strokeRect(bx - 1.6 * S, below, w + 3.2 * S, gh + 2 * S);
        // a small shield glyph names the meter
        this._shieldGlyph(g, bx - 9 * S, below + gh / 2 + 1 * S, 4 * S, PAL.goldHi);
        below += gh + 3 * S;
      }
    }
    // ── armour: a bronze plate mark at the left cap ──
    if (armour) this._shieldGlyph(g, bx - 10 * S, by + h / 2, 4.6 * S, '#c9b8ff', true);

    // ── the elite affix tag, above the bar in the affix colour ──
    if (elite) {
      const c = ELITE_COLOR[elite] || PAL.goldHi;
      const label = `ELITE · ${elite.toUpperCase()}`;
      const size = 8.5 * S;
      const tw = trackedWidth(g, label, { size, track: 0.22, weight: 700 });
      const pw = tw + 16 * S, ph = 14 * S, pyy = by - 1.6 * S - ph - 3 * S;
      plaqueRect(g, x - pw / 2, pyy, pw, ph, 3 * S);
      g.fillStyle = 'rgba(8,4,14,0.86)'; g.fill();
      g.strokeStyle = rgba(c, 0.85); g.lineWidth = Math.max(0.8, 1 * S); g.stroke();
      tracked(g, label, x, pyy + ph * 0.74, { size, track: 0.22, weight: 700, align: 'center', color: lift(c, 0.2), shadow: '#05030b', shadowDy: 1 * S });
      // the name sits under the bar for an elite so the tag and the body agree
      if (b.name) {
        const nm = String(b.name).toUpperCase();
        tracked(g, nm, x, below + 9.5 * S, { size: 7.8 * S, track: 0.16, weight: 600, align: 'center', color: rgba(PAL.parch, 0.85), shadow: '#05030b', shadowDy: 1 * S });
      }
    }
    g.restore();
  }

  _shieldGlyph(g, cx, cy, r, color, plate = false) {
    g.save(); g.translate(cx, cy);
    g.beginPath(); g.moveTo(0, -r); g.lineTo(r * 0.85, -r * 0.55); g.lineTo(r * 0.7, r * 0.35); g.lineTo(0, r); g.lineTo(-r * 0.7, r * 0.35); g.lineTo(-r * 0.85, -r * 0.55); g.closePath();
    g.fillStyle = 'rgba(8,4,14,0.9)'; g.fill();
    g.strokeStyle = rgba(color, 0.95); g.lineWidth = Math.max(0.8, r * 0.28); g.stroke();
    if (plate) { g.beginPath(); g.moveTo(-r * 0.4, 0); g.lineTo(r * 0.4, 0); g.moveTo(0, -r * 0.5); g.lineTo(0, r * 0.5); g.stroke(); }
    g.restore();
  }

  _bossBar(g, W, H, S, t) {
    const b = this.boss;
    const w = Math.min(W * 0.46, 660 * S), h = 19 * S;
    const x = (W - w) / 2, y = 64 * S;
    const age = t - b.t0;
    const intro = ease.out(clamp01(age / 0.6));
    const cb = !!this.ui.settings?.colorBlind;
    const C = cb ? { hi: '#ffb27a', core: '#e4572e', mid: '#9a3a1e', deep: '#4a1a0c' } : { hi: '#ff6a72', core: '#c81d3c', mid: '#83102a', deep: '#420615' };
    const enraged = !!b.enraged;
    g.save(); g.globalAlpha *= intro;
    g.translate(0, (1 - intro) * -18 * S);

    // ── the name plate: a dark tablet with palmette ends, above the bar ──
    const nameSize = Math.min(17 * S, w / 22);
    const name = String(b.name).toUpperCase();
    const tw = trackedWidth(g, name, { size: nameSize, track: 0.30, weight: 700 });
    const pw = Math.min(w + 40 * S, tw + 76 * S), ph = 28 * S, px = W / 2 - pw / 2, py = y - ph - 8 * S;
    plaqueRect(g, px, py, pw, ph, 6 * S);
    const pg = g.createLinearGradient(px, py, px, py + ph);
    pg.addColorStop(0, 'rgba(28,18,42,0.92)'); pg.addColorStop(1, 'rgba(10,6,18,0.92)');
    g.fillStyle = pg; g.fill();
    g.strokeStyle = goldGradient(g, px, py, px + pw, py + ph, (t * 0.2) % 1); g.lineWidth = 1.3 * S; g.stroke();
    palmette(g, px + 10 * S, py + ph / 2, 9 * S, { rot: Math.PI / 2, lobes: 5 });
    palmette(g, px + pw - 10 * S, py + ph / 2, 9 * S, { rot: -Math.PI / 2, lobes: 5 });
    if (enraged) {
      const blink = 0.6 + 0.4 * Math.sin(t * 6);
      tracked(g, name, W / 2, py + ph * 0.70, { size: nameSize, track: 0.30, weight: 700, align: 'center', color: mix('#ffe9a8', C.hi, 0.5 + 0.4 * blink), shadow: '#06030c', shadowDy: 2.4 * S });
      tracked(g, 'ENRAGED', W / 2 + pw / 2 + 8 * S, py + ph * 0.70, { size: 9 * S, track: 0.3, weight: 700, align: 'left', color: rgba(C.hi, 0.6 + 0.4 * blink), shadow: '#06030c', shadowDy: 1.5 * S });
    } else {
      tracked(g, name, W / 2, py + ph * 0.70, { size: nameSize, track: 0.30, weight: 700, align: 'center', gold: true, sweep: (t * 0.16) % 1, shadow: '#06030c', shadowDy: 2.4 * S });
    }

    // well
    plaqueRect(g, x, y, w, h, 6 * S);
    const wg = g.createLinearGradient(x, y, x, y + h);
    wg.addColorStop(0, '#1c0810'); wg.addColorStop(1, '#0a0410');
    g.fillStyle = wg; g.fill();

    g.save(); plaqueRect(g, x, y, w, h, 6 * S); g.clip();
    if (b.ghost > b.hp + 0.002) { g.fillStyle = rgba(cb ? '#ffffff' : '#ffb27a', 0.6); g.fillRect(x + w * b.hp, y, w * (b.ghost - b.hp), h); }
    const fg = g.createLinearGradient(x, y, x, y + h);
    fg.addColorStop(0, C.hi); fg.addColorStop(0.2, C.core);
    fg.addColorStop(0.62, C.mid); fg.addColorStop(1, C.deep);
    g.fillStyle = fg; g.fillRect(x, y, w * b.hp, h);
    g.fillStyle = rgba('#ff9aa6', 0.4); g.fillRect(x, y + 1.2 * S, w * b.hp, 1.6 * S);
    g.fillStyle = rgba('#ffd0c0', 0.85); g.fillRect(x + w * b.hp - 2.4 * S, y, 2.4 * S, h);
    if (b.hitT > 0 && t - b.hitT < 0.25) { g.fillStyle = rgba('#fff2e0', 0.35 * (1 - (t - b.hitT) / 0.25)); g.fillRect(x, y, w * b.hp, h); }
    // phase divisions
    for (let i = 1; i < b.phases; i++) {
      const px2 = x + (w * i) / b.phases;
      g.fillStyle = 'rgba(6,3,12,0.8)'; g.fillRect(px2 - 1.2 * S, y, 2.4 * S, h);
      g.fillStyle = rgba(PAL.gold, 0.5); g.fillRect(px2 + 1.2 * S, y, 0.8 * S, h);
    }
    g.restore();

    plaqueRect(g, x, y, w, h, 6 * S);
    g.strokeStyle = enraged ? rgba(C.hi, 0.9) : goldGradient(g, x, y, x, y + h, (t * 0.2) % 1); g.lineWidth = 2 * S; g.stroke();
    // ornate ends
    palmette(g, x - 4 * S, y + h / 2, 13 * S, { rot: -Math.PI / 2, lobes: 6 });
    palmette(g, x + w + 4 * S, y + h / 2, 13 * S, { rot: Math.PI / 2, lobes: 6 });
    // phase pips under the bar: one per phase REMAINING, and the phase word
    const pr = 4.6 * S, gap = 15 * S, n = b.phases;
    for (let i = 0; i < n; i++) {
      const cx = W / 2 + (i - (n - 1) / 2) * gap, cy = y + h + 11 * S;
      const on = i < b.remaining;
      g.beginPath(); g.arc(cx, cy, pr, 0, 6.2832);
      if (on) { const gg = g.createRadialGradient(cx - pr * 0.3, cy - pr * 0.4, 0, cx, cy, pr); gg.addColorStop(0, '#ffe9a8'); gg.addColorStop(1, '#c98f2b'); g.fillStyle = gg; }
      else g.fillStyle = 'rgba(40,26,14,0.9)';
      g.fill();
      g.strokeStyle = rgba(PAL.bronze, 0.9); g.lineWidth = 1 * S; g.stroke();
    }
    tracked(g, `PHASE ${b.phase} / ${b.phases}`, x + w, y + h + 14.5 * S, { size: 8.5 * S, track: 0.26, weight: 700, align: 'right', color: rgba(PAL.parchDim, 0.9), shadow: '#06030c', shadowDy: 1 * S });
    tracked(g, `${Math.round(b.hp * 100)}%`, x, y + h + 14.5 * S, { size: 8.5 * S, track: 0.16, weight: 700, align: 'left', color: rgba(PAL.parchDim, 0.9), shadow: '#06030c', shadowDy: 1 * S });
    g.restore();
  }

  /** Screen-space extent of the boss plate, so banners can keep clear of it. */
  bossBottom(S) { return this.boss ? 64 * S + 19 * S + 22 * S : 0; }

  _prompt(g, x, y, S, t, pr) {
    const bob = Math.sin(t * 2.4) * 2 * S;
    const size = 12 * S;
    const pad = this.ui.padGlyphs ? this.ui.padGlyphs() : false;
    const key = pr.action && this.ui.keyFor ? this.ui.keyFor(pr.action) : String(pr.key);
    const tw = trackedWidth(g, pr.text.toUpperCase(), { size, track: 0.22, weight: 600 });
    const kw = Math.max(20 * S, 8 * S * key.length + 8 * S), kh = 20 * S, w = tw + kw + 30 * S, h = 26 * S;
    const bx = x - w / 2, by = y - h / 2 + bob;
    g.save();
    // a faint tether down to the thing the prompt belongs to
    const tg = g.createLinearGradient(0, by + h, 0, by + h + 22 * S);
    tg.addColorStop(0, rgba(PAL.gold, 0.55)); tg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = tg; g.fillRect(x - 0.6 * S, by + h, 1.2 * S, 22 * S);
    plaqueRect(g, bx, by, w, h, 5 * S);
    g.fillStyle = 'rgba(10,6,18,0.86)'; g.fill();
    g.strokeStyle = goldGradient(g, bx, by, bx + w, by + h, (t * 0.4) % 1); g.lineWidth = 1.4 * S; g.stroke();
    keyCap(g, bx + 9 * S, by + (h - kh) / 2, kw, kh, key, { pad: pad && key.length <= 2, size: 10.5 * S });
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
