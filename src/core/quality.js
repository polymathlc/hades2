// Browser graphics policy. Automatic mode is deliberately conservative: the
// game should start smoothly on an ordinary laptop before it tries to look like
// the capture build. A query-string or saved setting always wins.
export const GRAPHICS_STORAGE_KEY = 'erebus.graphics.v1';
export const GRAPHICS_CHOICES = ['auto', 'low', 'med', 'high', 'ultra'];
export const GRAPHICS_TIERS = GRAPHICS_CHOICES.slice(1);

export function isGraphicsTier(value) {
  return GRAPHICS_TIERS.includes(value);
}

export function graphicsDprCap(tier) {
  return ({ low: 1, med: 1.25, high: 1.5, ultra: 2 })[tier] || 1;
}

export function chooseGraphicsTier(options = {}) {
  if (options.capture) return 'ultra';
  if (isGraphicsTier(options.requested)) return options.requested;
  if (isGraphicsTier(options.stored)) return options.stored;

  const memory = Math.max(0, Number(options.deviceMemory) || 0);
  const cores = Math.max(0, Number(options.cores) || 0);
  const dpr = Math.min(2, Math.max(1, Number(options.dpr) || 1));
  const width = Math.max(1, Number(options.width) || 1280);
  const height = Math.max(1, Number(options.height) || 720);
  const pixels = width * height * dpr * dpr;
  const clearlyPowerful = memory >= 12 && cores >= 10;

  if (options.saveData || options.mobile || (memory > 0 && memory <= 4)
    || (cores > 0 && cores <= 4) || (pixels >= 7_000_000 && !clearlyPowerful)) return 'low';

  // Browsers such as Firefox and Safari may hide deviceMemory. When both useful
  // hints are absent, medium is a safer default than betting on a fast GPU.
  if (!memory && !cores) return 'med';
  if ((memory > 0 && memory < 8) || (cores > 0 && cores < 8)
    || (pixels >= 4_000_000 && !clearlyPowerful)) return 'med';
  return 'high';
}

export function graphicsChoiceSource({ capture = false, requested, stored } = {}) {
  if (capture) return 'capture';
  if (isGraphicsTier(requested)) return 'query';
  if (isGraphicsTier(stored)) return 'stored';
  return 'auto';
}
