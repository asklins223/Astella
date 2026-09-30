import { describe, expect, it } from "vitest";
import {
  objectivePersonalStateV3Schema,
  type LearningObjectivePrimaryActionV3,
} from "@ailearn/shared/learning-objective-surface-contracts";
import {
  formatObjectiveDateTime,
  formatObjectiveState,
  objectiveStateHint,
  objectiveProgressChips,
  objectiveStateNeedsAttention,
  objectiveStateTone,
  primaryActionDescription,
  primaryActionLabel,
  objectiveHoldNotice,
  objectiveResumeNotice,
  objectiveReviewHoldHint,
  objectiveReviewHoldLabel,
  OBJECTIVE_HOLD_ACTION_LABEL,
  OBJECTIVE_RESUME_ACTION_LABEL,
} from "../run/objective-state-copy.ts";

const CARD_START = {
  version: 2,
  originV2: { kind: "card", cardId: "00000000-0000-4000-8000-000000000004", objectiveId: "00000000-0000-4000-8000-000000000001" },
  goal: "stabilize",
  requestedTimeBudgetSeconds: 180,
  responsePreference: "adaptive",
} as const;

describe("理解目标状态文案", () => {
  it("服务端状态枚举里每一个值都有人话说法，不露原始 token", () => {
    for (const state of objectivePersonalStateV3Schema.options) {
      const label = formatObjectiveState(state);
      expect(label, `state=${state} 没有文案`).not.toBe(state);
      expect(label).not.toMatch(/[a-z_]/);
      expect(objectiveStateHint(state).length, `state=${state} 没有说明`).toBeGreaterThan(0);
      expect(objectiveStateTone(state)).not.toBeNull();
    }
  });

  it("认不出的状态原样显示，不编造", () => {
    expect(formatObjectiveState("quantum_flux")).toBe("quantum_flux");
    expect(objectiveStateHint("quantum_flux")).toBe("");
    expect(objectiveStateTone("quantum_flux")).toBe("neutral");
  });

  it("「还没正式答过」不再写成谁都看不懂的「待验证」", () => {
    expect(formatObjectiveState("unvalidated")).toBe("还没正式答过");
    expect(objectiveStateNeedsAttention("unvalidated")).toBe(true);
    // 它不属于 tone 的 attention，却正是最需要被数进「要处理」的一类。
    expect(objectiveStateTone("unvalidated")).toBe("neutral");
  });

  it("每个动作的说明都回答「现在能做什么、什么时候能正式算」", () => {
    const actions: LearningObjectivePrimaryActionV3[] = [
      { kind: "resume_run", runId: "00000000-0000-4000-8000-000000000009", objectiveId: CARD_START.originV2.objectiveId },
      {
        kind: "practice_only",
        objectiveId: CARD_START.originV2.objectiveId,
        reasonCodes: ["exposed"],
        label: "带着参考答案练一下",
        start: CARD_START,
        formalValidationNotBefore: "2026-09-21T14:30:00.000Z",
      },
      {
        kind: "practice_only",
        objectiveId: CARD_START.originV2.objectiveId,
        reasonCodes: ["exposed"],
        label: "带着参考答案练一下",
        start: CARD_START,
        formalValidationNotBefore: null,
      },
      {
        kind: "wait_for_initial_validation",
        reminderId: "00000000-0000-4000-8000-000000000008",
        qualificationNotBefore: "2026-09-21T14:30:00.000Z",
      },
    ];
    const [resume, practicing, practicingOpenEnded, waiting] = actions;

    expect(primaryActionLabel(resume)).toBe("继续作答");
    // 冷却中的练习必须带上时间点；没有冷却时不许凭空造一个。
    // 时间点按本地时区渲染，所以钉"月日 + 时:分"的形状，不钉具体读数。
    expect(primaryActionDescription(practicing)).toMatch(/\d+月\d+日 \d{2}:\d{2}/);
    expect(primaryActionDescription(practicing)).not.toContain("2026-09-21T");
    expect(primaryActionDescription(practicingOpenEnded)).not.toMatch(/\d+月\d+日/);
    expect(primaryActionDescription(waiting)).toMatch(/\d+月\d+日 \d{2}:\d{2}/);
    for (const action of actions) {
      expect(primaryActionDescription(action)).not.toMatch(/practice_only|qualification|reminderId|服务端/);
    }
  });

  it("复习时间按「还有几天 / 已到期几天」说，不写成回顾", () => {
    const base = { practiceTrailCount: 1, lastCanonicalAt: null, initialValidation: null, validationNotBefore: null };
    const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
    const reviewChip = (days: number) => objectiveProgressChips({ ...base, reviewDueAt: inDays(days) })
      .find((chip) => chip.startsWith("复习")) ?? "";
    expect(reviewChip(5)).toBe("复习 5 天后");
    // 实测过：「复习 11 天前」会被读成"11 天前复习过"。
    expect(reviewChip(-11)).toBe("复习已到期 11 天");
    expect(reviewChip(400)).toMatch(/^复习 \d+月\d+日$/);
  });

  it("时间点读不出来时也不给一个空白", () => {
    expect(formatObjectiveDateTime("not-a-date")).toBe("时间未定");
    expect(formatObjectiveDateTime(null)).toBe("时间未定");
  });

  it("日期写法由本模块定死，不跟 ICU 版本走", () => {
    // vitest 的 Node 与 Electron 的 full-icu 对 zh-CN `month:"numeric"` 给出的
    // 分别是「9/21」和「9月21日」——等待终点不能随环境变。
    const local = new Date(2026, 8, 21, 9, 5);
    expect(formatObjectiveDateTime(local.toISOString())).toBe("9月21日 09:05");
  });
});

