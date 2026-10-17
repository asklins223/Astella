import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPANION_RELEASE_THRESHOLD_DEFAULTS,
  companionReleaseGateFor,
  companionReleaseGates,
  createCompanionReleaseRouterPort,
  evaluateCompanionRelease,
  extractCompanionReleaseSeedRows,
  indexStoredCompanionReleaseSamples,
  normalizeCompanionReleaseText,
  parseCompanionReleaseScopeKey,
  rememberCompanionReleaseSample,
  resetCompanionReleaseRouterForTests,
  resetCompanionReleaseSeedingForTests,
  resolveCompanionReleaseRouterMode,
  resolveCompanionReleaseThresholds,
  seedCompanionReleaseIndex,
  type CompanionReleaseThresholds,
} from "../companion-release-router.ts";

const SAFE_VEC = [1, 0.05, 0, 0] as const;
const QUESTION_VEC = [0.05, 1, 0, 0] as const;
const QUERY_VEC = [1, 0, 0, 0] as const;

const thresholds = (overrides: Partial<CompanionReleaseThresholds> = {}): CompanionReleaseThresholds => ({
  ...COMPANION_RELEASE_THRESHOLD_DEFAULTS,
  minSamples: 3,
  ...overrides,
});

const embedFor =
  (mapping: Record<string, readonly number[]>, fallback: readonly number[] = SAFE_VEC) =>
    async (text: string): Promise<readonly number[]> => mapping[text] ?? fallback;

async function seed(scopeKey: string, labels: Array<{ intent: string; toolUse: string }>): Promise<void> {
  let index = 0;
  for (const label of labels) {
    index += 1;
    await rememberCompanionReleaseSample({
      scopeKey,
      text: `seed-${scopeKey}-${index}`,
      intent: label.intent,
      toolUse: label.toolUse,
      embed: async () => (label.intent === "question" ? QUESTION_VEC
  : label.toolUse === "none" ? SAFE_VEC : [0.8, 0, 0.6, 0]),
      thresholds: thresholds({ maxSamples: 512 }),
    });
  }
}

test.beforeEach(() => { resetCompanionReleaseRouterForTests(); resetCompanionReleaseSeedingForTests(); });

test("模式与阈值解析：缺省 off，shadow 才开；非法阈值回落默认", () => {
  assert.equal(resolveCompanionReleaseRouterMode(undefined), "off");
  assert.equal(resolveCompanionReleaseRouterMode(""), "off");
  assert.equal(resolveCompanionReleaseRouterMode("shadow"), "shadow");
  assert.equal(resolveCompanionReleaseRouterMode(" SHADOW "), "shadow");
  assert.equal(resolveCompanionReleaseRouterMode("enforce"), "enforce");
  const parsed = resolveCompanionReleaseThresholds({
    COMPANION_RELEASE_TAU_SAFE: "0.7", COMPANION_RELEASE_TAU_SIM: "2", COMPANION_RELEASE_MIN_SAMPLES: "5",
  });
  assert.equal(parsed.safeProbability, 0.7);
  assert.equal(parsed.topSimilarity, COMPANION_RELEASE_THRESHOLD_DEFAULTS.topSimilarity ?? parsed.topSimilarity);
  assert.equal(parsed.minSamples, 5);
  assert.deepEqual(resolveCompanionReleaseThresholds({}), COMPANION_RELEASE_THRESHOLD_DEFAULTS);
});

test("状态门：她的追问收尾、短句、指代一律弃权", () => {
  assert.equal(companionReleaseGates({
    text: "那我们今天就轻松一点，先说说哪里最累？".slice(0, 5),
    recentMessages: [{ role: "assistant", text: "要不要接着往下讲？" }],
  }).pendingOffer, true);
  assert.equal(companionReleaseGates({ text: "先暂停一下" }).short, true);
  assert.equal(companionReleaseGates({ text: "那篇笔记里刚才那个公式再讲一遍" }).anaphora, true);
  const open = companionReleaseGates({
    text: "今天好累，想随便聊聊最近的事",
    recentMessages: [{ role: "assistant", text: "好呀，我在呢。" }],
  });
  assert.deepEqual(open, { pendingOffer: false, anaphora: false, short: false, learningTask: false });
});

