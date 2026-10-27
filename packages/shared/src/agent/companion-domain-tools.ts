/**
 * Model-facing domain tools and the internal operation each action dispatches to.
 *
 * The model sees one read/write tool per domain. Internally the host keys
 * execution, authorization and receipts on a stable operation id
 * (`domain.action`) instead of keeping a second one-operation tool per action.
 */

export type CompanionDomainToolName =
  | "companion_open"
  | "companion_web"
  | "companion_notes_read"
  | "companion_notes_write"
  | "companion_memory_read"
  | "companion_memory_write"
  | "companion_attention_read"
  | "companion_attention_write"
  | "companion_persona_read"
  | "companion_persona_write"
  | "companion_goals_read"
  | "companion_goals_write"
  | "companion_observe"
  | "companion_visual"
  | "companion_say"
  // Flat aliases for high-frequency actions. They keep the same executor,
  // confirmation and receipt semantics as their domain action; the only
  // difference is that the model does not have to select an action first.
  // Split delivery has no alias: the host splits the reply, so there is no
  // "send another message" action for the model to choose.
  | "companion_self_note_write"
  | "companion_memory_forget"
  | "companion_goal_start"
  | "companion_memory_save";

export const COMPANION_DOMAIN_ACTIONS: Readonly<Record<CompanionDomainToolName, readonly string[]>> = Object.freeze({
  companion_open: ["note", "page", "card"],
  companion_web: ["search", "read_document"],
  companion_notes_read: ["search", "read", "source", "cards"],
  companion_notes_write: ["create", "edit", "share", "annotate"],
  companion_memory_read: ["read", "recall", "past_conversation", "playbook", "diary"],
  companion_memory_write: ["save", "forget", "revise", "move", "judgment"],
  companion_attention_read: ["participation", "reminders"],
  companion_attention_write: ["save_participation", "arrange", "schedule_wake", "schedule_reminder", "cancel_reminder", "pause"],
  companion_persona_read: ["identity", "self_notes"],
  companion_persona_write: ["self_note", "identity", "style", "tags", "activeness", "boundary"],
  companion_goals_read: ["list", "list_long"],
  companion_goals_write: ["start", "revise", "control"],
  companion_observe: ["context", "current_page", "history", "stats", "activity", "calculate"],
  companion_visual: ["read_image", "show_image", "diagram"],
  companion_say: ["publish", "finish_participation"],
  companion_self_note_write: ["self_note"],
  companion_memory_forget: ["forget"],
  companion_goal_start: ["start"],
  companion_memory_save: ["save"],
});

/** Action → internal operation id. The operation owns the executor branch,
 * policy checks, labels and durable receipt semantics. */
export const COMPANION_DOMAIN_OPERATIONS: Readonly<Record<CompanionDomainToolName, Readonly<Record<string, string>>>> =
  Object.freeze({
    companion_open: { note: "open.note", page: "open.page", card: "open.card" },
    companion_web: { search: "web.search", read_document: "web.read_document" },
    companion_notes_read: {
      search: "notes.read.search", read: "notes.read.read", source: "notes.read.source", cards: "notes.read.cards",
    },
    companion_notes_write: {
      create: "notes.write.create", edit: "notes.write.edit", share: "notes.write.share", annotate: "notes.write.annotate",
    },
    companion_memory_read: {
      read: "memory.read.read", recall: "memory.read.recall", past_conversation: "memory.read.past_conversation",
      playbook: "memory.read.playbook", diary: "memory.read.diary",
    },
    companion_memory_write: {
      save: "memory.write.save", forget: "memory.write.forget", revise: "memory.write.revise",
      move: "memory.write.move", judgment: "memory.write.judgment",
    },
    companion_attention_read: {
      participation: "attention.read.participation", reminders: "attention.read.reminders",
    },
    companion_attention_write: {
      save_participation: "attention.write.save_participation", arrange: "attention.write.arrange",
      schedule_wake: "attention.write.schedule_wake", schedule_reminder: "attention.write.schedule_reminder",
      cancel_reminder: "attention.write.cancel_reminder", pause: "attention.write.pause",
    },
    companion_persona_read: {
      identity: "persona.read.identity", self_notes: "persona.read.self_notes",
    },
    companion_persona_write: {
      self_note: "persona.write.self_note", identity: "persona.write.identity", style: "persona.write.style",
      tags: "persona.write.tags", activeness: "persona.write.activeness", boundary: "persona.write.boundary",
    },
    companion_goals_read: { list: "goals.read.list", list_long: "goals.read.list_long" },
    companion_goals_write: {
      start: "goals.write.start", revise: "goals.write.revise", control: "goals.write.control",
    },
    companion_observe: {
      context: "observe.context", current_page: "observe.current_page", history: "observe.history",
      stats: "observe.stats", activity: "observe.activity", calculate: "observe.calculate",
    },
    companion_visual: {
      read_image: "visual.read_image", show_image: "visual.show_image", diagram: "visual.diagram",
    },
    companion_say: { publish: "say.publish", finish_participation: "say.finish_participation" },
    companion_self_note_write: { self_note: "persona.write.self_note" },
    companion_memory_forget: { forget: "memory.write.forget" },
    companion_goal_start: { start: "goals.write.start" },
    companion_memory_save: { save: "memory.write.save" },
  });

