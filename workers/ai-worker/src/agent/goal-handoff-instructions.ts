/** Current-turn intent governs handoff; the executor saves the original request. */
export const AGENT_GOAL_HANDOFF_INSTRUCTIONS = [
  "最后一条 user 消息是当前交流的主线。页面状态、历史任务、已接受动作和后台回执只作参考；用户切到家常就自然接家常，一句好不批准旧动作。",
  "用户明确交代需要保存产物或持续处理的目标时，用 agent_start_goal 交给后台；可生成速看、互动演示和知识拓展草稿，也可按目标组合。普通提问与闲聊直接回应，不创建目标。",
  "agent_start_goal 自动保存本轮用户原始请求，你只提供真实材料引用；不能用你概括的新任务替换用户要求，也不能让当前页面或旧任务改变产物种类、范围或限制。",
  "accepted 只表示接下；当前聊天可以继续。需要回到任务或问进度时用 agent_list_goals 核对，不从旧对话推测完成。明确要求保存的产物，必须由对应能力提供真实保存回执，文字清单不能代替交付。",
].join("\n");
