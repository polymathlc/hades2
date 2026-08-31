// OWNER: AGENT-UI (data + modifier engine; presentation lives in src/ui/boons.js)
// ---------------------------------------------------------------------------
// EREBUS — BOONS
//
// Boons are DATA. Each one carries a small `apply(mods, v)` function that
// writes into a flat, plain modifier object. Nothing walks a list of boons at
// combat time: granting a boon rebuilds `state.mods` once, and combat reads
// `ctx.boons.mods.attackMul` (a property access) at hit time.
//
// Numbers scale with rarity through `base` values multiplied by RARITY_MUL, so
// one authored boon covers all four rarities without four copies.
// ---------------------------------------------------------------------------

import { GODS } from '../materials/palette.js';
import { EXPANDED_BOONS, EXPANDED_DUOS } from './boon-expansion.js';
import { CANON_BOONS, CANON_DUOS } from './canonical-boons.js';
import { HADES2_BOONS } from './hades2-boons.js';

export const SLOTS = {
  attack:  { name: 'Attack',  glyph: 'sword' },
  special: { name: 'Special', glyph: 'burst' },
  cast:    { name: 'Cast',    glyph: 'bolt' },
  dash:    { name: 'Dash',    glyph: 'chevron' },
  call:    { name: 'Call',    glyph: 'horn' },
  passive: { name: 'Boon',    glyph: 'laurel' },
  forge:   { name: 'Weapon Forge', glyph: 'hammer' },
  gain:    { name: 'Magick Gain', glyph: 'moons' },
  legendary: { name: 'Legendary', glyph: 'laurel' },
};
/** Short tags for the HUD tray, which has room for four characters at most. */
export const SLOT_TAG = {
  attack: 'ATK', special: 'SPC', cast: 'CAST', dash: 'DASH', call: 'CALL',
  passive: 'BOON', forge: 'FORGE', gain: 'GAIN', legendary: 'LGND',
};

// ── RARITY ─────────────────────────────────────────────────────────────────
// Hades separates two axes and so do we.
//   * RARITIES is the *ladder*: the four tiers a normal boon can roll on and
//     be promoted along. Every authored `base` table is written at Common and
//     multiplied up, so one card covers all four tiers.
//   * TIERS adds the two fixed grades that never roll and never promote —
//     Duo (two gods) and Legendary (one god, deep investment). Giving them
//     real multipliers is what makes the payoff cards feel like payoffs.
export const RARITIES = ['common', 'rare', 'epic', 'heroic'];
export const FIXED_TIERS = ['duo', 'legendary'];
export const TIERS = [...RARITIES, ...FIXED_TIERS];
export const RARITY_MUL = { common: 1, rare: 1.5, epic: 2.0, heroic: 2.6, duo: 2.2, legendary: 3.0 };
export const RARITY_LABEL = { common: 'Common', rare: 'Rare', epic: 'Epic', heroic: 'Heroic', duo: 'Duo', legendary: 'Legendary' };
/** Canonical tier colours. src/ui/style.css mirrors these as CSS custom properties. */
export const RARITY_COLOR = {
  common: '#c9a476', rare: '#cfdcee', epic: '#f2c14e',
  heroic: '#ffd6f0', duo: '#7ef2c8', legendary: '#ff9d5c',
};
/** Weights used when a boon is offered without a forced rarity. */
export const RARITY_WEIGHT = { common: 62, rare: 26, epic: 9, heroic: 3 };

const rarityRank = (rarity) => Math.max(0, RARITIES.indexOf(rarity));
const nextRarity = (rarity) => RARITIES[Math.min(RARITIES.length - 1, rarityRank(rarity) + 1)];
const isLadder = (rarity) => RARITIES.includes(rarity);
export const isFixedTier = (rarity) => FIXED_TIERS.includes(rarity);
const CORE_SLOTS = Object.freeze(['attack', 'special', 'cast', 'dash', 'call', 'gain']);
/** The five categories a god's offer can occupy. Exactly one boon each. */
export const ACTION_SLOTS = Object.freeze(['attack', 'special', 'cast', 'dash', 'call']);

// ── STATUS CURSES ──────────────────────────────────────────────────────────
// The combat authority implements five status primitives (burn / chill /
// shock / doom / weak). Hades II speaks in *curses* instead, and a curse is
// more than a rename: it carries its own name, colour, verb and the god who
// deals it, so a card can promise "Scorch" and the HUD can show a scorch chip
// while combat keeps ticking the one primitive it knows how to tick.
//
// `engine` is the only field combat ever sees. Everything else is identity.
export const CURSES = Object.freeze({
  scorch: { id: 'scorch', name: 'Scorch', engine: 'burn', color: '#ff8c1a', verb: 'Burns',
    blurb: 'Sears foes for damage over time; stacks deepen the burn.' },
  blitz: { id: 'blitz', name: 'Blitz', engine: 'shock', color: '#ffe14d', verb: 'Builds',
    blurb: 'Static gathers on the foe and discharges through its guard.' },
  freeze: { id: 'freeze', name: 'Freeze', engine: 'chill', color: '#3fb8ff', verb: 'Chills',
    blurb: 'Slows foes and shatters them once fully frozen.' },
  slow: { id: 'slow', name: 'Slow', engine: 'chill', color: '#8fd8ff', verb: 'Drags',
    blurb: 'Weighs foes down so they close and swing sluggishly.' },
  hitch: { id: 'hitch', name: 'Hitch', engine: 'weak', color: '#ff9bd6', verb: 'Binds',
    blurb: 'Binds a foe so its own blows come back blunted.' },
  weak: { id: 'weak', name: 'Weak', engine: 'weak', color: '#8ef0d0', verb: 'Saps',
    blurb: 'Foes deal markedly less damage while afflicted.' },
  blind: { id: 'blind', name: 'Blind', engine: 'weak', color: '#ffe9a8', verb: 'Dazzles',
    blurb: 'Light robs foes of their aim and their nerve.' },
  wither: { id: 'wither', name: 'Wither', engine: 'doom', color: '#a05fe0', verb: 'Dooms',
    blurb: 'A knife hangs over the foe and falls for a delayed burst.' },
  hangover: { id: 'hangover', name: 'Hangover', engine: 'burn', color: '#b884ff', verb: 'Sickens',
    blurb: 'Dionysus\u2019 own rot: stacks that amplify everything else you land.' },
});
export const CURSE_KEYS = Object.keys(CURSES);
/** Every display name a description or tooltip may highlight. */
export const CURSE_NAMES = Object.freeze(CURSE_KEYS.map(k => CURSES[k].name));
/** Engine status -> the curse used when a god declares no preference. */
const DEFAULT_CURSE = { burn: 'scorch', chill: 'freeze', shock: 'blitz', doom: 'wither', weak: 'weak' };
/** Look a curse up by curse id OR by engine status id. */
export function curseInfo(key) {
  if (!key) return null;
  const id = String(key).toLowerCase();
  return CURSES[id] || CURSES[DEFAULT_CURSE[id]] || null;
}

// `curse` is the god's signature affliction, `identity` the one-line promise
// the boon screen prints under their name. Two gods who both apply `weak` are
// still distinct because one Hitches and the other Blinds.
export const GOD_INFO = {
  zeus:      { name: 'Zeus',      title: 'God of Thunder',        color: GODS.zeus,      status: 'shock', emblem: 'bolt',
    curse: 'blitz', identity: 'Lightning that forks between foes and builds until it breaks them.' },
  poseidon:  { name: 'Poseidon',  title: 'God of the Sea',        color: GODS.poseidon,  status: null,    emblem: 'trident',
    curse: 'slow', identity: 'Displacement. Hurl foes into walls and let the room finish them.' },
  athena:    { name: 'Athena',    title: 'Goddess of Wisdom',     color: GODS.athena,    status: null,    emblem: 'aegis',
    curse: 'weak', identity: 'Deflection and Exposure — turn incoming harm into an opening.' },
  aphrodite: { name: 'Aphrodite', title: 'Goddess of Love',       color: GODS.aphrodite, status: 'weak',  emblem: 'rose',
    curse: 'weak', identity: 'The heaviest single hits, paid for by making foes strike softly.' },
  ares:      { name: 'Ares',      title: 'God of War',            color: GODS.ares,      status: 'doom',  emblem: 'blades',
    curse: 'wither', identity: 'Delayed reckonings and blade rifts — damage banked, then collected.' },
  artemis:   { name: 'Artemis',   title: 'Goddess of the Hunt',   color: GODS.artemis,   status: null,    emblem: 'bow',
    curse: 'weak', identity: 'Critical chance and seeking shots. Every hit can be the big one.' },
  dionysus:  { name: 'Dionysus',  title: 'God of Wine',           color: GODS.dionysus,  status: 'burn',  emblem: 'grapes',
    curse: 'hangover', identity: 'Hangover stacks that amplify everything else you land.' },
  hermes:    { name: 'Hermes',    title: 'God of Swiftness',      color: GODS.hermes,    status: null,    emblem: 'wing',
    curse: null, identity: 'Speed as a stat: faster attacks, faster casts, faster escapes.' },
  hecate:    { name: 'Hecate',    title: 'Witch of the Crossroads', color: GODS.hecate,  status: 'chill', emblem: 'moons',
    curse: 'freeze', identity: 'Arcane mastery of the Cast, and Freeze that outlasts the fight.' },
  selene:    { name: 'Selene',    title: 'Goddess of the Moon',   color: GODS.selene,    status: 'chill', emblem: 'crescent',
    curse: 'freeze', identity: 'Moon magick: the Call, the sustained ray, and silver escapes.' },
  hephaestus:{ name: 'Hephaestus',title: 'God of the Forge',      color: GODS.hephaestus,status: 'burn',  emblem: 'hammer',
    curse: 'scorch', identity: 'Forged blasts that change what your weapon is, not just its numbers.' },
  demeter:   { name: 'Demeter',   title: 'Goddess of Seasons',    color: GODS.demeter,   status: 'chill', emblem: 'wheat',
    curse: 'freeze', identity: 'Freeze that piles up until the foe simply shatters.' },
  apollo:    { name: 'Apollo',    title: 'God of Light',           color: GODS.apollo,    status: 'weak',  emblem: 'sun',
    curse: 'blind', identity: 'Wide radiant areas that Blind — safety through sheer coverage.' },
  hera:      { name: 'Hera',      title: 'Queen of Olympus',       color: GODS.hera,      status: 'weak',  emblem: 'crown',
    curse: 'hitch', identity: 'Hitch binds foes together so one wound is shared by the room.' },
  hestia:    { name: 'Hestia',    title: 'Goddess of Flame',      color: GODS.hestia,    status: 'burn',  emblem: 'flame',
    curse: 'scorch', identity: 'Many small Scorch stacks rather than one large blow.' },
  chaos:     { name: 'Chaos',     title: 'Origin of All',          color: GODS.chaos,     status: null,    emblem: 'spiral',
    curse: null, identity: 'A curse now for a blessing later. Nothing here is free.' },
  hades:     { name: 'Hades',     title: 'Lord of the Dead',       color: GODS.hades,     status: 'doom',  emblem: 'helm',
    curse: 'wither', identity: 'The father’s own gifts: Wither, and dominion over the dead.' },
};
export const GOD_KEYS = Object.keys(GOD_INFO);

