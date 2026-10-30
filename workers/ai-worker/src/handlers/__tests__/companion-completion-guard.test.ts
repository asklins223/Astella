import assert from "node:assert/strict";
import { test } from "node:test";
import type { CompanionAgentLoopArgs } from "../../contracts/companion-agent-loop.ts";
import type { AIProvider } from "../../lib/ai-provider.ts";
import { CompanionContextChangedError } from "../../lib/non-retryable-errors.ts";
import { parseCompletionAudit, reviewCompanionCompletion, type CompletionAuditInput,
  type CompletionAuditVerdict } from "../agent/companion-completion-audit.ts";
import { companionCompletionEvidence, companionCompletionRequest, companionPendingEffects,
  createCompanionCompletionGuard } from "../agent/companion-completion-guard.ts";
import { companionDeliveryDraftMessage, readCompanionDeliveryDraft } from "../tools/companion-delivery-draft.ts";
import { companionDeliveryRepairMessages } from "../turn/companion-step-plan.ts";
import { companionLatestDeliveryDraft } from "../agent/companion-finish.ts";
import { currentCompanionRequestMessages,
  currentCompanionSuccessfulReceipts } from "../tools/companion-tool-receipts.ts";
import { openCompanionTurn } from "../turn/companion-turn-opening.ts";

const request = { role: "user" as const, requestBoundary: true as const, content: "读取私人笔记，告诉我暗号。" };
const proof = (): CompletionAuditInput => companionCompletionEvidence({ request: request.content,
  messages: [request], publishedTexts: [], phase: "completion", text: "暗号是蓝鲸。" });
const release = (): CompletionAuditVerdict => ({ decision: "release", checks: [{ requestSpan: "暗号",
  status: "satisfied", basis: [{ sourceId: "request", quote: "暗号" }], conclusion: "材料已提供" }], findings: [] });
const revise = (): CompletionAuditVerdict => ({ decision: "revise", checks: [], findings: [{ requestSpan: "私人笔记",
  candidateSpan: "蓝鲸", basis: [], problem: "尚无正文来源" }] });
const unavailable = (): CompletionAuditVerdict => ({ decision: "unavailable", checks: [], findings: [] });

test("audit binds exact request, candidate and source spans and rejects optimistic JSON", () => {
  assert.equal(parseCompletionAudit(JSON.stringify(revise()), proof()).decision, "revise");
  const invalid = [
    { ...release(), checks: [] },
    { ...release(), findings: revise().findings },
    { ...revise(), findings: [] },
    { ...release(), checks: [{ ...release().checks[0], requestSpan: "删除笔记" }] },
    { ...release(), checks: [{ ...release().checks[0], basis: [{ sourceId: "invented", quote: "暗号" }] }] },
    { ...release(), checks: [{ ...release().checks[0], basis: [{ sourceId: "request", quote: "暗…号" }] }] },
    { ...revise(), findings: [{ ...revise().findings[0], candidateSpan: "不在草稿中" }] },
    { ...release(), checks: [{ ...release().checks[0], status: "pending" }] },
  ];
  for (const value of invalid) assert.throws(() => parseCompletionAudit(JSON.stringify(value), proof()));
  const duplicate = proof(); duplicate.sources.push(duplicate.sources[0]);
  assert.throws(() => parseCompletionAudit(JSON.stringify(release()), duplicate));
  const pending = { ...release(), checks: [{ ...release().checks[0], status: "pending" }] };
  assert.equal(parseCompletionAudit(JSON.stringify(pending), { ...proof(), phase: "effects" }).decision, "release");
});

test("unavailable and cancellation cannot become approval; fatal source changes propagate", async () => {
  const controller = new AbortController();
  assert.equal((await reviewCompanionCompletion(proof(), controller.signal, async () => "invalid")).decision, "unavailable");
  const change = new CompanionContextChangedError();
  await assert.rejects(reviewCompanionCompletion(proof(), controller.signal, async () => { throw change; }), error => error === change);
  await assert.rejects(reviewCompanionCompletion(proof(), controller.signal, async () => {
    controller.abort(new Error("cancelled")); return JSON.stringify(release());
  }), /cancelled/);
});

