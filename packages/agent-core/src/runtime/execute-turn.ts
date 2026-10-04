export type AgentStepResult<T> = { kind: "continue" } | { kind: "settled"; result: T };

/** Hosts own models, persistence and effects; this is the single bounded step driver. */
export async function executeTurn<T>(ports: {
  signal?: AbortSignal;
  now: () => number;
  limits: () => { maxSteps: number; deadlineAt: number };
  budgetError: () => Error;
  advance: (step: number) => Promise<AgentStepResult<T>>;
}): Promise<T> {
  for (let step = 1; step <= ports.limits().maxSteps; step += 1) {
    ports.signal?.throwIfAborted();
    if (ports.now() >= ports.limits().deadlineAt) throw ports.budgetError();
    const outcome = await ports.advance(step);
    if (outcome.kind === "settled") return outcome.result;
  }
  throw ports.budgetError();
}
