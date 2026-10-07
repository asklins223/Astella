/** Synthetic fixtures only; run against a separate PostgreSQL database and the configured private S3 bucket. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import postgres from "postgres";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import multipart from "@fastify/multipart";
import { S3Client, ListObjectsV2Command, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { objectTransferDownloadSchema } from "@astella/shared/object-transfer-contracts";
import { resolveStorageConfig } from "@astella/shared/storage-config";

assert.equal(process.env.STORAGE_MODE, "remote", "this test requires explicit remote storage mode");
const databaseUrl = process.env.DATABASE_URL_TEST_ADMIN;
assert.ok(databaseUrl, "a dedicated integration admin database URL is required");
assert.match(new URL(databaseUrl).pathname, /^\/astella_storage_it_[a-z0-9_]+$/, "use a disposable astella_storage_it_* database");
const database = postgres(databaseUrl, { max: 2 });
const { objectTransferRoutes } = await import("../modules/storage/routes.ts");
const { objectExportHook } = await import("../modules/storage/exports.ts");
const { uploadRoutes } = await import("../modules/upload/routes.ts");
const { sourceRoutes } = await import("../modules/source/routes.ts");
const { exportRoutes } = await import("../modules/export/routes.ts");
const { companionExportRoutes } = await import("../modules/companion-conversation/routes.ts");
const { closeDatabase } = await import("../db/client.ts");
const { runParseSource } = await import("../../../../workers/ai-worker/src/handlers/parse-source.ts");
const workerDb = await import("../../../../workers/ai-worker/src/db.ts");
const fixtures = Array.from({ length: 2 }, () => ({ userId: randomUUID(), workspaceId: randomUUID(), token: `storage-test-${randomUUID()}` }));
const app = Fastify({ logger: false });
await app.register(sensible);
await app.register(multipart);
app.addHook("onSend", objectExportHook);
await app.register(objectTransferRoutes);
await app.register(uploadRoutes);
await app.register(sourceRoutes);
await app.register(exportRoutes);
await app.register(companionExportRoutes);

for (const fixture of fixtures) {
  await database`INSERT INTO users(id,email,password_hash,role) VALUES(${fixture.userId},${`storage-${fixture.userId}@example.test`},'test','owner')`;
  await database`INSERT INTO workspaces(id,name,owner_id) VALUES(${fixture.workspaceId},'Storage test',${fixture.userId})`;
  await database`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${fixture.workspaceId},${fixture.userId},'owner')`;
  await database`INSERT INTO sessions(token,user_id,workspace_id,expires_at) VALUES(${createHash("sha256").update(fixture.token).digest("hex")},${fixture.userId},${fixture.workspaceId},now()+interval '1 hour')`;
}

const config = resolveStorageConfig(process.env)!;
const storage = new S3Client({ endpoint: config.endpoint, region: config.region, forcePathStyle: true,
  credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" });
after(async () => {
  for (const f of fixtures) for (const prefix of [f.workspaceId + "/", `avatars/${f.userId}/`,
    `temporary/uploads/${f.workspaceId}/`, `temporary/exports/${f.workspaceId}/`]) {
    const listed = await storage.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: prefix }));
    for (const object of listed.Contents ?? []) if (object.Key)
      await storage.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: object.Key }));
  }
  storage.destroy(); await app.close(); await closeDatabase(); await workerDb.closeDatabase(); await database.end({ timeout: 2 });
});

const fixture = fixtures[0]!;
const headers = (other = false) => ({ authorization: `Bearer ${fixtures[other ? 1 : 0]!.token}`, "x-astella-object-transfer-accept": "1" });
async function prepare(purpose: "source_text" | "note_image" | "avatar" | "companion_image" | "markdown_import",
  bytes: Buffer, extra: Record<string, unknown> = {}) {
  const result = await app.inject({ method: "POST", url: "/storage/transfers", headers: headers(), payload: {
    purpose, fileName: purpose === "source_text" ? "test.md" : "test.png", mimeType: purpose === "source_text" ? "text/markdown" : "image/png",
    byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), ...extra,
  } });
  assert.equal(result.statusCode, 200, result.statusCode >= 300 ? result.body : "");
  return result.json<{ transferId: string; url: string; headers: Record<string, string> }>();
}
async function put(grant: { url: string; headers: Record<string, string> }, bytes: Buffer) {
  const response = await fetch(grant.url, { method: "PUT", headers: grant.headers, body: new Uint8Array(bytes), redirect: "manual" });
  assert.equal(response.status, 200, "private signed PUT must succeed"); await response.body?.cancel();
}
async function download(body: unknown) {
  const descriptor = objectTransferDownloadSchema.parse(body);
  const response = await fetch(descriptor.url, { redirect: "manual" });
  assert.equal(response.status, 200, "private signed GET must succeed");
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.length, descriptor.byteLength);
  if (descriptor.sha256) assert.equal(createHash("sha256").update(bytes).digest("hex"), descriptor.sha256);
  const unsigned = new URL(descriptor.url); unsigned.search = "";
  const anonymous = await fetch(unsigned, { redirect: "manual" });
  assert.equal(anonymous.status, 403, "objects must not be publicly readable"); await anonymous.body?.cancel();
  return bytes;
}

test("private remote storage: direct source upload, worker parse, note images, receipt replay, and exports", async () => {
  assert.equal((await app.inject({ method: "POST", url: "/storage/transfers", payload: {} })).statusCode, 401);
  const sourceBytes = Buffer.from("# Synthetic source\n\nA private learning note used only for the storage integration test.");
  const grant = await prepare("source_text", sourceBytes, { source: { type: "markdown", title: "Storage fixture" } });
  await put(grant, sourceBytes);
  assert.equal((await app.inject({ method: "POST", url: `/storage/transfers/${grant.transferId}/complete`, headers: headers(true) })).statusCode, 404);
  const completed = await app.inject({ method: "POST", url: `/storage/transfers/${grant.transferId}/complete`, headers: headers() });
  assert.equal(completed.statusCode, 200, completed.statusCode >= 300 ? completed.body : "");
  const sourceId = completed.json<{ source: { id: string } }>().source.id;
  const [source] = await database`SELECT metadata FROM sources WHERE id=${sourceId}`;
  assert.equal(typeof source!.metadata.storageObjectKey, "string");
  assert.equal(source!.metadata.rawContent, undefined);
  const leaseToken = randomUUID();
  const [job] = await database`UPDATE jobs SET status='running',lease_token=${leaseToken},started_at=now()
    WHERE workspace_id=${fixture.workspaceId} AND type='parse_source' RETURNING id,payload`;
  assert.ok(job);
  await runParseSource({ id: job.id, workspaceId: fixture.workspaceId, requestedBy: fixture.userId, leaseToken, payload: job.payload });
  await database`UPDATE jobs SET status='succeeded',finished_at=now() WHERE id=${job.id}`;
  const createdNote = await app.inject({ method: "POST", url: `/sources/${sourceId}/create-note`, headers: headers() });
  assert.equal(createdNote.statusCode, 200, createdNote.statusCode >= 300 ? createdNote.body : "");
  const noteId = createdNote.json<{ note: { id: string } }>().note.id;
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0j0AAAAASUVORK5CYII=", "base64");
  // An owner cannot obtain a signed upload for another user's private note in the same workspace.
  await database`UPDATE notes SET created_by=${fixtures[1]!.userId},share_scope='private' WHERE id=${noteId}`;
  try {
    const hidden = await app.inject({ method: "POST", url: "/storage/transfers", headers: headers(), payload: {
      purpose: "note_image", fileName: "private.png", mimeType: "image/png", byteLength: png.length,
      sha256: createHash("sha256").update(png).digest("hex"), noteId,
    } });
    assert.equal(hidden.statusCode, 404, "private note must be invisible before issuing an upload URL");
  } finally { await database`UPDATE notes SET created_by=${fixture.userId} WHERE id=${noteId}`; }
  const imageGrant = await prepare("note_image", png, { noteId });
  await put(imageGrant, png);
  const confirmed = await app.inject({ method: "POST", url: `/storage/transfers/${imageGrant.transferId}/complete`, headers: headers() });
  assert.equal(confirmed.statusCode, 201, confirmed.statusCode >= 300 ? confirmed.body : "");
  const image = confirmed.json<{ objectKey: string }>();
  const repeat = await app.inject({ method: "POST", url: `/storage/transfers/${imageGrant.transferId}/complete`, headers: headers() });
  assert.equal(repeat.statusCode, 201); assert.deepEqual(repeat.json(), confirmed.json());
  assert.equal((await database`SELECT count(*)::int AS count FROM note_image_assets WHERE object_key=${image.objectKey}`)[0]!.count, 1);
  const denied = await app.inject({ method: "GET", url: `/uploads/${image.objectKey}`, headers: headers(true) });
  assert.equal(denied.statusCode, 404);
  const downloaded = await app.inject({ method: "GET", url: `/uploads/${image.objectKey}`, headers: headers() });
  assert.equal(downloaded.headers["x-astella-object-transfer"], "1");
  assert.deepEqual(await download(downloaded.json()), png);
  const modified = Buffer.from(png); modified[modified.length - 1] ^= 1;
  await put(imageGrant, modified);
  const again = await app.inject({ method: "GET", url: `/uploads/${image.objectKey}`, headers: headers() });
  assert.deepEqual(await download(again.json()), png, "replaying a staging URL cannot change the committed image");
  const tamperedGrant = await prepare("companion_image", png); await put(tamperedGrant, modified);
  const tampered = await app.inject({ method: "POST", url: `/storage/transfers/${tamperedGrant.transferId}/complete`, headers: headers() });
  assert.equal(tampered.statusCode, 400);
  for (const purpose of ["avatar", "companion_image"] as const) {
    const uploaded = await prepare(purpose, png); await put(uploaded, png);
    const receipt = await app.inject({ method: "POST", url: `/storage/transfers/${uploaded.transferId}/complete`, headers: headers() });
    assert.equal(receipt.statusCode, 201, receipt.statusCode >= 300 ? receipt.body : "");
  }
  for (const path of [`/export/notes/${noteId}`, "/export/workspace", "/companion/export"]) {
    const response = await app.inject({ method: "GET", url: path, headers: headers() });
    assert.equal(response.statusCode, 200, response.statusCode >= 300 ? response.body : "");
    assert.equal(response.headers["x-astella-object-transfer"], "1");
    const bytes = await download(response.json()); assert.ok(bytes.length > 0);
  }
  const legacy = await app.inject({ method: "GET", url: `/export/notes/${noteId}`, headers: { authorization: `Bearer ${fixture.token}` } });
  assert.equal(legacy.headers["x-astella-object-transfer"], undefined); assert.ok(legacy.body.includes("Synthetic source"));
});