/** Conversation-level actions that keep the interpreter's pre-authorized path. */
export const COMPANION_DOMAIN_AUTO_ACTIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  companion_notes_write: ["annotate"],
  companion_attention_write: ["save_participation", "arrange", "schedule_wake"],
  companion_say: ["publish", "finish_participation"],
  companion_persona_write: ["self_note", "identity", "style", "tags"],
  companion_self_note_write: ["self_note"],
  // activeness/boundary stay gated: they change how often she speaks to the user.
});

export const COMPANION_DOMAIN_CONFIRM_ACTIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  companion_notes_write: ["edit_delete"],
  companion_memory_write: ["forget", "revise"],
  companion_memory_forget: ["forget"],
  companion_attention_write: ["cancel_reminder", "pause"],
  // Both change how often or how far she speaks to the user; neither is a
  // wording preference, so both keep the confirmation at every tier.
  companion_persona_write: ["activeness", "boundary"],
});

export function companionDomainOperation(toolName: string, action: unknown): string | null {
  if (typeof action !== "string") return null;
  const map = (COMPANION_DOMAIN_OPERATIONS as Record<string, Record<string, string>>)[toolName];
  return map?.[action] ?? null;
}

export function companionDomainAction(args: Record<string, unknown> | undefined | null): string | null {
  if (typeof args?.action === "string") return args.action;
  // `companion_open` selects its target with `target` (note/page/card).
  return typeof args?.target === "string" ? args.target : null;
}

/**
 * Flat aliases carry no `action`; each stands for exactly one action. Keeping
 * the mapping here (rather than only in the executor) is what lets every
 * reader — ledger, confirmation, receipt counting, pre-execution resolution —
 * see the same internal operation for the same call.
 */
export const COMPANION_FLAT_ALIAS_ACTION: Readonly<Record<string, string>> = Object.freeze({
  companion_self_note_write: "self_note",
  companion_memory_forget: "forget",
  companion_goal_start: "start",
  companion_memory_save: "save",
});

/** Internal operation id for a model-facing call; undeclared tools stay as-is. */
export function companionOperationName(args: { name: string; arguments?: Record<string, unknown> }): string {
  const action = companionDomainAction(args.arguments) ?? COMPANION_FLAT_ALIAS_ACTION[args.name] ?? null;
  return companionDomainOperation(args.name, action) ?? args.name;
}

/**
 * Flat split-delivery aliases carry no `action`; each stands for one publish.
 * `begin`/`end` also decide `final` by tool name, so the flag is read here
 * rather than assumed from the arguments.
 */
const COMPANION_FLAT_SAY_FINAL: Readonly<Record<string, boolean | undefined>> = Object.freeze({
});

export function isCompanionPublicationCall(args: { name: string; arguments?: Record<string, unknown> | null }): boolean {
  return companionOperationName({ name: args.name, ...(args.arguments ? { arguments: args.arguments } : {}) }) === "say.publish"
    || args.name in COMPANION_FLAT_SAY_FINAL;
}

/** `final` for a publication call; null when the call is not one. */
export function companionPublicationFinal(args: { name: string; arguments?: Record<string, unknown> | null }): boolean | null {
  if (!isCompanionPublicationCall(args)) return null;
  const fixed = COMPANION_FLAT_SAY_FINAL[args.name];
  if (fixed !== undefined) return fixed;
  return (args.arguments as { final?: boolean } | null | undefined)?.final !== false;
}

