/**
 * 证据预览的唯一读点（doc 34 L21 §2）。
 *
 * 候选 reveal 与卡片 reveal 以前各有一份"按快照 id 切 `note_blocks.content`"的代码，
 * 两份都不复算哈希——于是自动保存把那段文字改掉之后，界面上显示的仍然是
 * "原文依据"，而 keep/reject 是照它定的。这里把两半合掉：落点状态与切片只算一次。
 *
 * 落点有**两维**会失效，各自都红过：①**就地改写**——自动保存把当前版本那一行的正文换了、
 * 块 id 不换，靠复算哈希抓（L21 §2，原有）；②**开了新版本**——显式保存给每个块换新 id，
 * 锚点从此停在旧版本的行上，那一行再也不会被改，于是"落点还在"是恒真的（39d D3 §3 第 2 层，
 * `evidence-anchor-version-drift-postgres.integration.ts` 钉住）。②的正解是拿这一篇的
 * **当前版本**按 ordinal 重落锚点，重落不出来就判"无法确认"。
 */
import { and, eq, inArray } from "drizzle-orm";
import { evidenceSnapshotsV2 } from "@astella/shared/db-schema/card-generation-v2";
import { noteBlocks, noteVersions, notes } from "@astella/shared/db-schema/note";
import { evidenceQuoteCopiesV2 } from "@astella/shared/db-schema/card-generation-v2";
import { classifyEvidencePreviewV2 } from "@astella/shared/card-generation-v2-hashing";
import type { ApiTransaction } from "../../db/client.ts";

export interface EvidencePreviewItem {
  evidenceSnapshotId: string;
  preview: string;
  sourceLabel: string | null;
  sourceState: "located" | "drifted" | "missing";
  /**
   * 密封时冻住的原文（0275）。落点还在时它是 null——那时"当初那段"就是现在这段。
   * drifted/missing 时为 null 只有两种可能：这条证据是 0275 之前的存量，或副本行缺失。
   * 副本为空串与没有副本都归一到 null：0275 之前的存量一律 null，界面不能说"没有原文"，只能说"这段没被冻住"。
   */
  originalPreview: string | null;
}

const MAX_PREVIEWS = 20;
const MAX_PREVIEW_CHARS = 2000;

