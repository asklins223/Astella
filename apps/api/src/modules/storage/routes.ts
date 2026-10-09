import { randomUUID, createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, eq, isNull, sql } from "drizzle-orm";
import { notes } from "@astella/shared/db-schema/note";
import { MAX_SOURCE_TEXT_BYTES, objectTransferRequestSchema, objectTransferUploadSchema, type ObjectTransferRequest } from "@astella/shared/object-transfer-contracts";
import { AVATAR_MAX_BYTES } from "@astella/shared/desktop-ipc-contracts";
import { SOURCE_IMAGE_MAX_BYTES } from "@astella/shared/source-image-contracts";
import { db, withWorkspaceTransaction, scopeOfSession, type WorkspaceTransactionContext } from "../../db/client.ts";
import { requireSession, isWorkspaceOwner } from "../identity/middleware.ts";
import { parseBody } from "../../lib/validate.ts";
import { storageTransferOrigins, usesRemoteStorage, signObjectUpload, getObject, headObject, deleteObject, persistObject } from "../../lib/object-storage.ts";
import { uploadNoteImage, uploadCompanionImage, uploadAvatar, uploadImportedImage } from "../upload/upload-service.ts";
import { createSource } from "../source/service.ts";
import { sourceCreateSchema } from "../source/schema.ts";
// Share the import payload contract with the established Markdown import domain.
import { importMarkdownSchema } from "../import/schema.ts";
import { visibleNotesCondition } from "../note/visibility.ts";
import { prepareMarkdownImport, importMarkdownNotes, finalizeMarkdownImport } from "../import/markdown-import-service.ts";
import { RateLimiter, createRateLimitStoreFromEnv } from "../../lib/rate-limit-store.ts";

type TransferRow = { id: string; staging_key: string; request_json: ObjectTransferRequest;
  status: "pending" | "verifying" | "completed" | "failed"; result_json: unknown; result_status: number | null; expires_at: Date };
const limiter = new RateLimiter(createRateLimitStoreFromEnv(), { windowMs: 60_000, maxAttempts: 20 });
const avatarLimiter = new RateLimiter(createRateLimitStoreFromEnv(), { windowMs: 60_000, maxAttempts: 5 });
/**
 * 导入一整个 Markdown 文件夹/zip 时，每张随文图片各要一次预签名——它和「手工往笔记里
 * 贴一张图」不是一个数量级，按笔记图片那条 20/min 走会让几百张图的导入光排队就几分钟。
 * 单独一条额度（240/min），尺寸/类型/归属校验与别的图片用途完全同一套。
 */
const bundleImageLimiter = new RateLimiter(createRateLimitStoreFromEnv(), { windowMs: 60_000, maxAttempts: 240 });

export function validateTransferPurpose(request: ObjectTransferRequest): void {
  const image = request.purpose === "note_image" || request.purpose === "companion_image"
    || request.purpose === "avatar" || request.purpose === "markdown_import_image";
  if (image && !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(request.mimeType))
    throw Object.assign(new Error("unsupported file type"), { statusCode: 415 });
  // 导入随文图片按**渲染层取得动的体积**收口（SOURCE_IMAGE_MAX_BYTES），而不是按
  // 笔记图片那条的 10MB：一张 6MB 的图存进对象存储，取图时会被通道上限拒掉，
  // 结果是「导入说收下了、笔记里永远缺一块」。在这里按能显示的数拦，失败就发生在上传这一刻。
  const max = request.purpose === "avatar" ? AVATAR_MAX_BYTES
    : request.purpose === "markdown_import_image" ? SOURCE_IMAGE_MAX_BYTES
    : image ? 10 * 1024 * 1024
    : request.purpose === "source_text" ? MAX_SOURCE_TEXT_BYTES : 50 * 1024 * 1024;
  if (request.byteLength > max) throw Object.assign(new Error("file too large"), { statusCode: 413 });
  if (request.purpose === "note_image" && !request.noteId) throw Object.assign(new Error("noteId is required"), { statusCode: 400 });
  if (request.purpose === "source_text" && request.mimeType !== "text/plain" && request.mimeType !== "text/markdown")
    throw Object.assign(new Error("unsupported source type"), { statusCode: 415 });
  if (request.purpose === "markdown_import" && request.mimeType !== "application/json")
    throw Object.assign(new Error("unsupported import type"), { statusCode: 415 });
}