export function companionDomainActionRequiresConfirmation(toolName: string, args: Record<string, unknown>): boolean {
  // A flat alias carries no `action`; its single action decides the gate, so a
  // `companion_memory_forget` call is confirmed exactly like `action=forget`.
  const action = companionDomainAction(args) ?? COMPANION_FLAT_ALIAS_ACTION[toolName] ?? null;
  if (!action) return false;
  if (toolName === "companion_notes_write" && action === "edit"
    && typeof args.operation === "string" && args.operation.startsWith("delete")) return true;
  return (COMPANION_DOMAIN_CONFIRM_ACTIONS[toolName] ?? []).includes(action);
}

export function companionDomainActionAutoExecutes(toolName: string, args: Record<string, unknown>): boolean {
  const action = companionDomainAction(args) ?? COMPANION_FLAT_ALIAS_ACTION[toolName] ?? null;
  return action !== null && (COMPANION_DOMAIN_AUTO_ACTIONS[toolName] ?? []).includes(action);
}

/** Executors parse their own narrow input shapes. A domain call carries the
 * union of every action's fields, so each operation receives only the fields
 * its executor accepts. */
const OPERATION_ARGUMENT_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "notes.write.create": ["title", "markdown", "links"],
  "notes.write.edit": ["noteId", "noteVersionId", "operation", "markdown", "preserveBlockStructure",
    "startBlock", "endBlock", "expectedBlocks"],
  "notes.write.share": ["noteId", "shareScope"],
  "notes.write.annotate": ["markdown", "final"],
  "memory.write.save": ["kind", "content", "sourceQuote", "appliesWhen", "validFrom", "validUntil"],
  "memory.write.forget": ["memoryId", "query"],
  "memory.write.revise": ["memoryId", "expectedRevision", "content", "appliesWhen", "validFrom", "validUntil"],
  "memory.write.move": ["memoryId", "tier"],
  "memory.write.judgment": ["text", "sourceEventIds", "epistemicStatus"],
  "attention.write.save_participation": ["expectedRevision", "markdown", "enabled", "sourceQuote"],
  "attention.write.arrange": ["key", "expectedRevision", "intent", "topics", "state",
    "nextReviewAt", "expiresAt", "preferenceRevision", "selfNote"],
  "attention.write.schedule_wake": ["key", "expectedRevision", "at", "reason"],
  "attention.write.schedule_reminder": ["text", "fireAtLocal", "noteId"],
  "attention.write.cancel_reminder": ["reminderId"],
  "attention.write.pause": ["scope", "reason"],
  "say.publish": ["text", "final"],
  "say.finish_participation": ["decision"],
  "persona.write.self_note": ["key", "expectedRevision", "title", "body", "tier",
    "nextReviewAt", "expiresAt", "reason"],
  "persona.write.identity": ["document", "reason"],
  "persona.write.style": ["speakingStyle", "reason"],
  "persona.write.tags": ["personalityTags", "reason"],
  "persona.write.activeness": ["activeness"],
  "persona.write.boundary": ["allowPlayful", "allowNudgeLearning", "allowVoiceTags", "catchphrase"],
  "goals.write.start": ["inputs", "longGoal"],
  "goals.write.revise": ["runId", "expectedRevision", "goal", "longGoal"],
  "goals.write.control": ["runId", "expectedRevision"],
});

export function companionOperationArguments(operation: string, args: Record<string, unknown>): Record<string, unknown> {
  const fields = OPERATION_ARGUMENT_FIELDS[operation];
  if (!fields) {
    const { action: _action, ...rest } = args;
    return rest;
  }
  return Object.fromEntries(fields.filter(field => args[field] !== undefined).map(field => [field, args[field]]));
}

/**
 * Reverse map: operation id → the model-facing tool that declares it.
 *
 * Several tools can reach one operation (a domain tool plus its flat aliases).
 * The domain tool must win: its schema takes an `action`, so a frozen
 * confirmation replays as `{action, ...fields}`. A flat alias would reject that
 * payload as unrecognized keys.
 */
const OPERATION_DOMAIN_TOOL = new Map<string, CompanionDomainToolName>();
for (const [domain, actions] of Object.entries(COMPANION_DOMAIN_OPERATIONS)) {
  if (domain in COMPANION_FLAT_ALIAS_ACTION) continue;
  for (const operation of Object.values(actions)) {
    if (!OPERATION_DOMAIN_TOOL.has(operation)) OPERATION_DOMAIN_TOOL.set(operation, domain as CompanionDomainToolName);
  }
}