// ─── W7-3 刀三：目标级「暂不安排」的人话（39 §9.1 行 2、行 3）────────────
//
// 钉的不是文风，是 §9.1 规则表里那三件**不许被折叠掉**的事：
//  1. 立排除要说清"只停这一个"，还要把"顺手撤了 N 条"念出来；
//  2. 本来就在排除中，说的是"本来就在"而不是"刚刚设好了"；
//  3. 恢复是**组合动作**——沿用已有的那一格与新建那一格是两句不同的话，
//     而"本来就没在排除中"仍要说排上了（两件事在回执里是两个字段）。
// 三件事各自都带一条**正控制**：把分支反过来，对面那一条会立刻红。

describe("目标级「暂不安排」：39 §9.1 行 2、行 3 的人话", () => {
  const HOLD = {
    objectiveId: "00000000-0000-4000-8000-000000000001",
    noteId: "00000000-0000-4000-8000-000000000009",
    reasonCode: "user_deferred_objective",
    createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
  };
  const receipt = (over: Partial<Parameters<typeof objectiveHoldNotice>[0]>) => ({
    objectiveId: HOLD.objectiveId,
    noteId: HOLD.noteId,
    alreadyHeld: false,
    dismissedPendingSchedules: 2,
    ...over,
  });
  const resume = (over: Partial<Parameters<typeof objectiveResumeNotice>[0]>) => ({
    version: 2 as const,
    objectiveId: HOLD.objectiveId,
    released: true,
    scheduled: "created" as const,
    scheduleId: "00000000-0000-4000-8000-0000000000aa",
    // 相对"今天"推后若干天而不是写死一个日期：
    // `formatObjectiveDay` 对 1 天内说"明天/今天"、1–30 天说"N 天后"，
    // 写死日期会让这条断言在别的日子变成一条假红。
    nextReviewAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
    ...over,
  });

  it("立排除：把撤下了几条念出来（§9.1「操作时说明」）", () => {
    const said = objectiveHoldNotice(receipt({ dismissedPendingSchedules: 2 }));
    expect(said).toContain("暂不安排");
    expect(said).toContain("2 条");
  });

  it("一条也没撤时说成另一句，不让「撤了 0 条」读成没生效", () => {
    const said = objectiveHoldNotice(receipt({ dismissedPendingSchedules: 0 }));
    expect(said).toContain("没有排着的回访");
    expect(said).not.toContain("0 条");
  });

  it("本来就在排除中：说「本来就在」，不说「刚刚设好了」", () => {
    const said = objectiveHoldNotice(receipt({ alreadyHeld: true, dismissedPendingSchedules: 2 }));
    expect(said).toContain("本来就在");
    expect(said).not.toContain("撤下");
  });

  it("恢复：新建那一档念出日期", () => {
    const said = objectiveResumeNotice(resume({ scheduled: "created" }));
    expect(said).toContain("10 天后");
    expect(said).toContain("已经排上");
  });

  it("恢复：沿用已有的那一格说「沿用」，不冒充这次排的", () => {
    const said = objectiveResumeNotice(resume({ scheduled: "reused_existing" }));
    expect(said).toContain("沿用已经排好的安排");
    expect(said).not.toContain("已经排上");
  });

  it("本来就没在排除中：仍要说排上了（released 与 scheduled 是两件事）", () => {
    const said = objectiveResumeNotice(resume({ released: false }));
    expect(said).toContain("本来就没有在暂不安排中");
    expect(said).toContain("已经排上");
  });

  it("屏上那枚纸签与那行说明：说清怎么回来，且不承诺别的安排也停了", () => {
    expect(objectiveReviewHoldLabel(HOLD)).toContain("暂不安排");
    const hint = objectiveReviewHoldHint(HOLD);
    expect(hint).toContain(OBJECTIVE_RESUME_ACTION_LABEL);
    expect(hint).toContain("照旧");
  });

  it("恢复那颗按钮承诺的是「恢复并开启」，不是「取消排除」", () => {
    // §9.1 行 3：只有「恢复此目标并开启」才解除排除。文案退化成"取消"就会
    // 重新造出那个"点完之后再也不回队列"的洞。
    expect(OBJECTIVE_RESUME_ACTION_LABEL).toBe("恢复并开启");
    expect(OBJECTIVE_HOLD_ACTION_LABEL).toContain("暂不安排");
  });
});
