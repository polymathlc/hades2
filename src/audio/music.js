// OWNER: AGENT-AUDIO
// ---------------------------------------------------------------------------
// src/audio/music.js — the adaptive score, authored as DATA.
//
// The model, in one paragraph: each biome is a KEY (root + Greek/maqam mode), a
// TEMPO, a CHORD PROGRESSION and a set of LAYERS. Each layer owns a bank of
// one-bar step patterns and a window of combat intensity over which it fades in.
// A look-ahead scheduler walks a 16th-note grid on the AUDIO clock, reads the
// chord under the current bar, turns each pattern event into a note, and hands
// it to an instrument. Nothing is ever "started" from the render loop — the
// render loop only asks "is there room in the next 350 ms?".
//
// Intensity does not crossfade a finished mix; it ADDS PARTS, the way a live
// band does. At 0 you hear a drone, a choir and a slow bass. At 1 you hear the
// bouzouki riff doubled, a full percussion bed, a modal lead line and a tension
// drone a semitone off the tonic. The chords underneath never change, so the
// transition is a build, not a cut.
//
// Biome and intensity changes land on MUSICAL boundaries: intensity ramps
// across a whole bar; a biome change waits for a two-bar phrase line and comes
// in on a crash.
// ---------------------------------------------------------------------------

import {
  adsr, attackTo, releaseAt, sweep, gain, filter, osc, src, noise, wave, shaper, fmVoice, stackVoice,
  midiToFreq, clamp, lerp, smoothstep, PluckBank, Poly, mulberry32, lfo, TAU, EPS,
} from './synth.js';

// ── modes ──────────────────────────────────────────────────────────────────
// The Greek/Anatolian material the Hades score leans on. Phrygian dominant and
// Hijaz are the same interval set under two names; both are kept because they
// are used with different chord habits.
export const SCALES = {
  phrygian:         [0, 1, 3, 5, 7, 8, 10],
  phrygianDominant: [0, 1, 4, 5, 7, 8, 10],   // Hijaz
  hijaz:            [0, 1, 4, 5, 7, 8, 10],
  hijazKar:         [0, 1, 4, 5, 7, 8, 11],   // double harmonic
  doubleHarmonic:   [0, 1, 4, 5, 7, 8, 11],
  harmonicMinor:    [0, 2, 3, 5, 7, 8, 11],
  aeolian:          [0, 2, 3, 5, 7, 8, 10],
  dorian:           [0, 2, 3, 5, 7, 9, 10],
  nikriz:           [0, 2, 3, 6, 7, 9, 10],   // Hijaz on the 4th — Asphodel's colour
};

function degToSemi(scale, deg) {
  const n = scale.length;
  const o = Math.floor(deg / n);
  return scale[((deg % n) + n) % n] + 12 * o;
}

// ═══════════════════════════════════════════════════════════════════════════
// THE SCORE
// ═══════════════════════════════════════════════════════════════════════════
// Event grammar:
//   { s: step, d: durationInSteps, v: velocity 0..1,
//     t: chord-tone index (0=root,1=third,2=fifth,3=seventh)  OR
//     n: scale-degree offset from the chord root,
//     o: octave offset, drum: name (percussion layers only) }

