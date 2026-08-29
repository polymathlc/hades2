// Canvas modal for spending boss-earned Nectar at the Crossroads altar.

import { PAL, frame, plaqueRect, tracked, wrap, rgba, goldGradient, ease, clamp01, bodyFont } from './ornament.js';
import { godEmblem } from './boons.js';
import { GOD_INFO, GOD_KEYS } from '../game/boons.js';
import {
  GOD_LEGACIES, META_MAX_RANK, META_WEAPONS, WEAPON_MAX_RANK, GOD_TRACKS, WEAPON_TRACKS,
  MIRROR_TALENTS, MIRROR_TRACKS,
} from '../game/meta.js';
import { lockModalInput, releaseModalInput } from './modal-input.js';

export class NectarOverlay {
  constructor(ui) {
    this.ui = ui;
    this.active = false;
    this.meta = null;
    this.page = 'gods';
    this.selected = 0;
    this.selectedWeapon = 0;
    this.selectedMirror = 0;
    this.track = 'boon';
    this.t0 = 0;
    this.hit = [];
    this._inputWasEnabled = true;
    this._inputLockHeld = false;
  }

  open(meta, page = 'gods') {
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
    this._openedAt = page === 'mirror' ? 'mirror' : 'altar';
    this.selected = Math.max(0, Math.min(GOD_KEYS.length - 1, this.selected));
    this.selectedWeapon = Math.max(0, Math.min(Object.keys(META_WEAPONS).length - 1, this.selectedWeapon));
    this.selectedMirror = Math.max(0, Math.min(MIRROR_TRACKS.length - 1, this.selectedMirror));
    this._setPage(page);
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
    this.ui.ctx?.events?.emit?.(this._openedAt === 'mirror' ? 'home.mirrorClosed' : 'home.altarClosed', {});
    this.ui.dirty = true;
  }

  buy(track = this.track) {
    if (this.page === 'mirror') {
      const talent = MIRROR_TRACKS[this.selectedMirror];
      const result = this.meta?.upgradeMirror?.(talent);
      if (result?.ok) {
        this.ui.ctx?.audio?.sfx?.('ui.boon', { gain: 0.75 });
        this.ui.toast(`${MIRROR_TALENTS[talent].name.toUpperCase()} · RANK ${result.rank}/${MIRROR_TALENTS[talent].max}`, { color: '#b884ff', dur: 2.8 });
      } else if (result?.reason === 'max') this.ui.toast('This Mirror talent is complete', { color: '#d8b6ff' });
      else this.ui.toast(`Not enough Darkness · Need ${result?.cost || 1}`, { color: '#a775ff' });
      this.ui.dirty = true;
      return;
    }
    if (this.page === 'weapons') {
      const weapon = Object.keys(META_WEAPONS)[this.selectedWeapon];
      const result = this.meta?.upgradeWeapon?.(weapon, track);
      if (result?.ok) {
        this.ui.ctx?.audio?.sfx?.('ui.boon', { gain: 0.75 });
        this.ui.toast(`${META_WEAPONS[weapon]} · ${track.toUpperCase()} ${result.rank}/${WEAPON_MAX_RANK}`, { color: '#ff756b', dur: 2.8 });
      } else if (result?.reason === 'max') this.ui.toast('This weapon path is already complete', { color: '#ffb08a' });
      else this.ui.toast(`Not enough Titan Blood · Need ${result?.cost || 1}`, { color: '#e8506a' });
      this.ui.dirty = true;
      return;
    }
    const god = GOD_KEYS[this.selected];
    const result = this.meta?.upgrade?.(god, track);
    if (result?.ok) {
      this.ui.ctx?.audio?.sfx?.('ui.boon', { gain: 0.75 });
      const label = track === 'boon' ? 'Boon Mastery' : track === 'devotion' ? 'Divine Devotion' : GOD_LEGACIES[god]?.name;
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
    else if (e.key === 'Tab' || e.key.toLowerCase() === 'q' || e.key.toLowerCase() === 'e') this._cyclePage(1);
    else if (e.key === 'ArrowUp' || e.key.toLowerCase() === 'w') this._moveSelection(-1);
    else if (e.key === 'ArrowDown' || e.key.toLowerCase() === 's') this._moveSelection(1);
    else if (e.key === 'ArrowLeft' || e.key.toLowerCase() === 'a') this._moveTrack(-1);
    else if (e.key === 'ArrowRight' || e.key.toLowerCase() === 'd') this._moveTrack(1);
    else if (e.key === 'Enter' || e.key === ' ') this.buy();
    else return false;
    e.preventDefault?.();
    this.ui.dirty = true;
    return true;
  }

  gamepad(action) {
    if (!this.active) return false;
    if (action === 'back') this.close();
    else if (action === 'up') this._moveSelection(-1);
    else if (action === 'down') this._moveSelection(1);
    else if (action === 'left') this._moveTrack(-1, true);
    else if (action === 'right') this._moveTrack(1, true);
    else if (action === 'accept') this.buy();
    else return false;
    this.ui.dirty = true;
    return true;
  }

  move(x, y) {
    for (const h of this.hit) {
      if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) {
        if (h.god != null) this.selected = h.god;
        if (h.weapon != null) this.selectedWeapon = h.weapon;
        if (h.mirror != null) this.selectedMirror = h.mirror;
        if (h.page) this._setPage(h.page);
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
        if (h.weapon != null) this.selectedWeapon = h.weapon;
        if (h.page) this._setPage(h.page);
        if (h.track) this.track = h.track;
      }
      this.ui.dirty = true;
      return true;
    }
    return false;
  }

