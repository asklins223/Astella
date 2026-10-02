// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NoteRecallPaper } from "../notebook-recall-paper";
import type { NoteRecallCardV1 } from "../notebook-recall-contract";
import { recallQuestionText } from "../recall-question-text";

const recall: NoteRecallCardV1 = { question: "好，那我不给答案，先问一个：**IndexTTS 2.5 为什么要做 2.5 这个版本？", versionState: "current", noteVersionNumber: 3, sectionOrdinal: 1, selfReport: null };
const actions = { onCollapse: vi.fn(), onAct: vi.fn(async () => undefined), onReflectionChange: vi.fn(), onLocateSection: vi.fn() };
const base = { ...actions, busy: null, failure: null, reflection: "", paperRef: null };
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe("回想以一个问题和显式翻开的依据为主", () => {
  it("未闭合标记不出现在标题里；关键词默认折起，翻开前没有答案或自评", () => {
    const view = render(<NoteRecallPaper {...base} recall={recall} />);
    expect(view.getByRole("heading", { name: "IndexTTS 2.5 为什么要做 2.5 这个版本？" })).toBeTruthy();
    expect(view.queryByRole("region", { name: "原文对照" })).toBeNull();
    expect(view.queryByRole("button", { name: "想起了一部分" })).toBeNull();
    expect(view.container.querySelector("details")?.open).toBe(false);
    fireEvent.click(view.getByText("记几个关键词"));
    const input = view.getByLabelText("先记下你想起的内容（可不写）");
    fireEvent.change(input, { target: { value: "先修速度与语种" } });
    expect(actions.onReflectionChange).toHaveBeenCalledWith("先修速度与语种");
    fireEvent.click(view.getByRole("button", { name: "翻开原文对照" }));
    expect(actions.onAct).toHaveBeenCalledWith({ kind: "reveal" });
    expect(recallQuestionText("**长 * 宽 * 高** 为什么相乘？")).toBe("长 * 宽 * 高 为什么相乘？");
  });
  it("恢复已揭示的记录仍先看问题，主动对照才显示原句和自评；旧版不能跳到当前正文", async () => {
    const view = render(<NoteRecallPaper {...base} reflection="我的关键词" recall={{ ...recall, versionState: "older", answer: "原文讲 **速度**。\n\n还讲语种。" }} />);
    expect(view.queryByText("速度")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "翻开原文对照" }));
    const answer = await view.findByText("速度"); expect(answer.tagName).toBe("STRONG");
    expect(view.getByText("笔记后来改过，这里保留的是当时的原文快照。")).toBeTruthy();
    expect(view.queryByRole("button", { name: "回到原文" })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "想起了一部分" }));
    await waitFor(() => expect(actions.onAct).toHaveBeenCalledWith({ kind: "self_report", value: "partly", reflection: "我的关键词" }));
    view.rerender(<NoteRecallPaper {...base} recall={{ ...recall, answer: "当前的原句" }} />);
    fireEvent.click(view.getByRole("button", { name: "回到原文" })); expect(actions.onLocateSection).toHaveBeenCalledWith(0);
  });
  it("迟到的揭示回执只更新记录，不主动展开；用户明确揭示后才展开", async () => {
    const view = render(<NoteRecallPaper {...base} recall={recall} />);
    view.rerender(<NoteRecallPaper {...base} recall={{ ...recall, answer: "服务端保存的原句" }} />);
    expect(view.queryByText("服务端保存的原句")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "翻开原文对照" }));
    expect(await view.findByText("服务端保存的原句")).toBeTruthy();
    expect(actions.onAct).not.toHaveBeenCalled();
  });
  it("旧的整篇快照需要第二次明确展开", () => {
    const view = render(<NoteRecallPaper {...base} recall={{ ...recall, sectionOrdinal: null, answer: "旧文内容。".repeat(300) }} />);
    fireEvent.click(view.getByRole("button", { name: "翻开原文对照" }));
    const full = view.getByText("查看当时完整原文快照").closest("details"); expect(full?.open).toBe(false);
  });
});
