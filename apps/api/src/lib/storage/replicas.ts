import { S3Client, GetObjectCommand, HeadObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command, HeadBucketCommand } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { Readable } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { resolveStorageConfig } from "@astella/shared/storage-config";
import { logger } from "../logger.ts";
import { shouldBackUpObject } from "./chat-catalog.ts";
import { isChatObjectKey, replicaCopyMayRun, inNightlyBackupWindow, backupHours } from "./policy.ts";

export type StorageLocation = "primary" | "backup";
let backup: S3Client | undefined;
let primary: S3Client | undefined;
let queue: StorageBackupQueue | undefined;
let health: { location: StorageLocation; expires: number } | undefined;
let probing: Promise<StorageLocation> | undefined;
const positive = (value: string | undefined, fallback: number) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
export function backupEnabled(): boolean { return process.env.STORAGE_MODE === "remote" && process.env.STORAGE_BACKUP_ENABLED === "true"; }
export function backupBucket(): string { return process.env.STORAGE_BACKUP_BUCKET?.trim() || "astella-backup"; }
export function backupPublicOrigin(): string | undefined {
  const value = process.env.STORAGE_BACKUP_PUBLIC_ENDPOINT?.trim();
  if (!value) return undefined;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/") throw new Error("backup endpoint must be an HTTPS origin");
  return url.origin;
}
export function replicaClient(location: StorageLocation): S3Client {
  if (location === "primary") {
    if (primary) return primary;
    const config = resolveStorageConfig(process.env);
    if (!config) throw new Error("primary storage configuration incomplete");
    return primary = new S3Client({ endpoint: config.endpoint, region: config.region,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }, forcePathStyle: true,
      maxAttempts: 1, requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
      requestHandler: new NodeHttpHandler({ connectionTimeout: 3_000, requestTimeout: 0, socketTimeout: 30_000 }) });
  }
  if (backup) return backup;
  const endpoint = process.env.STORAGE_BACKUP_ENDPOINT?.trim(), accessKeyId = process.env.STORAGE_BACKUP_ACCESS_KEY_ID?.trim(),
    secretAccessKey = process.env.STORAGE_BACKUP_SECRET_ACCESS_KEY?.trim();
  if (!endpoint || !accessKeyId || !secretAccessKey) throw new Error("backup storage configuration incomplete");
  return backup = new S3Client({ endpoint, region: process.env.STORAGE_BACKUP_REGION?.trim() || "us-east-1",
    credentials: { accessKeyId, secretAccessKey }, forcePathStyle: true, maxAttempts: 1,
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: new NodeHttpHandler({ connectionTimeout: 3_000, requestTimeout: 0, socketTimeout: 30_000 }) });
}
export function replicaBucket(location: StorageLocation): string {
  return location === "backup" ? backupBucket() : resolveStorageConfig(process.env)!.bucket;
}
export function markPrimaryUnavailable(): void { health = { location: "backup", expires: Date.now() + 15_000 }; }
/** Cache and coalesce the cheap health probe; don't wait 120s for an unavailable origin. */
export async function activeStorageLocation(): Promise<StorageLocation> {
  if (!backupEnabled()) return "primary";
  if (health && health.expires > Date.now()) return health.location;
  if (probing) return probing;
  probing = (async () => {
    let location: StorageLocation = "primary";
    try { await replicaClient("primary").send(new HeadBucketCommand({ Bucket: replicaBucket("primary") }), { abortSignal: AbortSignal.timeout(2_500) }); }
    catch { location = "backup"; }
    if (location === "backup") await replicaClient("backup").send(new HeadBucketCommand({ Bucket: backupBucket() }), { abortSignal: AbortSignal.timeout(2_500) });
    health = { location, expires: Date.now() + (location === "primary" ? 30_000 : 15_000) };
    return location;
  })();
  try { return await probing; } finally { probing = undefined; }
}
export async function locationForObject(key: string): Promise<StorageLocation> {
  if (!backupEnabled()) return "primary";
  if (await getBackupQueue().isDeleted(key)) throw Object.assign(new Error("object deleted"), { $metadata: { httpStatusCode: 404 } });
  const active = await activeStorageLocation();
  try { await replicaClient(active).send(new HeadObjectCommand({ Bucket: replicaBucket(active), Key: key }), { abortSignal: AbortSignal.timeout(3_500) }); return active; }
  catch (error) {
    // A local-only write may still be awaiting its slow recovery copy even after cloud recovery.
    const other = active === "primary" ? "backup" : "primary";
    if (active === "backup") throw error; // Don't retry a known-unavailable cloud for every missing key.
    await replicaClient(other).send(new HeadObjectCommand({ Bucket: replicaBucket(other), Key: key }), { abortSignal: AbortSignal.timeout(3_500) });
    return other;
  }
}
export async function enqueueReplica(key: string, source: StorageLocation, operation: "copy" | "delete" = "copy"): Promise<void> {
  if (!backupEnabled()) return;
  if (operation === 'copy' && source === 'primary' && !await shouldBackUpObject(key)) return;
  try { await getBackupQueue().enqueue(key, source, operation); }
  catch (error) { logger.error({ error: error instanceof Error ? error.message : "queue write failed" }, "backup queue admission failed; foreground object remains usable and reconciliation will retry"); }
}
export function getBackupQueue(): StorageBackupQueue {
  if (queue) return queue;
  const bytesPerSecond = positive(process.env.STORAGE_BACKUP_BYTES_PER_SECOND, 262_144);
  const hours = backupHours(process.env);
  queue = new StorageBackupQueue(process.env.STORAGE_BACKUP_QUEUE_DIR || "/var/lib/astella/object-backup-queue", {
    async copy(job, rate, signal) {
      const retained = await shouldBackUpObject(job.key);
      if (job.source === 'primary' && !retained) {
        // Remove legacy chat replicas only after confirming the cloud original.
        // A local-only outage upload must never be removed before recovery.
        if (isChatObjectKey(job.key)) {
          await replicaClient('primary').send(new HeadObjectCommand({ Bucket: replicaBucket('primary'), Key: job.key }), { abortSignal: signal });
          await replicaClient('backup').send(new DeleteObjectCommand({ Bucket: backupBucket(), Key: job.key }), { abortSignal: signal });
        }
        return;
      }
      const source = replicaClient(job.source), destinationName = job.source === "primary" ? "backup" : "primary";
      const target = replicaClient(destinationName), sourceBucket = replicaBucket(job.source), targetBucket = replicaBucket(destinationName);
      const head = await source.send(new HeadObjectCommand({ Bucket: sourceBucket, Key: job.key }), { abortSignal: signal });
      const previous = await target.send(new HeadObjectCommand({ Bucket: targetBucket, Key: job.key }), { abortSignal: signal }).catch((error: unknown) => {
        if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404) throw error;
        return undefined;
      });
      const removeTransientReplica = async () => {
        if (job.source === 'backup' && !retained) await source.send(new DeleteObjectCommand({ Bucket: sourceBucket, Key: job.key }), { abortSignal: signal });
      };
      if (previous?.Metadata?.["astella-source-etag"] === head.ETag && previous?.ContentLength === head.ContentLength) {
        await removeTransientReplica(); return;
      }
      const object = await source.send(new GetObjectCommand({ Bucket: sourceBucket, Key: job.key, IfMatch: head.ETag }), { abortSignal: signal });
      if (!object.Body) throw new Error("backup source has no body");
      const hash = createHash("sha256"); let count = 0;
      const input = object.Body as AsyncIterable<Uint8Array>;
      async function* bytes() {
        for await (const chunk of throttledObjectBytes(input, rate, signal)) { hash.update(chunk); count += chunk.byteLength; yield chunk; }
      }
      const stream = Readable.from(bytes());
      try {
        await target.send(new PutObjectCommand({ Bucket: targetBucket, Key: job.key, Body: stream,
          ContentLength: head.ContentLength, ContentType: object.ContentType,
          Metadata: { ...object.Metadata, "astella-source-etag": head.ETag ?? "" } }), { abortSignal: signal });
        const expected = object.Metadata?.["astella-sha256"];
        if (count !== head.ContentLength || (expected && hash.digest("hex") !== expected)) {
          await target.send(new DeleteObjectCommand({ Bucket: targetBucket, Key: job.key }), { abortSignal: signal });
          throw new Error("backup object integrity mismatch");
        }
        if (job.source === "backup") health = undefined;
        await removeTransientReplica();
      } finally { stream.destroy(); }
    },
    async remove(job, signal) {
      await Promise.all((["primary", "backup"] as const).map(location => replicaClient(location).send(
        new DeleteObjectCommand({ Bucket: replicaBucket(location), Key: job.key }), { abortSignal: signal })));
    },
    async scan(cursor, signal) {
      const location: StorageLocation = cursor?.startsWith("backup:") ? "backup" : "primary";
      const token = cursor?.includes(":") ? cursor.slice(cursor.indexOf(":") + 1) : undefined;
      const result = await replicaClient(location).send(new ListObjectsV2Command({ Bucket: replicaBucket(location), MaxKeys: 100,
        ...(token ? { ContinuationToken: token } : {}) }), { abortSignal: signal });
      const keys: string[] = [];
      for (const item of result.Contents ?? []) if (item.Key && !item.Key.startsWith('temporary/')
        && (location === 'backup' || await shouldBackUpObject(item.Key))) keys.push(item.Key);
      const next = result.NextContinuationToken ? `${location}:${result.NextContinuationToken}` : location === "primary" ? "backup:" : undefined;
      return { keys: location === "primary" ? keys : [], ...(location === "backup" ? { backupKeys: keys } : {}),
        ...(next ? { cursor: next } : {}) };
    }
  }, { bytesPerSecond, intervalMs: positive(process.env.STORAGE_BACKUP_INTERVAL_MS, 5_000), allowCopy: (job, now) => replicaCopyMayRun(job, now, hours),
    allowScan: now => inNightlyBackupWindow(now, hours),
    warn: error => logger.warn({ error: error instanceof Error ? error.message : "backup operation failed" }, "slow object backup will retry") });
  return queue;
}

