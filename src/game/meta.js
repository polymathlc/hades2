// Persistent progression shared by the Crossroads home base and every run.
// The save is intentionally small and versioned so a malformed/older browser
// value can never prevent the game from booting.

import { GOD_KEYS } from './boons.js';

export const META_SAVE_KEY = 'erebus.meta.v1';
export const META_MAX_RANK = 5;

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
};

const cleanRank = value => Math.max(0, Math.min(META_MAX_RANK, Math.floor(Number(value) || 0)));

function blankGods() {
  const gods = {};
  for (const god of GOD_KEYS) gods[god] = { boon: 0, passive: 0 };
  return gods;
}

export class MetaProgression {
  constructor(ctx, storage) {
    this.ctx = ctx || null;
    this.storage = storage !== undefined ? storage : (() => {
      try { return globalThis.localStorage; } catch (e) { return null; }
    })();
    this.nectar = 0;
    this.gods = blankGods();
    this.version = 1;
  }

  load() {
    let data = null;
    try { data = JSON.parse(this.storage?.getItem?.(META_SAVE_KEY) || 'null'); } catch (e) { data = null; }
    this.nectar = Math.max(0, Math.floor(Number(data?.nectar) || 0));
    this.gods = blankGods();
    for (const god of GOD_KEYS) {
      this.gods[god].boon = cleanRank(data?.gods?.[god]?.boon);
      this.gods[god].passive = cleanRank(data?.gods?.[god]?.passive);
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
    return { version: this.version, nectar: this.nectar, gods };
  }

  rank(god, track = 'boon') { return cleanRank(this.gods[god]?.[track]); }
  cost(god, track = 'boon') {
    const rank = this.rank(god, track);
    if (rank >= META_MAX_RANK) return 0;
    return rank + (track === 'passive' ? 2 : 1);
  }
  boonMultiplier(god) { return 1 + this.rank(god, 'boon') * 0.10; }

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

  upgrade(god, track = 'boon') {
    if (!GOD_KEYS.includes(god) || !['boon', 'passive'].includes(track)) return { ok: false, reason: 'invalid' };
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

  applyPassives(mods) {
    for (const god of GOD_KEYS) {
      const rank = this.rank(god, 'passive');
      if (rank) GOD_LEGACIES[god]?.apply?.(mods, rank);
    }
    return mods;
  }
}

export default MetaProgression;
