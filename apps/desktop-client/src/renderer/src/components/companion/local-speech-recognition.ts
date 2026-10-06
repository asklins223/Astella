/**
 * 伴星语音识别的**唯一一条路**：本机上的 SenseVoice（sherpa-onnx WASM）。
 *
 * ## 为什么没有第二条（2026-10）
 *
 * 此前这里是「本地优先 + 云端兜底」：worker 拉不起来就把录音 base64 发给
 * `POST /voice/transcribe`（硅基流动）。那条路的代价不是"慢一点"——
 * 是**每一次本地失败都把用户的整段录音送出设备**，而且失败往往发生在用户最需要
 * 它的时候（模型没装好、内存吃紧、刚说完话）。
 *
 * 现在模型改成用户自己下载的附加功能，没装就是没装：这一层直接告诉调用方
 * 「本机还没有识别模型」，由界面把人领到设置里下载。**没有可回落的地方，
 * 也就没有"悄悄把录音送出去"的那种可能。**
 *
 * ## 为什么解码在主进程而不是这里的 worker（2026-10-06）
 *
 * 随包的 `public/sherpa/sherpa-onnx-wasm-nodejs.js` 是 emscripten 的 **Node 构建**：
 * 工厂函数一开头就无条件 `require("path")`，运行时还有一条
 * `if(!ENVIRONMENT_IS_NODE) throw new Error("NODERAWFS is currently only supported on Node.js environment.")`。
 * 而窗口是 `sandbox: true` + `nodeIntegration: false`——打包应用里实测 worker 内
 * `typeof require` 是 `undefined`，`init` 一律回 fatal，用户说完话只会看到
 * 「识别失败：require is not defined」。引擎没坏，是**位置**错了。
 *
 * 所以：录音仍然在这里采集（麦克风、波形、VAD 都是渲染层的事），解码交出去给主进程的
 * Node 子进程；音频只经一条本机 IPC，**不出这台设备**。空闲收摊那套记在主进程引擎上
 * （`voice-asr-engine.ts` 的 90 s），这一层不再持有引擎。
 */

import { readVoiceAsrModel } from "./voice-asr-model";
import { createRequestMeta, unwrapGatewayResult } from "../../app/desktop-client";

export type VoiceRoute = "local";

export interface VoiceTranscription {
  readonly text: string;
  readonly route: VoiceRoute;
}

/**
 * 本机还不能识别。界面据此把「去设置里下载」摆到用户面前——
 * 这是一个**可解决的动作**，不是一句"识别失败"。
 */
export class AsrModelMissingError extends Error {
  constructor() {
    super("本地识别模型尚未安装");
    this.name = "AsrModelMissingError";
  }
}

export function isAsrModelMissing(error: unknown): boolean {
  return error instanceof AsrModelMissingError;
}

/** 设备级通道：不要求工作区纪元（音频与引擎都在这台机器上，与登录哪个空间无关）。 */
const TRANSCRIBE_META = () => createRequestMeta();

/**
 * Float32（[-1,1]）→ Int16 小端 PCM 的 base64。
 *
 * 为什么转成字符串再过桥：这段字节要过 contextBridge 与 `ipcRenderer.invoke` 两道序列化，
 * 裸 TypedArray 在两边的支持面不同（structured clone 认、contextBridge 的老行为不保证），
 * base64 在两处都是普通值——和笔记正文走 IPC 是同一个形状。渲染层已经在录制时降采样到
 * 16 kHz（`voice-recorder.ts`），这里只做量化。
 */
function toPcmBase64(samples: Float32Array): string {
  const pcm = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]!));
    pcm[index] = Math.round(clamped * 32_767);
  }
  const bytes = new Uint8Array(pcm.buffer);
  // 分块换行：`String.fromCharCode(...bytes)` 一次传太多会炸调用栈（60 s 的录音接近 2 MB）。
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

export async function transcribeRecording(args: TranscribeArgs): Promise<VoiceTranscription> {
  const model = await readVoiceAsrModel();
  // 只认「两个文件都在」。下到一半（`downloading`）与下载失败（`error`）都不是"能用"——
  // 界面要把这两种情况分别领到"继续下"和"重试"，而不是笼统一句"没装好"。
  if (model.status !== "ready") throw new AsrModelMissingError();
  const result = await window.astella.companion.voice.transcribe({
    meta: TRANSCRIBE_META(),
    request: {
      sampleRate: args.sampleRate,
      pcmBase64: toPcmBase64(args.samples),
    },
  });
  return { text: unwrapGatewayResult(result).text, route: "local" };
}

export interface TranscribeArgs {
  readonly sampleRate: number;
  readonly samples: Float32Array;
}

/** 设置页之外的地方只想知道「现在能不能说话」时用它：一次 IPC，不拉引擎。 */
export async function isLocalAsrReady(): Promise<boolean> {
  try {
    return (await readVoiceAsrModel()).status === "ready";
  } catch {
    // 连状态都读不到（主进程没接线 / 没登录）时按"还不能"处理：宁可让界面说
    // "去设置看看"，也不让它去找一份引擎。
    return false;
  }
}