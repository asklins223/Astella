/**
 * The per-step tool surface.
 *
 * The model sees a small core plus the groups declared for the current page. It
 * can expand the surface itself with `companion_load_tools`; candidate
 * operations may only add groups, never remove one. The full catalog still
 * drives authorization and execution checks, so this is a view rather than a
 * grant.
 */

import {
  companionToolGroupCatalog,
  resolveCompanionInitialToolNames,
  resolveCompanionToolGroupNames,
  type AgentTurnRequest,
} from "@astella/shared";

type ToolDefinition = AgentTurnRequest["tools"][number];

export interface CompanionToolSurface {
  /** Tools declared by the interpreter's candidate groups and the page. */
  readonly initialToolNames: ReadonlySet<string>;
  /** Groups the model loaded in this turn (survives checkpoints). */
  readonly loadedToolNames: Set<string>;
  /** The visible definitions for this step. */
  offered(): ToolDefinition[];
}

export function createCompanionToolSurface(input: {
  definitions: readonly ToolDefinition[];
  pageKind: string | null;
  candidateOperations: readonly string[];
  loadedToolNames?: Iterable<string>;
}): CompanionToolSurface {
  const loadedToolNames = new Set(input.loadedToolNames ?? []);
  const initialToolNames = resolveCompanionInitialToolNames({
    availableToolNames: input.definitions.map(definition => definition.name),
    pageKind: input.pageKind,
    candidateOperations: input.candidateOperations,
  });
  return {
    initialToolNames,
    loadedToolNames,
    offered: () => input.definitions
      .filter(definition => initialToolNames.has(definition.name) || loadedToolNames.has(definition.name))
      .map(({ name, description, parameters }) => ({ name, description, parameters })),
  };
}

/**
 * Resolve `companion_load_tools` arguments into concrete tool names and record
 * them in the surface. Returns what was loaded for the tool receipt.
 */
export function loadCompanionToolGroups(surface: CompanionToolSurface, input: {
  groups: readonly string[];
  definitions: readonly { name: string }[];
}): string[] {
  const wanted = resolveCompanionToolGroupNames(input.groups);
  const loaded = input.definitions.filter(item => wanted.has(item.name)).map(item => item.name);
  for (const name of loaded) surface.loadedToolNames.add(name);
  return loaded;
}

/**
 * Apply a `companion_load_tools` call: expand the surface, push the receipt the
 * model will see, and record the audit event. Returns the loaded tool names.
 */
export async function applyCompanionToolLoad(input: {
  surface: CompanionToolSurface;
  groups: readonly string[];
  definitions: readonly { name: string; toolVersion: string }[];
  callId: string;
  toolName: string;
  toolVersion: string;
  pushReceipt: (content: string) => void;
  recordAudit: (tool: { toolCallId: string; name: string; toolVersion: string;
    riskClass: "read"; status: "succeeded"; safeLabel: string; safeSummary: string }) => Promise<void>;
}): Promise<string[]> {
  const loaded = loadCompanionToolGroups(input.surface, {
    groups: input.groups, definitions: input.definitions,
  });
  const summary = `已装载 ${loaded.length} 个工具`;
  input.pushReceipt(JSON.stringify({
    ok: true,
    data: {
      loadedGroups: [...input.groups],
      tools: loaded,
      // 每组装了什么、能办什么：只在这次回执里说一次。
      // 放进工具描述会顶穿每轮的工具面预算（单条 150 字符、总量 4000，实测只剩 6 字符），
      // 而回执只在装载那一步出现，之后不再进请求。
      groupCatalog: companionToolGroupCatalog(input.groups),
    },
    summary,
  }));
  await input.recordAudit({
    toolCallId: input.callId, name: input.toolName, toolVersion: input.toolVersion,
    riskClass: "read", status: "succeeded", safeLabel: "已装载更多能力", safeSummary: summary,
  });
  return loaded;
}
