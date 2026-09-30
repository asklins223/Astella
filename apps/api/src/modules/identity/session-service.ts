/**
 * identity 的「会话」服务（P1-7：从门面变成实现）。
 *
 * ## 搬法：按**名字**定位，不按行号切
 *
 * 这五个函数在 `service.ts` 里**不连续**——`loginWithPassword` 与 `decodeToken`
 * 之间夹着 `generateDefaultWorkspaceName` / `registerWithoutInvite` 等生命周期
 * 那一族。第一版按行号切，把中间那两族一起搬了过来；靠"位置看起来是连续的"
 * 这种假设做拆分必然出错。
 *
 * 上一轮先把**凭证原语**抽进 `credentials.ts`（密码哈希、令牌生成、会话过期常量、
 * `SessionContext`）也是为此——那是本族与另外三族共享的地基。
 *
 * `changePassword` / `revokeAllSessionsForUser` 仍住在 `service.ts`（位置上散在
 * 文件另一头，且与那边正在用的 `verifyPassword` / `hashPassword` 交织）。
 * 它们在本文件末尾转出，所以调用方认这一个文件就够了。
 *
 * ## 搬走之后 service.ts 的 import 是**逐个符号**核过的
 *
 * 上一轮试过用脚本按"未使用"自动剪枝，结果把还在被 `extends DomainError`
 * 和类型标注使用的符号也删了，类型层级直接断掉（症状出现在远处的测试里）。
 * 那一轮整轮回滚了。这一次的做法是：先算出「搬走之后剩余正文」，
 * 再拿它**逐个问**每个符号还用不用——不是启发式，是看真实使用。
 */

import bcrypt from "bcryptjs";
import {
  DUMMY_PASSWORD_HASH,
  SESSION_TTL_MS,
  canonicalizeEmail,
  generateToken,
  hashPassword,
  hashToken,
  nextSessionExpiry,
  verifyPassword,
  type SessionContext,
} from "./credentials.ts";
// **类型**引入：编译期被抹掉，所以不构成运行时环
// （service.ts 从本文件 re-export 值，本文件只在类型位置引它）。
import type { WorkspaceInfo } from "./service.ts";
import { eq, and, inArray, isNull, lt, sql } from "drizzle-orm";
import { users, workspaceMembers, workspaces } from "@ailearn/shared/db-schema/identity";
import { sessions } from "@ailearn/shared/db-schema/session";
import {
  assumeActor,
  db,
  withActorTransaction,
  SYSTEM_USER_ID,
  type ApiTransaction,
} from "../../db/client.ts";

/** 系统级的会话维护单飞：并发的定时触发只让一个进去。 */
let sessionCleanupRunning = false;
const SESSION_CLEANUP_BATCH = 1000;

/**
 * 决定一次会话使用是否应当延长过期时间。纯函数，便于离线测试。
 *
 * 返回 null 表示无需写库：要么剩余寿命还充裕，要么已经顶到绝对上限。
 */
/**
 * 签发一个会话行。
 *
 * `executor` 是**可选的**：调用方若已经在 actor 事务里（登录、切空间、注册），
 * 传进来就能复用同一事务——`sessions` 的写策略要求 `user_id = app.user_id`，
 * 没有 actor 上下文的裸 `db` 写会被 RLS 挡掉（静默 0 行，不是报错）。
 */
export async function issueSession(
  userId: string,
  workspaceId: string,
  executor?: ApiTransaction,
): Promise<{ token: string; ctx: SessionContext }> {
  const token = generateToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  const values = { token: hashToken(token), userId, workspaceId, createdAt: now, expiresAt };
  // R-011: 存储 token 的哈希值，而非明文
  if (executor) {
    await executor.insert(sessions).values(values);
  } else {
    await withActorTransaction({ userId, workspaceId, sessionToken: hashToken(token) }, (tx) =>
      tx.insert(sessions).values(values),
    );
  }
  // 边界令牌必须**当场**读出来：签发的这一刻就是客户端认识的第一个值，
  // 写死 1 会让"服务端抬过 epoch 的空间"在下次请求时立刻被判过期。
  const [workspace] = await (executor ?? db)
    .select({ workspaceEpoch: workspaces.workspaceEpoch })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return { token, ctx: { userId, workspaceId, workspaceEpoch: workspace?.workspaceEpoch ?? 1 } };
}

