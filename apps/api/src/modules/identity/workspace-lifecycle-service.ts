/**
 * identity 的「空间生命周期」服务（P1-7：从门面变成实现）——**P1-7 的最后一族**。
 *
 * ## 这一族是 11 个声明
 *
 * 函数 7：generateDefaultWorkspaceName / registerWithoutInvite /
 *         resetRecoveredUserPassword / createCollaborativeWorkspace /
 *         renameWorkspace / previewWorkspaceDissolve / dissolveWorkspace
 * 伴生 2：CreateWorkspaceError / RenameWorkspaceError（两个错误码类型）
 * 私有 2：MAX_WORKSPACE_NAME_LENGTH / generateDefaultDisplayName
 *
 * ## 为什么要连**私有**的也一起搬
 *
 * 模块私有作用域对外面等于没有名字——留在 service.ts 的话，本文件得从它取值，
 * 而 service.ts 又从本文件 re-export，那又是**值级别的环**。私有不等于可以留在原地。
 *
 * ## 边界
 *
 * 本文件**不引用 service.ts 的值**。`WorkspaceInfo` 的声明仍在那边（它是
 * `loginWithPassword` 的返回类型），这里只用 `import type` 引它——编译期抹掉，不成环。
 */

import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { adoptWorkspaceContext, db, withActorTransaction, withWorkspaceTransaction } from "../../db/client.ts";
import { onboardingStates, users, workspaceMembers, workspaces } from "@ailearn/shared/db-schema/identity";
import { sessions } from "@ailearn/shared/db-schema/session";
import { RECOVERED_PASSWORD_SENTINEL, canonicalizeEmail, hashPassword, SessionContext } from "./credentials.ts";
import { issueSession } from "./session-service.ts";
import { MAX_COLLABORATIVE_WORKSPACES } from "./workspace-membership-service.ts";
const MAX_WORKSPACE_NAME_LENGTH = 50;

/**
 * PROFILE-01: 生成默认个人工作区名称。
 * 优先使用 displayName，过长则截断；回退到 email 本地部分。
 */
export function generateDefaultWorkspaceName(displayName: string | null | undefined, email: string): string {
  const base = (displayName?.trim() || email.split("@")[0] || "用户").slice(0, MAX_WORKSPACE_NAME_LENGTH - 4);
  return `${base}的工作区`;
}

function generateDefaultDisplayName(displayName: string | null | undefined, email: string): string {
  return (displayName?.trim() || email.split("@")[0] || "用户").slice(0, 32);
}

/**
 * ADR-0009: 无邀请码注册 — 只创建个人工作区，不加入任何协作空间。
 */
