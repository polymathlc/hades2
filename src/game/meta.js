// Persistent progression shared by the Crossroads home base and every run.
// The save is intentionally small and versioned so a malformed/older browser
// value can never prevent the game from booting.

import { GOD_KEYS } from './boons.js';

export const META_SAVE_KEY = 'erebus.meta.v1';
export const META_MAX_RANK = 5;
export const WEAPON_MAX_RANK = 5;
export const GOD_FAVOR_PER_RANK = 0.20;
export const GOD_TRACKS = Object.freeze(['boon', 'passive', 'devotion']);
export const WEAPON_TRACKS = Object.freeze(['attack', 'special', 'cast']);
export const META_WEAPONS = Object.freeze({
  blade: 'Stygian Blade', spear: 'Eternal Spear', bow: 'Heart-Seeking Bow', shield: 'Shield of Chaos',
});

export const GOD_LEGACIES = {
  zeus:      { name: 'Olympian Authority', text: r => `All damage +${r * 2}%`, apply: (m, r) => { m.dmgMul *= 1 + r * 0.02; } },
  poseidon:  { name: 'Ocean’s Force', text: r => `All knockback +${(r * 0.6).toFixed(1)}m`, apply: (m, r) => { m.knockback += r * 0.6; } },
  athena:    { name: 'Aegis Training', text: r => `Damage taken -${r * 2}%`, apply: (m, r) => { m.damageTaken *= 1 - r * 0.02; } },
  aphrodite: { name: 'Enduring Grace', text: r => `Maximum Life +${r * 5}`, apply: (m, r) => { m.maxHealthAdd += r * 5; } },
  ares:      { name: 'War God’s Edge', text: r => `Critical damage +${(r * 0.08).toFixed(2)}x`, apply: (m, r) => { m.critMul += r * 0.08; } },
  artemis:   { name: 'Hunter’s Instinct', text: r => `Critical chance +${r}%`, apply: (m, r) => { m.critChance += r * 0.01; } },
  dionysus:  { name: 'Vintage Reserve', text: r => `Hangover power +${r * 6}%`, apply: (m, r) => { m.status.burn *= 1 + r * 0.06; } },
  hermes:    { name: 'Winged Practice', text: r => `Move and Attack speed +${r * 2}%`, apply: (m, r) => { const v = 1 + r * 0.02; m.moveMul *= v; m.attackSpeed *= v; } },
  hecate:    { name: 'Crossroads Lore', text: r => `Maximum Magick +${r * 8}; regeneration +${r * 3}%`, apply: (m, r) => { m.maxManaAdd += r * 8; m.manaRegenMul *= 1 + r * 0.03; } },
  selene:    { name: 'Moonlit Discipline', text: r => `Cast and Call damage +${r * 3}%`, apply: (m, r) => { const v = 1 + r * 0.03; m.castMul *= v; m.callMul *= v; } },
  hephaestus:{ name: 'Master Smithing', text: r => `Forged weapon effects +${r * 5}%`, apply: (m, r) => { m.forgeMul *= 1 + r * 0.05; } },
};

const cleanRank = value => Math.max(0, Math.min(META_MAX_RANK, Math.floor(Number(value) || 0)));

function blankGods() {
  const gods = {};
  for (const god of GOD_KEYS) gods[god] = { boon: 0, passive: 0, devotion: 0 };
  return gods;
}

function blankWeapons() {
  return Object.fromEntries(Object.keys(META_WEAPONS).map(id => [id, { attack: 0, special: 0, cast: 0 }]));
}

export class MetaProgression {
  constructor(ctx, storage) {
    this.ctx = ctx || null;
    this.storage = storage !== undefined ? storage : (() => {
      try { return globalThis.localStorage; } catch (e) { return null; }
    })();
    this.nectar = 0;
    this.titanBlood = 0;
    this.gods = blankGods();
    this.weapons = blankWeapons();
    this.version = 2;
  }

  load() {
    let data = null;
    try { data = JSON.parse(this.storage?.getItem?.(META_SAVE_KEY) || 'null'); } catch (e) { data = null; }
    this.nectar = Math.max(0, Math.floor(Number(data?.nectar) || 0));
    this.titanBlood = Math.max(0, Math.floor(Number(data?.titanBlood) || 0));
    this.gods = blankGods();
    for (const god of GOD_KEYS) {
      this.gods[god].boon = cleanRank(data?.gods?.[god]?.boon);
      this.gods[god].passive = cleanRank(data?.gods?.[god]?.passive);
      this.gods[god].devotion = cleanRank(data?.gods?.[god]?.devotion);
    }
    this.weapons = blankWeapons();
    for (const weapon of Object.keys(META_WEAPONS)) {
      for (const track of WEAPON_TRACKS) this.weapons[weapon][track] = cleanRank(data?.weapons?.[weapon]?.[track]);
    }
    this.ctx?.events?.emit?.('meta.loaded', this.snapshot());
    return this;
  }

  save() {
    try { this.storage?.setItem?.(META_SAVE_KEY, JSON.stringify(this.snapshot())); } catch (e) { /* private mode / quota */ }
    return this;
  }

  snapshot() {
    const gods = {};
    for (const god of GOD_KEYS) gods[god] = { ...this.gods[god] };
    const weapons = {};
    for (const weapon of Object.keys(META_WEAPONS)) weapons[weapon] = { ...this.weapons[weapon] };
    return { version: this.version, nectar: this.nectar, titanBlood: this.titanBlood, gods, weapons };
  }

