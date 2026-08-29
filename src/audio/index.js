// OWNER: AGENT-AUDIO
// ---------------------------------------------------------------------------
// src/audio/index.js — the Audio system. Implements ARCHITECTURE.md §2.10:
//
//   audio.sfx(name, {pos, pitch, gain, variation})
//   audio.music.setBiome(name) / audio.music.setIntensity(0..1)
//   audio.duck(amount, ms)
//
// Everything is synthesised (see synth.js / sfx.js / music.js / reverb.js).
// There is not one audio file in this project.
//
// TWO HARD CONTRACTS, both load-bearing for the whole project's QA:
//
//  1. Under `ctx.CAPTURE` this system is a NO-OP. init() returns before it
//     subscribes to anything, before it touches localStorage, and before it
//     even looks for an AudioContext. No listeners, no nodes, no allocation,
//     no clock reads — the headless shot harness must see nothing at all.
//  2. With no AudioContext (headless Chrome without audio, an old browser, a
//     locked-down iframe) nothing throws. Every public method is guarded by
//     `_live`, and unlock() is wrapped, so a failure to create audio silently
//     leaves a silent game rather than a broken one.
//
// The system is also EVENT-DRIVEN: it subscribes to the canonical bus events
// (§2.5) plus the richer set combat/enemies/run emit, so most of the game makes
// sound without anyone calling into audio at all.
// ---------------------------------------------------------------------------

import { Music } from './music.js';
import { RECIPES, resolve as resolveSfx, SFX_NAMES } from './sfx.js';
import { ReverbBus, DelayBus, BIOME_SPACE } from './reverb.js';
import { mulberry32, hashName, clamp, lerp, gain as mkGain, filter as mkFilter, panner as mkPanner, shaperCurve, noise } from './synth.js';

// ── mix constants, tuned for the isometric camera ──────────────────────────
// The listener is the PLAYER, not the camera: in a 3/4 iso game the camera sits
// 18-20 units behind and above, so camera-relative distance would make every
// sound in the arena "far". Panning, however, is CAMERA-relative — left on
// screen must be left in the mix.
const REF_DIST = 6.5;        // world units at which a sound is at full level
const MAX_DIST = 42;         // beyond this it is inaudible and never scheduled
const PAN_WIDTH = 11;        // world units of lateral offset for full pan
const PAN_MAX = 0.82;        // never hard-pan; it breaks the illusion on headphones
const ROLLOFF = 1.35;
const FAR_LP_START = 11;     // air absorption kicks in past this distance
const VOICE_CAP = 26;        // concurrent one-shot chains

const DEFAULT_VOL = { master: 0.85, music: 0.78, sfx: 0.92, ui: 0.70 };
const STORE_KEY = 'erebus.audio.v1';

// Minimum gap between two plays of the same name. Repetition is what makes a
// synthesised set sound cheap; spacing plus per-call variation is what stops it.
const GAP = {
  _default: 0.030,
  hit: 0.028, crit: 0.05, 'impact.flesh': 0.03, telegraph: 0.11, stagger: 0.09,
  enemyDeath: 0.05, hurt: 0.14, dash: 0.08, 'ui.hover': 0.05, brazier: 0.0,
  heartbeat: 0.5, 'status.fire': 0.30, 'status.poison': 0.30, 'status.frost': 0.30,
  'status.lightning': 0.22, 'status.arcane': 0.30, cloth: 0.06, footstep: 0.05,
};
// Priority decides who survives when the voice budget is full.
const PRIO = {
  _default: 1,
  hurt: 4, 'player.death': 5, 'boss.roar': 5, 'boss.phase': 5, 'boss.telegraph': 4,
  'room.cleared': 4, 'door.unseal': 4, telegraph: 3, crit: 3, heartbeat: 3,
  'ui.select': 3, 'ui.boon': 3, 'boon.common': 3, 'boon.rare': 3, 'boon.epic': 3, 'boon.heroic': 3,
  brazier: 0, cloth: 0, footstep: 0, shaker: 0,
};

