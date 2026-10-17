import assert from "node:assert/strict";
import test from "node:test";
import { buildCompanionRouteRecordV1, createCompanionRouteRecorder } from "../companion-route-record.ts";

test("正常分类：记录真实耗时与放行等待", () => {
  const record = buildCompanionRouteRecordV1({
    classifier: { elapsedMs: 2734.4, failureClass: null },
    handlerStartedAtMs: 1_000,
    releasedAtMs: 3_900,
  });
  assert.deepEqual(record, {
    version: 1,
    classifier: { source: "l2", elapsedMs: 2734, hedged: false },
    release: { waitedMs: 2_900 },
  });
});

test("对冲过就记 hedged，耗时按四舍五入的正数记", () => {
  const record = buildCompanionRouteRecordV1({
    classifier: { elapsedMs: -5, failureClass: null, hedged: true },
    handlerStartedAtMs: 2_000,
    releasedAtMs: 2_400,
  });
  assert.equal(record.classifier.hedged, true);
  assert.equal(record.classifier.elapsedMs, 0, "负数耗时按 0 记，不写脏读数");
  assert.equal(record.release.waitedMs, 400);
});

test("分类器超时：source=timeout，首字仍会继续（reading 数值不受影响）", () => {
  const record = buildCompanionRouteRecordV1({
    classifier: { elapsedMs: 20_000, failureClass: "timeout" },
    handlerStartedAtMs: 10_000,
    releasedAtMs: 30_100,
  });
  assert.equal(record.classifier.source, "timeout");
  assert.equal(record.classifier.elapsedMs, 20_000);
  assert.equal(record.release.waitedMs, 20_100);
});

test("复用已存解释、没有发起分类时记 cached，且没有伪造耗时", () => {
  const record = buildCompanionRouteRecordV1({
    classifier: null,
    handlerStartedAtMs: 5_000,
    releasedAtMs: 5_050,
  });
  assert.deepEqual(record.classifier, { source: "cached", elapsedMs: null, hedged: false });
});

test("时钟回拨等异常不让 waitedMs 变成负数", () => {
  const record = buildCompanionRouteRecordV1({
    classifier: { elapsedMs: 1_200, failureClass: null },
    handlerStartedAtMs: 9_000,
    releasedAtMs: 8_000,
  });
  assert.equal(record.release.waitedMs, 0);
});

test("录制器：回执与放行时刻落成一行 route，写失败不抛给调用方", async () => {
  const writes: Array<{ route: unknown }> = [];
  const recorder = createCompanionRouteRecorder({}, async (_event, patch) => { writes.push(patch); });
  recorder.onReceipt({ elapsedMs: 1234.6, failureClass: null, hedged: true },
    { runId: "run", providerId: "p", modelId: "m" });
  await recorder.track(Promise.resolve("released"));
  recorder.record({ read: { runId: "run" } } as never, Date.now() - 2_000);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(writes.length, 1);
  const route = writes[0]!.route as ReturnType<typeof buildCompanionRouteRecordV1>;
  assert.equal(route.classifier.source, "l2");
  assert.equal(route.classifier.elapsedMs, 1235);
  assert.equal(route.classifier.hedged, true);
  assert.ok(route.release.waitedMs >= 1_900, `放行等待应包含跟踪期间的时间，实际 ${route.release.waitedMs}`);
});

test("录制器：没收到分类回执（复用已存解释）时 route 记 cached", async () => {
  const writes: Array<{ route: unknown }> = [];
  const recorder = createCompanionRouteRecorder({}, async (_event, patch) => { writes.push(patch); });
  recorder.record({ read: { runId: "run" } } as never, 1_000);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const route = writes[0]!.route as ReturnType<typeof buildCompanionRouteRecordV1>;
  assert.equal(route.classifier.source, "cached");
  assert.equal(route.classifier.elapsedMs, null);
});

