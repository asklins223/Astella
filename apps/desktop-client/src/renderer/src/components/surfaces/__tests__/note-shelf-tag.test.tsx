// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NoteShelfTag, noteShelfTagText } from "../notebook/note-shelf-tag.tsx";
import type { NoteShelfStateV1 } from "@astella/shared/note-shelf-state-contracts";

/**
 * 那一枚纸签的三条硬约束。
 *
 * 最要紧的是第一条：**读不到状态时不画纸签**。把「没读到」渲染成「暂无学习记录」，是
 * 界面替数据库编了一个不存在的事实——而这正是 41 §5 反复在防的那类事。
 * 用户会照着它决定还要不要读一篇自己已经读过的笔记。
 */
afterEach(cleanup);

const state = (patch: {
  stage?: NoteShelfStateV1["stage"];
  editedAfterLearning?: boolean;
  facts?: Partial<NoteShelfStateV1["facts"]>;
}): NoteShelfStateV1 => ({
  facts: {
    overviewCount: 0,
    overviewVersionNumber: null,
    recallCount: 0,
    lastRecallSelfReport: null,
    annotationCount: 0,
    artifactCount: 0,
    expansionCount: 0,
    latestVersionNumber: null,
    latestAt: null,
    ...(patch.facts ?? {}),
  },
  stage: patch.stage ?? "untouched",
  editedAfterLearning: patch.editedAfterLearning ?? false,
});

describe("NoteShelfTag", () => {
  it("读不到状态时什么都不画，而不是画一枚「暂无学习记录」", () => {
    const { container } = render(<NoteShelfTag state={null} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText("暂无学习记录")).toBeNull();
  });

  it("undefined 也当作读不到", () => {
    const { container } = render(<NoteShelfTag state={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it("空稿与「暂无学习记录」是两个词，不能合并", () => {
    const { unmount } = render(<NoteShelfTag state={state({ stage: "draft" })} />);
    expect(screen.getByText("空稿")).toBeTruthy();
    unmount();
    render(<NoteShelfTag state={state({ stage: "untouched" })} />);
    expect(screen.getByText("暂无学习记录")).toBeTruthy();
  });

  it("副签说能数出来的东西，不给百分比", () => {
    render(<NoteShelfTag state={state({
      stage: "annotated",
      facts: { annotationCount: 3, overviewCount: 2 },
    })} />);
    expect(screen.getByText("有原位批注")).toBeTruthy();
    expect(screen.getByText("2 张速看 · 3 处批注")).toBeTruthy();
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it("紧凑视图只留主签，数字交给 title", () => {
    const { container } = render(<NoteShelfTag compact state={state({
      stage: "recalled",
      facts: { recallCount: 4 },
    })} />);
    expect(container.querySelector(".note-state-tag__detail")).toBeNull();
    expect(container.querySelector(".note-state-tag")?.getAttribute("title"))
      .toContain("4 条回想");
  });

  it("改过版是另一枚签，且说清痕迹停在哪一版", () => {
    const { container } = render(<NoteShelfTag state={state({
      stage: "skimmed",
      editedAfterLearning: true,
      facts: { overviewCount: 1, latestVersionNumber: 2 },
    })} />);
    const tag = container.querySelector(".note-state-tag");
    expect(screen.getByText("速看已备")).toBeTruthy();
    expect(screen.getByText("改过版")).toBeTruthy();
    expect(tag?.getAttribute("data-edited-after-learning")).toBe("true");
    expect(tag?.getAttribute("title")).toContain("记录停在 v2");
  });

  it("stage 落到 data-stage 上，样式与测试都从它读", () => {
    const { container } = render(<NoteShelfTag state={state({ stage: "grew" })} />);
    expect(container.querySelector(".note-state-tag")?.getAttribute("data-stage")).toBe("grew");
  });

  it("自述「没想起来」不改变纸签上的那一个词", () => {
    render(<NoteShelfTag state={state({
      stage: "recalled",
      facts: { recallCount: 1, lastRecallSelfReport: "not_yet" },
    })} />);
    expect(screen.getByText("有回想记录")).toBeTruthy();
  });
});

describe("noteShelfTagText", () => {
  it("伴星读到的说法与纸签上是同一份事实", () => {
    const one = state({ stage: "annotated", facts: { annotationCount: 2, overviewCount: 1 } });
    expect(noteShelfTagText(one)).toBe("有原位批注，1 张速看，2 处批注");
  });

  it("改过版只报告版本变化，不推断用户看过", () => {
    expect(noteShelfTagText(state({
      stage: "skimmed",
      editedAfterLearning: true,
      facts: { overviewCount: 1, latestVersionNumber: 1 },
    }))).toBe("速看已备，1 张速看，这篇后来改过版（记录停在 v1）");
  });
});