// Per-recipe output trim, set from an OfflineAudioContext loudness pass, not by
// ear-guessing. The raw recipes ranged from -3.8 dBFS (shield.bash1) to -37
// dBFS (footstep) at gain 1 — a 33 dB spread, with the single most-played sound
// in the game (the sword swing, -16.7) near the bottom. These bring every
// one-shot into roughly a -8..-13 dBFS window so `gain` in a call site means
// the same thing everywhere.
const TRIM = {
  'blade.swing1': 2.3, 'blade.swing2': 2.1, 'blade.lunge': 1.6, 'blade.dashcut': 2.1, 'blade.sweep': 1.25,
  'spear.poke1': 2.1, 'spear.poke2': 2.1, 'spear.spin': 1.5, 'spear.throw': 1.5, 'spear.recall': 1.5,
  'bow.loose': 1.4, 'bow.kick': 1.2,
  'shield.bash1': 0.6, 'shield.bash2': 0.6, 'shield.block': 0.85, 'shield.rush': 0.85,
  hit: 1.15, crit: 0.8, 'impact.flesh': 1.25, 'impact.bone': 1.1, 'impact.wood': 1.15,
  dash: 1.5, 'dash.ready': 1.6, telegraph: 1.8, 'projectile.arrow': 1.8, 'projectile.arcane': 1.8,
  'projectile.fire': 1.4, 'ui.click': 1.6, 'ui.hover': 1.6, 'ui.back': 1.4, 'ui.boon': 1.2,
  'voc.shade': 1.8, 'voc.brute': 1.5, 'voc.hound': 1.8, 'voc.bloat': 1.7, 'voc.hexer': 1.8, 'voc.herald': 1.7,
  enemyDeath: 1.3, enemySpawn: 1.5, 'room.cleared': 1.3, 'boon.common': 1.2, 'boon.rare': 1.2,
  footstep: 2.6, cloth: 2.2, 'charge.full': 1.5, 'status.fire': 1.4, 'status.poison': 1.5,
  'status.lightning': 1.5, 'status.arcane': 1.5, 'weapon.equip': 1.1,
};

const FAMILY_OF = {
  shade: 'shade', brute: 'brute', hound: 'hound', bloat: 'bloat',
  hexer: 'hexer', herald: 'herald', warden: 'warden',
};
const PROJ_SFX = {
  fire: 'projectile.fire', lightning: 'projectile.bolt', frost: 'projectile.arcane',
  arcane: 'projectile.arcane', poison: 'projectile.fire', physical: 'projectile.arrow',
};

export class Audio {
  constructor() {
    // `music` must exist from construction — main.js and combat.js hold a
    // reference before init() and call through it. It is the same object for
    // the life of the system; the real engine is attached at unlock().
    this.music = new MusicFacade(this);
    this.muted = false;
    this._live = false;         // an AudioContext exists and the graph is built
    this._capture = false;
    this.ac = null;
    this.vol = { ...DEFAULT_VOL };
    this._rnd = mulberry32(0x9e37);
    this._last = new Map();     // name -> audio time of last play
    this._voices = [];          // [{end, prio}] pruned every frame
    this._suppressed = new Map();
    this._bossFloor = 0;
    this._hbNext = 0;
    this._ambNext = 0;
    this._bedNext = 0;
    this._doorAt = 0;
    this._offs = [];
    // scratch — reused so a sound effect never allocates
    this._K = { ac: null, dest: null, rnd: null, pitch: 1 };
    this._P = { gain: 1, pitch: 1, rnd: null, variation: 0 };
  }

  // ─────────────────────────────────────────────────────────────── init ────
  async init(ctx) {
    this.ctx = ctx;
    // CONTRACT 1: under capture this system does not exist.
    if (ctx && ctx.CAPTURE) { this._capture = true; return; }
    this._loadVolumes();
    if (ctx?.ui?.menus?.settings) {
      ctx.ui.menus.settings.master = this.vol.master;
      ctx.ui.menus.settings.music = this.vol.music;
      ctx.ui.menus.settings.sfx = this.vol.sfx;
    }
    try { this._rnd = mulberry32((ctx?.rng?.fork?.('audio')?.f?.() * 0xffffffff) >>> 0 || 0x9e37); }
    catch (e) { /* a stub rng — the fixed seed is fine */ }
    this._bind(ctx);
  }

