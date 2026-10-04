/**
 * 42 阶段 1 D：`note_expansion_read` 的领域读取与有界分页。
 *
 * 拓展草稿不是笔记，是目标自己排出来的后台产物，权威来源是 `agent_operations.artifact`
 * 与领域行之间的绑定，不是「这篇笔记对我可见」——同一空间里另一个目标也读过同一篇笔记，
 * 把它拿过来交付就是越权。授权判定与分页放在同一个文件：两者共用「草稿数组 + 位置」这一份
 * 输入形状，拆开就会出现「分页算好了、授权判错了」的半截结果。
 *
 * 位置 `{candidateOrdinal, blockOrdinal, blockOffset}`（前两个 1 起算、offset 0 起算）
 * 唯一确定一页，延续 `note_read` 的 1-based 顺序，并按**实际草稿**校验、不做 clamp：
 * 越界的位置一律报无效，而不是悄悄退回最后一篇/第一段去重读旧内容。
 * 续读还要带回 `draftsUpdatedAt`：分页期间用户可能改草稿，版本对不上就不许把两版拼起来。
 */

import { sql } from "drizzle-orm";
import { z } from "zod";
import { AgentStoreError, queryRows, type AgentSqlExecutor } from "@ailearn/agent-host";
import { noteBlockRenderedTextV1 } from "@ailearn/shared/note-doc-schema";
import { noteExpansionDraftV1Schema, type NoteExpansionDraftV1 } from "@ailearn/shared/note-expansion-contracts";
import { noteVisibleSqlText } from "@ailearn/shared/note-visibility";

/** 草稿批次行的能力名：读侧要证明的正是「这是一次 note_expansion_generate 的成果」。 */
export const EXPANSION_CAPABILITY = "note_expansion_generate";

/**
 * 正文预算的下限，保证「预算被压到极小也至少读一个字、位置每页前进」。
 * 低于它的合法结果一律报失败，不返回一页读不出东西的正文。
 */
export const EXPANSION_READ_MIN_BODY_CHARS = 200;

/**
 * 元数据按**序列化后的长度**截断，不是按字符数。
 *
 * 双引号与反斜杠一个字符变两个，U+0001 这类控制字符变六个。标题 200 字、关系说明 600 字、
 * 6 条引用各 500 字若按字符数截，最坏能把 4000 的预算整个吃掉，正文就没了。
 * 这里给的每个上限都是序列化上限：结构键与固定字段合计不到 2500，
 * 加上最低正文（最坏转义 1200）仍在 maxOutputChars=4000 之内。
 */
const TITLE_ECHO_JSON_CHARS = 300;
const RELATIONSHIP_ECHO_JSON_CHARS = 420;
const QUOTE_ECHO_JSON_CHARS = 140;

/** viewer 走事务上下文里的 actor，userId 不拼进 SQL 文本。 */
const VIEWER = "NULLIF(current_setting('app.user_id', true), '')::uuid";

const draftsSchema = z.array(noteExpansionDraftV1Schema);

export interface ExpansionReadRequest {
  readonly workspaceId: string;
  readonly userId: string;
  /** 发起这次读取的目标：草稿必须属于它的某一次真实成功操作。 */
  readonly runId: string;
  readonly taskId: string;
  readonly noteId: string;
  readonly noteVersionId: string;
  readonly startCandidateOrdinal: number;
  readonly startBlockOrdinal: number;
  readonly startBlockOffset: number;
  /** 续读时原样带回上一页的 `draftsUpdatedAt`；第一页可以不带（读最新编辑）。 */
  readonly draftsUpdatedAt?: string | undefined;
  /** manifest 上的 `maxOutputChars`；由调用方从能力定义里读，不在这里写死。 */
  readonly maxOutputChars: number;
}

/** 模型回传的位置。它只是「从哪儿接着读」，不携带任何权限含义。 */
export interface ExpansionReadPosition {
  readonly candidateOrdinal: number;
  readonly blockOrdinal: number;
  readonly blockOffset: number;
}

