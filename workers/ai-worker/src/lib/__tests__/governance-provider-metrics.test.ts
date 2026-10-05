/**
 * provider 观测的收口判据：一次外发 = 一次记账。
 *
 * 这组测试盯的是三条会互相矛盾、且一旦发生就无法事后修补的形状：
 *
 * 1. **漏记** —— 被治理门拦下（没同意 / 政策拒发）的那一次根本没发出去，
 *    如果它不计数，"调用量"就只是"成功量"，而"我们拒绝了多少次外发"
 *    恰恰是合规最想看的那一格。
 * 2. **重记** —— 同一次外发被两个出口各记一次，调用量翻倍而 token 不翻倍
 *    （token 只在有 usage 时递增），于是图上出现"调用 2 次、token 1 次"
 *    这种自相矛盾却看不出错在哪的读数。
 * 3. **猜 token** —— 流式接口不返回 usage，用 0 补齐会让"没报 usage"
 *    和"真的没用 token"长得一样，流式成本永远显示 0 而不是"未知"。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AIConsentRequiredError,
  AIDataPolicyDeniedError,
  createGovernedEmbeddingProvider,
  createGovernedProvider,
  type WorkspaceAIPolicy,
} from "../governance.ts";
import { providerMetricSnapshot } from "../metrics.ts";
import type { AIProvider, EmbeddingProviderLike } from "../ai-provider.ts";

const workspaceId = "00000000-0000-0000-0000-00000000000a";

function policy(overrides: Partial<WorkspaceAIPolicy> = {}): WorkspaceAIPolicy {
  return { sendToExternal: true, sendImageContent: true, piiDetection: true, auditLogging: true, ...overrides };
}

type ChatBehaviour = () => Promise<{ content: string; usage?: Record<string, number> }>;

function chatProvider(behaviour: ChatBehaviour) {
  const provider = {
    id: "openai_compatible",
    modelId: "test-model",
    visionModelId: "test-vision",
    promptVersion: "test-v1",
    chatCompletion: () => behaviour(),
  } as unknown as AIProvider;
  return provider;
}

/** 读某个 (provider,kind,outcome) 桶的当前计数；没有这条样本时返回 0。 */
async function calls(outcome: string, kind = "chat", provider = "openai_compatible"): Promise<number> {
  return sample(`ailearn_provider_calls_total{provider="${provider}",kind="${kind}",outcome="${outcome}"}`);
}

async function tokens(direction: string, kind = "chat", provider = "openai_compatible"): Promise<number> {
  return sample(`ailearn_provider_call_tokens_total{provider="${provider}",kind="${kind}",direction="${direction}"}`);
}

/** 耗时直方图的观测条数。prom-client 按声明顺序输出标签，不是字典序。 */
async function durationObserved(kind = "chat", provider = "openai_compatible"): Promise<number> {
  return sample(`ailearn_provider_call_duration_seconds_count{provider="${provider}",kind="${kind}"}`);
}

/** 取一条指标样本的值。指标没有样本行 = 从未递增（不是 0，是"没记过"）。 */
async function sample(label: string): Promise<number> {
  const match = (await providerMetricSnapshot()).match(new RegExp(`^${label} (\\d+(?:\\.\\d+)?)$`, "m"));
  return match ? Number(match[1]) : 0;
}

test("成功的一次 chat 记一次调用、一次耗时、按 usage 记 token", async () => {
  const governed = createGovernedProvider(
    chatProvider(() => Promise.resolve({ content: "ok", usage: { totalTokens: 30, promptTokens: 20, completionTokens: 10 } })),
    { consentOk: true, policy: policy() },
    workspaceId,
  );
  const before = { success: await calls("success"), prompt: await tokens("prompt"), completion: await tokens("completion") };
  await governed.chatCompletion([{ role: "user", content: "hello" }], {});
  assert.equal(await calls("success"), before.success + 1, "成功的外发必须恰好记一次");
  assert.equal(await tokens("prompt"), before.prompt + 20);
  assert.equal(await tokens("completion"), before.completion + 10);
  assert.ok(await durationObserved() > 0, "耗时直方图没有观测到这次调用");
});

