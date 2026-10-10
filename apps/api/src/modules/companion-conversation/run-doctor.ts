import { and, desc, eq, gt, sql } from "drizzle-orm";
import {
  COMPANION_AGENT_DEADLINE_MS,
  COMPANION_AGENT_MAX_STEPS,
  COMPANION_AGENT_MAX_TOOL_CALLS,
  COMPANION_AGENT_MAX_TOOL_CALLS_PER_STEP,
  companionAgentBudgetSnapshotV1Schema,
  companionAgentCapabilitySnapshotV1Schema,
  companionRunFailureClassV1Schema,
  companionRunDoctorV1Schema,
  companionRunJobStatusV1Schema,
  type CompanionAgentPermissionLevel,
  type CompanionRunDoctorV1,
  type CompanionRunFailureClassV1,
} from "@astella/shared";
import {
  companionAgentSteps,
  companionAgentToolCalls,
  companionProceduralPlaybooks,
  companionPersonaProfiles,
  companionReflections,
  companionStreamEvents,
  companionTurnRuns,
  jobs,
} from "@astella/shared/db-schema";
import type { ApiTransaction } from "../../db/client.ts";

export interface CompanionRunDoctorScope {
  workspaceId: string;
  userId: string;
}

export interface CompanionRunDoctorRunRow {
  id: string;
  conversationId: string;
  status: CompanionRunDoctorV1["run"]["status"];
  generation: number;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  assistantMessageId: string | null;
  errorCode: string | null;
  providerId: string | null;
  modelId: string | null;
  promptVersion: string | null;
  permissionLevel: CompanionAgentPermissionLevel | null;
  permissionSnapshot: unknown;
  budgetSnapshot: unknown;
  /** 这一轮钉死的那一版人格（0341/0356）；null = 还没到钉版本的阶段。 */
  personaProfileRevision: number | null;
  /** 44 的装配回执：哪些来源真进了这一次请求。 */
  contextAssemblyReceipt: unknown;
  stepCount: number;
  toolCallCount: number;
  agentElapsedMs: number;
  lastEventSeq: number;
  jobId: string | null;
};

export interface CompanionRunDoctorProjectionInput {
  run: CompanionRunDoctorRunRow;
  job: {
    id: string;
    status: NonNullable<CompanionRunDoctorV1["queue"]["status"]>;
    attempts: number;
    hasLease: boolean;
    scheduledAt: Date;
    startedAt: Date | null;
    finishedAt: Date | null;
  } | null;
  stepCounts: CompanionRunDoctorV1["ledger"]["stepCounts"];
  toolCounts: CompanionRunDoctorV1["ledger"]["toolCounts"];
  retainedEvent: { count: number; latestSeq: number | null; latestAt: Date | null };
  failureSpans?: CompanionRunDoctorV1["failureSpans"];
  /**
   * 成长闭环的格子（方案 50 §12.2）。读的是已有的权威行，不新立一份状态：
   * 回顾结论在 `companion_reflections`，人格当前/排队在账号档案上，
   * 进没进上下文在这一轮的装配回执里。整个字段可缺省——缺省就是「什么都不能说」，
   * 投影成 null，而不是投影成「一切正常」。
   */
  growth?: {
    reflection: {
      id: string; createdAt: Date; decision: string; decisionSummary: string | null;
      strategyVersion: string; inputFromSeq: number; inputToSeq: number;
      baselinePersonaRevision: number; pendingPersonaRevision: number | null;
      resultRef: unknown; jobId: string | null;
    } | null;
    reflectionJobStatus?: string | null;
    persona?: {
      currentRevision: number; pendingRevision: number | null; pendingAuthor: string | null;
      pinnedThisRun: number | null;
    } | null;
    candidateCount?: number;
  } | null;
}

const ACTIVE_RUN_STATUSES = new Set([
  "accepted",
  "running",
  "waiting_for_confirmation",
  "cancel_requested",
]);
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "cancelled", "failed", "superseded"]);

function iso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function failureCategory(status: string, code: string | null): "none" | "stale_context" | "internal" | "unknown" {
  if (status !== "failed") return "none";
  if (code === "ACTION_STALE") return "stale_context";
  if (code === "INTERNAL_ERROR") return "internal";
  return "unknown";
}

