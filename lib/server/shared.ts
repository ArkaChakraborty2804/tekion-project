/**
 * Process-wide singletons. The custom server (server.ts, run by Node directly) and Next.js route handlers (bundled)
 * load separate copies of these modules in the same process. Anything that must be one value per process — the dev
 * clock offset, the change bus, in-flight background work, caches over the shared DB — lives on globalThis under a
 * namespaced Symbol so every copy sees the same object.
 */
export function shared<T>(key: string, init: () => T): T {
  const sym = Symbol.for(`tekion-loyalty.${key}`);
  const g = globalThis as Record<symbol, unknown>;
  if (!(sym in g)) g[sym] = init();
  return g[sym] as T;
}
