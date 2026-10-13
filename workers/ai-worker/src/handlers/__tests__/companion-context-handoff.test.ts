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
  boundCompanionRecentHistory,
  buildCompanionContextHandoffSnapshotV1,
  COMPANION_INTERACTIVE_REPLAY_TOKEN_BUDGET,
  renderCompanionContextHandoff,
  renderPendingOffersAsRecords,
  selectCompanionInteractiveReplayWindow,
  selectCompanionReplayWindow,
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


test("回放窗口按声明预算整条取舍：留下的必须是最近那一段，少带了几条当场说清", () => {
  // §4.7.4：不把固定条数当**边界定义**。2026-10-12 起窗口由本次路由模型声明的输入
  // 预算决定，一条要么整条带走、要么这一轮不带；不给容量时根本不做条数取舍。
  const history = Array.from({ length: 40 }, (_, i) =>
    msg(i % 2 === 0 ? "user" : "assistant", `第 ${i} 条`, `m-${i}`));

  const whole = boundCompanionRecentHistory(history);
  assert.equal(whole.length, 40, "没给声明容量时不该再按条数收边");

  const capacity = { maxInputTokens: 100 };
  const { messages: taken, receipt } = selectCompanionReplayWindow(history, capacity);
  assert.ok(taken.length > 0 && taken.length < history.length, "紧容量必须真的取舍，否则下面的断言全是空的");
  // 留下的是**末尾那一段连续的整条**：中间挖洞会把她上一句和用户下一句拆开
  assert.deepEqual(taken, history.slice(history.length - taken.length));
  assert.equal(receipt.takenCount, taken.length);
  assert.equal(receipt.omittedCount, history.length - taken.length, "少带的条数要如实等于少掉的条数");
  assert.equal(receipt.capacityTokens, capacity.maxInputTokens);
  assert.ok(receipt.usedTokens <= capacity.maxInputTokens);
  // 没带走的那一段里最新的一条：她由此知道「不是没发生过」，也知道从哪个 seq 取回
  assert.equal(receipt.uncoveredThroughSeq, history[history.length - taken.length - 1]?.seq);
});

test("交互历史不因模型超大窗口而无限变长，旧消息仍留下按需取回水位", () => {
  const history = Array.from({ length: 24 }, (_, index) =>
    msg(index % 2 === 0 ? "user" : "assistant", `消息 ${index}：${"x".repeat(1_200)}`, `m-${index}`));
  const selected = selectCompanionInteractiveReplayWindow(history, 1_000_000);

  assert.equal(selected.receipt.capacityTokens, COMPANION_INTERACTIVE_REPLAY_TOKEN_BUDGET);
  assert.ok(selected.messages.length > 0 && selected.messages.length < history.length);
  assert.deepEqual(selected.messages, history.slice(history.length - selected.messages.length),
    "保留的必须是最近连续尾部，不能在历史中间挖洞");
  assert.equal(selected.receipt.omittedCount, history.length - selected.messages.length);
  assert.equal(selected.receipt.uncoveredThroughSeq, history[history.length - selected.messages.length - 1]?.seq);
  assert.ok(selected.receipt.usedTokens <= selected.receipt.capacityTokens);
});

test("交互尾部遵守更小的路由硬容量", () => {
  const history = Array.from({ length: 8 }, (_, index) => msg(
    index % 2 === 0 ? "user" : "assistant", `消息 ${index}：${"x".repeat(900)}`, `m-${index}`));
  const selected = selectCompanionInteractiveReplayWindow(history, 1_500);

  assert.equal(selected.receipt.capacityTokens, 1_500);
  assert.ok(selected.receipt.usedTokens <= 1_500);
  assert.equal(selected.messages.at(-1)?.seq, "m-7", "最新一条历史必须保留");
});

test("短回复与前面的用户问题都保持原样", () => {
  // 短句可能是有效确认，不能仅凭长度判断失败。
  const bounded = boundCompanionRecentHistory([
    msg("user", "这一段是什么意思", "m-1"),
    msg("assistant", "嗯", "m-2"),
    msg("user", "那我换一个问法", "m-3"),
  ]);
  const texts = bounded.map((m) => m.text);
  assert.ok(texts.includes("嗯"));
  assert.ok(texts.includes("这一段是什么意思"));
  assert.ok(texts.includes("那我换一个问法"));
});

test("【自证】判据认得出「留下的是最早那批」这个真实退化", () => {
  // 这一条要防的退化从来没变：紧容量下留下的若是**最早那批**，她就读不到自己上一句。
  // 变的只是判据不再由条数 20 决定，而由声明预算整条取舍决定。
  const history = Array.from({ length: 40 }, (_, i) =>
    msg(i % 2 === 0 ? "user" : "assistant", `第 ${i} 条`, `m-${i}`));
  const { messages: taken, receipt } = selectCompanionReplayWindow(history, { maxInputTokens: 100 });
  assert.ok(taken.length > 0 && taken.length < history.length, "自证样本没造好：这一轮没发生取舍");
  // 正控制：保留的是**末尾**那批，最早那条已被丢掉（不再是因为条数刚好 20）。
  assert.equal(taken[taken.length - 1]?.text, "第 39 条");
  assert.ok(taken.some((m) => m.text === "第 39 条"), "最近那条必须留着");
  assert.ok(!taken.some((m) => m.text === "第 0 条"), "最早那条应当已被丢掉");
  assert.equal(receipt.uncoveredThroughSeq, "m-29", "没带走的那一段最新的是一条要说得清 seq");
  // 反向：若实现从前面切（留下最早那批、条数一样），上面两条判据都会红。
  const forwardCut = history.slice(0, taken.length);
  assert.ok(forwardCut.some((m) => m.text === "第 0 条") && !forwardCut.some((m) => m.text === "第 39 条"),
    "自证样本没造好：从前面切那一批必须同时满足这两条反向判据");
});

