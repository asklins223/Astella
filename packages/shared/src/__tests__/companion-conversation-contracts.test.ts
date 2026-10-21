import test from "node:test";
import assert from "node:assert/strict";
import {
  companionConversationV1Schema,
  companionContentBlockV1Schema,
  companionMessageV1Schema,
  companionTurnRunV1Schema,
  companionStreamEventV1Schema,
  companionErrorV1Schema,
  createCompanionTurnResponseV1Schema,
  createCompanionTurnRequestV1Schema,
  proposedLearningActionPayloadV1Schema,
  COMPANION_P2_LIMITS,
  COMPANION_SELECTION_MAX_CHARS,
  companionSelectionV1Schema,
  type CompanionStreamEventV1,
} from "../contracts/companion/companion-conversation-contracts.ts";
import { canonicalJsonV1, sha256Utf8V1, sha256Hex } from "../content/content-hash.ts";

const UUID = "123e4567-e89b-12d3-a456-426614174000";
const UUID2 = "223e4567-e89b-12d3-a456-426614174001";
const HASH = "a".repeat(64);
const TIME = "2026-08-10T00:00:00.000Z";
const SHA256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

test("a quote preserves exact executor-owned source identity while old excerpts remain readable", () => {
  const quote = { type: "quote", label: "原文", text: "实际读到的摘录" };
  assert.ok(companionContentBlockV1Schema.safeParse(quote).success);
  for (const sourceRef of [
    { kind: "note", noteId: UUID, noteVersionId: UUID2, blockOrdinal: 0 },
    { kind: "source", sourceId: UUID, segmentOrdinal: 2 },
  ]) assert.deepEqual(companionContentBlockV1Schema.parse({ ...quote, sourceRef }), { ...quote, sourceRef });
  for (const sourceRef of [
    { kind: "note", noteId: UUID },
    { kind: "source", sourceId: "a title", segmentOrdinal: 1 },
    { kind: "source", sourceId: UUID, segmentOrdinal: -1 },
    { kind: "note", noteId: UUID, noteVersionId: UUID2, sourceId: UUID },
  ]) assert.equal(companionContentBlockV1Schema.safeParse({ ...quote, sourceRef }).success, false);
});

test("选区20,000字符边界完整接收，超限拒绝并保留原输入", () => {
  const text = "字".repeat(COMPANION_SELECTION_MAX_CHARS - 5) + "尾部更正。";
  const selection = { text, sharing: "user_selected" as const };
  assert.deepEqual(companionSelectionV1Schema.parse(selection), selection);
  assert.equal(companionSelectionV1Schema.safeParse({ ...selection, text: text + "多" }).success, false);
  assert.equal(selection.text, text);
});

function baseEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    eventId: `${UUID}:1`,
    seq: 1,
    workspaceId: UUID,
    conversationId: UUID2,
    runId: UUID,
    generation: 1,
    accountEpoch: 0,
    createdAt: TIME,
    type: "turn.accepted",
    payload: {
      clientMessageId: UUID2,
      userMessageId: UUID,
      status: "accepted",
    },
    ...overrides,
  };
}

test("agent terminal failures survive strict stream validation and can close the client turn", () => {
  for (const code of ["ACTION_NOT_EXECUTED", "TOOL_ARGUMENTS_INVALID", "REPLY_LENGTH_LIMIT", "REPLY_FORMAT_INVALID", "AGENT_BUDGET_EXCEEDED", "AI_DATA_POLICY_DENIED"]) {
    const frame = baseEvent({ type: "error", payload: { code, recoverable: false } });
    assert.equal(companionStreamEventV1Schema.safeParse(frame).success, true, `${code} must reach the client`);
  }
});

test("conversation schema accepts a valid row", () => {
  const result = companionConversationV1Schema.safeParse({
    version: 1,
    id: UUID,
    workspaceId: UUID,
    userId: UUID2,
    kind: "dialogue",
    title: "新对话",
    titleSource: "placeholder",
    status: "active",
    createdAt: TIME,
    updatedAt: TIME,
    lastMessageAt: null,
  });
  assert.equal(result.success, true);
});

