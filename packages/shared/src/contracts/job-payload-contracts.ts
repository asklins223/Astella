/**
 * 作业 payload 契约（按作业类型分型）。
 *
 * 审计事实（稳定 P1，2026-09-15）：`jobs.payload` 是 `jsonb NOT NULL`，drizzle 侧
 * 只标注为 `$type<Record<string, unknown>>`；生产端手写对象字面量（见
 * `apps/api/src/modules/source/service.ts` 的 parse_source 裸插入），消费端用
 * `job.payload.sourceId as string | undefined` 取值。后果是字段改名/漏传**没有任何
 * 编译期反馈**，只在运行期表现为 "missing sourceId in payload"，而且那条是**可重试**
 * 失败——重试三次才 dead letter，期间每次都在消耗租约。
 *
 * 本文件把**非 companion** 作业的 payload 收敛成精确契约（companion_* 的载荷由各自
 * 的契约模块负责，见 companion-memory-job-payload.ts，不在这里重复定义）：
 *
 *   - 生产端：`const payload: ParseSourceJobPayload = {...}` —— 漏字段、拼错字段、
 *     类型不对都直接编译失败；
 *   - 消费端：`readParseSourceJobPayload()` 校验 + 归一化，非法载荷抛
 *     `JobPayloadContractError`（**确定性失败**，worker 归类为不可重试，直接 dead）；
 *   - 新增非 companion 作业类型：登记进 `TypedJobPayloadByType` 即自动获得同样强度的
 *     约束；`JobPayloadFor<T>` 对未登记的类型（含 companion_*）回退为不透明 JSON，
 *     所以这份文件不会替 companion 侧做决定。
 *
 * 纯类型 + 常量 + 一个纯函数，无 node: 依赖，可从 index.ts 与子路径同时导入。
 */
import { JobType } from "../enums.ts";

export const PARSE_SOURCE_JOB_PAYLOAD_FIELDS = {
  sourceId: "sourceId",
  fetchUrlContent: "fetchUrlContent",
} as const;

/**
 * parse_source 的 payload。
 *
 * 刻意用 `type` 而不是 `interface`：interface 没有隐式索引签名，无法赋给
 * `Record<string, unknown>`（jobs.payload 的列类型），会让生产端插入处报类型错误。
 *
 * 历史字段 `userId` 已删除——生产端写、**无人读**：worker 只读 sourceId 与
 * fetchUrlContent（租户与 actor 归属一律走 `jobs.workspace_id` / `jobs.requested_by`，
 * 见 parse-source.ts），而 jobs 查询接口本来就把它从响应里脱敏掉（R-006）。
 * 契约只保留真实被消费的字段，避免"看着像有约定、其实没人看"的假契约。
 */
export type ParseSourceJobPayload = {
  sourceId: string;
  /** URL 类型来源且尚无正文时为 true：worker 需先抓取 URL 正文再分段。 */
  fetchUrlContent?: true;
};

export type CompanionThoughtJobPayload = {
  userId: string;
};

export type NoteOverviewGenerateJobPayload = {
  noteId: string;
  noteVersionId: string;
  requestId: string;
};

export type NoteAnnotationExplainJobPayload = {
  noteId: string;
  noteVersionId: string;
  requestId: string;
  anchor: {
    noteVersionId: string;
    startBlockOrdinal: number;
    startOffset: number;
    endBlockOrdinal: number;
    endOffset: number;
    excerpt: string;
    prefix: string;
    suffix: string;
  };
};

export type NoteDynamicArtifactGenerateJobPayload = {
  noteId: string;
  noteVersionId: string;
  requestId: string;
  sourceKind: "overview" | "annotation";
  anchor?: NoteAnnotationExplainJobPayload["anchor"];
};

export type NoteExpansionGenerateJobPayload = {
  noteId: string;
  noteVersionId: string;
  requestId: string;
  focusAnchor?: NoteAnnotationExplainJobPayload["anchor"];
  sourceMessageId?: string;
  conversationId?: string;
};

/** 已强类型化的作业类型 → payload 契约映射（目前只有非 companion 的 parse_source）。 */
export type TypedJobPayloadByType = {
  [JobType.PARSE_SOURCE]: ParseSourceJobPayload;
  [JobType.COMPANION_THOUGHT]: CompanionThoughtJobPayload;
  [JobType.NOTE_OVERVIEW_GENERATE]: NoteOverviewGenerateJobPayload;
  [JobType.NOTE_ANNOTATION_EXPLAIN]: NoteAnnotationExplainJobPayload;
  [JobType.NOTE_DYNAMIC_ARTIFACT_GENERATE]: NoteDynamicArtifactGenerateJobPayload;
  [JobType.NOTE_EXPANSION_GENERATE]: NoteExpansionGenerateJobPayload;
};

