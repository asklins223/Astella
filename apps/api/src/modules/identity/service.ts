/**
 * identity 的**聚合出口**（P1-7 完成后）。
 *
 * 1580 行、28 个导出、6 个关注点的那个文件已经拆成四族 + 一块共享地基：
 *
 *   ./session-service.ts            会话签发/登录/解码/撤销/清理/改密
 *   ./workspace-membership-service  成员关系：切空间/列表/凭码加入/转让/退出/档案
 *   ./workspace-lifecycle-service   空间生命周期：注册/建空间/改名/解散预览/解散
 *   ./ai-consent-service.ts         AI 授权与审计
 *   ./credentials.ts                共享地基：邮箱规范化/密码哈希/令牌生成/会话过期常量
 *
 * 本文件保留两样东西：
 *
 *   1. **转出**。既有调用方（53 处 import）一律继续从 `./service.ts` 取，
 *      **一行都不用改**。这就是先立门面那一步换来的东西。
 *   2. `WorkspaceInfo` —— 三族共用的空间摘要 DTO。它的声明留在这里，
 *      别的文件用 `import type` 引它（编译期抹掉，不构成运行时环）。
 *      搬走它反而要多改三个文件，而它本身就是一个共享形状。
 *
 * ## 为什么不在这里放任何逻辑
 *
 * 这类"谁都能往里塞一点"的模块正是拆分要消灭的东西。留在这里的每一条 import，
 * 都在提示"还有一个本该有自己名字的形状"。
 *
 * 配套的棘轮在 `identity-service-export-ratchet.test.ts`：
 * 本文件的**函数**导出数已经被压到 0，且只能更少。
 */

export {
  // 会话
  issueSession,
  loginWithPassword,
  decodeToken,
  revokeSession,
  cleanupExpiredSessions,
  changePassword,
  revokeAllSessionsForUser,
} from "./session-service.ts";

export {
  // 空间成员关系
  switchWorkspace,
  listUserWorkspaces,
  joinWorkspaceByInviteToken,
  transferWorkspaceOwnership,
  leaveWorkspace,
  updateUserProfile,
  JoinWorkspaceError,
  type JoinWorkspaceErrorCode,
  type TransferOwnershipError,
  type LeaveWorkspaceError,
  type UpdateProfileError,
  MAX_COLLABORATIVE_WORKSPACES,
} from "./workspace-membership-service.ts";

export {
  // 空间生命周期
  generateDefaultWorkspaceName,
  registerWithoutInvite,
  resetRecoveredUserPassword,
  createCollaborativeWorkspace,
  renameWorkspace,
  previewWorkspaceDissolve,
  dissolveWorkspace,
  type CreateWorkspaceError,
  type RenameWorkspaceError,
} from "./workspace-lifecycle-service.ts";

export {
  // AI 授权与审计
  getAIPrivacySettings,
  updateAIConsent,
  updateAIDataPolicy,
  listAIAuditLog,
  logAICall,
} from "./ai-consent-service.ts";

export {
  // 凭证原语与会话过期常量
  SESSION_TTL_MS,
  SESSION_ABSOLUTE_MAX_MS,
  SESSION_RENEW_WHEN_REMAINING_MS,
  nextSessionExpiry,
  RECOVERED_PASSWORD_SENTINEL,
  canonicalizeEmail,
  hashPassword,
  type SessionContext,
} from "./credentials.ts";

/** 三族共用的空间摘要 DTO（`loginWithPassword` 的返回类型）。 */
export interface WorkspaceInfo {
  workspaceId: string;
  workspaceName: string;
  role: string;
  workspaceType: string;
  isPersonal: boolean;
  leftAt: Date | null;
}
