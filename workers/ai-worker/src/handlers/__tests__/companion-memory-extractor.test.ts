import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  buildExtractMessages,
  isMemoryExtractConfidenceAccepted,
  isMemoryValidityRangeUsable,
  memoryExtractOutputSchema,
  parseMemoryExtractJson,
  resolveMemoryExtractSource,
  isMemorySourceSuppressed,
} from "../memory/companion-memory-extractor.ts";
// 范围判据住在共享层（42 阶段 1 E）。抽取器只调用它，不自带一份。
import { memoryScopeForKind } from "@astella/shared/companion-memory-scope";
import {
  resolveCompanionMemoryTemporalMetadata,
  type CompanionMemoryTemporalMetadataInput,
} from "@astella/shared";
import type { WorkerTransaction } from "../../db.ts";

test("记忆抽取保留长原话末尾的取消和期限，不把旧偏好前缀当成完整陈述", () => {
  const userText = "以后要提醒我" + "背景".repeat(1000) + "末尾纠正：刚才的提醒不要记住了。";
  const assistantText = "已接住这次纠正。" + "解释".repeat(1000) + "末尾确认：没有保存任何提醒。";
  const old = "此前说法".repeat(500) + "旧原话最后的条件。";
  const messages = buildExtractMessages({ userText, assistantText, recent: [{ role: "user", text: old }] });
  assert.ok(messages[1]!.content.includes(userText));
  assert.ok(messages[1]!.content.includes(assistantText));
  assert.ok(messages[1]!.content.includes(old));
});

test("记忆置信度边界与抽取提示一致：0.7 可继续，低于 0.7 拒绝", () => {
  assert.equal(isMemoryExtractConfidenceAccepted(0.6999), false);
  assert.equal(isMemoryExtractConfidenceAccepted(0.7), true);
  assert.equal(isMemoryExtractConfidenceAccepted(1), true);
  assert.equal(isMemoryExtractConfidenceAccepted(Number.POSITIVE_INFINITY), false);
  assert.equal(isMemoryExtractConfidenceAccepted(Number.NaN), false);
});

test("有效期必须晚于来源事件且仍有效，永久记忆允许没有截止时间", () => {
  const now = new Date("2026-10-01T00:00:00.000Z");
  assert.equal(isMemoryValidityRangeUsable(null, null, now), true);
  assert.equal(isMemoryValidityRangeUsable("2026-10-02T00:00:00.000Z", "2026-09-30T00:00:00.000Z", now), true);
  assert.equal(isMemoryValidityRangeUsable("2026-09-30T00:00:00.000Z", "2026-09-29T00:00:00.000Z", now), false);
  assert.equal(isMemoryValidityRangeUsable("2026-09-30T00:00:00.000Z", "2026-10-01T00:00:00.000Z", now), false);
  assert.equal(isMemoryValidityRangeUsable("2026-10-02T00:00:00.000Z", undefined, now), false);
});

test("有效期只接受来源里的原样绝对时间；未转换的短期状态不得永久保存", () => {
  const quote = "我会在 2026-10-15T17:00:00+08:00 前完成复习";
  const base = {
    kind: "goal" as const,
    content: "在截止前完成复习",
    sourceQuote: quote,
    appliesWhen: null,
    validUntil: "2026-10-15T17:00:00+08:00",
  };
  const resolve = (
    overrides: Partial<Omit<CompanionMemoryTemporalMetadataInput, "sourceText">> = {},
    sourceText = quote,
  ) => resolveCompanionMemoryTemporalMetadata({ ...base, ...overrides, sourceText });
  assert.deepEqual(resolve(), {
    ok: true,
    appliesWhen: null,
    validUntil: "2026-10-15T17:00:00+08:00",
  });
  assert.deepEqual(
    resolve({ validUntil: "2026-10-16T00:00:00+08:00" }),
    { ok: false, reason: "unverifiable_valid_until" },
  );
  assert.deepEqual(
    resolve({
      sourceQuote: "我下周完成数据库索引复习",
      content: "下周完成数据库索引复习",
      validUntil: null,
    }, "我下周完成数据库索引复习"),
    { ok: true, appliesWhen: null, validUntil: null },
  );
  assert.deepEqual(
    resolve({
      kind: "episodic",
      sourceQuote: "今天一起复习了索引",
      content: "今天一起复习了索引",
      validUntil: null,
    }, "今天一起复习了索引"),
    { ok: true, appliesWhen: null, validUntil: null },
  );
  assert.deepEqual(
    resolve({
      sourceQuote: "我喜欢讲机制时先举例",
      content: "讲机制时先举例",
      appliesWhen: "累的时候",
      validUntil: null,
    }, "我喜欢讲机制时先举例"),
    { ok: true, appliesWhen: null, validUntil: null },
    "a paraphrased condition is dropped; the verified user preference itself still saves",
  );
});

