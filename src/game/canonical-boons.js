// Playable translations of the wider Hades / Hades II boon catalog.
//
// The source games contain systems this compact browser roguelite does not
// (Omega moves, elemental infusions, fishing, Death Defiance, boss-specific
// clauses). Those cards are expressed through the closest live EREBUS hook so
// every entry in the offer pool changes combat instead of being flavor-only.

import { GODS } from '../materials/palette.js';

const B = (id, god, slot, name, base, text, apply, extra) => ({ id, god, slot, name, base, text, apply, ...(extra || {}) });
const P = (god, id, name, base, text, apply, extra) => B(`${god}.canon.${id}`, god, 'passive', name, base, text, apply, extra);

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

const CORE_LABEL = { attack: 'Attack', special: 'Special', cast: 'Cast', dash: 'Dash', call: 'Call' };

function coreFamily(god, spec) {
  const slots = ['attack', 'special', 'cast', 'dash', 'call'];
  return slots.map((slot, i) => {
    const base = { dmg: spec.damage[i], stacks: spec.stacks?.[i] || 1 };
    if (spec.knock?.[i]) base.knock = spec.knock[i];
    if (spec.radius?.[i]) base.radius = spec.radius[i];
    return B(`${god}.canon.${slot}`, god, slot, spec.names[i], base,
      v => spec.text(slot, v),
      (m, v) => {
        rider(m, slot, {
          bonus: spec.statusPower ? 0 : v.dmg,
          type: spec.type, status: spec.status, stacks: v.stacks,
          statusPower: spec.statusPower ? v.dmg : 0,
          knockback: v.knock || 0, color: GODS[god], god, name: spec.names[i],
        });
        if (slot === 'cast') m.castRadius += v.radius || spec.castRadius || 0;
        if (slot === 'dash') m.dashRadius += v.radius || spec.dashRadius || 0;
        spec.after?.(slot, m, v);
      }, spec.status ? { status: spec.status, sourceGame: spec.sourceGame || 'Hades II' } : { sourceGame: spec.sourceGame || 'Hades II' });
  });
}

const NEW_CORE = [
  ...coreFamily('demeter', {
    names: ['Frost Strike', 'Frost Flourish', 'Arctic Ring', 'Frigid Rush', 'Demeter’s Aid'],
    damage: [14, 24, 18, 13, 44], stacks: [2, 3, 3, 2, 5], radius: [0, 0, 2.2, 2.0, 0],
    status: 'chill', type: 'frost',
    text: (slot, v) => `Your ${CORE_LABEL[slot]} deals ${v.dmg} frost damage and inflicts ${v.stacks} Freeze/Chill.`,
  }),
  ...coreFamily('apollo', {
    names: ['Nova Strike', 'Nova Flourish', 'Solar Ring', 'Blinding Rush', 'Apollo’s Aid'],
    damage: [16, 25, 22, 14, 42], stacks: [1, 2, 2, 2, 3], radius: [0, 0, 2.4, 2.1, 0],
    status: 'weak', type: 'arcane',
    text: (slot, v) => `Your ${CORE_LABEL[slot]} radiates for ${v.dmg} damage and inflicts ${v.stacks} Daze.`,
    after: (slot, m) => { if (slot === 'attack' || slot === 'special') m.dmgMul *= 1.03; },
  }),
  ...coreFamily('hera', {
    names: ['Sworn Strike', 'Sworn Flourish', 'Engagement Ring', 'Nexus Rush', 'Hera’s Aid'],
    damage: [18, 28, 20, 15, 46], stacks: [2, 3, 3, 2, 4], radius: [0, 0, 2.0, 2.0, 0],
    status: 'weak', type: 'arcane',
    text: (slot, v) => `Your ${CORE_LABEL[slot]} deals ${v.dmg} royal damage and binds foes with ${v.stacks} Hitch.`,
  }),
  ...coreFamily('hestia', {
    names: ['Flame Strike', 'Flame Flourish', 'Smolder Ring', 'Soot Sprint', 'Hestia’s Aid'],
    damage: [7, 9, 12, 10, 30], stacks: [3, 4, 4, 3, 6], radius: [0, 0, 2.5, 2.0, 0],
    status: 'burn', type: 'fire', statusPower: true,
    text: (slot, v) => `Your ${CORE_LABEL[slot]} inflicts ${v.stacks} Scorch for ${v.dmg} damage per stack.`,
  }),
  ...coreFamily('hephaestus', {
    names: ['Volcanic Strike', 'Heaven Flourish', 'Anvil Ring', 'Smithy Rush', 'Hephaestus’ Aid'],
    damage: [32, 48, 28, 24, 55], radius: [0, 0, 2.6, 2.3, 0],
    type: 'fire',
    text: (slot, v) => `Your ${CORE_LABEL[slot]} triggers a forged Blast for ${v.dmg} damage.`,
    after: (slot, m) => { if (slot === 'cast') m.castTicks += 2; },
  }),
];

