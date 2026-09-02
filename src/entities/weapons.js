// OWNER: AGENT-COMBAT
// ---------------------------------------------------------------------------
// weapons.js — the Infernal Arms.  ALL TUNING IS DATA. The runtime below never
// contains a number that belongs to a weapon; it only reads this table.
//
// WHY THAT MATTERS: timings are the product. The reason Hades' blade feels
// different from its bow is not code, it is thirty numbers. Keeping them in one
// literal means a designer can retune the whole arsenal without ever opening
// the state machine, and means a diff of a balance pass is legible.
//
// THE FEEL CONTRACT, applied to every step:
//   WINDUP    must be READABLE. Nothing lands in under ~90ms of anticipation;
//             heavy commits telegraph for 200ms+ so they can be reacted to.
//   ACTIVE    must be SHORT and DECISIVE. 50-110ms. A long active frame turns
//             a swing into a bulldozer and destroys the reading of spacing.
//   RECOVERY  must be CANCELLABLE BY DASH well before it ends (see `cancel`),
//             because in this genre the dash is the answer to every mistake.
//   CHAIN     opens BEFORE recovery ends, so a buffered press flows instantly.
//   BUFFER    a press up to `buffer` seconds early is honoured. Generosity is
//             the difference between "tight" and "unresponsive".
//   PERFECT   a press that lands INSIDE the chain window (not mashed early,
//   CHAIN     not late) is a timed input: the next step comes out faster and
//             harder. Mashing still chains; timing is simply rewarded.
//   WEIGHT    every step declares how heavy it is. combat.js turns weight into
//             hit-stop and shake, so a finisher reads heavier than a jab even
//             when the numbers are close.
//
// FOUR WEAPONS, FOUR RHYTHMS:
//   blade   fast, close, 3-hit, the 3rd a committed lunge with root motion
//   spear   long reach, slow pokes, a charged THROW that sticks and is recalled
//   bow     charge-to-fire, damage/pierce scale with charge, power shot at full
//   shield  a block that absorbs AND REFLECTS, plus a charged bash dash-attack
// ---------------------------------------------------------------------------

import { TEAM } from './hitbox.js';

const GOLD = '#ffe9a8', EMBER = '#ffb04a', ARTERIAL = '#e01f2d';
const RIM = '#5fd0ff', VERD = '#3f8f7a', WITCH = '#8ef0d0';

// A step's derived timeline:  t0 = windup, t1 = windup+active, dur = t1+recovery
const step = (o) => {
  o.t0 = o.windup; o.t1 = o.windup + o.active; o.dur = o.t1 + o.recovery;
  if (o.chain == null) o.chain = o.t1 + o.recovery * 0.34;
  if (o.cancel == null) o.cancel = o.t1 + o.recovery * 0.18;
  if (o.turnLock == null) o.turnLock = o.windup * 0.72;
  return o;
};

