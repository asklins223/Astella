/**
 * 语音与本地识别模型这一族的**设备级通道**（2026-10-06 从 `desktop-ipc.ts` 拆出）。
 *
 * ## 为什么单独一个文件
 *
 * 五条通道（模型四条 + 本机识别一条）在边界上同族：**设备级、不要求工作区纪元、
 * 不过网关**——模型与音频都在这台机器上，不在谁的名下。用户在设置页第一次点「下载」
 * 时可能还没登录任何空间，用 `assertEpoch` 会把这一次正当操作判成 `stale_workspace`，
 * 界面上只剩一句看不懂的失败；识别那句更不该扯上工作区。
 *
 * 拆出来的直接原因是体量：`desktop-ipc.ts` 2026-09-30 已拆到软线（2000）之下
 * （1904 行），把这一族留在原地会把它重新推过软线——那是已还的账，不该重新欠上。
 *
 * ## 与模型那条的分工
 *
 * 模型四条只回答「模型在不在这台机器上、下到哪了」；本机识别那条才碰音频，
 * 解码在 `utilityProcess`（Node 上下文）里做。两件事都不经过网关：服务端从头到尾
 * 没参与，**音频不出设备**。
 */

import type { BrowserWindow } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import {
  companionVoiceTranscribeRequestV1Schema,
  companionVoiceTranscribeResultV1Schema,
  DESKTOP_IPC_CHANNELS,
  requestMetaSchema,
  type RequestMetaV1,
} from "@ailearn/shared/desktop-ipc-contracts";
import { voiceAsrModelSnapshotV1Schema } from "@ailearn/shared/voice-asr-model-contracts";
import { runtimeInputSchema } from "./desktop-ipc-companion";
import type { InputSchema, ParsedMeta } from "./desktop-ipc";
import { DesktopGatewayFailure } from "./desktop-gateway-failure";
import { voiceAsrModelMountUrl } from "./voice-asr-model-route";
import type { VoiceAsrModelStore } from "./voice-asr-model-store";
import { transcribeWithVoiceAsrEngine } from "./voice-asr-engine";

/** 这一族从 `registerM1DesktopIpc` 的闭包里拿到的全部东西。 */
export type VoiceAsrChannelDeps = {
  /** 闭包版 `channel()`：已经绑好 options 与纪元取值器。 */
  channel: <TInput extends ParsedMeta, TOutput>(
    name: string,
    schema: InputSchema<TInput>,
    operation: (event: IpcMainInvokeEvent, window: BrowserWindow, input: TInput) => TOutput | Promise<TOutput>,
    outputSchema?: z.ZodType<TOutput>,
  ) => void;
  /** 纪元豁免：设备级通道不需要工作区纪元。 */
  assertEpochBoundaryExempt: (meta: RequestMetaV1, activeWorkspaceEpoch: number) => void;
  /** 纪元的 getter，不是值（闭包里是会话读回来之后才立起来的可变状态）。 */
  activeWorkspaceEpoch: () => number;
  /** 模型仓库；没有它这四条就是 `configuration_error`。 */
  voiceAsrModelStore?: VoiceAsrModelStore;
};

export function registerVoiceAsrChannels(deps: VoiceAsrChannelDeps): void {
  const { channel, assertEpochBoundaryExempt, activeWorkspaceEpoch } = deps;

  /**
   * `mountUrl` 交的是**页面所在那个 origin** 下的保留前缀（算法见
   * `voiceAsrModelMountUrl`）：打包后由 app scheme 路由提供，开发时由开发服务器提供，
   * 两种形态都同源。
   */
  const mountUrlFor = (window: BrowserWindow): string => {
    try {
      return voiceAsrModelMountUrl(window.webContents.getURL(), process.env.ELECTRON_RENDERER_URL);
    } catch {
      throw new DesktopGatewayFailure("configuration_error", "never");
    }
  };

  for (const [channelName, run] of [
    [DESKTOP_IPC_CHANNELS.companionVoiceAsrModelState, null],
    [DESKTOP_IPC_CHANNELS.companionVoiceAsrModelDownload, "startDownload"],
    [DESKTOP_IPC_CHANNELS.companionVoiceAsrModelCancel, "cancel"],
    [DESKTOP_IPC_CHANNELS.companionVoiceAsrModelRemove, "remove"],
  ] as const) {
    channel(channelName, runtimeInputSchema, async (_event, window, input) => {
      assertEpochBoundaryExempt(input.meta, activeWorkspaceEpoch());
      const store = deps.voiceAsrModelStore;
      if (!store) throw new DesktopGatewayFailure("configuration_error", "never");
      // 下载是长任务：发起即返回，进度靠再去读状态拿。把 239 MB 的等待压在
      // 一次 invoke 里，用户切走设置页就会把它一起带走。
      if (run) await store[run]();
      return voiceAsrModelSnapshotV1Schema.parse({
        version: 1,
        mountUrl: mountUrlFor(window),
        ...(await store.state()),
      });
    }, voiceAsrModelSnapshotV1Schema);
  }

  /**
   * 本机识别（2026-10-06）：渲染层录到的 PCM 在这里进 Node 子进程解码。
   *
   * 解码放在 `utilityProcess` 里而不是渲染进程的 worker：随包的 sherpa-onnx 是
   * emscripten 的 Node 构建（工厂里无条件 `require("path")` + NODERAWFS 只认 Node），
   * 而窗口是 `sandbox: true`，worker 里连 `require` 都没有——那条路在打包应用里
   * 只会回「识别失败：require is not defined」。
   */
  channel(
    DESKTOP_IPC_CHANNELS.companionVoiceTranscribe,
    z.strictObject({
      meta: requestMetaSchema,
      request: companionVoiceTranscribeRequestV1Schema,
    }),
    async (_event, _window, input) => {
      assertEpochBoundaryExempt(input.meta, activeWorkspaceEpoch());
      const bytes = Buffer.from(input.request.pcmBase64, "base64");
      // 半个样本说明 base64 不是这一段 PCM：宁可当场判失败，也不要把错位的样本喂给引擎。
      if (bytes.byteLength < 2 || bytes.byteLength % 2 !== 0) {
        throw new DesktopGatewayFailure("validation", "user_action");
      }
      const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
      try {
        return companionVoiceTranscribeResultV1Schema.parse({
          text: await transcribeWithVoiceAsrEngine(pcm, input.request.sampleRate),
        });
      } catch {
        // 引擎起不来/半路死掉/超时：说清是**本机引擎**的问题（服务端没参与），
        // 而不是那句会把用户送去重试网络的"学习服务出了点问题"。
        throw new DesktopGatewayFailure("voice_engine_unavailable", "user_action");
      }
    },
    companionVoiceTranscribeResultV1Schema,
  );
}