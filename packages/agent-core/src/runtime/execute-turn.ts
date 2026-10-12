/**
 * Hosts own models, persistence and effects; this is the step driver.
 *
 * `maxSteps: null` means no count ceiling — the run stops when the work settles,
 * when the wall-clock slice ends, or when the host's fence aborts it, never
 * because a number of turns was reached.
 */
export type AgentStepResult<T> = { kind: "continue" } | { kind: "settled"; result: T };

export async function executeTurn<T>(ports: {
  signal?: AbortSignal;
  now: () => number;
  limits: () => { maxSteps: number | null; deadlineAt: number };
  budgetError: () => Error;
  advance: (step: number) => Promise<AgentStepResult<T>>;
}): Promise<T> {
  for (let step = 1; ; step += 1) {
    const limits = ports.limits();
    if (limits.maxSteps !== null && step > limits.maxSteps) throw ports.budgetError();
    ports.signal?.throwIfAborted();
    if (ports.now() >= limits.deadlineAt) throw ports.budgetError();
    const outcome = await ports.advance(step);
    if (outcome.kind === "settled") return outcome.result;
  }
}