export const WEAPONS = {

  // ═══════════════════════════════════════════════════════ STYGIAN BLADE ═══
  // The metronome. 3 hits in ~1.1s, tiny commitment on 1-2, a real one on 3.
  blade: {
    id: 'blade', name: 'Stygian Blade', kind: 'melee', character: 'zagreus',
    palette: { core: '#fffdf0', body: GOLD, glow: EMBER },
    buffer: 0.24, moveScale: 0.30, critChance: 0.08, critMul: 1.9,
    // the metronome pays for rhythm: a timed chain is 15% harder and 12% faster
    perfectChain: { window: 0.11, bonus: 0.15, speed: 1.12 },
    combo: [
      step({
        name: 'cut1', windup: 0.115, active: 0.075, recovery: 0.205, weight: 0.85,
        hitbox: { shape: 'arc', radius: 2.30, arcDeg: 128, offset: [0.35, 0], maxTargets: 4 },
        damage: 15, type: 'physical', knockback: 3.4, poise: 9, hitstop: 56,
        shake: { amp: 0.085, dur: 0.16, freq: 33 },
        root: { distance: 0.55, ease: 2.0 },
        vfx: { call: 'slash', arc: 132, radius: 2.35, width: 0.40, y: 1.05, spin: 1 },
        sfx: 'blade.swing1',
      }),
      step({
        name: 'cut2', windup: 0.095, active: 0.070, recovery: 0.195,
        hitbox: { shape: 'arc', radius: 2.35, arcDeg: 140, offset: [0.35, 0], maxTargets: 4 },
        damage: 15, type: 'physical', knockback: 3.7, poise: 10, hitstop: 62,
        shake: { amp: 0.095, dur: 0.17, freq: 33 },
        root: { distance: 0.62, ease: 2.0 },
        vfx: { call: 'slash', arc: 144, radius: 2.40, width: 0.44, y: 1.02, spin: -1 },
        sfx: 'blade.swing2',
      }),
      step({
        // THE COMMIT. Long tell, big arc, real root motion, real recovery.
        name: 'lunge', windup: 0.225, active: 0.105, recovery: 0.335,
        chain: 0.62, cancel: 0.44, weight: 1.3, finisher: true,
        hitbox: { shape: 'arc', radius: 2.85, arcDeg: 205, offset: [0.55, 0], maxTargets: 6 },
        damage: 29, type: 'physical', knockback: 7.4, poise: 26, hitstop: 98,
        shake: { amp: 0.165, dur: 0.26, freq: 29 },
        root: { distance: 2.65, ease: 2.6 },
        vfx: { call: 'slash', arc: 212, radius: 2.95, width: 0.60, y: 1.00, color: EMBER, spin: 1 },
        sfx: 'blade.lunge',
      }),
    ],
    // dash-strike: cheap, fast, the reason you dash INTO a fight
    dashAttack: step({
      name: 'dashcut', windup: 0.075, active: 0.070, recovery: 0.180,
      hitbox: { shape: 'arc', radius: 2.5, arcDeg: 160, offset: [0.5, 0], maxTargets: 5 },
      damage: 18, type: 'physical', knockback: 5.0, poise: 14, hitstop: 68,
      shake: { amp: 0.11, dur: 0.18, freq: 32 },
      root: { distance: 1.35, ease: 2.2 },
      vfx: { call: 'slash', arc: 168, radius: 2.6, width: 0.5, y: 1.1, color: RIM, spin: -1 },
      sfx: 'blade.dashcut',
    }),
    special: step({
      name: 'sweep', windup: 0.185, active: 0.090, recovery: 0.300, weight: 1.2,
      hitbox: { shape: 'ring', radius: 3.35, innerRadius: 0.6, arcDeg: 360, maxTargets: 10 },
      damage: 24, type: 'physical', knockback: 8.6, poise: 34, hitstop: 104,
      shake: { amp: 0.19, dur: 0.30, freq: 27 },
      vfx: { call: 'shockwave', radius: 3.4, color: EMBER, life: 0.42 },
      sfx: 'blade.sweep',
    }),
  },

  // ═══════════════════════════════════════════════════════ ETERNAL SPEAR ═══
  // Reach and patience. Pokes are capsules, not arcs — the hitbox is a LINE,
  // so spacing, not sweeping, is the skill. The throw is the payoff.
  spear: {
    id: 'spear', name: 'Eternal Spear', kind: 'melee', character: 'zagreus',
    palette: { core: '#f4ffff', body: VERD, glow: RIM },
    buffer: 0.26, moveScale: 0.38, critChance: 0.10, critMul: 2.0,
    perfectChain: { window: 0.12, bonus: 0.12, speed: 1.08 },
    // THE TIP. A thrust that lands with the far 38% of the shaft deals +35%,
    // pierces poise and crits more: the Spear's skill is DISTANCE.
    combo: [
      step({
        name: 'poke1', windup: 0.135, active: 0.060, recovery: 0.210, weight: 0.9,
        hitbox: { shape: 'capsule', radius: 0.62, length: 3.55, offset: [0.35, 0], maxTargets: 3, pierce: 3, tipBonus: 0.35, tipFrom: 0.62 },
        damage: 17, type: 'physical', knockback: 4.2, poise: 10, hitstop: 58,
        shake: { amp: 0.075, dur: 0.15, freq: 34 },
        root: { distance: 0.95, ease: 2.4 },
        vfx: { call: 'thrust', length: 3.9, width: 0.30, y: 1.10, color: VERD },
        sfx: 'spear.poke1',
      }),
      step({
        name: 'poke2', windup: 0.115, active: 0.060, recovery: 0.200, weight: 0.9,
        hitbox: { shape: 'capsule', radius: 0.64, length: 3.75, offset: [0.35, 0], maxTargets: 3, pierce: 3, tipBonus: 0.35, tipFrom: 0.62 },
        damage: 18, type: 'physical', knockback: 4.4, poise: 11, hitstop: 62,
        shake: { amp: 0.08, dur: 0.16, freq: 34 },
        root: { distance: 1.05, ease: 2.4 },
        vfx: { call: 'thrust', length: 4.1, width: 0.32, y: 1.06, color: VERD },
        sfx: 'spear.poke2',
      }),
      step({
        name: 'spin', windup: 0.200, active: 0.095, recovery: 0.320,
        chain: 0.58, cancel: 0.41, weight: 1.25, finisher: true,
        hitbox: { shape: 'ring', radius: 3.05, innerRadius: 0.5, arcDeg: 360, maxTargets: 8 },
        damage: 26, type: 'physical', knockback: 6.8, poise: 24, hitstop: 92,
        shake: { amp: 0.15, dur: 0.24, freq: 30 },
        root: { distance: 0.9, ease: 2.0 },
        vfx: { call: 'slash', arc: 350, radius: 3.1, width: 0.52, y: 0.98, color: RIM, spin: 1 },
        sfx: 'spear.spin',
      }),
    ],
    // DASH-STRIKE: a longer, narrower commitment than the Blade's dashcut.
    // The Spear should turn a dash into precise reach, not another circular
    // clear. It uses the normal Attack slot so Olympian riders, crit chance
    // and Hermes' post-dash payoff all remain part of the player's build.
    dashAttack: step({
      name: 'dashthrust', windup: 0.080, active: 0.065, recovery: 0.205, weight: 1.0,
      hitbox: { shape: 'capsule', radius: 0.70, length: 4.65, offset: [0.45, 0], maxTargets: 4, pierce: 4, tipBonus: 0.35, tipFrom: 0.62 },
      damage: 21, type: 'physical', knockback: 5.4, poise: 16, hitstop: 74,
      shake: { amp: 0.105, dur: 0.18, freq: 33 },
      root: { distance: 1.75, ease: 2.35 },
      vfx: { call: 'thrust', length: 5.0, width: 0.38, y: 1.08, color: RIM },
      sfx: 'spear.poke2',
    }),
    // CHARGED THROW: hold to wind, release to throw. The spear sticks where it
    // lands and is RECALLED — the recall is its own damaging projectile.
    charge: {
      action: 'special',
      minHold: 0.10, fullHold: 0.72,
      windup: 0.145, recovery: 0.285,
      tell: { color: VERD, ringFrom: 2.4, ringTo: 0.9 },
      projectile: {
        kind: 'straight', speed: 26, speedFull: 40, radius: 0.34, life: 1.05,
        damage: 22, damageFull: 52, pierce: 2, pierceFull: 5,
        type: 'physical', knockback: 6.0, hitstop: 88, color: VERD,
        size: 1.35, coreSize: 1.5, hero: true, stick: true, onExpire: 'impact',
      },
      recall: {
        speed: 34, damage: 16, damageFull: 30, pierce: 8, radius: 0.42,
        color: RIM, hitstop: 54, knockback: 3.5,
      },
      shake: { amp: 0.13, dur: 0.22, freq: 30 },
      sfx: 'spear.throw',
    },
  },

  // ═════════════════════════════════════════════════ HEART-SEEKING BOW ═════
  // Charge-to-fire. The whole weapon is one decision: how long do you dare hold
  // still. Damage and pierce scale continuously; the full charge is a POWER
  // SHOT with its own colour, its own sound and a much bigger payload.
  bow: {
    id: 'bow', name: 'Heart-Seeking Bow', kind: 'ranged', character: 'zagreus',
    palette: { core: '#ffffff', body: GOLD, glow: RIM },
    buffer: 0.20, moveScale: 0.55, critChance: 0.14, critMul: 2.35,
    charge: {
      action: 'attack',
      minHold: 0.06, fullHold: 0.58, overHold: 0.78,   // past overHold it decays back
      // THREE DRAWS, not a slider: a flick, a half draw, the power shot. The
      // release quantises to the tier reached so each one is learnable by ear
      // (a tick per tier) and by eye (a ring pulse), and the numbers are
      // exactly three numbers instead of a continuum nobody can feel.
      tiers: [0.36, 0.70, 1.0],
      windup: 0.055, recovery: 0.230, recoveryFull: 0.320,
      tell: { color: GOLD, ringFrom: 1.9, ringTo: 0.55 },
      projectile: {
        kind: 'straight', speed: 34, speedFull: 52, radius: 0.22, life: 1.5,
        damage: 12, damageFull: 44, pierce: 1, pierceFull: 4,
        type: 'physical', knockback: 2.4, knockbackFull: 7.5,
        hitstop: 40, hitstopFull: 96, color: GOLD, colorFull: '#fffdf0',
        size: 0.95, sizeFull: 1.9, coreSize: 1.0, coreSizeFull: 1.7, hero: true,
        crit: 0.0, critFull: 0.35,
      },
      shake: { amp: 0.05, dur: 0.12, freq: 36 }, shakeFull: { amp: 0.16, dur: 0.26, freq: 28 },
      sfx: 'bow.loose', sfxFull: 'bow.power',
    },
    // SNAP SHOT: the dash-strike. No draw, a fast twin flick at whatever you
    // dashed toward. Cheap damage, real pierce, keeps the bow moving.
    dashAttack: step({
      name: 'snapshot', windup: 0.055, active: 0.040, recovery: 0.150, weight: 0.8,
      projectile: { kind: 'straight', speed: 40, radius: 0.20, life: 1.1, damage: 11, pierce: 2, count: 2, spread: 0.085,
        type: 'physical', knockback: 2.0, hitstop: 30, color: RIM, size: 0.9, coreSize: 0.9, hero: true },
      shake: { amp: 0.06, dur: 0.12, freq: 34 },
      sfx: 'bow.loose',
    }),
    // point-blank kick — the bow's answer to being cornered
    special: step({
      name: 'kick', windup: 0.105, active: 0.070, recovery: 0.240, weight: 1.1,
      hitbox: { shape: 'arc', radius: 2.05, arcDeg: 150, offset: [0.3, 0], maxTargets: 5 },
      damage: 14, type: 'physical', knockback: 11.0, poise: 30, hitstop: 74,
      shake: { amp: 0.12, dur: 0.20, freq: 31 },
      vfx: { call: 'shockwave', radius: 2.2, color: RIM, life: 0.30 },
      sfx: 'bow.kick',
    }),
  },

  // ════════════════════════════════════════════════════ SHIELD OF CHAOS ════
  // The only weapon with a defensive state. Block absorbs damage in a frontal
  // arc, REFLECTS projectiles back doubled, and charges the bash while held.
  shield: {
    id: 'shield', name: 'Shield of Chaos', kind: 'melee', character: 'zagreus',
    palette: { core: '#ffffff', body: '#c9b8ff', glow: RIM },
    buffer: 0.24, moveScale: 0.34, critChance: 0.06, critMul: 1.8,
    combo: [
      step({
        name: 'punch1', windup: 0.120, active: 0.070, recovery: 0.215,
        hitbox: { shape: 'box', halfLength: 1.35, halfWidth: 0.95, offset: [1.35, 0], maxTargets: 4 },
        damage: 16, type: 'physical', knockback: 5.2, poise: 16, hitstop: 64,
        shake: { amp: 0.10, dur: 0.17, freq: 32 },
        root: { distance: 0.7, ease: 2.1 },
        vfx: { call: 'slash', arc: 96, radius: 2.1, width: 0.55, y: 1.05, color: '#c9b8ff', spin: 1 },
        sfx: 'shield.bash1',
      }),
      step({
        name: 'punch2', windup: 0.135, active: 0.080, recovery: 0.290, weight: 1.25, finisher: true,
        hitbox: { shape: 'box', halfLength: 1.55, halfWidth: 1.10, offset: [1.5, 0], maxTargets: 5 },
        damage: 25, type: 'physical', knockback: 9.5, poise: 30, hitstop: 96,
        shake: { amp: 0.17, dur: 0.26, freq: 28 },
        root: { distance: 1.0, ease: 2.1 },
        vfx: { call: 'shockwave', radius: 2.6, color: '#c9b8ff', life: 0.34 },
        sfx: 'shield.bash2',
      }),
    ],
    block: {
      action: 'special',
      raise: 0.085,                 // frames before the guard is live — a real tell
      arcDeg: 190, absorb: 0.86,    // 86% of damage in the arc is eaten
      chipMul: 0.14, reflectMul: 2.0, reflectSpeed: 1.4,
      perfect: 0.16,                // a parry window at the start of the raise
      perfectHitstop: 120, perfectSlowmo: [0.35, 0.22],
      // THE PARRY PAYS TWICE: the attacker is staggered for `stagger` seconds
      // and the next Attack inside `ripostFor` seconds deals +riposte.
      parry: { stagger: 0.75, riposte: 0.5, riposteFor: 2.0 },
      color: '#c9b8ff', sfx: 'shield.block', sfxReflect: 'shield.reflect',
    },
    charge: {
      action: 'special', requiresBlock: true,
      minHold: 0.30, fullHold: 1.05,
      windup: 0.090, recovery: 0.300,
      dash: { distance: 5.4, distanceFull: 9.2, time: 0.20, timeFull: 0.30 },
      hitbox: { shape: 'circle', radius: 1.25, maxTargets: 6, pierce: 6 },
      damage: 22, damageFull: 46, knockback: 9.0, knockbackFull: 15.0,
      poise: 40, hitstop: 92, hitstopFull: 128,
      shake: { amp: 0.14, dur: 0.24, freq: 29 }, shakeFull: { amp: 0.24, dur: 0.34, freq: 25 },
      color: '#c9b8ff', sfx: 'shield.rush',
    },
  },

  // ═════════════════════════════════════════════════════ TWIN FISTS ════════
  fists: {
    id: 'fists', name: 'Twin Fists of Malphon', kind: 'melee', character: 'zagreus',
    palette: { core: '#fff8dd', body: '#c97945', glow: '#ffcf5a' },
    buffer: 0.30, moveScale: 0.22, critChance: 0.12, critMul: 2.0,
    // FLURRY: each chained jab comes out 7% faster than the last, so a full
    // string accelerates into the uppercut; timed chains add on top.
    chainAccel: 0.07, perfectChain: { window: 0.09, bonus: 0.10, speed: 1.10 },
    combo: [
      step({ name: 'jab1', windup: 0.06, active: 0.05, recovery: 0.10, weight: 0.7,
        hitbox: { shape: 'box', halfLength: 1.05, halfWidth: 0.58, offset: [1.0, 0], maxTargets: 2 }, damage: 9,
        knockback: 1.8, poise: 6, hitstop: 36, root: { distance: 0.42, ease: 2.8 },
        vfx: { call: 'thrust', length: 2.1, width: 0.25, y: 1.04, color: '#ffcf5a' }, sfx: 'shield.bash1' }),
      step({ name: 'jab2', windup: 0.055, active: 0.05, recovery: 0.10,
        hitbox: { shape: 'box', halfLength: 1.08, halfWidth: 0.6, offset: [1.02, 0], maxTargets: 2 }, damage: 10,
        knockback: 2.0, poise: 7, hitstop: 39, root: { distance: 0.45, ease: 2.8 },
        vfx: { call: 'thrust', length: 2.15, width: 0.26, y: 1.08, color: '#fff8dd' }, sfx: 'shield.bash1' }),
      step({ name: 'jab3', windup: 0.07, active: 0.055, recovery: 0.12,
        hitbox: { shape: 'arc', radius: 1.65, arcDeg: 110, offset: [0.35, 0], maxTargets: 3 }, damage: 12,
        knockback: 2.8, poise: 9, hitstop: 44, root: { distance: 0.52, ease: 2.7 },
        vfx: { call: 'slash', arc: 116, radius: 1.75, width: 0.29, y: 1.0, color: '#c97945', spin: 1 }, sfx: 'blade.swing1' }),
      step({ name: 'jab4', windup: 0.10, active: 0.07, recovery: 0.19, weight: 1.2, finisher: true,
        hitbox: { shape: 'box', halfLength: 1.45, halfWidth: 0.78, offset: [1.35, 0], maxTargets: 4 }, damage: 20,
        knockback: 6.0, poise: 20, hitstop: 72, root: { distance: 1.05, ease: 2.6 },
        vfx: { call: 'thrust', length: 2.9, width: 0.44, y: 1.12, color: '#ffcf5a' }, sfx: 'shield.bash2' }),
    ],
    dashAttack: step({ name: 'dashupper', windup: 0.055, active: 0.06, recovery: 0.14,
      hitbox: { shape: 'box', halfLength: 1.45, halfWidth: 0.72, offset: [1.35, 0], maxTargets: 4 }, damage: 17,
      knockback: 4.8, poise: 16, hitstop: 62, root: { distance: 1.25, ease: 2.8 },
      vfx: { call: 'thrust', length: 2.9, width: 0.4, y: 1.05, color: '#fff8dd' }, sfx: 'shield.rush' }),
    special: step({ name: 'uppercut', windup: 0.12, active: 0.075, recovery: 0.22, weight: 1.2,
      hitbox: { shape: 'arc', radius: 2.05, arcDeg: 145, offset: [0.45, 0], maxTargets: 5 }, damage: 27,
      knockback: 9.0, poise: 31, hitstop: 94, root: { distance: 1.0, ease: 2.5 },
      vfx: { call: 'slash', arc: 152, radius: 2.15, width: 0.48, y: 1.12, color: '#ffcf5a', spin: -1 }, sfx: 'blade.lunge' }),
  },

  // ═══════════════════════════════════════════════════ ADAMANT RAIL ════════
  rail: {
    id: 'rail', name: 'Adamant Rail', kind: 'ranged', character: 'zagreus',
    palette: { core: '#fff4cf', body: '#80566f', glow: '#ff9b42' },
    buffer: 0.20, moveScale: 0.62, critChance: 0.09, critMul: 2.05,
    // THE LAST ROUND is the one that matters: +50% damage, a real hit-stop,
    // and the reload that follows it is the Rail's recovery frame.
    magazine: { capacity: 6, reload: 1.35 },
    lastRound: { dmgMul: 1.5, hitstop: 70 },
    // HIP-FIRE: the dash-strike is a two-round burst that does not spend the
    // magazine. Cheap, fast, and the reason to dash INTO a lane.
    dashAttack: step({
      name: 'hipfire', windup: 0.045, active: 0.040, recovery: 0.140, weight: 0.75,
      projectile: { kind: 'straight', speed: 36, radius: 0.16, life: 1.0, damage: 8, pierce: 1, count: 2, spread: 0.06,
        type: 'physical', knockback: 1.2, hitstop: 22, color: '#ff9b42', size: 0.7, coreSize: 0.6, hero: true },
      shake: { amp: 0.04, dur: 0.1, freq: 38 },
      sfx: 'bow.loose',
    }),
    charge: { action: 'attack', minHold: 0.04, fullHold: 0.48, windup: 0.035, recovery: 0.16, recoveryFull: 0.23,
      tell: { color: '#ff9b42' }, projectile: { kind: 'straight', speed: 34, speedFull: 42, radius: 0.16, life: 1.05,
        damage: 7, damageFull: 14, pierce: 1, pierceFull: 1, type: 'physical', knockback: 1.0, knockbackFull: 2.0,
        hitstop: 22, hitstopFull: 38, color: '#fff4cf', colorFull: '#ff9b42', size: 0.62, sizeFull: 0.92,
        coreSize: 0.55, coreSizeFull: 0.9, hero: true },
      shake: { amp: 0.03, dur: 0.08, freq: 40 }, shakeFull: { amp: 0.08, dur: 0.15, freq: 34 }, sfx: 'bow.loose', sfxFull: 'bow.power' },
    special: step({ name: 'bombard', windup: 0.26, active: 0.10, recovery: 0.42, weight: 1.3,
      hitbox: { shape: 'ring', radius: 3.15, innerRadius: 0.6, arcDeg: 360, maxTargets: 8 }, damage: 25, type: 'fire',
      knockback: 6.0, poise: 32, hitstop: 82, shake: { amp: 0.17, dur: 0.28, freq: 25 },
      vfx: { call: 'shockwave', radius: 3.2, color: '#ff9b42', life: 0.46 }, sfx: 'shield.rush' }),
  },

  // ═══════════════════════════════════════════════════ WITCH'S STAFF ══════
  // Melinoe's teaching arm: measured staff strings at reach, then an Omega
  // orb on Special. The charge is mobile but deliberately punishable.
  staff: {
    id: 'staff', name: "Witch's Staff", kind: 'melee', character: 'melinoe',
    palette: { core: '#e9ffe8', body: '#68cfae', glow: '#f3a45d' },
    buffer: 0.25, moveScale: 0.42, critChance: 0.09, critMul: 2.0,
    perfectChain: { window: 0.12, bonus: 0.12, speed: 1.08 },
    dashAttack: step({ name: 'dashstaff', windup: 0.07, active: 0.06, recovery: 0.18, weight: 0.95,
      hitbox: { shape: 'capsule', radius: 0.7, length: 4.1, offset: [0.4, 0], maxTargets: 4, pierce: 4, tipBonus: 0.25, tipFrom: 0.6 },
      damage: 19, type: 'arcane', knockback: 4.6, poise: 15, hitstop: 66, root: { distance: 1.5, ease: 2.4 },
      vfx: { call: 'thrust', length: 4.4, width: 0.36, y: 1.06, color: '#f3a45d' }, sfx: 'spear.poke2' }),
    combo: [
      step({ name: 'staff1', windup: 0.12, active: 0.065, recovery: 0.19, weight: 0.9,
        hitbox: { shape: 'capsule', radius: 0.66, length: 3.15, offset: [0.30, 0], maxTargets: 4, pierce: 4, tipBonus: 0.25, tipFrom: 0.62 },
        damage: 16, type: 'arcane', knockback: 3.8, poise: 11, hitstop: 58,
        shake: { amp: 0.075, dur: 0.15, freq: 34 }, root: { distance: 0.72, ease: 2.2 },
        vfx: { call: 'thrust', length: 3.45, width: 0.33, y: 1.04, color: '#68cfae' }, sfx: 'spear.poke1' }),
      step({ name: 'staff2', windup: 0.11, active: 0.075, recovery: 0.21,
        hitbox: { shape: 'arc', radius: 2.75, arcDeg: 175, offset: [0.25, 0], maxTargets: 6 },
        damage: 20, type: 'arcane', knockback: 5.2, poise: 16, hitstop: 70,
        shake: { amp: 0.10, dur: 0.18, freq: 31 }, root: { distance: 0.82, ease: 2.1 },
        vfx: { call: 'slash', arc: 184, radius: 2.8, width: 0.46, y: 1.0, color: '#f3a45d', spin: -1 }, sfx: 'blade.swing2' }),
      step({ name: 'staff3', windup: 0.19, active: 0.09, recovery: 0.29, weight: 1.25, finisher: true,
        hitbox: { shape: 'ring', radius: 3.15, innerRadius: 0.35, arcDeg: 360, maxTargets: 10 },
        damage: 29, type: 'arcane', knockback: 7.0, poise: 26, hitstop: 92,
        shake: { amp: 0.15, dur: 0.25, freq: 28 }, root: { distance: 0.45, ease: 2.0 },
        vfx: { call: 'shockwave', radius: 3.2, color: '#68cfae', life: 0.38 }, sfx: 'blade.sweep' }),
    ],
    charge: { action: 'special', minHold: 0.10, fullHold: 0.78, windup: 0.10, recovery: 0.28,
      tell: { color: '#68cfae' }, projectile: { kind: 'straight', speed: 21, speedFull: 34, radius: 0.34, life: 1.35,
        damage: 18, damageFull: 54, pierce: 2, pierceFull: 7, type: 'arcane', knockback: 3.5, knockbackFull: 8.0,
        hitstop: 52, hitstopFull: 96, color: '#68cfae', colorFull: '#f3a45d', size: 1.1, sizeFull: 2.1,
        coreSize: 0.8, coreSizeFull: 1.7, hero: true, onExpire: 'burst' },
      shake: { amp: 0.08, dur: 0.15, freq: 33 }, shakeFull: { amp: 0.17, dur: 0.26, freq: 27 }, sfx: 'bow.loose', sfxFull: 'bow.power' },
  },

  // ═══════════════════════════════════════════════════ SISTER BLADES ══════
  blades: {
    id: 'blades', name: 'Sister Blades', kind: 'melee', character: 'melinoe',
    palette: { core: '#f7fff0', body: '#8bd7be', glow: '#ff8a65' },
    buffer: 0.29, moveScale: 0.24, critChance: 0.15, critMul: 2.15,
    chainAccel: 0.05, perfectChain: { window: 0.09, bonus: 0.14, speed: 1.12 },
    combo: [
      step({ name: 'knife1', windup: 0.075, active: 0.055, recovery: 0.135, weight: 0.75,
        hitbox: { shape: 'arc', radius: 1.9, arcDeg: 105, offset: [0.35, 0], maxTargets: 3 }, damage: 11,
        knockback: 2.1, poise: 7, hitstop: 42, root: { distance: 0.65, ease: 2.5 },
        vfx: { call: 'slash', arc: 112, radius: 2.0, width: 0.28, y: 1.0, color: '#8bd7be', spin: 1 }, sfx: 'blade.swing1' }),
      step({ name: 'knife2', windup: 0.065, active: 0.055, recovery: 0.14,
        hitbox: { shape: 'arc', radius: 2.0, arcDeg: 118, offset: [0.38, 0], maxTargets: 3 }, damage: 12,
        knockback: 2.4, poise: 8, hitstop: 46, root: { distance: 0.72, ease: 2.5 },
        vfx: { call: 'slash', arc: 124, radius: 2.08, width: 0.3, y: 1.05, color: '#ff8a65', spin: -1 }, sfx: 'blade.swing2' }),
      step({ name: 'knife3', windup: 0.13, active: 0.075, recovery: 0.22, weight: 1.2, finisher: true,
        hitbox: { shape: 'box', halfLength: 1.7, halfWidth: 0.78, offset: [1.45, 0], maxTargets: 5 }, damage: 23,
        knockback: 5.2, poise: 18, hitstop: 76, root: { distance: 1.75, ease: 2.7 },
        vfx: { call: 'thrust', length: 3.2, width: 0.42, y: 1.02, color: '#f7fff0' }, sfx: 'blade.lunge' }),
    ],
    dashAttack: step({ name: 'shadowcut', windup: 0.055, active: 0.055, recovery: 0.145,
      hitbox: { shape: 'arc', radius: 2.15, arcDeg: 135, offset: [0.45, 0], maxTargets: 4 }, damage: 16,
      knockback: 3.2, poise: 11, hitstop: 55, root: { distance: 1.15, ease: 2.6 },
      vfx: { call: 'slash', arc: 142, radius: 2.25, width: 0.33, y: 1.06, color: '#8bd7be', spin: -1 }, sfx: 'blade.dashcut' }),
    charge: { action: 'special', minHold: 0.06, fullHold: 0.54, windup: 0.06, recovery: 0.19,
      tell: { color: '#ff8a65' }, projectile: { kind: 'straight', speed: 33, speedFull: 48, radius: 0.18, life: 1.15,
        damage: 13, damageFull: 36, pierce: 1, pierceFull: 4, type: 'physical', knockback: 1.8, knockbackFull: 4.2,
        hitstop: 38, hitstopFull: 70, color: '#8bd7be', colorFull: '#ff8a65', size: 0.8, sizeFull: 1.35,
        coreSize: 0.7, coreSizeFull: 1.1, hero: true, crit: 0.08, critFull: 0.28 },
      shake: { amp: 0.04, dur: 0.1, freq: 36 }, shakeFull: { amp: 0.1, dur: 0.18, freq: 31 }, sfx: 'bow.loose', sfxFull: 'bow.power' },
  },

  // ═══════════════════════════════════════════════════ UMBRAL FLAMES ══════
  flames: {
    id: 'flames', name: 'Umbral Flames', kind: 'ranged', character: 'melinoe',
    palette: { core: '#eefff8', body: '#55c7a5', glow: '#ff7a4f' },
    buffer: 0.22, moveScale: 0.70, critChance: 0.08, critMul: 1.85,
    charge: { action: 'attack', minHold: 0.04, fullHold: 0.62, windup: 0.04, recovery: 0.15, recoveryFull: 0.22,
      tell: { color: '#55c7a5' }, projectile: { kind: 'homing', speed: 20, speedFull: 29, radius: 0.24, life: 1.75,
        damage: 10, damageFull: 30, pierce: 1, pierceFull: 3, type: 'arcane', knockback: 1.4, knockbackFull: 3.6,
        hitstop: 34, hitstopFull: 64, color: '#55c7a5', colorFull: '#ff7a4f', size: 0.82, sizeFull: 1.55,
        coreSize: 0.72, coreSizeFull: 1.3, hero: true, onExpire: 'burst' },
      shake: { amp: 0.035, dur: 0.1, freq: 36 }, shakeFull: { amp: 0.10, dur: 0.18, freq: 31 }, sfx: 'bow.loose', sfxFull: 'charge.full' },
    dashAttack: step({ name: 'dashflare', windup: 0.05, active: 0.04, recovery: 0.15, weight: 0.8,
      projectile: { kind: 'homing', homing: 6, speed: 24, radius: 0.24, life: 1.4, damage: 12, pierce: 1, count: 3, spread: 0.34,
        type: 'arcane', knockback: 1.6, hitstop: 28, color: '#ff7a4f', size: 0.85, coreSize: 0.75, hero: true, onExpire: 'burst' },
      shake: { amp: 0.05, dur: 0.1, freq: 36 }, sfx: 'bow.loose' }),
    special: step({ name: 'orbit', windup: 0.13, active: 0.12, recovery: 0.22, weight: 1.1,
      hitbox: { shape: 'ring', radius: 3.25, innerRadius: 1.05, arcDeg: 360, maxTargets: 10 }, damage: 21, type: 'arcane',
      knockback: 4.4, poise: 20, hitstop: 65, shake: { amp: 0.11, dur: 0.2, freq: 30 },
      vfx: { call: 'shockwave', radius: 3.3, color: '#ff7a4f', life: 0.44 }, sfx: 'blade.sweep' }),
  },

  // ═══════════════════════════════════════════════════ MOONSTONE AXE ══════
  axe: {
    id: 'axe', name: 'Moonstone Axe', kind: 'melee', character: 'melinoe',
    palette: { core: '#e8fff5', body: '#75bca9', glow: '#ff9a62' },
    buffer: 0.28, moveScale: 0.20, critChance: 0.07, critMul: 2.25,
    // the Axe rewards the timed chain most of all: hew2 is the heaviest hit
    // in the arsenal, and a perfect chain into it is the whole weapon
    perfectChain: { window: 0.14, bonus: 0.20, speed: 1.15 },
    dashAttack: step({ name: 'dashhew', windup: 0.10, active: 0.08, recovery: 0.22, weight: 1.15,
      hitbox: { shape: 'arc', radius: 2.9, arcDeg: 150, offset: [0.5, 0], maxTargets: 6 }, damage: 26,
      knockback: 7.0, poise: 28, hitstop: 88, root: { distance: 1.6, ease: 2.3 }, shake: { amp: 0.13, dur: 0.2, freq: 30 },
      vfx: { call: 'slash', arc: 158, radius: 3.0, width: 0.6, y: 1.1, color: '#ff9a62', spin: -1 }, sfx: 'blade.dashcut' }),
    combo: [
      step({ name: 'hew1', windup: 0.22, active: 0.10, recovery: 0.30, weight: 1.2,
        hitbox: { shape: 'arc', radius: 3.15, arcDeg: 185, offset: [0.45, 0], maxTargets: 7 }, damage: 31,
        knockback: 8.8, poise: 34, hitstop: 105, shake: { amp: 0.18, dur: 0.28, freq: 27 }, root: { distance: 0.85, ease: 2.0 },
        vfx: { call: 'slash', arc: 192, radius: 3.25, width: 0.68, y: 1.12, color: '#75bca9', spin: 1 }, sfx: 'blade.lunge' }),
      step({ name: 'hew2', windup: 0.28, active: 0.12, recovery: 0.38, weight: 1.5, finisher: true,
        hitbox: { shape: 'ring', radius: 3.7, innerRadius: 0.55, arcDeg: 360, maxTargets: 12 }, damage: 48,
        knockback: 12.0, poise: 48, hitstop: 132, shake: { amp: 0.26, dur: 0.36, freq: 24 }, root: { distance: 1.05, ease: 1.9 },
        vfx: { call: 'shockwave', radius: 3.75, color: '#ff9a62', life: 0.52 }, sfx: 'shield.rush' }),
    ],
    special: step({ name: 'moonwall', windup: 0.16, active: 0.11, recovery: 0.25,
      hitbox: { shape: 'arc', radius: 2.8, arcDeg: 230, offset: [0.2, 0], maxTargets: 9 }, damage: 25, type: 'arcane',
      knockback: 10, poise: 40, hitstop: 90, shake: { amp: 0.16, dur: 0.25, freq: 28 },
      vfx: { call: 'slash', arc: 240, radius: 2.9, width: 0.72, y: 1.15, color: '#e8fff5', spin: -1 }, sfx: 'shield.block' }),
  },

  // ═════════════════════════════════════════════════════ ARGENT SKULL ══════
  skull: {
    id: 'skull', name: 'Argent Skull', kind: 'ranged', character: 'melinoe',
    palette: { core: '#f5fff4', body: '#9fc9ba', glow: '#ff8359' },
    buffer: 0.24, moveScale: 0.58, critChance: 0.11, critMul: 2.15,
    charge: { action: 'attack', minHold: 0.05, fullHold: 0.48, windup: 0.05, recovery: 0.24, recoveryFull: 0.31,
      tell: { color: '#ff8359' }, projectile: { kind: 'straight', speed: 25, speedFull: 37, radius: 0.38, life: 1.15,
        damage: 18, damageFull: 50, pierce: 1, pierceFull: 2, type: 'arcane', knockback: 5.2, knockbackFull: 10.5,
        hitstop: 58, hitstopFull: 105, color: '#9fc9ba', colorFull: '#ff8359', size: 1.25, sizeFull: 2.25,
        coreSize: 1.0, coreSizeFull: 1.8, hero: true, onExpire: 'burst' },
      shake: { amp: 0.08, dur: 0.15, freq: 32 }, shakeFull: { amp: 0.2, dur: 0.3, freq: 25 }, sfx: 'bow.loose', sfxFull: 'shield.rush' },
    dashAttack: step({ name: 'dashskull', windup: 0.06, active: 0.07, recovery: 0.17, weight: 1.0,
      hitbox: { shape: 'box', halfLength: 1.7, halfWidth: 0.9, offset: [1.5, 0], maxTargets: 5 }, damage: 20, type: 'arcane',
      knockback: 6.2, poise: 22, hitstop: 70, root: { distance: 1.8, ease: 2.7 }, shake: { amp: 0.1, dur: 0.17, freq: 31 },
      vfx: { call: 'thrust', length: 3.6, width: 0.56, y: 0.95, color: '#ff8359' }, sfx: 'shield.rush' }),
    special: step({ name: 'skullrush', windup: 0.10, active: 0.09, recovery: 0.23, weight: 1.15,
      hitbox: { shape: 'box', halfLength: 2.0, halfWidth: 1.0, offset: [1.65, 0], maxTargets: 7 }, damage: 23, type: 'arcane',
      knockback: 8.2, poise: 31, hitstop: 82, root: { distance: 2.4, ease: 2.8 }, shake: { amp: 0.15, dur: 0.24, freq: 29 },
      vfx: { call: 'thrust', length: 4.1, width: 0.68, y: 0.92, color: '#ff8359' }, sfx: 'shield.rush' }),
  },

  // ═════════════════════════════════════════════════════ BLACK COAT ════════
  coat: {
    id: 'coat', name: 'Black Coat', kind: 'melee', character: 'melinoe',
    palette: { core: '#eafff7', body: '#476e67', glow: '#76f0c3' },
    buffer: 0.25, moveScale: 0.32, critChance: 0.10, critMul: 2.0,
    combo: [
      step({ name: 'gauntlet1', windup: 0.09, active: 0.06, recovery: 0.15,
        hitbox: { shape: 'box', halfLength: 1.3, halfWidth: 0.72, offset: [1.25, 0], maxTargets: 3 }, damage: 14,
        knockback: 3.2, poise: 12, hitstop: 50, root: { distance: 0.7, ease: 2.5 },
        vfx: { call: 'thrust', length: 2.6, width: 0.38, y: 1.03, color: '#76f0c3' }, sfx: 'shield.bash1' }),
      step({ name: 'gauntlet2', windup: 0.08, active: 0.06, recovery: 0.16,
        hitbox: { shape: 'box', halfLength: 1.4, halfWidth: 0.78, offset: [1.32, 0], maxTargets: 4 }, damage: 15,
        knockback: 3.6, poise: 13, hitstop: 54, root: { distance: 0.78, ease: 2.5 },
        vfx: { call: 'thrust', length: 2.8, width: 0.4, y: 1.06, color: '#ff9a62' }, sfx: 'shield.bash1' }),
      step({ name: 'gauntlet3', windup: 0.16, active: 0.085, recovery: 0.25, weight: 1.2, finisher: true,
        hitbox: { shape: 'ring', radius: 2.7, innerRadius: 0.4, arcDeg: 360, maxTargets: 8 }, damage: 29,
        knockback: 7.8, poise: 30, hitstop: 91, root: { distance: 1.1, ease: 2.3 },
        vfx: { call: 'shockwave', radius: 2.75, color: '#76f0c3', life: 0.36 }, sfx: 'shield.bash2' }),
    ],
    dashAttack: step({ name: 'jetpunch', windup: 0.07, active: 0.07, recovery: 0.17,
      hitbox: { shape: 'box', halfLength: 1.75, halfWidth: 0.82, offset: [1.6, 0], maxTargets: 5 }, damage: 20,
      knockback: 6.5, poise: 21, hitstop: 72, root: { distance: 1.55, ease: 2.8 },
      vfx: { call: 'thrust', length: 3.5, width: 0.5, y: 1.04, color: '#76f0c3' }, sfx: 'shield.rush' }),
    special: step({ name: 'rockets', windup: 0.15, active: 0.09, recovery: 0.25,
      hitbox: { shape: 'ring', radius: 3.1, innerRadius: 0.8, arcDeg: 360, maxTargets: 10 }, damage: 24, type: 'arcane',
      knockback: 6.4, poise: 27, hitstop: 78, shake: { amp: 0.14, dur: 0.22, freq: 29 },
      vfx: { call: 'shockwave', radius: 3.15, color: '#ff9a62', life: 0.40 }, sfx: 'blade.sweep' }),
  },
};