/** The curse a given boon inflicts, or null. God preference wins over status. */
export function curseForBoon(boon) {
  if (!boon) return null;
  if (boon.curse) return CURSES[boon.curse] || null;
  const status = boon.status || null;
  if (!status) return null;
  const god = boon.god || (boon.gods && boon.gods[0]);
  const preferred = god && GOD_INFO[god] && GOD_INFO[god].curse ? CURSES[GOD_INFO[god].curse] : null;
  if (preferred && preferred.engine === status) return preferred;
  return curseInfo(status);
}

// ── helpers ────────────────────────────────────────────────────────────────
const r1 = (n) => Math.round(n * 10) / 10;
/** A bad text() must never take the offer screen down with it. */
export function safeText(boon, values) {
  try { const s = boon.text(values); return typeof s === 'string' ? s : ''; } catch (e) { return ''; }
}
const DISCRETE_VALUES = new Set(['stacks', 'ticks', 'arcs', 'forks', 'shots', 'bounces', 'pierce', 'weak', 'chill']);
function scaleVal(base, mul, key) {
  if (typeof base !== 'number') return base;
  const v = base * mul;
  if (DISCRETE_VALUES.has(key)) return Math.max(1, Math.round(v));
  return Math.abs(base) >= 5 ? Math.round(v) : r1(v);
}
/** Resolve a boon's authored `base` table for a given rarity. */
export function valuesFor(boon, rarity) {
  const mul = RARITY_MUL[rarity] || 1;
  const out = {};
  for (const k in boon.base) out[k] = scaleVal(boon.base[k], mul, k);
  return out;
}

// A rider is what a slot's hit carries: bonus damage, a damage type, and an
// optional status the combat system already implements (burn/chill/shock/doom/weak).
function rider(m, slot, o) {
  const r = m.rider[slot] || (m.rider[slot] = { bonus: 0, type: null, status: null, stacks: 0, color: null, god: null, name: null, tier: 1 });
  if (o.bonus) r.bonus += o.bonus;
  if (o.type) r.type = o.type;
  if (o.status) { r.status = o.status; r.stacks += (o.stacks || 1); }
  if (o.color) r.color = o.color;
  if (o.god) r.god = o.god;
  if (o.name) r.name = o.name;
  for (const k of ['knockback', 'critChance', 'critMark', 'expose', 'deflect', 'postDashBonus', 'statusPower']) {
    if (o[k] != null) r[k] = (r[k] || 0) + o[k];
  }
  return r;
}

// ═══════════════════════════════════════════════════════ THE BOON TABLE ════
// text() receives the rarity-scaled values, so a Heroic card literally reads
// the Heroic number.
const B = (id, god, slot, name, base, text, apply, extra) => ({ id, god, slot, name, base, text, apply, ...(extra || {}) });

