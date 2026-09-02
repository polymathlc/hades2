// OWNER: AGENT-UI
// ---------------------------------------------------------------------------
// THE PACT — the run-modifier screen.
//
// run.js keeps the truth (`run.modifiers`, `run.heat`, `run.setModifier`) and
// meta.js owns the table (`RUN_MODIFIERS`). This screen only reads that table,
// shows every entry with its cost, and asks run.js to seal or release one. It
// is reachable from the pause menu while the hero stands at the Crossroads —
// the only place run.js accepts a toggle — so the pause menu hides the item
// elsewhere, and a toggle that is refused says why instead of doing nothing.
//
// The model at the top is pure so scripts/test-ui-hud.mjs can pin it.
// ---------------------------------------------------------------------------

import { RUN_MODIFIERS, heatOf } from '../game/meta.js';
import {
  PAL, plaqueRect, goldGradient, tracked, trackedWidth, wrap, rgba, lift, bodyFont, palmette, beadRule, keyCap, clamp01,
} from './ornament.js';
import { fitText } from './hud-boons.js';

export const HEAT_COLOR = '#ff756b';

/** Every modifier, in table order, with whether it is sealed. */
export function pactRows(active, table = RUN_MODIFIERS) {
  const on = active instanceof Set ? active : new Set(active || []);
  return table.map(m => ({ id: m.id, name: m.name, text: m.text, heat: m.heat | 0, on: on.has(m.id) }));
}

/** Totals for the read-out: heat, the Darkness it pays per clear, how many are sealed. */
export function pactTotals(active, table = RUN_MODIFIERS) {
  const on = active instanceof Set ? active : new Set(active || []);
  const ids = [...on].filter(id => table.some(m => m.id === id));
  const heat = heatOf(ids);
  return { heat, darknessPerClear: heat, sealed: ids.length, max: table.reduce((a, m) => a + (m.heat | 0), 0) };
}

/** Focus order: the rows, then the Back item; wraps in both directions. */
export function pactFocus(sel, dir, rowCount) {
  const n = Math.max(1, (rowCount | 0) + 1);
  return ((sel | 0) + dir + n * 4) % n;
}

export class PactScreen {
  constructor(ui) {
    this.ui = ui;
    this.sel = 0;
    this.preview = null;          // a Set under capture, so the reference frame never touches meta
    this.note = ''; this.noteT = -9;
    this.flip = new Map();        // id -> time of last toggle, for the seal animation
  }

  /** The sealed set: the preview under capture, else run.js's truth. */
  active() {
    if (this.preview) return this.preview;
    const m = this.ui.ctx?.run?.modifiers;
    return m instanceof Set ? m : new Set(m || []);
  }
  rows() { return pactRows(this.active()); }
  get atCrossroads() { return !!this.preview || this.ui.ctx?.run?.state === 'home'; }

  open() { this.sel = 0; this.note = ''; this.ui.dirty = true; }
  key(dir) { this.sel = pactFocus(this.sel, dir, this.rows().length); this.ui.dirty = true; }
  /** Enter / A / click on the focused item. Returns true when it was the Back item. */
  confirm() {
    const rows = this.rows();
    if (this.sel >= rows.length) return true;
    this.toggle(rows[this.sel].id);
    return false;
  }
  toggle(id) {
    const on = !this.active().has(id);
    if (this.preview) { if (on) this.preview.add(id); else this.preview.delete(id); }
    else {
      const run = this.ui.ctx?.run;
      const ok = run && typeof run.setModifier === 'function' ? run.setModifier(id, on) : false;
      if (!ok) { this._note(this.atCrossroads ? 'THAT PACT CANNOT BE CHANGED NOW' : 'THE PACT IS SEALED AT THE CROSSROADS ONLY'); return false; }
    }
    this.flip.set(id, this.ui.now());
    this.ui.ctx?.audio?.sfx?.('ui.select', { gain: 0.6 });
    this.ui.dirty = true;
    return true;
  }
  _note(text) { this.note = text; this.noteT = this.ui.now(); this.ui.dirty = true; }

