/**
 * 对象存储的**配置判定**（2026-09-29，P2-16 跨包下沉）。
 *
 * ## 为什么下沉的是"判定"而不是整个 S3 封装
 *
 * `apps/api/src/lib/object-storage.ts`（232 行）与
 * `workers/ai-worker/src/lib/object-storage.ts`（125 行）各有一份 S3 封装。
 * 逐函数比对之后，真正重复的是**配置怎么读**：
 * endpoint / region / bucket / 凭证 / 是否已配置 / 超时。
 *
 * 而 S3 客户端本身**不该**下沉：`@aws-sdk/client-s3` 不是 `packages/shared` 的依赖
 * （shared 只有 `drizzle-orm` 与 `zod`），为了一个配置文件把 SDK 拖进 shared
 * 会让所有引用方（包括桌面端）都背上这份依赖。
 *
 * 所以这里给的是**纯函数**：读 env、返回判定结果，不构造任何客户端。
 * 两个进程各自拿它去建自己的 `S3Client`。
 *
 * ## 一条被抄写过、且**必须只有一处**的规则
 *
 * 凭证回退链：独立凭证（`MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY`，最小权限）
 * 优先，回退 root（`MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`）。
 *
 * 用的是 `||` 而不是 `??`——**空串按未配置处理**。这一点两侧曾经各写一次，
 * 且注释都写着"与 isStorageConfigured 的 truthy 语义一致"。也就是说，
 * 判定"是否已配置"和"实际取哪个凭证"是**同一条规则的两面**：
 * 前者用 `Boolean(a && b || c && d)`，后者用 `a?.trim() || c?.trim()`。
 * 一旦某个进程把 `||` 抄成 `??`，就会出现"报告已配置、构造客户端却拿到空串凭证"
 * 这种只在生产里显形的不一致。
 */

export type StorageEnv = Readonly<Record<string, string | undefined>>;

/** 解析出来的存储配置；`null` 表示按「未配置」处理。 */
export type ResolvedStorageConfig = {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly requestTimeoutMs: number;
};

/** Deployment explicitly selects remote storage; NODE_ENV alone also describes local containers. */
export function isRemoteStorage(env: StorageEnv): boolean {
  return env.STORAGE_MODE?.trim() === "remote";
}

const DEFAULT_ENDPOINT = "http://minio:9000";
const DEFAULT_REGION = "us-east-1";
const DEFAULT_BUCKET = "astella-workspaces";
/** 与两个进程此前写死的一致：MinIO 半挂时 S3Client 默认无超时会让请求无限挂起。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const CONNECTION_TIMEOUT_MS = 10_000;

function trimmed(env: StorageEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

/**
 * 独立凭证优先、回退 root 凭证。
 *
 * `||` 而非 `??`：**空串按未配置处理**，与 `isStorageConfigured` 同一条规则。
 */
export function resolveStorageCredentials(
  env: StorageEnv,
): { accessKeyId: string; secretAccessKey: string } | null {
  if (isRemoteStorage(env)) {
    const accessKeyId = trimmed(env, "STORAGE_ACCESS_KEY_ID");
    const secretAccessKey = trimmed(env, "STORAGE_SECRET_ACCESS_KEY");
    return accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : null;
  }
  // ⚠️ 两条凭证必须来自**同一套**，不能一半独立一半 root。
  //
  // 2026-09-29：下沉过程中被测试逮到——原来的 api 与 worker 两份实现里，
  // "取凭证"是逐个变量回退（accessKey 回退独立→root，secret 也一样），
  // 而"是否已配置"是成对判断（两套都要齐全）。于是
  // `MINIO_ACCESS_KEY=a` + `MINIO_ROOT_PASSWORD=p` 这种**半套**配置，
  // 前者判"已配置"、后者判"未配置"——同一份 env，两个答案。
  //
  // 后果是拿一对**哪套都不是**的凭证去连 S3，拿到一个不透明的 403，
  // 而本地开发两个变量都设了所以永远复现不出来。
  //
  // 现在两条规则统一成"同一套齐全才算"，并各自逐套尝试。
  const independentKey = trimmed(env, "MINIO_ACCESS_KEY");
  const independentSecret = trimmed(env, "MINIO_SECRET_KEY");
  if (independentKey && independentSecret) {
    return { accessKeyId: independentKey, secretAccessKey: independentSecret };
  }

  const rootKey = trimmed(env, "MINIO_ROOT_USER");
  const rootSecret = trimmed(env, "MINIO_ROOT_PASSWORD");
  if (rootKey && rootSecret) {
    return { accessKeyId: rootKey, secretAccessKey: rootSecret };
  }

  return null;
}

/**
 * 是否已配置与构造客户端使用同一份配置；远程模式还要求显式端点和桶名。
 */
export function isStorageConfigured(env: StorageEnv): boolean {
  // **不是**另写一份判断，而是直接问上面那个函数。
  // 两面各写一次正是这条规则分叉的根源——判据的对象是"是否已配置"这一条契约，
  // 不是"两个表达式恰好相等"。
  return resolveStorageConfig(env) !== null;
}

/** 对象存储的桶名；未设置时回退到两个进程共用的默认值。 */
export function resolveStorageBucket(env: StorageEnv): string {
  return trimmed(env, "S3_BUCKET") ?? DEFAULT_BUCKET;
}

/** 一次读全：凭证缺失时返回 `null`，让调用方按自己的方式表达"未配置"。 */
export function resolveStorageConfig(env: StorageEnv): ResolvedStorageConfig | null {
  const credentials = resolveStorageCredentials(env);
  if (!credentials) return null;
  if (isRemoteStorage(env) && (!trimmed(env, "STORAGE_ENDPOINT") || !trimmed(env, "S3_BUCKET"))) return null;
  return {
    endpoint: trimmed(env, "STORAGE_ENDPOINT") ?? DEFAULT_ENDPOINT,
    region: trimmed(env, "S3_REGION") ?? DEFAULT_REGION,
    bucket: resolveStorageBucket(env),
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    requestTimeoutMs: resolveStorageRequestTimeoutMs(env),
  };
}

export function resolveStorageRequestTimeoutMs(env: StorageEnv): number {
  const raw = trimmed(env, "STORAGE_REQUEST_TIMEOUT_MS");
  if (!raw) return DEFAULT_REQUEST_TIMEOUT_MS;
  const parsed = Number(raw);
  // 解析不出来就用默认——一个写坏的环境变量不该让整个存储面不可用，
  // 但也不该让它悄悄变成 0（0 等于"立即超时"）。
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_REQUEST_TIMEOUT_MS;
}

export const STORAGE_CONNECTION_TIMEOUT_MS = CONNECTION_TIMEOUT_MS;
