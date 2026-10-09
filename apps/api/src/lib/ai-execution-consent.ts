import { sql } from "drizzle-orm";
import { AIConsentRequiredError, AIDataPolicyDeniedError, queryRows, type AgentSqlExecutor } from "@astella/agent-host";
import { resolveSystemProviderForCapability } from "@astella/shared/task-router";

export function systemUsesExternalAI(): boolean {
  return ["agent_turn", "vision", "text_generation", "embedding"].some(
    capability => resolveSystemProviderForCapability(capability as "agent_turn" | "vision" | "text_generation" | "embedding") !== "mock",
  );
}

/** Acceptance gate, before any run/job/outbox write. The worker still checks
 * again before external calls. Read in the caller's scoped transaction. */
export async function requireAiExecutionConsent(tx: AgentSqlExecutor, scope: { userId: string }): Promise<void> {
  if (!systemUsesExternalAI()) return;
  const [settings] = await queryRows<{ consent_at: unknown; consent_version: string | null; data_policy: { sendToExternal?: boolean } | null }>(tx,
    sql`SELECT consent_at, consent_version, data_policy FROM user_ai_settings WHERE user_id=${scope.userId} FOR SHARE`);
  if (!settings?.consent_at || !settings.consent_version) throw new AIConsentRequiredError();
  if (settings.data_policy?.sendToExternal !== true) throw new AIDataPolicyDeniedError(
    "外部 AI 已关闭，请在 AI 使用设置中开启「允许发送到外部模型服务」后继续。",
  );
}
