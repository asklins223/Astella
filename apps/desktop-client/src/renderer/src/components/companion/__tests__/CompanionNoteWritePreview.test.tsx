// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CompanionProposalUiState } from "../../../app/companion-session/companion-chat-session";
import { CompanionNoteWritePreview } from "../journal/CompanionNoteWritePreview";

const mock = vi.hoisted(() => ({ chat: null as any }));
vi.mock("../../../app/companion-session/companion-chat-session", () => ({ useOptionalCompanionChat: () => mock.chat }));
afterEach(cleanup);

it("预览和取消不会卸载编辑器或覆盖用户在等待期间的编辑", () => {
  const noteId = "11111111-1111-4111-8111-111111111111";
  const state: CompanionProposalUiState = { phase: "ready", proposal: {
    version: 1, proposalId: noteId, conversationId: noteId, sourceMessageId: noteId, sourceGeneration: 1,
    contextGrantId: null, payloadSha256: "a".repeat(64), title: "保存这次改动？", targetSummary: "原笔记",
    impactSummary: "保存完整结果", requiresConfirmation: true, status: "pending", decision: null,
    expiresAt: null, decidedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    payload: { kind: "agent_tool_review", toolName: "companion_edit_note", arguments: {},
      confirmationStage: "after_preview", preview: { noteId, title: "原笔记", markdown: "准备好的完整新内容" } },
  } };
  mock.chat = { proposalStates: {}, decideProposal: vi.fn(), retryProposal: vi.fn() };
  const paper = () => <CompanionNoteWritePreview noteId={noteId}><input aria-label="真实编辑器" defaultValue="用户原文" /></CompanionNoteWritePreview>;
  const { rerender } = render(paper());
  const editor = screen.getByLabelText("真实编辑器") as HTMLInputElement;
  fireEvent.change(editor, { target: { value: "用户后来补写" } });
  mock.chat.proposalStates = { [noteId]: state }; rerender(paper());
  expect(editor.parentElement!.hidden).toBe(true);
  expect(screen.getByLabelText("待保存的完整结果").textContent).toBe("准备好的完整新内容");
  fireEvent.click(screen.getByRole("button", { name: "取消并还原" }));
  expect(mock.chat.decideProposal).toHaveBeenCalledWith(noteId, "reject");
  mock.chat.proposalStates = { [noteId]: { ...state, proposal: { ...state.proposal, status: "rejected" } } }; rerender(paper());
  expect(editor.parentElement!.hidden).toBe(false);
  expect(screen.getByLabelText("真实编辑器")).toBe(editor);
  expect(editor.value).toBe("用户后来补写");
});
