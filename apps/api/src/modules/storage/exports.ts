import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { WorkspaceTransactionContext } from "../../db/client.ts";
import { signObjectDownload, uploadObject, uploadObjectFile, usesRemoteStorage } from "../../lib/object-storage.ts";
import { OBJECT_TRANSFER_HEADER, OBJECT_TRANSFER_MAX_BYTES, type ObjectTransferDownload } from "@astella/shared/object-transfer-contracts";

export async function storeExport(scope: WorkspaceTransactionContext, contentType: string, bytes: Buffer): Promise<ObjectTransferDownload> {
  if (bytes.length > OBJECT_TRANSFER_MAX_BYTES) throw Object.assign(new Error("export too large"), { statusCode: 413 });
  const key = `temporary/exports/${scope.workspaceId}/${scope.userId}/${randomUUID()}`;
  await uploadObject(key, bytes, contentType);
  return signObjectDownload(key, contentType, bytes.length, createHash("sha256").update(bytes).digest("hex"));
}

export function sendObjectDescriptor(reply: FastifyReply, descriptor: ObjectTransferDownload): FastifyReply {
  return reply.header(OBJECT_TRANSFER_HEADER, "1").header("Cache-Control", "no-store")
    .header("Content-Type", "application/json").removeHeader("Content-Encoding").send(descriptor);
}

/** Streaming exports spool to a bounded temporary file, not a giant in-memory array. */
export async function spoolObjectExport<T>(scope: WorkspaceTransactionContext, contentType: string,
  generate: (write: (line: string) => Promise<void>) => Promise<T>,
  ready: (result: T, descriptor: ObjectTransferDownload, filePath: string) => Promise<void>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "astella-export-"));
  const path = join(directory, "export");
  const handle = await open(path, "w", 0o600);
  const hash = createHash("sha256");
  let byteLength = 0;
  try {
    const result = await generate(async line => {
      const bytes = Buffer.from(`${line}\n`);
      byteLength += bytes.length;
      if (byteLength > OBJECT_TRANSFER_MAX_BYTES) throw Object.assign(new Error("export too large"), { statusCode: 413 });
      hash.update(bytes); await handle.write(bytes);
    });
    await handle.close();
    if (byteLength) {
      const key = `temporary/exports/${scope.workspaceId}/${scope.userId}/${randomUUID()}`;
      await uploadObjectFile(key, createReadStream(path), contentType, (await stat(path)).size);
      const descriptor = await signObjectDownload(key, contentType, byteLength, hash.digest("hex"));
      await ready(result, descriptor, path);
    }
    return result;
  } finally { await handle.close().catch(() => undefined); await rm(directory, { recursive: true, force: true }); }
}

export { usesRemoteStorage };

/** Runs before compression; old clients still receive their established body format. */
export async function objectExportHook(req: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> {
  if (!usesRemoteStorage() || reply.statusCode !== 200 || !req.session
    || !/^(\/export\/workspace|\/export\/notes\/[a-f0-9-]+|\/companion\/memory\/export|\/me\/companion\/audit\/export)(\?|$)/.test(req.url)
    || (typeof payload !== "string" && !Buffer.isBuffer(payload))) return payload;
  const type = String(reply.getHeader("Content-Type") ?? "application/json").split(";")[0];
  const descriptor = await storeExport({ workspaceId: req.session.workspaceId, userId: req.session.userId }, type, Buffer.from(payload));
  if (req.headers["x-astella-object-transfer-accept"] !== "1") return payload;
  reply.header(OBJECT_TRANSFER_HEADER, "1").header("Cache-Control", "no-store").header("Content-Type", "application/json")
    .removeHeader("Content-Encoding").removeHeader("Content-Length");
  return JSON.stringify(descriptor);
}