  rank(god, track = 'boon') { return cleanRank(this.gods[god]?.[track]); }
  cost(god, track = 'boon') {
    const rank = this.rank(god, track);
    if (rank >= META_MAX_RANK) return 0;
    return rank + (track === 'boon' ? 1 : 2);
  }
  boonMultiplier(god) { return 1 + this.rank(god, 'boon') * 0.10; }
  investment(god) { return GOD_TRACKS.reduce((sum, track) => sum + this.rank(god, track), 0); }
  appearanceBonus(god) { return this.investment(god) * GOD_FAVOR_PER_RANK; }
  appearanceWeight(god) { return 1 + this.appearanceBonus(god); }
  appearanceWeights() {
    return Object.fromEntries(GOD_KEYS.map(god => [god, this.appearanceWeight(god)]));
  }
  /** Devotion moves offers out of Common without changing deterministic rolls. */
  rarityWeights(god) {
    const rank = this.rank(god, 'devotion');
    return {
      common: Math.max(12, 62 - rank * 8),
      rare: 26 + rank * 4,
      epic: 9 + rank * 2.5,
      heroic: 3 + rank * 1.5,
    };
  }
  rareOrBetterChance(god) {
    const w = this.rarityWeights(god), total = w.common + w.rare + w.epic + w.heroic;
    return total > 0 ? (w.rare + w.epic + w.heroic) / total : 0;
  }

  weaponRank(weapon, track = 'attack') {
    return cleanRank(this.weapons[weapon]?.[track]);
  }
  weaponCost(weapon, track = 'attack') {
    const rank = this.weaponRank(weapon, track);
    return rank >= WEAPON_MAX_RANK ? 0 : rank + 1;
  }
  weaponMultiplier(weapon, track = 'attack') { return 1 + this.weaponRank(weapon, track) * 0.05; }

  awardNectar(amount = 1, o = {}) {
    const gained = Math.max(0, Math.floor(Number(amount) || 0));
    if (!gained) return 0;
    this.nectar += gained;
    this.save();
    const payload = { amount: gained, total: this.nectar, source: o.source || 'boss' };
    this.ctx?.events?.emit?.('nectar.awarded', payload);
    this.ctx?.events?.emit?.('nectar.changed', payload);
    return gained;
  }

  awardTitanBlood(amount = 1, o = {}) {
    const gained = Math.max(0, Math.floor(Number(amount) || 0));
    if (!gained) return 0;
    this.titanBlood += gained;
    this.save();
    const payload = { amount: gained, total: this.titanBlood, source: o.source || 'boss' };
    this.ctx?.events?.emit?.('titanBlood.awarded', payload);
    this.ctx?.events?.emit?.('titanBlood.changed', payload);
    return gained;
  }

  upgrade(god, track = 'boon') {
    if (!GOD_KEYS.includes(god) || !GOD_TRACKS.includes(track)) return { ok: false, reason: 'invalid' };
    const rank = this.rank(god, track);
    if (rank >= META_MAX_RANK) return { ok: false, reason: 'max', rank, cost: 0 };
    const cost = this.cost(god, track);
    if (this.nectar < cost) return { ok: false, reason: 'nectar', rank, cost, nectar: this.nectar };
    this.nectar -= cost;
    this.gods[god][track] = rank + 1;
    this.save();
    const result = { ok: true, god, track, rank: rank + 1, cost, nectar: this.nectar };
    this.ctx?.boons?.rebuild?.();
    this.ctx?.boons?._syncPlayer?.();
    this.ctx?.events?.emit?.('meta.upgraded', result);
    this.ctx?.events?.emit?.('nectar.changed', { amount: -cost, total: this.nectar, source: 'altar' });
    return result;
  }

  upgradeWeapon(weapon, track = 'attack') {
    if (!META_WEAPONS[weapon] || !WEAPON_TRACKS.includes(track)) return { ok: false, reason: 'invalid' };
    const rank = this.weaponRank(weapon, track);
    if (rank >= WEAPON_MAX_RANK) return { ok: false, reason: 'max', rank, cost: 0 };
    const cost = this.weaponCost(weapon, track);
    if (this.titanBlood < cost) return { ok: false, reason: 'titanBlood', rank, cost, titanBlood: this.titanBlood };
    this.titanBlood -= cost;
    this.weapons[weapon][track] = rank + 1;
    this.save();
    const result = { ok: true, weapon, track, rank: rank + 1, cost, titanBlood: this.titanBlood };
    this.ctx?.boons?.rebuild?.();
    this.ctx?.boons?._syncPlayer?.();
    this.ctx?.events?.emit?.('weapon.metaUpgraded', result);
    this.ctx?.events?.emit?.('titanBlood.changed', { amount: -cost, total: this.titanBlood, source: 'altar' });
    return result;
  }

  applyPassives(mods) {
    for (const god of GOD_KEYS) {
      const rank = this.rank(god, 'passive');
      if (rank) GOD_LEGACIES[god]?.apply?.(mods, rank);
    }
    const weapon = this.ctx?.combat?.weaponId;
    if (weapon && this.weapons[weapon]) {
      mods.attackMul *= this.weaponMultiplier(weapon, 'attack');
      mods.specialMul *= this.weaponMultiplier(weapon, 'special');
      mods.castMul *= this.weaponMultiplier(weapon, 'cast');
    }
    return mods;
  }
}

export default MetaProgression;
