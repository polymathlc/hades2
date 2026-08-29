// Idempotent gameplay-input ownership for canvas modals. A duplicate open must
// never overwrite the state captured by the first open.
export function lockModalInput(owner, input) {
  if (!owner || !input || owner._inputLockHeld) return false;
  owner._inputLockHeld = true;
  owner._inputWasEnabled = input.enabled !== false;
  input.enabled = false;
  return true;
}

export function releaseModalInput(owner, input, mayEnable = true) {
  if (!owner || !input || !owner._inputLockHeld) return false;
  owner._inputLockHeld = false;
  input.enabled = !!owner._inputWasEnabled && !!mayEnable;
  return true;
}
