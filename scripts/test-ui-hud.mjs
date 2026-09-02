import assert from 'node:assert/strict';
import {
  upsertHudBoon, hudBoonSlotLabel, fmtRunTime, cooldownFrac, lowHealthLevel, verbState,
  damageColor, DAMAGE_TYPE_COLORS, DAMAGE_TYPE_GLYPH, statChips,
} from '../src/ui/hud-boons.js';
import {
  SETTINGS_DEFAULTS, SETTINGS_ROWS, sanitiseSetting, bumpSetting, settingLabel, loadSettings, saveSettings, wantPadGlyphs, TEXT_SCALES,
} from '../src/ui/settings.js';
import {
  BINDINGS, DEFAULT_BINDINGS, ACTIONS, CONTROL_ROWS, controlRows, keyLabel, keymap, rebind, resetBindings,
  applyBindings, saveBindings, loadBindings, primaryKey, padLabel,
} from '../src/core/controls.js';
import { toggleLatch } from '../src/core/input.js';
import { boonOfferComparison, advanceCardFocus, releaseGatedEdge } from '../src/ui/boon-choice.js';

// ── the boon rail ──────────────────────────────────────────────────────────
const rec = (id, god, slot, rarity = 'common', level) => ({
  boon: { id, god, slot, name: id }, god, slot, rarity, level,
});

let rail = [];
rail = upsertHudBoon(rail, rec('poseidon.attack', 'poseidon', 'attack', 'rare'));
rail = upsertHudBoon(rail, rec('ares.passive.one', 'ares', 'passive'));
rail = upsertHudBoon(rail, rec('ares.passive.two', 'ares', 'passive'));
rail = upsertHudBoon(rail, rec('zeus.attack', 'zeus', 'attack', 'epic'));

assert.equal(rail.filter(x => x.slot === 'attack').length, 1, 'a replaced action boon remained on the rail');
assert.equal(rail.find(x => x.slot === 'attack').id, 'zeus.attack');
assert.equal(rail.filter(x => x.god === 'ares').length, 2, 'distinct same-god passives were collapsed');
assert.equal(rail[0].slot, 'attack', 'action slots should have a stable glance order');
assert.equal(rail[0].level, 1, 'a fresh boon starts at level 1');

rail = upsertHudBoon(rail, rec('zeus.attack', 'zeus', 'attack', 'heroic'));
assert.equal(rail.length, 3, 'upgrading an owned boon duplicated it');
assert.equal(rail[0].rarity, 'heroic');
assert.equal(rail[0].level, 2, 'an upgrade without an explicit level must still count up on the rail');
rail = upsertHudBoon(rail, rec('zeus.attack', 'zeus', 'attack', 'heroic', 5));
assert.equal(rail[0].level, 5, 'an explicit level from the run system wins');

for (let i = 0; i < 10; i++) rail = upsertHudBoon(rail, rec(`passive.${i}`, 'hermes', 'passive'), 8);
assert.equal(rail.length, 8);
assert.equal(rail.filter(x => x.slot === 'attack').length, 1, 'rail trimming discarded the live action boon');
assert.equal(hudBoonSlotLabel({ slot: 'special' }), 'SPECIAL');
assert.equal(hudBoonSlotLabel({ slot: 'passive', duo: true }), 'DUO');

// ── the run clock and cooldown rings ───────────────────────────────────────
assert.equal(fmtRunTime(0), '0:00');
assert.equal(fmtRunTime(65.9), '1:05');
assert.equal(fmtRunTime(3725), '1:02:05', 'hours must appear once they exist, with padded minutes');
assert.equal(fmtRunTime(-4), '0:00');
assert.equal(cooldownFrac(7, 14), 0.5);
assert.equal(cooldownFrac(0, 14), 0);
assert.equal(cooldownFrac(20, 14), 1, 'a remaining time over the total clamps to a full ring');
assert.equal(cooldownFrac(3, 0), 0, 'a zero total is ready, never NaN');