  _tracks() { return this.page === 'weapons' ? WEAPON_TRACKS : this.page === 'mirror' ? ['rank'] : GOD_TRACKS; }
  _setPage(page) {
    this.page = ['gods', 'weapons', 'mirror'].includes(page) ? page : 'gods';
    this.track = this._tracks()[0];
  }
  _cyclePage(delta) {
    const pages = ['gods', 'weapons', 'mirror'];
    this._setPage(pages[(pages.indexOf(this.page) + delta + pages.length) % pages.length]);
  }
  _moveSelection(delta) {
    const n = this.page === 'weapons' ? Object.keys(META_WEAPONS).length : this.page === 'mirror' ? MIRROR_TRACKS.length : GOD_KEYS.length;
    const key = this.page === 'weapons' ? 'selectedWeapon' : this.page === 'mirror' ? 'selectedMirror' : 'selected';
    this[key] = (this[key] + delta + n) % n;
  }
  _moveTrack(delta, switchAtEdge = false) {
    const tracks = this._tracks();
    const index = Math.max(0, tracks.indexOf(this.track));
    const next = index + delta;
    if (switchAtEdge && (next < 0 || next >= tracks.length)) {
      this._cyclePage(delta > 0 ? 1 : -1);
      this.track = delta > 0 ? this._tracks()[0] : this._tracks().at(-1);
    } else this.track = tracks[(next + tracks.length) % tracks.length];
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
    tracked(g, 'CROSSROADS LEGACIES', W / 2, py + 54 * S, { size: 29 * S, track: 0.30, weight: 700, align: 'center', gold: true, sweep: (t * 0.2) % 1, shadow: '#050209', shadowDy: 3 * S });
    tracked(g, 'OFFER RELICS AND DARKNESS FOR POWER THAT ENDURES BETWEEN RUNS', W / 2, py + 78 * S, { size: 10.5 * S, track: 0.28, weight: 600, align: 'center', color: rgba(PAL.parch, 0.72) });

    const nx = px + pw - 126 * S, ny = py + 28 * S, nw = 94 * S, nh = 34 * S;
    plaqueRect(g, nx, ny, nw, nh, 6 * S); g.fillStyle = rgba('#160b25', 0.94); g.fill(); g.strokeStyle = rgba('#b884ff', 0.8); g.lineWidth = 1.2 * S; g.stroke();
    this._nectarGlyph(g, nx + 17 * S, ny + 17 * S, 9 * S);
    tracked(g, String(this.meta.nectar), nx + nw - 12 * S, ny + 23 * S, { size: 16 * S, track: 0.08, weight: 700, align: 'right', color: '#e8d6ff' });
    const bx = nx - 106 * S;
    plaqueRect(g, bx, ny, 96 * S, nh, 6 * S); g.fillStyle = rgba('#25080f', 0.94); g.fill(); g.strokeStyle = rgba('#ff5968', 0.82); g.lineWidth = 1.2 * S; g.stroke();
    this._bloodGlyph(g, bx + 17 * S, ny + 17 * S, 9 * S);
    tracked(g, String(this.meta.titanBlood || 0), bx + 84 * S, ny + 23 * S, { size: 16 * S, track: 0.08, weight: 700, align: 'right', color: '#ffd1bd' });
    const kx = bx - 106 * S;
    plaqueRect(g, kx, ny, 96 * S, nh, 6 * S); g.fillStyle = rgba('#120620', 0.94); g.fill(); g.strokeStyle = rgba('#8c5cff', 0.82); g.lineWidth = 1.2 * S; g.stroke();
    this._darknessGlyph(g, kx + 17 * S, ny + 17 * S, 9 * S);
    tracked(g, String(this.meta.darkness || 0), kx + 84 * S, ny + 23 * S, { size: 16 * S, track: 0.08, weight: 700, align: 'right', color: '#e4d4ff' });

    const tabY = py + 92 * S, tabW = 154 * S, tabH = 30 * S;
    const pages = ['gods', 'weapons', 'mirror'];
    const tabsWide = pages.length * tabW + (pages.length - 1) * 7 * S;
    for (const [i, page] of pages.entries()) {
      const tx = W / 2 - tabsWide / 2 + i * (tabW + 7 * S);
      plaqueRect(g, tx, tabY, tabW, tabH, 5 * S);
      const pageColor = page === 'gods' ? '#8c5cff' : page === 'weapons' ? '#ff5968' : '#a775ff';
      g.fillStyle = this.page === page ? rgba(pageColor, 0.28) : rgba('#090611', 0.72); g.fill();
      g.strokeStyle = this.page === page ? rgba('#ffe9a8', 0.84) : rgba(PAL.bronze, 0.42); g.lineWidth = (this.page === page ? 1.5 : 0.9) * S; g.stroke();
      const pageLabel = page === 'gods' ? 'GODS · NECTAR' : page === 'weapons' ? 'WEAPONS · TITAN BLOOD' : 'MIRROR · DARKNESS';
      tracked(g, pageLabel, tx + tabW / 2, tabY + 20 * S, { size: 9.2 * S, track: 0.18, weight: 700, align: 'center', color: this.page === page ? '#fff0c6' : rgba(PAL.parch, 0.62) });
      this.hit.push({ x: tx, y: tabY, w: tabW, h: tabH, page });
    }

    const listX = px + 36 * S, listY = py + 139 * S, listW = 405 * S;
    const dx = listX + listW + 38 * S, dw = px + pw - 34 * S - dx;
    if (this.page === 'gods') this._drawGodPage(g, { listX, listY, listW, dx, dw, ph, px, py, S, t });
    else if (this.page === 'weapons') this._drawWeaponPage(g, { listX, listY, listW, dx, dw, ph, px, py, S, t });
    else this._drawMirrorPage(g, { listX, listY, listW, dx, dw, ph, px, py, S, t });

    const hintsY = py + ph - 31 * S;
    tracked(g, '↑ ↓  CHOOSE     ← →  PATH     TAB / Q / E  CHANGE PAGE     ENTER / A  UPGRADE     ESC / B  CLOSE', W / 2, hintsY, { size: 8.5 * S, track: 0.17, weight: 600, align: 'center', color: rgba(PAL.parchDim, 0.70), font: bodyFont() });
    const close = { x: px + pw - 52 * S, y: py + 74 * S, w: 30 * S, h: 30 * S, act: 'close' };
    tracked(g, '×', close.x + close.w / 2, close.y + 22 * S, { size: 20 * S, track: 0, weight: 700, align: 'center', color: rgba(PAL.parch, 0.72) });
    this.hit.push(close);
    g.restore();
  }