export async function loginWithPassword(
  email: string,
  password: string,
): Promise<{ token: string; ctx: SessionContext; workspaces: WorkspaceInfo[] } | null> {
  const normalizedEmail = canonicalizeEmail(email);
  // R4（round-3 审计）：不再用 lower(email) = ...（无表达式索引 → 每次登录 Seq Scan）。
  // canonicalizeEmail 已在注册/邀请路径将 email 小写存储，直接 eq(users.email, ...)
  // 命中 users_email_idx 唯一索引。
  //
  // 2026-09-29（P0-4）：这一句从裸查表改成走 SECURITY DEFINER 函数
  // `ailearn_find_user_by_email`（迁移 0327）。原因是 `users` 补上了 RLS，而
  // **登录发生在会话建立之前**——没有事务，就没有 `app.user_id` /
  // `app.workspace_id`，任何要求上下文的策略都会返回 0 行，那就是所有人都登不进来。
  // 函数是"刻意的、有名字的、窄口径的"跨用户读路径，与 jobs 表那套
  // `ailearn_claim_job` 是同一个既有模式；它只读一行、只读这一列集，不提供写能力。
  type LoginUserRow = {
    id: string;
    email: string;
    password_hash: string;
    role: string;
    created_at: Date;
    updated_at: Date;
    personal_workspace_id: string | null;
    display_name: string | null;
    avatar_url: string | null;
  };
  const rows = await db.execute<LoginUserRow>(sql`
    SELECT * FROM public.ailearn_find_user_by_email(${normalizedEmail})
  `);
  const row = (rows as unknown as LoginUserRow[])[0];
  // 函数返回的是库的列名（snake_case），这里映回 drizzle 的 camelCase 形状，
  // 下面所有读 user.xxx 的代码不用改。
  const user = row
    ? {
        id: row.id,
        email: row.email,
        passwordHash: row.password_hash,
        role: row.role,
        personalWorkspaceId: row.personal_workspace_id,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
      }
    : null;
  if (!user) {
    await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
    return null;
  }
  if (!(await verifyPassword(password, user.passwordHash))) return null;
  // 空间建立之前的 actor 事务：这条路的**第一件事**就是把"这个人属于哪些空间"
  // 读出来，而 RLS 的租户守卫要的正是"当前空间"。所以用 actor 上下文
  // （`app.user_id`）而不是 workspace 上下文——`workspace_members` /
  // `workspaces` 上的 actor 读策略就是为这一条路装的（迁移 0257）。
  return withActorTransaction({ userId: user.id }, async (tx) => {
    // ADR-0009: 查询所有活跃工作区（left_at IS NULL），排除已退出的
    const memberships = await tx.query.workspaceMembers.findMany({
      where: and(
        eq(workspaceMembers.userId, user.id),
        isNull(workspaceMembers.leftAt),
      ),
    });
    if (memberships.length === 0) return null;

    // 获取所有工作区名称
    const workspaceIds = memberships.map((m) => m.workspaceId);
    const workspaceRows = await tx.query.workspaces.findMany({
      where: inArray(workspaces.id, workspaceIds),
    });
  // PERF: 一次性建 Map，避免 memberships.map 内逐条 find() 的 O(m*n)。
    const workspaceById = new Map(workspaceRows.map((w) => [w.id, w]));
    const workspacesList: WorkspaceInfo[] = memberships.map((m) => {
      const ws = workspaceById.get(m.workspaceId);
      // `workspaceType` 是空间自身的属性，不是"谁在看"的函数。此前它由
      // ownerId === 查看者派生，于是任何人的个人空间被别人加入后都会自称
      // collaborative，而真正的协作空间反而没有创建入口。
      const workspaceType = ws?.workspaceType ?? "personal";
      // ADR-0009 §3.6: 个人归属仍按 ownerId 判定（而非 personalWorkspaceId），
      // 但只有这一行本身是 personal 类型时才算"我的个人空间"。
      const isPersonal = workspaceType === "personal" && ws?.ownerId === user.id;
      return {
        workspaceId: m.workspaceId,
        workspaceName: ws?.name ?? "未命名工作区",
        role: m.role,
        workspaceType,
        isPersonal,
        leftAt: m.leftAt,
      };
    });

    // BUG-67 修复：验证 personalWorkspaceId 是否仍在活跃成员列表中。
    // 如果用户被移出或主动退出了个人工作区（leftAt 非空），
    // personalWorkspaceId 仍指向已退出的工作区，签发的 session 将无效。
    // 改为优先从活跃成员列表中查找 personalWorkspaceId，找不到则回退到第一个。
    const activeWorkspaceIds = new Set(memberships.map((m) => m.workspaceId));
    const defaultWorkspaceId =
      (user.personalWorkspaceId && activeWorkspaceIds.has(user.personalWorkspaceId))
        ? user.personalWorkspaceId
        : memberships[0].workspaceId;
    const session = await issueSession(user.id, defaultWorkspaceId, tx);
    return { ...session, workspaces: workspacesList };
  });
}

