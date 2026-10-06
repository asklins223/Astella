/**
 * 学习运行的**作用域与读取底座**（2026-09-30 拆出，P2-2）。
 *
 * `RunScope` / `loadRun` / `originObjectiveId` 不属于任何一方——
 * `run-action.ts` 与 `run-service.ts` 都要用。让其中一方 import 另一方就成了**环**；
 * 给共同的底座一个自己的模块，环就不成立。
 *
 * 这与 AGENTS.md 那条「切不动是形状没名字」是同一条纪律。
 */
import type { ApiTransaction } from "../../db/client.ts";
import { runNotFound } from "./run-errors.ts";
import { learningRuns } from "@astella/shared/db-schema/learning-runs";
import { and, eq } from "drizzle-orm";

export interface RunScope {
  workspaceId: string;
  userId: string;
}


export async function loadRun(tx: ApiTransaction, scope: RunScope, runId: string, forUpdate = false) {
  const query = tx
    .select()
    .from(learningRuns)
    .where(and(
      eq(learningRuns.id, runId),
      eq(learningRuns.workspaceId, scope.workspaceId),
      eq(learningRuns.userId, scope.userId),
    ))
    .limit(1);
  // §13.2.1：写路径用 Run row lock（FOR UPDATE）保证 revision/epoch CAS 原子。
  const rows = forUpdate ? await query.for("update").execute() : await query;
  const row = rows[0];
  if (!row) throw runNotFound();
  return row;
}



/** 从严格 V2 run.origin 取目标 ID。 */
export function originObjectiveId(origin: unknown): string {
  if (origin && typeof origin === "object") {
    const objectiveId = (origin as { objectiveId?: unknown }).objectiveId;
    if (typeof objectiveId === "string") return objectiveId;
  }
  return "";
}

