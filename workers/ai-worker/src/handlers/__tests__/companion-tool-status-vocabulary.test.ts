/**
 * 工具失败的**状态词表**（40b §3.2：六类状态；本文件管其中的调用成败那一段）。
 *
 * ## 为什么这一档值得单独一份测试
 *
 * §3.2 那张表是按**下一步**分的：`not_executed` 说"改对参数再来一次有意义"，
 * `unavailable` 说"这个能力这一轮没有、重调没有意义"，`outcome_unknown` 说
 * "可能已经改过东西、**绝对不能**重调"。三者的下一步互相矛盾，
 * 所以把它们压成一个词的后果不是文案变难看——是**模型在相反的处境里做同一件事**。
 *
 * 在它们还不存在的那些版本里，40b §3.2 整张表在代码里对应的是三个词
 * （blocked / failed / outcome_unknown），而"未执行"与"不可用"统统落进 `failed`。
 *
 * ## 三件事必须同时成立
 *
 * 1. **判据对得上词**：哪个错 / 哪个条件落到哪一档，逐条钉；
 * 2. **`outcome_unknown` 没被吞掉**：新加的两档是 `CompanionToolError` 的子类，
 *    一旦有人把它们的判定写在 `instanceof CompanionToolError` **之后**，
 *    两档立刻塌回 `failed`，而 `outcome_unknown` 的判定顺序也可能被挤掉；
 * 3. **新状态真的被写到**：有真实写入点（读图外发门禁 / 派发前的屏障），
 *    而不只是词表里多两个词——这一条要有**正控制**，否则"声明了但没人用"同样是绿的。
 */
import assert from "node:assert/strict";
import * as toolOutcome from "../companion-tool-outcome.ts";
import test from "node:test";

import {
  classifyCompanionToolFailure,
  unavailableCompanionToolSummary,
  TOOL_NOT_EXECUTED_SAFE_SUMMARY,
  TOOL_UNAVAILABLE_SAFE_SUMMARY,
  VISION_EGRESS_UNAVAILABLE_SAFE_SUMMARY,
  type CompanionToolFailureStatus,
} from "../companion-tool-outcome.ts";
import {
  CompanionToolError,
  CompanionToolBlockedError,
  CompanionToolNotExecutedError,
  CompanionToolOutcomeUnknownError,
  CompanionToolUnavailableError,
} from "../companion-tool-result.ts";
import {
  companionAgentToolStatusSchema,
  companionToolReportedStatusSchema,
  resolveAllCompanionAgentTools,
} from "@astella/shared";
import { VISION_EGRESS_DENIED_MESSAGE } from "../companion-read-tools.ts";

test("每一档都由明确的条件产生，且两档新状态**不再落进 failed**", () => {
  const cases: ReadonlyArray<{
    what: string;
    error: unknown;
    riskClass: string;
    executionStarted: boolean;
    status: CompanionToolFailureStatus;
  }> = [
    {
      what: "权限/预算这类「不获准」仍是 blocked（不是 unavailable：用户含义不同）",
      error: new CompanionToolBlockedError("超出你给的权限"),
      riskClass: "reversible_low",
      executionStarted: true,
      status: "blocked",
    },
    {
      what: "能力这一轮没有 → unavailable（§3.2 要求指出实际影响与可用替代）",
      error: new CompanionToolUnavailableError("图片外发未开启，这一轮看不了图"),
      riskClass: "read",
      executionStarted: true,
      status: "unavailable",
    },
    {
      what: "显式的「从未开始」→ not_executed",
      error: new CompanionToolNotExecutedError("这一步要填的内容没有对上，没有执行"),
      riskClass: "consequential",
      executionStarted: true,
      status: "not_executed",
    },
    {
      what: "确定失败仍是 failed",
      error: new CompanionToolError("目标已不存在，没有改动"),
      riskClass: "consequential",
      executionStarted: true,
      status: "failed",
    },
    {
      what: "已开始的写操作遇到未知异常 → outcome_unknown（绝不能被新状态吞掉）",
      error: new Error("database connection closed"),
      riskClass: "reversible_low",
      executionStarted: true,
      status: "outcome_unknown",
    },
    {
      what: "屏障/取消/预算在派发前耗尽：executionStarted=false → not_executed",
      error: new Error("deadline"),
      riskClass: "irreversible",
      executionStarted: false,
      status: "not_executed",
    },
    {
      what: "读类工具超时仍是 failed（无副作用，报 unknown 是吓人）",
      error: new Error("read timed out"),
      riskClass: "read",
      executionStarted: true,
      status: "failed",
    },
  ];
  for (const item of cases) {
    assert.equal(
      classifyCompanionToolFailure(item.error, item.riskClass, item.executionStarted).status,
      item.status,
      item.what,
    );
  }
});

