/**
 * 模型交的那一份**内容** → V2 的 objective 草稿（39d W7-1 附刀七）。
 *
 * 为什么这一份存在：V3 原先直接把 `learningObjectiveDraftV2Schema` 问模型要，六发真模型
 * 每发撞一层——词表（`knowledgeForm:"…"`）→ 该层必填（`objectiveDraft:{…}`）→ 更深一层的
 * 枚举（`preferredTaskIntents[0]`）→ 输出被 `max_tokens` 截断 → `rubricUnitId` 缺失 →
 * 某格该是对象却交了字符串。那份重形状里大半是**结构脚手架**：unit id、rubric unit id、
 * 七支判别式、relations 的 64 位哈希——都不是"教学质量"，却全是模型必然出错的地方，
 * 而每撞一层都要再花一发真调用才知道。
 *
 * 三条不变量：
 *  - **不新增判分语义**：判分点逐条来自模型，`answerUnitIds` 只把"第几个片段"换成服务端 id；
 *    指不到存在片段的序号**丢掉**（宁可少一条判分点，也不留一个指向空气的引用——留着就是
 *    过了 schema 却悬空，只有落库后的投影会炸）。
 *  - **不越权决定题型**：`strategy`/`transformationKind` 只放合法占位，整批分配在
 *    `plan-assembly.ts` 覆盖（教训见 card-generation-v2-contracts.ts:404-414）。
 *  - `practiceItem` 不生成：`plan-assembly.ts` 那条"缺省时按答案派生"的规则照旧生效。
 */
import {
  cardGenerateV3CandidateContentSchema,
  cardGenerateV3DraftOutputSchema,
  cardGenerateV3OutputEnvelopeSchema,
  type CardGenerateV3CandidateContent,
  type CardGenerateV3CandidateDraft,
  type CardGenerateV3DraftOutput,
  type CardGenerateV3ObjectiveProposal,
} from "@ailearn/shared/card-generation-v3-contracts";
import type {
  CanonicalAnswerV2,
  CardPresentationDraftV2,
  LearningObjectiveDraftV2,
} from "@ailearn/shared/card-generation-v2-contracts";
import type { TaskIntentV1 } from "@ailearn/shared/learning-run-contracts";

type RubricUnitV2 = LearningObjectiveDraftV2["rubric"]["units"][number];

/** 占位策略；真实值由整批分配覆盖。 */
const PLACEHOLDER_STRATEGY = "recall" as const;

const TRANSFORMATION_BY_STRATEGY: Record<string, CardPresentationDraftV2["transformationKind"]> = {
  recall: "retrieval_definition",
  cloze: "mechanism_reconstruction",
  compare: "structured_comparison",
  sequence: "procedure_reconstruction",
  why: "mechanism_reconstruction",
  boundary: "boundary_discrimination",
  application: "source_grounded_application",
};

function buildCanonicalAnswer(content: CardGenerateV3CandidateContent): CanonicalAnswerV2 {
  const parts = content.answerParts;
  const idOf = (index: number) => `au-${index + 1}`;
  const asBullets = (): CanonicalAnswerV2 => ({
    kind: "bullets",
    items: parts.map((part, index) => ({ unitId: idOf(index), text: part.text })),
  });
  switch (content.answerForm) {
    case "bullets":
      return asBullets();
    case "steps":
      // `ordered_steps` 合同要 ≥2 段：只给了一段就退回 bullets，而不是让整发红在片段数上。
      return parts.length >= 2
        ? { kind: "ordered_steps", steps: parts.map((part, index) => ({ unitId: idOf(index), text: part.text })) }
        : asBullets();
    case "pairs":
      return {
        kind: "mapping",
        pairs: parts.map((part, index) => ({
          unitId: idOf(index),
          left: part.label && part.label.length > 0 ? part.label : `第 ${index + 1} 项`,
          right: part.text,
        })),
      };
    case "prose":
    default:
      return { kind: "text", unit: { unitId: "au-1", text: parts[0]!.text } };
  }
}

/**
 * 片段序号的**两种写法**：合同写 1 起，但真模型会写 0 起（第七发就是被 `too_small` 整批拒的）。
 * 判据只有一条：出现 0 且没有出现等于片段数的越界值 ⇒ 按 0 起解释，整体 +1。
 * 序号约定不是教学质量问题，不该用"整批红一次"来教。
 */
function normalizePartIndexesV3(indexes: readonly number[], partCount: number): number[] {
  const zeroBased = indexes.includes(0) && !indexes.includes(partCount);
  return indexes.map((n) => (zeroBased ? n + 1 : n));
}

export interface ExpandCandidateContentV3 {
  readonly draft: CardGenerateV3CandidateDraft;
  /** 被丢掉的悬空引用条数（模型指了不存在的片段号）。 */
  readonly droppedPartRefs: number;
  /** 一条判分点都没剩：这一张不能进牌堆。 */
  readonly rubricEmpty: boolean;
}

