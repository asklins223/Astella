/**
 * identity 的「空间成员关系」服务（P1-7：从门面变成实现）。
 *
 * ## 这一族是 12 个声明，不只是 6 个函数
 *
 * 函数 6：switchWorkspace / listUserWorkspaces / joinWorkspaceByInviteToken /
 *         transferWorkspaceOwnership / leaveWorkspace / updateUserProfile
 * 伴生 6：MAX_COLLABORATIVE_WORKSPACES / JoinWorkspaceErrorCode / JoinWorkspaceError /
 *         TransferOwnershipError / LeaveWorkspaceError / UpdateProfileError
 *
 * 前四轮都只搬了函数体，留下这六个伴生声明，于是本文件要从 service.ts **值引入**它们，
 * 而 service.ts 又从本文件 re-export 函数体——**值级别的环**，`import type` 消不掉。
 *
 * ## 声明在文件里是交错的
 *
 * 与 lifecycle 那一族（createCollaborativeWorkspace / renameWorkspace）互相夹着，
 * 按行号切一定会扫到别的族。这次按**声明名**逐个定位，12 段一起搬。
 *
 * ## 这里的 import 是照着**搬走的文本**逐符号核出来的
 *
 * 前三轮翻车的收尾全是"搬完之后收拾 service.ts 里那堆不再使用的 import"：
 * 自动剪枝删了还在被 `extends` 用的符号；`re.S` 多行正则跨文件匹配把别的文件的
 * import 也删了；剪枝的未使用名单来自上一轮文件状态，删完立刻报"找不到名字"。
 * 所以这一步**不做剪枝**——先把 12 段摘出来，在「搬走的文本」和「留下的文本」
 * 里各搜一遍每个符号，两张表对出来再分别写 import。
 *
 * ## 边界
 *
 * 本文件**不引用 service.ts 的值**。唯一的例外是 `import type { WorkspaceInfo }`
 * ——编译期被抹掉，不构成运行时环，而它的声明留在 service.ts。
 */

import { and, eq, gte, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { DomainError } from "@ailearn/shared";
import { adoptWorkspaceContext, db, withActorTransaction, withWorkspaceTransaction } from "../../db/client.ts";
import { inviteCodes, onboardingStates, users, workspaceMembers, workspaces } from "@ailearn/shared/db-schema/identity";
import { sessions } from "@ailearn/shared/db-schema/session";
import { deleteObject } from "../../lib/object-storage.ts";
import { logger } from "../../lib/logger.ts";
import { recordWorkspaceAudit } from "../audit/service.ts";
import { retireWorkspaceMemoriesOnDeparture } from "../companion-conversation/memory/memory-departure.ts";
import { hashToken, SessionContext } from "./credentials.ts";
import { issueSession } from "./session-service.ts";
import {
  hashInvitationToken as hashInvitationTokenLocal,
  isValidInvitationToken as isValidInvitationTokenLocal,
} from "./invitation-token.ts";
// 类型引入：编译期被抹掉，不构成运行时环
import type { WorkspaceInfo } from "./service.ts";
/**
 * ADR-0009: 切换工作区 — 重新签发绑定目标 workspace 的 session。
 * 验证用户是否仍是目标 workspace 的活跃成员（left_at IS NULL）。
 */
export async function switchWorkspace(
  userId: string,
  workspaceId: string,
  previousToken: string | null,
): Promise<{ token: string; ctx: SessionContext } | null> {
  // 目标空间在这条路的入口就是已知量（请求体带 workspaceId），所以直接进
  // workspace 事务：成员行要过租户守卫，会话行的撤销与签发要过 actor 策略。
  return withWorkspaceTransaction({ workspaceId, userId }, async (tx) => {
    const membership = await tx.query.workspaceMembers.findFirst({
      where: and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId),
        isNull(workspaceMembers.leftAt),
      ),
    });
    if (!membership) return null;
    // 2026-08-11（安全修复）：同一事务内"撤销旧 token + 签发新 token"——
    // 此前 routes 先签发后撤销，revoke 失败时被窃取的旧 token 继续有效。
    if (previousToken) {
      await tx.delete(sessions).where(eq(sessions.token, hashToken(previousToken)));
    }
    const session = await issueSession(userId, workspaceId, tx);
    return {
      token: session.token,
      ctx: {
        userId,
        workspaceId,
        membershipRole: membership.role ?? null,
        workspaceEpoch: session.ctx.workspaceEpoch,
      },
    };
  });
}

/**
 * ADR-0009: 列出用户可访问的所有活跃工作区（含个人工作区和协作工作区）。
 */
