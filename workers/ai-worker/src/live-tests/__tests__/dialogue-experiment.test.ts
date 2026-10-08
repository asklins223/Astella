import assert from "node:assert/strict";
import { test } from "node:test";
import { dialogueCases, dialogueGenerationFixture } from "../dialogue-cases.ts";
import { buildDialogueExperimentRequest, buildDialogueIdentityDiagnostic, buildDialogueThinkingDiagnostic, dialogueMatrixSchedule, snapshotDialogueRequest, snapshotDialogueWireBody } from "../dialogue-experiment.ts";
import { buildDialogueReviewPacket } from "../dialogue-review-packet.ts";
import { resolveDialogueCandidate, dialogueCandidateThinking } from "../dialogue-candidate.ts";
import type { AIPlatformConfig } from "@astella/shared/platform-config";

test("冻结候选的闲聊档只改闲聊配置，求助、原文与原档案保持完整", () => {
  const route = resolveDialogueCandidate({ platforms: { p: { type: "opencode_go", apiKey: "fixture",
    baseUrl: "https://example.com", models: { m: { contextWindowTokens: 10000, maxOutputTokens: 8000,
      reasoning: { levels: ["none", "low", "medium"], default: "medium" } } } } }, capabilities: {} }, "p", "m");
  const original = structuredClone(route);
  for (const id of ["resume", "practice-help"]) {
    const fixture = dialogueGenerationFixture(dialogueCases.find(c => c.id === id)!);
    const { request } = buildDialogueExperimentRequest(fixture, "full", 8000);
    const configured = dialogueCandidateThinking(route, request, fixture.intent, "low");
    assert.deepEqual(configured.request.messages, request.messages);
    assert.deepEqual({ ...configured.request, disableThinking: request.disableThinking }, request);
    assert.equal(configured.route.modelProfile!.reasoning!.default, id === "resume" ? "low" : "medium");
    assert.equal(configured.request.disableThinking, false);
    assert.deepEqual(route, original);
    assert.throws(() => dialogueCandidateThinking(route, request, fixture.intent, "high"), /declared/);
  }
});

test("跨平台候选只用已配置且已声明的模型，不改变正式路由", () => {
  const config: AIPlatformConfig = { platforms: { candidate: { type: "openai_compatible", apiKey: "test-key",
    baseUrl: "https://example.com/v1", models: { model: { contextWindowTokens: 32768, maxOutputTokens: 8192,
      reasoning: { levels: ["none", "high"], default: "high" } } } } },
    capabilities: { agent_turn: { platform: "current", model: "current-model" } } };
  const before = structuredClone(config), resolved = resolveDialogueCandidate(config, "candidate", "model");
  assert.equal(resolved.platformId, "candidate");
  resolved.modelProfile!.maxOutputTokens = 1;
  assert.deepEqual(config, before);
  assert.throws(() => resolveDialogueCandidate(config, "candidate", "undeclared"), /declared/);
  assert.throws(() => resolveDialogueCandidate(null, "candidate", "model"), /declared/);
  config.platforms.candidate!.apiKey = "${UNRESOLVED}";
  assert.throws(() => resolveDialogueCandidate(config, "candidate", "model"), /unresolved/);
  config.platforms.candidate!.apiKey = "test-key";
  config.platforms.candidate!.type = "dashscope";
  assert.throws(() => resolveDialogueCandidate(config, "candidate", "model"), /protocol/);
  config.platforms.candidate!.type = "openai_compatible";
  delete config.platforms.candidate!.models!.model!.maxOutputTokens;
  assert.throws(() => resolveDialogueCandidate(config, "candidate", "model"), /token limits/);
});

test("30 个话题按设计与隔离材料分开，生成输入不含评阅判据", () => {
  assert.equal(dialogueCases.filter(c => c.split === "design").length, 10);
  assert.equal(dialogueCases.filter(c => c.split === "heldout").length, 20);
  assert.equal(new Set(dialogueCases.map(c => c.id)).size, 30);
  assert.equal(new Set(dialogueCases.map(c => c.topic)).size, 30);
  for (const c of dialogueCases) {
    const fixture = dialogueGenerationFixture(c);
    assert.deepEqual(Object.keys(fixture).sort(), ["history", "id", "intent", "userText"]);
    const { request } = buildDialogueExperimentRequest(fixture, "full", 131072);
    for (const criterion of c.criteria) assert.ok(!JSON.stringify(request).includes(criterion));
  }
});

