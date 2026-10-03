/**
 * 身份侧的凭证原语（P1-7 第五步）。
 *
 * ## 为什么先抽这一块，而不是直接搬 session 那一族
 *
 * `service.ts` 里 session 那一族**散在四处不连续的位置**，而且与另外三族共享
 * `hashPassword` / `verifyPassword` / `generateToken` / `hashToken` / `canonicalizeEmail`
 * （注册、重置密码、凭邀请码加入空间都要用）。
 *
 * 先把这块**共享地基**抽出来，session 那一族后面搬的时候就不再有跨族依赖。
 *
 * ## 边界
 *
 * 只依赖 `bcrypt` 与两张表（`sessions` / `workspaces`），**不引用 service.ts 的任何东西**
 * ——所以它不会因为 service.ts 从本文件 re-export 而造出一个环。
 *
 * `verifyPassword` / `generateToken` / `hashToken` 三个此前是私有的，搬过来之后必须导出：
 * session 那一族还在 service.ts 里，它要用。**模块私有作用域对外面等于没有名字**
 * ——不导出就等于这三个函数在原地消失了。
 */

import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MAX_MS = 180 * 24 * 60 * 60 * 1000;
export const SESSION_RENEW_WHEN_REMAINING_MS = SESSION_TTL_MS / 2;

export function nextSessionExpiry(input: {
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly now: Date;
}): Date | null {
  const { createdAt, expiresAt, now } = input;
  // 续期永远不能复活一个已经到期的会话，即使调用方没有先做过期判断。
  if (expiresAt.getTime() <= now.getTime()) return null;
  if (expiresAt.getTime() - now.getTime() >= SESSION_RENEW_WHEN_REMAINING_MS) return null;
  const ceiling = createdAt.getTime() + SESSION_ABSOLUTE_MAX_MS;
  const renewed = Math.min(now.getTime() + SESSION_TTL_MS, ceiling);
  return renewed > expiresAt.getTime() ? new Date(renewed) : null;
}
export const RECOVERED_PASSWORD_SENTINEL = "$RESET_REQUIRED$";
const BCRYPT_COST = 10;
// Keep unknown-account logins on the same expensive bcrypt path as known
// accounts so response timing does not become a reliable email oracle.
export const DUMMY_PASSWORD_HASH = "$2a$10$cgxNDTz4bljIsmxLn2w.7O6Cd/C3cZK3neQBb/2Xxx4xNJkIgMrse";

export function canonicalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  return bcrypt.compare(plain, stored);
}

export function generateToken(): string {
  return randomBytes(24).toString("hex");
}

// R-011: 对 token 做 SHA-256 哈希后存储，数据库泄露不暴露可用 session
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface SessionContext {
  userId: string;
  workspaceId: string;
  /** 2026-08-11（性能专项）：decodeToken 合并 JOIN 时顺带取回的成员角色，
   * 供 /auth/me 等端点复用（避免重复查 workspace_members）。 */
  membershipRole?: string | null;
  /**
   * 当前空间的 `owner_id`，同样由 decodeToken 一次 JOIN 带回。
   *
   * 为什么要有它：`isWorkspaceOwner` 是 OR 语义（成员行写着 owner，**或**空间
   * owner_id 就是本人）。此前只有 `requireOwner` 自己再去查一遍 owner_id，于是
   * `/v1/auth/capabilities` 与笔记投影这些"只想判一次角色"的地方拿不到 owner_id，
   * 就各自写了个只看 membershipRole 的简化版——同一个人在服务端可写、在 UI 上却被
   * 判成只读。把 owner_id 放进 session 上下文，判据才有唯一的落点。
   */
  workspaceOwnerId?: string | null;
  /**
   * 当前空间的 `name` / `workspace_type`，2026-10-03 由 decodeToken 顺带取回。
   *
   * 这两列此前没有任何人读，`/auth/me` 就自己又发了一条 `SELECT ... FROM
   * workspaces`。而 decodeToken 本来就已经在同一事务里读过这一行了（为了
   * `owner_id` 与 `workspace_epoch`），只是没把列选全。
   *
   * 实测代价：每个已认证请求 8 条语句里有 2 条读的是**同一张表的同一行**。
   * 按实测的 ~117µs/条计，删掉重复读约等于单进程吞吐 +15%。
   *
   * 可选而非必填：`issueSession`（登录/注册/切空间的签发路径）不填它们，
   * 与既有的 `membershipRole` / `workspaceOwnerId` 同一约定——只有逐请求解码
   * 这条路需要空间的外围属性。
   */
  workspaceName?: string | null;
  workspaceType?: string | null;
  /**
   * 当前空间的服务端边界令牌（`workspaces.workspace_epoch`，迁移 0261）。
   *
   * 审查 1.3 说服务端"无 workspaceEpoch 概念（只有硬编码 1）→ 无法做某空间全端
   * 强制下线"。这一列把那个数字变成真的事实源：成员变动 / AI 同意或外发政策改变 /
   * 空间改名时 +1（触发器），会话每次解码时读回当前值。客户端拿旧值请求会被
   * 主进程的 `assertEpoch` 判 `stale_workspace`，重读会话后才继续。
   */
  workspaceEpoch: number;
}

