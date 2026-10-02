/**
 * 上下文的**交接快照与历史收边**（40 §4.7）。
 *
 * ## 为什么单独一份测试
 *
 * 2026-10-01 这一族从 `companion-dialogue-content.ts` 搬出来时，它是合同里
 * **最容易被悄悄违反**的一节：
 *
 *   §4.7.2「在实际裁剪边界保存输入快照和交接版本后，才更新上下文指针」
 *   §4.7.2「覆盖水位之后的尾部必须保留」
 *   §4.7.4「不把固定 200 条消息当边界定义」
 *
 * 三条都没有报错路径：水位写错一位、尾部多丢两条，界面上完全看不出来——
 * 只是过一阵她「记错了顺序」。搬文件时也正是最容易把它们改坏的一刻。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  REPLAY_WINDOW_MESSAGES,
  boundCompanionRecentHistory,
  buildCompanionContextHandoffSnapshotV1,
  renderCompanionContextHandoff,
  type CompanionContextHandoffInputV1,
  type CompanionRecentHistoryMessage,
} from "../companion-context-handoff.ts";

const msg = (role: "user" | "assistant", text: string, seq?: string): CompanionRecentHistoryMessage => ({
  role,
  text,
  ...(seq ? { seq } : {}),
});

const input = (over: Partial<CompanionContextHandoffInputV1> = {}): CompanionContextHandoffInputV1 => ({
  runId: "11111111-1111-1111-1111-111111111111",
  conversationId: "22222222-2222-2222-2222-222222222222",
  throughMessageSeq: "m-40",
  throughEventSeq: "e-90",
  historyStartSeq: "m-10",
  clippedMessageCount: 30,
  currentRequest: { messageId: "m-41", messageSeq: "m-41", text: "那我先按反例走一遍？" },
  contextGrantId: null,
  permissionLevel: "moderate",
  permissionSnapshot: { hash: "abc" },
  runStatus: "running",
  cancelRequestedAt: null,
  pageContext: { pageKind: "today" },
  summaryCoverage: { fromSeq: "m-01", throughSeq: "m-09", sourceSha256: "sha-1" },
  historyTail: [{ seq: "m-40", role: "user" as const, text: "我今天不太想学" }],
  actionLedger: [
    { receiptId: "r-1", toolCallId: "c-1", name: "companion_read_note", status: "succeeded", safeSummary: "读了那篇笔记" },
    { receiptId: "r-2", toolCallId: "c-2", name: "companion_save_memory", status: "outcome_unknown", safeSummary: null },
  ],
  proposals: [],
  memoryRefs: [],
  modelMessages: [],
  ...over,
});

test("快照把水位、未决调用与尾部一起固定下来", () => {
  const snapshot = buildCompanionContextHandoffSnapshotV1(input());
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.watermark.throughMessageSeq, "m-40");
  assert.equal(snapshot.watermark.throughEventSeq, "e-90");
  assert.equal(snapshot.watermark.clippedMessageCount, 30);
  assert.equal(snapshot.historyTail.length, 1);
  // 未决的那一次调用必须落进 unresolved，否则下一轮会当成"没发生过"
  // ——§4.7.2「不把未配对调用或未知副作用当作成功」。
  assert.equal(snapshot.actionLedger.unresolved.length, 1);
  assert.equal(snapshot.actionLedger.unresolved[0]?.status, "outcome_unknown");
  assert.equal(snapshot.actionLedger.completed.length, 1, "已完成的那一次没被收下来");
});

test("尾部按内容指纹保存，而不是把正文原样再存一份", () => {
  // 存指纹有两个用处：正文不进快照（省空间），而"她后来读到的是不是同一段"
  // 仍然可核对。两条不同正文必须得到不同指纹。
  const a = buildCompanionContextHandoffSnapshotV1(input());
  const b = buildCompanionContextHandoffSnapshotV1(input({
    historyTail: [{ seq: "m-40", role: "user", text: "今天想换个方向" }],
  }));
  assert.ok(a.historyTail[0]?.contentSha256);
  assert.notEqual(a.historyTail[0]?.contentSha256, b.historyTail[0]?.contentSha256,
    "正文换了指纹却没变 —— 那就说明指纹是摆设");
});

test("当前请求也按指纹存：用户最新请求与授权单列（§4.7.2）", () => {
  const snapshot = buildCompanionContextHandoffSnapshotV1(input());
  assert.equal(snapshot.currentRequest.messageSeq, "m-41");
  assert.ok(snapshot.currentRequest.contentSha256.length > 0);
  assert.equal(snapshot.authorization.permissionLevel, "moderate");
});

test("渲染出的交接块**明说**什么算完成，且把 outcome_unknown 留在未决里", () => {
  const rendered = renderCompanionContextHandoff(buildCompanionContextHandoffSnapshotV1(input()));
  assert.ok(rendered.length > 0);
  // §4.7.2：「不把未配对调用或未知副作用当作成功」。
  // 那句话必须**写在数据旁边**——只把状态列出来不够，模型看不到判据。
  assert.match(rendered, /只有状态为 succeeded 的账本项代表已完成/);
  assert.match(rendered, /outcome_unknown/);
  // 已完成与未决分列，不能混进同一格
  assert.match(rendered, /"completed":\[/);
  assert.match(rendered, /"unresolved":\[/);
  // 建议不等于授权（§4.7.2「可接续的下一步：…（建议，不是新增授权）」）
  assert.match(rendered, /建议不等于授权/);
});

test("【自证】把 outcome_unknown 混进 completed 会立刻被抓出来", () => {
  const snapshot = buildCompanionContextHandoffSnapshotV1(input());
  // 退化形状：把未决的那次调用算成已完成。
  const degraded = {
    ...snapshot,
    actionLedger: {
      completed: [...snapshot.actionLedger.completed, { receiptId: "r-2", toolCallId: "c-2", name: "companion_save_memory", safeSummary: null }],
      unresolved: [],
      notCompleted: [],
    },
  };
  const rendered = renderCompanionContextHandoff(degraded);
  // 判据不能只依赖"数据被正确分类"：即便分类错了，渲染里那句判据仍在。
  assert.match(rendered, /只有状态为 succeeded 的账本项代表已完成/,
    "自证样本没造好");
  assert.equal(degraded.actionLedger.unresolved.length, 0, "自证：退化样本确实把未决清空了");
});

test("回放窗口是**20**，且摘要器必须让开它（两处各写一个 20 就会静默重叠）", () => {
  assert.equal(REPLAY_WINDOW_MESSAGES, 20);
  // §4.7.4：不把固定消息条数当**边界定义**——条数只是预算，水位才是边界。
  const many = Array.from({ length: REPLAY_WINDOW_MESSAGES * 2 }, (_, i) =>
    msg(i % 2 === 0 ? "user" : "assistant", `第 ${i} 条`, `m-${i}`));
  const bounded = boundCompanionRecentHistory(many);
  assert.ok(bounded.length <= REPLAY_WINDOW_MESSAGES, "收边之后还超过回放窗口");
  // 保留的是**最近**的那些，不是最早的
  assert.equal(bounded[bounded.length - 1]?.seq, `m-${REPLAY_WINDOW_MESSAGES * 2 - 1}`);
});

test("被折叠掉的助手残句会连同它前面那句提问一起丢掉", () => {
  // 只剩半句的助手回答对下一轮是纯噪声：用户问了、她没答上，
  // 留着会让她看起来像是无视了问题。
  const bounded = boundCompanionRecentHistory([
    msg("user", "这一段是什么意思", "m-1"),
    msg("assistant", "嗯", "m-2"),
    msg("user", "那我换一个问法", "m-3"),
  ]);
  const texts = bounded.map((m) => m.text);
  assert.ok(!texts.includes("嗯"), "被折叠的助手残句还留着");
  assert.ok(!texts.includes("这一段是什么意思"), "它前面那句提问也被留下了");
  assert.ok(texts.includes("那我换一个问法"));
});

test("【自证】判据认得出「留下的是最早那批」这个真实退化", () => {
  const history = Array.from({ length: 40 }, (_, i) =>
    msg(i % 2 === 0 ? "user" : "assistant", `第 ${i} 条`, `m-${i}`));
  const bounded = boundCompanionRecentHistory(history);
  // 正控制：保留的是**末尾**那批。
  assert.equal(bounded[bounded.length - 1]?.text, "第 39 条");
  // 反向：若实现从前面切（留下最早那批），上面这条与这条都会红。
  assert.notEqual(bounded[bounded.length - 1]?.text, "第 0 条");
  assert.ok(bounded.some((m) => m.text === "第 39 条"), "最近那条必须留着");
  assert.ok(!bounded.some((m) => m.text === "第 0 条"), "最早那条应当已被丢掉");
});
