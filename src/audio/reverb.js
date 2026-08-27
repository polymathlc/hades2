// OWNER: AGENT-AUDIO
// ---------------------------------------------------------------------------
// src/audio/reverb.js — procedurally generated impulse responses.
//
// Four rooms, none of them a file:
//   cell      a small carved stone cell   — Tartarus' chambers
//   lavahall  a wide, roaring basalt hall — Asphodel
//   temple    a bright marble peristyle   — Elysium
//   cavern    the vast void beyond        — the abyss, titles, boss arenas
//
// Each IR is exponentially-decaying decorrelated noise with (a) a set of
// discrete early reflections whose pattern is what actually tells the ear how
// big the room is, and (b) a one-pole lowpass whose cutoff FALLS across the
// tail, which is the physical behaviour of air and stone absorbing treble.
// A flat-spectrum decaying noise burst sounds like a cheap plate; the moving
// damping is the whole difference.
// ---------------------------------------------------------------------------

import { mulberry32, hashName, clamp, TAU } from './synth.js';

export const SPACES = {
  cell: {
    t60: 0.85, predelay: 0.007, hf0: 9500, hf1: 2400, lowBoost: 0.12,
    er: [[0.009, 0.62], [0.014, -0.48], [0.021, 0.40], [0.029, -0.31], [0.041, 0.24], [0.053, -0.17]],
    width: 0.55, density: 1.0,
  },
  lavahall: {
    t60: 2.7, predelay: 0.020, hf0: 5200, hf1: 820, lowBoost: 0.42,
    er: [[0.017, 0.55], [0.028, -0.44], [0.043, 0.38], [0.061, -0.30], [0.082, 0.24], [0.11, -0.18], [0.14, 0.13]],
    width: 0.75, density: 0.85,
  },
  temple: {
    t60: 2.2, predelay: 0.013, hf0: 13000, hf1: 3400, lowBoost: 0.08,
    er: [[0.011, 0.58], [0.019, -0.45], [0.026, 0.42], [0.037, -0.33], [0.049, 0.28], [0.066, -0.21], [0.088, 0.15]],
    width: 0.8, density: 1.15,
  },
  cavern: {
    t60: 4.4, predelay: 0.034, hf0: 6200, hf1: 620, lowBoost: 0.30,
    er: [[0.028, 0.48], [0.047, -0.40], [0.072, 0.35], [0.101, -0.29], [0.137, 0.23], [0.181, -0.18], [0.24, 0.13], [0.31, -0.09]],
    width: 0.92, density: 0.7,
  },
};

/** Which room each biome sounds like. */
export const BIOME_SPACE = {
  tartarus: 'cell',
  asphodel: 'lavahall',
  elysium: 'temple',
  styx: 'cavern',
  void: 'cavern',
  menu: 'cavern',
};

/** Render one space to a stereo AudioBuffer. Deterministic, ~10-40ms of JS. */
export function renderIR(ac, name) {
  const S = SPACES[name] || SPACES.cell;
  const sr = ac.sampleRate;
  const len = Math.max(256, Math.floor(sr * (S.t60 * 1.05 + S.predelay + 0.05)));
  const buf = ac.createBuffer(2, len, sr);
  const pd = Math.floor(S.predelay * sr);
  const decay = Math.log(1000) / (S.t60 * sr);   // per-sample e-folding for -60dB

  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    const rnd = mulberry32(hashName('ir:' + name) + ch * 4409);
    // --- diffuse tail ------------------------------------------------------
    let lp = 0, hp0 = 0, hp1 = 0, yPrev = 0;
    for (let i = pd; i < len; i++) {
      const t = (i - pd) / sr;
      const env = Math.exp(-decay * (i - pd));
      // build-up: energy in a real room takes a few ms to become diffuse
      const build = 1 - Math.exp(-t * 340);
      // sparse early / dense late — cheap "density" model
      const dens = clamp(S.density * (0.25 + 0.75 * Math.min(1, t * 22)), 0, 1);
      const w = (rnd() < dens) ? (rnd() * 2 - 1) : 0;
      // moving damping: cutoff glides hf0 -> hf1 across the tail
      const k = Math.min(1, t / S.t60);
      const fc = S.hf0 * Math.pow(S.hf1 / S.hf0, k);
      const a = 1 - Math.exp(-TAU * fc / sr);
      lp += (w - lp) * a;
      let v = lp * env * build;
      // gentle low shelf so a big room sounds big rather than merely long
      hp0 += (v - hp0) * (1 - Math.exp(-TAU * 140 / sr));
      v += hp0 * S.lowBoost;
      // rumble control — a proper DC blocker (y = v - x1 + 0.995*y1). An
      // earlier version here was a bare first-difference, which is a +6dB/oct
      // highpass and thinned every room to a hiss.
      const y = v - hp1 + 0.995 * yPrev; hp1 = v; yPrev = y;
      d[i] = y;
    }
    // --- early reflections -------------------------------------------------
    const jitter = ch === 0 ? 1 : (1 + S.width * 0.11);
    for (const [tt, g] of S.er) {
      const i = pd + Math.floor(tt * jitter * sr);
      if (i >= len - 3) continue;
      const sgn = g * (0.85 + rnd() * 0.3);
      // a short shaped burst rather than a naked click
      const w = Math.max(2, Math.floor(sr * 0.0016));
      for (let k = 0; k < w && i + k < len; k++) {
        d[i + k] += sgn * (rnd() * 2 - 1) * (1 - k / w);
      }
    }
    // a touch of direct-adjacent energy so the send is not purely far away
    d[Math.max(0, pd - 1)] += 0.10;
  }

  // --- decorrelate + normalise ---------------------------------------------
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  const w = clamp(S.width, 0, 1);
  let peak = 1e-9, rms = 0;
  for (let i = 0; i < len; i++) {
    const m = (L[i] + R[i]) * 0.5, s = (L[i] - R[i]) * 0.5 * (0.25 + 0.55 * w);
    L[i] = m + s; R[i] = m - s;
    const a = Math.abs(L[i]) > Math.abs(R[i]) ? Math.abs(L[i]) : Math.abs(R[i]);
    if (a > peak) peak = a;
    rms += L[i] * L[i] + R[i] * R[i];
  }
  rms = Math.sqrt(rms / (len * 2)) || 1e-9;
  // normalise by RMS (perceived level), clipped by peak so long tails do not
  // arrive louder than short ones
  const g = Math.min(0.30 / rms, 0.85 / peak);
  for (let i = 0; i < len; i++) { L[i] *= g; R[i] *= g; }
  return buf;
}

