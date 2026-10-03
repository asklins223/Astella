// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopCardGenerationFeedbackReasonV2 } from "@ailearn/shared/card-generation-desktop-contracts";
import { useRoomStore } from "../../../../app/room-store";
import { GenerationSetup } from "../notebook-generation-setup";
import { DEFAULT_GENERATION_OPTIONS, generationOptionSummary, type GenerationOptions } from "../notebook-generation-options";

function MakingNote({ dirty = false, onStart = () => undefined, onClose = () => undefined }: {
  dirty?: boolean; onStart?: (options: GenerationOptions, note: string) => void; onClose?: () => void;
}) {
  const [options, setOptions] = useState(DEFAULT_GENERATION_OPTIONS);
  const [feedbackNote, setFeedbackNote] = useState("");
  const [feedbackReasons, setFeedbackReasons] = useState<readonly DesktopCardGenerationFeedbackReasonV2[]>([]);
  const [startingGeneration, setStarting] = useState(false);
  return <GenerationSetup options={options} setOptions={setOptions} startingGeneration={startingGeneration} generationFailure={null}
    dirty={dirty} generationEnabled startGeneration={() => { onStart(options, feedbackNote); setStarting(true); }}
    feedbackTarget={{ runId: "previous", status: "activated", updatedAt: "2026-10-01" }} feedbackNote={feedbackNote} setFeedbackNote={setFeedbackNote}
    feedbackReasons={feedbackReasons} setFeedbackReasons={setFeedbackReasons} generationOptionSummary={generationOptionSummary}
    cardGenerationStatusLabel={() => "已收进卡组"} formatRelative={() => "昨天"} closeGenerationSetup={onClose} />;
}
beforeEach(() => useRoomStore.setState({ motionMode: "off", reducedMotion: false }));
afterEach(() => { cleanup(); useRoomStore.setState({ motionMode: "full", reducedMotion: false }); });

describe("制作学习卡的小纸笺", () => {
  it("默认可开始，微调选项可以按需展开", () => {
    const onStart = vi.fn(); render(<MakingNote onStart={onStart} />);
    expect(screen.getByRole("dialog", { name: "这次想怎么练？" })).toBeTruthy();
    expect(screen.getByText("微调这叠卡").closest("details")?.open).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "开始生成" }));
    expect(onStart).toHaveBeenCalledWith(DEFAULT_GENERATION_OPTIONS, "");
    expect(screen.getByRole("button", { name: "记住" }).matches(":disabled")).toBe(true);
  });
  it("卡型、数量与学习方向一起交给生成入口，至少留一种卡型", () => {
    const onStart = vi.fn(); render(<MakingNote onStart={onStart} />);
    fireEvent.click(screen.getByRole("button", { name: "应用" }));
    fireEvent.click(screen.getByText("微调这叠卡"));
    fireEvent.click(screen.getByRole("button", { name: "4 张" }));
    fireEvent.click(screen.getByRole("button", { name: "深入" }));
    for (const name of ["主动回忆", "关键补全", "对比辨析", "顺序重建", "边界判断", "情境应用"]) fireEvent.click(screen.getByRole("button", { name }));
    expect((screen.getByRole("button", { name: "机制解释" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "开始生成" }));
    expect(onStart).toHaveBeenCalledWith({ learningGoal: "apply", detailThreshold: "deep", hardMaxCards: 4, preferredStrategies: ["why"] }, "");
  });
  it("反馈是可选的，多行补充内容不会被合成一行", () => {
    const onStart = vi.fn(); render(<MakingNote onStart={onStart} />);
    fireEvent.click(screen.getByText("让这次更合心意"));
    expect(screen.queryByRole("textbox", { name: "重新生成的补充说明" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "与已有卡片重复" }));
    const note = "合并相近的问题。\n保留能解释原因的卡。";
    fireEvent.change(screen.getByRole("textbox", { name: "重新生成的补充说明" }), { target: { value: note } });
    fireEvent.click(screen.getByRole("button", { name: "开始生成" }));
    expect(onStart).toHaveBeenCalledWith(DEFAULT_GENERATION_OPTIONS, note);
  });
  it("键盘焦点跳过折叠内容，并能从头尾循环及 Escape 关闭", () => {
    const onClose = vi.fn(); render(<MakingNote onClose={onClose} />);
    const first = screen.getByRole("button", { name: "关闭生成方案" });
    const last = screen.getByRole("button", { name: "开始生成" });
    first.focus(); fireEvent.keyDown(first, { key: "Tab", shiftKey: true }); expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: "Tab" }); expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Escape" }); expect(onClose).toHaveBeenCalledTimes(1);
  });
  it("未保存的正文不会被拿去创建新卡", () => {
    const onStart = vi.fn(); render(<MakingNote dirty onStart={onStart} />);
    fireEvent.click(screen.getByRole("button", { name: "开始生成" })); expect(onStart).not.toHaveBeenCalled();
    expect(screen.getByText("笔记改动还没保存，保存后就可以开始。")).toBeTruthy();
  });
});
