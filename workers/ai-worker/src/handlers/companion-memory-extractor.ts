/**
 * 日常对话记忆提取器（22-real-desktop-pet-memory-context-prd-tdd.md §9.1）。
 *
 * 在 assistant.final 后异步执行：
 * - 读取本 run 的 user message / assistant reply / 最近上下文；
 * - 调用 LLM 输出严格 JSON 候选（最多 3 条）；
 * - 先验证候选引用的用户消息 ID、说话者与原文短引文，再写入；
 * - 以原消息 ID 作为来源身份，防止后续 run 重复抽取同一来源；
 * - 失败静默，不阻塞对话。
 */

import { z } from "zod";
import { taskEntityFromPersistedPageContext, type CompanionTaskEntityRef } from "./companion-task-memory.ts";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { readJobPayloadString, resolveCompanionMemoryTemporalMetadata } from "@ailearn/shared";
import { canonicalJsonV1, sha256Utf8V1 } from "@ailearn/shared/content-hash";
import { logger } from "../lib/logger.ts";
import { createProvider, withThinkingDisabled } from "../lib/ai-provider.ts";
import {
  AIConsentRequiredError,
  createGovernedProvider,
  resolveAIGovernanceContext,
  resolveProviderForTask,
} from "../lib/governance.ts";
import { assertJobLease, lockJobLease, withJobTransaction } from "../lib/job-lease.ts";
import { resolveProviderCallTimeout } from "../lib/handler-timeout-config.ts";
import { MemoryExtractOutputError } from "../lib/non-retryable-errors.ts";
import { withoutQuotedNames } from "./companion-dialogue-content.ts";
import {
  companionMemoryMutationLockKey,
  MEMORY_CONTENT_SIMILARITY_THRESHOLD,
} from "@ailearn/shared/db-schema/assistant-memory";
import type { WorkerTransaction } from "../db.ts";
import type { JobPayload } from "./index.ts";
import { runWorkerAiTask } from "./worker-ai-task.ts";

/**
 * 单次抽取的**独立事实**限额（40 §4.5.6 第 3 条）。
 *
 * 合同原话：「单次抽取按独立事实限额。**默认最多一条**；确有互不重复的事实可在
 * 任务预算内增加。不上『每次必须记一条』的最低配额。」
 *
 * 三句话对应三处设计：
 *
 * 1. **默认最多一条** —— `maxFacts` 默认就是 1。绝大多数轮次确实只有一件事值得记。
 * 2. **可在任务预算内增加** —— 增加是**显式的**（调用方传 `maxFacts`），上界
 *    `MEMORY_EXTRACT_MAX_FACTS`。它不是"模型给几条就收几条"：必须先证明它们
 *    互不重复（同一条事实重复输出不占额度），再受硬上限约束。
 * 3. **不设最低配额** —— 返回空数组是完全正常的结果，没有任何"至少留一条"的兜底。
 *
 * 「互不重复」按 (种类, 原文短引) 判定，**不用相似度**：相似度那套是给**跨轮**
 * 去重用的（见 MEMORY_CONTENT_SIMILARITY_THRESHOLD），同一轮里对两条做相似度判断
 * 反而会把"目标 + 偏好"这种真的两件事合并掉。
 */
export const MEMORY_EXTRACT_MAX_FACTS = 3;
export const MEMORY_EXTRACT_DEFAULT_MAX_FACTS = 1;

export function limitMemoryExtractionsToIndependentFacts<T extends { kind: string; sourceQuote?: string | null }>(
  candidates: readonly T[],
  options: { maxFacts?: number } = {},
): T[] {
  const cap = Math.max(
    0,
    Math.min(options.maxFacts ?? MEMORY_EXTRACT_DEFAULT_MAX_FACTS, MEMORY_EXTRACT_MAX_FACTS),
  );
  const kept: T[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (kept.length >= cap) break;
    const key = JSON.stringify([candidate.kind, candidate.sourceQuote ?? ""]);
    if (seen.has(key)) continue; // 同一条事实被说了两遍 —— 不占额度
    seen.add(key);
    kept.push(candidate);
  }
  return kept;
}

/**
 * 自动准入的拒写判据（40 §4.5.2 末段 / §4.5.3）。
 *
 * 合同把「移除日常确认写入/暂不采用的候选流程」与「**敏感推断…拒写**」写在一起：
 * 去掉确认队列**不等于**什么都自动收，来源不足、敏感推断、超出材料权限、
 * 用户已抑制的仍然拒写，只是拒写时**给理由**而不是弹气泡给用户点。
 *
 * 这里守的是「敏感推断」那一条，而且**不按关键词**——合同明说
 * 「不能用『喜欢/希望/累/现在』几个词强制升级或降级」，按词判会把
 * 「今天很累」（用户自述，允许）与「他大概很焦虑」（模型推断，拒绝）混成一类。
 *
 * 判据取的是**说话者与种类的组合**：
 * - `interaction_note` 是「关于用户当下状态」的一类；
 * - 用户**自己说的**当下状态（sourceBasis=direct_statement）可以存，
 *   §4.5.3 明写「『今天很累。』有期限的用户自述，不推导焦虑、依赖或人格特征」；
 * - 而**模型替用户断言**当下状态就是推断，那正是旧候选队列当初要拦的东西，
 *   现在由这里确定性拒写，并留下可审计的理由。
 */
export type MemoryAdmissionRejection = "sensitive_inference";

export function memoryAdmissionDecision(input: {
  kind: string;
  sourceBasis: string;
}): { ok: true } | { ok: false; reason: MemoryAdmissionRejection } {
  const isUserSelfReport = input.sourceBasis === "direct_statement";
  if (input.kind === "interaction_note" && !isUserSelfReport) {
    return { ok: false, reason: "sensitive_inference" };
  }
  return { ok: true };
}

/** Keep the acceptance boundary aligned with the extractor prompt. */
export function isMemoryExtractConfidenceAccepted(confidence: number): boolean {
  return Number.isFinite(confidence) && confidence >= 0.7 && confidence <= 1;
}

