import type { AgentTurnResult, ChatOptions } from "@astella/shared";
import type { ToolCall } from "@earendil-works/pi-ai";
import { AgentOutputError } from "../non-retryable-errors.ts";
import { ProviderStreamError } from "../provider-request-error.ts";
import { parseResponsesAgentTurn, readResponsesReasoningHandles, readResponsesUsage } from "./opencode-go.ts";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function items(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.flatMap(item => record(item) ? [record(item)!] : []) : [];
}
function argumentsObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string") return record(raw);
  try { return record(JSON.parse(raw)); } catch { return null; }
}
function publicPhase(phase: unknown): boolean {
  return phase === undefined || phase === "commentary" || phase === "final" || phase === "final_answer";
}

/** Enforces host invariants that a tolerant SDK parser cannot decide for us. */
export class PiWireObservation {
  private terminal?: Record<string, unknown>;
  private readonly phases = new Map<number, unknown>();
  private readonly deltaPhases: unknown[] = [];
  private readonly rawCalls = new Map<string | number, { id: string; name: string; arguments: string }>();
  private readonly started = new Set<string>();
  private readonly settled = new Set<string>();
  private streamed = "";
  private sawFinish = false;
  private failure?: Error;

  constructor(private readonly provider: string, private readonly api: "openai-completions" | "openai-responses",
    private readonly hasTools: boolean, private readonly onDelta?: (text: string) => void,
    private readonly supportsAssistantPhase?: boolean) {}

  observe(value: unknown): void {
    const event = record(value);
    if (!event) return;
    if (this.api === "openai-responses") {
      const item = record(event.item);
      if (typeof event.output_index === "number" && item?.type === "message") this.phases.set(event.output_index, item.phase);
      if (event.type === "response.output_text.delta" || event.type === "response.refusal.delta") {
        this.deltaPhases.push(this.phases.has(event.output_index as number)
          ? this.phases.get(event.output_index as number) : "unknown");
      }
      if (event.type === "response.output_item.done" && item?.type === "function_call") {
        this.rawCalls.set(String(item.call_id), { id: String(item.call_id ?? ""),
          name: String(item.name ?? ""), arguments: typeof item.arguments === "string" ? item.arguments : "" });
      }
      if (event.type === "response.completed" || event.type === "response.incomplete") {
        this.terminal = record(event.response) ?? undefined;
        if (event.type === "response.incomplete") {
          this.failure = record(this.terminal?.incomplete_details)?.reason === "max_output_tokens"
            ? new AgentOutputError("output_truncated", "model response exhausted its output limit")
            : new ProviderStreamError(this.provider, "stream_incomplete");
        }
      } else if (event.type === "response.failed" || event.type === "error") this.failure = new ProviderStreamError(this.provider, "stream_failed");
    } else {
      const choice = items(event.choices)[0];
      if (!choice) return;
      if (typeof choice.finish_reason === "string" && choice.finish_reason) this.sawFinish = true;
      if (choice.finish_reason === "length") this.failure = new AgentOutputError("output_truncated", "model response exhausted its output limit");
      const delta = record(choice.delta);
      for (const fragment of items(delta?.tool_calls)) {
        // A stream may carry several calls in one delta, and a gateway may omit
        // `index`. Falling back to a shared index 0 concatenated two
        // independent `companion_send_message` calls into one paragraph, so
        // only a single bubble ever appeared. Key on the provider's call id
        // when present and fall back to index only while it is missing.
        const id = typeof fragment.id === "string" ? fragment.id.trim() : "";
        const index = typeof fragment.index === "number" ? fragment.index : 0;
        const key: string | number = id || index;
        const slot = this.rawCalls.get(key) ?? { id: "", name: "", arguments: "" };
        if (!slot.id && id) slot.id = id;
        const fn = record(fragment.function);
        if (typeof fn?.name === "string") slot.name += fn.name;
        if (typeof fn?.arguments === "string") slot.arguments += fn.arguments;
        this.rawCalls.set(key, slot);
      }
    }
  }

