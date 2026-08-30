// Shared Cast language. Combat, the player animator and the projectile renderer
// all read this table so a god never launches one colour with another god's
// pose or embedded-shard motion.

export const CAST_SHARD_MAX = 3;
export const CAST_SHARD_DURATION = 8;
export const CAST_SHARD_BASE_BONUS = 0.25;

const DEFAULT = Object.freeze({
  clip: 'cast', fx: 'spark', form: 'bolt',
  spin: 3.2, pulse: 0.08, core: [0.86, 0.86, 1.22], trailWidth: 0.16,
});

const PRESENTATION = Object.freeze({
  zeus:       { clip: 'cast',       fx: 'sparkFine', form: 'storm', spin: 8.0, pulse: 0.18, core: [0.62, 0.62, 1.55], trailWidth: 0.13 },
  poseidon:   { clip: 'castSweep',  fx: 'wisp',      form: 'tide',  spin: 2.0, pulse: 0.14, core: [1.15, 0.72, 1.05], trailWidth: 0.24 },
  athena:     { clip: 'cast',       fx: 'shard',     form: 'aegis', spin: 1.2, pulse: 0.04, core: [1.18, 1.18, 0.92], trailWidth: 0.15 },
  aphrodite:  { clip: 'castSweep',  fx: 'mote',      form: 'heart', spin: 2.8, pulse: 0.22, core: [1.12, 0.82, 1.02], trailWidth: 0.22 },
  ares:       { clip: 'castRitual', fx: 'rune',      form: 'rift',  spin: 9.5, pulse: 0.10, core: [0.68, 1.28, 1.28], trailWidth: 0.20 },
  artemis:    { clip: 'cast',       fx: 'chev',      form: 'arrow', spin: 0.8, pulse: 0.03, core: [0.48, 0.48, 1.82], trailWidth: 0.11 },
  dionysus:   { clip: 'castSweep',  fx: 'wisp',      form: 'wine',  spin: 4.6, pulse: 0.28, core: [1.22, 1.22, 0.90], trailWidth: 0.25 },
  hermes:     { clip: 'cast',       fx: 'chev',      form: 'swift', spin: 6.8, pulse: 0.06, core: [0.52, 0.52, 1.62], trailWidth: 0.10 },
  hecate:     { clip: 'castRitual', fx: 'rune',      form: 'hex',   spin: 5.2, pulse: 0.20, core: [0.92, 1.20, 1.04], trailWidth: 0.21 },
  selene:     { clip: 'castRitual', fx: 'star',      form: 'moon',  spin: 1.8, pulse: 0.25, core: [1.28, 1.28, 0.72], trailWidth: 0.23 },
  hephaestus: { clip: 'cast',       fx: 'sparkFine', form: 'forge', spin: 1.0, pulse: 0.08, core: [1.30, 1.05, 0.86], trailWidth: 0.18 },
  demeter:    { clip: 'castRitual', fx: 'shard',     form: 'frost', spin: 3.8, pulse: 0.12, core: [1.06, 1.06, 1.12], trailWidth: 0.18 },
  apollo:     { clip: 'castSweep',  fx: 'star',      form: 'solar', spin: 4.0, pulse: 0.30, core: [1.24, 1.24, 0.76], trailWidth: 0.24 },
  hera:       { clip: 'castSweep',  fx: 'mote',      form: 'royal', spin: 2.2, pulse: 0.13, core: [1.18, 0.92, 1.00], trailWidth: 0.20 },
  hestia:     { clip: 'castRitual', fx: 'sparkFine', form: 'flame', spin: 7.0, pulse: 0.22, core: [0.72, 1.18, 1.26], trailWidth: 0.21 },
  chaos:      { clip: 'castRitual', fx: 'rune',      form: 'chaos', spin: -5.0, pulse: 0.32, core: [1.24, 0.82, 1.16], trailWidth: 0.25 },
  hades:      { clip: 'castRitual', fx: 'rune',      form: 'soul',  spin: -2.6, pulse: 0.16, core: [0.82, 1.22, 1.18], trailWidth: 0.19 },
});

export function castPresentation(god) {
  const style = PRESENTATION[god];
  return style ? { ...DEFAULT, ...style } : { ...DEFAULT };
}

export default castPresentation;
