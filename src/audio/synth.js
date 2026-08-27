// OWNER: AGENT-AUDIO
// ---------------------------------------------------------------------------
// src/audio/synth.js — the procedural synthesis toolkit.
//
// Everything EREBUS makes a noise with is built here out of oscillators, noise,
// wavetables and DSP. There is not one audio file in this project.
//
// Design rules this file obeys, and every caller must keep obeying:
//   * Every parameter change is SCHEDULED on the audio clock (setValueAtTime /
//     linearRampToValueAtTime / exponentialRampToValueAtTime). Nothing is poked
//     from the render loop; the render loop only decides *when*, never *now*.
//   * Buffers (noise, impulse responses, Karplus-Strong strings) are rendered
//     once and cached. A one-shot never allocates a Float32Array.
//   * Randomness comes from a private mulberry32 stream, NOT ctx.rng. Audio must
//     never advance the simulation's RNG — if it did, a muted run and an audible
//     run would diverge and determinism would be a lie. The audio stream is
//     seeded FROM ctx.rng.fork('audio') so it is still reproducible per seed.
// ---------------------------------------------------------------------------

export const TAU = Math.PI * 2;

/** Small, fast, deterministic PRNG. Private to audio (see header). */
export function mulberry32(seed) {
  let a = (seed >>> 0) || 1;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashName(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

export const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);
export const dbToGain = (db) => Math.pow(10, db / 20);
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
}

// ── envelopes ──────────────────────────────────────────────────────────────
// exponentialRamp cannot reach zero, so every "off" value is EPS.
const EPS = 0.00015;

/**
 * Percussive / one-shot ADSR scheduled from t0. Returns the time it ends.
 * o = { peak, a, d, s, hold, r, curve:'exp'|'lin' }
 */
export function adsr(param, t0, o = {}) {
  const peak = Math.max(EPS, o.peak ?? 1);
  const a = Math.max(0.0005, o.a ?? 0.004);
  const d = Math.max(0.001, o.d ?? 0.09);
  const s = clamp(o.s ?? 0, 0, 1);
  const hold = Math.max(0, o.hold ?? 0);
  const r = Math.max(0.004, o.r ?? 0.10);
  const sv = Math.max(EPS, peak * s);
  param.cancelScheduledValues(t0);
  param.setValueAtTime(EPS, t0);
  param.linearRampToValueAtTime(peak, t0 + a);
  const tD = t0 + a + d;
  if (o.curve === 'lin') param.linearRampToValueAtTime(sv, tD);
  else param.exponentialRampToValueAtTime(sv, tD);
  const tE = tD + hold;
  if (hold > 0) param.setValueAtTime(sv, tE);
  param.exponentialRampToValueAtTime(EPS, tE + r);
  param.setValueAtTime(0, tE + r + 0.001);
  return tE + r + 0.002;
}

/** Sustained attack — for pads and loops that are released later. */
export function attackTo(param, t0, peak, a = 0.6) {
  param.cancelScheduledValues(t0);
  param.setValueAtTime(Math.max(EPS, param.value), t0);
  param.linearRampToValueAtTime(Math.max(EPS, peak), t0 + Math.max(0.002, a));
}
export function releaseAt(param, t0, r = 0.8) {
  param.cancelScheduledValues(t0);
  param.setValueAtTime(Math.max(EPS, param.value), t0);
  param.exponentialRampToValueAtTime(EPS, t0 + Math.max(0.01, r));
  param.setValueAtTime(0, t0 + Math.max(0.01, r) + 0.001);
  return t0 + r + 0.002;
}

/** Filter cutoff sweep — the single most useful gesture in synthesis. */
export function sweep(param, t0, f0, f1, time, curve = 'exp') {
  param.cancelScheduledValues(t0);
  param.setValueAtTime(clamp(f0, 20, 21000), t0);
  if (curve === 'lin') param.linearRampToValueAtTime(clamp(f1, 20, 21000), t0 + time);
  else param.exponentialRampToValueAtTime(clamp(f1, 20, 21000), t0 + Math.max(0.002, time));
}

