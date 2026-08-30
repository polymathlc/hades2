// Browser texture budgets. Resolution is the dominant cost because synthesis,
// decoded RAM, mip storage and upload bandwidth all grow with width².
export const TEXTURE_PROFILES = Object.freeze({
  low: Object.freeze({ proceduralScale: 0.30, generatedScale: 0.25, anisotropy: 2 }),
  med: Object.freeze({ proceduralScale: 0.42, generatedScale: 0.50, anisotropy: 4 }),
  high: Object.freeze({ proceduralScale: 0.58, generatedScale: 0.75, anisotropy: 8 }),
  ultra: Object.freeze({ proceduralScale: 0.75, generatedScale: 1.00, anisotropy: 12 }),
});

export function textureProfileForTier(tier = 'med') {
  return TEXTURE_PROFILES[tier] || TEXTURE_PROFILES.med;
}

export default TEXTURE_PROFILES;