export function expandCardGenerateV3ContentV3(input: {
  content: CardGenerateV3CandidateContent;
  proposal: CardGenerateV3ObjectiveProposal | undefined;
}): ExpandCandidateContentV3 {
  const { content, proposal } = input;
  const partCount = content.answerParts.length;
  const known = new Set<string>(
    Array.from({ length: partCount }, (_, index) => `au-${index + 1}`),
  );
  let droppedPartRefs = 0;
  const units: RubricUnitV2[] = [];
  content.judgingPoints.forEach((point, index) => {
    const indexes = normalizePartIndexesV3(point.partIndexes, partCount);
    const answerUnitIds = [...new Set(indexes.map((n) => `au-${n}`))].filter((id) => known.has(id));
    droppedPartRefs += indexes.length - answerUnitIds.length;
    if (answerUnitIds.length === 0) return;
    units.push({
      rubricUnitId: `ru-${index + 1}`,
      facet: point.facet as TaskIntentV1,
      criterion: point.criterion,
      required: point.required,
      answerUnitIds,
      evidenceRefIds: content.evidenceSnapshotIds,
      contradictionRules: [],
    });
  });
  const objectiveDraft: LearningObjectiveDraftV2 = {
    // 目标陈述与知识形态以**提案**为准：不让模型在两张表里各说一遍（说歪了就没有出处）。
    objectiveStatement: proposal?.objectiveStatement ?? content.publicSummary,
    publicSummary: content.publicSummary,
    conceptLabel: content.conceptLabel,
    knowledgeForm: proposal?.knowledgeForm ?? "fact",
    preferredTaskIntents: [...new Set(content.judgingPoints.map((point) => point.facet as TaskIntentV1))].slice(0, 6),
    canonicalAnswer: buildCanonicalAnswer(content),
    learningSupport: {
      explanation: content.explanation,
      ...(content.boundary ? { boundary: content.boundary } : {}),
      ...(content.misconception ? { misconception: content.misconception } : {}),
      ...(content.workedExample ? { workedExample: content.workedExample } : {}),
    },
    rubric: {
      version: 2,
      units,
      passingPolicy: { requireAllRequiredUnits: true, allowContradiction: false },
      rubricHash: "0".repeat(64), // 组装层丢弃重算
    },
    relations: [],
    difficulty: units.length >= 3 ? "advanced" : units.length === 2 ? "intermediate" : "introductory",
    evidenceRefIds: content.evidenceSnapshotIds,
  };
  return {
    droppedPartRefs,
    rubricEmpty: units.length === 0,
    draft: {
      objectiveLocalId: content.objectiveLocalId,
      objectiveDraft,
      presentationDraft: {
        // 两个占位都会被整批分配覆盖（strategy 必须整批定，见 v2-contracts:404-414）。
        strategy: PLACEHOLDER_STRATEGY,
        transformationKind: TRANSFORMATION_BY_STRATEGY[PLACEHOLDER_STRATEGY]!,
        front: {
          cue: content.front.cue,
          prompt: content.front.prompt,
          ...(content.front.context ? { context: content.front.context } : {}),
        },
        estimatedReviewSeconds: content.estimatedReviewSeconds,
      },
      hints: content.hints,
    },
  };
}

export interface ExpandOutputV3 {
  readonly output: CardGenerateV3DraftOutput;
  readonly droppedEmptyRubric: number;
  readonly droppedPartRefs: number;
  /** 内容合同没过的候选：**逐条**剔除并留因（一条少给一格不该让整批红）。 */
  readonly droppedInvalid: ReadonlyArray<{ readonly objectiveLocalId: string; readonly reason: string }>;
}