test("conversation schema rejects unknown kind/titleSource", () => {
  assert.equal(
    companionConversationV1Schema.safeParse({
      version: 1,
      id: UUID,
      workspaceId: UUID,
      userId: UUID2,
      kind: "chat",
      title: "x",
      titleSource: "placeholder",
      status: "active",
      createdAt: TIME,
      updatedAt: TIME,
      lastMessageAt: null,
    }).success,
    false,
  );
});

test("message schema: exactly one text block for user turn", () => {
  const ok = companionMessageV1Schema.safeParse({
    version: 1,
    id: UUID,
    workspaceId: UUID,
    conversationId: UUID2,
    seq: 1,
    role: "user",
    kind: "text",
    blocks: [{ type: "text", text: "你好" }],
    runId: UUID,
    clientMessageId: UUID2,
    contentSha256: SHA256,
    createdAt: TIME,
    editedAt: null,
  });
  assert.equal(ok.success, true);
  // 拒绝空 blocks
  const empty = companionMessageV1Schema.safeParse({
    version: 1,
    id: UUID,
    workspaceId: UUID,
    conversationId: UUID2,
    seq: 1,
    role: "user",
    kind: "text",
    blocks: [],
    runId: UUID,
    clientMessageId: UUID2,
    contentSha256: SHA256,
    createdAt: TIME,
    editedAt: null,
  });
  assert.equal(empty.success, false);
  // 拒绝超过 32 blocks
  const tooMany = companionMessageV1Schema.safeParse({
    version: 1,
    id: UUID,
    workspaceId: UUID,
    conversationId: UUID2,
    seq: 1,
    role: "user",
    kind: "text",
    blocks: Array.from({ length: 33 }, () => ({ type: "text", text: "a" })),
    runId: UUID,
    clientMessageId: UUID2,
    contentSha256: SHA256,
    createdAt: TIME,
    editedAt: null,
  });
  assert.equal(tooMany.success, false);
});

test("citation href 只允许 https", () => {
  const https = companionMessageV1Schema.safeParse({
    version: 1,
    id: UUID,
    workspaceId: UUID,
    conversationId: UUID2,
    seq: 1,
    role: "assistant",
    kind: "text",
    blocks: [
      { type: "text", text: "参见" },
      { type: "citation", label: "文档", target: { kind: "external_https", href: "https://example.com/doc" } },
    ],
    runId: UUID,
    clientMessageId: null,
    contentSha256: SHA256,
    createdAt: TIME,
    editedAt: null,
  });
  assert.equal(https.success, true);
  const http = companionMessageV1Schema.safeParse({
    version: 1,
    id: UUID,
    workspaceId: UUID,
    conversationId: UUID2,
    seq: 1,
    role: "assistant",
    kind: "text",
    blocks: [
      { type: "citation", label: "文档", target: { kind: "external_https", href: "http://example.com" } },
    ],
    runId: UUID,
    clientMessageId: null,
    contentSha256: SHA256,
    createdAt: TIME,
    editedAt: null,
  });
  assert.equal(http.success, false);
});

test("turn run: terminal 状态 phase 必须 null（superRefine 由 service 保证，schema 至少接受结构）", () => {
  const ok = companionTurnRunV1Schema.safeParse({
    version: 1,
    id: UUID,
    conversationId: UUID2,
    userMessageId: UUID,
    assistantMessageId: null,
    generation: 1,
    status: "accepted",
    phase: "accepted",
    previewText: "",
    previewTextSha256: HASH,
    lastEventSeq: 1,
    createdAt: TIME,
    updatedAt: TIME,
  });
  assert.equal(ok.success, true);
});





test("LearningRun page context revision input is deterministic and state-bound", () => {
  const input = {
    runId: UUID,
    snapshotId: UUID2,
    taskId: UUID,
    phase: "active",
    runRevision: 1,
    runtimeEpoch: 1,
  };
  const revision = sha256Utf8V1(canonicalJsonV1(input));
  assert.equal(revision, sha256Utf8V1(canonicalJsonV1(input)));
  assert.notEqual(sha256Utf8V1(canonicalJsonV1({ ...input, runRevision: 2 })), revision);
});