assert.equal(lowHealthLevel(1), 0);
assert.equal(lowHealthLevel(0.4), 0, 'the low-life treatment must not start above 40%');
assert.ok(lowHealthLevel(0.3) > 0 && lowHealthLevel(0.3) < 1);
assert.equal(lowHealthLevel(0.1), 1);
assert.equal(lowHealthLevel(NaN), 0);

{
  const idle = verbState('special', { weaponState: 'idle' });
  assert.ok(idle.ready && !idle.active && idle.frac === 0);
  const block = verbState('special', { weaponState: 'block' });
  assert.ok(block.active && block.label === 'GUARD');
  const reload = verbState('special', { weaponState: 'reload', reloadRemaining: 0.5, reloadTotal: 1.0 });
  assert.equal(reload.frac, 0.5);
  const recall = verbState('special', { weaponState: 'idle', stuck: {} });
  assert.equal(recall.label, 'RECALL', 'a thrown spear must advertise the recall press');
  const cast = verbState('cast', { cast: 0, castMax: 3 });
  assert.ok(!cast.ready && cast.frac === 1 && cast.label === '0/3');
  const call = verbState('call', { callRemaining: 7, callTotal: 14 });
  assert.equal(call.frac, 0.5); assert.equal(call.label, '7S');
  assert.ok(verbState('call', {}).ready);
}

// ── colour-blind-safe damage colours ───────────────────────────────────────
assert.equal(damageColor('fire', false), DAMAGE_TYPE_COLORS.normal.fire);
assert.equal(damageColor('fire', true), DAMAGE_TYPE_COLORS.safe.fire);
assert.equal(damageColor('nonsense', true), DAMAGE_TYPE_COLORS.safe.physical);
assert.notEqual(DAMAGE_TYPE_COLORS.safe.poison, DAMAGE_TYPE_COLORS.safe.fire);
for (const type of ['fire', 'lightning', 'frost', 'poison', 'arcane']) assert.ok(DAMAGE_TYPE_GLYPH[type], `${type} needs a shape cue in the safe palette`);

// ── stat chips ─────────────────────────────────────────────────────────────
{
  const chips = statChips({ dmg: 40, crit: 10, label: 'x' }, { dmg: 30, crit: 10 });
  assert.equal(chips.length, 2, 'non-numeric values are not chips');
  assert.deepEqual({ ...chips[0] }, { key: 'dmg', label: 'DAMAGE', from: 30, to: 40, up: true, down: false });
  assert.equal(chips[1].up, false);
  assert.equal(statChips(null).length, 0);
  assert.equal(statChips({ a: 1, b: 2, c: 3, d: 4 }).length, 3, 'chips are capped so the card never overflows');
}

// ── settings model ─────────────────────────────────────────────────────────
{
  const s = { ...SETTINGS_DEFAULTS };
  assert.equal(sanitiseSetting('shakeAmount', 4), 1);
  assert.equal(sanitiseSetting('shakeAmount', 'nope'), SETTINGS_DEFAULTS.shakeAmount);
  assert.equal(sanitiseSetting('textScale', 1.12), 1.15, 'text scale snaps to an authored step');
  assert.equal(sanitiseSetting('quality', 'potato'), 'auto');
  bumpSetting(s, 'shakeAmount', -1); assert.equal(s.shakeAmount, 0.9);
  for (let i = 0; i < 9; i++) bumpSetting(s, 'shakeAmount', -1);
  assert.equal(s.shakeAmount, 0); assert.equal(s.shake, false, 'zero shake must also flip the legacy on/off flag');
  bumpSetting(s, 'shakeAmount', -1); assert.equal(s.shakeAmount, 1, 'sliders wrap for keyboard users');
  bumpSetting(s, 'reduceFlash'); assert.equal(s.reduceFlash, true);
  bumpSetting(s, 'holdToggle'); assert.equal(settingLabel(s, 'holdToggle'), 'TOGGLE');
  bumpSetting(s, 'textScale'); assert.equal(s.textScale, TEXT_SCALES[2]);
  assert.equal(settingLabel(s, 'quality', { tier: 'high' }), 'AUTO (HIGH)');
  assert.ok(SETTINGS_ROWS.every(r => r.key in SETTINGS_DEFAULTS), 'every settings row must map to a real setting');

  const store = new Map();
  const storage = { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, v) };
  assert.equal(saveSettings(s, storage), true);
  const back = loadSettings(storage);
  assert.equal(back.reduceFlash, true); assert.equal(back.shakeAmount, 1); assert.equal(back.textScale, TEXT_SCALES[2]);
  assert.equal(back.quality, 'auto', 'graphics quality is owned by main.js storage, not the UI table');
  assert.deepEqual(loadSettings({ getItem: () => '{not json' }), { ...SETTINGS_DEFAULTS }, 'corrupt storage falls back to defaults');
  assert.equal(wantPadGlyphs({ padGlyphs: 'auto' }, true), true);
  assert.equal(wantPadGlyphs({ padGlyphs: 'keyboard' }, true), false);
  assert.equal(wantPadGlyphs({ padGlyphs: 'gamepad' }, false), true);
}

