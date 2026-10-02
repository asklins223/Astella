/**
 * 流中提前派发的**可判定部分**（40b §4.1-1，R7，A58 / A75 / A76）。
 *
 * ## 为什么要把它拆成纯函数
 *
 * 提前派发的三个判据——**输出序号顺序、序号缺口、确认门**——在真流里最难验：
 * 它们只在特定分片顺序下才出错，而真 provider 的分片顺序是随机的。
 *
 * 所以这一层做成纯函数：吃累积槽，吐"哪个 index 现在能派、为什么不能"。
 * 能穷举着测，也能被非流式路径复用。
 *
 * ## 这一批为什么只放只读工具
 *
 * 合同原话：「第一批仅对**无业务副作用、可取消**的读取工具测收益。」
 * 提前派发的收益来自重叠，风险是"工具已经执行、但这一轮最终失败或被取消"。
 * 读工具重读一次就行，写工具重做一次可能就是重复提交。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  dispatchableCalls,
  eagerCommitRecheck,
  eagerDispatchDecisions,
  interruptedEagerCallStatus,
  type EagerDispatchOptions,
  type StreamToolCallSlot,
} from "../companion-eager-dispatch.ts";

const READ = new Set(["companion_read_memory", "companion_read_context"]);

const options = (over: Partial<EagerDispatchOptions> = {}): EagerDispatchOptions => ({
  eligibleTools: READ,
  ...over,
});

const slot = (index: number, name: string, argsText: string): StreamToolCallSlot => ({
  index,
  id: `call-${index}`,
  name,
  argsText,
});

test("第 2 个调用开始吐了，第 1 个才变成可派 —— 这是唯一的完成信号", () => {
  // 协议没有"第 N 个已完成"这种事件；顺序保证才是可用的那个。
  const onlyFirst = [slot(0, "companion_read_memory", '{"memoryId":"m"}')];
  const d1 = eagerDispatchDecisions(onlyFirst, options());
  assert.equal(d1[0]?.ready, false);
  assert.equal(d1[0]?.ready === false && d1[0]?.reason, "awaiting_later_index");

  const both = [...onlyFirst, slot(1, "companion_read_context", "{}")];
  const d2 = eagerDispatchDecisions(both, options());
  // index 0 现在确定完整（1 已经开始），index 1 自己还在流里。
  assert.equal(d2[0]?.ready, true);
  assert.equal(d2[1]?.ready, false);
});

test("流结束时最后一个槽子也变成可派", () => {
  const slots = [slot(0, "companion_read_context", "{}")];
  const decisions = eagerDispatchDecisions(slots, options({ streamFinished: true }));
  assert.equal(decisions[0]?.ready, true, "流已结束，最后一个调用确定完整却没被派");
});

test("参数没拼完就不派 —— 不能从流式 JSON 片段猜（A75）", () => {
  const halfJson = [slot(0, "companion_read_memory", '{"memoryId":"m-1"')];
  const decisions = eagerDispatchDecisions(halfJson, options({ streamFinished: true }));
  assert.equal(decisions[0]?.ready, false);
  assert.equal(decisions[0]?.ready === false && decisions[0]?.reason, "arguments_incomplete");
});

test("参数解析出来不是对象也不派（数组/标量/null 一律拒绝）", () => {
  for (const args of ["[1,2]", '"a string"', "null", "42"]) {
    const decisions = eagerDispatchDecisions([slot(0, "companion_read_memory", args)], options({ streamFinished: true }));
    assert.equal(decisions[0]?.ready, false, `${args} 被放行了`);
    assert.equal(decisions[0]?.ready === false && decisions[0]?.reason, "arguments_not_object");
  }
});

test("provider 没给调用名就不猜", () => {
  const decisions = eagerDispatchDecisions([slot(0, "", '{"memoryId":"m"}')], options({ streamFinished: true }));
  assert.equal(decisions[0]?.ready, false);
  assert.equal(decisions[0]?.ready === false && decisions[0]?.reason, "missing_name");
});

test("序号有缺口就不越过那个缺口", () => {
  // 0 完整、1 **缺失**、2 完整。此时绝不能先派 2：
  // 缺口里可能是一个 requiresConfirmation 的工具，按顺序赌它是空的等于越权。
  const withHole = [
    slot(0, "companion_read_context", "{}"),
    slot(2, "companion_read_context", "{}"),
  ];
  const decisions = eagerDispatchDecisions(withHole, options({ streamFinished: true }));
  const byIndex = new Map(decisions.map((d) => [d.index, d]));
  const two = byIndex.get(2);
  assert.equal(two?.ready, false, "越过序号缺口派发了 index 2");
  assert.equal(two?.ready === false && two.reason, "index_gap");
  // 缺口**之前**的照常派 —— 缺口不是让整轮停摆。
  assert.equal(byIndex.get(0)?.ready, true, "缺口之前的那一个也不派了 —— 那过头了");
});

test("缺口补齐之后，后面的才重新可派", () => {
  const hole = [slot(0, "companion_read_context", "{}"), slot(2, "companion_read_context", "{}")];
  const filled = [...hole, slot(1, "companion_read_context", "{}")];
  assert.equal(
    eagerDispatchDecisions(hole, options({ streamFinished: true })).find((d) => d.index === 2)?.ready,
    false,
  );
  assert.equal(
    eagerDispatchDecisions(filled, options({ streamFinished: true })).find((d) => d.index === 2)?.ready,
    true,
    "缺口补齐后 index 2 仍然不派 —— 判据过严",
  );
});

test("确认门之后的调用不得越过（A58）", () => {
  // 第 1 个要用户确认，它必须停在提案流程里；第 2 个不许抢在它前面执行。
  const slots = [
    slot(0, "companion_read_context", "{}"),
    slot(1, "companion_save_memory", '{"kind":"goal","content":"x"}'),
    slot(2, "companion_read_context", "{}"),
  ];
  const decisions = eagerDispatchDecisions(slots, options({
    streamFinished: true,
    requiresConfirmation: (name) => name === "companion_save_memory",
  }));
  const byIndex = new Map(decisions.map((d) => [d.index, d]));
  assert.equal(byIndex.get(0)?.ready, true, "确认门之前的只读调用本可以先跑");
  assert.equal(byIndex.get(2)?.ready, false, "确认门之后的调用被放行，越过了屏障");
});

test("白名单之外一律不派 —— 这一批只有只读工具", () => {
  const decisions = eagerDispatchDecisions(
    [slot(0, "companion_save_memory", '{"kind":"goal","content":"x"}')],
    options({ streamFinished: true }),
  );
  assert.equal(decisions[0]?.ready, false);
  assert.equal(decisions[0]?.ready === false && decisions[0]?.reason, "tool_not_eligible");
});

test("交出去的顺序与模型发出的顺序一致", () => {
  // 乱序回给模型会让它读到"第二条的结果在第一条之前"。
  const slots = [
    slot(2, "companion_read_context", "{}"),
    slot(0, "companion_read_memory", '{"memoryId":"m"}'),
    slot(1, "companion_read_context", "{}"),
  ];
  const ordered = dispatchableCalls(eagerDispatchDecisions(slots, options({ streamFinished: true })));
  assert.deepEqual(ordered.map((d) => d.index), [0, 1, 2]);
});

test("空输入不产出任何可派调用（没有收益的形状退化成原样，而不是猜着跑）", () => {
  assert.deepEqual(eagerDispatchDecisions([], options()), []);
  assert.deepEqual(dispatchableCalls([]), []);
});

test("【自证】判据认得出「按到达顺序立刻派」这个真实退化", () => {
  // 退化形状：不看 index，只按"这个槽现在有字了"就派。
  const arrived = [slot(0, "companion_read_memory", '{"memoryId":'), slot(1, "companion_read_context", "{}")];
  const degenerate = arrived
    .filter((s) => s.argsText.length > 0)
    .map((s) => ({ index: s.index, ready: s.argsText.length > 0 }));
  // 退化版会把半截参数的 0 号也派出去（它"有字了"）。
  assert.equal(degenerate.find((d) => d.index === 0)?.ready, true, "自证样本没造好");
  // 正控制：我们的判据不派它。
  const ours = eagerDispatchDecisions(arrived, options());
  assert.equal(ours.find((d) => d.index === 0)?.ready, false,
    "半截参数被派了出去 —— 那正是从流式片段猜参数");
});

test("流中断时：已执行的**保留**，没开始的写 not_executed，正在跑的写 unknown", () => {
  // 合同原话：「流中断保留已经执行的结果，未开始写 not_executed，
  // 可能执行但不确定写 outcome_unknown。」
  assert.equal(interruptedEagerCallStatus("executed", true), "succeeded",
    "已经执行完的结果被丢掉了 —— 用户会以为那件事没发生过");
  assert.equal(interruptedEagerCallStatus("not_started", true), "not_executed");
  assert.equal(interruptedEagerCallStatus("pending", true), "outcome_unknown",
    "正在跑的算成 not_executed —— 用户据此再操作一次就是重复提交");
  assert.equal(interruptedEagerCallStatus("outcome_unknown", true), "outcome_unknown");
});

test("没有中断时，pending 不该被算成成功", () => {
  assert.equal(interruptedEagerCallStatus("executed", false), "succeeded");
  assert.equal(interruptedEagerCallStatus("pending", false), "not_executed",
    "没中断却把 pending 说成没发生");
});

test("流没断也不能把 `outcome_unknown` 降成 `not_executed`", () => {
  // 「跑了但没拿到回执」与流断不断流无关。降成 not_executed 就是告诉用户
  // "那件事没发生"，而用户会据此再操作一次——重复提交。
  assert.equal(interruptedEagerCallStatus("outcome_unknown", false), "outcome_unknown",
    "派发抛错的一律被报成『没发生』");
});

test("撤销/取消/租约丢失之后提交前复查：只读不写，带副作用标 unknown（A76）", () => {
  const blocks = [
    { name: "撤权", revoked: true, cancelled: false, leaseLost: false },
    { name: "取消", revoked: false, cancelled: true, leaseLost: false },
    { name: "租约丢失", revoked: false, cancelled: false, leaseLost: true },
  ];
  for (const blocked of blocks) {
    const readOnly = eagerCommitRecheck({ ...blocked, hasSideEffect: false });
    assert.equal(readOnly.commit, false, `${blocked.name} 之后仍然提交了`);
    assert.equal(readOnly.status, "not_executed", `${blocked.name}：只读调用撤销后不提交即可，不必吓人`);

    const withSideEffect = eagerCommitRecheck({ ...blocked, hasSideEffect: true });
    assert.equal(withSideEffect.status, "outcome_unknown",
      `${blocked.name}：带副作用的撤销不能算 not_executed —— 那是不假回滚`);
  }
});

test("没被撤销时正常提交", () => {
  const ok = eagerCommitRecheck({
    revoked: false, cancelled: false, leaseLost: false, hasSideEffect: true,
  });
  assert.equal(ok.commit, true);
  assert.equal(ok.status, "succeeded");
});

test("【自证】判据认得出「中断时一律算 not_executed」这个真实退化", () => {
  // 退化形状：不区分 pending 与 not_started，一律写 not_executed。
  const degenerate = (phase: string) => phase === "executed" ? "succeeded" : "not_executed";
  assert.equal(degenerate("pending"), "not_executed", "自证样本没造好");
  // 正控制：我们的判据把 pending 归到 unknown。
  assert.equal(interruptedEagerCallStatus("pending", true), "outcome_unknown");
});

test("【自证】判据认得出「撤销后假装回滚」这个更重的退化", () => {
  // 退化形状：带副作用的撤销也写 not_executed，等于宣称"没发生"。
  const fakeRollback = eagerCommitRecheck({
    revoked: true, cancelled: false, leaseLost: false, hasSideEffect: true,
  });
  assert.equal(fakeRollback.status, "outcome_unknown",
    "自证：带副作用的撤销必须落 unknown，不能宣称没发生");
});
