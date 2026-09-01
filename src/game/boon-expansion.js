// Second blessing families and additional duo payoffs. Kept separate from the
// core table so the offer engine stays readable while every god gains another
// Attack, Special, Cast, Dash, passive and Call.

import { GODS } from '../materials/palette.js';

const B = (id, god, slot, name, base, text, apply, extra) => ({ id, god, slot, name, base, text, apply, ...(extra || {}) });

function rider(m, slot, o) {
  const r = m.rider[slot] || (m.rider[slot] = { bonus: 0, type: null, status: null, stacks: 0, color: null, god: null, name: null, tier: 1 });
  if (o.bonus) r.bonus += o.bonus;
  if (o.type) r.type = o.type;
  if (o.status) { r.status = o.status; r.stacks += o.stacks || 1; }
  for (const key of ['knockback', 'critChance', 'critMark', 'expose', 'deflect', 'postDashBonus', 'statusPower']) {
    if (o[key] != null) r[key] = (r[key] || 0) + o[key];
  }
  r.color = o.color; r.god = o.god; r.name = o.name;
  return r;
}

const ACTIONS = ['attack', 'special', 'cast', 'dash', 'call'];
const ACTION_LABEL = { attack: 'Attack', special: 'Special', cast: 'Cast', dash: 'Dash', call: 'Call' };

// The curse each god's affliction is named after. Duplicated as a literal
// because boons.js imports this module; boons.js owns the CURSES semantics.
const GOD_CURSE = {
  zeus: 'blitz', hestia: 'scorch', hephaestus: 'scorch', dionysus: 'hangover',
  demeter: 'freeze', hecate: 'freeze', selene: 'freeze', poseidon: 'slow',
  hera: 'hitch', apollo: 'blind', ares: 'wither', hades: 'wither',
  aphrodite: 'weak', athena: 'weak', artemis: 'weak',
};

