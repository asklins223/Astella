import { z } from "zod";
import { OBJECT_TRANSFER_MAX_BYTES, objectTransferDownloadSchema } from "./object-transfer-contracts.ts";

/**
 * 伴星 Live2D 模型的**运行时分发**合同（2026-11-18 桌面端接入）。
 *
 * ## 为什么模型不在安装包里
 *
 * fatfish 一份 60 MB（44 MB 单张贴图 + 16 MB moc3），whale 4.2 MB；两份都是
 * `redistributionAllowed:false` 的授权资产。和本机语音识别模型同一条口径：
 * 不随安装包分发，首次使用前从对象存储经**已登录会话**取回，校验完整后本地缓存。
 *
 * ## 服务端
 *
 * `GET /companion/model/manifest?modelId=…`（鉴权）返回本文件的 manifest 形状：
 * 每个文件带字节数、SHA-256 和下载描述（远程存储是 300s 签名 URL；本地 MinIO
 * 是同一 API origin 下的 session 授权路径）。客户端不得自己拼对象键。
 *
 * ## 同源
 *
 * 下载落盘后由主进程在**页面同源**的 `device/models/<modelId>/…` 路由下提供，
 * 渲染层照旧用 `resolveBundledAsset` 那套同源判据读取——跨源读本机文件不成立。
 */

export const COMPANION_MODEL_ROUTE_PREFIX = "device/models/" as const;

/** 桌面端认识的伴星形态（与服务端 catalog 的 modelId 一一对应）。 */
export const COMPANION_MODEL_IDS = [
  "companion-live2d-whale-v3",
  "companion-live2d-fatfish-v4",
] as const;
export type CompanionModelRegistryId = (typeof COMPANION_MODEL_IDS)[number];

/** modelId 会拼进路由与对象键：只收安全字符集。 */
export const companionModelIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export type CompanionModelId = z.infer<typeof companionModelIdSchema>;

const companionModelFilePathSchema = z.string().min(1).max(512).refine(
  (value) => !value.startsWith("/") && !value.includes("\\")
    && value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
  "model file path must be relative and traversal-free",
);

/**
 * 本地存储模式（MinIO / STORAGE_MODE=local）的下载描述：URL 是 API origin 下的
 * 相对路径，必须带会话才能读。远程模式则是 `object_download` 签名描述。
 */
export const companionModelSessionDownloadSchema = z.strictObject({
  url: z.string().min(1).max(2048),
  authorization: z.literal("session"),
});

export const companionModelManifestFileSchema = z.strictObject({
  path: companionModelFilePathSchema,
  contentType: z.string().min(1).max(128),
  byteLength: z.number().int().positive().max(OBJECT_TRANSFER_MAX_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  download: z.union([objectTransferDownloadSchema, companionModelSessionDownloadSchema]),
});
export type CompanionModelManifestFileV1 = z.infer<typeof companionModelManifestFileSchema>;

export const companionModelManifestV1Schema = z.strictObject({
  version: z.literal(1),
  modelId: companionModelIdSchema,
  modelVersion: z.string().min(1).max(128),
  entry: companionModelFilePathSchema,
  files: z.array(companionModelManifestFileSchema).min(1).max(256),
});
export type CompanionModelManifestV1 = z.infer<typeof companionModelManifestV1Schema>;

/**
 * 一台机器上某个模型的本地状态。`ready` 只有在**整份清单**逐文件校验通过、
 * 且安装标记与当前清单一致时才成立——半个模型不算装好，入口必须继续挡住。
 */
export const companionModelSnapshotV1Schema = z.strictObject({
  version: z.literal(1),
  modelId: companionModelIdSchema,
  mountUrl: z.string().min(1),
  status: z.enum(["absent", "downloading", "verifying", "ready", "failed"]),
  receivedBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  installedVersion: z.string().max(128).nullable(),
  failure: z.enum(["network", "storage", "integrity", "disk", "cancelled"]).nullable(),
});
export type CompanionModelSnapshotV1 = z.infer<typeof companionModelSnapshotV1Schema>;

/** 安装标记：与模型目录同级的 `installed.json`，是「整份装好」的唯一凭据。 */
export const companionModelInstalledMarkerV1Schema = z.strictObject({
  version: z.literal(1),
  modelId: companionModelIdSchema,
  modelVersion: z.string().min(1).max(128),
  installedAt: z.string().datetime(),
  files: z.array(z.strictObject({
    path: companionModelFilePathSchema,
    contentType: z.string().min(1).max(128),
    byteLength: z.number().int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })).min(1).max(256),
});
export type CompanionModelInstalledMarkerV1 = z.infer<typeof companionModelInstalledMarkerV1Schema>;