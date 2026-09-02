// One canonical, user-facing control catalogue. Keep dead/debug actions out.
//
// This file is also the REMAP-READY BINDING TABLE. `core/input.js` builds its
// key map from `BINDINGS` rather than from a private literal, the controls
// guide in the pause menu renders `controlRows()` so it always reflects the
// live bindings, and `rebind()` / `loadBindings()` / `saveBindings()` give the
// settings screen a persistence path. Mouse buttons and the gamepad layout are
// fixed (they are positional by nature); everything on the keyboard is open.

export const ACTIONS = Object.freeze({
  up:       { label: 'Move up',        group: 'move',   rebind: true },
  down:     { label: 'Move down',      group: 'move',   rebind: true },
  left:     { label: 'Move left',      group: 'move',   rebind: true },
  right:    { label: 'Move right',     group: 'move',   rebind: true },
  attack:   { label: 'Attack',         group: 'combat', rebind: false, mouse: 0 },
  special:  { label: 'Special',        group: 'combat', rebind: false, mouse: 2 },
  cast:     { label: 'Cast',           group: 'combat', rebind: true },
  dash:     { label: 'Dash',           group: 'combat', rebind: true },
  summon:   { label: 'Call',           group: 'combat', rebind: true },
  interact: { label: 'Interact',       group: 'world',  rebind: true },
  pause:    { label: 'Pause',          group: 'menu',   rebind: false },
  help:     { label: 'Controls guide', group: 'menu',   rebind: false },
  boons:    { label: 'Current boons',  group: 'menu',   rebind: false },
});

/** Default keyboard bindings: action -> KeyboardEvent.code list. */
export const DEFAULT_BINDINGS = Object.freeze({
  up: ['KeyW', 'ArrowUp'],
  down: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  dash: ['Space', 'ShiftLeft'],
  cast: ['KeyQ'],
  summon: ['KeyR'],
  interact: ['KeyE', 'KeyF'],
  pause: ['Escape'],
  help: ['KeyH'],
  boons: ['KeyB', 'Tab'],
});

/** Gamepad layout (standard mapping button indices). Positional, not remappable. */
export const PAD_BINDINGS = Object.freeze({
  attack: 2, special: 3, cast: 7, dash: 0, summon: 1, interact: 5, pause: 9, boons: 8,
});

/** Human glyphs for gamepad buttons, by standard-mapping index. */
export const PAD_GLYPH = Object.freeze({
  0: 'A', 1: 'B', 2: 'X', 3: 'Y', 4: 'LB', 5: 'RB', 6: 'LT', 7: 'RT', 8: 'VIEW', 9: 'MENU',
  12: '▲', 13: '▼', 14: '◀', 15: '▶',
});

const BINDINGS_KEY = 'erebus.bindings.v1';

// live table (mutable copy of the defaults; never mutate DEFAULT_BINDINGS)
export const BINDINGS = Object.fromEntries(Object.entries(DEFAULT_BINDINGS).map(([k, v]) => [k, v.slice()]));

/** Human label for a KeyboardEvent.code ("KeyW" -> "W", "ShiftLeft" -> "L SHIFT"). */
export function keyLabel(code) {
  if (!code) return '';
  const m = /^Key([A-Z])$/.exec(code); if (m) return m[1];
  const d = /^Digit(\d)$/.exec(code); if (d) return d[1];
  const a = /^Arrow(Up|Down|Left|Right)$/.exec(code);
  if (a) return { Up: '↑', Down: '↓', Left: '←', Right: '→' }[a[1]];
  switch (code) {
    case 'Space': return 'SPACE';
    case 'ShiftLeft': return 'L SHIFT';
    case 'ShiftRight': return 'R SHIFT';
    case 'ControlLeft': return 'L CTRL';
    case 'ControlRight': return 'R CTRL';
    case 'AltLeft': return 'L ALT';
    case 'AltRight': return 'R ALT';
    case 'Escape': return 'ESC';
    case 'Enter': return 'ENTER';
    case 'Tab': return 'TAB';
    case 'Backspace': return 'BKSP';
    case 'CapsLock': return 'CAPS';
    default: return code.replace(/^(Numpad|Bracket|Semi|Back)/, '$1 ').toUpperCase();
  }
}

/** Short label for the FIRST key bound to an action — used on HUD glyphs. */
export function primaryKey(action) {
  const list = BINDINGS[action];
  return list && list.length ? keyLabel(list[0]) : '';
}

/** Every label for an action, joined for the controls table. */
export function keysLabel(action) {
  const list = BINDINGS[action] || [];
  return list.map(keyLabel).join(' / ');
}

export function padLabel(action) {
  const i = PAD_BINDINGS[action];
  return i == null ? '' : (PAD_GLYPH[i] || `BTN ${i}`);
}

/** action -> code lookup for the input layer, derived from the live table. */
export function keymap() {
  const map = {};
  for (const action in BINDINGS) for (const code of BINDINGS[action]) map[code] = action;
  return map;
}

