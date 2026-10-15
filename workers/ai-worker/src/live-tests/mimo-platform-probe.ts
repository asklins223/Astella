/**
 * MiMo Agent 的出网探针：按 config/ai-platforms.json 里 platforms.mimo-agent 的声明
 * 走官方 Responses API，核对 `/responses`、`reasoning.effort`、结构化文本和 usage。
 *
 *   cd workers/ai-worker
 *   AI_PLATFORMS_CONFIG=../../config/ai-platforms.json \
 *     node --env-file=../../.env --import tsx src/live-tests/mimo-platform-probe.ts
 */
import { resolveSystemPlatform } from "@astella/shared/platform-config-node";
import { postJsonToPublicEndpoint } from "@astella/shared/public-json-http";
import { MiMoResponsesProvider } from "../lib/providers/opencode-go.ts";

const platform = resolveSystemPlatform("agent_turn");
if (!platform || platform.platformId !== "mimo-agent" || platform.type !== "mimo_responses") {
  throw new Error(`agent_turn 没有指向 mimo-agent Responses（实际：${platform?.platformId ?? "未配置"}/${platform?.type ?? "无类型"}）`);
}

let lastBody: Record<string, unknown> | undefined;
const capturingRequester: typeof postJsonToPublicEndpoint = async (url, headers, body, signal) => {
  lastBody = body as Record<string, unknown>;
  const response = await postJsonToPublicEndpoint(url, headers, body, signal);
  const usage = (response.body as { usage?: unknown } | undefined)?.usage;
  console.log("  发出的 Responses 字段:", JSON.stringify(Object.fromEntries(
    Object.entries(lastBody).filter(([key]) => ["reasoning", "max_output_tokens", "temperature", "text", "tools", "tool_choice"].includes(key)))));
  console.log("  上游 usage:", JSON.stringify(usage));
  return response;
};

const provider = new MiMoResponsesProvider({
  apiKey: platform.apiKey!,
  baseUrl: platform.baseUrl!,
  model: platform.model,
  ...(platform.modelProfile ? { modelProfile: platform.modelProfile } : {}),
  ...(platform.options ? { platformOptions: platform.options } : {}),
  request: capturingRequester,
});

console.log(`平台 ${platform.platformId} / ${platform.type} / ${platform.model} / 档案 ${JSON.stringify(platform.modelProfile)}`);

const messages = [{ role: "user" as const, content: "用一句话说明光合作用。" }] as Parameters<typeof provider.chatCompletion>[0];

console.log("\n[1] MiMo Responses 默认思考档（reasoning.effort）");
const on = await provider.chatCompletion(messages, { responseFormat: "text" });
console.log("  正文:", on.content.slice(0, 60));

console.log("\n[2] Responses 调用方显式关思考（reasoning.effort=none）");
const off = await provider.chatCompletion(messages, { responseFormat: "text", disableThinking: true });
console.log("  正文:", off.content.slice(0, 60));

console.log("\n[3] Responses 结构化输出（json_object）");
const json = await provider.chatCompletion(
  [{ role: "user", content: "返回 {\"ok\":true}" }] as Parameters<typeof provider.chatCompletion>[0],
  { responseFormat: "json_object" },
);
console.log("  正文:", json.content);

console.log("\nlastBody 顶层键:", Object.keys(lastBody ?? {}).join(","));