/**
 * 跨空间同步的判据（2026-09-22 Owner 裁决 + 当日收紧）。
 *
 * 裁决是"跟空间关联性不强的记忆需要带过去"，同时要求**收紧**——因为"关联性不强"
 * 如果只按种类粗判，会把空间专属的东西带到别的空间去。
 *
 * ─── 拿真实数据定出来的两条 ───
 * dev 库那批真种子记忆（45 条）里能看到很清楚的分界：
 *
 *   可携带：习惯在晚上九点之后写笔记 / 看新概念时更想先看反例 / 偏好短节奏学习
 *   该留下：用户正在备考日语N3，考试时间为下个月 / 用户正在学习数据库索引优化 /
 *           用户之前主要专注于 N3 相关工作，近期开始接触数据库索引优化
 *
 * 于是：
 *   1. **只有 `preference` 可能跨空间**。`interaction_note` 实测记的多半是"用户
 *      当前在做什么"（上面第三条就是它），那是空间内容，改回本地。另外三种本来
 *      就绑定空间内的对象。
 *   2. `preference` 里还要再分一次：关于**怎么学**的（时段、节奏、顺序、环境、
 *      称呼）跟人走；提到**具体科目/考试/项目**的留在原空间——那些东西在另一个
 *      空间里根本不存在。
 *
 * ─── 两道判据，任一判本地就本地 ───
 *   - 模型给 `binding`（它在对话现场，能看见"这句话是在说这门课还是说我"）；
 *   - 服务端确定性规则（见 `memoryLooksWorkspaceBound`），**可以否决模型**：
 *     模型说 portable 但内容里有明确的"这个班/这门课/考试"，一律按本地。
 *
 * 缺省 fail-closed：模型没说、规则也没说 → 本地。宁可少带，不可错带。
 */
const CROSS_SPACE_KINDS = new Set<string>(["preference"]);

/**
 * 内容里出现"空间专属"信号的确定性判据。
 *
 * 两类：
 *   - **明确的本地指代**：这个班 / 我们组 / 这门课 / 本学期的……
 *   - **具体科目、考试、项目**：日语、物理、贝叶斯、N3、考试、期中、答辩……
 *     （第二个列表只用于 `preference`，所以像"喜欢在安静时段学习"这种不带科目的
 *     偏好不会被误判成本地。）
 *
 * 导出给测试用。改这个正则等于改"什么记忆会跨空间"，所以它有专门的用例。
 */
const LOCAL_REFERENCE_PATTERN =
  /(这个|该|本|我们|咱们|此)(空间|房间|工作区|协作|班级|班|课|课程|小组|团队|项目|学期|门课)|(这|本)(学期|门课|门|节课|次考试)|(期中|期末|月考|模拟考|统考|答辩|deadline|截止日期)/;

const SUBJECT_OR_EXAM_PATTERN =
  /(日语|英语|数学|物理|化学|生物|语文|历史|地理|政治|编程|数据库|索引|算法|贝叶斯|统计|概率|线性代数|微积分|N[1-5]|雅思|托福|考研|高考|中考|四级|六级|考试|备考|证书|认证)/i;

/** `preference` 的内容看起来是否绑定了这个空间。 */
export function memoryLooksWorkspaceBound(content: string): boolean {
  return LOCAL_REFERENCE_PATTERN.test(content) || SUBJECT_OR_EXAM_PATTERN.test(content);
}

/** 一条记忆该落在哪个 scope 上。导出给测试与调用方共用，避免第二套判据。 */
export function memoryScopeForKind(
  kind: string,
  modelScope?: string,
  binding?: string,
  content?: string,
): "global" | "workspace" | "task" {
  if (CROSS_SPACE_KINDS.has(kind)) {
    // 两道判据任一判本地就本地。规则那一道可以否决模型。
    //
    // 注意这里是 `!== "portable"` 而不是 `=== "local"`：缺省必须落在**本地**。
    // 契约（schema）的默认值也是 local，但函数不能依赖调用方先过 schema——
    // 直接调这个函数的地方（测试、以后的批量重算）同样要 fail-closed。
    // 实测抓到过：写成 `=== "local"` 时 `binding` 为 undefined 会返回 global，
    // 与契约的默认值方向相反，等于开了一个"漏传就跨空间"的口子。
    if (binding !== "portable") return "workspace";
    if (content !== undefined && memoryLooksWorkspaceBound(content)) return "workspace";
    return "global";
  }
  // 非跨空间种类尊重模型给的 task（"只在这一轮有用"的细分），其余一律 workspace。
  if (modelScope === "task") return "task";
  return "workspace";
}

/**
 * "系统随时算得出来的那份统计"不是记忆（实机 2026-09-21）。
 *
 * 抽取器把"截至当前，用户本周累计学习时长为 23 分钟，拥有 10 张活跃卡片和 9 篇笔记"
 * 写成了 `learning_context`——而那个 23 分钟本来就是她当轮**没查工具编出来的**
 * （真值 60）。统计量进记忆有两层害：①数值天天变，存下来就是过期事实；
 * ②她自己的编造从此有了"记忆出处"，下一轮照着复述，谁拦都拦不住。
 *
 * 判据要窄，用户说出口的偏好里也带数字（"每天只能挤出四十分钟"、"每次练习约 10 分钟、
 * 每天总计约 40 分钟"），那些是要留的稳定信息——所以**不含**"累计/总计"这种通用量词，
 * 只认指向"现在这一份"的时间窗：本周/今天/截至。
 */
const VOLATILE_STAT_WINDOW_TEST = /(本周|这周|今天|今日|截至|这一阵)/;
const STATISTIC_QUANTITY_TEST = /\d+(?:\.\d+)?\s*(分钟|小时|张|篇|项|题|次|条|%)/;

export function isVolatileStatisticMemory(content: string): boolean {
  // 名字里的数量词不算统计（「背 3 条法律」是一张真卡的标题也可能长这样）：
  // 误判的代价是这条记忆**根本没写进去**，比误放难发现得多。
  const outsideNames = withoutQuotedNames(content);
  return VOLATILE_STAT_WINDOW_TEST.test(outsideNames) && STATISTIC_QUANTITY_TEST.test(outsideNames);
}