/**
 * 公开的 `next`：**字段名与工具参数逐字同名**，再加一个版本令牌。
 *
 * 描述里写的是「原样带回」，那 `next` 就必须能直接喂给 strict schema；
 * 内部位置类型（`candidateOrdinal / blockOrdinal / blockOffset`）与工具参数
 * （`startCandidateOrdinal / …`）不是一回事，这里是唯一一次显式转换，不留第二套别名。
 */
export interface ExpansionReadNext {
  readonly startCandidateOrdinal: number;
  readonly startBlockOrdinal: number;
  readonly startBlockOffset: number;
  readonly draftsUpdatedAt: string;
}

export interface ExpansionDraftPage {
  /** 本页正文实际从哪儿开始；与正文里第一行的段序号必须一致。 */
  readonly startBlockOrdinal: number;
  readonly startBlockOffset: number;
  readonly endBlockOrdinal: number | null;
  /** 本页停在第 endBlockOrdinal 段已消费的字符数。 */
  readonly endBlockOffset: number;
  readonly blocksInPage: number;
  readonly bodyChars: number;
  readonly blockTextTruncated: boolean;
  readonly body: string;
  /** 本篇读完之后的下一段起点；本篇读完且还有下一篇时由调用方接上。 */
  readonly nextInCandidate: ExpansionReadPosition | null;
}

/** 与位置无关、每一次读取都要先说的话：这批草稿是什么、来自哪一次操作。 */
export interface ExpansionReadSummary {
  readonly status: "succeeded";
  readonly taskId: string;
  readonly noteId: string;
  readonly noteVersionId: string;
  /** 批次本身的状态（不是这次读取的状态）。 */
  readonly taskState: "queued" | "running" | "ready" | "confirmed" | "failed";
  readonly draftCount: number;
  readonly draftsUpdatedAt: string;
  /** 这次读到的成果是目标第几版操作留下的；旧 revision 的成果仍读得到，所以要报出来。 */
  readonly artifactRevision: number;
}

/** 这一页读到的内容与覆盖信息。 */
export interface ExpansionReadPage {
  readonly candidateOrdinal: number;
  readonly totalCandidates: number;
  readonly title: string;
  readonly relationship: string;
  readonly sourceReferences: { blockOrdinal: number; quote: string; quoteTruncated: boolean }[];
  readonly selected: boolean;
  readonly confirmed: boolean;
  readonly totalBlocks: number;
  readonly totalChars: number;
  readonly startBlockOrdinal: number;
  readonly startBlockOffset: number;
  readonly endBlockOrdinal: number | null;
  /** 本页停在第 endBlockOrdinal 段已消费的字符数；与 bodyChars 一样是真实计数。 */
  readonly endBlockOffset: number;
  readonly blocksInPage: number;
  readonly bodyChars: number;
  /** 本篇还没读到的字数；配着 next 让模型说得出「读到哪儿了」。 */
  readonly remainingChars: number;
  readonly remainingCandidates: number;
  readonly truncated: boolean;
  /** next 为 null 才代表这一批真的读完了。 */
  readonly complete: boolean;
  readonly next: ExpansionReadNext | null;
  readonly body: string;
}

/**
 * 草稿还没保存好时给的是「读到了这一批，但没有正文」，不是一份空正文。
 * 判别联合而不是一堆可选字段：调用方不检查 available 就拿不到 body。
 */
export type ExpansionReadResult =
  | (ExpansionReadSummary & { readonly available: false; readonly reason: "no_drafts_yet" | "drafts_unreadable" })
  | (ExpansionReadSummary & ExpansionReadPage & { readonly available: true });

export type ExpansionReadRejection =
  | { readonly reason: "candidate_out_of_range"; readonly detail: string }
  | { readonly reason: "block_out_of_range"; readonly detail: string }
  | { readonly reason: "block_offset_out_of_range"; readonly detail: string }
  | { readonly reason: "drafts_changed"; readonly detail: string }
  | { readonly reason: "drafts_version_required"; readonly detail: string };