test("每一档都必须带一句**用户读得懂**的话，且不是那句通用废话", () => {
  const summaries = [
    classifyCompanionToolFailure(new Error("deadline"), "irreversible", false),
    classifyCompanionToolFailure(new CompanionToolUnavailableError("图片外发未开启"), "read", true),
    classifyCompanionToolFailure(new CompanionToolNotExecutedError("参数没对上"), "read", true),
    classifyCompanionToolFailure(new CompanionToolError("目标不存在"), "consequential", true),
    classifyCompanionToolFailure(new Error("boom"), "reversible_low", true),
  ];
  for (const { status, safeSummary } of summaries) {
    assert.ok(safeSummary.trim().length > 0, `${status} 没有给出任何说明`);
    assert.ok(safeSummary.length <= 240, `${status} 的说明超长，会被事件与账本截断`);
    assert.doesNotMatch(safeSummary, /undefined|\[object|Error:/, `${status} 的说明漏了原始异常`);
  }
  // 「从未执行」那一档不能只是通用失败话术——那正是它与 failed 唯一的区别。
  assert.equal(
    classifyCompanionToolFailure(new Error("deadline"), "irreversible", false).safeSummary,
    TOOL_NOT_EXECUTED_SAFE_SUMMARY,
  );
  assert.match(TOOL_NOT_EXECUTED_SAFE_SUMMARY, /没有执行/);
  assert.match(TOOL_UNAVAILABLE_SAFE_SUMMARY, /没有开/);
});

test("新状态没有把 outcome_unknown 吞掉——三条防线逐条钉", () => {
  // ① 分类顺序：新状态是 CompanionToolError 的子类，判定写在它**之后**就永远读不到。
  assert.ok(new CompanionToolUnavailableError("x") instanceof CompanionToolError,
    "前提不成立：unavailable 不再是工具错误，catch 里的 instanceof 会漏掉它");
  assert.equal(
    classifyCompanionToolFailure(new CompanionToolUnavailableError("x"), "reversible_low", true).status,
    "unavailable",
    "判定顺序被倒过来了：它继承自 CompanionToolError，先命中 failed 就再也走不到 unavailable",
  );

  // ② 类继承：新的两档都**不能**继承 outcome_unknown 那一支——
  //    一旦继承，"可能已经改过东西"就被说成"根本没跑"，用户会再去操作一次。
  assert.ok(!(new CompanionToolUnavailableError("x") instanceof CompanionToolOutcomeUnknownError));
  assert.ok(!(new CompanionToolNotExecutedError("x") instanceof CompanionToolOutcomeUnknownError));
  assert.ok(!(new CompanionToolOutcomeUnknownError("x") instanceof CompanionToolUnavailableError));
  assert.ok(!(new CompanionToolOutcomeUnknownError("x") instanceof CompanionToolNotExecutedError));

  // ③ 正控制：已开始的写操作遇到真·未知异常，仍然是 outcome_unknown。
  assert.equal(
    classifyCompanionToolFailure(new Error("socket hang up"), "irreversible", true).status,
    "outcome_unknown",
    "unknown 被新状态吃掉了：这是三条防线里最贵的一条——它会诱发一次重复提交",
  );
  // 自证：把这一档换成任意其它词，下面这条必定红——证明判据不是恒真。
  for (const wrong of ["failed", "not_executed", "unavailable", "blocked"] as const) {
    assert.notEqual(
      classifyCompanionToolFailure(new Error("socket hang up"), "irreversible", true).status,
      wrong,
      `自证样本没造好：判据对 ${wrong} 也通过`,
    );
  }
});

test("【正控制】新状态真的被写到，而不是只在词表里存在", () => {
  // ① 分类器确实产得出它们（不是死词）。
  assert.equal(
    classifyCompanionToolFailure(new CompanionToolUnavailableError("x"), "read", true).status,
    "unavailable",
  );
  assert.equal(
    classifyCompanionToolFailure(new Error("barrier"), "irreversible", false).status,
    "not_executed",
  );

  // ② 真实写入点：读图受数据外发政策管，关着时这一轮**没有这个能力**。
  assert.equal(
    unavailableCompanionToolSummary("companion_read_image", { visionEnabled: false }),
    VISION_EGRESS_UNAVAILABLE_SAFE_SUMMARY,
  );
  assert.equal(unavailableCompanionToolSummary("companion_read_image", {}), VISION_EGRESS_UNAVAILABLE_SAFE_SUMMARY);
  // 开了就恢复成"可用"——判据不能只看工具名。
  assert.equal(unavailableCompanionToolSummary("companion_read_image", { visionEnabled: true }), null);
  // 展示图片**不**出境，所以它不受这条管（工具面本来就区分了这两件事）。
  assert.equal(unavailableCompanionToolSummary("companion_show_image", { visionEnabled: false }), null);
  assert.equal(unavailableCompanionToolSummary("companion_read_note", { visionEnabled: false }), null);
  // 而且它必须是**工具面真的摘掉了读图**的那一条，否则这一档永远不会发生。
  assert.ok(!resolveAllCompanionAgentTools("full", { visionEnabled: false })
    .some((definition) => definition.name === "companion_read_image"));
  assert.ok(resolveAllCompanionAgentTools("full", { visionEnabled: true })
    .some((definition) => definition.name === "companion_read_image"));
});

test("【正反两向】这一档必须**指出影响并给出替代**，否则用户不知道怎么拿回来", () => {
  // §3.2 的原话：「指出实际影响及可用替代」。只说"做不到"的那一句不合格。
  assert.match(VISION_EGRESS_UNAVAILABLE_SAFE_SUMMARY, /看不了图片/, "没有说清楚缺的是哪一项能力");
  assert.match(VISION_EGRESS_UNAVAILABLE_SAFE_SUMMARY, /正文仍然可以读/, "没说还能做什么");
  assert.match(VISION_EGRESS_UNAVAILABLE_SAFE_SUMMARY, /设置/, "没给出拿回来的办法");
  // 同一件事在执行层对直接调用方说的是同一句开关名，用户在两处看到的话必须对得上。
  assert.ok(
    VISION_EGRESS_UNAVAILABLE_SAFE_SUMMARY.includes("「允许发送图片内容」")
      && VISION_EGRESS_DENIED_MESSAGE.includes("「允许发送图片内容」"),
    "两处文案里的开关名漂移了：用户在执行层与账本层会看到两个不同的名字",
  );
  // 负对照：把"替代"删掉，上面那条必须红——否则它是恒真的。
  const withoutAlternative = VISION_EGRESS_UNAVAILABLE_SAFE_SUMMARY.replace(/设置[^。]*。/, "");
  assert.ok(!/设置/.test(withoutAlternative), "负对照造不出差异：判据恒真");
  assert.doesNotMatch(withoutAlternative, /设置/, "负对照自证失败：替代办法没有被删掉");
});

test("报告给模型的每一个词，账本与客户端现在都**原样**接受（0349 之后）", () => {
  // 这一条防的是运行期崩溃：`companion_agent_tool_calls.status` 有 CHECK 约束。
  // 0349 把 not_executed / unavailable 加进了约束，客户端 TOOL_STATE 也补了条目，
  // 于是曾经存在的那层降级映射被**删除**了 —— 不留"以后可能用到"的转发层。
  for (const status of companionToolReportedStatusSchema.options) {
    assert.equal(
      companionAgentToolStatusSchema.safeParse(status).success,
      true,
      `${status} 报告给模型却落不进账本——运行期会直接炸在工具链上`,
    );
  }
  // 反向也成立：报告面不再比落库面多出任何一档。
  const reportedOnly = companionToolReportedStatusSchema.options
    .filter((status) => !(companionAgentToolStatusSchema.options as readonly string[]).includes(status));
  assert.deepEqual([...reportedOnly], [], "又出现了只有模型能说、账本说不了的词");
});

test("折叠映射已经删除 —— 它本来就是错的，不是「以后可能用到」", () => {
  // unavailable 被写成 blocked 时，用户读到的是「被拒绝」，而实际是
  // 「这一轮没有这个能力，且有替代路径」（40b §3.2）。那不是翻译，是失真。
  assert.equal(
    (toolOutcome as unknown as Record<string, unknown>).companionToolLedgerStatusFor,
    undefined,
    "companionToolLedgerStatusFor 又回来了——账本已经能收精确词，不需要降级",
  );
});