export async function listUserWorkspaces(userId: string): Promise<WorkspaceInfo[]> {
  // 与登录同一条理由：这条路要读的正是"我属于哪些空间"，而当前空间还没定。
  return withActorTransaction({ userId }, async (tx) => {
    const memberships = await tx.query.workspaceMembers.findMany({
      where: and(
        eq(workspaceMembers.userId, userId),
        isNull(workspaceMembers.leftAt),
      ),
    });
    if (memberships.length === 0) return [];

    const workspaceIds = memberships.map((m) => m.workspaceId);
    const workspaceRows = await tx.query.workspaces.findMany({
      where: inArray(workspaces.id, workspaceIds),
    });

    // PERF: 一次性建 Map 替代逐条 find() 的 O(m*n)。
    const workspaceById = new Map(workspaceRows.map((w) => [w.id, w]));
    return memberships.map((m) => {
      const ws = workspaceById.get(m.workspaceId);
      // 见 listUserWorkspaces 同名注释：类型属于空间，不属于查看者。
      const workspaceType = ws?.workspaceType ?? "personal";
      const isPersonal = workspaceType === "personal" && ws?.ownerId === userId;
      return {
        workspaceId: m.workspaceId,
        workspaceName: ws?.name ?? "未命名工作区",
        role: m.role,
        workspaceType,
        isPersonal,
        leftAt: m.leftAt,
      };
    });
  });
}

/** ADR-0009: 协作工作区加入上限 */
export const MAX_COLLABORATIVE_WORKSPACES = 3;

export type JoinWorkspaceErrorCode =
  | "not_found"
  | "expired"
  | "revoked"
  | "already_consumed"
  | "concurrent_consumption"
  | "workspace_limit_reached"
  | "already_member";

export class JoinWorkspaceError extends DomainError {
  readonly code: JoinWorkspaceErrorCode;
  constructor(code: JoinWorkspaceErrorCode) {
    super({ name: "JoinWorkspaceError", code, message: code, statusCode: 400 });
    this.code = code;
  }
}

/**
 * ADR-0009: 已登录用户通过邀请码加入协作工作区。
 * 不创建新用户，只创建 membership 记录。
 */