export async function loadEvidencePreviewItems(
  tx: ApiTransaction,
  workspaceId: string,
  refIds: string[],
): Promise<EvidencePreviewItem[]> {
  const ids = [...new Set(refIds)].slice(0, MAX_PREVIEWS);
  if (ids.length === 0) return [];

  const rows = await tx.select().from(evidenceSnapshotsV2)
    .where(and(
      eq(evidenceSnapshotsV2.workspaceId, workspaceId),
      inArray(evidenceSnapshotsV2.evidenceSnapshotId, ids),
    ))
    .limit(MAX_PREVIEWS);
  if (rows.length === 0) return [];

  const blockIds = [...new Set(
    rows.map((r) => r.blockId).filter((b): b is string => Boolean(b)),
  )];
  const blockTextById = new Map<string, string>();
  const blockRowById = new Map<string, { versionId: string; ordinal: number }>();
  if (blockIds.length > 0) {
    const blockRows = await tx.select({
      id: noteBlocks.id,
      content: noteBlocks.content,
      versionId: noteBlocks.versionId,
      ordinal: noteBlocks.ordinal,
    })
      .from(noteBlocks)
      .where(and(
        eq(noteBlocks.workspaceId, workspaceId),
        inArray(noteBlocks.id, blockIds),
      ));
    for (const b of blockRows) {
      blockTextById.set(b.id, b.content);
      blockRowById.set(b.id, { versionId: b.versionId, ordinal: b.ordinal });
    }
  }

  /**
   * 锚点那一行属于**上一版**时，按块 id 取到的正文就是**当初的文字**——哈希当然对得上。
   * 这不是猜：`checkpointNote` 建好新版本行后让 `projectBlocksIntoVersion` 按 ordinal 投影进
   * 那个新版本，新版本此刻一行都没有 ⇒ 每个块都拿到新 uuid（`note/document-state.ts:419-442`
   * ＋ `note_blocks.id` 的 `defaultRandom()`）。所以"就地改写"那条路（自动保存改当前版本的行）
   * 一直判得对，**显式保存开新版**这条路永远判成落点还在。下面把它接上：以这一篇的当前版本
   * 为准按 ordinal 重落锚点；重落不出来就如实说"无法确认"，**不**按位置往下找一个块冒充当初
   * 的依据（D3 §2.1：没有可比的落点是独立的一种状态，不是"内容没变"）。
   */
  const versionStateById = new Map<string, { currentVersionId: string | null }>();
  const anchorVersionIds = [...new Set([...blockRowById.values()].map((b) => b.versionId))];
  if (anchorVersionIds.length > 0) {
    const versionRows = await tx.select({
      versionId: noteVersions.id,
      currentVersionId: notes.currentVersionId,
    })
      .from(noteVersions)
      .innerJoin(notes, and(
        eq(notes.id, noteVersions.noteId),
        eq(notes.workspaceId, workspaceId),
      ))
      .where(and(
        eq(noteVersions.workspaceId, workspaceId),
        inArray(noteVersions.id, anchorVersionIds),
      ));
    for (const v of versionRows) {
      versionStateById.set(v.versionId, { currentVersionId: v.currentVersionId });
    }
  }

  const currentVersionIdsToRead = [...new Set(
    [...versionStateById.entries()]
      .filter(([anchorVersionId, s]) => s.currentVersionId !== anchorVersionId)
      .map(([, s]) => s.currentVersionId)
      .filter((id): id is string => id !== null),
  )];
  const currentBlockTextByOrdinal = new Map<string, string>();
  const versionIdsWithProjection = new Set<string>();
  if (currentVersionIdsToRead.length > 0) {
    const currentRows = await tx.select({
      versionId: noteBlocks.versionId,
      ordinal: noteBlocks.ordinal,
      content: noteBlocks.content,
    })
      .from(noteBlocks)
      .where(and(
        eq(noteBlocks.workspaceId, workspaceId),
        inArray(noteBlocks.versionId, currentVersionIdsToRead),
      ));
    for (const b of currentRows) {
      versionIdsWithProjection.add(b.versionId);
      currentBlockTextByOrdinal.set(`${b.versionId}:${b.ordinal}`, b.content);
    }
  }

  // 这条证据现在该拿哪一段正文去复算哈希；null＝落点重落不出来。
  const liveBlockContent = (blockId: string | null): string | null => {
    if (!blockId) return null;
    const stored = blockTextById.get(blockId) ?? null;
    const anchor = blockRowById.get(blockId);
    if (!anchor || stored === null) return stored;
    const state = versionStateById.get(anchor.versionId);
    // 这一篇**没有当前版本指针**时无处可重落（dev 实测 902/1024 条 notes 为 NULL，是常态
    // 不是异常）。与 `checkSourceOutdated` 同一口径（`helpers.ts:112`）：说不出新旧就不报
    // 消息——把"没有指针"说成"落点没了"会让八成的卡片凭空亮出"无法确认"。
    if (!state || !state.currentVersionId || state.currentVersionId === anchor.versionId) return stored;
    // 当前版本**一行投影都没有**时没有可对照的整体（dev 实测：69 条旧版锚点里 63 条是这一形，
    // 它们的笔记当前版块数为 0）。与"没有指针"同口径：说不出新旧就不报消息——把「无从比对」
    // 说成界面上那句「原文已不在笔记里」是凭空造一条用户可见的断言。
    if (!versionIdsWithProjection.has(state.currentVersionId)) return stored;
    return currentBlockTextByOrdinal.get(`${state.currentVersionId}:${anchor.ordinal}`) ?? null;
  };

  // 副本按 (workspace, evidence_snapshot_id) 取——**不是**按 protected_quote_ref 里那个号：
  // 0275 之前的行 ref 里装的是凭空抽的随机号（L21 §1 那个缺陷本身），按它查永远查不到。
  const copyTextById = new Map<string, string>();
  const copyRows = await tx
    .select({
      evidenceSnapshotId: evidenceQuoteCopiesV2.evidenceSnapshotId,
      quoteText: evidenceQuoteCopiesV2.quoteText,
    })
    .from(evidenceQuoteCopiesV2)
    .where(and(
      eq(evidenceQuoteCopiesV2.workspaceId, workspaceId),
      inArray(evidenceQuoteCopiesV2.evidenceSnapshotId, rows.map((r) => r.evidenceSnapshotId)),
    ));
  for (const c of copyRows) copyTextById.set(c.evidenceSnapshotId, c.quoteText);

  const items: EvidencePreviewItem[] = [];
  for (const row of rows) {
    const blockContent = liveBlockContent(row.blockId);
    const { state, quote } = classifyEvidencePreviewV2({
      blockContent,
      blockContentHash: row.blockContentHash,
      quoteHash: row.quoteHash,
      startOffset: row.startOffset,
      endOffset: row.endOffset,
    });
    const preview = quote.trim().slice(0, MAX_PREVIEW_CHARS);
    // 落点还在、文字也没变，却切出个空串——那是这条证据本身没有正文，
    // 和"找不到原文"是两件事，不该占用后者的位置。
    if (state === "located" && !preview) continue;
    items.push({
      evidenceSnapshotId: row.evidenceSnapshotId,
      preview,
      sourceLabel: null,
      sourceState: state,
      originalPreview: state === "located"
        ? null
        : (copyTextById.get(row.evidenceSnapshotId) ?? "").trim().slice(0, MAX_PREVIEW_CHARS) || null,
    });
  }
  return items;
}