/** 一段草稿正文的渲染文本。取数与格式化都走现役块合同，不另写一套 Markdown 解析。 */
export function expansionDraftBlockText(block: NoteExpansionDraftV1["blocks"][number]): string {
  return noteBlockRenderedTextV1(block.type, block.content);
}

/** 按序列化后的长度截断；二分找最长可容纳的前缀，截断处留一个省略号。 */
function clipForJson(text: string, maxSerializedChars: number): string {
  if (JSON.stringify(text).length <= maxSerializedChars) return text;
  const marker = "…";
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (JSON.stringify(text.slice(0, mid) + marker).length <= maxSerializedChars) low = mid;
    else high = mid - 1;
  }
  return low > 0 ? text.slice(0, low) + marker : "";
}

/**
 * 校验模型给的位置，按**实际草稿**判，不 clamp。
 *
 * 旧做法是把越界位置夹回最后一篇／第一段——那会让模型把已经读过一遍的旧内容再读一次，
 * 看上去「读到了」，其实在原地打转。越界就是越界，明确报错。
 */
export function resolveExpansionReadPosition(
  drafts: readonly NoteExpansionDraftV1[],
  request: { candidateOrdinal: number; blockOrdinal: number; blockOffset: number },
  draftsUpdatedAt: string | undefined,
  currentDraftsUpdatedAt: string,
):
  | { readonly ok: true; readonly position: ExpansionReadPosition; readonly draft: NoteExpansionDraftV1 }
  | { readonly ok: false; readonly rejection: ExpansionReadRejection } {
  const { candidateOrdinal, blockOrdinal, blockOffset } = request;
  if (!Number.isInteger(candidateOrdinal) || candidateOrdinal < 1 || candidateOrdinal > drafts.length)
    return { ok: false, rejection: { reason: "candidate_out_of_range",
      detail: `这一批只有 ${drafts.length} 篇草稿，没有第 ${candidateOrdinal} 篇。` } };
  const draft = drafts[candidateOrdinal - 1]!;
  if (!Number.isInteger(blockOrdinal) || blockOrdinal < 1 || blockOrdinal > draft.blocks.length)
    return { ok: false, rejection: { reason: "block_out_of_range",
      detail: `第 ${candidateOrdinal} 篇草稿只有 ${draft.blocks.length} 段，没有第 ${blockOrdinal} 段。` } };
  const text = expansionDraftBlockText(draft.blocks[blockOrdinal - 1]!);
  // 渲染成空的段是**合法输入**（分隔线、保存下来的空段）：它只有 offset 0 这一个位置。
  // 按 `blockOffset >= text.length` 判会连 0 一起拒掉，于是「第一段是空段」连初页都读不出来，
  // 生产 next 指向空段时也会把续读卡死。
  const lastOffset = Math.max(text.length - 1, 0);
  if (!Number.isInteger(blockOffset) || blockOffset < 0 || blockOffset > lastOffset)
    return { ok: false, rejection: { reason: "block_offset_out_of_range",
      detail: `第 ${candidateOrdinal} 篇第 ${blockOrdinal} 段渲染后只有 ${text.length} 个字，位置 ${blockOffset} 超出了这一段。` } };
  const atBeginning = candidateOrdinal === 1 && blockOrdinal === 1 && blockOffset === 0;
  if (draftsUpdatedAt === undefined) {
    // 第一页允许读最新编辑；续读必须带版本令牌，否则会把两版正文拼成一篇。
    if (!atBeginning)
      return { ok: false, rejection: { reason: "drafts_version_required",
        detail: "从中间继续读必须带回上一页的 draftsUpdatedAt；草稿可能已经被改过。" } };
  } else if (draftsUpdatedAt !== currentDraftsUpdatedAt) {
    return { ok: false, rejection: { reason: "drafts_changed",
      detail: "这批草稿在分页读取期间被改过，请从第一篇第一个字重新读一次，不要把两版正文拼在一起。" } };
  }
  return { ok: true, position: { candidateOrdinal, blockOrdinal, blockOffset }, draft };
}