export const BIOMES = {

  // ── TARTARUS ────────────────────────────────────────────────────────────
  // D Hijaz, 132 bpm, hard 4/4. Bouzouki riff, tapan groove, low choir.
  tartarus: {
    root: 50, scale: 'phrygianDominant', bpm: 132, beatsPerBar: 4, steps: 16,
    swing: 0.06, space: 'cell', delayMul: 0.75,
    prog: [[0, 2], [1, 1], [6, 1], [0, 2], [3, 1], [1, 1]],   // 8-bar loop
    layers: {
      bass: {
        inst: 'bassAnalog', oct: -1, gain: 0.50, lo: -1, hi: 0.05,
        bars: [
          [{ s: 0, d: 3, t: 0, v: 1 }, { s: 6, d: 2, t: 0, v: .72 }, { s: 10, d: 2, t: 0, v: .8 }, { s: 14, d: 2, t: 2, v: .62 }],
          [{ s: 0, d: 3, t: 0, v: 1 }, { s: 4, d: 2, t: 0, v: .6 }, { s: 8, d: 2, t: 2, v: .74 }, { s: 12, d: 4, t: 0, v: .8 }],
        ],
        barsHot: [
          [{ s: 0, d: 2, t: 0, v: 1 }, { s: 2, d: 1, t: 0, v: .5 }, { s: 4, d: 2, t: 0, v: .8 }, { s: 6, d: 2, t: 0, v: .62 },
           { s: 8, d: 2, t: 0, v: .95 }, { s: 10, d: 2, t: 2, v: .7 }, { s: 12, d: 2, t: 0, v: .85 }, { s: 14, d: 2, t: 1, v: .6 }],
          [{ s: 0, d: 2, t: 0, v: 1 }, { s: 3, d: 1, t: 0, v: .55 }, { s: 4, d: 2, t: 4, o: -1, v: .8 }, { s: 8, d: 2, t: 0, v: .95 },
           { s: 11, d: 1, t: 2, v: .6 }, { s: 12, d: 4, t: 0, v: .85 }],
        ],
      },
      pluck: {
        inst: 'bouzouki', oct: 0, gain: 0.34, lo: -0.02, hi: 0.20,
        bars: [
          [{ s: 0, d: 2, t: 0, v: .9 }, { s: 3, d: 1, t: 1, v: .55 }, { s: 4, d: 2, t: 2, v: .8 }, { s: 7, d: 1, t: 1, v: .5 },
           { s: 8, d: 2, t: 0, o: 1, v: .85 }, { s: 11, d: 1, t: 2, v: .55 }, { s: 12, d: 2, t: 1, v: .7 }, { s: 14, d: 2, t: 0, v: .6 }],
          [{ s: 0, d: 2, t: 2, v: .85 }, { s: 2, d: 2, t: 1, v: .6 }, { s: 4, d: 2, t: 0, o: 1, v: .9 }, { s: 6, d: 2, t: 2, v: .55 },
           { s: 8, d: 2, t: 1, v: .8 }, { s: 10, d: 1, t: 3, v: .5 }, { s: 12, d: 4, t: 0, v: .8 }],
          [{ s: 0, d: 1, t: 0, v: .9 }, { s: 1, d: 1, t: 1, v: .45 }, { s: 2, d: 2, t: 2, v: .7 }, { s: 5, d: 1, t: 1, v: .5 },
           { s: 6, d: 2, t: 0, o: 1, v: .8 }, { s: 9, d: 1, t: 2, v: .5 }, { s: 10, d: 2, t: 1, v: .7 }, { s: 13, d: 3, t: 0, v: .75 }],
        ],
      },
      lead: {
        inst: 'bouzouki', oct: 1, gain: 0.30, lo: 0.36, hi: 0.66, delay: 0.5,
        bars: [
          [{ s: 0, d: 4, n: 4, v: .9 }, { s: 4, d: 2, n: 5, v: .7 }, { s: 6, d: 2, n: 4, v: .65 }, { s: 8, d: 6, n: 2, v: .85 }, { s: 14, d: 2, n: 3, v: .6 }],
          [{ s: 0, d: 6, n: 1, v: .85 }, { s: 6, d: 2, n: 0, v: .6 }, { s: 8, d: 8, n: -2, v: .8 }],
          [{ s: 0, d: 3, n: 7, v: .95 }, { s: 3, d: 1, n: 6, v: .55 }, { s: 4, d: 4, n: 5, v: .8 }, { s: 8, d: 4, n: 4, v: .75 }, { s: 12, d: 4, n: 2, v: .7 }],
          [{ s: 0, d: 10, n: 0, v: .9 }, { s: 10, d: 2, n: 1, v: .55 }, { s: 12, d: 4, n: -1, v: .7 }],
        ],
      },
      perc: {
        gain: 0.52, lo: 0.05, hi: 0.38,
        bars: [
          [{ s: 0, drum: 'kick', v: 1 }, { s: 0, drum: 'tapan', v: .8 }, { s: 4, drum: 'frame', v: .7 },
           { s: 6, drum: 'kick', v: .7 }, { s: 8, drum: 'tapan', v: .6 }, { s: 10, drum: 'kick', v: .8 }, { s: 12, drum: 'frame', v: .75 },
           { s: 2, drum: 'shaker', v: .35 }, { s: 6, drum: 'shaker', v: .3 }, { s: 10, drum: 'shaker', v: .35 }, { s: 14, drum: 'shaker', v: .3 }],
          [{ s: 0, drum: 'kick', v: 1 }, { s: 0, drum: 'tapan', v: .8 }, { s: 3, drum: 'rim', v: .5 }, { s: 4, drum: 'frame', v: .7 },
           { s: 7, drum: 'kick', v: .65 }, { s: 10, drum: 'kick', v: .8 }, { s: 12, drum: 'frame', v: .8 }, { s: 15, drum: 'riq', v: .5 },
           { s: 2, drum: 'shaker', v: .3 }, { s: 6, drum: 'shaker', v: .35 }, { s: 14, drum: 'shaker', v: .3 }],
        ],
        barsHot: [
          [{ s: 0, drum: 'kick', v: 1 }, { s: 0, drum: 'tapan', v: .9 }, { s: 2, drum: 'shaker', v: .4 }, { s: 3, drum: 'kick', v: .55 },
           { s: 4, drum: 'frame', v: .85 }, { s: 4, drum: 'clap', v: .5 }, { s: 6, drum: 'kick', v: .8 }, { s: 7, drum: 'riq', v: .45 },
           { s: 8, drum: 'tapan', v: .75 }, { s: 10, drum: 'kick', v: .9 }, { s: 11, drum: 'shaker', v: .4 }, { s: 12, drum: 'frame', v: .9 },
           { s: 12, drum: 'clap', v: .5 }, { s: 14, drum: 'kick', v: .6 }, { s: 15, drum: 'riq', v: .5 }],
          [{ s: 0, drum: 'kick', v: 1 }, { s: 0, drum: 'tapan', v: .9 }, { s: 1, drum: 'rim', v: .4 }, { s: 2, drum: 'kick', v: .5 },
           { s: 4, drum: 'frame', v: .85 }, { s: 4, drum: 'clap', v: .55 }, { s: 6, drum: 'shaker', v: .4 }, { s: 8, drum: 'kick', v: .9 },
           { s: 8, drum: 'tapan', v: .7 }, { s: 10, drum: 'riq', v: .5 }, { s: 11, drum: 'kick', v: .6 }, { s: 12, drum: 'frame', v: .9 },
           { s: 12, drum: 'clap', v: .55 }, { s: 13, drum: 'shaker', v: .4 }, { s: 14, drum: 'kick', v: .7 }, { s: 15, drum: 'shaker', v: .4 }],
        ],
      },
      pad: { inst: 'choirAh', oct: 0, gain: 0.30, lo: -1, hi: 0.02, voicing: [0, 2, 4], attack: 1.1, release: 1.6 },
      tension: {
        gain: 0.34, lo: 0.58, hi: 0.90, droneOct: -2, droneWave: 'bowed', clusterSemi: 1,
        bars: [
          [{ s: 0, drum: 'taiko', v: 1 }, { s: 8, drum: 'taiko', v: .7 }],
          [{ s: 0, drum: 'taiko', v: 1 }, { s: 6, drum: 'taiko', v: .6 }, { s: 12, drum: 'taiko', v: .8 }],
        ],
      },
    },
  },

  // ── ASPHODEL ────────────────────────────────────────────────────────────
  // G# Nikriz, 96 bpm, 12/8 — a lurching triplet feel over a lava sea.
  // Plucked bass, low choir "oo", frame drums, a ney over the top.
  asphodel: {
    root: 44, scale: 'nikriz', bpm: 96, beatsPerBar: 4, steps: 12,
    swing: 0, space: 'lavahall', delayMul: 1.0,
    prog: [[0, 2], [3, 1], [4, 1], [0, 1], [6, 1], [1, 2]],
    layers: {
      bass: {
        inst: 'bassPluck', oct: -1, gain: 0.52, lo: -1, hi: 0.05,
        bars: [
          [{ s: 0, d: 3, t: 0, v: 1 }, { s: 3, d: 2, t: 0, v: .55 }, { s: 6, d: 3, t: 0, v: .8 }, { s: 9, d: 3, t: 2, v: .65 }],
          [{ s: 0, d: 3, t: 0, v: 1 }, { s: 4, d: 2, t: 4, o: -1, v: .6 }, { s: 6, d: 3, t: 0, v: .85 }, { s: 10, d: 2, t: 1, v: .55 }],
        ],
        barsHot: [
          [{ s: 0, d: 2, t: 0, v: 1 }, { s: 2, d: 1, t: 0, v: .5 }, { s: 3, d: 2, t: 2, v: .7 }, { s: 6, d: 2, t: 0, v: .9 },
           { s: 8, d: 1, t: 0, v: .5 }, { s: 9, d: 3, t: 4, o: -1, v: .75 }],
          [{ s: 0, d: 2, t: 0, v: 1 }, { s: 2, d: 2, t: 1, v: .6 }, { s: 5, d: 1, t: 0, v: .55 }, { s: 6, d: 3, t: 0, v: .9 },
           { s: 9, d: 1, t: 2, v: .6 }, { s: 10, d: 2, t: 0, v: .8 }],
        ],
      },
      pluck: {
        inst: 'bouzouki', oct: 0, gain: 0.30, lo: 0.0, hi: 0.22,
        bars: [
          [{ s: 0, d: 2, t: 0, v: .85 }, { s: 2, d: 1, t: 2, v: .5 }, { s: 3, d: 2, t: 1, v: .75 }, { s: 6, d: 2, t: 0, o: 1, v: .8 },
           { s: 8, d: 1, t: 2, v: .5 }, { s: 9, d: 3, t: 1, v: .7 }],
          [{ s: 0, d: 3, t: 2, v: .8 }, { s: 3, d: 1, t: 3, v: .5 }, { s: 4, d: 2, t: 1, v: .7 }, { s: 6, d: 3, t: 0, o: 1, v: .85 },
           { s: 10, d: 2, t: 2, v: .6 }],
          [{ s: 0, d: 1, t: 0, v: .9 }, { s: 1, d: 2, t: 1, v: .5 }, { s: 4, d: 2, t: 2, v: .75 }, { s: 6, d: 1, t: 1, v: .6 },
           { s: 7, d: 2, t: 0, o: 1, v: .8 }, { s: 10, d: 2, t: 2, v: .65 }],
        ],
      },
      lead: {
        inst: 'ney', oct: 1, gain: 0.26, lo: 0.38, hi: 0.68, delay: 0.65,
        bars: [
          [{ s: 0, d: 5, n: 4, v: .85 }, { s: 5, d: 1, n: 3, v: .5 }, { s: 6, d: 6, n: 2, v: .8 }],
          [{ s: 0, d: 3, n: 5, v: .9 }, { s: 3, d: 3, n: 4, v: .65 }, { s: 6, d: 2, n: 3, v: .6 }, { s: 8, d: 4, n: 1, v: .8 }],
          [{ s: 0, d: 6, n: 7, v: .95 }, { s: 6, d: 2, n: 6, v: .6 }, { s: 8, d: 4, n: 4, v: .8 }],
          [{ s: 0, d: 12, n: 0, v: .85 }],
        ],
      },
      perc: {
        gain: 0.50, lo: 0.06, hi: 0.40,
        bars: [
          [{ s: 0, drum: 'tapan', v: 1 }, { s: 0, drum: 'kick', v: .9 }, { s: 3, drum: 'frame', v: .6 }, { s: 6, drum: 'kick', v: .75 },
           { s: 6, drum: 'frame', v: .7 }, { s: 9, drum: 'frame', v: .55 }, { s: 2, drum: 'shaker', v: .3 }, { s: 5, drum: 'shaker', v: .3 },
           { s: 8, drum: 'shaker', v: .32 }, { s: 11, drum: 'shaker', v: .3 }],
          [{ s: 0, drum: 'tapan', v: 1 }, { s: 0, drum: 'kick', v: .9 }, { s: 4, drum: 'rim', v: .45 }, { s: 6, drum: 'kick', v: .7 },
           { s: 7, drum: 'frame', v: .65 }, { s: 10, drum: 'riq', v: .5 }, { s: 2, drum: 'shaker', v: .3 }, { s: 8, drum: 'shaker', v: .32 }],
        ],
        barsHot: [
          [{ s: 0, drum: 'tapan', v: 1 }, { s: 0, drum: 'kick', v: 1 }, { s: 2, drum: 'frame', v: .55 }, { s: 3, drum: 'kick', v: .6 },
           { s: 4, drum: 'clap', v: .5 }, { s: 5, drum: 'riq', v: .4 }, { s: 6, drum: 'kick', v: .9 }, { s: 6, drum: 'tapan', v: .7 },
           { s: 8, drum: 'frame', v: .7 }, { s: 9, drum: 'kick', v: .6 }, { s: 10, drum: 'clap', v: .5 }, { s: 11, drum: 'riq', v: .45 },
           { s: 1, drum: 'shaker', v: .35 }, { s: 7, drum: 'shaker', v: .35 }],
          [{ s: 0, drum: 'tapan', v: 1 }, { s: 0, drum: 'kick', v: 1 }, { s: 1, drum: 'rim', v: .4 }, { s: 3, drum: 'frame', v: .7 },
           { s: 4, drum: 'kick', v: .6 }, { s: 6, drum: 'kick', v: .95 }, { s: 6, drum: 'clap', v: .55 }, { s: 8, drum: 'riq', v: .45 },
           { s: 9, drum: 'frame', v: .75 }, { s: 10, drum: 'kick', v: .65 }, { s: 11, drum: 'shaker', v: .4 }],
        ],
      },
      pad: { inst: 'choirOo', oct: 0, gain: 0.25, lo: -1, hi: 0.02, voicing: [0, 2, 4, 7], attack: 1.6, release: 2.0 },
      tension: {
        gain: 0.36, lo: 0.55, hi: 0.88, droneOct: -2, droneWave: 'bowed', clusterSemi: 6,
        bars: [
          [{ s: 0, drum: 'taiko', v: 1 }, { s: 6, drum: 'taiko', v: .65 }],
          [{ s: 0, drum: 'taiko', v: 1 }, { s: 9, drum: 'taiko', v: .8 }],
        ],
      },
    },
  },

  // ── ELYSIUM ─────────────────────────────────────────────────────────────
  // E harmonic minor, 144 bpm — heroic, bright, the closest thing to prog rock
  // in the descent. Lyre ornament, a driving kit, a wide bright choir.
  elysium: {
    root: 52, scale: 'harmonicMinor', bpm: 144, beatsPerBar: 4, steps: 16,
    swing: 0, space: 'temple', delayMul: 0.75,
    prog: [[0, 2], [5, 1], [4, 1], [3, 2], [6, 1], [4, 1]],
    layers: {
      bass: {
        inst: 'bassAnalog', oct: -1, gain: 0.48, lo: -1, hi: 0.05,
        bars: [
          [{ s: 0, d: 2, t: 0, v: 1 }, { s: 2, d: 2, t: 0, v: .6 }, { s: 4, d: 2, t: 0, v: .85 }, { s: 6, d: 2, t: 4, o: -1, v: .6 },
           { s: 8, d: 2, t: 0, v: .95 }, { s: 10, d: 2, t: 0, v: .6 }, { s: 12, d: 2, t: 2, v: .8 }, { s: 14, d: 2, t: 1, v: .6 }],
          [{ s: 0, d: 2, t: 0, v: 1 }, { s: 2, d: 2, t: 2, v: .6 }, { s: 4, d: 4, t: 0, v: .85 }, { s: 8, d: 2, t: 0, v: .9 },
           { s: 10, d: 2, t: 4, o: -1, v: .6 }, { s: 12, d: 4, t: 0, v: .8 }],
        ],
        barsHot: [
          [{ s: 0, d: 1, t: 0, v: 1 }, { s: 1, d: 1, t: 0, v: .5 }, { s: 2, d: 2, t: 0, v: .7 }, { s: 4, d: 1, t: 0, v: .9 },
           { s: 5, d: 1, t: 0, v: .5 }, { s: 6, d: 2, t: 2, v: .75 }, { s: 8, d: 1, t: 0, v: 1 }, { s: 9, d: 1, t: 0, v: .5 },
           { s: 10, d: 2, t: 4, o: -1, v: .7 }, { s: 12, d: 2, t: 0, v: .9 }, { s: 14, d: 2, t: 1, v: .65 }],
          [{ s: 0, d: 1, t: 0, v: 1 }, { s: 2, d: 1, t: 0, v: .55 }, { s: 3, d: 1, t: 2, v: .6 }, { s: 4, d: 2, t: 0, v: .9 },
           { s: 7, d: 1, t: 1, v: .55 }, { s: 8, d: 2, t: 0, v: 1 }, { s: 11, d: 1, t: 4, o: -1, v: .6 }, { s: 12, d: 4, t: 0, v: .85 }],
        ],
      },
      pluck: {
        inst: 'lyre', oct: 1, gain: 0.28, lo: -0.02, hi: 0.18,
        bars: [
          [{ s: 0, d: 2, t: 0, v: .8 }, { s: 2, d: 2, t: 1, v: .6 }, { s: 4, d: 2, t: 2, v: .75 }, { s: 6, d: 2, t: 3, v: .55 },
           { s: 8, d: 2, t: 2, v: .7 }, { s: 10, d: 2, t: 1, v: .55 }, { s: 12, d: 4, t: 0, o: 1, v: .8 }],
          [{ s: 0, d: 3, t: 2, v: .8 }, { s: 4, d: 2, t: 0, o: 1, v: .85 }, { s: 6, d: 2, t: 1, v: .55 }, { s: 8, d: 2, t: 2, v: .7 },
           { s: 11, d: 1, t: 3, v: .5 }, { s: 12, d: 4, t: 1, v: .75 }],
          [{ s: 1, d: 1, t: 0, v: .7 }, { s: 3, d: 1, t: 1, v: .5 }, { s: 5, d: 1, t: 2, v: .65 }, { s: 7, d: 1, t: 1, v: .5 },
           { s: 9, d: 1, t: 0, o: 1, v: .8 }, { s: 11, d: 1, t: 2, v: .55 }, { s: 13, d: 3, t: 1, v: .7 }],
        ],
      },
      lead: {
        inst: 'lyre', oct: 2, gain: 0.26, lo: 0.34, hi: 0.64, delay: 0.6,
        bars: [
          [{ s: 0, d: 4, n: 4, v: .9 }, { s: 4, d: 2, n: 6, v: .7 }, { s: 6, d: 2, n: 5, v: .65 }, { s: 8, d: 4, n: 4, v: .8 }, { s: 12, d: 4, n: 2, v: .75 }],
          [{ s: 0, d: 2, n: 7, v: .95 }, { s: 2, d: 2, n: 6, v: .6 }, { s: 4, d: 4, n: 4, v: .8 }, { s: 8, d: 2, n: 5, v: .7 }, { s: 10, d: 6, n: 3, v: .8 }],
          [{ s: 0, d: 6, n: 2, v: .85 }, { s: 6, d: 2, n: 3, v: .6 }, { s: 8, d: 2, n: 4, v: .7 }, { s: 10, d: 2, n: 5, v: .7 }, { s: 12, d: 4, n: 7, v: .9 }],
          [{ s: 0, d: 12, n: 0, o: 1, v: .9 }, { s: 12, d: 4, n: -1, v: .6 }],
        ],
      },
      perc: {
        gain: 0.50, lo: 0.04, hi: 0.36,
        bars: [
          [{ s: 0, drum: 'kick', v: 1 }, { s: 4, drum: 'frame', v: .8 }, { s: 6, drum: 'kick', v: .6 }, { s: 8, drum: 'kick', v: .8 },
           { s: 12, drum: 'frame', v: .85 }, { s: 0, drum: 'shaker', v: .3 }, { s: 2, drum: 'shaker', v: .35 }, { s: 4, drum: 'shaker', v: .3 },
           { s: 6, drum: 'shaker', v: .35 }, { s: 8, drum: 'shaker', v: .3 }, { s: 10, drum: 'shaker', v: .35 }, { s: 12, drum: 'shaker', v: .3 }, { s: 14, drum: 'shaker', v: .35 }],
          [{ s: 0, drum: 'kick', v: 1 }, { s: 3, drum: 'kick', v: .5 }, { s: 4, drum: 'frame', v: .8 }, { s: 8, drum: 'kick', v: .85 },
           { s: 11, drum: 'rim', v: .45 }, { s: 12, drum: 'frame', v: .85 }, { s: 15, drum: 'riq', v: .5 },
           { s: 2, drum: 'shaker', v: .3 }, { s: 6, drum: 'shaker', v: .35 }, { s: 10, drum: 'shaker', v: .3 }, { s: 14, drum: 'shaker', v: .35 }],
        ],
        barsHot: [
          [{ s: 0, drum: 'kick', v: 1 }, { s: 0, drum: 'tapan', v: .6 }, { s: 2, drum: 'kick', v: .5 }, { s: 4, drum: 'frame', v: .9 },
           { s: 4, drum: 'clap', v: .5 }, { s: 6, drum: 'kick', v: .75 }, { s: 8, drum: 'kick', v: .9 }, { s: 10, drum: 'riq', v: .45 },
           { s: 11, drum: 'kick', v: .55 }, { s: 12, drum: 'frame', v: .95 }, { s: 12, drum: 'clap', v: .55 }, { s: 14, drum: 'kick', v: .6 },
           { s: 1, drum: 'shaker', v: .35 }, { s: 3, drum: 'shaker', v: .3 }, { s: 5, drum: 'shaker', v: .35 }, { s: 7, drum: 'shaker', v: .3 },
           { s: 9, drum: 'shaker', v: .35 }, { s: 13, drum: 'shaker', v: .3 }, { s: 15, drum: 'shaker', v: .4 }],
          [{ s: 0, drum: 'kick', v: 1 }, { s: 0, drum: 'tapan', v: .7 }, { s: 3, drum: 'kick', v: .55 }, { s: 4, drum: 'frame', v: .9 },
           { s: 4, drum: 'clap', v: .55 }, { s: 6, drum: 'rim', v: .45 }, { s: 7, drum: 'kick', v: .6 }, { s: 8, drum: 'kick', v: .95 },
           { s: 10, drum: 'frame', v: .6 }, { s: 12, drum: 'frame', v: .95 }, { s: 12, drum: 'clap', v: .55 }, { s: 14, drum: 'riq', v: .5 },
           { s: 2, drum: 'shaker', v: .35 }, { s: 6, drum: 'shaker', v: .3 }, { s: 10, drum: 'shaker', v: .35 }, { s: 15, drum: 'shaker', v: .4 }],
        ],
      },
      pad: { inst: 'choirEh', oct: 1, gain: 0.26, lo: -1, hi: 0.02, voicing: [0, 2, 4], attack: 0.9, release: 1.4 },
      tension: {
        gain: 0.32, lo: 0.60, hi: 0.92, droneOct: -2, droneWave: 'bowed', clusterSemi: 11,
        bars: [
          [{ s: 0, drum: 'taiko', v: 1 }, { s: 10, drum: 'taiko', v: .7 }],
          [{ s: 0, drum: 'taiko', v: 1 }, { s: 8, drum: 'taiko', v: .8 }, { s: 14, drum: 'crash', v: .5 }],
        ],
      },
    },
  },

  // ── MENU / TITLE ────────────────────────────────────────────────────────
  // A Phrygian, 72 bpm. Almost nothing: a lyre, a choir, a heartbeat of a drum.
  menu: {
    root: 45, scale: 'phrygian', bpm: 72, beatsPerBar: 4, steps: 16,
    swing: 0, space: 'cavern', delayMul: 1.0,
    prog: [[0, 2], [5, 2], [3, 2], [1, 2]],
    layers: {
      bass: {
        inst: 'bassAnalog', oct: -1, gain: 0.38, lo: -1, hi: 0.05,
        bars: [[{ s: 0, d: 8, t: 0, v: .8 }, { s: 8, d: 8, t: 0, v: .55 }]],
      },
      pluck: {
        inst: 'lyre', oct: 1, gain: 0.32, lo: -0.4, hi: 0.02,
        bars: [
          [{ s: 0, d: 4, t: 0, v: .7 }, { s: 4, d: 4, t: 2, v: .55 }, { s: 8, d: 4, t: 1, v: .6 }, { s: 12, d: 4, t: 0, o: 1, v: .65 }],
          [{ s: 0, d: 6, t: 2, v: .65 }, { s: 6, d: 4, t: 1, v: .5 }, { s: 10, d: 6, t: 0, v: .6 }],
        ],
      },
      lead: { inst: 'ney', oct: 1, gain: 0.22, lo: 0.35, hi: 0.7, delay: 0.7,
        bars: [[{ s: 0, d: 8, n: 4, v: .7 }, { s: 8, d: 8, n: 2, v: .6 }], [{ s: 0, d: 12, n: 0, v: .7 }, { s: 12, d: 4, n: 1, v: .5 }]] },
      perc: { gain: 0.30, lo: 0.25, hi: 0.6,
        bars: [[{ s: 0, drum: 'frame', v: .5 }, { s: 8, drum: 'frame', v: .35 }]] },
      pad: { inst: 'choirOo', oct: 0, gain: 0.27, lo: -1, hi: 0.02, voicing: [0, 2, 4, 7], attack: 2.2, release: 2.6 },
      tension: { gain: 0.24, lo: 0.7, hi: 0.95, droneOct: -2, droneWave: 'bowed', clusterSemi: 1,
        bars: [[{ s: 0, drum: 'taiko', v: .8 }]] },
    },
  },
};

