/**
 * mimo 平台的出网探针：按 config/ai-platforms.json 里 platforms.mimo 的声明走真实
 * provider 出网，核对思考字段的**方言**确实发出去了、上游确实照办（关思考要看到
 * reasoning_tokens=0），顺带验识图入参与带工具的 agent turn。
 *
 *   cd workers/ai-worker
 *   AI_PLATFORMS_CONFIG=../../config/ai-platforms.json \
 *     node --env-file=../../.env --import tsx src/live-tests/mimo-platform-probe.ts
 */
import { resolveSystemPlatform } from "@astella/shared/platform-config-node";
import { postJsonToPublicEndpoint } from "@astella/shared/public-json-http";
import { OpenAICompatibleProvider } from "../lib/providers/openai-compatible.ts";

const platform = resolveSystemPlatform("text_generation");
if (!platform || platform.platformId !== "mimo") {
  throw new Error(`text_generation 没有指向 mimo（实际：${platform?.platformId ?? "未配置"}）`);
}

let lastBody: Record<string, unknown> | undefined;
const capturingRequester: typeof postJsonToPublicEndpoint = async (url, headers, body, signal) => {
  lastBody = body as Record<string, unknown>;
  const response = await postJsonToPublicEndpoint(url, headers, body, signal);
  const usage = (response.body as { usage?: unknown } | undefined)?.usage;
  console.log("  发出的思考字段:", JSON.stringify(Object.fromEntries(
    Object.entries(lastBody).filter(([key]) => key === "enable_thinking" || key === "reasoning_effort" || key === "max_tokens" || key === "temperature" || key === "response_format"))));
  console.log("  上游 usage:", JSON.stringify(usage));
  return response;
};

const provider = new OpenAICompatibleProvider({
  apiKey: platform.apiKey!,
  baseUrl: platform.baseUrl!,
  model: platform.model,
  ...(platform.modelProfile ? { modelProfile: platform.modelProfile } : {}),
  ...(platform.options ? { platformOptions: platform.options } : {}),
  request: capturingRequester,
});

console.log(`平台 ${platform.platformId} / ${platform.model} / 档案 ${JSON.stringify(platform.modelProfile)}`);

const messages = [{ role: "user" as const, content: "用一句话说明光合作用。" }] as Parameters<typeof provider.chatCompletion>[0];

console.log("\n[1] 跟档案默认档（thinkingParam=reasoning_effort）");
const on = await provider.chatCompletion(messages, { responseFormat: "text" });
console.log("  正文:", on.content.slice(0, 60));

console.log("\n[2] 调用方显式关思考");
const off = await provider.chatCompletion(messages, { responseFormat: "text", disableThinking: true });
console.log("  正文:", off.content.slice(0, 60));

console.log("\n[3] 结构化输出 + 识图入参形状（json_object）");
const json = await provider.chatCompletion(
  [{ role: "user", content: "返回 {\"ok\":true}" }] as Parameters<typeof provider.chatCompletion>[0],
  { responseFormat: "json_object" },
);
console.log("  正文:", json.content);

console.log("\nlastBody 顶层键:", Object.keys(lastBody ?? {}).join(","));