test("被治理门拦下的外发也要计数，且归到 blocked 而不是凭空消失", async () => {
  const denied = createGovernedProvider(
    chatProvider(() => { throw new Error("provider 不该被调用到"); }),
    { consentOk: true, policy: policy({ sendToExternal: false }) },
    workspaceId,
  );
  const noConsent = createGovernedProvider(
    chatProvider(() => { throw new Error("provider 不该被调用到"); }),
    { consentOk: false, policy: policy() },
    workspaceId,
  );
  const before = { blocked: await calls("blocked"), success: await calls("success") };

  await assert.rejects(() => denied.chatCompletion([{ role: "user", content: "x" }], {}), AIDataPolicyDeniedError);
  await assert.rejects(() => noConsent.chatCompletion([{ role: "user", content: "x" }], {}), AIConsentRequiredError);

  assert.equal(await calls("blocked"), before.blocked + 2, "被拒绝的外发没有计数：调用量会退化成成功量");
  assert.equal(await calls("success"), before.success, "被拒绝的外发不该被记成成功");
});

test("取消与超时各自归属，不混进 error", async () => {
  const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
  const timeoutError = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  const cancelled = createGovernedProvider(chatProvider(() => Promise.reject(abortError)), { consentOk: true, policy: policy() }, workspaceId);
  const timedOut = createGovernedProvider(chatProvider(() => Promise.reject(timeoutError)), { consentOk: true, policy: policy() }, workspaceId);
  const before = { cancelled: await calls("cancelled"), timeout: await calls("timeout"), error: await calls("error") };

  await assert.rejects(() => cancelled.chatCompletion([{ role: "user", content: "x" }], {}));
  await assert.rejects(() => timedOut.chatCompletion([{ role: "user", content: "x" }], {}));

  assert.equal(await calls("cancelled"), before.cancelled + 1, "用户/任务自己按的取消没被单独归属");
  assert.equal(await calls("timeout"), before.timeout + 1, "上游超时没被单独归属");
  assert.equal(await calls("error"), before.error, "取消与超时都不该混进 error");
});

test("流式接口没有 usage：不递增 token，但调用与耗时照记", async () => {
  const provider = {
    id: "openai_compatible",
    modelId: "test-model",
    visionModelId: "test-vision",
    promptVersion: "test-v1",
    chatCompletion: async () => ({ content: "unused" }),
    chatCompletionStream: async () => ({ content: "流式正文" }),
  } as unknown as AIProvider;
  const governed = createGovernedProvider(provider, { consentOk: true, policy: policy() }, workspaceId);
  const before = { success: await calls("success", "stream"), prompt: await tokens("prompt", "stream") };

  await governed.chatCompletionStream!([{ role: "user", content: "x" }], {}, undefined, () => {});

  assert.equal(await calls("success", "stream"), before.success + 1, "流式外发没有计数");
  assert.equal(await tokens("prompt", "stream"), before.prompt,
    "流式没有 usage 却记了 token：那是猜的，不能用 0 或任何估算冒充");
});

test("同一份 provider 在同一 workspace 上包两次不会把同一次外发记两遍", async () => {
  const raw = chatProvider(() => Promise.resolve({ content: "ok", usage: { totalTokens: 5, promptTokens: 5, completionTokens: 0 } }));
  const first = createGovernedProvider(raw, { consentOk: true, policy: policy() }, workspaceId);
  const second = createGovernedProvider(first, { consentOk: true, policy: policy() }, workspaceId);
  assert.equal(second, first, "同 workspace 的重复包装没有被短路");

  const before = await calls("success");
  await second.chatCompletion([{ role: "user", content: "x" }], {});
  assert.equal(await calls("success"), before + 1, "一次外发被记了两次：调用量翻倍而 token 不翻倍");
});

test("重新包装采用当前政策与当前回合预算，不保留旧授权或重复预留", async () => {
  let sent=0,oldReserves=0,currentReserves=0;
  const raw=chatProvider(async()=>{sent++;return {content:"ok"};});
  const context={consentOk:true,policy:policy({auditLogging:false})};
  const first=createGovernedProvider(raw,context,workspaceId,{userId:"u",operation:"old",reserveCall:async()=>{oldReserves++;}});
  const denied=createGovernedProvider(first,{...context,policy:policy({sendToExternal:false,auditLogging:false})},workspaceId);
  await assert.rejects(()=>denied.chatCompletion([{role:"user",content:"private"}],{}),AIDataPolicyDeniedError);
  assert.equal(sent,0);
  assert.equal(oldReserves,0);
  const current=createGovernedProvider(first,context,workspaceId,{userId:"u",operation:"current",reserveCall:async()=>{currentReserves++;}});
  await current.chatCompletion([{role:"user",content:"x"}],{});
  assert.equal(sent,1);
  assert.equal(currentReserves,1);
  assert.equal(oldReserves,0);
});