const FAMILIES = {
  zeus: {
    names: ['Chain Strike', 'Overload Flourish', 'Storm Shot', 'Static Passage', 'Zeus Aid'],
    damage: [9, 18, 16, 14, 48], status: 'shock', type: 'lightning', stacks: [2, 2, 2, 2, 3],
    text: (slot, v) => `Your ${ACTION_LABEL[slot]} deals ${v.dmg} lightning damage and inflicts ${v.stacks} Blitz.`,
    passive: B('zeus.passive.voltage', 'zeus', 'passive', 'High Voltage', { pct: 12 },
      v => `Shock is ${v.pct}% stronger and Calls deal more damage.`,
      (m, v) => { m.status.shock *= 1 + v.pct / 100; m.callMul *= 1 + v.pct / 200; }),
  },
  poseidon: {
    names: ['Surging Strike', 'Undertow Flourish', 'Whirlpool Shot', 'Cresting Dash', 'Poseidon Aid'],
    damage: [9, 18, 13, 15, 44], knock: [4, 6, 3, 4, 7], type: 'physical',
    text: (slot, v) => `Your ${ACTION_LABEL[slot]} deals ${v.dmg} damage and hurls foes ${v.knock}m.`,
    after: (slot, m, v) => { if (slot === 'cast') m.castRadius += 2.2; if (slot === 'dash') m.dashRadius += 2.8; },
    passive: B('poseidon.passive.ocean', 'poseidon', 'passive', 'Ocean Bounty', { heal: 8, knock: 1 },
      v => `Each chamber restores ${v.heal} Life and all knockback gains ${v.knock}m.`,
      (m, v) => { m.clearHeal += v.heal; m.knockback += v.knock; }),
  },
  athena: {
    names: ['Guarded Strike', 'Aegis Flourish', 'Judgment Shot', 'Bulwark Dash', 'Athena Aid'],
    damage: [11, 16, 12, 8, 34], status: 'weak', type: 'arcane', stacks: [2, 2, 3, 2, 4],
    deflect: [0, 1.4, 0, 0.85, 0],
    text: (slot, v) => `Your ${ACTION_LABEL[slot]} deals ${v.dmg} damage and applies ${v.stacks} Weak${v.deflect ? ` with ${v.deflect}s Deflect` : ''}.`,
    passive: B('athena.passive.resolve', 'athena', 'passive', 'Unbroken Resolve', { dr: 6, iframe: 0.08 },
      v => `Take ${v.dr}% less damage and extend Dash invulnerability by ${v.iframe}s.`,
      (m, v) => { m.damageTaken *= 1 - v.dr / 100; m.iframeAdd += v.iframe; }),
  },
  aphrodite: {
    names: ['Sweet Surrender', 'Charming Flourish', 'Heart Shot', 'Rose Dash', 'Aphrodite Aid'],
    damage: [17, 26, 24, 13, 40], status: 'weak', type: 'arcane', stacks: [2, 3, 2, 3, 4],
    text: (slot, v) => `Your ${ACTION_LABEL[slot]} deals ${v.dmg} damage and inflicts ${v.stacks} Weak.`,
    passive: B('aphrodite.passive.grace', 'aphrodite', 'passive', 'Lasting Grace', { hp: 18, dr: 4 },
      v => `Gain ${v.hp} maximum Life and take ${v.dr}% less damage.`,
      (m, v) => { m.maxHealthAdd += v.hp; m.damageTaken *= 1 - v.dr / 100; }),
  },
  ares: {
    names: ['Blood Oath', 'War Flourish', 'Vortex Shot', 'Warpath Dash', 'Ares Aid'],
    damage: [24, 36, 28, 22, 50], status: 'doom', type: 'arcane', stacks: [1, 1, 1, 1, 1], doom: true,
    text: (slot, v) => `Your ${ACTION_LABEL[slot]} inflicts Wither for ${v.dmg} delayed damage.`,
    after: (slot, m) => { if (slot === 'cast') m.castTicks += 6; },
    passive: B('ares.passive.violence', 'ares', 'passive', 'Urge to Kill', { dmg: 8, crit: 3 },
      v => `Deal ${v.dmg}% more damage and gain ${v.crit}% Critical chance.`,
      (m, v) => { m.dmgMul *= 1 + v.dmg / 100; m.critChance += v.crit / 100; }),
  },
  artemis: {
    names: ['Ambush Strike', 'Hunter Flourish', 'Seeking Volley', 'Tracker Dash', 'Artemis Aid'],
    damage: [7, 13, 20, 11, 46], crit: [18, 22, 14, 16, 20], type: 'physical',
    text: (slot, v) => `Your ${ACTION_LABEL[slot]} deals ${v.dmg} damage with +${v.crit}% Critical chance.`,
    after: (slot, m) => { if (slot === 'cast') m.castSeek = Math.max(m.castSeek, 1); },
    passive: B('artemis.passive.clean', 'artemis', 'passive', 'Clean Kill', { crit: 5, mul: 0.35 },
      v => `Gain +${v.crit}% Critical chance and +${v.mul}x Critical damage.`,
      (m, v) => { m.critChance += v.crit / 100; m.critMul += v.mul; }),
  },
  dionysus: {
    names: ['Vintage Strike', 'Festival Flourish', 'Revelry Shot', 'Spill Dash', 'Dionysus Aid'],
    damage: [6, 7, 11, 10, 34], status: 'burn', type: 'poison', stacks: [3, 4, 3, 3, 5], statusPower: true,
    text: (slot, v) => `Your ${ACTION_LABEL[slot]} inflicts ${v.stacks} Hangover for ${v.dmg} damage per stack.`,
    after: (slot, m) => { if (slot === 'cast') m.castRadius += 3; },
    passive: B('dionysus.passive.afterparty', 'dionysus', 'passive', 'After Party', { heal: 7, pct: 10 },
      v => `Each clear restores ${v.heal} Life; Hangover is ${v.pct}% stronger.`,
      (m, v) => { m.clearHeal += v.heal; m.status.burn *= 1 + v.pct / 100; }),
  },
  hermes: {
    names: ['Rapid Strike', 'Express Flourish', 'Quickened Cast', 'Second Wind', 'Hermes Aid'],
    damage: [6, 12, 9, 7, 28], type: 'physical', speed: [10, 8, 18, 9, 25],
    text: (slot, v) => `Your ${ACTION_LABEL[slot]} deals ${v.dmg} bonus damage and gains ${v.speed}% swiftness.`,
    after: (slot, m, v) => {
      if (slot === 'attack') m.attackSpeed *= 1 + v.speed / 100;
      else if (slot === 'cast') m.castSpeed *= 1 + v.speed / 100;
      else if (slot === 'call') m.callCharge *= 1 + v.speed / 100;
      else m.moveMul *= 1 + v.speed / 100;
    },
    passive: B('hermes.passive.greatest', 'hermes', 'passive', 'Quickened Reflex', { spd: 9, dodge: 4 },
      v => `Move ${v.spd}% faster and gain ${v.dodge}% dodge.`,
      (m, v) => { m.moveMul *= 1 + v.spd / 100; m.dodge += v.dodge / 100; }),
  },
  hecate: {
    names: ['Hexed Strike', 'Twin-Torch Flourish', 'Witch Circle', 'Shadow Step', 'Hecate Aid'],
    damage: [11, 21, 25, 10, 42], status: 'chill', type: 'arcane', stacks: [3, 3, 2, 3, 4],
    text: (slot, v) => `Your ${ACTION_LABEL[slot]} deals ${v.dmg} arcane damage and inflicts ${v.stacks} Freeze.`,
    after: (slot, m) => { if (slot === 'cast') m.castRadius += 2; },
    passive: B('hecate.passive.cauldron', 'hecate', 'passive', 'Cauldron Soul', { mana: 30, regen: 22 },
      v => `Gain ${v.mana} maximum Magick and ${v.regen}% faster regeneration.`,
      (m, v) => { m.maxManaAdd += v.mana; m.manaRegenMul *= 1 + v.regen / 100; }),
  },
  selene: {
    names: ['Moonlit Strike', 'Eclipse Flourish', 'Orbital Shot', 'Crescent Dash', 'Eclipse Call'],
    damage: [15, 20, 22, 13, 36], status: 'chill', type: 'arcane', stacks: [2, 3, 2, 2, 4],
    text: (slot, v) => `Your ${ACTION_LABEL[slot]} deals ${v.dmg} moon damage and inflicts ${v.stacks} Freeze.`,
    after: (slot, m) => { if (slot === 'cast') m.castRadius += 1.8; if (slot === 'dash') m.iframeAdd += 0.14; },
    passive: B('selene.passive.fullmoon', 'selene', 'passive', 'Full Moon', { cast: 12, mana: 18 },
      v => `Cast damage gains ${v.cast}% and maximum Magick gains ${v.mana}.`,
      (m, v) => { m.castMul *= 1 + v.cast / 100; m.maxManaAdd += v.mana; }),
  },
};

