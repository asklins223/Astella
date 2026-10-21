/**
 * Declaration-driven tool groups for the companion agent.
 *
 * The full catalog still contains every declared capability. The model only
 * sees a small core + the groups declared for the current page, and can expand
 * the surface itself with `companion_load_tools`. Nothing is removed based on
 * the classifier's guess: candidate operations may only *add* a group.
 */

export const COMPANION_TOOL_GROUP_IDS = [
  "notes",
  "memory",
  "persona",
  "attention",
  "goals",
  "web",
  "visual",
  "stats",
  "navigation",
] as const;
export type CompanionToolGroupId = (typeof COMPANION_TOOL_GROUP_IDS)[number];

export const COMPANION_DIRECT_ENTRY_TOOL_NAMES = ["companion_deepen", "companion_configure_turn"] as const;

export const COMPANION_CORE_TOOL_NAMES: readonly string[] = Object.freeze([
  ...COMPANION_DIRECT_ENTRY_TOOL_NAMES,
  "companion_read_context",
  "companion_read_history",
  "companion_search_notes",
  "companion_read_note",
  "companion_read_memory",
  "companion_recall_memory",
  "companion_save_memory",
  "companion_read_participation",
  "companion_read_identity",
  "companion_read_self_notes",
  "companion_load_tools",
]);

export const COMPANION_TOOL_GROUPS: Readonly<Record<CompanionToolGroupId, {
  readonly label: string;
  readonly description: string;
  readonly tools: readonly string[];
}>> = Object.freeze({
  notes: {
    label: "笔记与来源",
    description: "搜索、读取、新建、修改、共享笔记与来源，学习卡搜索，推荐卡片，打开笔记。",
    tools: [
      "companion_search_notes", "companion_search_cards", "companion_read_note", "companion_read_source",
      "companion_create_note", "companion_edit_note", "companion_share_note",
      "companion_recommend_learning", "companion_write_annotation",
    ],
  },
  memory: {
    label: "长期记忆与手册",
    description: "保存/修订/忘记记忆，记录判断，检索旧对话，读手册、日记，调整记忆容量层。",
    tools: [
      "companion_save_memory", "companion_forget_memory", "companion_revise_memory",
      "companion_remember_judgment", "companion_recall_memory", "companion_read_memory",
      "companion_recall_past_conversation", "companion_move_memory",
      "companion_read_playbook", "companion_read_diary",
    ],
  },
  persona: {
    label: "她自己的表达与边界",
    description: "写自己的记事、身份、语气、标签，调整活跃度与行为边界。",
    tools: [
      "companion_write_self_note", "companion_revise_identity", "companion_revise_own_style",
      "companion_revise_own_tags", "companion_set_activeness", "companion_set_boundary",
    ],
  },
  attention: {
    label: "参与、提醒与关注",
    description: "相处偏好、提醒、关注安排、主动发言、暂停学习建议。",
    tools: [
      "companion_read_participation", "companion_save_participation", "companion_arrange_attention",
      "companion_schedule_wake", "companion_schedule_reminder", "companion_list_reminders",
      "companion_cancel_reminder", "companion_pause_learning_suggestions",
      "companion_publish_utterance", "companion_finish_participation",
    ],
  },
  goals: {
    label: "后台持续目标",
    description: "启动、查看、修改、暂停/继续/停止后台目标，生成速看/脑图/演示/拓展稿。",
    tools: [
      "agent_start_goal", "agent_list_goals", "agent_list_long_goals",
      "agent_revise_goal", "agent_control_goal",
    ],
  },
  web: {
    label: "联网与公开文档",
    description: "联网搜索、读取用户给出的公开 HTTPS 文档。",
    tools: ["agent_web_search", "agent_read_public_document"],
  },
  visual: {
    label: "看图与画图",
    description: "读图、在本地显示用户库里的图片、把步骤画成流程图。",
    tools: ["companion_read_image", "companion_show_image", "companion_render_diagram"],
  },
  stats: {
    label: "进度与当前页面",
    description: "学习统计、最近活动、当前页面/上下文/历史，以及实际计算。",
    tools: [
      "companion_get_learning_stats",
      "companion_list_recent_activity", "companion_read_context", "companion_read_current_page",
      "companion_read_history", "agent_calculate",
    ],
  },
  navigation: {
    label: "带路",
    description: "打开笔记、页面、学习卡，聚焦知识图谱目标。",
    tools: ["companion_open_note", "companion_open_page", "companion_open_card"],
  },
});

