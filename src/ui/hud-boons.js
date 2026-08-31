// Pure bookkeeping for the in-run boon tray. The combat HUD must describe the
// live build, not the history of choices that produced it.
//
// Everything here is deliberately free of Canvas and of image imports so the
// tray's rules — which boon owns which category, what gets trimmed first, how
// the rows are grouped — can be tested directly.

export const HUD_ACTION_SLOTS = Object.freeze(['attack', 'special', 'cast', 'dash', 'call']);

const ACTION_SLOT = new Set(HUD_ACTION_SLOTS);

function safeText(rec, boon) {
  if (rec && typeof rec.text === 'string' && rec.text) return rec.text;
  const fn = boon && boon.text;
  if (typeof fn !== 'function') return '';
  try { const s = fn(rec?.values || boon.base || {}); return typeof s === 'string' ? s : ''; } catch (e) { return ''; }
}

function normaliseHudBoon(rec) {
  if (!rec) return null;
  const boon = rec.boon || rec;
  const god = rec.god || boon.god || (rec.gods && rec.gods[0]) || (boon.gods && boon.gods[0]);
  if (!god) return null;
  const duo = !!(rec.duo || boon.gods);
  const legendary = !!(rec.legendary || boon.legendary);
  return {
    id: rec.id || boon.id || `${god}.${rec.slot || boon.slot || 'passive'}`,
    god,
    gods: boon.gods || rec.gods || [god],
    rarity: String(rec.rarity || 'common').toLowerCase(),
    slot: rec.slot || boon.slot || 'passive',
    name: rec.name || boon.name || '',
    level: Math.max(1, rec.level || 1),
    // The tray is where a player checks what a boon actually does mid-fight,
    // so it carries the live description rather than the authored template.
    text: safeText(rec, boon),
    curse: rec.curse || null,
    duo,
    legendary,
  };
}

/**
 * Return the tray after one grant/upgrade. Core action slots are exclusive,
 * while passive/duo/legendary boons are keyed by id so two passives from one
 * god do not accidentally erase one another. When the tray is full, older
 * passives yield before any live action-slot boon.
 */
export function upsertHudBoon(current, rec, limit = 8) {
  const next = normaliseHudBoon(rec);
  if (!next) return Array.isArray(current) ? current.slice() : [];
  const list = Array.isArray(current) ? current.slice() : [];
  const isAction = ACTION_SLOT.has(next.slot) && !next.duo && !next.legendary;
  const replaceAt = isAction
    ? list.findIndex(x => !x.duo && !x.legendary && x.slot === next.slot)
    : list.findIndex(x => x.id === next.id);

  if (replaceAt >= 0) list.splice(replaceAt, 1, next);
  else list.push(next);

  const cap = Math.max(HUD_ACTION_SLOTS.length, limit | 0);
  while (list.length > cap) {
    // A Duo or a Legendary is the run's payoff — trim ordinary passives first,
    // and only fall back to the payoff cards if nothing else can go.
    let expendable = list.findIndex(x => !x.duo && !x.legendary && !ACTION_SLOT.has(x.slot));
    if (expendable < 0) expendable = list.findIndex(x => x.duo || x.legendary);
    list.splice(expendable >= 0 ? expendable : 0, 1);
  }

  // Stable action order makes the tray readable at a glance even when boons
  // were collected in a different sequence. Extras retain acquisition order.
  return list
    .map((x, i) => ({ x, i, order: hudBoonOrder(x) }))
    .sort((a, b) => a.order - b.order || a.i - b.i)
    .map(x => x.x);
}

/** Sort key: the five categories in play order, then Legendary, Duo, passive. */
export function hudBoonOrder(boon) {
  if (!boon) return 99;
  if (boon.legendary) return 90;
  if (boon.duo) return 95;
  const i = HUD_ACTION_SLOTS.indexOf(boon.slot);
  return i < 0 ? 96 : i;
}

export function hudBoonSlotLabel(boon) {
  if (!boon) return 'BOON';
  if (boon.legendary) return 'LEGENDARY';   // the word, not an abbreviation of it
  if (boon.duo) return 'DUO';
  const slot = String(boon.slot || 'passive').toUpperCase();
  return slot === 'PASSIVE' ? 'PASSIVE' : slot;
}

/**
 * Group the tray for display: the five fixed ability categories (present or
 * empty) followed by whatever else the run has picked up. Empty categories are
 * kept as explicit sockets, because "your Cast slot is still free" is exactly
 * the information a Hades player uses to decide what to take next.
 */
export function hudBoonGroups(list, o = {}) {
  const boons = Array.isArray(list) ? list : [];
  const abilities = HUD_ACTION_SLOTS.map(slot => ({
    slot,
    boon: boons.find(b => !b.duo && !b.legendary && b.slot === slot) || null,
  }));
  const extras = boons
    .filter(b => b.duo || b.legendary || !ACTION_SLOT.has(b.slot))
    .slice(0, Math.max(0, o.extraLimit != null ? o.extraLimit : 4));
  return { abilities, extras };
}