export const BOONS = [
  // ── ZEUS — chain lightning, shock ────────────────────────────────────────
  B('zeus.attack', 'zeus', 'attack', 'Lightning Strike', { dmg: 14, stacks: 1 },
    v => `Your Attack deals ${v.dmg} bonus lightning damage and inflicts Blitz.`,
    (m, v) => rider(m, 'attack', { bonus: v.dmg, type: 'lightning', status: 'shock', stacks: v.stacks, color: GODS.zeus, god: 'zeus', name: 'Lightning Strike' }),
    { status: 'shock' }),
  B('zeus.special', 'zeus', 'special', 'Thunder Flourish', { dmg: 26 },
    v => `Your Special calls a bolt for ${v.dmg} lightning damage in a wide arc.`,
    (m, v) => rider(m, 'special', { bonus: v.dmg, type: 'lightning', status: 'shock', color: GODS.zeus, god: 'zeus', name: 'Thunder Flourish' }),
    { status: 'shock' }),
  B('zeus.cast', 'zeus', 'cast', 'Electric Shot', { dmg: 20, arcs: 2 },
    v => `Your Cast forks to ${v.arcs} nearby foes for ${v.dmg} lightning damage.`,
    (m, v) => { rider(m, 'cast', { bonus: v.dmg, type: 'lightning', status: 'shock', color: GODS.zeus, god: 'zeus', name: 'Electric Shot' }); m.castForks += v.arcs; },
    { status: 'shock' }),
  B('zeus.dash', 'zeus', 'dash', 'Thunder Dash', { dmg: 22 },
    v => `Your Dash blasts foes at the point of departure for ${v.dmg} lightning damage.`,
    (m, v) => rider(m, 'dash', { bonus: v.dmg, type: 'lightning', status: 'shock', color: GODS.zeus, god: 'zeus', name: 'Thunder Dash' }),
    { status: 'shock' }),
  B('zeus.passive', 'zeus', 'passive', 'Heaven’s Vengeance', { chance: 8, dmg: 30 },
    v => `${v.chance}% chance that taking damage strikes the attacker for ${v.dmg}.`,
    (m, v) => { m.retaliate += v.chance / 100; m.retaliateDmg += v.dmg; }),

  // ── POSEIDON — knockback, displacement, rooms ────────────────────────────
  B('poseidon.attack', 'poseidon', 'attack', 'Tempest Strike', { dmg: 12, knock: 3 },
    v => `Your Attack deals ${v.dmg} bonus damage and knocks foes back ${v.knock}m.`,
    (m, v) => rider(m, 'attack', { bonus: v.dmg, type: 'physical', knockback: v.knock, color: GODS.poseidon, god: 'poseidon', name: 'Tempest Strike' })),
  B('poseidon.special', 'poseidon', 'special', 'Tidal Dash', { dmg: 24, knock: 5 },
    v => `Your Special becomes a breaking wave: ${v.dmg} damage, ${v.knock}m knockback.`,
    (m, v) => rider(m, 'special', { bonus: v.dmg, knockback: v.knock, color: GODS.poseidon, god: 'poseidon', name: 'Tidal Dash' })),
  B('poseidon.cast', 'poseidon', 'cast', 'Flood Shot', { dmg: 18, radius: 1.6 },
    v => `Your Cast bursts for ${v.dmg} damage in a ${v.radius}m flood.`,
    (m, v) => { rider(m, 'cast', { bonus: v.dmg, color: GODS.poseidon, god: 'poseidon', name: 'Flood Shot' }); m.castRadius += v.radius; }),
  B('poseidon.dash', 'poseidon', 'dash', 'Breaker Dash', { dmg: 20, radius: 2.2 },
    v => `Your Dash slams for ${v.dmg} damage in a ${v.radius}m ring on arrival.`,
    (m, v) => { rider(m, 'dash', { bonus: v.dmg, color: GODS.poseidon, god: 'poseidon', name: 'Breaker Dash' }); m.dashRadius += v.radius; }),
  B('poseidon.passive', 'poseidon', 'passive', 'Sunken Treasure', { heal: 6, wall: 12 },
    v => `Knocking a foe into a wall deals ${v.wall} damage; each clear heals ${v.heal}.`,
    (m, v) => { m.wallSlamDmg += v.wall; m.clearHeal += v.heal; }),

  // ── ATHENA — deflect, exposure, defence ──────────────────────────────────
  B('athena.attack', 'athena', 'attack', 'Divine Strike', { dmg: 15, expose: 10 },
    v => `Your Attack deals ${v.dmg} bonus damage and Exposes foes for ${v.expose}%.`,
    (m, v) => rider(m, 'attack', { bonus: v.dmg, expose: v.expose / 100, color: GODS.athena, god: 'athena', name: 'Divine Strike' })),
  B('athena.special', 'athena', 'special', 'Phalanx Flourish', { dmg: 22, deflect: 1 },
    v => `Your Special deals ${v.dmg} bonus damage and deflects for ${v.deflect}s.`,
    (m, v) => rider(m, 'special', { bonus: v.dmg, deflect: v.deflect, color: GODS.athena, god: 'athena', name: 'Phalanx Flourish' })),
  B('athena.cast', 'athena', 'cast', 'Phalanx Shot', { dmg: 16, weak: 2 },
    v => `Your Cast pins and Weakens foes by ${v.weak} stacks for ${v.dmg} damage.`,
    (m, v) => rider(m, 'cast', { bonus: v.dmg, status: 'weak', stacks: v.weak, color: GODS.athena, god: 'athena', name: 'Phalanx Shot' }),
    { status: 'weak' }),
  B('athena.dash', 'athena', 'dash', 'Deflect Dash', { dmg: 12, window: 0.6 },
    v => `Your Dash deflects incoming attacks for ${v.window}s and deals ${v.dmg}.`,
    (m, v) => rider(m, 'dash', { bonus: v.dmg, deflect: v.window, color: GODS.athena, god: 'athena', name: 'Deflect Dash' })),
  B('athena.passive', 'athena', 'passive', 'Bronze Skin', { dr: 8 },
    v => `Take ${v.dr}% less damage from all sources.`,
    (m, v) => { m.damageTaken *= (1 - v.dr / 100); }),

  // ── APHRODITE — weak, charm, raw damage ──────────────────────────────────
  B('aphrodite.attack', 'aphrodite', 'attack', 'Heartbreak Strike', { dmg: 22, weak: 1 },
    v => `Your Attack deals ${v.dmg} bonus damage and inflicts Weak (${v.weak}).`,
    (m, v) => rider(m, 'attack', { bonus: v.dmg, status: 'weak', stacks: v.weak, color: GODS.aphrodite, god: 'aphrodite', name: 'Heartbreak Strike' }),
    { status: 'weak' }),
  B('aphrodite.special', 'aphrodite', 'special', 'Heartbreak Flourish', { dmg: 34, weak: 2 },
    v => `Your Special deals ${v.dmg} bonus damage and inflicts Weak (${v.weak}).`,
    (m, v) => rider(m, 'special', { bonus: v.dmg, status: 'weak', stacks: v.weak, color: GODS.aphrodite, god: 'aphrodite', name: 'Heartbreak Flourish' }),
    { status: 'weak' }),
  B('aphrodite.cast', 'aphrodite', 'cast', 'Crush Shot', { dmg: 30 },
    v => `Your Cast blooms for ${v.dmg} bonus damage and leaves foes Weakened.`,
    (m, v) => rider(m, 'cast', { bonus: v.dmg, status: 'weak', color: GODS.aphrodite, god: 'aphrodite', name: 'Crush Shot' }),
    { status: 'weak' }),
  B('aphrodite.dash', 'aphrodite', 'dash', 'Passion Dash', { dmg: 18, weak: 2 },
    v => `Your Dash Weakens (${v.weak}) all nearby foes and deals ${v.dmg}.`,
    (m, v) => rider(m, 'dash', { bonus: v.dmg, status: 'weak', stacks: v.weak, color: GODS.aphrodite, god: 'aphrodite', name: 'Passion Dash' }),
    { status: 'weak' }),
  B('aphrodite.passive', 'aphrodite', 'passive', 'Life Affirmation', { hp: 25 },
    v => `Gain ${v.hp} maximum life. Beauty endures.`,
    (m, v) => { m.maxHealthAdd += v.hp; }),

  // ── ARES — doom, blade rifts, crits ──────────────────────────────────────
  B('ares.attack', 'ares', 'attack', 'Curse of Agony', { dmg: 30 },
    v => `Your Attack inflicts Wither, dealing ${v.dmg} damage after a delay.`,
    (m, v) => rider(m, 'attack', { bonus: 0, type: 'arcane', status: 'doom', statusPower: v.dmg, color: GODS.ares, god: 'ares', name: 'Curse of Agony' }),
    { status: 'doom' }),
  B('ares.special', 'ares', 'special', 'Curse of Pain', { dmg: 46 },
    v => `Your Special inflicts Wither for ${v.dmg} delayed damage.`,
    (m, v) => rider(m, 'special', { status: 'doom', type: 'arcane', statusPower: v.dmg, color: GODS.ares, god: 'ares', name: 'Curse of Pain' }),
    { status: 'doom' }),
  B('ares.cast', 'ares', 'cast', 'Slicing Shot', { dmg: 24, ticks: 5 },
    v => `Your Cast opens a Blade Rift: ${v.ticks} cuts of ${v.dmg} damage.`,
    (m, v) => { rider(m, 'cast', { bonus: v.dmg, color: GODS.ares, god: 'ares', name: 'Slicing Shot' }); m.castTicks += v.ticks; }),
  B('ares.dash', 'ares', 'dash', 'Blade Dash', { dmg: 26 },
    v => `Your Dash cuts a rift behind you for ${v.dmg} damage.`,
    (m, v) => rider(m, 'dash', { bonus: v.dmg, color: GODS.ares, god: 'ares', name: 'Blade Dash' })),
  B('ares.passive', 'ares', 'passive', 'Battle Rage', { crit: 6, mul: 0.4 },
    v => `+${v.crit}% Critical chance and +${v.mul}x Critical damage.`,
    (m, v) => { m.critChance += v.crit / 100; m.critMul += v.mul; }),

  // ── ARTEMIS — crit, seeking ──────────────────────────────────────────────
  B('artemis.attack', 'artemis', 'attack', 'Deadly Strike', { dmg: 10, crit: 12 },
    v => `Your Attack deals ${v.dmg} bonus damage with +${v.crit}% Critical chance.`,
    (m, v) => rider(m, 'attack', { bonus: v.dmg, critChance: v.crit / 100, color: GODS.artemis, god: 'artemis', name: 'Deadly Strike' })),
  B('artemis.special', 'artemis', 'special', 'Deadly Flourish', { dmg: 18, crit: 15 },
    v => `Your Special deals ${v.dmg} bonus damage with +${v.crit}% Critical chance.`,
    (m, v) => rider(m, 'special', { bonus: v.dmg, critChance: v.crit / 100, color: GODS.artemis, god: 'artemis', name: 'Deadly Flourish' })),
  B('artemis.cast', 'artemis', 'cast', 'True Shot', { dmg: 26 },
    v => `Your Cast seeks the nearest foe and deals ${v.dmg} bonus damage.`,
    (m, v) => { rider(m, 'cast', { bonus: v.dmg, color: GODS.artemis, god: 'artemis', name: 'True Shot' }); m.castSeek = 1; }),
  B('artemis.dash', 'artemis', 'dash', 'Hunter’s Flare', { dmg: 16, crit: 10 },
    v => `Your Dash marks foes: +${v.crit}% Critical chance against them, ${v.dmg} damage.`,
    (m, v) => rider(m, 'dash', { bonus: v.dmg, critMark: v.crit / 100, color: GODS.artemis, god: 'artemis', name: 'Hunter’s Flare' })),
  B('artemis.passive', 'artemis', 'passive', 'Pressure Points', { crit: 4, mul: 0.6 },
    v => `All damage has +${v.crit}% Critical chance and +${v.mul}x Critical damage.`,
    (m, v) => { m.critChance += v.crit / 100; m.critMul += v.mul; }),

  // ── DIONYSUS — hangover (burn), festive fog ──────────────────────────────
  B('dionysus.attack', 'dionysus', 'attack', 'Drunken Strike', { stacks: 2, dmg: 8 },
    v => `Your Attack inflicts ${v.stacks} Hangover, burning for ${v.dmg} per stack.`,
    (m, v) => rider(m, 'attack', { bonus: 0, type: 'poison', status: 'burn', stacks: v.stacks, statusPower: v.dmg, color: GODS.dionysus, god: 'dionysus', name: 'Drunken Strike' }),
    { status: 'burn' }),
  B('dionysus.special', 'dionysus', 'special', 'Drunken Flourish', { stacks: 3, dmg: 10 },
    v => `Your Special inflicts ${v.stacks} Hangover for ${v.dmg} damage per stack.`,
    (m, v) => rider(m, 'special', { status: 'burn', type: 'poison', stacks: v.stacks, statusPower: v.dmg, color: GODS.dionysus, god: 'dionysus', name: 'Drunken Flourish' }),
    { status: 'burn' }),
  B('dionysus.cast', 'dionysus', 'cast', 'Trippy Shot', { dmg: 14, radius: 2.4 },
    v => `Your Cast leaves a festive fog: ${v.dmg} damage in ${v.radius}m.`,
    (m, v) => { rider(m, 'cast', { bonus: v.dmg, status: 'burn', color: GODS.dionysus, god: 'dionysus', name: 'Trippy Shot' }); m.castRadius += v.radius; },
    { status: 'burn' }),
  B('dionysus.dash', 'dionysus', 'dash', 'Trippy Dash', { dmg: 14, stacks: 2 },
    v => `Your Dash leaves a fog inflicting ${v.stacks} Hangover for ${v.dmg}.`,
    (m, v) => rider(m, 'dash', { bonus: v.dmg, status: 'burn', stacks: v.stacks, color: GODS.dionysus, god: 'dionysus', name: 'Trippy Dash' }),
    { status: 'burn' }),
  B('dionysus.passive', 'dionysus', 'passive', 'Premium Vintage', { dmg: 3 },
    v => `Deal +${v.dmg}% damage for every Hangover stack on the target.`,
    (m, v) => { m.hangoverAmp += v.dmg / 100; }),

  // ── HERMES — speed, cooldowns ────────────────────────────────────────────
  B('hermes.passive', 'hermes', 'passive', 'Swift Strike', { spd: 12 },
    v => `Your Attack is ${v.spd}% faster.`,
    (m, v) => { m.attackSpeed *= (1 + v.spd / 100); }),
  B('hermes.dash', 'hermes', 'dash', 'Greater Evasion', { dodge: 8 },
    v => `${v.dodge}% chance to dodge any incoming attack.`,
    (m, v) => { m.dodge += v.dodge / 100; }),
  B('hermes.call', 'hermes', 'call', 'Quick Favour', { cdr: 20 },
    v => `Your Call charges ${v.cdr}% faster and refunds magick.`,
    (m, v) => { m.callCharge *= (1 + v.cdr / 100); m.callRefund += 18; }),
  B('hermes.cast', 'hermes', 'cast', 'Flurry Cast', { rate: 25 },
    v => `Your Cast fires ${v.rate}% faster and returns sooner.`,
    (m, v) => { m.castSpeed *= (1 + v.rate / 100); }),
  B('hermes.attack', 'hermes', 'attack', 'Hyper Sprint', { spd: 14, dmg: 8 },
    v => `Move ${v.spd}% faster; the first hit out of a Dash deals +${v.dmg}.`,
    (m, v) => { m.moveMul *= (1 + v.spd / 100); rider(m, 'attack', { postDashBonus: v.dmg, color: GODS.hermes, god: 'hermes', name: 'Hyper Sprint' }); }),

  // ── HECATE — chill, arcane, cast mastery ─────────────────────────────────
  B('hecate.attack', 'hecate', 'attack', 'Crossroads Strike', { dmg: 16, chill: 2 },
    v => `Your Attack deals ${v.dmg} arcane damage and Freezes (${v.chill}).`,
    (m, v) => rider(m, 'attack', { bonus: v.dmg, type: 'arcane', status: 'chill', stacks: v.chill, color: GODS.hecate, god: 'hecate', name: 'Crossroads Strike' }),
    { status: 'chill' }),
  B('hecate.cast', 'hecate', 'cast', 'Witching Hour', { dmg: 34, chill: 3 },
    v => `Your Cast rends for ${v.dmg} arcane damage and Freezes (${v.chill}).`,
    (m, v) => rider(m, 'cast', { bonus: v.dmg, type: 'arcane', status: 'chill', stacks: v.chill, color: GODS.hecate, god: 'hecate', name: 'Witching Hour' }),
    { status: 'chill' }),
  B('hecate.special', 'hecate', 'special', 'Hex Flourish', { dmg: 28, chill: 2 },
    v => `Your Special hexes for ${v.dmg} arcane damage and Freezes (${v.chill}).`,
    (m, v) => rider(m, 'special', { bonus: v.dmg, type: 'arcane', status: 'chill', stacks: v.chill, color: GODS.hecate, god: 'hecate', name: 'Hex Flourish' }),
    { status: 'chill' }),
  B('hecate.dash', 'hecate', 'dash', 'Phase Dash', { dmg: 14, chill: 2 },
    v => `Your Dash phases through foes, Freezing (${v.chill}) for ${v.dmg}.`,
    (m, v) => rider(m, 'dash', { bonus: v.dmg, type: 'arcane', status: 'chill', stacks: v.chill, color: GODS.hecate, god: 'hecate', name: 'Phase Dash' }),
    { status: 'chill' }),
  B('hecate.passive', 'hecate', 'passive', 'Arcane Reserve', { mana: 40 },
    v => `Magick regenerates ${v.mana}% faster; Freeze lasts longer.`,
    (m, v) => { m.manaRegenMul *= (1 + v.mana / 100); m.statusDuration.chill *= 1.25; }),

  // ── SELENE — moon magick, the Call ───────────────────────────────────────
  B('selene.call', 'selene', 'call', 'Moon Water', { dmg: 42 },
    v => `Your Call detonates moonlight for ${v.dmg} damage around you.`,
    (m, v) => { rider(m, 'call', { bonus: v.dmg, type: 'arcane', color: GODS.selene, god: 'selene', name: 'Moon Water' }); }),
  B('selene.cast', 'selene', 'cast', 'Lunar Ray', { dmg: 30 },
    v => `Your Cast becomes a sustained ray for ${v.dmg} damage per second.`,
    (m, v) => { rider(m, 'cast', { bonus: v.dmg, type: 'arcane', color: GODS.selene, god: 'selene', name: 'Lunar Ray' }); m.castBeam = 1; }),
  B('selene.passive', 'selene', 'passive', 'Night Bloom', { hp: 15, mana: 25 },
    v => `Gain ${v.hp} life and ${v.mana} maximum magick under the dark moon.`,
    (m, v) => { m.maxHealthAdd += v.hp; m.maxManaAdd += v.mana; }),
  B('selene.dash', 'selene', 'dash', 'Silver Step', { dmg: 18, iframes: 0.2 },
    v => `Your Dash leaves moonlight for ${v.dmg} and extends invulnerability ${v.iframes}s.`,
    (m, v) => { rider(m, 'dash', { bonus: v.dmg, type: 'arcane', color: GODS.selene, god: 'selene', name: 'Silver Step' }); m.iframeAdd += v.iframes; }),
  B('selene.special', 'selene', 'special', 'Moonlit Flourish', { dmg: 26, chill: 2 },
    v => `Your Special deals ${v.dmg} arcane damage and Freezes (${v.chill}).`,
    (m, v) => rider(m, 'special', { bonus: v.dmg, type: 'arcane', status: 'chill', stacks: v.chill, color: GODS.selene, god: 'selene', name: 'Moonlit Flourish' }),
    { status: 'chill' }),

  // ── HEPHAESTUS — persistent, weapon-specific Daedalus-style forges ──────
  // Forge boons live outside the four core action slots, so they can alter a
  // weapon's rules without replacing an Olympian Attack/Special/Cast/Dash.
  B('hephaestus.blade.wave', 'hephaestus', 'forge', 'Furnace Wave', { dmg: 32 },
    v => `The Blade combo finisher launches a molten wave for ${v.dmg} damage.`,
    (m, v) => { m.forge.blade.wave = Math.max(m.forge.blade.wave, v.dmg); }, { weapon: 'blade', forgeAction: 'attack' }),
  B('hephaestus.blade.echo', 'hephaestus', 'forge', 'Echo-Tempered Edge', { dmg: 22 },
    v => `Blade finishers strike a second time in a wide forged ring for ${v.dmg} damage.`,
    (m, v) => { m.forge.blade.echo = Math.max(m.forge.blade.echo, v.dmg); }, { weapon: 'blade', forgeAction: 'attack' }),
  B('hephaestus.blade.ember', 'hephaestus', 'forge', 'Emberbrand', { stacks: 3 },
    v => `Every Blade hit brands foes with ${v.stacks} Hangover-like ember stacks.`,
    (m, v) => { m.forge.blade.ember = Math.max(m.forge.blade.ember, v.stacks); }, { weapon: 'blade', forgeAction: 'attack' }),
  B('hephaestus.blade.special', 'hephaestus', 'forge', 'Cyclone Temper', { pct: 18 },
    v => `The Blade Special gains +${v.pct}% damage from a balanced bronze counterweight.`,
    (m, v) => { m.forge.blade.specialMul *= 1 + v.pct / 100; }, { weapon: 'blade', forgeAction: 'special' }),
  B('hephaestus.blade.cast', 'hephaestus', 'forge', 'Crucible Cast', { pct: 16, radius: 1.8 },
    v => `Your Cast gains +${v.pct}% damage and erupts across ${v.radius}m on impact.`,
    (m, v) => { m.forge.blade.castMul *= 1 + v.pct / 100; m.forge.blade.castBlast = Math.max(m.forge.blade.castBlast, v.radius); },
    { weapon: 'blade', forgeAction: 'cast' }),

  B('hephaestus.spear.trident', 'hephaestus', 'forge', 'Trident Temper', {},
    () => `A fully charged Spear throw splits into three forged prongs.`,
    (m) => { m.forge.spear.trident = true; }, { weapon: 'spear', forgeAction: 'special' }),
  B('hephaestus.spear.recall', 'hephaestus', 'forge', 'Volcanic Recall', { radius: 2.8 },
    v => `The returning Spear erupts in a ${v.radius}m blast when it strikes.`,
    (m, v) => { m.forge.spear.recallBlast = Math.max(m.forge.spear.recallBlast, v.radius); }, { weapon: 'spear', forgeAction: 'special' }),
  B('hephaestus.spear.seek', 'hephaestus', 'forge', 'Magnetic Harpoon', { turn: 5 },
    v => `Thrown Spears bend toward foes; recalled Spears pull home with +${v.turn} tracking force.`,
    (m, v) => { m.forge.spear.homing = Math.max(m.forge.spear.homing, v.turn); }, { weapon: 'spear', forgeAction: 'special' }),
  B('hephaestus.spear.attack', 'hephaestus', 'forge', 'Adamant Point', { pct: 20 },
    v => `Spear Attack and Dash-Strike damage gain +${v.pct}%.`,
    (m, v) => { m.forge.spear.attackMul *= 1 + v.pct / 100; }, { weapon: 'spear', forgeAction: 'attack' }),
  B('hephaestus.spear.cast', 'hephaestus', 'forge', 'Skewer Cast', { pct: 16, pierce: 2 },
    v => `Your Cast gains +${v.pct}% damage and pierces ${v.pierce} additional foes.`,
    (m, v) => { m.forge.spear.castMul *= 1 + v.pct / 100; m.forge.spear.castPierce = Math.max(m.forge.spear.castPierce, v.pierce); },
    { weapon: 'spear', forgeAction: 'cast' }),

  B('hephaestus.bow.triple', 'hephaestus', 'forge', 'Triple-Forged String', {},
    () => `A fully drawn Bow fires a tight fan of three arrows.`,
    (m) => { m.forge.bow.triple = true; }, { weapon: 'bow', forgeAction: 'attack' }),
  B('hephaestus.bow.explosive', 'hephaestus', 'forge', 'Blast-Capped Arrows', { radius: 3.2 },
    v => `Full-charge arrows explode across ${v.radius}m on impact.`,
    (m, v) => { m.forge.bow.blast = Math.max(m.forge.bow.blast, v.radius); }, { weapon: 'bow', forgeAction: 'attack' }),
  B('hephaestus.bow.seek', 'hephaestus', 'forge', 'Living Bronze Fletching', { turn: 6 },
    v => `Full-charge arrows seek enemies with ${v.turn} homing force.`,
    (m, v) => { m.forge.bow.homing = Math.max(m.forge.bow.homing, v.turn); }, { weapon: 'bow', forgeAction: 'attack' }),
  B('hephaestus.bow.special', 'hephaestus', 'forge', 'Backdraft Kick', { pct: 22 },
    v => `The Bow Special gains +${v.pct}% damage and breaks through heavier armor.`,
    (m, v) => { m.forge.bow.specialMul *= 1 + v.pct / 100; }, { weapon: 'bow', forgeAction: 'special' }),
  B('hephaestus.bow.cast', 'hephaestus', 'forge', 'Hunter-Seeking Cast', { pct: 16, turn: 6 },
    v => `Your Cast gains +${v.pct}% damage and seeks foes with ${v.turn} tracking force.`,
    (m, v) => { m.forge.bow.castMul *= 1 + v.pct / 100; m.forge.bow.castSeek = Math.max(m.forge.bow.castSeek, v.turn); },
    { weapon: 'bow', forgeAction: 'cast' }),

  B('hephaestus.shield.ram', 'hephaestus', 'forge', 'Furnace Ram', { dmg: 38 },
    v => `A full Shield Rush releases a second molten shockwave for ${v.dmg} damage.`,
    (m, v) => { m.forge.shield.ram = Math.max(m.forge.shield.ram, v.dmg); }, { weapon: 'shield', forgeAction: 'special' }),
  B('hephaestus.shield.bank', 'hephaestus', 'forge', 'Masterwork Reprisal', { dmg: 44 },
    v => `A perfect block banks ${v.dmg} damage for your next Shield Rush.`,
    (m, v) => { m.forge.shield.bank = Math.max(m.forge.shield.bank, v.dmg); }, { weapon: 'shield', forgeAction: 'special' }),
  B('hephaestus.shield.reflect', 'hephaestus', 'forge', 'Mirrored Anvil', { dmg: 28 },
    v => `Reflecting a projectile also blasts nearby foes for ${v.dmg} damage.`,
    (m, v) => { m.forge.shield.reflect = Math.max(m.forge.shield.reflect, v.dmg); }, { weapon: 'shield', forgeAction: 'special' }),
  B('hephaestus.shield.attack', 'hephaestus', 'forge', 'Weighted Rim', { pct: 20 },
    v => `Shield Attack combos gain +${v.pct}% damage.`,
    (m, v) => { m.forge.shield.attackMul *= 1 + v.pct / 100; }, { weapon: 'shield', forgeAction: 'attack' }),
  B('hephaestus.shield.cast', 'hephaestus', 'forge', 'Ricochet Cast', { pct: 16, bounces: 2 },
    v => `Your Cast gains +${v.pct}% damage and ricochets ${v.bounces} times.`,
    (m, v) => { m.forge.shield.castMul *= 1 + v.pct / 100; m.forge.shield.castBounces = Math.max(m.forge.shield.castBounces, v.bounces); },
    { weapon: 'shield', forgeAction: 'cast' }),
];

