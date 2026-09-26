/**
 * 任务记忆的身份绑定（39d W6-2 / 39b C8；D6 §⑥ 的"两条路二选一"）。
 *
 * 改前的事实：`deriveMemoryScope` 按 pageKind 猜出 "task"，但**没有任何 run/task
 * 维度跟着落库**——scope='task' 的记忆召回时对任何 task 页都可见，"这一轮的临时
 * 状态"会漏进"那一轮"的上下文。语义相关性代替不了身份约束。
 *
 * 本模块把"任务身份"变成两个方向都用的同一样东西：
 *  - **写入侧**（companion-memory-extractor）：task 记忆落库时必须带
 *    `memory_links(entity_type, entity_id)`——从 turn 持久化的 page_context 推导
 *    （learning_run→runId；card/review→cardId）。**推不出身份就不落 task**，
 *    降级 workspace（缺绑定不能默认为全任务通用）。
 *  - **召回侧**（companion-memory-vector）：scope='task' 的行只在"当前任务身份
 *    与某条 link 相等"时可见；当前上下文没有任务身份 ⇒ 一条 task 行都看不见。
 *
 * 身份取自 `companion_turn_runs.page_context`（API `sanitizeContext` 收窄后的
 * 审计形状，turn-service.ts:63-110）：learning_run 页带 runId，card/review 页带
 * cardId。这是**服务端落的形状**，不是渲染层说什么就是什么。
 */

export interface CompanionTaskEntityRef {
  /** memory_links.entity_type 的合法取值（card | key_point | note | source | learning_run）。 */
  readonly entityType: "learning_run" | "card";
  readonly entityId: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 从持久化 page_context 推导当前任务身份；推不出（非任务页 / 缺 id / 形状不对）
 * 返回 null——调用方据此把 task 记忆降级 workspace、或让召回对 task 行不可见。
 */
export function taskEntityFromPersistedPageContext(
  pageContext: unknown,
): CompanionTaskEntityRef | null {
  if (!pageContext || typeof pageContext !== "object") return null;
  const context = (pageContext as { context?: unknown }).context;
  if (!context || typeof context !== "object") return null;
  const pageKind = (context as { pageKind?: unknown }).pageKind;
  const entityIdOf = (key: string): string | null => {
    const value = (context as Record<string, unknown>)[key];
    return typeof value === "string" && UUID_PATTERN.test(value) ? value : null;
  };
  if (pageKind === "learning_run") {
    const runId = entityIdOf("runId");
    return runId ? { entityType: "learning_run", entityId: runId } : null;
  }
  if (pageKind === "card" || pageKind === "review") {
    const cardId = entityIdOf("cardId");
    return cardId ? { entityType: "card", entityId: cardId } : null;
  }
  return null;
}
