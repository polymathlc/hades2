// Playable heirs and the content pools that make them mechanically distinct.
// This is deliberately independent from the render/combat modules so the
// Crossroads, run director, tests and UI all read one canonical contract.

export const CHARACTER_INFO = Object.freeze({
  zagreus: Object.freeze({
    id: 'zagreus',
    name: 'Zagreus',
    game: 'Hades I',
    title: 'Prince of the Underworld',
    color: '#ef465f',
    accent: '#ffd36a',
    defaultWeapon: 'blade',
    weapons: Object.freeze(['blade', 'spear', 'bow', 'shield', 'fists', 'rail']),
    gods: Object.freeze(['zeus', 'poseidon', 'athena', 'aphrodite', 'ares', 'artemis', 'dionysus', 'hermes', 'demeter', 'chaos', 'hephaestus']),
  }),
  melinoe: Object.freeze({
    id: 'melinoe',
    name: 'Melinoë',
    game: 'Hades II',
    title: 'Princess of the Underworld',
    color: '#86e6c1',
    accent: '#f3a45d',
    defaultWeapon: 'staff',
    weapons: Object.freeze(['staff', 'blades', 'flames', 'axe', 'skull', 'coat']),
    // Ordinary chamber gates use the nine Hades II Olympian families. Selene,
    // Artemis, Hades, Hecate and Chaos remain authored for dedicated encounter,
    // Hex and story systems instead of masquerading as standard Olympian doors.
    gods: Object.freeze(['zeus', 'poseidon', 'aphrodite', 'demeter', 'apollo', 'ares', 'hera', 'hestia', 'hephaestus']),
  }),
});

export const CHARACTER_IDS = Object.freeze(Object.keys(CHARACTER_INFO));

export function characterInfo(id) {
  return CHARACTER_INFO[id] || CHARACTER_INFO.zagreus;
}

export function weaponIdsForCharacter(id) {
  return characterInfo(id).weapons.slice();
}

export function godIdsForCharacter(id) {
  return characterInfo(id).gods.slice();
}

export function characterOwnsWeapon(characterId, weaponId) {
  return characterInfo(characterId).weapons.includes(weaponId);
}

export default CHARACTER_INFO;