test("memory extract messages: 包含 system 提示与拼接对话", () => {
  const messages = buildExtractMessages({
    userText: "我喜欢语音讲解",
    assistantText: "好呀，以后多用语音。",
    userMessageId: "00000000-0000-4000-8000-000000000001",
    assistantMessageId: "00000000-0000-4000-8000-000000000002",
    recent: [{ messageId: "00000000-0000-4000-8000-000000000003", role: "user", text: "今天学光合作用" }],
  });
  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /记忆整理器/);
  assert.match(messages[0].content, /sourceMessageId/);
  assert.match(messages[0].content, /sourceQuote/);
  assert.match(messages[0].content, /appliesWhen/);
  assert.match(messages[0].content, /validUntil/);
  assert.match(messages[0].content, /逐字包含完整 ISO 时间戳/);
  assert.match(messages[0].content, /sourceSpeaker 必须与该消息的真实说话者一致/);
  assert.match(messages[1].content, /我喜欢语音讲解/);
  assert.match(messages[1].content, /00000000-0000-4000-8000-000000000001/);
});

test("memory extract schema: 合法候选通过，低置信仍可解析", () => {
  const parsed = memoryExtractOutputSchema.safeParse({
    version: 1,
    candidates: [
      { kind: "preference", content: "喜欢语音讲解", importance: 0.7, confidence: 0.8, scope: "workspace", linkedEntityIds: [] },
    ],
  });
  assert.equal(parsed.success, true);
  if (parsed.success) assert.equal(parsed.data.candidates[0].kind, "preference");
});

test("记忆来源核验：只接受输入中用户消息的真实短引文", () => {
  const userMessageId = "00000000-0000-4000-8000-000000000011";
  const assistantMessageId = "00000000-0000-4000-8000-000000000012";
  const sourceText = "以后讲机制先举例，别一上来就下定义。";
  const source = { messageId: userMessageId, speaker: "user" as const, text: sourceText };
  const assistantSource = {
    messageId: assistantMessageId,
    speaker: "assistant" as const,
    text: "好，我以后讲机制先举例。",
  };
  const parseCandidate = (overrides: Record<string, unknown> = {}) =>
    memoryExtractOutputSchema.parse({
      candidates: [{
        kind: "preference",
        content: "解释机制时先举例",
        confidence: 0.9,
        sourceMessageId: userMessageId,
        sourceSpeaker: "user",
        sourceQuote: "以后讲机制先举例",
        sourceBasis: "direct_statement",
        ...overrides,
      }],
    }).candidates[0];

  const candidate = parseCandidate();
  assert.deepEqual(resolveMemoryExtractSource(candidate, [source]), { ok: true, source });
  assert.deepEqual(
    resolveMemoryExtractSource(parseCandidate({ sourceMessageId: "00000000-0000-4000-8000-000000000099" }), [source]),
    { ok: false, reason: "message_not_in_input" },
  );
  assert.deepEqual(
    resolveMemoryExtractSource(parseCandidate({ sourceSpeaker: "assistant" }), [source]),
    { ok: false, reason: "speaker_mismatch" },
  );
  assert.deepEqual(
    resolveMemoryExtractSource(parseCandidate({ sourceQuote: "别把建议当用户事实" }), [source]),
    { ok: false, reason: "quote_not_found" },
  );
  assert.deepEqual(
    resolveMemoryExtractSource(parseCandidate({ sourceBasis: undefined }), [source]),
    { ok: false, reason: "missing_basis" },
  );
  assert.deepEqual(
    resolveMemoryExtractSource(
      parseCandidate({ sourceMessageId: assistantMessageId, sourceSpeaker: "assistant", sourceQuote: "我以后讲机制先举例" }),
      [source, assistantSource],
    ),
    { ok: false, reason: "not_user_message" },
  );
});

