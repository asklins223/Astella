/**
 * Card Generation V2 — **复用判定的读侧**（2026-09-29 拆出，P2-2）。
 *
 * ## 为什么拆
 *
 * `activation-service.ts` 此前 2523 行，把"读权威计划、判定能不能复用"与
 * "写卡、写版本、写事件、写生命周期"挤在一个文件里。而前者是**纯函数**：
 * 不碰库、不碰事务、不看时钟。
 *
 * 纯的部分混在有副作用的部分里，代价是它**看起来**像需要事务、需要锁、
 * 需要小心顺序——于是改动它的人不敢动，而真正要改（那段 §4.2 判据的
 * 边界很容易被误改）的地方就一直没人改。
 *
 * ## 这里装什么
 *
 * 三个纯读函数：
 *
 * · `bindingEntryEvidenceSnapshotIds` — 从一条 binding 条目取 evidence snapshot id
 * · `pickCurrentBindingPlanV2` — 同一条修订**多份** binding plan 行里取"当前带着"的那份
 * · `resolveReuseFromPlanV2` — 从权威计划读出"这条候选落到哪颗既有目标"
 *
 * 三个都不 import 任何东西——这不是巧合，是搬走之前量过的：
 * 它们确实一个外部标识符都不用。**若将来要给它们加依赖，先回头看本文
 * 说的"纯"还成不成立**，而不是直接加 import。
 *
 * ## 行为一个字都没改
 *
 * 这次是**搬移**，不是改写：三段原文照搬（含注释）。判据、返回值、边界行为
 * 全部不变。调用点也仍然在 `activation-service.ts` 里，从这里 import。
 */


/**
 * §14.3：从 binding plan 行的单条 target_unit_bindings 条目提取被绑定 evidence
 * snapshot id。条目为完整 binding 形状（单数 `evidenceSnapshotId`，与
 * candidateEvidenceBindingPlanV2Schema.bindings 一致）。
 */
export function bindingEntryEvidenceSnapshotIds(entry: Record<string, unknown>): string[] {
  if (typeof entry?.evidenceSnapshotId === "string" && entry.evidenceSnapshotId) {
    return [entry.evidenceSnapshotId];
  }
  return [];
}

export function pickCurrentBindingPlanV2<T extends { bindingPlanHash: string }>(
  rows: readonly T[],
  namedHash: string | null | undefined,
): T | undefined {
  const named = namedHash ? rows.find((r) => r.bindingPlanHash === namedHash) : undefined;
  return named ?? rows[rows.length - 1];
}

/**
 * W7-5 刀四：从**权威计划**里读出"这条候选要落到哪颗既有目标上"。
 *
 * 候选 → `plan_objective_local_id` → 计划 `result.objectives` 里那一条 → 它的
 * `changeContext`。判据本身在 `@astella/shared/objective-reuse-rules-v2`（纯函数），
 * 装配那一步已经跑过；这里**只读结果，不重跑**——重跑一遍就会有两个地方能给出不同的
 * 结论，而其中一份没有 `planHash` 背书。
 *
 * **读不到计划 / 读不到那条目标 / `changeContext` 不是复用那档** ⇒ 返回 null，
 * 也就是照原样建一颗新目标。§4.2「无法确定时保留差异」在读侧是同一句话：
 * 拿不到权威判断时，**新建**是可发现的那一侧。
 */
export function resolveReuseFromPlanV2(
  planResult: unknown,
  planObjectiveLocalId: string | null,
): { objectiveId: string } | null {
  if (!planResult || typeof planResult !== "object") return null;
  if (!planObjectiveLocalId) return null;
  const result = (planResult as { kind?: string; objectives?: unknown[] });
  if (result.kind !== "author_candidates" || !Array.isArray(result.objectives)) return null;
  const objective = result.objectives.find((item) => (
    typeof item === "object" && item !== null
    && (item as { objectiveLocalId?: string }).objectiveLocalId === planObjectiveLocalId
  )) as { changeContext?: { kind?: string; objectiveId?: string } } | undefined;
  const changeContext = objective?.changeContext;
  if (!changeContext || changeContext.kind !== "reuse_existing_objective") return null;
  if (typeof changeContext.objectiveId !== "string") return null;
  // **不带 epoch 令牌**。第一版这里交了一个 `0` 占位，而复用那一支拿它与那一行的真值
  // 比——真值从 1 起，于是**每一次复用都抛 `stale_objective_lifecycle`**。那不是"并发保护
  // 太严"，是**这条路径结构上永远走不通**（C49 的真库读数把它抓了出来：第一次跑到复用
  // 分支就撞上这一句）。
  //
  // 为什么**不需要**那个令牌：复用是**服务端**照权威计划做的判断（这里读的是带
  // `planHash` 的那一份），而 epoch CAS 防的是「**客户端**拿着一份过期的读数来改」——这里
  // 没有客户端参与，事务内又重新读了那一行（`lifecycle='active'` 那一道闸还在）。
  return { objectiveId: changeContext.objectiveId };
}