export function verifyTransferredBytes(bytes: Buffer, request: Pick<ObjectTransferRequest, "byteLength" | "sha256">): boolean {
  return bytes.length === request.byteLength && createHash("sha256").update(bytes).digest("hex") === request.sha256;
}

async function commitTransfer(scope: WorkspaceTransactionContext, request: ObjectTransferRequest,
  staging: { key: string; etag: string }, bytes: Buffer): Promise<{ status: number; body: unknown }> {
  const file = { mimetype: request.mimeType, toBuffer: async () => bytes };
  if (request.purpose === "note_image" || request.purpose === "companion_image" || request.purpose === "avatar" || request.purpose === "markdown_import_image") {
    const result = request.purpose === "note_image" ? await uploadNoteImage(scope, { noteId: request.noteId!, file, staging })
      : request.purpose === "markdown_import_image" ? await uploadImportedImage(scope, { file, staging })
        : request.purpose === "companion_image" ? await uploadCompanionImage(scope, { file, staging })
          : await uploadAvatar(scope, { file, staging });
    if (result.ok) return { status: 201, body: result.body };
    const reason = result.reason;
    const status = reason === "note_not_found" ? 404 : reason === "too_large" || reason === "file_read_too_large" ? 413
      : reason === "persist_failed" || reason === "storage_upload_failed" ? 503 : 415;
    return { status, body: { error: reason, message: "文件未通过校验或保存失败" } };
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (request.purpose === "source_text") {
    const body = sourceCreateSchema.parse({ ...request.source, content: text });
    const key = `${scope.workspaceId}/files/${scope.userId}/${randomUUID()}.txt`;
    await persistObject(key, bytes, request.mimeType, staging);
    try {
      const result = await withWorkspaceTransaction(scope, tx => createSource(tx, scope.workspaceId, scope.userId, body,
        { objectKey: key, sha256: request.sha256, byteLength: bytes.length, fileName: request.fileName }));
      if (result?.duplicateOf) await deleteObject(key).catch(() => undefined);
      return { status: 200, body: result };
    } catch (error) { await deleteObject(key).catch(() => undefined); throw error; }
  }
  const body = importMarkdownSchema.parse(JSON.parse(text));
  const items = await prepareMarkdownImport(scope, body.items);
  const key = `${scope.workspaceId}/imports/${scope.userId}/${randomUUID()}.json`;
  await persistObject(key, bytes, request.mimeType, staging);
  try {
    const outcome = await withWorkspaceTransaction(scope, tx => importMarkdownNotes(tx, scope, { items, importId: body.importId ?? null }));
    return { status: 200, body: await finalizeMarkdownImport(outcome) };
  } catch (error) { await deleteObject(key).catch(() => undefined); throw error; }
}

export async function objectTransferRoutes(app: FastifyInstance): Promise<void> {
  if (usesRemoteStorage()) {
    const cleanup = setInterval(() => {
      void db.execute(sql`SELECT astella_purge_expired_object_transfers()`)
        .catch(() => app.log.warn("expired object transfer receipt cleanup failed"));
    }, 3_600_000);
    cleanup.unref();
    app.addHook("onClose", async () => { clearInterval(cleanup); });
  }
  app.addHook("preHandler", requireSession);
  app.get("/storage/transfers/config", async (_req, reply) => reply.header("Cache-Control", "no-store").send({
    version: 1, mode: usesRemoteStorage() ? "remote" : "local", origins: storageTransferOrigins(),
  }));
  app.post("/storage/transfers", async (req, reply) => {
    if (!usesRemoteStorage()) return reply.code(409).send({ error: "direct_storage_disabled" });
    const request = parseBody(app, objectTransferRequestSchema, req.body);
    validateTransferPurpose(request);
    if (!["companion_image", "avatar"].includes(request.purpose) && !isWorkspaceOwner(req.session))
      return reply.code(403).send({ error: "owner role required" });
    const image = request.purpose === "note_image" || request.purpose === "companion_image";
    const bundleImage = request.purpose === "markdown_import_image";
    const selectedLimiter = request.purpose === "avatar" ? avatarLimiter : bundleImage ? bundleImageLimiter : limiter;
    const rateKey = request.purpose === "avatar" ? `upload:avatar:user:${req.session.userId}`
      : bundleImage ? `upload:bundle-image:user:${req.session.userId}`
      : image ? `upload:image:user:${req.session.userId}` : `object-transfer:file:${req.session.userId}`;
    const decision = await selectedLimiter.consume(rateKey);
    if (!decision.allowed) return reply.header("Retry-After", "60").code(429).send({ error: "rate_limited" });
    const scope = scopeOfSession(req.session);
    const id = randomUUID();
    const key = `temporary/uploads/${scope.workspaceId}/${scope.userId}/${id}`;
    const expiresAt = new Date(Date.now() + 900_000);
    await withWorkspaceTransaction(scope, async tx => {
      if (request.purpose === "note_image") {
        const note = await tx.query.notes.findFirst({ columns: { id: true }, where: and(eq(notes.id, request.noteId!), eq(notes.workspaceId, scope.workspaceId), visibleNotesCondition(scope.userId), isNull(notes.deletedAt)) });
        if (!note) throw Object.assign(new Error("note not found"), { statusCode: 404 });
      }
      await tx.execute(sql`INSERT INTO object_transfers(id,workspace_id,user_id,purpose,staging_key,request_json,expires_at)
        VALUES(${id}::uuid,${scope.workspaceId}::uuid,${scope.userId}::uuid,${request.purpose},${key},${JSON.stringify(request)}::jsonb,${expiresAt.toISOString()}::timestamptz)`);
    });
    const url = await signObjectUpload(key, request.mimeType, request.byteLength);
    return reply.header("Cache-Control", "no-store").send(objectTransferUploadSchema.parse({ version: 1, transferId: id,
      url, method: "PUT", headers: { "Content-Type": request.mimeType, "Content-Length": String(request.byteLength) }, expiresAt: expiresAt.toISOString() }));
  });
  app.post<{ Params: { id: string } }>("/storage/transfers/:id/complete", async (req, reply) => {
    if (!usesRemoteStorage()) return reply.code(409).send({ error: "direct_storage_disabled" });
    if (!/^[a-f0-9-]{36}$/.test(req.params.id)) return reply.code(404).send({ error: "transfer_not_found" });
    const scope = scopeOfSession(req.session);
    const row = await withWorkspaceTransaction(scope, async tx => {
      const rows = await tx.execute<TransferRow>(sql`SELECT * FROM object_transfers WHERE id=${req.params.id}::uuid FOR UPDATE`);
      const transfer = rows[0];
      if (!transfer || transfer.status === "completed" || transfer.status === "failed" || transfer.status === "verifying" || new Date(transfer.expires_at).getTime() < Date.now()) return transfer;
      await tx.execute(sql`UPDATE object_transfers SET status='verifying',updated_at=now() WHERE id=${transfer.id}::uuid`);
      return { ...transfer, status: "pending" as const };
    });
    if (!row) return reply.code(404).send({ error: "transfer_not_found" });
    if (row.status === "completed" || row.status === "failed") return reply.code(row.result_status ?? 400).send(row.result_json);
    if (new Date(row.expires_at).getTime() < Date.now()) return reply.code(410).send({ error: "transfer_expired" });
    if (row.status === "verifying") return reply.header("Retry-After", "1").code(409).send({ error: "transfer_in_progress" });
    if (!["companion_image", "avatar"].includes(row.request_json.purpose) && !isWorkspaceOwner(req.session)) {
      await withWorkspaceTransaction(scope, tx => tx.execute(sql`UPDATE object_transfers SET status='pending' WHERE id=${row.id}::uuid`));
      return reply.code(403).send({ error: "owner role required" });
    }
    try {
      const request = objectTransferRequestSchema.parse(row.request_json);
      validateTransferPurpose(request);
      const head = await headObject(row.staging_key);
      if (!head || head.contentLength !== request.byteLength) throw Object.assign(new Error("uploaded file size mismatch"), { statusCode: 400 });
      const object = await getObject(row.staging_key);
      if (!verifyTransferredBytes(object.body, request)) throw Object.assign(new Error("uploaded file hash mismatch"), { statusCode: 400 });
      const result = await commitTransfer(scope, request, { key: row.staging_key, etag: object.etag }, object.body);
      await withWorkspaceTransaction(scope, tx => tx.execute(sql`UPDATE object_transfers SET status=${result.status < 300 ? "completed" : "failed"},
        result_status=${result.status},result_json=${JSON.stringify(result.body)}::jsonb,updated_at=now() WHERE id=${row.id}::uuid`));
      await deleteObject(row.staging_key).catch(() => undefined);
      return reply.code(result.status).send(result.body);
    } catch (error) {
      await withWorkspaceTransaction(scope, tx => tx.execute(sql`UPDATE object_transfers SET status='pending',updated_at=now() WHERE id=${row.id}::uuid`));
      throw error;
    }
  });
}