export const WEAPON_IDS = Object.keys(WEAPONS);

// ── derived defaults: every arm gets the FEEL fields whether or not its
//    author wrote them, so combat.js never has to guess. Explicit values in
//    the table always win; this only fills the gaps.
export const PERFECT_CHAIN_DEFAULT = Object.freeze({ window: 0.10, bonus: 0.12, speed: 1.10 });
function weightFor(step) {
  if (step.weight != null) return step.weight;
  const d = step.damage || 0;
  return d >= 40 ? 1.3 : d >= 25 ? 1.15 : d >= 15 ? 1.0 : 0.85;
}
for (const id of WEAPON_IDS) {
  const w = WEAPONS[id];
  const steps = [...(w.combo || []), w.special, w.dashAttack].filter(Boolean);
  for (const st of steps) { st.weight = weightFor(st); st.finisher = !!st.finisher; }
  if (w.combo && w.combo.length) w.combo[w.combo.length - 1].finisher = true;
  if (w.combo && !w.perfectChain) w.perfectChain = PERFECT_CHAIN_DEFAULT;
  if (w.chainAccel == null) w.chainAccel = 0;
}

// ---------------------------------------------------------------------------
// WeaponRuntime — reads the table, drives ONE wielder.
//
// A "wielder" is any object with { position:Vector3, facing:Vector2, radius }.
// It is deliberately not "the player": enemies, the boss and the training
// dummy all run the same machine, which is why an enemy's telegraph reads the
// same way the player's does. If the wielder exposes optional hooks
// (onWeaponState, animLock) they are called; otherwise they are skipped.
// ---------------------------------------------------------------------------
export class WeaponRuntime {
  constructor(combat, wielder, weaponId = 'blade') {
    this.combat = combat; this.ctx = combat.ctx; this.actor = wielder;
    this.equip(weaponId);
    this.state = 'idle';        // idle | attack | dashAttack | charge | block | rush | reload
    this.step = null; this.stepIndex = -1;
    this.t = 0; this.dur = 0;
    this.hbId = 0; this.fired = false;
    this.queued = false; this.buffer = 0;
    // A dash-strike is an attack buffered during the hero's dash. It stays a
    // separate intent until the runtime consumes the attack buffer so the
    // same-frame Dash+Attack case cannot accidentally fall back to cut1.
    this.dashQueued = false;
    this.charge = 0; this.holding = false;
    this.rootDone = 0;
    this.stuck = null;           // the thrown spear waiting to be recalled
    this.blockT = 0;
    // timing rewards: when the chain press landed, whether it was perfect,
    // how fast the live step plays and the damage bonus it carries
    this._pressAt = -1; this.perfect = false; this.stepSpeed = 1; this.stepBonus = 0;
    this.chainStreak = 0;
    this._riposte = 0; this._riposteT = 0;   // shield parry payoff
    this._tier = 0;                          // charge tier reached this draw
  }