test("SSE: union 中全部事件类型均可被接受（含 agent.skill/agent.tool）", () => {
  const cases: Record<string, Record<string, unknown>> = {
    "turn.accepted": { clientMessageId: UUID2, userMessageId: UUID, status: "accepted" },
    "assistant.status": { status: "thinking", safeLabel: "正在思考" },
    "assistant.thinking": { index: 0, text: "先确认他问的是这一节的定义，再想要不要举例子。" },
    "assistant.delta": { appendFrom: 12, textDelta: "你好" },
    "assistant.final": { messageId: UUID, textLength: 4, textSha256: HASH, messageContentSha256: HASH },
    // 追问由后台任务在终态之后补写，所以它带的是那条回复的内容校验值。
    "assistant.followups.ready": { messageId: UUID, messageContentSha256: HASH, followUpPrompts: ["为什么傍晚的天是红的？"] },
    "character.cue": { cue: { version: 1, intent: "think", emotion: "curious", intensity: 0.35 } },
    "action.proposed": {
      proposal: {
        version: 1,
        id: UUID,
        workspaceId: UUID,
        conversationId: UUID2,
        sourceMessageId: UUID,
        sourceGeneration: 1,
        kind: { kind: "open_conversation_history" },
        payloadSha256: HASH,
        title: "看历史",
        targetSummary: "我们聊过的那几轮",
        impactSummary: "打开对话历史",
        status: "pending",
      },
    },
    "action.decision": { proposalId: UUID, decision: "confirm", status: "accepted" },
    "action.expired": { proposalId: UUID },
    "voice.segment.ready": {
      version: 2,
      segmentId: HASH,
      ordinal: 1,
      displayText: "你好",
      displayStart: 0,
      displayEnd: 2,
      synthesisText: "[excited]你好",
      synthesisTextSha256: HASH,
      cue: { version: 1, intent: "acknowledge", emotion: "happy", intensity: 0.6, durationMs: 4_000 },
    },
    "proactive.delivery": { deliveryId: UUID, messageId: UUID, expiresAt: TIME, contentPolicy: "content" },
    "assistant.utterance": { messageId: UUID, messageSeq: 1, text: "补一个例子。", proactive: false, deviceSessionId: null },
    "turn.completed": { messageIds: [UUID], silent: false },
    "proactive.delivery.updated": { deliveryId: UUID, status: "shown", contentClaimed: true },
    "turn.cancelled": { reason: "user" },
    error: { code: "PROVIDER_TIMEOUT", recoverable: true },
    // 工具执行进度走 wire 合同。`agent.skill` 已随技能层删除（方案 29 §4.1）：
    // 每轮工具面固定，"选中了哪个技能"不再是一个需要广播的事实。
    "agent.tool": {
      tool: {
        toolCallId: "call_1",
        name: "companion_open_page",
        toolVersion: "1.0.0",
        riskClass: "read",
        status: "succeeded",
        safeLabel: "打开复习页面",
        safeSummary: "已定位到复习页面",
      },
    },
  };
  for (const [type, payload] of Object.entries(cases)) {
    const result = companionStreamEventV1Schema.safeParse(baseEvent({ type, payload }));
    assert.equal(result.success, true, `type ${type} 应可接受`);
  }
  // 漂移护栏：union 新增事件类型时必须同步补用例——此前 agent.skill/agent.tool
  // 已加入 union，但本用例漏掉，导致新增事件类型无人校验。
  const covered = new Set(Object.keys(cases));
  for (const option of companionStreamEventV1Schema.options) {
    const literal = (option.shape.type as { value: string }).value;
    assert.ok(covered.has(literal), `union 事件类型 ${literal} 缺少用例`);
  }
  // 条数与 companion_messages.follow_up_prompts 的 CHECK 同一口径：第四条存不下。
  assert.equal(companionStreamEventV1Schema.safeParse(baseEvent({
    type: "assistant.followups.ready",
    payload: { messageId: UUID, messageContentSha256: HASH, followUpPrompts: ["一", "二", "三", "四"] },
  })).success, false);
  // 未知 type 拒绝
  const unknown = companionStreamEventV1Schema.safeParse(
    baseEvent({ type: "mystery" } as unknown as CompanionStreamEventV1),
  );
  assert.equal(unknown.success, false);
  // §5.1：envelope 顶层 strict——未知顶层字段拒绝（不能静默 strip）
  const extraKey = companionStreamEventV1Schema.safeParse({
    ...baseEvent({ type: "turn.accepted" }),
    unexpectedField: "x",
  });
  assert.equal(extraKey.success, false);
  // delta 超 2000 code unit 拒绝
  const tooLongDelta = companionStreamEventV1Schema.safeParse(
    baseEvent({ type: "assistant.delta", payload: { appendFrom: 0, textDelta: "x".repeat(2001) } }),
  );
  assert.equal(tooLongDelta.success, false);
  // 思考块同样有单帧上限（桌面主进程按 16KB 过桥，超限的帧会被整条丢掉）
  assert.equal(companionStreamEventV1Schema.safeParse(
    baseEvent({ type: "assistant.thinking", payload: { index: 0, text: "x".repeat(4001) } }),
  ).success, false);
});