/**
 * A reverb send with two convolvers so a room change crossfades instead of
 * cutting the tail off mid-decay.
 */
export class ReverbBus {
  constructor(ac, dest, opts = {}) {
    this.ac = ac;
    this.cache = new Map();
    this.input = ac.createGain(); this.input.gain.value = 1;
    // pre-filter: keep sub-bass and hiss out of the tail, which is where mud
    // and fizz come from in a game mix
    this.pre = ac.createBiquadFilter(); this.pre.type = 'highpass'; this.pre.frequency.value = opts.hp ?? 180;
    this.pre2 = ac.createBiquadFilter(); this.pre2.type = 'lowpass'; this.pre2.frequency.value = opts.lp ?? 8200;
    this.input.connect(this.pre); this.pre.connect(this.pre2);
    this.a = { conv: ac.createConvolver(), gain: ac.createGain(), name: null };
    this.b = { conv: ac.createConvolver(), gain: ac.createGain(), name: null };
    for (const s of [this.a, this.b]) {
      s.conv.normalize = false;
      this.pre2.connect(s.conv); s.conv.connect(s.gain); s.gain.connect(dest);
      s.gain.gain.value = 0;
    }
    this.cur = this.a; this.other = this.b;
    this.wet = opts.wet ?? 1;
    this.space = null;
  }
  ir(name) {
    let b = this.cache.get(name);
    if (!b) { b = renderIR(this.ac, name); this.cache.set(name, b); }
    return b;
  }
  /** Swap rooms on the audio clock; 1.2s equal-ish crossfade. */
  setSpace(name, t, fade = 1.2) {
    if (!SPACES[name] || name === this.space) return;
    const now = t ?? this.ac.currentTime;
    const target = this.other;
    target.conv.buffer = this.ir(name);
    target.name = name;
    target.gain.gain.cancelScheduledValues(now);
    target.gain.gain.setValueAtTime(target.gain.gain.value, now);
    target.gain.gain.linearRampToValueAtTime(this.wet, now + fade);
    const old = this.cur;
    old.gain.gain.cancelScheduledValues(now);
    old.gain.gain.setValueAtTime(old.gain.gain.value, now);
    old.gain.gain.linearRampToValueAtTime(0, now + fade);
    this.cur = target; this.other = old;
    this.space = name;
  }
  setBiome(biome, t) { this.setSpace(BIOME_SPACE[biome] || 'cell', t); }
}

/**
 * A tempo-synced delay send. Dotted-eighth by default — the classic way to
 * make a plucked riff feel like it is bouncing off a big stone room.
 */
export class DelayBus {
  constructor(ac, dest, opts = {}) {
    this.ac = ac;
    this.input = ac.createGain();
    this.delay = ac.createDelay(2.0);
    this.delay.delayTime.value = opts.time ?? 0.34;
    this.fb = ac.createGain(); this.fb.gain.value = opts.feedback ?? 0.34;
    this.tone = ac.createBiquadFilter(); this.tone.type = 'lowpass'; this.tone.frequency.value = opts.tone ?? 2600;
    this.hp = ac.createBiquadFilter(); this.hp.type = 'highpass'; this.hp.frequency.value = 260;
    this.out = ac.createGain(); this.out.gain.value = opts.wet ?? 1;
    this.input.connect(this.hp); this.hp.connect(this.delay);
    this.delay.connect(this.tone); this.tone.connect(this.fb); this.fb.connect(this.delay);
    this.delay.connect(this.out); this.out.connect(dest);
  }
  setTime(sec, t) {
    const now = t ?? this.ac.currentTime;
    this.delay.delayTime.cancelScheduledValues(now);
    this.delay.delayTime.setValueAtTime(this.delay.delayTime.value, now);
    this.delay.delayTime.linearRampToValueAtTime(Math.max(0.01, Math.min(1.9, sec)), now + 0.4);
  }
  setFeedback(v, t) {
    const now = t ?? this.ac.currentTime;
    this.fb.gain.setValueAtTime(Math.max(0, Math.min(0.85, v)), now);
  }
}