// Every additional Infernal/Nocturnal Arm gets a complete three-action forge
// family. The first card changes the weapon's rule (shockwave or split shot),
// while the other two improve Special and Cast independently.
const EXTENDED_FORGE = {
  fists:  { noun: 'Knuckles', attack: 'Quake Knuckles', trait: 'nova' },
  rail:   { noun: 'Chamber', attack: 'Triple Chamber', trait: 'triple' },
  staff:  { noun: 'Moonstone', attack: 'Resonant Moonstone', trait: 'nova' },
  blades: { noun: 'Sisters', attack: 'Forked Sisters', trait: 'triple' },
  flames: { noun: 'Embers', attack: 'Threefold Embers', trait: 'triple' },
  axe:    { noun: 'Crescent', attack: 'Seismic Crescent', trait: 'nova' },
  skull:  { noun: 'Shells', attack: 'Blast-Forged Shells', trait: 'blast' },
  coat:   { noun: 'Jets', attack: 'Quake Jets', trait: 'nova' },
};
for (const [weapon, spec] of Object.entries(EXTENDED_FORGE)) {
  BOONS.push(
    B(`hephaestus.${weapon}.attack`, 'hephaestus', 'forge', spec.attack, { pct: 20, dmg: 24, radius: 2.6 },
      v => `${spec.noun} Attack gains +${v.pct}% damage and ${spec.trait === 'triple' ? 'full charges split into three shots' : spec.trait === 'blast' ? `full shots explode across ${v.radius}m` : `hits release a ${v.dmg}-damage forged shockwave`}.`,
      (m, v) => {
        const f = m.forge[weapon]; f.attackMul *= 1 + v.pct / 100;
        if (spec.trait === 'triple') f.triple = true;
        else if (spec.trait === 'blast') f.blast = Math.max(f.blast || 0, v.radius);
        else f.nova = Math.max(f.nova || 0, v.dmg);
      }, { weapon, forgeAction: 'attack' }),
    B(`hephaestus.${weapon}.special`, 'hephaestus', 'forge', `Tempered ${spec.noun}`, { pct: 24 },
      v => `${spec.noun} Special gains +${v.pct}% damage and poise-breaking force.`,
      (m, v) => { m.forge[weapon].specialMul *= 1 + v.pct / 100; }, { weapon, forgeAction: 'special' }),
    B(`hephaestus.${weapon}.cast`, 'hephaestus', 'forge', `${spec.noun} Witch-Cast`, { pct: 18, turn: 5 },
      v => `Cast gains +${v.pct}% damage and ${v.turn} seeking while wielding this arm.`,
      (m, v) => { m.forge[weapon].castMul *= 1 + v.pct / 100; m.forge[weapon].castSeek = Math.max(m.forge[weapon].castSeek || 0, v.turn); },
      { weapon, forgeAction: 'cast' }),
  );
}
BOONS.push(...HADES2_BOONS);
const MELINOE_CORE_GODS = new Set(HADES2_BOONS.map(b => b.god));
BOONS.push(...EXPANDED_BOONS);
for (const boon of CANON_BOONS) if (!BOONS.some(existing => existing.id === boon.id)) BOONS.push(boon);

