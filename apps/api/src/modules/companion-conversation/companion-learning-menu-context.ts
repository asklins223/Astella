/** Read-only learning-menu context, shared with proposal creation in its transaction. */
import { createLearningRunV2RequestSchema, type CompanionLearningContextV1, type LearningRunOriginV2 } from "@astella/shared";
import { sha256Utf8V1, canonicalJsonV1 } from "@astella/shared/content-hash";
import { withWorkspaceTransaction, type ApiTransaction } from "../../db/client.ts";
import { primaryActionPrecedenceV3 } from "../learning-objectives/action-resolver.ts";
import { listObjectiveSurfacesV3, type SurfaceContext } from "../learning-objectives/surface-service.ts";

export function sanitizeText(value: string, max: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * resolveCompanionLearningContextInTransaction 的内部返回：除公开候选外，附带
 * 已查出、供 proposal create 无重复查询地构造 payload 的最小引用 id。
 * LearningRun 候选的合同已经携带创建/恢复所需的最小引用。
 */
type ResolvedCompanionContextInternal = CompanionLearningContextV1;

function toPublicContext(ctx: ResolvedCompanionContextInternal): CompanionLearningContextV1 {
  return {
    version: ctx.version,
    contextRevision: ctx.contextRevision,
    learningRunResumeCandidate: ctx.learningRunResumeCandidate,
    learningRunStartCandidate: ctx.learningRunStartCandidate,
  };
}

/**
 * Plan 23 CS-05/CS-06：V2 run 请求的 originV2 类型守卫。
 * pet 不自建 origin 对象；以下仅作 narrow，保证下游 createRunV2 类型安全。
 */
function isLearningRunOriginV2(value: unknown): value is LearningRunOriginV2 {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === "card" || kind === "review" || kind === "today" || kind === "star_map" || kind === "onboarding";
}

/**
 * Plan 23 CS-05/CS-06：从 Objective Surface 主 action 构造 V2 run 请求。
 * 绝不从 claim/summary 自推断 run 参数；所有参数都来自 Surface 的 typed action。
 *
 * 返回 null 表示当前 action 不适合菜单创建（如 none / refresh）。
 */
function buildStartPayloadV2(
  surface: Awaited<ReturnType<typeof listObjectiveSurfacesV3>>["items"][number],
): {
  request: {
    originV2: LearningRunOriginV2;
    goal: "stabilize" | "clarify" | "repair" | "transfer" | "explore";
    idempotencyKey: string;
    requestedTimeBudgetSeconds?: number;
    responsePreference?: "adaptive" | "voice" | "text" | "structured";
  };
} | null {
  const objectiveId = surface.objectiveId;
  switch (surface.primaryAction.kind) {
    case "create_run": {
      return {
        request: {
          ...surface.primaryAction.start,
          idempotencyKey: `pet-menu-v2:${objectiveId}`,
        },
      };
    }
    case "create_review_run": {
      return {
        request: {
          ...surface.primaryAction.start,
          idempotencyKey: `pet-menu-v2:${objectiveId}`,
        },
      };
    }
    case "resume_run": {
      // resume 语义走 resume_learning_run；create 入口仍需一个 create 语义。
      return null;
    }
    case "view_successor":
      // view_successor 不是可"创建 run"的 action；菜单不展示。
      return null;
    case "refresh":
    case "practice_only":
    case "none":
      // 这些 action 不适合 pet 菜单创建 run。
      return null;
    default:
      return null;
  }
  return null;
}


export async function resolveCompanionLearningContextInTransaction(
  tx: ApiTransaction,
  args: {
    workspaceId: string;
    userId: string;
  },
): Promise<ResolvedCompanionContextInternal> {
  // This helper deliberately accepts the caller's transaction. Proposal
  // creation must validate the read-only context and perform all writes under
  // the same RLS snapshot; opening a nested transaction here would leave a
  // race between validation and insertion.
  // 当前候选只从 Objective Surface 派生，不能从已删除的 Session/Episode 表回退。
  const surfaceCtx: SurfaceContext = {
    workspaceId: args.workspaceId,
    userId: args.userId,
  };
  const objectiveLimit = 5;
  const { items: objectives } = await listObjectiveSurfacesV3(tx, surfaceCtx, {
    limit: objectiveLimit,
    lifecycle: "active",
  });

  /**
   * 顺位取 §3.2 那一份唯一住处（`action-resolver.ts`），**这里不再抄表**。
   * 此前这份本地表把 `create_run` 排在 `create_review_run` 之前——伴星会因此把
   * 「开始学习」排在「到期复习」前面，正是 §3.2 明令不许的那种不一致
   * （"不能在笔记页推荐初学、首页强制复习、星图又恢复另一轮"）。
   */
  const sorted = [...objectives].sort(
    (a, b) => primaryActionPrecedenceV3(a.primaryAction.kind) - primaryActionPrecedenceV3(b.primaryAction.kind),
  );

  // resume：带 activeRun 的第一个 Objective（typed resume_run）。
  let learningRunResumeCandidate: CompanionLearningContextV1["learningRunResumeCandidate"] = null;
  const resumeObjective = sorted.find((s) => s.personal.activeRun);
  if (resumeObjective) {
    const runId = resumeObjective.personal.activeRun!.runId;
    const label = resumeObjective.content.conceptLabel;
    const title = sanitizeText(label ?? "", 80) || "继续本次巩固";
    const summaryPreview = resumeObjective.content.publicSummary.split("\n")[0] ?? "";
    const payload = { kind: "resume_learning_run", runId };
    learningRunResumeCandidate = {
      candidateId: "learning_run_resume",
      runId,
      title,
      targetSummary: sanitizeText(summaryPreview || `继续：${title}`, 160),
      impactSummary: "恢复当前学习运行",
      payloadSha256: sha256Utf8V1(canonicalJsonV1(payload)),
    };
  }

  // start：可执行的第一个 Objective（typed create_run / create_review_run）。
  let learningRunStartCandidate: CompanionLearningContextV1["learningRunStartCandidate"] = null;
  const actionableObjective = sorted.find((s) => {
    const k = s.primaryAction.kind;
    return k === "create_run" || k === "create_review_run" || k === "resume_run";
  });
  if (actionableObjective) {
    const label = actionableObjective.content.conceptLabel;
    const claimText = label ?? "";
    const startAction = actionableObjective.primaryAction;
    const payloadV2 = buildStartPayloadV2(actionableObjective);
    const v2Payload = payloadV2 ? {
      kind: "start_learning_run_v2" as const,
      request: payloadV2.request,
    } : null;
    if (v2Payload && isLearningRunOriginV2(v2Payload.request.originV2)) {
      const request = createLearningRunV2RequestSchema.parse(v2Payload.request);
      const proposalPayload = { kind: "start_learning_run_v2" as const, request };
      learningRunStartCandidate = {
      candidateId: "learning_run_start",
      // 没有概念名时用**服务端这一条 action 自己带的 label**（「开始学习」／「开始首次验证」／
      // 「再做一次正式挑战」／「开始到期复习」）。这里原来硬写了「开始验证」——那既不是
      // 这一条动作的词，还把"练习/新学"说成"正式验证"（2026-09-25 量到：无卡目标的候选
      // title=「开始验证」而 action.label=「开始学习」）。一个用户可见的词只准一个来源。
      title: sanitizeText(claimText, 80)
        || (startAction.kind === "create_run" || startAction.kind === "create_review_run"
          ? startAction.label
          : claimText),
      targetSummary: sanitizeText(actionableObjective.content.publicSummary.split("\n")[0]
        || `开始：${claimText}`, 160),
      impactSummary: actionableObjective.personal.review?.status === "due"
        ? "完成复习运行，恢复记忆曲线"
        : "创建一次学习运行，完成后按真实结果安排复习",
      payloadSha256: sha256Utf8V1(canonicalJsonV1(proposalPayload)),
      objectiveId: actionableObjective.objectiveId,
      originV2: request.originV2,
      request,
      };
    }
  }

  const contextRevision = sha256Utf8V1(
    canonicalJsonV1({ learningRunResumeCandidate, learningRunStartCandidate }),
  );
  return {
    version: 1,
    contextRevision,
    learningRunResumeCandidate,
    learningRunStartCandidate,
  };
}

export async function resolveCompanionLearningContext(args: {
  workspaceId: string;
  userId: string;
}): Promise<CompanionLearningContextV1> {
  return withWorkspaceTransaction(
    { workspaceId: args.workspaceId, userId: args.userId },
    (tx) => resolveCompanionLearningContextInTransaction(tx, args).then(toPublicContext),
  );
}
