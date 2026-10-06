import { and, eq, gt, sql } from "drizzle-orm";
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

  return projectCompanionRunDoctorV1({
    run,
    job,
    stepCounts,
    toolCounts,
    retainedEvent: {
      count: Number(eventRows[0]?.count ?? 0),
      latestSeq: eventRows[0]?.latestSeq ?? null,
      latestAt: eventRows[0]?.latestAt ?? null,
    },
    failureSpans,
  });
}