// ═══════════════════════════════════════════════════════════ DUO BOONS ════
// A duo requires a boon from BOTH gods already granted. They are rare, always
// offered at Epic or above, and read as the run's payoff.
export const DUOS = [
  { id: 'duo.zeus.poseidon', gods: ['zeus', 'poseidon'], name: 'Sea Storm', slot: 'passive',
    base: { dmg: 40 }, text: v => `Foes knocked back are struck by lightning for ${v.dmg} damage.`,
    apply: (m, v) => { m.seaStormDmg += v.dmg; } },
  { id: 'duo.zeus.artemis', gods: ['zeus', 'artemis'], name: 'Fully Loaded', slot: 'passive',
    base: { crit: 10 }, text: v => `Lightning strikes can Critically hit for +${v.crit}%.`,
    apply: (m, v) => { m.lightningCrit += v.crit / 100; } },
  { id: 'duo.ares.aphrodite', gods: ['ares', 'aphrodite'], name: 'Curse of Longing', slot: 'passive',
    base: { dmg: 55 }, text: v => `Doom on Weakened foes deals ${v.dmg} extra damage.`,
    apply: (m, v) => { m.doomVsWeak += v.dmg; } },
  { id: 'duo.ares.artemis', gods: ['ares', 'artemis'], name: 'Hunting Blades', slot: 'passive',
    base: { dmg: 34 }, text: v => `Critical hits open a Blade Rift for ${v.dmg} damage.`,
    apply: (m, v) => { m.critRiftDmg += v.dmg; } },
  { id: 'duo.dionysus.aphrodite', gods: ['dionysus', 'aphrodite'], name: 'Low Tolerance', slot: 'passive',
    base: { dmg: 6 }, text: v => `Weakened foes take +${v.dmg}% damage per Hangover stack.`,
    apply: (m, v) => { m.hangoverVsWeak += v.dmg / 100; } },
  { id: 'duo.hecate.selene', gods: ['hecate', 'selene'], name: 'Moonstruck', slot: 'passive',
    base: { dmg: 28 }, text: v => `Frozen foes shatter under moonlight for ${v.dmg} arcane damage.`,
    apply: (m, v) => { m.moonlightShatter += v.dmg; } },
  { id: 'duo.athena.hermes', gods: ['athena', 'hermes'], name: 'Sure Footing', slot: 'passive',
    base: { dodge: 12 }, text: v => `While deflecting, gain +${v.dodge}% dodge and move freely.`,
    apply: (m, v) => { m.deflectDodge += v.dodge / 100; } },
  { id: 'duo.poseidon.hermes', gods: ['poseidon', 'hermes'], name: 'Rip Current', slot: 'passive',
    base: { spd: 18 }, text: v => `Knockback carries you: move ${v.spd}% faster after a slam.`,
    apply: (m, v) => { m.slamSpeed += v.spd / 100; m.knockback += 1.5; } },
];
DUOS.push(...EXPANDED_DUOS);
for (const duo of CANON_DUOS) if (!DUOS.some(existing => existing.id === duo.id)) DUOS.push(duo);

// ═════════════════════════════════════════════════ PREREQUISITE GATING ════
// In Hades a Duo is not "you met both gods". It is "you hold one of *these*
// boons from her AND one of *these* from him", which is what turns a Duo into
// something you build toward instead of something that happens to you.
//
// Authoring 100+ hand-written requirement lists would rot instantly, so the
// list is derived once, deterministically, from what each god actually offers:
// their action-slot boons (Attack/Special/Cast/Dash/Call) are the prerequisite
// pool, because those are the cards that define a build. Passives are excluded
// — a passive is a stat, not a commitment. A duo may still override with its
// own explicit `requires` map when a designer wants a tighter promise.
const ACTION_SET = new Set(ACTION_SLOTS);
const PREREQ_POOL = new Map();
function prereqPool(god) {
  let list = PREREQ_POOL.get(god);
  if (!list) {
    list = BOONS.filter(b => b.god === god && ACTION_SET.has(b.slot) && !b.weapon).map(b => b.id);
    // A god with no action family at all (pure passives) still needs a gate.
    if (!list.length) list = BOONS.filter(b => b.god === god).map(b => b.id);
    PREREQ_POOL.set(god, list);
  }
  return list;
}
for (const duo of DUOS) {
  if (!duo.requires) {
    duo.requires = {};
    for (const god of duo.gods) duo.requires[god] = prereqPool(god);
  }
  duo.tier = 'duo';
}

// ══════════════════════════════════════════════════════ LEGENDARY BOONS ════
// One god, deep investment. Hades gates a Legendary behind two specific boons
// from that god; we gate behind `need` distinct action boons from their pool,
// which is the same promise expressed against a generated catalog. Legendaries
// never roll a rarity — they arrive at their own fixed tier.
const L = (id, god, name, need, base, text, apply, extra = {}) => ({
  id: `legendary.${id}`, god, slot: 'legendary', name, base, text, apply,
  legendary: true, tier: 'legendary', need,
  requires: { [god]: null },   // filled from prereqPool below
  ...extra,
});