test("error envelope：public message 有长度上限", () => {
  const ok = companionErrorV1Schema.safeParse({
    version: 1,
    error: "RATE_LIMITED",
    message: "请求过于频繁",
    recoverable: true,
    requestId: "req_1",
  });
  assert.equal(ok.success, true);
  const bad = companionErrorV1Schema.safeParse({
    version: 1,
    error: "NOT_A_CODE",
    message: "x",
    recoverable: false,
    requestId: "r",
  });
  assert.equal(bad.success, false);
});

test("create turn response：eventCursor 非负", () => {
  const ok = createCompanionTurnResponseV1Schema.safeParse({
    version: 1,
    conversationId: UUID2,
    clientMessageId: UUID,
    userMessageId: UUID,
    runId: UUID,
    generation: 1,
    status: "accepted",
    eventCursor: 5,
  });
  assert.equal(ok.success, true);
});

test("canonicalJsonV1：key 按 code point 排序、-0 → 0、无空白", () => {
  const canonical = canonicalJsonV1({ z: 1, a: { y: 2, b: [3, 4] }, m: null, n: true });
  assert.equal(canonical, '{"a":{"b":[3,4],"y":2},"m":null,"n":true,"z":1}');
  assert.equal(canonicalJsonV1({ x: -0 }), '{"x":0}');
  // 非 safe integer 拒绝
  assert.throws(() => canonicalJsonV1({ x: 1.5 }));
  assert.throws(() => canonicalJsonV1({ x: Number.MAX_SAFE_INTEGER + 1 }));
  // Unicode key 排序（code point）：学 U+5B66 在 a 之后、𠀀 U+20000 最后
  const unicode = canonicalJsonV1({ 学习: 1, a: 2, 𠀀: 3 });
  assert.equal(unicode, '{"a":2,"学习":1,"𠀀":3}');
});

test("sha256Utf8V1：与裸 sha256Hex 一致且为 64 位小写 hex", () => {
  const value = "你好\n换行 test";
  assert.equal(sha256Utf8V1(value), sha256Hex(value));
  assert.match(sha256Utf8V1(value), /^[a-f0-9]{64}$/);
});

test("P2 客户端限额常量与合同一致", () => {
  assert.equal(COMPANION_P2_LIMITS.composerMaxChars, 4_000);
  assert.equal(COMPANION_P2_LIMITS.serverHardMaxChars, 20_000);
  assert.equal(COMPANION_P2_LIMITS.deltaMaxChars, 2_000);
  assert.equal(COMPANION_P2_LIMITS.blocksPerMessage, 32);
});



// ─── Plan 23 CS-05/CS-06：V2 学习运行 payload 与候选扩展 ────────────────









// ─── 方案 16 §18.1：工具网关第二批（Orchestrator 动作工具全集） ────────