  textDelta(delta: string): void {
    const observedPhase = this.api === "openai-responses" ? this.deltaPhases.shift() : undefined;
    const phase = observedPhase === "unknown" && this.supportsAssistantPhase === false ? undefined : observedPhase;
    // Phase-free models publish output_text incrementally. Unknown/phase-capable
    // routes still wait for the terminal selection; explicit private phases are
    // always withheld, even if the profile claims not to use them.
    const phaseFreeText = phase === undefined && this.supportsAssistantPhase === false;
    if (!delta || (this.api === "openai-responses" && (!publicPhase(phase)
      || (!this.hasTools && !phaseFreeText && phase !== "final" && phase !== "final_answer")))) return;
    this.streamed += delta;
    this.onDelta?.(delta);
  }

  toolStarted(index: number, call: ToolCall, options: ChatOptions): void {
    const id = call.id.split("|")[0];
    if (!id || !call.name || this.started.has(id)) return;
    this.started.add(id);
    options.onToolCallStarted?.({ index, id, name: call.name });
  }

  toolSettled(index: number, call: ToolCall, options: ChatOptions): void {
    const id = call.id.split("|")[0];
    const raw = [...this.rawCalls.values()].find(item => item.id === id);
    // Pi repairs partial JSON; eager dispatch requires the exact complete input.
    if (!raw || !raw.name || !argumentsObject(raw.arguments) || this.settled.has(id)) return;
    this.settled.add(id);
    options.onToolCallSettled?.({ index, id, name: raw.name, argsText: raw.arguments });
  }

  /** Read-only view of accumulated chat-completions calls, for tests and logs.
   * One entry per real provider call; independent calls are never merged. */
  observedCalls(): Array<{ id: string; name: string; arguments: string }> {
    return [...this.rawCalls.values()].map(call => ({ ...call }));
  }

  validate(): void {
    if (this.failure) throw this.failure;
    if (this.api === "openai-responses" ? !this.terminal : !this.sawFinish) throw new ProviderStreamError(this.provider, "stream_incomplete");
    for (const call of this.rawCalls.values()) {
      if (!call.id || !call.name || !argumentsObject(call.arguments)) throw new AgentOutputError("arguments_malformed", "model returned malformed tool arguments");
    }
    if (this.api === "openai-responses" && this.terminal?.status !== "completed") throw new ProviderStreamError(this.provider, "stream_incomplete");
  }

  result(piResult: AgentTurnResult): AgentTurnResult {
    if (!this.terminal) return piResult;
    // The terminal response includes full reasoning omitted by some gateways
    // from output_item.done. Preserve it verbatim for the next tool round.
    const output = items(this.terminal.output);
    const visible = output.filter(item => item.type !== "message" || publicPhase(item.phase));
    const parsed = parseResponsesAgentTurn({ ...this.terminal, output: visible }, this.hasTools);
    if (parsed.toolCalls.some(call => call.argumentsMalformed || !call.id || !call.name)) throw new AgentOutputError("arguments_malformed", "model returned malformed tool arguments");
    const selectedMessages = visible.filter(item => item.type === "message"
      && (this.hasTools || item.phase === "final" || item.phase === "final_answer"));
    const phases = new Set(selectedMessages.map(item => item.phase === "final" ? "final_answer" : item.phase));
    const phase = phases.size === 1 ? [...phases][0] : undefined;
    const reasoning = readResponsesReasoningHandles(this.terminal);
    return {
      content: parsed.content,
      toolCalls: parsed.toolCalls.map(({ id, name, arguments: args }) => ({ id, name, arguments: args })),
      finishReason: parsed.finishReason,
      ...(phase === "commentary" || phase === "final_answer" ? { phase } : {}),
      ...(reasoning.length ? { reasoning } : {}),
      usage: readResponsesUsage(this.terminal) ?? piResult.usage,
      providerRequestId: parsed.requestId ?? piResult.providerRequestId,
    };
  }

  publishRemaining(content: string): void {
    if (!content.startsWith(this.streamed)) throw new ProviderStreamError(this.provider, "stream_content_mismatch");
    const remaining = content.slice(this.streamed.length);
    if (remaining) this.onDelta?.(remaining);
  }
}
