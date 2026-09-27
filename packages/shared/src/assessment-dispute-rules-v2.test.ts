/**
 * §14.2 那六条裁决的单测（39d W5-5）。
 *
 * 这份判据是**执法点要少**换来的：跑 `run-disputes` 的行为测试要起一次性 PostgreSQL，
 * 成本高且失败时看不出是哪条规则错了。这里把每条规则钉在最小输入上，
 * 改坏哪一条就一眼是哪一条。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  correctionBackdatesFirstAnswerV2,
  correctionOverwritesFirstAnswerV2,
  decideDisputedObservationV2,
  decideDisputeCloseV2,
  decideDisputeRecheckV2,
  decideSupplementArtifactRequiredV2,
  disputeIsPersonalOnlyV2,
  type AssessmentCorrectionKindV2,
} from "./assessment-dispute-rules-v2.ts";

// ─── 规则一：一次重新检查（§16.22 争议不形成死循环）──────────────────────

test("没复核过才允许复核；已复核一次就不再允许——包括维持", () => {
  assert.deepEqual(
    decideDisputeRecheckV2({ disputeClosed: false, recheckPerformed: false }),
    { allowed: true },
  );
  // 「维持」也是复核过：让系统能对着同一次回答反复重检，正是 §16.22 要挡的死循环。
  for (const performed of [true]) {
    assert.deepEqual(
      decideDisputeRecheckV2({ disputeClosed: false, recheckPerformed: performed }),
      { allowed: false, reasonCode: "recheck_already_performed" },
    );
  }
});

test("已结束的争议连第一次复核都不给（关闭先于复核）", () => {
  assert.deepEqual(
    decideDisputeRecheckV2({ disputeClosed: true, recheckPerformed: false }),
    { allowed: false, reasonCode: "dispute_closed" },
  );
});

// ─── 规则二：待复核时不持续放大结论（§14.2）──────────────────────────────

test("无活争议时按原判定走，不挂起产物", () => {
  assert.deepEqual(
    decideDisputedObservationV2({
      hasLiveDispute: false,
      recheckOutcome: null,
      correctionAlreadyApplied: false,
    }),
    { action: "use_as_is", suspendsArtifactReuse: false, reasonCode: "no_live_dispute" },
  );
});

test("待复核与仍无法判断都只保留结论、不推进间隔", () => {
  for (const outcome of [null, "undetermined"] as const) {
    const decided = decideDisputedObservationV2({
      hasLiveDispute: true,
      recheckOutcome: outcome,
      correctionAlreadyApplied: false,
    });
    assert.equal(decided.action, "withhold_conclusion");
    // §14.2「问题产物对本人暂停复用」：这两档都要挂起。
    assert.equal(decided.suspendsArtifactReuse, true);
  }
});

test("维持＝结论可用，但产物仍对本人暂停复用", () => {
  const decided = decideDisputedObservationV2({
    hasLiveDispute: true,
    recheckOutcome: "upheld",
    correctionAlreadyApplied: false,
  });
  assert.equal(decided.action, "use_as_is");
  assert.equal(decided.suspendsArtifactReuse, true, "题目本身被质疑过就不再拿给本人复用");
});

test("修正只许应用一次；第二次回到「已应用」而不是重复消费", () => {
  const fresh = decideDisputedObservationV2({
    hasLiveDispute: true,
    recheckOutcome: "corrected",
    correctionAlreadyApplied: false,
  });
  assert.equal(fresh.action, "apply_correction_once");

  const replay = decideDisputedObservationV2({
    hasLiveDispute: true,
    recheckOutcome: "corrected",
    correctionAlreadyApplied: true,
  });
  assert.equal(replay.action, "withhold_conclusion", "重复应用同一次更正＝重复计学习");
  assert.equal(replay.reasonCode, "correction_already_applied");
});

// ─── 规则三：更正不重写、不倒算（§14.2、§16.25）─────────────────────────

test("两种更正都不覆盖也不倒算第一次回答", () => {
  const kinds: AssessmentCorrectionKindV2[] = ["system_misjudgment", "user_supplement"];
  for (const kind of kinds) {
    assert.equal(correctionOverwritesFirstAnswerV2(kind), false);
    assert.equal(correctionBackdatesFirstAnswerV2(kind), false);
  }
});

test("只有「用户补答」那一档需要新的作答产物", () => {
  assert.deepEqual(
    decideSupplementArtifactRequiredV2({
      kind: "system_misjudgment",
      supplementArtifactId: null,
    }),
    { required: false },
  );
  assert.deepEqual(
    decideSupplementArtifactRequiredV2({ kind: "user_supplement", supplementArtifactId: null }),
    { required: true, provided: false },
  );
  assert.deepEqual(
    decideSupplementArtifactRequiredV2({
      kind: "user_supplement",
      supplementArtifactId: "3b0f1a52-0000-4000-8000-000000000001",
    }),
    { required: true, provided: true },
  );
});

// ─── 规则四：结束并暂不安排（§14.2）──────────────────────────────────────

test("指向目标且本人要暂不安排时才落排除；判不出目标就只能结束", () => {
  const objectiveId = "3b0f1a52-0000-4000-8000-000000000002";
  assert.deepEqual(
    decideDisputeCloseV2({ objectiveId, userAskedForHold: true }),
    { outcome: "hold_objective" },
  );
  // 排除按目标生效；目标判不出来时动别人的安排就越权了。
  assert.deepEqual(
    decideDisputeCloseV2({ objectiveId: null, userAskedForHold: true }),
    { outcome: "close_without_hold" },
  );
  // 本人只想结束这一项，不顺手动安排。
  assert.deepEqual(
    decideDisputeCloseV2({ objectiveId, userAskedForHold: false }),
    { outcome: "close_without_hold" },
  );
});

test("排不出可挂的笔记时落第三档，不静默降级也不把用户卡死", () => {
  const objectiveId = "3b0f1a52-0000-4000-8000-000000000002";
  // 本人要暂不安排，但这一目标没有 origin_kind='note' 的绑定 ⇒ 挂不上排除表。
  assert.deepEqual(
    decideDisputeCloseV2({ objectiveId, userAskedForHold: true, noteBindingAvailable: false }),
    { outcome: "hold_unavailable" },
  );
  // 不能降级成 close_without_hold：界面会显示"已暂不安排"而库里什么都没写。
  assert.notDeepEqual(
    decideDisputeCloseV2({ objectiveId, userAskedForHold: true, noteBindingAvailable: false }),
    { outcome: "close_without_hold" },
  );
  // 缺省按"能挂"处理，老调用点不必立刻改。
  assert.deepEqual(
    decideDisputeCloseV2({ objectiveId, userAskedForHold: true }),
    { outcome: "hold_objective" },
  );
});

// ─── 规则五：争议是个人数据（§14.4）──────────────────────────────────────

test("争议只对本人可见，也不动别人的证据", () => {
  const ruled = disputeIsPersonalOnlyV2();
  assert.equal(ruled.readableByAuthorOnly, true);
  assert.equal(ruled.affectsOtherMembersEvidence, false);
  assert.equal(ruled.sharedMaterialWithdrawalHandledElsewhere, true);
});
