// OWNER: AGENT-UI
// ---------------------------------------------------------------------------
// SCREENS — title, pause, settings, death / run summary.
// All drawn over the LIVE rendered chamber: the scrim is a graded wash, never
// an opaque sheet, so the game keeps breathing behind the type.
// ---------------------------------------------------------------------------

import {
  PAL, RARITY, frame, plaqueRect, roundRect, goldGradient, meander, beadRule,
  laurel, palmette, eggAndDart, tracked, trackedWidth, wrap, rgba, mix, shade,
  lift, displayFont, bodyFont, ease, clamp01, lerp, LayerCache,
} from './ornament.js';
import { godEmblem } from './boons.js';
import { GOD_INFO } from '../game/boons.js';
import { CONTROL_ROWS } from '../core/controls.js';

const QUALITY = ['auto', 'low', 'med', 'high', 'ultra'];

export class Menus {
  constructor(ui) {
    this.ui = ui;
    this.cache = new LayerCache();
    this.screen = 'game';
    this.t0 = 0;
    this.sel = 0;
    this.hit = [];                 // [{x,y,w,h,act,i}]
    this.settingsOpen = false;
    this.controlsOpen = false;
    this.boonsOpen = false;
    this.boonSel = 0;
    this.settings = { quality: 'auto', master: 0.8, music: 0.7, sfx: 0.9, shake: true };
    this.summary = { depth: 1, biome: 'tartarus', kills: 0, damage: 0, time: 0, boons: [], killedBy: 'the Underworld' };
  }

  set(screen) {
    if (this.screen === screen) return;
    this.screen = screen;
    this.t0 = this.ui.now();
    this.sel = 0;
    this.settingsOpen = false;
    this.controlsOpen = false;
    this.boonsOpen = false;
    this.ui.dirty = true;
  }

  get modal() { return this.screen === 'title' || this.screen === 'pause' || this.screen === 'death' || this.screen === 'victory'; }

  items() {
    if (this.settingsOpen || this.controlsOpen || this.boonsOpen) return [{ label: 'Back', act: 'back' }];
    switch (this.screen) {
      case 'title': return [{ label: 'Descend', act: 'start' }, { label: 'Controls', act: 'controls' }, { label: 'Settings', act: 'settings' }, { label: 'Credits', act: 'credits' }];
      case 'pause': return [{ label: 'Resume', act: 'resume' }, { label: 'Current Boons', act: 'boons' }, { label: 'Controls', act: 'controls' }, { label: 'Settings', act: 'settings' }, { label: 'Abandon Run', act: 'abandon' }];
      case 'death': return [{ label: 'Rise Again', act: 'start' }, { label: 'Controls', act: 'controls' }, { label: 'Settings', act: 'settings' }];
      case 'victory': return [{ label: 'Descend Again', act: 'start' }];
      default: return [];
    }
  }

  activate(act) {
    const ui = this.ui;
    switch (act) {
      case 'settings': this.settingsOpen = true; this.controlsOpen = false; this.boonsOpen = false; this.sel = 0; break;
      case 'controls': this.controlsOpen = true; this.settingsOpen = false; this.boonsOpen = false; this.sel = 0; break;
      case 'boons': this.boonsOpen = true; this.settingsOpen = false; this.controlsOpen = false; this.boonSel = 0; this.sel = 0; break;
      case 'back': this.settingsOpen = false; this.controlsOpen = false; this.boonsOpen = false; this.sel = 0; break;
      case 'resume': ui.screen('game'); break;
      case 'start': ui.screen('game'); ui.ctx?.events?.emit?.('run.start', {}); break;
      case 'abandon': ui.screen('title'); ui.ctx?.events?.emit?.('run.abandon', {}); break;
      default: break;
    }
    ui.ctx?.audio?.sfx?.('ui.select', { gain: 0.6 });
    ui.dirty = true;
  }

  key(dir) {
    if (this.boonsOpen) {
      const n = this.ui.ctx?.boons?.list?.().length || 0;
      if (n) this.boonSel = (this.boonSel + dir + n) % n;
      this.ui.dirty = true;
      return;
    }
    const n = this.items().length + (this.settingsOpen ? 5 : 0);
    if (!n) return;
    this.sel = (this.sel + dir + n) % n;
    this.ui.dirty = true;
  }

