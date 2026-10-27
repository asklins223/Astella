import { createHash } from "node:crypto";
import type { ObjectTransferRequest } from "@astella/shared/object-transfer-contracts";
import { readImageDimensions } from "../../lib/file-validation.ts";

export const HEADER_LIMIT = 256 * 1024;
/** Only JPEG may hide its dimensions behind large metadata segments. */
export function inspectionLength(mimeType: string, byteLength: number): number {
  const required: Record<string, number> = { 'image/png': 24, 'image/gif': 10, 'image/webp': 30,
    'application/pdf': 5, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 4 };
  return Math.min(byteLength, required[mimeType] ?? HEADER_LIMIT);
}
export function mayInspectObjectPrefix(request: Pick<ObjectTransferRequest, 'purpose' | 'mimeType'>): boolean {
  return ['note_image', 'companion_image', 'avatar', 'markdown_import_image'].includes(request.purpose)
    || (request.purpose === 'companion_file' && ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(request.mimeType));
}
export function verifyTransferredBytes(bytes: Buffer, request: Pick<ObjectTransferRequest, 'byteLength' | 'sha256'>): boolean {
  return bytes.length === request.byteLength && createHash('sha256').update(bytes).digest('hex') === request.sha256;
}
type Request = Pick<ObjectTransferRequest, 'purpose' | 'mimeType' | 'byteLength' | 'sha256'>;
type Head = { contentLength?: number; etag?: string; checksumSHA256?: string };
type Reads = { prefix(etag: string, length: number): Promise<Buffer>; full(): Promise<{ body: Buffer; etag: string }> };
/** A provider-verified signed digest allows bounded header inspection; legacy objects use a full read. */
export async function verifiedTransferContent(request: Request, head: Head | null, optimized: boolean, reads: Reads): Promise<{ bytes: Buffer; etag: string; verified: boolean }> {
  if (!head || head.contentLength !== request.byteLength) throw Object.assign(new Error('uploaded file size mismatch'), { statusCode: 400 });
  const checksum = Buffer.from(request.sha256, 'hex').toString('base64');
  if (head.checksumSHA256 && head.checksumSHA256 !== checksum) throw Object.assign(new Error('uploaded file hash mismatch'), { statusCode: 400 });
  const verified = optimized && mayInspectObjectPrefix(request) && head.checksumSHA256 === checksum && Boolean(head.etag);
  if (verified) {
    const etag = head.etag!;
    const bytes = await reads.prefix(etag, inspectionLength(request.mimeType, request.byteLength));
    if (request.mimeType !== 'image/jpeg' || bytes.length === request.byteLength || readImageDimensions(bytes, request.mimeType))
      return { bytes, etag, verified: true };
    // Unusually large JPEG EXIF can put dimensions after the first 256 KiB.
    const full = await reads.full();
    if (full.etag !== etag || !verifyTransferredBytes(full.body, request)) throw Object.assign(new Error('uploaded file changed'), { statusCode: 400 });
    return { bytes: full.body, etag, verified: true };
  }
  const full = await reads.full();
  if (!verifyTransferredBytes(full.body, request)) throw Object.assign(new Error('uploaded file hash mismatch'), { statusCode: 400 });
  return { bytes: full.body, etag: full.etag, verified: false };
}
