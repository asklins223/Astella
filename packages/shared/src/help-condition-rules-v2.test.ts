/**
 * 帮助条件可对账性的判据（39d W5-1 主体刀一；39 §14.1.1）。
 *
 * 这份判据的**存在理由**是一次实测：`evidence_reveal` 在全仓**零生产者**
 * （合同注释自己写着"七处在读、零处生产"），而 `run-processing-tick.ts` 三处
 * `calculateDiscreteV2Schedule({ …, unassistedEligibleAfter: null })` 把那条
 * **借助完成冷却**的唯一入口写死成 null——于是"判不出有没有被帮助"被解成了
 * "没有被帮助"。下面几格把 §14.1.1 的四档钉住，让那个反面解法在单测里显形。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decideHelpConditionV2,
  helpConditionCountsAsIndependentV2,
  helpConditionNeedsCooldownV2,
  unreconcilableDispositionV2,
  type HelpConditionV2,
} from "./help-condition-rules-v2.ts";

const LOCK = new Date("2026-09-27T10:00:00.000Z");
const at = (iso: string) => new Date(iso);

function decide(overrides: Partial<Parameters<typeof decideHelpConditionV2>[0]> = {}) {
  return decideHelpConditionV2({
    answerLockedAt: LOCK,
    helpRequestedAt: null,
    helpPresentedAt: null,
    // 今天的实情：判不出来。测试里显式写出来，免得有人以为默认是"判得出来"。
    reconcilable: false,
    ...overrides,
  });
}

test("锁定前没有任何帮助请求 ⇒ 独立（这是唯一一档干净的）", () => {
  assert.equal(decide(), "independent");
  // 锁定**之后**才请求的帮助，不追溯降低已锁定的回答（§14.1.1）。
  assert.equal(
    decide({ helpRequestedAt: at("2026-09-27T10:00:01.000Z") }),
    "independent",
    "锁定后的帮助把这次算成了借助——那是评分返回时间当界，§14.1.1 明写不许",
  );
});

test("锁定前请求、呈现回执也确认在锁定前 ⇒ 借助完成", () => {
  assert.equal(
    decide({
      helpRequestedAt: at("2026-09-27T09:59:00.000Z"),
      helpPresentedAt: at("2026-09-27T09:59:30.000Z"),
    }),
    "assisted",
  );
});

test("锁定前请求、呈现回执没对上 ⇒ 帮助条件无法确认（不是「独立」也不是「借助」）", () => {
  // 这一格是整份判据的重点：今天系统判不出这件事，而它必须**不被解成独立**。
  assert.equal(
    decide({ helpRequestedAt: at("2026-09-27T09:59:00.000Z"), helpPresentedAt: null }),
    "unreconcilable",
  );
  // 回执"更晚到达"也不能判成提交后发生——§14.1.1 明写不许只凭客户端时间判。
  assert.equal(
    decide({
      helpRequestedAt: at("2026-09-27T09:59:00.000Z"),
      helpPresentedAt: at("2026-09-27T10:05:00.000Z"),
    }),
    "unreconcilable",
    "只凭更晚到达的回执就判成「提交后」，正是 §14.1.1 点名不许的那种",
  );
});

test("没有回答锁定记录 ⇒ 没有证据，不签发任何东西", () => {
  assert.equal(decide({ answerLockedAt: null }), "unknown_no_evidence");
});

test("四档两两不同：把「无法确认」并进「独立」或「借助」都会让下面两格失效", () => {
  const all: HelpConditionV2[] = ["independent", "assisted", "unreconcilable", "unknown_no_evidence"];
  assert.equal(new Set(all).size, 4);
  // 关键差别：后两档都**不**算独立证据。合成一档之后这个判据就恒真。
  for (const c of ["unreconcilable", "unknown_no_evidence"] as const) {
    assert.equal(helpConditionCountsAsIndependentV2(c), false, `${c} 不该算独立表现`);
  }
  assert.equal(helpConditionCountsAsIndependentV2("independent"), true);
  assert.equal(helpConditionCountsAsIndependentV2("assisted"), false);
});

test("冷却只对「借助」与「无法确认」生效；独立不需要", () => {
  assert.equal(helpConditionNeedsCooldownV2("assisted"), true);
  assert.equal(helpConditionNeedsCooldownV2("unreconcilable"), true);
  assert.equal(helpConditionNeedsCooldownV2("independent"), false);
  // `unknown_no_evidence` 是**没有锁定回答**，于是压根没有一次观察产生，
  // 也就没有「这次观察要不要冷却」这个问题——第一版把它断言成 true，
  // 那会让调用方给一个不存在的观察排一条冷却。判据没改，改的是这条断言。
  assert.equal(helpConditionNeedsCooldownV2("unknown_no_evidence"), false,
    "没有锁定回答就没有观察，没有观察就不该排冷却");
});

test("§14.1.1 那一档的四条边界是常量：哪天能返回反面，判据就破了", () => {
  const d = unreconcilableDispositionV2();
  // 保留回答：丢掉它等于让她重答一遍，而 §14.1.1 说的是"保留待核对并对账"。
  assert.equal(d.keepsAnswer, true);
  // 不签发独立证据：这一档存在的**全部**理由。
  assert.equal(d.issuesIndependentEvidence, false);
  // 不靠自报自动补签：§14.1.1「不靠自报未看过自动补签」。
  assert.equal(d.autoSignsFromSelfReport, false);
  // 不让人永久等待。
  assert.equal(d.blocksForever, false);
  // 至多一次新尝试——是"一次"，不是无限重试。
  assert.equal(d.freshAttemptsAllowed, 1);
  assert.equal(d.userFacingLabel, "帮助条件无法确认");
});

test("判据自己的灵敏度：同一份输入必须稳定判出同一档", () => {
  // 判不出来这一档必须**恒定**落 unreconcilable：换一个无关的入参不能翻成 independent。
  const base = { answerLockedAt: LOCK, helpRequestedAt: at("2026-09-27T09:00:00.000Z") };
  for (const presented of [null, at("2026-09-27T10:30:00.000Z"), at("2026-09-27T09:30:00.000Z")]) {
    const c = decideHelpConditionV2({ ...base, helpPresentedAt: presented, reconcilable: false });
    assert.equal(
      helpConditionCountsAsIndependentV2(c),
      false,
      `呈现回执=${presented?.toISOString() ?? "null"} 这一档翻成了独立——那正是今天那个反面解法`,
    );
  }
});