  click(x, y) {
    for (const h of this.hit) {
      if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) {
        if (h.act === 'boon-select') { this.boonSel = h.boonIndex; this.ui.dirty = true; }
        else if (h.act === 'setting') {
          if (h.kind === 'slider' && h.sliderW && x >= h.sliderX && x <= h.sliderX + h.sliderW) this._setVolume(h.key, clamp01((x - h.sliderX) / h.sliderW));
          else this._bump(h.key, 1);
        }
        else this.activate(h.act);
        return true;
      }
    }
    return false;
  }

  move(x, y) {
    for (let i = 0; i < this.hit.length; i++) {
      const h = this.hit[i];
      if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) {
        if (h.boonIndex != null) { if (this.boonSel !== h.boonIndex) { this.boonSel = h.boonIndex; this.ui.dirty = true; } }
        else if (this.sel !== h.i) { this.sel = h.i; this.ui.dirty = true; }
        return;
      }
    }
  }

  _bump(key, d) {
    const s = this.settings;
    if (key === 'quality') { const i = QUALITY.indexOf(s.quality); s.quality = QUALITY[(i + d + QUALITY.length) % QUALITY.length]; this.ui.ctx?.events?.emit?.('quality.request', { tier: s.quality }); }
    else if (key === 'shake') { s.shake = !s.shake; this.ui.ctx?.events?.emit?.('settings.shake', { on: s.shake }); }
    else { s[key] = Math.round(((s[key] + 0.1 * d) % 1.05) * 10) / 10; if (s[key] < 0) s[key] = 1; this.ui.ctx?.events?.emit?.('settings.volume', { channel: key, value: s[key] }); }
    this.ui.dirty = true;
  }

  _setVolume(key, value) {
    if (!['master', 'music', 'sfx'].includes(key)) return;
    this.settings[key] = Math.round(clamp01(value) * 100) / 100;
    this.ui.ctx?.events?.emit?.('settings.volume', { channel: key, value: this.settings[key] });
    this.ui.dirty = true;
  }

  // ── draw ─────────────────────────────────────────────────────────────────
  draw(g, W, H, S, t) {
    this.hit.length = 0;
    if (!this.modal) return;
    const age = t - this.t0;
    if (this.screen === 'title') this._title(g, W, H, S, t, age);
    else if (this.screen === 'pause') this._panelScreen(g, W, H, S, t, age, 'Paused', null);
    else if (this.screen === 'death') this._death(g, W, H, S, t, age);
    else if (this.screen === 'victory') this._panelScreen(g, W, H, S, t, age, 'You Have Escaped', null);
  }

  _scrim(g, W, H, a, o = {}) {
    const sg = g.createRadialGradient(W * 0.5, H * (o.cy || 0.46), H * 0.10, W * 0.5, H * 0.5, H * 1.0);
    sg.addColorStop(0, rgba('#0a0614', (o.c0 != null ? o.c0 : 0.45) * a));
    sg.addColorStop(0.5, rgba('#08040f', (o.c1 != null ? o.c1 : 0.72) * a));
    sg.addColorStop(1, rgba('#050308', (o.c2 != null ? o.c2 : 0.92) * a));
    g.fillStyle = sg; g.fillRect(0, 0, W, H);
  }

  // ═════════════════════════════════════════════════════════════ TITLE ════
  _title(g, W, H, S, t, age) {
    const a = ease.out(clamp01(age / 0.7));
    this._scrim(g, W, H, a, { c0: 0.30, c1: 0.62, c2: 0.94, cy: 0.34 });

    const cx = W / 2, ty = H * 0.30;
    g.save(); g.globalAlpha = a;

    // wordmark
    const size = Math.min(112 * S, W / 7.2);
    tracked(g, 'EREBUS', cx, ty + (1 - a) * 14 * S, {
      size, track: 0.30, weight: 700, align: 'center', gold: true, sweep: (t * 0.13) % 1,
      shadow: 'rgba(4,2,8,0.95)', shadowDy: 6 * S,
    });
    // a second, offset pass in near-black gives the letters a carved depth
    g.save(); g.globalAlpha *= 0.35;
    tracked(g, 'EREBUS', cx, ty + (1 - a) * 14 * S - 2 * S, { size, track: 0.30, weight: 700, align: 'center', color: 'rgba(255,233,168,0.35)' });
    g.restore();

    // rule + subtitle
    const rw = size * 3.5;
    const rg = g.createLinearGradient(cx - rw / 2, 0, cx + rw / 2, 0);
    rg.addColorStop(0, 'rgba(0,0,0,0)'); rg.addColorStop(0.5, rgba(PAL.gold, 0.8)); rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg; g.fillRect(cx - rw / 2, ty + size * 0.30, rw, Math.max(1, 1.4 * S));
    palmette(g, cx - rw / 2, ty + size * 0.305, 12 * S, { rot: Math.PI / 2, lobes: 5 });
    palmette(g, cx + rw / 2, ty + size * 0.305, 12 * S, { rot: -Math.PI / 2, lobes: 5 });
    tracked(g, 'DESCENT', cx, ty + size * 0.52, {
      size: 21 * S, track: 0.62, weight: 600, align: 'center', color: rgba(PAL.parch, 0.82), shadow: '#06030c', shadowDy: 2 * S,
    });
    laurel(g, cx, ty + size * 0.36, size * 1.55, { side: 1, leaves: 13, from: Math.PI * 0.50, to: Math.PI * 0.06, leafLen: 0.16 });
    laurel(g, cx, ty + size * 0.36, size * 1.55, { side: -1, leaves: 13, from: Math.PI * 0.50, to: Math.PI * 0.06, leafLen: 0.16 });
    g.restore();

    if (this.controlsOpen) this._controls(g, W, H, S, t, H * 0.49, Math.min(650 * S, W * 0.78));
    else if (this.settingsOpen) this._settings(g, W, H, S, t, H * 0.52);
    else this._menu(g, W, H, S, t, H * 0.62, a);

    g.save(); g.globalAlpha = a * 0.5;
    tracked(g, 'A ROGUE-LITE DESCENT · THREE.JS · NO EXTERNAL ASSETS', cx, H - 26 * S, {
      size: 9.5 * S, track: 0.34, weight: 500, align: 'center', color: rgba(PAL.parchDim, 0.7), font: bodyFont(),
    });
    g.restore();
  }

  // ═══════════════════════════════════════════════════ PAUSE / GENERIC ════
  _panelScreen(g, W, H, S, t, age, title, sub) {
    const a = ease.out(clamp01(age / 0.35));
    this._scrim(g, W, H, a);
    const w = (this.boonsOpen ? 1040 : this.controlsOpen ? 700 : 460) * S;
    const h = (this.boonsOpen ? 620 : this.controlsOpen ? 520 : this.settingsOpen ? 400 : 360) * S;
    const x = (W - w) / 2, y = (H - h) / 2 + (1 - a) * -16 * S;
    g.save(); g.globalAlpha = a;
    frame(g, {
      x, y, w, h, weight: 1.25 * S, r: 9 * S, pad: 8,
      meander: 'both', meanderH: 9, palmettes: 'crest', palmetteS: 15,
      sweep: (t * 0.2) % 1, glowAlpha: 0.26,
      fill: { top: '#1c1229', mid: '#120b1e', bot: '#0a0612' },
    });
    const panelTitle = this.boonsOpen ? 'Current Boons' : title;
    tracked(g, panelTitle.toUpperCase(), W / 2, y + 62 * S, {
      size: 27 * S, track: 0.26, weight: 700, align: 'center', gold: true, sweep: (t * 0.2) % 1,
      shadow: '#06030c', shadowDy: 3 * S,
    });
    const rw = w - 120 * S;
    const rg = g.createLinearGradient(W / 2 - rw / 2, 0, W / 2 + rw / 2, 0);
    rg.addColorStop(0, 'rgba(0,0,0,0)'); rg.addColorStop(0.5, rgba(PAL.gold, 0.65)); rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg; g.fillRect(W / 2 - rw / 2, y + 76 * S, rw, Math.max(1, 1.2 * S));
    g.restore();
    if (this.boonsOpen) this._boonArchive(g, W, H, S, t, x + 34 * S, y + 96 * S, w - 68 * S, h - 128 * S);
    else if (this.controlsOpen) this._controls(g, W, H, S, t, y + 108 * S, w - 76 * S);
    else if (this.settingsOpen) this._settings(g, W, H, S, t, y + 110 * S, w - 90 * S);
    else this._menu(g, W, H, S, t, y + 130 * S, a);
  }

  // ═══════════════════════════════════════════════════════════ DEATH ══════
  _death(g, W, H, S, t, age) {
    const a = ease.out(clamp01(age / 0.8));
    this._scrim(g, W, H, a, { c0: 0.55, c1: 0.82, c2: 0.96 });
    // a blood wash from the bottom
    const bg = g.createLinearGradient(0, H, 0, H * 0.35);
    bg.addColorStop(0, rgba('#3a0512', 0.5 * a)); bg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);

    const cx = W / 2, s = this.summary;
    g.save(); g.globalAlpha = a;
    tracked(g, 'YOU HAVE DIED', cx, H * 0.26, {
      size: Math.min(58 * S, W / 13), track: 0.30, weight: 700, align: 'center',
      color: '#e8506a', shadow: 'rgba(10,0,4,0.95)', shadowDy: 5 * S,
    });
    tracked(g, `Slain in ${(s.biome || 'tartarus').toUpperCase()} · CHAMBER ${s.depth}`, cx, H * 0.26 + 30 * S, {
      size: 12 * S, track: 0.36, weight: 600, align: 'center', color: rgba(PAL.parchDim, 0.85),
    });

    // summary plaque
    const w = 520 * S, h = 152 * S, x = cx - w / 2, y = H * 0.34;
    frame(g, {
      x, y, w, h, weight: 1.0 * S, r: 7 * S, pad: 6, meander: true, meanderH: 8,
      palmetteS: 12, sweep: (t * 0.18) % 1, glowAlpha: 0.20,
      fill: { top: '#1a1026', mid: '#110a1c', bot: '#090511', bounce: '#c81d3c' },
    });
    const stats = [
      ['CHAMBERS', String(s.depth)],
      ['FOES SLAIN', String(s.kills)],
      ['DAMAGE DEALT', String(Math.round(s.damage))],
      ['TIME', fmtTime(s.time)],
    ];
    const colW = (w - 56 * S) / stats.length;
    for (let i = 0; i < stats.length; i++) {
      const px = x + 28 * S + colW * (i + 0.5);
      tracked(g, stats[i][1], px, y + 62 * S, { size: 24 * S, track: 0.04, weight: 700, align: 'center', gold: true, sweep: (t * 0.2 + i * 0.1) % 1, shadow: '#06030c', shadowDy: 2 * S });
      tracked(g, stats[i][0], px, y + 80 * S, { size: 8.6 * S, track: 0.34, weight: 600, align: 'center', color: rgba(PAL.parchDim, 0.8) });
      if (i) { g.fillStyle = rgba(PAL.bronze, 0.5); g.fillRect(x + 28 * S + colW * i, y + 44 * S, Math.max(1, 1 * S), 44 * S); }
    }
    // boons collected
    const bl = (s.boons || []).slice(0, 8);
    if (bl.length) {
      const r = 14 * S, gap = 36 * S;
      const bx = cx - (bl.length - 1) * gap / 2;
      for (let i = 0; i < bl.length; i++) {
        const b = bl[i];
        const px = bx + i * gap, py = y + h - 28 * S;
        g.beginPath(); g.arc(px, py, r, 0, 6.2832);
        g.fillStyle = '#0c0715'; g.fill();
        g.strokeStyle = rgba(RARITY[b.rarity]?.text || PAL.gold, 0.8); g.lineWidth = 1.3 * S; g.stroke();
        godEmblem(g, px, py, r * 0.55, b.god, { glowA: 0.3, glowR: 1.8 });
      }
    } else {
      tracked(g, 'NO BOONS CLAIMED', cx, y + h - 22 * S, { size: 9 * S, track: 0.34, weight: 600, align: 'center', color: rgba(PAL.parchDim, 0.55) });
    }
    g.restore();

    if (this.controlsOpen) this._controls(g, W, H, S, t, H * 0.57, Math.min(650 * S, W * 0.78));
    else if (this.settingsOpen) this._settings(g, W, H, S, t, H * 0.66);
    else this._menu(g, W, H, S, t, H * 0.70, a);
  }

  // ═══════════════════════════════════════════════════════ MENU ITEMS ═════
  _menu(g, W, H, S, t, y0, a, off = 0) {
    const items = this.items();
    const cx = W / 2, step = 44 * S;
    g.save(); g.globalAlpha = a;
    for (let i = 0; i < items.length; i++) {
      const it = items[i], y = y0 + i * step;
      const on = this.sel === i + off;
      const size = (on ? 22 : 20) * S;
      const w = trackedWidth(g, it.label.toUpperCase(), { size, track: 0.28, weight: 600 });
      this.hit.push({ x: cx - w / 2 - 26 * S, y: y - 20 * S, w: w + 52 * S, h: 32 * S, act: it.act, i: i + off });
      if (on) {
        // selection: a pair of inward palmette pointers plus a warm underlay
        const ug = g.createLinearGradient(cx - w, y, cx + w, y);
        ug.addColorStop(0, 'rgba(0,0,0,0)'); ug.addColorStop(0.5, rgba(PAL.gold, 0.14)); ug.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = ug; g.fillRect(cx - w, y - 17 * S, w * 2, 26 * S);
        palmette(g, cx - w / 2 - 22 * S, y - 5 * S, 9 * S, { rot: Math.PI / 2, lobes: 5 });
        palmette(g, cx + w / 2 + 22 * S, y - 5 * S, 9 * S, { rot: -Math.PI / 2, lobes: 5 });
      }
      tracked(g, it.label.toUpperCase(), cx, y, {
        size, track: 0.28, weight: 600, align: 'center',
        gold: on, sweep: on ? (t * 0.35) % 1 : undefined,
        color: on ? undefined : rgba(PAL.parch, 0.62),
        shadow: '#05030b', shadowDy: 2 * S,
      });
    }
    g.restore();
  }

  // ═══════════════════════════════════════════════════════ THE CODEX ══════
  // The loadout screen. A Hades player opens this to answer three questions:
  // what is in each of my five ability slots, exactly what does each boon do
  // at the grade and level I actually have it, and what am I close to
  // unlocking. It answers all three, in that order.
  _boonArchive(g, W, H, S, t, x, y, w, h) {
    const state = this.ui.ctx?.boons || this.ui.boonState;
    const entries = state?.loadout?.() || [];
    const records = entries.length
      ? entries
      : [...(state?.list?.() || [])].map(r => state?.describe?.(r)).filter(Boolean);

    if (!records.length) {
      tracked(g, 'NO BOONS CLAIMED THIS DESCENT', W / 2, y + h * .42, { size: 15 * S, track: .25, weight: 700, align: 'center', color: rgba(PAL.parchDim, .65) });
      tracked(g, 'PASS THROUGH A GOD GATE TO BEGIN YOUR BUILD', W / 2, y + h * .42 + 28 * S, { size: 9 * S, track: .18, weight: 600, align: 'center', color: rgba(PAL.goldHi, .7), font: bodyFont() });
      this._menu(g, W, H, S, t, y + h - 4 * S, 1, 0);
      return;
    }

    this.boonSel = Math.max(0, Math.min(records.length - 1, this.boonSel));
    const leftW = w * .47, gap = 22 * S, rightX = x + leftW + gap, rightW = w - leftW - gap;

    // ── header: the build in one line ──
    const gods = new Set(records.map(r => r.god));
    const duos = records.filter(r => r.duo).length;
    const legs = records.filter(r => r.legendary).length;
    const rerolls = state?.rerolls || 0;
    tracked(g, `CURRENT BUILD · ${records.length} BOON${records.length === 1 ? '' : 'S'} · ${gods.size} GOD${gods.size === 1 ? '' : 'S'}`,
      x, y + 12 * S, { size: 10 * S, track: .22, weight: 700, align: 'left', color: rgba(PAL.goldHi, .86) });
    const tally = [duos ? `${duos} DUO` : null, legs ? `${legs} LEGENDARY` : null, `${rerolls} REROLL${rerolls === 1 ? '' : 'S'}`]
      .filter(Boolean).join('   ·   ');
    tracked(g, tally, x + w, y + 12 * S, { size: 8.4 * S, track: .18, weight: 700, align: 'right', color: rgba(PAL.parchDim, .8) });

    // ── the list, grouped by category ──
    // Rows and group headings share one scroll window, so the selection never
    // jumps a heading it cannot see.
    const rows = [];
    const ORDER = [
      ['attack', 'Attack'], ['special', 'Special'], ['cast', 'Cast'], ['dash', 'Dash'], ['call', 'Call'],
      ['gain', 'Magick Gain'], ['legendary', 'Legendary'], ['passive', 'Blessings'], ['forge', 'Weapon Forge'],
    ];
    const placed = new Set();
    for (const [slot, label] of ORDER) {
      const group = [];
      for (let i = 0; i < records.length; i++) {
        if (placed.has(i) || records[i].slot !== slot) continue;
        placed.add(i); group.push({ rec: records[i], index: i });
      }
      if (!group.length) continue;
      rows.push({ head: label.toUpperCase() });
      rows.push(...group);
    }
    // Anything with an unexpected category still gets listed rather than lost.
    const rest = [];
    for (let i = 0; i < records.length; i++) if (!placed.has(i)) rest.push({ rec: records[i], index: i });
    if (rest.length) { rows.push({ head: 'OTHER' }); rows.push(...rest); }

    const rowH = 30 * S, headH = 18 * S;
    const listTop = y + 26 * S, listBot = y + h - 26 * S;
    const selRow = Math.max(0, rows.findIndex(r => r.index === this.boonSel));
    // keep the selection inside the window
    let acc = 0, start = 0;
    for (let i = 0; i < rows.length; i++) {
      const hh = rows[i].head ? headH : rowH;
      if (i < selRow) acc += hh;
    }
    const windowH = listBot - listTop;
    let offset = Math.max(0, acc - windowH * 0.55);
    let total = 0;
    for (const r of rows) total += r.head ? headH : rowH;
    offset = Math.min(offset, Math.max(0, total - windowH));

    g.save();
    g.beginPath(); g.rect(x - 2 * S, listTop, leftW + 4 * S, windowH); g.clip();
    let ry = listTop - offset;
    for (const row of rows) {
      const hh = row.head ? headH : rowH;
      if (ry + hh > listTop - 4 * S && ry < listBot + 4 * S) {
        if (row.head) {
          tracked(g, row.head, x + 2 * S, ry + 12 * S, {
            size: 7.8 * S, track: .30, weight: 700, align: 'left', color: rgba(PAL.goldMid, .9),
          });
          const hg = g.createLinearGradient(x, 0, x + leftW, 0);
          hg.addColorStop(0, rgba(PAL.bronze, .55)); hg.addColorStop(1, 'rgba(0,0,0,0)');
          g.fillStyle = hg; g.fillRect(x + trackedWidth(g, row.head, { size: 7.8 * S, track: .30, weight: 700 }) + 10 * S, ry + 8 * S, leftW - trackedWidth(g, row.head, { size: 7.8 * S, track: .30, weight: 700 }) - 12 * S, Math.max(1, 1 * S));
        } else {
          const rec = row.rec, info = GOD_INFO[rec.god] || GOD_INFO.zeus;
          const on = row.index === this.boonSel;
          const R = RARITY[rec.tier] || RARITY[rec.rarity] || RARITY.common;
          plaqueRect(g, x, ry, leftW, rowH - 4 * S, 4 * S);
          g.fillStyle = on ? rgba(info.color, .22) : rgba('#090611', .58); g.fill();
          g.strokeStyle = on ? rgba(R.text, .95) : rgba(PAL.bronze, .30); g.lineWidth = (on ? 1.5 : .8) * S; g.stroke();
          // a rarity spine on the left edge: grade without reading
          g.fillStyle = rgba(R.text, on ? .95 : .62);
          g.fillRect(x, ry + 2 * S, 2.4 * S, rowH - 8 * S);
          godEmblem(g, x + 17 * S, ry + (rowH - 4 * S) / 2, 8.5 * S, rec.god, { glowA: on ? .34 : .12, glowR: 1.5 });
          const nm = String(rec.name || 'Boon').toUpperCase();
          tracked(g, nm, x + 31 * S, ry + 12 * S, {
            size: 9.6 * S, track: .09, weight: 700, align: 'left', color: on ? '#fff0c6' : rgba(PAL.parch, .78),
          });
          const grade = `${String(rec.tier || rec.rarity).toUpperCase()}${(rec.level || 1) > 1 ? ` · LV ${rec.level}` : ''}`;
          tracked(g, grade, x + 31 * S, ry + 22 * S, {
            size: 7 * S, track: .14, weight: 700, align: 'left', color: R.text, font: bodyFont(),
          });
          if (rec.curse) {
            const cn = rec.curse.name.toUpperCase();
            const cw = trackedWidth(g, cn, { size: 6.8 * S, track: .16, weight: 700 }) + 12 * S;
            plaqueRect(g, x + leftW - cw - 6 * S, ry + 7 * S, cw, 13 * S, 3 * S);
            g.fillStyle = rgba(shade(rec.curse.color, .68), .95); g.fill();
            g.strokeStyle = rgba(rec.curse.color, .8); g.lineWidth = .8 * S; g.stroke();
            tracked(g, cn, x + leftW - cw / 2 - 6 * S, ry + 16 * S, {
              size: 6.8 * S, track: .16, weight: 700, align: 'center', color: lift(rec.curse.color, .45),
            });
          }
          this.hit.push({ x, y: ry, w: leftW, h: rowH - 4 * S, act: 'boon-select', boonIndex: row.index });
        }
      }
      ry += hh;
    }
    g.restore();
    if (offset > 1) tracked(g, '▲', x + leftW - 6 * S, listTop + 10 * S, { size: 8 * S, track: 0, weight: 700, align: 'right', color: rgba(PAL.parchDim, .7) });
    if (offset < total - windowH - 1) tracked(g, '▼', x + leftW - 6 * S, listBot - 3 * S, { size: 8 * S, track: 0, weight: 700, align: 'right', color: rgba(PAL.parchDim, .7) });

    // ── the detail plate ──
    const rec = records[this.boonSel];
    const info = GOD_INFO[rec.god] || GOD_INFO.zeus;
    const R = RARITY[rec.tier] || RARITY[rec.rarity] || RARITY.common;
    const py = y + 26 * S, ph = h - 52 * S;
    plaqueRect(g, rightX, py, rightW, ph, 8 * S);
    g.fillStyle = rgba('#10091b', .9); g.fill();
    g.strokeStyle = rgba(R.text, .78); g.lineWidth = 1.5 * S; g.stroke();
    g.save();
    plaqueRect(g, rightX, py, rightW, ph, 8 * S); g.clip();
    const wash = g.createRadialGradient(rightX + rightW / 2, py + 60 * S, 4, rightX + rightW / 2, py + 60 * S, rightW);
    wash.addColorStop(0, rgba(info.color, .26)); wash.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = wash; g.fillRect(rightX, py, rightW, ph);
    g.restore();

    // grade ribbon, same language as the offer card
    const ribW = rightW - 44 * S, ribH = 20 * S, ribX = rightX + 22 * S, ribY = py + 12 * S;
    plaqueRect(g, ribX, ribY, ribW, ribH, 5 * S);
    const rg2 = g.createLinearGradient(ribX, ribY, ribX + ribW, ribY);
    rg2.addColorStop(0, rgba(shade(R.ring[0], .42), .95));
    rg2.addColorStop(.5, rgba(R.ring[1], .3));
    rg2.addColorStop(1, rgba(shade(R.ring[2] || R.ring[0], .42), .95));
    g.fillStyle = rg2; g.fill();
    g.strokeStyle = rgba(R.text, .8); g.lineWidth = 1 * S; g.stroke();
    tracked(g, `${String(rec.tier || rec.rarity).toUpperCase()}${(rec.level || 1) > 1 ? `  ·  LEVEL ${rec.level}` : ''}  ·  ${String(rec.slot).toUpperCase()}`,
      rightX + rightW / 2, ribY + ribH * .68, { size: 9.2 * S, track: .24, weight: 700, align: 'center', color: R.text });

    const medY = ribY + ribH + 44 * S;
    godEmblem(g, rightX + rightW / 2, medY, 28 * S, rec.god, { glowA: .5, glowR: 2.0 });
    tracked(g, info.name.toUpperCase(), rightX + rightW / 2, medY + 48 * S, { size: 11 * S, track: .25, weight: 700, align: 'center', color: info.color });
    tracked(g, String(rec.name || 'BOON').toUpperCase(), rightX + rightW / 2, medY + 76 * S, { size: 17 * S, track: .12, weight: 700, align: 'center', color: '#ffe9a8' });

    let ty = medY + 100 * S;
    if (rec.curse) {
      const cn = rec.curse.name.toUpperCase();
      const cw = trackedWidth(g, cn, { size: 8.4 * S, track: .2, weight: 700 }) + 30 * S;
      const cx2 = rightX + rightW / 2 - cw / 2;
      plaqueRect(g, cx2, ty - 11 * S, cw, 17 * S, 4 * S);
      g.fillStyle = rgba(shade(rec.curse.color, .66), .95); g.fill();
      g.strokeStyle = rgba(rec.curse.color, .85); g.lineWidth = 1 * S; g.stroke();
      g.beginPath(); g.arc(cx2 + 11 * S, ty - 2.5 * S, 3.4 * S, 0, 6.2832);
      g.fillStyle = rgba(rec.curse.color, .95); g.fill();
      tracked(g, cn, cx2 + 19 * S, ty, { size: 8.4 * S, track: .2, weight: 700, align: 'left', color: lift(rec.curse.color, .45) });
      ty += 20 * S;
      const blurb = wrap(g, rec.curse.blurb || '', rightW - 60 * S, { size: 9 * S, weight: 400, font: bodyFont() });
      g.font = `400 ${9 * S}px ${bodyFont()}`; g.fillStyle = rgba(rec.curse.color, .78); g.textAlign = 'center';
      for (const ln of blurb.slice(0, 2)) { g.fillText(ln, rightX + rightW / 2, ty); ty += 12 * S; }
      ty += 6 * S;
    }

    const lines = wrap(g, rec.text || '', rightW - 54 * S, { size: 11 * S, weight: 500, font: bodyFont() });
    g.font = `500 ${11 * S}px ${bodyFont()}`; g.fillStyle = rgba(PAL.parch, .88); g.textAlign = 'center';
    for (const ln of lines.slice(0, 6)) { g.fillText(ln, rightX + rightW / 2, ty); ty += 17 * S; }
    g.textAlign = 'left';

    // the god's promise — why this patron and not another
    const identity = rec.duo
      ? `A pact between ${rec.gods.map(k => GOD_INFO[k]?.name || k).join(' and ')}.`
      : (info.identity || info.title || '');
    const idLines = wrap(g, identity, rightW - 54 * S, { size: 9.4 * S, weight: 400, font: bodyFont() });
    let iy = py + ph - 28 * S - (idLines.length - 1) * 12 * S;
    g.font = `400 ${9.4 * S}px ${bodyFont()}`; g.fillStyle = rgba(info.color, .8); g.textAlign = 'center';
    for (const ln of idLines.slice(0, 3)) { g.fillText(ln, rightX + rightW / 2, iy); iy += 12 * S; }
    g.textAlign = 'left';

    tracked(g, '↑ ↓ SELECT · B / ESC BACK', W / 2, y + h - 8 * S, { size: 8 * S, track: .20, weight: 600, align: 'center', color: rgba(PAL.parchDim, .66), font: bodyFont() });
  }

  _settings(g, W, H, S, t, y0, width) {
    const s = this.settings;
    const w = width || 420 * S, cx = W / 2, x = cx - w / 2;
    const rows = [
      { key: 'quality', label: 'Graphics Quality', kind: 'cycle', value: s.quality === 'auto' ? `AUTO (${(this.ui.ctx?.quality?.tier || 'med').toUpperCase()})` : s.quality.toUpperCase() },
      { key: 'master', label: 'Master Volume', kind: 'slider', value: s.master },
      { key: 'music', label: 'Music', kind: 'slider', value: s.music },
      { key: 'sfx', label: 'Effects', kind: 'slider', value: s.sfx },
      { key: 'shake', label: 'Screen Shake', kind: 'toggle', value: s.shake },
    ];
    const step = 34 * S;
    g.save();
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i], y = y0 + i * step;
      const on = this.sel === i;
      const sliderX = x + w * 0.52, sliderW = w * 0.48 - 34 * S;
      this.hit.push({ x, y: y - 14 * S, w, h: 26 * S, act: 'setting', key: r.key, kind: r.kind, sliderX, sliderW, i });
      if (on) { g.fillStyle = rgba(PAL.gold, 0.08); g.fillRect(x - 8 * S, y - 15 * S, w + 16 * S, 28 * S); }
      tracked(g, r.label.toUpperCase(), x, y, {
        size: 12 * S, track: 0.26, weight: 600, align: 'left',
        color: on ? '#ffe9a8' : rgba(PAL.parch, 0.66),
      });
      const vx = x + w * 0.52, vw = w * 0.48;
      if (r.kind === 'slider') {
        const bh = 7 * S, by = y - 6 * S;
        plaqueRect(g, vx, by, vw - 34 * S, bh, 3 * S);
        g.fillStyle = 'rgba(8,4,14,0.9)'; g.fill();
        g.fillStyle = goldGradient(g, vx, by, vx + (vw - 34 * S) * r.value, by + bh, 0.4);
        g.fillRect(vx, by, (vw - 34 * S) * r.value, bh);
        plaqueRect(g, vx, by, vw - 34 * S, bh, 3 * S);
        g.strokeStyle = rgba(PAL.bronze, 0.9); g.lineWidth = 1 * S; g.stroke();
        tracked(g, String(Math.round(r.value * 100)), x + w, y, { size: 11 * S, track: 0.06, weight: 600, align: 'right', color: rgba(PAL.parchDim, 0.9) });
      } else if (r.kind === 'toggle') {
        const tw = 40 * S, th = 16 * S, ty = y - 11 * S;
        plaqueRect(g, x + w - tw, ty, tw, th, 4 * S);
        g.fillStyle = r.value ? rgba(PAL.goldMid, 0.45) : 'rgba(20,12,30,0.9)'; g.fill();
        g.strokeStyle = rgba(PAL.bronze, 0.9); g.lineWidth = 1 * S; g.stroke();
        const kx = x + w - tw + (r.value ? tw - th + 1 * S : 1 * S);
        plaqueRect(g, kx, ty + 1 * S, th - 2 * S, th - 2 * S, 3 * S);
        g.fillStyle = r.value ? '#ffe9a8' : '#5a4a66'; g.fill();
      } else {
        tracked(g, String(r.value), x + w, y, { size: 12 * S, track: 0.22, weight: 700, align: 'right', gold: true, sweep: on ? (t * 0.4) % 1 : 0.5 });
      }
    }
    g.restore();
    this._menu(g, W, H, S, t, y0 + rows.length * step + 26 * S, 1, rows.length);
  }

  // ═══════════════════════════════════════════════════════ CONTROLS ═══════
  _controls(g, W, H, S, t, y0, width) {
    const w = width || 640 * S, x = W / 2 - w / 2;
    const actionX = x, keyboardX = x + w * 0.33, padX = x + w * 0.72;
    tracked(g, 'ACTION', actionX, y0, { size: 9 * S, track: 0.30, weight: 700, align: 'left', color: rgba(PAL.goldHi, 0.82) });
    tracked(g, 'KEYBOARD & MOUSE', keyboardX, y0, { size: 9 * S, track: 0.24, weight: 700, align: 'left', color: rgba(PAL.goldHi, 0.82) });
    tracked(g, 'GAMEPAD', padX, y0, { size: 9 * S, track: 0.30, weight: 700, align: 'left', color: rgba(PAL.goldHi, 0.82) });
    const step = 27 * S;
    g.save();
    for (let i = 0; i < CONTROL_ROWS.length; i++) {
      const [action, keyboard, pad] = CONTROL_ROWS[i], y = y0 + 26 * S + i * step;
      if (i % 2 === 0) { g.fillStyle = rgba(PAL.gold, 0.045); g.fillRect(x - 8 * S, y - 16 * S, w + 16 * S, 23 * S); }
      tracked(g, action.toUpperCase(), actionX, y, { size: 10.5 * S, track: 0.16, weight: 700, align: 'left', color: rgba(PAL.parch, 0.86) });
      tracked(g, keyboard.toUpperCase(), keyboardX, y, { size: 10.5 * S, track: 0.09, weight: 500, align: 'left', color: rgba(PAL.parchDim, 0.82), font: bodyFont() });
      tracked(g, pad.toUpperCase(), padX, y, { size: 10.5 * S, track: 0.09, weight: 500, align: 'left', color: rgba(PAL.parchDim, 0.82), font: bodyFont() });
    }
    g.restore();
    const noteY = y0 + 26 * S + CONTROL_ROWS.length * step + 12 * S;
    tracked(g, 'ATTACKS AIM AT THE CURSOR OR RIGHT STICK', W / 2, noteY, { size: 9 * S, track: 0.24, weight: 600, align: 'center', color: rgba(PAL.goldHi, 0.74) });
    this._menu(g, W, H, S, t, noteY + 38 * S, 1, 0);
  }
}

function fmtTime(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  const m = (s / 60) | 0;
  return m + ':' + String(s % 60).padStart(2, '0');
}