export const LEGENDARIES = [
  L('splitting-bolt', 'zeus', 'Splitting Bolt', 2, { arcs: 1, dmg: 24 },
    v => `Your lightning forks to ${v.arcs} more foes and every Blitz discharge deals ${v.dmg} extra damage.`,
    (m, v) => { m.castForks += v.arcs; m.status.shock *= 1.35; m.chainBonus += v.dmg; }, { curse: 'blitz' }),
  L('hydraulic-might', 'poseidon', 'Hydraulic Might', 2, { pct: 30, knock: 3 },
    v => `Knockback gains ${v.knock}m and every wall slam deals ${v.pct}% more damage.`,
    (m, v) => { m.knockback += v.knock; m.wallSlamDmg += 30; m.slamAmp += v.pct / 100; }, { curse: 'slow' }),
  L('divine-protection', 'athena', 'Divine Protection', 2, { dr: 18, deflect: 0.5 },
    v => `Take ${v.dr}% less damage, and each chamber begins with a ${v.deflect}s Deflect.`,
    (m, v) => { m.damageTaken *= 1 - v.dr / 100; m.deflect += v.deflect; m.roomDeflect += v.deflect; }),
  L('broken-resolve', 'aphrodite', 'Broken Resolve', 2, { pct: 40 },
    v => `Weak foes take ${v.pct}% more damage from every source.`,
    (m, v) => { m.vsWeakAmp += v.pct / 100; m.status.weak *= 1.4; }, { curse: 'weak' }),
  L('vicious-cycle', 'ares', 'Vicious Cycle', 2, { dmg: 30 },
    v => `Each Wither that resolves deals ${v.dmg} more damage than the last, up to five times.`,
    (m, v) => { m.doomDmg += v.dmg; m.doomEscalate += v.dmg; m.status.doom *= 1.3; }, { curse: 'wither' }),
  L('hunters-instinct', 'artemis', 'Hunter’s Instinct', 2, { crit: 15, mul: 1.0 },
    v => `Gain ${v.crit}% Critical chance and +${v.mul}x Critical damage; marks never expire.`,
    (m, v) => { m.critChance += v.crit / 100; m.critMul += v.mul; m.markPermanent = 1; }),
  L('black-out', 'dionysus', 'Black Out', 2, { dmg: 6 },
    v => `Hangover stacks amplify all damage by a further ${v.dmg}% each and never fall off early.`,
    (m, v) => { m.hangoverAmp += v.dmg / 100; m.statusDuration.burn *= 1.6; }, { curse: 'scorch' }),
  L('greatest-reflex', 'hermes', 'Greatest Reflex', 2, { dash: 1, dodge: 12 },
    v => `Gain ${v.dash} additional Dash and ${v.dodge}% dodge.`,
    (m, v) => { m.dashCharges += v.dash; m.dodge += v.dodge / 100; m.moveMul *= 1.08; }),
  L('winter-harvest', 'demeter', 'Winter Harvest', 2, { dmg: 60 },
    v => `Frozen foes shatter when struck, dealing ${v.dmg} area damage.`,
    (m, v) => { m.shatterDmg += v.dmg; m.moonlightShatter += v.dmg * 0.4; m.status.chill *= 1.3; }, { curse: 'freeze' }),
  L('perfect-image', 'apollo', 'Perfect Image', 2, { pct: 25 },
    v => `Blinded foes cannot land a blow and take ${v.pct}% more damage.`,
    (m, v) => { m.vsWeakAmp += v.pct / 100; m.statusDuration.weak *= 1.5; }, { curse: 'blind' }),
  L('nexus-sting', 'hera', 'Nexus Sting', 2, { pct: 35 },
    v => `Hitched foes share ${v.pct}% of all damage you deal to any of them.`,
    (m, v) => { m.hitchShare += v.pct / 100; m.status.weak *= 1.3; }, { curse: 'hitch' }),
  L('soot-sprite', 'hestia', 'Soot Sprite', 2, { stacks: 3 },
    v => `Scorch reaches ${v.stacks} more stacks and its damage no longer plateaus.`,
    (m, v) => { m.scorchCap += v.stacks; m.status.burn *= 1.45; }, { curse: 'scorch' }),
  L('volcanic-ash', 'hephaestus', 'Volcanic Ash', 2, { dmg: 55 },
    v => `Every forged Blast leaves cinders that deal ${v.dmg} damage over time.`,
    (m, v) => { m.forgeMul *= 1.25; m.blastCinder += v.dmg; }, { curse: 'scorch' }),
  L('crossroads-crown', 'hecate', 'Crossroads Crown', 2, { pct: 35, mana: 40 },
    v => `Cast damage gains ${v.pct}% and Magick returns ${v.mana}% faster.`,
    (m, v) => { m.castMul *= 1 + v.pct / 100; m.manaRegenMul *= 1 + v.mana / 100; }, { curse: 'freeze' }),
  L('moons-favour', 'selene', 'Moon’s Favour', 2, { pct: 45, cdr: 30 },
    v => `Your Call deals ${v.pct}% more damage and charges ${v.cdr}% faster.`,
    (m, v) => { m.callMul *= 1 + v.pct / 100; m.callCharge *= 1 + v.cdr / 100; }),
];
for (const leg of LEGENDARIES) leg.requires = { [leg.god]: prereqPool(leg.god) };
BOONS.push(...LEGENDARIES);

/**
 * Does `held` (a Set/Map of owned boon ids) satisfy this boon's requirement?
 * Returns a structured report so the card can *show* what is still missing —
 * a locked duo the player can read is a goal; one they cannot is noise.
 */
export function prerequisiteStatus(boon, held) {
  const req = boon && boon.requires;
  if (!req) return { gated: false, met: true, need: 0, gods: [] };
  const has = (id) => (held && (held.has ? held.has(id) : !!held[id]));
  const need = boon.need || 1;
  const gods = [];
  let met = true;
  for (const god of Object.keys(req)) {
    const pool = req[god] || [];
    const owned = pool.filter(has);
    const short = Math.max(0, need - owned.length);
    if (short > 0) met = false;
    gods.push({
      god,
      need,
      have: owned.length,
      met: short === 0,
      ownedNames: owned.map(id => BOONS.find(b => b.id === id)?.name).filter(Boolean),
    });
  }
  return { gated: true, met, need, gods };
}

// ═══════════════════════════════════════════════════════ MODIFIER STATE ════
export function emptyMods() {
  return {
    // multiplicative
    dmgMul: 1, attackMul: 1, specialMul: 1, castMul: 1, callMul: 1,
    attackSpeed: 1, castSpeed: 1, moveMul: 1, manaRegenMul: 1, callCharge: 1,
    damageTaken: 1, forgeMul: 1,
    // additive
    critChance: 0, critMul: 0, dodge: 0, expose: 0, knockback: 0,
    maxHealthAdd: 0, maxManaAdd: 0, iframeAdd: 0, deflect: 0, castShardBonus: 0,
    castRadius: 0, castTicks: 0, castForks: 0, castSeek: 0, castBeam: 0,
    dashRadius: 0, doomDmg: 0, shatterDmg: 0, wallSlamDmg: 0, clearHeal: 0,
    hangoverAmp: 0, retaliate: 0, retaliateDmg: 0, callRefund: 0,
    seaStormDmg: 0, lightningCrit: 0, doomVsWeak: 0, critRiftDmg: 0,
    hangoverVsWeak: 0, moonlightShatter: 0, deflectDodge: 0, slamSpeed: 0,
    // Legendary payoffs. Each is read by exactly one place at runtime; the
    // ones combat does not yet consume still change the loadout report and the
    // Codex, so no Legendary is ever a card with no consequence.
    chainBonus: 0, slamAmp: 0, roomDeflect: 0, vsWeakAmp: 0, doomEscalate: 0,
    markPermanent: 0, dashCharges: 0, hitchShare: 0, scorchCap: 0, blastCinder: 0,
    // per-slot riders
    rider: { attack: null, special: null, cast: null, dash: null, call: null },
    // status potency multipliers, keyed to the combat system's own statuses
    status: { burn: 1, chill: 1, shock: 1, doom: 1, weak: 1 },
    statusDuration: { burn: 1, chill: 1, shock: 1, doom: 1, weak: 1 },
    forge: {
      blade: { attackMul: 1, specialMul: 1, castMul: 1, wave: 0, echo: 0, ember: 0, castBlast: 0 },
      spear: { attackMul: 1, specialMul: 1, castMul: 1, trident: false, recallBlast: 0, homing: 0, castPierce: 0 },
      bow: { attackMul: 1, specialMul: 1, castMul: 1, triple: false, blast: 0, homing: 0, castSeek: 0 },
      shield: { attackMul: 1, specialMul: 1, castMul: 1, ram: 0, bank: 0, reflect: 0, castBounces: 0 },
      fists: { attackMul: 1, specialMul: 1, castMul: 1, nova: 0, castSeek: 0 },
      rail: { attackMul: 1, specialMul: 1, castMul: 1, triple: false, castSeek: 0 },
      staff: { attackMul: 1, specialMul: 1, castMul: 1, nova: 0, castSeek: 0 },
      blades: { attackMul: 1, specialMul: 1, castMul: 1, triple: false, castSeek: 0 },
      flames: { attackMul: 1, specialMul: 1, castMul: 1, triple: false, castSeek: 0 },
      axe: { attackMul: 1, specialMul: 1, castMul: 1, nova: 0, castSeek: 0 },
      skull: { attackMul: 1, specialMul: 1, castMul: 1, blast: 0, castSeek: 0 },
      coat: { attackMul: 1, specialMul: 1, castMul: 1, nova: 0, castSeek: 0 },
    },
  };
}

/**
 * The run's boon loadout. Cheap to query: `ctx.boons.mods.attackMul`.
 * Rebuilt only when a boon is granted.
 */
export class BoonState {
  constructor(ctx) {
    this.ctx = ctx || null;
    this.granted = [];               // [{boon, rarity, values, god, slot}]
    this.byId = new Map();
    this.mods = emptyMods();
    this.godCount = {};
    // Fated Persuasion: a run-scoped currency that lets the player refuse the
    // hand they were dealt. Seeded from the Mirror so meta progression is felt
    // on the very first offer of a descent.
    this.rerolls = 0;
    this.rerollsSpent = 0;
    this._seen = new Set();          // ids already shown this offer, for rerolls
    // Poms of Power. Held as a run resource so a chamber reward, a shop or a
    // boss drop can all hand one over through the same door.
    this.poms = 0;
  }

  has(id) { return this.byId.has(id); }
  get(id) { return this.byId.get(id) || null; }
  /** Gods with at least one boon — the duo requirement and the HUD tray. */
  gods() { return Object.keys(this.godCount); }
  list() { return this.granted; }
  /** The rider a slot's hit should carry, or null. Zero-alloc read. */
  rider(slot) { return this.mods.rider[slot]; }

  /** Rarity values after permanent Crossroads mastery for the owning god(s). */
  values(boon, rarity, level = 1) {
    const out = valuesFor(boon, rarity);
    const meta = this.ctx?.meta;
    const gods = boon.gods || [boon.god];
    const mastery = meta
      ? gods.reduce((sum, god) => sum + (meta.boonMultiplier?.(god) || 1), 0) / Math.max(1, gods.length)
      : 1;
    // Levels are the Pom-style axis while rarity is the quality axis. Keeping
    // them separate lets the loadout menu report a real potency increase.
    const mul = mastery * (1 + Math.max(0, level - 1) * 0.12);
    if (mul <= 1) return out;
    for (const key in out) {
      if (typeof out[key] !== 'number') continue;
      const v = out[key] * mul;
      out[key] = DISCRETE_VALUES.has(key) ? Math.max(1, Math.round(v)) : (Math.abs(out[key]) >= 5 ? Math.round(v) : Math.round(v * 10) / 10);
    }
    return out;
  }

