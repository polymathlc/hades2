// OWNER: AGENT-MATERIAL
// ---------------------------------------------------------------------------
// texworker.js — one core's worth of texture synthesis.
//
// Imports recipes.js ONLY (which imports texgen-core.js + palette.js). No
// three.js: the point of the worker is to start painting immediately, and
// parsing a megabyte of renderer first would eat the win.
//
// Protocol: { id, key, n } in -> { id, ok, set } out, with the four pixel
// buffers TRANSFERRED (not copied) so a 1024² set costs nothing to hand back.
// ---------------------------------------------------------------------------

import { bakeSet, bakeTransferables } from './recipes.js';

self.onmessage = (e) => {
  const { id, key, n } = e.data || {};
  try {
    const t0 = (self.performance || Date).now();
    const set = bakeSet(key, n);
    if (!set) { self.postMessage({ id, ok: false, error: 'unknown recipe ' + key }); return; }
    set.cpuMs = (self.performance || Date).now() - t0;
    self.postMessage({ id, ok: true, set }, bakeTransferables(set));
  } catch (err) {
    self.postMessage({ id, ok: false, error: (err && err.message) || String(err) });
  }
};