const SUPPORT = [
  // Zeus — chain lightning, Jolted, retaliatory thunder.
  P('zeus', 'storm-lightning', 'Storm Lightning', { forks: 2 }, v => `Chain lightning forks to ${v.forks} additional foes.`, (m, v) => { m.castForks += v.forks; }),
  P('zeus', 'double-strike', 'Double Strike', { pct: 12 }, v => `Lightning deals ${v.pct}% more damage and may strike twice.`, (m, v) => { m.status.shock *= 1 + v.pct / 100; m.lightningCrit += v.pct / 200; }),
  P('zeus', 'static-discharge', 'Static Discharge', { pct: 18 }, v => `Shock and Jolted effects gain ${v.pct}% power.`, (m, v) => { m.status.shock *= 1 + v.pct / 100; }),
  P('zeus', 'clouded-judgment', 'Clouded Judgment', { pct: 16 }, v => `Your Call charges ${v.pct}% faster.`, (m, v) => { m.callCharge *= 1 + v.pct / 100; }),
  P('zeus', 'billowing-strength', 'Billowing Strength', { pct: 10 }, v => `Calls and all damage gain ${v.pct}% power.`, (m, v) => { m.callMul *= 1 + v.pct / 100; m.dmgMul *= 1 + v.pct / 200; }),
  P('zeus', 'splitting-bolt', 'Splitting Bolt', { dmg: 32 }, v => `Lightning Critical hits release an extra ${v.dmg}-damage burst.`, (m, v) => { m.lightningCrit += 0.08; m.retaliateDmg += v.dmg; }),
  P('zeus', 'heavens-vengeance', 'Heaven’s Vengeance', { chance: 12, dmg: 34 }, v => `${v.chance}% chance to retaliate for ${v.dmg} lightning damage.`, (m, v) => { m.retaliate += v.chance / 100; m.retaliateDmg += v.dmg; }),

  // Poseidon — slam, Rupture, rewards translated to recovery/wealth value.
  P('poseidon', 'typhoons-fury', 'Typhoon’s Fury', { dmg: 24 }, v => `Wall slams deal ${v.dmg} additional damage.`, (m, v) => { m.wallSlamDmg += v.dmg; }),
  P('poseidon', 'hydraulic-might', 'Hydraulic Might', { pct: 10 }, v => `Attack and Special deal ${v.pct}% more damage.`, (m, v) => { m.attackMul *= 1 + v.pct / 100; m.specialMul *= 1 + v.pct / 100; }),
  P('poseidon', 'oceans-bounty', 'Ocean’s Bounty', { heal: 7 }, v => `Room rewards restore ${v.heal} Life after every clear.`, (m, v) => { m.clearHeal += v.heal; }),
  P('poseidon', 'razor-shoals', 'Razor Shoals', { pct: 10 }, v => `Knockback effects deal ${v.pct}% more damage.`, (m, v) => { m.dmgMul *= 1 + v.pct / 100; m.knockback += 1; }),
  P('poseidon', 'breaking-wave', 'Breaking Wave', { dmg: 30 }, v => `Wall slams release a ${v.dmg}-damage wave.`, (m, v) => { m.wallSlamDmg += v.dmg; m.seaStormDmg += v.dmg * 0.35; }),
  P('poseidon', 'wave-pounding', 'Wave Pounding', { pct: 12 }, v => `Knock-away effects gain ${v.pct}% power against heavy foes.`, (m, v) => { m.dmgMul *= 1 + v.pct / 100; }),
  P('poseidon', 'second-wave', 'Second Wave', { knock: 2 }, v => `Every knock-away effect pushes ${v.knock}m farther.`, (m, v) => { m.knockback += v.knock; }),
  P('poseidon', 'huge-catch', 'Huge Catch', { heal: 10 }, v => `Treasures are richer; chamber clears restore ${v.heal} Life.`, (m, v) => { m.clearHeal += v.heal; }),

  // Athena — Deflect, Exposed, defensive recovery.
  P('athena', 'holy-shield', 'Holy Shield', { chance: 10, dmg: 24 }, v => `Taking damage has ${v.chance}% chance to deflect ${v.dmg} damage.`, (m, v) => { m.retaliate += v.chance / 100; m.retaliateDmg += v.dmg; }),
  P('athena', 'sure-footing', 'Sure Footing', { dr: 8 }, v => `Take ${v.dr}% less damage from hazards and attacks.`, (m, v) => { m.damageTaken *= 1 - v.dr / 100; }),
  P('athena', 'proud-bearing', 'Proud Bearing', { pct: 15 }, v => `Calls charge ${v.pct}% faster and refund more Magick.`, (m, v) => { m.callCharge *= 1 + v.pct / 100; m.callRefund += 8; }),
  P('athena', 'blinding-flash', 'Blinding Flash', { pct: 12 }, v => `Deflecting effects Expose foes for ${v.pct}% bonus damage.`, (m, v) => { m.expose += v.pct / 100; m.dmgMul *= 1 + v.pct / 200; }),
  P('athena', 'brilliant-riposte', 'Brilliant Riposte', { pct: 18 }, v => `Deflect retaliation gains ${v.pct}% damage.`, (m, v) => { m.retaliateDmg += v.pct; }),
  P('athena', 'deathless-stand', 'Deathless Stand', { hp: 18, iframe: .08 }, v => `Gain ${v.hp} maximum Life and ${v.iframe}s Dash invulnerability.`, (m, v) => { m.maxHealthAdd += v.hp; m.iframeAdd += v.iframe; }),
  P('athena', 'divine-protection', 'Divine Protection', { dodge: 8, dr: 6 }, v => `A divine barrier grants ${v.dodge}% dodge and ${v.dr}% damage resistance.`, (m, v) => { m.dodge += v.dodge / 100; m.damageTaken *= 1 - v.dr / 100; }, { legendary: true }),

  // Aphrodite — Weak, close-range power, durability.
  P('aphrodite', 'dying-lament', 'Dying Lament', { pct: 9 }, v => `Weakened foes take ${v.pct}% more damage.`, (m, v) => { m.status.weak *= 1 + v.pct / 100; m.dmgMul *= 1 + v.pct / 200; }),
  P('aphrodite', 'wave-of-despair', 'Wave of Despair', { chance: 14, dmg: 26 }, v => `Taking damage has ${v.chance}% chance to retaliate for ${v.dmg}.`, (m, v) => { m.retaliate += v.chance / 100; m.retaliateDmg += v.dmg; }),
  P('aphrodite', 'different-league', 'Different League', { dr: 8 }, v => `Take ${v.dr}% less damage.`, (m, v) => { m.damageTaken *= 1 - v.dr / 100; }),
  P('aphrodite', 'empty-inside', 'Empty Inside', { pct: 28 }, v => `Weak lasts ${v.pct}% longer.`, (m, v) => { m.statusDuration.weak *= 1 + v.pct / 100; }),
  P('aphrodite', 'sweet-surrender', 'Sweet Surrender', { pct: 10 }, v => `All damage gains ${v.pct}% against Weak foes.`, (m, v) => { m.status.weak *= 1 + v.pct / 100; m.dmgMul *= 1 + v.pct / 200; }),
  P('aphrodite', 'broken-resolve', 'Broken Resolve', { pct: 18 }, v => `Weak reduces enemy damage by an additional ${v.pct}%.`, (m, v) => { m.status.weak *= 1 + v.pct / 100; }),
  P('aphrodite', 'unhealthy-fixation', 'Unhealthy Fixation', { dodge: 8, pct: 12 }, v => `Weak may Charm foes; gain ${v.dodge}% dodge and ${v.pct}% Weak power.`, (m, v) => { m.dodge += v.dodge / 100; m.status.weak *= 1 + v.pct / 100; }, { legendary: true }),

  // Ares — Doom, rifts, escalating violence.
  P('ares', 'dire-misfortune', 'Dire Misfortune', { dmg: 20 }, v => `Doom gains ${v.dmg} delayed damage.`, (m, v) => { m.doomDmg += v.dmg; }),
  P('ares', 'impending-doom', 'Impending Doom', { dmg: 34 }, v => `Doom detonations deal ${v.dmg} additional damage.`, (m, v) => { m.doomDmg += v.dmg; m.statusDuration.doom *= 1.12; }),
  P('ares', 'urge-to-kill', 'Urge to Kill', { pct: 10 }, v => `Attack, Special, and Cast deal ${v.pct}% more damage.`, (m, v) => { const x = 1 + v.pct / 100; m.attackMul *= x; m.specialMul *= x; m.castMul *= x; }),
  P('ares', 'black-metal', 'Black Metal', { radius: 2 }, v => `Blade Rift and Cast areas grow by ${v.radius}m.`, (m, v) => { m.castRadius += v.radius; }),
  P('ares', 'engulfing-vortex', 'Engulfing Vortex', { ticks: 3 }, v => `Blade Rifts strike ${v.ticks} additional times.`, (m, v) => { m.castTicks += v.ticks; }),
  P('ares', 'blood-frenzy', 'Blood Frenzy', { pct: 12, crit: 4 }, v => `Deal ${v.pct}% more damage with +${v.crit}% Critical chance.`, (m, v) => { m.dmgMul *= 1 + v.pct / 100; m.critChance += v.crit / 100; }),
  P('ares', 'vicious-cycle', 'Vicious Cycle', { dmg: 28, ticks: 2 }, v => `Rifts gain ${v.ticks} cuts and ${v.dmg} finishing damage.`, (m, v) => { m.castTicks += v.ticks; m.critRiftDmg += v.dmg; }, { legendary: true }),

  // Artemis — Criticals, Marked, seeking arrows.
  P('artemis', 'exit-wounds', 'Exit Wounds', { pct: 12 }, v => `Cast and seeking effects deal ${v.pct}% more damage.`, (m, v) => { m.castMul *= 1 + v.pct / 100; }),
  P('artemis', 'support-fire', 'Support Fire', { crit: 5, seek: 1 }, v => `Attacks gain ${v.crit}% Critical chance; Casts seek foes.`, (m, v) => { m.critChance += v.crit / 100; m.castSeek = Math.max(m.castSeek, v.seek); }),
  P('artemis', 'hunters-mark', 'Hunter’s Mark', { crit: 8 }, v => `Marked targets grant ${v.crit}% additional Critical chance.`, (m, v) => { m.critChance += v.crit / 100; }),
  P('artemis', 'clean-kill', 'Clean Kill', { mul: .35 }, v => `Critical damage gains ${v.mul}x.`, (m, v) => { m.critMul += v.mul; }),
  P('artemis', 'hide-breaker', 'Hide Breaker', { pct: 12 }, v => `Critical and Special damage gain ${v.pct}%.`, (m, v) => { m.specialMul *= 1 + v.pct / 100; m.critMul += v.pct / 100; }),
  P('artemis', 'hunters-instinct', 'Hunter’s Instinct', { crit: 4, charge: 10 }, v => `Gain ${v.crit}% Critical chance and ${v.charge}% Call charge.`, (m, v) => { m.critChance += v.crit / 100; m.callCharge *= 1 + v.charge / 100; }),
  P('artemis', 'fully-loaded', 'Fully Loaded', { forks: 2, crit: 5 }, v => `Casts fork ${v.forks} times and gain ${v.crit}% Critical chance.`, (m, v) => { m.castForks += v.forks; m.critChance += v.crit / 100; }, { legendary: true }),

  // Dionysus — Hangover, fog, sustain.
  P('dionysus', 'strong-drink', 'Strong Drink', { heal: 9, pct: 8 }, v => `Clears restore ${v.heal} Life and all damage gains ${v.pct}%.`, (m, v) => { m.clearHeal += v.heal; m.dmgMul *= 1 + v.pct / 100; }),
  P('dionysus', 'after-party', 'After Party', { heal: 12 }, v => `After every chamber restore ${v.heal} Life.`, (m, v) => { m.clearHeal += v.heal; }),
  P('dionysus', 'positive-outlook', 'Positive Outlook', { dr: 8 }, v => `Take ${v.dr}% less damage while reveling.`, (m, v) => { m.damageTaken *= 1 - v.dr / 100; }),
  P('dionysus', 'numbing-sensation', 'Numbing Sensation', { pct: 18 }, v => `Hangover gains ${v.pct}% power and slows foes.`, (m, v) => { m.status.burn *= 1 + v.pct / 100; }),
  P('dionysus', 'bad-influence', 'Bad Influence', { pct: 12 }, v => `Deal ${v.pct}% more damage while Hangover is active.`, (m, v) => { m.hangoverAmp += v.pct / 100; }),
  P('dionysus', 'peer-pressure', 'Peer Pressure', { pct: 16 }, v => `Hangover spreads with ${v.pct}% increased potency.`, (m, v) => { m.status.burn *= 1 + v.pct / 100; m.statusDuration.burn *= 1.18; }),
  P('dionysus', 'black-out', 'Black Out', { pct: 24 }, v => `Festive fog and Hangover gain ${v.pct}% power.`, (m, v) => { m.status.burn *= 1 + v.pct / 100; m.castMul *= 1 + v.pct / 100; }, { legendary: true }),

  // Hermes — speed, recovery, wealth translated to run tempo.
  P('hermes', 'swift-flourish', 'Swift Flourish', { pct: 14 }, v => `Specials are ${v.pct}% faster and stronger.`, (m, v) => { m.specialMul *= 1 + v.pct / 100; m.attackSpeed *= 1 + v.pct / 200; }),
  P('hermes', 'greater-haste', 'Greater Haste', { pct: 12 }, v => `Move ${v.pct}% faster.`, (m, v) => { m.moveMul *= 1 + v.pct / 100; }),
  P('hermes', 'rush-delivery', 'Rush Delivery', { pct: 10 }, v => `Speed becomes damage: deal ${v.pct}% more.`, (m, v) => { m.dmgMul *= 1 + v.pct / 100; m.moveMul *= 1.05; }),
  P('hermes', 'quick-recovery', 'Quick Recovery', { heal: 6 }, v => `Recover ${v.heal} Life after every chamber.`, (m, v) => { m.clearHeal += v.heal; }),
  P('hermes', 'second-wind', 'Second Wind', { dodge: 8, pct: 10 }, v => `Gain ${v.dodge}% dodge and ${v.pct}% speed.`, (m, v) => { m.dodge += v.dodge / 100; m.moveMul *= 1 + v.pct / 100; }),
  P('hermes', 'side-hustle', 'Side Hustle', { heal: 5, mana: 12 }, v => `Every clear restores ${v.heal} Life and grants ${v.mana} Magick capacity.`, (m, v) => { m.clearHeal += v.heal; m.maxManaAdd += v.mana; }),
  P('hermes', 'bad-news', 'Bad News', { pct: 18 }, v => `Casts deal ${v.pct}% more damage and travel true.`, (m, v) => { m.castMul *= 1 + v.pct / 100; m.castSeek = 1; }, { legendary: true }),
  P('hermes', 'greater-recall', 'Greater Recall', { pct: 20 }, v => `Cast and Call recover ${v.pct}% faster.`, (m, v) => { m.castSpeed *= 1 + v.pct / 100; m.callCharge *= 1 + v.pct / 100; }, { legendary: true }),

  // Demeter — Freeze/Chill, healing, growth.
  P('demeter', 'frozen-touch', 'Frozen Touch', { chance: 14, dmg: 28 }, v => `Taking damage has ${v.chance}% chance to freeze and retaliate for ${v.dmg}.`, (m, v) => { m.retaliate += v.chance / 100; m.retaliateDmg += v.dmg; }),
  P('demeter', 'rare-crop', 'Rare Crop', { pct: 12 }, v => `Your boons grow stronger between chambers: all damage +${v.pct}%.`, (m, v) => { m.dmgMul *= 1 + v.pct / 100; }),
  P('demeter', 'ravenous-will', 'Ravenous Will', { pct: 10, dr: 6 }, v => `Deal ${v.pct}% more damage and take ${v.dr}% less.`, (m, v) => { m.dmgMul *= 1 + v.pct / 100; m.damageTaken *= 1 - v.dr / 100; }),
  P('demeter', 'nourished-soul', 'Nourished Soul', { hp: 20, heal: 6 }, v => `Gain ${v.hp} maximum Life; clears restore ${v.heal}.`, (m, v) => { m.maxHealthAdd += v.hp; m.clearHeal += v.heal; }),
  P('demeter', 'snow-burst', 'Snow Burst', { radius: 2, dmg: 18 }, v => `Casts gain ${v.radius}m area and ${v.dmg} frost power.`, (m, v) => { m.castRadius += v.radius; m.castMul *= 1 + v.dmg / 100; }),
  P('demeter', 'arctic-blast', 'Arctic Blast', { dmg: 34 }, v => `Full Chill shatters for ${v.dmg} additional damage.`, (m, v) => { m.shatterDmg += v.dmg; }),
  P('demeter', 'killing-freeze', 'Killing Freeze', { pct: 18 }, v => `Freeze/Chill gains ${v.pct}% power and duration.`, (m, v) => { m.status.chill *= 1 + v.pct / 100; m.statusDuration.chill *= 1 + v.pct / 100; }),
  P('demeter', 'winter-harvest', 'Winter Harvest', { dmg: 55 }, v => `Frozen foes shatter for ${v.dmg} additional damage.`, (m, v) => { m.shatterDmg += v.dmg; }, { legendary: true }),

  // Apollo — Daze, larger zones, double hits.
  P('apollo', 'light-smite', 'Light Smite', { chance: 12, dmg: 28 }, v => `Taking damage has ${v.chance}% chance to radiate ${v.dmg} damage.`, (m, v) => { m.retaliate += v.chance / 100; m.retaliateDmg += v.dmg; }),
  P('apollo', 'perfect-image', 'Perfect Image', { pct: 12 }, v => `Deal ${v.pct}% more damage while your form remains unbroken.`, (m, v) => { m.dmgMul *= 1 + v.pct / 100; }),
  P('apollo', 'dazzling-display', 'Dazzling Display', { pct: 14 }, v => `Daze grows ${v.pct}% stronger.`, (m, v) => { m.status.weak *= 1 + v.pct / 100; }),
  P('apollo', 'back-burner', 'Back Burner', { crit: 5, pct: 10 }, v => `Dazed foes grant ${v.crit}% Critical chance and ${v.pct}% damage.`, (m, v) => { m.critChance += v.crit / 100; m.dmgMul *= 1 + v.pct / 100; }),
  P('apollo', 'prominence-flare', 'Prominence Flare', { ticks: 3, radius: 2 }, v => `Casts pulse ${v.ticks} more times and grow ${v.radius}m.`, (m, v) => { m.castTicks += v.ticks; m.castRadius += v.radius; }),
  P('apollo', 'super-nova', 'Super Nova', { radius: 3 }, v => `Cast and Dash areas gain ${v.radius}m.`, (m, v) => { m.castRadius += v.radius; m.dashRadius += v.radius * .5; }),
  P('apollo', 'extra-dose', 'Extra Dose', { pct: 16 }, v => `Attacks have a double-hit chance represented by ${v.pct}% extra power.`, (m, v) => { m.attackMul *= 1 + v.pct / 100; m.attackSpeed *= 1.06; }),
  P('apollo', 'exceptional-talent', 'Exceptional Talent', { pct: 18 }, v => `Attack and Special gain ${v.pct}% power.`, (m, v) => { m.attackMul *= 1 + v.pct / 100; m.specialMul *= 1 + v.pct / 100; }, { legendary: true }),

  // Hera — Hitch, rarity/family power, royal sustain.
  P('hera', 'extended-family', 'Extended Family', { pct: 12 }, v => `Olympian damage gains ${v.pct}%.`, (m, v) => { m.dmgMul *= 1 + v.pct / 100; }),
  P('hera', 'dying-wish', 'Dying Wish', { pct: 14 }, v => `Hitch-bound foes take ${v.pct}% more damage.`, (m, v) => { m.status.weak *= 1 + v.pct / 100; m.dmgMul *= 1 + v.pct / 200; }),
  P('hera', 'bridal-glow', 'Bridal Glow', { pct: 15 }, v => `All boon effects gain ${v.pct}% power.`, (m, v) => { m.dmgMul *= 1 + v.pct / 100; m.status.weak *= 1 + v.pct / 100; }),
  P('hera', 'blood-line', 'Blood Line', { hp: 20, mana: 20 }, v => `Gain ${v.hp} maximum Life and ${v.mana} maximum Magick.`, (m, v) => { m.maxHealthAdd += v.hp; m.maxManaAdd += v.mana; }),
  P('hera', 'keen-intuition', 'Keen Intuition', { pct: 12 }, v => `Cast and Call gain ${v.pct}% power.`, (m, v) => { m.castMul *= 1 + v.pct / 100; m.callMul *= 1 + v.pct / 100; }),
  P('hera', 'family-trade', 'Family Trade', { pct: 8, dr: 5 }, v => `Deal ${v.pct}% more damage and take ${v.dr}% less.`, (m, v) => { m.dmgMul *= 1 + v.pct / 100; m.damageTaken *= 1 - v.dr / 100; }),
  P('hera', 'nasty-comeback', 'Nasty Comeback', { chance: 14, dmg: 30 }, v => `Taking damage may return ${v.dmg} royal damage (${v.chance}%).`, (m, v) => { m.retaliate += v.chance / 100; m.retaliateDmg += v.dmg; }),
  P('hera', 'queenly-grace', 'Queenly Grace', { pct: 20 }, v => `All core actions gain ${v.pct}% power.`, (m, v) => { const x = 1 + v.pct / 100; m.attackMul *= x; m.specialMul *= x; m.castMul *= x; }, { legendary: true }),

  // Hestia — Scorch, fireballs, projectile safety translated to resistance.
  P('hestia', 'controlled-burn', 'Controlled Burn', { pct: 18 }, v => `Scorch gains ${v.pct}% power.`, (m, v) => { m.status.burn *= 1 + v.pct / 100; }),
  P('hestia', 'pyro-technique', 'Pyro Technique', { pct: 20 }, v => `Scorch burns ${v.pct}% harder.`, (m, v) => { m.status.burn *= 1 + v.pct / 100; m.statusDuration.burn *= .9; }),
  P('hestia', 'highly-flammable', 'Highly Flammable', { pct: 16 }, v => `Burning foes take ${v.pct}% more damage.`, (m, v) => { m.hangoverAmp += v.pct / 100; }),
  P('hestia', 'slow-cooker', 'Slow Cooker', { pct: 14 }, v => `Fire and all damage gain ${v.pct}%.`, (m, v) => { m.status.burn *= 1 + v.pct / 100; m.dmgMul *= 1 + v.pct / 200; }),
  P('hestia', 'warmth-gain', 'Warmth Gain', { regen: 20 }, v => `Magick regenerates ${v.regen}% faster.`, (m, v) => { m.manaRegenMul *= 1 + v.regen / 100; }),
  P('hestia', 'natural-gas', 'Natural Gas', { radius: 2, ticks: 2 }, v => `Scorch Casts gain ${v.radius}m area and ${v.ticks} pulses.`, (m, v) => { m.castRadius += v.radius; m.castTicks += v.ticks; }),
  P('hestia', 'glowing-coal', 'Glowing Coal', { seek: 1, pct: 12 }, v => `Casts seek foes and deal ${v.pct}% more damage.`, (m, v) => { m.castSeek = v.seek; m.castMul *= 1 + v.pct / 100; }),
  P('hestia', 'fire-extinguisher', 'Fire Extinguisher', { dr: 8, dodge: 5 }, v => `Take ${v.dr}% less damage and gain ${v.dodge}% dodge.`, (m, v) => { m.damageTaken *= 1 - v.dr / 100; m.dodge += v.dodge / 100; }),
  P('hestia', 'fine-kindling', 'Fine Kindling', { pct: 30 }, v => `Scorch becomes an inferno with ${v.pct}% more power.`, (m, v) => { m.status.burn *= 1 + v.pct / 100; }, { legendary: true }),

  // Hephaestus — blast, armor, durable smithing alongside weapon forges.
  P('hephaestus', 'grand-caldera', 'Grand Caldera', { pct: 20, radius: 2 }, v => `Blast damage gains ${v.pct}% and areas gain ${v.radius}m.`, (m, v) => { m.dmgMul *= 1 + v.pct / 100; m.castRadius += v.radius; }),
  P('hephaestus', 'molten-touch', 'Molten Touch', { pct: 14 }, v => `Attack and Special gain ${v.pct}% damage.`, (m, v) => { m.attackMul *= 1 + v.pct / 100; m.specialMul *= 1 + v.pct / 100; }),
  P('hephaestus', 'heavy-metal', 'Heavy Metal', { hp: 25, dr: 5 }, v => `Gain ${v.hp} maximum Life and ${v.dr}% resistance.`, (m, v) => { m.maxHealthAdd += v.hp; m.damageTaken *= 1 - v.dr / 100; }),
  P('hephaestus', 'trusty-shield', 'Trusty Shield', { dr: 8, iframe: .06 }, v => `Gain ${v.dr}% resistance and ${v.iframe}s Dash invulnerability.`, (m, v) => { m.damageTaken *= 1 - v.dr / 100; m.iframeAdd += v.iframe; }),
  P('hephaestus', 'mint-condition', 'Mint Condition', { dodge: 8 }, v => `Start encounters fortified with ${v.dodge}% dodge.`, (m, v) => { m.dodge += v.dodge / 100; }),
  P('hephaestus', 'uncanny-fortitude', 'Uncanny Fortitude', { hp: 18, mana: 18 }, v => `Gain ${v.hp} Life and ${v.mana} Magick capacity.`, (m, v) => { m.maxHealthAdd += v.hp; m.maxManaAdd += v.mana; }),
  P('hephaestus', 'furnace-blast', 'Furnace Blast', { dmg: 28, ticks: 2 }, v => `Blasts gain ${v.dmg} power and ${v.ticks} aftershocks.`, (m, v) => { m.castTicks += v.ticks; m.critRiftDmg += v.dmg; }),
  P('hephaestus', 'martial-art', 'Martial Art', { pct: 16 }, v => `Weapon Attack and Special gain ${v.pct}% power.`, (m, v) => { m.attackMul *= 1 + v.pct / 100; m.specialMul *= 1 + v.pct / 100; }),
  P('hephaestus', 'fine-tuning', 'Fine Tuning', { pct: 25 }, v => `All forged and blast effects gain ${v.pct}% power.`, (m, v) => { m.forgeMul *= 1 + v.pct / 100; m.dmgMul *= 1 + v.pct / 200; }, { legendary: true }),

  // Chaos — curse-cleared rewards represented as powerful unconditional gifts.
  P('chaos', 'strike', 'Chaos Strike', { pct: 22 }, v => `After the primordial trial, Attacks deal ${v.pct}% more damage.`, (m, v) => { m.attackMul *= 1 + v.pct / 100; }),
  P('chaos', 'flourish', 'Chaos Flourish', { pct: 28 }, v => `After the primordial trial, Specials deal ${v.pct}% more damage.`, (m, v) => { m.specialMul *= 1 + v.pct / 100; }),
  P('chaos', 'shot', 'Chaos Shot', { pct: 24 }, v => `After the primordial trial, Casts deal ${v.pct}% more damage.`, (m, v) => { m.castMul *= 1 + v.pct / 100; }),
  P('chaos', 'soul', 'Chaos Soul', { hp: 30 }, v => `Gain ${v.hp} maximum Life.`, (m, v) => { m.maxHealthAdd += v.hp; }),
  P('chaos', 'mind', 'Chaos Mind', { mana: 35 }, v => `Gain ${v.mana} maximum Magick.`, (m, v) => { m.maxManaAdd += v.mana; }),
  P('chaos', 'favor', 'Chaos Favor', { crit: 6, pct: 8 }, v => `Gain ${v.crit}% Critical chance and ${v.pct}% damage.`, (m, v) => { m.critChance += v.crit / 100; m.dmgMul *= 1 + v.pct / 100; }),
  P('chaos', 'haste', 'Chaos Haste', { pct: 16 }, v => `Move and Attack ${v.pct}% faster.`, (m, v) => { m.moveMul *= 1 + v.pct / 100; m.attackSpeed *= 1 + v.pct / 100; }),
  P('chaos', 'will', 'Chaos Will', { pct: 26 }, v => `Regenerate Magick ${v.pct}% faster.`, (m, v) => { m.manaRegenMul *= 1 + v.pct / 100; }),
  P('chaos', 'defiance', 'Chaos Defiance', { hp: 35, dr: 8 }, v => `Gain ${v.hp} Life and ${v.dr}% resistance.`, (m, v) => { m.maxHealthAdd += v.hp; m.damageTaken *= 1 - v.dr / 100; }, { legendary: true }),

  // Hades — direct underworld blessings from Hades II.
  P('hades', 'life-tax', 'Life Tax', { heal: 9 }, v => `Underworld tribute restores ${v.heal} Life after each clear.`, (m, v) => { m.clearHeal += v.heal; }),
  P('hades', 'last-gasp', 'Last Gasp', { pct: 12 }, v => `Deal ${v.pct}% more damage as the night deepens.`, (m, v) => { m.dmgMul *= 1 + v.pct / 100; }),
  P('hades', 'unseen-ire', 'Unseen Ire', { dodge: 7, pct: 10 }, v => `After being struck, darkness grants ${v.dodge}% dodge and ${v.pct}% damage.`, (m, v) => { m.dodge += v.dodge / 100; m.dmgMul *= 1 + v.pct / 100; }),
  P('hades', 'howling-soul', 'Howling Soul', { seek: 1, pct: 18 }, v => `Casts seek foes and deal ${v.pct}% more damage.`, (m, v) => { m.castSeek = v.seek; m.castMul *= 1 + v.pct / 100; }),
  P('hades', 'cinerary-circle', 'Cinerary Circle', { ticks: 4, radius: 2 }, v => `Casts summon ${v.ticks} soul pulses across ${v.radius}m.`, (m, v) => { m.castTicks += v.ticks; m.castRadius += v.radius; }),
  P('hades', 'old-grudge', 'Old Grudge', { dmg: 40 }, v => `Doom and retaliations gain ${v.dmg} damage.`, (m, v) => { m.doomDmg += v.dmg; m.retaliateDmg += v.dmg; }),
  P('hades', 'deep-dissent', 'Deep Dissent', { dr: 10, pct: 10 }, v => `Take ${v.dr}% less damage and deal ${v.pct}% more to bosses.`, (m, v) => { m.damageTaken *= 1 - v.dr / 100; m.dmgMul *= 1 + v.pct / 100; }),

  // Selene's complete Hex family translated into Call/Cast specializations.
  P('selene', 'phase-shift', 'Phase Shift', { dodge: 10, pct: 14 }, v => `Moonlight grants ${v.dodge}% dodge and ${v.pct}% speed.`, (m, v) => { m.dodge += v.dodge / 100; m.moveMul *= 1 + v.pct / 100; }),
  P('selene', 'twilight-curse', 'Twilight Curse', { seek: 1, pct: 14 }, v => `Casts seek foes and gain ${v.pct}% damage.`, (m, v) => { m.castSeek = v.seek; m.castMul *= 1 + v.pct / 100; }),
  P('selene', 'lunar-ray', 'Lunar Ray', { pct: 18 }, v => `Casts become a sustained moonbeam with ${v.pct}% extra power.`, (m, v) => { m.castBeam += 1; m.castMul *= 1 + v.pct / 100; }),
  P('selene', 'wolf-howl', 'Wolf Howl', { radius: 3, dmg: 20 }, v => `Dash and Call areas gain ${v.radius}m and ${v.dmg}% damage.`, (m, v) => { m.dashRadius += v.radius; m.callMul *= 1 + v.dmg / 100; }),
  P('selene', 'moon-water', 'Moon Water', { heal: 12 }, v => `Moonlight restores ${v.heal} Life after every clear.`, (m, v) => { m.clearHeal += v.heal; }),
  P('selene', 'night-bloom', 'Night Bloom', { pct: 20, charge: 18 }, v => `Calls deal ${v.pct}% more damage and charge ${v.charge}% faster.`, (m, v) => { m.callMul *= 1 + v.pct / 100; m.callCharge *= 1 + v.charge / 100; }),
  P('selene', 'total-eclipse', 'Total Eclipse', { pct: 32 }, v => `Call and Cast damage gain ${v.pct}%.`, (m, v) => { m.callMul *= 1 + v.pct / 100; m.castMul *= 1 + v.pct / 100; }, { legendary: true }),
  P('selene', 'dark-side', 'Dark Side', { dodge: 12, dr: 8 }, v => `Become a living nightmare: ${v.dodge}% dodge, ${v.dr}% resistance.`, (m, v) => { m.dodge += v.dodge / 100; m.damageTaken *= 1 - v.dr / 100; }, { legendary: true }),
];

