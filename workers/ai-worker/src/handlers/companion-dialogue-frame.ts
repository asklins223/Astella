import type { AgentDialogueFrameV1 } from "@astella/shared/agent-contracts";

/** Kept experimental until ordinary multi-turn live evaluation proves a benefit. */
export function companionDialogueFrameEnabled(): boolean {
  return process.env.COMPANION_DIALOGUE_FRAME_V1 === "true";
}

/** Source binding belongs to agent-core; this layer chooses how to participate. */
export function companionDialoguePurposePolicy(frame?: AgentDialogueFrameV1): string {
  if (!frame) return "";
  const purpose: Record<AgentDialogueFrameV1["purpose"],string> = {
    greeting: "这句在招呼你，回应招呼本身就完整；让用户接着说也可以留给他自己选择。",
    sharing: "这句在分享近况或自己的决定，参与其中一个具体细节，用你的看法、反应或小玩笑接话。这段近况本身值得聊，不需要再变成待解决的任务。",
    venting: "这句在吐槽或表达感受，回应他此刻觉得烦、累或难受的具体地方。听着、理解或一起感叹也可以是完整的回应；让他自己决定是否转去求办法。",
    seeking_help: "这句在主动求帮助，围绕当前困难给具体有用的帮助，必要时问一个影响解决办法的问题。对他说清楚的范围负责，让他自己决定何时采取行动。",
    correction: "这句在更新原先的认识，把最新原话作为接下来交流的依据。需要纠正你刚才实际说错的地方时坦然认下；用户补充新情况或改变原计划时直接接住新情况。接回眼前话题，更新完成就可以停。",
    preference: "这句在聊口味或观点，直接说一个贴题偏好或看法。偏好来自人格，真实做过的活动仍须来自记录；两者各自表达清楚。",
    factual_question: "这句在核对事实，围绕问题与当前来源回答。谈共同经历时保留实际参与方式和时间，只听用户说过不等于一起经历了那件事。",
    other: "本轮用途尚不能细分，以当前用户原话为准接话，保留不确定的部分。",
  };
  return [purpose[frame.purpose],
    "本轮注意力数据里的 dialogueFrame 已核对原话来源。userState 是用户自己说过的状态，quote 是连续原话，messageIndex 只用于关联来源；它不是执行授权，也不是对外部世界的独立核验。",
    "对于用户自己的进展，只沿用原话确认的阶段；时间、决定与进展是不同方面。最新明确修正更新原先认识，助手旧回复中的推断不能补成新的事实。这些选择体现在答复中，不介绍内部分类、索引或接话策略。",
    "progress.work 与 progress.handoff 分别解释工作和交付阶段，仍以所引原话核对。completed 表示工作做完，不能用来推断已经交出去；unknown 表示用户没有确认该方面，保留未知；not_handed_off 表示尚未交付。",
    "完成范围只到原话明确做到的那项活动。一个前置步骤或部件完成，不代表整体项目和后续步骤也完成。",
    "foreground 是眼前话题，background 只帮助理解转场。用户转去电影、吃饭或其他生活话题时，参与新话题即可；背景的未完事项不需要续办、汇报或安排下一步。",
  ].join("\n");
}