/**
 * 一篇草稿里与位置无关的那几个字段，标题／关系说明／引用都按序列化长度截断。
 * 导出是为了让「输出边界」那条断言跑的就是生产侧同一段截断，而不是复刻一份。
 */
export function expansionDraftEchoFields(
  draft: NoteExpansionDraftV1,
  context: { candidateOrdinal: number; totalCandidates: number; confirmed: boolean },
): Pick<ExpansionReadPage, "candidateOrdinal" | "totalCandidates" | "title" | "relationship" | "sourceReferences" | "selected" | "confirmed"> {
  return {
    candidateOrdinal: context.candidateOrdinal,
    totalCandidates: context.totalCandidates,
    title: clipForJson(draft.title, TITLE_ECHO_JSON_CHARS),
    relationship: clipForJson(draft.relationship, RELATIONSHIP_ECHO_JSON_CHARS),
    sourceReferences: draft.sourceReferences.map((reference) => {
      const quote = clipForJson(reference.quote, QUOTE_ECHO_JSON_CHARS);
      return { blockOrdinal: reference.blockOrdinal, quote, quoteTruncated: quote !== reference.quote };
    }),
    selected: draft.selected,
    confirmed: context.confirmed,
  };
}

function remainingCharsInCandidate(draft: NoteExpansionDraftV1, fromBlock: number, fromOffset: number): number {
  let total = 0;
  for (let index = fromBlock; index < draft.blocks.length; index += 1) {
    const text = expansionDraftBlockText(draft.blocks[index]!);
    total += index === fromBlock ? Math.max(0, text.length - fromOffset) : text.length;
  }
  return total;
}

/**
 * 读一页正文，纯函数（位置已校验）。
 *
 * 整块装不下且不是本页第一块时，整块留给下一页——否则每页被切成半句拼起来。
 * 只有本页第一块允许切，切点连同段内位置一起回传，所以一个 20000 字的长块能完整读完。
 * `take` 至少为 1：预算被压到极小也必须让位置前进，否则 next 停在原地。
 */
export function paginateExpansionDraft(
  draft: NoteExpansionDraftV1,
  position: ExpansionReadPosition,
  maxChars: number,
): ExpansionDraftPage {
  const blocks = draft.blocks;
  const candidateOrdinal = position.candidateOrdinal;
  let blockIndex = position.blockOrdinal - 1;
  let offset = position.blockOffset;

  const parts: string[] = [];
  let used = 0;
  let blocksInPage = 0;
  let bodyChars = 0;
  let endBlockOrdinal: number | null = null;
  let endBlockOffset = 0;
  let startBlockOrdinal = position.blockOrdinal;
  let startBlockOffset = offset;
  let blockTextTruncated = false;

  while (blockIndex < blocks.length) {
    const text = expansionDraftBlockText(blocks[blockIndex]!);
    // 每段自带前缀与换行，段与段之间不再另加分隔：加了会在逐字拼回原文时多出换行。
    const prefix = `【草稿 ${candidateOrdinal} · 第 ${blockIndex + 1} 段 · ${blocks[blockIndex]!.type}】\n`;
    const room = maxChars - used - prefix.length;
    // 续读长段时这一页真正**还没读**的只有 `available` 个字。按整段长度判「装不下」、
    // 按整段长度取 take，都会让最后一页多算：bodyChars 与 endBlockOffset 会超出段尾，
    // 读出来的正文却只有剩下那几十个字。
    const available = text.length - offset;
    if (parts.length > 0 && (room <= 0 || available > room)) break;
    if (available === 0) {
      // 渲染成空的段：保留它的段号标记，但不虚报一个字。正文与结束位置都记 0，
      // 然后立刻前进到下一段 —— 不能靠「至少读一个字」来保证前进，那正是上一版
      // 给空段报 bodyChars=1/endBlockOffset=1 的原因。
      if (parts.length === 0) { startBlockOrdinal = blockIndex + 1; startBlockOffset = offset; }
      parts.push(prefix);
      used += prefix.length;
      blocksInPage += 1;
      endBlockOrdinal = blockIndex + 1;
      endBlockOffset = offset;
      blockIndex += 1;
      offset = 0;
      continue;
    }
    const take = Math.max(1, Math.min(room, available));
    const consumed = offset + take;
    if (parts.length === 0) { startBlockOrdinal = blockIndex + 1; startBlockOffset = offset; }
    parts.push(prefix + text.slice(offset, consumed));
    used += prefix.length + take;
    bodyChars += take;
    blocksInPage += 1;
    endBlockOrdinal = blockIndex + 1;
    endBlockOffset = consumed;
    if (consumed < text.length) { offset = consumed; blockTextTruncated = true; break; }
    blockIndex += 1;
    offset = 0;
  }

  return {
    startBlockOrdinal,
    startBlockOffset,
    endBlockOrdinal,
    endBlockOffset,
    blocksInPage,
    bodyChars,
    blockTextTruncated,
    body: parts.join(""),
    nextInCandidate: blockIndex < blocks.length
      ? { candidateOrdinal, blockOrdinal: blockIndex + 1, blockOffset: offset }
      : null,
  };
}