test("录制器：run meta 写失败只咽掉，不影响本轮调用方", async () => {
  const recorder = createCompanionRouteRecorder({}, async () => { throw new Error("db down"); });
  recorder.record({ read: { runId: "run" } } as never, 1_000);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(true, "record 同步返回且没有把 rejection 抛给调用方");
});

const SAFE_SHADOW_VEC = [1, 0, 0, 0] as const;

async function seedShadowIndex(scopeKey: string, embed: (text: string) => Promise<readonly number[] | null>): Promise<void> {
  const { rememberCompanionReleaseSample, resetCompanionReleaseRouterForTests } = await import("../companion-release-router.ts");
  resetCompanionReleaseRouterForTests();
  for (let index = 0; index < 8; index += 1) {
    await rememberCompanionReleaseSample({
      scopeKey, text: `seed-${scopeKey}-${index}`, intent: "conversation", toolUse: "none", embed,
    });
  }
}

test("影子模式：route.l1 记录 L1 判断、同轮 L2 结论与一致性", async () => {
  const scopeKey = "shadow-aligned";
  const embed = async (): Promise<readonly number[] | null> => SAFE_SHADOW_VEC;
  await seedShadowIndex(scopeKey, embed);
  const writes: Array<{ route: unknown }> = [];
  const recorder = createCompanionRouteRecorder({
    scopeKey, userText: "今天好累，想随便聊聊最近的事", recentMessages: [], embedText: embed, releaseRouterMode: "shadow",
  }, async (_event, patch) => { writes.push(patch); });
  recorder.onReceipt({ elapsedMs: 900, failureClass: null }, { runId: "r", providerId: "p", modelId: "m" });
  await recorder.track(Promise.resolve({ intent: "conversation", toolUse: "none" }));
  recorder.record({ read: { runId: "r" } } as never, Date.now() - 500);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(writes.length, 1, "影子结果和基础 route 合成一次写");
  const l1 = (writes[0]!.route as { l1?: Record<string, unknown> }).l1!;
  assert.equal(l1.mode, "shadow");
  assert.equal(l1.decision, "release");
  assert.equal(l1.agreement, "aligned");
  assert.deepEqual(l1.actual, { intent: "conversation", toolUse: "none", safe: true });
  assert.equal(l1.samples, 8);
});

test("影子模式：L1 想放行而 L2 判成动作轮时记 misrelease（漏放曲线用）", async () => {
  const scopeKey = "shadow-misrelease";
  const embed = async (): Promise<readonly number[] | null> => SAFE_SHADOW_VEC;
  await seedShadowIndex(scopeKey, embed);
  const writes: Array<{ route: unknown }> = [];
  const recorder = createCompanionRouteRecorder({
    scopeKey, userText: "今天好累，想随便聊聊最近的事", recentMessages: [], embedText: embed, releaseRouterMode: "shadow",
  }, async (_event, patch) => { writes.push(patch); });
  await recorder.track(Promise.resolve({ intent: "task", toolUse: "act" }));
  recorder.record({ read: { runId: "r" } } as never, Date.now() - 500);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const l1 = (writes[0]!.route as { l1?: Record<string, unknown> }).l1!;
  assert.equal(l1.decision, "release");
  assert.equal(l1.agreement, "misrelease");
});

test("影子模式关闭时完全不碰 embedding，route 里也没有 l1", async () => {
  let embedded = 0;
  const embed = async (): Promise<readonly number[] | null> => { embedded += 1; return SAFE_SHADOW_VEC; };
  const writes: Array<{ route: unknown }> = [];
  const recorder = createCompanionRouteRecorder({
    scopeKey: "shadow-off", userText: "今天好累，想随便聊聊最近的事", embedText: embed, releaseRouterMode: "off",
  }, async (_event, patch) => { writes.push(patch); });
  await recorder.track(Promise.resolve({ intent: "conversation", toolUse: "none" }));
  recorder.record({ read: { runId: "r" } } as never, Date.now() - 500);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(embedded, 0);
  assert.equal((writes[0]!.route as { l1?: unknown }).l1, undefined);
});