  grant(entry) {
    if (!entry || !entry.boon) return null;
    const prev = this.byId.get(entry.boon.id);
    const incomingSlot = entry.boon.slot || 'passive';
    let replaced = null;
    // Core action boons are mutually exclusive. Replacing them prevents two
    // gods' statuses from being folded into one corrupt rider and matches the
    // familiar Hades loadout model. The surrendered boon also tempers its
    // successor: the replacement inherits the stronger tier and advances once.
    // Passive, forge and duo gifts remain freely stackable.
    if (!prev && CORE_SLOTS.includes(incomingSlot)) {
      const old = this.granted.find(r => !r.duo && r.slot === incomingSlot);
      if (old) {
        replaced = old;
        this.granted.splice(this.granted.indexOf(old), 1);
        this.byId.delete(old.boon.id);
        this.godCount[old.god] = Math.max(0, (this.godCount[old.god] || 1) - 1);
        if (!this.godCount[old.god]) delete this.godCount[old.god];
      }
    }
    // Re-offering an owned boon is an upgrade. Never let a later low roll
    // replace an Epic/Heroic copy with a weaker one. Replacement offers are
    // normally promoted by offer() so the player sees the true card; direct
    // callers receive the same promotion here exactly once.
    const requested = entry.rarity || 'common';
    let rarity = prev && rarityRank(prev.rarity) > rarityRank(requested) ? prev.rarity : requested;
    if (replaced) {
      const inherited = rarityRank(replaced.rarity) > rarityRank(rarity) ? replaced.rarity : rarity;
      const previewMatches = entry.replacementBoosted && entry.replaces === replaced.boon.id;
      rarity = previewMatches ? inherited : nextRarity(inherited);
    }
    const level = prev ? (prev.level || 1) + 1 : replaced ? (replaced.level || 1) : Math.max(1, entry.level || 1);
    const rec = {
      boon: entry.boon, rarity,
      values: this.values(entry.boon, rarity, level),
      level,
      god: entry.boon.god || (entry.boon.gods && entry.boon.gods[0]),
      slot: entry.boon.slot || 'passive',
      duo: !!entry.boon.gods,
    };
    if (prev) {                                  // upgrade in place
      this.granted[this.granted.indexOf(prev)] = rec;
    } else {
      this.granted.push(rec);
      if (rec.boon.gods) { for (const g of rec.boon.gods) this.godCount[g] = (this.godCount[g] || 0) + 1; }
      else this.godCount[rec.god] = (this.godCount[rec.god] || 0) + 1;
    }
    this.byId.set(rec.boon.id, rec);
    this.rebuild();
    this._syncPlayer();
    if (replaced) this.ctx?.events?.emit?.('boon.replaced', {
      old: replaced.boon, oldRarity: replaced.rarity,
      replacement: rec.boon, rarity: rec.rarity, values: rec.values, slot: incomingSlot,
    });
    this.ctx?.events?.emit?.('boon.granted', { boon: rec.boon, rarity: rec.rarity, values: rec.values, record: rec });
    return rec;
  }

  rebuild() {
    const m = emptyMods();
    this.ctx?.meta?.applyPassives?.(m);
    for (const rec of this.granted) {
      try { rec.boon.apply(m, rec.values, this.ctx); } catch (e) { /* a bad boon must never kill the run */ }
    }
    // Status potency folds into rider stacks so combat needs no extra query.
    for (const k in m.rider) {
      const r = m.rider[k];
      if (r && r.status && m.status[r.status] > 1) r.stacks = Math.max(1, Math.round(r.stacks * m.status[r.status]));
    }
    for (const rec of this.granted) {
      const r = m.rider[rec.slot];
      if (r && (!r.god || r.god === rec.god)) r.tier = Math.max(r.tier || 1, rarityRank(rec.rarity) + 1);
    }
    this.mods = m;
    return m;
  }

  /** Publish persistent boon stats onto the hero; combat reads the rest live. */
  _syncPlayer() {
    const p = this.ctx?.player;
    if (!p) return;
    if (p._boonBaseMaxHealth == null) p._boonBaseMaxHealth = p.maxHealth;
    if (p._boonBaseMaxMana == null) p._boonBaseMaxMana = p.maxMana;
    const oldHealthMax = p.maxHealth;
    const oldManaMax = p.maxMana;
    p.maxHealth = p._boonBaseMaxHealth + this.mods.maxHealthAdd;
    p.maxMana = p._boonBaseMaxMana + this.mods.maxManaAdd;
    if (p.maxHealth > oldHealthMax) p.health += p.maxHealth - oldHealthMax;
    if (p.maxMana > oldManaMax) p.mana += p.maxMana - oldManaMax;
    p.health = Math.min(p.health, p.maxHealth);
    p.mana = Math.min(p.mana, p.maxMana);
    p.critChance = this.mods.critChance;
    p.critMul = 2 + this.mods.critMul;
    this.ctx.ui?.setHealth?.(p.health, p.maxHealth);
    this.ctx.ui?.setMana?.(p.mana, p.maxMana);
  }

  clear() {
    this.granted.length = 0;
    this.byId.clear();
    this.godCount = {};
    this.rebuild();
    this._syncPlayer();
    this.seedRun();
  }

  /**
   * Start-of-descent resources. Called by clear() so a new run always begins
   * with whatever the Mirror has earned — no run system change required.
   */
  seedRun() {
    this.rerolls = Math.max(0, this.ctx?.meta?.startingRerolls?.() || 0);
    this.rerollsSpent = 0;
    this.poms = 0;
    this._seen = new Set();
    this.ctx?.events?.emit?.('boon.rerolls', { total: this.rerolls });
    return this;
  }

  // ── slots ────────────────────────────────────────────────────────────────
  /**
   * The five action categories and what currently occupies each. This is the
   * contract the offer engine, the HUD ability icons and the Codex all read,
   * so "which slot is free" has exactly one answer in the codebase.
   */
  slotState() {
    const out = {};
    for (const slot of ACTION_SLOTS) {
      const rec = this.granted.find(r => !r.duo && !r.boon.legendary && r.slot === slot) || null;
      out[slot] = {
        slot,
        filled: !!rec,
        record: rec,
        name: rec ? rec.boon.name : null,
        god: rec ? rec.god : null,
        rarity: rec ? rec.rarity : null,
        level: rec ? (rec.level || 1) : 0,
        upgradable: !!rec && isLadder(rec.rarity) && rarityRank(rec.rarity) < RARITIES.length - 1,
      };
    }
    return out;
  }
  /** Categories with nothing in them yet — what a god should offer first. */
  freeSlots() { const s = this.slotState(); return ACTION_SLOTS.filter(k => !s[k].filled); }
  /** The boon occupying a category, or null. */
  slotBoon(slot) { return this.slotState()[slot]?.record || null; }

  // ── duo & legendary gating ───────────────────────────────────────────────
  /** Structured "what do I still need" for any gated card. */
  prerequisites(boon) { return prerequisiteStatus(boon, this.byId); }

  /** Which duos are currently unlockable — prerequisite boons actually held. */
  availableDuos() {
    return DUOS.filter(d => !this.byId.has(d.id) && prerequisiteStatus(d, this.byId).met);
  }
  /** Duos one prerequisite away, for the "you are close" callout. */
  pendingDuos() {
    return DUOS
      .filter(d => !this.byId.has(d.id))
      .map(d => ({ duo: d, status: prerequisiteStatus(d, this.byId) }))
      .filter(x => !x.status.met && x.status.gods.some(g => g.met));
  }
  /** Legendaries whose single-god investment requirement is satisfied. */
  availableLegendaries(god) {
    return LEGENDARIES.filter(l => !this.byId.has(l.id) && (!god || l.god === god)
      && prerequisiteStatus(l, this.byId).met);
  }

  // ── Pom of Power ─────────────────────────────────────────────────────────
  /** Every boon a Pom could deepen: anything with numbers that can grow. */
  pomTargets() {
    return this.granted.filter(r => r.boon && r.boon.base && Object.keys(r.boon.base).length);
  }
  /**
   * Raise one boon's level. Levels are the Pom axis (potency) and rarity is
   * the quality axis; keeping them orthogonal is what lets a Common boon you
   * have fed five Poms out-damage a fresh Epic, exactly as in Hades.
   */
  applyPom(id, levels = 1) {
    const rec = this.byId.get(id);
    if (!rec) return null;
    const before = rec.values;
    rec.level = Math.max(1, (rec.level || 1) + Math.max(1, levels | 0));
    rec.values = this.values(rec.boon, rec.rarity, rec.level);
    this.rebuild();
    this._syncPlayer();
    this.ctx?.events?.emit?.('boon.levelled', { boon: rec.boon, level: rec.level, values: rec.values, before, record: rec });
    return rec;
  }
  /** Pom offers, shaped like boon offers so one card renderer serves both. */
  pomOffers(rng, count = 3) {
    const targets = this.pomTargets();
    if (!targets.length) return [];
    const picked = [];
    const pool = targets.slice();
    while (picked.length < Math.min(count, pool.length)) {
      const i = rng && rng.f ? Math.floor(rng.f() * pool.length) % pool.length : 0;
      picked.push(pool.splice(i, 1)[0]);
    }
    return picked.map(rec => {
      const next = this.values(rec.boon, rec.rarity, (rec.level || 1) + 1);
      return {
        id: rec.boon.id, boon: rec.boon, rarity: rec.rarity, values: next,
        god: rec.god, gods: rec.boon.gods || [rec.god], slot: rec.slot,
        level: (rec.level || 1) + 1, name: rec.boon.name,
        text: safeText(rec.boon, next),
        color: GOD_INFO[rec.god] ? GOD_INFO[rec.god].color : '#f2c14e',
        kind: 'pom', pom: true, duo: !!rec.boon.gods,
        curse: curseForBoon(rec.boon),
        tier: rec.rarity,
        fromLevel: rec.level || 1,
        fromValues: rec.values,
      };
    });
  }

  // ── rerolls ──────────────────────────────────────────────────────────────
  grantRerolls(n = 1) {
    this.rerolls = Math.max(0, this.rerolls + (n | 0));
    this.ctx?.events?.emit?.('boon.rerolls', { total: this.rerolls });
    return this.rerolls;
  }
  canReroll() { return this.rerolls > 0; }
  /**
   * Spend one token and deal a different hand. Everything already shown is
   * remembered for the life of the offer, so a reroll can never hand back the
   * same three cards — the single most important property of the feature.
   */
  reroll(rng, options = {}, shown = []) {
    if (!this.canReroll()) return null;
    this.rerolls--;
    this.rerollsSpent++;
    for (const o of shown) if (o && o.id) this._seen.add(o.id);
    const next = this.roll(rng, { ...options, exclude: this._seen });
    this.ctx?.events?.emit?.('boon.rerolled', { remaining: this.rerolls, offers: next });
    return next;
  }
  /** Called by whoever opens a fresh offer so reroll memory does not leak. */
  beginOffer() { this._seen = new Set(); return this; }

