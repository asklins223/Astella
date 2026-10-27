/** A genuinely separate worker process for SIGKILL recovery integration cases. */
import { MockProvider } from "../../lib/providers/mock.ts";
import { runCompanionDialogue } from "../../handlers/turn/companion-dialogue.ts";

const fixture = JSON.parse(process.argv[2]!) as { runId: string; jobId: string; workspaceId: string; userId: string; mode: string };
Object.defineProperty(MockProvider.prototype, "chatCompletionStream", { configurable: true, value: undefined });
let calls = 0;
const prefix = "我先核对眼前这一句话的意思。";
const scripted = async (onDelta?: (text: string) => void) => {
  calls++;
  if (fixture.mode === "partial-stream") {
    onDelta?.(prefix);
    // Wait for the real stream delivery to commit before the parent kills us.
    const { withWorkerWorkspaceTransaction } = await import("../../db.ts");
    const { sql } = await import("drizzle-orm");
    const deadline = Date.now() + 10_000;
    for (;;) {
      const [saved] = await withWorkerWorkspaceTransaction({ workspaceId: fixture.workspaceId, userId: fixture.userId },
        tx => tx.execute(sql`SELECT 1 FROM companion_stream_events WHERE run_id=${fixture.runId} AND type='assistant.delta' LIMIT 1`));
      if (saved) break;
      if (Date.now() > deadline) throw new Error("prefix never committed");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    process.stdout.write(`RUNTIME_RECOVERY_HELD:${fixture.runId}\n`);
    return new Promise<never>(() => { setInterval(() => undefined, 10_000); });
  }
  if (calls === 1) {
    if (fixture.mode === "read") return { content: null,
      toolCalls: [{ id: "durable-history-read", name: "companion_observe", arguments: { action: "history", fromSeq: 1, limit: 3 } }],
      finishReason: "tool_calls", usage: {}, providerRequestId: "first-process-read" };
    const bad = "<tool_call><function=companion_observe><parameter=expression>1+1</parameter></function></tool_call>";
    if (onDelta) { onDelta(prefix); await new Promise(resolve => setTimeout(resolve, 20)); onDelta(bad); }
    return { content: (onDelta ? prefix : "") + bad,
      toolCalls: [], finishReason: "stop", usage: {}, providerRequestId: "first-process-format-draft" };
  }
  process.stdout.write(`RUNTIME_RECOVERY_HELD:${fixture.runId}\n`);
  return new Promise<never>(() => { setInterval(() => undefined, 10_000); });
};
MockProvider.prototype.executeAgentTurn = () => scripted();
if (["prefix-repair", "partial-stream"].includes(fixture.mode)) {
  Object.defineProperty(MockProvider.prototype, "chatCompletionStreamToolCalls", { configurable: true, value: true });
  Object.defineProperty(MockProvider.prototype, "chatCompletionStream", { configurable: true,
    value: async (_messages: unknown, _options: unknown, _signal: unknown, onDelta: (text: string) => void) => scripted(onDelta) });
}
await runCompanionDialogue({ id: fixture.jobId, payload: { runId: fixture.runId }, workspaceId: fixture.workspaceId,
  requestedBy: fixture.userId, leaseToken: "fixture-lease", signal: new AbortController().signal });
