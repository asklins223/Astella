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
  COMPANION_COMMON_ACTION_TOOL_NAMES,
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
  initiative?: boolean;
  hasImageAttachments?: boolean;
}): CompanionToolSurface {
  const loadedToolNames = new Set(input.loadedToolNames ?? []);
  const initialToolNames = resolveCompanionInitialToolNames({
    availableToolNames: input.definitions.map(definition => definition.name),
    pageKind: input.pageKind,
    hasImageAttachments: input.hasImageAttachments,
    candidateOperations: [...input.candidateOperations],
  });
  // Proactive turns keep the earlier, narrower surface: common writes are for
  // user-requested work, not for self-initiated participation. Her own persona
  // records stay available — advancing a self-note is exactly what a proactive
  // turn is for, and it never writes anything the user owns.
  if (input.initiative) {
    for (const name of COMPANION_COMMON_ACTION_TOOL_NAMES) initialToolNames.delete(name);
    for (const name of ["companion_notes_write", "companion_memory_write"]) {
      initialToolNames.delete(name);
    }
    // Her own records and the attention plan she maintains are hers to advance;
    // gated actions on them (cancel/pause/activeness/boundary) still hit the
    // execution-time confirmation and the initiative business-op block.
    for (const name of ["companion_persona_read", "companion_persona_write", "companion_attention_write",
      "companion_observe", "companion_notes_read", "companion_send_message"]) {
      if (input.definitions.some(definition => definition.name === name)) initialToolNames.add(name);
    }
  }
  // Candidate operations and page declarations may add tools. Nothing narrows
  // the declared, permission-filtered surface here: a compound request keeps
  // its reminder, memory, or persona capabilities alongside note authoring.
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

/** 附图只有资产身份，首轮须真正读取才能回答画面；显式不看图的请求保持原意。 */
export function companionAttachmentReadRequired(input: {
  hasImageAttachments: boolean; visionEnabled: boolean; userText: string;
}): boolean {
  if (!input.hasImageAttachments || !input.visionEnabled) return false;
  const declined = /(?:不要|不用|无需|先别|别|不必|不需要)\s*(?:先|再|帮我)?\s*(?:读图|看图|识图|识别图片|分析图片|分析照片|查看图片|查看照片)/u.test(input.userText)
    || /\b(?:do not|don't|no need to)\s+(?:read|inspect|analy[sz]e|describe)\s+(?:(?:the|these|my)\s+)?(?:images?|pictures?|photos?)\b/iu.test(input.userText);
  return !declined;
}