export type TypedJobType = keyof TypedJobPayloadByType;

/**
 * 某个作业类型的 payload 形状：已登记的类型用精确契约，其余（companion_*）保持
 * 不透明 JSON——收紧只发生在明确登记过的类型上。
 *
 * "新增类型自动收紧"由这张表本身保证：往 TypedJobPayloadByType 加一个键，
 * 该类型的 payload 立刻从 Record<string, unknown> 变成精确契约，调用点会当场报错。
 * 因此不需要额外的运行期清单（那种清单只会多一处需要同步的真相）。
 */
export type JobPayloadFor<TJobType extends string> =
  TJobType extends TypedJobType ? TypedJobPayloadByType[TJobType] : Record<string, unknown>;

/** payload 与类型不符（确定性失败：重试不会让缺失字段出现）。 */
export class JobPayloadContractError extends Error {
  readonly code = "job_payload_contract_error";
  constructor(readonly jobType: string, message: string) {
    super(`${jobType}: ${message}`);
    this.name = "JobPayloadContractError";
  }
}

export type NormalizedParseSourceJobPayload = {
  sourceId: string;
  /** 归一化为布尔：只有字面 true 才算需要抓取。 */
  fetchUrlContent: boolean;
};

/**
 * 读取并校验 parse_source 的 payload（fail closed）。
 *
 * `fetchUrlContent` 只认字面 `true`：历史载荷里可能混入 `"true"`/`1` 之类的脏值，
 * 把它当成"要抓 URL"会对外发起非预期请求；而把它当成 false 的代价只是不抓正文，
 * 用户可以重试。两害相权取后者。
 */
export function readParseSourceJobPayload(
  payload: Record<string, unknown> | null | undefined,
): NormalizedParseSourceJobPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new JobPayloadContractError(JobType.PARSE_SOURCE, "payload must be a JSON object");
  }
  const rawSourceId = payload[PARSE_SOURCE_JOB_PAYLOAD_FIELDS.sourceId];
  if (typeof rawSourceId !== "string" || rawSourceId.trim() === "") {
    throw new JobPayloadContractError(
      JobType.PARSE_SOURCE,
      `payload.${PARSE_SOURCE_JOB_PAYLOAD_FIELDS.sourceId} must be a non-empty string`,
    );
  }
  return {
    sourceId: rawSourceId,
    fetchUrlContent:
      payload[PARSE_SOURCE_JOB_PAYLOAD_FIELDS.fetchUrlContent] === true,
  };
}

export function readCompanionThoughtJobPayload(
  payload: Record<string, unknown> | null | undefined,
): CompanionThoughtJobPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new JobPayloadContractError(JobType.COMPANION_THOUGHT, "payload must be a JSON object");
  }
  const userId = payload.userId;
  if (typeof userId !== "string" || userId.trim() === "") {
    throw new JobPayloadContractError(JobType.COMPANION_THOUGHT, "payload.userId must be a non-empty string");
  }
  return { userId };
}

export function readNoteOverviewGenerateJobPayload(
  payload: Record<string, unknown> | null | undefined,
): NoteOverviewGenerateJobPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new JobPayloadContractError(JobType.NOTE_OVERVIEW_GENERATE, "payload must be a JSON object");
  }
  const readUuid = (key: keyof NoteOverviewGenerateJobPayload): string => {
    const value = payload[key];
    if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      throw new JobPayloadContractError(JobType.NOTE_OVERVIEW_GENERATE, `payload.${key} must be a UUID`);
    }
    return value;
  };
  return { noteId: readUuid("noteId"), noteVersionId: readUuid("noteVersionId"), requestId: readUuid("requestId") };
}