function countFor(
  counts: readonly { status: string; count: number }[],
  status: string,
): number {
  return counts.find((entry) => entry.status === status)?.count ?? 0;
}

function buildMarkdown(report: Omit<CompanionRunDoctorV1, "markdown">): string {
  const lines = [
    "# 伴星运行诊断",
    `- Run：${report.run.id}`,
    `- 状态：${report.run.status}；第 ${report.run.generation} 代`,
    `- 后台任务：${report.queue.status ?? "无可读关联任务"}`,
    `- Agent 预算：步骤 ${report.executionBudget.stepsUsed}/${report.executionBudget.maxSteps}，工具 ${report.executionBudget.toolCallsUsed}/${report.executionBudget.maxToolCalls}，累计 ${report.executionBudget.elapsedMs} ms`,
    `- 工具账本：${report.ledger.toolCounts.reduce((sum, entry) => sum + entry.count, 0)} 条；结果待核对 ${report.ledger.unknownToolOutcomeCount} 条`,
    `- 当前可读事件：${report.ledger.retainedEventCount} 条`,
  ];
  if (report.findings.length > 0) {
    lines.push("", "## 检查结果");
    for (const finding of report.findings) {
      lines.push(`- [${finding.severity}] ${finding.message}`);
    }
  } else {
    lines.push("", "运行状态与当前可读账本未发现明显断链。");
  }
  const growthLines = describeGrowthLoop(report.growth);
  if (growthLines.length > 0) lines.push("", ...growthLines);
  const openSpans = report.failureSpans.filter((span) => span.recoveredAt === null);
  if (openSpans.length > 0) {
    lines.push("", "## 尚未恢复的失败段");
    for (const span of openSpans) {
      lines.push(`- ${span.failureClass}：${span.failureCount} 次，最近 ${span.lastFailureAt}；定位 run ${span.lastRunId ?? "已删除"}`);
    }
  }
  return lines.join("\n");
}


/**
 * 成长闭环那一格：把「她回顾了吗 / 得出什么 / 提交了吗 / 生效了吗 / 这一轮带上身了吗」
 * 摊成可诊断的事实（方案 50 §12.2）。
 *
 * 三条刻意的口径：
 * - **安静不是故障**。`no_change`、段落没落定这些都属正常结果，报 info 并把原因说清，
 *   不能不报——不报与报成「后台维护正常」是同一个毛病。
 * - 缺省（读不到任何行）投影成 null：没有证据时不说「正常」。
 * - 「进了上下文但行为没兑现」这一格机器证不了，这里只交事实，
 *   报告里明写它要靠样本。
 */
