/**
 * Tiny in-memory data cache for stale-while-revalidate navigation.
 *
 * Lets pages render instantly with the last-known data when you navigate back
 * to a page you already visited, while a background refetch keeps it fresh.
 * This is a lightweight, dependency-free stand-in for a full query cache
 * (e.g. react-query) scoped to read-heavy navigation paths.
 *
 * The cache lives for the lifetime of the tab (module singleton) and is
 * intentionally NOT persisted — a full reload starts fresh. Because sign-out
 * does not reload the page, entries holding per-user data must be keyed with
 * the owning user's identity, and authService clears the whole cache on every
 * sign-in and sign-out so a new principal never inherits a previous one's data.
 */

interface CacheEntry<T> {
  data: T;
  ts: number;
}

const store = new Map<string, CacheEntry<unknown>>();

/** Read the cached value regardless of age (used to seed initial render). */
export function peekCached<T>(key: string): T | undefined {
  return (store.get(key) as CacheEntry<T> | undefined)?.data;
}

/** Read the cached value only if it's newer than `maxAgeMs`. */
export function getCached<T>(key: string, maxAgeMs: number): T | undefined {
  const entry = store.get(key) as CacheEntry<T> | undefined;
  if (!entry) return undefined;
  if (Date.now() - entry.ts > maxAgeMs) return undefined;
  return entry.data;
}

/** Store a value in the cache with the current timestamp. */
export function setCached<T>(key: string, data: T): void {
  store.set(key, { data, ts: Date.now() });
}

/** Remove cache entries whose key exactly matches or starts with `keyOrPrefix`. */
export function invalidateCache(keyOrPrefix: string): void {
  for (const key of store.keys()) {
    if (key === keyOrPrefix || key.startsWith(keyOrPrefix)) {
      store.delete(key);
    }
  }
}

/** Remove every cache entry. Called at session boundaries (sign-in/sign-out). */
export function clearCache(): void {
  store.clear();
}
