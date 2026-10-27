import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { AVATAR_MAX_BYTES } from "@astella/shared/desktop-ipc-contracts";
import { MAX_SOURCE_TEXT_BYTES, objectTransferRequestSchema, objectTransferDownloadSchema } from "@astella/shared/object-transfer-contracts";
import { validateTransferPurpose, verifyTransferredBytes } from "../routes.ts";

const base = { purpose: "companion_image" as const, fileName: "test.png", mimeType: "image/png", byteLength: 100,
  sha256: "a".repeat(64) };
test("direct uploads reject mismatched purpose, missing target, and oversized payload", () => {
  assert.throws(() => validateTransferPurpose({ ...base, purpose: "note_image" }));
  assert.throws(() => validateTransferPurpose({ ...base, mimeType: "text/html" }));
  assert.throws(() => validateTransferPurpose({ ...base, purpose: "avatar", byteLength: AVATAR_MAX_BYTES + 1 }));
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

test("avatar upload authorization accepts 10 MB and rejects a byte over the shared limit", () => {
  assert.doesNotThrow(() => validateTransferPurpose({ ...base, purpose: "avatar", byteLength: 3 * 1024 * 1024 }));
  assert.doesNotThrow(() => validateTransferPurpose({ ...base, purpose: "avatar", byteLength: AVATAR_MAX_BYTES }));
  assert.throws(() => validateTransferPurpose({ ...base, purpose: "avatar", byteLength: AVATAR_MAX_BYTES + 1 }), /too large/);
});


test("companion originals use direct transfer with the existing 20 MiB limit", () => {
  const file = { ...base, purpose: "companion_file" as const, mimeType: "application/pdf", fileName: "note.pdf" };
  assert.equal(objectTransferRequestSchema.safeParse(file).success, true);
  assert.doesNotThrow(() => validateTransferPurpose({ ...file, byteLength: 20 * 1024 * 1024 }));
  assert.throws(() => validateTransferPurpose({ ...file, byteLength: 20 * 1024 * 1024 + 1 }), /too large/);
  assert.throws(() => validateTransferPurpose({ ...file, mimeType: "application/octet-stream" }), /unsupported file type/);
});

test('S3-verified image and PDF only read a bounded header; legacy and text validate full bytes', async () => {
  const { verifiedTransferContent, HEADER_LIMIT } = await import('../transfer-integrity.ts');
  const bytes = Buffer.alloc(HEADER_LIMIT + 8192, 3);
  bytes.writeUInt32BE(0x89504e47, 0); bytes.writeUInt32BE(80,16); bytes.writeUInt32BE(60,20);
  const request = { ...base, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const head = { contentLength: bytes.length, etag: 'v1', checksumSHA256: Buffer.from(request.sha256,'hex').toString('base64') };
  let prefixReads=0, fullReads=0;
  const reads = { prefix: async (etag: string, count: number) => { prefixReads++; assert.equal(etag,'v1'); return bytes.subarray(0,count); },
    full: async () => { fullReads++; return { body: bytes, etag: 'v1' }; } };
  const result = await verifiedTransferContent(request,head,true,reads);
  assert.equal(result.verified,true); assert.equal(result.bytes.length,24); assert.equal(prefixReads,1); assert.equal(fullReads,0);
  const pdf = await verifiedTransferContent({ ...request, purpose:'companion_file',mimeType:'application/pdf' },head,true,reads);
  assert.equal(pdf.bytes.length,5);
  assert.equal(prefixReads,2); assert.equal(fullReads,0);
  const legacy = await verifiedTransferContent(request,{ contentLength:bytes.length,etag:'v1' },true,reads);
  assert.equal(legacy.verified,false); assert.equal(fullReads,1);
  await verifiedTransferContent({ ...request,purpose:'companion_file',mimeType:'text/plain' },head,true,reads);
  assert.equal(fullReads,2);
  await assert.rejects(verifiedTransferContent(request,{...head,checksumSHA256:Buffer.alloc(32).toString('base64')},true,reads),/hash mismatch/);
  await assert.rejects(verifiedTransferContent(request,{...head,contentLength:1},true,reads),/size mismatch/);
});

test('JPEG with dimensions beyond the bounded header falls back to the complete verified body', async () => {
  const { verifiedTransferContent } = await import('../transfer-integrity.ts');
  const bytes=Buffer.alloc(300000,0); bytes[0]=0xff; bytes[1]=0xd8;
  const sha256=createHash('sha256').update(bytes).digest('hex');
  const request={...base,mimeType:'image/jpeg',byteLength:bytes.length,sha256};
  let fullReads=0;
  const reads={ prefix:async (_etag:string,count:number)=>bytes.subarray(0,count),full:async()=>{fullReads++;return {body:bytes,etag:'v1'};} };
  const result=await verifiedTransferContent(request,{contentLength:bytes.length,etag:'v1',checksumSHA256:Buffer.from(sha256,'hex').toString('base64')},true,reads);
  assert.equal(result.bytes.length,bytes.length); assert.equal(fullReads,1);
  await assert.rejects(verifiedTransferContent(request,{contentLength:bytes.length,etag:'v1',checksumSHA256:Buffer.from(sha256,'hex').toString('base64')},true,
    {...reads,full:async()=>({body:bytes,etag:'v2'})}),/changed/);
});
