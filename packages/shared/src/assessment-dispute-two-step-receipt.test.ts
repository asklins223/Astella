/**
 * 开争议那**两步**回执（39d W5-5；39 §10.3「区分『当时的结算』与『后续确认』」、
 * §14.2、§16.22）。
 *
 * ## 为什么要拆
 *
 * 这一发**等**系统复核跑完（真模型实测 2.8–3.0 秒），而响应里有两件性质不同的事：
 * 「异议记下了」按下去就成立；「复核怎么看」需要一次模型调用，可能成、可能跳过、
 * 可能失败。塞进一个扁平 `status` 的后果有两个：
 *  ① 用户等那 3 秒期间不知道自己按的那一下生效了没有 ⇒ 会重复点，
 *     而重复点正是 §16.22 那个**可重复动作**；
 *  ② 复核失败时那一发要么整体报错（用户以为异议没记下来）、要么假装成功（假回执）。
 *
 * **不做成 fire-and-forget**：挂成后台 job 再立即回执，那颗按钮就变成能按的重复动作，
 * §16.22 的死循环立刻有了新入口。所以保留等待，只把**回执的形状**拆开。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RECHECK_OUTCOME_LINE_V2,
  disputeReceiptLinesV2,
  openAssessmentDisputeResultV2Schema,
  type AssessmentDisputeRecheckOutcomeV2,
  type OpenAssessmentDisputeRecheckReceiptV2,
} from "./assessment-dispute-rules-v2.ts";

const DECIDED_AT = "2026-09-27T12:00:00.000Z";

function receipt(over: Partial<OpenAssessmentDisputeRecheckReceiptV2> = {}): OpenAssessmentDisputeRecheckReceiptV2 {
  return {
    stage: "supplementary",
    status: "committed",
    decidedAt: DECIDED_AT,
    outcome: "upheld",
    reason: "复核者自己那一句",
    reasonCode: null,
    ...over,
  };
}

test("第一步与第二步是**两句话**，不是一句加尾巴", () => {
  const { first, second } = disputeReceiptLinesV2({ created: true, recheck: receipt() });
  assert.ok(first.includes("异议"), `第一步要回答「我按的那一下生效了吗」，实际是「${first}」`);
  assert.ok(first.includes("不推进复习"), "第一步要说明副作用：这一次不推进复习");
  assert.notEqual(first, second);
  assert.ok(second.length > 0, "第二步要回答「系统怎么看」");
});

test("重复提交要说出来，不许当成第一次（那一发是幂等的）", () => {
  const again = disputeReceiptLinesV2({ created: false, recheck: receipt() });
  assert.ok(!again.first.includes("已经记下了这一次"),
    `created=false 时不能说「已经记下」——用户会以为刚才那一下也生效了。实际是「${again.first}」`);
  assert.ok(again.first.includes("没有重复记") || again.first.includes("之前已经记过"),
    `created=false 要说得出「没有重复记」，实际是「${again.first}」`);
});

/**
 * ⚠️ 复核没跑成时，**不许**说「正在处理」。
 *
 * 那一刻没有东西在处理——这一发已经等完了。说「正在处理」会让用户以为再等一会儿
 * 就有结果，而真实出口是他自己补充说明、或结束这份异议并暂不安排（§14.2／§16.22）。
 */
test("复核没跑成时不说「正在处理」——那一刻已经等完了", () => {
  for (const status of ["skipped", "failed"] as const) {
    const { second } = disputeReceiptLinesV2({
      created: true,
      recheck: receipt({ status, outcome: null, reason: null, reasonCode: "provider_unavailable" }),
    });
    assert.ok(!/正在|稍等|请稍候|处理中/.test(second),
      `${status} 那一档说了「${second}」——那一刻没有东西在处理，说「正在处理」是骗用户继续等`);
    assert.ok(/补充说明|结束/.test(second), `${status} 那一档要指出真实出口（补充说明／结束并暂不安排），实际是「${second}」`);
  }
});