/**
 * 把凭据解成一个会话上下文。挂在 18 处 preHandler 上，是全站最热的一条查询。
 *
 * ─── 为什么从"一条 JOIN"改成"两段"（SEC-01 重开 RLS）───
 * 旧写法是一条 `sessions LEFT JOIN workspace_members LEFT JOIN workspaces`。
 * RLS 重开之后它不再成立：`workspace_members` 与 `workspaces` 的策略都要
 * `app.workspace_id`，而**这个值正是要从这一行读出来的**——用未知量做谓词是循环。
 *
 * 所以按"已知量"分两段，并且都在同一个 actor 事务里：
 *   1. 用令牌哈希读 `sessions`（策略 `sec01_v1_sessions_actor_read` 认
 *      `token = app.session_token`），拿到 user_id / workspace_id；
 *   2. 用这两个值查 `workspace_members` 与 `workspaces`——它们是**同一行里的
 *      事实**，不是调用方传进来的参数，所以按它们取行不会放宽隔离。
 *
 * 代价是每个已认证请求多一次往返（两次都是主键/唯一索引命中）。换来的是一条
 * 真正的边界：任何"按 token 查会话"的语句都只能拿到自己手里那一个令牌的行。
 */
export async function decodeToken(token: string): Promise<SessionContext | null> {
  // R-011: 查询时使用 token 哈希
  const tokenHash = hashToken(token);

  return withActorTransaction({ userId: SYSTEM_USER_ID, sessionToken: tokenHash }, async (tx) => {
    const session = await tx.query.sessions.findFirst({
      where: eq(sessions.token, tokenHash),
      columns: { userId: true, workspaceId: true, createdAt: true, expiresAt: true },
    });
    if (!session) return null;
    if (session.expiresAt < new Date()) {
      // Remove expired credentials on first use as well as during the periodic
      // cleanup job. This bounds the lifetime of a stolen, already-expired token.
      await tx.delete(sessions).where(eq(sessions.token, tokenHash));
      return null;
    }

    // 第二段：会话行自带的两个 id 是这里的已知量。`withActorTransaction` 的
    // 嵌套校验只认同一个 actor，所以 actor 在这里从 SYSTEM_USER_ID 换成
    // 令牌真正的主人——用一次显式的 `set_config`，语义是"这条事务从现在起
    // 代表这个已认证用户"。
    await assumeActor(tx, session.userId, session.workspaceId);

    const membership = await tx.query.workspaceMembers.findFirst({
      where: and(
        eq(workspaceMembers.workspaceId, session.workspaceId),
        eq(workspaceMembers.userId, session.userId),
      ),
      columns: { leftAt: true, role: true },
    });
    // ADR-0009: 无 membership 行或 left_at 非空（已退出）——用户被移出/退出后
    // 立即吊销 session。旧写法用 `membershipRole !== null` 区分"join 未命中"与
    // "活跃成员（left_at 为 NULL）"；现在 membership 行本身在手上，判据更直白。
    if (!membership || membership.leftAt !== null) {
      await tx.delete(sessions).where(eq(sessions.token, tokenHash));
      return null;
    }

    // 空间归属人（isWorkspaceOwner 的 OR 判据需要它）与边界令牌（0261）。
    const workspace = await tx.query.workspaces.findFirst({
      where: eq(workspaces.id, session.workspaceId),
      columns: { ownerId: true, workspaceEpoch: true },
    });

    // 滑动续期：桌面端把凭据存在本机，只要用户还在用就一直有效，直到绝对上限。
    // 低频写入由 nextSessionExpiry 的阈值保证（见常量注释）。
    const renewed = nextSessionExpiry({ createdAt: session.createdAt, expiresAt: session.expiresAt, now: new Date() });
    if (renewed) {
      await tx.update(sessions).set({ expiresAt: renewed }).where(eq(sessions.token, tokenHash));
    }
    return {
      userId: session.userId,
      workspaceId: session.workspaceId,
      membershipRole: membership.role ?? null,
      workspaceOwnerId: workspace?.ownerId ?? null,
      // 空间行读不到时退回 1（而不是 0）：契约是 positiveInt，0 会让整个会话
      // 在客户端解析失败。读不到只可能是空间刚被删，那种情况下一次请求就会被拒。
      workspaceEpoch: workspace?.workspaceEpoch ?? 1,
    };
  });
}