export async function registerWithoutInvite(
  email: string,
  password: string,
  options?: { displayName?: string; avatarUrl?: string },
): Promise<{ token: string; ctx: SessionContext } | null> {
  const normalizedEmail = canonicalizeEmail(email);
  // R5（round-3 审计）：bcryptjs 为纯 JS 主线程 CPU 密集（cost 10 ≈ 50-150ms）。
  // 在开事务前计算哈希，避免持有 10 连接池之一的同时在主线程哈希。
  // 不换库（依赖约束），保留纯 JS bcryptjs；未来可迁移 native bcrypt/worker。
  // 副作用：重复注册（已在期用户）路径会多做一次哈希，但该路径罕见且开销可忽略。
  const passwordHash = await hashPassword(password);
  // 新账号的 id 在插入前就取定：`withActorTransaction` 的 actor 必须在事务开始时
  // 确定，而注册这条路要写 `users` / `workspaces` / `workspace_members` /
  // `onboarding_states` / `sessions` 五张表——其中四张的策略按 `app.user_id` 判。
  // 让数据库自己 gen_random_uuid() 再回头设 actor，就会在嵌套校验上撞车
  // （同一条请求里两个身份），所以这里显式生成一次，只生成这一个值。
  const newUserId = randomUUID();
  let result: { session: { token: string; ctx: SessionContext } } | null;
  try {
    result = await withActorTransaction({ userId: newUserId }, async (tx) => {
      const existing = await tx.query.users.findFirst({ where: eq(users.email, normalizedEmail) });
      if (existing) return null;

      const [user] = await tx
        .insert(users)
        .values({
          id: newUserId,
          email: normalizedEmail,
          passwordHash,
          displayName: generateDefaultDisplayName(options?.displayName, normalizedEmail),
          ...(options?.avatarUrl?.trim() ? { avatarUrl: options.avatarUrl.trim() } : {}),
        })
        .returning();

      // 创建个人工作区，名称优先使用昵称
      const [personalWs] = await tx
        .insert(workspaces)
        .values({
          ownerId: user.id,
          name: generateDefaultWorkspaceName(options?.displayName, user.email),
          workspaceType: "personal",
        })
        .returning({ id: workspaces.id });

      // 注册是"边界事务"：新空间的 id 到这里才知道，而随后的成员行与引导行
      // 都要过租户守卫。actor 已经是新用户（见上面 newUserId 的说明），这里
      // 只需补上 `app.workspace_id`。
      await adoptWorkspaceContext(tx, personalWs.id);

      await tx
        .update(users)
        .set({ personalWorkspaceId: personalWs.id })
        .where(eq(users.id, user.id));

      await tx.insert(workspaceMembers).values({
        workspaceId: personalWs.id,
        userId: user.id,
        role: "owner",
      });

      await tx.insert(onboardingStates).values({
        workspaceId: personalWs.id,
        userId: user.id,
        version: "v1",
        steps: {},
        status: "pending",
      });

      return { userId: user.id, workspaceId: personalWs.id, session: await issueSession(user.id, personalWs.id, tx) };
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "23505") {
      return null;
    }
    throw error;
  }
  if (!result) return null;
  return result.session;
}

/**
 * Set the first real password for a user restored from a workspace export.
 * Existing accounts cannot be changed through this path, and every old
 * session for the restored identity is revoked before the transaction commits.
 */
export async function resetRecoveredUserPassword(
  workspaceId: string,
  userId: string,
  password: string,
): Promise<boolean> {
  const passwordHash = await hashPassword(password);
  // 恢复账号的密码重置：操作者是空间 owner，被改的是另一个人的账号，所以
  // actor 用**目标账号**（会话删除要按它的 user_id 过策略），租户用当前空间
  // （成员行与空间守卫都要它）。
  return withActorTransaction({ userId, workspaceId }, async (tx) => {
    const membership = await tx.query.workspaceMembers.findFirst({
      where: and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId),
      ),
    });
    if (!membership) return false;

    const updated = await tx
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(and(
        eq(users.id, userId),
        eq(users.passwordHash, RECOVERED_PASSWORD_SENTINEL),
      ))
      .returning({ id: users.id });
    if (updated.length === 0) return false;

    await tx.delete(sessions).where(eq(sessions.userId, userId));
    return true;
  });
}

export type CreateWorkspaceError = "invalid_name" | "workspace_limit_reached";

/**
 * 新建一个协作工作区。
 *
 * 为什么需要它：生产代码里此前**没有任何创建工作区的入口**——`workspaces` 只在注册
 * 时建 `personal` 行，而 `workspaceType` 是按"查看者是不是 owner"派生出来的。于是
 * 协作空间事实上无法存在，唯一的共享方式是把别人拉进**自己的个人空间**，ADR-0009 的
 * 个人/协作二分因此只剩一半是真的。
 *
 * 配额沿用加入邀请码那套 `MAX_COLLABORATIVE_WORKSPACES`：自己建的协作空间同样占一个
 * 活跃协作名额，不另开第二条政策。
 */
export async function createCollaborativeWorkspace(
  userId: string,
  name: string,
): Promise<
  | { ok: true; workspaceId: string; workspaceName: string }
  | { ok: false; error: CreateWorkspaceError }