  _drawGodPage(g, o) {
    const { listX, listY, listW, dx, dw, ph, S, t } = o;
    const rowH = Math.min(49 * S, (ph - 181 * S) / GOD_KEYS.length);
    for (let i = 0; i < GOD_KEYS.length; i++) {
      const god = GOD_KEYS[i], info = GOD_INFO[god], y = listY + i * rowH, on = i === this.selected;
      plaqueRect(g, listX, y, listW, rowH - 4 * S, 6 * S);
      g.fillStyle = on ? rgba(info.color, 0.18) : rgba('#0b0712', 0.62); g.fill();
      g.strokeStyle = on ? rgba(info.color, 0.95) : rgba(PAL.bronze, 0.38); g.lineWidth = (on ? 1.7 : 0.9) * S; g.stroke();
      godEmblem(g, listX + 23 * S, y + (rowH - 4 * S) / 2, 12 * S, god, { glowA: on ? 0.42 : 0.18, glowR: 1.65 });
      tracked(g, info.name.toUpperCase(), listX + 49 * S, y + 18 * S, { size: 12.5 * S, track: 0.18, weight: 700, align: 'left', color: on ? '#fff0c6' : rgba(PAL.parch, 0.76) });
      const br = this.meta.rank(god, 'boon'), pr = this.meta.rank(god, 'passive'), dr = this.meta.rank(god, 'devotion');
      const favor = Math.round((this.meta.appearanceBonus?.(god) || 0) * 100);
      tracked(g, `BOON ${br} · LEGACY ${pr} · DEVOTION ${dr}  ·  FAVOR +${favor}%`, listX + 49 * S, y + 33 * S, { size: 7.5 * S, track: 0.11, weight: 600, align: 'left', color: rgba(info.color, 0.86), font: bodyFont() });
      this.hit.push({ x: listX, y, w: listW, h: rowH - 4 * S, god: i });
    }
    const god = GOD_KEYS[this.selected], info = GOD_INFO[god];
    godEmblem(g, dx + 42 * S, listY + 39 * S, 26 * S, god, { glowA: 0.50, glowR: 2.1 });
    tracked(g, info.name.toUpperCase(), dx + 88 * S, listY + 29 * S, { size: 21 * S, track: 0.20, weight: 700, align: 'left', color: '#fff0c6', shadow: '#050209', shadowDy: 2 * S });
    tracked(g, `FAVOR +${Math.round((this.meta.appearanceBonus?.(god) || 0) * 100)}%  ·  RARE+ ${Math.round((this.meta.rareOrBetterChance?.(god) || 0) * 100)}%`, dx + 88 * S, listY + 56 * S, { size: 9 * S, track: 0.15, weight: 700, align: 'left', color: '#ffe9a8', font: bodyFont() });
    const cardY = listY + 82 * S, gap = 12 * S, cardW = (dw - gap * 2) / 3, cardH = 310 * S;
    for (const [i, track] of GOD_TRACKS.entries()) this._trackCard(g, { x: dx + i * (cardW + gap), y: cardY, w: cardW, h: cardH, god, track, S, t });
  }