export function readNoteAnnotationExplainJobPayload(
  payload: Record<string, unknown> | null | undefined,
): NoteAnnotationExplainJobPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new JobPayloadContractError(JobType.NOTE_ANNOTATION_EXPLAIN, "payload must be a JSON object");
  }
  const uuid = (key: "noteId" | "noteVersionId" | "requestId") => {
    const value = payload[key];
    if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      throw new JobPayloadContractError(JobType.NOTE_ANNOTATION_EXPLAIN, `payload.${key} must be a UUID`);
    }
    return value;
  };
  const anchor = payload.anchor;
  if (!anchor || typeof anchor !== "object" || Array.isArray(anchor)) {
    throw new JobPayloadContractError(JobType.NOTE_ANNOTATION_EXPLAIN, "payload.anchor must be an object");
  }
  const candidate = anchor as Record<string, unknown>;
  const ordinal = (key: "startBlockOrdinal" | "endBlockOrdinal" | "startOffset" | "endOffset") => {
    const value = candidate[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new JobPayloadContractError(JobType.NOTE_ANNOTATION_EXPLAIN, `payload.anchor.${key} must be a non-negative integer`);
    }
    return value;
  };
  const stringField = (key: "excerpt" | "prefix" | "suffix", max: number, min = 0) => {
    const value = candidate[key];
    if (typeof value !== "string" || value.length < min || value.length > max) {
      throw new JobPayloadContractError(JobType.NOTE_ANNOTATION_EXPLAIN, `payload.anchor.${key} has an invalid length`);
    }
    return value;
  };
  const noteVersionId = uuid("noteVersionId");
  const anchorVersionId = candidate.noteVersionId;
  const startBlockOrdinal = ordinal("startBlockOrdinal");
  const endBlockOrdinal = ordinal("endBlockOrdinal");
  const startOffset = ordinal("startOffset");
  const endOffset = ordinal("endOffset");
  const excerpt = stringField("excerpt", 2_000, 1);
  if (typeof anchorVersionId !== "string" || anchorVersionId !== noteVersionId
    || endBlockOrdinal < startBlockOrdinal
    || startBlockOrdinal === endBlockOrdinal && endOffset <= startOffset) {
    throw new JobPayloadContractError(JobType.NOTE_ANNOTATION_EXPLAIN, "payload.anchor does not match the frozen note version");
  }
  return {
    noteId: uuid("noteId"),
    noteVersionId,
    requestId: uuid("requestId"),
    anchor: {
      noteVersionId,
      startBlockOrdinal,
      startOffset,
      endBlockOrdinal,
      endOffset,
      excerpt,
      prefix: stringField("prefix", 120),
      suffix: stringField("suffix", 120),
    },
  };
}

export function readNoteDynamicArtifactGenerateJobPayload(
  payload: Record<string, unknown> | null | undefined,
): NoteDynamicArtifactGenerateJobPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new JobPayloadContractError(JobType.NOTE_DYNAMIC_ARTIFACT_GENERATE, "payload must be a JSON object");
  }
  const uuid = (key: "noteId" | "noteVersionId" | "requestId") => {
    const value = payload[key];
    if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      throw new JobPayloadContractError(JobType.NOTE_DYNAMIC_ARTIFACT_GENERATE, `payload.${key} must be a UUID`);
    }
    return value;
  };
  const sourceKind = payload.sourceKind;
  if (sourceKind !== "overview" && sourceKind !== "annotation") {
    throw new JobPayloadContractError(JobType.NOTE_DYNAMIC_ARTIFACT_GENERATE, "payload.sourceKind must be overview or annotation");
  }
  const anchorValue = payload.anchor;
  if (sourceKind === "annotation" && (!anchorValue || typeof anchorValue !== "object" || Array.isArray(anchorValue))) {
    throw new JobPayloadContractError(JobType.NOTE_DYNAMIC_ARTIFACT_GENERATE, "payload.anchor is required for annotation artifacts");
  }
  if (sourceKind === "overview" && anchorValue !== undefined) {
    throw new JobPayloadContractError(JobType.NOTE_DYNAMIC_ARTIFACT_GENERATE, "payload.anchor is not allowed for overview artifacts");
  }
  let anchor: NoteDynamicArtifactGenerateJobPayload["anchor"];
  if (anchorValue && typeof anchorValue === "object" && !Array.isArray(anchorValue)) {
    const candidate = anchorValue as Record<string, unknown>;
    const anchorUuid = candidate.noteVersionId;
    if (typeof anchorUuid !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(anchorUuid)) {
      throw new JobPayloadContractError(JobType.NOTE_DYNAMIC_ARTIFACT_GENERATE, "payload.anchor.noteVersionId must be a UUID");
    }
    const ordinal = (key: "startBlockOrdinal" | "endBlockOrdinal" | "startOffset" | "endOffset") => {
      const value = candidate[key];
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        throw new JobPayloadContractError(JobType.NOTE_DYNAMIC_ARTIFACT_GENERATE, `payload.anchor.${key} must be a non-negative integer`);
      }
      return value;
    };
    if (typeof candidate.excerpt !== "string" || candidate.excerpt.trim().length < 1 || candidate.excerpt.length > 2_000
      || typeof candidate.prefix !== "string" || candidate.prefix.length > 120
      || typeof candidate.suffix !== "string" || candidate.suffix.length > 120) {
      throw new JobPayloadContractError(JobType.NOTE_DYNAMIC_ARTIFACT_GENERATE, "payload.anchor text fields are invalid");
    }
    const startBlockOrdinal = ordinal("startBlockOrdinal");
    const endBlockOrdinal = ordinal("endBlockOrdinal");
    const startOffset = ordinal("startOffset");
    const endOffset = ordinal("endOffset");
    if (anchorUuid !== uuid("noteVersionId") || endBlockOrdinal < startBlockOrdinal
      || endBlockOrdinal === startBlockOrdinal && endOffset <= startOffset) {
      throw new JobPayloadContractError(JobType.NOTE_DYNAMIC_ARTIFACT_GENERATE, "payload.anchor must cover a forward range in the frozen note version");
    }
    anchor = {
      noteVersionId: anchorUuid,
      startBlockOrdinal,
      startOffset,
      endBlockOrdinal,
      endOffset,
      excerpt: candidate.excerpt,
      prefix: candidate.prefix,
      suffix: candidate.suffix,
    };
  }
  return {
    noteId: uuid("noteId"),
    noteVersionId: uuid("noteVersionId"),
    requestId: uuid("requestId"),
    sourceKind,
    ...(anchor ? { anchor } : {}),
  };
}

