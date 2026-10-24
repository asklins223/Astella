import { DomainError } from "@astella/shared";
import type { ClientAssetPlatform, ClientAssetsRegistration } from "./schema.ts";

const PLATFORM_PATH_PREFIXES: Record<ClientAssetPlatform, readonly string[]> = {
  ios: ["notes-web/", "launch-motion/"],
  android: ["launch-motion/"],
};

const MAX_FILES = 500;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;

export class ManifestValidationError extends DomainError {
  constructor(message: string) {
    super({ name: "ManifestValidationError", code: "invalid_asset_manifest", message, statusCode: 400 });
  }
}

/** 单段路径安全：不允许绝对路径、`..`、反斜杠、空段。 */
function safeRelativePath(path: string): boolean {
  if (!path || path.includes("\\") || path.startsWith("/")) return false;
  const parts = path.split("/");
  return parts.length > 1 && parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

/** 公开版本身份/资产地址的公共校验；未配置 RELEASE_ASSET_HOSTS 时只检查 https。 */
export function assertAllowedUrl(url: string, label: string): void {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new ManifestValidationError(`${label} 不是合法 URL：${url}`); }
  if (parsed.protocol !== "https:") throw new ManifestValidationError(`${label} 必须是 https：${url}`);
  if (!hostAllowed(url)) throw new ManifestValidationError(`${label} 不在允许域名：${url}`);
}

function hostAllowed(url: string): boolean {
  const raw = process.env.RELEASE_ASSET_HOSTS?.trim();
  if (!raw) return true; // 未配置时不额外拒绝（注册接口仍受 token 保护）
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== "https:") return false;
  const allowed = raw.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  return allowed.includes(parsed.host.toLowerCase());
}

function assertPathPlatform(platform: ClientAssetPlatform, path: string): void {
  if (!safeRelativePath(path)) throw new ManifestValidationError(`资产路径不安全：${path}`);
  if (!PLATFORM_PATH_PREFIXES[platform].some((prefix) => path.startsWith(prefix))) {
    throw new ManifestValidationError(`资产路径不属于 ${platform} 的更新范围：${path}`);
  }
}

/**
 * 校验一次热更新资产注册：清单与文件列表必须一致，路径、hash、大小、URL 均有上界。
 * 这份规则与 iOS ClientAssetUpdater 的本地校验同源；服务端先拒绝，避免下发客户端也
 * 不敢用的清单。
 */
export function validateClientAssets(input: ClientAssetsRegistration): void {
  const { platform, manifest, files } = input;
  if (manifest.version !== input.version) throw new ManifestValidationError("manifest.version 与 version 不一致");
  if (manifest.files.length !== files.length) throw new ManifestValidationError("manifest.files 与 files 数量不一致");
  if (manifest.files.length > MAX_FILES) throw new ManifestValidationError("资产文件数量超过上限");

  const seen = new Set<string>();
  const byPath = new Map(files.map((file) => [file.path, file]));
  let total = 0;
  for (const file of manifest.files) {
    assertPathPlatform(platform, file.path);
    if (seen.has(file.path)) throw new ManifestValidationError(`资产路径重复：${file.path}`);
    seen.add(file.path);
    const listed = byPath.get(file.path);
    if (!listed) throw new ManifestValidationError(`文件列表缺少：${file.path}`);
    if (listed.sha256 !== file.sha256 || listed.byteLength !== file.byteLength) {
      throw new ManifestValidationError(`文件列表与清单不一致：${file.path}`);
    }
    if (!hostAllowed(file.url)) throw new ManifestValidationError(`资产 URL 不在允许域名：${file.url}`);
    total += file.byteLength;
  }
  if (total > MAX_TOTAL_BYTES) throw new ManifestValidationError("资产总体积超过上限");
}

export function assetManifestResponse(manifest: unknown): Record<string, unknown> | null {
  if (!manifest || typeof manifest !== "object") return null;
  const value = manifest as Record<string, unknown>;
  return {
    version: value.version,
    baseVersion: value.baseVersion ?? null,
    createdAt: value.createdAt ?? null,
    files: value.files,
  };
}
