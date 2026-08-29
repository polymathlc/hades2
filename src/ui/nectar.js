// Canvas modal for spending boss-earned Nectar at the Crossroads altar.

import { PAL, frame, plaqueRect, tracked, wrap, rgba, goldGradient, ease, clamp01, bodyFont } from './ornament.js';
import { godEmblem } from './boons.js';
import { GOD_INFO, GOD_KEYS } from '../game/boons.js';
import { GOD_LEGACIES, META_MAX_RANK } from '../game/meta.js';
import { lockModalInput, releaseModalInput } from './modal-input.js';

export class NectarOverlay {
  constructor(ui) {
    this.ui = ui;
    this.active = false;
    this.meta = null;
    this.selected = 0;
    this.track = 'boon';
    this.t0 = 0;
    this.hit = [];
    this._inputWasEnabled = true;
    this._inputLockHeld = false;
  }

  open(meta) {
    if (!meta) return;
    this.meta = meta;
    // Interact/capture events can arrive twice in one frame. Never replace the
    // original input snapshot with the already-disabled modal state, otherwise
    // close() leaves the hero permanently unable to move.
    if (this.active) {
      this.ui.dirty = true;
      return;
    }
    this.active = true;
    this.selected = Math.max(0, Math.min(GOD_KEYS.length - 1, this.selected));
    this.track = 'boon';
    this.t0 = this.ui.now();
    this.ui.hud?.alpha?.set?.(0.2);
    lockModalInput(this, this.ui.ctx?.input);
    this.ui.dirty = true;
  }

  close() {
    if (!this.active) return;
    this.active = false;
    this.ui.hud?.alpha?.set?.(1);
    releaseModalInput(this, this.ui.ctx?.input, this.ui.menus?.screen === 'game' && !this.ui.boonUI?.active);
    this.ui.ctx?.events?.emit?.('home.altarClosed', {});
    this.ui.dirty = true;
  }

  buy(track = this.track) {
    const god = GOD_KEYS[this.selected];
    const result = this.meta?.upgrade?.(god, track);
    if (result?.ok) {
      this.ui.ctx?.audio?.sfx?.('ui.boon', { gain: 0.75 });
      const label = track === 'boon' ? 'Boon Mastery' : GOD_LEGACIES[god]?.name;
      this.ui.toast(`${GOD_INFO[god].name} · ${label} ${result.rank}/${META_MAX_RANK}`, { color: GOD_INFO[god].color, dur: 2.8 });
    } else if (result?.reason === 'max') {
      this.ui.toast('This offering is already complete', { color: '#d8b6ff' });
    } else {
      this.ui.toast(`Not enough Nectar · Need ${result?.cost || 1}`, { color: '#e8506a' });
    }
    this.ui.dirty = true;
  }

  key(e) {
    if (!this.active) return false;
    if (e.key === 'Escape') this.close();
    else if (e.key === 'ArrowUp' || e.key.toLowerCase() === 'w') this.selected = (this.selected + GOD_KEYS.length - 1) % GOD_KEYS.length;
    else if (e.key === 'ArrowDown' || e.key.toLowerCase() === 's') this.selected = (this.selected + 1) % GOD_KEYS.length;
    else if (e.key === 'ArrowLeft' || e.key.toLowerCase() === 'a') this.track = 'boon';
    else if (e.key === 'ArrowRight' || e.key.toLowerCase() === 'd') this.track = 'passive';
    else if (e.key === 'Enter' || e.key === ' ') this.buy();
    else return false;
    e.preventDefault?.();
    this.ui.dirty = true;
    return true;
  }

  gamepad(action) {
    if (!this.active) return false;
    if (action === 'back') this.close();
    else if (action === 'up') this.selected = (this.selected + GOD_KEYS.length - 1) % GOD_KEYS.length;
    else if (action === 'down') this.selected = (this.selected + 1) % GOD_KEYS.length;
    else if (action === 'left') this.track = 'boon';
    else if (action === 'right') this.track = 'passive';
    else if (action === 'accept') this.buy();
    else return false;
    this.ui.dirty = true;
    return true;
  }