export function readNoteExpansionGenerateJobPayload(
  payload: Record<string, unknown> | null | undefined,
): NoteExpansionGenerateJobPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new JobPayloadContractError(JobType.NOTE_EXPANSION_GENERATE, "payload must be a JSON object");
  }
  const uuid = (key: string) => {
    const value = payload[key];
    if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      throw new JobPayloadContractError(JobType.NOTE_EXPANSION_GENERATE, `payload.${key} must be a UUID`);
    }
    return value;
  };
  const noteId = uuid("noteId");
  const noteVersionId = uuid("noteVersionId");
  const requestId = uuid("requestId");
  const sourceMessageId = payload.sourceMessageId === undefined ? undefined : uuid("sourceMessageId");
  const conversationId = payload.conversationId === undefined ? undefined : uuid("conversationId");
  if (Boolean(sourceMessageId) !== Boolean(conversationId)) {
    throw new JobPayloadContractError(JobType.NOTE_EXPANSION_GENERATE, "sourceMessageId and conversationId must be provided together");
  }
  let focusAnchor: NoteExpansionGenerateJobPayload["focusAnchor"];
  const rawAnchor = payload.focusAnchor;
  if (rawAnchor !== undefined) {
    if (!rawAnchor || typeof rawAnchor !== "object" || Array.isArray(rawAnchor)) {
      throw new JobPayloadContractError(JobType.NOTE_EXPANSION_GENERATE, "payload.focusAnchor must be an object");
    }
    const anchor = rawAnchor as Record<string, unknown>;
    const anchorNoteVersionId = anchor.noteVersionId;
    const integer = (key: string) => {
      const value = anchor[key];
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        throw new JobPayloadContractError(JobType.NOTE_EXPANSION_GENERATE, `payload.focusAnchor.${key} must be a non-negative integer`);
      }
      return value;
    };
    const string = (key: string, max: number) => {
      const value = anchor[key];
      if (typeof value !== "string" || value.length > max) {
        throw new JobPayloadContractError(JobType.NOTE_EXPANSION_GENERATE, `payload.focusAnchor.${key} is invalid`);
      }
      return value;
    };
    const startBlockOrdinal = integer("startBlockOrdinal");
    const endBlockOrdinal = integer("endBlockOrdinal");
    const startOffset = integer("startOffset");
    const endOffset = integer("endOffset");
    if (anchorNoteVersionId !== noteVersionId || endBlockOrdinal < startBlockOrdinal
      || startBlockOrdinal === endBlockOrdinal && endOffset <= startOffset) {
      throw new JobPayloadContractError(JobType.NOTE_EXPANSION_GENERATE, "focusAnchor does not match the frozen note version");
    }
    focusAnchor = {
      noteVersionId,
      startBlockOrdinal,
      startOffset,
      endBlockOrdinal,
      endOffset,
      excerpt: string("excerpt", 2_000),
      prefix: string("prefix", 120),
      suffix: string("suffix", 120),
    };
  }
  return {
    noteId,
    noteVersionId,
    requestId,
    ...(focusAnchor ? { focusAnchor } : {}),
    ...(sourceMessageId && conversationId ? { sourceMessageId, conversationId } : {}),
  };
}
