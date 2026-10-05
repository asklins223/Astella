import { sql } from "drizzle-orm";
import type { WorkerTransaction } from "../db.ts";

type Executor = WorkerTransaction;

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const maybe = result as { rows?: T[] } | null;
  return Array.isArray(maybe?.rows) ? maybe.rows : [];
}

export interface PlaybookScope {
  workspaceId: string;
  userId: string;
}

/**
 * 记忆的**后台语义整理**（40 §4.6.3 / §4.6.9，验收 A74）。
 *
 * ## 为什么触发条件是最容易做错的一处
 *
 * 合同 §4.6.3 原话：「每日维护窗口检查**自上次成功整理以来的累计待处理量**。
 * 初始阈值 30 条、距上次成功至少 7 天；首轮按最早待处理记录计时。
 * 积累不足但最旧待处理达到 30 天时，可做有界的小批整理。
 * **阈值按样本调优，不用『当天新增 30 条』让低频用户永远不触发。**」
 *
 * 最后那句是被点名过的失败形状：拿"当天新增"当分母，低频用户（一个月说三句话）
 * 永远攒不到 30 条，于是后台整理**一次都不跑**，而他们的记忆恰恰最需要被整理。
 * 正确的分母是**自上次成功整理以来的累计积压**，与"今天说了几句"无关。
 *
 * 所以这个判据写成**纯函数**：它没有任何 IO，只吃三个数就能答"该不该跑"。
 * 把 IO 和判据混在一起时，这条规则最难测也最容易被无声改掉。
 *
 * ## 三种情况
 *
 * | 情形 | 判定 | 依据 |
 * | --- | --- | --- |
 * | 从没成功整理过 | 按**最早待处理**计时；够 30 天就跑一批 | §4.6.3「首轮按最早待处理记录计时」 |
 * | 有上次成功时间 | 积压 ≥30 **且** 距上次成功 ≥7 天 | 「初始阈值 30 条、距上次成功至少 7 天」 |
 * | 积压不足 | 但最旧待处理已满 30 天 → 做**有界的小批** | §4.6.3 第三句 |
 *
 * 任何一种情形下积压为 0 都不跑——没有待处理的东西就不该产生模型调用。
 */

/** 初始阈值与间隔。合同说「按样本调优」，所以它们是具名常量而不是散落的字面量。 */
export const MEMORY_ORGANIZATION_MIN_BACKLOG = 30;
export const MEMORY_ORGANIZATION_MIN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
export const MEMORY_ORGANIZATION_OLDEST_PENDING_MS = 30 * 24 * 60 * 60 * 1000;

export interface MemoryOrganizationGateInput {
  /** 自上次成功整理以来累计的待处理条数（**不是**当天新增）。 */
  backlogCount: number;
  /** 最早一条待处理记忆的时间；没有待处理时为 null。 */
  oldestPendingAt: Date | null;
  /** 上一次**成功**整理的时间；从未成功过为 null。 */
  lastSuccessAt: Date | null;
  now: Date;
}

export type MemoryOrganizationGateDecision =
  | { run: false; reason: "nothing_pending" }
  | { run: false; reason: "not_enough_time" | "backlog_below_threshold" }
  | { run: true; reason: "first_run_backlog"; bounded: false }
  | { run: true; reason: "backlog_and_interval"; bounded: false }
  | { run: true; reason: "oldest_pending_expired"; bounded: true };

export function memoryOrganizationGate(
  input: MemoryOrganizationGateInput,
): MemoryOrganizationGateDecision {
  const { backlogCount, oldestPendingAt, lastSuccessAt, now } = input;

  // 没有待处理就没有模型调用——这一条必须排在最前面，
  // 否则「间隔到了但没东西可整理」也会空跑一轮。
  if (backlogCount <= 0) return { run: false, reason: "nothing_pending" };

  const oldestAgeMs = oldestPendingAt ? now.getTime() - oldestPendingAt.getTime() : 0;

  // 首轮：没有成功整理过 ⇒ 按最早待处理计时，不设"距上次成功"这一条
  //（它没有上次可距）。
  if (lastSuccessAt === null) {
    if (backlogCount >= MEMORY_ORGANIZATION_MIN_BACKLOG) {
      return { run: true, reason: "first_run_backlog", bounded: false };
    }
    if (oldestAgeMs >= MEMORY_ORGANIZATION_OLDEST_PENDING_MS) {
      return { run: true, reason: "oldest_pending_expired", bounded: true };
    }
    return { run: false, reason: "backlog_below_threshold" };
  }

  // 距上次成功不足 7 天：这一轮跳过。**低频用户尤其要靠后面那条兜底**——
  // 否则 7 天窗口会把他们永远挡在门外。
  const sinceSuccessMs = now.getTime() - lastSuccessAt.getTime();
  if (backlogCount >= MEMORY_ORGANIZATION_MIN_BACKLOG
    && sinceSuccessMs >= MEMORY_ORGANIZATION_MIN_INTERVAL_MS) {
    return { run: true, reason: "backlog_and_interval", bounded: false };
  }

  // 积累不足，但最旧待处理已经躺了 30 天 ⇒ 有界小批。
  if (oldestAgeMs >= MEMORY_ORGANIZATION_OLDEST_PENDING_MS) {
    return { run: true, reason: "oldest_pending_expired", bounded: true };
  }
  return {
    run: false,
    reason: sinceSuccessMs < MEMORY_ORGANIZATION_MIN_INTERVAL_MS ? "not_enough_time" : "backlog_below_threshold",
  };
}

