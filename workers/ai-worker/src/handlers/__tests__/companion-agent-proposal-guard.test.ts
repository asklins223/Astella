import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * 提案创建的**三条语义不变式**（2026-09-30，B2 拆出 `companion-agent-proposal.ts` 时补）。
 *
 * ## 为什么要有这条
 *
 * 实测：把 `buildActionPayload` / `createAgentProposal` 搬出去之后，
 * handler 覆盖棘轮把 `companion-agent-proposal` 报成「没有任何测试引用」——
 * 也就是说这一族**一条测试都没有**。它又是生产路径（用户确认那一整条路都走它）。
 *
 * 所以先补最要紧的三条。它们是「提案」这个概念成立的**前提**，而不是它的细节。
 *
 * ## 三条是什么
 *
 * 1. **提案只建不执行。** 这一步是"停下来等用户"，不是"做掉"。
 *    在这里调 `executeReadTool` / `executeDirectTool` 会让 full 档
 *    （免确认那档）也停下来——而那条路的判据是 `executeDirectTool` 直执行。
 * 2. **同一会话同时只能有一件待确认的事。** 已有 `pending` 提案时抛错，
 *    而不是插第二条——因为"确认哪一件"由 `waiting_proposal_id` 唯一指定，
 *    两条并行会让用户确认的那一件与真正在等的那一件**不是同一件**。
 * 3. **落库的 payload 要过 schema。** 它直接变成屏上那张卡片的形状；
 *    不过 schema 的话，坏字段会一路到渲染才炸，而那时已落库、回滚不了。
 */

const PROPOSAL = join(import.meta.dirname, "../companion-agent-proposal.ts");
const source = readFileSync(PROPOSAL, "utf8");

/**
 * 去掉注释再找。
 *
 * 这是必须的：本族里有一句**注释**写着「full 档不经提案、由 executeDirectTool 直执行」，
 * 而它恰好说明了为什么这里**不能**调 executeDirectTool。第一版没去注释，
 * 于是那条断言被自己的说明文字判成了违规。
 */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

test("① 提案这一步只建不执行", () => {
  // 「只建」的意思是：这一族里**不得**出现执行器的调用。
  for (const forbidden of ["executeReadTool", "executeDirectTool", "executeTool"]) {
    assert.ok(
      !code.includes(forbidden),
      `提案族里出现了 ${forbidden}——这一步是"停下来等用户确认"；`
      + "在这里执行会让免确认那一档（full）也停下来，而那条路的设计是直执行。",
    );
  }
  // 反向对照：它确实在落库，不是空壳
  assert.ok(/INSERT INTO/.test(code), "提案族里没有 INSERT——那它就不叫'建提案'");
});

test("② 同一会话已有待确认提案时抛错，而不是插第二条", () => {
  assert.ok(
    /status = 'pending'/.test(source),
    "找不到「查当前 pending 提案」那道闸——少了它，两条提案并行，"
    + "而 waiting_proposal_id 只指定一件，用户确认的那件与真正在等的那件会不是同一件。",
  );
  assert.ok(
    /CompanionToolError\("还有一件等你确认的事没处理完/.test(source),
    "已有 pending 提案时那句给用户的话不见了——闸还在但话没了，"
    + "用户会看到一句内部话，而那句话是他唯一知道要先去处理哪件的线索。",
  );
});

test("③ 落库的 payload 必须过 schema", () => {
  // 实际用的是 safeParse——所以判据是「用了 schema 且失败时**不落库**」，
  // 而不是「用了 parse」（第一版写死 parse，判据在第一版就红了）。
  assert.ok(
    /proposedLearningActionPayloadV1Schema\.safeParse\(/.test(code),
    "payload 没有过 schema——坏字段会一路到渲染才炸，而那时已落库、回滚不了。",
  );
  assert.ok(
    /if \(!parsedPayload\.success\) throw new CompanionToolError\(/.test(code),
    "safeParse 失败时没有立刻抛错——那就等于校验了个寂寞，坏 payload 照样会落库。",
  );
  // 摘要字段也要跟着落：屏上那张卡片靠它们说清"要做什么"
  for (const field of ["title", "target_summary", "impact_summary"]) {
    assert.ok(code.includes(field), `提案落库少了 ${field}——屏上那张卡片靠它说清"要做什么"`);
  }
});

test("【自证】判据会红：把 pending 那道闸抽掉必须被抓", () => {
  const broken = code.replace(/status = 'pending'/, "status = 'anything'");
  assert.ok(!/status = 'pending'/.test(broken), "自证：抽掉之后不该再匹配到");
  assert.ok(/status = 'pending'/.test(source), "自证：真实源码里那道闸还在");
});
