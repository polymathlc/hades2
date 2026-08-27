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

const QUALITY = ['low', 'med', 'high', 'ultra'];

export class Menus {
  constructor(ui) {
    this.ui = ui;
    this.cache = new LayerCache();
    this.screen = 'game';
    this.t0 = 0;
    this.sel = 0;
    this.hit = [];                 // [{x,y,w,h,act,i}]
    this.settingsOpen = false;
    this.settings = { quality: 'high', master: 0.8, music: 0.7, sfx: 0.9, shake: true };
    this.summary = { depth: 1, biome: 'tartarus', kills: 0, damage: 0, time: 0, boons: [], killedBy: 'the Underworld' };
  }

  set(screen) {
    if (this.screen === screen) return;
    this.screen = screen;
    this.t0 = this.ui.now();
    this.sel = 0;
    this.settingsOpen = false;
    this.ui.dirty = true;
  }

  get modal() { return this.screen === 'title' || this.screen === 'pause' || this.screen === 'death' || this.screen === 'victory'; }

  items() {
    if (this.settingsOpen) return [{ label: 'Back', act: 'back' }];
    switch (this.screen) {
      case 'title': return [{ label: 'Descend', act: 'start' }, { label: 'Settings', act: 'settings' }, { label: 'Credits', act: 'credits' }];
      case 'pause': return [{ label: 'Resume', act: 'resume' }, { label: 'Settings', act: 'settings' }, { label: 'Abandon Run', act: 'abandon' }];
      case 'death': return [{ label: 'Rise Again', act: 'start' }, { label: 'Settings', act: 'settings' }];
      case 'victory': return [{ label: 'Descend Again', act: 'start' }];
      default: return [];
    }
  }

  activate(act) {
    const ui = this.ui;
    switch (act) {
      case 'settings': this.settingsOpen = true; this.sel = 0; break;
      case 'back': this.settingsOpen = false; this.sel = 0; break;
      case 'resume': ui.screen('game'); break;
      case 'start': ui.screen('game'); ui.ctx?.events?.emit?.('run.start', {}); break;
      case 'abandon': ui.screen('title'); ui.ctx?.events?.emit?.('run.abandon', {}); break;
      default: break;
    }
    ui.ctx?.audio?.sfx?.('ui.select', { gain: 0.6 });
    ui.dirty = true;
  }

  key(dir) {
    const n = this.items().length + (this.settingsOpen ? 5 : 0);
    if (!n) return;
    this.sel = (this.sel + dir + n) % n;
    this.ui.dirty = true;
  }

  click(x, y) {
    for (const h of this.hit) {
      if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) {
        if (h.act === 'setting') this._bump(h.key, 1);
        else this.activate(h.act);
        return true;
      }
    }
    return false;
  }

  move(x, y) {
    for (let i = 0; i < this.hit.length; i++) {
      const h = this.hit[i];
      if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) { if (this.sel !== h.i) { this.sel = h.i; this.ui.dirty = true; } return; }
    }
  }

  _bump(key, d) {
    const s = this.settings;
    if (key === 'quality') { const i = QUALITY.indexOf(s.quality); s.quality = QUALITY[(i + d + QUALITY.length) % QUALITY.length]; this.ui.ctx?.events?.emit?.('quality.request', { tier: s.quality }); }
    else if (key === 'shake') { s.shake = !s.shake; this.ui.ctx?.events?.emit?.('settings.shake', { on: s.shake }); }
    else { s[key] = Math.round(((s[key] + 0.1 * d) % 1.05) * 10) / 10; if (s[key] < 0) s[key] = 1; this.ui.ctx?.events?.emit?.('settings.volume', { channel: key, value: s[key] }); }
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

    if (this.settingsOpen) this._settings(g, W, H, S, t, H * 0.52);
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
    const w = 460 * S, h = (this.settingsOpen ? 400 : 330) * S;
    const x = (W - w) / 2, y = (H - h) / 2 + (1 - a) * -16 * S;
    g.save(); g.globalAlpha = a;
    frame(g, {
      x, y, w, h, weight: 1.25 * S, r: 9 * S, pad: 8,
      meander: 'both', meanderH: 9, palmettes: 'crest', palmetteS: 15,
      sweep: (t * 0.2) % 1, glowAlpha: 0.26,
      fill: { top: '#1c1229', mid: '#120b1e', bot: '#0a0612' },
    });
    tracked(g, title.toUpperCase(), W / 2, y + 62 * S, {
      size: 27 * S, track: 0.26, weight: 700, align: 'center', gold: true, sweep: (t * 0.2) % 1,
      shadow: '#06030c', shadowDy: 3 * S,
    });
    const rw = w - 120 * S;
    const rg = g.createLinearGradient(W / 2 - rw / 2, 0, W / 2 + rw / 2, 0);
    rg.addColorStop(0, 'rgba(0,0,0,0)'); rg.addColorStop(0.5, rgba(PAL.gold, 0.65)); rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg; g.fillRect(W / 2 - rw / 2, y + 76 * S, rw, Math.max(1, 1.2 * S));
    g.restore();
    if (this.settingsOpen) this._settings(g, W, H, S, t, y + 110 * S, w - 90 * S);
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

    if (this.settingsOpen) this._settings(g, W, H, S, t, H * 0.66);
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

  // ═══════════════════════════════════════════════════════ SETTINGS ═══════
  _settings(g, W, H, S, t, y0, width) {
    const s = this.settings;
    const w = width || 420 * S, cx = W / 2, x = cx - w / 2;
    const rows = [
      { key: 'quality', label: 'Quality', kind: 'cycle', value: s.quality.toUpperCase() },
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
      this.hit.push({ x, y: y - 14 * S, w, h: 26 * S, act: 'setting', key: r.key, i });
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
}

function fmtTime(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  const m = (s / 60) | 0;
  return m + ':' + String(s % 60).padStart(2, '0');
}
