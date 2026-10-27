import { sql } from "drizzle-orm";
import type { AgentTurnRequest } from "@astella/shared";
import { logger } from "../../lib/logger.ts";
import { withWorkerWorkspaceTransaction } from "../../db.ts";
import { getObjectBytes } from "../../lib/object-storage.ts";
import { claimsImageContent } from "../turn/companion-reply-shape.ts";

/**
 * Put the user's pictures in front of the model directly.
 *
 * When the conversation model declares vision, the pictures the user attached
 * belong in the request, exactly like a person looking at the screen. The
 * earlier design sent only a name plus an assetId and made the model call a
 * read tool; the model then answered from the name — fluently, confidently and
 * wrongly — which is the "识图胡说" failure: the picture was never there for it
 * to look at.
 *
 * Only this turn's user message is decorated, and only when the host says the
 * model can actually see (declared `vision`). A model that cannot see gets the
 * same request it got before.
 */
const MAX_IMAGES_PER_TURN = 10;
const MAX_IMAGE_RAW_BYTES = 4_000_000;
/** Total decoded bytes for one request; providers reject very large bodies. */
const MAX_TOTAL_RAW_BYTES = 12_000_000;

export interface CompanionImageAttachment {
  readonly assetId: string;
  readonly label?: string;
}

type ImageRow = {
  id: string;
  object_key: string;
  mime_type: string;
  byte_size: number;
} & Record<string, unknown>;

export async function loadCompanionAttachmentImages(input: {
  workspaceId: string;
  userId: string;
  attachments: readonly CompanionImageAttachment[];
  runId: string;
}): Promise<Array<{ assetId: string; mimeType: string; bytes: Buffer }>> {
  const wanted = input.attachments
    .map(attachment => attachment.assetId)
    .filter(assetId => typeof assetId === "string" && assetId.length > 0)
    .slice(0, MAX_IMAGES_PER_TURN);
  if (wanted.length === 0) return [];
  let rows: ImageRow[] = [];
  try {
    rows = await withWorkerWorkspaceTransaction(
      { workspaceId: input.workspaceId, userId: input.userId },
      // One parameter per id keeps this independent of array-binding behaviour
      // across drivers; an array cast was the thing that failed silently before.
      tx => tx.execute<ImageRow>(sql`
        SELECT id::text AS id, object_key, mime_type, byte_size
        FROM note_image_assets
        WHERE workspace_id = ${input.workspaceId} AND deleted_at IS NULL AND status = 'ready'
          AND id IN (${sql.join(wanted.map(assetId => sql`${assetId}::uuid`), sql`, `)})
      `),
    );
  } catch (error) {
    // Say what actually failed: the previous message was the bare name "Error",
    // which hid a broken query behind "proceeding without images".
    logger.warn({ runId: input.runId, assetIds: wanted.length,
      message: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) },
    "companion attachment images could not be resolved; the turn proceeds without them");
    return [];
  }
  const byId = new Map(rows.map(row => [row.id, row]));
  const images: Array<{ assetId: string; mimeType: string; bytes: Buffer }> = [];
  let total = 0;
  for (const assetId of wanted) {
    const row = byId.get(assetId);
    if (!row) continue;
    if (!row.mime_type.startsWith("image/")) continue;
    if (row.byte_size > MAX_IMAGE_RAW_BYTES) {
      logger.info({ runId: input.runId, assetId, bytes: row.byte_size },
        "companion attachment image skipped: larger than the per-image limit");
      continue;
    }
    if (total + row.byte_size > MAX_TOTAL_RAW_BYTES) {
      logger.info({ runId: input.runId, assetId },
        "companion attachment image skipped: turn image budget exhausted");
      continue;
    }
    try {
      const bytes = await getObjectBytes(row.object_key, MAX_IMAGE_RAW_BYTES);
      total += bytes.byteLength;
      images.push({ assetId, mimeType: row.mime_type, bytes });
    } catch (error) {
      // A missing object is not a reason to fail the turn; she simply has fewer
      // pictures than the user sent, and the receipt says which ones arrived.
      logger.warn({ runId: input.runId, assetId, error: error instanceof Error ? error.name : "unknown" },
        "companion attachment image could not be read");
    }
  }
  return images;
}

/** Attach the pictures to this turn's user message as multimodal content. */
export function attachImagesToLastUserMessage<T extends { role: string; content: unknown }>(
  messages: readonly T[],
  images: readonly { assetId: string; mimeType: string; bytes: Buffer }[],
): T[] {
  if (images.length === 0) return [...messages];
  let index = -1;
  for (let cursor = messages.length - 1; cursor >= 0; cursor -= 1) {
    if (messages[cursor]!.role === "user") { index = cursor; break; }
  }
  if (index < 0) return [...messages];
  const target = messages[index]!;
  const text = typeof target.content === "string" ? target.content : "";
  const content = [
    ...(text ? [{ type: "text" as const, text }] : []),
    ...images.map(image => ({
      type: "image_url" as const,
      image_url: { url: `data:${image.mimeType};base64,${image.bytes.toString("base64")}`, detail: "high" as const },
    })),
  ];
  return messages.map((message, position) => position === index ? { ...message, content } : message);
}

/** Decorate this turn's messages with its pictures, when the model can see. */
export async function companionTurnMessagesWithImages<T extends { role: string; content: unknown }>(input: {
  args: {
    ctx: { workspaceId: string };
    read: {
      userId: string; runId: string; turnImagesSentDirectly?: boolean;
      userImageAttachments?: readonly CompanionImageAttachment[];
    };
  };
  messages: readonly T[];
}): Promise<T[]> {
  const { read } = input.args;
  if (read.turnImagesSentDirectly !== true || !read.userImageAttachments?.length) return [...input.messages];
  const images = await loadCompanionAttachmentImages({
    workspaceId: input.args.ctx.workspaceId, userId: read.userId,
    attachments: read.userImageAttachments, runId: read.runId,
  });
  if (images.length === 0) return [...input.messages];
  logger.info({ runId: read.runId, attached: images.length, sent: read.userImageAttachments.length },
    "companion attached images are sent with the turn");
  return attachImagesToLastUserMessage(input.messages, images);
}

/**
 * The reply describes a picture nobody looked at.
 *
 * Facts, not wording: the pictures count as seen when they were sent with this
 * request, or when the turn holds a successful image read. Without either, a
 * description of what is in the picture cannot be known and is corrected once.
 */
export function reviewCompanionImageClaim(input: {
  said: string;
  calls: readonly unknown[];
  messages: AgentTurnRequest["messages"];
  sentDirectly: boolean;
  hasAttachments: boolean;
  alreadyCorrected: boolean;
  runId: string;
  stepCount: number;
}): { instruction: string } | null {
  if (input.alreadyCorrected || !input.hasAttachments || input.calls.length > 0) return null;
  const sawImages = input.sentDirectly
    || input.messages.some(message => message.role === "tool" && typeof message.content === "string"
      && message.content.includes('"operation":"visual.read_image"') && message.content.includes('"ok":true'));
  if (sawImages || !claimsImageContent(input.said)) return null;
  logger.warn({ runId: input.runId, stepCount: input.stepCount },
    "companion described image content without looking");
  return { instruction: "这一轮的图片你还没有真正看到，不能描述图里的内容。"
    + "要么先用 companion_visual（action=read_image）读图再回答，要么如实说你还没看到；不要凭图名或上下文猜。" };
}
