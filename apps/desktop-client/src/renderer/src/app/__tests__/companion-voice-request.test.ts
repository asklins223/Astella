// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { GatewayResultV1, RequestMetaV1 } from "@astella/shared/desktop-ipc-contracts";
import { requestCompanionVoiceAudio } from "../companion-voice-request.ts";

afterEach(() => { Reflect.deleteProperty(window, "astella"); });

function result(): GatewayResultV1<string> {
  return { version: 1, ok: true, data: "audio", requestId: "voice-test", correlationId: "voice-test", schemaRevision: "desktop-ipc-v1" };
}

it("停止时向主进程取消实际音频 requestId；迟到结果不能再交付", async () => {
  const cancel = vi.fn(async (_input: { requestId: string }) => result());
  Object.defineProperty(window, "astella", { configurable: true, value: { runtime: { cancel } } });
  let release!: (value: GatewayResultV1<string>) => void;
  let sentMeta!: RequestMetaV1;
  const controller = new AbortController();
  const pending = requestCompanionVoiceAudio(meta => {
    sentMeta = meta;
    return new Promise<GatewayResultV1<string>>(resolve => { release = resolve; });
  }, 7, controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  expect(cancel).toHaveBeenCalledOnce();
  expect(cancel.mock.calls[0]?.[0]).toMatchObject({ requestId: sentMeta.requestId });
  release(result());
  await rejected;
});

it("已经取消的请求不发送；正常请求结束后移除取消监听", async () => {
  const cancel = vi.fn(async (_input: { requestId: string }) => result());
  Object.defineProperty(window, "astella", { configurable: true, value: { runtime: { cancel } } });
  const invoke = vi.fn(async () => result());
  const preAborted = new AbortController();
  preAborted.abort();
  await expect(requestCompanionVoiceAudio(invoke, 7, preAborted.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(invoke).not.toHaveBeenCalled();
  const done = new AbortController();
  await expect(requestCompanionVoiceAudio(invoke, 7, done.signal)).resolves.toBe("audio");
  done.abort();
  expect(cancel).not.toHaveBeenCalled();
});
