import assert from 'node:assert/strict';
import {
  upsertHudBoon, hudBoonSlotLabel, fmtRunTime, cooldownFrac, lowHealthLevel, verbState,
  damageColor, DAMAGE_TYPE_COLORS, DAMAGE_TYPE_GLYPH, statChips,
  fitText, wrapLines, damageStackRule, fanOffset, stackScale, DAMAGE_STACK_WINDOW, DAMAGE_DUPE_WINDOW, DAMAGE_STACK_MAX_AGE,
  healthBand, HEALTH_BANDS, guardFrac, bossModel,
} from '../src/ui/hud-boons.js';
import { pactRows, pactTotals, pactFocus } from '../src/ui/pact.js';
import { RUN_MODIFIERS, heatOf } from '../src/game/meta.js';
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

// ── label fitting: shrink, then ellipsise, never overflow ─────────────────
{
  const measure = (txt, size) => [...txt].length * size * 0.62;   // a fixed-pitch stand-in for canvas metrics
  const fits = fitText(measure, 'DASH', 200, { size: 10 });
  assert.deepEqual(fits, { text: 'DASH', size: 10, shrunk: false, truncated: false }, 'a label that fits is untouched');
  const label = 'BLOODSTONE / BINDING CAST';
  const wide = fitText(measure, label, measure(label, 10) - 1, { size: 10, minSize: 9 });
  assert.equal(wide.text, label, 'a label that fits at the floor size shrinks rather than cuts');
  assert.ok(wide.shrunk && wide.size < 10 && wide.size >= 9);
  assert.ok(measure(wide.text, wide.size) <= measure(label, 10) - 1);
  const cut = fitText(measure, label, 90, { size: 10, minSize: 9 });
  assert.ok(cut.truncated && cut.text.endsWith('…'), 'a label that cannot fit at the floor is ellipsised');
  assert.equal(cut.size, 9, 'ellipsising happens at the floor size, not above it');
  assert.ok(measure(cut.text, cut.size) <= 90, 'the fitted label never exceeds its column');
  assert.ok(!/[\s·]…$/.test(cut.text), 'no dangling separator before the ellipsis');
  assert.equal(fitText(measure, '', 50).text, '');
  for (const w of [40, 60, 80, 120, 160]) {
    const r = fitText(measure, label, w, { size: 10.5, minSize: 8.8 });
    assert.ok(measure(r.text, r.size) <= w, `fitted width must be <= ${w}`);
  }
  const lines = wrapLines(measure, 'Lightning Strike of Zeus', 70, 7.8, 2);
  assert.ok(lines.length <= 2, 'two-line labels are capped at two lines');
  for (const l of lines) assert.ok(measure(l, 7.8) <= 70, `wrapped line "${l}" must fit its cell`);
  assert.deepEqual(wrapLines(measure, 'Short', 200, 8), ['Short']);
  const long = wrapLines(measure, 'One two three four five six seven', 40, 8, 2);
  assert.equal(long.length, 2); assert.ok(long[1].endsWith('…'), 'overflow past the last line is ellipsised');
  assert.ok(wrapLines(measure, 'Supercalifragilistic', 30, 8, 2)[0].endsWith('…'), 'a single word wider than the cell is cut');
}

// ── damage-number stacking ────────────────────────────────────────────────
{
  const hit = { crit: false, type: 'physical', amount: 29 };
  assert.deepEqual(damageStackRule(null, hit, 1), { mode: 'new', lane: 0 }, 'no number in flight: a new one');
  const prev = { live: true, t0: 1.0, lastHit: 1.0, lastAmount: 29, crit: false, type: 'physical', lane: 0, fan: 0 };
  assert.equal(damageStackRule(prev, hit, 1.0 + DAMAGE_DUPE_WINDOW / 2).mode, 'dupe', 'the same amount inside the dupe window is the same hit reported twice');
  assert.equal(damageStackRule(prev, hit, 1.0 + DAMAGE_DUPE_WINDOW * 2).mode, 'merge', 'a repeat hit after the dupe window merges');
  assert.equal(damageStackRule(prev, { ...hit, amount: 31 }, 1.01).mode, 'merge', 'a different amount is a real second hit even within the dupe window');
  assert.equal(damageStackRule(prev, hit, 1.0 + DAMAGE_STACK_WINDOW + 0.01).mode, 'new', 'past the window the numbers are separate');
  assert.equal(damageStackRule(prev, hit, 1.0 + DAMAGE_STACK_WINDOW).mode, 'merge', 'the window is inclusive');
  assert.deepEqual(damageStackRule(prev, { crit: true, amount: 118 }, 1.2), { mode: 'fan', lane: 1 }, 'a crit never merges into a plain number: it fans out');
  assert.deepEqual(damageStackRule({ ...prev, fan: 1 }, { type: 'fire', amount: 12 }, 1.2), { mode: 'fan', lane: 2 }, 'the fan lane advances');
  assert.equal(damageStackRule({ ...prev, live: false }, hit, 1.1).mode, 'new', 'a dead pool entry is not a stack target');
  assert.equal(damageStackRule(prev, hit, 0.5).mode, 'new', 'a hit before the number was born cannot merge into it');
  const old = { ...prev, t0: 0, lastHit: 1.5 };
  assert.equal(damageStackRule(old, hit, 1.6).mode, 'fan', 'a number older than the cap stops absorbing: the combo fans to a fresh one');
  assert.equal(damageStackRule({ ...old, t0: 1.0 }, hit, 1.6).mode, 'merge');
  assert.ok(DAMAGE_STACK_MAX_AGE > DAMAGE_STACK_WINDOW);
  assert.equal(fanOffset(0), 0);
  assert.ok(fanOffset(1) > 0 && fanOffset(2) < 0 && fanOffset(3) > fanOffset(1), 'lanes alternate sides and step outward');
  assert.equal(fanOffset(2), -fanOffset(1));
  assert.equal(stackScale(1), 1);
  assert.ok(stackScale(3) > stackScale(2) && stackScale(2) > 1, 'a merged number grows with its hit count');
  assert.equal(stackScale(40), 1.6, 'growth is capped');
}