/**
 * 「有界小批」的批大小（§4.6.3 说「可做**有界**的小批整理」）。
 *
 * 取 10：足够让一次整理产生可观察的效果，又不至于让后台任务跑很久
 * 或吃掉整轮预算。**它必须小于** {@link MEMORY_ORGANIZATION_MIN_BACKLOG}——
 * 「有界」的意义就在于它不是"那 30 条全做一遍"。
 */
export const MEMORY_ORGANIZATION_BOUNDED_BATCH = 10;

/** 这一轮要处理的条数上限。 */
export function memoryOrganizationBatchSize(decision: MemoryOrganizationGateDecision): number {
  return decision.run && decision.bounded ? MEMORY_ORGANIZATION_BOUNDED_BATCH : MEMORY_ORGANIZATION_MIN_BACKLOG;
}

/**
 * 五种语义动作的**判据**（§4.6.3 那张表）。
 *
 * 这些判据是纯函数、可单测，因为它们决定「动哪条记忆」——动错了就是
 * 悄悄丢用户的数据，比不整理严重得多。所以下面每一条都写死了它**不**做什么。
 */
export type MemoryOrganizationAction = "merge" | "downgrade" | "distill" | "upgrade" | "remove";

export interface MemoryOrganizationCandidate {
  memoryId: string;
  kind: string;
  /** 同一事实的另一条（合并的另一端）；没有则为 null。 */
  sameFactTwinId: string | null;
  /** 同组里是否**存在矛盾**内容；有矛盾时合同要求并存 + 标争议，不合并。 */
  sameFactTwinContradicts: boolean;
  importance: number;
  pinned: boolean;
  appliesWhen: string | null;
  validFrom: Date | null;
  validUntil: Date | null;
  /**
   * 支持这条记忆的**独立事件**数。
   * 同一事件反复摘要**只算一份**——所以判据看这个数，不看条数也不看跨日数。
   */
  independentEvidenceCount: number;
}

export function memoryOrganizationActionFor(
  candidate: MemoryOrganizationCandidate,
  now: Date,
): MemoryOrganizationAction | null {
  // 固定（pinned）表达重要性：§4.6.6「『固定』表达重要性，不能绕过有效期、
  // 事实检查、权限或预算」——反过来也成立，后台整理不该自动动它。
  if (candidate.pinned) return null;

  // 移除：已过**声明期限**。这是机械过期，按已声明的期限处理。
  if (candidate.validUntil !== null && candidate.validUntil.getTime() <= now.getTime()) {
    return "remove";
  }

  // 合并：同一事实且**无矛盾**，保留所有来源。
  // 有矛盾时合同原话是「冲突不强行合并」——由 persist 层并存 + 标争议，
  // 而不是在这里挑一个赢。
  if (candidate.sameFactTwinId !== null && !candidate.sameFactTwinContradicts) {
    return "merge";
  }

  // 蒸馏：独立事件支持稳定模式。
  if (candidate.independentEvidenceCount >= 3) return "distill";

  // 升级：证据支持**未来持续使用**。条数和跨日只作提示，
  // 所以要求它带条件（appliesWhen）且有多份独立证据——
  // 一次反馈不该升级，条件本身就是「什么时候还成立」的答案。
  if (candidate.appliesWhen !== null
    && candidate.validUntil === null
    && candidate.independentEvidenceCount >= 2) {
    return "upgrade";
  }

  // 降级：条件性记忆只有**一份**证据 ⇒ 不该继续待在综合层，移入情景/短期层。
  // 显式**不**拿「最近没被提到」当理由：§4.6.3「不因未再次提到就断言失效」。
  if (candidate.appliesWhen !== null && candidate.independentEvidenceCount <= 1) {
    return "downgrade";
  }

  return null;
}