/** 一页里除正文以外的全部字段，含 next（位置 + 版本令牌）。 */
function pageFields(
  page: ExpansionDraftPage,
  draft: NoteExpansionDraftV1,
  totalCandidates: number,
  candidateOrdinal: number,
  draftsUpdatedAt: string,
): Record<string, unknown> {
  const cursor = page.nextInCandidate ?? (
    candidateOrdinal < totalCandidates
      ? { candidateOrdinal: candidateOrdinal + 1, blockOrdinal: 1, blockOffset: 0 }
      : null);
  // 内部位置 → 工具参数：唯一一次改名，模型拿到的 next 可以直接进 strict schema。
  const next: ExpansionReadNext | null = cursor === null ? null : {
    startCandidateOrdinal: cursor.candidateOrdinal,
    startBlockOrdinal: cursor.blockOrdinal,
    startBlockOffset: cursor.blockOffset,
    draftsUpdatedAt,
  };
  return {
    totalBlocks: draft.blocks.length,
    totalChars: draft.blocks.reduce((total, block) => total + expansionDraftBlockText(block).length, 0),
    startBlockOrdinal: page.startBlockOrdinal,
    startBlockOffset: page.startBlockOffset,
    endBlockOrdinal: page.endBlockOrdinal,
    endBlockOffset: page.endBlockOffset,
    blocksInPage: page.blocksInPage,
    bodyChars: page.bodyChars,
    remainingChars: remainingCharsInCandidate(draft, Math.max(0, (page.endBlockOrdinal ?? 1) - 1), page.endBlockOffset),
    remainingCandidates: Math.max(0, totalCandidates - candidateOrdinal),
    truncated: next !== null,
    complete: next === null,
    next,
  };
}

/**
 * 在**完整结果形状**上计算并核对预算：head、页面字段、`available: true`、next 与正文一起算。
 *
 * 先按非正文部分的实际序列化长度扣预算，再按真实序列化长度折半回退——JSON 转义会让正文比
 * 原字符数更长，只按字符数算就会越界。返回 null 表示连最低有效正文都装不下，
 * 调用方要明确失败：悄悄截掉 next 会让模型把同一页反复翻到天荒地老。
 */