  _drawWeaponPage(g, o) {
    const { listX, listY, listW, dx, dw, S, t } = o;
    const weapons = Object.keys(META_WEAPONS), rowH = 96 * S;
    for (let i = 0; i < weapons.length; i++) {
      const weapon = weapons[i], y = listY + i * rowH, on = i === this.selectedWeapon;
      plaqueRect(g, listX, y, listW, rowH - 10 * S, 7 * S);
      g.fillStyle = on ? rgba('#ff5968', 0.16) : rgba('#0b0712', 0.62); g.fill();
      g.strokeStyle = on ? rgba('#ff9a6b', 0.92) : rgba(PAL.bronze, 0.38); g.lineWidth = (on ? 1.7 : 0.9) * S; g.stroke();
      this._weaponGlyph(g, listX + 36 * S, y + 41 * S, 19 * S, weapon);
      tracked(g, META_WEAPONS[weapon].toUpperCase(), listX + 72 * S, y + 34 * S, { size: 14 * S, track: 0.15, weight: 700, align: 'left', color: on ? '#fff0c6' : rgba(PAL.parch, 0.76) });
      const ranks = WEAPON_TRACKS.map(track => `${track.slice(0, 3).toUpperCase()} ${this.meta.weaponRank(weapon, track)}`).join('  ·  ');
      tracked(g, ranks, listX + 72 * S, y + 58 * S, { size: 9 * S, track: 0.14, weight: 600, align: 'left', color: rgba('#ff9a6b', 0.84), font: bodyFont() });
      this.hit.push({ x: listX, y, w: listW, h: rowH - 10 * S, weapon: i });
    }
    const weapon = weapons[this.selectedWeapon];
    this._weaponGlyph(g, dx + 42 * S, listY + 39 * S, 27 * S, weapon);
    tracked(g, META_WEAPONS[weapon].toUpperCase(), dx + 88 * S, listY + 31 * S, { size: 19 * S, track: 0.18, weight: 700, align: 'left', color: '#fff0c6' });
    tracked(g, 'PERMANENT FORGE · APPLIES WHEN THIS ARM IS BOUND', dx + 88 * S, listY + 55 * S, { size: 8.5 * S, track: 0.15, weight: 700, align: 'left', color: '#ffb08a', font: bodyFont() });
    const cardY = listY + 82 * S, gap = 12 * S, cardW = (dw - gap * 2) / 3, cardH = 310 * S;
    for (const [i, track] of WEAPON_TRACKS.entries()) this._weaponTrackCard(g, { x: dx + i * (cardW + gap), y: cardY, w: cardW, h: cardH, weapon, track, S, t });
  }