  // ── offering ─────────────────────────────────────────────────────────────
  /**
   * Roll `count` distinct boon offers. Deterministic: pass ctx.rng (or a fork).
   * `god` forces a single god (a chamber is usually one god's offer).
   */
  roll(rng, o = {}) {
    const count = o.count || 3;
    const pickR = (god = o.god) => {
      if (o.rarity) return o.rarity;
      const weights = this.ctx?.meta?.rarityWeights?.(god) || RARITY_WEIGHT;
      const total = RARITIES.reduce((s, r) => s + weights[r], 0);
      let x = (rng ? rng.f() : 0.5) * total;
      for (const r of RARITIES) { x -= weights[r]; if (x <= 0) return r; }
      return 'common';
    };
    // A forge chamber is a compact build decision, not three variants of the
    // same button. It always presents one current-weapon Attack, Special and
    // Cast temper. Owned choices advance rarity once all choices in that path
    // have been discovered.
    if (o.god === 'hephaestus' && o.weapon && count === 3) {
      const offers = [];
      for (const action of ['attack', 'special', 'cast']) {
        const authored = BOONS.filter(b => b.god === 'hephaestus' && b.weapon === o.weapon && b.forgeAction === action);
        const fresh = authored.filter(b => !this.byId.has(b.id));
        const upgradeable = this.granted.filter(rec => rec.god === 'hephaestus' && rec.boon.weapon === o.weapon
          && rec.boon.forgeAction === action && rarityRank(rec.rarity) < RARITIES.length - 1);
        if (fresh.length) {
          const boon = rng ? rng.pick(fresh) : fresh[0];
          offers.push(this.offer(boon, pickR('hephaestus')));
        } else if (upgradeable.length) {
          const rec = rng ? rng.pick(upgradeable) : upgradeable[0];
          const offer = this.offer(rec.boon, nextRarity(rec.rarity));
          offer.upgrade = true;
          offers.push(offer);
        } else if (authored.length) {
          const boon = rng ? rng.pick(authored) : authored[0];
          offers.push(this.offer(boon, 'heroic'));
        }
      }
      if (offers.length === count) return offers;
    }
    const out = [];
    const excluded = o.exclude instanceof Set ? o.exclude : new Set(o.exclude || []);
    // A Legendary outranks everything: it is the reward for having committed
    // to one god all descent, and it can only appear at that god's own gate.
    const legendaries = this.availableLegendaries(o.god).filter(l => !excluded.has(l.id));
    if (legendaries.length && o.allowLegendary !== false
      && (rng ? rng.f() : 0) < (o.legendaryChance != null ? o.legendaryChance : 0.30)) {
      out.push(this.offer(rng ? rng.pick(legendaries) : legendaries[0]));
    }
    // a duo, if earned, always takes the first slot — it is the run's reward
    const duos = this.availableDuos()
      .filter(d => (!o.god || d.gods.includes(o.god)) && !excluded.has(d.id));
    if (duos.length && (o.allowDuo !== false) && (rng ? rng.f() : 1) < (o.duoChance != null ? o.duoChance : 0.18)) {
      const d = rng ? rng.pick(duos) : duos[0];
      out.push(this.offer(d));
    }
    // Once a god has blessed the run, boon doors can improve that exact gift.
    // The card keeps its identity but moves one rarity tier, so the changed
    // numbers and effect intensity are easy to understand.
    const upgradeable = this.granted.filter(rec => isLadder(rec.rarity)
      && rarityRank(rec.rarity) < RARITIES.length - 1
      && (!o.god || rec.god === o.god)
      && !excluded.has(rec.boon.id)
      && (!rec.boon.weapon || !o.weapon || rec.boon.weapon === o.weapon));
    const upgradeChance = o.upgradeChance != null ? o.upgradeChance : 0.48;
    if (out.length < count && upgradeable.length && (o.preferUpgrade || (rng ? rng.f() : 0) < upgradeChance)) {
      const rec = rng ? rng.pick(upgradeable) : upgradeable[0];
      const upgrade = this.offer(rec.boon, nextRarity(rec.rarity));
      upgrade.upgrade = true;
      out.push(upgrade);
    }
    const gods = o.god ? [o.god] : GOD_KEYS;
    // Epic and Heroic core slots are settled builds. Do not show a different
    // boon for that action: even a rarity-preserving replacement reads as a
    // downgrade and crowds out genuinely new choices. The exact owned boon
    // can still advance Epic -> Heroic through the upgrade path above.
    const protectedSlots = new Set(this.granted
      .filter(rec => !rec.duo && CORE_SLOTS.includes(rec.slot) && rarityRank(rec.rarity) >= rarityRank('epic'))
      .map(rec => rec.slot));
    const hero = o.character || this.ctx?.player?.characterId || null;
    const eligible = b => gods.includes(b.god)
      && (!b.hero || !hero || b.hero === hero)
      && !(hero === 'melinoe' && MELINOE_CORE_GODS.has(b.god) && CORE_SLOTS.includes(b.slot) && b.hero !== 'melinoe')
      && (!b.weapon || !o.weapon || b.weapon === o.weapon)
      && !excluded.has(b.id)
      // Legendaries are never part of the ordinary draw: they enter above,
      // through their own gate, or not at all.
      && !b.legendary
      && !(CORE_SLOTS.includes(b.slot) && protectedSlots.has(b.slot) && !this.byId.has(b.id));
    const pool = BOONS.filter(b => eligible(b) && !this.byId.has(b.id));
    // Hades hands you a card for a category you have not filled far more often
    // than a sidegrade for one you have. Splitting the pool and drawing from
    // the "open category" half first is what stops a run from being five
    // Attack boons in a row while the Cast slot stays empty all descent.
    const open = new Set(this.freeSlots());
    const fresh = pool.filter(b => open.has(b.slot));
    const rest = pool.filter(b => !open.has(b.slot));
    const src = pool;
    const used = new Set(out.map(x => x.boon.id));
    let guard = 0, seq = 0;
    while (out.length < count && src.length && guard++ < 400) {
      // random draw first; after a few misses walk the pool so a small or
      // degenerate rng stream can never return fewer cards than asked for
      const openBias = o.slotBias != null ? o.slotBias : 0.72;
      const preferFresh = fresh.length && (rng ? rng.f() : 0) < openBias;
      const bag = preferFresh ? fresh : (rest.length ? rest : src);
      const b = (rng && guard < 40) ? rng.pick(bag) : src[seq++ % src.length];
      if (!b || used.has(b.id)) continue;
      used.add(b.id);
      out.push(this.offer(b, pickR(b.god)));
    }
    // A late-run forced god can exhaust fresh passive/call choices. Fill only
    // with real rarity promotions, never duplicate Heroic or lower cards.
    for (const rec of upgradeable) {
      if (out.length >= count || used.has(rec.boon.id)) continue;
      const upgrade = this.offer(rec.boon, nextRarity(rec.rarity));
      upgrade.upgrade = true;
      used.add(rec.boon.id);
      out.push(upgrade);
    }
    return out;
  }

  /** Package a boon + rarity into the object the UI renders and grant() takes. */
  offer(boon, rarity = 'common') {
    const slot = boon.slot || 'passive';
    // Duos and Legendaries do not roll. They arrive at their own fixed grade,
    // which is the whole reason those cards read as an event.
    if (boon.gods) rarity = 'duo';
    else if (boon.legendary) rarity = 'legendary';
    const owned = this.byId.get(boon.id);
    if (owned && isLadder(rarity) && rarityRank(owned.rarity) > rarityRank(rarity)) rarity = owned.rarity;
    let replacement = null;
    let replacementBoosted = false;
    // Preview replacement transmutation on the card itself. This keeps the
    // rarity label, description numbers and eventual runtime modifier in lock
    // step instead of surprising the player only after they choose it.
    if (CORE_SLOTS.includes(slot) && !boon.gods && !boon.legendary && !this.byId.has(boon.id)) {
      replacement = this.granted.find(r => !r.duo && r.slot === slot) || null;
      if (replacement) {
        const inherited = rarityRank(replacement.rarity) > rarityRank(rarity) ? replacement.rarity : rarity;
        rarity = nextRarity(inherited);
        replacementBoosted = true;
      }
    }
    const level = owned ? (owned.level || 1) + 1 : replacement ? (replacement.level || 1) : 1;
    const values = this.values(boon, rarity, level);
    const god = boon.god || (boon.gods && boon.gods[0]);
    const prereq = boon.requires ? prerequisiteStatus(boon, this.byId) : null;
    return {
      id: boon.id, boon, rarity, values,
      god, gods: boon.gods || [god],
      slot,
      level,
      name: boon.name,
      text: safeText(boon, values),
      color: GOD_INFO[god] ? GOD_INFO[god].color : '#f2c14e',
      duo: !!boon.gods,
      legendary: !!boon.legendary,
      tier: boon.gods ? 'duo' : boon.legendary ? 'legendary' : rarity,
      curse: curseForBoon(boon),
      prereq,
      locked: !!(prereq && !prereq.met),
      status: boon.status || null,
      upgrade: replacementBoosted,
      replacementBoosted,
      replaces: replacement?.boon?.id || null,
    };
  }

  /**
   * Everything the loadout screen needs about one owned boon, including the
   * live description at its current rarity *and* level — a Codex that shows
   * authored text instead of the numbers actually in play is a lie.
   */
  describe(rec) {
    if (!rec || !rec.boon) return null;
    const boon = rec.boon;
    const god = rec.god || boon.god || (boon.gods && boon.gods[0]);
    return {
      id: boon.id,
      name: boon.name,
      god,
      gods: boon.gods || [god],
      slot: rec.slot || boon.slot || 'passive',
      rarity: rec.rarity || 'common',
      tier: boon.gods ? 'duo' : boon.legendary ? 'legendary' : (rec.rarity || 'common'),
      level: rec.level || 1,
      values: rec.values,
      text: safeText(boon, rec.values),
      curse: curseForBoon(boon),
      duo: !!boon.gods,
      legendary: !!boon.legendary,
      color: GOD_INFO[god] ? GOD_INFO[god].color : '#f2c14e',
    };
  }
  /** The whole build, ordered the way the HUD and Codex read it. */
  loadout() {
    const order = { attack: 0, special: 1, cast: 2, dash: 3, call: 4, gain: 5, legendary: 6, passive: 7, forge: 8 };
    return this.granted
      .map(r => this.describe(r))
      .filter(Boolean)
      .sort((a, b) => (order[a.slot] ?? 9) - (order[b.slot] ?? 9) || a.name.localeCompare(b.name));
  }
}

export const ALL_BOONS = BOONS;
export default {
  BOONS, DUOS, LEGENDARIES, BoonState, GOD_INFO, SLOTS, SLOT_TAG, ACTION_SLOTS,
  RARITIES, TIERS, RARITY_LABEL, RARITY_COLOR, CURSES, curseInfo, curseForBoon,
  prerequisiteStatus, valuesFor,
};
