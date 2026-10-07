/**
 * 伴星这一轮要不要开思考（2026-10-06 用户决定，取代「全链路常开最高档」）。
 *
 * 判据用**本轮已经算出来的注意力解释**，不再猜：
 * - 对话用途为纠正，或有明确进展/时间状态需要核对 → 开，语气仍是当前人格。
 * - 其他纯闲聊（`intent=conversation` 且 `toolUse=none`）→ 请求关闭。这一类话要的是即时与轻，
 *   高档思考把它拖到几十秒，用户体感就是「她还没说完上一条」。
 * - 提问、任务、混合、任务控制，或本轮要看要动工具（read/act/uncertain）→ 开，
 *   按模型档案声明的默认档（当前是 high）。解释概念、带路、读图都在这一类。
 * - 注意力解释本身失败时是 `intent=question` + `toolUse=uncertain`（见 agent-core 的
 *   `resolveAgentTurnInterpretation` 兜底），所以**判不出来时按开处理**：宁可慢一点，
 *   也不要把一个可能要看东西的轮次降级成随口答。
 *
 * 这里只决定「这一轮开不开」，档位仍归模型档案（`platforms.X.models.Y.reasoning`）：
 * provider 收到关闭请求时按档案取能关到的最低档，声明了 `none` 才是真关。
 */
export type CompanionTurnThinkingInput = {
  readonly intent?: string;
  readonly toolUse?: string;
  readonly dialogueFrame?: Pick<import("@astella/shared/agent-contracts").AgentDialogueFrameV1,"purpose"|"userState">;
} | null | undefined;

/** Casual tone does not make chronology or an explicit correction trivial. */
export function companionDialogueNeedsGrounding(attention: CompanionTurnThinkingInput): boolean {
  const frame=attention?.dialogueFrame;
  return frame?.purpose === "correction" || Boolean(frame?.userState.some(state =>
    state.relevance !== "background" && (state.aspect === "progress" || state.aspect === "timing")));
}

export interface CompanionTurnThinking {
  readonly disableThinking: boolean;
  /** 一句话理由，进日志与观测：延迟异常时先查这一格。 */
  readonly basis: string;
}

export function companionTurnThinking(attention: CompanionTurnThinkingInput): CompanionTurnThinking {
  const intent = attention?.intent ?? "question";
  const toolUse = attention?.toolUse ?? "uncertain";
  const wantsTool = toolUse !== "none";
  if (intent === "conversation" && !wantsTool && companionDialogueNeedsGrounding(attention))
    return { disableThinking: false, basis: "dialogue:user-state-or-correction" };
  if (intent === "conversation" && !wantsTool) {
    return { disableThinking: true, basis: "casual:conversation+no-tool" };
  }
  return { disableThinking: false, basis: `thinking:${intent}/${toolUse}` };
}
