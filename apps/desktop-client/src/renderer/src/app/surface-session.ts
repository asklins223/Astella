import type { SessionContextV1 } from "@astella/shared/desktop-ipc-contracts";
import { createRequestMeta, getCurrentWorkspaceEpoch, RendererGatewayError, unwrapGatewayResult } from "./desktop-client";
import { subscribeGateInvalidation } from "./gate-invalidation";

// 门禁已经核验过的会话就是页面取数的作用域；页面导航不再各自等待 /auth/me。
// 真实数据读写仍由 main 的 epoch 与 API 会话/权限检查收口。
let verifiedSession: SessionContextV1 | null = null;
export function setAuthenticatedSurfaceSession(session: SessionContextV1 | null): void {
  verifiedSession = session?.status === "authenticated" && session.workspace ? session : null;
}
subscribeGateInvalidation(() => setAuthenticatedSurfaceSession(null));

/**
 * Every task surface reads the session before it reads workspace data, and each
 * one owns its own `workspaceEpoch` cursor so a stale response can be discarded.
 */
export async function readAuthenticatedSession(
  epochRef: React.MutableRefObject<number | undefined>,
): Promise<SessionContextV1> {
  if (!window.astella) throw new Error("桌面端 API 不可用，无法读取真实工作区数据。");
  if (verifiedSession && verifiedSession.workspaceEpoch === getCurrentWorkspaceEpoch()) {
    epochRef.current = verifiedSession.workspaceEpoch;
    return verifiedSession;
  }
  const response = await window.astella.auth.getState({ meta: createRequestMeta(epochRef.current) });
  if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
  const session = unwrapGatewayResult(response);
  if (session.status !== "authenticated" || !session.workspace) {
    throw new RendererGatewayError({ code: "auth_required", safeMessageKey: "error.auth_required", retry: "user_action" });
  }
  return session;
}