const memoryExtractCandidateSchema = z.object({
  kind: z.enum(["preference", "goal", "learning_context", "interaction_note", "episodic"]),
  // §9.4：写入端即限制 ≤200 字，确保读取注入时不需截断、不丢失信息。
  content: z.string().min(1).max(200),
  importance: z.number().min(0).max(1).default(0.5),
  /**
   * 保持必填：它是 §9.1 `> 0.6` 置信度闸的输入。给默认值等于替模型表态
   * （默认高了就什么都写、默认低了就什么都不写），两种都比"模型没给"更糟。
   */
  confidence: z.number().min(0).max(1),
  scope: z.enum(["global", "workspace", "task"]).default("workspace"),
  /**
   * 这条记忆是"关于我怎么学"（portable）还是"关于我现在在弄什么"（local）。
   *
   * 缺省 **local**（fail-closed）：模型没说就按本地处理。宁可少带一条到别的空间，
   * 也不要把"这个班的作业"带过去。服务端的确定性规则还能再否决一次 portable。
   */
  binding: z.enum(["portable", "local"]).default("local"),
  // 来源字段先保持解析可选，方便安全处理仍未按新合同输出的模型结果；
  // 写入前由 resolveMemoryExtractSource 要求三项齐全并逐项核验。
  sourceMessageId: z.string().uuid().optional(),
  sourceSpeaker: z.enum(["user", "assistant"]).optional(),
  sourceQuote: z.string().trim().min(3).max(80).optional(),
  sourceBasis: z.enum(["direct_statement", "inferred_from_statement"]).optional(),
  appliesWhen: z.string().trim().min(1).max(200).nullable().default(null),
  validUntil: z.string().datetime({ offset: true }).nullable().default(null),
  linkedEntityIds: z.array(z.string()).max(10).default([]),
});

export const memoryExtractOutputSchema = z.object({
  // `version` 是**我们自己的**信封版本，不是模型该表达的内容。以前它是
  // `z.literal(1)` 必填，而 prompt 里从未提到这个形状——于是模型给出
  // `{"candidates":[…]}` 就整单解析失败。这是 §9.11 那 88 次失败的主因。
  version: z.literal(1).default(1),
  // 候选超过 3 条时截断而不是判失败：多给一条是模型的正常发挥，
  // 为这个把整轮记忆丢掉不值得。
  candidates: z.preprocess(
    (value) => (Array.isArray(value) ? value.slice(0, 3) : value),
    z.array(memoryExtractCandidateSchema).max(3).default([]),
  ),
});

const EXTRACT_PROMPT = [
  "你是桌宠的记忆整理器。根据对话判断是否有值得长期记住的信息。",
  "只提取用户明确表达或高置信推断的信息；没有就返回空数组，不要为了有输出而编造。",
  "分类时看整句、上下文和用户是否认同，不把祈使句、引用内容或单次反馈自动升级为长期偏好：",
  "  用户说‘这一次希望先看例子。’ → candidates=[]；只约束本轮，不是长期 preference。",
  "  用户说‘以后我累的时候别催学习。’ → preference；appliesWhen 必须原样写‘我累的时候’。条件偏好可以保存。",
  "  用户说‘今天喜欢这个例子。’ → 不输出 preference；单次反馈不能代表稳定喜好。",
  "  用户说‘我看到一句“每天都该学习”，但我不认同。’ → candidates=[]；引文不是用户观点或指令。",
  "  用户明确说‘更正：我现在晚上更方便学习。’ → 当前纠正优先；不要追加与旧记录冲突的第二条。若当前流程不能用稳定 ID 与 expectedRevision 安全定位旧记录，就不输出候选。",
  "  用户说‘我希望下周完成数据库索引复习。’ → 这是本地短期 goal，不是 preference；若不能提供可核验的有限期限，就不要写入长期记忆。",
  // 统计量不是记忆：见 isVolatileStatisticMemory。prompt 先讲清规矩，服务端再拦一道。
  "不要记录系统随时能查出来的当前数字（今天/本周学了多久、卡片数、笔记数、到期数）——它们每天都在变，记下来就成了过期事实；只记用户自己说过的稳定偏好、目标和情况。",
  "每条记忆内容不超过 200 字，只保留核心信息，不要赘述。",
  // 契约必须写进 prompt：schema 单方面要求而模型不知道，等于必然失败。
  "只输出一个 JSON 对象，形状如下（不要输出 JSON 以外的任何文字、不要 markdown 代码块）：",
  '{"candidates":[{"kind":"goal|preference|learning_context|interaction_note|episodic",'
  + '"content":"…","importance":0.0到1.0,"confidence":0.0到1.0,"binding":"portable|local",'
  + '"sourceMessageId":"原消息ID","sourceSpeaker":"user","sourceQuote":"原消息中的连续短引文",'
  + '"sourceBasis":"direct_statement|inferred_from_statement","appliesWhen":"适用条件或 null",'
  + '"validUntil":"原话中逐字出现的 ISO 时间戳，否则为 null"}]}',
  "kind 可以省略（会有默认值），但必须从上面五个枚举里选。",
  // scope 不再由模型选（产品规则按 kind 定），但 binding 必须问它：只有它在对话现场，
  // 能分辨"这句话是在说我这门课，还是在说我一贯怎么学"。
  "不要输出 scope 字段——记忆的可见范围由系统决定。",
  "每条给一个 binding，表示这条记忆是不是只在**当前这个学习空间**里成立：",
  "  portable —— 关于用户**一贯怎么学、怎么相处**的：学习时段与节奏、理解顺序、环境偏好、称呼与沟通方式。换个空间照样成立。",
  "  local —— 与**当前空间的内容**绑定的：正在学的科目或技术、要考的试与时间、这个班/这门课/这个项目的事、以及「用户最近在做什么」。",
  "拿不准就填 local。宁可留在这个空间，也不要让它跑到别的空间去。",
  "confidence 表示你有多确信这是用户真实长期信息：0.7 以上才会被采纳。",
  "每条候选必须引用输入里确实提供的消息 ID；sourceSpeaker 必须与该消息的真实说话者一致。",
  "sourceQuote 必须是该条用户消息中的连续原文（3–80 字），不能改写、拼接或引用桌宠自己的话。",
  "sourceBasis=direct_statement 表示用户在引文中明确说出了这项内容；inferred_from_statement 表示你根据用户原话作了有限归纳。",
  "appliesWhen 只写用户原话中逐字出现的适用条件；不能逐字核对时填 null。validUntil 仅当来源原文逐字包含完整 ISO 时间戳（含时区）时照抄；不要把‘今天/下周/月底’自行换算成日期。没有可逐字核对的明确期限时填 null。",
  "只从用户消息提取关于用户的记忆；桌宠自己的承诺、建议或复述不能作为用户事实的来源。",
  "候选找不到可靠的用户原话来源时不要输出该候选。",
  "没有值得记的信息时输出 {\"candidates\":[]}。",
  // §4.5.6 第 3 条：默认给**一条**。确有几件互不重复的事才给多条，并按上面的规则区分。
  "默认只给一条。只有确实互不重复的好几件事时才给多条，并说明它们各自来自哪句原话；不要把同一件事拆成几条。",
  // 40 §4.5.2/§4.5.3：用户自述的当下状态可以存，模型替用户断言的不行。
  "interaction_note 只在**用户自己说出**当下状态时给（如『今天很累』）；不要替用户判断他的情绪、性格或依赖。",
].join("\n");