test("门关着或索引没热时不调用 embedding", async () => {
  let embedded = 0;
  const embed = async (): Promise<readonly number[]> => { embedded += 1; return QUERY_VEC; };
  const gated = await evaluateCompanionRelease({
    scopeKey: "gated", text: "这个怎么弄", embed, thresholds: thresholds(),
  });
  assert.equal(gated.decision, "wait");
  assert.equal(gated.reason, "gated");
  const cold = await evaluateCompanionRelease({
    scopeKey: "cold", text: "今天好累，想随便聊聊最近的事", embed, thresholds: thresholds(),
  });
  assert.equal(cold.reason, "cold");
  assert.equal(embedded, 0, "门关着/冷启动都不该发 embedding");
});

test("相似度与概率都过线才放行，并给出意图猜测", async () => {
  await seed("release", [
    { intent: "conversation", toolUse: "none" }, { intent: "conversation", toolUse: "none" },
    { intent: "question", toolUse: "none" }, { intent: "question", toolUse: "none" },
  ]);
  const verdict = await evaluateCompanionRelease({
    scopeKey: "release", text: "今天好累，想随便聊聊最近的事", embed: embedFor({}), thresholds: thresholds(),
  });
  assert.equal(verdict.decision, "release");
  assert.equal(verdict.reason, "released");
  assert.ok((verdict.topSimilarity ?? 0) > 0.9);
  assert.ok((verdict.safeProbability ?? 0) >= 0.85);
  assert.ok(verdict.intentGuess === "conversation" || verdict.intentGuess === "question");
});

test("近邻里有不该放行的样本时，概率门挡住", async () => {
  await seed("unsafe", [
    { intent: "task", toolUse: "act" }, { intent: "task", toolUse: "act" },
    { intent: "conversation", toolUse: "none" }, { intent: "conversation", toolUse: "none" },
  ]);
  const verdict = await evaluateCompanionRelease({
    scopeKey: "unsafe", text: "今天好累，想随便聊聊最近的事", embed: embedFor({}, QUERY_VEC), thresholds: thresholds(),
  });
  assert.equal(verdict.decision, "wait");
  assert.equal(verdict.reason, "probability");
});

test("没见过这种说法（相似度不够）时弃权，不靠 margin", async () => {
  await seed("ood", [
    { intent: "conversation", toolUse: "none" }, { intent: "conversation", toolUse: "none" },
    { intent: "conversation", toolUse: "none" },
  ]);
  const verdict = await evaluateCompanionRelease({
    scopeKey: "ood", text: "帮我看看这篇论文的第三作者", embed: async () => [0, 0, 0, 1], thresholds: thresholds(),
  });
  assert.equal(verdict.decision, "wait");
  assert.equal(verdict.reason, "similarity");
});

test("embedding 失败 = 弃权，不把 null 当零向量", async () => {
  await seed("noembed", [
    { intent: "conversation", toolUse: "none" }, { intent: "conversation", toolUse: "none" },
    { intent: "conversation", toolUse: "none" },
  ]);
  const verdict = await evaluateCompanionRelease({
    scopeKey: "noembed", text: "今天好累，想随便聊聊最近的事", embed: async () => null, thresholds: thresholds(),
  });
  assert.equal(verdict.decision, "wait");
  assert.equal(verdict.reason, "embedding_unavailable");
});

test("在线索引：同一条样本不重复入索引，且有上限", async () => {
  let embeds = 0;
  const embed = async (): Promise<readonly number[]> => { embeds += 1; return SAFE_VEC; };
  const input = { scopeKey: "dedupe", text: "同一句话", intent: "conversation", toolUse: "none", embed, thresholds: thresholds({ maxSamples: 4 }) };
  await rememberCompanionReleaseSample(input);
  await rememberCompanionReleaseSample(input);
  assert.equal(embeds, 1, "同一句原话只 embed 一次");
  for (let index = 0; index < 10; index += 1) {
    await rememberCompanionReleaseSample({ ...input, text: `另一句-${index}` });
  }
  const verdict = await evaluateCompanionRelease({
    scopeKey: "dedupe", text: "今天好累，想随便聊聊最近的事", embed, thresholds: thresholds({ maxSamples: 4 }),
  });
  assert.equal(verdict.samples, 4, "索引按上限截断");
});