// ── noise ──────────────────────────────────────────────────────────────────
const _noiseCache = new WeakMap();

/** Cached deterministic noise buffer. kind: 'white' | 'pink' | 'brown' | 'metal' */
export function noise(ac, kind = 'white', seconds = 2.2) {
  let m = _noiseCache.get(ac);
  if (!m) { m = new Map(); _noiseCache.set(ac, m); }
  const key = kind + ':' + seconds;
  let b = m.get(key);
  if (b) return b;
  const sr = ac.sampleRate;
  const n = Math.max(1, Math.floor(sr * seconds));
  b = ac.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    const rnd = mulberry32(hashName(key) + ch * 7919);
    if (kind === 'white') {
      for (let i = 0; i < n; i++) d[i] = rnd() * 2 - 1;
    } else if (kind === 'pink') {
      // Paul Kellet's economy pink filter
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < n; i++) {
        const w = rnd() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.96900 * b2 + w * 0.1538520; b3 = 0.86650 * b3 + w * 0.3104856;
        b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.16;
        b6 = w * 0.115926;
      }
    } else if (kind === 'brown') {
      let last = 0;
      for (let i = 0; i < n; i++) { last = (last + 0.028 * (rnd() * 2 - 1)) / 1.028; d[i] = last * 3.2; }
    } else { // 'metal' — dense inharmonic partials, for cymbals and jingles
      const partials = 14, ph = new Float32Array(partials), inc = new Float32Array(partials);
      for (let k = 0; k < partials; k++) inc[k] = TAU * (1400 + rnd() * 7200) / sr;
      for (let i = 0; i < n; i++) {
        let v = 0;
        for (let k = 0; k < partials; k++) { ph[k] += inc[k]; v += Math.sin(ph[k]); }
        d[i] = (v / partials) * 0.9 + (rnd() * 2 - 1) * 0.35;
      }
    }
  }
  m.set(key, b);
  return b;
}

// ── wavetables ─────────────────────────────────────────────────────────────
const _waveCache = new WeakMap();

// A formant-shaped harmonic series: places spectral peaks at fixed frequencies
// assuming a nominal f0, which is what makes a stack of saws read as "voice"
// rather than "synth". A real fixed formant bank sits on the pad bus as well.
function formantAmps(f0, forms, n) {
  const a = new Float32Array(n);
  for (let k = 1; k < n; k++) {
    const f = f0 * k;
    let g = 0;
    for (const [ff, bw, amp] of forms) {
      const x = (f - ff) / bw;
      g += amp * Math.exp(-x * x);
    }
    a[k] = (g + 0.06 / k) / Math.sqrt(k);
  }
  return a;
}

