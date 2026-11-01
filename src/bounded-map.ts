/**
 * Startup filesystem stages keep at most this many operations in flight. Reads
 * hold descriptors, and Bun's realpath briefly opens each path as well.
 */
export const STARTUP_CONCURRENCY = 16;

/**
 * Maps items with at most STARTUP_CONCURRENCY tasks in flight, starting them in
 * input order, and resolves with results in input order. After a task fails, no
 * further items start; once running tasks settle, the earliest failure in input
 * order is rejected, matching the error a sequential loop reports.
 */
export async function mapBounded<T, R>(
  items: readonly T[],
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  // Index of the earliest failure so far; items.length means none.
  let failed = items.length;
  let failure: unknown;
  await Promise.all(
    Array.from(
      { length: Math.min(STARTUP_CONCURRENCY, items.length) },
      async () => {
        while (next < failed) {
          const index = next++;
          try {
            results[index] = await task(items[index]);
          } catch (error) {
            if (index < failed) {
              failed = index;
              failure = error;
            }
          }
        }
      },
    ),
  );
  if (failed < items.length) {
    throw failure;
  }
  return results;
}
