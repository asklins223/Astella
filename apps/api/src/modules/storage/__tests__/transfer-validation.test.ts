import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { MAX_SOURCE_TEXT_BYTES, objectTransferRequestSchema, objectTransferDownloadSchema } from "@astella/shared/object-transfer-contracts";
import { validateTransferPurpose, verifyTransferredBytes } from "../routes.ts";

const base = { purpose: "companion_image" as const, fileName: "test.png", mimeType: "image/png", byteLength: 100,
  sha256: "a".repeat(64) };
test("direct uploads reject mismatched purpose, missing target, and oversized payload", () => {
  assert.throws(() => validateTransferPurpose({ ...base, purpose: "note_image" }));
  assert.throws(() => validateTransferPurpose({ ...base, mimeType: "text/html" }));
  assert.throws(() => validateTransferPurpose({ ...base, purpose: "avatar", byteLength: 3 * 1024 * 1024 }));
  assert.throws(() => validateTransferPurpose({ ...base, purpose: "source_text", mimeType: "text/plain", byteLength: MAX_SOURCE_TEXT_BYTES + 1 }));
  assert.equal(objectTransferRequestSchema.safeParse({ ...base, objectKey: "another-user/file" }).success, false);
});
test("imported markdown images are capped by what the reading layer can actually fetch", () => {
  const image = { ...base, purpose: "markdown_import_image" as const };
  assert.equal(objectTransferRequestSchema.safeParse(image).success, true);
  assert.doesNotThrow(() => validateTransferPurpose({ ...image, byteLength: 5_000_000 }));
  assert.throws(() => validateTransferPurpose({ ...image, byteLength: 5_000_001 }), /too large/);
  assert.throws(() => validateTransferPurpose({ ...image, mimeType: "image/svg+xml" }), /unsupported file type/);
});
test("upload confirmation detects modified bytes and truncation", () => {
  const bytes = Buffer.from("original upload");
  const expected = { byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  assert.equal(verifyTransferredBytes(bytes, expected), true);
  assert.equal(verifyTransferredBytes(Buffer.from("modified upload"), expected), false);
  assert.equal(verifyTransferredBytes(bytes.subarray(1), expected), false);
});
test("download descriptors reject insecure, credential-bearing and unbounded URLs", () => {
  const ticket = { version: 1, kind: "object_download", url: "https://objects.example.test/file?signature=s",
    contentType: "image/png", byteLength: 100, expiresAt: new Date().toISOString() };
  assert.equal(objectTransferDownloadSchema.safeParse(ticket).success, true);
  assert.equal(objectTransferDownloadSchema.safeParse({ ...ticket, url: "http://objects.example.test/file" }).success, false);
  assert.equal(objectTransferDownloadSchema.safeParse({ ...ticket, url: "https://user:secret@objects.example.test/file" }).success, false);
  assert.equal(objectTransferDownloadSchema.safeParse({ ...ticket, byteLength: 1024 ** 3 }).success, false);
});