function projectGrowthLoop(
  input: CompanionRunDoctorProjectionInput,
  addFinding: (code: CompanionRunDoctorV1["findings"][number]["code"],
    severity: CompanionRunDoctorV1["findings"][number]["severity"], message: string) => void,
): CompanionRunDoctorV1["growth"] {
  const growth = input.growth;
  if (!growth) return null;
  const reflection = growth.reflection;
  const persona = growth.persona ?? null;

  const receipt = input.run.contextAssemblyReceipt as
    { included?: Array<{ id?: unknown }>; omitted?: Array<{ id?: unknown }> } | null | undefined;
  const includedIds = new Set((receipt?.included ?? [])
    .map((entry) => (typeof entry?.id === "string" ? entry.id : "")));
  const context = receipt === null || receipt === undefined ? null : {
    personaIncluded: includedIds.has("persona"),
    methodCandidatesIncluded: includedIds.has("method_candidates"),
    receiptPresent: true,
    candidateCount: growth.candidateCount ?? 0,
  };

  const quietReason: Record<string, string> = {
    trigger_none: "这一段还没落定（末尾还停在用户说话），所以她还没回顾。",
    insufficient_input: "这一段的来回太少，回顾没有可依据的东西，模型也没被调用。",
    no_change: "她看过这一段，认为没有什么要改。",
  };
  const failedReason: Record<string, string> = {
    protocol_failed: "回顾拿到的那份结论没通过核对，这一次什么都没留下。",
    commit_conflict: "回顾想提交时，它参照的那一版人格已经被推走，于是不提交。",
    source_invalid: "那一版改动引用的原话已经不在了，所以没有生效。",
    lease_lost: "回顾任务被接手过，这一次的结果没有提交。",
    governance_denied: "数据同意或预算不允许，这一次回顾没有向模型发任何东西。",
  };
  if (reflection) {
    if (failedReason[reflection.decision]) {
      addFinding("growth_reflection_failed", "warning",
        `回顾（${reflection.decision}）：${failedReason[reflection.decision]}`);
    } else if (quietReason[reflection.decision]) {
      addFinding("growth_reflection_quiet", "info",
        `回顾（${reflection.decision}）：${quietReason[reflection.decision]}`);
    } else if (["queued", "running"].includes(reflection.decision)) {
      addFinding("growth_reflection_quiet", "info",
        `回顾还在排队或正在跑（job ${growth.reflectionJobStatus ?? "未知状态"}）。`);
    }
  }
  if (persona?.pendingRevision != null) {
    addFinding("growth_staged_not_adopted", "info",
      `第 ${persona.pendingRevision} 版她自己的改动在排队（${persona.pendingAuthor ?? "未知出处"}），`
        + "等下一条被接受的新消息才生效。");
  }
  if (persona && input.run.personaProfileRevision !== null
    && input.run.personaProfileRevision !== persona.currentRevision) {
    addFinding("growth_persona_version_not_this_run", "info",
      `这一轮钉的是第 ${input.run.personaProfileRevision} 版，账号现在是第 ${persona.currentRevision} 版。`);
  }
  if (context && context.candidateCount > 0 && !context.methodCandidatesIncluded) {
    addFinding("growth_candidates_not_in_context", "info",
      `有 ${context.candidateCount} 条她自己提炼的做法，这一轮没带上`
        + "（正式作答那一档不带候选，或没进这一轮的装配）。");
  }

  const dropped = Array.isArray((reflection?.resultRef as { dropped?: unknown } | null)?.dropped)
    ? ((reflection?.resultRef as { dropped: unknown[] }).dropped.length) : 0;
  return {
    reflection: reflection ? {
      id: reflection.id,
      createdAt: iso(reflection.createdAt) ?? new Date(0).toISOString(),
      decision: reflection.decision,
      decisionSummary: reflection.decisionSummary,
      strategyVersion: reflection.strategyVersion,
      // bigint 列经这条读边回来可能是字符串形态；合同要的是数，在边界上换算一次。
      inputFromSeq: Number(reflection.inputFromSeq),
      inputToSeq: Number(reflection.inputToSeq),
      baselinePersonaRevision: Number(reflection.baselinePersonaRevision),
      pendingPersonaRevision: reflection.pendingPersonaRevision === null
        ? null : Number(reflection.pendingPersonaRevision),
      droppedCount: dropped,
      jobId: reflection.jobId,
      jobStatus: growth.reflectionJobStatus
        ? companionRunJobStatusV1Schema.parse(growth.reflectionJobStatus) : null,
    } : null,
    // 「这一轮钉的是哪一版」只有 run 自己说了算，不由那份账号档案推。
    persona: persona
      // 这一列在库里是 bigint，读边给的是字符串；合同要数，在边界换算一次。
      ? {
        ...persona,
        pinnedThisRun: input.run.personaProfileRevision === null
          ? null : Number(input.run.personaProfileRevision),
      } : null,
    context,
  };
}

/**
 * 报告里那一格「成长闭环」。每行都是已落库的事实；读不出的那一步直说读不出来。
 */