export async function joinWorkspaceByInviteToken(
  userId: string,
  token: string,
): Promise<{ workspaceId: string; workspaceName: string; role: string } | JoinWorkspaceError> {
  // 验证邀请码
  if (!isValidInvitationTokenLocal(token)) {
    return new JoinWorkspaceError("not_found");
  }
  const tokenHash = hashInvitationTokenLocal(token);

  let result: { workspaceId: string; workspaceName: string; role: string } | null;
  try {
    // 边界事务：进来时只知道"手里这串邀请码"，空间 id 要读出来才知道。
    // actor 是加入者本人；令牌哈希进 `app.session_token`，让邀请码那一行的
    // actor 读策略能命中（策略见迁移 0257）。
    result = await withActorTransaction(
      { userId, sessionToken: tokenHash },
      async (tx) => {
        const now = new Date();

        // Serialize all join operations for the same user so two different
        // invitation tokens cannot both pass the three-workspace limit.
        const userRows = await tx
          .select()
          .from(users)
          .where(eq(users.id, userId))
          .for("update");
        const userRow = userRows[0];
        if (!userRow) return null;

        const inviteRows = await tx
          .select()
          .from(inviteCodes)
          .where(
            and(
              eq(inviteCodes.tokenHash, tokenHash),
              isNull(inviteCodes.consumedBy),
              isNull(inviteCodes.revokedAt),
              or(isNull(inviteCodes.expiresAt), gte(inviteCodes.expiresAt, now)),
            ),
          )
          .for("update");

        const invite = inviteRows[0];
        if (!invite) {
          // 检查是否存在但已失效
          const existing = await tx
            .select({
              consumedBy: inviteCodes.consumedBy,
              revokedAt: inviteCodes.revokedAt,
              expiresAt: inviteCodes.expiresAt,
            })
            .from(inviteCodes)
            .where(eq(inviteCodes.tokenHash, tokenHash))
            .limit(1);
          if (existing.length === 0) return null;
          const row = existing[0];
          if (row.revokedAt) throw new JoinWorkspaceError("revoked");
          if (row.consumedBy) throw new JoinWorkspaceError("already_consumed");
          if (row.expiresAt && row.expiresAt < now) throw new JoinWorkspaceError("expired");
          return null;
        }

        // 检查目标 workspace 是否存在
        const ws = await tx.query.workspaces.findFirst({
          where: eq(workspaces.id, invite.workspaceId),
        });
        if (!ws) return null;

        // 空间 id 到这里才知道，随后的成员行 / 引导行 / 邀请码消费都要过租户守卫。
        await adoptWorkspaceContext(tx, invite.workspaceId);

        // ADR-0009: 允许邀请人加入个人工作区——对邀请者而言始终是「个人工作区」，
        // 对被邀请者而言则显示为「协作工作区」（基于 isPersonal 用户视角判断）。

        // 检查是否已是活跃成员
        const existingMembership = await tx.query.workspaceMembers.findFirst({
          where: and(
            eq(workspaceMembers.workspaceId, invite.workspaceId),
            eq(workspaceMembers.userId, userId),
            isNull(workspaceMembers.leftAt),
          ),
        });
        if (existingMembership) {
          throw new JoinWorkspaceError("already_member");
        }

        // ADR-0009 defines a collaborative membership from the current user's
        // perspective: active workspaces owned by somebody else. Excluding only
        // personalWorkspaceId would incorrectly count other user-owned spaces.
        const activeCollabMemberships = await tx
          .select({ workspaceId: workspaceMembers.workspaceId })
          .from(workspaceMembers)
          .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
          .where(
            and(
              eq(workspaceMembers.userId, userId),
              isNull(workspaceMembers.leftAt),
              ne(workspaces.ownerId, userId),
            ),
          );
        if (activeCollabMemberships.length >= MAX_COLLABORATIVE_WORKSPACES) {
          throw new JoinWorkspaceError("workspace_limit_reached");
        }

        // 检查是否有已退出的历史记录（可以重新加入）
        const leftMembership = await tx.query.workspaceMembers.findFirst({
          where: and(
            eq(workspaceMembers.workspaceId, invite.workspaceId),
            eq(workspaceMembers.userId, userId),
            // left_at IS NOT NULL — 已退出的记录
            sql`${workspaceMembers.leftAt} IS NOT NULL`,
          ),
        });

      if (leftMembership) {
        // 重新加入：清除 left_at，使用邀请码指定的角色
        await tx
          .update(workspaceMembers)
          .set({ leftAt: null, role: invite.role ?? "member", joinedAt: now })
          .where(
            and(
              eq(workspaceMembers.workspaceId, invite.workspaceId),
              eq(workspaceMembers.userId, userId),
            ),
          );
      } else {
        // 新加入
        await tx.insert(workspaceMembers).values({
          workspaceId: invite.workspaceId,
          userId,
          role: invite.role ?? "member",
        });
      }

      await tx
        .insert(onboardingStates)
        .values({
          workspaceId: invite.workspaceId,
          userId,
          version: "v1",
          steps: {},
          status: "pending",
        })
        .onConflictDoNothing();

      // 标记邀请码已消费
      await tx
        .update(inviteCodes)
        .set({ consumedBy: userId, consumedAt: now, consumeContext: "workspace_join" })
        .where(
          and(
            eq(inviteCodes.id, invite.id),
            isNull(inviteCodes.consumedBy),
          ),
        );

      return { workspaceId: invite.workspaceId, workspaceName: ws.name, role: invite.role ?? "member" };
      },
    );
  } catch (error) {
    if (error instanceof JoinWorkspaceError) return error;
    if (error && typeof error === "object" && "code" in error && error.code === "23505") {
      return new JoinWorkspaceError("already_member");
    }
    throw error;
  }

  if (!result) return new JoinWorkspaceError("not_found");
  return result;
}

export type TransferOwnershipError =
  | "not_found"
  | "not_owner"
  | "target_not_member"
  | "target_is_owner"
  | "personal_workspace_not_transferable";

/**
 * 把协作空间的所有权交给另一个**活跃成员**（审查附录 C 的"没有出口"）。
 *
 * 为什么必须有这条路：`leaveWorkspace` 对 owner 直接拒（`owner_cannot_leave`）——
 * 那道拦截是对的（否则空间变无主，`requireOwner` 的 OR 语义会让所有 member 同时
 * "非 owner"，整个空间锁死），但它把 owner 也关死了：既不能退，也不能交。
 * 有了转让，退出这条路才重新打开（先交、再退）。
 *
 * 三条不变量：
 *   - 只有**当前** owner 能发起（`isWorkspaceOwner`，与其余判据同源）；
 *   - 目标必须是这个空间的活跃成员（数据库触发器也拦一次，见迁移 0264）；
 *   - 个人空间不能转让（个人空间的所有权就是"这是我"这件事，ADR-0009）。
 *
 * 转让写审计（`workspace.ownership_transferred`）：这是"谁能拿走全空间数据"的变更，
 * 比一次导出更该留痕。
 */