export function boundExpansionReadPage(
  head: Record<string, unknown>,
  draft: NoteExpansionDraftV1,
  totalCandidates: number,
  candidateOrdinal: number,
  draftsUpdatedAt: string,
  position: ExpansionReadPosition,
  maxOutputChars: number,
): { fields: Record<string, unknown>; body: string } | null {
  const render = (fields: Record<string, unknown>, body: string) =>
    JSON.stringify({ ...head, ...fields, available: true, body });
  const fieldsOf = (page: ExpansionDraftPage) => pageFields(page, draft, totalCandidates, candidateOrdinal, draftsUpdatedAt);
  const paginate = (maxChars: number) => paginateExpansionDraft(draft, position, maxChars);
  const emptyPage: ExpansionDraftPage = {
    startBlockOrdinal: position.blockOrdinal, startBlockOffset: position.blockOffset, endBlockOrdinal: null,
    endBlockOffset: 0, blocksInPage: 0, bodyChars: 0, blockTextTruncated: false, body: "", nextInCandidate: null,
  };
  let page = paginate(Math.max(EXPANSION_READ_MIN_BODY_CHARS,
    maxOutputChars - render(fieldsOf(emptyPage), "").length));
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const fields = fieldsOf(page);
    const rendered = render(fields, page.body).length;
    if (rendered <= maxOutputChars) return { fields, body: page.body };
    // 比例法：量出这一页正文转义后实际占了多少，再按剩下的额度一次缩到位。
    // 折半会退化成几十页（正文全是控制字符时转义率是 6 倍），比例法一两步就收敛。
    const withoutBody = render(fields, "").length;
    const escapedBody = rendered - withoutBody;
    const room = maxOutputChars - withoutBody;
    const scale = escapedBody > 0 ? room / escapedBody : 0;
    const smaller = paginate(Math.max(EXPANSION_READ_MIN_BODY_CHARS, Math.floor(page.body.length * scale)));
    if (smaller.body.length >= page.body.length) break;
    page = smaller;
  }
  const fields = fieldsOf(page);
  return render(fields, page.body).length <= maxOutputChars ? { fields, body: page.body } : null;
}

interface ExpansionTaskRow extends Record<string, unknown> {
  task_id: string;
  job_status: string;
  drafts: unknown;
  confirmed_candidate_ids: unknown;
  artifact: unknown;
  operation_revision: number;
  drafts_updated_at: string;
}

/**
 * 读一批拓展草稿的一页。读不到（不是这个目标的成果、绑定对不上、材料失权）返回 null，
 * 位置或版本不对抛 400 ——「读不到」和「你给的位置不对」是两件不同的事，不能混成一句。
 *
 * 调用方必须在自己的事务里调它：材料可见性与冻结输入的核对要和这一次读在同一次事务内，
 * 否则取消或修订可能夹在两次之间。
 */
