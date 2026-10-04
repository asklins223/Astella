import { z } from "zod";

/**
 * 客户端本地语音识别模型的合同（`companion.voice.asrModel.*`）。
 *
 * ## 为什么模型不在安装包里
 *
 * SenseVoice int8 一份就是 239 MB，而语音输入是**偶尔**才用的功能。跟着安装包走，
 * 每个人都为一年可能用十几次的句子多背 239 MB——所以它改成**用户自己决定要不要**：
 * 设置里下载到本机，随时可以移除，移除后录音根本不出设备这件事也就没有任何余地。
 *
 * ## 这一族合同的边界
 *
 * 这一族**只描述模型在本机的状态**（在不在、下到哪、失败在哪一类）。它不描述
 * 识别结果，也不描述音频：录音与识别都在渲染进程里就地发生，主进程只当仓库。
 * 当前语音输入由 `local-speech-recognition.ts` 交给本地 WASM worker，
 * 模型管理通道只传模型状态，不承载录音或识别内容。
 */

/** 目录里的两个文件就是**全部**模型内容：多一个少一个都不算装好。 */
export const VOICE_ASR_MODEL_FILES = [
  { name: "model.int8.onnx", expectedBytes: 239_233_841, sha256: "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51" },
  { name: "tokens.txt", expectedBytes: 315_894, sha256: "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc" },
] as const;

export const VOICE_ASR_MODEL_ID = "sensevoice-int8-zh-en-ja-ko-yue" as const;

/** 用户可见的模型名。界面直接用这一份，不在渲染层再写一遍。 */
export const VOICE_ASR_MODEL_LABEL = "SenseVoice 离线识别" as const;

/**
 * 模型从哪儿下：**按顺序试，第一个成了就用它。**
 *
 * ## 为什么是列表而不是单个地址
 *
 * 因为"某个源现在连不上"这件事不是配置错误，是**常态**：模型库在改域名、镜像在限流、
 * 公司网络在拦境外地址、用户在飞机上。单一地址把这一切变成"语音功能坏了"；
 * 按序回退把它变成"慢了一点"。失败判定包括连不上、非 200、以及**下回来的字节数不对**
 * ——最后这一条最要紧：代理截断会给一个 200 的错误页，只判状态码的话用户会拿到一个
 * 装不上的模型，而界面正说着「已装在这台设备上」。
 *
 * ## 顺序为什么国内优先
 *
 * 默认把国内镜像放第一位、官方库放最后一位。反过来（官方优先）在国内几乎每次都要
 * 等一次超时才轮得到镜像，而那一次超时要几十秒，用户看到的是"点了没反应"。
 * 国内镜像命中时是一次直连；不命中才回源，反过来则是每次都先撞一次墙。
 *
 * `AILEARN_VOICE_ASR_SOURCE`（逗号分隔）可以整份换掉这份列表——自建镜像、离线机器、
 * 内网制品库走这一条。
 */
export interface VoiceAsrModelSourceV1 {
  readonly id: string
  /** 印在设置页上的名字。 */
  readonly name: string
  readonly baseUrl: string
}

export const VOICE_ASR_MODEL_SOURCES: readonly VoiceAsrModelSourceV1[] = [
  {
    id: "modelscope",
    name: "魔搭社区",
    // 这份 sherpa-onnx 导出与官方 2024-07-17 文件的大小、SHA-256 一致。
    // 魔搭原始 SenseVoiceSmall / FunASR 导出不能直接交给当前 WASM 引擎。
    baseUrl: "https://modelscope.cn/models/pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue/resolve/master",
  },
  {
    id: "hf-mirror",
    name: "hf-mirror 国内镜像",
    // 与官方库同一个仓库的镜像：**文件是同一份**，字节数校验对两者是同一把尺子。
    baseUrl: "https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main",
  },
  {
    id: "huggingface",
    name: "Hugging Face 官方库",
    baseUrl: "https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main",
  },
];

/** 完整装好时占用的字节数（两个文件加起来）。设置页用它给一句磁盘占用。 */
export const VOICE_ASR_MODEL_EXPECTED_BYTES = VOICE_ASR_MODEL_FILES.reduce(
  (total, file) => total + file.expectedBytes,
  0,
);

export const voiceAsrModelFileNameSchema = z.enum(
  VOICE_ASR_MODEL_FILES.map((file) => file.name) as [string, ...string[]],
).refine(
  (name): name is (typeof VOICE_ASR_MODEL_FILES)[number]["name"] =>
    VOICE_ASR_MODEL_FILES.some((file) => file.name === name),
  "不在语音识别模型的清单里",
);
export type VoiceAsrModelFileName = z.infer<typeof voiceAsrModelFileNameSchema>;