  equip(id) {
    const w = WEAPONS[id] || WEAPONS.blade;
    this.weapon = w; this.weaponId = w.id;
    this.state = 'idle'; this.step = null; this.stepIndex = -1; this.charge = 0;
    this.ammoMax = w.magazine?.capacity || 0;
    this.ammo = this.ammoMax;
    this.reloadT = 0; this._reloadQueued = false;
    this.ctx?.events.emit('weapon.equipped', { id: w.id, name: w.name, actor: this.actor, ammo: this.ammo, maxAmmo: this.ammoMax });
    if (this.ammoMax) this.ctx?.events.emit('weapon.ammo', { weapon: w.id, current: this.ammo, max: this.ammoMax, actor: this.actor });
    return w;
  }

  get busy() { return this.state !== 'idle' && this.state !== 'block'; }
  /** Recovery is dash-cancellable from the step's `cancel` mark. */
  get cancellable() {
    const committedStrike = this.state === 'attack' || this.state === 'dashAttack';
    return !committedStrike || (this.step && this.t >= this.step.cancel);
  }
  get moveScale() {
    if (this.state === 'idle') return 1;
    if (this.state === 'reload') return 0.46;
    if (this.state === 'block' || this.state === 'charge') return this.weapon.moveScale;
    if (this.step && this.t >= this.step.cancel) return this.weapon.moveScale;
    return 0.06;
  }

