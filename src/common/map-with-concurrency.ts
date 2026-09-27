/**
 * `Promise.all(items.map(fn))` with at most `limit` calls in flight, results in input order.
 *
 * Use it instead of an unbounded Promise.all whenever the per-item work hits the database:
 * every Vercel instance shares one small Prisma pool across all its concurrent requests, so a
 * request that fires N queries at once queues ahead of everyone else on that instance and can
 * push them past the pool timeout. Bounding the fan-out lets other requests interleave.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker),
  );
  return results;
}