  /** Build the graph. Called on the first user gesture (main.js wires this). */
  unlock() {
    if (this._capture || this._live) return;
    try {
      const AC = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
      if (!AC) return;                                  // CONTRACT 2
      const ac = new AC({ latencyHint: 'interactive' });
      this.ac = ac;
      this._buildGraph(ac);
      this._K.ac = ac; this._K.rnd = this._rnd;
      this._live = true;
      if (ac.state === 'suspended' && ac.resume) ac.resume();
      // main.js unbinds its unlock listener after one call. If the browser
      // refused that first resume (some autoplay policies only accept a
      // trusted click on the document body), a silent game would be permanent.
      // Keep retrying on any gesture until the context is actually running.
      if (typeof window !== 'undefined') {
        const retry = () => {
          if (!this.ac) return;
          if (this.ac.state === 'running') {
            removeEventListener('pointerdown', retry); removeEventListener('keydown', retry);
            return;
          }
          try { this.ac.resume(); } catch (e) { /* still refused */ }
        };
        addEventListener('pointerdown', retry); addEventListener('keydown', retry);
        this._retry = retry;
      }
      // plucked-string banks: ~40ms of JS, once, off the render path
      this._music.prime();
      const t = ac.currentTime + 0.05;
      this._music.jumpTo(this._pendingBiome || this.ctx?.run?.biome || this.ctx?.world?.biome || 'tartarus');
      this._music.setIntensity(this._pendingIntensity ?? 0);
      this._music.start(t);
    } catch (e) {
      // A broken AudioContext must never break the game.
      console.warn('[audio] unavailable:', e && e.message);
      this._live = false; this.ac = null;
    }
  }

  _buildGraph(ac) {
    // master: buses -> master -> limiter -> soft clip -> out
    this.out = ac.createGain(); this.out.gain.value = 1;
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -8; comp.knee.value = 3; comp.ratio.value = 14;
    comp.attack.value = 0.003; comp.release.value = 0.16;
    const clipper = ac.createWaveShaper();
    clipper.curve = shaperCurve(0.14);        // a gentle tanh — the last line
    clipper.oversample = '2x';
    this.master = ac.createGain(); this.master.gain.value = this.muted ? 0 : this.vol.master;
    this.out.connect(comp); comp.connect(clipper); clipper.connect(this.master); this.master.connect(ac.destination);

    // sends live pre-limiter so the limiter sees the whole mix
    this._rev = new ReverbBus(ac, this.out, { wet: 1 });
    this._dly = new DelayBus(ac, this.out, { feedback: 0.32, wet: 0.55, tone: 2400 });

    // buses
    this.busSfx = ac.createGain(); this.busSfx.gain.value = this.vol.sfx;
    this.busUi = ac.createGain(); this.busUi.gain.value = this.vol.ui;
    this.busMusic = ac.createGain(); this.busMusic.gain.value = this.vol.music;
    this.duckGain = ac.createGain(); this.duckGain.gain.value = 1;
    this.busSfx.connect(this.out); this.busUi.connect(this.out);
    this.busMusic.connect(this.duckGain); this.duckGain.connect(this.out);
    // a touch of the UI bus in the room so menus are not stuck to the glass
    this.uiSend = ac.createGain(); this.uiSend.gain.value = 0.10;
    this.busUi.connect(this.uiSend); this.uiSend.connect(this._rev.input);

    this._music = new Music(ac, this.busMusic, this._rev, this._dly, 0x1337);
  }