  // ───────────────────────────────────────────────────────────── input ────
  press(action) {
    const w = this.weapon;
    if (action === 'attack') {
      this.actionSlot = 'attack';
      if (this.weaponId === 'rail' && this.ammo <= 0) { if (this.state === 'idle') this._beginReload(); return; }
      if (w.charge && w.charge.action === 'attack') { this.holding = true; if (!this.busy) this._beginCharge(); return; }
      if (this.state === 'attack') { this.queued = true; this._pressAt = this.t; return; }
      if (this.state === 'dashAttack') return;
      this.buffer = w.buffer;
      return;
    }
    if (action === 'special') {
      this.actionSlot = 'special';
      // A second Special press recalls the thrown spear. This must precede
      // charge/busy handling or the input simply starts another throw charge.
      if (this.weaponId === 'spear' && this.stuck) { this.recall(); return; }
      if (w.block) { this._beginBlock(); return; }
      if (w.charge && w.charge.action === 'special') { this.holding = true; if (!this.busy) this._beginCharge(); return; }
      if (w.special && !this.busy) this._beginStep(w.special, -1);
      return;
    }
    if (action === 'dash' && this.cancellable) this.cancel();
  }
  /** Promote the live attack buffer to this arm's authored dash-strike. */
  queueDashAttack() {
    if (!this.weapon.dashAttack) return false;
    // Once the dashcut has begun, repeated input is a normal combo request.
    // Re-arming dash intent here could survive the active move and turn a
    // later standing Attack into an unexplained second dashcut.
    if (this.state === 'dashAttack') return false;
    this.dashQueued = true;
    this.buffer = Math.max(this.buffer, this.weapon.buffer);
    return true;
  }
  release(action) {
    const w = this.weapon;
    this.holding = false;
    if (this.state === 'charge') this._releaseCharge();
    else if (this.state === 'block') this._endBlock();
  }
  cancel() {
    const cancelledReload = this.state === 'reload';
    if (this.hbId) { this.combat.hitboxes.cancel(this.hbId); this.hbId = 0; }
    this.state = 'idle'; this.step = null; this.queued = false; this.dashQueued = false; this.charge = 0;
    this.reloadT = 0; this._reloadQueued = false;
    this.stepSpeed = 1; this.stepBonus = 0; this.perfect = false; this.chainStreak = 0; this._pressAt = -1;
    if (cancelledReload) this.ctx.events.emit('weapon.reload.cancel', { weapon: this.weaponId, current: this.ammo, max: this.ammoMax, actor: this.actor });
  }

  // ───────────────────────────────────────────────────────────── update ────
  update(dt) {
    // A dash-strike is released after the movement dash, not inside it. Pause
    // its short input buffer while the actor is still dashing; both states run
    // on the same fixed clock, so this preserves intent without beginning the
    // hitbox, root motion or weapon animation under the dash animation.
    const waitingForDashExit = this.dashQueued && this.actor?.state === 'dash';
    if (this.buffer > 0 && !waitingForDashExit) {
      this.buffer = Math.max(0, this.buffer - dt);
      if (this.buffer <= 0) this.dashQueued = false;
    }
    if (this.blockT > 0) this.blockT -= dt;
    if (this._riposteT > 0) { this._riposteT -= dt; if (this._riposteT <= 0) this._riposte = 0; }
    const actionDt = this.actor === this.ctx.player && this.actionSlot === 'attack'
      ? dt * (this.ctx.boons?.mods?.attackSpeed || 1) : dt;

    switch (this.state) {
      case 'idle':
        if (this.buffer > 0 && this.dashQueued && this.weapon.dashAttack) {
          if (this.actor?.state === 'dash') break;
          this.buffer = 0;
          this._beginDashAttack(this.weapon.dashAttack);
        } else if (this.buffer > 0 && this.weapon.combo) {
          this.buffer = 0;
          this._beginStep(this.weapon.combo[0], 0);
        }
        break;
      case 'attack': this._stepAttack(actionDt); break;
      case 'dashAttack': this._stepAttack(actionDt); break;
      case 'charge': this._stepCharge(actionDt); break;
      case 'rush': this._stepRush(dt); break;
      case 'block': this._stepBlock(dt); break;
      case 'reload': this._stepReload(dt); break;
    }
  }

  _stepAttack(dt) {
    const s = this.step;
    // a timed chain and a flurry both play the step FASTER, never shorter:
    // the windup/active/recovery ratio the animation was authored to is kept
    this.t += dt * this.stepSpeed;
    if (s.root && s.root.distance > 0) this._rootMotion(dt, s);
    if (!this.fired && this.t >= s.t0) { this.fired = true; this._fire(s); }
    if (this.queued && this.weapon.combo && this.stepIndex >= 0 && this.stepIndex < this.weapon.combo.length - 1 && this.t >= s.chain) {
      this.queued = false;
      // PERFECT CHAIN: the press itself fell inside [chain, chain+window].
      // A press buffered earlier chains at exactly `chain` (that is the
      // generosity contract) but was not a timed input and earns nothing.
      const pc = this.weapon.perfectChain || PERFECT_CHAIN_DEFAULT;
      const perfect = this._pressAt >= s.chain && this._pressAt <= s.chain + pc.window;
      this._beginStep(this.weapon.combo[this.stepIndex + 1], this.stepIndex + 1, perfect);
      return;
    }
    if (this.t >= s.dur) {
      if (this._reloadQueued) { this._beginReload(); return; }
      this.state = 'idle'; this.step = null; this.queued = false;
      this.stepSpeed = 1; this.stepBonus = 0; this.perfect = false; this.chainStreak = 0; this._pressAt = -1;
      // Completion is a hard input boundary. No dash intent from this attack
      // may affect the next standing press.
      this.dashQueued = false;
    }
  }

  _rootMotion(dt, s) {
    // Ease-out displacement over the ACTIVE window only. Root motion during
    // windup would make the tell lie about where the attack lands.
    const a = this.combat.clamp01((this.t - s.t0) / Math.max(1e-4, (s.t1 - s.t0) + s.recovery * 0.35));
    const k = 1 - Math.pow(1 - a, s.root.ease);
    const want = s.root.distance * k;
    const d = want - this.rootDone;
    if (d <= 0) return;
    this.rootDone = want;
    const A = this.actor;
    A.position.x += A.facing.x * d;
    A.position.z += A.facing.y * d;
    this.ctx.world?.collide?.(A.position, A.radius || 0.45);
  }

  _beginStep(s, idx, perfect = false) {
    this.state = 'attack'; this.step = s; this.stepIndex = idx;
    this.t = 0; this.fired = false; this.queued = false; this.dashQueued = false; this.rootDone = 0;
    this._pressAt = -1;
    this.dur = s.dur;
    const A = this.actor;
    const w = this.weapon;
    // rhythm rewards: a flurry accelerates with the chain, a timed press adds
    // its own speed and damage on top, and both are capped so a step never
    // loses its readable windup
    const pc = w.perfectChain || PERFECT_CHAIN_DEFAULT;
    this.chainStreak = idx > 0 ? this.chainStreak + 1 : 0;
    this.perfect = perfect;
    this.stepSpeed = Math.min(1.45, (1 + (w.chainAccel || 0) * this.chainStreak) * (perfect ? pc.speed : 1));
    this.stepBonus = perfect ? pc.bonus : 0;
    this.ctx.events.emit('weapon.step', { weapon: this.weaponId, step: s.name, actor: A, dur: s.dur / this.stepSpeed, t0: s.t0 / this.stepSpeed, t1: s.t1 / this.stepSpeed, perfect, streak: this.chainStreak });
    A.onWeaponState?.('attack', s);
    this.ctx.audio?.sfx?.(s.sfx, { pos: A.position, pitch: perfect ? 1.08 : 1 });
    if (s.shake) this.ctx.events.emit('camera.shake', { amp: s.shake.amp * 0.32, dur: 0.08, freq: 36 });
    if (perfect) {
      const col = w.palette.glow || w.palette.body;
      this.ctx.vfx?.shockwave?.(this.combat._v3a.set(A.position.x, 0.06, A.position.z), { radius: 1.25, color: col, life: 0.20 });
      this.ctx.audio?.sfx?.('charge.full', { pos: A.position, gain: 0.35, pitch: 1.5 });
      this.ctx.events.emit('weapon.perfectChain', { weapon: this.weaponId, step: s.name, actor: A, bonus: pc.bonus, streak: this.chainStreak, color: this.weapon.palette.body, reach: (s.hitbox && (s.hitbox.radius || s.hitbox.length || (s.hitbox.halfLength ? s.hitbox.halfLength * 2 : 0))) || 2.2 });
    }
  }