  _drawMirrorPage(g, o) {
    const { listX, listY, listW, dx, dw, ph, S, t } = o;
    const rowH = Math.min(66 * S, (ph - 181 * S) / MIRROR_TRACKS.length);
    for (let i = 0; i < MIRROR_TRACKS.length; i++) {
      const talent = MIRROR_TRACKS[i], def = MIRROR_TALENTS[talent], y = listY + i * rowH, on = i === this.selectedMirror;
      plaqueRect(g, listX, y, listW, rowH - 5 * S, 6 * S);
      g.fillStyle = on ? rgba('#8c5cff', 0.20) : rgba('#0b0712', 0.62); g.fill();
      g.strokeStyle = on ? rgba('#b884ff', 0.96) : rgba(PAL.bronze, 0.38); g.lineWidth = (on ? 1.7 : 0.9) * S; g.stroke();
      this._darknessGlyph(g, listX + 25 * S, y + (rowH - 5 * S) / 2, 11 * S);
      tracked(g, def.name.toUpperCase(), listX + 50 * S, y + 20 * S, { size: 11.8 * S, track: 0.16, weight: 700, align: 'left', color: on ? '#fff0c6' : rgba(PAL.parch, 0.76) });
      const rank = this.meta.mirrorRank(talent);
      tracked(g, `RANK ${rank} / ${def.max}`, listX + 50 * S, y + 38 * S, { size: 8.2 * S, track: 0.13, weight: 600, align: 'left', color: rgba('#b884ff', 0.9), font: bodyFont() });
      this.hit.push({ x: listX, y, w: listW, h: rowH - 5 * S, mirror: i });
    }

    const talent = MIRROR_TRACKS[this.selectedMirror], def = MIRROR_TALENTS[talent];
    const rank = this.meta.mirrorRank(talent), cost = this.meta.mirrorCost(talent), max = rank >= def.max;
    const cardW = Math.min(dw, 520 * S), cardH = 350 * S, x = dx + (dw - cardW) / 2, y = listY + 62 * S;
    this._darknessGlyph(g, dx + 43 * S, listY + 32 * S, 23 * S);
    tracked(g, 'MIRROR OF NIGHT', dx + 82 * S, listY + 28 * S, { size: 20 * S, track: 0.20, weight: 700, align: 'left', color: '#fff0c6' });
    tracked(g, 'DARKNESS REVEALS PERMANENT TALENTS', dx + 82 * S, listY + 51 * S, { size: 8.7 * S, track: 0.17, weight: 700, align: 'left', color: '#b884ff', font: bodyFont() });
    plaqueRect(g, x, y, cardW, cardH, 9 * S);
    g.fillStyle = rgba('#170923', 0.88); g.fill();
    g.strokeStyle = goldGradient(g, x, y, x + cardW, y + cardH, (t * 0.22) % 1); g.lineWidth = 1.8 * S; g.stroke();
    tracked(g, def.name.toUpperCase(), x + cardW / 2, y + 53 * S, { size: 18 * S, track: 0.20, weight: 700, align: 'center', color: '#ffe9a8' });
    tracked(g, `${rank} / ${def.max}`, x + cardW / 2, y + 101 * S, { size: 31 * S, track: 0.10, weight: 700, align: 'center', color: '#b884ff', shadow: '#050209', shadowDy: 2 * S });
    const desc = max
      ? `${def.text(rank)} This talent is fully awakened and is active at the start of every descent.`
      : rank > 0
        ? `Next rank: ${def.text(rank + 1)} Current effect: ${def.text(rank)}`
        : `Next rank: ${def.text(1)} It becomes active at the start of every descent.`;
    const fontSize = 12 * S, lines = wrap(g, desc, cardW - 60 * S, { size: fontSize, weight: 500, font: bodyFont() });
    g.font = `500 ${fontSize}px ${bodyFont()}`; g.fillStyle = rgba(PAL.parch, 0.82); g.textAlign = 'center';
    for (let i = 0; i < Math.min(lines.length, 6); i++) g.fillText(lines[i], x + cardW / 2, y + 145 * S + i * 19 * S);
    const bx = x + 46 * S, by = y + cardH - 69 * S, bw = cardW - 92 * S, bh = 44 * S;
    plaqueRect(g, bx, by, bw, bh, 7 * S);
    const affordable = (this.meta.darkness || 0) >= cost;
    g.fillStyle = max ? rgba('#21172b', 0.82) : affordable ? rgba('#8c5cff', 0.38) : rgba('#32101a', 0.72); g.fill();
    g.strokeStyle = max ? rgba(PAL.bronze, 0.38) : affordable ? rgba('#b884ff', 0.95) : rgba('#e8506a', 0.72); g.lineWidth = 1.2 * S; g.stroke();
    const label = max ? 'TALENT COMPLETE' : `SPEND ${cost} DARKNESS`;
    tracked(g, label, x + cardW / 2, by + 29 * S, { size: 10.2 * S, track: 0.16, weight: 700, align: 'center', color: max ? rgba(PAL.parchDim, 0.58) : affordable ? '#fff0c6' : '#ff8a9a' });
    this.hit.push({ x, y, w: cardW, h: cardH, track: 'rank' });
    this.hit.push({ x: bx, y: by, w: bw, h: bh, track: 'rank', act: 'buy' });
  }