/** Revoke a session by its raw bearer/cookie token. */
export async function revokeSession(token: string): Promise<void> {
  const tokenHash = hashToken(token);
  await withActorTransaction({ userId: SYSTEM_USER_ID, sessionToken: tokenHash }, (tx) =>
    tx.delete(sessions).where(eq(sessions.token, tokenHash)),
  );
}

export async function cleanupExpiredSessions(): Promise<number> {
  if (sessionCleanupRunning) return 0;
  sessionCleanupRunning = true;
  try {
    // 系统级的会话维护：没有"某一个令牌"要处理，所以 actor 用 nil UUID 且
    // sessionToken 留空——`sec01_v1_sessions_actor_*` 的空令牌分支就是为这条
    // 每小时的清理路留的（只按 expires_at 扫，不认人）。
    return await withActorTransaction({ userId: SYSTEM_USER_ID }, async (tx) => {
      let total = 0;
      for (;;) {
        // 分批删除：先取一批过期 token（LIMIT 有界），再按 id 删除，
        // 避免单条无界 DELETE 在过期积压大时形成长事务。
        const expired = await tx
          .select({ token: sessions.token })
          .from(sessions)
          .where(lt(sessions.expiresAt, new Date()))
          .limit(SESSION_CLEANUP_BATCH);
        if (expired.length === 0) break;
        const ids = expired.map((r) => r.token);
        // 按实际删除行计数（returning 中的 token 唯一；若个别 id 因并发已被删，
        // returning 的 len 才反映真实删除数）。
        const deleted = await tx.delete(sessions).where(inArray(sessions.token, ids)).returning({ token: sessions.token });
        total += deleted.length;
        if (expired.length < SESSION_CLEANUP_BATCH) break;
      }
      return total;
    });
  } finally {
    sessionCleanupRunning = false;
  }
}


/**
 * N-011: 获取工作区的 AI 隐私治理配置。
 */
/**
 * 读取本人的 AI 同意与数据外发政策（0237 起为账号级）。
 *
 * 必须走 `withWorkspaceTransaction`：`user_ai_settings` 启用了 RLS 且策略按
 * `app.user_id`，用默认 `db` 连接查它会**静默返回 0 行**，表现成"同意永远未签"
 * 而不是报错。`workspaceId` 只用于设置事务上下文，不参与这张表的隔离。
 */
/**
 * 2026-08-11（安全加固）：修改密码——验证旧密码后更新 bcrypt 哈希，
 * 并在同一事务内撤销该用户**全部** session（改密后强制全端重新登录）。
 * 返回 false 表示旧密码错误（不区分其他原因，避免枚举）。
 */
export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<boolean> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) return false;
  const newHash = await hashPassword(newPassword);
  // 撤销"这个人的全部会话"是改密的语义本身，所以 actor 就是这个人，
  // 不带 sessionToken——`sec01_v1_sessions_actor_*` 的空令牌分支允许按 user_id 批量删。
  await withActorTransaction({ userId }, async (tx) => {
    await tx.update(users).set({ passwordHash: newHash, updatedAt: new Date() }).where(eq(users.id, userId));
    await tx.delete(sessions).where(eq(sessions.userId, userId));
  });
  return true;
}

/**
 * 2026-08-11（安全加固）：撤销用户全部会话（"退出所有设备"）。
 */
export async function revokeAllSessionsForUser(userId: string): Promise<void> {
  await withActorTransaction({ userId }, (tx) =>
    tx.delete(sessions).where(eq(sessions.userId, userId)),
  );
}
