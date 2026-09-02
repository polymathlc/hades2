// OWNER: AGENT-UI
// ---------------------------------------------------------------------------
// The player-facing settings model. Pure: no DOM, no canvas, so it is testable
// and the same table drives the pause menu, the camera rig, the HUD and the
// post-processing flash. Persistence is opt-in (never in capture mode, where
// determinism matters more than memory).
// ---------------------------------------------------------------------------

export const TEXT_SCALES = Object.freeze([0.9, 1.0, 1.15, 1.3]);
export const SETTINGS_KEY = 'erebus.ui.settings.v1';

export const SETTINGS_DEFAULTS = Object.freeze({
  quality: 'auto',
  master: 0.8, music: 0.7, sfx: 0.9,
  shake: true,          // legacy on/off, kept so old listeners keep working
  shakeAmount: 1.0,     // 0..1 multiplier on every camera shake amplitude
  reduceFlash: false,   // damps screen flashes and HUD hit flashes
  reduceMotion: false,  // calms camera lead/roll and UI sweeps
  textScale: 1.0,       // multiplies the UI scale
  colorBlind: false,    // colour-blind-safe status palette + shape cues
  holdToggle: false,    // Special (block / charge) becomes press-to-toggle
  padGlyphs: 'auto',    // 'auto' | 'keyboard' | 'gamepad'
  onboarded: false,     // first-run controls card has been dismissed
});

export const SETTINGS_ROWS = Object.freeze([
  { key: 'quality', label: 'Graphics Quality', kind: 'cycle', section: 'Display' },
  { key: 'textScale', label: 'Text Size', kind: 'cycle', section: 'Display' },
  { key: 'master', label: 'Master Volume', kind: 'slider', section: 'Audio' },
  { key: 'music', label: 'Music', kind: 'slider', section: 'Audio' },
  { key: 'sfx', label: 'Effects', kind: 'slider', section: 'Audio' },
  { key: 'shakeAmount', label: 'Screen Shake', kind: 'slider', section: 'Comfort' },
  { key: 'reduceFlash', label: 'Reduce Flashes', kind: 'toggle', section: 'Comfort' },
  { key: 'reduceMotion', label: 'Reduce Camera Motion', kind: 'toggle', section: 'Comfort' },
  { key: 'colorBlind', label: 'Colour-Blind Palette', kind: 'toggle', section: 'Access' },
  { key: 'holdToggle', label: 'Block / Charge', kind: 'cycle', section: 'Access' },
  { key: 'padGlyphs', label: 'Button Prompts', kind: 'cycle', section: 'Access' },
]);

const QUALITY = ['auto', 'low', 'med', 'high', 'ultra'];
const PROMPTS = ['auto', 'keyboard', 'gamepad'];
const clamp01 = (v) => v < 0 ? 0 : v > 1 ? 1 : v;

/** Coerce one value into its legal range; unknown keys pass through untouched. */
export function sanitiseSetting(key, value) {
  switch (key) {
    case 'quality': return QUALITY.includes(value) ? value : 'auto';
    case 'master': case 'music': case 'sfx': case 'shakeAmount':
      return Number.isFinite(+value) ? Math.round(clamp01(+value) * 100) / 100 : SETTINGS_DEFAULTS[key];
    case 'textScale': {
      const v = +value;
      return TEXT_SCALES.includes(v) ? v : TEXT_SCALES.reduce((a, b) => Math.abs(b - v) < Math.abs(a - v) ? b : a, 1);
    }
    case 'padGlyphs': return PROMPTS.includes(value) ? value : 'auto';
    case 'shake': case 'reduceFlash': case 'reduceMotion': case 'colorBlind': case 'holdToggle': case 'onboarded':
      return !!value;
    default: return value;
  }
}

/** Step a setting by `dir` (cycle/toggle rows) or set it (sliders). Returns the new value. */
export function bumpSetting(settings, key, dir = 1) {
  const s = settings;
  switch (key) {
    case 'quality': { const i = QUALITY.indexOf(s.quality); s.quality = QUALITY[(i + dir + QUALITY.length) % QUALITY.length]; break; }
    case 'textScale': { const i = TEXT_SCALES.indexOf(s.textScale); s.textScale = TEXT_SCALES[(Math.max(0, i) + dir + TEXT_SCALES.length) % TEXT_SCALES.length]; break; }
    case 'padGlyphs': { const i = PROMPTS.indexOf(s.padGlyphs); s.padGlyphs = PROMPTS[(Math.max(0, i) + dir + PROMPTS.length) % PROMPTS.length]; break; }
    case 'shakeAmount': case 'master': case 'music': case 'sfx': {
      // sliders step in tenths and wrap, so a keyboard user can reach 0 from 1
      let v = Math.round((s[key] + 0.1 * dir) * 10) / 10;
      if (v > 1.001) v = 0; else if (v < -0.001) v = 1;
      s[key] = sanitiseSetting(key, v);
      break;
    }
    default: if (typeof s[key] === 'boolean') s[key] = !s[key];
  }
  if (key === 'shakeAmount') s.shake = s.shakeAmount > 0.001;
  return s[key];
}

/** The text shown for a cycle/toggle value on the settings screen. */
export function settingLabel(settings, key, extra = {}) {
  const v = settings[key];
  switch (key) {
    case 'quality': return v === 'auto' ? `AUTO (${String(extra.tier || 'med').toUpperCase()})` : String(v).toUpperCase();
    case 'textScale': return `${Math.round(v * 100)}%`;
    case 'holdToggle': return v ? 'TOGGLE' : 'HOLD';
    case 'padGlyphs': return v === 'auto' ? 'AUTO' : v === 'gamepad' ? 'GAMEPAD' : 'KEYBOARD';
    default: return typeof v === 'boolean' ? (v ? 'ON' : 'OFF') : String(v);
  }
}

export function loadSettings(storage) {
  const out = { ...SETTINGS_DEFAULTS };
  try {
    const raw = (storage || globalThis.localStorage)?.getItem(SETTINGS_KEY);
    if (raw) {
      const obj = JSON.parse(raw);
      for (const k in obj) if (k in SETTINGS_DEFAULTS) out[k] = sanitiseSetting(k, obj[k]);
    }
  } catch (e) { /* blocked storage is not an error */ }
  out.shake = out.shakeAmount > 0.001;
  return out;
}

export function saveSettings(settings, storage) {
  try {
    const out = {};
    for (const k in SETTINGS_DEFAULTS) if (k !== 'quality' && k in settings) out[k] = settings[k];
    (storage || globalThis.localStorage)?.setItem(SETTINGS_KEY, JSON.stringify(out));
    return true;
  } catch (e) { return false; }
}

/** Whether the HUD should draw gamepad glyphs right now. */
export function wantPadGlyphs(settings, usingGamepad) {
  if (settings.padGlyphs === 'gamepad') return true;
  if (settings.padGlyphs === 'keyboard') return false;
  return !!usingGamepad;
}