// ── enemy bar bands, guard meter, boss plate ──────────────────────────────
{
  assert.equal(healthBand(1, false).key, 'high'); assert.equal(healthBand(0.5, false).key, 'mid');
  assert.equal(healthBand(0.26, false).key, 'mid'); assert.equal(healthBand(0.25, false).key, 'low');
  assert.equal(healthBand(NaN, false).key, 'low');
  assert.equal(healthBand(0.9, false).color, HEALTH_BANDS.normal.high);
  assert.equal(healthBand(0.9, true).color, HEALTH_BANDS.safe.high);
  assert.notEqual(HEALTH_BANDS.safe.high, HEALTH_BANDS.normal.high, 'the safe palette must actually differ');
  assert.ok(new Set(Object.values(HEALTH_BANDS.safe)).size === 3 && new Set(Object.values(HEALTH_BANDS.normal)).size === 3, 'three distinct bands in each palette');
  assert.equal(guardFrac(null), null); assert.equal(guardFrac({ mem: {} }), null, 'no guard meter without a guardMax');
  assert.equal(guardFrac({ shielded: true, mem: { guardMax: 80, guard: 40 } }), 0.5);
  assert.equal(guardFrac({ shielded: true, mem: { guardMax: 80, guard: 200 } }), 1, 'clamped');
  assert.equal(guardFrac({ shielded: false, mem: { guardMax: 80, guard: 0, guardBroken: 2 } }), 0, 'a broken guard still reports (empty) so the bar can say so');
  assert.equal(guardFrac({ shielded: false, mem: { guardMax: 80, guard: 0, guardBroken: 0 } }), null, 'a dropped shield with no break timer has no meter');

  const spawn = bossModel(null, { name: 'The Warden of the Ninth Gate', hp: 900, max: 900, phases: 3 });
  assert.equal(spawn.hp, 1); assert.equal(spawn.phase, 1); assert.equal(spawn.remaining, 3); assert.equal(spawn.enraged, false);
  assert.equal(spawn.name, 'The Warden of the Ninth Gate');
  const hit = bossModel(spawn, { hp: 500, max: 900 });
  assert.equal(hit.name, spawn.name, 'a health-only update keeps the name from the spawn');
  assert.equal(hit.phase, 2, 'the phase follows the health when no phase event has arrived');
  assert.equal(hit.remaining, 2);
  const ph = bossModel(hit, { phase: 3 });
  assert.equal(ph.phase, 3); assert.equal(ph.remaining, 1); assert.equal(ph.hp, hit.hp, 'a phase-only update keeps the fill');
  const rage = bossModel(ph, { enraged: true });
  assert.equal(rage.enraged, true); assert.equal(bossModel(rage, { hp: 100, max: 900 }).enraged, true, 'enrage persists across health updates');
  assert.equal(bossModel(rage, { frac: 0.1 }).phase, 3);
  assert.equal(bossModel(null, { hp: -5, max: 100 }).hp, 0, 'clamped');
  assert.equal(bossModel(null, { phases: 0 }).phases, 3, 'a missing phase count falls back to the three-phase default');
  assert.equal(bossModel(null, { phases: 1 }).remaining, 1);
  assert.equal(bossModel(null, {}).name, 'The Warden');
}

// ── the Pact model ────────────────────────────────────────────────────────
{
  const rows = pactRows(new Set(['swift']));
  assert.equal(rows.length, RUN_MODIFIERS.length, 'every run modifier gets a row');
  assert.deepEqual(rows.map(r => r.id), RUN_MODIFIERS.map(m => m.id), 'rows keep table order');
  assert.ok(rows.every(r => r.name && r.text && r.heat > 0), 'each row carries a name, a description and a heat cost');
  assert.equal(rows.find(r => r.id === 'swift').on, true); assert.equal(rows.find(r => r.id === 'lean').on, false);
  assert.deepEqual(pactRows(['lean']).find(r => r.id === 'lean').on, true, 'an array of ids works too');
  const t = pactTotals(new Set(['swift', 'hardened', 'bogus']));
  assert.equal(t.heat, heatOf(['swift', 'hardened']), 'the total is meta.js\'s own heat');
  assert.equal(t.heat, 3); assert.equal(t.darknessPerClear, 3); assert.equal(t.sealed, 2, 'unknown ids are not counted');
  assert.equal(t.max, RUN_MODIFIERS.reduce((a, m) => a + m.heat, 0));
  assert.equal(pactTotals(new Set()).heat, 0);
  const n = rows.length;
  assert.equal(pactFocus(0, -1, n), n, 'focus wraps from the first row to the Back item');
  assert.equal(pactFocus(n, 1, n), 0, 'and from Back to the first row');
  assert.equal(pactFocus(2, 1, n), 3);
}

console.log('ui hud ok: rail levels, run clock, cooldown rings, low-life law, safe palette, stat chips, settings model, bindings table, toggle latch, label fitting, damage stacking, bar bands, boss plate, pact model');
