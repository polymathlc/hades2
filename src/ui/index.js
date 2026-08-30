// OWNER: AGENT-UI
// ---------------------------------------------------------------------------
// UI — the system. Implements ARCHITECTURE.md §2.9 exactly.
//
// WHY THE UI IS A CANVAS AND NOT DOM
// The capture harness reads `canvas.toDataURL()` — the WebGL drawing buffer.
// A DOM HUD is invisible to every critic and to every shot in the shot list,
// so the interface would be judged as "no UI at all". Drawing the whole
// interface into a 2D canvas gives us one authoring surface that can be
// composited straight into the WebGL frame in capture mode, and blitted for
// free as a stacked DOM canvas in play. It also buys full control of ornament,
// gradients and relief that CSS cannot express.
//
// The system defines render(), which the engine calls AFTER RenderSystem's own
// render() (systems run in add order). In capture mode we additionally wrap
// RenderSystem.render so the driver's explicit render() call carries the UI.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { PAL, LayerCache, rgba, clamp01, ease, tracked, trackedWidth, plaqueRect, goldGradient, palmette } from './ornament.js';
import { HUD } from './hud.js';
import { BoonOverlay } from './boons.js';
import { NectarOverlay } from './nectar.js';
import { Menus } from './menus.js';
import { WorldLabels } from './worldlabels.js';
import { BoonState, BOONS, DUOS, GOD_INFO } from '../game/boons.js';
import { CHARACTER_INFO } from '../game/characters.js';

const REF_W = 1600, REF_H = 900;

export class UI {
  constructor() {
    this.ctx = null;
    this.t = 0;
    this.dirty = true;
    this.scale = 1;
    this.W = 0; this.H = 0;
    this.toasts = [];
    this._rand = 0;
    this.enabled = true;
    this._padPrev = {};
    // Constructed eagerly, not in init(): main.js adds UI after the player, and
    // Player.init() calls ctx.ui.setHealth() during initAll. Every contract
    // setter must be safe from the moment the object exists.
    this.hud = new HUD(this);
    this.boonUI = new BoonOverlay(this);
    this.nectarUI = new NectarOverlay(this);
    this.menus = new Menus(this);
    this.labels = new WorldLabels(this);
    this.boonState = new BoonState(null);
  }

  now() { return this.t; }
  /** Deterministic 0..1 — no Math.random anywhere in the UI. */
  rand() {
    if (this.ctx && this.ctx.rng && this._rng) return this._rng.f();
    this._rand = (this._rand * 1664525 + 1013904223) >>> 0;
    return this._rand / 4294967296;
  }

  async init(ctx) {
    this.ctx = ctx;
    this.menus.settings.quality = ctx.quality?.source === 'auto' ? 'auto' : (ctx.quality?.tier || 'med');
    this._rng = ctx.rng && ctx.rng.fork ? ctx.rng.fork('ui') : ctx.rng;

    // DOM host (kept: main.js's capture.hud() toggles #ui, and it hosts the
    // play-mode canvas so we pay no texture upload outside capture)
    this.root = document.createElement('div');
    this.root.id = 'ui';
    document.body.appendChild(this.root);

    this.canvas = document.createElement('canvas');
    this.canvas.id = 'ui-canvas';
    this.g = this.canvas.getContext('2d', { alpha: true, desynchronized: true });
    this.root.appendChild(this.canvas);   // capture.hud() toggles #ui, so live here too

    // ── modules ──
    if (ctx.boons instanceof BoonState) this.boonState = ctx.boons;
    else { this.boonState.ctx = ctx; ctx.boons = this.boonState; }  // cheap modifier query for combat
    this.cache = new LayerCache();

    this._sizeTo(ctx);

    // ── WebGL compositing path (capture, and a fallback if the DOM canvas is
    //    ever suppressed). One extra draw call, no post-processing on the UI. ──
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.generateMipmaps = false;
    this.overlayScene = new THREE.Scene();
    this.overlayCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.overlayMat = new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
    this.overlayMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.overlayMat);
    this.overlayMesh.frustumCulled = false;
    this.overlayScene.add(this.overlayMesh);

