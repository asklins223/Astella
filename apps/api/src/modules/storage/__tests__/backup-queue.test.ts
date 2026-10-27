import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StorageBackupQueue, throttledObjectBytes } from "../../../lib/storage/replicas.ts";
const empty = { scan: async () => ({ keys: [] }), remove: async () => undefined };
const options = { bytesPerSecond: 262144, intervalMs: 5000, warn: (_: unknown) => undefined };
test("durable enqueue does not wait for copy; restart executes once", async () => {
 const root = await mkdtemp(join(tmpdir(), "astella-backup-"));
 try {
  let copies = 0; const transport = { ...empty, copy: async () => { copies++; } };
  const queue = new StorageBackupQueue(root, transport, options);
  await queue.enqueue("room/image.jpg", "primary"); assert.equal(copies, 0);
  const reopened = new StorageBackupQueue(root, transport, options);
  assert.equal(await reopened.runOnce(), true); assert.equal(copies, 1);
  assert.equal(await reopened.runOnce(), false); assert.equal(copies, 1);
 } finally { await rm(root, { recursive: true, force: true }); }
});
test("older in-flight copy preserves a newer delete and a second consumer cannot start", async () => {
 const root = await mkdtemp(join(tmpdir(), "astella-backup-"));
 try {
  let release!: () => void, entered!: () => void, deleted = 0;
  const began = new Promise<void>(r => { entered = r; }), wait = new Promise<void>(r => { release = r; });
  const transport = { ...empty, copy: async () => { entered(); await wait; }, remove: async () => { deleted++; } };
  const queue = new StorageBackupQueue(root, transport, options), other = new StorageBackupQueue(root, transport, options);
  await queue.enqueue("room/image.jpg", "primary"); const running = queue.runOnce(); await began;
  assert.equal(await other.runOnce(), false);
  await queue.enqueue("room/image.jpg", "primary", "delete"); release(); await running;
  assert.equal(await queue.isDeleted("room/image.jpg"), true); await queue.runOnce(); assert.equal(deleted, 1);
 } finally { await rm(root, { recursive: true, force: true }); }
});
test("failure is retained with exponential backoff", async () => {
 const root = await mkdtemp(join(tmpdir(), "astella-backup-"));
 try {
  const queue = new StorageBackupQueue(root, { ...empty, copy: async () => { throw Error("unavailable"); } }, options);
  await queue.enqueue("room/image.jpg", "backup"); const now = Date.now(); await queue.runOnce(now);
  const name = (await readdir(root)).find(n => n.endsWith(".state"))!;
  const state = JSON.parse(await readFile(join(root, name), "utf8"));
  assert.equal(state.done, false); assert.equal(state.attempts, 1); assert.equal(state.nextAt, now + 30000);
  assert.equal(await queue.runOnce(now + 1), false);
 } finally { await rm(root, { recursive: true, force: true }); }
});
test("64 KiB burst bound and abort", async () => {
 const controller = new AbortController(); async function* bytes() { yield new Uint8Array(200000); }
 const stream = throttledObjectBytes(bytes(), 16384, controller.signal);
 assert.equal((await stream.next()).value!.byteLength, 65536); controller.abort(); await assert.rejects(stream.next());
});
