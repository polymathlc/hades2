// OWNER: AGENT-AUDIO
// ---------------------------------------------------------------------------
// src/audio/sfx.js — the complete sound-effect set, synthesised.
//
// Every effect is a RECIPE: a function (K, t, p) that schedules nodes on the
// audio clock and returns the time it finishes.
//   K = the kit  { ac, dest, rev, dly, noise(kind), banks, rnd() }
//   t = start time on the audio clock
//   p = { gain, pitch, rnd, variation, revSend, dlySend }
//
// Variation is not decoration — it is the difference between a game and a
// slot machine. Every recipe reads p.rnd() for pitch, timbre and timing so the
// third sword swing in a second never sounds like the first.
// ---------------------------------------------------------------------------

import {
  adsr, sweep, gain, filter, osc, src, noise, wave, shaper, fmVoice, stackVoice,
  midiToFreq, clamp, lerp, TAU,
} from './synth.js';

// ── local helpers ──────────────────────────────────────────────────────────
// K.pitch is the §2.10 `pitch` argument. Every primitive scales its frequencies
// by it, so one number retunes a whole recipe — a brute's death is the same
// recipe as a shade's, an octave down.
const pit = (K) => (K.pitch || 1);


/** A band-passed noise burst — the backbone of swings, impacts and drums. */
function nz(K, t, o = {}) {
  const ac = K.ac;
  const b = noise(K.ac, o.kind || 'white');
  const g = gain(ac, 0);
  const P = pit(K);
  const f = filter(ac, o.type || 'bandpass', (o.f0 ?? 1200) * P, o.q ?? 1.2);
  const dest = o.dest || K.dest;
  src(ac, f, b, t, { rate: o.rate ?? 1, offset: (o.off ?? (K.rnd() * 1.6)), stop: t + (o.dur ?? 0.2) + 0.08 });
  f.connect(g); g.connect(dest);
  if (o.f1 != null) sweep(f.frequency, t, (o.f0 ?? 1200) * P, o.f1 * P, o.sweepT ?? (o.dur ?? 0.2));
  adsr(g.gain, t, { peak: o.gain ?? 0.4, a: o.a ?? 0.004, d: o.d ?? (o.dur ?? 0.2) * 0.5, s: o.s ?? 0, hold: o.hold ?? 0, r: o.r ?? (o.dur ?? 0.2) * 0.6 });
  return t + (o.dur ?? 0.2) + 0.1;
}

/** A pitched sine/whatever body with a frequency drop — drums and thumps. */
function body(K, t, o = {}) {
  const ac = K.ac;
  const g = gain(ac, 0);
  const dest = o.dest || K.dest;
  g.connect(dest);
  const dur = (o.a ?? 0.002) + (o.d ?? 0.25) + (o.r ?? 0.1);
  const P = pit(K);
  const o1 = osc(ac, g, o.wave || 'sine', (o.f0 ?? 140) * P, t, t + dur + 0.05);
  if (o.f1 != null) sweep(o1.frequency, t, (o.f0 ?? 140) * P, o.f1 * P, o.pitchT ?? Math.min(dur, o.d ?? 0.25) * 0.55);
  adsr(g.gain, t, { peak: o.gain ?? 0.5, a: o.a ?? 0.002, d: o.d ?? 0.25, s: o.s ?? 0, r: o.r ?? 0.1 });
  return t + dur + 0.05;
}

/** A short metallic ring — swords, shields, bells, chains. */
function metal(K, t, o = {}) {
  const f = (o.f ?? 2400) * pit(K);
  const g = o.gain ?? 0.18;
  let end = t;
  const parts = o.parts ?? [1, 1.71, 2.43, 3.19];
  for (let i = 0; i < parts.length; i++) {
    const e = fmVoice(K.ac, o.dest || K.dest, t + i * 0.0018, f * parts[i], {
      ratio: 1.41 + i * 0.13, index: (o.index ?? 260) / (i + 1), indexEnd: 0.03,
      a: 0.001, d: (o.d ?? 0.5) / (1 + i * 0.55), r: (o.r ?? 0.35) / (1 + i * 0.4),
      gain: g / (1 + i * 1.1), wave: 'sine',
    });
    end = Math.max(end, e.end);
  }
  return end;
}

/** A swept whoosh — the air a weapon moves. */
function whoosh(K, t, o = {}) {
  const dur = o.dur ?? 0.26;
  const P = pit(K);
  const lo = (o.lo ?? 320) * P, hi = (o.hi ?? 3400) * P;
  const ac = K.ac;
  const g = gain(ac, 0);
  const bp = filter(ac, 'bandpass', lo, o.q ?? 1.6);
  const hp = filter(ac, 'highpass', 180, 0.7);
  src(ac, bp, noise(ac, o.kind || 'white'), t, { rate: o.rate ?? 1, offset: K.rnd() * 1.5, stop: t + dur + 0.1 });
  bp.connect(hp); hp.connect(g); g.connect(o.dest || K.dest);
  // up then down: the doppler shape of a blade passing the ear
  bp.frequency.setValueAtTime(lo, t);
  bp.frequency.exponentialRampToValueAtTime(hi, t + dur * 0.42);
  bp.frequency.exponentialRampToValueAtTime(lo * 0.7, t + dur);
  adsr(g.gain, t, { peak: o.gain ?? 0.42, a: dur * 0.22, d: dur * 0.3, s: 0.5, hold: 0, r: dur * 0.6, curve: 'lin' });
  return t + dur + 0.12;
}

