/**
 * 伴星 agent 的**读工具**（2026-09-30 拆出，B2）。
 *
 * ## 为什么拆
 *
 * `companion-agent-runtime.ts` 此前 3950 行，混着四类东西：
 * 步进规划、事件持久化、**读工具**、工具执行与提案创建。
 *
 * 读工具这一族是自成一体的：它只做「按参数取一页内容 → 裁成模型能吃的形状」，
 * 不推进步数、不写事件、不碰工具调用账本。所以它可以在不看 runtime 其余部分
 * 的前提下单独读、单独测。
 *
 * 拆出来之前它躺在 runtime 中段，于是"改一个分页上限"看起来像"改 agent 运行时"
 * ——而那两件事的风险完全不同。
 *
 * ## 这一段是**照搬**的
 *
 * 判据、上限、SQL 一个字没改。调用点在 `companion-agent-runtime.ts`，从这里 import。
 */

import { sql, type SQL } from "drizzle-orm";
import { pageReadableV1Schema } from "@astella/shared/companion-bridge-contracts";
import { noteVisibleSqlText } from "@astella/shared/note-visibility";
import { PAGE_KIND_LABELS } from "./companion-here-and-now.ts";
import { CompanionToolUnavailableError } from "./companion-tool-result.ts";


import { withWorkerWorkspaceTransaction, type WorkerTransaction } from "../db.ts";
import type { CompanionAgentToolExecutionConstraints } from "@astella/shared";
import type { CompanionDialogueHandlerContext, ReadContext } from "./companion-dialogue-store.ts";

export interface AgentEventContext {
  ctx: CompanionDialogueHandlerContext;
  read: ReadContext;
  expiresAt: string;
  /**
   * 服务端判定的执行约束，跟着工具执行走（下发面另外单独用它过滤，见 loop）。
   * 放这里而不是逐层加参数：它是"这一轮的事实"，与 run/workspace 同生命周期。
   */
  constraints: CompanionAgentToolExecutionConstraints;
}

/** 每页正文预算；超长块用块内游标续读，不丢弃余下正文。 */
export const NOTE_READ_MAX_CHARS = 3_000;

export interface ReadPageBlock {
  readonly ordinal: number;
  readonly content: string;
}

export interface ReadPage {
  readonly blocks: readonly { ordinal: number; content: string; startOffset: number; complete: boolean }[];
  readonly body: string;
  /** 本页实际读到的最后一个块序号；一块都没有时为 null。 */
  readonly endOrdinal: number | null;
  /** 单块超预算被切了文本（这一页在块中间结束）。 */
  readonly blockTextTruncated: boolean;
  /** 非 null 时仍在 endOrdinal 内，续读须同时带回块序号与此 offset。 */
  readonly nextStartOffset: number | null;
}

/**
 * 把块序列装进一页字符预算（39d W6-2 / 39b C5 的分页读取）。
 *
 * 装到预算为止就停；**至少装一块**——单块超预算时切那一块的文本并标
 * `blockTextTruncated`，否则一篇"只有一段超长正文"的笔记永远一页都读不出来。
 * 超长首块在块内分页；正文不添加省略号，游标描述未读边界。
 */
export function paginateReadBlocks(blocks: readonly ReadPageBlock[], maxChars: number, startOffset = 0): ReadPage {
  if (!Number.isSafeInteger(maxChars) || maxChars < 2 || !Number.isSafeInteger(startOffset) || startOffset < 0) {
    throw new Error("invalid read page budget or offset");
  }
  const parts: string[] = [];
  const pageBlocks: Array<{ ordinal: number; content: string; startOffset: number; complete: boolean }> = [];
  let used = 0;
  let endOrdinal: number | null = null;
  let blockTextTruncated = false;
  let nextStartOffset: number | null = null;
  for (const [index, block] of blocks.entries()) {
    const offset = index === 0 ? startOffset : 0;
    if (offset > block.content.length) throw new Error("read page offset exceeds block length");
    const remaining = block.content.slice(offset);
    const separator = parts.length > 0 ? "\n\n" : "";
    const room = maxChars - used - separator.length;
    if (room <= 0 && parts.length > 0) break;
    // 整块装不下且**不是本页第一块** → 留给下一页。只有第一块才允许切：
    // 否则每块都被切成半句拼进本页，用户读到的是被碎块化的正文。
    if (remaining.length > room && parts.length > 0) break;
    let take = Math.min(remaining.length, room);
    // UTF-16 offset agrees with JS/string contracts, but never splits a surrogate pair.
    if (take < remaining.length && /[\uD800-\uDBFF]/.test(remaining.charAt(take - 1))) take--;
    const text = remaining.slice(0, take);
    pageBlocks.push({ ordinal: block.ordinal, content: text, startOffset: offset, complete: offset === 0 && take === block.content.length });
    parts.push(separator + text);
    used += separator.length + text.length;
    endOrdinal = block.ordinal;
    if (text.length < remaining.length) {
      blockTextTruncated = true;
      nextStartOffset = offset + text.length;
      break;
    }
  }
  return { body: parts.join(""), blocks: pageBlocks, endOrdinal, blockTextTruncated, nextStartOffset };
}

