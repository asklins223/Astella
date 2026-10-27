import { S3Client, GetObjectCommand, HeadObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command, HeadBucketCommand } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { resolveStorageConfig } from "@astella/shared/storage-config";
import { StorageBackupQueue, throttledObjectBytes } from "./backup-queue.ts";
import { logger } from "../../lib/logger.ts";

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
  try { await getBackupQueue().enqueue(key, source, operation); }
  catch (error) { logger.error({ error: error instanceof Error ? error.message : "queue write failed" }, "backup queue admission failed; foreground object remains usable and reconciliation will retry"); }
}
export function getBackupQueue(): StorageBackupQueue {
  if (queue) return queue;
  const bytesPerSecond = positive(process.env.STORAGE_BACKUP_BYTES_PER_SECOND, 262_144);
  queue = new StorageBackupQueue(process.env.STORAGE_BACKUP_QUEUE_DIR || "/var/lib/astella/object-backup-queue", {
    async copy(job, rate, signal) {
      const source = replicaClient(job.source), destinationName = job.source === "primary" ? "backup" : "primary";
      const target = replicaClient(destinationName), sourceBucket = replicaBucket(job.source), targetBucket = replicaBucket(destinationName);
      const head = await source.send(new HeadObjectCommand({ Bucket: sourceBucket, Key: job.key }), { abortSignal: signal });
      const previous = await target.send(new HeadObjectCommand({ Bucket: targetBucket, Key: job.key }), { abortSignal: signal }).catch((error: unknown) => {
        if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404) throw error;
        return undefined;
      });
      if (previous?.Metadata?.["astella-source-etag"] === head.ETag && previous?.ContentLength === head.ContentLength) return;
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
      const keys = (result.Contents ?? []).flatMap(item => item.Key && !item.Key.startsWith("temporary/") ? [item.Key] : []);
      const next = result.NextContinuationToken ? `${location}:${result.NextContinuationToken}` : location === "primary" ? "backup:" : undefined;
      return { keys: location === "primary" ? keys : [], ...(location === "backup" ? { backupKeys: keys } : {}),
        ...(next ? { cursor: next } : {}) };
    }
  }, { bytesPerSecond, intervalMs: positive(process.env.STORAGE_BACKUP_INTERVAL_MS, 5_000),
    warn: error => logger.warn({ error: error instanceof Error ? error.message : "backup operation failed" }, "slow object backup will retry") });
  return queue;
}