  _trackCard(g, o) {
    const { x, y, w, h, god, track, S, t } = o;
    const on = this.track === track, info = GOD_INFO[god];
    const rank = this.meta.rank(god, track), cost = this.meta.cost(god, track), max = rank >= META_MAX_RANK;
    plaqueRect(g, x, y, w, h, 8 * S);
    g.fillStyle = on ? rgba(info.color, 0.16) : rgba('#0b0712', 0.78); g.fill();
    g.strokeStyle = on ? goldGradient(g, x, y, x + w, y + h, (t * 0.22) % 1) : rgba(PAL.bronze, 0.48); g.lineWidth = (on ? 1.8 : 1.0) * S; g.stroke();
    const title = track === 'boon' ? 'BOON MASTERY' : track === 'devotion' ? 'DIVINE DEVOTION' : GOD_LEGACIES[god].name.toUpperCase();
    tracked(g, title, x + w / 2, y + 39 * S, { size: 11.5 * S, track: 0.16, weight: 700, align: 'center', color: on ? '#ffe9a8' : rgba(PAL.parch, 0.82) });
    tracked(g, `${rank} / ${META_MAX_RANK}`, x + w / 2, y + 75 * S, { size: 26 * S, track: 0.10, weight: 700, align: 'center', color: info.color, shadow: '#050209', shadowDy: 2 * S });
    const favorText = `Each rank also adds +20% weight to ${info.name}'s chance of appearing at a gate.`;
    const desc = track === 'boon'
      ? `Numerical boon effects gain +10% power per rank. Current power: +${rank * 10}%. ${favorText}`
      : track === 'devotion'
        ? `Raises Rare, Epic and Heroic offer rates. Current Rare-or-better chance: ${Math.round((this.meta.rareOrBetterChance?.(god) || 0) * 100)}%. ${favorText}`
        : `${GOD_LEGACIES[god].text(rank)}. Active at the start of every descent. ${favorText}`;
    const fontSize = 10.5 * S;
    const lines = wrap(g, desc, w - 28 * S, { size: fontSize, weight: 500, font: bodyFont() });
    g.font = `500 ${fontSize}px ${bodyFont()}`; g.fillStyle = rgba(PAL.parch, 0.78); g.textAlign = 'center';
    for (let i = 0; i < Math.min(lines.length, 7); i++) g.fillText(lines[i], x + w / 2, y + 111 * S + i * 16 * S);
    const by = y + h - 60 * S, bh = 40 * S, bx = x + 20 * S, bw = w - 40 * S;
    plaqueRect(g, bx, by, bw, bh, 7 * S);
    const affordable = this.meta.nectar >= cost;
    g.fillStyle = max ? rgba('#21172b', 0.82) : affordable ? rgba(info.color, on ? 0.38 : 0.24) : rgba('#32101a', 0.72); g.fill();
    g.strokeStyle = max ? rgba(PAL.bronze, 0.38) : affordable ? rgba(info.color, 0.9) : rgba('#e8506a', 0.72); g.lineWidth = 1.1 * S; g.stroke();
    const label = max ? 'OFFERING COMPLETE' : `OFFER ${cost} NECTAR`;
    tracked(g, label, x + w / 2, by + 26 * S, { size: 9.5 * S, track: 0.15, weight: 700, align: 'center', color: max ? rgba(PAL.parchDim, 0.58) : affordable ? '#fff0c6' : '#ff8a9a' });
    this.hit.push({ x, y, w, h, track });
    this.hit.push({ x: bx, y: by, w: bw, h: bh, track, act: 'buy' });
  }

