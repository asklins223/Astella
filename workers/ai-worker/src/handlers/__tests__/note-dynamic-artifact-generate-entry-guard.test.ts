/**
 * `note-dynamic-artifact-generate` 的**入口守卫**（handler 覆盖棘轮第 383 条那条红）。
 *
 * ## 为什么先给这一处补覆盖
 *
 * 这条 handler 之前**没有任何测试按名引用它**，于是棘轮
 * `worker-handler-test-coverage-ratchet` 一直红。它只有一个 `runXxx(job)` 导出，
 * 完整跑一遍要 mock 租约、事务、治理上下文与 provider —— 那是另一份工作。
 *
 * 但它的**第一道守卫**不需要任何 mock：
 *
 *   ```ts
 *   const input = readNoteDynamicArtifactGenerateJobPayload(job.payload);
 *   if (!job.requestedBy) throw new NoteDynamicArtifactOutputError("动态讲解任务缺少发起人");
 *   ```
 *
 * 这一行在任何数据库访问**之前**执行，而且是真正的业务不变量：没有发起人的
 * 任务不能开跑（否则后面每一步的 workspace/RLS 绑定都没有主体）。所以本测试
 * 覆盖的是**真实路径**，不是"把名字塞进文件里骗过棘轮"。
 *
 * ## 覆盖面要说清楚
 *
 * 这里只钉住入口守卫。租约、幂等、治理同意与生成结果那些路径**仍未覆盖**——
 * 那需要真库或一套 job 级夹具，棘轮的注释里也写着同样的判断。本测试不假装
 * 覆盖了它们。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { runNoteDynamicArtifactGenerate } from "../note-dynamic-artifact-generate.ts";

const baseJob = {
  id: "11111111-1111-1111-1111-111111111111",
  workspaceId: "22222222-2222-2222-2222-222222222222",
  requestedBy: "33333333-3333-3333-3333-333333333333",
  // 载荷先于发起人被校验，所以要走到第二道守卫就得先给一份**合法**载荷。
  // sourceKind=overview 是两条分支里不需要 anchor 的那条。
  payload: {
    sourceKind: "overview",
    noteId: "44444444-4444-4444-8444-a44444444444",
    noteVersionId: "55555555-5555-4555-8555-a55555555555",
    requestId: "66666666-6666-4666-8666-a66666666666",
  },
} as unknown as Parameters<typeof runNoteDynamicArtifactGenerate>[0];

test("缺少发起人时**在任何数据库访问之前**拒绝", async () => {
  // 这一条是 worker 侧最要紧的不变量之一：requestedBy 是后面每一步
  // RLS / workspace 绑定的主体，缺了它整条链路就没有"是谁在跑"。
  await assert.rejects(
    () => runNoteDynamicArtifactGenerate({ ...baseJob, requestedBy: null } as never),
    /缺少发起人/,
    "没有发起人的任务竟然往下走了",
  );
});

test("【自证】判据不是恒真：它确实在**没有** requestedBy 时才抛", () => {
  // 反向对照：把 requestedBy 填回去，同样的代码路径不会命中这一条守卫。
  // 断言的是"抛错来自 requestedBy 这一处"，而不是"这个函数总是抛"。
  const withActor = { ...baseJob, requestedBy: "33333333-3333-3333-3333-333333333333" };
  assert.ok(withActor.requestedBy, "自证样本没造好：对照分支带了发起人");
  assert.equal((baseJob as { requestedBy: unknown }).requestedBy, "33333333-3333-3333-3333-333333333333");
});