const WAVE_BUILDERS = {
  saw:    (n) => { const a = new Float32Array(n); for (let k = 1; k < n; k++) a[k] = 1 / k; return a; },
  square: (n) => { const a = new Float32Array(n); for (let k = 1; k < n; k += 2) a[k] = 1 / k; return a; },
  pulse:  (n) => { const a = new Float32Array(n); for (let k = 1; k < n; k++) a[k] = Math.sin(k * Math.PI * 0.22) / k; return a; },
  organ:  (n) => { const a = new Float32Array(n); const t = [1, .62, .12, .40, .06, .05, .03, .22];
                   for (let k = 1; k < n; k++) a[k] = (t[(k - 1) % 8] || 0.02) / (1 + (k >> 3)); return a; },
  choirAh: (n) => formantAmps(190, [[730, 130, 1.0], [1090, 170, 0.62], [2440, 260, 0.28], [3400, 420, 0.10]], n),
  choirOo: (n) => formantAmps(190, [[320, 110, 1.0], [860, 150, 0.42], [2240, 300, 0.11], [3200, 460, 0.05]], n),
  choirEh: (n) => formantAmps(190, [[530, 120, 1.0], [1840, 220, 0.55], [2480, 300, 0.30], [3500, 460, 0.09]], n),
  brass:  (n) => { const a = new Float32Array(n); for (let k = 1; k < n; k++) a[k] = Math.exp(-Math.pow((k - 5) / 7, 2) * 0.5) / Math.sqrt(k); return a; },
  reed:   (n) => { const a = new Float32Array(n); for (let k = 1; k < n; k += 2) a[k] = 1 / Math.pow(k, 1.35); for (let k = 2; k < n; k += 2) a[k] = 0.22 / Math.pow(k, 1.6); return a; },
  ney:    (n) => { const a = new Float32Array(n); const t = [1, .30, .13, .05, .03, .015];
                   for (let k = 1; k < n; k++) a[k] = t[k - 1] || 0.006 / k; return a; },
  glass:  (n) => { const a = new Float32Array(n); const ks = [1, 2, 4, 7, 11, 16], g = [1, .5, .3, .18, .1, .06];
                   for (let i = 0; i < ks.length; i++) if (ks[i] < n) a[ks[i]] = g[i]; return a; },
  bowed:  (n) => { const a = new Float32Array(n); for (let k = 1; k < n; k++) a[k] = (1 / k) * Math.exp(-k / 26) * (1 + 0.35 * Math.sin(k * 1.7)); return a; },
};

/** Cached PeriodicWave. name must be a key of WAVE_BUILDERS. */
export function wave(ac, name) {
  let m = _waveCache.get(ac);
  if (!m) { m = new Map(); _waveCache.set(ac, m); }
  let w = m.get(name);
  if (w) return w;
  const N = 64;
  const build = WAVE_BUILDERS[name] || WAVE_BUILDERS.saw;
  const imag = build(N);
  const real = new Float32Array(N);
  // normalise so every table has comparable loudness
  let s = 0; for (let k = 1; k < N; k++) s += Math.abs(imag[k]);
  if (s > 0) for (let k = 1; k < N; k++) imag[k] /= s * 0.55;
  w = ac.createPeriodicWave(real, imag, { disableNormalization: false });
  m.set(name, w);
  return w;
}
export const WAVE_NAMES = Object.keys(WAVE_BUILDERS);

// ── wave shaper (drive) ────────────────────────────────────────────────────
const _shaperCache = new WeakMap();
export function shaperCurve(amount, n = 2048) {
  const c = new Float32Array(n);
  const k = Math.max(0.0001, amount);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / (n - 1) - 1;
    c[i] = Math.tanh(x * (1 + k * 7)) / Math.tanh(1 + k * 7);
  }
  return c;
}
/** Cached WaveShaperNode curve; `amount` is quantised so the cache actually hits. */
export function shaper(ac, amount = 0.4) {
  let m = _shaperCache.get(ac);
  if (!m) { m = new Map(); _shaperCache.set(ac, m); }
  const q = Math.round(clamp(amount, 0, 4) * 20) / 20;
  let cur = m.get(q);
  if (!cur) { cur = shaperCurve(q); m.set(q, cur); }
  const w = ac.createWaveShaper();
  w.curve = cur;
  w.oversample = '2x';
  return w;
}

// ── node helpers ───────────────────────────────────────────────────────────
export function gain(ac, v = 0) { const g = ac.createGain(); g.gain.value = v; return g; }
export function filter(ac, type = 'lowpass', f = 1000, q = 1) {
  const b = ac.createBiquadFilter(); b.type = type; b.frequency.value = clamp(f, 10, 21000); b.Q.value = q; return b;
}
export function panner(ac, p = 0) {
  if (ac.createStereoPanner) { const n = ac.createStereoPanner(); n.pan.value = clamp(p, -1, 1); return n; }
  // Safari-shaped fallback: an equal-power pan through a PannerNode
  const n = ac.createPanner(); n.panningModel = 'equalpower';
  n.setPosition ? n.setPosition(clamp(p, -1, 1), 0, 1 - Math.abs(p) * 0.5) : 0;
  return n;
}

