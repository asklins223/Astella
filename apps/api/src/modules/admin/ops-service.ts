/**
 * 运维面板的跨租户只读视图（队列 / 失败 / 审计 / 计数）。
 *
 * ## 数据从哪来
 *
 * 全部经 0365 迁移创建的 `SECURITY DEFINER` 函数（见迁移头部注释里「为什么是
 * SECURITY DEFINER」一节）。本文件**不做**任何跨租户裸查询——在
 * `withWorkspaceTransaction` 下那恒为 0 行，且与「队列是空的」无法区分。
 *
 * ## 脱敏边界
 *
 * 这一层是**唯一**能把 `safe_error` 变回可展示文本的地方。数据库返回的是 worker
 * 写入的 `operational_error:<category>:<name>[:<code>]` 定长投影，但那终究是
 * **格式约定**（shared/safe-error.ts）而不是数据库约束。所以这里用同一套正则
 * 再解析一次：
 *   - 匹配 → 只保留 `category` / `name` / `code` 三个受控片段；
 *   - 不匹配 → 一律显示 `unknown`，**原始字符串不离开这个函数**。
 * 这样约定哪天被绕过（有人直接 UPDATE jobs.last_error 写了自由文本），
 * 后果是面板少显示一个分类，而不是把自由文本经浏览器扩散开。
 */

import { sql } from "drizzle-orm";
import { db } from "../../db/client.ts";
import { logger } from "../../lib/logger.ts";
import { JOB_TYPE_LABELS } from "./labels.ts";

/**
 * 与 `packages/shared/src/safe-error.ts` 的 `SAFE_ERROR_MESSAGE_PATTERN` 同形。
 *
 * 刻意**不复用**那边的常量：那个正则没有导出，而把它导出就得把整个
 * safe-error 模块拉进面板的依赖面。这里保持同形并在两处各自写清理由——
 * 改一边时另一边的测试会红（admin 侧有用例锁住它）。
 */
const SAFE_ERROR_PATTERN =
  /^operational_error:(aborted|timeout|database|provider|authentication|billing|configuration|validation|not_found|unknown):([A-Za-z][A-Za-z0-9_.-]{0,63})(?::([A-Za-z0-9_.-]{1,40}))?$/;

export interface SafeFailureProjection {
  category: string | null;
  name: string | null;
  code: string | null;
  /** 给面板直接显示的一行摘要。永远由受控片段拼成。 */
  summary: string;
}

/** 把 `jobs.last_error` 投影成受控摘要。匹配不上就是 unknown，不透传原文。 */
export function projectSafeError(raw: string | null | undefined): SafeFailureProjection {
  if (typeof raw !== "string" || raw.length === 0) {
    return { category: null, name: null, code: null, summary: "无错误信息" };
  }
  const match = SAFE_ERROR_PATTERN.exec(raw);
  if (!match) {
    return { category: "unknown", name: null, code: null, summary: "unknown" };
  }
  const [, category, name, code] = match;
  return {
    category: category ?? null,
    name: name ?? null,
    code: code ?? null,
    summary: [category, name, code].filter(Boolean).join(" · "),
  };
}

export interface QueueBacklogRow {
  jobType: string;
  /**
   * 人话名。**在 service 里就译好**，而不是在路由层补：
   * 待办清单（todo-service）与队列页都要它，路由层补一次就意味着
   * 少一个消费者时要记得在两处各译一遍——而那种漏译不会让任何测试变红。
   */
  label: string;
  /** 这个类型有没有收录人话名（没有则 label 是原样标识）。 */
  known: boolean;
  pending: number;
  running: number;
  failedRecent: number;
  deadTotal: number;
  oldestPendingSeconds: number;
}

export interface QueueSummary {
  byType: QueueBacklogRow[];
  totals: {
    pending: number;
    running: number;
    failedRecent: number;
    deadTotal: number;
    oldestPendingSeconds: number;
  };
}

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 按作业类型的跨租户队列积压。 */
export async function readQueueBacklog(): Promise<QueueSummary> {
  const rows = (await db.execute(sql`
    SELECT * FROM public.ailearn_admin_job_backlog()
  `)) as unknown as Array<Record<string, unknown>>;

  const byType: QueueBacklogRow[] = rows.map((row) => ({
    jobType: String(row.job_type ?? ""),
    label: JOB_TYPE_LABELS[String(row.job_type ?? "")] ?? String(row.job_type ?? ""),
    known: JOB_TYPE_LABELS[String(row.job_type ?? "")] !== undefined,
    pending: toNumber(row.pending),
    running: toNumber(row.running),
    failedRecent: toNumber(row.failed_recent),
    deadTotal: toNumber(row.dead_total),
    oldestPendingSeconds: toNumber(row.oldest_pending_seconds),
  }));

  const sum = (pick: (row: QueueBacklogRow) => number) => byType.reduce((acc, row) => acc + pick(row), 0);
  return {
    // 有积压的排前面：面板一打开就该看到"哪里堵了"，而不是按字母序找。
    byType: byType.sort((a, b) => {
      const weight = (r: QueueBacklogRow) => r.pending + r.running * 2 + r.failedRecent * 3 + r.deadTotal;
      return weight(b) - weight(a) || a.jobType.localeCompare(b.jobType);
    }),
    totals: {
      pending: sum((r) => r.pending),
      running: sum((r) => r.running),
      failedRecent: sum((r) => r.failedRecent),
      deadTotal: sum((r) => r.deadTotal),
      oldestPendingSeconds: Math.max(0, ...byType.map((r) => r.oldestPendingSeconds)),
    },
  };
}