/** 来源没解析好时的那句照实说明（39b C5："来源没有解析或无权限时明确说明"）。 */
export function sourceNotReadyNote(status: string): string {
  const wording: Record<string, string> = {
    draft: "还没开始解析",
    processing: "还在解析中",
    failed: "解析失败了",
    archived: "已归档",
  };
  return `这份来源${wording[status] ?? "还没解析好"}，现在读不到正文。不要假装读过，也不要凭标题猜内容。`;
}

/**
 * 笔记读取实际需要的那个端口：**只有 execute**，且只把行当作普通对象数组交出来。
 *
 * 这个函数不写任何东西，也不需要事务的其余能力。把它收窄成结构化的最小面，
 * Agent 调用点就能把它自己的执行器适配过来（`queryRows` 已经是同一件事的另一半），
 * 于是那次读取可以和可见性/冻结输入的核对待在**同一次事务**里 —— 否则取消或修订
 * 可能夹在「核对通过」与「真的读到」之间。
 *
 * 声明最小面而不是 `WorkerTransaction`：声明一个自己没有的能力，只会让下一个调用点
 * 以为它可以写。行类型也不在这里泛化 —— 驱动返回的是带品牌的 RowList，把它泛化过来
 * 只会逼调用点去断言「这其实就是个数组」；所以窄到 `Record<string, unknown>[]`，
 * 具名的行类型留给下面每条查询自己声明。
 */
export interface ReadPageSqlExecutor {
  execute(query: SQL): Promise<Record<string, unknown>[]>;
}

/**
 * 笔记读取的**数据装载半**（39d W6-2；集测直接调它，走的是与工具同一份生产 SQL，
 * 不是复刻形状）。可见性与 read_note 的旧实现同一句话（noteVisibleSqlText）：
 * 缺它时协作空间里成员甲的伴星能读出成员乙私有笔记的正文。
 */
export async function loadNoteReadPage(
  tx: ReadPageSqlExecutor,
  input: { workspaceId: string; userId: string; noteId: string; noteVersionId?: string; startOrdinal: number; startOffset?: number; maxChars: number },
): Promise<{
  title: string; versionId: string; ageMinutes: number;
  totalBlocks: number;
  imageIds: string[]; imageTotal: number;
  page: ReadPage;
  truncated: boolean;
  nextStartOrdinal: number | null;
  nextStartOffset: number | null;
} | null> {
  const heads = await tx.execute(sql`
    SELECT n.title,
           COALESCE(requested_version.id, n.current_version_id)::text AS version_id,
           (EXTRACT(EPOCH FROM (now() - n.updated_at)) / 60)::int AS age_minutes
    FROM notes n
    LEFT JOIN note_versions requested_version
      ON requested_version.id = ${input.noteVersionId ?? null}::uuid
      AND requested_version.note_id = n.id
      AND requested_version.workspace_id = n.workspace_id
    WHERE n.id = ${input.noteId}::uuid
      AND n.workspace_id = ${input.workspaceId}
      AND n.deleted_at IS NULL
      AND ${sql.raw(noteVisibleSqlText("n", `'${input.userId}'::uuid`))}
      AND (${input.noteVersionId ?? null}::uuid IS NULL OR requested_version.id IS NOT NULL)
    LIMIT 1
  `);
  const head = heads[0] as NoteReadRow | undefined;
  if (!head) return null;
  const blocks = await tx.execute(sql`
    SELECT numbered.ordinal::text AS ordinal, numbered.content FROM (
      SELECT row_number() OVER (ORDER BY nb.ordinal) AS ordinal, nb.content
      FROM note_blocks nb WHERE nb.version_id = ${head.version_id}::uuid
    ) numbered WHERE numbered.ordinal >= ${input.startOrdinal} ORDER BY numbered.ordinal
  `);
  const totals = await tx.execute(sql`
    SELECT count(*)::text AS total FROM note_blocks nb
    WHERE nb.version_id = ${head.version_id}::uuid
  `);
  const images = await tx.execute(sql`
    SELECT a.id::text AS id, count(*) OVER () AS total
    FROM note_image_assets a
    WHERE a.workspace_id = ${input.workspaceId}
      AND a.uploaded_for_note_id = ${input.noteId}::uuid
      AND a.status = 'ready' AND a.deleted_at IS NULL
    ORDER BY a.created_at DESC, a.id
    LIMIT 6
  `);
  // 分页与续读指针在装载半里完成（组合点只有这一处）：工具与集测看到的是同一页。
  const page = paginateReadBlocks(
    (blocks as { ordinal: string; content: string }[]).map((row) => ({ ordinal: Number(row.ordinal), content: row.content })),
    input.maxChars,
    input.startOffset,
  );
  const totalBlocks = Number((totals[0] as { total?: string } | undefined)?.total ?? 0);
  const nextStartOrdinal = page.nextStartOffset !== null ? page.endOrdinal : page.endOrdinal !== null && page.endOrdinal < totalBlocks
    ? page.endOrdinal + 1
    : null;
  return {
    title: head.title,
    versionId: head.version_id,
    ageMinutes: head.age_minutes,
    totalBlocks,
    imageIds: (images as { id: string }[]).map((row) => row.id),
    imageTotal: Number((images[0] as { total?: string } | undefined)?.total ?? 0),
    page,
    truncated: nextStartOrdinal !== null || page.blockTextTruncated,
    nextStartOrdinal,
    nextStartOffset: page.nextStartOffset,
  };
}

