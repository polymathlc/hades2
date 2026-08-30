/**
 * Install a completed worker bake only when no live texture set won the race.
 * Kept dependency-free so the cache contract can run in Node without loading
 * the browser-only generated texture atlases.
 */
export function installPrebuilt(cache, key, raw, install) {
  if (!raw || cache.has(key)) return cache.get(key) || null;
  const set = install(raw);
  cache.set(key, set);
  return set;
}

export default installPrebuilt;
