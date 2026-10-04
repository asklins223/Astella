// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useVoiceModelNotifications } from "../use-voice-model-notifications";
import type { VoiceAsrModelSnapshotV1 } from "../voice-asr-model";
const read = vi.hoisted(() => vi.fn());
const settled = vi.hoisted(() => vi.fn());
const progress = vi.hoisted(() => vi.fn());
vi.mock("../voice-asr-model", () => ({ readVoiceAsrModel: read }));
vi.mock("../voice-model-notifications", () => ({ VOICE_MODEL_DOWNLOAD_STARTED: "ailearn:voice-model-download-started", notifyVoiceModelSettled: settled, notifyVoiceModelDownloading: progress }));
const snapshot = (status: string) => ({ status }) as VoiceAsrModelSnapshotV1;
beforeEach(() => { vi.useFakeTimers(); read.mockReset().mockResolvedValue(snapshot("absent")); settled.mockReset(); progress.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
const start = async () => { await act(async () => window.dispatchEvent(new CustomEvent("ailearn:voice-model-download-started", { detail: snapshot("downloading") }))); };

it("does not announce a model that was already installed at startup", async () => {
  read.mockResolvedValue(snapshot("ready")); renderHook(useVoiceModelNotifications); await act(async () => {});
  expect(settled).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
it("tracks completion outside Settings and stops polling once installed", async () => {
  renderHook(useVoiceModelNotifications); await act(async () => {}); await start();
  read.mockResolvedValue(snapshot("ready")); await act(async () => vi.advanceTimersByTimeAsync(900));
  expect(settled).toHaveBeenCalledExactlyOnceWith(snapshot("ready")); expect(vi.getTimerCount()).toBe(0);
});
it("recovers an in-progress download and survives a temporarily unreadable IPC", async () => {
  read.mockResolvedValueOnce(snapshot("downloading")).mockRejectedValueOnce(new Error("restarting")).mockResolvedValue(snapshot("error"));
  renderHook(useVoiceModelNotifications); await act(async () => {});
  await act(async () => vi.advanceTimersByTimeAsync(900)); expect(settled).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(900)); expect(settled).toHaveBeenCalledExactlyOnceWith(snapshot("error"));
});
it("ignores a late initial state after a newer download begins", async () => {
  let resolve!: (state: VoiceAsrModelSnapshotV1) => void;
  read.mockImplementationOnce(() => new Promise(done => { resolve = done; })); renderHook(useVoiceModelNotifications); await start();
  await act(async () => resolve(snapshot("ready"))); expect(settled).not.toHaveBeenCalled();
  read.mockResolvedValue(snapshot("ready")); await act(async () => vi.advanceTimersByTimeAsync(900)); expect(settled).toHaveBeenCalledOnce();
});
it("does not deliver after the companion host unmounts", async () => {
  const view = renderHook(useVoiceModelNotifications); await act(async () => {}); await start();
  let resolve!: (state: VoiceAsrModelSnapshotV1) => void;
  read.mockImplementationOnce(() => new Promise(done => { resolve = done; })); await act(async () => vi.advanceTimersByTimeAsync(900));
  view.unmount(); await act(async () => resolve(snapshot("ready"))); expect(settled).not.toHaveBeenCalled();
});
