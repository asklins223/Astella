/**
 * Worker 端 MinIO/S3 对象存储封装。
 *
 * 用于 URL 来源解析时下载页面内嵌图片并上传到 MinIO，
 * 使图片可通过 /api/uploads/{objectKey} 访问。
 */
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { logger } from "./logger.ts";
import {
  resolveStorageBucket,
  resolveStorageConfig,
  resolveStorageRequestTimeoutMs,
  type StorageEnv,
} from "@astella/shared/storage-config";

/**
 * 配置判定委托给 `@astella/shared/storage-config`（2026-09-29，P2-16）。
 *
 * 此前这一份与 `apps/api` 那份**各写一次**凭证回退链：独立凭证优先、回退 root，
 * 且用 `||` 让空串按未配置处理。改一处不改另一处就会出现
 * "报告已配置、构造客户端却拿到空串凭证"——那只在生产里显形。
 *
 * S3 客户端仍由本文件构造：`@aws-sdk/client-s3` 不是 shared 的依赖，
 * 为了一个配置读取把它拖进 shared，会让所有引用方都背上这份依赖。
 */
const env = (): StorageEnv => process.env;

function storageCredentials(): { accessKeyId: string; secretAccessKey: string } {
  const resolved = resolveStorageConfig(env());
  if (!resolved) {
    throw new Error(
      "STORAGE not configured: MINIO_ACCESS_KEY/MINIO_SECRET_KEY "
      + "(or MINIO_ROOT_USER/MINIO_ROOT_PASSWORD) missing",
    );
  }
  return { accessKeyId: resolved.accessKeyId, secretAccessKey: resolved.secretAccessKey };
}

/** 存储是否已配置（与 api 侧同一条规则，见 ）。 */
export function isStorageConfigured(): boolean {
  return resolveStorageConfig(env()) !== null;
}

function getBucket(): string {
  return resolveStorageBucket(env());
}

// 2026-08-12（存储面审计，与 API 侧对齐）：
// - 独立凭证优先（MINIO_ACCESS_KEY/SECRET_KEY，最小权限），回退 root；
// - 请求超时（S3Client 默认无 requestTimeout，MinIO 半挂时请求无限挂起）；
// - 初始化失败缓存（此前 env 缺失时每次调用重复构造报错）。
let client: S3Client | null = null;
let clientInitError: Error | null = null;

function getClient(): S3Client {
  if (client) return client;
  if (clientInitError) throw clientInitError;
  try {
    const config = resolveStorageConfig(env());
    if (!config) storageCredentials(); // 复用上面那条失败表达
    const { endpoint, region, accessKeyId, secretAccessKey } = config!;
    void storageCredentials;
    client = new S3Client({
      endpoint,
      region,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 10_000,
        requestTimeout: resolveStorageRequestTimeoutMs(env()),
      }),
    });
  } catch (err) {
    clientInitError = err instanceof Error ? err : new Error(String(err));
    throw clientInitError;
  }
  return client;
}


const EXT_FROM_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/**
 * Upload a source image to object storage.
 * Object key: {workspaceId}/sources/{sourceId}/{uuid}.{ext}
 * Returns the object key (consumable via /api/uploads/{objectKey}).
 */
export async function uploadSourceImage(
  workspaceId: string,
  sourceId: string,
  body: Buffer,
  contentType: string,
): Promise<string> {
  const ext = EXT_FROM_MIME[contentType] ?? "bin";
  const uuid = crypto.randomUUID();
  const objectKey = `${workspaceId}/sources/${sourceId}/${uuid}.${ext}`;

  const command = new PutObjectCommand({
    Bucket: getBucket(),
    Key: objectKey,
    Body: body,
    ContentType: contentType,
  });
  await getClient().send(command);
  logger.debug({ objectKey, size: body.length }, "source image uploaded to storage");
  return objectKey;
}

/**
 * 读回一个对象（伴星读图工具用）。
 *
 * `maxBytes` 是**必须的**，不是可选的谨慎：视觉 provider 按 base64 计费/限时，
 * 一张手机原图 8MB 会让这一步稳定超时，用户只看到"她没反应"。
 * objectKey 来自我们自己库里的行，不接用户输入；仍然挡一手路径穿越。
 */
export async function getObjectBytes(objectKey: string, maxBytes = 4_000_000): Promise<Buffer> {
  if (!objectKey || objectKey.includes("..")) {
    throw new Error("invalid object key");
  }
  const response = await getClient().send(new GetObjectCommand({
    Bucket: getBucket(),
    Key: objectKey,
  }));
  const stream = response.Body as AsyncIterable<Uint8Array> | undefined;
  if (!stream) throw new Error(`object ${objectKey} returned no body`);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > maxBytes) throw new Error(`object ${objectKey} exceeds ${maxBytes} bytes`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