const GROUP_BY_TOOL: ReadonlyMap<string, CompanionToolGroupId> = (() => {
  const map = new Map<string, CompanionToolGroupId>();
  for (const group of COMPANION_TOOL_GROUP_IDS) {
    for (const tool of COMPANION_TOOL_GROUPS[group].tools) map.set(tool, group);
  }
  return map;
})();

export function companionToolGroupFor(toolName: string): CompanionToolGroupId | null {
  return GROUP_BY_TOOL.get(toolName) ?? null;
}

/**
 * 每个组是什么，给**装载回执**用。
 *
 * 组名与用途写在这份声明里，但此前只有测试读过——模型看到的只是组 id，
 * 要装 `notes` 还是 `learning` 全靠猜（「搜索学习卡」在 notes 里，而 learning 听起来更近）。
 *
 * 放回执而不是工具描述，是预算决定的：工具面描述单条上限 150 字符、总量 4000，
 * 实测只剩 6 字符余量（`agent-capability-description-budget.test.ts`）。十组说明约 300
 * 字符，塞进描述会直接顶穿；而回执只在装载那一步出现一次，之后不再进请求。
 */
export function companionToolGroupCatalog(groups: Iterable<string>): Array<{
  id: string; label: string; description: string;
}> {
  const seen = new Set<string>();
  const out: Array<{ id: string; label: string; description: string }> = [];
  for (const group of groups) {
    if (!(COMPANION_TOOL_GROUP_IDS as readonly string[]).includes(group)) continue;
    if (seen.has(group)) continue;
    seen.add(group);
    const declared = COMPANION_TOOL_GROUPS[group as CompanionToolGroupId];
    out.push({ id: group, label: declared.label, description: declared.description });
  }
  return out;
}

/** Groups declared for a page kind. This is a host fact, not an intent guess. */
export const COMPANION_PAGE_TOOL_GROUPS: Readonly<Record<string, readonly CompanionToolGroupId[]>> = Object.freeze({
  note: ["notes", "visual"],
  source: ["notes", "visual"],
  star_map: ["navigation"],
  settings: ["persona"],
  conversation: ["stats"],
  other: ["stats"],
});

export function companionPageToolGroups(pageKind: string | null | undefined): readonly CompanionToolGroupId[] {
  return COMPANION_PAGE_TOOL_GROUPS[pageKind ?? "other"] ?? COMPANION_PAGE_TOOL_GROUPS.other!;
}

/** Union of tool names from the given groups. */
export function resolveCompanionToolGroupNames(groups: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const group of groups) {
    if (!(COMPANION_TOOL_GROUP_IDS as readonly string[]).includes(group)) continue;
    for (const tool of COMPANION_TOOL_GROUPS[group as CompanionToolGroupId].tools) out.add(tool);
  }
  return out;
}

/**
 * The initial surface for one turn: core + page groups + the groups of any
 * candidate operations the interpreter named. Candidate operations may only
 * add groups; they never remove one.
 */
export function resolveCompanionInitialToolNames(input: {
  availableToolNames: readonly string[];
  pageKind?: string | null;
  candidateOperations?: readonly string[];
}): Set<string> {
  const available = new Set(input.availableToolNames);
  const names = new Set<string>();
  for (const name of COMPANION_CORE_TOOL_NAMES) {
    if (available.has(name)) names.add(name);
  }
  const groups = new Set<CompanionToolGroupId>(companionPageToolGroups(input.pageKind));
  for (const candidate of input.candidateOperations ?? []) {
    const group = companionToolGroupFor(candidate);
    if (group) groups.add(group);
  }
  for (const name of resolveCompanionToolGroupNames(groups)) {
    if (available.has(name)) names.add(name);
  }
  // The loader itself must always be reachable; otherwise the surface is closed.
  if (available.has("companion_load_tools")) names.add("companion_load_tools");
  return names;
}
