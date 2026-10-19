/**
 * 分类器黄金集：每一条都是真实用户口吻，写明这一轮**必须**成立的判定。
 *
 * 只断言"影响行为的字段"：intent / toolUse / candidateOperations（包含关系）/
 * goalRelation。不断言 phrasing、不做逐字对比；判定用"必须包含某候选"而不是全等，
 * 因为候选只是把工具组放回她面前，多一个不改变授权。
 *
 * 这些句子来自生产事故、窗口验收记录与 plan 29/42 的边界句，不来自模型自己生成。
 */
export interface ClassifierGoldenCase {
  readonly id: string;
  readonly text: string;
  /** 真实历史里紧挨着这一句的上一轮回复（只给分类器看，不继承任务）。 */
  readonly recentReply?: string;
  readonly expect: {
    readonly toolUse: "none" | "read" | "act" | "uncertain";
    readonly candidatesAny?: readonly string[];
    readonly candidatesAll?: readonly string[];
    readonly goalRelation?: "new" | "unrelated" | "continue" | "revise" | "control" | "discuss" | "unclear";
    readonly intent?: "conversation" | "question" | "task" | "task_control" | "mixed";
  };
}

export const CLASSIFIER_GOLDEN_CASES: readonly ClassifierGoldenCase[] = [
  // ── 产物生成：必须拿到入口，不能在聊天里编一段充数 ──
  { id: "overview-current-note", text: "给我生成这篇笔记的速看吧", expect: { toolUse: "act", candidatesAny: ["agent_start_goal"], goalRelation: "new" } },
  { id: "overview-casual", text: "帮我速看一下", expect: { toolUse: "act", candidatesAny: ["agent_start_goal"] } },
  { id: "mind-map", text: "给这篇笔记画个思维导图", expect: { toolUse: "act", candidatesAny: ["agent_start_goal"] } },
  { id: "dynamic-demo", text: "做一个动画演示讲讲这段", expect: { toolUse: "act", candidatesAny: ["agent_start_goal"] } },
  { id: "expansion", text: "从这篇往外学，先生成草稿我挑，不要制卡", expect: { toolUse: "act", candidatesAny: ["agent_start_goal"] } },
  { id: "cards", text: "根据这篇笔记生成学习卡", expect: { toolUse: "act", candidatesAny: ["agent_start_goal"] } },
  { id: "stale-denial", text: "生成拓展笔记", recentReply: "速看和拓展能力没有接上，这轮只能在聊天里写文字。", expect: { toolUse: "act", candidatesAny: ["agent_start_goal"] } },
  // ── 新建笔记：一条原话一次保存，不走后台目标 ──
  { id: "new-notes-topic", text: "给我生成几个历史的笔记", expect: { toolUse: "act", candidatesAny: ["companion_create_note"] } },
  { id: "new-note-from-chat", text: "把刚才聊的电功率写成一篇笔记", expect: { toolUse: "act", candidatesAny: ["companion_create_note"] } },
  { id: "new-note-organize", text: "把这三块整理成笔记", expect: { toolUse: "act", candidatesAny: ["companion_create_note"] } },
  // ── 编辑当前笔记：只动当前正文 ──
  { id: "edit-format", text: "把这篇笔记的格式整理一下", expect: { toolUse: "act", candidatesAny: ["companion_edit_note"] } },
  { id: "edit-selection", text: "把选中的这一段改成表格", expect: { toolUse: "act", candidatesAny: ["companion_edit_note"] } },
  // ── 读/查：只回答问题，不写 ──
  { id: "read-note", text: "这篇笔记讲了什么？先读原文再回答", expect: { toolUse: "read", candidatesAny: ["companion_read_note"] } },
  { id: "chitchat-read-only", text: "帮我速看一下，在聊天里概括就好，不生成任何东西", expect: { toolUse: "read", candidatesAny: ["companion_read_note"] } },
  { id: "search-notes", text: "我库里有没有讲机会成本的笔记", expect: { toolUse: "read", candidatesAny: ["companion_search_notes"] } },
  { id: "due-reviews", text: "今天有多少要复习的", expect: { toolUse: "read", candidatesAny: ["companion_list_due_reviews"] } },
  // ── 纯聊天/提问：不能误启动工具或目标 ──
  { id: "term-question", text: "往外学是什么意思？", expect: { toolUse: "none" } },
  { id: "not-studying", text: "今天不想学习", expect: { toolUse: "none" } },
  { id: "casual-tired", text: "今天有点累，随便聊聊", expect: { toolUse: "none" } },
  { id: "knowledge-question", text: "为什么白天天空是蓝色的？", expect: { toolUse: "none" } },
  // ── 后台目标控制：必须落到已有 run 上 ──
  { id: "goal-control", text: "刚才那件事先停一下", expect: { toolUse: "act", candidatesAny: ["agent_control_goal"] } },
  // ── 边界：情绪 + 请求混在一句 ──
  { id: "mixed-request", text: "有点烦，但还是帮我把这篇笔记的速看生成一下吧", expect: { toolUse: "act", candidatesAny: ["agent_start_goal"] } },
];