function describeGrowthLoop(growth: CompanionRunDoctorV1["growth"]): string[] {
  if (!growth) return [];
  const lines: string[] = ["## 成长闭环"];
  if (growth.reflection) {
    const r = growth.reflection;
    lines.push(`- 最近一次回顾：${r.decision}${r.decisionSummary ? `；${r.decisionSummary}` : ""}`
      + `（段 seq ${r.inputFromSeq}→${r.inputToSeq}，策略 ${r.strategyVersion}，`
      + `基线第 ${r.baselinePersonaRevision} 版，核对丢掉 ${r.droppedCount} 条）`);
    if (r.jobStatus) lines.push(`- 那次回顾的后台任务：${r.jobStatus}`);
  } else {
    lines.push("- 这个会话还没有回顾记录：入队门没挑中它（段落没落定、来回太少，或还没到下一次叫醒）。");
  }
  if (growth.persona) {
    const p = growth.persona;
    lines.push(`- 人格：当前第 ${p.currentRevision} 版`
      + (p.pendingRevision != null
        ? `，另有第 ${p.pendingRevision} 版在排队（${p.pendingAuthor ?? "未知出处"}）`
        : "，没有排队的版本")
      + (p.pinnedThisRun != null ? `；这一轮钉的是第 ${p.pinnedThisRun} 版` : "；这一轮还没钉版本"));
    if (p.pendingRevision != null) {
      lines.push("- 排队那一版要等**下一条被接受的新用户消息**才生效；正在进行的这一轮不变。");
    }
  }
  if (growth.context) {
    const c = growth.context;
    lines.push(`- 带上身了吗：人格 ${c.personaIncluded ? "在" : "不在"}这一轮请求、`
      + `她自己提炼的做法 ${c.candidateCount} 条（${c.methodCandidatesIncluded ? "已进这一轮" : "未进这一轮"}）`);
  }
  lines.push("- 「进了上下文之后行为是否兑现」不由这里判定，需要独立后续对话样本。");
  return lines;
}

/**
 * Build a private, read-only diagnosis from the run's existing durable records.
 * Raw prompt context, tool arguments/results, checkpoints, reasoning handles,
 * job payloads and provider error text are deliberately never projected.
 */