// ── bindings table ─────────────────────────────────────────────────────────
{
  resetBindings();
  assert.equal(keyLabel('KeyW'), 'W'); assert.equal(keyLabel('ShiftLeft'), 'L SHIFT'); assert.equal(keyLabel('ArrowUp'), '↑');
  assert.equal(keymap().KeyQ, 'cast'); assert.equal(keymap().Space, 'dash'); assert.equal(keymap().KeyH, 'help');
  assert.equal(padLabel('dash'), 'A'); assert.equal(padLabel('interact'), 'RB');
  const r = rebind('cast', 'KeyE');
  assert.equal(r.ok, true); assert.equal(r.displaced, 'interact', 'stealing a key reports who lost it');
  assert.equal(primaryKey('cast'), 'E');
  assert.deepEqual(BINDINGS.interact, ['KeyF'], 'the displaced action keeps its remaining key');
  assert.equal(keymap().KeyE, 'cast');
  assert.equal(rebind('attack', 'KeyZ').ok, false, 'mouse actions are positional and not remappable');
  assert.equal(rebind('dash', 'Escape').ok, false, 'Escape is reserved for pause');
  assert.equal(rebind('dash', 'KeyH').ok, false, 'fixed menu keys cannot be stolen');
  const live = controlRows();
  assert.ok(live.find(row => row[3] === 'cast')[1].startsWith('E'), 'the controls guide must reflect the live binding');
  assert.equal(CONTROL_ROWS.length, live.length);
  const store = new Map();
  const storage = { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, v) };
  saveBindings(storage); resetBindings(); assert.equal(primaryKey('cast'), 'Q');
  loadBindings(storage); assert.equal(primaryKey('cast'), 'E', 'bindings round-trip through storage');
  applyBindings({ dash: ['Escape'], attack: ['KeyZ'], cast: 'KeyQ' });
  assert.deepEqual(BINDINGS.dash, DEFAULT_BINDINGS.dash, 'a reserved key in storage is ignored');
  assert.ok(!BINDINGS.dash.includes('Escape'));
  assert.ok(!('attack' in DEFAULT_BINDINGS));
  resetBindings();
  assert.ok(Object.keys(ACTIONS).every(a => !ACTIONS[a].rebind || DEFAULT_BINDINGS[a]?.length), 'every rebindable action ships a default');
}

// ── toggle latch (hold-vs-toggle accessibility) ───────────────────────────
{
  let st = toggleLatch(false, 'down'); assert.deepEqual(st, { latched: true, down: true });
  st = toggleLatch(st.latched, 'up'); assert.deepEqual(st, { latched: true, down: true }, 'releasing the key must not end a latched action');
  st = toggleLatch(st.latched, 'down'); assert.deepEqual(st, { latched: false, down: false }, 'the second press ends it');
}

// ── boon-choice helpers keep their contract ───────────────────────────────
assert.equal(advanceCardFocus(-1, 1, 3), 0);
assert.equal(advanceCardFocus(0, -1, 3), 2);
assert.deepEqual(releaseGatedEdge(false, false, false), { armed: true, trigger: false });
assert.equal(boonOfferComparison(null, null), null);

console.log('ui hud ok: rail levels, run clock, cooldown rings, low-life law, safe palette, stat chips, settings model, bindings table, toggle latch');