export const EXPANDED_BOONS = [];
for (const [god, family] of Object.entries(FAMILIES)) {
  ACTIONS.forEach((slot, i) => {
    const id = `${god}.${slot}.${slot === 'call' ? 'aid' : 'alternate'}`;
    const base = { dmg: family.damage[i] };
    if (family.stacks) base.stacks = family.stacks[i];
    if (family.knock) base.knock = family.knock[i];
    if (family.crit) base.crit = family.crit[i];
    if (family.deflect) base.deflect = family.deflect[i];
    if (family.speed) base.speed = family.speed[i];
    EXPANDED_BOONS.push(B(id, god, slot, family.names[i], base,
      v => family.text(slot, v),
      (m, v) => {
        const statusPower = family.doom || family.statusPower ? v.dmg : 0;
        rider(m, slot, {
          bonus: family.doom || family.statusPower ? 0 : v.dmg,
          type: family.type, status: family.status, stacks: v.stacks,
          knockback: v.knock, critChance: v.crit ? v.crit / 100 : 0,
          deflect: v.deflect, statusPower,
          color: GODS[god], god, name: family.names[i],
        });
        family.after?.(slot, m, v);
      }, family.status ? { status: family.status, curse: family.curse || GOD_CURSE[god] } : undefined));
  });
  EXPANDED_BOONS.push(family.passive);
}