export async function readExpansionDrafts(
  tx: AgentSqlExecutor,
  input: ExpansionReadRequest,
): Promise<ExpansionReadResult | null> {
  const rows = await queryRows<ExpansionTaskRow>(tx, sql`
    SELECT n.id::text AS task_id,
           j.status::text AS job_status,
           n.drafts,
           n.confirmed_candidate_ids,
           o.artifact,
           o.revision::int AS operation_revision,
           to_char(n.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS drafts_updated_at
    FROM public.note_expansion_tasks n
    JOIN public.jobs j
      ON j.id = n.id
     AND j.type = ${EXPANSION_CAPABILITY}
     AND j.workspace_id = n.workspace_id
     AND j.requested_by = n.user_id
     AND j.payload->>'noteId' = n.note_id::text
     AND j.payload->>'noteVersionId' = n.note_version_id::text
    JOIN public.agent_operations o
      ON o.job_id = n.id
     AND o.capability = ${EXPANSION_CAPABILITY}
     AND o.run_id = ${input.runId}::uuid
     AND o.workspace_id = n.workspace_id
     AND o.user_id = n.user_id
     AND o.status = 'succeeded'
     AND o.artifact IS NOT NULL
     AND o.artifact->>'kind' = 'note_expansion'
     AND o.artifact->>'id' = n.id::text
     AND o.artifact->>'jobId' = n.id::text
     AND o.artifact->>'noteId' = n.note_id::text
     AND o.artifact->>'noteVersionId' = n.note_version_id::text
    JOIN public.agent_runs r
      ON r.id = o.run_id AND r.workspace_id = n.workspace_id AND r.user_id = n.user_id
    JOIN public.notes src
      ON src.id = n.note_id AND src.workspace_id = n.workspace_id
     AND src.deleted_at IS NULL
     AND ${sql.raw(noteVisibleSqlText("src", VIEWER))}
    JOIN public.note_versions v
      ON v.id = n.note_version_id AND v.note_id = n.note_id AND v.workspace_id = n.workspace_id
    WHERE n.id = ${input.taskId}::uuid
      AND n.workspace_id = ${input.workspaceId}
      AND n.user_id = ${input.userId}
      AND n.note_id = ${input.noteId}::uuid
      AND n.note_version_id = ${input.noteVersionId}::uuid
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(r.inputs) i
        WHERE i->>'noteId' = n.note_id::text
          AND i->>'noteVersionId' = n.note_version_id::text)
    LIMIT 1
  `);
  const row = rows[0];
  if (!row) return null;

  const artifact = row.artifact as { id?: string; jobId?: string } | null;
  if (artifact?.id !== row.task_id || artifact?.jobId !== row.task_id) return null;

  const parsed = draftsSchema.safeParse(row.drafts);
  const drafts = parsed.success ? parsed.data : [];
  const confirmedIds = Array.isArray(row.confirmed_candidate_ids) ? row.confirmed_candidate_ids as string[] : null;
  const summary: ExpansionReadSummary = {
    status: "succeeded",
    taskId: row.task_id,
    noteId: input.noteId,
    noteVersionId: input.noteVersionId,
    taskState: expansionTaskState(row.job_status, drafts, confirmedIds),
    draftCount: drafts.length,
    draftsUpdatedAt: row.drafts_updated_at,
    artifactRevision: Number(row.operation_revision),
  };
  if (drafts.length === 0)
    return { ...summary, available: false, reason: parsed.success ? "no_drafts_yet" : "drafts_unreadable" };

  const resolved = resolveExpansionReadPosition(drafts, {
    candidateOrdinal: input.startCandidateOrdinal,
    blockOrdinal: input.startBlockOrdinal,
    blockOffset: input.startBlockOffset,
  }, input.draftsUpdatedAt, row.drafts_updated_at);
  if (!resolved.ok)
    throw new AgentStoreError(400, "invalid_read_position", resolved.rejection.detail);

  const totalCandidates = drafts.length;
  const { position, draft } = resolved;
  const fixed = expansionDraftEchoFields(draft, {
    candidateOrdinal: position.candidateOrdinal, totalCandidates,
    confirmed: new Set(confirmedIds ?? []).has(draft.candidateId),
  });
  const bounded = boundExpansionReadPage({ ...summary, ...fixed }, draft, totalCandidates,
    position.candidateOrdinal, row.drafts_updated_at, position, input.maxOutputChars);
  if (!bounded)
    throw new AgentStoreError(422, "expansion_page_too_large",
      "这一页的元数据加上正文放不进一次输出的上限，请缩小选区后重试；不会返回一页读不出东西的正文。");
  return { ...summary, ...fixed, ...bounded.fields, body: bounded.body, available: true } as ExpansionReadResult;
}

function expansionTaskState(
  jobStatus: string,
  drafts: readonly NoteExpansionDraftV1[],
  confirmedIds: readonly string[] | null,
): ExpansionReadResult["taskState"] {
  if (jobStatus === "pending") return "queued";
  if (jobStatus === "running") return "running";
  if (jobStatus !== "succeeded" || drafts.length === 0) return "failed";
  const confirmed = new Set(confirmedIds ?? []);
  return drafts.every((draft) => confirmed.has(draft.candidateId)) ? "confirmed" : "ready";
}
