// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CompanionMessageAudioButton, COMPANION_AUDIO_CACHE_CHANGED } from "../CompanionMessageAudioButton";
import { CompanionChatRecordArticle } from "../CompanionChatRecord";
import { DialoguePanel } from "../../surfaces/companion/companion-dialogue-panel";
import { interactionSession } from "./companion-interaction-fixtures";
import { resetCompanionVoicePlayback, setCompanionVoiceHost } from "../../../app/companion-voice-playback";
import { useRoomStore } from "../../../app/room-store";
import type { CompanionMessageV1 } from "@astella/shared/companion-conversation-contracts";
const runId = "11111111-1111-4111-8111-111111111111";
const ok = <T,>(data: T) => ({ ok: true as const, data, workspaceEpoch: 1, requestId: "audio-test" });
const list = vi.fn();
const play = vi.fn();
const stop = vi.fn();
const read = vi.fn();
let settle: (() => void) | undefined;
beforeEach(() => {
  list.mockReset().mockResolvedValue(ok({ version: 1, items: [{ runId, ordinals: [1, 2] }] }));
  vi.stubGlobal("astella", { companion: { voice: { cachedList: list } } });
  read.mockReset().mockResolvedValue({ duration: 1 });
  play.mockReset().mockImplementation(() => new Promise<void>(resolve => { settle = resolve; }));
  stop.mockReset().mockImplementation(() => settle?.());
  setCompanionVoiceHost({ audible: () => true, synthesize: vi.fn(), synthesizeSegment: vi.fn(),
    readCachedSegment: read, play, stop, reportSegmentOutcome: vi.fn() });
});
afterEach(() => { cleanup(); resetCompanionVoicePlayback(); vi.unstubAllGlobals(); settle = undefined; });

it("shows only real local recordings and can stop them while preserving keyboard focus", async () => {
  render(<CompanionMessageAudioButton runId={runId} />);
  const button = await screen.findByRole("button", { name: "播放这条消息的音频" });
  button.focus(); fireEvent.click(button);
  await waitFor(() => expect(play).toHaveBeenCalledOnce());
  expect(button.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "停止播放这条消息的音频" }));
  expect(button.getAttribute("aria-pressed")).toBe("false");
  expect(document.activeElement).toBe(button);
  expect(read).toHaveBeenCalledOnce();
});

it("refreshes availability when new audio arrives or an old recording is evicted", async () => {
  list.mockResolvedValue(ok({ version: 1, items: [] }));
  render(<CompanionMessageAudioButton runId={runId} />);
  await waitFor(() => expect(list).toHaveBeenCalledOnce());
  expect(screen.queryByRole("button")).toBeNull();
  list.mockResolvedValue(ok({ version: 1, items: [{ runId, ordinals: [1] }] }));
  act(() => window.dispatchEvent(new Event(COMPANION_AUDIO_CACHE_CHANGED)));
  await screen.findByRole("button", { name: "播放这条消息的音频" });
  list.mockResolvedValue(ok({ version: 1, items: [] }));
  act(() => window.dispatchEvent(new Event(COMPANION_AUDIO_CACHE_CHANGED)));
  await waitFor(() => expect(screen.queryByRole("button")).toBeNull());
});

it("mounts the same player in the journal and companion center and excludes user messages", async () => {
  const message = { id: "22222222-2222-4222-8222-222222222222", role: "assistant", kind: "text", blocks: [{ type: "text", text: "当时她说的原话。" }],
    runId, createdAt: "2026-10-07T00:00:00Z" } as CompanionMessageV1;
  const journal = render(<CompanionChatRecordArticle message={message} chat={interactionSession()} />);
  await screen.findByRole("button", { name: "播放这条消息的音频" });
  journal.rerender(<CompanionChatRecordArticle message={{ ...message, role: "user" }} chat={interactionSession()} />);
  expect(screen.queryByRole("button", { name: "播放这条消息的音频" })).toBeNull();
  journal.unmount();
  const item = { ...message, version: 1 as const, messageId: message.id, editedAt: null };
  render(<DialoguePanel section={{ ok: true, value: { version: 1, items: [item], nextCursor: null } }} items={[item]} cursor={null}
    query="" searching={false} loadingMore={false} error={null} onQuery={vi.fn()} onSearch={vi.fn()} onLoadMore={vi.fn()} onRetry={vi.fn()} />);
  await screen.findByRole("button", { name: "播放这条消息的音频" });
});

it("stops on page departure or a workspace change and ignores late availability from the previous space", async () => {
  const page = render(<CompanionMessageAudioButton runId={runId} />);
  fireEvent.click(await screen.findByRole("button", { name: "播放这条消息的音频" }));
  await waitFor(() => expect(play).toHaveBeenCalledOnce());
  act(() => useRoomStore.setState(state => ({ workspaceScopeRevision: state.workspaceScopeRevision + 1 })));
  await waitFor(() => expect(stop).toHaveBeenCalled());
  fireEvent.click(await screen.findByRole("button", { name: "播放这条消息的音频" }));
  await waitFor(() => expect(play).toHaveBeenCalledTimes(2));
  const calls = stop.mock.calls.length;
  page.unmount();
  expect(stop.mock.calls.length).toBeGreaterThan(calls);
});

it("reports why a cached message cannot currently sound instead of doing another synthesis", async () => {
  setCompanionVoiceHost(null);
  render(<CompanionMessageAudioButton runId={runId} />);
  fireEvent.click(await screen.findByRole("button", { name: "播放这条消息的音频" }));
  expect(screen.getByRole("status").textContent).toContain("请先开启声音");
  expect(read).not.toHaveBeenCalled();
});