/** An oscillator started at t and stopped at tEnd, routed to dest. */
export function osc(ac, dest, type, f, t, tEnd) {
  const o = ac.createOscillator();
  if (typeof type === 'string' && WAVE_BUILDERS[type]) o.setPeriodicWave(wave(ac, type));
  else o.type = type || 'sine';
  o.frequency.setValueAtTime(clamp(f, 0.01, 20000), t);
  o.connect(dest);
  o.start(t);
  if (tEnd != null) o.stop(tEnd);
  return o;
}

/** A buffer source started at t. */
export function src(ac, dest, buffer, t, o = {}) {
  const s = ac.createBufferSource();
  s.buffer = buffer;
  s.playbackRate.value = o.rate ?? 1;
  s.loop = !!o.loop;
  if (o.loop) { s.loopStart = o.loopStart ?? 0; s.loopEnd = o.loopEnd ?? buffer.duration; }
  s.connect(dest);
  const off = o.offset ?? 0;
  s.start(t, off, o.duration);
  if (o.stop != null) s.stop(o.stop);
  return s;
}

// ── LFO ────────────────────────────────────────────────────────────────────
/**
 * An LFO is an oscillator into a gain, connected to one or more AudioParams.
 * Returns { osc, depth, stop(t) } — never left running.
 */
export function lfo(ac, rate, depth, type = 'sine', t = 0, phaseSeed = 0) {
  const o = ac.createOscillator();
  o.type = type;
  o.frequency.value = rate;
  // WebAudio gives no phase control; a tiny detune offset decorrelates stacked LFOs
  if (phaseSeed) o.detune.value = (phaseSeed % 17) * 1.5;
  const g = ac.createGain();
  g.gain.value = depth;
  o.connect(g);
  o.start(t);
  return { osc: o, depth: g, connect: (p) => g.connect(p), stop: (te) => { try { o.stop(te); } catch (e) { /* already stopped */ } } };
}

// ═══════════════════════════════════════════════════════════════════════════
// KARPLUS-STRONG — the signature instrument
// ═══════════════════════════════════════════════════════════════════════════
//
// Rendered OFFLINE into an AudioBuffer rather than built as a DelayNode
// feedback loop, for one hard reason: WebAudio inserts a mandatory 128-sample
// latency into any node cycle, which caps a real-time feedback string at about
// 375 Hz. A bouzouki lives an octave above that. Rendering the string in JS
// gives exact fractional-delay pitch at any frequency, a proper pick-position
// comb, and the double-course detune that IS the bouzouki sound — at the cost
// of a few milliseconds, once, at unlock.

/** One string voice summed into `out`. Extended Karplus-Strong (Jaffe-Smith). */
function ksString(out, sr, f, o, seed, amp) {
  const rnd = mulberry32(seed);
  const L = sr / f;                       // fractional delay length in samples
  const N = Math.ceil(L) + 2;
  const buf = new Float32Array(N);

  // --- excitation: a short filtered noise burst, combed by pick position ----
  const exLen = Math.max(2, Math.min(N, Math.floor(L)));
  const ex = new Float32Array(exLen);
  const bright = clamp(o.bright ?? 0.5, 0, 1);
  const exA = 0.25 + 0.7 * bright;        // excitation lowpass coefficient
  let lp = 0;
  for (let i = 0; i < exLen; i++) { const w = rnd() * 2 - 1; lp += (w - lp) * exA; ex[i] = lp; }
  const pick = Math.max(1, Math.floor(exLen * clamp(o.pickPos ?? 0.26, 0.02, 0.5)));
  for (let i = exLen - 1; i >= pick; i--) ex[i] -= ex[i - pick] * 0.86;
  let mx = 1e-9; for (let i = 0; i < exLen; i++) { const a = Math.abs(ex[i]); if (a > mx) mx = a; }
  for (let i = 0; i < exLen; i++) buf[i] = ex[i] / mx;

  // --- loop: one-pole damping + per-sample loss set from a T60 target -------
  const t60 = Math.max(0.08, o.t60 ?? 1.6);
  const loss = Math.pow(10, -3 / (sr * t60));
  // damping tracks pitch so high notes stay bright instead of turning to mud
  const fc = clamp(f * (3.5 + 24 * bright), 700, sr * 0.44);
  const a1 = 1 - Math.exp(-TAU * fc / sr);
  const n = out.length;
  let y1 = 0, idx = 0, dc0 = 0, dc1 = 0;
  const stretch = o.stretch ?? 0;         // slight inharmonicity → metal/bell edge
  for (let i = 0; i < n; i++) {
    let r = idx - L; if (r < 0) r += N;
    const i0 = r | 0, fr = r - i0;
    const s0 = buf[i0 % N], s1 = buf[(i0 + 1) % N];
    let v = s0 + (s1 - s0) * fr;
    y1 += (v - y1) * a1;
    let s = y1 * loss;
    if (stretch) s += (v - y1) * stretch * 0.5;
    buf[idx % N] = s;
    idx++;
    // DC blocker so a long string cannot drift and eat headroom
    const y = s - dc0 + 0.9985 * dc1; dc0 = s; dc1 = y;
    out[i] += y * amp;
  }
}

