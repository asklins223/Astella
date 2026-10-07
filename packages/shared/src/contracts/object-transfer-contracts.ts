import { z } from "zod";

export const OBJECT_TRANSFER_HEADER = "X-Astella-Object-Transfer";
export const OBJECT_TRANSFER_MAX_BYTES = 256 * 1024 * 1024;
export const objectTransferPurposeSchema = z.enum(["note_image", "companion_image", "avatar", "source_text", "markdown_import"]);
export type ObjectTransferPurpose = z.infer<typeof objectTransferPurposeSchema>;
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const httpsUrl = z.string().url().refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password;
});
export const objectTransferRequestSchema = z.object({
  purpose: objectTransferPurposeSchema,
  fileName: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(100),
  byteLength: z.number().int().positive().max(50 * 1024 * 1024),
  sha256,
  noteId: z.string().uuid().optional(),
  source: z.object({ type: z.enum(["text", "markdown", "code", "url"]).optional(), title: z.string().max(500).optional(), url: z.string().url().optional(), force: z.boolean().optional() }).strict().optional(),
}).strict();
export type ObjectTransferRequest = z.infer<typeof objectTransferRequestSchema>;
export const objectTransferUploadSchema = z.object({
  version: z.literal(1),
  transferId: z.string().uuid(),
  url: httpsUrl,
  method: z.literal("PUT"),
  headers: z.record(z.string()),
  expiresAt: z.string().datetime(),
}).strict();
export const objectTransferDownloadSchema = z.object({
  version: z.literal(1),
  kind: z.literal("object_download"),
  url: httpsUrl,
  contentType: z.string().min(1).max(100),
  byteLength: z.number().int().nonnegative().max(OBJECT_TRANSFER_MAX_BYTES),
  sha256: sha256.optional(),
  expiresAt: z.string().datetime(),
}).strict();
export type ObjectTransferDownload = z.infer<typeof objectTransferDownloadSchema>;
export const objectTransferConfigurationSchema = z.object({
  version: z.literal(1),
  mode: z.enum(["local", "remote"]),
  origins: z.array(httpsUrl).max(4),
}).strict();