> {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_WORKSPACE_NAME_LENGTH) {
    return { ok: false, error: "invalid_name" };
  }

  // 边界事务：进来的第一件事是按 user_id 查自己已有的协作空间（那时还没有当前
  // 空间），建出新的之后才把租户切过去——所以 actor 上下文，不是 workspace 上下文。
  return withActorTransaction({ userId }, async (tx) => {
    // 与 joinWorkspaceByInviteToken 同一把 users 行锁：两个并发请求不能各自越过配额。
    const userRows = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .for("update");
    if (userRows.length === 0) return { ok: false, error: "invalid_name" } as const;

    const activeCollaborative = await tx
      .select({ workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(
        and(
          eq(workspaceMembers.userId, userId),
          isNull(workspaceMembers.leftAt),
          eq(workspaces.workspaceType, "collaborative"),
        ),
      );
    if (activeCollaborative.length >= MAX_COLLABORATIVE_WORKSPACES) {
      return { ok: false, error: "workspace_limit_reached" } as const;
    }

    const [created] = await tx
      .insert(workspaces)
      .values({ ownerId: userId, name: trimmed, workspaceType: "collaborative" })
      .returning({ id: workspaces.id, name: workspaces.name });

    // 新空间的成员行与引导行都要过租户守卫，而它的 id 到这一步才知道。
    await adoptWorkspaceContext(tx, created.id);

    await tx.insert(workspaceMembers).values({
      workspaceId: created.id,
      userId,
      role: "owner",
    });
    await tx.insert(onboardingStates).values({
      workspaceId: created.id,
      userId,
      version: "v1",
      steps: {},
      status: "pending",
    });

    return { ok: true, workspaceId: created.id, workspaceName: created.name };
  });
}

export type RenameWorkspaceError =
  | "not_found"
  | "not_member"
  | "not_owner"
  | "not_personal_workspace"
  | "empty_name";

/**
 * PROFILE-01: 重命名工作区。
 * 仅允许重命名当前用户拥有的个人工作区（personalWorkspaceId === workspaceId）。
 */
export async function renameWorkspace(
  userId: string,
  workspaceId: string,
  newName: string,
): Promise<{ ok: true; workspaceId: string; name: string } | { ok: false; error: RenameWorkspaceError }> {
  const trimmedName = newName.trim();
  if (!trimmedName) return { ok: false, error: "empty_name" };
  if (trimmedName.length > MAX_WORKSPACE_NAME_LENGTH) return { ok: false, error: "empty_name" };

  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) return { ok: false, error: "not_found" };

  // 个人空间：仍然只允许重命名自己那一个（原有规则）。
  //
  // 协作空间（审计 F39）：**它的 owner 也能改名**。此前这条把协作空间一律拒掉，
  // 而界面上唯一的替代出口是不可逆的解散——"名字随手起错了"没有轻的出路是操作
  // 逻辑问题，改名本身没有任何破坏性。判据与 `transferWorkspaceOwnership` 同一句：
  // `workspaces.owner_id` 或 membership.role=owner（co-owner 也是 owner）。
  if (user.personalWorkspaceId !== workspaceId) {
    const [workspace, membership] = await Promise.all([
      db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId), columns: { ownerId: true, workspaceType: true } }),
      db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, userId),
          isNull(workspaceMembers.leftAt),
        ),
        columns: { role: true },
      }),
    ]);
    if (!workspace) return { ok: false, error: "not_found" };
    if (!membership && workspace.ownerId !== userId) return { ok: false, error: "not_member" };
    const actorIsOwner = workspace.ownerId === userId || membership?.role === "owner";
    if (!actorIsOwner) return { ok: false, error: "not_owner" };
    if (workspace.workspaceType !== "collaborative") return { ok: false, error: "not_personal_workspace" };
  }

  // 读写都在同一个 workspace 事务里：`workspaces` 的租户守卫按
  // `id = app.workspace_id` 判，裸 db 查询在 RLS 下会读到 0 行。
  return withWorkspaceTransaction({ workspaceId, userId }, async (tx) => {
    const ws = await tx.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    if (!ws) return { ok: false, error: "not_found" };

    await tx.update(workspaces).set({ name: trimmedName }).where(eq(workspaces.id, workspaceId));
    return { ok: true, workspaceId, name: trimmedName };
  });
}

/**
 * 解散一个协作空间（doc 34 L6 的 ②；实现体是迁移 0276 里那支函数）。
 *
 * 为什么把整件事放进一支 `SECURITY DEFINER` 函数而不是在 TS 里循环删：
 * 库里有 102 张表带 `workspace_id`、只有 13 张真有指向 `workspaces` 的外键，
 * 逐表清理必须在**同一个事务**里完成并且由 catalog 决定清单——留在 TS 侧就是一段
 * 会随迁移增长而悄悄漏表的清单（漏一张就是一批没人认领的孤儿行）。
 * TS 这一层只做三件事：拿会话身份、把函数抛的错误名翻成人能懂的错误码、把逐表计数带回去。
 */