export type ReplicaJob = { key: string; source: "primary" | "backup"; operation: "copy" | "delete";
  revision: string; attempts: number; nextAt: number; done: boolean; updatedAt: number; policyVersion?: number };
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
      allowCopy?: (job: ReplicaJob, now: number) => boolean; allowScan?: (now: number) => boolean;
      warn: (error: unknown) => void }) {}
  private file(key: string): string { return join(this.directory, createHash("sha256").update(key).digest("hex") + ".json"); }
  async enqueue(key: string, source: ReplicaJob["source"], operation: ReplicaJob["operation"] = "copy"): Promise<void> {
    if (key.startsWith("temporary/")) return;
    if (!key || key.includes("..") || key.startsWith("/")) throw new Error("invalid backup object key");
    const previous = this.pending.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      const job: ReplicaJob = { key, source, operation, revision: randomUUID(), attempts: 0,
        nextAt: Date.now(), done: false, updatedAt: Date.now(), policyVersion: 2 };
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
        if (!job || (job.done && job.policyVersion === 2) || job.nextAt > now) continue;
        if (job.operation === 'copy' && this.options.allowCopy && !this.options.allowCopy(job, now)) continue;
        try {
          if (job.operation === "copy") await this.transport.copy(job, this.options.bytesPerSecond, this.abort.signal);
          else await this.transport.remove(job, this.abort.signal);
          // A concurrent delete/replacement must keep its own queued intent.
          if ((await this.read(this.file(job.key)))?.revision === job.revision) await this.saveState({ ...job, done: true, updatedAt: Date.now(), policyVersion: 2 });
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
      if (now >= this.nextScan && (!this.options.allowScan || this.options.allowScan(now))) {
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