  /** The active frame: one hitbox, one effect, one sound. */
  _fire(s) {
    const A = this.actor, C = this.combat;
    const hb = s.hitbox;
    const slot = s === this.weapon.special ? 'special' : 'attack';
    const { mods, rider } = this._boon(slot);
    const slotMul = slot === 'special' ? (mods?.specialMul || 1) : (mods?.attackMul || 1);
    const forge = this._forge();
    const forgeActionMul = slot === 'special' ? (forge?.specialMul || 1) : (forge?.attackMul || 1);
    const dashBonus = slot === 'attack' && A._boonPostDash && rider?.postDashBonus ? rider.postDashBonus : 0;
    if (dashBonus) A._boonPostDash = false;
    // timing pays: the perfect-chain bonus and the shield's parry riposte
    let timingMul = 1 + (this.stepBonus || 0);
    if (slot === 'attack' && this._riposte > 0) { timingMul *= 1 + this._riposte; this._riposte = 0; this._riposteT = 0; this.ctx.events.emit('weapon.riposte', { weapon: this.weaponId, actor: A, color: this.weapon.palette.body }); }
    const damage = (s.damage || 0) * slotMul * forgeActionMul * (mods?.dmgMul || 1) * timingMul + (rider?.bonus || 0) + dashBonus;
    const forgeMul = mods?.forgeMul || 1;
    const color = rider?.color || (s.vfx && s.vfx.color) || this.weapon.palette.body;
    const dashStrike = this.state === 'dashAttack';
    const active = (s.t1 - s.t0) / Math.max(0.5, this.stepSpeed || 1);
    if (hb) {
      this.hbId = C.hitboxes.spawn({
        shape: hb.shape, owner: A, source: A,
        radius: hb.radius, innerRadius: hb.innerRadius, arcDeg: hb.arcDeg,
        length: hb.length, halfWidth: hb.halfWidth, halfLength: hb.halfLength,
        offset: hb.offset, maxTargets: hb.maxTargets ?? 6, pierce: hb.pierce ?? 255,
        t0: 0, t1: active, life: active + 0.02,
        damage, type: rider?.type || s.type || 'physical', knockback: s.knockback + (rider?.knockback || 0) + (mods?.knockback || 0),
        poiseDamage: s.poise * (this.perfect ? 1.25 : 1), hitstop: s.hitstop, shake: s.shake ? s.shake.amp : 0,
        weight: s.weight, finisher: !!s.finisher, dashStrike, tipBonus: hb.tipBonus || 0, tipFrom: hb.tipFrom ?? 0.6,
        status: rider?.status || (this.weaponId === 'blade' && forge?.ember ? 'burn' : s.status),
        statusStacks: rider?.stacks || (this.weaponId === 'blade' && forge?.ember ? Math.round(forge.ember * forgeMul) : 1), statusPower: rider?.statusPower || 0,
        crit: (s.crit || 0) + (this.weapon.critChance || 0) + (rider?.critChance || 0),
        expose: rider?.expose || 0, boonGod: rider?.god, boonSlot: slot,
        color,
        tag: this.weaponId + ':' + s.name,
      });
      // Olympian riders own the primary hit's status. Emberbrand is a second
      // forge proc so it remains live beside Shock, Weak, Doom, Chill or an
      // existing Burn rider instead of silently losing to `rider.status`.
      if (this.weaponId === 'blade' && forge?.ember && rider?.status) {
        C.hitboxes.spawn({
          shape: hb.shape, owner: A, source: A,
          radius: hb.radius, innerRadius: hb.innerRadius, arcDeg: hb.arcDeg,
          length: hb.length, halfWidth: hb.halfWidth, halfLength: hb.halfLength,
          offset: hb.offset, maxTargets: hb.maxTargets ?? 6, pierce: hb.pierce ?? 255,
          t0: 0, t1: s.t1 - s.t0, life: s.t1 - s.t0 + 0.02,
          damage: 0.01, type: 'fire', knockback: 0, poiseDamage: 0, hitstop: 0,
          status: 'burn', statusStacks: Math.max(1, Math.round(forge.ember * forgeMul)),
          color: '#ff9b42', tag: 'forge:blade-ember',
        });
      }
      if (forge?.nova) {
        C.hitboxes.spawn({ shape: 'circle', owner: A, source: A, follow: false,
          x: A.position.x + A.facing.x * 0.8, z: A.position.z + A.facing.y * 0.8,
          radius: 2.6, t0: 0, t1: 0.08, life: 0.10, maxTargets: 10,
          damage: forge.nova * forgeMul, type: 'fire', knockback: 3.5,
          status: 'burn', statusStacks: 1, color: '#ff9b42', tag: `forge:${this.weaponId}-nova` });
        this.ctx.vfx?.shockwave?.(this.combat._v3a.set(A.position.x + A.facing.x * 0.8, 0.07, A.position.z + A.facing.y * 0.8), { radius: 2.6, color: '#ff9b42', life: 0.30 });
        this.ctx.events.emit('forge.triggered', { weapon: this.weaponId, effect: 'nova' });
      }
    }
    if (s.projectile) this._fireStepProjectile(s, slot, mods, rider, damage, color, dashStrike);
    this._playVfx(s, rider, slot);
    const bladeFinisher = this.weaponId === 'blade' && slot === 'attack' && this.weapon.combo && this.stepIndex === this.weapon.combo.length - 1;
    if (bladeFinisher && forge?.wave) {
      C.projectiles.fire({
        x: A.position.x + A.facing.x * 1.0, y: 0.85, z: A.position.z + A.facing.y * 1.0,
        dx: A.facing.x, dz: A.facing.y, kind: 'straight', speed: 12, radius: 0.52, life: 0.85,
        damage: forge.wave * forgeMul, type: 'fire', pierce: 4, knockback: 3.2, hitstop: 0.06,
        color: '#ff9b42', size: 1.25, coreSize: 0.42, status: 'burn', statusStacks: 2,
        source: A, hero: true, onExpire: 'burst', tag: 'forge:blade-wave',
      });
      this.ctx.vfx?.beam?.(this.combat._v3a.set(A.position.x, 0.18, A.position.z), this.combat._v3b.set(A.position.x + A.facing.x * 4.8, 0.18, A.position.z + A.facing.y * 4.8), { color: '#ff9b42', width: 0.5, life: 0.24 });
      this.ctx.events.emit('forge.triggered', { weapon: 'blade', effect: 'wave' });
    }
    if (bladeFinisher && forge?.echo) {
      C.hitboxes.spawn({ shape: 'circle', owner: A, source: A, follow: false,
        x: A.position.x, z: A.position.z, radius: 3.2, t0: 0, t1: 0.10, life: 0.12,
        maxTargets: 12, damage: forge.echo * forgeMul, type: 'fire', knockback: 4.0,
        status: 'burn', statusStacks: 1, color: '#ffb15c', tag: 'forge:blade-echo' });
      this.ctx.vfx?.shockwave?.(this.combat._v3a.set(A.position.x, 0.07, A.position.z), { radius: 3.2, color: '#ff9b42', life: 0.38 });
      this.ctx.events.emit('forge.triggered', { weapon: 'blade', effect: 'echo' });
    }
    if (slot === 'special' && rider?.deflect) C.activateDeflect(A, rider.deflect, rider.color);
    if (slot === 'special' && rider?.god === 'zeus') {
      C.hitboxes.spawn({ shape: 'circle', owner: A, source: A, follow: false,
        x: A.position.x, z: A.position.z, radius: 3.2, t0: 0, t1: 0.08, life: 0.10,
        maxTargets: 10, damage: Math.max(1, (rider.bonus || 0) * 0.55), type: 'lightning',
        knockback: 2.2, status: 'shock', statusStacks: 1, crit: rider.critChance || 0,
        color, boonGod: 'zeus', boonSlot: 'special', tag: 'boon:thunder-flourish' });
      this.ctx.vfx?.shockwave?.(this.combat._v3a.set(A.position.x, 0.08, A.position.z), { radius: 3.2, color, life: 0.32 });
    }
    this.ctx.audio?.sfx?.(s.sfx + '.hit', { pos: A.position, gain: 0.5 });
  }

  /**
   * A step that shoots instead of swinging: the ranged arms' dash-strikes.
   * `count` bolts fan across `spread` radians around the facing; every one
   * carries the slot's rider so Olympian Attack boons ride the snap shot.
   */
  _fireStepProjectile(s, slot, mods, rider, damage, color, dashStrike) {
    const A = this.actor, P = s.projectile, C = this.combat;
    const n = Math.max(1, P.count | 0);
    const per = (P.damage || 0) * (slot === 'special' ? (mods?.specialMul || 1) : (mods?.attackMul || 1)) * (mods?.dmgMul || 1) * (1 + (this.stepBonus || 0)) + (rider?.bonus || 0) * 0.5;
    for (let i = 0; i < n; i++) {
      const ang = n > 1 ? (i / (n - 1) - 0.5) * (P.spread || 0) : 0;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const dx = A.facing.x * ca - A.facing.y * sa;
      const dz = A.facing.x * sa + A.facing.y * ca;
      C.projectiles.fire({
        x: A.position.x + dx * 0.7, y: 1.12, z: A.position.z + dz * 0.7, dx, dz,
        kind: P.kind || 'straight', homing: P.homing || 0,
        speed: P.speed, radius: P.radius, life: P.life,
        damage: per, type: rider?.type || P.type || 'physical', pierce: P.pierce ?? 1,
        knockback: (P.knockback || 0) + (rider?.knockback || 0) + (mods?.knockback || 0), hitstop: P.hitstop || 0,
        color: rider?.color || P.color || color, size: P.size ?? 1, coreSize: P.coreSize ?? 1,
        crit: (this.weapon.critChance || 0) + (rider?.critChance || 0),
        status: rider?.status || P.status, statusStacks: rider?.stacks || P.statusStacks || 1, statusPower: rider?.statusPower || 0,
        expose: rider?.expose || 0, boonGod: rider?.god, boonSlot: slot,
        source: A, hero: !!P.hero, onExpire: P.onExpire || 'burst', shake: 0,
        tag: this.weaponId + ':' + s.name,
      });
    }
    this.ctx.events.emit('weapon.loose', { weapon: this.weaponId, charge: 0, full: false, actor: A, step: s.name, dashStrike, count: n, color: s.vfx?.color || this.weapon.palette.body, glow: this.weapon.palette.glow });
  }

  /** A real third action state, not a standing Attack pasted onto Dash. */
  _beginDashAttack(s) {
    this.state = 'dashAttack'; this.step = s; this.stepIndex = -2;
    this.t = 0; this.fired = false; this.queued = false; this.dashQueued = false; this.rootDone = 0;
    this.stepSpeed = 1; this.stepBonus = 0; this.perfect = false; this.chainStreak = 0; this._pressAt = -1;
    this.dur = s.dur;
    const A = this.actor;
    this.ctx.events.emit('weapon.dashAttack', {
      weapon: this.weaponId, step: s.name, actor: A, dur: s.dur, t0: s.t0, t1: s.t1,
    });
    // Preserve generic weapon-step listeners such as cloth/audio accents while
    // exposing the dedicated event and state to animation/gameplay systems.
    this.ctx.events.emit('weapon.step', { weapon: this.weaponId, step: s.name, actor: A, dur: s.dur, t0: s.t0, t1: s.t1, dashAttack: true });
    A.onWeaponState?.('dashAttack', s);
    this.ctx.audio?.sfx?.(s.sfx, { pos: A.position });
    const color = s.vfx?.color || this.weapon.palette.glow || this.weapon.palette.body;
    this.ctx.vfx?.shockwave?.(A.position.clone().setY(0.05), { radius: 1.55, color, life: 0.24 });
    this.ctx.vfx?.burst?.(A.position.clone().setY(0.8), {
      count: 10, color, speed: 7.5, spread: 0.58, kind: 'chev',
    });
    if (s.shake) this.ctx.events.emit('camera.shake', { amp: s.shake.amp * 0.42, dur: 0.10, freq: 38 });
  }

  _boon(slot) {
    if (this.actor !== this.ctx.player) return { mods: null, rider: null };
    const mods = this.ctx.boons?.mods || null;
    return { mods, rider: mods?.rider?.[slot] || null };
  }

  _forge() {
    if (this.actor !== this.ctx.player) return null;
    return this.ctx.boons?.mods?.forge?.[this.weaponId] || null;
  }

  _playVfx(s, rider = null, slot = 'attack') {
    const v = s.vfx; if (!v) return;
    const A = this.actor, ctx = this.ctx;
    const P = this.combat._v3a.set(A.position.x, v.y ?? 1.05, A.position.z);
    const D = this.combat._v3b.set(A.facing.x, 0, A.facing.y);
    const col = rider?.color || v.color || this.weapon.palette.body;
    // every call carries the ARM: vfx/index.js owns a per-weapon shape table
    // (crescent / heavy crescent / thrust streak / bash ring / tracer ...) so
    // a bow frame and a spear frame stop being pixel-identical apart from the
    // held prop
    const weapon = this.weaponId;
    if (v.call === 'slash') {
      ctx.vfx?.slash?.(P, D, { arc: v.arc ?? 130, radius: v.radius ?? 2.3, width: v.width ?? 0.44, color: col, glow: this.weapon.palette.glow, spin: v.spin, weapon, step: s.name });
    } else if (v.call === 'shockwave') {
      ctx.vfx?.shockwave?.(this.combat._v3a.set(A.position.x, 0.06, A.position.z), { radius: v.radius ?? 3, color: col, life: v.life ?? 0.4, weapon });
    } else if (v.call === 'thrust') {
      // a spear thrust is a BEAM, not a crescent — the shape language has to
      // tell you the hitbox is a line before the damage number does
      const b = this.combat._v3b.set(A.position.x + A.facing.x * (v.length ?? 3.8), v.y ?? 1.08, A.position.z + A.facing.y * (v.length ?? 3.8));
      ctx.vfx?.beam?.(P, b, { color: col, width: v.width ?? 0.30, life: 0.20, weapon, thrust: true });
    }
    if (rider) this._playBoonFx(rider, P, D, slot);
  }

  _playBoonFx(rider, pos, dir, slot) {
    const ctx = this.ctx, col = rider.color || '#f2c14e';
    const tier = rider.tier || 1;
    const kind = {
      zeus: 'sparkFine', poseidon: 'wisp', athena: 'shard', aphrodite: 'mote',
      ares: 'rune', artemis: 'chev', dionysus: 'wisp', hermes: 'chev',
      hecate: 'rune', selene: 'star',
    }[rider.god] || 'spark';
    ctx.vfx?.burst?.(pos, {
      count: (slot === 'special' ? 15 : 9) + tier * 3, color: col,
      speed: slot === 'special' ? 9 : 6.5, spread: rider.god === 'poseidon' ? 1.15 : 0.65,
      kind, dir,
    });
    if (['poseidon', 'athena', 'dionysus', 'selene'].includes(rider.god)) {
      ctx.vfx?.shockwave?.(this.combat._v3a.set(this.actor.position.x, 0.07, this.actor.position.z), {
        radius: (slot === 'special' ? 2.6 : 1.8) + tier * 0.12, color: col, life: 0.32,
      });
    }
  }