/**
 * Render a plucked-string note into a mono AudioBuffer.
 * o = { courses, detune(cents), bright, t60, pickPos, stretch, drive, seed }
 */
export function renderPluck(ac, freq, seconds, o = {}) {
  const sr = ac.sampleRate;
  const n = Math.max(64, Math.floor(sr * seconds));
  const acc = new Float32Array(n);
  const courses = o.courses ?? 2;
  const det = o.detune ?? 7;
  for (let c = 0; c < courses; c++) {
    const cents = courses === 1 ? 0 : (c - (courses - 1) / 2) * det;
    // a real double course is also struck a hair apart in time; emulate with a
    // slightly different excitation seed and a per-course amplitude tilt
    ksString(acc, sr, freq * Math.pow(2, cents / 1200), o, (o.seed ?? 1) + c * 9781, (1 - c * 0.14) / courses);
  }
  // soft saturation + a tail taper so the buffer never ends on a step
  const drive = o.drive ?? 0.5;
  const k = 1 + drive * 3;
  const taperFrom = Math.floor(n * 0.86);
  let peak = 1e-9;
  for (let i = 0; i < n; i++) {
    let v = Math.tanh(acc[i] * k) / Math.tanh(k);
    if (i > taperFrom) v *= 1 - (i - taperFrom) / (n - taperFrom);
    acc[i] = v;
    const a = Math.abs(v); if (a > peak) peak = a;
  }
  const g = 0.92 / peak;
  for (let i = 0; i < n; i++) acc[i] *= g;
  const b = ac.createBuffer(1, n, sr);
  b.copyToChannel(acc, 0);
  return b;
}

/**
 * A cached bank of plucked strings. Strings are rendered at four base pitches
 * and transposed by playbackRate — the same trick a sampler uses — so one
 * bouzouki costs 12 short buffers instead of one per note.
 */