/** 这一轮的处置结论（§4.6.9「整理结果至多返回一段 surface 结论」）。 */
export interface MemoryOrganizationSurfaceV1 {
  /** 短结论；没有值得返回的内容时为 null（§4.5.10「没有值得返回的内容可以为空」）。 */
  surface: string | null;
  movedIds: string[];
  removedIds: string[];
  mergedIntoId: string | null;
}

export function emptySurface(): MemoryOrganizationSurfaceV1 {
  return { surface: null, movedIds: [], removedIds: [], mergedIntoId: null };
}

/**
 * 提交租约（40 §4.6.9「同一 `(workspace_id, user_id)` 的后台整理串行，
 * 最多一项整理任务持有提交租约」）。
 *
 * 为什么**不**先查再插：worker 有多个副本，「先查后插」之间有一个窗口，
 * 两个副本同时查到「没人持有」就会各插一条。真正挡住那个窗口的是
 * `companion_memory_organization_leases` 的**主键**——所以这里直接插，
 * 撞约束就算被别人持有。
 *
 * 租约带 `expiresAt`：崩溃的副本不会执行任何清理，没有到期时间的话
 * 这个用户**再也不会**被整理。
 */
export async function acquireMemoryOrganizationLease(
  tx: Executor,
  scope: PlaybookScope,
  holder: string,
  ttlMs = 10 * 60 * 1000,
  now: Date = new Date(),
): Promise<boolean> {
  await tx.execute(sql`
    INSERT INTO companion_memory_organization_state (workspace_id, user_id, updated_at)
    VALUES (${scope.workspaceId}, ${scope.userId}, ${now.toISOString()})
    ON CONFLICT (workspace_id, user_id) DO NOTHING
  `);
  try {
    await tx.execute(sql`
      INSERT INTO companion_memory_organization_leases
        (workspace_id, user_id, holder, acquired_at, expires_at)
      VALUES (${scope.workspaceId}, ${scope.userId}, ${holder}, ${now.toISOString()},
              ${new Date(now.getTime() + ttlMs).toISOString()})
      ON CONFLICT (workspace_id, user_id) DO NOTHING
    `);
  } catch {
    // 唯一约束冲突 = 有人在整理。这不是错误，是这一轮的正确答案。
    return false;
  }
  const held = await tx.execute<{ held: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM companion_memory_organization_leases
       WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
         AND holder = ${holder} AND expires_at > ${now.toISOString()}
    ) AS held
  `);
  return rowsOf<{ held: boolean }>(await held)[0]?.held === true;
}

/**
 * 提交一轮整理。
 *
 * 返回 false 表示**没能提交**——租约不在手里，或状态已被别人推进。
 * 两种情况下调用方都不得把建议当成已落地（§4.6.9「冲突不覆盖用户新修改」）。
 */
export async function commitMemoryOrganization(
  tx: Executor,
  scope: PlaybookScope,
  holder: string,
  surface: string | null,
  backlog: number,
): Promise<boolean> {
  const rows = await tx.execute<{ committed: boolean }>(sql`
    SELECT public.ailearn_commit_memory_organization(
      ${scope.workspaceId}::uuid, ${scope.userId}::uuid, ${holder},
      ${surface}, ${backlog}
    ) AS committed
  `);
  return rowsOf<{ committed: boolean }>(rows)[0]?.committed === true;
}

/**
 * 本轮返回的 surface 结论（§4.6.9「至多返回一段」/ §4.5.10「没有值得返回的可以为空」）。
 *
 * 刻意**没有**"每次都必须说一句"：空是完全正常的结果，编一句出来才是负债。
 */
export function memoryOrganizationSurface(
  movedIds: readonly string[],
  removedIds: readonly string[],
): string | null {
  const parts: string[] = [];
  if (movedIds.length > 0) parts.push(`整理了 ${movedIds.length} 条记忆`);
  if (removedIds.length > 0) parts.push(`清掉 ${removedIds.length} 条过期的`);
  // 超过一句就截断：下一轮注入时它只是"她刚整理过"的一个提示，
  // 写长了会挤掉真正要注入的上下文。
  return parts.length === 0 ? null : parts.join("，").slice(0, 240);
}
