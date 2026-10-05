import type { AgentScopeV1 } from "@ailearn/shared/agent-contracts";

/** Content and source selection belong to the caller's domain. The core owns
 * scope checks, priority, atomic admission and the resulting budget receipt. */
export interface AgentContextSourcePlan {
  id: string;
  authority: "policy" | "data";
  required?: boolean;
  priority?: number;
  maxCharacters?: number;
}

export interface AgentContextPlan {
  maxCharacters: number;
  sources: readonly AgentContextSourcePlan[];
}

export type AgentContextSourceScope =
  | { kind: "policy" | "request" }
  | { kind: "account"; userId: string }
  | { kind: "workspace"; userId: string; workspaceId: string };

export interface AgentContextSource {
  content: string;
  scope: AgentContextSourceScope;
}

export interface AgentContextReceipt {
  id: string;
  authority: AgentContextSourcePlan["authority"];
  characters: number;
  status: "included" | "empty" | "budget_omitted";
}

export class AgentContextError extends Error {
  constructor(readonly code: "invalid_plan" | "scope_mismatch" | "required_context_overflow", sourceId: string) {
    super(`Agent context ${code}: ${sourceId}`);
    this.name = "AgentContextError";
  }
}

function validLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validatePlan(plan: AgentContextPlan): void {
  if (!validLimit(plan.maxCharacters) || new Set(plan.sources.map(source => source.id)).size !== plan.sources.length)
    throw new AgentContextError("invalid_plan", "plan");
  for (const source of plan.sources) {
    if (!source.id || (source.maxCharacters !== undefined && !validLimit(source.maxCharacters)))
      throw new AgentContextError("invalid_plan", source.id);
  }
}

/** Synchronous entry for already resolved turn data. No text is sliced: JSON,
 * source quotations and envelope boundaries remain whole, or are omitted with
 * a receipt. Required policy/current evidence never silently disappears. */
export function composeAgentContext(
  plan: AgentContextPlan,
  sources: ReadonlyMap<string, AgentContextSource>,
  scope?: AgentScopeV1,
): { systemPrompt: string; receipts: AgentContextReceipt[]; characters: number } {
  validatePlan(plan);
  for (const source of plan.sources) {
    const resolved = sources.get(source.id);
    if (!resolved) continue;
    const origin = resolved.scope;
    if ((source.authority === "policy" && origin.kind !== "policy")
      || (source.authority === "data" && origin.kind === "policy")
      || ((origin.kind === "account" || origin.kind === "workspace") && (!scope || origin.userId !== scope.userId))
      || (origin.kind === "workspace" && origin.workspaceId !== scope?.workspaceId))
      throw new AgentContextError("scope_mismatch", source.id);
  }

  // Admission order differs from display order. Required and high-priority
  // material cannot be crowded out by an earlier optional page/summary block.
  const ordered = plan.sources.map((source, index) => ({ source, index })).sort((a, b) =>
    Number(Boolean(b.source.required)) - Number(Boolean(a.source.required))
    || (b.source.priority ?? 0) - (a.source.priority ?? 0) || a.index - b.index);
  const included = new Set<string>();
  const statuses = new Map<string, AgentContextReceipt["status"]>();
  let characters = 0;
  for (const { source } of ordered) {
    const content = sources.get(source.id)?.content ?? "";
    if (!content) {
      if (source.required) throw new AgentContextError("required_context_overflow", source.id);
      statuses.set(source.id, "empty");
      continue;
    }
    const addition = content.length + (included.size ? 1 : 0);
    if (content.length > (source.maxCharacters ?? plan.maxCharacters) || characters + addition > plan.maxCharacters) {
      if (source.required) throw new AgentContextError("required_context_overflow", source.id);
      statuses.set(source.id, "budget_omitted");
      continue;
    }
    included.add(source.id);
    statuses.set(source.id, "included");
    characters += addition;
  }
  return {
    systemPrompt: plan.sources.filter(source => included.has(source.id)).map(source => sources.get(source.id)!.content).join("\n"),
    receipts: plan.sources.map(source => ({ id: source.id, authority: source.authority,
      characters: sources.get(source.id)?.content.length ?? 0, status: statuses.get(source.id)! })),
    characters,
  };
}

/** A host resolves only this plan's named sources under its current RLS/actor
 * transaction. The returned scope is verified before any prompt is assembled. */
export async function assembleAgentContext(
  scope: AgentScopeV1,
  plan: AgentContextPlan,
  port: { resolve(sourceId: string): Promise<AgentContextSource | null> },
) {
  validatePlan(plan);
  const resolved = new Map<string, AgentContextSource>();
  // Sequential by design: one host transaction may own the reads and some
  // sources consume a watermark. This does not start extra model calls.
  for (const source of plan.sources) {
    const value = await port.resolve(source.id);
    if (value) resolved.set(source.id, value);
  }
  return composeAgentContext(plan, resolved, scope);
}

/** Structured directories/receipts keep complete records and explicit coverage.
 * The host chooses a compact projection; the core never slices serialized JSON. */
export interface AgentContextRecordCost {
  characters: number;
  bytes: number;
  tokens: number;
}

export interface AgentContextRecordBudget<T> {
  maxItems?: number;
  maxCharacters?: number;
  maxBytes?: number;
  maxTokens?: number;
  /** Domain-specific projection/token estimate. Admission remains in the core. */
  measure?: (record: T) => AgentContextRecordCost;
}

export function budgetAgentContextRecords<T>(records: readonly T[], budget: AgentContextRecordBudget<T>) {
  const maxItems = budget.maxItems ?? records.length;
  if (!validLimit(maxItems) || [budget.maxCharacters, budget.maxBytes, budget.maxTokens]
    .some(limit => limit !== undefined && !validLimit(limit))
    || (!budget.measure && (budget.maxTokens !== undefined || (budget.maxCharacters ?? 2) < 2 || (budget.maxBytes ?? 2) < 2)))
    throw new AgentContextError("invalid_plan", "records");
  const items: T[] = [];
  // JSON directories include their array envelope. Memory-body projections
  // supply their own cost, without pretending to use an exact tokenizer.
  let characters = budget.measure ? 0 : 2;
  let bytes = characters;
  let tokens = 0;
  const encoder = new TextEncoder();
  for (const record of records) {
    if (items.length >= maxItems) break;
    const serialized = budget.measure ? undefined : JSON.stringify(record);
    if (!budget.measure && serialized === undefined) throw new AgentContextError("invalid_plan", "record");
    const cost = budget.measure ? budget.measure(record) : {
      characters: serialized!.length + (items.length ? 1 : 0),
      bytes: encoder.encode(serialized!).length + (items.length ? 1 : 0), tokens: 0,
    };
    if (![cost.characters, cost.bytes, cost.tokens].every(validLimit)) throw new AgentContextError("invalid_plan", "record_cost");
    if (characters + cost.characters > (budget.maxCharacters ?? Infinity)
      || bytes + cost.bytes > (budget.maxBytes ?? Infinity)
      || tokens + cost.tokens > (budget.maxTokens ?? Infinity)) continue;
    items.push(record);
    characters += cost.characters;
    bytes += cost.bytes;
    tokens += cost.tokens;
  }
  return { items, omittedCount: records.length - items.length, characters, bytes, tokens };
}
