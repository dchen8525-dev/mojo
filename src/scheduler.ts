/**
 * Wave scheduling for tool calls in one model turn. Consecutive parallel-safe
 * calls group into a wave that runs concurrently (bounded); a mutating call
 * breaks the wave and runs alone, preserving the model's emission order so a
 * mutating tool never overlaps anything else.
 */
export const MAX_WAVE_CONCURRENCY = 8;

export function planWaves(names: string[], isParallelSafe: (name: string) => boolean): number[][] {
  const waves: number[][] = [];
  let current: number[] = [];
  for (let i = 0; i < names.length; i++) {
    if (isParallelSafe(names[i])) {
      current.push(i);
    } else {
      if (current.length) waves.push(current);
      current = [];
      waves.push([i]);
    }
  }
  if (current.length) waves.push(current);
  return waves;
}

/** Run one wave's tasks with a concurrency cap, waiting for all. */
export async function runWave(tasks: Array<() => Promise<void>>, maxConcurrency = MAX_WAVE_CONCURRENCY): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(maxConcurrency, tasks.length) }, async () => {
    while (next < tasks.length) {
      await tasks[next++]();
    }
  });
  await Promise.all(workers);
}