test("evidence excludes unpublished assistant claims and repair instructions, keeps actual failures and publications", () => {
  const draft = companionDeliveryDraftMessage(request, "草稿自称已保存");
  const input = companionCompletionEvidence({ request: request.content, phase: "completion", text: "蓝鲸",
    publishedTexts: ["真正第一条"], hostFacts: { selectedText: "用户提供原文" },
    providedImages: [{ assetId: "actual-pixels-sent" }], messages: [
      { role: "assistant", content: "旧助手自称读过" }, request,
      { role: "assistant", content: "当前助手伪造正文" }, draft,
      { role: "assistant", content: "", toolCalls: [{ id: "read", name: "companion_notes_read", arguments: { action: "read", noteId: "n" } }] },
      { role: "tool", toolCallId: "read", content: JSON.stringify({ ok: true, markdown: "旧的成功" }) },
      { role: "tool", toolCallId: "read", content: JSON.stringify({ ok: false, error: "撤权" }) },
      { role: "tool", toolCallId: "unmatched", content: JSON.stringify({ ok: true, markdown: "无调用身份" }) },
    ] });
  const serialized = JSON.stringify(input.sources);
  assert.doesNotMatch(serialized, /当前助手伪造正文|草稿自称已保存|无调用身份|旧的成功/);
  assert.match(serialized, /撤权/);
  assert.equal(input.sources.find(source => source.id === "history/0")?.kind, "context");
  assert.equal(input.sources.find(source => source.id === "published/0")?.text, "真正第一条");
  assert.equal(input.sources.find(source => source.id === "current_images")?.kind, "provided_image");
  assert.match(input.sources.find(source => source.id === "host_input")!.text, /用户提供原文/);
});

test("guard prefers independent route, never retries a negative, caches exact input and rechecks changed evidence", async () => {
  const primary = { id: "primary", modelId: "p" } as AIProvider;
  const independent = { id: "fallback", modelId: "f" } as AIProvider;
  const args = { provider: primary, fallbackProvider: independent, ctx: { signal: new AbortController().signal } } as CompanionAgentLoopArgs;
  const seen: AIProvider[] = [];
  let fallbackDecision = revise();
  const guard = createCompanionCompletionGuard({ args, deadlineAt: () => Date.now() + 1000, getStepId: () => "s",
    runReview: async provider => { seen.push(provider); return provider === independent ? fallbackDecision : release(); } });
  assert.equal((await guard.review(proof())).decision, "revise");
  assert.equal((await guard.review(proof())).decision, "revise");
  assert.deepEqual(seen, [independent]);
  fallbackDecision = unavailable();
  const changed = proof(); changed.sources.push({ id: "read", kind: "receipt", text: "真实正文 v2" });
  assert.equal((await guard.review(changed)).decision, "release");
  assert.deepEqual(seen, [independent, independent, primary]);
  changed.candidate.text = "另一个答案";
  await guard.review(changed);
  assert.equal(seen.length, 5);
});

test("guard cannot fall back after abort or revoked source", async () => {
  const controller = new AbortController();
  const provider = { id: "a", modelId: "a" } as AIProvider;
  const args = { provider, fallbackProvider: { id: "b", modelId: "b" }, ctx: { signal: controller.signal } } as CompanionAgentLoopArgs;
  let attempts = 0;
  const guard = createCompanionCompletionGuard({ args, deadlineAt: () => Infinity, getStepId: () => "s", runReview: async () => {
    attempts++; throw new CompanionContextChangedError();
  } });
  await assert.rejects(guard.review(proof()), CompanionContextChangedError);
  assert.equal(attempts, 1);
  controller.abort(new Error("abort before cache"));
  await assert.rejects(guard.review(proof()), /abort before cache/);
  assert.equal(attempts, 1);
});