interface ExtractMessage {
  messageId?: string;
  role: "user" | "assistant";
  text: string;
  createdAt?: string | null;
}

export interface MemoryExtractSource {
  messageId: string;
  speaker: "user" | "assistant";
  text: string;
  createdAt?: string | null;
}

type MemoryExtractCandidate = z.infer<typeof memoryExtractCandidateSchema>;

export type MemoryExtractSourceRejection =
  | "missing_reference"
  | "message_not_in_input"
  | "speaker_mismatch"
  | "not_user_message"
  | "quote_not_found"
  | "missing_basis";

export type MemoryExtractSourceResolution =
  | { ok: true; source: MemoryExtractSource }
  | { ok: false; reason: MemoryExtractSourceRejection };

/** A finite window is usable only when anchored after the cited event and still active. */
export function isMemoryValidityRangeUsable(
  validUntil: string | null,
  sourceCreatedAt: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (validUntil === null) return true;
  const end = Date.parse(validUntil);
  const start = sourceCreatedAt ? Date.parse(sourceCreatedAt) : Number.NaN;
  return Number.isFinite(end) && Number.isFinite(start) && end > start && end > now.getTime();
}

/** 验证模型声称的来源确实存在于本轮输入，且短引文来自用户本人原文。 */
export function resolveMemoryExtractSource(
  candidate: MemoryExtractCandidate,
  sources: readonly MemoryExtractSource[],
): MemoryExtractSourceResolution {
  if (!candidate.sourceMessageId || !candidate.sourceSpeaker || !candidate.sourceQuote) {
    return { ok: false, reason: "missing_reference" };
  }
  if (!candidate.sourceBasis) return { ok: false, reason: "missing_basis" };
  const source = sources.find((item) => item.messageId === candidate.sourceMessageId);
  if (!source) return { ok: false, reason: "message_not_in_input" };
  if (source.speaker !== candidate.sourceSpeaker) return { ok: false, reason: "speaker_mismatch" };
  if (source.speaker !== "user") return { ok: false, reason: "not_user_message" };
  if (!source.text.includes(candidate.sourceQuote)) return { ok: false, reason: "quote_not_found" };
  return { ok: true, source };
}

/** True when this user explicitly forgot this kind from this immutable source. */
export async function isMemorySourceSuppressed(
  tx: WorkerTransaction,
  userId: string,
  kind: string,
  sourceEventId: string,
): Promise<boolean> {
  const rows = await tx.execute<{ suppressed: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM assistant_memory_source_suppressions
       WHERE user_id = ${userId}
         AND kind = ${kind}
         AND source_event_id = ${sourceEventId}
    ) AS suppressed
  `);
  return rows[0]?.suppressed === true;
}

/** Suppress only a similar, dismissed memory of the same semantic kind. */
export async function hasDismissedMemoryTwin(
  tx: WorkerTransaction,
  input: { workspaceId: string; userId: string; kind: string; content: string },
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    SELECT id FROM assistant_memory_items
    WHERE workspace_id = ${input.workspaceId}
      AND user_id = ${input.userId}
      AND kind = ${input.kind}
      AND deleted_at IS NULL
      AND dismissed_at IS NOT NULL
      AND (valid_from IS NULL OR valid_from <= now())
      AND (valid_until IS NULL OR valid_until > now())
      AND similarity(content, ${input.content}) > ${MEMORY_CONTENT_SIMILARITY_THRESHOLD}
    LIMIT 1
  `);
  return rows.length > 0;
}

export function buildExtractMessages(input: {
  userText: string;
  assistantText: string;
  userMessageId?: string | null;
  assistantMessageId?: string | null;
  recent: ExtractMessage[];
}): Array<{ role: "system" | "user"; content: string }> {
  const recentText = input.recent
    .slice(-5)
    .map((m) => `消息ID=${m.messageId ?? "不可用"}；发言者=${m.role}：${m.text.slice(0, 500)}`)
    .join("\n");
  const conversation = [
    ...(recentText ? [`最近上下文：\n${recentText}`] : []),
    `消息ID=${input.userMessageId ?? "不可用"}；发言者=user：${input.userText.slice(0, 1000)}`,
    `消息ID=${input.assistantMessageId ?? "不可用"}；发言者=assistant：${input.assistantText.slice(0, 1000)}`,
  ].join("\n\n");
  return [
    { role: "system" as const, content: EXTRACT_PROMPT },
    { role: "user" as const, content: conversation },
  ];
}

/**
 * 2026-08-16（实机溯源修复）：LLM 输出容错解析——
 * tokenrhythm 偶发在 JSON 外包裹 ```json fence 或前后赘述，
 * 此前直接 JSON.parse 失败即整轮丢弃（记忆提取成功率低）。
 * 依次尝试：原样 → 剥 fence → 提取首个 {…} 平衡片段。
 */