    if (ctx.CAPTURE) {
      const rs = ctx.renderSystem;
      if (rs && typeof rs.render === 'function' && !rs.__uiOverlayWrapped) {
        const orig = rs.render.bind(rs);
        rs.render = (c) => { orig(c); try { this.renderOverlay(c); } catch (e) { } };
        rs.__uiOverlayWrapped = true;
      }
    }

    // ── events ──
    const E = ctx.events;
    E.on('damage.number', (i) => {
      if (!i || !i.pos) return;
      if (i.target === ctx.player) return;                 // no numbers on the hero
      this.labels.damageNumber(i.pos, i.amount, { crit: i.crit, type: i.type });
    });
    E.on('damage.dealt', (i) => {
      if (!i || !i.target || i.target === ctx.player) return;
      const t = i.target;
      if (t.maxHealth) this.labels.enemyHealth(t, t.health, t.maxHealth, t.def && (t.def.title || t.def.name));
      if (t.def && t.def.boss) this.labels.setBoss({ name: t.def.title || t.def.name || 'The Warden', hp: t.health, max: t.maxHealth, phases: t.def.phases || 3, phase: Math.max(1, Math.ceil((t.health / t.maxHealth) * (t.def.phases || 3))) });
    });
    E.on('entity.died', (i) => { if (i && i.entity) { this.labels.removeEnemy(i.entity); if (i.entity.def && i.entity.def.boss) this.labels.setBoss(null); } });
    E.on('boon.granted', (i) => { if (i) this.hud.addBoon(i.record || i); });
    E.on('nectar.changed', (i) => { if (i && i.total != null) this.setResources(null, i.total); });
    E.on('titanBlood.changed', (i) => { if (i && i.total != null) this.setResources(null, null, i.total); });
    E.on('darkness.changed', (i) => { if (i && i.total != null) this.setResources(null, null, null, i.total); });
    E.on('weapon.equipped', (i) => this.hud.setWeapon(i));
    E.on('character.changed', (i) => this.hud.setCharacter(i?.character || i));
    E.on('home.characterSelected', (i) => this.hud.setCharacter(i?.character || i));
    E.on('room.entered', (i) => { if (i && i.room) this.setRoom(i.room.depth, i.room.biome); });
    E.on('biome.changed', (i) => { if (i && i.name) this.setRoom(null, i.name); });
    E.on('player.dashed', () => { this.hud.setDash(Math.max(0, this.hud.dash - 1)); });
    E.on('capture.state', ({ name, args }) => this._captureState(name, args, ctx));

