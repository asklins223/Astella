/**
 * 伴星语音识别的**唯一一条路**：本机上的 SenseVoice（sherpa-onnx WASM worker）。
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
 */

import { readVoiceAsrModel } from "./voice-asr-model";

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

interface DecodePending {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
}

let worker: Worker | null = null;
let initPromise: Promise<void> | null = null;
/** 正在等待 ready/fatal 的那次 init 的 reject；worker 崩了要立刻打断它。 */
let initReject: ((error: Error) => void) | null = null;
const pending = new Map<number, DecodePending>();
let decodeSeq = 0;

/**
 * 一句说完之后隔多久把整个识别引擎交还内存。
 *
 * 为什么必须交：本地 SenseVoice 一个引擎就是那份 228 MB 的 int8 模型——它进 WASM 堆、
 * onnxruntime 建图还要再占一份。而语音是**偶尔**用的功能：以前这条 worker 是模块级单例、
 * 只在崩溃时 `terminate`，成功路径上永不下线，于是用户说过一句话之后这几百 MB 就一直
 * 占到应用退出。90s 是「连说几句不用重载」与「说完就走别占着」之间的取值。
 */
const ASR_IDLE_RELEASE_MS = 90_000;
let releaseTimer = 0;

/** 收摊：断 worker、清在途解码，下一次识别从零起（会重付一次模型加载）。 */
function releaseEngine(): void {
  worker?.terminate();
  worker = null;
  initPromise = null;
  initReject = null;
  for (const [, entry] of pending) entry.reject(new Error("asr engine released"));
  pending.clear();
}

/**
 * 重新计时。触发时先看有没有东西还在跑：解码在途（`pending` 非空）或 init 还没落定
 * （`initReject` 还挂着，`settle()` 清它）都不收，顺延一轮——收了就是把一次正在进行的
 * 识别踢进「worker 已终止」的错误路径，用户那句话白说了。
 */
function armIdleRelease(): void {
  window.clearTimeout(releaseTimer);
  releaseTimer = window.setTimeout(() => {
    if (pending.size > 0 || initReject !== null) {
      armIdleRelease();
      return;
    }
    releaseEngine();
  }, ASR_IDLE_RELEASE_MS);
}

function spawnWorker(): Worker | null {
  if (worker) return worker;
  try {
    worker = new Worker("/sherpa/asr-worker.js");
  } catch {
    worker = null;
    return null;
  }
  worker.onmessage = (event: MessageEvent) => {
    const data = event.data || {};
    if (data.type === "ready" || data.type === "fatal") {
      // ready/fatal 由 init 的 await 链消费（worker 里的 promise 会 resolve/reject）。
      return;
    }
    if ((data.type === "result" || data.type === "error") && typeof data.id === "number") {
      const entry = pending.get(data.id);
      pending.delete(data.id);
      if (!entry) return;
      if (data.type === "result") entry.resolve(String(data.text ?? ""));
      else entry.reject(new Error(String(data.message ?? "decode failed")));
    }
  };
  worker.onerror = () => {
    // 加载失败（文件缺失等）：让 init 与在途解码立刻失败。
    // 不等 init 的 60s 超时——那会让用户点完「说完了」白等一分钟。
    for (const [, entry] of pending) entry.reject(new Error("asr worker crashed"));
    pending.clear();
    initReject?.(new Error("asr worker crashed"));
    // 死掉的 worker 不能复用：留着它下一次识别只会再撞一次同样的错。
    worker?.terminate();
    worker = null;
    initPromise = null;
  };
  return worker;
}

/**
 * @param mountUrl 主进程给的**同源**模型挂载点，以 `/` 结尾。
 *   它不是写死的地址：打包后是 `ailearn-app://bundle/device/asr/`，开发时是
 *   `http://localhost:5173/device/asr/`。worker 把它交给 fetch，两种形态都命中
 *   页面自己的 CSP `'self'`。
 */
async function initLocalEngine(mountUrl: string): Promise<void> {
  if (initPromise) return initPromise;
  const w = spawnWorker();
  if (!w) throw new Error("worker unavailable");
  initPromise = new Promise<void>((resolve, reject) => {
    const previous = w.onmessage;
    const previousError = w.onerror;
    const settle = () => {
      window.clearTimeout(timeout);
      w.onmessage = previous;
      w.onerror = previousError;
      initReject = null;
    };
    const timeout = window.setTimeout(() => {
      settle();
      initPromise = null;
      reject(new Error("asr init timeout"));
    }, 60_000);
    initReject = (error) => {
      settle();
      initPromise = null;
      reject(error);
    };
    w.onmessage = (event: MessageEvent) => {
      const data = event.data || {};
      if (data.type === "ready") {
        settle();
        resolve();
      } else if (data.type === "fatal") {
        settle();
        initPromise = null;
        reject(new Error(String(data.message ?? "asr init failed")));
      }
    };
    w.postMessage({ type: "init", mountUrl });
  });
  try {
    await initPromise;
  } catch (err) {
    initPromise = null;
    throw err;
  }
}

async function decodeLocally(mountUrl: string, sampleRate: number, samples: Float32Array): Promise<string> {
  // 有人要用了，先把「空闲就收摊」的表停掉——否则上一句留下的定时器会在这句识别中途
  // 把 worker 抽走。
  window.clearTimeout(releaseTimer);
  await initLocalEngine(mountUrl);
  const w = spawnWorker();
  if (!w) throw new Error("worker unavailable");
  const id = ++decodeSeq;
  return new Promise<string>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pending.delete(id);
      armIdleRelease();
      reject(new Error("asr decode timeout"));
    }, 30_000);
    pending.set(id, {
      resolve: (text) => {
        window.clearTimeout(timeout);
        armIdleRelease();
        resolve(text);
      },
      reject: (err) => {
        window.clearTimeout(timeout);
        armIdleRelease();
        reject(err);
      },
    });
    w.postMessage({ type: "decode", id, sampleRate, samples }, [samples.buffer]);
  });
}

export interface TranscribeArgs {
  readonly sampleRate: number;
  readonly samples: Float32Array;
}

export async function transcribeRecording(args: TranscribeArgs): Promise<VoiceTranscription> {
  const model = await readVoiceAsrModel();
  // 只认「两个文件都在」。下到一半（`downloading`）与下载失败（`error`）都不是"能用"——
  // 界面要把这两种情况分别领到"继续下"和"重试"，而不是笼统一句"没装好"。
  if (model.status !== "ready") throw new AsrModelMissingError();
  return { text: await decodeLocally(model.mountUrl, args.sampleRate, args.samples), route: "local" };
}

/** 设置页之外的地方只想知道「现在能不能说话」时用它：一次 IPC，不拉 worker。 */
export async function isLocalAsrReady(): Promise<boolean> {
  try {
    return (await readVoiceAsrModel()).status === "ready";
  } catch {
    // 连状态都读不到（主进程没接线 / 没登录）时按"还不能"处理：宁可让界面说
    // "去设置看看"，也不让它启动一个注定失败的两百兆引擎。
    return false;
  }
}