  // ──────────────────────────────────────────────────────── public API ────
  /**
   * §2.10 — play one effect.
   * o = { pos, pitch, gain, variation, bus:'sfx'|'ui', rev, dly }
   */
  sfx(name, o) {
    if (!this._live || this.muted || !name) return;
    const ac = this.ac;
    if (ac.state !== 'running') return;
    const t0 = ac.currentTime;
    const now = t0;

    // suppression (one system's richer version replacing another's generic)
    const sup = this._suppressed.get(name);
    if (sup !== undefined && sup > now) return;

    const gap = GAP[name] !== undefined ? GAP[name] : GAP._default;
    const last = this._last.get(name);
    if (last !== undefined && now - last < gap) return;

    const prio = PRIO[name] !== undefined ? PRIO[name] : PRIO._default;
    this._pruneVoices(now);
    if (this._voices.length >= VOICE_CAP) {
      // budget full: only let something more important through, and take the
      // seat of the least important live voice
      let worst = -1, wp = prio;
      for (let i = 0; i < this._voices.length; i++) if (this._voices[i].prio < wp) { wp = this._voices[i].prio; worst = i; }
      if (worst < 0) return;
      this._voices.splice(worst, 1);
    }

    const isUi = (o && o.bus === 'ui') || name.startsWith('ui.') || name.startsWith('boon.');
    const busIn = isUi ? this.busUi : this.busSfx;

    // ── spatialisation ──────────────────────────────────────────────────
    let dGain = 1, pan = 0, lp = 0, dist = 0;
    const pos = o && o.pos;
    if (pos && !isUi) {
      const P = this._place(pos);
      if (!P) return;                             // out of earshot: never scheduled
      dGain = P.g; pan = P.pan; lp = P.lp; dist = P.d;
    }

    // ── per-instance chain: [voice] -> (lowpass) -> pan -> bus (+ sends) ──
    const head = mkGain(ac, 1);
    let node = head;
    if (lp > 0) { const f = mkFilter(ac, 'lowpass', lp, 0.7); node.connect(f); node = f; }
    const pn = mkPanner(ac, pan);
    node.connect(pn);
    const lvl = mkGain(ac, dGain * (o && o.gain !== undefined ? o.gain : 1) * (TRIM[name] || 1));
    pn.connect(lvl); lvl.connect(busIn);
    // reverb/delay sends scale with distance — far things are wetter, which is
    // most of what sells depth in a stone room
    const revAmt = (o && o.rev !== undefined ? o.rev : 0.22) * (1 + 1.5 * clamp((dist - 4) / 26, 0, 1));
    if (revAmt > 0.002 && this._rev) { const s = mkGain(ac, revAmt); lvl.connect(s); s.connect(this._rev.input); }
    if (o && o.dly) { const s = mkGain(ac, o.dly); lvl.connect(s); s.connect(this._dly.input); }

    // ── run the recipe ──────────────────────────────────────────────────
    const fn = resolveSfx(name);
    if (!fn) return;
    const K = this._K; K.dest = head; K.ac = ac; K.rnd = this._rnd;
    K.pitch = (o && o.pitch) || 1;
    const P = this._P;
    P.gain = 1;                                    // level is applied by `lvl`
    P.pitch = K.pitch;
    P.variation = (o && o.variation) || 0;
    // `variation` pins the recipe's random stream, so a caller that wants THIS
    // exact swing again (a replay, a combo that must sound identical) can ask
    // for it. Left out, every call walks the shared stream and never repeats.
    P.rnd = K.rnd = P.variation ? mulberry32(hashName(name) + (P.variation | 0) * 7919) : this._rnd;
    let end = t0 + 0.6;
    try { end = fn(K, t0, P) || (t0 + 0.6); }
    catch (e) { console.warn('[audio] sfx failed', name, e && e.message); return; }

    this._last.set(name, now);
    this._voices.push({ end: end + 0.15, prio });
    return end;
  }

