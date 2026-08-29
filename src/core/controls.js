// One canonical, user-facing control catalogue. Keep dead/debug actions out.
export const CONTROL_ROWS = Object.freeze([
  ['Move', 'WASD / Arrows', 'Left stick'],
  ['Aim', 'Mouse cursor', 'Right stick'],
  ['Attack', 'Left mouse', 'X / button 2'],
  ['Special / Spear Recall', 'Right mouse', 'Y / button 3'],
  ['Cast', 'Q', 'RT / button 7'],
  ['Dash', 'Space / Left Shift', 'A / button 0'],
  ['Call', 'R', 'B / button 1'],
  ['Interact / Equip', 'E / F', 'RB / button 5'],
  ['Choose weapon', 'Approach an arm at home', 'Approach an arm at home'],
  ['View current boons', 'B / Tab', 'Pause → Current Boons'],
  ['Pause / Controls', 'Esc / H', 'Menu / button 9'],
]);

export default CONTROL_ROWS;
