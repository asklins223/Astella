import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export type ReplicaJob = { key: string; source: "primary" | "backup"; operation: "copy" | "delete";
  revision: string; attempts: number; nextAt: number; done: boolean; updatedAt: number };
export interface ReplicaTransport {
  copy(job: ReplicaJob, bytesPerSecond: number, signal: AbortSignal): Promise<void>;
  remove(job: ReplicaJob, signal: AbortSignal): Promise<void>;
  scan(cursor: string | undefined, signal: AbortSignal): Promise<{ keys: string[]; backupKeys?: string[]; cursor?: string }>;
}

/** Disk persists only queue metadata. Object bytes stream directly between S3 stores. */
export class StorageBackupQueue {
  private running?: Promise<void>;
  private readonly abort = new AbortController();
  private readonly pending = new Map<string, Promise<void>>();
  private cursor?: string;
  private nextScan = 0;
  private scanOffset = 0;
  constructor(readonly directory: string, private readonly transport: ReplicaTransport,
    private readonly options: { bytesPerSecond: number; intervalMs: number; retryBaseMs?: number;
      warn: (error: unknown) => void }) {}
  private file(key: string): string { return join(this.directory, createHash("sha256").update(key).digest("hex") + ".json"); }
  async enqueue(key: string, source: ReplicaJob["source"], operation: ReplicaJob["operation"] = "copy"): Promise<void> {
    if (key.startsWith("temporary/")) return;
    if (!key || key.includes("..") || key.startsWith("/")) throw new Error("invalid backup object key");
    const previous = this.pending.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      const job: ReplicaJob = { key, source, operation, revision: randomUUID(), attempts: 0,
        nextAt: Date.now(), done: false, updatedAt: Date.now() };
      await this.save(job);
    });
    this.pending.set(key, next);
    try { await next; } finally { if (this.pending.get(key) === next) this.pending.delete(key); }
  }
  private async save(job: ReplicaJob): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const destination = this.file(job.key), temporary = destination + "." + randomUUID() + ".tmp";
    try { await writeFile(temporary, JSON.stringify(job), { mode: 0o600 }); await rename(temporary, destination); }
    finally { await unlink(temporary).catch(() => undefined); }
  }
  private async saveState(job: ReplicaJob): Promise<void> {
    const destination = this.file(job.key) + ".state", temporary = destination + "." + randomUUID() + ".tmp";
    try { await writeFile(temporary, JSON.stringify(job), { mode: 0o600 }); await rename(temporary, destination); }
    finally { await unlink(temporary).catch(() => undefined); }
  }
  private async read(file: string): Promise<ReplicaJob | null> {
    try {
      const job = JSON.parse(await readFile(file, "utf8")) as ReplicaJob;
      const state = await readFile(file + ".state", "utf8").then(text => JSON.parse(text) as ReplicaJob).catch(() => null);
      return state?.revision === job.revision ? { ...job, ...state } : job;
    } catch { return null; }
  }
  async isDeleted(key: string): Promise<boolean> { return (await this.read(this.file(key)))?.operation === "delete"; }
  /** One consumer, also across API processes sharing the durable queue volume. */
  start(): void { this.running ??= this.loop(); }
  async stop(): Promise<void> { this.abort.abort(); await this.running; }
  async runOnce(now = Date.now()): Promise<boolean> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lock = join(this.directory, "consumer.lock");
    try { await mkdir(lock); }
    catch {
      // Heartbeat is refreshed during a long throttled transfer; reclaim only a dead process.
      const existing = await stat(lock).catch(() => null);
      if (existing && now - existing.mtimeMs > 120_000) {
        const { rmdir } = await import("node:fs/promises"); await rmdir(lock).catch(() => undefined);
      }
      return false;
    }
    const heartbeat = setInterval(() => { void import("node:fs/promises").then(fs => fs.utimes(lock, new Date(), new Date())).catch(this.options.warn); }, 20_000);
    heartbeat.unref();
    try {
      const names = (await readdir(this.directory)).filter(name => name.endsWith(".json"));
      // Bound disk reads per tick as completed receipts accumulate.
      const batch = Array.from({ length: Math.min(64, names.length) }, (_, offset) => names[(this.scanOffset + offset) % names.length]!);
      this.scanOffset = (this.scanOffset + batch.length) % Math.max(1, names.length);
      for (const name of batch) {
        const job = await this.read(join(this.directory, name));
        if (!job || job.done || job.nextAt > now) continue;
        try {
          if (job.operation === "copy") await this.transport.copy(job, this.options.bytesPerSecond, this.abort.signal);
          else await this.transport.remove(job, this.abort.signal);
          // A concurrent delete/replacement must keep its own queued intent.
          if ((await this.read(this.file(job.key)))?.revision === job.revision) await this.saveState({ ...job, done: true, updatedAt: Date.now() });
        } catch (error) {
          if (this.abort.signal.aborted) return false;
          this.options.warn(error);
          if ((await this.read(this.file(job.key)))?.revision === job.revision) {
            const attempts = job.attempts + 1;
            await this.saveState({ ...job, attempts, nextAt: now + Math.min(3_600_000, (this.options.retryBaseMs ?? 30_000) * 2 ** Math.min(attempts - 1, 10)), updatedAt: Date.now() });
          }
        }
        return true;
      }
      // Backfill pre-existing objects, slowly. Completed receipts suppress repeated downloads.
      if (now >= this.nextScan) {
        const page = await this.transport.scan(this.cursor, this.abort.signal);
        for (const key of page.keys) if (!(await this.read(this.file(key)))) await this.enqueue(key, "primary");
        for (const key of page.backupKeys ?? []) if (!(await this.read(this.file(key)))) await this.enqueue(key, "backup");
        this.cursor = page.cursor;
        this.nextScan = now + (page.cursor ? 30_000 : 3_600_000);
      }
      return false;
    } finally {
      clearInterval(heartbeat);
      const { rmdir } = await import("node:fs/promises"); await rmdir(lock).catch(() => undefined);
    }
  }
  private async loop(): Promise<void> {
    while (!this.abort.signal.aborted) {
      try { await this.runOnce(); } catch (error) { if (!this.abort.signal.aborted) this.options.warn(error); }
      try { await delay(this.options.intervalMs, undefined, { signal: this.abort.signal }); } catch { return; }
    }
  }
}

/** 64 KiB maximum burst; one stream and one object at a time, no whole-file Buffer. */
export async function* throttledObjectBytes(source: AsyncIterable<Uint8Array>, bytesPerSecond: number,
  signal: AbortSignal): AsyncGenerator<Uint8Array> {
  const rate = Math.max(16_384, bytesPerSecond);
  let nextAt = Date.now();
  for await (const input of source) {
    for (let index = 0; index < input.byteLength; index += 65_536) {
      signal.throwIfAborted();
      const part = input.subarray(index, index + 65_536);
      const wait = nextAt - Date.now();
      if (wait > 0) await delay(wait, undefined, { signal });
      yield part;
      nextAt = Math.max(nextAt, Date.now()) + part.byteLength / rate * 1_000;
    }
  }
}