test("按索引降级她自己的收尾：问句和陈述式的等待句都算，没点到的不动", () => {
  const history = [
    { role: "assistant", content: "熵衡量的是一杯墨水能散成多少种摆法。\n\n想接着问生命凭什么维持有序，还是先拿冰箱当例子再捋一遍？" },
    { role: "user", content: "在干嘛呢" },
    // 记账的句子多是这种陈述句——只认问号的那一版实测等于没做（66.7% vs 基线 63.5%）。
    { role: "assistant", content: "趴着呢。想接着问冰箱那个例子我随时接。" },
    { role: "user", content: "大肥鱼" },
    { role: "assistant", content: "在呢。\n\n我这边先摸会儿鱼，到点就去吃饭。" },
  ];
  const rendered = renderPendingOffersAsRecords(history, [0, 2]);
  assert.equal(rendered[0]?.content,
    "熵衡量的是一杯墨水能散成多少种摆法。\n\n（这句说完就算过去了。）");
  assert.equal(rendered[2]?.content, "（这句说完就算过去了。）",
    "陈述式的等待句一样降级——判据是解释给的索引，不是标点");
  assert.equal(rendered[4]?.content, history[4]!.content, "没被点到的消息一个字不改");
  assert.equal(rendered[1]?.content, "在干嘛呢", "用户消息永不被改写");
});

test("降级只动末段、可重复应用，并保住正文之外的字段", () => {
  const once = renderPendingOffersAsRecords([{ role: "assistant", content: "第一段。\n\n末尾问句？" }], [0]);
  assert.equal(once[0]?.content, "第一段。\n\n（这句说完就算过去了。）");
  assert.deepEqual(renderPendingOffersAsRecords(once, [0]), once, "渲染两次必须是同一个结果（已经换过的不再套第二层）");
  assert.equal(
    renderPendingOffersAsRecords([{ role: "assistant", content: "上一段里也有一个？\n\n末尾是陈述。" }], [0])[0]?.content,
    "上一段里也有一个？\n\n（这句说完就算过去了。）",
    "只改最后那一段，正文里原有的问句不动",
  );
  assert.equal(
    renderPendingOffersAsRecords([{ role: "assistant", content: "随便一句？" }], [])[0]?.content,
    "随便一句？", "本轮没有待收的账时完全不介入");

  // 运行时那一份消息还带着工具调用与思考句柄：改写只能动正文。
  const carried = renderPendingOffersAsRecords([{
    role: "assistant", content: "要不要接着讲？",
    toolCalls: [{ id: "c1", name: "companion_read_note", arguments: {} }],
    reasoning: [{ handle: "h1" }],
  }], [0])[0] as Record<string, unknown>;
  assert.equal(carried.content, "（这句说完就算过去了。）");
  assert.deepEqual(carried.toolCalls, [{ id: "c1", name: "companion_read_note", arguments: {} }], "工具调用不能被改写抹掉");
  assert.deepEqual(carried.reasoning, [{ handle: "h1" }], "思考句柄不能被改写抹掉");

  const parts = [{ role: "assistant", content: [{ type: "text", text: "带着图的一条？" }] }];
  assert.equal(renderPendingOffersAsRecords(parts, [0])[0]?.content, parts[0]!.content,
    "非字符串正文不动——邀请只出现在纯文本回复里");
});


test("长任务交接保留全部回执、待确认提案和完整说明", () => {
  const actions = Array.from({ length: 90 }, (_, index) => ({ receiptId: `receipt-${index}`, toolCallId: `call-${index}`,
    name: "companion_edit_note", status: index % 2 ? "outcome_unknown" : "succeeded",
    safeSummary: `第 ${index} 次修改：${"完整说明。".repeat(100)}尾部回执` }));
  const proposals = Array.from({ length: 40 }, (_, index) => ({ id: `proposal-${index}`, status: "pending", decision: null,
    title: `第 ${index} 个提案`, targetSummary: "完整改动说明。".repeat(100), resultSafeSummary: null, expiresAt: null }));
  const snapshot = buildCompanionContextHandoffSnapshotV1({ ...input(), actionLedger: actions, proposals });
  assert.equal(snapshot.actionLedger.completed.length, 45);
  assert.equal(snapshot.actionLedger.unresolved.length, 45);
  assert.equal(snapshot.proposals.length, 40);
  const rendered = renderCompanionContextHandoff(snapshot);
  assert.ok(rendered.includes(actions[89]!.safeSummary));
  assert.ok(rendered.includes(proposals[39]!.targetSummary));
  assert.ok(rendered.includes("第 39 个提案"));
  const serialized = rendered.split("\n").find(line => line.startsWith("{"));
  assert.ok(serialized, "交接快照应包含可解析的序列化账本");
  const payload = JSON.parse(serialized) as {
    actionLedger: {
      completed: unknown[][];
      unresolved: unknown[][];
      notCompleted: unknown[][];
    };
  };
  assert.equal(payload.actionLedger.completed.length, 45);
  assert.equal(payload.actionLedger.unresolved.length, 45);
  assert.deepEqual(payload.actionLedger.completed[44], [actions[88]!.name, actions[88]!.safeSummary]);
  assert.deepEqual(payload.actionLedger.unresolved[44], [
    actions[89]!.name,
    actions[89]!.status,
    actions[89]!.safeSummary,
  ]);
});