/** 整份生成输出：内容 → 脚手架搭好的草稿（逐候选宽进、逐条留因）。 */
export function expandCardGenerateV3OutputV3(raw: unknown): ExpandOutputV3 {
  const parsed = cardGenerateV3OutputEnvelopeSchema.parse(raw);
  const drafts: CardGenerateV3CandidateDraft[] = [];
  const droppedInvalid: Array<{ objectiveLocalId: string; reason: string }> = [];
  let droppedEmptyRubric = 0;
  let droppedPartRefs = 0;
  if (parsed.planIntent.kind !== "author_candidates") {
    return {
      output: cardGenerateV3DraftOutputSchema.parse({ ...parsed, candidates: [] }),
      droppedEmptyRubric: 0, droppedPartRefs: 0, droppedInvalid: [],
    };
  }
  const proposals = new Map(parsed.objectiveProposals.map((p) => [p.objectiveLocalId, p]));
  for (const rawCandidate of parsed.candidates) {
    const localId = (rawCandidate as { objectiveLocalId?: unknown })?.objectiveLocalId;
    const parsedCandidate = cardGenerateV3CandidateContentSchema.safeParse(rawCandidate);
    if (!parsedCandidate.success) {
      droppedInvalid.push({
        objectiveLocalId: typeof localId === "string" ? localId : `#${droppedInvalid.length + 1}`,
        // 只留第一条与路径：整段 zod 消息会把 last_error 撑爆，也读不出重点。
        reason: parsedCandidate.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join(".") || "(根)"}: ${issue.message}`)
          .join("；"),
      });
      continue;
    }
    const content = parsedCandidate.data;
    const proposal = proposals.get(content.objectiveLocalId);
    if (!proposal) {
      // 提案对不上的引用在**合同那一层**就该被拒（信封不判，这里判）：仍旧剔掉并留因。
      droppedInvalid.push({ objectiveLocalId: content.objectiveLocalId, reason: "引用了未提案的 objectiveLocalId" });
      continue;
    }
    const expanded = expandCardGenerateV3ContentV3({ content, proposal });
    droppedPartRefs += expanded.droppedPartRefs;
    if (expanded.rubricEmpty) { droppedEmptyRubric += 1; continue; }
    drafts.push(expanded.draft);
  }
  return {
    output: cardGenerateV3DraftOutputSchema.parse({ ...parsed, candidates: drafts }),
    droppedEmptyRubric, droppedPartRefs, droppedInvalid,
  };
}


/**
 * 反向：搭好的 objective 草稿 → 内容形状。**只给确定性 provider 用**——它手里本来就有一份
 * 完整的 V2 草稿（离线作者交的），要走同一个端口就得说同一句话（内容），而不是把重形状
 * 直接塞回模型的合同位置。序号按 `au-N` 反推；反推不到的引用丢掉，交给展开器数。
 */
export function contentFromObjectiveDraftV3(input: {
  objectiveLocalId: string;
  draft: LearningObjectiveDraftV2;
  presentation: CardPresentationDraftV2;
  hints: { level1: string; level2: string };
}): CardGenerateV3CandidateContent {
  const { draft, presentation } = input;
  const answer = draft.canonicalAnswer;
  const unitTexts: Array<{ unitId: string; text: string; label?: string }> = (() => {
    switch (answer.kind) {
      case "text": return [{ unitId: answer.unit.unitId, text: answer.unit.text }];
      case "bullets": return answer.items.map((i) => ({ unitId: i.unitId, text: i.text }));
      case "ordered_steps": return answer.steps.map((i) => ({ unitId: i.unitId, text: i.text }));
      case "mapping": return answer.pairs.map((i) => ({ unitId: i.unitId, text: i.right, label: i.left }));
      case "comparison":
        return answer.rows.map((row) => ({
          unitId: row.unitId, text: `${row.dimension}：${row.values.join("、")}`, label: row.dimension,
        }));
      case "formula": return [{ unitId: answer.unitId, text: answer.latex }];
      case "code": return [{ unitId: answer.unitId, text: answer.code }];
      default: return [];
    }
  })();
  const indexOfUnit = new Map(unitTexts.map((u, index) => [u.unitId, index + 1]));
  const answerForm = answer.kind === "ordered_steps" ? "steps"
    : answer.kind === "mapping" ? "pairs"
      : answer.kind === "bullets" ? "bullets" : "prose";
  const judgingPoints = draft.rubric.units
    .map((unit) => ({
      facet: unit.facet,
      criterion: unit.criterion,
      required: unit.required,
      partIndexes: unit.answerUnitIds.map((id) => indexOfUnit.get(id) ?? 0).filter((n) => n > 0),
    }))
    .filter((point) => point.partIndexes.length > 0);
  return {
    objectiveLocalId: input.objectiveLocalId,
    conceptLabel: draft.conceptLabel,
    publicSummary: draft.publicSummary,
    answerForm,
    answerParts: unitTexts.map((u) => ({ text: u.text, ...(answerForm === "pairs" && u.label ? { label: u.label } : {}) })),
    judgingPoints: judgingPoints.length > 0
      ? judgingPoints
      : [{ facet: "recall" as TaskIntentV1, criterion: "说出这一句的关键点", required: true, partIndexes: [1] }],
    explanation: draft.learningSupport.explanation,
    ...(draft.learningSupport.boundary ? { boundary: draft.learningSupport.boundary } : {}),
    ...(draft.learningSupport.misconception ? { misconception: draft.learningSupport.misconception } : {}),
    ...(draft.learningSupport.workedExample ? { workedExample: draft.learningSupport.workedExample } : {}),
    front: {
      cue: presentation.front.cue,
      prompt: presentation.front.prompt,
      ...(presentation.front.context ? { context: presentation.front.context } : {}),
    },
    hints: input.hints,
    estimatedReviewSeconds: presentation.estimatedReviewSeconds,
    evidenceSnapshotIds: draft.evidenceRefIds,
  };
}