  /** §2.10 — duck the music under a stinger. */
  duck(amount = 0.4, ms = 700) {
    if (!this._live) return;
    const ac = this.ac, t = ac.currentTime;
    const g = this.duckGain.gain;
    const to = clamp(1 - amount, 0.02, 1);
    g.cancelScheduledValues(t);
    g.setValueAtTime(Math.max(0.02, g.value), t);
    g.linearRampToValueAtTime(to, t + 0.045);
    g.setValueAtTime(to, t + 0.045 + Math.max(0, ms / 1000) * 0.35);
    g.linearRampToValueAtTime(1, t + 0.045 + Math.max(0.05, ms / 1000));
  }

  // ── volumes ─────────────────────────────────────────────────────────────
  setVolume(bus, v) {
    v = clamp(+v || 0, 0, 1);
    if (!(bus in this.vol)) return;
    this.vol[bus] = v;
    if (this._live) {
      const t = this.ac.currentTime;
      const node = bus === 'master' ? this.master : bus === 'music' ? this.busMusic : bus === 'sfx' ? this.busSfx : this.busUi;
      if (node) {
        node.gain.cancelScheduledValues(t);
        node.gain.setValueAtTime(node.gain.value, t);
        node.gain.linearRampToValueAtTime(bus === 'master' && this.muted ? 0 : v, t + 0.08);
      }
    }
    this._saveVolumes();
  }
  getVolume(bus) { return this.vol[bus] ?? 0; }
  setMuted(v) {
    this.muted = !!v;
    if (this._live) {
      const t = this.ac.currentTime, g = this.master.gain;
      g.cancelScheduledValues(t); g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(this.muted ? 0 : this.vol.master, t + 0.08);
    }
    this._saveVolumes();
  }
  toggleMute() { this.setMuted(!this.muted); return this.muted; }