test("来源抑制检查：命中墓碑时阻止同来源自动抽取", async () => {
  const queries: unknown[] = [];
  const tx = {
    execute: async (query: unknown) => {
      queries.push(query);
      return [{ suppressed: true }];
    },
  } as unknown as WorkerTransaction;
  assert.equal(
    await isMemorySourceSuppressed(
      tx,
      "33333333-3333-4333-8333-333333333333",
      "goal",
      "00000000-0000-4000-8000-000000000011",
    ),
    true,
  );
  assert.equal(queries.length, 1);
});

test("parseMemoryExtractJson: 纯 JSON 原样解析", () => {
  const out = parseMemoryExtractJson('{"version":1,"candidates":[]}');
  assert.deepEqual(out, { version: 1, candidates: [] });
});

test("parseMemoryExtractJson: ```json fence 包裹可剥离解析", () => {
  const out = parseMemoryExtractJson('```json\n{"version":1,"candidates":[{"kind":"preference","content":"喜欢安静","importance":0.6,"confidence":0.9,"scope":"workspace","linkedEntityIds":[]}]}\n```');
  assert.equal((out as { candidates: unknown[] }).candidates.length, 1);
});

test("parseMemoryExtractJson: 前后赘述提取首个 JSON 片段", () => {
  const out = parseMemoryExtractJson('好的，这是提取结果：{"version":1,"candidates":[]} 希望对你有帮助');
  assert.deepEqual(out, { version: 1, candidates: [] });
});

test("parseMemoryExtractJson: 全形态失败抛 SyntaxError", () => {
  assert.throws(() => parseMemoryExtractJson("完全不是 JSON"), SyntaxError);
});

// ─── schema 宽容度（§9.11：88 次解析失败的主因是契约没告诉模型、又卡得死）──
// 模型自然输出的是"最小可用形状"，schema 必须接住它。

test("schema：省略 version 字段可解析（以前 z.literal(1) 必填 → 整单失败）", () => {
  const out = memoryExtractOutputSchema.safeParse({
    candidates: [{ kind: "goal", content: "下个月考日语N3", confidence: 0.9 }],
  });
  assert.equal(out.success, true, JSON.stringify(out.success ? {} : out.error.issues));
  if (out.success) {
    assert.equal(out.data.version, 1, "version 应回填默认 1");
    assert.equal(out.data.candidates[0].importance, 0.5, "importance 有默认");
    assert.equal(out.data.candidates[0].scope, "workspace", "scope 有默认");
    assert.equal(out.data.candidates[0].appliesWhen, null, "适用条件无默认内容");
    assert.equal(out.data.candidates[0].validUntil, null, "无明确期限时不推测截止时间");
    assert.deepEqual(out.data.candidates[0].linkedEntityIds, []);
  }
});

test("schema：模型给出几条就收几条，既不截断也不判整单失败", () => {
  // 2026-10-12 裁决取消条数上限：`MEMORY_EXTRACT_MAX_FACTS=3`、默认 1、schema 的
  // `.max(3)`、preprocess 的 `.slice(0,3)` 都没了——一次解释里有几条独立事实就收几条。
  // 重复的折叠不归这里：那是 (kind, sourceQuote) 那条语义判据（用例在
  // companion-memory-admission.test.ts 的「同 kind 同 sourceQuote 只收一条」）。
  const many = Array.from({ length: 5 }, (_, i) => ({
    kind: "preference", content: `偏好 ${i}`, confidence: 0.8,
  }));
  const out = memoryExtractOutputSchema.safeParse({ candidates: many });
  assert.equal(out.success, true, "模型多给两条不该把整轮记忆一起丢掉");
  if (out.success) {
    assert.equal(out.data.candidates.length, 5, "不在解析这一层剪掉后面的条目");
    assert.deepEqual(out.data.candidates.map((candidate) => candidate.content),
      many.map((candidate) => candidate.content), "条目顺序与正文原样");
  }
});

