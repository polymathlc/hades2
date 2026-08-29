// Pure bookkeeping for the in-run boon rail. The combat HUD must describe the
// live build, not the history of choices that produced it.

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

  if (replaceAt >= 0) list.splice(replaceAt, 1, next);
  else list.push(next);

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