  // ───────────────────────────────────────────────────────────── charge ────
  _beginCharge() {
    const c = this.weapon.charge; if (!c) return;
    this.state = 'charge'; this.t = 0; this.charge = 0; this.fired = false; this._tier = 0;
    this.actor.onWeaponState?.('charge', c);
    this.ctx.events.emit('weapon.charge.begin', { weapon: this.weaponId, actor: this.actor, color: this.weapon.palette.body });
  }
  _stepCharge(dt) {
    const c = this.weapon.charge;
    this.t += dt;
    this.charge = this.combat.clamp01((this.t - c.windup) / Math.max(1e-4, c.fullHold - c.windup));
    // the tell: a ring that closes on the wielder as the shot ripens, and a
    // sharp flash at exactly full charge so the timing is learnable by eye
    // CHARGE TIERS: a tick and a ring pulse the frame each authored tier is
    // reached, so the player learns the three draws by ear and by eye
    if (c.tiers && this._tier < c.tiers.length - 1 && this.charge >= c.tiers[this._tier] && c.tiers[this._tier] < 0.999) {
      this._tier++;
      this.ctx.vfx?.shockwave?.(this.combat._v3a.set(this.actor.position.x, 0.06, this.actor.position.z), { radius: 0.8 + 0.3 * this._tier, color: c.tell?.color || '#ffe9a8', life: 0.18 });
      this.ctx.audio?.sfx?.('telegraph', { pos: this.actor.position, gain: 0.3, pitch: 1.2 + 0.25 * this._tier });
      this.ctx.events.emit('weapon.charge.tier', { weapon: this.weaponId, actor: this.actor, tier: this._tier, of: c.tiers.length, color: this.weapon.palette.body, glow: this.weapon.palette.glow });
    }
    if (this.charge >= 1 && !this._fullPing) {
      this._fullPing = true;
      this.ctx.vfx?.shockwave?.(this.combat._v3a.set(this.actor.position.x, 0.06, this.actor.position.z), { radius: 1.5, color: c.tell?.color || '#ffe9a8', life: 0.26 });
      this.ctx.audio?.sfx?.('charge.full', { pos: this.actor.position });
      this.ctx.events.emit('weapon.charge.full', { weapon: this.weaponId, actor: this.actor, color: this.weapon.palette.body, glow: this.weapon.palette.glow });
    }
    if (!this.holding && this.t >= c.windup + c.minHold) this._releaseCharge();
  }
  _releaseCharge() {
    const c = this.weapon.charge; if (!c) { this.state = 'idle'; return; }
    let full = this.charge >= 0.999;
    let power = this.charge;
    // quantise to the tier reached: three distinct shots, not a continuum
    if (c.tiers && !full) {
      let tier = 0;
      for (let i = 0; i < c.tiers.length; i++) if (this.charge >= c.tiers[i]) tier = c.tiers[i];
      power = tier > 0 ? tier * 0.92 : this.charge * 0.55;
    }
    if (full && this.actor === this.ctx.player && this.actor.characterId === 'melinoe') {
      const cost = this.weapon.omegaCost || 20;
      if ((this.actor.mana || 0) < cost) {
        full = false; power = 0.78;
        this.ctx.ui?.toast?.('NOT ENOUGH MAGICK FOR Ω MOVE', { color: '#86e6c1', dur: 1.4 });
      } else {
        this.actor.mana -= cost;
        this.ctx.ui?.setMana?.(this.actor.mana, this.actor.maxMana);
        this.ctx.events.emit('magick.spent', { amount: cost, source: 'omega', weapon: this.weaponId, action: c.action });
        this.ctx.events.emit('weapon.omega', { weapon: this.weaponId, action: c.action, actor: this.actor });
      }
    }
    this._fullPing = false;
    if (this.weaponId === 'shield') return this._beginRush(full);
    this._loose(c, power, full);
    this.state = 'attack';
    this.step = { name: 'loose', t0: 0, t1: 0.01, dur: (full ? (c.recoveryFull ?? c.recovery) : c.recovery), cancel: c.recovery * 0.3, chain: 1e9, root: null, sfx: '' };
    this.t = 0; this.fired = true; this.stepIndex = -1; this.queued = false;
  }
  _loose(c, k, full) {
    const A = this.actor, P = c.projectile;
    const lerp = (a, b) => a + ((b ?? a) - a) * k;
    const slot = c.action === 'special' ? 'special' : 'attack';
    const { mods, rider } = this._boon(slot);
    const slotMul = slot === 'special' ? (mods?.specialMul || 1) : (mods?.attackMul || 1);
    const col = rider?.color || (full && P.colorFull ? P.colorFull : P.color);
    const dashBonus = slot === 'attack' && A._boonPostDash && rider?.postDashBonus ? rider.postDashBonus : 0;
    if (dashBonus) A._boonPostDash = false;
    const forge = this._forge();
    const forgeMul = mods?.forgeMul || 1;
    const forgeActionMul = slot === 'special' ? (forge?.specialMul || 1) : (forge?.attackMul || 1);
    const homing = full && ((this.weaponId === 'spear' ? forge?.homing : 0) || (this.weaponId === 'bow' ? forge?.homing : 0));
    const blastRadius = full ? (forge?.blast || 0) : 0;
    const spec = {
      x: A.position.x + A.facing.x * 0.7, y: 1.12, z: A.position.z + A.facing.y * 0.7,
      dx: A.facing.x, dz: A.facing.y,
      kind: homing ? 'homing' : P.kind, homing: homing || 0,
      speed: lerp(P.speed, P.speedFull), radius: P.radius, life: P.life,
      damage: lerp(P.damage, P.damageFull) * slotMul * forgeActionMul * (mods?.dmgMul || 1) + (rider?.bonus || 0) + dashBonus,
      type: rider?.type || P.type,
      pierce: Math.round(lerp(P.pierce, P.pierceFull)),
      knockback: lerp(P.knockback, P.knockbackFull) + (rider?.knockback || 0) + (mods?.knockback || 0), hitstop: lerp(P.hitstop, P.hitstopFull),
      color: col, size: lerp(P.size, P.sizeFull), coreSize: lerp(P.coreSize, P.coreSizeFull),
      crit: lerp(P.crit ?? 0, P.critFull ?? 0) + (this.weapon.critChance || 0) + (rider?.critChance || 0),
      status: rider?.status || P.status, statusStacks: rider?.stacks || P.statusStacks || 1, statusPower: rider?.statusPower || 0,
      expose: rider?.expose || 0, boonGod: rider?.god, boonSlot: slot,
      source: A, hero: true, onExpire: P.onExpire || 'burst',
      blastRadius: blastRadius * forgeMul,
      shake: full ? 0.2 : 0.08,
    };
    // THE LAST ROUND: the Rail's final shell before the reload is the heavy one
    const lastRound = this.weaponId === 'rail' && slot === 'attack' && this.ammoMax > 0 && this.ammo === 1 && this.weapon.lastRound;
    if (lastRound) {
      spec.damage *= lastRound.dmgMul || 1.5;
      spec.hitstop = Math.max(spec.hitstop, lastRound.hitstop || 60);
      spec.size *= 1.35; spec.coreSize *= 1.3; spec.shake = 0.16;
      spec.color = P.colorFull || spec.color;
      this.ctx.events.emit('weapon.lastRound', { weapon: this.weaponId, actor: A });
    }
    const id = this.combat.projectiles.fire(spec);
    if (this.weaponId === 'rail' && slot === 'attack') {
      this.ammo = Math.max(0, this.ammo - 1);
      this._reloadQueued = this.ammo <= 0;
      this.ctx.events.emit('weapon.ammo', { weapon: this.weaponId, current: this.ammo, max: this.ammoMax, actor: A });
    }
    const spread = full && ((this.weaponId === 'spear' && forge?.trident) || forge?.triple);
    if (spread) {
      for (const angle of [-0.16, 0.16]) {
        const ca = Math.cos(angle), sa = Math.sin(angle);
        const dx = A.facing.x * ca - A.facing.y * sa;
        const dz = A.facing.x * sa + A.facing.y * ca;
        this.combat.projectiles.fire({ ...spec, dx, dz, damage: spec.damage * 0.72, shake: 0.04, tag: `forge:${this.weaponId}-spread` });
      }
      this.ctx.events.emit('forge.triggered', { weapon: this.weaponId, effect: 'spread' });
    }
    if (P.stick) {
      // Keep a deterministic landing fallback because the outbound projectile
      // may have expired or struck scenery before the player asks for recall.
      this.stuck = {
        id, charge: k,
        x: spec.x + spec.dx * 7.5,
        z: spec.z + spec.dz * 7.5,
      };
    }
    const sh = full && c.shakeFull ? c.shakeFull : c.shake;
    if (sh) this.ctx.events.emit('camera.shake', sh);
    this.ctx.audio?.sfx?.(full && c.sfxFull ? c.sfxFull : c.sfx, { pos: A.position });
    this.ctx.vfx?.burst?.(this.combat._v3a.set(A.position.x + A.facing.x * 0.8, 1.14, A.position.z + A.facing.y * 0.8),
      { count: full ? 22 : 9, color: col, speed: full ? 11 : 6, spread: 0.45, kind: 'chev', dir: this.combat._v3b.set(A.facing.x, 0.12, A.facing.y) });
    if (rider) this._playBoonFx(rider, this.combat._v3a.set(A.position.x + A.facing.x, 1.1, A.position.z + A.facing.y), this.combat._v3b.set(A.facing.x, 0.12, A.facing.y), slot);
    if (slot === 'special' && rider?.deflect) this.combat.activateDeflect(A, rider.deflect, rider.color);
    this.ctx.events.emit('weapon.loose', { weapon: this.weaponId, charge: k, full, actor: A, color: this.weapon.palette.body, glow: this.weapon.palette.glow });
    if (full) this.ctx.engine?.slowmo?.(0.55, 0.10);
  }

  // ───────────────────────────────────────────────────────────── reload ───
  _beginReload() {
    const mag = this.weapon.magazine;
    if (!mag || this.ammo >= this.ammoMax) return false;
    this.state = 'reload'; this.step = null; this.t = 0; this.reloadT = mag.reload;
    this.holding = false; this.charge = 0; this._reloadQueued = false;
    this.actor.onWeaponState?.('reload', mag);
    this.ctx.events.emit('weapon.reload.begin', {
      weapon: this.weaponId, duration: mag.reload, current: this.ammo, max: this.ammoMax, actor: this.actor,
    });
    this.ctx.audio?.sfx?.('shield.block', { pos: this.actor.position, gain: 0.48, rate: 0.78 });
    if (this.actor === this.ctx.player) this.ctx.ui?.toast?.('ADAMANT RAIL · RELOADING', { color: '#ffb15c', dur: 1.15 });
    return true;
  }

  _stepReload(dt) {
    const mag = this.weapon.magazine;
    if (!mag) { this.state = 'idle'; return; }
    this.t += dt; this.reloadT = Math.max(0, mag.reload - this.t);
    if (this.t < mag.reload) return;
    this.ammo = this.ammoMax; this.reloadT = 0; this.state = 'idle';
    this.ctx.events.emit('weapon.ammo', { weapon: this.weaponId, current: this.ammo, max: this.ammoMax, actor: this.actor });
    this.ctx.events.emit('weapon.reload.end', { weapon: this.weaponId, current: this.ammo, max: this.ammoMax, actor: this.actor });
    this.ctx.audio?.sfx?.('charge.full', { pos: this.actor.position, gain: 0.40, rate: 1.22 });
  }

