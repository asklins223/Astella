/** Independent reads overlap; the caller still consumes receipts in call order.
 * Preparation owns validation/registration. Queued work is not registered after
 * cancellation, and close() drains every started executor before the step ends. */
export class CompanionReadBatch<P, R> {
  private readonly entries = new Map<number, Promise<{ value: P; result: Promise<R> } | undefined>>();
  private readonly jobs: Promise<void>[] = [];
  private readonly controller = new AbortController();
  private readonly signal: AbortSignal;
  private readonly results = new Map<string, Promise<R>>();
  private registration: Promise<void> = Promise.resolve();

  constructor(private readonly options: {
    count: number;
    operation: (index: number) => string | null;
    prepare: (index: number) => Promise<P | null>;
    key: (value: P) => string;
    execute: (index: number, value: P, signal: AbortSignal) => Promise<R>;
    signal: AbortSignal;
    concurrency?: number;
  }) {
    this.signal = AbortSignal.any([options.signal, this.controller.signal]);
  }

  async at(index: number) {
    if (this.entries.has(index)) return this.entries.get(index)!;
    const first = this.options.operation(index);
    if (!first) return undefined;
    const indices: number[] = [];
    let searched = false;
    for (let next = index; next < this.options.count; next++) {
      const operation = this.options.operation(next);
      // A search grants same-run URL provenance to a subsequent document read.
      // Load/control/write/publication/invalid calls are barriers too.
      if (!operation || (searched && operation === "web.read_document")) break;
      searched ||= operation === "web.search";
      indices.push(next);
    }
    if (indices.length < 2) return undefined;
    const pending = indices.map(i => {
      let resolve!: (value: { value: P; result: Promise<R> } | undefined) => void;
      let reject!: (reason: unknown) => void;
      const entry = new Promise<{ value: P; result: Promise<R> } | undefined>((yes, no) => { resolve = yes; reject = no; });
      void entry.catch(() => undefined);
      this.entries.set(i, entry);
      return { index: i, resolve, reject };
    });
    let cursor = 0;
    const worker = async () => {
      while (cursor < pending.length) {
        const item = pending[cursor++]!;
        if (this.signal.aborted) { item.resolve(undefined); continue; }
        try {
          // Registration reserves shared call budgets and deduplicates ledger
          // identities. Keep that short section ordered; only I/O overlaps.
          const preparation = this.registration.then(() => this.signal.aborted ? null : this.options.prepare(item.index));
          this.registration = preparation.then(() => undefined, () => undefined);
          const value = await preparation;
          if (value === null) { item.resolve(undefined); continue; }
          const key = this.options.key(value);
          let result = this.results.get(key);
          if (!result) {
            result = this.options.execute(item.index, value, this.signal);
            this.results.set(key, result);
          }
          // Observe rejection immediately even if an earlier call is still read.
          void result.catch(() => undefined);
          item.resolve({ value, result });
          await result.catch(() => undefined);
        } catch (error) { item.reject(error); }
      }
    };
    const limit = Math.max(1, Math.min(4, Math.trunc(this.options.concurrency ?? 4)));
    for (let n = 0; n < Math.min(limit, pending.length); n++) this.jobs.push(worker());
    return this.entries.get(index)!;
  }

  async close() {
    this.controller.abort();
    await Promise.allSettled(this.jobs);
  }
}

/** Pure application reads and searches only. Domain tools must first resolve
 * to their canonical operation; visual artifacts and navigation are excluded. */
export function companionParallelReadOperation(operation: string, riskClass: string): boolean {
  return riskClass === "read" && (/^(?:notes|memory|persona|attention|goals)\.read\./.test(operation)
    || operation.startsWith("observe.") || operation === "web.search" || operation === "web.read_document");
}