test("embedding 失败时不写入样本（留给后续轮次重试）", async () => {
  let calls = 0;
  const embed = async (): Promise<readonly number[] | null> => { calls += 1; return calls === 1 ? null : SAFE_VEC; };
  const base = { scopeKey: "retry", text: "同一条", intent: "conversation", toolUse: "none", embed, thresholds: thresholds({ minSamples: 1 }) };
  await rememberCompanionReleaseSample(base);
  await rememberCompanionReleaseSample(base);
  const verdict = await evaluateCompanionRelease({ ...base, text: "今天好累，想随便聊聊最近的事" });
  assert.ok(verdict.samples >= 1, "第一次失败、第二次成功，样本应当入索引");
});

test("enforce 模式可解析；学习任务/正式作答进状态门", () => {
  assert.equal(resolveCompanionReleaseRouterMode("enforce"), "enforce");
  const gated = companionReleaseGates({
    text: "今天好累，想随便聊聊最近的事", activeLearningTask: true,
  });
  assert.equal(gated.learningTask, true);
});

test("放行闸合成：L1 说这一版可放就立即开；不适用时只等 L2", async () => {
  const releaseConversation = Promise.resolve<never>({
    decision: "release", reason: "released", intentGuess: "conversation",
    safeProbability: 0.95, toolNoneProbability: 0.95, topSimilarity: 0.97, samples: 12,
    gates: { pendingOffer: false, anaphora: false, short: false, learningTask: false },
  } as never);
  let fallbackResolved = false;
  const fallback = (): Promise<boolean> => { fallbackResolved = true; return new Promise<boolean>(() => undefined); };
  const open = companionReleaseGateFor(releaseConversation, "conversation", fallback);
  assert.equal(await open(), true);
  assert.equal(fallbackResolved, true, "L2 那一路仍然在并行等，只是不挡 L1");

  // 猜的意图对不上这架航班 → 闸门只由 L2 决定（这里 L2 说放行）。
  const slowVerdict = new Promise<never>(() => undefined);
  const wait = companionReleaseGateFor(slowVerdict, "conversation", async () => true);
  assert.equal(await wait(), true);

  // L1 明确不放行时也不挡 L2 的既有判据。
  const waitVerdict = Promise.resolve<never>({
    decision: "wait", reason: "probability", intentGuess: null,
    safeProbability: 0.5, toolNoneProbability: 0.5, topSimilarity: 0.95, samples: 12,
    gates: { pendingOffer: false, anaphora: false, short: false, learningTask: false },
  } as never);
  const keepByL2 = companionReleaseGateFor(waitVerdict, "question", async () => true);
  assert.equal(await keepByL2(), true);
});

test("历史打底：blocks + turn_interpretation 抽成样本，坏形状整行跳过", () => {
  const rows = extractCompanionReleaseSeedRows([
    { blocks: [{ type: "text", text: "今天好累" }, { type: "image", url: "x" }], turnInterpretation: { intent: "conversation", toolUse: "none" } },
    { blocks: [{ type: "text", text: "   " }], turnInterpretation: { intent: "conversation", toolUse: "none" } },
    { blocks: "not-an-array", turnInterpretation: { intent: "conversation", toolUse: "none" } },
    { blocks: [{ type: "text", text: "只给结论" }], turnInterpretation: null },
    { blocks: [{ type: "text", text: "帮我改格式" }], turnInterpretation: { intent: "task", toolUse: "act" } },
  ]);
  assert.deepEqual(rows, [
    { text: "今天好累", intent: "conversation", toolUse: "none" },
    { text: "帮我改格式", intent: "task", toolUse: "act" },
  ]);
});