  // ────────────────────────────────────────────────── shield rush / block ──
  _beginRush(full) {
    const c = this.weapon.charge;
    const { mods, rider } = this._boon('special');
    const forge = this._forge();
    const forgeMul = mods?.forgeMul || 1;
    const banked = this._forgeBank || 0;
    this._forgeBank = 0;
    this.state = 'rush'; this.t = 0; this.rootDone = 0; this._rushFull = full;
    this._rushDist = full ? c.dash.distanceFull : c.dash.distance;
    this._rushTime = full ? c.dash.timeFull : c.dash.time;
    this.actor.onWeaponState?.('rush', c);
    this.hbId = this.combat.hitboxes.spawn({
      shape: c.hitbox.shape, owner: this.actor, source: this.actor,
      radius: c.hitbox.radius, maxTargets: c.hitbox.maxTargets, pierce: c.hitbox.pierce,
      t0: 0, t1: this._rushTime, life: this._rushTime + 0.02,
      damage: (full ? c.damageFull : c.damage) * (mods?.specialMul || 1) * (forge?.specialMul || 1) * (mods?.dmgMul || 1) + (rider?.bonus || 0) + banked,
      type: rider?.type || c.type || 'physical',
      knockback: (full ? c.knockbackFull : c.knockback) + (rider?.knockback || 0) + (mods?.knockback || 0),
      poiseDamage: c.poise, hitstop: full ? c.hitstopFull : c.hitstop,
      status: rider?.status, statusStacks: rider?.stacks || 1, statusPower: rider?.statusPower || 0,
      crit: (this.weapon.critChance || 0) + (rider?.critChance || 0), expose: rider?.expose || 0,
      boonGod: rider?.god, boonSlot: 'special',
      shake: (full ? c.shakeFull : c.shake).amp, color: rider?.color || c.color, tag: 'shield:rush',
    });
    this.ctx.vfx?.shockwave?.(this.combat._v3a.set(this.actor.position.x, 0.06, this.actor.position.z), { radius: full ? 2.6 : 1.8, color: rider?.color || c.color, life: 0.3 });
    if (full && forge?.ram) {
      this.combat.hitboxes.spawn({ shape: 'circle', owner: this.actor, source: this.actor, follow: true,
        radius: 3.35, t0: 0, t1: Math.min(0.18, this._rushTime), life: Math.min(0.20, this._rushTime + 0.02),
        maxTargets: 12, damage: forge.ram * forgeMul, type: 'fire', knockback: 5.5,
        status: 'burn', statusStacks: 2, color: '#ff9b42', tag: 'forge:shield-ram' });
      this.ctx.events.emit('forge.triggered', { weapon: 'shield', effect: 'ram' });
    }
    if (rider) this._playBoonFx(rider, this.combat._v3a.set(this.actor.position.x, 1.0, this.actor.position.z), this.combat._v3b.set(this.actor.facing.x, 0, this.actor.facing.y), 'special');
    if (rider?.deflect) this.combat.activateDeflect(this.actor, rider.deflect, rider.color);
    this.ctx.events.emit('camera.shake', full ? c.shakeFull : c.shake);
    this.ctx.audio?.sfx?.(c.sfx, { pos: this.actor.position });
  }
  _stepRush(dt) {
    const c = this.weapon.charge;
    this.t += dt;
    const a = this.combat.clamp01(this.t / this._rushTime);
    const want = this._rushDist * (1 - Math.pow(1 - a, 2.4));
    const d = want - this.rootDone; this.rootDone = want;
    const A = this.actor;
    A.position.x += A.facing.x * d; A.position.z += A.facing.y * d;
    this.ctx.world?.collide?.(A.position, A.radius || 0.45);
    if (this.t >= this._rushTime + c.recovery) { this.state = 'idle'; this.hbId = 0; }
  }

  _beginBlock() {
    const b = this.weapon.block; if (!b) return;
    if (this.busy) return;
    this.state = 'block'; this.t = 0; this.blockT = 0; this.holding = true;
    this.actor.blocking = this;
    this.actor.onWeaponState?.('block', b);
    this.ctx.audio?.sfx?.(b.sfx, { pos: this.actor.position });
    this.ctx.events.emit('weapon.block.begin', { actor: this.actor, weapon: this.weaponId });
  }
  _stepBlock(dt) {
    const b = this.weapon.block, c = this.weapon.charge;
    this.t += dt;
    // reflect anything hostile that enters the guard arc
    const A = this.actor;
    if (this.t >= b.raise) {
      const half = Math.cos(b.arcDeg * 0.5 * Math.PI / 180);
      this.combat.projectiles.forEachIncoming(A, 1.9, (p) => {
        const dx = p.x - A.position.x, dz = p.z - A.position.z;
        const l = Math.hypot(dx, dz) || 1;
        if ((dx / l) * A.facing.x + (dz / l) * A.facing.y < half) return;
        if (this.combat.projectiles.reflect(p, A, b.reflectMul, b.reflectSpeed)) {
          this.ctx.audio?.sfx?.(b.sfxReflect, { pos: A.position });
          this.ctx.events.emit('camera.shake', { amp: 0.09, dur: 0.16, freq: 33 });
          this.combat.hitstop(52);
          const forge = this._forge();
          if (forge?.reflect) {
            const forgeMul = this.ctx.boons?.mods?.forgeMul || 1;
            this.combat.hitboxes.spawn({ shape: 'circle', owner: A, source: A, follow: false,
              x: p.x, z: p.z, radius: 2.5, t0: 0, t1: 0.08, life: 0.10,
              maxTargets: 10, damage: forge.reflect * forgeMul, type: 'fire', knockback: 3.5,
              status: 'burn', statusStacks: 1, color: '#ff9b42', tag: 'forge:shield-reflect' });
            this.ctx.vfx?.shockwave?.(this.combat._v3a.set(p.x, 0.07, p.z), { radius: 2.5, color: '#ff9b42', life: 0.28 });
            this.ctx.events.emit('forge.triggered', { weapon: 'shield', effect: 'reflect' });
          }
        }
      });
    }
    if (c && c.requiresBlock) this.charge = this.combat.clamp01((this.t - c.minHold) / Math.max(1e-4, c.fullHold - c.minHold));
    if (!this.holding) this._endBlock();
  }
  _endBlock() {
    const c = this.weapon.charge;
    this.actor.blocking = null;
    if (c && c.requiresBlock && this.t >= c.minHold) { this._beginRush(this.charge >= 0.999); return; }
    this.state = 'idle';
    this.ctx.events.emit('weapon.block.end', { actor: this.actor });
  }

  /** Called by CombatSystem before damage lands on a blocking wielder. */
  absorb(info) {
    const b = this.weapon.block;
    if (!b || this.state !== 'block') return info.amount;
    const A = this.actor;
    const d = info.dir;
    if (d) {
      const half = Math.cos(b.arcDeg * 0.5 * Math.PI / 180);
      // info.dir points from the attacker toward the victim
      if (-(d.x * A.facing.x + (d.z ?? 0) * A.facing.y) < half) return info.amount;
    }
    const perfect = this.t <= b.perfect;
    this.ctx.vfx?.impact?.(this.combat._v3a.set(A.position.x + A.facing.x * 0.9, 1.15, A.position.z + A.facing.y * 0.9),
      this.combat._v3b.set(-A.facing.x, 0, -A.facing.y), { type: 'arcane', scale: perfect ? 1.2 : 0.7, color: b.color });
    this.ctx.events.emit('weapon.blocked', { actor: A, perfect, amount: info.amount });
    if (perfect) {
      const bank = this._forge()?.bank || 0;
      if (bank) {
        this._forgeBank = bank * (this.ctx.boons?.mods?.forgeMul || 1);
        this.ctx.events.emit('forge.triggered', { weapon: 'shield', effect: 'bank', damage: this._forgeBank });
      }
      // THE PARRY: the attacker is staggered out of its swing and the next
      // Attack is a riposte. A boss cannot be staggered, but it still eats
      // the poise damage, which is how the Shield opens its windows.
      const src = info.source;
      if (b.parry && src && src !== A && !src.dead) {
        if (src.stagger != null && (src.def?.poise ?? 0) < 999) {
          src.stagger = Math.max(src.stagger || 0, b.parry.stagger);
          this.ctx.events.emit('entity.staggered', { entity: src, pos: src.position, dir: null, parry: true });
        } else if (src.poiseMax > 0) {
          src.poise = Math.max(0, (src.poise ?? src.poiseMax) - src.poiseMax * 0.35);
          src.poiseRegenDelay = 1.2;
        }
        this._riposte = b.parry.riposte; this._riposteT = b.parry.riposteFor;
        this.ctx.vfx?.shockwave?.(this.combat._v3a.set(A.position.x + A.facing.x * 0.9, 0.06, A.position.z + A.facing.y * 0.9), { radius: 2.2, color: b.color, life: 0.3 });
        this.ctx.events.emit('weapon.parry', { actor: A, source: src, riposte: b.parry.riposte });
      }
      this.combat.hitstop(b.perfectHitstop);
      this.ctx.engine?.slowmo?.(b.perfectSlowmo[0], b.perfectSlowmo[1]);
      return 0;
    }
    this.combat.hitstop(40);
    return info.amount * (1 - b.absorb) + info.amount * b.chipMul * 0;
  }

  /** Recall the stuck spear — it flies home through everything in the way. */
  recall() {
    const c = this.weapon.charge;
    if (!c || !c.recall || !this.stuck) return false;
    const P = this.combat.projectiles;
    const A = this.actor;
    // Recall from the live outbound spear when possible, otherwise from its
    // predicted landing point after it has hit scenery or expired.
    const outbound = P.get?.(this.stuck.id);
    const ox = outbound?.x ?? this.stuck.x;
    const oz = outbound?.z ?? this.stuck.z;
    if (outbound) P.kill?.(outbound, 'silent');
    const dx = A.position.x - ox, dz = A.position.z - oz;
    const forge = this._forge();
    const { mods, rider } = this._boon('special');
    const forgeMul = mods?.forgeMul || 1;
    const charge = this.stuck.charge ?? 0;
    const returnDamage = c.recall.damage + ((c.recall.damageFull ?? c.recall.damage) - c.recall.damage) * charge;
    const distance = Math.hypot(dx, dz);
    P.fire({
      x: ox, y: 1.1, z: oz, dx, dz,
      kind: 'homing', homing: 12 + (forge?.homing || 0), target: A,
      returnTarget: A, returnRadius: (A.radius || 0.5) + 0.48,
      speed: c.recall.speed, radius: c.recall.radius, life: Math.max(0.45, distance / c.recall.speed + 0.45),
      damage: returnDamage * (mods?.specialMul || 1) * (forge?.specialMul || 1) * (mods?.dmgMul || 1) + (rider?.bonus || 0),
      pierce: c.recall.pierce, knockback: c.recall.knockback + (rider?.knockback || 0) + (mods?.knockback || 0),
      hitstop: c.recall.hitstop, color: c.recall.color, source: A, hero: true, size: 1.2,
      blastRadius: (forge?.recallBlast || 0) * forgeMul,
      type: rider?.type || (forge?.recallBlast ? 'fire' : 'physical'),
      status: rider?.status, statusStacks: rider?.stacks || 1, statusPower: rider?.statusPower || 0,
      crit: (this.weapon.critChance || 0) + (rider?.critChance || 0),
      expose: rider?.expose || 0, boonGod: rider?.god, boonSlot: 'special',
    });
    if (forge?.recallBlast || forge?.homing) this.ctx.events.emit('forge.triggered', { weapon: 'spear', effect: 'recall' });
    this.stuck = null;
    this.ctx.audio?.sfx?.('spear.recall', { pos: A.position });
    return true;
  }
}

export default WEAPONS;
