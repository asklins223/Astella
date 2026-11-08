/**
 * Keep a not-yet-started background model call from joining a live reply.
 *
 * Memory extraction and follow-up chips use the same model. Starting them
 * while a reply is in flight left the reply stream with no bytes. A call that
 * has already reached the provider is left alone: aborting it also dropped
 * the reply's connection.
 */
let interactive = 0;
const sleepers = new Set<() => void>();

export function enterInteractiveProviderLane(): void {
  interactive += 1;
}

export function leaveInteractiveProviderLane(): void {
  interactive = Math.max(0, interactive - 1);
  if (interactive === 0) for (const wake of sleepers) wake();
}

export function interactiveProviderLaneDepth(): number {
  return interactive;
}

export async function runWhenInteractiveProviderIdle<T>(
  run: (signal: AbortSignal) => Promise<T>,
  parent: AbortSignal,
): Promise<T> {
  parent.throwIfAborted();
  while (interactive > 0) {
    parent.throwIfAborted();
    await new Promise<void>(resolve => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = () => { clearTimeout(timer); sleepers.delete(finish); resolve(); };
      timer = setTimeout(finish, 150);
      sleepers.add(finish);
    });
  }
  parent.throwIfAborted();
  return run(parent);
}
