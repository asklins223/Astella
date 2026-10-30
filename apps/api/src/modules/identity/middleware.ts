import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { decodeToken } from "../identity/session-service.ts";
import { SESSION_CLIENT_KINDS } from "./credentials.ts";
import { extractAuthCredential, hasValidCookieCsrf, type AuthCredential } from "./session-auth.ts";

declare module "fastify" {
  interface FastifyRequest {
    session: {
      userId: string;
      workspaceId: string;
      membershipRole?: string | null;
      workspaceOwnerId?: string | null;
      /** 空间边界令牌（0261）：由 decodeToken 读回 `workspaces.workspace_epoch`。 */
      workspaceEpoch: number;
      /** 2026-10-03：decodeToken 同一行顺带取回，供 /auth/me 免掉重复查询。 */
      workspaceName?: string | null;
      workspaceType?: string | null;
      /** 0413：这枚凭据签发给了哪一种客户端（`sessions.client_kind`）。 */
      clientKind?: string | null;
    };
  }
}

export async function requireSession(req: FastifyRequest, reply: FastifyReply) {
  const credential = getRequestCredential(req);

  if (!credential) {
    reply.header("WWW-Authenticate", "Bearer");
    return reply.code(401).send({ error: "missing token" });
  }
  if (credential.source === "cookie" && !hasValidCookieCsrf(req.method, req.headers)) {
    return reply.code(403).send({ error: "csrf token required" });
  }
  const session = await decodeToken(credential.token);
  if (!session) {
    reply.header("WWW-Authenticate", "Bearer");
    return reply.code(401).send({ error: "invalid token" });
  }
  req.session = session;
}

/** Shared credential extraction for middleware and logout. */
export function getRequestCredential(req: FastifyRequest): AuthCredential | null {
  return extractAuthCredential(req.headers);
}

/**
 * Pure ownership decision extracted from requireOwner for testability.
 *
 * A user is considered an owner if EITHER:
 *   - their workspace_members.role equals "owner" (collaborative workspace), OR
 *   - the workspace.ownerId matches their userId (personal workspace, ADR-0009).
 *
 * This mirrors the OR semantics in requireOwner and /auth/me role derivation.
 */
export function isWorkspaceOwner(ctx: {
  userId: string;
  membershipRole?: string | null;
  workspaceOwnerId?: string | null;
}): boolean {
  return ctx.membershipRole === "owner" || ctx.workspaceOwnerId === ctx.userId;
}

/**
 * 判据只有一处：`req.session` 里的 `membershipRole` 与 `workspaceOwnerId` 都由
 * `decodeToken` 每次请求实时 JOIN 带回（成员失效时它直接吊销 session），所以这里
 * 不再自己查一遍。
 *
 * 此前它自己查、而 `/v1/auth/capabilities` 与笔记投影只看 `membershipRole`，同一个
 * 人于是可能"服务端允许写、UI 判它只读"。收敛成同一个谓词后这类分裂不再可能。
 */
export async function requireOwner(req: FastifyRequest, reply: FastifyReply) {
  if (!isWorkspaceOwner(req.session)) {
    return reply.code(403).send({ error: "owner role required" });
  }
}

/**
 * 登录/注册接口接受的「这枚凭据要交给谁」——0413 落进 `sessions.client_kind`。
 *
 * 可选、缺省 `desktop`，所以桌面端一次调用都不用改。取值域与库里那句 CHECK 必须
 * 一致，因此直接从 `SESSION_CLIENT_KINDS` 生成，不在两处各写一份字面量。
 * 填了别的值走 `parseBody` 的 400，**不归一成 desktop**：拼错的一端如果拿到最宽
 * 的权限，这条规则就变成"知道自己会被挡的人才会被挡"。
 */
export const sessionClientKindSchema = z.enum(SESSION_CLIENT_KINDS).default("desktop");

/** 2026-10-29: 手机和桌面共用空间权限，正文写入不再按客户端种类限制。 */