  move(x, y) {
    for (const h of this.hit) {
      if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) {
        if (h.god != null) this.selected = h.god;
        if (h.track) this.track = h.track;
        this.ui.dirty = true;
        return true;
      }
    }
    return false;
  }

  click(x, y) {
    // Buttons are appended after their containing cards; walk backwards so a
    // click on OFFER buys instead of being swallowed by the card selection.
    for (let i = this.hit.length - 1; i >= 0; i--) {
      const h = this.hit[i];
      if (x < h.x || x > h.x + h.w || y < h.y || y > h.y + h.h) continue;
      if (h.act === 'close') this.close();
      else if (h.act === 'buy') { if (h.track) this.track = h.track; this.buy(h.track || this.track); }
      else {
        if (h.god != null) this.selected = h.god;
        if (h.track) this.track = h.track;
      }
      this.ui.dirty = true;
      return true;
    }
    return false;
  }

  draw(g, W, H, S, t) {
    if (!this.active || !this.meta) return;
    this.hit.length = 0;
    const age = t - this.t0, a = ease.out(clamp01(age / 0.32));
    const shade = g.createRadialGradient(W * 0.58, H * 0.45, H * 0.08, W * 0.5, H * 0.5, H * 1.0);
    shade.addColorStop(0, rgba('#1a0c2c', 0.68 * a));
    shade.addColorStop(1, rgba('#050309', 0.96 * a));
    g.fillStyle = shade; g.fillRect(0, 0, W, H);

    const pw = Math.min(W - 70 * S, 1260 * S), ph = Math.min(H - 60 * S, 730 * S);
    const px = (W - pw) / 2, py = (H - ph) / 2;
    g.save(); g.globalAlpha = a;
    frame(g, {
      x: px, y: py, w: pw, h: ph, r: 10 * S, pad: 9, meander: 'both', meanderH: 9,
      palmettes: 'crest', palmetteS: 15, sweep: (t * 0.18) % 1, glowAlpha: 0.24,
      fill: { top: '#201032', mid: '#130a20', bot: '#090511', bounce: '#8c5cff' },
    });
    tracked(g, 'ALTAR OF THE GODS', W / 2, py + 54 * S, { size: 29 * S, track: 0.30, weight: 700, align: 'center', gold: true, sweep: (t * 0.2) % 1, shadow: '#050209', shadowDy: 3 * S });
    tracked(g, 'OFFER BOSS-FOUGHT NECTAR FOR POWER THAT ENDURES BETWEEN RUNS', W / 2, py + 78 * S, { size: 10.5 * S, track: 0.28, weight: 600, align: 'center', color: rgba(PAL.parch, 0.72) });

    const nx = px + pw - 126 * S, ny = py + 28 * S, nw = 94 * S, nh = 34 * S;
    plaqueRect(g, nx, ny, nw, nh, 6 * S); g.fillStyle = rgba('#160b25', 0.94); g.fill(); g.strokeStyle = rgba('#b884ff', 0.8); g.lineWidth = 1.2 * S; g.stroke();
    this._nectarGlyph(g, nx + 17 * S, ny + 17 * S, 9 * S);
    tracked(g, String(this.meta.nectar), nx + nw - 12 * S, ny + 23 * S, { size: 16 * S, track: 0.08, weight: 700, align: 'right', color: '#e8d6ff' });

    const listX = px + 36 * S, listY = py + 112 * S, listW = 405 * S;
    const rowH = Math.min(52 * S, (ph - 150 * S) / GOD_KEYS.length);
    for (let i = 0; i < GOD_KEYS.length; i++) {
      const god = GOD_KEYS[i], info = GOD_INFO[god], y = listY + i * rowH;
      const on = i === this.selected;
      plaqueRect(g, listX, y, listW, rowH - 5 * S, 6 * S);
      g.fillStyle = on ? rgba(info.color, 0.18) : rgba('#0b0712', 0.62); g.fill();
      g.strokeStyle = on ? rgba(info.color, 0.95) : rgba(PAL.bronze, 0.38); g.lineWidth = (on ? 1.7 : 0.9) * S; g.stroke();
      godEmblem(g, listX + 24 * S, y + (rowH - 5 * S) / 2, 12.5 * S, god, { glowA: on ? 0.42 : 0.18, glowR: 1.65 });
      tracked(g, info.name.toUpperCase(), listX + 51 * S, y + 20 * S, { size: 13 * S, track: 0.18, weight: 700, align: 'left', color: on ? '#fff0c6' : rgba(PAL.parch, 0.76) });
      const br = this.meta.rank(god, 'boon'), pr = this.meta.rank(god, 'passive');
      const favor = Math.round((this.meta.appearanceBonus?.(god) || 0) * 100);
      tracked(g, `BOON ${br}/${META_MAX_RANK}  ·  LEGACY ${pr}/${META_MAX_RANK}  ·  FAVOR +${favor}%`, listX + 51 * S, y + 36 * S, { size: 7.7 * S, track: 0.13, weight: 600, align: 'left', color: rgba(info.color, 0.86), font: bodyFont() });
      this.hit.push({ x: listX, y, w: listW, h: rowH - 5 * S, god: i });
    }

    const god = GOD_KEYS[this.selected], info = GOD_INFO[god];
    const dx = listX + listW + 38 * S, dw = px + pw - 34 * S - dx;
    godEmblem(g, dx + 52 * S, listY + 48 * S, 31 * S, god, { glowA: 0.50, glowR: 2.1 });
    tracked(g, info.name.toUpperCase(), dx + 105 * S, listY + 36 * S, { size: 24 * S, track: 0.22, weight: 700, align: 'left', color: '#fff0c6', shadow: '#050209', shadowDy: 2 * S });
    tracked(g, info.title.toUpperCase(), dx + 105 * S, listY + 59 * S, { size: 10 * S, track: 0.30, weight: 600, align: 'left', color: rgba(info.color, 0.9) });
    tracked(g, `GATE FAVOR  +${Math.round((this.meta.appearanceBonus?.(god) || 0) * 100)}% APPEARANCE WEIGHT`, dx + 105 * S, listY + 82 * S, { size: 9 * S, track: 0.18, weight: 700, align: 'left', color: '#ffe9a8', font: bodyFont() });

    const cardY = listY + 104 * S, gap = 18 * S, cardW = (dw - gap) / 2, cardH = 286 * S;
    this._trackCard(g, { x: dx, y: cardY, w: cardW, h: cardH, god, track: 'boon', S, t });
    this._trackCard(g, { x: dx + cardW + gap, y: cardY, w: cardW, h: cardH, god, track: 'passive', S, t });

    const hintsY = py + ph - 31 * S;
    tracked(g, '↑ ↓  CHOOSE GOD     ← →  CHOOSE OFFERING     ENTER / A  OFFER     ESC / B  CLOSE', W / 2, hintsY, { size: 9 * S, track: 0.22, weight: 600, align: 'center', color: rgba(PAL.parchDim, 0.70), font: bodyFont() });
    const close = { x: px + pw - 52 * S, y: py + 74 * S, w: 30 * S, h: 30 * S, act: 'close' };
    tracked(g, '×', close.x + close.w / 2, close.y + 22 * S, { size: 20 * S, track: 0, weight: 700, align: 'center', color: rgba(PAL.parch, 0.72) });
    this.hit.push(close);
    g.restore();
  }

  _trackCard(g, o) {
    const { x, y, w, h, god, track, S, t } = o;
    const on = this.track === track, info = GOD_INFO[god];
    const rank = this.meta.rank(god, track), cost = this.meta.cost(god, track), max = rank >= META_MAX_RANK;
    plaqueRect(g, x, y, w, h, 8 * S);
    g.fillStyle = on ? rgba(info.color, 0.16) : rgba('#0b0712', 0.78); g.fill();
    g.strokeStyle = on ? goldGradient(g, x, y, x + w, y + h, (t * 0.22) % 1) : rgba(PAL.bronze, 0.48); g.lineWidth = (on ? 1.8 : 1.0) * S; g.stroke();
    const title = track === 'boon' ? 'BOON MASTERY' : GOD_LEGACIES[god].name.toUpperCase();
    tracked(g, title, x + w / 2, y + 42 * S, { size: 15 * S, track: 0.22, weight: 700, align: 'center', color: on ? '#ffe9a8' : rgba(PAL.parch, 0.82) });
    tracked(g, `${rank} / ${META_MAX_RANK}`, x + w / 2, y + 78 * S, { size: 29 * S, track: 0.10, weight: 700, align: 'center', color: info.color, shadow: '#050209', shadowDy: 2 * S });
    const favorText = `Each rank also adds +20% weight to ${info.name}'s chance of appearing at a gate.`;
    const desc = track === 'boon'
      ? `All numerical effects on ${info.name}'s boons gain +10% power per rank. Current power: +${rank * 10}%. ${favorText}`
      : `${GOD_LEGACIES[god].text(rank)}. This passive is active at the start of every descent. ${favorText}`;
    const lines = wrap(g, desc, w - 38 * S, { size: 12 * S, weight: 500, font: bodyFont() });
    g.font = `500 ${12 * S}px ${bodyFont()}`; g.fillStyle = rgba(PAL.parch, 0.78); g.textAlign = 'center';
    for (let i = 0; i < lines.length; i++) g.fillText(lines[i], x + w / 2, y + 118 * S + i * 18 * S);
    const by = y + h - 60 * S, bh = 40 * S, bx = x + 20 * S, bw = w - 40 * S;
    plaqueRect(g, bx, by, bw, bh, 7 * S);
    const affordable = this.meta.nectar >= cost;
    g.fillStyle = max ? rgba('#21172b', 0.82) : affordable ? rgba(info.color, on ? 0.38 : 0.24) : rgba('#32101a', 0.72); g.fill();
    g.strokeStyle = max ? rgba(PAL.bronze, 0.38) : affordable ? rgba(info.color, 0.9) : rgba('#e8506a', 0.72); g.lineWidth = 1.1 * S; g.stroke();
    const label = max ? 'OFFERING COMPLETE' : `OFFER ${cost} NECTAR`;
    tracked(g, label, x + w / 2, by + 26 * S, { size: 11.5 * S, track: 0.20, weight: 700, align: 'center', color: max ? rgba(PAL.parchDim, 0.58) : affordable ? '#fff0c6' : '#ff8a9a' });
    this.hit.push({ x, y, w, h, track });
    this.hit.push({ x: bx, y: by, w: bw, h: bh, track, act: 'buy' });
  }

  _nectarGlyph(g, cx, cy, r) {
    g.save(); g.translate(cx, cy);
    const grad = g.createLinearGradient(-r, -r, r, r);
    grad.addColorStop(0, '#f0dcff'); grad.addColorStop(0.45, '#b884ff'); grad.addColorStop(1, '#56218f');
    plaqueRect(g, -r * 0.58, -r * 0.55, r * 1.16, r * 1.35, r * 0.34); g.fillStyle = grad; g.fill();
    g.fillStyle = '#f2c14e'; g.fillRect(-r * 0.32, -r * 0.92, r * 0.64, r * 0.34);
    g.strokeStyle = rgba('#fff4d0', 0.62); g.lineWidth = Math.max(1, r * 0.10); g.stroke();
    g.restore();
  }
}

export default NectarOverlay;