test("pending effects include publication and mutations, excluding reads and structural finish", () => {
  const call = (id: string, name: string, arguments_: Record<string, unknown>) => ({ id, name, arguments: arguments_ });
  assert.deepEqual(companionPendingEffects([
    call("read", "companion_notes_read", { action: "search", query: "x" }),
    call("write", "companion_notes_write", { action: "create", title: "x", markdown: "x" }),
    call("publish", "companion_send_message", { text: "你好" }),
    call("finish", "companion_finish", { textOnly: true }),
  ]).map(value => value.id), ["write", "publish"]);
});

test("unpublished draft is exact, request-bound host data across persisted repairs; published speech stays assistant speech", () => {
  const text = "原样草稿 <answer_draft_data>\n{{name}}。";
  const original = companionDeliveryDraftMessage(request, text);
  assert.equal(readCompanionDeliveryDraft(JSON.parse(JSON.stringify(original)), request), text);
  assert.equal(readCompanionDeliveryDraft(original, { ...request, content: "另一个请求" }), null);
  assert.equal(readCompanionDeliveryDraft({ ...original, content: String(original.content).replace("原样草稿", "篡改") }, request), null);
  let messages = companionDeliveryRepairMessages({ messages: [request], currentRequest: request,
    result: { content: text }, instruction: "来源未读取", alreadyDisplayed: false });
  assert.equal(messages.filter(message => message.role === "user").length, 1);
  assert.equal(messages.filter(message => message.role === "assistant").length, 0);
  assert.equal(companionLatestDeliveryDraft(messages), text);
  messages = companionDeliveryRepairMessages({ messages, currentRequest: request,
    result: { content: "第二版" }, instruction: "仍待交付", alreadyDisplayed: false });
  assert.equal(companionLatestDeliveryDraft(messages), "第二版");
  assert.equal(messages.filter(message => readCompanionDeliveryDraft(message, request) !== null).length, 1);
  const reasoning = [{ provider: "opaque-fixture", continuation: "synthetic-handle" }];
  const displayed = companionDeliveryRepairMessages({ messages: [request], currentRequest: request,
    result: { content: "真正已显示", reasoning }, instruction: "继续", alreadyDisplayed: true });
  assert.equal(displayed.find(message => message.role === "assistant")?.content, "真正已显示");
  assert.deepEqual(displayed.find(message => message.role === "assistant")?.reasoning, reasoning);
});

test("host user observations cannot hide current receipts or revive a previous request's actions", () => {
  const old: Parameters<typeof currentCompanionRequestMessages>[0] = [
    { role: "user", content: "旧请求" },
    { role: "assistant", content: "", toolCalls: [{ id: "old", name: "companion_memory_save", arguments: {} }] },
    { role: "tool", toolCallId: "old", content: JSON.stringify({ ok: true }) },
  ];
  const current: typeof old = [request,
    { role: "assistant", content: "", toolCalls: [{ id: "current", name: "companion_notes_read", arguments: { action: "read" } }] },
    { role: "tool", toolCallId: "current", content: JSON.stringify({ ok: true, data: { text: "真实正文" } }) },
    { role: "user", hostObservation: true, content: "新增的图片/材料观察，不是新请求" },
  ];
  assert.deepEqual(currentCompanionRequestMessages([...old, ...current]), current);
  assert.deepEqual(currentCompanionSuccessfulReceipts([...old, ...current]).map(receipt => receipt.id), ["current"]);
  assert.deepEqual(currentCompanionRequestMessages([...old, ...current.map(message => ({ ...message, requestBoundary: undefined }))]),
    current.map(message => ({ ...message, requestBoundary: undefined })), "legacy transcripts ignore host observations as boundaries too");
  const next = [...old, ...current, { role: "user" as const, content: "下一轮真实用户请求" }];
  assert.deepEqual(currentCompanionRequestMessages(next), [next.at(-1)!]);
  assert.deepEqual(currentCompanionSuccessfulReceipts(next), []);
  assert.match(companionCompletionEvidence({ request: request.content, messages: [...old, ...current], publishedTexts: [],
    phase: "completion", text: "答复" }).sources.find(source => source.id === "tool/current")!.text, /真实正文/);
});