/** A tonal formant growl/shriek — enemy voices. */
function voice(K, t, o = {}) {
  const ac = K.ac;
  const P = pit(K), FP = Math.pow(P, 0.6);   // formants move less than pitch:
  const dur = o.dur ?? 0.42;                  // a bigger throat, not a faster tape
  const f0 = (o.f0 ?? 150) * P;
  const g = gain(ac, 0);
  const out = o.dest || K.dest;
  g.connect(out);
  const src1 = ac.createOscillator();
  src1.setPeriodicWave(wave(ac, o.wave || 'reed'));
  src1.frequency.setValueAtTime(f0, t);
  if (o.f1 != null) sweep(src1.frequency, t, f0, o.f1 * P, dur * 0.85);
  // growl: an audio-rate-ish AM makes a throat rather than a synth
  const am = ac.createOscillator(); am.type = 'sine';
  am.frequency.setValueAtTime(o.growl ?? 28, t);
  const amg = gain(ac, o.growlDepth ?? 0.35);
  const vca = gain(ac, 1 - (o.growlDepth ?? 0.35));
  am.connect(amg); amg.connect(vca.gain);
  // parallel formants: a fixed vowel that does not follow pitch
  const forms = o.forms || [[520, 6, 1], [1180, 8, 0.5], [2600, 9, 0.18]];
  const mix = gain(ac, 1);
  for (const [ff, q, amp] of forms) {
    const bp = filter(ac, 'bandpass', ff * FP, q);
    const bg = gain(ac, amp);
    vca.connect(bp); bp.connect(bg); bg.connect(mix);
  }
  vca.connect(gain(ac, 0.22)).connect(mix); // a little dry so it is not hollow
  src1.connect(vca); mix.connect(g);
  // breath
  if (o.breath !== 0) {
    const bn = filter(ac, 'bandpass', (o.breathF ?? 1500) * FP, 0.9);
    const bg2 = gain(ac, o.breath ?? 0.22);
    src(ac, bn, noise(ac, 'pink'), t, { offset: K.rnd() * 1.4, stop: t + dur + 0.1 });
    bn.connect(bg2); bg2.connect(g);
  }
  src1.start(t); am.start(t);
  src1.stop(t + dur + 0.1); am.stop(t + dur + 0.1);
  adsr(g.gain, t, { peak: o.gain ?? 0.4, a: o.a ?? 0.02, d: dur * 0.3, s: o.s ?? 0.55, hold: dur * 0.35, r: o.r ?? dur * 0.5 });
  return t + dur + 0.2;
}

/** A rising or falling shimmer of tuned partials — magic, boons, unseals. */
function shimmer(K, t, o = {}) {
  const notes = o.notes || [0, 4, 7, 11, 14];
  const base = (o.base ?? 72) + 12 * Math.log2(pit(K));
  const dur = o.dur ?? 0.9;
  const stag = o.stagger ?? 0.045;
  let end = t;
  for (let i = 0; i < notes.length; i++) {
    const tt = t + i * stag * (o.reverse ? 1 : 1);
    const m = base + notes[o.reverse ? notes.length - 1 - i : i];
    const e = fmVoice(K.ac, o.dest || K.dest, tt, midiToFreq(m), {
      ratio: o.ratio ?? 3.01, index: o.index ?? 140, indexEnd: 0.02,
      a: 0.004, d: dur * 0.35, r: dur * 0.7, gain: (o.gain ?? 0.20) * (1 - i * 0.11),
      wave: 'sine',
    });
    end = Math.max(end, e.end);
  }
  return end;
}

// ═══════════════════════════════════════════════════════════════════════════
// THE RECIPES
// ═══════════════════════════════════════════════════════════════════════════
// Naming: <family>.<action>[.<variant>]. Everything another system already
// calls is here; extras are grouped at the bottom.