/**
 * 解散**之前**的先睹计数（审计 F39 ③）。
 *
 * 解散的确认文案自己写着"这个空间会连同其中的笔记、卡片与排程一起消失"，但界面上
 * 一个数都没有——用户要点开一颗盲盒。真删了多少行由迁移 0276 那个函数逐表带回来，
 * 那一刻已经太晚，所以这里在确认之前先读一次。
 *
 * 两道门卫的分工要写清楚：**能不能删仍然只由 SQL 函数判**（`actor_is_not_active_owner`
 * 等三条），这份预览只是"给已经在界面上看得到解散按钮的人一个数"。因此这里的判据
 * 取与改名/转让同一句（`owner_id` 或 membership.role=owner，且必须是协作空间）；
 * 它不会比真动作更宽松——放宽一点也不会删掉任何东西，收紧则会撒"没有"的谎。
 */
export async function previewWorkspaceDissolve(
  workspaceId: string,
  actorUserId: string,
): Promise<
  | { ok: true; counts: { notes: number; sources: number; cards: number; schedules: number } }
  | { ok: false; error: "workspace_not_found" | "actor_is_not_active_owner" | "cannot_dissolve_personal_workspace" }
> {
  const [workspace, membership] = await Promise.all([
    db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { ownerId: true, workspaceType: true },
    }),
    db.query.workspaceMembers.findFirst({
      where: and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, actorUserId),
        isNull(workspaceMembers.leftAt),
      ),
      columns: { role: true },
    }),
  ]);
  if (!workspace) return { ok: false, error: "workspace_not_found" };
  if (workspace.workspaceType !== "collaborative") {
    return { ok: false, error: "cannot_dissolve_personal_workspace" };
  }
  if (workspace.ownerId !== actorUserId && membership?.role !== "owner") {
    return { ok: false, error: "actor_is_not_active_owner" };
  }

  // 四张表一起数：`notes`/`sources` 连外键都靠 workspace_id 判，RLS 下必须带上下文，
  // 否则受限角色读到 0 行——那会让确认文案说"这里什么都没有"。
  const [row] = await withWorkspaceTransaction({ workspaceId, userId: actorUserId }, async (tx) =>
    tx.execute(sql`
      SELECT
        (SELECT count(*) FROM notes WHERE workspace_id = ${workspaceId}::uuid)::int AS notes,
        (SELECT count(*) FROM sources WHERE workspace_id = ${workspaceId}::uuid)::int AS sources,
        (SELECT count(*) FROM learning_cards_v2 WHERE workspace_id = ${workspaceId}::uuid)::int AS cards,
        (SELECT count(*) FROM review_schedules WHERE workspace_id = ${workspaceId}::uuid)::int AS schedules
    `),
  );
  const counts = (Array.isArray(row) ? row[0] : row) as {
    notes: number; sources: number; cards: number; schedules: number;
  };
  return { ok: true, counts };
}

export async function dissolveWorkspace(
  workspaceId: string,
  actorUserId: string,
): Promise<{ ok: true; counts: Record<string, number> } | { ok: false; error: string }> {
  try {
    const rows = await withActorTransaction({ userId: actorUserId }, (tx) =>
      tx.execute(sql`
        SELECT public.ailearn_dissolve_workspace(${workspaceId}::uuid, ${actorUserId}::uuid)
          AS counts
      `));
    const counts = (rows[0] as { counts: Record<string, number> } | undefined)?.counts ?? {};
    return { ok: true, counts };
  } catch (err) {
    // drizzle 会把驱动错误包成 `Failed query: …`，真正的 `RAISE EXCEPTION` 文本在
    // `err.cause` 上——只读 message 的话三种门卫全会掉进 500（我第一次跑就是这样）。
    const chain: string[] = [];
    let cursor: unknown = err;
    for (let depth = 0; depth < 5 && cursor; depth += 1) {
      const item = cursor as { message?: unknown; cause?: unknown };
      if (typeof item.message === "string") chain.push(item.message);
      cursor = item.cause;
    }
    const message = chain.join(" | ");
    const code = [
      "workspace_not_found",
      "cannot_dissolve_personal_workspace",
      "actor_is_not_active_owner",
      "actor_has_no_surviving_workspace_for_audit",
    ].find((name) => message.includes(name));
    return { ok: false, error: code ?? "dissolve_failed" };
  }
}