test("schema：confidence 仍必填——它是置信度闸的输入，给默认值等于替模型表态", () => {
  const out = memoryExtractOutputSchema.safeParse({
    candidates: [{ kind: "goal", content: "没有置信度的条目" }],
  });
  assert.equal(out.success, false);
});

test("schema：kind 非法枚举仍被拒（宽容只针对缺省，不针对错值）", () => {
  const out = memoryExtractOutputSchema.safeParse({
    candidates: [{ kind: "secret", content: "不该被接受", confidence: 0.9 }],
  });
  assert.equal(out.success, false);
});

test("prompt 必须把 JSON 形状与枚举写给模型（契约不能只在代码里）", () => {
  const messages = buildExtractMessages({ userText: "u", assistantText: "a", recent: [] });
  const system = messages[0].content;
  assert.ok(system.includes('"candidates"'), "prompt 未给出 JSON 形状");
  for (const kind of ["goal", "preference", "learning_context", "interaction_note", "episodic"]) {
    assert.ok(system.includes(kind), `prompt 未列出枚举 ${kind}`);
  }
  assert.ok(system.includes("confidence"), "prompt 未说明 confidence");
});

test("prompt 用现行准入反例区分临时请求、条件偏好、引用、改口与短期目标", () => {
  const system = buildExtractMessages({ userText: "u", assistantText: "a", recent: [] })[0].content;
  for (const example of [
    "这一次希望先看例子",
    "以后我累的时候别催学习",
    "今天喜欢这个例子",
    "我不认同",
    "更正：我现在晚上更方便学习",
    "我希望下周完成数据库索引复习",
    "稳定 ID 与 expectedRevision 安全定位旧记录",
  ]) {
    assert.ok(system.includes(example), `prompt 缺少准入对照样本：${example}`);
  }
});

// ─── 伴星思考档的归属（2026-10-06 第二次改判，取代「全链路常开最高档」）──────
// 入口策略在第一步前定下这一轮开不开思考。因此"谁可以关思考"要守住的是两条：
//   1. 后台 handler（摘要、抽取、日记、制卡…）不在关键路径上，**一律不关**，
//      思考预留由各自的 maxTokens 承担——这条与上一版守卫同源；
//   2. 对话链路要关只能通过入口/加深策略，不许在某个调用点上悄悄写死一个
//      `disableThinking: true`。
const thinkingSanctioned = new Set([
  // 2026-10-11：压缩用的**工作状态摘要**。产出是给她自己接续工作的内部件，不是讲给
  // 用户的回复，而这次调用发生在已经紧张的那一次请求里面、卡在 deadlineAt 上——
  // 开高档等于在她回话的路上再加十几秒。
  // 它被单独挪进这个模块而不是留在运行时里，正是为了让这条守卫仍然管得住对话主链路：
  // `companion-agent-runtime.ts` 只能经入口策略决定思考档。
  "companion-active-context-compaction.ts",
  // 2026-10-13：回复终态之后补的可选追问。它不在这条守卫保护的"她回话的路"上，
  // 但它只有一次 3 秒的窗口：开思考档的模型普遍要十几秒，追问就永远赶不到气泡上，
  // 而这件事本身只是"要不要再问一句"的判断，不是给她组织的正文。
  "companion-followup-suggestions.ts",
  // Narrow publication review compares already written speech and authoritative
  // run status. It never generates a question answer or performs background work.
  "companion-initiative-speech-review.ts",
  // Independent provenance/status review uses a separate measured JSON contract.
  // It does not generate or grade the answer, whose effort still follows entry.
  "companion-completion-guard.ts",
]);