export const RECIPES = {

  // ── blade (the sword) ────────────────────────────────────────────────────
  'blade.swing1': (K, t, p) => {
    const r = p.rnd, k = 1 + (r() - 0.5) * 0.16;
    whoosh(K, t, { dur: 0.20 * k, lo: 420, hi: 3900 * k, gain: 0.42 * p.gain, q: 1.9 });
    nz(K, t + 0.012, { f0: 5200 * k, q: 2.4, dur: 0.06, gain: 0.16 * p.gain });
    return t + 0.34;
  },
  'blade.swing2': (K, t, p) => {
    const r = p.rnd, k = 1 + (r() - 0.5) * 0.16;
    whoosh(K, t, { dur: 0.23 * k, lo: 300, hi: 3200 * k, gain: 0.46 * p.gain, q: 1.6 });
    nz(K, t + 0.014, { f0: 4200 * k, q: 2.0, dur: 0.07, gain: 0.17 * p.gain });
    return t + 0.38;
  },
  'blade.lunge': (K, t, p) => {
    const r = p.rnd, k = 1 + (r() - 0.5) * 0.12;
    whoosh(K, t, { dur: 0.34 * k, lo: 220, hi: 2600 * k, gain: 0.52 * p.gain, q: 1.2 });
    body(K, t, { f0: 190, f1: 70, d: 0.16, gain: 0.22 * p.gain, wave: 'triangle' });
    metal(K, t + 0.05, { f: 1900 * k, gain: 0.07 * p.gain, d: 0.35 });
    return t + 0.5;
  },
  'blade.dashcut': (K, t, p) => {
    const r = p.rnd, k = 1 + (r() - 0.5) * 0.14;
    whoosh(K, t, { dur: 0.16, lo: 700, hi: 6200 * k, gain: 0.44 * p.gain, q: 2.6 });
    nz(K, t, { f0: 7200 * k, f1: 2400, q: 1.6, dur: 0.10, gain: 0.20 * p.gain });
    return t + 0.3;
  },
  'blade.sweep': (K, t, p) => {
    const r = p.rnd, k = 1 + (r() - 0.5) * 0.1;
    whoosh(K, t, { dur: 0.44 * k, lo: 180, hi: 2900, gain: 0.58 * p.gain, q: 1.0 });
    whoosh(K, t + 0.06, { dur: 0.34, lo: 500, hi: 4600, gain: 0.30 * p.gain, q: 2.2 });
    body(K, t, { f0: 130, f1: 52, d: 0.3, gain: 0.26 * p.gain, wave: 'triangle' });
    return t + 0.66;
  },

  // ── spear ────────────────────────────────────────────────────────────────
  'spear.poke1': (K, t, p) => {
    const r = p.rnd, k = 1 + (r() - 0.5) * 0.18;
    whoosh(K, t, { dur: 0.13, lo: 900, hi: 5200 * k, gain: 0.36 * p.gain, q: 3.0 });
    nz(K, t, { f0: 3000 * k, f1: 900, q: 1.4, dur: 0.07, gain: 0.16 * p.gain });
    return t + 0.26;
  },
  'spear.poke2': (K, t, p) => {
    const r = p.rnd, k = 1 + (r() - 0.5) * 0.18;
    whoosh(K, t, { dur: 0.15, lo: 760, hi: 4400 * k, gain: 0.40 * p.gain, q: 2.6 });
    metal(K, t + 0.01, { f: 3100 * k, gain: 0.05 * p.gain, d: 0.2, parts: [1, 2.1] });
    return t + 0.3;
  },
  'spear.spin': (K, t, p) => {
    const r = p.rnd;
    // three passes of the shaft, accelerating
    let tt = t;
    for (let i = 0; i < 3; i++) {
      whoosh(K, tt, { dur: 0.20 - i * 0.03, lo: 260 + i * 90, hi: 2800 + i * 700, gain: (0.34 + i * 0.06) * p.gain, q: 1.5 });
      tt += 0.16 - i * 0.025 + r() * 0.01;
    }
    body(K, t, { f0: 120, f1: 60, d: 0.4, gain: 0.2 * p.gain, wave: 'triangle' });
    return tt + 0.3;
  },
  'spear.throw': (K, t, p) => {
    const r = p.rnd, k = 1 + (r() - 0.5) * 0.1;
    whoosh(K, t, { dur: 0.5, lo: 1400, hi: 380 * k, gain: 0.5 * p.gain, q: 2.2 });
    metal(K, t, { f: 2200, gain: 0.09 * p.gain, d: 0.5, r: 0.5 });
    body(K, t, { f0: 240, f1: 90, d: 0.1, gain: 0.2 * p.gain });
    return t + 0.7;
  },
  'spear.recall': (K, t, p) => {
    const r = p.rnd;
    // rising, doppler-in
    const ac = K.ac, g = gain(ac, 0), bp = filter(ac, 'bandpass', 300, 2.4);
    src(ac, bp, noise(ac, 'white'), t, { offset: r() * 1.2, stop: t + 0.52 });
    bp.connect(g); g.connect(K.dest);
    sweep(bp.frequency, t, 300, 4200, 0.42);
    adsr(g.gain, t, { peak: 0.34 * p.gain, a: 0.3, d: 0.06, s: 0.7, r: 0.14, curve: 'lin' });
    metal(K, t + 0.4, { f: 2600, gain: 0.13 * p.gain, d: 0.4 });
    return t + 0.8;
  },

  // ── bow ──────────────────────────────────────────────────────────────────
  'bow.loose': (K, t, p) => {
    const r = p.rnd, k = 1 + (r() - 0.5) * 0.14;
    // string release: a very short pitched snap + air
    body(K, t, { f0: 320 * k, f1: 90, d: 0.05, r: 0.05, gain: 0.30 * p.gain, wave: 'triangle' });
    nz(K, t, { f0: 2600 * k, f1: 700, q: 1.1, dur: 0.09, gain: 0.24 * p.gain, a: 0.001 });
    whoosh(K, t + 0.02, { dur: 0.22, lo: 1200, hi: 3600, gain: 0.20 * p.gain, q: 2.4 });
    return t + 0.36;
  },
  'bow.power': (K, t, p) => {
    const r = p.rnd, k = 1 + (r() - 0.5) * 0.08;
    body(K, t, { f0: 200 * k, f1: 55, d: 0.10, r: 0.1, gain: 0.44 * p.gain, wave: 'triangle' });
    nz(K, t, { f0: 1800 * k, f1: 420, q: 0.9, dur: 0.16, gain: 0.32 * p.gain, a: 0.001 });
    whoosh(K, t + 0.02, { dur: 0.4, lo: 900, hi: 3000, gain: 0.28 * p.gain, q: 1.8 });
    metal(K, t, { f: 1500, gain: 0.08 * p.gain, d: 0.6, r: 0.5, parts: [1, 2.4, 3.9] });
    return t + 0.7;
  },
  'bow.kick': (K, t, p) => {
    const r = p.rnd;
    body(K, t, { f0: 160, f1: 48, d: 0.13, gain: 0.42 * p.gain });
    nz(K, t, { f0: 800, f1: 220, q: 0.8, dur: 0.14, gain: 0.24 * p.gain, kind: 'pink' });
    whoosh(K, t, { dur: 0.2, lo: 400, hi: 1800, gain: 0.22 * p.gain });
    return t + 0.36;
  },

  // ── shield ───────────────────────────────────────────────────────────────
  'shield.bash1': (K, t, p) => {
    const r = p.rnd, k = 1 + (r() - 0.5) * 0.12;
    body(K, t, { f0: 150 * k, f1: 44, d: 0.20, gain: 0.5 * p.gain });
    metal(K, t, { f: 620 * k, gain: 0.16 * p.gain, d: 0.55, r: 0.4, index: 90, parts: [1, 1.63, 2.29, 3.11] });
    nz(K, t, { f0: 1400, f1: 380, q: 0.7, dur: 0.18, gain: 0.20 * p.gain, kind: 'pink' });
    return t + 0.6;
  },
  'shield.bash2': (K, t, p) => {
    const r = p.rnd, k = 1 + (r() - 0.5) * 0.12;
    body(K, t, { f0: 120 * k, f1: 38, d: 0.28, gain: 0.56 * p.gain });
    metal(K, t, { f: 520 * k, gain: 0.18 * p.gain, d: 0.7, r: 0.5, index: 80 });
    nz(K, t, { f0: 1100, f1: 300, q: 0.7, dur: 0.24, gain: 0.22 * p.gain, kind: 'pink' });
    return t + 0.8;
  },
  'shield.block': (K, t, p) => {
    // the brace: a low woody thunk and a bronze ring taking the load
    body(K, t, { f0: 210, f1: 96, d: 0.12, gain: 0.34 * p.gain, wave: 'triangle' });
    metal(K, t, { f: 780, gain: 0.13 * p.gain, d: 0.4, index: 60 });
    return t + 0.5;
  },
  'shield.reflect': (K, t, p) => {
    const r = p.rnd;
    metal(K, t, { f: 1700 + r() * 300, gain: 0.24 * p.gain, d: 0.5, r: 0.5, index: 320, parts: [1, 1.78, 2.71, 3.9] });
    shimmer(K, t + 0.01, { base: 84, notes: [0, 7, 12], dur: 0.5, gain: 0.10 * p.gain, stagger: 0.02, ratio: 2.0 });
    nz(K, t, { f0: 5000, f1: 9000, q: 1.2, dur: 0.10, gain: 0.14 * p.gain });
    return t + 0.7;
  },
  'shield.rush': (K, t, p) => {
    whoosh(K, t, { dur: 0.42, lo: 160, hi: 1500, gain: 0.5 * p.gain, q: 0.9, kind: 'brown' });
    body(K, t, { f0: 90, f1: 42, d: 0.35, gain: 0.30 * p.gain });
    metal(K, t + 0.02, { f: 460, gain: 0.07 * p.gain, d: 0.5 });
    return t + 0.6;
  },

  // ── generic combat ───────────────────────────────────────────────────────
  'hit': (K, t, p) => {
    const r = p.rnd, k = 1 + (r() - 0.5) * 0.24;
    body(K, t, { f0: 180 * k, f1: 60, d: 0.09, r: 0.06, gain: 0.34 * p.gain, wave: 'triangle' });
    nz(K, t, { f0: 900 * k, f1: 260, q: 0.9, dur: 0.09, gain: 0.30 * p.gain, kind: 'pink', a: 0.001 });
    nz(K, t, { f0: 3600 * k, q: 1.6, dur: 0.035, gain: 0.13 * p.gain, a: 0.0008 });
    return t + 0.22;
  },
  'crit': (K, t, p) => {
    const r = p.rnd;
    RECIPES.hit(K, t, { ...p, gain: p.gain * 1.05 });
    metal(K, t + 0.004, { f: 2900 + r() * 400, gain: 0.16 * p.gain, d: 0.45, r: 0.35, index: 400 });
    body(K, t, { f0: 70, f1: 34, d: 0.24, gain: 0.30 * p.gain });
    return t + 0.55;
  },
  'stagger': (K, t, p) => {
    body(K, t, { f0: 96, f1: 40, d: 0.26, gain: 0.36 * p.gain });
    nz(K, t, { f0: 420, f1: 150, q: 0.6, dur: 0.3, gain: 0.18 * p.gain, kind: 'brown' });
    metal(K, t, { f: 340, gain: 0.06 * p.gain, d: 0.5, index: 40 });
    return t + 0.55;
  },
  'block': (K, t, p) => RECIPES['shield.block'](K, t, p),
  'lunge': (K, t, p) => {
    whoosh(K, t, { dur: 0.28, lo: 240, hi: 2200, gain: 0.42 * p.gain, q: 1.3, kind: 'brown' });
    voice(K, t, { f0: 220, f1: 150, dur: 0.22, gain: 0.24 * p.gain, growl: 42, forms: [[420, 5, 1], [1300, 7, 0.4]] });
    return t + 0.5;
  },
  'charge.full': (K, t, p) => {
    shimmer(K, t, { base: 74, notes: [0, 5, 9, 12], dur: 0.55, gain: 0.16 * p.gain, stagger: 0.028, ratio: 1.5, index: 90 });
    body(K, t, { f0: 300, f1: 600, d: 0.16, gain: 0.14 * p.gain, wave: 'triangle', pitchT: 0.14 });
    return t + 0.8;
  },

  // ── impacts by material ──────────────────────────────────────────────────
  'impact.flesh': (K, t, p) => {
    const r = p.rnd, k = 1 + (r() - 0.5) * 0.3;
    body(K, t, { f0: 150 * k, f1: 45, d: 0.10, r: 0.07, gain: 0.36 * p.gain, wave: 'triangle' });
    nz(K, t, { f0: 620 * k, f1: 180, q: 0.6, dur: 0.13, gain: 0.30 * p.gain, kind: 'brown', a: 0.001 });
    nz(K, t + 0.006, { f0: 2400 * k, q: 1.1, dur: 0.05, gain: 0.10 * p.gain });
    return t + 0.26;
  },
  'impact.bone': (K, t, p) => {
    const r = p.rnd, k = 1 + (r() - 0.5) * 0.22;
    nz(K, t, { f0: 2600 * k, f1: 900, q: 2.2, dur: 0.06, gain: 0.28 * p.gain, a: 0.0006 });
    metal(K, t, { f: 1400 * k, gain: 0.07 * p.gain, d: 0.12, r: 0.1, index: 700, parts: [1, 2.7, 5.1] });
    body(K, t, { f0: 220 * k, f1: 90, d: 0.06, gain: 0.20 * p.gain, wave: 'triangle' });
    return t + 0.25;
  },
  'impact.stone': (K, t, p) => {
    const r = p.rnd, k = 1 + (r() - 0.5) * 0.24;
    nz(K, t, { f0: 1300 * k, f1: 320, q: 0.8, dur: 0.13, gain: 0.40 * p.gain, kind: 'pink', a: 0.0006 });
    body(K, t, { f0: 110 * k, f1: 52, d: 0.11, gain: 0.15 * p.gain });
    nz(K, t + 0.02, { f0: 4200, f1: 1800, q: 1.1, dur: 0.16, gain: 0.16 * p.gain });   // grit
    return t + 0.3;
  },
  'impact.metal': (K, t, p) => {
    const r = p.rnd, k = 1 + (r() - 0.5) * 0.2;
    metal(K, t, { f: 1800 * k, gain: 0.22 * p.gain, d: 0.5, r: 0.4, index: 500, parts: [1, 1.83, 2.61, 3.77, 5.2] });
    nz(K, t, { f0: 6200, f1: 2600, q: 1.0, dur: 0.06, gain: 0.16 * p.gain, a: 0.0005 });
    body(K, t, { f0: 200 * k, f1: 80, d: 0.06, gain: 0.16 * p.gain });
    return t + 0.6;
  },
  'impact.wood': (K, t, p) => {
    const r = p.rnd, k = 1 + (r() - 0.5) * 0.22;
    body(K, t, { f0: 260 * k, f1: 150, d: 0.08, gain: 0.30 * p.gain, wave: 'triangle' });
    nz(K, t, { f0: 1500 * k, f1: 500, q: 1.6, dur: 0.07, gain: 0.18 * p.gain, kind: 'pink' });
    return t + 0.22;
  },
  'impact.fire': (K, t, p) => {
    const r = p.rnd;
    nz(K, t, { f0: 500, f1: 2600, q: 0.5, dur: 0.30, gain: 0.42 * p.gain, kind: 'brown', a: 0.004, sweepT: 0.22 });
    body(K, t, { f0: 90, f1: 40, d: 0.20, gain: 0.17 * p.gain });
    nz(K, t + 0.01, { f0: 3800, f1: 8000, q: 0.8, dur: 0.35, gain: 0.16 * p.gain });
    return t + 0.5;
  },
  'impact.lightning': (K, t, p) => {
    const r = p.rnd;
    nz(K, t, { f0: 9000, f1: 2200, q: 0.6, dur: 0.09, gain: 0.34 * p.gain, a: 0.0004 });
    body(K, t, { f0: 130, f1: 44, d: 0.20, gain: 0.30 * p.gain });
    // the crack: fast repeated bursts
    for (let i = 0; i < 4; i++) nz(K, t + 0.012 * i + r() * 0.004, { f0: 5000 + r() * 5000, q: 3, dur: 0.02, gain: 0.13 * p.gain });
    metal(K, t, { f: 3600, gain: 0.07 * p.gain, d: 0.3, index: 900, parts: [1, 2.9] });
    return t + 0.45;
  },
  'impact.frost': (K, t, p) => {
    const r = p.rnd;
    nz(K, t, { f0: 7000, f1: 12000, q: 1.0, dur: 0.22, gain: 0.18 * p.gain });
    metal(K, t, { f: 4200 + r() * 600, gain: 0.16 * p.gain, d: 0.55, r: 0.5, index: 240, parts: [1, 2.13, 3.41, 4.8] });
    body(K, t, { f0: 160, f1: 70, d: 0.12, gain: 0.18 * p.gain, wave: 'triangle' });
    return t + 0.6;
  },
  'impact.poison': (K, t, p) => {
    nz(K, t, { f0: 700, f1: 2400, q: 0.7, dur: 0.34, gain: 0.24 * p.gain, kind: 'pink', a: 0.02 });
    body(K, t, { f0: 190, f1: 80, d: 0.2, gain: 0.20 * p.gain, wave: 'triangle' });
    // bubbles
    const r = p.rnd;
    for (let i = 0; i < 5; i++) body(K, t + 0.03 + r() * 0.25, { f0: 300 + r() * 500, f1: 900, d: 0.04, r: 0.03, gain: 0.07 * p.gain, wave: 'sine', pitchT: 0.03 });
    return t + 0.5;
  },
  'impact.arcane': (K, t, p) => {
    shimmer(K, t, { base: 68, notes: [0, 3, 7, 10, 15], dur: 0.6, gain: 0.14 * p.gain, stagger: 0.012, ratio: 2.51, index: 260 });
    body(K, t, { f0: 120, f1: 50, d: 0.18, gain: 0.24 * p.gain });
    nz(K, t, { f0: 3200, f1: 900, q: 1.2, dur: 0.14, gain: 0.12 * p.gain });
    return t + 0.8;
  },

  // ── player ───────────────────────────────────────────────────────────────
  'dash': (K, t, p) => {
    const r = p.rnd, k = 1 + (r() - 0.5) * 0.14;
    whoosh(K, t, { dur: 0.30, lo: 300 * k, hi: 2600 * k, gain: 0.44 * p.gain, q: 1.1, kind: 'brown' });
    nz(K, t, { f0: 5200, f1: 1400, q: 1.0, dur: 0.13, gain: 0.14 * p.gain });
    body(K, t, { f0: 120, f1: 46, d: 0.12, gain: 0.16 * p.gain });
    return t + 0.45;
  },
  'dash.ready': (K, t, p) => {
    shimmer(K, t, { base: 86, notes: [0, 7], dur: 0.35, gain: 0.07 * p.gain, stagger: 0.03, ratio: 2.0, index: 60 });
    return t + 0.45;
  },
  'hurt': (K, t, p) => {
    const r = p.rnd;
    // a body impact + a short human grunt + a low pressure drop
    body(K, t, { f0: 130, f1: 42, d: 0.16, gain: 0.42 * p.gain });
    nz(K, t, { f0: 700, f1: 200, q: 0.6, dur: 0.14, gain: 0.26 * p.gain, kind: 'brown', a: 0.001 });
    voice(K, t + 0.01, {
      f0: 190 + r() * 30, f1: 120, dur: 0.24, gain: 0.26 * p.gain, growl: 34, growlDepth: 0.4,
      forms: [[600, 6, 1], [1200, 8, 0.45], [2500, 9, 0.15]], breath: 0.3,
    });
    return t + 0.5;
  },
  'player.death': (K, t, p) => {
    const r = p.rnd;
    voice(K, t, { f0: 200, f1: 62, dur: 1.1, gain: 0.34 * p.gain, growl: 22, growlDepth: 0.5, a: 0.01, forms: [[520, 5, 1], [1050, 7, 0.5], [2400, 8, 0.2]], breath: 0.35 });
    body(K, t + 0.1, { f0: 90, f1: 28, d: 0.9, r: 0.5, gain: 0.34 * p.gain });
    nz(K, t + 0.05, { f0: 2400, f1: 300, q: 0.6, dur: 1.2, gain: 0.14 * p.gain, kind: 'pink', a: 0.05 });
    return t + 1.8;
  },
  'heartbeat': (K, t, p) => {
    body(K, t, { f0: 66, f1: 34, d: 0.16, r: 0.1, gain: 0.52 * p.gain, wave: 'sine' });
    body(K, t + 0.20, { f0: 58, f1: 30, d: 0.20, r: 0.12, gain: 0.38 * p.gain, wave: 'sine' });
    return t + 0.6;
  },

  // ── enemies ──────────────────────────────────────────────────────────────
  'telegraph': (K, t, p) => {
    const r = p.rnd;
    const base = 240 * (K.pitch || 1);   // built from raw oscillators, so it applies K.pitch itself
    // a rising, slightly detuned two-tone warning — reads over a busy mix
    const ac = K.ac, g = gain(ac, 0);
    g.connect(K.dest);
    const f = filter(ac, 'bandpass', base * 2, 3);
    f.connect(g);
    const o1 = osc(ac, f, 'reed', base, t, t + 0.42);
    const o2 = osc(ac, f, 'reed', base * 1.0075, t, t + 0.42);
    sweep(o1.frequency, t, base, base * 1.34, 0.30);
    sweep(o2.frequency, t, base * 1.0075, base * 1.35, 0.30);
    sweep(f.frequency, t, base * 1.6, base * 4.2, 0.3);
    adsr(g.gain, t, { peak: 0.20 * p.gain, a: 0.03, d: 0.10, s: 0.6, hold: 0.14, r: 0.14, curve: 'lin' });
    nz(K, t, { f0: 900, f1: 3000, q: 1.4, dur: 0.3, gain: 0.06 * p.gain, kind: 'pink', a: 0.1 });
    return t + 0.55;
  },
  'boss.telegraph': (K, t, p) => {
    const r = p.rnd;
    const kp = K.pitch; K.pitch = (kp || 1) * 0.62;
    RECIPES.telegraph(K, t, { ...p, gain: p.gain * 0.8 });
    K.pitch = kp;
    body(K, t, { f0: 58, f1: 92, d: 0.5, r: 0.25, gain: 0.34 * p.gain, wave: 'triangle', pitchT: 0.45 });
    metal(K, t + 0.02, { f: 320, gain: 0.10 * p.gain, d: 0.9, r: 0.7, index: 120, parts: [1, 1.41, 2.13] });
    voice(K, t + 0.05, { f0: 90, f1: 74, dur: 0.6, gain: 0.16 * p.gain, growl: 17, growlDepth: 0.55, forms: [[300, 5, 1], [820, 6, 0.5], [1900, 8, 0.2]] });
    return t + 1.1;
  },
  'boss.roar': (K, t, p) => {
    voice(K, t, { f0: 78, f1: 56, dur: 1.5, gain: 0.44 * p.gain, growl: 15, growlDepth: 0.6, a: 0.06,
      forms: [[260, 4, 1], [700, 5, 0.6], [1500, 7, 0.28], [3000, 9, 0.1]], breath: 0.3 });
    body(K, t, { f0: 44, f1: 30, d: 1.2, r: 0.6, gain: 0.36 * p.gain });
    nz(K, t, { f0: 200, f1: 1200, q: 0.4, dur: 1.4, gain: 0.16 * p.gain, kind: 'brown', a: 0.15 });
    return t + 2.2;
  },
  'boss.phase': (K, t, p) => {
    metal(K, t, { f: 180, gain: 0.26 * p.gain, d: 2.0, r: 1.6, index: 200, parts: [1, 1.52, 2.24, 3.1, 4.4] });
    body(K, t, { f0: 40, f1: 26, d: 1.4, r: 0.8, gain: 0.42 * p.gain });
    shimmer(K, t + 0.02, { base: 48, notes: [0, 1, 5, 8], dur: 1.6, gain: 0.12 * p.gain, stagger: 0.05, ratio: 1.41, index: 300 });
    return t + 2.6;
  },
  'enemySpawn': (K, t, p) => {
    const r = p.rnd;
    nz(K, t, { f0: 260, f1: 1800, q: 0.8, dur: 0.4, gain: 0.20 * p.gain, kind: 'pink', a: 0.14 });
    shimmer(K, t + 0.05, { base: 55, notes: [0, 6, 11], dur: 0.5, gain: 0.09 * p.gain, stagger: 0.03, ratio: 1.71, index: 220, reverse: true });
    body(K, t, { f0: 150, f1: 60, d: 0.3, gain: 0.16 * p.gain, wave: 'triangle' });
    return t + 0.7;
  },
  'enemyDeath': (K, t, p) => {
    const r = p.rnd, k = 0.9 + r() * 0.3;
    voice(K, t, { f0: 200 * k, f1: 70 * k, dur: 0.5, gain: 0.30 * p.gain, growl: 26, growlDepth: 0.5,
      forms: [[480, 5, 1], [1150, 7, 0.5], [2500, 9, 0.18]], breath: 0.28 });
    nz(K, t + 0.06, { f0: 2200, f1: 260, q: 0.6, dur: 0.6, gain: 0.16 * p.gain, kind: 'pink', a: 0.03 });
    body(K, t, { f0: 110, f1: 40, d: 0.35, gain: 0.22 * p.gain });
    return t + 0.9;
  },

  // per-family vocalisations (index.js maps enemy kind -> these)
  'voc.shade':  (K, t, p) => voice(K, t, { f0: 210, f1: 160, dur: 0.34, gain: 0.26 * p.gain, growl: 30, forms: [[540, 6, 1], [1250, 8, 0.45], [2600, 9, 0.16]] }),
  'voc.brute':  (K, t, p) => voice(K, t, { f0: 96,  f1: 74,  dur: 0.6,  gain: 0.34 * p.gain, growl: 18, growlDepth: 0.55, forms: [[320, 5, 1], [820, 6, 0.5], [1800, 8, 0.2]] }),
  'voc.hound':  (K, t, p) => voice(K, t, { f0: 330, f1: 190, dur: 0.22, gain: 0.28 * p.gain, growl: 48, growlDepth: 0.45, forms: [[760, 7, 1], [1600, 9, 0.5], [3000, 10, 0.2]], breath: 0.3 }),
  'voc.bloat':  (K, t, p) => voice(K, t, { f0: 130, f1: 175, dur: 0.5,  gain: 0.26 * p.gain, growl: 12, growlDepth: 0.6, forms: [[380, 4, 1], [900, 6, 0.4]], breath: 0.4, wave: 'pulse' }),
  'voc.hexer':  (K, t, p) => { voice(K, t, { f0: 260, f1: 300, dur: 0.5, gain: 0.20 * p.gain, growl: 22, forms: [[600, 8, 1], [1900, 10, 0.5], [3200, 11, 0.25]] });
                               shimmer(K, t, { base: 70, notes: [0, 1, 6], dur: 0.5, gain: 0.07 * p.gain, stagger: 0.04, ratio: 2.71 }); return t + 0.7; },
  'voc.herald': (K, t, p) => { voice(K, t, { f0: 165, f1: 220, dur: 0.6, gain: 0.24 * p.gain, growl: 20, forms: [[440, 6, 1], [1400, 8, 0.55], [2800, 9, 0.2]] });
                               metal(K, t, { f: 900, gain: 0.07 * p.gain, d: 0.7, index: 140 }); return t + 0.85; },
  'voc.warden': (K, t, p) => RECIPES['boss.roar'](K, t, { ...p, gain: p.gain * 0.7 }),

  // per-family deaths
  'death.shade':  (K, t, p) => { RECIPES.enemyDeath(K, t, p); shimmer(K, t + 0.05, { base: 62, notes: [0, 1, 6], dur: 0.7, gain: 0.07 * p.gain, stagger: 0.05, reverse: true }); return t + 1.0; },
  'death.brute':  (K, t, p) => { const kp = K.pitch; K.pitch = (kp || 1) * 0.62; RECIPES.enemyDeath(K, t, p); K.pitch = kp; body(K, t + 0.18, { f0: 70, f1: 30, d: 0.5, r: 0.3, gain: 0.34 * p.gain }); RECIPES['impact.stone'](K, t + 0.24, { ...p, gain: p.gain * 0.7 }); return t + 1.2; },
  'death.hound':  (K, t, p) => { voice(K, t, { f0: 420, f1: 120, dur: 0.35, gain: 0.30 * p.gain, growl: 44, forms: [[820, 7, 1], [1700, 9, 0.5]], breath: 0.3 }); RECIPES['impact.flesh'](K, t + 0.1, p); return t + 0.7; },
  'death.bloat':  (K, t, p) => { RECIPES['impact.poison'](K, t, { ...p, gain: p.gain * 1.2 }); body(K, t, { f0: 110, f1: 34, d: 0.4, gain: 0.42 * p.gain }); nz(K, t, { f0: 400, f1: 2000, q: 0.5, dur: 0.6, gain: 0.24 * p.gain, kind: 'brown', a: 0.002 }); return t + 0.9; },
  'death.hexer':  (K, t, p) => { RECIPES['impact.arcane'](K, t, p); voice(K, t, { f0: 280, f1: 90, dur: 0.5, gain: 0.22 * p.gain, growl: 26, forms: [[620, 8, 1], [2000, 10, 0.4]] }); return t + 1.0; },
  'death.herald': (K, t, p) => { RECIPES.enemyDeath(K, t, p); metal(K, t + 0.05, { f: 620, gain: 0.14 * p.gain, d: 1.2, r: 0.9, index: 180 }); return t + 1.4; },
  'death.warden': (K, t, p) => { RECIPES['boss.roar'](K, t, { ...p, gain: p.gain * 0.9 });
                                 RECIPES['boss.phase'](K, t + 0.5, { ...p, gain: p.gain * 0.8 });
                                 body(K, t + 1.2, { f0: 50, f1: 24, d: 1.6, r: 1.0, gain: 0.4 * p.gain }); return t + 3.4; },

  // ── projectiles ──────────────────────────────────────────────────────────
  'projectile.arrow': (K, t, p) => { whoosh(K, t, { dur: 0.24, lo: 1600, hi: 700, gain: 0.18 * p.gain, q: 3.0 }); return t + 0.36; },
  'projectile.fire': (K, t, p) => {
    nz(K, t, { f0: 400, f1: 1800, q: 0.6, dur: 0.3, gain: 0.22 * p.gain, kind: 'brown', a: 0.006 });
    body(K, t, { f0: 160, f1: 70, d: 0.16, gain: 0.16 * p.gain, wave: 'triangle' });
    return t + 0.45;
  },
  'projectile.arcane': (K, t, p) => {
    shimmer(K, t, { base: 76, notes: [0, 5, 8], dur: 0.4, gain: 0.10 * p.gain, stagger: 0.02, ratio: 2.51, index: 200 });
    nz(K, t, { f0: 2600, f1: 900, q: 1.2, dur: 0.18, gain: 0.10 * p.gain });
    return t + 0.55;
  },
  'projectile.bolt': (K, t, p) => { RECIPES['impact.lightning'](K, t, { ...p, gain: p.gain * 0.55 }); return t + 0.3; },

  // ── statuses ─────────────────────────────────────────────────────────────
  'status.fire':      (K, t, p) => { nz(K, t, { f0: 600, f1: 2600, q: 0.5, dur: 0.5, gain: 0.14 * p.gain, kind: 'brown', a: 0.05 }); return t + 0.7; },
  'status.frost':     (K, t, p) => { metal(K, t, { f: 5200, gain: 0.10 * p.gain, d: 0.7, r: 0.6, index: 160, parts: [1, 2.17, 3.6] }); nz(K, t, { f0: 9000, f1: 5000, q: 1.0, dur: 0.4, gain: 0.08 * p.gain, a: 0.02 }); return t + 0.9; },
  'status.poison':    (K, t, p) => { const r = p.rnd; for (let i = 0; i < 4; i++) body(K, t + i * 0.06 + r() * 0.02, { f0: 260 + r() * 300, f1: 800, d: 0.05, r: 0.04, gain: 0.07 * p.gain, pitchT: 0.04 }); return t + 0.5; },
  'status.lightning': (K, t, p) => { for (let i = 0; i < 3; i++) nz(K, t + i * 0.02, { f0: 6000 + i * 1500, q: 3, dur: 0.03, gain: 0.10 * p.gain }); return t + 0.2; },
  'status.arcane':    (K, t, p) => { shimmer(K, t, { base: 66, notes: [0, 1, 6, 11], dur: 0.7, gain: 0.07 * p.gain, stagger: 0.05, ratio: 3.01 }); return t + 0.9; },
  'status.shatter':   (K, t, p) => { const r = p.rnd; metal(K, t, { f: 4600, gain: 0.20 * p.gain, d: 0.3, r: 0.3, index: 800, parts: [1, 2.31, 3.9, 5.7] });
                                     for (let i = 0; i < 7; i++) nz(K, t + r() * 0.18, { f0: 4000 + r() * 7000, q: 4, dur: 0.05, gain: 0.08 * p.gain }); return t + 0.6; },

  // ── world / run ──────────────────────────────────────────────────────────
  'door.unseal': (K, t, p) => {
    // bronze bolts giving, then stone dragging, then the chord of the room beyond
    metal(K, t, { f: 260, gain: 0.20 * p.gain, d: 0.7, r: 0.5, index: 130, parts: [1, 1.47, 2.11, 3.02] });
    nz(K, t + 0.10, { f0: 260, f1: 90, q: 0.5, dur: 1.0, gain: 0.26 * p.gain, kind: 'brown', a: 0.12, sweepT: 0.9 });
    body(K, t + 0.10, { f0: 62, f1: 40, d: 0.9, r: 0.5, gain: 0.28 * p.gain });
    shimmer(K, t + 0.30, { base: 62, notes: [0, 7, 12, 19], dur: 1.6, gain: 0.13 * p.gain, stagger: 0.10, ratio: 2.0, index: 110 });
    return t + 2.0;
  },
  'room.cleared': (K, t, p) => {
    shimmer(K, t, { base: 64, notes: [0, 4, 7, 11, 16], dur: 1.4, gain: 0.15 * p.gain, stagger: 0.075, ratio: 2.0, index: 130 });
    metal(K, t, { f: 520, gain: 0.10 * p.gain, d: 1.2, r: 1.0, index: 150 });
    return t + 1.8;
  },
  'brazier': (K, t, p) => {
    // one crackle grain; index.js re-triggers these irregularly for a fire bed
    const r = p.rnd;
    nz(K, t, { f0: 900 + r() * 3000, q: 1.4 + r() * 2, dur: 0.05 + r() * 0.09, gain: (0.05 + r() * 0.07) * p.gain, kind: 'pink' });
    if (r() < 0.3) body(K, t, { f0: 120 + r() * 120, f1: 60, d: 0.06, gain: 0.05 * p.gain, wave: 'triangle' });
    return t + 0.25;
  },
  'brazier.bed': (K, t, p) => {
    // the continuous roar under the crackle — long, low, filtered noise
    const ac = K.ac, g = gain(ac, 0), lp = filter(ac, 'lowpass', 620, 0.8), hp = filter(ac, 'highpass', 90, 0.7);
    src(ac, hp, noise(ac, 'brown'), t, { offset: p.rnd() * 1.2, stop: t + 2.4, loop: true });
    hp.connect(lp); lp.connect(g); g.connect(K.dest);
    adsr(g.gain, t, { peak: 0.10 * p.gain, a: 0.5, d: 0.4, s: 0.9, hold: 1.0, r: 0.5, curve: 'lin' });
    return t + 2.4;
  },
  'weapon.equip': (K, t, p) => {
    metal(K, t, { f: 1500, gain: 0.18 * p.gain, d: 0.7, r: 0.6, index: 300, parts: [1, 1.9, 2.8, 4.1] });
    nz(K, t, { f0: 3200, f1: 900, q: 1.2, dur: 0.16, gain: 0.12 * p.gain });
    return t + 0.9;
  },
  'footstep': (K, t, p) => {
    const r = p.rnd;
    nz(K, t, { f0: 260 + r() * 200, f1: 110, q: 0.9, dur: 0.07, gain: 0.10 * p.gain, kind: 'brown', a: 0.001 });
    nz(K, t + 0.004, { f0: 2600 + r() * 1600, q: 1.8, dur: 0.035, gain: 0.045 * p.gain });
    return t + 0.15;
  },
  'cloth': (K, t, p) => {
    const r = p.rnd;
    nz(K, t, { f0: 2200 + r() * 1800, f1: 900, q: 1.1, dur: 0.10, gain: 0.055 * p.gain, kind: 'pink', a: 0.012 });
    return t + 0.2;
  },

  // ── UI ───────────────────────────────────────────────────────────────────
  'ui.click': (K, t, p) => {
    body(K, t, { f0: 880, f1: 620, d: 0.03, r: 0.04, gain: 0.16 * p.gain, wave: 'triangle', pitchT: 0.02 });
    nz(K, t, { f0: 4200, q: 2.4, dur: 0.02, gain: 0.06 * p.gain });
    return t + 0.12;
  },
  'ui.hover': (K, t, p) => {
    body(K, t, { f0: 1320, f1: 1320, d: 0.02, r: 0.05, gain: 0.055 * p.gain, wave: 'sine' });
    return t + 0.1;
  },
  'ui.select': (K, t, p) => {
    metal(K, t, { f: 1180, gain: 0.16 * p.gain, d: 0.5, r: 0.4, index: 180, parts: [1, 2.0, 3.0] });
    body(K, t, { f0: 590, f1: 880, d: 0.05, r: 0.06, gain: 0.10 * p.gain, wave: 'triangle', pitchT: 0.04 });
    return t + 0.7;
  },
  'ui.back': (K, t, p) => {
    body(K, t, { f0: 620, f1: 330, d: 0.06, r: 0.08, gain: 0.13 * p.gain, wave: 'triangle', pitchT: 0.05 });
    return t + 0.2;
  },
  'ui.pause': (K, t, p) => {
    metal(K, t, { f: 340, gain: 0.14 * p.gain, d: 0.9, r: 0.8, index: 90, parts: [1, 1.6, 2.4] });
    return t + 1.0;
  },
  'ui.boon': (K, t, p) => {
    shimmer(K, t, { base: 72, notes: [0, 4, 7, 12], dur: 0.8, gain: 0.13 * p.gain, stagger: 0.05, ratio: 2.0, index: 120 });
    return t + 1.1;
  },
  // Rarity-pitched boon pickups: common bronze -> heroic prismatic.
  'boon.common':  (K, t, p) => RECIPES._boon(K, t, p, 60, [0, 7, 12], 2.0, 1.1),
  'boon.rare':    (K, t, p) => RECIPES._boon(K, t, p, 64, [0, 7, 12, 16], 2.0, 1.3),
  'boon.epic':    (K, t, p) => RECIPES._boon(K, t, p, 67, [0, 5, 9, 12, 16], 2.51, 1.6),
  'boon.heroic':  (K, t, p) => RECIPES._boon(K, t, p, 72, [0, 4, 7, 11, 14, 19], 3.01, 2.0),
  '_boon': (K, t, p, base, notes, ratio, len) => {
    shimmer(K, t, { base, notes, dur: 0.9 * len, gain: 0.15 * p.gain, stagger: 0.065, ratio, index: 150 });
    metal(K, t, { f: 700, gain: 0.09 * p.gain, d: 0.9 * len, r: 0.8 * len, index: 140 });
    body(K, t, { f0: midiToFreq(base - 24), f1: midiToFreq(base - 24), d: 0.5 * len, r: 0.4 * len, gain: 0.16 * p.gain, wave: 'sine' });
    return t + 1.2 * len;
  },
};

// ── name resolution ────────────────────────────────────────────────────────
// weapons.js plays `<swing>.hit` for every landed blow, and other systems may
// invent names. Nothing should ever be silent by omission, and nothing should
// ever throw.
const HIT_FAMILY = { blade: 'impact.metal', spear: 'impact.metal', bow: 'impact.flesh', shield: 'impact.metal' };

export function resolve(name) {
  if (!name) return null;
  if (RECIPES[name]) return RECIPES[name];
  if (name.endsWith('.hit')) {
    const fam = name.split('.')[0];
    return RECIPES[HIT_FAMILY[fam] || 'hit'];
  }
  const head = name.split('.')[0];
  if (RECIPES[head]) return RECIPES[head];
  return RECIPES.hit;
}

/** Every name this module answers to (minus private helpers). */
export const SFX_NAMES = Object.keys(RECIPES).filter((k) => k[0] !== '_');