export async function transferWorkspaceOwnership(
  actorUserId: string,
  workspaceId: string,
  targetUserId: string,
): Promise<
  | { ok: true; workspaceId: string; newOwnerUserId: string }
  | { ok: false; error: TransferOwnershipError }
> {
  return withActorTransaction({ userId: actorUserId }, async (tx) => {
    const workspace = await tx.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { id: true, ownerId: true, workspaceType: true },
    });
    if (!workspace) return { ok: false, error: "not_found" } as const;
    if (workspace.workspaceType === "personal") {
      return { ok: false, error: "personal_workspace_not_transferable" } as const;
    }

    // 当前 owner 判定要**同时**认 membership.role 与 workspaces.owner_id
    // （`isWorkspaceOwner` 的 OR 语义），否则 co-owner 会被自己建的判据挡在门外。
    const actorMembership = await tx.query.workspaceMembers.findFirst({
      where: and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, actorUserId),
        isNull(workspaceMembers.leftAt),
      ),
      columns: { role: true },
    });
    const actorIsOwner = workspace.ownerId === actorUserId || actorMembership?.role === "owner";
    if (!actorIsOwner) return { ok: false, error: "not_owner" } as const;
    if (workspace.ownerId === targetUserId) {
      return { ok: false, error: "target_is_owner" } as const;
    }

    const targetMembership = await tx.query.workspaceMembers.findFirst({
      where: and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, targetUserId),
        isNull(workspaceMembers.leftAt),
      ),
      columns: { role: true },
    });
    if (!targetMembership) return { ok: false, error: "target_not_member" } as const;

    await adoptWorkspaceContext(tx, workspaceId);

    // 先写 owner_id（触发器要求新 owner 已是活跃成员，这里已核实）。
    await tx
      .update(workspaces)
      .set({ ownerId: targetUserId })
      .where(eq(workspaces.id, workspaceId));
    // 成员角色跟着走：两个 co-owner 并列会让 `isWorkspaceOwner` 的 OR 语义出现
    // 两个人都能"全权"的状态，而"谁是 owner"必须只有一个答案。
    await tx
      .update(workspaceMembers)
      .set({ role: "member" })
      .where(and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, actorUserId),
      ));
    await tx
      .update(workspaceMembers)
      .set({ role: "owner" })
      .where(and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, targetUserId),
      ));

    await recordWorkspaceAudit(tx, {
      workspaceId,
      actorUserId,
      action: "workspace.ownership_transferred",
      targetKind: "user",
      targetId: targetUserId,
      detail: { previousOwnerUserId: actorUserId },
    });

    return { ok: true, workspaceId, newOwnerUserId: targetUserId } as const;
  });
}

export type LeaveWorkspaceError =
  | "not_found"
  | "not_member"
  | "owner_cannot_leave"
  | "personal_workspace_cannot_leave"
  | "personal_workspace_missing";

/**
 * ADR-0009: 用户主动退出协作工作区。
 * - 软退出（设置 left_at）
 * - 邀请码标记为 revoked（退出即失效）
 * - 撤销该用户在该 workspace 的所有 session
 * - 返回用户应该切换到的个人工作区 ID
 */