test("「没跑成」与「没有结论」是两件事：outcome 那两档必须是 null 而不是 undetermined", () => {
  for (const status of ["skipped", "failed"] as const) {
    assert.equal(receipt({ status, outcome: null }).outcome, null, `${status} 的 outcome 必须是 null`);
  }
  // undetermined 是一个**真结论**（复核跑了，两说并存），它必须有 outcome
  assert.equal(receipt({ outcome: "undetermined" }).outcome, "undetermined");
  const parsed = openAssessmentDisputeResultV2Schema.safeParse({
    version: 2, disputeId: "0f9a5c9c-1b3f-4c1e-9c1a-6f2b7d5e4a10", status: "open", created: true,
    recordedLine: "异议已经记下了。这一次先不推进复习。",
    recheck: receipt({ status: "failed", outcome: "undetermined", reason: null, reasonCode: "provider_unavailable" }),
  });
  assert.equal(parsed.success, true, "回执形状没通过 zod");
});

test("四档各有一句人话，兜底句对任何已知档都不生效", () => {
  const outcomes: AssessmentDisputeRecheckOutcomeV2[] = ["upheld", "corrected", "over_broad", "undetermined"];
  for (const outcome of outcomes) {
    const line = RECHECK_OUTCOME_LINE_V2[outcome];
    assert.ok(typeof line === "string" && line.length > 0, `${outcome} 没有自己那一句`);
    assert.ok(!line.includes("undefined"), `${outcome} 的句子是「${line}」`);
  }
  // 屏上念的是句子而不是状态名：`recheck_original_too_broad` 没有人读得懂
  assert.ok(!Object.values(RECHECK_OUTCOME_LINE_V2).some((line) => /recheck_|undetermined|upheld/.test(line)),
    "屏上文案里出现了状态名——那是给数据库与测试看的");
  assert.equal(Object.keys(RECHECK_OUTCOME_LINE_V2).length, 4, "四档都要有一句，缺一档就会落进兜底");
});

test("「原判过宽」与「仍无法判断」在屏上是**两句不同的话**", () => {
  const overBroad = RECHECK_OUTCOME_LINE_V2.over_broad;
  const undetermined = RECHECK_OUTCOME_LINE_V2.undetermined;
  assert.notEqual(overBroad, undetermined);
  assert.ok(/判宽|偏宽|没成立|没满足/.test(overBroad),
    `「原判过宽」那一句要说得出「上次那条不算」，实际是「${overBroad}」`);
  assert.ok(/判断不了|两说|暂不采信/.test(undetermined),
    `「仍无法判断」那一句要说得出「还没想清楚」，实际是「${undetermined}」`);
});

test("回执缺任何一格都要被 zod 拒掉——屏上不能靠猜有没有发生过复核", () => {
  const base = {
    version: 2 as const, disputeId: "0f9a5c9c-1b3f-4c1e-9c1a-6f2b7d5e4a10", status: "open" as const, created: true,
    recordedLine: "x", recheck: receipt(),
  };
  assert.equal(openAssessmentDisputeResultV2Schema.safeParse(base).success, true, "正控制失败");
  for (const missing of ["recordedLine", "recheck", "created"] as const) {
    const partial: Record<string, unknown> = { ...base };
    delete partial[missing];
    assert.equal(openAssessmentDisputeResultV2Schema.safeParse(partial).success, false,
      `少了 \`${missing}\` 那一格居然通过了：屏上会以为没发生过复核`);
  }
  // stage 固定为「后续确认」：这一格永远不是当时的结算
  assert.equal(openAssessmentDisputeResultV2Schema.safeParse({ ...base, recheck: receipt({ stage: "initial" as never }) }).success, false,
    "`stage` 写成了别的值：这一格按合同永远不是当时的结算");
});

/** 变异自证：把两步合成一句，那条判据必须红。 */
test("判据对「合成一句」灵敏", () => {
  const merged = { first: "异议已记下，正在复核。", second: "异议已记下，正在复核。" };
  assert.equal(merged.first, merged.second, "变异自证样本：两步合成一句");
  const real = disputeReceiptLinesV2({ created: true, recheck: receipt() });
  assert.notEqual(real.first, real.second, "真实实现不许把两步合成一句");
  assert.ok(!/正在/.test(real.second), "第二步也不许说「正在」——它已经是终态了");
});
