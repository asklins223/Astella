/** Real S3 streaming/failover test, only two disposable loopback MinIO containers. */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S3Client, CreateBucketCommand, GetObjectCommand } from "@aws-sdk/client-s3";

const enabled = process.env.ASTELLA_RUN_STORAGE_REPLICA_TEST === "1";
test("streamed standby, primary outage, new local write, slow recovery and deletion", { skip: !enabled, timeout: 120000 }, async () => {
 const suffix = `${process.pid}`, names = [`astella-replica-qa-primary-${suffix}`, `astella-replica-qa-backup-${suffix}`];
 const root = await mkdtemp(join(tmpdir(), "astella-replica-it-"));
 const credentials = { accessKeyId: "astella-replica-test", secretAccessKey: "disposable-replica-test-password" };
 const ports = [19181, 19182]; const clients: S3Client[] = [];
 try {
  for (let index = 0; index < 2; index++) {
   execFileSync("docker", ["run", "-d", "--rm", "--name", names[index]!, "--cpus", "0.5", "--memory", "512m", "-p", `127.0.0.1:${ports[index]}:9000`, "-e", `MINIO_ROOT_USER=${credentials.accessKeyId}`, "-e", `MINIO_ROOT_PASSWORD=${credentials.secretAccessKey}`, "minio/minio:RELEASE.2024-12-18T13-15-44Z", "server", "/data"], { stdio: "pipe" });
   clients.push(new S3Client({ endpoint: `http://127.0.0.1:${ports[index]}`, region: "us-east-1", credentials, forcePathStyle: true, maxAttempts: 1,
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" }));
   let ready = false;
   for (let attempt = 0; attempt < 30; attempt++) {
    try { await clients[index]!.send(new CreateBucketCommand({ Bucket: "astella-replica-it" })); ready = true; break; }
    catch { await new Promise(r => setTimeout(r, 500)); }
   }
   assert.equal(ready, true, "disposable MinIO must become ready");
  }
  Object.assign(process.env, { STORAGE_MODE: "remote", STORAGE_ENDPOINT: "http://127.0.0.1:19181", S3_REGION: "us-east-1", S3_BUCKET: "astella-replica-it",
   STORAGE_ACCESS_KEY_ID: credentials.accessKeyId, STORAGE_SECRET_ACCESS_KEY: credentials.secretAccessKey,
   STORAGE_BACKUP_ENABLED: "true", STORAGE_BACKUP_ENDPOINT: "http://127.0.0.1:19182", STORAGE_BACKUP_BUCKET: "astella-replica-it",
   STORAGE_BACKUP_ACCESS_KEY_ID: credentials.accessKeyId, STORAGE_BACKUP_SECRET_ACCESS_KEY: credentials.secretAccessKey,
   STORAGE_BACKUP_QUEUE_DIR: root, STORAGE_BACKUP_BYTES_PER_SECOND: "131072" });
  const storage = await import("../lib/object-storage.ts"), replicas = await import("../lib/storage/replicas.ts");
  const bytes = Buffer.alloc(256 * 1024, 0x53), key = "room/companion/image.jpg";
  await storage.uploadObject(key, bytes, "image/jpeg");
  assert.equal(await replicas.getBackupQueue().runOnce(), true);
  const mirrored = await clients[1]!.send(new GetObjectCommand({ Bucket: "astella-replica-it", Key: key }));
  assert.equal(createHash("sha256").update(await mirrored.Body!.transformToByteArray()).digest("hex"), createHash("sha256").update(bytes).digest("hex"));
  execFileSync("docker", ["stop", "--time", "2", names[0]!], { stdio: "pipe" });
  replicas.markPrimaryUnavailable();
  assert.deepEqual((await storage.getObject(key)).body, bytes);
  const localKey = "room/companion/during-outage.jpg", localBytes = Buffer.from("new object while the cloud is unavailable");
  await storage.uploadObject(localKey, localBytes, "image/jpeg");
  assert.deepEqual((await storage.getObject(localKey)).body, localBytes);
  // A stopped --rm container is replaced as an empty recovered primary; recovery uses only queued local writes.
  execFileSync("docker", ["run", "-d", "--rm", "--name", names[0]!, "--cpus", "0.5", "--memory", "512m", "-p", "127.0.0.1:19181:9000", "-e", `MINIO_ROOT_USER=${credentials.accessKeyId}`, "-e", `MINIO_ROOT_PASSWORD=${credentials.secretAccessKey}`, "minio/minio:RELEASE.2024-12-18T13-15-44Z", "server", "/data"], { stdio: "pipe" });
  for (let attempt = 0; ; attempt++) {
   try { await clients[0]!.send(new CreateBucketCommand({ Bucket: "astella-replica-it" })); break; }
   catch (error) { if (attempt === 30) throw error; await new Promise(r => setTimeout(r, 500)); }
  }
  await replicas.getBackupQueue().runOnce();
  assert.deepEqual((await storage.getObject(localKey, "primary")).body, localBytes);
  await storage.deleteObject(localKey);
  await assert.rejects(storage.getObject(localKey));
  await replicas.getBackupQueue().runOnce();
  for (const client of clients) await assert.rejects(client.send(new GetObjectCommand({ Bucket: "astella-replica-it", Key: localKey })));
 } finally {
  for (const client of clients) client.destroy();
  for (const name of names) try { execFileSync("docker", ["rm", "-f", name], { stdio: "pipe" }); } catch {}
  await rm(root, { recursive: true, force: true });
 }
});
