// One canonical, user-facing control catalogue. Keep dead/debug actions out.
export const CONTROL_ROWS = Object.freeze([
  ['Move', 'WASD / Arrows', 'Left stick'],
  ['Aim', 'Mouse cursor', 'Right stick'],
  ['Attack / Ω Attack', 'Left mouse · hold on H2 arms', 'X / hold button 2'],
  ['Special / Ω / Recall', 'Right mouse · hold on H2 arms', 'Y / hold button 3'],
  ['Bloodstone / Binding Cast', 'Q', 'RT / button 7'],
  ['Dash', 'Space / Left Shift', 'A / button 0'],
  ['Call', 'R', 'B / button 1'],
  ['Interact / Equip', 'E / F', 'RB / button 5'],
  ['Choose heir / weapon', 'Approach at home · E', 'Approach at home · RB'],
  ['View current boons', 'B / Tab', 'Pause → Current Boons'],
  ['Pause / Controls', 'Esc / H', 'Menu / button 9'],
]);

export default CONTROL_ROWS;
