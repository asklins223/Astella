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
  renderCompanionContextHandoff,
  renderPendingOffersAsRecords,
  selectCompanionInteractiveReplayWindow,
  selectCompanionReplayWindow,
  type CompanionContextHandoffInputV1,
  type CompanionRecentHistoryMessage,
} from "../context/companion-context-handoff.ts";

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

/**
 * `modelMessages` 是重试时**原样重发**的那一份（"A retry must replay the exact
 * committed messages"）。2026-10-14（0435）起它必须连 reasoning 一起保住：
 * 网关在思考模式下要交回每个"纯文本续写位" assistant 的 `reasoning_text`，
 * 快照里剥掉它，重试就必然 400。此前三处映射（快照、运行时历史、persona 组装）
 * 都只保留 `{role, content}`，把句柄丢了——这条盯快照那一处。
 */
test("快照的 modelMessages 保留 reasoning，重试才交得回明文", () => {
  const reasoning = [{ type: "reasoning", id: "rs-1", status: "completed",
    encrypted_content: "enc-1", summary: [],
    content: [{ type: "reasoning_text", text: "先弄清他要什么" }] }];
  const snapshot = buildCompanionContextHandoffSnapshotV1(input({
    modelMessages: [
      { role: "system", content: "你是伴星" },
      { role: "user", content: "在吗" },
      { role: "assistant", content: "在的", reasoning },
    ],
  }));
  const last = snapshot.modelMessages.at(-1)!;
  assert.deepEqual(last.reasoning, reasoning,
    "明文 reasoning 必须随快照保留——丢掉它，重试那一轮会被网关 400");
  // user/system 消息不挂 reasoning：只在产出它的那条 assistant 上才有意义。
  assert.equal("reasoning" in snapshot.modelMessages[1]!, false);
  // 带 reasoning 的消息不影响指纹式正文之外的既有形状。
  assert.equal(snapshot.modelMessages[0]!.content, "你是伴星");
});

test("handoff recovery retains host provenance and the assistant phase", () => {
  const modelMessages = [{ role: "system" as const, hostObservation: true as const, content: "terminal history data" },
    { role: "assistant" as const, phase: "final_answer" as const, content: "actual answer" }];
  const snapshot = buildCompanionContextHandoffSnapshotV1(input({ modelMessages }));
  assert.deepEqual(snapshot.modelMessages, modelMessages);
});

test("当前请求也按指纹存：用户最新请求与授权单列（§4.7.2）", () => {
  const snapshot = buildCompanionContextHandoffSnapshotV1(input());
  assert.equal(snapshot.currentRequest.messageSeq, "m-41");
  assert.ok(snapshot.currentRequest.contentSha256.length > 0);
  assert.equal(snapshot.authorization.permissionLevel, "moderate");
});