/**
 * Bind `code` as the primary key of `action`. A code already used by another
 * rebindable action is taken from it (that action keeps its other keys). The
 * result reports the displaced action so the UI can say what happened.
 */
export function rebind(action, code) {
  const def = ACTIONS[action];
  if (!def || !def.rebind || !code) return { ok: false, reason: 'fixed' };
  if (code === 'Escape') return { ok: false, reason: 'reserved' };
  let displaced = null;
  for (const other in BINDINGS) {
    const i = BINDINGS[other].indexOf(code);
    if (i < 0) continue;
    if (!ACTIONS[other]?.rebind) return { ok: false, reason: 'reserved' };
    if (other !== action) displaced = other;
    BINDINGS[other].splice(i, 1);
  }
  BINDINGS[action].unshift(code);
  if (BINDINGS[action].length > 2) BINDINGS[action].length = 2;
  // never leave a rebindable action with no key at all
  for (const other in BINDINGS) {
    if (!BINDINGS[other].length && DEFAULT_BINDINGS[other]) {
      const fallback = DEFAULT_BINDINGS[other].find(c => !Object.values(BINDINGS).some(l => l.includes(c)));
      if (fallback) BINDINGS[other].push(fallback);
    }
  }
  return { ok: true, displaced, label: keyLabel(code) };
}

export function resetBindings() {
  for (const k in DEFAULT_BINDINGS) BINDINGS[k] = DEFAULT_BINDINGS[k].slice();
  return BINDINGS;
}

/** Apply a stored override table ({action: [codes]}); unknown actions are ignored. */
export function applyBindings(table) {
  if (!table || typeof table !== 'object') return BINDINGS;
  for (const action in table) {
    if (!ACTIONS[action]?.rebind || !Array.isArray(table[action])) continue;
    const codes = table[action].filter(c => typeof c === 'string' && c && c !== 'Escape').slice(0, 2);
    if (codes.length) BINDINGS[action] = codes;
  }
  return BINDINGS;
}

export function loadBindings(storage) {
  try {
    const raw = (storage || globalThis.localStorage)?.getItem(BINDINGS_KEY);
    if (raw) applyBindings(JSON.parse(raw));
  } catch (e) { /* storage may be blocked */ }
  return BINDINGS;
}

export function saveBindings(storage) {
  try {
    const out = {};
    for (const k in BINDINGS) if (ACTIONS[k]?.rebind) out[k] = BINDINGS[k].slice();
    (storage || globalThis.localStorage)?.setItem(BINDINGS_KEY, JSON.stringify(out));
    return true;
  } catch (e) { return false; }
}

/**
 * The live controls table: [action, keyboard, gamepad, rebindAction|null].
 * Rows carrying a rebind key can be remapped from the controls guide.
 */
export function controlRows() {
  const move = `${primaryKey('up')}${primaryKey('left')}${primaryKey('down')}${primaryKey('right')}`;
  return [
    ['Move', `${move} / Arrows`, 'Left stick', null],
    ['Aim', 'Mouse cursor', 'Right stick', null],
    ['Attack / Ω Attack', 'Left mouse · hold on H2 arms', 'X / hold button 2', null],
    ['Special / Ω / Recall', 'Right mouse · hold on H2 arms', 'Y / hold button 3', null],
    ['Bloodstone / Binding Cast', keysLabel('cast'), 'RT / button 7', 'cast'],
    ['Dash', keysLabel('dash'), 'A / button 0', 'dash'],
    ['Call', keysLabel('summon'), 'B / button 1', 'summon'],
    ['Interact / Equip', keysLabel('interact'), 'RB / button 5', 'interact'],
    ['Choose heir / weapon', `Approach at home · ${primaryKey('interact')}`, 'Approach at home · RB', null],
    ['View current boons', 'B / Tab', 'Pause → Current Boons', null],
    ['Pause / Controls', 'Esc / H', 'Menu / button 9', null],
  ];
}

// The default table, frozen, for documentation and tests.
export const CONTROL_ROWS = Object.freeze([
  ['Move', 'WASD / Arrows', 'Left stick'],
  ['Aim', 'Mouse cursor', 'Right stick'],
  ['Attack / Ω Attack', 'Left mouse · hold on H2 arms', 'X / hold button 2'],
  ['Special / Ω / Recall', 'Right mouse · hold on H2 arms', 'Y / hold button 3'],
  ['Bloodstone / Binding Cast', 'Q', 'RT / button 7'],
  ['Dash', 'Space / Left Shift', 'A / button 0'],
  ['Call', 'R', 'B / button 1'],
  ['Interact / Equip', 'E / F', 'RB / button 5'],
  ['Choose heir / weapon', 'Approach at home · E', 'Approach at home · RB'],
  ['View current boons', 'B / Tab', 'Pause → Current Boons'],
  ['Pause / Controls', 'Esc / H', 'Menu / button 9'],
]);

export default CONTROL_ROWS;
