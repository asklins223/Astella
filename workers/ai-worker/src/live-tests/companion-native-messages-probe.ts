import { AgentRole } from "@astella/shared";
import { platform, observedProvider, type WireReceipt } from "./acceptance-common.ts";

/** Can the Responses route return more than one assistant message item? */
const route = platform("agent_turn");
const receipts: WireReceipt[] = [];
const provider = observedProvider(route, "native-messages", receipts);
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(new Error("probe timeout")), 20_000);
const started = Date.now();
try {
  const result = await provider.executeAgentTurn!({
    role: AgentRole.COMPANION_AGENT,
    systemPrompt: "你是伴星。用户要求分条时，把每一条写成一条独立的 assistant 消息，不要用分隔符或编号把多条塞进同一条消息。",
    messages: [{ role: "user", content: "分两条跟我说：第一条只说“早”，第二条只说“今天想先做哪件事？”" }],
    tools: [], toolChoice: "auto", maxTokens: 128, temperature: 0.9, disableThinking: true,
  }, controller.signal, {});
  const receipt = receipts[0];
  console.log(JSON.stringify({ elapsedMs: Date.now() - started, content: String(result.content ?? "").slice(0, 300),
    outputMessageCount: receipt?.outputMessageCount ?? null, messagePhases: receipt?.messagePhases ?? null,
    firstOutputTextDeltaMs: receipt?.firstOutputTextDeltaMs ?? null }));
} catch (error) {
  console.log(JSON.stringify({ elapsedMs: Date.now() - started, error: error instanceof Error ? error.name : "unknown" }));
} finally { clearTimeout(timer); process.exit(0); }