  _loadVolumes() {
    try {
      const raw = (typeof localStorage !== 'undefined') && localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const j = JSON.parse(raw);
      for (const k of Object.keys(DEFAULT_VOL)) if (typeof j[k] === 'number') this.vol[k] = clamp(j[k], 0, 1);
      this.muted = !!j.muted;
    } catch (e) { /* private mode, quota, corrupt JSON — defaults are fine */ }
  }
  _saveVolumes() {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(STORE_KEY, JSON.stringify({ ...this.vol, muted: this.muted }));
    } catch (e) { /* never let a storage failure reach the game */ }
  }

  // ── spatial placement ───────────────────────────────────────────────────
  /**
   * Listener = the player (iso games are heard from the character, not the
   * lens). Pan = camera-relative, because left on screen must be left in the
   * mix. Returns null when the source is out of earshot so it is never even
   * scheduled — a dropped voice is the cheapest voice.
   */
  _place(pos) {
    const ctx = this.ctx;
    const px = pos.x || 0, py = pos.y || 0, pz = pos.z || 0;
    const pl = ctx && ctx.player && ctx.player.position;
    const cam = ctx && ctx.camera;
    const lx = pl ? pl.x : (cam ? cam.position.x : 0);
    const ly = pl ? pl.y : 0;
    const lz = pl ? pl.z : (cam ? cam.position.z : 0);
    const dx = px - lx, dy = py - ly, dz = pz - lz;
    const d = Math.sqrt(dx * dx + dy * dy * 0.4 + dz * dz);
    if (d > MAX_DIST) return null;
    const g = Math.pow(REF_DIST / Math.max(REF_DIST, d), ROLLOFF);
    if (g < 0.022) return null;
    let pan = 0;
    if (cam && cam.matrixWorld) {
      const e = cam.matrixWorld.elements;
      // column 0 of the camera's world matrix is its right vector
      const rx = e[0], rz = e[2];
      const inv = 1 / (Math.hypot(rx, rz) || 1);
      pan = clamp(((dx * rx + dz * rz) * inv) / PAN_WIDTH, -1, 1) * PAN_MAX;
    }
    const lp = d > FAR_LP_START ? lerp(19000, 2100, clamp((d - FAR_LP_START) / 26, 0, 1)) : 0;
    return { g, pan, lp, d };
  }

  _pruneVoices(now) {
    const V = this._voices;
    let w = 0;
    for (let i = 0; i < V.length; i++) if (V[i].end > now) V[w++] = V[i];
    V.length = w;
  }

  _suppress(name, seconds) {
    if (!this._live) return;
    this._suppressed.set(name, this.ac.currentTime + seconds);
  }

  // ─────────────────────────────────────────────────────────── the loop ────
  update(dt, ctx) { /* audio never runs on the sim clock — see lateUpdate */ }

  /**
   * lateUpdate, not update: the fixed-step update() is skipped entirely during
   * hit-stop (time.scale = 0), and music must not stop when the game freezes
   * for 70 ms. lateUpdate runs every rendered frame regardless of time scale.
   */
  lateUpdate(alpha, ctx) {
    if (!this._live) return;
    const ac = this.ac;
    if (ac.state !== 'running') return;
    this._music.update();
    const now = ac.currentTime;
    this._pruneVoices(now);
    this._lowHealth(ctx, now);
    this._ambience(ctx, now);
    if (this._doorAt && now >= this._doorAt) { this._doorAt = 0; this.sfx('door.unseal', { bus: 'ui', gain: 0.85 }); }
  }

  /** A heartbeat that speeds up as the hero bleeds out. */
  _lowHealth(ctx, now) {
    const p = ctx && ctx.player;
    if (!p || !p.alive || !p.maxHealth) { this._hbNext = 0; return; }
    const f = p.health / p.maxHealth;
    if (f > 0.32 || f <= 0) { this._hbNext = 0; return; }
    if (now < this._hbNext) return;
    const k = clamp(f / 0.32, 0, 1);
    const period = lerp(0.62, 1.15, k);
    this._hbNext = now + period;
    this.sfx('heartbeat', { bus: 'ui', gain: lerp(0.85, 0.35, k), rev: 0.05 });
  }

  /**
   * Braziers. The world owns where the fires are; audio owns what they sound
   * like, so rather than reaching across the ownership line this scatters
   * crackle grains around the listener at low level and lets the reverb place
   * them. It steps out of the way once a fight is loud.
   */
  _ambience(ctx, now) {
    const biome = this._music.name;
    if (biome === 'menu') return;
    const intensity = this._music._iRamped || 0;
    const busy = clamp(intensity, 0, 1);
    if (now >= this._bedNext) {
      this._bedNext = now + 2.0;
      this.sfx('brazier.bed', { gain: lerp(0.5, 0.12, busy), bus: 'sfx', rev: 0.4 });
    }
    if (now >= this._ambNext) {
      this._ambNext = now + 0.10 + this._rnd() * 0.34;
      if (this._rnd() < lerp(0.85, 0.2, busy)) {
        const a = this._rnd() * Math.PI * 2, r = 6 + this._rnd() * 12;
        const pl = ctx && ctx.player && ctx.player.position;
        _sp.x = (pl ? pl.x : 0) + Math.cos(a) * r;
        _sp.y = 1.2;
        _sp.z = (pl ? pl.z : 0) + Math.sin(a) * r;
        this.sfx('brazier', { pos: _sp, gain: lerp(0.7, 0.2, busy), rev: 0.5 });
      }
    }
  }

  // ────────────────────────────────────────────────────────── the bus ─────
  /**
   * Subscribe once, at init. Every handler is cheap, guarded, and does NOT
   * duplicate a sound another system already asks for by name — where a system
   * already calls sfx() directly (weapon swings, 'hit', 'telegraph'), these
   * handlers LAYER on top or SUPPRESS the generic version and replace it with
   * something specific.
   */
  _bind(ctx) {
    if (!ctx || !ctx.events) return;
    const E = ctx.events, on = (n, f) => { this._offs.push(E.on(n, f)); };

    // The canvas settings panel publishes these values. Keep this bridge in
    // audio authority so every change is ramped, persisted and immediately
    // audible instead of merely changing the drawn slider.
    on('settings.volume', (i) => {
      if (!i || !['master', 'music', 'sfx', 'ui'].includes(i.channel)) return;
      this.setVolume(i.channel, i.value);
    });

    // ── damage: combat.js already plays a generic 'hit'; this adds the
    //    elemental colour and the crit accent on top of it.
    on('damage.dealt', (i) => {
      if (!this._live || !i) return;
      if (i.target === ctx.player) return;                   // 'hurt' owns that
      const pos = i.pos || (i.target && i.target.position);
      if (i.type && i.type !== 'physical' && RECIPES['impact.' + i.type]) {
        this.sfx('impact.' + i.type, { pos, gain: 0.55 });
      }
      if (i.crit) this.sfx('crit', { pos, gain: 0.8 });
    });

    on('entity.staggered', (i) => { if (i) this.sfx('stagger', { pos: i.pos || i.entity?.position, gain: 0.8 }); });

    // ── deaths: replace the generic 'enemyDeath' with the family's own voice
    on('entity.died', (i) => {
      if (!this._live || !i || !i.entity) return;
      if (i.entity === ctx.player) return;
      const kind = i.entity.def?.kind || i.entity.kind;
      const fam = FAMILY_OF[kind];
      const pos = i.pos || i.entity.position;
      if (fam && RECIPES['death.' + fam]) {
        this._suppress('enemyDeath', 0.3);
        this.sfx('death.' + fam, { pos, gain: fam === 'warden' ? 1.0 : 0.85 });
        if (fam === 'warden') this.duck(0.45, 2200);
      }
    });

    on('status.applied', (i) => { if (i && RECIPES['status.' + i.kind]) this.sfx('status.' + i.kind, { pos: i.target?.position, gain: 0.55 }); });
    on('status.shatter', (i) => { if (i) this.sfx('status.shatter', { pos: i.target?.position, gain: 0.9 }); });

    // ── the hero's weapon: the swing is played by weapons.js; this adds the
    //    body under it — cloth and footwork, which is what makes a swing feel
    //    like a person rather than a sound file.
    on('weapon.step', (i) => { if (i && i.actor) this.sfx('cloth', { pos: i.actor.position, gain: 0.7 }); });
    on('weapon.blocked', (i) => {
      if (!i) return;
      if (!i.perfect) this.sfx('impact.metal', { pos: i.actor?.position, gain: 0.75 });
    });
    on('weapon.equipped', (i) => this.sfx('weapon.equip', { pos: i?.actor?.position, gain: 0.8 }));

    on('projectile.fired', (i) => {
      if (!i) return;
      const n = PROJ_SFX[i.type] || 'projectile.arrow';
      this.sfx(n, { pos: i.pos, gain: i.source === ctx.player ? 0.55 : 0.7 });
    });
    on('projectile.reflected', (i) => this.sfx('shield.reflect', { pos: i?.pos, gain: 0.8 }));

    // ── enemies: a family vocalisation under the generic telegraph, and the
    //    boss gets its own, much lower, much longer tell.
    on('enemy.telegraph', (i) => {
      if (!this._live || !i || !i.entity) return;
      const kind = i.entity.def?.kind || i.entity.kind;
      const pos = i.entity.position;
      if (kind === 'warden') { this._suppress('telegraph', 0.25); this.sfx('boss.telegraph', { pos, gain: 1 }); return; }
      const fam = FAMILY_OF[kind];
      if (fam && this._rnd() < 0.4 && RECIPES['voc.' + fam]) this.sfx('voc.' + fam, { pos, gain: 0.5 });
    });
    on('enemy.spawned', (i) => {
      if (!i || !i.entity) return;
      const fam = FAMILY_OF[i.entity.def?.kind || i.entity.kind];
      if (fam && this._rnd() < 0.5 && RECIPES['voc.' + fam]) this.sfx('voc.' + fam, { pos: i.pos || i.entity.position, gain: 0.42 });
    });

    // ── boss
    on('boss.spawned', (i) => {
      this.sfx('boss.roar', { pos: i?.entity?.position, gain: 1 });
      this.duck(0.5, 2600);
      this._bossFloor = 0.82;
      this.music.setIntensity(Math.max(this._bossFloor, this._lastIntensity || 0));
    });
    on('boss.phase', (i) => { this.sfx('boss.phase', { pos: i?.entity?.position, gain: 1 }); this.duck(0.4, 2000); this._bossFloor = 0.9; });
    on('boss.exposed', (i) => this.sfx('stagger', { pos: i?.entity?.position, gain: 1 }));
    on('boss.defeated', () => { this._bossFloor = 0; this.music.setIntensity(0); });

    // ── run flow
    on('room.cleared', () => {
      this._bossFloor = 0;
      this.music.setIntensity(0);
      this.sfx('room.cleared', { bus: 'ui', gain: 0.9 });
      this.duck(0.3, 1600);
      this._doorAt = (this._live ? this.ac.currentTime : 0) + 1.1;
    });
    on('room.entered', (i) => { if (i && i.biome) this.music.setBiome(i.biome); });
    on('biome.changed', (i) => { if (i && i.name) this.music.setBiome(i.name); });
    on('boon.granted', (i) => {
      const r = (i && i.rarity ? String(i.rarity) : 'common').toLowerCase();
      const n = RECIPES['boon.' + r] ? 'boon.' + r : 'boon.common';
      this.sfx(n, { bus: 'ui', gain: 1 });
      this.duck(0.3, 1400);
    });
    on('run.started', () => { this._bossFloor = 0; this.music.setIntensity(0); });

    // ── player
    on('player.dashReady', () => this.sfx('dash.ready', { bus: 'ui', gain: 0.5 }));
    on('player.died', () => {
      this.sfx('player.death', { bus: 'ui', gain: 1 });
      this._bossFloor = 0;
      this.music.setIntensity(0);
      this.music.setBiome('menu');
      this.duck(0.6, 3200);
    });
    on('player.cast', (i) => this.sfx('projectile.arcane', { pos: i?.pos, gain: 0.7 }));
    on('player.summoned', (i) => this.sfx('impact.arcane', { pos: i?.pos, gain: 0.7 }));

    // ── intensity: combat.js calls setIntensity directly too; this keeps the
    //    music honest if any other system publishes it.
    on('combat.intensity', (i) => { if (i) this.music.setIntensity(i.value); });

    // ── a heavy hit pulls the music back for a beat. Free game-feel.
    on('hit.stop', (i) => { if (i && i.ms >= 55) this.duck(0.22, i.ms * 4); });
  }

  dispose() {
    if (this._retry && typeof window !== 'undefined') {
      removeEventListener('pointerdown', this._retry); removeEventListener('keydown', this._retry); this._retry = null;
    }
    for (const off of this._offs) { try { off(); } catch (e) { /* already gone */ } }
    this._offs.length = 0;
    if (this._live) {
      try { this._music.stop(); } catch (e) { /* ignore */ }
      try { this.ac.close(); } catch (e) { /* ignore */ }
    }
    this._live = false;
  }
}

// A stable façade so `ctx.audio.music` is safe to hold before unlock() and
// safe to call under capture. Calls made early are remembered and applied when
// the graph comes up.
class MusicFacade {
  constructor(a) { this.a = a; }
  setBiome(name) {
    const a = this.a;
    a._pendingBiome = name;
    if (a._live && a._music) a._music.setBiome(name);
  }
  setIntensity(v) {
    const a = this.a;
    const x = clamp(+v || 0, 0, 1);
    a._lastIntensity = x;
    const y = Math.max(x, a._bossFloor || 0);
    a._pendingIntensity = y;
    if (a._live && a._music) a._music.setIntensity(y);
  }
  get name() { const a = this.a; return a._live && a._music ? a._music.name : (a._pendingBiome || 'tartarus'); }
  get intensity() { const a = this.a; return a._live && a._music ? a._music.intensity : (a._pendingIntensity || 0); }
  start() { const a = this.a; if (a._live) a._music.start(); }
  stop() { const a = this.a; if (a._live) a._music.stop(); }
}

// module-scope scratch — audio must not allocate per frame
const _sp = { x: 0, y: 0, z: 0 };

export { SFX_NAMES, BIOME_SPACE };
export default Audio;