test("上下文对照仅移除声明的合成背景，原生历史、人格、权限和参数保持一致", () => {
  const c = dialogueGenerationFixture(dialogueCases.find(c => c.id === "song")!);
  const a = buildDialogueExperimentRequest(c, "full", 131072);
  const b = buildDialogueExperimentRequest(c, "relevant", 131072);
  assert.deepEqual(a.request.messages, b.request.messages);
  for (const key of ["tools", "disableThinking", "temperature", "maxTokens", "role"] as const)
    assert.deepEqual(a.request[key], b.request[key]);
  assert.equal(a.provenance.originalHistoryHash, b.provenance.originalHistoryHash);
  assert.deepEqual(b.provenance.removedSources, ["here_and_now", "summary", "page_context"]);
  for (const source of ["system_base", "persona", "conversation_timeline", "voice_expression"])
    assert.equal(a.receipts.find(r => r.id === source)?.status, b.receipts.find(r => r.id === source)?.status);
  assert.match(b.request.systemPrompt, /爱吃白饭/);
  assert.match(b.request.systemPrompt, /本轮只回应用户此刻的话题/);
  assert.doesNotMatch(b.request.systemPrompt, /更早的合成会话|页面为笔记库/);
});

test("显式求助仍走知识参数，长原话与历史末尾不被评测入口截掉", () => {
  const c = dialogueGenerationFixture(dialogueCases.find(c => c.id === "practice-help")!);
  c.userText += "很长的说明".repeat(1500) + "最后一个细节";
  c.history = [{ role: "user", text: "旧话".repeat(2000) + "旧话最后" }];
  const { request } = buildDialogueExperimentRequest(c, "relevant", 131072);
  assert.equal(request.disableThinking, false);
  assert.equal(request.temperature, 0.3);
  assert.equal(request.messages.at(-1)?.content, c.userText);
  assert.equal(request.messages[0]?.content, c.history[0]?.text);
});

test("简洁身份只作多变量诊断，保留原生消息、参数及必需合同", () => {
  for (const id of ["song", "practice-help"]) {
    const fixture = dialogueGenerationFixture(dialogueCases.find(c => c.id === id)!);
    const control = buildDialogueExperimentRequest(fixture, "relevant", 131072, "absent");
    const diagnostic = buildDialogueIdentityDiagnostic(fixture, 131072);
    assert.deepEqual({ ...diagnostic.request, systemPrompt: "" }, { ...control.request, systemPrompt: "" });
    for (const policy of ["没有真实工具结果", "动作是否完成以业务回执为准", "声音表达协议", "<conversation_timeline>"])
      assert.ok(diagnostic.request.systemPrompt.includes(policy));
    assert.doesNotMatch(diagnostic.request.systemPrompt, /<persona_data>|脑子也得有个下班点|爱吃白饭/);
    assert.match(diagnostic.provenance.note, /Multiple prompt changes/);
    assert.notEqual(diagnostic.request.systemPrompt, control.request.systemPrompt);
  }
});

test("思考对照只改开关，明确求助继续保留原配置", () => {
  for (const id of ["resume", "practice-help"]) {
    const fixture = dialogueGenerationFixture(dialogueCases.find(c => c.id === id)!);
    const a = buildDialogueThinkingDiagnostic(fixture, 131072, "automatic");
    const b = buildDialogueThinkingDiagnostic(fixture, 131072, "enabled");
    assert.deepEqual({ ...a.request, disableThinking: false }, b.request);
    assert.equal(b.request.disableThinking, false);
    assert.equal(a.request.disableThinking, id === "resume");
    assert.equal(a.provenance.originalHistoryHash, b.provenance.originalHistoryHash);
    assert.match(b.provenance.note, /actual effort/);
  }
});

