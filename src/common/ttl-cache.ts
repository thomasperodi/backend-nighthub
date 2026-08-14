/**
 * Minimal in-process TTL cache with request coalescing, for per-tenant read endpoints that
 * are expensive to compute but tolerate a few seconds of staleness (analytics/dashboard
 * aggregates). Not shared across serverless instances - each cold start starts empty, which
 * is fine for a short TTL used only to deduplicate bursts of near-simultaneous requests.
 *
 * Deliberately not a generic caching layer for correctness-sensitive data - see
 * PERFORMANCE_AUDIT.md §6 for what is/isn't safe to cache this way.
 *
 * `getOrCompute` is generic per call (not a class type parameter) so each cache instance can
 * hold multiple differently-shaped cached results, and callers get their real inferred return
 * type back instead of `any`.
 */
export class TtlCache {
  private readonly entries = new Map<
    string,
    { expiresAt: number; value: Promise<unknown> }
  >();

  async getOrCompute<T>(
    key: string,
    ttlMs: number,
    compute: () => Promise<T>,
  ): Promise<T> {
    const now = Date.now();
    const existing = this.entries.get(key);
    if (existing && existing.expiresAt > now) {
      return existing.value as Promise<T>;
    }

    const value = compute();
    this.entries.set(key, { expiresAt: now + ttlMs, value });
    try {
      return await value;
    } catch (err) {
      // Don't cache failures - next call should retry against the DB.
      if (this.entries.get(key)?.value === value) {
        this.entries.delete(key);
      }
      throw err;
    }
  }
}