test("a host-origin handoff cannot instruct the model to resume the last historical user request", () => {
  const snapshot = buildCompanionContextHandoffSnapshotV1(input({ currentRequest: {
    messageId: null, messageSeq: "41", text: "", source: "host_observation",
  } }));
  assert.equal(snapshot.currentRequest.source, "host_observation");
  const rendered = renderCompanionContextHandoff(snapshot);
  assert.match(rendered, /本轮来自宿主观察，没有新的用户请求/);
  assert.doesNotMatch(rendered, /当前用户请求仍以最后一条 user 消息为准/);
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


test("capacity pressure never punches holes into an uncovered exchange", () => {
  const history = [msg("user", "old question", "1"), msg("assistant", "long answer".repeat(1_000), "2"), msg("user", "follow-up", "3")];
  const result = selectCompanionReplayWindow(history, { maxInputTokens: 100 });
  assert.deepEqual(result.messages, history);
  assert.ok(result.receipt.usedTokens > result.receipt.capacityTokens, "the full-request governor must see actual pressure");
  assert.equal(result.receipt.omittedCount, 0);
  assert.equal(result.receipt.uncoveredThroughSeq, null);
});

test("verified summaries replace older complete exchanges while retaining the latest answer", () => {
  const history = Array.from({ length: 24 }, (_, index) => msg(index % 2 ? "assistant" : "user", "x".repeat(1_200), String(index + 1)));
  assert.deepEqual(selectCompanionInteractiveReplayWindow(history, 1_000_000).messages, history);
  const projected = selectCompanionInteractiveReplayWindow(history, 100, { fromSeq: "1", throughSeq: "24", sourceSha256: "verified" });
  assert.deepEqual(projected.messages, history.slice(-2));
  assert.equal(projected.receipt.omittedCount, 22);
  assert.equal(projected.receipt.summaryFold?.throughSeq, "22");
  assert.equal(projected.receipt.uncoveredThroughSeq, null, "folded history is represented, not missing");
});

test("an oversized latest exchange is retained for semantic compaction instead of silently dropping its answer", () => {
  const history = [msg("user", "question", "1"), msg("assistant", "x".repeat(9_000), "2")];
  const result = selectCompanionInteractiveReplayWindow(history, 1_500, { fromSeq: "1", throughSeq: "2", sourceSha256: "verified" });
  assert.deepEqual(result.messages, history);
  assert.ok(result.receipt.usedTokens > 1_500);
});

test("the real failure shape retains answered math questions together with their long answers and reasoning", () => {
  const history: CompanionRecentHistoryMessage[] = [
    msg("user", "请推导贝叶斯公式并计算三个例子。", "1"),
    msg("assistant", "此前的三个例子都已回答。".repeat(500), "2"),
    msg("user", "零概率条件事件的边界呢？不要重讲例子。", "3"),
    { ...msg("assistant", "条件事件概率为零时不能按比值定义条件概率。".repeat(150), "4"),
      reasoning: [{ type: "reasoning", content: [{ type: "reasoning_text", text: "先核对当前边界。".repeat(500) }] }] },
    { ...msg("user", "刚才那句能推出严格集合包含吗？", "5"), replyStatus: "failed" },
  ];
  for (const capacity of [1_000, 100_000]) {
    const result = selectCompanionInteractiveReplayWindow(history, capacity);
    assert.deepEqual(result.messages, history);
    const compacted = selectCompanionInteractiveReplayWindow(history, capacity, { fromSeq: "1", throughSeq: "4", sourceSha256: "verified" });
    assert.deepEqual(compacted.messages, history.slice(2));
    assert.deepEqual(compacted.messages[1]?.reasoning, history[3]!.reasoning);
  }
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

test("partial summary coverage never separates a historical question from its answer", () => {
  const history = [msg("user", "old q", "1"), msg("assistant", "old a", "2"), msg("user", "new q", "3"), msg("assistant", "new a", "4")];
  for (const coverage of [
    { fromSeq: "1", throughSeq: "1", sourceSha256: "hash" },
    { fromSeq: "2", throughSeq: "2", sourceSha256: "hash" },
    { fromSeq: "1", throughSeq: "2", sourceSha256: null },
    { fromSeq: "1", throughSeq: "2", sourceSha256: "hash", uncovered: [{ fromSeq: "2", throughSeq: "2" }] },
  ]) assert.deepEqual(selectCompanionReplayWindow(history, { maxInputTokens: 10 }, coverage).messages, history);
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
    history[0]!.content + "\n\n（这句说完就算过去了。）");
  assert.equal(rendered[2]?.content, history[2]!.content + "\n\n（这句说完就算过去了。）",
    "陈述式的等待句一样降级——判据是解释给的索引，不是标点");
  assert.equal(rendered[4]?.content, history[4]!.content, "没被点到的消息一个字不改");
  assert.equal(rendered[1]?.content, "在干嘛呢", "用户消息永不被改写");
});

test("an offer annotation preserves the full reply, is idempotent, and retains native fields", () => {
  const once = renderPendingOffersAsRecords([{ role: "assistant", content: "第一段。\n\n末尾问句？" }], [0]);
  assert.equal(once[0]?.content, "第一段。\n\n末尾问句？\n\n（这句说完就算过去了。）");
  assert.deepEqual(renderPendingOffersAsRecords(once, [0]), once, "渲染两次必须是同一个结果（已经换过的不再套第二层）");
  assert.equal(
    renderPendingOffersAsRecords([{ role: "assistant", content: "上一段里也有一个？\n\n末尾是陈述。" }], [0])[0]?.content,
    "上一段里也有一个？\n\n末尾是陈述。\n\n（这句说完就算过去了。）",
    "a mistaken classifier index cannot remove substantive prose",
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
  assert.equal(carried.content, "要不要接着讲？\n\n（这句说完就算过去了。）");
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

test("consecutive user additions and segmented replies form an indivisible exchange", () => {
  const history = [msg("user", "first", "1"), msg("user", "addition", "2"), msg("assistant", "part a", "3"), msg("assistant", "part b", "4"), msg("user", "current", "5"), msg("assistant", "current answer", "6")];
  const partial = selectCompanionReplayWindow(history, { maxInputTokens: 10 }, { fromSeq: "2", throughSeq: "4", sourceSha256: "hash" });
  assert.deepEqual(partial.messages, history);
  const complete = selectCompanionReplayWindow(history, { maxInputTokens: 10 }, { fromSeq: "1", throughSeq: "4", sourceSha256: "hash" });
  assert.deepEqual(complete.messages, history.slice(4));
});

test("an invalid summary boundary fails open to original history", () => {
  const history = [msg("user", "q", "1"), msg("assistant", "a", "2"), msg("user", "next", "3"), msg("assistant", "next answer", "4")];
  for (const coverage of [
    { fromSeq: "broken", throughSeq: "4", sourceSha256: "hash" },
    { fromSeq: "4", throughSeq: "1", sourceSha256: "hash" },
    { fromSeq: "1", throughSeq: "4", sourceSha256: "hash", uncovered: [{ fromSeq: "4", throughSeq: "2" }] },
  ]) assert.deepEqual(selectCompanionReplayWindow(history, { maxInputTokens: 10 }, coverage).messages, history);
});

test("coverage holes retain their whole exchanges rather than isolated messages", () => {
  const history = Array.from({ length: 8 }, (_, i) => msg(i % 2 ? "assistant" : "user", String(i), String(i + 1)));
  const result = selectCompanionReplayWindow(history, { maxInputTokens: 1 }, { fromSeq: "1", throughSeq: "8", sourceSha256: "hash", uncovered: [{ fromSeq: "4", throughSeq: "4" }] });
  assert.deepEqual(result.messages.map(m => m.seq), ["3", "4", "7", "8"]);
});

test("窗口内部的洞说一次就够：给条数、给最新那条 seq、给取回入口", () => {
  const snapshot = buildCompanionContextHandoffSnapshotV1(input({
    replayWindow: {
      version: 1,
      capacityTokens: 2_048,
      usedTokens: 1_700,
      takenCount: 8,
      omittedCount: 3,
      uncoveredThroughSeq: "m-9",
      skippedToFit: [
        { seq: "m-7", role: "assistant", tokens: 600 },
        { seq: "m-9", role: "user", tokens: 120 },
      ],
    },
  }));
  const block = renderCompanionContextHandoff(snapshot);
  assert.match(block, /回放窗口内部跳过了 2 条/);
  assert.match(block, /最新一条是 m-9/);
  assert.match(block, /别把前后两条当成挨着说的/);
  assert.match(block, /companion_observe/);
  // 洞的 seq 清单在 JSON 里可读，不再逐条成句（第一版逐条成句，实测 52 个洞把交接块顶到 10,380 字符）。
  assert.ok(!block.includes("seq=m-7 那条"), "不再逐条成句");
});

test("账本按摘要覆盖线收边时，块里要说清折走了几条", () => {
  const snapshot = buildCompanionContextHandoffSnapshotV1(input({
    actionLedgerOmitted: { completed: 116, unresolved: 1, notCompleted: 4 },
  }));
  const block = renderCompanionContextHandoff(snapshot);
  assert.match(block, /另有 121 条更早的动作回执没逐条带走/);
  assert.match(block, /conversation_summary/);
  assert.match(block, /"omitted":\{"completed":116,"unresolved":1,"notCompleted":4\}/);
});

test("超长那条在交接块里说得清：说过、这一轮没带正文、按哪个 seq 取回", () => {
  const snapshot = buildCompanionContextHandoffSnapshotV1(input({
    replayWindow: {
      version: 1,
      capacityTokens: 2_048,
      usedTokens: 480,
      takenCount: 6,
      omittedCount: 191,
      uncoveredThroughSeq: "m-9",
      oversizedSkipped: [{ seq: "m-9", role: "assistant", tokens: 3_494 }],
    },
  }));
  const rendered = renderCompanionContextHandoff(snapshot);

  assert.match(rendered, /seq=m-9/);
  assert.match(rendered, /是你自己发的长内容/);
  assert.match(rendered, /没带走正文/);
  assert.match(rendered, /companion_observe/);
});

test("replay capacity includes persisted reasoning sent with assistant history", () => {
  const history: CompanionRecentHistoryMessage[] = [
    { seq: "1", role: "user", text: "question" },
    { seq: "2", role: "assistant", text: "short answer", reasoning: [{ type: "reasoning", content: [{ type: "reasoning_text", text: "r".repeat(200) }] }] },
  ];
  const narrow = selectCompanionReplayWindow(history, { maxInputTokens: 100, countTokens: text => text.length });
  assert.deepEqual(narrow.messages, history);
  assert.ok(narrow.receipt.usedTokens > narrow.receipt.capacityTokens);
  assert.deepEqual(narrow.messages[1]?.reasoning, history[1]!.reasoning);
  const wide = selectCompanionReplayWindow(history, { maxInputTokens: 1_000, countTokens: text => text.length });
  assert.equal(wide.receipt.usedTokens, history[0]!.text.length + history[1]!.text.length + JSON.stringify(history[1]!.reasoning).length);
});