    // ── input (pointer + keys) — only intercepts while a modal is open ──
    this._onMove = (e) => {
      if (!this._modal()) return;
      const r = this.canvas.getBoundingClientRect ? this.canvas.getBoundingClientRect() : { left: 0, top: 0, width: innerWidth, height: innerHeight };
      const x = (e.clientX - r.left) * (this.W / (r.width || innerWidth));
      const y = (e.clientY - r.top) * (this.H / (r.height || innerHeight));
      if (this.nectarUI.active) this.nectarUI.move(x, y);
      else if (this.boonUI.active) { const i = this.boonUI.hitTest(x, y); if (i !== this.boonUI.hover) { this.boonUI.hover = i; this.dirty = true; } }
      else this.menus.move(x, y);
    };
    this._onDown = (e) => {
      if (!this._modal()) return;
      const r = this.canvas.getBoundingClientRect ? this.canvas.getBoundingClientRect() : { left: 0, top: 0, width: innerWidth, height: innerHeight };
      const x = (e.clientX - r.left) * (this.W / (r.width || innerWidth));
      const y = (e.clientY - r.top) * (this.H / (r.height || innerHeight));
      if (this.nectarUI.active) { if (this.nectarUI.click(x, y)) e.preventDefault(); }
      else if (this.boonUI.active) { const i = this.boonUI.hitTest(x, y); if (i >= 0) { this.boonUI.choose(i); e.preventDefault(); } }
      else if (this.menus.click(x, y)) e.preventDefault();
    };
    this._onKey = (e) => {
      if (this.nectarUI.active) { this.nectarUI.key(e); return; }
      if (this.boonUI.active) {
        if (e.key === '1' || e.key === '2' || e.key === '3') this.boonUI.choose(+e.key - 1);
        else if (e.key === 'ArrowLeft') this.boonUI.moveSelection(-1);
        else if (e.key === 'ArrowRight') this.boonUI.moveSelection(1);
        else if (e.key === 'Enter' || e.key === ' ') this.boonUI.choose(this.boonUI.hover < 0 ? 0 : this.boonUI.hover);
        return;
      }
      if (e.key === 'h' || e.key === 'H') {
        if (!this._modal()) this.screen('pause');
        if (this.menus.screen === 'pause') this.menus.activate(this.menus.controlsOpen ? 'back' : 'controls');
        return;
      }
      if (e.key === 'b' || e.key === 'B' || e.key === 'Tab') {
        e.preventDefault();
        if (!this._modal()) this.screen('pause');
        if (this.menus.screen === 'pause') this.menus.activate(this.menus.boonsOpen ? 'back' : 'boons');
        return;
      }
      if (e.key === 'Escape') {
        if (this.menus.settingsOpen || this.menus.controlsOpen || this.menus.boonsOpen) this.menus.activate('back');
        else this.screen(this.menus.screen === 'pause' ? 'game' : 'pause');
        return;
      }
      if (!this._modal()) return;
      if (e.key === 'ArrowDown' || e.key === 's') this.menus.key(1);
      else if (e.key === 'ArrowUp' || e.key === 'w') this.menus.key(-1);
      else if (e.key === 'ArrowRight' || e.key === 'd') { const h = this.menus.hit[this.menus.sel]; if (h && h.act === 'setting') this.menus._bump(h.key, 1); }
      else if (e.key === 'ArrowLeft' || e.key === 'a') { const h = this.menus.hit[this.menus.sel]; if (h && h.act === 'setting') this.menus._bump(h.key, -1); }
      else if (e.key === 'Enter' || e.key === ' ') { const h = this.menus.hit[this.menus.sel]; if (h) { if (h.act === 'setting') this.menus._bump(h.key, 1); else this.menus.activate(h.act); } }
    };
    if (!ctx.CAPTURE) {
      addEventListener('pointermove', this._onMove, { passive: true });
      addEventListener('pointerdown', this._onDown);
      addEventListener('keydown', this._onKey);
    }