export interface RecentFailure {
  id: string;
  jobType: string;
  workspaceId: string;
  status: string;
  attempts: number;
  failure: SafeFailureProjection;
  scheduledAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export async function readRecentFailures(limit = 50): Promise<RecentFailure[]> {
  const rows = (await db.execute(sql`
    SELECT * FROM public.ailearn_admin_recent_job_failures(${limit})
  `)) as unknown as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: String(row.id ?? ""),
    jobType: String(row.job_type ?? ""),
    workspaceId: String(row.workspace_id ?? ""),
    status: String(row.status ?? ""),
    attempts: toNumber(row.attempts),
    failure: projectSafeError(row.safe_error as string | null),
    scheduledAt: row.scheduled_at ? new Date(row.scheduled_at as string).toISOString() : null,
    startedAt: row.started_at ? new Date(row.started_at as string).toISOString() : null,
    finishedAt: row.finished_at ? new Date(row.finished_at as string).toISOString() : null,
  }));
}

export interface RecentAudit {
  id: string;
  workspaceId: string;
  actorUserId: string;
  action: string;
  targetKind: string;
  targetId: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

export async function readRecentAudit(limit = 50): Promise<RecentAudit[]> {
  const rows = (await db.execute(sql`
    SELECT * FROM public.ailearn_admin_recent_audit(${limit})
  `)) as unknown as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: String(row.id ?? ""),
    workspaceId: String(row.workspace_id ?? ""),
    actorUserId: String(row.actor_user_id ?? ""),
    action: String(row.action ?? ""),
    targetKind: String(row.target_kind ?? ""),
    targetId: row.target_id ? String(row.target_id) : null,
    // detail 按审计模块的既有约定只放计数与字节数（modules/audit/service.ts 约束 3）。
    // 仍做一次形状收窄：面板不该因为某天有人往 detail 里塞了自由文本就整段渲染出来。
    detail: sanitizeDetail(row.detail),
    createdAt: new Date(row.created_at as string).toISOString(),
  }));
}

/** detail 的值只保留标量与短字符串；对象/数组压成形状摘要。 */
function sanitizeDetail(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    } else if (typeof value === "string") {
      out[key] = value.length > 120 ? `${value.slice(0, 120)}…` : value;
    } else if (Array.isArray(value)) {
      out[key] = { type: "array", length: value.length };
    } else if (value && typeof value === "object") {
      out[key] = { type: "object" };
    }
  }
  return out;
}

export interface PlatformCounts {
  usersTotal: number;
  workspacesTotal: number;
  notesActive: number;
  jobsTotal: number;
  runsTotal: number;
  sessionsActive: number;
}

export async function readPlatformCounts(): Promise<PlatformCounts> {
  const rows = (await db.execute(sql`
    SELECT * FROM public.ailearn_admin_platform_counts()
  `)) as unknown as Array<Record<string, unknown>>;
  const row = rows[0] ?? {};
  return {
    usersTotal: toNumber(row.users_total),
    workspacesTotal: toNumber(row.workspaces_total),
    notesActive: toNumber(row.notes_active),
    jobsTotal: toNumber(row.jobs_total),
    runsTotal: toNumber(row.runs_total),
    sessionsActive: toNumber(row.sessions_active),
  };
}
/* ─── 写操作（0366）─────────────────────────────────────────────────────── */

/**
 * 可执行的运维动作。
 *
 * **只允许这两种**，而且都按作业类型执行、都不碰 pending/running ——
 * 边界钉在数据库函数里（见 0366 迁移头部），这里再收一层参数校验。
 * 两层不是重复：服务层校验是为了在**返回给调用方之前**给出可读错误，
 * 而不是让 SQL 异常冒到错误处理器里。
 */
export type AdminJobAction = "retry" | "purge";

/** 与 0366 里那条正则**保持一致**；改一处必须同步另一处。 */
const JOB_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export interface AdminJobActionResult {
  action: AdminJobAction;
  jobType: string;
  affected: number;
}

export async function runJobAction(input: {
  action: AdminJobAction;
  jobType: string;
  limit?: number;
}): Promise<AdminJobActionResult> {
  const jobType = (input.jobType ?? "").trim();
  if (!JOB_TYPE_PATTERN.test(jobType)) {
    throw new AdminActionError("invalid_job_type", "作业类型不合法");
  }
  if (input.action !== "retry" && input.action !== "purge") {
    throw new AdminActionError("invalid_action", "不支持的操作");
  }

  // 上界在 SQL 里也夹一次，这里只是让非法值在往返之前就被拒。
  const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? (input.action === "retry" ? 100 : 500))));

  const fn = input.action === "retry"
    ? sql`SELECT public.ailearn_admin_retry_failed_jobs(${jobType}, ${limit}) AS n`
    : sql`SELECT public.ailearn_admin_purge_dead_jobs(${jobType}, ${limit}) AS n`;
  const rows = (await db.execute(fn)) as unknown as Array<Record<string, unknown>>;

  const affected = Number(rows[0]?.n ?? 0);

  // 删除是不可逆的，必须留下一条服务日志（pino → stdout → 容器运行时收集）。
  // 跨租户的运维操作不进 workspace_audit_log（那张表按空间分区，而这里没有空间概念），
  // 所以这条日志就是事后唯一的记录——不能省。
  logger.info(
    { scope: "admin-panel", action: input.action, jobType, affected },
    `运维面板执行了 ${input.action === "retry" ? "重试" : "清理"}`,
  );

  return { action: input.action, jobType, affected };
}

export class AdminActionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AdminActionError";
    this.code = code;
  }
}
