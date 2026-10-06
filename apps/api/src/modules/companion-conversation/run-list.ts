import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import {
  companionRunListV1Schema,
  type CompanionRunListQueryV1,
  type CompanionRunListV1,
} from "@astella/shared";
import { companionTurnRuns } from "@astella/shared/db-schema";
import type { ApiTransaction } from "../../db/client.ts";
import type { CompanionRunDoctorScope } from "./run-doctor.ts";

type RunListRow = {
  id: string;
  conversationId: string;
  status: CompanionRunListV1["items"][number]["status"];
  generation: number;
  createdAt: Date;
  cursorCreatedAt: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  assistantMessageId: string | null;
  errorCode: string | null;
  providerId: string | null;
  modelId: string | null;
  promptVersion: string | null;
  stepCount: number;
  toolCallCount: number;
  agentElapsedMs: number;
};

function iso(value: Date | null | undefined): string | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;
}

function safeCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function failureCategory(
  status: string,
  errorCode: string | null,
): CompanionRunListV1["items"][number]["failureCategory"] {
  if (status !== "failed") return "none";
  if (errorCode === "ACTION_STALE") return "stale_context";
  if (errorCode === "INTERNAL_ERROR") return "internal";
  return "unknown";
}

export function projectCompanionRunListV1(
  rows: readonly RunListRow[],
  limit: number,
): CompanionRunListV1 {
  const pageRows = rows.slice(0, limit);
  const items = pageRows.map((run) => ({
    id: run.id,
    conversationId: run.conversationId,
    status: run.status,
    generation: run.generation,
    createdAt: iso(run.createdAt) ?? new Date(0).toISOString(),
    startedAt: iso(run.startedAt),
    finishedAt: iso(run.finishedAt),
    assistantMessagePersisted: run.assistantMessageId !== null,
    failureCategory: failureCategory(run.status, run.errorCode),
    providerId: run.providerId?.slice(0, 120) ?? null,
    modelId: run.modelId?.slice(0, 160) ?? null,
    promptVersion: run.promptVersion?.slice(0, 200) ?? null,
    stepCount: safeCount(run.stepCount),
    toolCallCount: safeCount(run.toolCallCount),
    agentElapsedMs: safeCount(run.agentElapsedMs),
  }));
  const last = rows.length > limit ? pageRows.at(-1) : undefined;
  return companionRunListV1Schema.parse({
    version: 1,
    items,
    nextCursor: last ? {
      beforeCreatedAt: last.cursorCreatedAt,
      beforeId: last.id,
    } : null,
  });
}

/** Lists only the caller's runs; conversationId is the optional task filter. */
export async function loadCompanionRunListV1(
  tx: ApiTransaction,
  scope: CompanionRunDoctorScope,
  query: CompanionRunListQueryV1,
): Promise<CompanionRunListV1> {
  const filters = [
    eq(companionTurnRuns.workspaceId, scope.workspaceId),
    eq(companionTurnRuns.userId, scope.userId),
  ];
  if (query.conversationId) filters.push(eq(companionTurnRuns.conversationId, query.conversationId));
  if (query.status) filters.push(eq(companionTurnRuns.status, query.status));
  if (query.beforeCreatedAt && query.beforeId) {
    filters.push(or(
      sql`${companionTurnRuns.createdAt} < ${query.beforeCreatedAt}::timestamptz`,
      and(
        sql`${companionTurnRuns.createdAt} = ${query.beforeCreatedAt}::timestamptz`,
        lt(companionTurnRuns.id, query.beforeId),
      ),
    )!);
  }
  const rows = await tx.select({
    id: companionTurnRuns.id,
    conversationId: companionTurnRuns.conversationId,
    status: companionTurnRuns.status,
    generation: companionTurnRuns.generation,
    createdAt: companionTurnRuns.createdAt,
    cursorCreatedAt: sql<string>`to_char(${companionTurnRuns.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    startedAt: companionTurnRuns.startedAt,
    finishedAt: companionTurnRuns.finishedAt,
    assistantMessageId: companionTurnRuns.assistantMessageId,
    errorCode: companionTurnRuns.errorCode,
    providerId: companionTurnRuns.providerId,
    modelId: companionTurnRuns.modelId,
    promptVersion: companionTurnRuns.promptVersion,
    stepCount: companionTurnRuns.stepCount,
    toolCallCount: companionTurnRuns.toolCallCount,
    agentElapsedMs: companionTurnRuns.agentElapsedMs,
  }).from(companionTurnRuns)
    .where(and(...filters))
    .orderBy(desc(companionTurnRuns.createdAt), desc(companionTurnRuns.id))
    .limit(query.limit + 1);
  return projectCompanionRunListV1(rows as RunListRow[], query.limit);
}