// biome aliases so an unknown room never silences the score
const ALIAS = { styx: 'asphodel', void: 'menu', title: 'menu', hub: 'menu', boss: 'tartarus' };

// ── percussion ─────────────────────────────────────────────────────────────
// Every drum is oscillators + noise. No samples, and no two hits identical:
// each reads rnd() for pitch and timbre.
const DRUMS = {
  kick(ac, dest, t, v, rnd) {
    const g = gain(ac, 0); g.connect(dest);
    const o = osc(ac, g, 'sine', 128, t, t + 0.5);
    sweep(o.frequency, t, 122 + rnd() * 10, 42, 0.075);
    adsr(g.gain, t, { peak: 0.85 * v, a: 0.001, d: 0.30, s: 0, r: 0.10 });
    const cg = gain(ac, 0), cf = filter(ac, 'highpass', 1400, 0.8);
    src(ac, cf, noise(ac, 'white'), t, { offset: rnd() * 1.5, stop: t + 0.05 });
    cf.connect(cg); cg.connect(dest);
    adsr(cg.gain, t, { peak: 0.12 * v, a: 0.0005, d: 0.014, s: 0, r: 0.012 });
  },
  taiko(ac, dest, t, v, rnd) {
    const g = gain(ac, 0); g.connect(dest);
    const o = osc(ac, g, 'sine', 92, t, t + 1.4);
    sweep(o.frequency, t, 88 + rnd() * 8, 38, 0.30);
    adsr(g.gain, t, { peak: 0.9 * v, a: 0.002, d: 0.75, s: 0, r: 0.4 });
    const bg = gain(ac, 0), bf = filter(ac, 'bandpass', 180, 0.9);
    src(ac, bf, noise(ac, 'brown'), t, { offset: rnd() * 1.4, stop: t + 0.5 });
    bf.connect(bg); bg.connect(dest);
    adsr(bg.gain, t, { peak: 0.30 * v, a: 0.001, d: 0.28, s: 0, r: 0.2 });
  },
  tapan(ac, dest, t, v, rnd) {
    const g = gain(ac, 0); g.connect(dest);
    const o = osc(ac, g, 'sine', 105, t, t + 0.6);
    sweep(o.frequency, t, 100 + rnd() * 12, 58, 0.10);
    adsr(g.gain, t, { peak: 0.62 * v, a: 0.001, d: 0.26, s: 0, r: 0.14 });
    const bg = gain(ac, 0), bf = filter(ac, 'bandpass', 300 + rnd() * 90, 1.1);
    src(ac, bf, noise(ac, 'pink'), t, { offset: rnd() * 1.3, stop: t + 0.3 });
    bf.connect(bg); bg.connect(dest);
    adsr(bg.gain, t, { peak: 0.34 * v, a: 0.0008, d: 0.13, s: 0, r: 0.1 });
  },
  frame(ac, dest, t, v, rnd) {
    const g = gain(ac, 0); g.connect(dest);
    const o = osc(ac, g, 'triangle', 210, t, t + 0.35);
    sweep(o.frequency, t, 200 + rnd() * 30, 150, 0.06);
    adsr(g.gain, t, { peak: 0.32 * v, a: 0.001, d: 0.10, s: 0, r: 0.08 });
    const bg = gain(ac, 0), bf = filter(ac, 'bandpass', 1050 + rnd() * 300, 1.0);
    src(ac, bf, noise(ac, 'white'), t, { offset: rnd() * 1.4, stop: t + 0.25 });
    bf.connect(bg); bg.connect(dest);
    adsr(bg.gain, t, { peak: 0.44 * v, a: 0.0006, d: 0.10, s: 0, r: 0.09 });
  },
  rim(ac, dest, t, v, rnd) {
    const bg = gain(ac, 0), bf = filter(ac, 'bandpass', 2100 + rnd() * 500, 4);
    src(ac, bf, noise(ac, 'white'), t, { offset: rnd() * 1.2, stop: t + 0.08 });
    bf.connect(bg); bg.connect(dest);
    adsr(bg.gain, t, { peak: 0.34 * v, a: 0.0004, d: 0.025, s: 0, r: 0.02 });
  },
  shaker(ac, dest, t, v, rnd) {
    const bg = gain(ac, 0), bf = filter(ac, 'highpass', 5200 + rnd() * 1800, 0.9);
    src(ac, bf, noise(ac, 'white'), t, { offset: rnd() * 1.6, stop: t + 0.1 });
    bf.connect(bg); bg.connect(dest);
    adsr(bg.gain, t, { peak: 0.20 * v, a: 0.006, d: 0.035, s: 0, r: 0.03 });
  },
  riq(ac, dest, t, v, rnd) {
    const bg = gain(ac, 0), bf = filter(ac, 'highpass', 6000, 0.8);
    src(ac, bf, noise(ac, 'metal'), t, { offset: rnd() * 1.4, rate: 0.9 + rnd() * 0.3, stop: t + 0.4 });
    bf.connect(bg); bg.connect(dest);
    adsr(bg.gain, t, { peak: 0.20 * v, a: 0.001, d: 0.16, s: 0, r: 0.12 });
  },
  crash(ac, dest, t, v, rnd) {
    const bg = gain(ac, 0), bf = filter(ac, 'highpass', 3200, 0.7);
    src(ac, bf, noise(ac, 'metal'), t, { offset: rnd() * 1.2, rate: 0.55 + rnd() * 0.15, stop: t + 2.4 });
    bf.connect(bg); bg.connect(dest);
    adsr(bg.gain, t, { peak: 0.34 * v, a: 0.002, d: 1.1, s: 0, r: 1.1 });
  },
  clap(ac, dest, t, v, rnd) {
    for (let i = 0; i < 3; i++) {
      const bg = gain(ac, 0), bf = filter(ac, 'bandpass', 1300 + rnd() * 300, 2.2);
      src(ac, bf, noise(ac, 'white'), t + i * 0.008, { offset: rnd() * 1.5, stop: t + 0.2 });
      bf.connect(bg); bg.connect(dest);
      adsr(bg.gain, t + i * 0.008, { peak: (0.24 - i * 0.05) * v, a: 0.0005, d: 0.05, s: 0, r: 0.05 });
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// THE DIRECTOR
// ═══════════════════════════════════════════════════════════════════════════

const LOOKAHEAD = 0.34;      // seconds of music scheduled in advance
// One trim across the whole score. Set from measurement, not taste: an offline
// render of every biome at intensity 0.95 peaked between -1 and +2 dBFS before
// the master limiter, i.e. the limiter was doing the mixing. 0.5 puts the
// hottest biome at about -8 dBFS peak and leaves the limiter as a safety net.
const MIX = 0.5;
const LAYERS = ['bass', 'pad', 'pluck', 'perc', 'lead', 'tension'];

/** Retire a voice over 40 ms instead of cutting it dead. */
function fadeKill(ac, g, voice) {
  const t = ac.currentTime;
  try {
    if (g && g.gain) {
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(Math.max(EPS, g.gain.value), t);
      g.gain.exponentialRampToValueAtTime(EPS, t + 0.04);
    }
    if (voice && voice.stop) voice.stop(t + 0.06);
  } catch (e) { /* already finished */ }
}

export class Music {
  /**
   * @param {AudioContext} ac
   * @param {AudioNode} dest      the music bus (already volume-controlled)
   * @param {ReverbBus} rev
   * @param {DelayBus} dly
   * @param {number} seed
   */
  constructor(ac, dest, rev, dly, seed = 1337) {
    this.ac = ac; this.out = dest; this.rev = rev; this.dly = dly;
    this.rnd = mulberry32(seed >>> 0 || 1);
    this.running = false;
    this.intensity = 0; this._iRamped = 0;
    this.name = 'tartarus'; this.pending = null;
    this.cur = BIOMES.tartarus;
    this.step = 0; this.bar = 0; this.nextT = 0;
    this.poly = new Poly(64);
    this.padVoices = [];
    this.drone = null;
    this._chordIdx = -1;
    this._bassDup = 0;

    // per-layer gain nodes + their sends
    this.busses = {};
    for (const L of LAYERS) {
      const g = ac.createGain(); g.gain.value = 0;
      g.connect(dest);
      const rs = ac.createGain(); rs.gain.value = 0.20; g.connect(rs); if (rev) rs.connect(rev.input);
      const ds = ac.createGain(); ds.gain.value = 0.0;  g.connect(ds); if (dly) ds.connect(dly.input);
      this.busses[L] = { gain: g, rev: rs, dly: ds };
    }
    this.busses.pad.rev.gain.value = 0.45;
    this.busses.lead.dly.gain.value = 0.28;
    this.busses.pluck.dly.gain.value = 0.14;
    this.busses.perc.rev.gain.value = 0.10;
    this.busses.bass.rev.gain.value = 0.04;

    // the choir's fixed formant bank — three parallel bandpasses that do NOT
    // follow pitch, which is what stops a stack of saws sounding like a synth
    this.padIn = ac.createGain(); this.padIn.gain.value = 1;
    const mix = this.busses.pad.gain;
    for (const [f, q, a] of [[620, 5.5, 1.0], [1180, 7, 0.55], [2650, 8, 0.22]]) {
      const bp = filter(ac, 'bandpass', f, q), bg = gain(ac, a);
      this.padIn.connect(bp); bp.connect(bg); bg.connect(mix);
    }
    const dry = gain(ac, 0.34); this.padIn.connect(dry); dry.connect(mix);
    // slow breath on the whole choir
    this.padLfo = null;

    // instruments
    this.banks = {
      bouzouki: new PluckBank(ac, 'bouzouki', 0x51a1),
      lyre: new PluckBank(ac, 'lyre', 0x7c3e),
      harp: new PluckBank(ac, 'harp', 0x2f90),
      bassPluck: new PluckBank(ac, 'bass', 0x1d44),
    };
  }

  /** Render the plucked-string banks. ~40ms, once, at unlock. */
  prime() {
    this.banks.bouzouki.prime();
    this.banks.lyre.prime();
    this.banks.bassPluck.prime();
    return this;
  }

  get stepDur() { const B = this.cur; return (60 / B.bpm) * B.beatsPerBar / B.steps; }
  get barDur() { const B = this.cur; return (60 / B.bpm) * B.beatsPerBar; }
  get loopBars() { let n = 0; for (const [, b] of this.cur.prog) n += b; return n; }

  chordDegreeFor(bar) {
    const P = this.cur.prog;
    let b = bar % this.loopBars;
    for (let i = 0; i < P.length; i++) { if (b < P[i][1]) return { deg: P[i][0], idx: i }; b -= P[i][1]; }
    return { deg: P[0][0], idx: 0 };
  }

  midiFor(ev, deg, layerOct) {
    const sc = SCALES[this.cur.scale] || SCALES.phrygianDominant;
    const d = (ev.t != null) ? deg + 2 * ev.t : deg + (ev.n || 0);
    return this.cur.root + degToSemi(sc, d) + 12 * ((layerOct || 0) + (ev.o || 0));
  }

  start(t) {
    if (this.running) return;
    this.running = true;
    const now = t ?? this.ac.currentTime;
    this.nextT = now + 0.08;
    this.step = 0; this.bar = 0; this._chordIdx = -1;
    this._applyLayerGains(now, 0.05);
    if (this.rev) this.rev.setSpace(this.cur.space, now, 0.1);
    if (this.dly) this.dly.setTime(this.barDur * (this.cur.delayMul ?? 0.75) / 4, now);
    // the choir's slow breath — a pad that does not move is a synth pad
    if (!this.padLfo) {
      this.padLfo = lfo(this.ac, 0.09, 0.16, 'sine', now);
      this.padLfo.connect(this.busses.pad.gain.gain);
    }
  }

  stop(t) {
    const now = t ?? this.ac.currentTime;
    this.running = false;
    for (const L of LAYERS) {
      const g = this.busses[L].gain.gain;
      g.cancelScheduledValues(now); g.setValueAtTime(Math.max(EPS, g.value), now);
      g.exponentialRampToValueAtTime(EPS, now + 0.8);
    }
    this._releasePad(now, 0.8);
    this._releaseDrone(now, 0.8);
    this.poly.stopAll();
  }

  setBiome(name) {
    const key = ALIAS[name] || name;
    if (!BIOMES[key] || key === this.name) return;
    this.pending = key;
  }

  /** Change biome with no transition. Only legal before start(). */
  jumpTo(name) {
    const key = ALIAS[name] || name;
    if (!BIOMES[key]) return;
    this.name = key; this.cur = BIOMES[key]; this.pending = null;
    this.bar = 0; this.step = 0; this._chordIdx = -1;
  }

  setIntensity(v) {
    this.intensity = clamp(+v || 0, 0, 1);
  }

  layerGain(L) {
    const cfg = this.cur.layers[L];
    if (!cfg) return 0;
    const k = smoothstep(cfg.lo, cfg.hi, this._iRamped);
    let g = cfg.gain * k * MIX;
    // the pad steps back as the band comes in — otherwise the mix turns to soup
    if (L === 'pad') g *= 1 - 0.42 * smoothstep(0.25, 0.8, this._iRamped);
    if (L === 'bass') g *= 0.82 + 0.18 * smoothstep(0, 0.5, this._iRamped);
    return g;
  }

  _applyLayerGains(t, ramp) {
    for (const L of LAYERS) {
      const p = this.busses[L].gain.gain;
      const target = Math.max(0.0001, this.layerGain(L));
      p.cancelScheduledValues(t);
      p.setValueAtTime(Math.max(0.0001, p.value), t);
      p.linearRampToValueAtTime(target, t + ramp);
    }
  }

  // ── chord-length voices ─────────────────────────────────────────────────
  _releasePad(t, r) {
    for (const v of this.padVoices) {
      releaseAt(v.gain.gain, t, r);
      v.stop(t + r + 0.05);
    }
    this.padVoices.length = 0;
  }

  _pad(t, deg) {
    const cfg = this.cur.layers.pad;
    if (!cfg) return;
    this._releasePad(t, cfg.release);
    const sc = SCALES[this.cur.scale];
    const g = gain(this.ac, 0);
    g.connect(this.padIn);
    const oscs = [];
    const vib = this.ac.createOscillator(); vib.type = 'sine';
    vib.frequency.value = 4.3 + this.rnd() * 0.7;
    const vg = gain(this.ac, 6.5); vib.connect(vg); vib.start(t);
    for (const step of cfg.voicing) {
      const m = this.cur.root + degToSemi(sc, deg + step) + 12 * (cfg.oct || 0);
      for (let u = 0; u < 2; u++) {
        const o = this.ac.createOscillator();
        o.setPeriodicWave(wave(this.ac, cfg.inst || 'choirAh'));
        o.frequency.setValueAtTime(midiToFreq(m), t);
        o.detune.setValueAtTime((u ? 1 : -1) * (5 + this.rnd() * 5), t);
        vg.connect(o.detune);
        const og = gain(this.ac, 0.34 / cfg.voicing.length);
        o.connect(og); og.connect(g);
        o.start(t);
        oscs.push(o);
      }
    }
    oscs.push(vib);
    attackTo(g.gain, t, 0.9, cfg.attack);
    const v = { gain: g, stop: (te) => { for (const o of oscs) { try { o.stop(te); } catch (e) { /* done */ } } } };
    this.padVoices.push(v);
  }

  _releaseDrone(t, r) {
    if (!this.drone) return;
    const d = this.drone; this.drone = null;
    releaseAt(d.gain.gain, t, r);
    if (d._c) releaseAt(d._c.gain.gain, t, r);   // the cluster has its own gain
    d.stop(t + r + 0.05);
  }

  _startDrone(t) {
    const cfg = this.cur.layers.tension;
    if (!cfg || this.drone) return;
    const bus = this.busses.tension.gain;
    const root = this.cur.root + 12 * (cfg.droneOct ?? -2);
    const v = stackVoice(this.ac, bus, t, midiToFreq(root), {
      voices: 3, spread: 13, wave: cfg.droneWave || 'bowed', cutoff: 300, q: 3, drive: 0.5, sub: 0.5,
    });
    // the semitone above the tonic — the sound of something being wrong
    const c = stackVoice(this.ac, bus, t, midiToFreq(root + 12 + (cfg.clusterSemi ?? 1)), {
      voices: 2, spread: 22, wave: 'bowed', cutoff: 900, q: 4,
    });
    attackTo(v.gain.gain, t, 0.55, 3.0);
    attackTo(c.gain.gain, t, 0.12, 5.0);
    // slow filter movement so a drone is never static
    const lo = this.ac.createOscillator(); lo.type = 'sine'; lo.frequency.value = 0.055;
    const lg = gain(this.ac, 170); lo.connect(lg); lg.connect(v.filter.frequency); lo.start(t);
    this.drone = {
      gain: v.gain,
      stop: (te) => { v.stop(te); c.stop(te); try { lo.stop(te); } catch (e) { /* done */ } },
    };
    // the cluster rides the same bus gain, released together
    this.drone._c = c;
  }

  // ── the scheduler ───────────────────────────────────────────────────────
  /** Called every rendered frame. Cheap when there is nothing to schedule. */
  update() {
    if (!this.running) return;
    const ac = this.ac;
    if (ac.state !== 'running') return;
    const now = ac.currentTime;
    // a backgrounded tab can leave nextT far in the past; resync rather than
    // trying to catch up and dumping 40 bars into one buffer
    if (this.nextT < now - 0.6) this.nextT = now + 0.05;
    let guard = 0;
    while (this.nextT < now + LOOKAHEAD && guard++ < 96) {
      this._scheduleStep(this.nextT);
      this.nextT += this.stepDur;
      this.step++;
      if (this.step >= this.cur.steps) { this.step = 0; this.bar++; }
    }
    this.poly.prune(now);
  }

  _scheduleStep(t) {
    const B = this.cur;
    const s = this.step;

    // ── bar line: intensity ramp, biome swap, chord change ────────────────
    if (s === 0) {
      // intensity moves at most a bounded amount per bar, so a spike in the
      // fight cannot yank the arrangement — it swells into it
      const d = this.intensity - this._iRamped;
      this._iRamped += clamp(d, -0.34, 0.5);
      this._applyLayerGains(t, this.barDur * 0.95);

      if (this.pending && (this.bar % 2 === 0)) {
        this._swap(this.pending, t);
        this.pending = null;
        return this._scheduleStep(t);       // re-enter with the new biome
      }

      const ch = this.chordDegreeFor(this.bar);
      if (ch.idx !== this._chordIdx) {
        this._chordIdx = ch.idx;
        this._pad(t, ch.deg);
      }
      if (this._iRamped > (B.layers.tension?.lo ?? 1) - 0.06) this._startDrone(t);
      else if (this.drone && this._iRamped < (B.layers.tension?.lo ?? 1) - 0.2) this._releaseDrone(t, 2.5);
    }

    const { deg } = this.chordDegreeFor(this.bar);
    const swing = (s % 2 === 1) ? (B.swing || 0) * this.stepDur : 0;
    const tt = t + swing;

    for (const L of LAYERS) {
      if (L === 'pad') continue;
      const cfg = B.layers[L];
      if (!cfg) continue;
      if (this.layerGain(L) < 0.004) continue;         // silent layers cost nothing
      const hot = this._iRamped > 0.55 && cfg.barsHot;
      const bank = hot ? cfg.barsHot : cfg.bars;
      if (!bank || !bank.length) continue;
      const barPat = bank[this.bar % bank.length];
      for (let i = 0; i < barPat.length; i++) {
        const ev = barPat[i];
        if (ev.s !== s) continue;
        if (ev.drum) this._drum(L, ev.drum, tt, ev.v ?? 1);
        else this._note(L, cfg, ev, deg, tt);
      }
    }
  }

  _drum(L, name, t, v) {
    const fn = DRUMS[name];
    if (!fn) return;
    fn(this.ac, this.busses[L].gain, t, v * (0.85 + this.rnd() * 0.3), this.rnd);
  }

  _note(L, cfg, ev, deg, t) {
    const ac = this.ac;
    const bus = this.busses[L].gain;
    const midi = this.midiFor(ev, deg, cfg.oct);
    const dur = (ev.d ?? 2) * this.stepDur;
    const v = (ev.v ?? 0.8) * (0.88 + this.rnd() * 0.24);
    const inst = cfg.inst;

    if (inst === 'bouzouki' || inst === 'lyre' || inst === 'harp' || inst === 'bassPluck') {
      const bank = this.banks[inst];
      const s = bank.play(bus, t, midi, {
        gain: 0.5 * v, dur: Math.max(0.09, dur * 0.98), release: 0.16,
        detune: (this.rnd() - 0.5) * 7,
      });
      // A stolen voice is FADED, never cut: s.stop() on a ringing string is an
      // audible click, and voice stealing happens exactly when the mix is
      // busiest and least able to hide it.
      this.poly.add({ end: t + dur + 0.4, prio: L === 'lead' ? 2 : 1, stop: () => fadeKill(ac, s._g, s) });
      return;
    }

    if (inst === 'bassAnalog') {
      const f = midiToFreq(midi);
      const vv = stackVoice(ac, bus, t, f, {
        voices: 2, spread: 7, wave: 'saw', cutoff: 220, q: 6, drive: 0.85, sub: 0.75,
      });
      sweep(vv.filter.frequency, t, 200 + 900 * v, 190, Math.min(0.20, dur * 0.6));
      adsr(vv.gain.gain, t, { peak: 0.55 * v, a: 0.006, d: Math.min(0.14, dur * 0.4), s: 0.55, hold: Math.max(0.01, dur * 0.5), r: 0.09 });
      vv.stop(t + dur + 0.3);
      this.poly.add({ end: t + dur + 0.3, prio: 3, stop: () => fadeKill(ac, vv.gain, vv) });
      return;
    }

    if (inst === 'ney') {
      // breathy end-blown flute: a soft-cored tone plus a lot of correlated air
      const g = gain(ac, 0); g.connect(bus);
      const lp = filter(ac, 'lowpass', 2600, 1.1); lp.connect(g);
      const o = osc(ac, lp, 'ney', midiToFreq(midi), t, t + dur + 0.45);
      const vib = ac.createOscillator(); vib.type = 'sine'; vib.frequency.setValueAtTime(5.1 + this.rnd() * 0.8, t);
      const vg = gain(ac, 0); vg.gain.setValueAtTime(0, t); vg.gain.linearRampToValueAtTime(10, t + dur * 0.5);
      vib.connect(vg); vg.connect(o.detune); vib.start(t); vib.stop(t + dur + 0.45);
      const bg = gain(ac, 0), bf = filter(ac, 'bandpass', midiToFreq(midi) * 2.2, 1.4);
      src(ac, bf, noise(ac, 'pink'), t, { offset: this.rnd() * 1.4, stop: t + dur + 0.4 });
      bf.connect(bg); bg.connect(g);
      adsr(bg.gain, t, { peak: 0.16 * v, a: 0.05, d: 0.08, s: 0.7, hold: Math.max(0.02, dur * 0.7), r: 0.2, curve: 'lin' });
      adsr(g.gain, t, { peak: 0.34 * v, a: 0.055, d: 0.1, s: 0.75, hold: Math.max(0.02, dur * 0.72), r: 0.26, curve: 'lin' });
      this.poly.add({ end: t + dur + 0.5, prio: 2, stop: () => fadeKill(ac, g, { stop: (te) => { try { o.stop(te); vib.stop(te); } catch (e) { /* done */ } } }) });
      return;
    }

    // fallback: a plain filtered stack, so an unknown instrument still sings
    const vv = stackVoice(ac, bus, t, midiToFreq(midi), { voices: 2, spread: 8, wave: 'organ', cutoff: 1800, q: 2 });
    adsr(vv.gain.gain, t, { peak: 0.3 * v, a: 0.01, d: 0.1, s: 0.6, hold: Math.max(0.02, dur * 0.6), r: 0.2 });
    vv.stop(t + dur + 0.3);
  }

  /** Change biome on a phrase line: crash in, new key, new room. */
  _swap(key, t) {
    const nb = BIOMES[key];
    if (!nb) return;
    this._releasePad(t, 0.9);
    this._releaseDrone(t, 1.2);
    this.name = key; this.cur = nb;
    this.bar = 0; this.step = 0; this._chordIdx = -1;
    if (this.rev) this.rev.setSpace(nb.space, t, 1.4);
    if (this.dly) this.dly.setTime(this.barDur * (nb.delayMul ?? 0.75) / 4, t);
    DRUMS.crash(this.ac, this.busses.perc.gain, t, 0.55, this.rnd);
    this._applyLayerGains(t, 0.9);
  }
}

export const MUSIC_BIOMES = Object.keys(BIOMES);
export const resolveBiomeName = (n) => (ALIAS[n] || n);
export const DRUM_NAMES = Object.keys(DRUMS);