export class PluckBank {
  /** preset: 'bouzouki' | 'lyre' | 'bass' | 'harp' */
  constructor(ac, preset = 'bouzouki', seed = 1) {
    this.ac = ac; this.preset = preset; this.seed = seed;
    this.banks = new Map();      // register -> [AudioBuffer]
    this.bases = [38, 50, 62, 74];
    this.lens = [3.1, 2.4, 1.7, 1.15];
    this.variants = 3;
    this._n = 0;
    this.opt = PluckBank.PRESETS[preset] || PluckBank.PRESETS.bouzouki;
  }
  static PRESETS = {
    // double course, mid-bright, medium sustain — the game's signature timbre
    bouzouki: { courses: 2, detune: 8, bright: 0.62, t60: 1.5, pickPos: 0.24, drive: 0.55 },
    // single gut string, dark and long — Elysium's ornament
    lyre:     { courses: 1, detune: 0, bright: 0.40, t60: 2.6, pickPos: 0.34, drive: 0.25 },
    // bright, short, metallic — accents and menus
    harp:     { courses: 1, detune: 0, bright: 0.80, t60: 1.9, pickPos: 0.16, drive: 0.2, stretch: 0.05 },
    // low, thick, heavily damped — the plucked bass under Tartarus
    bass:     { courses: 2, detune: 4, bright: 0.30, t60: 0.9, pickPos: 0.30, drive: 0.9 },
  };
  _register(midi) {
    let best = 0, bd = 1e9;
    for (let i = 0; i < this.bases.length; i++) { const d = Math.abs(midi - this.bases[i]); if (d < bd) { bd = d; best = i; } }
    return best;
  }
  _bank(reg) {
    let b = this.banks.get(reg);
    if (b) return b;
    b = [];
    const f = midiToFreq(this.bases[reg]);
    for (let v = 0; v < this.variants; v++) {
      b.push(renderPluck(this.ac, f, this.lens[reg], {
        ...this.opt,
        bright: clamp(this.opt.bright + (v - 1) * 0.06, 0.05, 0.98),
        pickPos: clamp(this.opt.pickPos + (v - 1) * 0.035, 0.03, 0.48),
        seed: this.seed + reg * 131 + v * 7717,
      }));
    }
    this.banks.set(reg, b);
    return b;
  }
  /** Warm the whole bank (call once, at unlock, off the render path). */
  prime() { for (let i = 0; i < this.bases.length; i++) this._bank(i); return this; }
  /**
   * Play a note. Returns the BufferSource so the caller can stop it early.
   * o = { gain, dur, variant, detune (cents) }
   */
  play(dest, t, midi, o = {}) {
    const reg = this._register(midi);
    const bank = this._bank(reg);
    const v = (o.variant != null ? o.variant : this._n++) % this.variants;
    const buf = bank[v < 0 ? 0 : v];
    const rate = Math.pow(2, (midi - this.bases[reg] + (o.detune || 0) / 100) / 12);
    const g = gain(this.ac, 0);
    g.connect(dest);
    const s = src(this.ac, g, buf, t, { rate });
    const dur = o.dur != null ? Math.min(o.dur, buf.duration / rate) : buf.duration / rate;
    const peak = o.gain ?? 0.5;
    g.gain.setValueAtTime(EPS, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.003);
    // notes are released, not cut — a damped string, not a gate
    g.gain.setValueAtTime(peak, t + Math.max(0.02, dur * 0.55));
    g.gain.exponentialRampToValueAtTime(EPS, t + dur + (o.release ?? 0.12));
    s.stop(t + dur + (o.release ?? 0.12) + 0.02);
    // expose the note's own gain so a caller stealing this voice can fade it
    // out rather than cutting a ringing string dead (see Music.fadeKill)
    s._g = g;
    return s;
  }
}

// ── FM voice ───────────────────────────────────────────────────────────────
/**
 * Two-operator FM — bells, metal, boss stingers, magical shimmer.
 * o = { ratio, index, indexEnv, a, d, s, hold, r, gain, wave }
 */
export function fmVoice(ac, dest, t, freq, o = {}) {
  const ratio = o.ratio ?? 2.0;
  const index = o.index ?? 300;
  const dur = (o.a ?? 0.003) + (o.d ?? 0.4) + (o.hold ?? 0) + (o.r ?? 0.3);
  const car = ac.createOscillator();
  if (o.wave && WAVE_BUILDERS[o.wave]) car.setPeriodicWave(wave(ac, o.wave)); else car.type = o.wave || 'sine';
  car.frequency.setValueAtTime(freq, t);
  const mod = ac.createOscillator();
  mod.type = 'sine';
  mod.frequency.setValueAtTime(freq * ratio, t);
  const mg = gain(ac, 0);
  mg.gain.setValueAtTime(index, t);
  mg.gain.exponentialRampToValueAtTime(Math.max(1, index * (o.indexEnd ?? 0.02)), t + dur * 0.7);
  mod.connect(mg); mg.connect(car.frequency);
  const g = gain(ac, 0);
  car.connect(g); g.connect(dest);
  adsr(g.gain, t, { peak: o.gain ?? 0.4, a: o.a ?? 0.003, d: o.d ?? 0.4, s: o.s ?? 0, hold: o.hold ?? 0, r: o.r ?? 0.3 });
  car.start(t); mod.start(t);
  car.stop(t + dur + 0.05); mod.stop(t + dur + 0.05);
  return { car, mod, end: t + dur + 0.05 };
}

