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
  "companion_observe",
  "companion_notes_read",
  "companion_notes_write",
  "companion_memory_read",
  "companion_memory_write",
  "companion_attention_read",
  "companion_attention_write",
  "companion_send_message",
  "companion_persona_read",
  "companion_persona_write",
  "companion_visual",
  "companion_goals_read",
  "companion_goals_write",
  "companion_finish",
  "companion_load_tools",
]);

/**
 * 高频应用动作，不随本轮意图分类进出工具面。
 *
 * 2026-10-25 实机：分类器一次解析失败，候选操作为空，手机端又没有当前笔记页，
 * 于是 `companion_edit_note` 根本不在工具面里；模型照着历史里上一次成功的编辑，
 * 回了一句“保存回执 succeeded”。工具面按声明给，不按猜测给——这些是已授权
 * 用户最常要求的动作，先把它们放进默认面；其余能力仍可用 `companion_load_tools`
 * 展开。它们只扩大可见视图，执行侧的权限、确认与回执校验不变。
 */
export const COMPANION_COMMON_ACTION_TOOL_NAMES: readonly string[] = Object.freeze([
  "companion_notes_write",
  "companion_memory_write",
  "companion_attention_write",
  "companion_persona_write",
  "companion_open",
  "companion_goals_write",
  // A diagram is a general deliverable, not a note-page affordance. Keeping it
  // out of the common surface made "draw this as a flowchart" fall back to a
  // code block on pages that did not declare the visual group.
  "companion_visual",
  // Flat aliases: same operations, simpler model-facing choice.
  "companion_self_note_write",
  "companion_memory_forget",
  "companion_goal_start",
  "companion_memory_save",
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
      "companion_notes_read", "companion_notes_write", "companion_recommend_learning",
    ],
  },
  memory: {
    label: "长期记忆与手册",
    description: "保存/修订/忘记记忆，记录判断，检索旧对话，读手册、日记，调整记忆容量层。",
    tools: [
      "companion_memory_read", "companion_memory_write",
    ],
  },
  persona: {
    label: "她自己的表达与边界",
    description: "写自己的记事、身份、语气、标签，调整活跃度与行为边界。",
    tools: [
      "companion_persona_read", "companion_persona_write",
    ],
  },
  attention: {
    label: "参与、提醒与关注",
    description: "相处偏好、提醒、关注安排、主动发言、暂停学习建议。",
    tools: [
      "companion_attention_read", "companion_attention_write", "companion_send_message",
    ],
  },
  goals: {
    label: "后台持续目标",
    description: "启动、查看、修改、暂停/继续/停止后台目标，生成速看/脑图/演示/拓展稿。",
    tools: [
      "companion_goals_read", "companion_goals_write",
    ],
  },
  web: {
    label: "联网与公开文档",
    description: "联网搜索、读取用户给出的公开 HTTPS 文档。",
    tools: ["companion_web"],
  },
  visual: {
    label: "看图与画图",
    description: "读图、在本地显示用户库里的图片、把步骤画成流程图。",
    tools: ["companion_visual"],
  },
  stats: {
    label: "进度与当前页面",
    description: "学习统计、最近活动、当前页面/上下文/历史，以及实际计算。",
    tools: [
      "companion_observe",
    ],
  },
  navigation: {
    label: "带路",
    description: "打开笔记、页面、学习卡，聚焦知识图谱目标。",
    tools: ["companion_open"],
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
  hasImageAttachments?: boolean;
}): Set<string> {
  const available = new Set(input.availableToolNames);
  const names = new Set<string>();
  for (const name of COMPANION_CORE_TOOL_NAMES) {
    if (available.has(name)) names.add(name);
  }
  // Common application actions are declaration-driven. A wrong or missing
  // interpretation must not remove the user's ability to act.
  for (const name of COMPANION_COMMON_ACTION_TOOL_NAMES) {
    if (available.has(name)) names.add(name);
  }
  const groups = new Set<CompanionToolGroupId>(companionPageToolGroups(input.pageKind));
  // Intent candidates do not add or remove groups. The model expands the
  // surface itself with companion_load_tools when it needs another capability.
  for (const name of resolveCompanionToolGroupNames(groups)) {
    if (available.has(name)) names.add(name);
  }
  // A validated image attached to this turn is a host fact, independent of
  // page or intent classification. The policy-filtered catalog still owns permission.
  if (input.hasImageAttachments && available.has("companion_visual")) names.add("companion_visual");
  // The loader itself must always be reachable; otherwise the surface is closed.
  if (available.has("companion_load_tools")) names.add("companion_load_tools");
  return names;
}
