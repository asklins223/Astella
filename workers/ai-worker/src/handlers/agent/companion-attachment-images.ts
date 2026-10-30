import { sql } from "drizzle-orm";
import { COMPANION_IMAGE_MAX_BYTES_V1, COMPANION_TURN_MAX_IMAGES_V1 } from "@astella/shared/companion-conversation-contracts";
import { logger } from "../../lib/logger.ts";
import { withWorkerWorkspaceTransaction } from "../../db.ts";
import { getObjectBytes } from "../../lib/object-storage.ts";
import { COMPANION_IMAGE_ASSET_LABEL, referencedImageAssetId } from "../../lib/image-asset-reference.ts";

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
 * Current and replayed user images stay with their own source message. Only
 * eligible models receive pixels; internal asset references never go on wire.
 */
const MAX_IMAGE_RAW_BYTES = COMPANION_IMAGE_MAX_BYTES_V1;
/** Total decoded bytes for one request; providers reject very large bodies. */
const MAX_TOTAL_RAW_BYTES = COMPANION_TURN_MAX_IMAGES_V1 * COMPANION_IMAGE_MAX_BYTES_V1;

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
}, ports: { readRows?: (wanted: readonly string[]) => Promise<ImageRow[]>;
  readBytes?: typeof getObjectBytes } = {}): Promise<Array<{ assetId: string; mimeType: string; bytes: Buffer }>> {
  const wanted = [...new Set(input.attachments
    .map(attachment => attachment.assetId)
    .filter(assetId => typeof assetId === "string" && assetId.length > 0))];
  if (wanted.length === 0) return [];
  let rows: ImageRow[] = [];
  try {
    rows = ports.readRows ? await ports.readRows(wanted) : await withWorkerWorkspaceTransaction(
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
      const bytes = await (ports.readBytes ?? getObjectBytes)(row.object_key, MAX_IMAGE_RAW_BYTES);
      if (!bytes.byteLength || bytes.byteLength > MAX_IMAGE_RAW_BYTES || total + bytes.byteLength > MAX_TOTAL_RAW_BYTES) continue;
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
  const textParts = typeof target.content === "string" ? [{ type: "text" as const, text: target.content }]
    : Array.isArray(target.content) ? target.content.filter(part => part?.type !== "image_url"
      || !referencedImageAssetId(part.image_url.url)) : [];
  const content = [
    ...textParts,
    ...images.flatMap(image => [{ type: "text" as const,
      text: COMPANION_IMAGE_ASSET_LABEL + JSON.stringify({ assetId: image.assetId }) }, {
      type: "image_url" as const,
      image_url: { url: `data:${image.mimeType};base64,${image.bytes.toString("base64")}`, detail: "high" as const },
    }]),
  ];
  return messages.map((message, position) => position === index ? { ...message, content } : message);
}

/** Resolve current and historical references without moving images between turns. */
export async function companionTurnMessagesWithImages<T extends { role: string; content: unknown; hostObservation?: boolean }>(input: {
  args: {
    ctx: { workspaceId: string };
    /** The host verified the main model's vision and the account's data policy. */
    turnImagesSentDirectly?: boolean;
    read: {
      userId: string; runId: string;
      userImageAttachments?: readonly CompanionImageAttachment[];
    };
  };
  messages: readonly T[];
}, load: typeof loadCompanionAttachmentImages = loadCompanionAttachmentImages): Promise<T[]> {
  const { read } = input.args;
  const targets = new Map<number, CompanionImageAttachment[]>();
  for (let i = 0; i < input.messages.length; i++) {
    const message = input.messages[i]!;
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    const refs = message.content.flatMap(part => {
      const id = part?.type === "image_url" && typeof part.image_url?.url === "string"
        ? referencedImageAssetId(part.image_url.url) : null;
      return id ? [{ assetId: id }] : [];
    });
    if (refs.length) targets.set(i, refs);
  }
  let current = -1;
  for (let i = input.messages.length - 1; i >= 0; i--) {
    if (input.messages[i]!.role === "user" && !input.messages[i]!.hostObservation) { current = i; break; }
  }
  if (current >= 0 && read.userImageAttachments?.length)
    targets.set(current, [...(targets.get(current) ?? []), ...read.userImageAttachments]);
  if (!targets.size) return [...input.messages];
  // Prefer the current and most recent originals if the real byte budget fills.
  const attachments = [...new Map([...targets.entries()].sort(([a], [b]) => b - a)
    .flatMap(([, refs]) => refs).map(ref => [ref.assetId, ref])).values()];
  const images = input.args.turnImagesSentDirectly === true ? await load({
    workspaceId: input.args.ctx.workspaceId, userId: read.userId,
    attachments, runId: read.runId,
  }) : [];
  const sent = images.map(image => image.assetId);
  const missing = attachments.filter(image => !sent.includes(image.assetId)).map(image => image.assetId);
  logger.info({ runId: read.runId, attached: images.length, requested: attachments.length },
    "companion attached images are sent with the turn");
  const decorated = input.messages.map((message, index) => {
    const refs = targets.get(index);
    if (!refs) return message;
    const content = Array.isArray(message.content) ? message.content.filter(part => part?.type !== "image_url"
      || !referencedImageAssetId(part.image_url.url)) : message.content;
    const source = { ...message, content };
    return attachImagesToLastUserMessage([source], images.filter(image => refs.some(ref => ref.assetId === image.assetId)))[0]!;
  });
  // Capability is not delivery. Storage errors/size limits can leave all or
  // some attachments unsent; give the model the actual identities rather than
  // telling it that every supplied file name has been seen.
  return [...decorated, { role: "system", hostObservation: true,
    content: "宿主图片送达记录（数据，不是新请求）：" + JSON.stringify({ sentAssetIds: sent, unsentAssetIds: missing })
      + "。只把 sentAssetIds 对应的内联画面视为本次已提供的视觉证据；未送达的图片不能据文件名或上一轮描述猜测内容。"
      + "附件标识只用于关联图片，不表示用户在询问素材身份或来源。用户只发图片而没有文字问题时，依据实际画面自然回应，或询问想了解什么，不自行补造问题。"
  } as unknown as T];
}