  _weaponTrackCard(g, o) {
    const { x, y, w, h, weapon, track, S, t } = o;
    const on = this.track === track, rank = this.meta.weaponRank(weapon, track);
    const cost = this.meta.weaponCost(weapon, track), max = rank >= WEAPON_MAX_RANK;
    plaqueRect(g, x, y, w, h, 8 * S);
    g.fillStyle = on ? rgba('#ff5968', 0.17) : rgba('#0b0712', 0.78); g.fill();
    g.strokeStyle = on ? goldGradient(g, x, y, x + w, y + h, (t * 0.22) % 1) : rgba(PAL.bronze, 0.48); g.lineWidth = (on ? 1.8 : 1.0) * S; g.stroke();
    tracked(g, `${track.toUpperCase()} FORGE`, x + w / 2, y + 40 * S, { size: 12 * S, track: 0.18, weight: 700, align: 'center', color: on ? '#ffe9a8' : rgba(PAL.parch, 0.82) });
    tracked(g, `${rank} / ${WEAPON_MAX_RANK}`, x + w / 2, y + 77 * S, { size: 27 * S, track: 0.10, weight: 700, align: 'center', color: '#ff756b', shadow: '#050209', shadowDy: 2 * S });
    const current = Math.round((this.meta.weaponMultiplier(weapon, track) - 1) * 100);
    const desc = `Permanently adds +5% ${track} damage per rank while ${META_WEAPONS[weapon]} is equipped. Current bonus: +${current}%.`;
    const fontSize = 10.5 * S, lines = wrap(g, desc, w - 28 * S, { size: fontSize, weight: 500, font: bodyFont() });
    g.font = `500 ${fontSize}px ${bodyFont()}`; g.fillStyle = rgba(PAL.parch, 0.78); g.textAlign = 'center';
    for (let i = 0; i < lines.length; i++) g.fillText(lines[i], x + w / 2, y + 116 * S + i * 17 * S);
    const by = y + h - 60 * S, bh = 40 * S, bx = x + 20 * S, bw = w - 40 * S;
    plaqueRect(g, bx, by, bw, bh, 7 * S);
    const affordable = (this.meta.titanBlood || 0) >= cost;
    g.fillStyle = max ? rgba('#21172b', 0.82) : affordable ? rgba('#ff5968', on ? 0.40 : 0.25) : rgba('#32101a', 0.72); g.fill();
    g.strokeStyle = max ? rgba(PAL.bronze, 0.38) : affordable ? rgba('#ff9a6b', 0.9) : rgba('#e8506a', 0.72); g.lineWidth = 1.1 * S; g.stroke();
    const label = max ? 'FORGE COMPLETE' : `SPEND ${cost} TITAN BLOOD`;
    tracked(g, label, x + w / 2, by + 26 * S, { size: 8.7 * S, track: 0.13, weight: 700, align: 'center', color: max ? rgba(PAL.parchDim, 0.58) : affordable ? '#fff0c6' : '#ff8a9a' });
    this.hit.push({ x, y, w, h, track });
    this.hit.push({ x: bx, y: by, w: bw, h: bh, track, act: 'buy' });
  }

