// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useRoomStore } from "../../../../../../app/home/room-store";
import { LearningCardSurface } from "../learning-card-surface";

vi.mock("../../../../../../app/client/desktop-client", () => ({ createRequestMeta: (workspaceEpoch: number) => ({ workspaceEpoch }), gatewayErrorMessage: (error: unknown) => error instanceof Error ? error.message : "读取失败", unwrapGatewayResult: <T,>(result: { value: T }) => result.value }));
vi.mock("../../../../../../app/home/surface-session", () => ({ readAuthenticatedSession: async () => ({ workspaceEpoch: 7 }) }));
vi.mock("../../../../../../app/companion-session/companion-voice-playback", () => ({ stopCompanionSpeech: vi.fn() }));
vi.mock("../../../../../companion/voice/companion-notification-voice", () => ({ stopCompanionNotificationSpeech: vi.fn() }));
afterEach(() => { cleanup(); useRoomStore.setState({ returnTarget: null, activeNoteRef: null, surface: null }); });

it("reads the selected note on an independent card surface with generation controls and no notebook tools", async () => {
  const getNote = vi.fn(async () => ({ value: { noteId: "note-1", title: "地方行政", currentVersionId: "saved-version" } }));
  const getCard = vi.fn(async () => ({ value: { card: null, generating: false } }));
  const generate = vi.fn(async () => ({ value: { cardId: "card-1", queued: true } }));
  window.astella = { note: { get: getNote }, noteLearningCard: { get: getCard, generate } } as never;
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  const back = vi.fn();
  useRoomStore.setState({ surface: "note-card", activeNoteRef: { noteId: "note-1", noteVersionId: "saved-version" }, returnTarget: { label: "返回笔记", run: back } });
  render(<LearningCardSurface />);
  await screen.findByRole("heading", { name: "准备你的配套练习" });
  expect(getNote).toHaveBeenCalledWith({ meta: { workspaceEpoch: 7 }, noteId: "note-1" });
  expect(getCard).toHaveBeenCalledWith(expect.objectContaining({ noteId: "note-1" }));
  expect(useRoomStore.getState().hudPage).toBe("note-card");
  expect(screen.getByRole("region", { name: "学习卡独立页面" })).toBeTruthy();
  expect(document.querySelector(".notebook-desk")).toBeNull();
  expect(screen.queryByRole("button", { name: "资料袋" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /4.*题.*轻轻试一试/ }));
  fireEvent.click(screen.getByRole("button", { name: "生成这张学习卡" }));
  await waitFor(() => expect(generate).toHaveBeenCalledWith(expect.objectContaining({ noteId: "note-1", noteVersionId: "saved-version", options: { questionCount: 4 } })));
  await screen.findByRole("heading", { name: "正在制作你的学习卡" });
  const backButton = screen.getByRole("button", { name: "返回笔记" });
  expect(backButton.closest(".learning-card-surface")).toBeTruthy();
  fireEvent.click(backButton);
  expect(back).toHaveBeenCalledOnce();
});
