/** Bounds open handles even for the largest supported prompt inventory. */
const READ_WORKERS = 16;

/**
 * Runs tasks with a bounded number in flight and returns results in input order.
 * No item starts after a failure; once started tasks settle, the failure
 * earliest in input order is thrown, as a sequential loop would report it.
 */
export async function mapBounded<T, R>(
  items: readonly T[],
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  // Items are claimed in order: when one fails, every earlier item has started.
  let failed = items.length;
  let failure: unknown;
  await Promise.all(
    Array.from({ length: Math.min(READ_WORKERS, items.length) }, async () => {
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
    }),
  );
  if (failed < items.length) {
    throw failure;
  }
  return results;
}