/** Authorization snapshots contain the model-facing domain tool; ledger rows
 * contain the internal operation. This is the bridge between them. */
export function companionOperationDomainTool(operation: string): CompanionDomainToolName | null {
  return OPERATION_DOMAIN_TOOL.get(operation) ?? null;
}

/** Reverse of an operation id: the action it was dispatched from. The ledger keeps
 * only operation-scoped fields, so anything recomputing a policy decision needs
 * the action back to see the same shape the caller used. Domain tools win over
 * flat aliases for the same reason as above: their schema carries `action`. */
const OPERATION_ACTION = new Map<string, string>();
for (const [domain, actions] of Object.entries(COMPANION_DOMAIN_OPERATIONS)) {
  if (domain in COMPANION_FLAT_ALIAS_ACTION) continue;
  for (const [action, operation] of Object.entries(actions)) {
    if (!OPERATION_ACTION.has(operation)) OPERATION_ACTION.set(operation, action);
  }
}

/** Reverse of an operation id: the action it was dispatched from. The ledger keeps
 * only operation-scoped fields, so anything recomputing a policy decision needs
 * the action back to see the same shape the caller used. */
export function companionOperationAction(operation: string): string | null {
  return OPERATION_ACTION.get(operation) ?? null;
}

/** Audit labels for internal operations; the model never sees these names. */
export const COMPANION_OPERATION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  "open.note": "正在打开那篇笔记",
  "open.page": "正在带你去那个页面",
  "open.card": "正在打开那张卡",
  "web.search": "正在联网搜索",
  "web.read_document": "正在读公开文档",
  "notes.read.search": "正在翻你的笔记",
  "notes.read.read": "正在读那篇笔记",
  "notes.read.source": "正在读来源正文",
  "notes.read.cards": "正在翻你的学习卡",
  "notes.write.create": "正在写成笔记",
  "notes.write.edit": "正在调整笔记正文",
  "notes.write.share": "正在处理共享",
  "notes.write.annotate": "正在写原句解释",
  "memory.read.read": "正在读那条记忆",
  "memory.read.recall": "正在想你说过的事",
  "memory.read.past_conversation": "正在翻更早的对话",
  "memory.read.playbook": "正在查阅合作方法",
  "memory.read.diary": "正在读日记",
  "memory.write.save": "正在记住这件事",
  "memory.write.forget": "正在忘掉那一条",
  "memory.write.revise": "正在修订记忆",
  "memory.write.move": "正在调整这条记忆的保存位置",
  "memory.write.judgment": "正在记下自己的想法",
  "attention.read.participation": "正在看看我们的相处偏好",
  "attention.read.reminders": "正在看你约过的提醒",
  "attention.write.save_participation": "正在记住我们的相处方式",
  "attention.write.arrange": "正在安排接着关注",
  "attention.write.schedule_wake": "正在安排自己的重评",
  "attention.write.schedule_reminder": "正在记下这个提醒",
  "attention.write.cancel_reminder": "正在撤掉那个提醒",
  "attention.write.pause": "正在收一收学习建议",
  "say.publish": "分次发言",
  "say.finish_participation": "考虑已结束",
  "persona.read.identity": "正在读自己的身份文档",
  "persona.read.self_notes": "正在翻自己的记事",
  "persona.write.self_note": "正在整理自己的记事",
  "persona.write.identity": "正在修订自己的认识",
  "persona.write.style": "正在换一种说话方式",
  "persona.write.tags": "正在换一组性格标签",
  "persona.write.activeness": "正在改活跃度",
  "persona.write.boundary": "正在改行为边界",
  "goals.read.list": "正在看后台目标",
  "goals.read.list_long": "正在看长期目标",
  "goals.write.start": "正在接下目标",
  "goals.write.revise": "正在修改目标要求",
  "goals.write.control": "正在调整后台目标",
  "observe.context": "正在看你的学习上下文",
  "observe.current_page": "正在看你这一页",
  "observe.history": "正在翻之前的对话",
  "observe.stats": "正在看你的学习数据",
  "observe.activity": "正在看最近做了什么",
  "observe.calculate": "正在计算",
  "visual.read_image": "正在看那张图",
  "visual.show_image": "正在把那张图调出来",
  "visual.diagram": "正在画流程图",
});
