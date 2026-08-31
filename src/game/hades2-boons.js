// Hades II action families for Melinoe. These sit beside the wider translated
// catalog, but carry an explicit hero tag so Zagreus never receives Magick Gain
// cards and the offer UI can identify their source game honestly.

import { GODS } from '../materials/palette.js';

const B = (id, god, slot, name, base, text, apply, extra = {}) => ({
  id, god, slot, name, base, text, apply, hero: 'melinoe', sourceGame: 'Hades II', ...extra,
});

function rider(m, slot, o) {
  const r = m.rider[slot] || (m.rider[slot] = { bonus: 0, type: null, status: null, stacks: 0, color: null, god: null, name: null, tier: 1 });
  if (o.bonus) r.bonus += o.bonus;
  if (o.type) r.type = o.type;
  if (o.status) { r.status = o.status; r.stacks += o.stacks || 1; }
  if (o.statusPower) r.statusPower = (r.statusPower || 0) + o.statusPower;
  if (o.knockback) r.knockback = (r.knockback || 0) + o.knockback;
  if (o.critChance) r.critChance = (r.critChance || 0) + o.critChance;
  r.color = GODS[o.god]; r.god = o.god; r.name = o.name;
}

// The curse vocabulary, duplicated as a plain literal because boons.js imports
// *this* file — reaching back for CURSES would close an import cycle. The
// canonical table in boons.js owns the semantics; this owns the wording.
const CURSE_NAME = {
  zeus: 'Blitz', hestia: 'Scorch', hephaestus: 'Scorch', dionysus: 'Scorch',
  demeter: 'Freeze', hecate: 'Freeze', selene: 'Freeze', poseidon: 'Slow',
  hera: 'Hitch', apollo: 'Blind', ares: 'Wither', hades: 'Wither',
  aphrodite: 'Weak', athena: 'Weak', artemis: 'Weak',
};
const CURSE_ID = Object.fromEntries(Object.entries(CURSE_NAME).map(([g, n]) => [g, n.toLowerCase()]));

const DEFINITIONS = {
  aphrodite: { names: ['Flutter Strike', 'Flutter Flourish', 'Rapture Ring', 'Passion Rush', 'Glamour Gain'], type: 'arcane', status: 'weak', dmg: [18, 28, 23, 15], stacks: 2 },
  apollo: { names: ['Nova Strike', 'Nova Flourish', 'Solar Ring', 'Blinding Rush', 'Lucid Gain'], type: 'arcane', status: 'weak', dmg: [14, 24, 21, 14], stacks: 2 },
  ares: { names: ['Vicious Strike', 'Vicious Flourish', 'Sword Ring', 'Stabbing Rush', 'Grisly Gain'], type: 'arcane', status: 'doom', dmg: [22, 34, 27, 20], stacks: 1, power: true },
  demeter: { names: ['Ice Strike', 'Ice Flourish', 'Arctic Ring', 'Frigid Sprint', 'Tranquil Gain'], type: 'frost', status: 'chill', dmg: [13, 22, 19, 13], stacks: 3 },
  hephaestus: { names: ['Volcanic Strike', 'Volcanic Flourish', 'Anvil Ring', 'Smithy Sprint', 'Fixed Gain'], type: 'fire', status: 'burn', dmg: [30, 44, 28, 22], stacks: 2 },
  hera: { names: ['Sworn Strike', 'Sworn Flourish', 'Engagement Ring', 'Nexus Sprint', 'Born Gain'], type: 'arcane', status: 'weak', dmg: [16, 26, 22, 15], stacks: 3 },
  hestia: { names: ['Flame Strike', 'Flame Flourish', 'Smolder Ring', 'Soot Sprint', 'Hearth Gain'], type: 'fire', status: 'burn', dmg: [8, 11, 14, 10], stacks: 4, power: true },
  poseidon: { names: ['Wave Strike', 'Wave Flourish', 'Geyser Ring', 'Breaker Sprint', 'Fluid Gain'], type: 'physical', status: null, dmg: [13, 22, 19, 15], stacks: 1, knock: 4.5 },
  zeus: { names: ['Heaven Strike', 'Heaven Flourish', 'Storm Ring', 'Thunder Sprint', 'Ionic Gain'], type: 'lightning', status: 'shock', dmg: [11, 19, 17, 13], stacks: 2 },
};

const slots = ['attack', 'special', 'cast', 'dash'];
const labels = { attack: 'Attack', special: 'Special', cast: 'Cast', dash: 'Sprint' };

export const HADES2_BOONS = [];
for (const [god, spec] of Object.entries(DEFINITIONS)) {
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i], name = spec.names[i];
    HADES2_BOONS.push(B(`h2.${god}.${slot}`, god, slot, name,
      { dmg: spec.dmg[i], stacks: spec.stacks, knock: spec.knock || 0 },
      v => `Melinoë's ${labels[slot]} deals ${v.dmg} ${spec.type} damage${spec.status ? ` and inflicts ${v.stacks} ${CURSE_NAME[god] || 'Weak'}` : ` and knocks foes away ${v.knock}m`}.`,
      (m, v) => {
        rider(m, slot, { bonus: spec.power ? 0 : v.dmg, type: spec.type, status: spec.status, stacks: v.stacks,
          statusPower: spec.power ? v.dmg : 0, knockback: v.knock, god, name });
        if (slot === 'cast') m.castRadius += 1.7;
        if (slot === 'dash') m.dashRadius += 1.5;
      }, { status: spec.status || undefined, curse: CURSE_ID[god] || undefined, h2Core: true }));
  }
  const gainName = spec.names[4];
  HADES2_BOONS.push(B(`h2.${god}.gain`, god, 'gain', gainName, { regen: 12, mana: 10 },
    v => `Restore Magick ${v.regen}% faster and gain ${v.mana} maximum Magick.`,
    (m, v) => { m.manaRegenMul *= 1 + v.regen / 100; m.maxManaAdd += v.mana; }, { h2Core: true }));
}

export default HADES2_BOONS;