export const CANON_BOONS = [...NEW_CORE, ...SUPPORT];

const D = (id, gods, name, base, text, apply) => ({ id: `duo.canon.${id}`, gods, name, slot: 'passive', base, text, apply, canonical: true });
const powerPair = (id, gods, name, a = 10, b = 8) => D(id, gods, name, { dmg: a, status: b },
  v => `The paired powers deal ${v.dmg}% more damage and their curses gain ${v.status}% potency.`,
  (m, v) => { m.dmgMul *= 1 + v.dmg / 100; const keys = gods.map(g => ({ zeus: 'shock', poseidon: null, athena: 'weak', aphrodite: 'weak', ares: 'doom', artemis: null, dionysus: 'burn', demeter: 'chill', apollo: 'weak', hera: 'weak', hestia: 'burn', hephaestus: null }[g])).filter(Boolean); for (const key of keys) m.status[key] *= 1 + v.status / 100; });

// All 28 original pair names are represented, followed by one playable pairing
// for every Hades II core-god combination. Existing bespoke EREBUS duos remain
// alongside these adaptations and take precedence when IDs overlap.
export const CANON_DUOS = [
  powerPair('curse-of-longing', ['aphrodite', 'ares'], 'Curse of Longing'),
  powerPair('heart-rend', ['aphrodite', 'artemis'], 'Heart Rend'),
  powerPair('parting-shot', ['aphrodite', 'athena'], 'Parting Shot'),
  powerPair('cold-embrace', ['aphrodite', 'demeter'], 'Cold Embrace'),
  powerPair('low-tolerance', ['aphrodite', 'dionysus'], 'Low Tolerance'),
  powerPair('sweet-nectar', ['aphrodite', 'poseidon'], 'Sweet Nectar'),
  powerPair('smoldering-air', ['aphrodite', 'zeus'], 'Smoldering Air'),
  powerPair('hunting-blades', ['ares', 'artemis'], 'Hunting Blades'),
  powerPair('merciful-end', ['ares', 'athena'], 'Merciful End'),
  powerPair('freezing-vortex', ['ares', 'demeter'], 'Freezing Vortex'),
  powerPair('curse-of-nausea', ['ares', 'dionysus'], 'Curse of Nausea'),
  powerPair('curse-of-drowning', ['ares', 'poseidon'], 'Curse of Drowning'),
  powerPair('vengeful-mood', ['ares', 'zeus'], 'Vengeful Mood'),
  powerPair('deadly-reversal', ['artemis', 'athena'], 'Deadly Reversal'),
  powerPair('crystal-clarity', ['artemis', 'demeter'], 'Crystal Clarity'),
  powerPair('splitting-headache', ['artemis', 'dionysus'], 'Splitting Headache'),
  powerPair('mirage-shot', ['artemis', 'poseidon'], 'Mirage Shot'),
  powerPair('lightning-rod', ['artemis', 'zeus'], 'Lightning Rod'),
  powerPair('stubborn-roots', ['athena', 'demeter'], 'Stubborn Roots'),
  powerPair('calculated-risk', ['athena', 'dionysus'], 'Calculated Risk'),
  powerPair('unshakable-mettle', ['athena', 'poseidon'], 'Unshakable Mettle'),
  powerPair('lightning-phalanx', ['athena', 'zeus'], 'Lightning Phalanx'),
  powerPair('ice-wine', ['demeter', 'dionysus'], 'Ice Wine'),
  powerPair('blizzard-shot', ['demeter', 'poseidon'], 'Blizzard Shot'),
  powerPair('cold-fusion', ['demeter', 'zeus'], 'Cold Fusion'),
  powerPair('exclusive-access', ['dionysus', 'poseidon'], 'Exclusive Access'),
  powerPair('scintillating-feast', ['dionysus', 'zeus'], 'Scintillating Feast'),
  powerPair('sea-storm', ['poseidon', 'zeus'], 'Sea Storm'),

  powerPair('queen-ransom', ['hera', 'zeus'], 'Queen’s Ransom', 12, 10),
  powerPair('golden-rule', ['hera', 'poseidon'], 'Golden Rule', 10, 10),
  powerPair('seasonal-vows', ['hera', 'demeter'], 'Seasonal Vows', 10, 12),
  powerPair('sunlit-oath', ['hera', 'apollo'], 'Sunlit Oath', 12, 8),
  powerPair('soul-mate', ['hera', 'aphrodite'], 'Soul Mate', 10, 12),
  powerPair('brave-face', ['hera', 'hephaestus'], 'Brave Face', 8, 12),
  powerPair('incandescent-aura', ['hera', 'hestia'], 'Incandescent Aura', 10, 12),
  powerPair('war-council', ['hera', 'ares'], 'War Council', 14, 8),
  powerPair('island-getaway', ['poseidon', 'apollo'], 'Island Getaway', 12, 8),
  powerPair('arterial-spray', ['poseidon', 'aphrodite'], 'Arterial Spray', 12, 10),
  powerPair('seismic-hammer', ['poseidon', 'hephaestus'], 'Seismic Hammer', 14, 8),
  powerPair('steam', ['poseidon', 'hestia'], 'Steam', 12, 12),
  powerPair('undertow-blades', ['poseidon', 'ares'], 'Undertow Blades', 14, 8),
  powerPair('sunshower', ['poseidon', 'demeter'], 'Sunshower', 10, 10),
  powerPair('sun-worshipper', ['demeter', 'apollo'], 'Sun Worshipper', 12, 10),
  powerPair('freezer-burn', ['demeter', 'hestia'], 'Freezer Burn', 12, 14),
  powerPair('room-temperature', ['demeter', 'hephaestus'], 'Room Temperature', 12, 10),
  powerPair('winter-coat', ['demeter', 'aphrodite'], 'Winter Coat', 10, 12),
  powerPair('frozen-blood', ['demeter', 'ares'], 'Frozen Blood', 14, 12),
  powerPair('warm-breeze', ['apollo', 'hestia'], 'Warm Breeze', 10, 12),
  powerPair('rude-awakening', ['apollo', 'hephaestus'], 'Rude Awakening', 14, 8),
  powerPair('glorious-disaster', ['apollo', 'zeus'], 'Glorious Disaster', 14, 10),
  powerPair('sun-spot', ['apollo', 'aphrodite'], 'Sun Spot', 12, 10),
  powerPair('radiant-violence', ['apollo', 'ares'], 'Radiant Violence', 14, 8),
  powerPair('love-handles', ['aphrodite', 'hephaestus'], 'Love Handles', 12, 10),
  powerPair('fourth-degree', ['aphrodite', 'hestia'], 'Fourth Degree', 12, 14),
  powerPair('cutting-edge', ['aphrodite', 'ares'], 'Cutting Edge', 14, 10),
  powerPair('chain-reaction', ['hephaestus', 'hestia'], 'Chain Reaction', 14, 12),
  powerPair('master-conductor', ['hephaestus', 'zeus'], 'Master Conductor', 14, 10),
  powerPair('coffin-nail', ['hephaestus', 'ares'], 'Coffin Nail', 16, 8),
  powerPair('thermal-shock', ['hestia', 'zeus'], 'Thermal Shock', 14, 14),
  powerPair('scorched-earth', ['hestia', 'ares'], 'Scorched Earth', 16, 12),
  powerPair('war-storm-ii', ['ares', 'zeus'], 'War Storm', 16, 10),
  D('open-heart', ['aphrodite', 'ares'], 'Open Heart', { hp: 25, dmg: 12 },
    v => `Gain ${v.hp} maximum Life and deal ${v.dmg}% more damage.`,
    (m, v) => { m.maxHealthAdd += v.hp; m.dmgMul *= 1 + v.dmg / 100; }),
];

export default { CANON_BOONS, CANON_DUOS };