export function parseMemoryExtractJson(raw: string): unknown {
  const attempts: string[] = [raw.trim()];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) attempts.push(fenced[1].trim());
  // 提取首个从 { 到最后一个 } 的平衡片段（容忍前后赘述）。
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    attempts.push(raw.slice(firstBrace, lastBrace + 1).trim());
  }
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch {
      // 继续尝试下一形态
    }
  }
  throw new SyntaxError("memory extract JSON parse failed after all fallbacks");
}

export async function runCompanionMemoryExtract(job: JobPayload): Promise<void> {
  // 设计 P1-8（2026-09-15 审计）：字段名走共享契约（@ailearn/shared 的
  // companion-memory-job-payload），改名由编译器兜住。
  const runId = readJobPayloadString(job.payload, "runId");
  const userId = readJobPayloadString(job.payload, "userId");
  if (!runId || !userId) throw new Error("companion_memory_extract payload 缺 runId/userId");
  await assertJobLease(job);

  const govCtx = await resolveAIGovernanceContext(job.workspaceId, userId);
  if (!govCtx.consentOk) throw new AIConsentRequiredError();
  const textRes = resolveProviderForTask(govCtx, "companion_agent");
  // 思考必须关掉：这是一次 `responseFormat:"json_object"` + `maxTokens:800` 的整段取回，
  // 思考 token 也算在 800 里——吃满之后 `content` 直接为空，JSON 解析失败，
  // provider 内部重试 × job 重试跑满就把 job 判死（实机 2026-09-22：dead 里
  // `MEMORY_EXTRACT_OUTPUT_INVALID` 与 `provider_http_400` 各占一条，
  // 与 §9.71 摘要器"建表以来 0 行"是同一根因，当时只修了摘要器那一个调用点）。
  const provider = createGovernedProvider(
    createProvider(textRes.providerName, withThinkingDisabled(textRes.providerConfig)),
    govCtx,
    job.workspaceId,
    // AI P0-8（2026-09-15 审计）：接上 ai_audit_log 的唯一写入口（此前零调用）。
    // ai_audit_log.user_id 是 NOT NULL，故 payload 未带可信 actor 时不写审计行。
    userId
      ? { userId, operation: "companion_memory_extract", jobId: job.id, dataCategories: ["user_answer"] }
      : undefined,
  );

  // 使用独立 RLS 事务读取本轮消息（避免在 provider 调用期间持有事务）。
  // runId 是 companion_turn_runs 的 ID，需通过它获取 user_message_id 和
  // conversation_id，再关联查询 companion_messages。
  const context = await withJobTransaction(job, async (tx) => {
    const runRows = await tx.execute<{ user_message_id: string; conversation_id: string; page_context: unknown }>(sql`
      SELECT user_message_id, conversation_id, page_context FROM companion_turn_runs
      WHERE id = ${runId}
    `);
    const run = runRows[0];
    if (!run) {
      return {
        userText: "",
        assistantText: "",
        userMessageId: null,
        assistantMessageId: null,
        recent: [],
        sourceMessages: [],
        taskEntity: null,
      };
    }
    // 任务身份只认**服务端落库**的 page_context（39b C8）：learning_run→runId、
    // card/review→cardId；推不出就是 null，task 记忆会因此降级 workspace。
    const taskEntity = taskEntityFromPersistedPageContext(run.page_context);

    const userRows = await tx.execute<{ id: string; blocks: unknown; created_at: Date | string }>(sql`
      SELECT id, blocks, created_at FROM companion_messages
      WHERE id = ${run.user_message_id}
    `);
    const userMessageId = userRows[0]?.id ?? null;
    const userBlocks = userRows[0]?.blocks;
    const userText = Array.isArray(userBlocks)
      ? (userBlocks as Array<{ type?: string; text?: unknown }>)
          .filter((b) => b.type === "text")
          .map((b) => String(b.text ?? ""))
          .join("")
      : "";

    const assistantRows = await tx.execute<{ id: string; blocks: unknown; created_at: Date | string }>(sql`
      SELECT id, blocks, created_at FROM companion_messages
      WHERE run_id = ${runId} AND role = 'assistant'
      ORDER BY seq DESC LIMIT 1
    `);
    const assistantMessageId = assistantRows[0]?.id ?? null;
    const assistantBlocks = assistantRows[0]?.blocks;
    const assistantText = Array.isArray(assistantBlocks)
      ? (assistantBlocks as Array<{ type?: string; text?: unknown }>)
          .filter((b) => b.type === "text")
          .map((b) => String(b.text ?? ""))
          .join("")
      : "";

    const historyRows = await tx.execute<{ id: string; role: string; blocks: unknown; created_at: Date | string }>(sql`
      SELECT id, role, blocks, created_at FROM companion_messages
      WHERE conversation_id = ${run.conversation_id}
        AND id <> ${run.user_message_id}
        AND run_id IS DISTINCT FROM ${runId}
        AND role IN ('user', 'assistant')
      ORDER BY seq DESC LIMIT 8
    `);
    const recent = historyRows
      .slice()
      .reverse()
      .map((row) => ({
        messageId: row.id,
        role: (row.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
        createdAt: new Date(row.created_at).toISOString(),
        text: Array.isArray(row.blocks)
          ? (row.blocks as Array<{ type?: string; text?: unknown }>)
              .filter((b) => b.type === "text")
              .map((b) => String(b.text ?? ""))
              .join("")
          : "",
      }));

    const sourceMessages: MemoryExtractSource[] = [
      ...recent.slice(-5).map((message) => ({
        messageId: message.messageId ?? "",
        speaker: message.role,
        text: message.text,
        createdAt: message.createdAt,
      })),
      ...(userMessageId ? [{
        messageId: userMessageId,
        speaker: "user" as const,
        text: userText,
        createdAt: new Date(userRows[0].created_at).toISOString(),
      }] : []),
      ...(assistantMessageId ? [{
        messageId: assistantMessageId,
        speaker: "assistant" as const,
        text: assistantText,
        createdAt: new Date(assistantRows[0].created_at).toISOString(),
      }] : []),
    ];

    return { userText, assistantText, userMessageId, assistantMessageId, recent, sourceMessages, taskEntity };
  });

  if (!context.userText.trim() && !context.assistantText.trim()) {
    logger.info({ jobId: job.id, runId }, "memory extract skipped: empty conversation");
    return;
  }

  const messages = buildExtractMessages(context);
  // 2026-08-16（实机溯源修复）：LLM 输出不可解析或 schema 校验失败先重试
  // 一次（provider 偶发输出半截/非 JSON/字段缺失），重试仍失败才跳过——
  // 记忆提取从"一次失误即丢"改为容错。
  //
  // 2026-09-20（方案 29 §4.3）：**"跳过"这一步是整条记忆写路径静默瘫痪的原因**。
  // 解析失败时函数直接 `return`，不抛错也不记日志，于是 `jobs.status` 落成
  // `succeeded`——实测 242 个"成功"的抽取 job 写进了 0 行记忆，监控上一切正常。
  // 现在两条失败路径都必须抛：采样已在本函数内重试过一次，重投不会更好，
  // 所以判不可重试、直接 dead，让 `jobs.last_error` 说真话。
  type ExtractOutput = z.infer<typeof memoryExtractOutputSchema>;
  const generationParameters = { temperature: 0.2, maxTokens: 800, responseFormat: "json_object" as const };
  const inputSnapshotHash = sha256Utf8V1(canonicalJsonV1({
    taskVersion: 1,
    runId,
    sourceMessages: context.sourceMessages,
    taskEntity: context.taskEntity,
    modelId: provider.modelId,
    promptVersion: provider.promptVersion,
    generationParameters,
    messages,
  }));
  let extracted: { output: ExtractOutput; raw: string };
  try {
    extracted = await runWorkerAiTask({
      job,
      userId,
      taskId: "companion_memory_extract",
      taskVersion: 1,
      idempotencyKey: `memory-extract:${job.id}:${inputSnapshotHash}`,
      inputSnapshotRef: { kind: "task", id: `${runId}:memory-extract`, hash: inputSnapshotHash },
      input: messages,
      modelId: provider.modelId,
      promptVersion: `${provider.promptVersion}:companion-memory-extract-v1`,
      resourceClass: "maintenance",
      timeoutMs: resolveProviderCallTimeout("companion_memory_extract"),
      taskDeadlineMs: resolveProviderCallTimeout("companion_memory_extract"),
      maxModelCalls: 2,
      maxAutoRetries: 1,
      isOutputShapeError: (error) => error instanceof MemoryExtractOutputError,
      execute: async (request, signal, retryIndex) => {
        if (retryIndex > 0) {
          logger.warn({ jobId: job.id, runId, retryIndex }, "memory extract retrying after a retryable task failure");
        }
        // 2026-08-24（AI 设计审查 §4.2）：responseFormat "text" → "json_object"，
        // provider 层先保证 JSON 合法性，容错解析退为二道防线。
        const result = await provider.chatCompletion(request, generationParameters, signal);
        let candidate: z.SafeParseReturnType<unknown, ExtractOutput> | null = null;
        try {
          candidate = memoryExtractOutputSchema.safeParse(parseMemoryExtractJson(result.content));
        } catch {
          candidate = null;
        }
        if (!candidate?.success) {
          throw new MemoryExtractOutputError("memory extract output was not valid structured JSON");
        }
        return {
          ok: true,
          output: { output: candidate.data, raw: result.content },
          promptTokens: result.usage?.promptTokens ?? undefined,
          completionTokens: result.usage?.completionTokens ?? undefined,
        };
      },
    });
  } catch (error) {
    if (error instanceof MemoryExtractOutputError) {
      throw new MemoryExtractOutputError(
        `memory extract produced no schema-valid output after 2 attempts (run ${runId})`,
      );
    }
    logger.warn({ jobId: job.id, runId, err: error }, "memory extract provider failed");
    throw error;
  }
  const parsed = extracted.output;
  /** 与解析结果同源的原始输出（候选为空时的指纹留痕要用它）。 */
  const parsedRaw = extracted.raw;
  // 低于 prompt 中明确要求的 0.7 不进入后续准入判断。
  const confidenceAccepted = parsed.candidates.filter((c) => isMemoryExtractConfidenceAccepted(c.confidence));
  let sourceRejected = 0;
  let invalidValidityRejected = 0;
  const sourcedCandidates: (MemoryExtractCandidate & { source: MemoryExtractSource })[] = [];
  for (const candidate of confidenceAccepted) {
    const resolution = resolveMemoryExtractSource(candidate, context.sourceMessages);
    if (!resolution.ok) {
      sourceRejected += 1;
      continue;
    }
    const temporal = resolveCompanionMemoryTemporalMetadata({
      kind: candidate.kind,
      content: candidate.content,
      appliesWhen: candidate.appliesWhen,
      validUntil: candidate.validUntil,
      sourceQuote: candidate.sourceQuote,
      sourceText: resolution.source.text,
    });
    if (!temporal.ok || !isMemoryValidityRangeUsable(temporal.validUntil, resolution.source.createdAt)) {
      invalidValidityRejected += 1;
      continue;
    }
    sourcedCandidates.push({ ...candidate, ...temporal, source: resolution.source });
  }
  const nonVolatileCandidates = sourcedCandidates.filter((candidate) => !isVolatileStatisticMemory(candidate.content));
  const dedupedCandidates: typeof sourcedCandidates = [];
  const seenSourceKinds = new Set<string>();
  let duplicateSourceKindDropped = 0;
  for (const candidate of nonVolatileCandidates) {
    const key = `${candidate.source.messageId}:${candidate.kind}`;
    if (seenSourceKinds.has(key)) {
      duplicateSourceKindDropped += 1;
      continue;
    }
    seenSourceKinds.add(key);
    dedupedCandidates.push(candidate);
  }
  // 40 §4.5.6 第 3 条：单次抽取按**独立事实**限额，默认一条。
  // 这一步放在同源去重之后——先把"同一句话说三遍"折叠掉，再按事实算额度，
  // 否则模型把同一条重复输出三遍就能把额度占满。
  const admissionPassed: typeof dedupedCandidates = [];
  let sensitiveInferenceRejected = 0;
  for (const candidate of dedupedCandidates) {
    // `sourceBasis` 在 schema 上是可选的。缺它时按**推断**处理（fail-closed）：
    // 「来源不足…拒写」是 §4.5.2 的原话，而"用户没说、只是模型这么认为"正是
    // 我们不愿意留下来的那种。resolveMemoryExtractSource 挡掉的是另一种缺法
    //（引文不在原文里），这一处挡的是"根本没给 basis"。
    const decision = memoryAdmissionDecision({
      kind: candidate.kind,
      sourceBasis: candidate.sourceBasis ?? "inferred_from_statement",
    });
    if (!decision.ok) {
      sensitiveInferenceRejected += 1;
      // 拒写不存正文（§4.5.2：「不能为了保守拒写而把被拒正文另外存成永久审计」），
      // 这里只留一个计数供 §4.5.9 的审计分母使用。
      logger.info(
        { jobId: job.id, runId, kind: candidate.kind, reason: decision.reason },
        "memory extract refused a candidate under the auto-admission rule",
      );
      continue;
    }
    admissionPassed.push(candidate);
  }
  const candidates = limitMemoryExtractionsToIndependentFacts(admissionPassed);
  if (nonVolatileCandidates.length < sourcedCandidates.length) {
    logger.warn(
      {
        jobId: job.id,
        runId,
        dropped: sourcedCandidates
          .filter((c) => isVolatileStatisticMemory(c.content))
          .length,
      },
      "memory extract dropped volatile-statistic candidates (系统查得到，不该记)",
    );
  }
  if (sourceRejected > 0) {
    logger.warn(
      { jobId: job.id, runId, dropped: sourceRejected },
      "memory extract dropped candidates without a verifiable user-message source",
    );
  }
  if (invalidValidityRejected > 0) {
    logger.warn(
      { jobId: job.id, runId, dropped: invalidValidityRejected },
      "memory extract dropped validity ranges that were expired or not anchored to the source event",
    );
  }
  if (duplicateSourceKindDropped > 0) {
    logger.warn(
      { jobId: job.id, runId, dropped: duplicateSourceKindDropped },
      "memory extract dropped repeated candidates from the same source message and kind",
    );
  }
  if (candidates.length === 0) {
    // 2026-08-16（溯源）：候选被过滤/为空时留痕——区分"LLM 没提取到"与
    // "提取到但置信不足"，便于排查记忆链路。
    //
    // AI P0-13（2026-09-15 审计）：此处原为 `rawPreview: raw.slice(0, 160)`，
    // 而 raw 是模型对**用户对话内容**的复述/改写——INFO 级、无开关，是本轮审计
    // 清单里唯一无条件的用户内容泄漏点。改为长度 + sha256 前缀指纹：仍可对照定位
    // （同一次输出的指纹稳定），但不可还原。（与 openai-compatible.ts 的 REPRO-LOG
    // 加固同一模式。）
    logger.info(
      {
        jobId: job.id,
        runId,
        rawCandidates: parsed.candidates.length,
        sourceRejected,
        invalidValidityRejected,
        duplicateSourceKindDropped,
        rawLen: parsedRaw.length,
        rawFingerprint: createHash("sha256").update(parsedRaw, "utf8").digest("hex").slice(0, 16),
      },
      "memory extract has no candidates after confidence and provenance filters",
    );
    return;
  }

  // 用户明确"忽略"过的事，下一轮抽取不能再当成新事端上来（doc 34 L14 的后半）。
  let skippedDismissedTwins = 0;
  let skippedForgottenSources = 0;
  // 本轮的页面身份（39b C8）：有它 task 记忆才落 task 档并绑定；没有就全部降级 workspace。
  const taskEntity: CompanionTaskEntityRef | null = context.taskEntity;
  let taskScopeDowngrades = 0;

  await withJobTransaction(job, async (tx) => {
    // 稳定 P1-1（2026-09-15 审计）：提交前重新校验并续租租约（TOCTOU 围栏）。
    // 入口 assertJobLease 挡不住"LLM 调用期间租约被 reap"后另一实例重领并重复
    // 写记忆/重复计费。
    await lockJobLease(tx, job);
    // 先拿用户级记忆锁，再拿 inbox 锁。删除也按这个顺序（记忆软删后结账 delivery），
    // 避免“抽取持 inbox 等记忆 / 删除持记忆等 inbox”的锁环。
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${companionMemoryMutationLockKey(userId)}, 0))
    `);
    // 与 API/action writer 共用用户级序列锁，防止并发写入时 inbox_sequence 冲突。
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${`companion-inbox:${job.workspaceId}:${userId}`}, 0))
    `);
    for (const candidate of candidates) {
      // 用不可变用户消息 ID 作为来源身份：同一条原话在后续 run 的上下文中
      // 再次被抽取时会命中现有唯一键，而不是生成一条新的“来源”。
      const sourceEventId = candidate.source.messageId;
      if (await isMemorySourceSuppressed(tx, userId, candidate.kind, sourceEventId)) {
        skippedForgottenSources += 1;
        continue;
      }
      const userStated = candidate.sourceBasis === "direct_statement";
      // scope 由种类 + 绑定判据决定，不采信模型给的 scope（见 memoryScopeForKind）。
      // 两道判据任一判本地就本地，服务端规则可以否决模型的 portable。
      const derivedScope = memoryScopeForKind(candidate.kind, candidate.scope, candidate.binding, candidate.content);
      // 任务记忆必须带身份（39b C8）：落不了 memory_links 绑定的 task 记忆降级
      // workspace——"缺绑定不能默认为全任务通用"，而 workspace 是它安全的家。
      let scope = derivedScope;
      if (scope === "task" && !taskEntity) {
        scope = "workspace";
        taskScopeDowngrades += 1;
      }
      // 同一空间里已经有一条**被本人忽略过**的同类同内容记忆，就整条跳过：
      // 不写候选、不发气泡、不铺跨空间。判据与 api 侧冲突分组共用同一个数（见
      // MEMORY_CONTENT_SIMILARITY_THRESHOLD），否则同一句话会在一边算重复、
      // 另一边算新事。只认 dismissed_at，删除（deleted_at）不算"别再告诉我"。
      const dismissedTwin = await hasDismissedMemoryTwin(tx, {
        workspaceId: job.workspaceId,
        userId,
        kind: candidate.kind,
        content: candidate.content,
      });
      if (dismissedTwin) {
        skippedDismissedTwins += 1;
        continue;
      }
      await tx.execute(sql`
        INSERT INTO assistant_memory_items
          (workspace_id, user_id, kind, content, source_event_id, source_speaker, source_basis,
           applies_when, valid_from, valid_until, user_stated, user_confirmed,
           candidate, importance, confidence, scope, source_type, embedding_status, created_at, updated_at)
        VALUES
          (${job.workspaceId}, ${userId}, ${candidate.kind}, ${candidate.content}, ${sourceEventId},
           ${candidate.source.speaker}, ${candidate.sourceBasis}, ${candidate.appliesWhen},
           ${candidate.source.createdAt ? new Date(candidate.source.createdAt) : null},
           ${candidate.validUntil ? new Date(candidate.validUntil) : null},
           ${userStated}, ${userStated}, false,
           ${candidate.importance}, ${candidate.confidence}, ${scope},
           ${userStated ? "user_stated" : "model_inferred"}, 'pending', now(), now())
        ON CONFLICT (workspace_id, user_id, kind, source_event_id)
          WHERE deleted_at IS NULL AND source_event_id IS NOT NULL
        DO NOTHING
      `);
      const memoryRows = await tx.execute<{ id: string }>(sql`
        SELECT id FROM assistant_memory_items
        WHERE workspace_id = ${job.workspaceId} AND user_id = ${userId}
          AND kind = ${candidate.kind}
          AND source_event_id = ${sourceEventId}
        LIMIT 1
      `);
      const memoryId = memoryRows[0]?.id;
      if (memoryId) {
        // 跨空间记忆：铺到该用户所有活跃空间（0267 的唯一实现）。
        // 只对 global 调；函数自己也会再判一次 scope，双保险。
        // 铺开失败不该让整轮记忆丢掉——它是"多带一份"的增强，不是主路径；
        // 但也不能静默：日志里留一行，否则"另一个空间怎么不记得"会查无实据。
        if (scope === "task" && taskEntity) {
          // 任务身份绑定（39b C8）：召回侧只对"当前身份与此绑定相等"的上下文
          // 放行 task 行。绑定行失败不阻塞记忆本身（记忆还在，只是这一轮退化为
          // workspace 可见），但要留日志——"为什么另一轮看不见"得查得到。
          try {
            await tx.execute(sql`
              INSERT INTO memory_links (workspace_id, user_id, memory_id, entity_type, entity_id, auto_linked)
              VALUES (${job.workspaceId}, ${userId}, ${memoryId}::uuid,
                      ${taskEntity.entityType}, ${taskEntity.entityId}, true)
              ON CONFLICT (memory_id, entity_type, entity_id) DO NOTHING
            `);
          } catch (error) {
            logger.warn(
              { memoryId, taskEntity, error: (error as Error).message },
              "task memory link failed; the memory stays workspace-visible this round",
            );
          }
        }
        if (scope === "global") {
          try {
            const fanned = await tx.execute<{ inserted: number }>(sql`
              SELECT public.ailearn_fanout_global_companion_memory(${memoryId}::uuid) AS inserted
            `);
            logger.info(
              { memoryId, kind: candidate.kind, spaces: Number(fanned[0]?.inserted ?? 0) },
              "cross-space memory fanned out",
            );
          } catch (error) {
            logger.warn(
              { memoryId, kind: candidate.kind, error: (error as Error).message },
              "cross-space memory fanout failed; the memory stays in this space only",
            );
          }
        }
        // 40 §4.5.6：「移除日常『确认写入/暂不采用』的候选流程」。
        //
        // 过去这里写一行 `memory_candidate` 交付，用户要点一下"确认"那条记忆才会活。
        // 现在通过准入的记忆**直接就是活的**，所以这里**不再产出任何交付**：
        // 用户不需要为"她记住了一句话"逐条点确认，也不该被这种气泡打扰。
        //
        // 记忆的管理入口（看/改/删）仍然是有的——合同要移除的是**准入**这一步的
        // 逐条确认，不是移除用户控制（§4.5.6 末段明确保留了手动增删改与归档）。
      }
      for (const entityRef of candidate.linkedEntityIds) {
        const [entityType, entityId] = entityRef.split(":", 2);
        if (!entityType || !entityId) continue;
        await tx.execute(sql`
          INSERT INTO memory_links (memory_id, workspace_id, user_id, entity_type, entity_id, auto_linked)
          SELECT id, workspace_id, user_id, ${entityType}, ${entityId}::uuid, true
          FROM assistant_memory_items
          WHERE workspace_id = ${job.workspaceId} AND user_id = ${userId}
            AND kind = ${candidate.kind}
            AND source_event_id = ${sourceEventId}
          ON CONFLICT (memory_id, entity_type, entity_id) DO NOTHING
        `);
      }
    }
  });

  // 40 §4.5.9：审计的**分母是抽取尝试**，不是"已落库行数"。
  // 所以拒写/去重/丢弃各有各的计数，一起打出来，否则"错误长期化"那一列
  // 永远算不出来——被拒的那些才是最需要看的。
  logger.info(
    {
      jobId: job.id,
      runId,
      count: candidates.length - skippedDismissedTwins - skippedForgottenSources,
      // 分母：模型给了几条
      attempted: confidenceAccepted.length,
      // 分子按原因分开
      sourceRejected,
      invalidValidityRejected,
      sensitiveInferenceRejected,
      volatileDropped: sourcedCandidates.length - nonVolatileCandidates.length,
      duplicateSourceKindDropped,
      dismissedTwinsSkipped: skippedDismissedTwins,
      forgottenSourcesSkipped: skippedForgottenSources,
    },
    "memory extract completed",
  );
}