/**
 * 失败分类。主进程只传失败类别，界面将它翻译成操作提示；
 * 这份合同不承载内部路径、errno 或上游的原始错误响应。
 */
export const voiceAsrModelFailureSchema = z.enum([
  /** 连不上、或中途断了（用户取消不算这一类，另有 `cancelled`）。 */
  "network",
  /** 文件大小或 SHA-256 不匹配：不允许作为已安装模型使用。 */
  "size_mismatch",
  /** 写不进磁盘：权限不足 / 空间不够。 */
  "storage",
  /** 用户中途取消。这一类**不是错误**：界面回到「还没下载」即可。 */
  "cancelled",
  /** 没归进上面几类的意外失败。 */
  "unknown",
]);
export type VoiceAsrModelFailure = z.infer<typeof voiceAsrModelFailureSchema>;

export const voiceAsrModelStatusSchema = z.enum([
  /** 本机没有模型（或只下了半个）。 */
  "absent",
  /** 正在下载。 */
  "downloading",
  /** 两个文件都齐了，可以识别。 */
  "ready",
  /** 下载失败，`failure` 说明是哪一类。 */
  "error",
]);
export type VoiceAsrModelStatus = z.infer<typeof voiceAsrModelStatusSchema>;

export const voiceAsrModelFileStateV1Schema = z.strictObject({
  name: voiceAsrModelFileNameSchema,
  /** 此刻磁盘上实际占着的字节（只下完的正式文件，不含 `.part`）。 */
  bytes: z.number().int().nonnegative(),
  expectedBytes: z.number().int().positive(),
  complete: z.boolean(),
});
export type VoiceAsrModelFileStateV1 = z.infer<typeof voiceAsrModelFileStateV1Schema>;

export const voiceAsrModelSnapshotV1Schema = z.strictObject({
  version: z.literal(1),
  modelId: z.literal(VOICE_ASR_MODEL_ID),
  /**
   * 模型文件在**渲染进程 URL 空间**里的挂载点，以 `/` 结尾。
   *
   * 为什么由主进程给而不是渲染层自己拼：打包后页面在 `ailearn-app://bundle/`，
   * 开发时页面在 `http://localhost:5173/`，两种形态的绝对 URL 不一样，而 worker
   * 又拿不到任何页面对象。主进程手里正好有这一发请求的来源 URL，拼出来的那一份
   * 必定与页面同源。
   */
  mountUrl: z.string().min(1),
  status: voiceAsrModelStatusSchema,
  /** 装好之后完整占用的字节。设置页的「大约多少」用它。 */
  expectedBytes: z.number().int().positive(),
  /** 这一轮下载已经收到的字节（含 `.part`）。进度条按它画。 */
  receivedBytes: z.number().int().nonnegative(),
  /** 正式文件此刻占的字节（不含 `.part`）。 */
  installedBytes: z.number().int().nonnegative(),
  files: z.array(voiceAsrModelFileStateV1Schema).length(VOICE_ASR_MODEL_FILES.length),
  failure: voiceAsrModelFailureSchema.nullable(),
  /** 装好的时刻（ISO）。设置页用它讲「几月几号下的」。 */
  installedAt: z.string().nullable(),
  /**
   * 按顺序试的来源名字。设置页把它讲成「优先 A，连不上会自动换 B」——
   * 只印第一个的话，用户在镜像挂掉时会以为下载坏了，而不是在等它自己换源。
   */
  sources: z.array(z.string().min(1)).min(1),
  /** 正在连接或传输的源；界面可如实显示自动换源。 */
  activeSource: z.string().min(1).nullable().default(null),
});
export type VoiceAsrModelSnapshotV1 = z.infer<typeof voiceAsrModelSnapshotV1Schema>;

/**
 * 模型文件在**渲染进程 URL 空间**里的挂载点。
 *
 * 它必须与页面**同源**：worker 用 `new URL(relative, self.location.href)` 取它，
 * 于是打包后落在 `ailearn-app://bundle/device/asr/…`、开发时落在
 * `http://localhost:5173/device/asr/…`。两种形态都命中 CSP 的 `'self'`，
 * 不需要放开任何一条 connect-src，也就不存在「为了下模型给页面开外连」这种事。
 *
 * 路径是**保留前缀**：主进程只认清单里那两个文件名，前缀之后给什么都回 404。
 */
export const VOICE_ASR_MODEL_ROUTE_PREFIX = "device/asr/";