/** 来源读取的数据装载半（39d W6-2）：未就绪时返回 status、不给段。 */
export async function loadSourceReadPage(
  tx: Parameters<Parameters<typeof withWorkerWorkspaceTransaction>[1]>[0],
  input: { workspaceId: string; sourceId: string; startOrdinal: number; startOffset?: number; maxChars: number },
): Promise<{
  title: string; status: string; origin: string | null;
  totalSegments: number;
  page: ReadPage | null;
  truncated: boolean;
  nextStartOrdinal: number | null;
  nextStartOffset: number | null;
} | null> {
  const heads = await tx.execute<{ title: string; status: string; origin: string | null }>(sql`
    SELECT s.title, s.status::text AS status, s.origin
    FROM sources s
    WHERE s.id = ${input.sourceId}::uuid
      AND s.workspace_id = ${input.workspaceId}
    LIMIT 1
  `);
  const head = heads[0];
  if (!head) return null;
  if (head.status !== "ready") {
    return { title: head.title, status: head.status, origin: head.origin, totalSegments: 0, page: null, truncated: false, nextStartOrdinal: null, nextStartOffset: null };
  }
  const segments = await tx.execute<{ ordinal: string; text: string }>(sql`
    SELECT sg.ordinal::text AS ordinal, sg.text
    FROM source_segments sg
    WHERE sg.source_id = ${input.sourceId}::uuid
      AND sg.workspace_id = ${input.workspaceId}
      AND sg.ordinal >= ${input.startOrdinal}
    ORDER BY sg.ordinal
  `);
  const totals = await tx.execute<{ total: string }>(sql`
    SELECT count(*)::text AS total FROM source_segments sg
    WHERE sg.source_id = ${input.sourceId}::uuid
      AND sg.workspace_id = ${input.workspaceId}
  `);
  const page = paginateReadBlocks(
    segments.map((row) => ({ ordinal: Number(row.ordinal), content: row.text })),
    input.maxChars,
    input.startOffset,
  );
  const totalSegments = Number(totals[0]?.total ?? 0);
  const nextStartOrdinal = page.nextStartOffset !== null ? page.endOrdinal : page.endOrdinal !== null && page.endOrdinal < totalSegments
    ? page.endOrdinal + 1
    : null;
  return {
    title: head.title,
    status: head.status,
    origin: head.origin,
    totalSegments,
    page,
    truncated: nextStartOrdinal !== null || page.blockTextTruncated,
    nextStartOrdinal,
    nextStartOffset: page.nextStartOffset,
  };
}

/**
 * 读图：原图字节上限。
 *
 * 上传侧允许 10MB，而一次视觉请求要把它 base64（≈×1.37）后整包发出去。不设这一层
 * 的结果不是"慢一点"：手机拍的原图稳定把这一步推到超时，用户看到的是"她没反应"，
 * 比一句"这张太大我看不了"坏得多。超过它就明确拒绝，不静默降分辨率（那会悄悄改变
 * 她看到的内容，而小字正是图片里最值钱的部分）。
 */