export function projectCompanionRunDoctorV1(input: CompanionRunDoctorProjectionInput): CompanionRunDoctorV1 {
  const budgetResult = companionAgentBudgetSnapshotV1Schema.safeParse(input.run.budgetSnapshot);
  const budget = budgetResult.success
    ? budgetResult.data
    : {
      maxSteps: COMPANION_AGENT_MAX_STEPS,
      maxToolCallsPerStep: COMPANION_AGENT_MAX_TOOL_CALLS_PER_STEP,
      maxToolCalls: COMPANION_AGENT_MAX_TOOL_CALLS,
      deadlineMs: COMPANION_AGENT_DEADLINE_MS,
    };
  const capabilityResult = companionAgentCapabilitySnapshotV1Schema.safeParse(input.run.permissionSnapshot);
  const capability = capabilityResult.success ? capabilityResult.data : null;
  const stepCounts = input.stepCounts.map(({ status, count }) => ({ status, count }));
  const toolCounts = input.toolCounts.map(({ status, count }) => ({ status, count }));
  const unknownToolOutcomeCount = countFor(toolCounts, "outcome_unknown");
  const pendingToolCount = ["requested", "executing", "waiting_confirmation"]
    .reduce((sum, status) => sum + countFor(toolCounts, status), 0);
  const job = input.job;
  const findings: CompanionRunDoctorV1["findings"] = [];
  const failureSpans = input.failureSpans ?? [];
  const addFinding = (
    code: CompanionRunDoctorV1["findings"][number]["code"],
    severity: CompanionRunDoctorV1["findings"][number]["severity"],
    message: string,
  ) => findings.push({ code, severity, message });

  if (input.run.status === "failed") {
    const category = failureCategory(input.run.status, input.run.errorCode);
    addFinding(
      "run_failed",
      "error",
      category === "stale_context"
        ? "本轮因上下文已变化而失败。"
        : category === "internal"
          ? "本轮运行失败；内部错误详情未包含在诊断中。"
          : "本轮运行失败；错误详情未包含在诊断中。",
    );
  }
  if (input.run.status === "succeeded" && input.run.assistantMessageId === null) {
    addFinding("success_without_message", "error", "运行记录显示成功，但没有已保存的伴星回复。 ");
  }
  if (ACTIVE_RUN_STATUSES.has(input.run.status) && !job) {
    addFinding("active_job_missing", "error", "本轮仍处于活动状态，但关联后台任务不可读。 ");
  }
  if (
    ACTIVE_RUN_STATUSES.has(input.run.status)
    && job
    && ["failed", "dead", "succeeded"].includes(job.status)
  ) {
    addFinding("active_job_terminal", "error", "本轮仍处于活动状态，但后台任务已经终止。 ");
  }
  if (job?.status === "running" && !job.hasLease) {
    addFinding("running_job_without_lease", "warning", "后台任务显示运行中，但当前没有可见租约。 ");
  }
  if (unknownToolOutcomeCount > 0) {
    addFinding("tool_outcome_unknown", "warning", "有工具动作没有确定回执；核对结果前不要重复执行。 ");
  }
  if (TERMINAL_RUN_STATUSES.has(input.run.status) && pendingToolCount > 0) {
    addFinding("terminal_run_open_tool", "warning", "本轮已结束，但工具账本仍有未收口动作。 ");
  }
  if (capability === null) {
    addFinding("tool_snapshot_missing", "info", "这轮没有保存当时提供给模型的工具清单，历史工具可用性无法复核。 ");
  }
  if (
    ACTIVE_RUN_STATUSES.has(input.run.status)
    && input.run.lastEventSeq > 0
    && input.retainedEvent.latestSeq !== input.run.lastEventSeq
  ) {
    addFinding("active_event_tail_missing", "warning", "本轮记录的事件游标与保留事件尾部不一致；需要核对事件链。");
  }
  const openFailureSpans = failureSpans.filter((span) => span.recoveredAt === null);
  if (openFailureSpans.length > 0) {
    addFinding(
      "open_failure_span",
      "warning",
      `此账号/空间有 ${openFailureSpans.length} 类失败尚未观察到恢复；详见失败段记录。`,
    );
  }

  const growth = projectGrowthLoop(input, addFinding);

  const reportBase = {
    version: 1 as const,
    run: {
      id: input.run.id,
      conversationId: input.run.conversationId,
      status: input.run.status,
      generation: input.run.generation,
      createdAt: iso(input.run.createdAt) ?? new Date(0).toISOString(),
      startedAt: iso(input.run.startedAt),
      finishedAt: iso(input.run.finishedAt),
      assistantMessagePersisted: input.run.assistantMessageId !== null,
      failureCategory: failureCategory(input.run.status, input.run.errorCode),
      providerId: input.run.providerId,
      modelId: input.run.modelId,
      promptVersion: input.run.promptVersion,
      permissionLevel: input.run.permissionLevel,
    },
    executionBudget: {
      maxSteps: budget.maxSteps,
      stepsUsed: input.run.stepCount,
      maxToolCallsPerStep: budget.maxToolCallsPerStep,
      maxToolCalls: budget.maxToolCalls,
      toolCallsUsed: input.run.toolCallCount,
      deadlineMs: budget.deadlineMs,
      elapsedMs: input.run.agentElapsedMs,
    },
    queue: {
      jobId: job?.id ?? null,
      status: job ? companionRunJobStatusV1Schema.parse(job.status) : null,
      attempts: job?.attempts ?? null,
      hasLease: job ? job.hasLease : null,
      scheduledAt: iso(job?.scheduledAt) ?? null,
      startedAt: iso(job?.startedAt),
      finishedAt: iso(job?.finishedAt),
    },
    capabilities: {
      snapshotPresent: capability !== null,
      permissionLevel: capability?.level ?? input.run.permissionLevel,
      offeredTools: capability?.offeredTools ?? [],
    },
    ledger: {
      stepCounts,
      toolCounts,
      unknownToolOutcomeCount,
      pendingToolCount,
      retainedEventCount: input.retainedEvent.count,
      latestRetainedEventSeq: input.retainedEvent.latestSeq,
      latestRetainedEventAt: iso(input.retainedEvent.latestAt),
    },
    failureSpans,
    growth,
    findings,
  };
  const parsedBase = companionRunDoctorV1Schema.omit({ markdown: true }).parse(reportBase);
  return companionRunDoctorV1Schema.parse({
    ...parsedBase,
    markdown: buildMarkdown(parsedBase),
  });
}

