import assert from "node:assert/strict";
import test from "node:test";
import { createRoundRuntimeCollaborators } from "../runtime-collaborators.ts";

/**
 * P1-3：轮次 LLM 协作者的装配语义。
 *
 * ## 这里要钉住的是三件事
 *
 * 1. **"模型没配"怎么表达**。收口前它是 `modelId === "unconfigured"` 这个
 *    字面量，在路由里被比较了 4 处。搬成 `ready` 布尔之后，路由不再碰那个
 *    字面量——但**注入的替身也得被正确判成 ready/not ready**，否则离线用例
 *    会以为"配好了"而实际没配，症状是"测试里模型调用次数是 0"。
 * 2. **逐个覆盖，不是整体替换**。只注入 `teaching` 时，另两个仍走生产默认——
 *    这正是「讲解成、演示不成」那种形状的造法，整体替换会把这个能力弄丢。
 * 3. **讲解与演示的 external 语义**。离线注入的讲解替身 `external: false`，
 *    生产默认是 `true`（真走外部服务）。
 */

const fakeProvider = (() => Promise.resolve({})) as never;

test("没有注入时：三条链路都由生产默认装配，ready 跟随模型配置", () => {
  const c = createRoundRuntimeCollaborators();
  assert.equal(typeof c.teaching.ready, "boolean");
  assert.equal(typeof c.artifact.ready, "boolean");
  // ready 与 modelId 必须自洽：ready 为 true 就不能是未配置字面量
  if (c.teaching.ready) assert.notEqual(c.teaching.modelId, "unconfigured");
  if (c.artifact.ready) assert.notEqual(c.artifact.modelId, "unconfigured");
  assert.ok(c.targetGrounder, "targetGrounder 必须被装配出来");
});

test("注入的替身被原样采用，且 ready 由注入的 modelId 决定", () => {
  const configured = createRoundRuntimeCollaborators({
    teaching: { provider: fakeProvider, modelId: "qwen-max", external: false },
    artifact: { provider: fakeProvider, modelId: "qwen-max" },
  });
  assert.equal(configured.teaching.modelId, "qwen-max");
  assert.equal(configured.teaching.ready, true);
  assert.equal(configured.teaching.external, false, "注入替身的 external 语义要保留");
  assert.equal(configured.artifact.ready, true);

  const unconfigured = createRoundRuntimeCollaborators({
    teaching: { provider: fakeProvider, modelId: "unconfigured", external: false },
  });
  assert.equal(unconfigured.teaching.ready, false, "modelId 是未配置字面量 → ready 必须是 false");
});

test("逐个覆盖：只注入 teaching 时，artifact 仍走生产默认（不整体替换）", () => {
  const c = createRoundRuntimeCollaborators({
    teaching: { provider: fakeProvider, modelId: "injected-model", external: false },
  });
  assert.equal(c.teaching.modelId, "injected-model");
  // 这两条**不该**被注入带走——这正是「讲解成、演示不成」形状依赖的能力
  assert.notEqual(c.artifact.provider, fakeProvider, "artifact 不该被 teaching 的注入顺带顶掉");
  assert.ok(c.targetGrounder);
});

test("【自证】ready 不是恒 true 也不是恒 false（否则注入语综上那条断言是空的）", () => {
  const ready = createRoundRuntimeCollaborators({
    teaching: { provider: fakeProvider, modelId: "some-model", external: false },
  }).teaching.ready;
  const notReady = createRoundRuntimeCollaborators({
    teaching: { provider: fakeProvider, modelId: "unconfigured", external: false },
  }).teaching.ready;
  assert.equal(ready, true);
  assert.equal(notReady, false);
  assert.notEqual(ready, notReady, "ready 必须真的随 modelId 变，否则它没有承载任何信息");
});