test("语境示例只替换无语境样例，不改变原生消息、人格其他字段和参数", () => {
  const fixture = dialogueGenerationFixture(dialogueCases.find(c => c.id === "resume")!);
  const a = buildDialogueExperimentRequest(fixture, "relevant", 128000);
  const b = buildDialogueExperimentRequest(fixture, "relevant", 128000, "contextual");
  assert.deepEqual({ ...a.request, systemPrompt: "" }, { ...b.request, systemPrompt: "" });
  assert.match(b.request.systemPrompt, /情境：|快捷键|表格导入/);
  assert.match(b.request.systemPrompt, /爱吃白饭/);
  assert.match(b.request.systemPrompt, /不是事实或待复述的台词/);
  for (const criterion of dialogueCases.find(c => c.id === "resume")!.criteria)
    assert.ok(!b.request.systemPrompt.includes(criterion));
});

test("请求快照固定完整文本与哈希，拒绝保存隐藏推理回放句柄", () => {
  const { request } = buildDialogueExperimentRequest(dialogueGenerationFixture(dialogueCases[0]!), "full", 131072);
  const saved = snapshotDialogueRequest(request);
  request.messages[0]!.content = "changed";
  assert.notEqual(saved.request.messages[0]!.content, "changed");
  assert.equal(saved.hash, snapshotDialogueRequest(saved.request).hash);
  request.messages[0]!.reasoning = [{ id: "opaque" }];
  assert.throws(() => snapshotDialogueRequest(request), /reasoning/);
  const wire = snapshotDialogueWireBody({ model: "m", instructions: "p", input: [{ role: "user", content: "full" }],
    reasoning: { effort: "none" }, temperature: 0.9, apiKey: "secret", headers: { authorization: "secret" } });
  assert.deepEqual(wire.body.reasoning, { effort: "none" });
  assert.equal(wire.complete, false);
  assert.equal(wire.omittedFieldCount, 2);
  assert.doesNotMatch(JSON.stringify(wire), /secret|authorization|apiKey/);
  assert.throws(() => snapshotDialogueWireBody({ input: [{ type: "reasoning", encrypted_content: "opaque" }] }), /reasoning/);
  const stream = snapshotDialogueWireBody({ model: "m", stream: true, stream_options: { include_usage: true } });
  assert.equal(stream.complete, true);
  assert.deepEqual(stream.body.stream_options, { include_usage: true });
});

test("配对顺序轮换、重复可追踪，无重复案例和超额采样", () => {
  const schedule = dialogueMatrixSchedule(["a", "b"], 2);
  assert.equal(schedule.length, 16);
  for (const id of ["a", "b"]) for (const repeat of [0, 1])
    assert.equal(new Set(schedule.filter(s => s.caseId === id && s.repeat === repeat).map(s => s.condition)).size, 4);
  assert.notEqual(schedule[0]!.condition, schedule[4]!.condition);
  assert.throws(() => dialogueMatrixSchedule(["a", "a"], 1));
  assert.throws(() => dialogueMatrixSchedule(["a"], 3));
});

test("匿名评阅材料不暴露模型条件、哈希与等待，不预填评阅意见", () => {
  const samples = ["current/full", "current/relevant", "candidate/full", "candidate/relevant"].map(condition => ({
    caseId: "plant", repeat: 0, condition, answer: "[neutral]新叶回来了。", structuralOk: true,
  }));
  const { packet, key } = buildDialogueReviewPacket(samples, () => 0);
  const encoded = JSON.stringify(packet);
  assert.doesNotMatch(encoded, /current\/|candidate\/|full|relevant|hash|elapsedMs|\[neutral\]/);
  assert.equal(packet.packets.length, 1);
  assert.equal(key.responses.length, 4);
  assert.ok(packet.packets[0]!.ratings.every(r => r.persona === null && r.evidence.length === 0));
  assert.deepEqual(packet.packets[0]!.preference.groupsBestToWorst, []);
  assert.equal(new Set(key.responses.map(r => r.condition)).size, 4);
  assert.throws(() => buildDialogueReviewPacket([samples[0]!, samples[0]!]));
});