export const READ_IMAGE_MAX_RAW_BYTES = 2_000_000;

/**
 * 读图的独立工具预算。
 *
 * `COMPANION_AGENT_TOOL_TIMEOUT_MS`(10s) 是按"查一次库"定的；读图里嵌的是一次
 * 完整的视觉模型往返（GLM-4.1V-Thinking-Flash 带思考，20–40s 是常态）。沿用 10s
 * 不是"偶尔超时"而是**每轮必超时**，而她拿到的是 `ok:false` + 一句通用失败。
 * 仍受 run deadline 夹住（取 min），不会把整轮拖爆。
 */
export const READ_IMAGE_TOOL_TIMEOUT_MS = DEFAULT_AI_PROVIDER_TIMEOUT_MS;

/** 政策拒绝时给她的那句话：说得出原因、也给得出出路，不出现内部术语。 */
export const VISION_EGRESS_DENIED_MESSAGE = "「允许发送图片内容」没有开启，图片留在本机，我看不到图里的内容";

/** 无实体页面的中文名，只用于 safeSummary（它会进她的可见轨迹）。 */
export interface NoteSearchRow extends Record<string, unknown> {
  id: string;
  title: string;
  age_minutes: number;
  snippet: string | null;
}

export interface NoteReadRow extends Record<string, unknown> {
  title: string;
  /** 这一版正文的稳定定位（读侧分页引用它 + 块序号，39d W6-2）。 */
  version_id: string;
  age_minutes: number;
}

/** 一张可被 `companion_read_image` / `companion_show_image` 取到的图。 */
export interface ImageAssetRow extends Record<string, unknown> {
  id: string;
  object_key: string;
  mime_type: string;
  byte_size: number;
  width: number;
  height: number;
  note_title: string | null;
}

/**
 * 按 assetId 或「noteId + 第几张」取一张图，并带回**这篇一共有几张**。
 *
 * 读图与显示图共用这一条查询，所以两边对"哪一张"的理解必须一致：
 * `position` 与 `companion_read_note` 回传的 `imageAssetIds` 同一排序
 * （created_at DESC, id），她拿着那个列表说"第 2 张"才真的是第 2 张。
 *
 * 两个 id 都可能是模型编的，所以取字节的唯一途径是**我们自己库里的行**：
 * 查不到就没有 object_key，也就拼不出任何指向任意地址的请求。
 *
 * 总数单独查一条：取不到图时她要的是"这篇只有 5 张，没有第 8 张"，
 * 而不是一句"找不到"——后者会让她下一轮继续猜。
 */
