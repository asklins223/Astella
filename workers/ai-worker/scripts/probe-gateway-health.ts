/**
 * 网关健康探测（2026-10-14）：一发最小请求，确认网关响应正常再发真实用户轮。
 *
 * 上一轮自举验证挂在网关上：一次用户轮跑了 37 分钟不返回（provider 超时 15 分钟
 * 都没触发，step 1 一直 running）。那次请求体与改动前逐字节相同，不是改动引入的。
 * 这一发只为回答"网关现在活着吗"，避免再空等。
 *
 *   docker cp scripts/probe-gateway-health.ts astella-dev-worker-1:/app/scripts/
 *   docker exec astella-dev-worker-1 ./node_modules/.bin/tsx \
 *     scripts/probe-gateway-health.ts <workspaceId> <userId>
 */
import { createProvider } from "../src/lib/ai-provider.ts";
import { resolveAIGovernanceContext, resolveProviderForTask } from "../src/lib/governance.ts";
import type { AIProvider } from "../src/lib/ai-provider.ts";

const [workspaceId, userId] = process.argv.slice(2);
if (!workspaceId || !userId) throw new Error("用法：probe-gateway-health.ts <workspaceId> <userId>");

const govCtx = await resolveAIGovernanceContext(workspaceId, userId);
if (!govCtx.consentOk) throw new Error("account has no AI consent");
const textRes = resolveProviderForTask(govCtx, "companion_agent");
const provider = createProvider(textRes.providerName,
  { ...textRes.providerConfig, sessionId: "probe-health" }) as AIProvider;

const started = Date.now();
const deadline = setTimeout(() => { console.log("[health] 超过 60 秒未返回，网关不健康"); process.exit(2); }, 60_000);
try {
  const r = await provider.chatCompletion(
    [{ role: "user", content: "只回复：好" }] as never,
    { responseFormat: "text", maxTokens: 32 },
  );
  clearTimeout(deadline);
  console.log(`[health] OK ${Date.now() - started}ms provider=${textRes.providerName}`,
    JSON.stringify(r.content).slice(0, 40));
} catch (err) {
  clearTimeout(deadline);
  const e = err as { code?: string; providerCode?: string; message?: string };
  console.log(`[health] FAILED ${Date.now() - started}ms`, e.code, e.providerCode, e.message);
  process.exit(1);
}