// ── unison wavetable voice ────────────────────────────────────────────────
/**
 * A detuned stack through a filter — the analog workhorse (bass, drone, brass).
 * Returns { gain, filter, stop(t) } so it can be sustained and released.
 */
export function stackVoice(ac, dest, t, freq, o = {}) {
  const n = o.voices ?? 3;
  const spread = o.spread ?? 9;            // cents
  const g = gain(ac, 0);
  const f = filter(ac, o.filterType || 'lowpass', o.cutoff ?? 1400, o.q ?? 4);
  let node = f;
  if (o.drive) { const sh = shaper(ac, o.drive); f.connect(sh); node = sh; }
  node.connect(g); g.connect(dest);
  const oscs = [];
  const wv = o.wave || 'saw';
  for (let i = 0; i < n; i++) {
    const cents = n === 1 ? 0 : (i / (n - 1) - 0.5) * 2 * spread;
    const oo = ac.createOscillator();
    if (WAVE_BUILDERS[wv]) oo.setPeriodicWave(wave(ac, wv)); else oo.type = wv;
    oo.frequency.setValueAtTime(freq, t);
    oo.detune.setValueAtTime(cents, t);
    const vg = gain(ac, 1 / n);
    oo.connect(vg); vg.connect(f);
    oo.start(t);
    oscs.push(oo);
  }
  if (o.sub) {
    const so = ac.createOscillator(); so.type = 'sine';
    so.frequency.setValueAtTime(freq * 0.5, t);
    const sg = gain(ac, o.sub); so.connect(sg); sg.connect(f); so.start(t); oscs.push(so);
  }
  return {
    gain: g, filter: f, oscs,
    stop(te) { for (const oo of oscs) { try { oo.stop(te); } catch (e) { /* already scheduled */ } } },
  };
}

// ── polyphonic allocator with stealing ────────────────────────────────────
/**
 * Tracks live voices and enforces a hard cap. Voices are pruned by their
 * scheduled end time (no per-voice `onended` callback, no per-frame garbage).
 */
export class Poly {
  constructor(max = 16) { this.max = max; this.live = []; this._id = 0; }
  /** entry = { end, stop(t), prio } */
  add(entry) {
    entry.id = ++this._id;
    if (this.live.length >= this.max) {
      // steal the lowest priority, oldest voice
      let worst = 0;
      for (let i = 1; i < this.live.length; i++) {
        const a = this.live[i], b = this.live[worst];
        if ((a.prio ?? 1) < (b.prio ?? 1) || ((a.prio ?? 1) === (b.prio ?? 1) && a.id < b.id)) worst = i;
      }
      const v = this.live[worst];
      if (v && v.stop) { try { v.stop(); } catch (e) { /* voice already gone */ } }
      this.live.splice(worst, 1);
    }
    this.live.push(entry);
    return entry;
  }
  /** Drop finished voices. Called from lateUpdate; O(live), no allocation. */
  prune(now) {
    const L = this.live;
    let w = 0;
    for (let i = 0; i < L.length; i++) { if (L[i].end > now) L[w++] = L[i]; }
    L.length = w;
  }
  stopAll(t) { for (const v of this.live) { if (v.stop) { try { v.stop(t); } catch (e) { /* ignore */ } } } this.live.length = 0; }
  get count() { return this.live.length; }
}

export { EPS };