test("proposedLearningActionPayload：§18 工具非法变体拒绝", () => {
  const runId = "423e4567-e89b-12d3-a456-426614174000";
  // 缺 runId / 缺 level / level 越界 / 未知 reasonCode
  assert.equal(proposedLearningActionPayloadV1Schema.safeParse({ kind: "pause_learning_run" }).success, false);
  assert.equal(proposedLearningActionPayloadV1Schema.safeParse({ kind: "request_hint_level", runId }).success, false);
  assert.equal(
    proposedLearningActionPayloadV1Schema.safeParse({ kind: "request_hint_level", runId, taskId: runId, level: 4 }).success,
    false,
  );
  assert.equal(
    proposedLearningActionPayloadV1Schema.safeParse({
      kind: "defer_review",
      scheduleId: runId,
      scheduleGeneration: 0,
      deferredUntil: "2026-08-20T09:00:00.000Z",
      reasonCode: "mystery",
    }).success,
    false,
  );
  assert.equal(proposedLearningActionPayloadV1Schema.safeParse({ kind: "focus_graph_node" }).success, false);
  assert.equal(proposedLearningActionPayloadV1Schema.safeParse({ kind: "confirm_or_reject_memory", memoryId: runId, revision: 1 }).success, false);
  assert.equal(proposedLearningActionPayloadV1Schema.safeParse({
    kind: "revise_memory",
    memoryId: runId,
    expectedRevision: 0,
    content: "修订内容",
  }).success, false);
  assert.equal(proposedLearningActionPayloadV1Schema.safeParse({
    kind: "revise_memory",
    memoryId: runId,
    expectedRevision: 1,
    content: "修订内容",
    validFrom: "2026-10-10T00:00:00+08:00",
    validUntil: "2026-10-09T00:00:00+08:00",
  }).success, false);
  // 已删除的 kind 必须被拒绝（防止通过历史 payload 复活不可实现的动作）。
  assert.equal(proposedLearningActionPayloadV1Schema.safeParse({ kind: "ask_grounded_tutor", runId, snapshotId: runId, taskId: runId, question: "?" }).success, false);
  assert.equal(
    proposedLearningActionPayloadV1Schema.safeParse({ kind: "propose_memory_candidate", memoryKind: "preference", value: "偏好", sourceMessageId: runId }).success,
    false,
  );
});







test("划选投喂：turn 请求可携带 selection（user_selected），首个块仍是 text", () => {
  const ok = createCompanionTurnRequestV1Schema.safeParse({
    version: 1,
    clientMessageId: UUID,
    inputKind: "text",
    blocks: [{ type: "text", text: "这段在讲什么？" }],
    sourceSurface: "pet",
    selection: { text: "光的折射定律：入射角等于反射角。", sharing: "user_selected" },
  });
  assert.equal(ok.success, true);
  // 超长选区拒绝
  const tooLong = createCompanionTurnRequestV1Schema.safeParse({
    version: 1,
    clientMessageId: UUID,
    inputKind: "text",
    blocks: [{ type: "text", text: "问题" }],
    sourceSurface: "pet",
    selection: { text: "x".repeat(COMPANION_SELECTION_MAX_CHARS + 1), sharing: "user_selected" },
  });
  assert.equal(tooLong.success, false);
  // sharing 只认 user_selected
  const wrongSharing = createCompanionTurnRequestV1Schema.safeParse({
    version: 1,
    clientMessageId: UUID,
    inputKind: "text",
    blocks: [{ type: "text", text: "问题" }],
    sourceSurface: "pet",
    selection: { text: "一段话", sharing: "page_registered" },
  });
  assert.equal(wrongSharing.success, false);
});