  // ── draw ─────────────────────────────────────────────────────────────────
  /** Draws inside the panel rect the menu hands us; pushes hits onto menus.hit. */
  draw(g, W, H, S, t, x, y, w, h) {
    const rows = this.rows();
    const totals = pactTotals(this.active());
    const hit = this.ui.menus.hit;
    const pad = this.ui.padGlyphs ? this.ui.padGlyphs() : false;
    this.sel = Math.max(0, Math.min(rows.length, this.sel));

    // ── the heat read-out: an ember tablet at the top ──
    const rw = w, rh = 44 * S, rx = x, ry = y;
    plaqueRect(g, rx, ry, rw, rh, 6 * S);
    const rg = g.createLinearGradient(rx, ry, rx + rw, ry);
    rg.addColorStop(0, rgba('#2a0a10', 0.9)); rg.addColorStop(0.5, rgba('#160812', 0.9)); rg.addColorStop(1, rgba('#2a0a10', 0.9));
    g.fillStyle = rg; g.fill();
    g.strokeStyle = rgba(HEAT_COLOR, 0.7); g.lineWidth = 1.1 * S; g.stroke();
    this._flame(g, rx + 26 * S, ry + rh / 2, 9 * S, t, totals.heat > 0 ? 1 : 0.35);
    tracked(g, `HEAT ${totals.heat}`, rx + 44 * S, ry + rh * 0.63, { size: 17 * S, track: 0.18, weight: 700, align: 'left', color: totals.heat > 0 ? '#ffb8a8' : rgba(PAL.parchDim, 0.8), shadow: '#07040d', shadowDy: 1.5 * S });
    const line = totals.heat > 0
      ? `${totals.sealed} PACT${totals.sealed === 1 ? '' : 'S'} SEALED · +${totals.darknessPerClear} DARKNESS ON EVERY CLEAR`
      : 'NO PACTS SEALED · THE DESCENT AS THE FATES WROTE IT';
    const lf = fitText((s, sz) => trackedWidth(g, s, { size: sz, track: 0.22, weight: 600 }), line, rw - 200 * S, { size: 9 * S, minSize: 7.6 * S });
    tracked(g, lf.text, rx + rw - 16 * S, ry + rh * 0.63, { size: lf.size, track: 0.22, weight: 600, align: 'right', color: rgba(PAL.parch, 0.85) });
    // the heat scale under the tablet: one ember per point, lit up to the total
    const maxHeat = totals.max, eg = Math.min(18 * S, (rw - 40 * S) / Math.max(1, maxHeat));
    const ex0 = rx + rw / 2 - (maxHeat - 1) * eg / 2, ey = ry + rh + 12 * S;
    for (let i = 0; i < maxHeat; i++) {
      const on = i < totals.heat;
      g.beginPath(); g.arc(ex0 + i * eg, ey, 3.2 * S, 0, 6.2832);
      g.fillStyle = on ? HEAT_COLOR : 'rgba(40,20,26,0.9)'; g.fill();
      g.strokeStyle = rgba(on ? '#ffb8a8' : PAL.bronze, 0.8); g.lineWidth = Math.max(0.7, 0.8 * S); g.stroke();
    }

    // ── the rows ──
    const listY = ry + rh + 26 * S;
    const rowH = Math.min(58 * S, (h - (listY - y) - 70 * S) / Math.max(1, rows.length));
    // right-to-left reservation: toggle · status word · cost — each measured
    const toggleW = 46 * S, toggleH = 20 * S;
    const statusW = Math.max(trackedWidth(g, 'SEALED', { size: 8 * S, track: 0.2, weight: 700 }), trackedWidth(g, 'OPEN', { size: 8 * S, track: 0.2, weight: 700 }));
    const costW = trackedWidth(g, '+2 HEAT', { size: 9.5 * S, track: 0.2, weight: 700 }) + 8 * S;
    const tx = x + w - toggleW - 14 * S;                 // toggle left edge
    const statusX = tx - 8 * S;                          // status word, right-aligned
    const costX = statusX - statusW - 14 * S - costW / 2; // cost, centred
    const textW = costX - costW / 2 - 14 * S - (x + 38 * S);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i], yy = listY + i * rowH, on = this.sel === i;
      const flipT = this.flip.has(r.id) ? clamp01((t - this.flip.get(r.id)) / 0.35) : 1;
      plaqueRect(g, x, yy, w, rowH - 6 * S, 5 * S);
      g.fillStyle = r.on ? rgba('#2a0a10', on ? 0.92 : 0.72) : rgba('#090611', on ? 0.9 : 0.62); g.fill();
      g.strokeStyle = on ? rgba(PAL.goldHi, 0.95) : r.on ? rgba(HEAT_COLOR, 0.55) : rgba(PAL.bronze, 0.4); g.lineWidth = (on ? 1.6 : 0.9) * S; g.stroke();
      if (on) {
        // the focus ring: a second, inset stroke and the palmette pointers
        plaqueRect(g, x + 3 * S, yy + 3 * S, w - 6 * S, rowH - 12 * S, 4 * S);
        g.strokeStyle = rgba(PAL.gold, 0.35); g.lineWidth = 1 * S; g.stroke();
        palmette(g, x - 12 * S, yy + (rowH - 6 * S) / 2, 8 * S, { rot: Math.PI / 2, lobes: 5 });
      }
      hit.push({ x, y: yy, w, h: rowH - 6 * S, act: 'pact-row', pactIndex: i, pactId: r.id });
      // the ember mark, lit when sealed
      this._flame(g, x + 20 * S, yy + (rowH - 6 * S) / 2, 7 * S, t, r.on ? 1 : 0.28);
      // name and text, fitted to the space left of the cost and the toggle
      const nf = fitText((s, sz) => trackedWidth(g, s, { size: sz, track: 0.14, weight: 700 }), r.name.toUpperCase(), textW, { size: 12 * S, minSize: 10 * S });
      tracked(g, nf.text, x + 38 * S, yy + 20 * S, { size: nf.size, track: 0.14, weight: 700, align: 'left', color: on ? '#ffe9a8' : r.on ? '#ffd2c6' : rgba(PAL.parch, 0.85), shadow: '#05030b', shadowDy: 1 * S });
      const lines = wrap(g, r.text, textW, { size: 10 * S, weight: 500, font: bodyFont() });
      g.font = `500 ${10 * S}px ${bodyFont()}`; g.fillStyle = rgba(PAL.parch, on ? 0.9 : 0.68); g.textAlign = 'left';
      for (let k = 0; k < Math.min(2, lines.length); k++) g.fillText(lines[k], x + 38 * S, yy + 34 * S + k * 12 * S);
      // the cost
      tracked(g, `+${r.heat} HEAT`, costX, yy + (rowH - 6 * S) / 2 + 4 * S, { size: 9.5 * S, track: 0.2, weight: 700, align: 'center', color: r.on ? '#ffb8a8' : rgba(HEAT_COLOR, 0.75), shadow: '#05030b', shadowDy: 1 });
      // the toggle
      const ty = yy + (rowH - 6 * S) / 2 - toggleH / 2;
      plaqueRect(g, tx, ty, toggleW, toggleH, 5 * S);
      g.fillStyle = r.on ? rgba(HEAT_COLOR, 0.45) : 'rgba(20,12,30,0.9)'; g.fill();
      g.strokeStyle = on ? rgba(PAL.goldHi, 0.9) : rgba(PAL.bronze, 0.9); g.lineWidth = 1 * S; g.stroke();
      const kx = tx + (r.on ? toggleW - toggleH + 1 * S : 1 * S) * flipT + (r.on ? 0 : (toggleW - toggleH) * (1 - flipT));
      plaqueRect(g, kx, ty + 1 * S, toggleH - 2 * S, toggleH - 2 * S, 4 * S);
      g.fillStyle = r.on ? '#ffe9a8' : '#5a4a66'; g.fill();
      tracked(g, r.on ? 'SEALED' : 'OPEN', statusX, yy + (rowH - 6 * S) / 2 + 3.5 * S, { size: 8 * S, track: 0.2, weight: 700, align: 'right', color: r.on ? '#ffb8a8' : rgba(PAL.parchDim, 0.7) });
    }

    // ── the note (a refused toggle says why) and the navigation hint ──
    const noteAge = t - this.noteT;
    const bottom = listY + rows.length * rowH;
    const note = noteAge < 3.2 && this.note ? this.note
      : this.atCrossroads ? 'SEAL A PACT FOR A HARDER DESCENT · EACH POINT OF HEAT PAYS ONE DARKNESS PER CHAMBER CLEARED'
        : 'PACTS CAN ONLY BE CHANGED AT THE CROSSROADS · RETURN HOME TO SEAL OR RELEASE ONE';
    const nf2 = fitText((s, sz) => trackedWidth(g, s, { size: sz, track: 0.2, weight: 600 }), note, w, { size: 8.6 * S, minSize: 7.4 * S });
    tracked(g, nf2.text, x + w / 2, bottom + 10 * S, { size: nf2.size, track: 0.2, weight: 600, align: 'center', color: noteAge < 3.2 && this.note ? '#ffb8a8' : rgba(PAL.goldHi, 0.72) });
    // the Back item, in the menu's own idiom, then the device hints
    const by = bottom + 40 * S, onBack = this.sel >= rows.length;
    const bw = trackedWidth(g, 'BACK', { size: (onBack ? 22 : 20) * S, track: 0.28, weight: 600 });
    hit.push({ x: W / 2 - bw / 2 - 26 * S, y: by - 20 * S, w: bw + 52 * S, h: 32 * S, act: 'back', i: rows.length });
    if (onBack) {
      palmette(g, W / 2 - bw / 2 - 22 * S, by - 5 * S, 9 * S, { rot: Math.PI / 2, lobes: 5 });
      palmette(g, W / 2 + bw / 2 + 22 * S, by - 5 * S, 9 * S, { rot: -Math.PI / 2, lobes: 5 });
    }
    tracked(g, 'BACK', W / 2, by, { size: (onBack ? 22 : 20) * S, track: 0.28, weight: 600, align: 'center', gold: onBack, sweep: onBack ? (t * 0.35) % 1 : undefined, color: onBack ? undefined : rgba(PAL.parch, 0.62), shadow: '#05030b', shadowDy: 2 * S });
    const hints = pad ? [['▲▼', 'MOVE'], ['A', 'SEAL / RELEASE'], ['B', 'BACK']] : [['↑↓', 'MOVE'], ['ENTER', 'SEAL / RELEASE'], ['ESC', 'BACK']];
    let tw = 0; const ws = hints.map(([k, l]) => { const kw = Math.max(18 * S, 6.5 * S * k.length + 10 * S); const lw = trackedWidth(g, l, { size: 8 * S, track: 0.22, weight: 600 }); tw += kw + 6 * S + lw + 22 * S; return { k, l, kw, lw }; });
    let hx = W / 2 - tw / 2 + 11 * S; const hy = by + 30 * S;
    g.save(); g.globalAlpha *= 0.7;
    for (const p of ws) {
      keyCap(g, hx, hy - 11 * S, p.kw, 14 * S, p.k, { pad: pad && p.k.length <= 2, size: 7.4 * S, edgeAlpha: 0.55 });
      tracked(g, p.l, hx + p.kw + 6 * S, hy, { size: 8 * S, track: 0.22, weight: 600, align: 'left', color: rgba(PAL.parchDim, 0.9) });
      hx += p.kw + 6 * S + p.lw + 22 * S;
    }
    g.restore();
  }

  _flame(g, fx, fy, fs, t, lit) {
    const flick = lit > 0.5 ? 0.85 + 0.15 * Math.sin(t * 7.3 + fx * 0.05) : 0.9;
    g.save(); g.globalAlpha *= 0.35 + 0.65 * lit;
    g.beginPath(); g.moveTo(fx, fy - fs * flick); g.quadraticCurveTo(fx + fs * 0.9, fy - fs * 0.2, fx + fs * 0.45, fy + fs * 0.7);
    g.quadraticCurveTo(fx, fy + fs * 1.05, fx - fs * 0.45, fy + fs * 0.7); g.quadraticCurveTo(fx - fs * 0.9, fy - fs * 0.2, fx, fy - fs * flick); g.closePath();
    const fg = g.createLinearGradient(fx, fy - fs, fx, fy + fs);
    if (lit > 0.5) { fg.addColorStop(0, '#ffe9a8'); fg.addColorStop(0.5, HEAT_COLOR); fg.addColorStop(1, '#8a1a1c'); }
    else { fg.addColorStop(0, '#6a5a58'); fg.addColorStop(1, '#2a1a1c'); }
    g.fillStyle = fg; g.fill();
    g.strokeStyle = rgba(lit > 0.5 ? '#ffb8a8' : PAL.bronze, 0.6); g.lineWidth = Math.max(0.7, fs * 0.1); g.stroke();
    g.restore();
  }
}