export async function leaveWorkspace(
  userId: string,
  workspaceId: string,
): Promise<{ ok: true; personalWorkspaceId: string } | { ok: false; error: LeaveWorkspaceError }> {
  const result = await withActorTransaction({ userId }, async (tx) => {
    const userRows = await tx
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .for("update");
    const userRow = userRows[0];
    if (!userRow) return { ok: false as const, error: "not_found" as LeaveWorkspaceError };
    if (!userRow.personalWorkspaceId) {
      return { ok: false as const, error: "personal_workspace_missing" as LeaveWorkspaceError };
    }
    if (userRow.personalWorkspaceId === workspaceId) {
      return { ok: false as const, error: "personal_workspace_cannot_leave" as LeaveWorkspaceError };
    }
    // 这一步要在"要退出的那个空间"的租户上下文里读不到：`workspaces` 的
    // actor 读策略认 `id = app.workspace_id`。所以先把上下文摆到**个人空间**上
    // （它的 id 就是 userRow.personalWorkspaceId），确认它还在、还是这个人的，
    // 再把上下文切到要退出的空间做后面三张表的写入。
    await adoptWorkspaceContext(tx, userRow.personalWorkspaceId);
    const personalRows = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(
        and(
          eq(workspaces.id, userRow.personalWorkspaceId),
          eq(workspaces.ownerId, userId),
        ),
      )
      .limit(1);
    if (!personalRows[0]) {
      return { ok: false as const, error: "personal_workspace_missing" as LeaveWorkspaceError };
    }

    // 退出动作全部发生在"要退出的那个空间"里：成员行、该空间内的会话、
    // 该空间里被这个用户消费掉的邀请码——三张表的租户守卫都要它。
    await adoptWorkspaceContext(tx, workspaceId);

    const membership = await tx
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, userId),
        ),
      )
      .for("update");

    const m = membership[0];
    if (!m) return { ok: false as const, error: "not_member" as LeaveWorkspaceError };
    if (m.leftAt) return { ok: false as const, error: "not_member" as LeaveWorkspaceError };
    if (m.role === "owner") {
      return { ok: false as const, error: "owner_cannot_leave" as LeaveWorkspaceError };
    }

    // 软退出
    await tx
      .update(workspaceMembers)
      .set({ leftAt: new Date() })
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, userId),
        ),
      );

    // 撤销该用户在该 workspace 的所有 session
    await tx
      .delete(sessions)
      .where(
        and(
          eq(sessions.userId, userId),
          eq(sessions.workspaceId, workspaceId),
        ),
      );

    // 将该用户消费的邀请码标记为 revoked（退出即失效）
    await tx
      .update(inviteCodes)
      .set({ revokedAt: new Date(), revokedBy: userId })
      .where(
        and(
          eq(inviteCodes.workspaceId, workspaceId),
          eq(inviteCodes.consumedBy, userId),
          isNull(inviteCodes.revokedAt),
        ),
      );

    // 离开时收掉**这个空间那一侧的记忆**（doc 34 L38）：`scope='workspace'` 的行软删除，
    // 跟人绑定的 `scope='global'` 不动。与被退同一事务——回滚了却留下一堆"被收掉的记忆"
    // 是假证据。走数据库函数是因为策略要求 app.user_id 等于行的 user_id，
    // 而 owner 移人时上下文里的 actor 不是当事人。
    await retireWorkspaceMemoriesOnDeparture(tx, { workspaceId, userId });

    return { ok: true as const, personalWorkspaceId: userRow.personalWorkspaceId };
  });

  return result;
}

export type UpdateProfileError = "not_found";

/**
 * PROFILE-01: 更新当前用户的展示名和头像 URL。
 * 传 undefined 表示不修改对应字段；传 null 或空串表示清除。
 * 当头像从站内上传路径变更为新值时，异步清理旧头像文件。
 */
export async function updateUserProfile(
  userId: string,
  fields: { displayName?: string | null; avatarUrl?: string | null },
): Promise<{ ok: true; displayName: string | null; avatarUrl: string | null } | { ok: false; error: UpdateProfileError }> {
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (fields.displayName !== undefined) {
    const trimmed = fields.displayName?.trim() ?? null;
    updates.displayName = trimmed && trimmed.length > 0 ? trimmed.slice(0, 32) : null;
  }

  let oldAvatarUrl: string | null = null;
  if (fields.avatarUrl !== undefined) {
    // Query old avatarUrl before updating so we can clean it up
    const existingUser = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { avatarUrl: true },
    });
    oldAvatarUrl = existingUser?.avatarUrl ?? null;

    const trimmed = fields.avatarUrl?.trim() ?? null;
    updates.avatarUrl = trimmed && trimmed.length > 0 ? trimmed.slice(0, 500) : null;
  }

  const [updated] = await db
    .update(users)
    .set(updates)
    .where(eq(users.id, userId))
    .returning({ displayName: users.displayName, avatarUrl: users.avatarUrl });
  if (!updated) return { ok: false, error: "not_found" };

  // Clean up old avatar from object storage if it was a site-uploaded avatar
  // and the new avatar URL is different.
  // SEC 修复（2026-09 后端审查）：必须确认旧对象键属于当前用户名下
  // （avatars/{userId}/...）。此前只校验 "/api/uploads/avatars/" 前缀，而
  // avatarUrlSchema 允许任意该前缀的路径——用户可把 avatarUrl 指向他人头像，
  // 再修改/清空头像即删除他人存储对象。
  if (
    oldAvatarUrl &&
    oldAvatarUrl.startsWith(`/api/uploads/avatars/${userId}/`) &&
    oldAvatarUrl !== updates.avatarUrl
  ) {
    const oldObjectKey = oldAvatarUrl.replace("/api/uploads/", "");
    void deleteObject(oldObjectKey).catch((err) => {
      logger.warn({ err, oldObjectKey }, "failed to delete old avatar");
    });
  }

  return {
    ok: true,
    displayName: updated.displayName,
    avatarUrl: updated.avatarUrl,
  };
}
