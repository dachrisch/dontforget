// A tiny in-process job list for background searches. The POST route fires
// the searxng+opencode run here instead of awaiting it, so the request
// returns as soon as the query row is created. Tests await `flushSearches()`
// to make the fire-and-forget runs deterministic against the real DB.
const pending = new Set<Promise<void>>();

export function enqueueSearch(run: () => Promise<void>): void {
  const job = run();
  pending.add(job);
  void job.finally(() => {
    pending.delete(job);
  });
}

export async function flushSearches(): Promise<void> {
  while (pending.size > 0) {
    await Promise.all(Array.from(pending));
  }
}
