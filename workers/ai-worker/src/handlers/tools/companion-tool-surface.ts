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
import { explicitCompanionProductRequest, explicitlyRequestsUtterances } from "./companion-tool-intent.ts";

export function companionTaskSurfaceCandidates(userText: string | undefined): string[] {
  return [...(explicitCompanionProductRequest(userText).newNote ? ["companion_create_note"] : []),
    ...(explicitlyRequestsUtterances(userText) ? ["companion_publish_utterance"] : [])];
}

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
  userText?: string;
  initiative?: boolean;
}): CompanionToolSurface {
  const loadedToolNames = new Set(input.loadedToolNames ?? []);
  const initialToolNames = resolveCompanionInitialToolNames({
    availableToolNames: input.definitions.map(definition => definition.name),
    pageKind: input.pageKind,
    candidateOperations: [...input.candidateOperations, ...companionTaskSurfaceCandidates(input.userText)],
  });
  // A fresh note task needs its authoring dependencies immediately. Unrelated
  // core groups remain discoverable, without serializing them at every step.
  // The deterministic new-note signal decides; classifier candidates only add
  // groups, so an empty or noisy candidate list must not defeat the narrowing.
  if (explicitCompanionProductRequest(input.userText).newNote) {
    const authoring = new Set(["companion_create_note", "companion_search_notes", "companion_read_note", "companion_read_source",
      "companion_read_current_page", "companion_read_history", "companion_load_tools"]);
    for (const name of initialToolNames) if (!authoring.has(name)) initialToolNames.delete(name);
  }
  // 分条发言不再只属于主动轮：伴星可以自己决定把回复拆成几条真实消息。
  // 安静结束仍然只给主动轮。只加入当前宿主上下文已经授权的定义。
  for (const name of input.initiative
    ? ["companion_publish_utterance", "companion_finish_participation"]
    : ["companion_publish_utterance"]) {
    if (input.definitions.some(definition => definition.name === name)) initialToolNames.add(name);
  }
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