test("伴星思考档：对话按本轮意图选择，其余后台按各自预算运行", () => {
  // 扫的是 handlers 目录本体（`..`），不是 __tests__ ——旧版本用的 `.` 会把自己
  // 所在的测试目录当扫描面，`.test.` 过滤又把里面的文件全排除，等于空转。
  const dir = new URL("..", import.meta.url);
  // handlers 按职责分了子目录：递归收，豁免名单仍按文件名匹配（组只影响位置）。
  const files: Array<{ name: string; url: URL }> = [];
  const collect = (base: URL): void => {
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") collect(new URL(`${entry.name}/`, base));
        continue;
      }
      if (entry.name.startsWith("companion-") && entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
        files.push({ name: entry.name, url: new URL(entry.name, base) });
      }
    }
  };
  collect(new URL("", dir));
  const offenders = files
    .filter(({ name }) => !thinkingSanctioned.has(name))
    .filter(({ url }) => {
      const text = readFileSync(url, "utf8");
      // 两条历史路径都算：包 provider 的 withThinkingDisabled、每次调用写死的
      // disableThinking: true（走策略函数算出来的布尔值不在此列）。
      return text.includes("withThinkingDisabled(") || text.includes("disableThinking: true");
    })
    .map(({ name }) => name);
  // Classification and pixel transcription are independent short contracts;
  // neither generates the final answer or chooses application operations.
  assert.deepEqual(offenders.filter(name => !["companion-entry-decision.ts", "companion-image-batches.ts"].includes(name)), [],
    `这些执行 handler 绕开资源策略把思考关死了：${offenders.join(", ")}`);

  // 正向：对话主链路确实经过显式的入口/加深策略，而不是各自决定。
  const runtime = readFileSync(new URL("agent/companion-agent-runtime.ts", dir), "utf8");
  assert.match(runtime, /disableThinking: stepReasoningEffort === "none"/,
    "Agent 运行时不再经过 directControls，快速档与加深档就会散成各处硬编码");
});

// ─── 跨空间记忆的判据（2026-09-22 裁决 + 收紧）──────────────────────────
// 判据本体在 `@astella/shared/companion-memory-scope`（42 阶段 1 E）。这里断言的是
// **worker 这一侧的用法**：仍然按模型 binding + 确定性规则两道判、缺省本地，
// 而且抽取器不再自带第二份正则——那份判据现在同时管着手动保存的写入端。
// 这些断言直接对着 dev 库那批真种子记忆写：分界线是从数据里读出来的，不是猜的。

test("跨空间判据：只有 preference 可能跨空间，其余留在原空间", () => {
  // 正向：偏好——关于"怎么学、怎么相处"——跟人走。
  assert.equal(memoryScopeForKind("preference", "workspace", "portable"), "global");
  assert.equal(memoryScopeForKind("preference", "workspace", "portable"), "global");
  assert.equal(memoryScopeForKind("preference", "workspace", "portable"), "global");
  assert.equal(memoryScopeForKind("preference", "workspace", "portable"), "global");
  // 负向：这四类绑定空间内的东西。
  assert.equal(memoryScopeForKind("interaction_note", "workspace", "portable"), "workspace");
  assert.equal(memoryScopeForKind("goal", "workspace", "portable"), "workspace");
  assert.equal(memoryScopeForKind("learning_context", "workspace", "portable"), "workspace");
  assert.equal(memoryScopeForKind("episodic", "workspace", "portable"), "workspace");
});

test("跨空间判据：非跨空间种类仍尊重模型给的 task 细分", () => {
  assert.equal(memoryScopeForKind("episodic", "task", "local"), "task");
  assert.equal(memoryScopeForKind("goal", "task", "local"), "task");
  // 跨空间种类不吃 task：偏好不是"这一轮"的东西。
  assert.equal(memoryScopeForKind("preference", "task", "portable"), "global");
});

test("范围判据只有一份：抽取器调用共享层，不自带正则或第二套判定", () => {
  // 判据一旦在抽取器和写入端各有一份，漂移的方向通常是写入端那份更松——那正是
  // 42 阶段 1 E 要补的洞。所以这里守的是"只有一处定义"，而不只是"值对不对"。
  const source = readFileSync(new URL("../memory/companion-memory-extractor.ts", import.meta.url), "utf8");
  assert.match(source, /from "@astella\/shared\/companion-memory-scope"/,
    "抽取器没有走共享判据：写入端与抽取端可能已经各判各的");
  for (const duplicated of ["LOCAL_REFERENCE_PATTERN", "SUBJECT_OR_EXAM_PATTERN", "CROSS_SPACE_KINDS"]) {
    assert.ok(!source.includes(duplicated), `抽取器里又出现了一份 ${duplicated}：判据不再唯一`);
  }
  // 调用点仍要按"两道判据"传参：少传 binding 会让缺省方向翻面（见共享层注释）。
  assert.match(source, /memoryScopeForKind\(candidate\.kind, candidate\.scope, candidate\.binding\)/);
});
