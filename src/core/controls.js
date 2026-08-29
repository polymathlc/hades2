// One canonical, user-facing control catalogue. Keep dead/debug actions out.
export const CONTROL_ROWS = Object.freeze([
  ['Move', 'WASD / Arrows', 'Left stick'],
  ['Aim', 'Mouse cursor', 'Right stick'],
  ['Attack', 'Left mouse', 'X / button 2'],
  ['Special', 'Right mouse / E', 'Y / button 3'],
  ['Cast', 'Q', 'RT / button 7'],
  ['Dash', 'Space / Left Shift', 'A / button 0'],
  ['Call', 'R', 'B / button 1'],
  ['Interact', 'F', 'RB / button 5'],
  ['Choose weapon', '1–4 · X/C cycle', '—'],
  ['Pause / Controls', 'Esc / H', 'Menu / button 9'],
]);

export default CONTROL_ROWS;