test("输入框传图：一轮可以带一张用户自己传的图，形状与顺序都收窄", () => {
  const image = {
    type: "image",
    url: `/api/uploads/${UUID}/companion/${UUID}.png`,
    label: "截屏 2026-10-06",
  };
  const turn = (blocks: unknown[], inputKind: "text" | "voice_transcript" = "text") => ({
    version: 1,
    clientMessageId: UUID,
    inputKind,
    blocks,
    ...(inputKind === "voice_transcript" ? { voiceArtifactId: UUID } : {}),
    sourceSurface: "pet",
  });
  assert.equal(createCompanionTurnRequestV1Schema.safeParse(
    turn([{ type: "text", text: "这张图里画的是什么" }, image]),
  ).success, true);
  // 首个块必须是 text：图不能排在文字前面（注意力分类、标题、事实读取都以文字为准）。
  assert.equal(createCompanionTurnRequestV1Schema.safeParse(
    turn([image, { type: "text", text: "看图" }]),
  ).success, false);
  // 2026-10-15 扩展 A：允许「仅附件」（用户拖一张图/一个文件、什么都没说），
  // 由服务端登记显式「仅附件意图」，客户端不再伪造文案。
  assert.equal(createCompanionTurnRequestV1Schema.safeParse(turn([image])).success, true);
  // 至多一张，第二块只认 image。
  assert.equal(createCompanionTurnRequestV1Schema.safeParse(
    turn([{ type: "text", text: "两张" }, image, image]),
  ).success, false);
  assert.equal(createCompanionTurnRequestV1Schema.safeParse(
    turn([{ type: "text", text: "问题" }, { type: "quote", label: "原文", text: "一段话" }]),
  ).success, false);
  // 语音这一轮没有传图的入口（麦克风路径不带附件）。
  assert.equal(createCompanionTurnRequestV1Schema.safeParse(
    turn([{ type: "text", text: "刚说的" }, image], "voice_transcript"),
  ).success, false);
  // 站外地址不认：显示用的 url 只能指向站内图片通道。
  assert.equal(createCompanionTurnRequestV1Schema.safeParse(
    turn([{ type: "text", text: "看图" }, { ...image, url: "https://example.com/a.png" }]),
  ).success, false);
});

test("nav 块：她带我去哪儿，落在消息里而不是消息外面", () => {
  assert.equal(companionContentBlockV1Schema.safeParse({
    type: "nav",
    label: "打开《消防疏散》",
    route: { kind: "note", noteId: UUID },
  }).success, true);
  // 落点仍按主进程白名单——不是"任何 kind + 任何 uuid"都能拼出一个可跳的东西
  assert.equal(companionContentBlockV1Schema.safeParse({
    type: "nav",
    label: "x",
    route: { kind: "user_settings" },
  }).success, false);
  assert.equal(companionContentBlockV1Schema.safeParse({
    type: "nav",
    label: "y".repeat(81),
    route: { kind: "home" },
  }).success, false);
  // 一条助手消息 = 正文 + 落点，顺序即渲染顺序
  const message = companionMessageV1Schema.safeParse({
    version: 1,
    id: UUID,
    workspaceId: UUID,
    conversationId: UUID2,
    seq: 3,
    role: "assistant",
    kind: "text",
    blocks: [
      { type: "text", text: "带你去看那篇笔记。" },
      { type: "nav", label: "打开《消防疏散》", route: { kind: "note", noteId: UUID } },
    ],
    runId: UUID,
    clientMessageId: null,
    contentSha256: SHA256,
    createdAt: TIME,
    editedAt: null,
  });
  assert.equal(message.success, true);
});

test("quote 块：她读到的原文由服务端带出，长度与字段都收紧", () => {
  assert.equal(companionContentBlockV1Schema.safeParse({
    type: "quote",
    label: "《消防疏散与灭火器使用》· 3 天前",
    text: "多层住宅疏散：先关燃气总阀，再带上门口的应急包。",
  }).success, true);
  assert.equal(companionContentBlockV1Schema.safeParse({
    type: "quote",
    label: "《一篇很长的笔记》",
    text: "字".repeat(2_001),
  }).success, false);
  // 原文不是指令：块里没有可执行字段（route/tool 之类）
  assert.equal(companionContentBlockV1Schema.safeParse({
    type: "quote",
    label: "《X》",
    text: "正文",
    route: { kind: "home" },
  }).success, false);
});

// ─── 2026-10-15 扩展 A：回合附件合同（图片或文件，至多一个；允许仅附件） ───

