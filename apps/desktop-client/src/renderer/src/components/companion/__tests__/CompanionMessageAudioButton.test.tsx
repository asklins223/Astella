// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CompanionMessageAudioButton, COMPANION_AUDIO_CACHE_CHANGED } from "../voice/CompanionMessageAudioButton";
import { CompanionChatRecordArticle } from "../hud/CompanionChatRecord";
import { DialoguePanel } from "../../surfaces/companion/companion-dialogue-panel";
import { interactionSession } from "./companion-interaction-fixtures";
import { resetCompanionVoicePlayback, setCompanionVoiceHost } from "../../../app/companion-session/companion-voice-playback";
import { useRoomStore } from "../../../app/home/room-store";
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

/**
 * 2026-10-16 改判：没有本机录音时**不再直接消失**。
 *
 * 原来这里断言 `queryByRole("button")` 为 null——那正是"错过的这一段永久静音、
 * 连手动补听的入口都没有"的形状（生产 09:10 那条主动消息：服务端下发 2 段、
 * 本机一个字都没有、按钮不存在）。现在这个位置给的是补听入口。
 */
it("没有本机录音时给补听入口，新录音到了再换成播放", async () => {
  list.mockResolvedValue(ok({ version: 1, items: [] }));
  render(<CompanionMessageAudioButton runId={runId} />);
  await waitFor(() => expect(list).toHaveBeenCalledOnce());
  expect(await screen.findByRole("button", { name: "补听这段" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "播放这条消息的音频" })).toBeNull();
  list.mockResolvedValue(ok({ version: 1, items: [{ runId, ordinals: [1] }] }));
  act(() => window.dispatchEvent(new Event(COMPANION_AUDIO_CACHE_CHANGED)));
  await screen.findByRole("button", { name: "播放这条消息的音频" });
  expect(screen.queryByRole("button", { name: "补听这段" })).toBeNull();
  list.mockResolvedValue(ok({ version: 1, items: [] }));
  act(() => window.dispatchEvent(new Event(COMPANION_AUDIO_CACHE_CHANGED)));
  await screen.findByRole("button", { name: "补听这段" });
});

/** 补听取不到服务端留档时说实话，不假装还能放。 */
it("补听取不到留档时说清楚，不静默失败", async () => {
  list.mockResolvedValue(ok({ version: 1, items: [] }));
  render(<CompanionMessageAudioButton runId={runId} />);
  fireEvent.click(await screen.findByRole("button", { name: "补听这段" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("这段暂时取不回来。"));
  expect(play).not.toHaveBeenCalled();
});

/**
 * 这一条钉的是"没有留档"那条话真的能说出来。
 *
 * 上面那条只走到"拿不到补听通道"（`listRunVoiceSegments` 缺席）。服务端把
 * 没有留档从 404 改成 200 + 空列表之后，客户端在解包那一步不再抛，两句实话
 * 才第一次有分工：取不回来 vs 这一轮确实没留下音频。
 */
it("这一轮没有留档时说实话，不进播放态也不假装能放", async () => {
  const listRunVoiceSegments = vi.fn().mockResolvedValue(ok({
    version: 1, runId, conversationId: "33333333-3333-4333-8333-333333333333", generation: null, items: [],
  }));
  vi.stubGlobal("astella", { companion: {
    voice: { cachedList: list },
    chat: { listRunVoiceSegments },
  } });
  list.mockResolvedValue(ok({ version: 1, items: [] }));
  render(<CompanionMessageAudioButton runId={runId} />);
  fireEvent.click(await screen.findByRole("button", { name: "补听这段" }));
  await waitFor(() => expect(listRunVoiceSegments).toHaveBeenCalledOnce());
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("这段没有留下语音记录。"));
  expect(play).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "停止播放这条消息的音频" })).toBeNull();
});

/**
 * 这一条钉的是 2026-10-16 自查抓到的接线洞：伴星中心的连续对话与手记时间线**根本没有
 * conversationId**（那一层按产品口径不暴露 conversation），所以原来那个"要 conversationId
 * 才给补听"的条件在那里永远走不到——入口给了也只会说"暂时取不回来"。
 * 现在请求只带 runId，会话身份由服务端随段回来。
 */
it("只带 runId 也能补听：会话身份用服务端回来的那一份，不靠界面自己知道", async () => {
  const conversationId = "44444444-4444-4444-8444-444444444444";
  const listRunVoiceSegments = vi.fn().mockResolvedValue(ok({
    version: 1, runId, conversationId, generation: 7,
    items: [{ ordinal: 1, segmentId: "a".repeat(64), displayText: "刚讲完饭锅的故事",
      displayStart: 0, displayEnd: 8, cue: { emotion: "neutral" } }],
  }));
  const synthesizeSegment = vi.fn().mockResolvedValue({ duration: 1 });
  vi.stubGlobal("astella", { companion: { voice: { cachedList: list }, chat: { listRunVoiceSegments } } });
  list.mockResolvedValue(ok({ version: 1, items: [] }));
  setCompanionVoiceHost({ audible: () => true, synthesize: vi.fn(), synthesizeSegment,
    readCachedSegment: read, play, stop, reportSegmentOutcome: vi.fn() });
  render(<CompanionMessageAudioButton runId={runId} />);
  fireEvent.click(await screen.findByRole("button", { name: "补听这段" }));
  await waitFor(() => expect(listRunVoiceSegments).toHaveBeenCalledOnce());
  expect(listRunVoiceSegments.mock.calls[0][0].request).toEqual({ version: 1, runId });
  await waitFor(() => expect(synthesizeSegment).toHaveBeenCalledOnce());
  expect(synthesizeSegment.mock.calls[0][0]).toMatchObject({
    version: 2, conversationId, runId, generation: 7, ordinal: 1,
  });
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
