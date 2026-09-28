import { describe, expect, it } from "vitest";
import type { RoundNextStepV1 } from "@ailearn/shared/note-learning-round-contracts";
import { noteLearningScene, notePracticeResultCopy, roundTrackNextV1, roundTrackV1 } from "./note-learning-flow";

const step = (kind: RoundNextStepV1["kind"], evidence: RoundNextStepV1["evidence"] = "none"): RoundNextStepV1 =>
  ({ kind, basisRunId: null, gapFacets: [], evidence });

describe("note learning scene", () => {
  const base = { roundPhase: "active" as const, editingQuestion: false, hasTeaching: false, nextStep: step("explain") };

  it("opens only the activity signed by the server", () => {
    expect(noteLearningScene(base)).toBe("question");
    expect(noteLearningScene({ ...base, nextStep: step("attempt") })).toBe("question");
    expect(noteLearningScene({ ...base, hasTeaching: true, nextStep: step("attempt") })).toBe("teaching");
    expect(noteLearningScene({ ...base, nextStep: step("resume") })).toBe("practice");
    expect(noteLearningScene({ ...base, nextStep: step("help", "incomplete") })).toBe("result");
    expect(noteLearningScene({ ...base, nextStep: null })).toBe("unavailable");
    expect(noteLearningScene({ ...base, roundPhase: "paused" })).toBe("paused");
  });
});

describe("这一轮走到哪一步（39f UI-2）", () => {
  const marks = (input: Parameters<typeof roundTrackV1>[0]) => roundTrackV1(input).map((s) => s.mark);
  const notes = (input: Parameters<typeof roundTrackV1>[0]) => roundTrackV1(input).map((s) => s.note);
  const fresh = { scene: "question" as const, hasTeaching: false, practiceCount: 0, settledCount: 0, canFinish: false };

  it("什么也没做时三枚都不亮——不用「已经走过一步」来安慰一张空白纸", () => {
    expect(marks(fresh)).toEqual(["current", "todo", "todo"]);
    expect(notes(fresh)[0]).toBe("正在讲");
  });

  it("讲过了就是讲过了；后面一步都还没开始时它仍是「正在」那一枚", () => {
    expect(marks({ ...fresh, hasTeaching: true, scene: "teaching" })).toEqual(["current", "todo", "todo"]);
    expect(marks({ ...fresh, hasTeaching: true, scene: "teaching", settledCount: 1 })).toEqual(["done", "done", "todo"]);
  });

  it("开着的那一次练习算「正在答」，不算「练过了」（未结算的成绩不是成绩）", () => {
    expect(marks({ ...fresh, hasTeaching: true, scene: "practice", practiceCount: 1, settledCount: 0 }))
      .toEqual(["done", "current", "todo"]);
    expect(notes({ ...fresh, hasTeaching: true, scene: "practice", practiceCount: 1, settledCount: 0 })[1])
      .toBe("正在答");
  });

  it("只数已结算的次数，且那句话把数量说出来", () => {
    const two = { ...fresh, hasTeaching: true, scene: "result" as const, practiceCount: 2, settledCount: 2 };
    expect(notes(two)[1]).toBe("已经试过 2 次");
    // 三次里只结算过一次：说 1 次，不说 3 次。
    expect(notes({ ...two, settledCount: 1, practiceCount: 3 })[1]).toBe("已经试过 1 次");
  });

  it("「看收获」只有服务端说这一轮可以收了，才签得过「已看过」", () => {
    expect(marks({ ...fresh, hasTeaching: true, scene: "result", settledCount: 1, practiceCount: 1, canFinish: false }))
      .toEqual(["done", "done", "current"]);
    expect(marks({ ...fresh, hasTeaching: true, scene: "result", settledCount: 1, practiceCount: 1, canFinish: true }))
      .toEqual(["done", "done", "done"]);
    // 还没走到结果那一格就标"已看过"，是拿没发生过的事充进度。
    expect(marks({ ...fresh, hasTeaching: true, settledCount: 1, practiceCount: 1, canFinish: true })[2]).toBe("todo");
  });

  it("暂停回来仍说得清「停在哪一步」", () => {
    const paused = { ...fresh, scene: "paused" as const, hasTeaching: true, settledCount: 1, practiceCount: 1 };
    expect(marks(paused)).toEqual(["done", "done", "todo"]);
    expect(roundTrackV1(paused)[0]!.note).toBe("已经讲过");
  });
});

describe("这一轮的收获回执（39f §3 最后一格）", () => {
  const practices = [{ outcome: "demonstrated" as const }, { outcome: "partial" as const }];

  it("第一行点名这一轮的问题与最近那次的真实结算，不是一句通用话", () => {
    const copy = notePracticeResultCopy({
      question: "提取练习为什么要合上书",
      practices,
      nextStep: step("finish", "independent_demonstrated"),
    });
    expect(copy.today).toContain("提取练习为什么要合上书");
    expect(copy.today).toContain("走出来了");
    // 结算说法取的是**最后一次已结算**的那一次，不是笼统的"练过了"。
    expect(copy.today).toContain("做出一部分");
    expect(copy.today).not.toContain("留下作答记录");
  });

  it("还差的那一行说成一个动作，不是能力名", () => {
    const copy = notePracticeResultCopy({
      question: null,
      practices: [],
      nextStep: { kind: "help", basisRunId: null, gapFacets: ["example", "boundary"], evidence: "incomplete" },
    });
    expect(copy.gap).toContain("举出一个合适的例子");
    expect(copy.gap).toContain("说出它什么时候不成立");
    expect(copy.gap).not.toContain("示例");
  });

  it("判不出来就是判不出来，不说成「你没学会」", () => {
    const copy = notePracticeResultCopy({
      question: "q",
      practices: [],
      nextStep: step("finish", "unassessable"),
    });
    expect(copy.gap).toContain("系统");
    expect(copy.gap).toContain("不代表你没学会");
    expect(copy.today).toContain("没能可靠判断");
  });

  it("一道题的证据不等于整篇笔记", () => {
    const copy = notePracticeResultCopy({
      question: "提取练习为什么要合上书",
      practices,
      nextStep: step("finish", "independent_demonstrated"),
    });
    expect(copy.gap).toContain("整篇笔记");
  });

  it("还没有作答时如实说没有，不替你下结论", () => {
    const copy = notePracticeResultCopy({ question: "q", practices: [], nextStep: null });
    expect(copy.today).toContain("没有结算过的练习");
    expect(copy.gap).toContain("不替你下结论");
  });

  it("「接着做什么」一处签发：结果页与暂停回执读同一句", () => {
    for (const kind of ["explain", "attempt", "resume", "help", "retry", "apply", "finish", "uncertain", "choose", "review_material"] as const) {
      const copy = notePracticeResultCopy({
        question: "q",
        practices: [],
        nextStep: { kind, basisRunId: null, gapFacets: [], evidence: "practice_covered" },
      });
      expect(copy.next).toBe(roundTrackNextV1(kind));
    }
  });
});