    // sensible starting state so the HUD is never empty-looking
    this.hud.setHealth(ctx.player?.health ?? 100, ctx.player?.maxHealth ?? 100);
    this.hud.setCharacter(CHARACTER_INFO?.[ctx.player?.characterId] || { id: 'zagreus', name: 'Zagreus' });
    this.hud.setMana(ctx.player?.mana ?? 100, ctx.player?.maxMana ?? 100);
    this.hud.setRoom(ctx.run?.depth || 1, ctx.run?.biome || 'tartarus');
    this.hud.roomT = -9;
    this.draw();
  }

  _modal() { return this.nectarUI.active || this.boonUI.active || this.menus.modal; }

  _sizeTo(ctx) {
    const r = ctx.renderer;
    let w = 1600, h = 900;
    if (r && r.domElement) { w = r.domElement.width || w; h = r.domElement.height || h; }
    // cap the UI raster so a 4K screen does not pay for a 4K interface
    const cap = 2200;
    if (w > cap) { h = Math.round(h * cap / w); w = cap; }
    if (this.W === w && this.H === h) return;
    this.W = w; this.H = h;
    this.canvas.width = w; this.canvas.height = h;
    this.canvas.style.width = '100%'; this.canvas.style.height = '100%';
    this.scale = Math.min(w / REF_W, h / REF_H);
    // never let the UI shrink below legibility or grow into a billboard
    this.scale = Math.max(0.62, Math.min(1.5, this.scale));
    this.cache.clear(); this.hud.cache.clear(); this.menus.cache.clear();
    if (this.tex) this.tex.needsUpdate = true;
    this.dirty = true;
  }

  resize(w, h, ctx) { this._sizeTo(ctx || this.ctx); }

  // ═══════════════════════════════════════════════════ §2.9 CONTRACT ══════
  setHealth(cur, max) { this.hud.setHealth(cur, max); }
  setMana(cur, max) { this.hud.setMana(cur, max); }
  setCast(n, max) { this.hud.setCast(n, max); }
  setRoom(depth, biome) { this.hud.setRoom(depth, biome); }
  damageNumber(worldPos, amount, o) { this.labels.damageNumber(worldPos, amount, o); }
  showBoonChoice(options, o) { return this.boonUI.open(options, o); }
  showHomeUpgrades(meta, page) { this.nectarUI.open(meta || this.ctx?.meta, page); }
  toast(text, o = {}) {
    this.toasts.push({ text: String(text), color: o.color || PAL.gold, icon: o.icon || null, t0: this.t, dur: o.dur || 2.4 });
    if (this.toasts.length > 4) this.toasts.shift();
    this.dirty = true;
  }
  screen(name) {
    if (name === 'game') { this.menus.set('game'); this.hud.alpha.set(1); }
    else { this.menus.set(name); this.hud.alpha.set(name === 'pause' ? 0.25 : 0); }
    if (this.ctx) {
      this.ctx.paused = name === 'pause';
      if (this.ctx.input) this.ctx.input.enabled = name === 'game';
    }
    this.dirty = true;
  }
  // ── extensions (all optional for other systems) ──
  setDash(n, max) { this.hud.setDash(n, max); }
  setWeapon(w) { this.hud.setWeapon(w); }
  setBoss(o) { this.labels.setBoss(o); }
  clearRunBoons() { this.hud.boons.length = 0; this.hud.boonPop.clear(); this.dirty = true; }
  prompt(pos, text, o) { this.labels.prompt(pos, text, o); }
  clearPrompts() { this.labels.clearPrompts(); }
  sigil(pos, o) { this.labels.sigil(pos, o); }
  clearSigils() { this.labels.clearSigils(); }
  setResources(obols, nectar, titanBlood, darkness) {
    if (obols != null) this.hud.obols = obols;
    if (nectar != null) this.hud.nectar = nectar;
    if (titanBlood != null) this.hud.titanBlood = titanBlood;
    if (darkness != null) this.hud.darkness = darkness;
    this.dirty = true;
  }
  setSummary(o) { Object.assign(this.menus.summary, o || {}); this.dirty = true; }

  // ═══════════════════════════════════════════════════════════ LOOP ═══════
  update(dt, ctx) {
    this.t += dt;
    // scheduled capture events (see setupCaptureHUD) fire relative to the shot
    if (this._sched && this._sched.length) {
      for (let i = this._sched.length - 1; i >= 0; i--) {
        if (this.t >= this._sched[i].at) { try { this._sched[i].fn(); } catch (e) { } this._sched.splice(i, 1); }
      }
    }
    this.hud.update(dt);
    this.labels.update(dt, this.t);
    if (this.toasts.length) {
      for (let i = this.toasts.length - 1; i >= 0; i--) if (this.t - this.toasts[i].t0 > this.toasts[i].dur) this.toasts.splice(i, 1);
      this.dirty = true;
    }
    // live values from the player, cheaply
    const p = ctx.player;
    if (p) {
      if (p.health !== this._lastHp) { this._lastHp = p.health; this.hud.setHealth(p.health, p.maxHealth); }
      if (p.mana !== this._lastMp) { this._lastMp = p.mana; this.hud.setMana(p.mana, p.maxMana); }
      if (p.dash) {
        const d = p.dash.ready ? this.hud.dashMax : Math.max(0, this.hud.dashMax - 1);
        if (d !== this.hud.dash) this.hud.setDash(d);
      }
    }
    if (this.nectarUI.active || this.boonUI.active || this.menus.modal) this.dirty = true;
  }

  lateUpdate(alpha, ctx) {
    if (ctx.paused) this.t += ctx.time?.unscaledDt || 0;
    this._pollGamepad(ctx);
    if (this._modal() || this.labels.nums.length) this.dirty = true;
    this.draw();
  }

  _pollGamepad(ctx) {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return;
    const pad = Array.from(navigator.getGamepads()).find(Boolean);
    if (!pad) { this._padPrev = {}; return; }
    const down = i => !!pad.buttons?.[i]?.pressed;
    const edge = (key, value) => { const was = !!this._padPrev[key]; this._padPrev[key] = !!value; return value && !was; };
    const pause = edge('pause', down(9));
    const up = down(12) || (pad.axes?.[1] ?? 0) < -0.72;
    const dn = down(13) || (pad.axes?.[1] ?? 0) > 0.72;
    const lf = down(14) || (pad.axes?.[0] ?? 0) < -0.72;
    const rt = down(15) || (pad.axes?.[0] ?? 0) > 0.72;
    // Sample A every frame, including ordinary gameplay, so the edge latch
    // cannot go stale while the player is dashing toward a reward gate.
    const acceptDown = down(0);
    const accept = edge('accept', acceptDown);
    if (this.boonUI.active) {
      if (edge('left', lf)) this.boonUI.gamepad('left');
      else if (edge('right', rt)) this.boonUI.gamepad('right');
      else this.boonUI.pollGamepadAccept(acceptDown, accept);
      return; // the offer is a required decision; Start must not open behind it
    }
    if (this.nectarUI.active) {
      if (pause || edge('back', down(1))) this.nectarUI.gamepad('back');
      else if (edge('up', up)) this.nectarUI.gamepad('up');
      else if (edge('down', dn)) this.nectarUI.gamepad('down');
      else if (edge('left', lf)) this.nectarUI.gamepad('left');
      else if (edge('right', rt)) this.nectarUI.gamepad('right');
      else if (accept) this.nectarUI.gamepad('accept');
      return;
    }
    if (pause) {
      if (this.menus.settingsOpen || this.menus.controlsOpen || this.menus.boonsOpen) this.menus.activate('back');
      else this.screen(this.menus.screen === 'pause' ? 'game' : 'pause');
    }
    if (!this.menus.modal || this.boonUI.active) return;
    if (edge('up', up)) this.menus.key(-1);
    if (edge('down', dn)) this.menus.key(1);
    if (edge('left', lf)) { const h = this.menus.hit[this.menus.sel]; if (h?.act === 'setting') this.menus._bump(h.key, -1); }
    if (edge('right', rt)) { const h = this.menus.hit[this.menus.sel]; if (h?.act === 'setting') this.menus._bump(h.key, 1); }
    if (accept) { const h = this.menus.hit[this.menus.sel]; if (h) h.act === 'setting' ? this.menus._bump(h.key, 1) : this.menus.activate(h.act); }
    if (edge('back', down(1))) {
      if (this.menus.settingsOpen || this.menus.controlsOpen || this.menus.boonsOpen) this.menus.activate('back');
      else if (this.menus.screen === 'pause') this.screen('game');
    }
  }

  /** Engine calls this after RenderSystem.render(); play-mode DOM path is free. */
  render(ctx) {
    if (ctx.CAPTURE) return;             // capture goes through the wrapper
    // Nothing to do: the 2D canvas is stacked over the WebGL canvas in the DOM.
  }

  renderOverlay(ctx) {
    // The analyzer measures the floor by reconstructing world position from the depth pass, then
    // reading luma from the colour frame. This overlay is composited into that same colour frame,
    // so HUD pixels sitting over floor pixels were being counted as blazing floor — an agent
    // rendered the mask and found the metric was largely measuring the HUD. `suppressForMetrics`
    // lets the capture harness take a clean colour frame for measurement only.
    if (this.suppressForMetrics) return;
    if (!this.enabled) return;
    if (this.root && this.root.style.display === 'none') return;   // capture.hud(false)
    const r = ctx.renderer; if (!r) return;
    if (this._texDirty !== false) { this.tex.needsUpdate = true; this._texDirty = false; }
    this.tex.needsUpdate = true;
    const prevTarget = r.getRenderTarget();
    if (prevTarget !== null) r.setRenderTarget(null);
    const prevAuto = r.autoClear;
    r.autoClear = false;
    r.render(this.overlayScene, this.overlayCam);
    r.autoClear = prevAuto;
  }

  // ═══════════════════════════════════════════════════════════ DRAW ═══════
  draw() {
    if (!this.g) return;
    const g = this.g, W = this.W, H = this.H, S = this.scale, t = this.t;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    g.textBaseline = 'alphabetic';
    g.lineJoin = 'round';

    const inGame = this.menus.screen === 'game' || this.menus.screen === 'pause';
    if (inGame) {
      // world labels dim with the HUD so a modal is not fighting damage
      // numbers and enemy bars for the eye
      const la = this.hud.alpha.v;
      if (la > 0.01) {
        g.save(); g.globalAlpha = la;
        this.labels.draw(g, W, H, S, t, this.ctx && this.ctx.camera);
        g.restore();
      }
      this.hud.draw(g, W, H, S, t);
      if (la > 0.4) this._toasts(g, W, H, S, t);
    }
    this.menus.draw(g, W, H, S, t);
    this.boonUI.draw(g, W, H, S, t);
    this.nectarUI.draw(g, W, H, S, t);
    this.dirty = false;
  }

  _toasts(g, W, H, S, t) {
    for (let i = 0; i < this.toasts.length; i++) {
      const to = this.toasts[i];
      const age = t - to.t0;
      const a = age < 0.25 ? ease.out(age / 0.25) : age > to.dur - 0.5 ? 1 - ease.out((age - (to.dur - 0.5)) / 0.5) : 1;
      const y = H * 0.30 + i * 34 * S - ease.out(clamp01(age / 0.4)) * 8 * S;
      const size = 13 * S;
      const tw = trackedWidth(g, to.text.toUpperCase(), { size, track: 0.24, weight: 600 });
      const w = tw + 46 * S, h = 30 * S, x = W / 2 - w / 2;
      g.save(); g.globalAlpha = a;
      plaqueRect(g, x, y - h / 2, w, h, 5 * S);
      g.fillStyle = 'rgba(10,6,18,0.82)'; g.fill();
      g.strokeStyle = goldGradient(g, x, y - h / 2, x + w, y + h / 2, (t * 0.3) % 1); g.lineWidth = 1.3 * S; g.stroke();
      palmette(g, x + 14 * S, y, 8 * S, { rot: Math.PI / 2, lobes: 5 });
      palmette(g, x + w - 14 * S, y, 8 * S, { rot: -Math.PI / 2, lobes: 5 });
      tracked(g, to.text.toUpperCase(), W / 2, y + size * 0.36, {
        size, track: 0.24, weight: 600, align: 'center', color: to.color, shadow: '#06030c', shadowDy: 1.6 * S,
      });
      g.restore();
    }
  }

  // ═══════════════════════════════════════ ARCHITECTURE §5 CAPTURE ════════
  _captureState(name, args, ctx) {
    if (name === 'ui') this.setupCaptureHUD(ctx);
    else if (name === 'boons') this.setupCaptureBoons(ctx, args?.god || 'zeus');
    else if (name === 'forge') this.setupCaptureBoons(ctx, 'hephaestus');
    else if (name === 'loadout') this.setupCaptureLoadout(ctx);
    else if (name === 'combat') {
      // the combat frame should carry the HUD too — it is what the player sees
      this.setupCaptureHUD(ctx, { quiet: true, character: args?.character, weapon: args?.weapon });
    }
  }

  /**
   * §5 `ui`: a full HUD populated with plausible mid-run values. Everything is
   * scheduled RELATIVE TO THE SHOT: the shot list steps 2.0s after setting the
   * state, so a damage number born "now" would be long dead by the time the
   * frame is read. We plant events in the near future so the frame catches
   * them mid-flight.
   */
  setupCaptureHUD(ctx, o = {}) {
    const at = this.t + 2.0;                       // when the shot is taken
    const h = this.hud;
    h.health.max = 120; h.mana.max = 100;
    h.setHealth(120, 120); h.hpFill.snap(1); h.hpGhost = 1;
    h.setMana(64, 100); h.mpFill.snap(0.64);
    h.setCast(2, 3); h.setDash(1, 2);
    const character = CHARACTER_INFO[o.character || ctx.player?.characterId] || CHARACTER_INFO.zagreus;
    const runtimeWeapon = ctx.combat?.runtimes?.get?.(ctx.player)?.weapon;
    h.setCharacter(character);
    h.setWeapon(runtimeWeapon || { id: o.weapon || character.defaultWeapon, name: String(o.weapon || character.defaultWeapon) });
    h.weaponCd = 0.34;
    h.obols = 137; h.nectar = 4; h.titanBlood = 2;
    h.depth = 7; h.biome = (ctx.run && ctx.run.biome) || 'tartarus';
    h.roomT = -99;                                  // the plaque already says it; no banner
    h.boons.length = 0; h.boonPop.clear();
    const tray = character.id === 'melinoe' ? [
      ['apollo', 'epic', 'attack'], ['hera', 'rare', 'special'],
      ['hestia', 'heroic', 'cast'], ['demeter', 'common', 'dash'],
      ['zeus', 'rare', 'gain'], ['hephaestus', 'common', 'passive'],
    ] : [
      ['zeus', 'epic', 'attack'], ['aphrodite', 'rare', 'special'],
      ['athena', 'heroic', 'cast'], ['hermes', 'common', 'dash'],
      ['artemis', 'rare', 'passive'], ['poseidon', 'common', 'call'],
    ];
    for (const [god, rarity, slot] of tray) h.addBoon({
      id: `${god}.capture.${slot}`, god, rarity, slot,
      name: `${GOD_INFO[god]?.name || god} ${slot}`,
    });
    h.boonPop.clear();

    // the life bar caught mid damage-lag: drop life just before the shot
    this._sched = this._sched || [];
    this._sched.push({ at: at - 0.62, fn: () => { h.setHealth(78, 120); } });
    // `quiet` = the HUD only. The combat and boon shots belong to other
    // systems' scenarios; planting a fake boss bar and fake damage numbers in
    // them would fight the real thing AGENT-ENEMY sets up.
    if (o.quiet) { this.dirty = true; return; }

    // a boss mid-fight and a couple of numbers in flight
    this.labels.clear();
    this.labels.setBoss({ name: 'The Bone Hydra', frac: 1, phases: 3, phase: 2 });
    this.labels.boss.t0 = at - 1.4;
    this._sched.push({ at: at - 0.9, fn: () => this.labels.setBoss({ frac: 0.58, phase: 2, phases: 3 }) });

    const px = (ctx.player && ctx.player.position) ? ctx.player.position : { x: 0, y: 0, z: 0 };
    this._sched.push({ at: at - 0.46, fn: () => this.labels.damageNumber({ x: px.x + 1.9, y: 0.4, z: px.z - 2.1 }, 118, { crit: true, type: 'physical' }) });
    this._sched.push({ at: at - 0.28, fn: () => this.labels.damageNumber({ x: px.x - 2.4, y: 0.3, z: px.z - 1.2 }, 41, { type: 'lightning' }) });
    this._sched.push({ at: at - 0.12, fn: () => this.labels.damageNumber({ x: px.x + 3.2, y: 0.5, z: px.z + 0.6 }, 27, { type: 'frost' }) });

    this._sched.push({ at: at - 0.75, fn: () => this.toast('Chamber Cleared', { color: '#ffe9a8' }) });
    this.dirty = true;
  }

  /** §5 `boons`: the choice open with three real cards, settled and readable. */
  setupCaptureBoons(ctx, god = 'zeus') {
    this.setupCaptureHUD(ctx, { quiet: true });
    const bs = this.boonState;
    // Seed one occupied action slot so the reference shot exercises the most
    // information-dense live case: a god replacing an existing action boon.
    if (god === 'zeus' && !bs.granted.length) {
      const currentAttack = BOONS.find(x => x.id === 'poseidon.attack');
      if (currentAttack) bs.grant(bs.offer(currentAttack, 'rare'));
    }
    // Hand-picked from one deity to mirror the live post-gate audience. Three
    // slots and three rarities keep the upgrade language readable while the
    // repeated portrait makes it unmistakable that Zeus owns this offer.
    const want = god === 'hephaestus'
      ? [['hephaestus.blade.wave', 'epic'], ['hephaestus.blade.echo', 'rare'], ['hephaestus.blade.ember', 'heroic']]
      : god === 'zeus'
        ? [['zeus.attack', 'epic'], ['zeus.special', 'rare'], ['zeus.cast', 'heroic']]
        : BOONS.filter(b => b.god === god && ['attack', 'special', 'cast', 'dash', 'call'].includes(b.slot))
          .slice(0, 3).map((b, i) => [b.id, ['epic', 'rare', 'heroic'][i]]);
    const opts = [];
    for (const [id, rarity] of want) {
      const b = BOONS.find(x => x.id === id);
      if (b) opts.push(bs.offer(b, rarity));
    }
    const rng = (ctx.rng && ctx.rng.fork) ? ctx.rng.fork('boonshot') : ctx.rng;
    const list = opts.length === 3 ? opts : bs.roll(rng, { count: 3, god, allowDuo: false });
    this.boonUI.open(list);
    this.boonUI.t0 = this.t - 1.35;                 // settled by the time we shoot
    this.boonUI.hover = 1;
    this.dirty = true;
  }

  /** `loadout`: the pause Codex populated with a varied late-run build. */
  setupCaptureLoadout(ctx) {
    const bs = this.boonState;
    bs.clear();
    const seed = [
      ['zeus.attack', 'epic'], ['aphrodite.special', 'rare'], ['demeter.canon.cast', 'epic'],
      ['apollo.canon.dash', 'rare'], ['selene.call', 'heroic'], ['hera.canon.extended-family', 'rare'],
      ['hestia.canon.controlled-burn', 'epic'], ['chaos.canon.favor', 'rare'], ['hades.canon.life-tax', 'common'],
      ['duo.canon.cold-fusion', 'heroic'],
    ];
    for (const [id, rarity] of seed) {
      const boon = [...BOONS, ...DUOS].find(x => x.id === id);
      if (boon) bs.grant(bs.offer(boon, rarity));
    }
    this.screen('pause');
    this.menus.activate('boons');
    this.menus.t0 = this.t - 1;
    this.menus.boonSel = 2;
    this.dirty = true;
  }

  dispose() {
    removeEventListener('pointermove', this._onMove);
    removeEventListener('pointerdown', this._onDown);
    removeEventListener('keydown', this._onKey);
    this.overlayMat?.dispose(); this.tex?.dispose();
  }
}