const FILE_URL = `/api/uploads/${UUID}/companion-files/${UUID2}/notes.pdf`;
const FILE_BLOCK = {
  type: "file",
  url: FILE_URL,
  name: "notes.pdf",
  mime: "application/pdf",
  byteLength: 1234,
  text: "第一章 绪论……",
};
const IMAGE_BLOCK = {
  type: "image",
  url: `/api/uploads/${UUID}/companion/${UUID2}.png`,
  label: "第 1 张",
};
function turnBody(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    version: 1,
    clientMessageId: UUID,
    inputKind: "text",
    sourceSurface: "pet",
    ...overrides,
  };
}

test("扩展 A：text+文件、仅文件、仅图片、text+图片 均合法", () => {
  assert.equal(createCompanionTurnRequestV1Schema.safeParse(turnBody({
    blocks: [{ type: "text", text: "帮我看看" }, FILE_BLOCK],
  })).success, true);
  assert.equal(createCompanionTurnRequestV1Schema.safeParse(turnBody({
    blocks: [FILE_BLOCK],
  })).success, true);
  assert.equal(createCompanionTurnRequestV1Schema.safeParse(turnBody({
    blocks: [IMAGE_BLOCK],
  })).success, true);
  assert.equal(createCompanionTurnRequestV1Schema.safeParse(turnBody({
    blocks: [{ type: "text", text: "看看这张图" }, IMAGE_BLOCK],
  })).success, true);
});

test("扩展 A：双附件、text+text、附件+文字 的组合按合同拒绝", () => {
  // 附件+附件：拒绝
  assert.equal(createCompanionTurnRequestV1Schema.safeParse(turnBody({
    blocks: [IMAGE_BLOCK, FILE_BLOCK],
  })).success, false);
  // text+text：拒绝（第二块必须是附件）
  assert.equal(createCompanionTurnRequestV1Schema.safeParse(turnBody({
    blocks: [{ type: "text", text: "一" }, { type: "text", text: "二" }],
  })).success, false);
  // 附件在前、文字在后：拒绝（第二块只能是附件）
  assert.equal(createCompanionTurnRequestV1Schema.safeParse(turnBody({
    blocks: [FILE_BLOCK, { type: "text", text: "补充" }],
  })).success, false);
});

test("扩展 A：语音转写仍必须是唯一文字块、不带附件", () => {
  const voice = (blocks: unknown[]) => turnBody({
    inputKind: "voice_transcript",
    voiceArtifactId: UUID2,
    blocks,
  });
  assert.equal(createCompanionTurnRequestV1Schema.safeParse(
    voice([{ type: "text", text: "念一下这段" }]),
  ).success, true);
  assert.equal(createCompanionTurnRequestV1Schema.safeParse(
    voice([{ type: "text", text: "念一下" }, IMAGE_BLOCK]),
  ).success, false);
  assert.equal(createCompanionTurnRequestV1Schema.safeParse(
    voice([FILE_BLOCK]),
  ).success, false);
});

test("扩展 A：file 块字段按合同收口（url 站内、mime 白名单、text 上限）", () => {
  // url 是外链：拒绝
  assert.equal(createCompanionTurnRequestV1Schema.safeParse(turnBody({
    blocks: [{ ...FILE_BLOCK, url: "https://example.com/x.pdf" }],
  })).success, false);
  // mime 不在白名单：拒绝
  assert.equal(createCompanionTurnRequestV1Schema.safeParse(turnBody({
    blocks: [{ ...FILE_BLOCK, mime: "application/x-msdownload" }],
  })).success, false);
  // text 超 100,000：拒绝
  assert.equal(createCompanionTurnRequestV1Schema.safeParse(turnBody({
    blocks: [{ ...FILE_BLOCK, text: "字".repeat(100_001) }],
  })).success, false);
  // byteLength 超 20MiB：拒绝
  assert.equal(createCompanionTurnRequestV1Schema.safeParse(turnBody({
    blocks: [{ ...FILE_BLOCK, byteLength: 21 * 1024 * 1024 }],
  })).success, false);
});
