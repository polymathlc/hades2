// Pure bookkeeping for the in-run HUD. The combat HUD must describe the live
// build, not the history of choices that produced it. Nothing in here touches
// the canvas, so every rule is unit-testable (scripts/test-ui-hud.mjs).

export const HUD_ACTION_SLOTS = Object.freeze(['attack', 'special', 'cast', 'dash']);

const ACTION_SLOT = new Set(HUD_ACTION_SLOTS);

function normaliseHudBoon(rec) {
  if (!rec) return null;
  const boon = rec.boon || rec;
  const god = rec.god || boon.god || (rec.gods && rec.gods[0]) || (boon.gods && boon.gods[0]);
  if (!god) return null;
  return {
    id: rec.id || boon.id || `${god}.${rec.slot || boon.slot || 'passive'}`,
    god,
    rarity: String(rec.rarity || 'common').toLowerCase(),
    slot: rec.slot || boon.slot || 'passive',
    name: rec.name || boon.name || '',
    duo: !!(rec.duo || boon.gods),
    level: Math.max(1, rec.level | 0 || 1),
  };
}

/**
 * Return the rail after one grant/upgrade. Core action slots are exclusive,
 * while passive/call/duo boons are keyed by id so two passives from one god do
 * not accidentally erase one another. When the rail is full, older passives
 * yield before any live action-slot boon.
 */
export function upsertHudBoon(current, rec, limit = 8) {
  const next = normaliseHudBoon(rec);
  if (!next) return Array.isArray(current) ? current.slice() : [];
  const list = Array.isArray(current) ? current.slice() : [];
  const isAction = ACTION_SLOT.has(next.slot) && !next.duo;
  const replaceAt = isAction
    ? list.findIndex(x => !x.duo && x.slot === next.slot)
    : list.findIndex(x => x.id === next.id);

  if (replaceAt >= 0) {
    // an upgrade of the SAME boon keeps counting up even if the caller forgot
    // to pass a level (the run system always does; capture scaffolds may not)
    const prev = list[replaceAt];
    if (prev.id === next.id && !(rec.level | 0)) next.level = prev.level + 1;
    list.splice(replaceAt, 1, next);
  } else list.push(next);

  const cap = Math.max(HUD_ACTION_SLOTS.length, limit | 0);
  while (list.length > cap) {
    const expendable = list.findIndex(x => x.duo || !ACTION_SLOT.has(x.slot));
    list.splice(expendable >= 0 ? expendable : 0, 1);
  }

  // Stable action order makes the rail readable at a glance even when boons
  // were collected in a different sequence. Extras retain acquisition order.
  return list
    .map((x, i) => ({ x, i, order: x.duo ? 99 : HUD_ACTION_SLOTS.indexOf(x.slot) }))
    .sort((a, b) => {
      const ao = a.order < 0 ? 98 : a.order;
      const bo = b.order < 0 ? 98 : b.order;
      return ao - bo || a.i - b.i;
    })
    .map(x => x.x);
}

export function hudBoonSlotLabel(boon) {
  if (!boon) return 'BOON';
  if (boon.duo) return 'DUO';
  const slot = String(boon.slot || 'passive').toUpperCase();
  return slot === 'PASSIVE' ? 'PASSIVE' : slot;
}

/** "7:05" for a run clock; hours appear only once they exist. */
export function fmtRunTime(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = (s / 3600) | 0, m = ((s % 3600) / 60) | 0, r = s % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return (h ? h + ':' : '') + mm + ':' + String(r).padStart(2, '0');
}

/** Remaining fraction 0..1 of a cooldown, safe against zero/negative totals. */
export function cooldownFrac(remaining, total) {
  if (!(total > 0) || !(remaining > 0)) return 0;
  return Math.min(1, remaining / total);
}

/**
 * Low-health treatment strength 0..1: nothing above 40% life, ramping to a
 * full pulse at 15%. The HUD uses it for the vignette, the numerals and the
 * heartbeat on the bar. Pure so the threshold is a tested fact, not a vibe.
 */
export function lowHealthLevel(frac) {
  if (!(frac < 0.4)) return 0;
  return Math.min(1, (0.4 - Math.max(0, frac)) / 0.25);
}

/**
 * The state one verb slot (special / cast / call) shows: ready, a remaining
 * fraction, or active. Reads only plain fields so combat may stay a stub.
 */
export function verbState(kind, o = {}) {
  if (kind === 'special') {
    const st = o.weaponState;
    if (st === 'charge' || st === 'block') return { ready: false, active: true, frac: 0, label: st === 'block' ? 'GUARD' : 'CHARGE' };
    if (st === 'reload') return { ready: false, active: false, frac: cooldownFrac(o.reloadRemaining, o.reloadTotal) || 1, label: 'RELOAD' };
    if (o.stuck) return { ready: true, active: false, frac: 0, label: 'RECALL' };
    return { ready: true, active: false, frac: 0, label: '' };
  }
  if (kind === 'cast') {
    const n = o.cast | 0, max = Math.max(1, o.castMax | 0);
    return { ready: n > 0, active: false, frac: n > 0 ? 0 : 1, label: `${n}/${max}` };
  }
  // call: a 14-second recharge unless the run reports its own total
  const total = o.callTotal || 14, rem = o.callRemaining || 0;
  const frac = cooldownFrac(rem, total);
  return { ready: frac <= 0, active: false, frac, label: frac > 0 ? `${Math.ceil(rem)}S` : '' };
}

/** Damage-number colour by type, with the colour-blind-safe alternates. */
export const DAMAGE_TYPE_COLORS = Object.freeze({
  normal: { physical: '#fff1d8', fire: '#ff9a3c', lightning: '#ffe14d', frost: '#7fe2ff', poison: '#7ee06a', arcane: '#c9a0ff' },
  safe:   { physical: '#ffffff', fire: '#ff8c1a', lightning: '#fff3a0', frost: '#3fb8ff', poison: '#e0e0e0', arcane: '#ff6fae' },
});
/** In the safe palette every non-physical type also carries a glyph suffix. */
export const DAMAGE_TYPE_GLYPH = Object.freeze({ fire: '🜂', lightning: '↯', frost: '❄', poison: '☠', arcane: '✦' });

export function damageColor(type, colorBlind) {
  const pal = DAMAGE_TYPE_COLORS[colorBlind ? 'safe' : 'normal'];
  return pal[type] || pal.physical;
}

/** Stat chips for a boon card: [{key, label, from, to}] from the base values. */
const STAT_LABEL = { dmg: 'Damage', bonus: 'Bonus', crit: 'Crit', chance: 'Chance', stacks: 'Stacks', dur: 'Duration', mul: 'Power', speed: 'Speed', radius: 'Radius', heal: 'Heal', arcs: 'Arcs', forks: 'Forks', shots: 'Shots', bounces: 'Bounces', pierce: 'Pierce', ticks: 'Ticks', weak: 'Weak', chill: 'Chill', armor: 'Armour', regen: 'Regen', mana: 'Magick', life: 'Life', cd: 'Cooldown' };
export function statChips(values, prevValues, limit = 3) {
  if (!values || typeof values !== 'object') return [];
  const out = [];
  for (const k in values) {
    const v = values[k];
    if (typeof v !== 'number') continue;
    const p = prevValues && typeof prevValues[k] === 'number' ? prevValues[k] : null;
    out.push({ key: k, label: (STAT_LABEL[k] || k).toUpperCase(), from: p, to: v, up: p != null && v > p, down: p != null && v < p });
    if (out.length >= limit) break;
  }
  return out;
}
