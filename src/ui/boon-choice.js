// Pure decision helpers for the boon overlay. Keeping these independent from
// Canvas and image imports makes the replacement contract cheap to test.

export function boonOfferComparison(x, boonState) {
  if (!x || !boonState) return null;
  const boon = x.boon || x;
  const id = x.id || boon.id;
  const slot = x.slot || boon.slot || 'passive';
  const offeredRarity = (x.rarity || 'common').toLowerCase();
  const owned = id && boonState.byId?.get?.(id);
  if (owned) return {
    kind: 'upgrade',
    fromName: owned.boon?.name || boon.name || x.name || 'Owned Boon',
    fromRarity: owned.rarity || 'common',
    toRarity: offeredRarity,
  };
  if (!['attack', 'special', 'cast', 'dash'].includes(slot)) return null;
  const previous = (x.replaces && boonState.byId?.get?.(x.replaces))
    || boonState.granted?.find?.(r => !r.duo && r.slot === slot);
  if (!previous) return null;
  return {
    kind: 'replace',
    fromName: previous.boon?.name || 'Current Boon',
    fromRarity: previous.rarity || 'common',
    toRarity: offeredRarity,
  };
}

export function advanceCardFocus(current, dir, count) {
  if (!count) return -1;
  if (current < 0) return dir < 0 ? count - 1 : 0;
  return (current + dir + count) % count;
}

/**
 * Required-choice modals must not consume the press that opened/reached them.
 * `armed` becomes true only after the button is observed up at least once.
 */
export function releaseGatedEdge(armed, down, edge) {
  if (!down) return { armed: true, trigger: false };
  return { armed: !!armed, trigger: !!armed && !!edge };
}