test("历史打底：每个 scope 只跑一次，注入 loader 后索引变热", async () => {
  const scopeKey = "seed-scope";
  let loads = 0;
  const load = async () => {
    loads += 1;
    return [{ text: "今天好累", intent: "conversation", toolUse: "none" },
      { text: "帮我改格式", intent: "task", toolUse: "act" }];
  };
  const loadStored = async () => [];
  await seedCompanionReleaseIndex({
    scopeKey, workspaceId: "ws", userId: "user", load, loadStored,
    embed: async () => SAFE_VEC, thresholds: thresholds({ minSamples: 2, maxSamples: 8 }),
  });
  await seedCompanionReleaseIndex({
    scopeKey, workspaceId: "ws", userId: "user", load, loadStored,
    embed: async () => SAFE_VEC, thresholds: thresholds({ minSamples: 2, maxSamples: 8 }),
  });
  assert.equal(loads, 1, "同一个 scope 只打底一次");
  const verdict = await evaluateCompanionRelease({
    scopeKey, text: "今天好累，想随便聊聊最近的事", embed: async () => SAFE_VEC,
    thresholds: thresholds({ minSamples: 2 }),
  });
  assert.equal(verdict.samples, 2);
});

test("端口：本轮只算一次 embedding，两架航班共用", async () => {
  let embedded = 0;
  const scopeKey = "port-scope";
  for (let index = 0; index < 8; index += 1) {
    await rememberCompanionReleaseSample({
      scopeKey, text: `port-seed-${index}`, intent: "conversation", toolUse: "none",
      embed: async () => SAFE_VEC,
    });
  }
  const port = createCompanionReleaseRouterPort({
    mode: "enforce", scopeKey, text: "今天好累，想随便聊聊最近的事",
    embed: async () => { embedded += 1; return SAFE_VEC; },
  });
  const [first, second] = await Promise.all([port.evaluate(), port.evaluate()]);
  assert.equal(embedded, 1, "一次判断只发一次 embedding");
  assert.deepEqual(first, second);
});

test("原话规范化与账号键解析：非 UUID 的测试 scope 不会触发任何数据库读写", () => {
  assert.equal(normalizeCompanionReleaseText("  今天   好累\n"), "今天 好累");
  assert.deepEqual(parseCompanionReleaseScopeKey("11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222"), {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
  });
  assert.equal(parseCompanionReleaseScopeKey("shadow-aligned"), null);
  assert.equal(parseCompanionReleaseScopeKey("not-a-uuid:also-not"), null);
});

test("持久样本装回索引：坏向量跳过、同一行不重复入索引", () => {
  const scopeKey = "stored-scope";
  const rows = [
    { textSha256: "a".repeat(64), intent: "conversation", toolUse: "none", embedding: SAFE_VEC },
    { textSha256: "a".repeat(64), intent: "conversation", toolUse: "none", embedding: SAFE_VEC },
    { textSha256: "b".repeat(64), intent: "task", toolUse: "act", embedding: [0.2, 0.2, 0.2, 0.2] },
    { textSha256: "c".repeat(64), intent: "conversation", toolUse: "none", embedding: [] },
    { textSha256: "d".repeat(64), intent: "conversation", toolUse: "none", embedding: ["bad"] as never },
  ];
  assert.equal(indexStoredCompanionReleaseSamples(scopeKey, rows), 2, "只装两条合法行，且同一行只装一次");
  // 再装一次不会重复计数
  assert.equal(indexStoredCompanionReleaseSamples(scopeKey, rows), 0);
});

test("remember 的持久化钩子：只落规范化原话 + 标签 + 向量", async () => {
  const writes: Array<{ text: string; intent: string; toolUse: string; embedding: readonly number[] }> = [];
  await rememberCompanionReleaseSample({
    scopeKey: "fake-scope", text: "  今天   好累  ", intent: "conversation", toolUse: "none",
    embed: async () => SAFE_VEC, persist: async (row) => { writes.push(row); },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(writes, [{ text: "今天 好累", intent: "conversation", toolUse: "none", embedding: [...SAFE_VEC] }]);
});