export const EXPANDED_DUOS = [
  { id: 'duo.zeus.athena', gods: ['zeus', 'athena'], name: 'Static Guard', slot: 'passive', base: { dr: 8, pct: 12 },
    text: v => `Take ${v.dr}% less damage; Shock gains ${v.pct}% power.`, apply: (m, v) => { m.damageTaken *= 1 - v.dr / 100; m.status.shock *= 1 + v.pct / 100; } },
  { id: 'duo.zeus.aphrodite', gods: ['zeus', 'aphrodite'], name: 'Smoldering Air', slot: 'passive', base: { pct: 10 },
    text: v => `Shock and Weak are ${v.pct}% stronger together.`, apply: (m, v) => { m.status.shock *= 1 + v.pct / 100; m.status.weak *= 1 + v.pct / 100; } },
  { id: 'duo.zeus.ares', gods: ['zeus', 'ares'], name: 'War Storm', slot: 'passive', base: { dmg: 9, pct: 12 },
    text: v => `Deal ${v.dmg}% more damage; Doom gains ${v.pct}% power.`, apply: (m, v) => { m.dmgMul *= 1 + v.dmg / 100; m.status.doom *= 1 + v.pct / 100; } },
  { id: 'duo.poseidon.athena', gods: ['poseidon', 'athena'], name: 'Unshakable Tide', slot: 'passive', base: { dr: 7, knock: 2 },
    text: v => `Take ${v.dr}% less damage and gain ${v.knock}m knockback.`, apply: (m, v) => { m.damageTaken *= 1 - v.dr / 100; m.knockback += v.knock; } },
  { id: 'duo.poseidon.aphrodite', gods: ['poseidon', 'aphrodite'], name: 'Sweet Surrender', slot: 'passive', base: { hp: 22, heal: 6 },
    text: v => `Gain ${v.hp} maximum Life; clears restore ${v.heal}.`, apply: (m, v) => { m.maxHealthAdd += v.hp; m.clearHeal += v.heal; } },
  { id: 'duo.poseidon.artemis', gods: ['poseidon', 'artemis'], name: 'Distant Shoals', slot: 'passive', base: { crit: 7, knock: 1.5 },
    text: v => `Gain ${v.crit}% Critical chance and ${v.knock}m knockback.`, apply: (m, v) => { m.critChance += v.crit / 100; m.knockback += v.knock; } },
  { id: 'duo.athena.aphrodite', gods: ['athena', 'aphrodite'], name: 'Tender Defence', slot: 'passive', base: { hp: 18, dr: 6 },
    text: v => `Gain ${v.hp} maximum Life and take ${v.dr}% less damage.`, apply: (m, v) => { m.maxHealthAdd += v.hp; m.damageTaken *= 1 - v.dr / 100; } },
  { id: 'duo.athena.ares', gods: ['athena', 'ares'], name: 'Calculated Risk', slot: 'passive', base: { dmg: 8, iframe: 0.12 },
    text: v => `Deal ${v.dmg}% more damage and extend Dash invulnerability ${v.iframe}s.`, apply: (m, v) => { m.dmgMul *= 1 + v.dmg / 100; m.iframeAdd += v.iframe; } },
  { id: 'duo.aphrodite.artemis', gods: ['aphrodite', 'artemis'], name: 'Heart Rend', slot: 'passive', base: { crit: 0.45, pct: 12 },
    text: v => `Critical damage gains ${v.crit}x; Weak gains ${v.pct}% power.`, apply: (m, v) => { m.critMul += v.crit; m.status.weak *= 1 + v.pct / 100; } },
  { id: 'duo.dionysus.zeus', gods: ['dionysus', 'zeus'], name: 'Scintillating Feast', slot: 'passive', base: { pct: 14 },
    text: v => `Hangover and Shock each gain ${v.pct}% power.`, apply: (m, v) => { m.status.burn *= 1 + v.pct / 100; m.status.shock *= 1 + v.pct / 100; } },
  { id: 'duo.dionysus.poseidon', gods: ['dionysus', 'poseidon'], name: 'Exclusive Access', slot: 'passive', base: { dmg: 8, heal: 5 },
    text: v => `Deal ${v.dmg}% more damage; clears restore ${v.heal} Life.`, apply: (m, v) => { m.dmgMul *= 1 + v.dmg / 100; m.clearHeal += v.heal; } },
  { id: 'duo.dionysus.hermes', gods: ['dionysus', 'hermes'], name: 'Drunken Dash', slot: 'passive', base: { spd: 12, dodge: 6 },
    text: v => `Move ${v.spd}% faster and gain ${v.dodge}% dodge.`, apply: (m, v) => { m.moveMul *= 1 + v.spd / 100; m.dodge += v.dodge / 100; } },
  { id: 'duo.hermes.artemis', gods: ['hermes', 'artemis'], name: 'Lightning Reflexes', slot: 'passive', base: { spd: 12, crit: 6 },
    text: v => `Attack ${v.spd}% faster and gain ${v.crit}% Critical chance.`, apply: (m, v) => { m.attackSpeed *= 1 + v.spd / 100; m.critChance += v.crit / 100; } },
  { id: 'duo.hecate.ares', gods: ['hecate', 'ares'], name: 'Witch’s Curse', slot: 'passive', base: { pct: 15 },
    text: v => `Doom and Chill gain ${v.pct}% power and duration.`, apply: (m, v) => { m.status.doom *= 1 + v.pct / 100; m.status.chill *= 1 + v.pct / 100; m.statusDuration.chill *= 1 + v.pct / 100; } },
  { id: 'duo.selene.artemis', gods: ['selene', 'artemis'], name: 'Moon Hunt', slot: 'passive', base: { cast: 12, crit: 6 },
    text: v => `Cast damage gains ${v.cast}% and all damage gains ${v.crit}% Critical chance.`, apply: (m, v) => { m.castMul *= 1 + v.cast / 100; m.critChance += v.crit / 100; } },
];