test("预算拒绝不实际调用 provider，且按 blocked 归属", async () => {
  let sent=0;
  const governed=createGovernedProvider(chatProvider(async()=>{sent++;return {content:"bad"};}),
    {consentOk:true,policy:policy({auditLogging:false})},workspaceId,
    {userId:"u",operation:"budget",reserveCall:async()=>{throw Object.assign(new Error("limit"),{code:"AGENT_BUDGET_EXCEEDED"});}});
  const before=await calls("blocked");
  await assert.rejects(()=>governed.chatCompletion([{role:"user",content:"x"}],{}),/limit/);
  assert.equal(sent,0);
  assert.equal(await calls("blocked"),before+1);
});

test("embedding provider 走同一条记账口径（kind=embed），且不依赖审计开关", async () => {
  let embedded = 0;
  const raw: EmbeddingProviderLike = {
    id: "openai_compatible",
    embeddingModelId: "embed-model",
    embed: async () => { embedded += 1; return [0.1, 0.2]; },
  };
  // 审计开关关着：这一次调用**仍然**要进指标。指标是一次外发的客观事实，
  // 不能因为用户关了合规记录就一起消失——否则"关了审计之后花了多少"就无从回答。
  const governed = createGovernedEmbeddingProvider(
    raw,
    { consentOk: true, policy: policy({ auditLogging: false }) },
    workspaceId,
    { userId: "11111111-1111-1111-1111-111111111111", operation: "companion_memory_recall_embedding", dataCategories: ["user_answer"] },
  );
  const before = await calls("success", "embed");
  await governed.embed("她还记得的那句话");
  assert.equal(embedded, 1, "治理门不该改动真实外发次数");
  assert.equal(await calls("success", "embed"), before + 1, "向量调用没有进调用量");
  assert.ok(await durationObserved("embed") > 0, "向量调用没有进耗时直方图");
});

test("审计上下文照常传到向量出口（不因为没有真实 actor 就整段丢弃）", async () => {
  // 这里只看**记账与审计口径是否共用一条路**：向量出口与主 provider 共用
  // `createCallRecorder`，所以向量调用同样能带 owner/operation/job/categories。
  // 写库那一段要真库，这里关掉审计开关以免 fire-and-forget 的写把进程挂住。
  const raw: EmbeddingProviderLike = {
    id: "openai_compatible",
    embeddingModelId: "embed-model",
    embed: async () => [0.1],
  };
  const ctx = { consentOk: true, policy: policy({ auditLogging: false }) };
  const audit = { userId: "11111111-1111-1111-1111-111111111111", operation: "companion_memory_recall_embedding" };
  const withAudit = createGovernedEmbeddingProvider(raw, ctx, workspaceId, audit);
  const withoutAudit = createGovernedEmbeddingProvider(
    { ...raw },
    ctx,
    workspaceId,
  );
  const before = await calls("success", "embed");
  await withAudit.embed("有审计上下文");
  await withoutAudit.embed("没有审计上下文");
  assert.equal(await calls("success", "embed"), before + 2,
    "审计上下文的有无不该改变记账：两种向量调用都要能被统计到");
});

test("向量 provider 被政策拒发时归 blocked，同样记一次", async () => {
  let embedded = 0;
  const raw: EmbeddingProviderLike = {
    id: "openai_compatible",
    embeddingModelId: "embed-model",
    embed: async () => { embedded += 1; return [0.1]; },
  };
  const governed = createGovernedEmbeddingProvider(raw, { consentOk: true, policy: policy({ sendToExternal: false }) }, workspaceId);
  const before = await calls("blocked", "embed");
  await assert.rejects(() => governed.embed("用户原话"), AIDataPolicyDeniedError);
  assert.equal(embedded, 0, "被拒的向量请求真的发出去了");
  assert.equal(await calls("blocked", "embed"), before + 1);
});

test("向量 provider 的重复包装同样被短路", async () => {
  const raw: EmbeddingProviderLike = {
    id: "openai_compatible",
    embeddingModelId: "embed-model",
    embed: async () => [0.1],
  };
  const first = createGovernedEmbeddingProvider(raw, { consentOk: true, policy: policy() }, workspaceId);
  const second = createGovernedEmbeddingProvider(first, { consentOk: true, policy: policy() }, workspaceId);
  assert.equal(second, first);
  const before = await calls("success", "embed");
  await second.embed("一句话");
  assert.equal(await calls("success", "embed"), before + 1);
});