  _weaponGlyph(g, cx, cy, r, weapon) {
    const glyph = { blade: '†', spear: '↟', bow: '⌒', shield: '◇' }[weapon] || '◆';
    g.save(); g.translate(cx, cy);
    const grad = g.createRadialGradient(-r * 0.25, -r * 0.35, 0, 0, 0, r);
    grad.addColorStop(0, '#4b2531'); grad.addColorStop(1, '#100911');
    g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.fillStyle = grad; g.fill();
    g.strokeStyle = '#d9a64c'; g.lineWidth = Math.max(1, r * 0.10); g.stroke();
    g.font = `700 ${r * 1.25}px ${bodyFont()}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#ffb08a'; g.fillText(glyph, 0, 1);
    g.restore();
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

  _bloodGlyph(g, cx, cy, r) {
    g.save(); g.translate(cx, cy);
    const grad = g.createRadialGradient(-r * 0.2, -r * 0.35, 0, 0, 0, r);
    grad.addColorStop(0, '#ffd2b5'); grad.addColorStop(0.34, '#ff5968'); grad.addColorStop(1, '#620817');
    g.beginPath(); g.moveTo(0, -r); g.bezierCurveTo(r * 0.9, -r * 0.2, r * 0.8, r * 0.6, 0, r);
    g.bezierCurveTo(-r * 0.8, r * 0.6, -r * 0.9, -r * 0.2, 0, -r); g.closePath(); g.fillStyle = grad; g.fill();
    g.strokeStyle = rgba('#ffd19f', 0.7); g.lineWidth = Math.max(1, r * 0.1); g.stroke();
    g.restore();
  }

  _darknessGlyph(g, cx, cy, r) {
    g.save(); g.translate(cx, cy);
    const grad = g.createRadialGradient(-r * 0.25, -r * 0.35, 0, 0, 0, r);
    grad.addColorStop(0, '#f0dcff'); grad.addColorStop(0.34, '#8c5cff'); grad.addColorStop(1, '#160424');
    g.beginPath(); g.moveTo(0, -r); g.lineTo(r * 0.76, 0); g.lineTo(0, r); g.lineTo(-r * 0.76, 0); g.closePath();
    g.fillStyle = grad; g.fill();
    g.strokeStyle = rgba('#e4d4ff', 0.72); g.lineWidth = Math.max(1, r * 0.09); g.stroke();
    g.beginPath(); g.arc(r * 0.12, -r * 0.05, r * 0.34, 0.55, 5.45); g.strokeStyle = rgba('#fff4ff', 0.52); g.stroke();
    g.restore();
  }
}

export default NectarOverlay;