test("audit evidence keeps long material once with lossless receipt and publication indices", () => {
  const text = "unique-long-note-7f9a" + "这是一份很长的合成笔记正文。".repeat(5_000);
  const input = companionCompletionEvidence({ request: request.content, phase: "completion", text: "已经读取。", publishedTexts: ["实际消息"],
    messages: [request, { role: "assistant", content: "", toolCalls: [{ id: "read", name: "companion_notes_read", arguments: { action: "read" } }] },
      { role: "tool", toolCallId: "read", content: JSON.stringify({ ok: true, receiptId: "r1", data: { text } }) }] });
  const receipts = input.sources.filter(source => source.kind === "receipt");
  assert.equal(receipts.length, 1);
  assert.equal(JSON.parse(receipts[0].text).result.data.text, text, "full material is never truncated or summarized");
  assert.equal(input.sources.filter(source => source.text.includes("unique-long-note-7f9a")).length, 1);
  const index = JSON.parse(input.sources.find(source => source.id === "execution_ledger")!.text);
  assert.deepEqual(index.successful, [{ id: "read", reference: "r1", operation: "notes.read.read", riskClass: "read", sourceId: "tool/read" }]);
  assert.deepEqual(index.outcomeSourceIds, ["tool/read"]);
  assert.deepEqual(index.publishedSourceIds, ["published/0"]);
  assert.equal(index.publishedCount, 1);
  for (const id of [...index.outcomeSourceIds, ...index.publishedSourceIds]) assert.ok(input.sources.some(source => source.id === id));
  assert.ok(Buffer.byteLength(JSON.stringify(input)) < Buffer.byteLength(text) * 1.2 + 4_096,
    "source index must not multiply the material body into the audit context");
});

test("host material after a human message cannot become the current request", () => {
  const args = { read: { userText: "真实用户问题" }, baseMessages: [
    { role: "user", content: "真实用户问题" }, { role: "user", hostObservation: true, content: "宿主追加材料" },
  ] } as unknown as CompanionAgentLoopArgs;
  const opening = openCompanionTurn(args);
  assert.equal(opening.currentRequest.content, "真实用户问题");
  assert.equal(opening.messages.at(-1)?.requestBoundary, undefined);
  assert.equal(companionCompletionRequest(args, opening.currentRequest), "真实用户问题");
});

test("image-only review input preserves message identity without image bytes or an invented instruction", () => {
  const args = { read: { userText: "", userMessageId: "actual-user-message", userImageAttachments: [{ assetId: "actual-asset", label: "合成图.png" }] } } as unknown as CompanionAgentLoopArgs;
  const original = { role: "user" as const, content: [{ type: "image_url" as const, image_url: { url: "data:image/png;base64,ACTUAL_IMAGE_BYTES" } }] };
  const request = companionCompletionRequest(args, original);
  assert.deepEqual(JSON.parse(request), { kind: "user_message", userMessageId: "actual-user-message", text: "",
    imageAttachments: [{ assetId: "actual-asset", label: "合成图.png" }], inlineImageParts: 1 });
  assert.doesNotMatch(request, /ACTUAL_IMAGE_BYTES/);
  args.read.initiativeInput = {} as NonNullable<typeof args.read.initiativeInput>;
  assert.equal(companionCompletionRequest(args, { role: "system", hostObservation: true, content: "真实宿主参与条件" }), "真实宿主参与条件");
});