/** The owner-scoped query is intentionally explicit even when RLS is active. */
export async function loadCompanionRunDoctorV1(
  tx: ApiTransaction,
  scope: CompanionRunDoctorScope,
  runId: string,
  now = new Date(),
): Promise<CompanionRunDoctorV1 | null> {
  const runRows = await tx.select({
    id: companionTurnRuns.id,
    conversationId: companionTurnRuns.conversationId,
    status: companionTurnRuns.status,
    generation: companionTurnRuns.generation,
    createdAt: companionTurnRuns.createdAt,
    startedAt: companionTurnRuns.startedAt,
    finishedAt: companionTurnRuns.finishedAt,
    assistantMessageId: companionTurnRuns.assistantMessageId,
    errorCode: companionTurnRuns.errorCode,
    providerId: companionTurnRuns.providerId,
    modelId: companionTurnRuns.modelId,
    promptVersion: companionTurnRuns.promptVersion,
    permissionLevel: companionTurnRuns.permissionLevel,
    permissionSnapshot: companionTurnRuns.permissionSnapshot,
    budgetSnapshot: companionTurnRuns.budgetSnapshot,
    stepCount: companionTurnRuns.stepCount,
    toolCallCount: companionTurnRuns.toolCallCount,
    agentElapsedMs: companionTurnRuns.agentElapsedMs,
    lastEventSeq: companionTurnRuns.lastEventSeq,
    jobId: companionTurnRuns.jobId,
    personaProfileRevision: companionTurnRuns.personaProfileRevision,
    contextAssemblyReceipt: companionTurnRuns.contextAssemblyReceipt,
  }).from(companionTurnRuns).where(and(
    eq(companionTurnRuns.id, runId),
    eq(companionTurnRuns.workspaceId, scope.workspaceId),
    eq(companionTurnRuns.userId, scope.userId),
  )).limit(1);
  const run = runRows[0] as CompanionRunDoctorRunRow | undefined;
  if (!run) return null;

  let job: Parameters<typeof projectCompanionRunDoctorV1>[0]["job"] = null;
  if (run.jobId) {
    const jobRows = await tx.select({
      id: jobs.id,
      status: jobs.status,
      attempts: jobs.attempts,
      hasLease: sql<boolean>`${jobs.leaseToken} IS NOT NULL`,
      scheduledAt: jobs.scheduledAt,
      startedAt: jobs.startedAt,
      finishedAt: jobs.finishedAt,
    }).from(jobs).where(and(
      eq(jobs.id, run.jobId),
      eq(jobs.workspaceId, scope.workspaceId),
      eq(jobs.requestedBy, scope.userId),
    )).limit(1);
    const selectedJob = jobRows[0];
    job = selectedJob
      ? { ...selectedJob, status: companionRunJobStatusV1Schema.parse(selectedJob.status) }
      : null;
  }

  const stepCounts = await tx.select({
    status: companionAgentSteps.status,
    count: sql<number>`count(*)::int`,
  }).from(companionAgentSteps).where(and(
    eq(companionAgentSteps.runId, runId),
    eq(companionAgentSteps.workspaceId, scope.workspaceId),
    eq(companionAgentSteps.userId, scope.userId),
  )).groupBy(companionAgentSteps.status);

  const toolCounts = await tx.select({
    status: companionAgentToolCalls.status,
    count: sql<number>`count(*)::int`,
  }).from(companionAgentToolCalls).where(and(
    eq(companionAgentToolCalls.runId, runId),
    eq(companionAgentToolCalls.workspaceId, scope.workspaceId),
    eq(companionAgentToolCalls.userId, scope.userId),
  )).groupBy(companionAgentToolCalls.status);

  const eventRows = await tx.select({
    count: sql<number>`count(*)::int`,
    latestSeq: sql<number | null>`max(${companionStreamEvents.seq})`,
    latestAt: sql<Date | null>`max(${companionStreamEvents.createdAt})`,
  }).from(companionStreamEvents).where(and(
    eq(companionStreamEvents.runId, runId),
    eq(companionStreamEvents.workspaceId, scope.workspaceId),
    eq(companionStreamEvents.userId, scope.userId),
    gt(companionStreamEvents.expiresAt, now),
  ));

  const failureRows = await tx.execute<{
    failure_class: string;
    span_started_at: Date | string;
    last_failure_at: Date | string;
    failure_count: number;
    first_run_id: string | null;
    last_run_id: string | null;
    recovered_at: Date | string | null;
    recovery_run_id: string | null;
  }>(sql`
    SELECT failure_class, span_started_at, last_failure_at, failure_count,
           first_run_id, last_run_id, recovered_at, recovery_run_id
    FROM public.companion_run_failure_spans
    WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
    ORDER BY last_failure_at DESC, failure_class
    LIMIT 7
  `);
  const failureSpans = failureRows.map((row) => ({
    failureClass: companionRunFailureClassV1Schema.parse(row.failure_class) as CompanionRunFailureClassV1,
    startedAt: iso(row.span_started_at) ?? new Date(0).toISOString(),
    lastFailureAt: iso(row.last_failure_at) ?? new Date(0).toISOString(),
    failureCount: Number.isSafeInteger(row.failure_count) && row.failure_count > 0 ? row.failure_count : 1,
    firstRunId: row.first_run_id,
    lastRunId: row.last_run_id,
    recoveredAt: iso(row.recovered_at),
    recoveryRunId: row.recovery_run_id,
  }));

  // 成长闭环那几格（§12.2）读的是已有权威行：最近一次回顾、它那个后台任务的状态、
  // 账号人格的当前/排队指针，以及这一轮有没有把「她自己提炼的做法」带上身。
  const [reflectionRow] = await tx.select({
    id: companionReflections.id,
    createdAt: companionReflections.createdAt,
    decision: companionReflections.decision,
    decisionSummary: companionReflections.decisionSummary,
    strategyVersion: companionReflections.strategyVersion,
    inputFromSeq: companionReflections.inputFromSeq,
    inputToSeq: companionReflections.inputToSeq,
    baselinePersonaRevision: companionReflections.baselinePersonaRevision,
    pendingPersonaRevision: companionReflections.pendingPersonaRevision,
    resultRef: companionReflections.resultRef,
    jobId: companionReflections.jobId,
  }).from(companionReflections).where(and(
    eq(companionReflections.conversationId, run.conversationId),
    eq(companionReflections.workspaceId, scope.workspaceId),
    eq(companionReflections.userId, scope.userId),
  )).orderBy(desc(companionReflections.createdAt)).limit(1);
  let reflectionJobStatus: string | null = null;
  if (reflectionRow?.jobId) {
    const [reflectionJobRow] = await tx.select({ status: jobs.status }).from(jobs)
      .where(and(eq(jobs.id, reflectionRow.jobId), eq(jobs.workspaceId, scope.workspaceId),
        eq(jobs.requestedBy, scope.userId))).limit(1);
    reflectionJobStatus = reflectionJobRow?.status ?? null;
  }
  const [personaRow] = await tx.select({
    revision: companionPersonaProfiles.revision,
    pendingRevision: companionPersonaProfiles.pendingRevision,
  }).from(companionPersonaProfiles)
    .where(eq(companionPersonaProfiles.userId, scope.userId)).limit(1);
  // 排队那一版的「出自谁」在版本行上（指针只是指针），单独读一次。
  let pendingAuthor: string | null = null;
  if (personaRow?.pendingRevision != null) {
    const [versionRow] = await tx.execute<{ author: string }>(sql`
      SELECT author FROM companion_persona_profile_versions
      WHERE user_id = ${scope.userId} AND revision = ${personaRow.pendingRevision}
      LIMIT 1
    `);
    pendingAuthor = versionRow?.author ?? null;
  }
  const [candidateRow] = await tx.select({
    count: sql<number>`count(*)::int`,
  }).from(companionProceduralPlaybooks).where(and(
    eq(companionProceduralPlaybooks.workspaceId, scope.workspaceId),
    eq(companionProceduralPlaybooks.userId, scope.userId),
    sql`${companionProceduralPlaybooks.methodState} = 'candidate'`,
  ));

  return projectCompanionRunDoctorV1({
    run,
    job,
    stepCounts,
    toolCounts,
    retainedEvent: {
      count: Number(eventRows[0]?.count ?? 0),
      // max(seq) 打的是 bigint 列：这条读边给字符串，合同要数。
      latestSeq: eventRows[0]?.latestSeq == null ? null : Number(eventRows[0].latestSeq),
      latestAt: eventRows[0]?.latestAt ?? null,
    },
    failureSpans,
    growth: {
      reflection: reflectionRow ?? null,
      reflectionJobStatus,
      persona: personaRow
        ? {
          currentRevision: Number(personaRow.revision ?? 0),
          pendingRevision: personaRow.pendingRevision ?? null,
          pendingAuthor,
          pinnedThisRun: run.personaProfileRevision,
        }
        : null,
      candidateCount: Number(candidateRow?.count ?? 0),
    },
  });
}