export async function findNoteImageAsset(
  event: AgentEventContext,
  ref: { assetId: string | null; noteId: string | null; position: number },
): Promise<{ asset: ImageAssetRow | null; noteTotal: number }> {
  return withWorkerWorkspaceTransaction(
    { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
    async (tx) => {
      const rows = await tx.execute<ImageAssetRow>(ref.assetId
        ? sql`
            SELECT a.id::text AS id, a.object_key, a.mime_type, a.byte_size, a.width, a.height,
                   n.title AS note_title
            FROM note_image_assets a
            LEFT JOIN notes n ON n.id = a.uploaded_for_note_id AND n.workspace_id = a.workspace_id
            WHERE a.workspace_id = ${event.ctx.workspaceId}
              AND a.status = 'ready' AND a.deleted_at IS NULL
              AND a.id::text = ${ref.assetId}
            LIMIT 1
          `
        : sql`
            SELECT a.id::text AS id, a.object_key, a.mime_type, a.byte_size, a.width, a.height,
                   n.title AS note_title
            FROM note_image_assets a
            LEFT JOIN notes n ON n.id = a.uploaded_for_note_id AND n.workspace_id = a.workspace_id
            WHERE a.workspace_id = ${event.ctx.workspaceId}
              AND a.uploaded_for_note_id::text = ${ref.noteId}
              AND a.status = 'ready' AND a.deleted_at IS NULL
            ORDER BY a.created_at DESC, a.id
            LIMIT 1 OFFSET ${ref.position - 1}
          `);
      const asset = rows[0] ?? null;
      // 只有"按 noteId 却没取到"时才需要总数（多半是 position 越界）。
      const totals = !asset && ref.noteId
        ? await tx.execute<{ n: string }>(sql`
            SELECT count(*) AS n FROM note_image_assets a
            WHERE a.workspace_id = ${event.ctx.workspaceId}
              AND a.uploaded_for_note_id::text = ${ref.noteId}
              AND a.status = 'ready' AND a.deleted_at IS NULL
          `)
        : [];
      return { asset, noteTotal: Number(totals[0]?.n ?? 0) };
    },
  );
}

/** `SOURCE_IMAGE_UPLOAD_PREFIX` 的 worker 侧对应物：渲染层认的就是这个形状。 */
export const SITE_IMAGE_URL_PREFIX = "/api/uploads/";

export function missingImageMessage(assetId: string | null): string {
  return assetId
    ? "这张图我没找到，可能它已经不在了。"
    : "那篇笔记里没有这张图（可能已经删了，也可能当初只是把图片地址写进了正文）";
}

export interface TaskQueueRow extends Record<string, unknown> {
  task_id: string;
  sequence: number;
  status: string;
  label: string | null;
  run_phase: string;
  run_id: string | null;
}

/**
 * `companion_list_task_queue` 的结果（纯函数，便于测）。
 *
 * 带 route 的理由（实机 2026-09-22 真人轮「我接下来的任务队列里都排着什么？」）：
 * 这个工具此前只回文字清单，**既不给 route 也不出块**，而 `open_page` 的白名单里
 * 又没有一个"任务队列"页可跳——她把清单念完了，用户想点开看一眼却无路可走。
 * 队列本来就属于某一次学习运行，所以跳到那一轮的运行页就是它该去的地方。
 */
export function taskQueueToolResult(rows: TaskQueueRow[]): {
  value: Record<string, unknown>;
  safeSummary: string;
  route?: Record<string, unknown>;
  routeLabel?: string;
} {
  const tasks = rows.map((row) => ({
    taskId: row.task_id,
    step: Number(row.sequence),
    status: row.status,
    label: String(row.label ?? "").slice(0, 80),
  }));
  if (tasks.length === 0) {
    return { value: { tasks }, safeSummary: "当前没有排着的任务" };
  }
  // 行是按 `r.updated_at DESC, t.sequence` 排的，第一条就是"下一个要做的"，
  // 它所属的那轮运行也就是用户点进去最该落到的地方。
  const firstRunId = rows[0].run_id;
  return {
    value: { tasks },
    safeSummary: `队列里有 ${tasks.length} 个待办任务`,
    ...(firstRunId
      ? {
        route: { kind: "learning_run", runId: firstRunId },
        routeLabel: "打开这轮学习，看完整任务队列",
      }
      : {}),
  };
}

export interface ActivityRow extends Record<string, unknown> {
  kind: string;
  label: string | null;
  age_minutes: number;
}

export interface DueReviewRow extends Record<string, unknown> {
  schedule_id: string;
  /**
   * `review_schedules.subject_id`。名字骗人：这张表的 `subject_type` 被 CHECK 成 'card'，
   * 但按方案 20 §29.4 的别名规则，**列里存的是 objectiveId**（实测量：23 个 subject_id
   * 里 19 个命中 `learning_cards_v2.objective_id`，只有 4 个是 card_id）。
   * `companion_open_card` 两个键都认，所以它可以往下传这个。
   */
  objective_id: string;
  /** 该目标当前那张 active 卡；没有就是 null（她得能说"这条还没有卡"）。 */
  card_id: string | null;
  title: string;
  overdue_hours: number;
}

/**
 * `companion_read_current_page` 的结果（纯函数，便于测）。
 *
 * 三件事是这条工具的存在理由，缺一条它就会重新变成"真而无关的答案"：
 *
 * 1. **读不到就明说读不到。** 这次事故里她不是沉默，是拿 `list_task_queue`
 *    （查 `learning_tasks`，与卡片生成毫无关系）的"队列是空的"推出了
 *    "系统没在跑东西"。`available:false` 必须是一个她看得懂、而且不会再去找
 *    替代数字的答复。
 * 2. **裁剪在服务端做，不信客户端自报的 sensitivity。** 正式作答页的条目正文就是
 *    题目本身，只丢 `items`；凭证页整块不给。
 * 3. **新鲜度只有一个来源。** 视图里没有时间戳，"这份内容多久没变"由服务端从
 *    `issued_at` 算——否则她嘴里的"6 分钟前"和屏幕上的"6 分钟前"会是两个数。
 */
export interface PageContextRow extends Record<string, unknown> {
  page_kind: string;
  sensitivity: string;
  readable_view: unknown;
  content_age_seconds: number;
}

export function currentPageToolResult(row: PageContextRow | null): {
  value: Record<string, unknown>;
  safeSummary: string;
} {
  // 注意 `no_live_page` **不**抛：那时根本没有页面，是"现在没有"而不是
  // "这个能力不可用"。40b §3.2 的 unavailable 说的是后者。
  if (!row) {
    return {
      value: { available: false, reason: "no_live_page" },
      safeSummary: "这一页现在没有可读的内容",
    };
  }
  if (row.sensitivity === "credential_surface") {
    // 40b §3.2：`unavailable` = 「所需资源或能力不可用，指出实际影响及可用替代」。
    // 凭据页正是这一类——页面在、能力在，就是这一处不给读。
    //
    // 为什么改成**抛**而不是在 value 里说 available:false：账本状态与页面文案
    // 必须和模型看到的是同一个身份（§3.2「二者对应同一运行身份」）。塞在
    // payload 里的话，账本记的是 succeeded，页面显示"读成功"，只有模型
    // 知道拿不到——那正是 0349 之前 not_executed 被压成 failed 的同一种病。
    throw new CompanionToolUnavailableError(
      "这一页是凭据相关的页面，内容不能读；换一页或直接问我别的。",
    );
  }
  const parsed = pageReadableV1Schema.safeParse(row.readable_view);
  if (!parsed.success) {
    // 落库的视图对不上合同（旧行、或页面登记错了形状）——按"这页没登记可读内容"
    // 处理，而不是把半份形状递给她去猜。
    const label = PAGE_KIND_LABELS[row.page_kind] ?? row.page_kind;
    // 同上：`page_not_readable` 是「这一页读不了」，属于能力不可用而不是
    // 「读到了但是空的」。§3.2 要求页面、账本与模型看到同一个类别。
    throw new CompanionToolUnavailableError(
      `这一页还没有登记可读内容（${label}）；换一页或直接问我别的。`,
    );
  }
  const view = parsed.data;
  const isFormalAssessment = row.sensitivity === "formal_assessment";
  const ageSeconds = Math.max(0, Number(row.content_age_seconds));
  const value: Record<string, unknown> = {
    available: true,
    pageKind: row.page_kind,
    pageId: view.pageId,
    title: view.title,
    contentAgeSeconds: ageSeconds,
    ...(view.statusLine ? { statusLine: view.statusLine } : {}),
    ...(view.metrics?.length ? { metrics: view.metrics } : {}),
    ...(view.notice ? { notice: view.notice } : {}),
    ...(view.filters?.length ? { filters: view.filters } : {}),
    // 正式作答页的条目正文就是题目：只给"这页在作答、有几项"，正文不给。
    ...(isFormalAssessment
      ? { itemsOmitted: true, itemCount: view.items?.length ?? 0 }
      : view.items?.length ? { items: view.items } : {}),
  };
  const itemCount = view.items?.length ?? 0;
  return {
    value,
    safeSummary: itemCount > 0
      ? `正在看「${view.title}」· 屏上 ${itemCount} 项`
      : `正在看「${view.title}」`,
  };
}

/**
 * 取"这一屏"那一条 context 行（集测直接调它做跨空间守卫的往返验证）。
 *
 * workspace_id / user_id 必须在 SQL 里显式过滤：这张表的 RLS 守卫对
 * `astella_worker` 是**放行**的（`CURRENT_USER = 'astella_worker' OR ...`），
 * 也就是说行级隔离在这条路径上不存在，漏一个条件就是跨账号读到别人的屏。
 */
export async function readLatestPageContextRow(
  tx: WorkerTransaction,
  scope: { workspaceId: string; userId: string },
): Promise<PageContextRow | null> {
  const rows = await tx.execute<PageContextRow>(sql`
    SELECT page_kind,
           sensitivity,
           readable_view,
           EXTRACT(EPOCH FROM (now() - issued_at))::int AS content_age_seconds
    FROM assistant_page_contexts
    WHERE workspace_id = ${scope.workspaceId}
      AND user_id = ${scope.userId}
      AND revoked_at IS NULL
      AND expires_at > now()
    ORDER BY issued_at DESC, id
    LIMIT 1
  `);
  return Array.isArray(rows) ? rows[0] ?? null : null;
}
import { DEFAULT_AI_PROVIDER_TIMEOUT_MS } from "@astella/shared";
