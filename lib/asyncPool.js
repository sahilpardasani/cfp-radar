/** Run async work with a hard concurrency ceiling while preserving input order. */
export async function mapLimit(values, limit, worker) {
  const input = Array.from(values || []);
  if (!input.length) return [];
  const width = Math.max(1, Math.min(Number(limit) || 1, input.length));
  const results = new Array(input.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: width }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= input.length) return;
      results[index] = await worker(input[index], index);
    }
  }));
  return results;
}
