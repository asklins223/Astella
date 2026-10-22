/**
 * 伴星 Live2D 模型资产入库（2026-10-15，移动端全量重构扩展 E）。
 *
 * 把桌面端同一套模型目录上传到对象存储，最后写入 `manifest.json`
 * （schemaVersion/modelId/version/entry/files[]，每个文件带 sha256 与字节数）。
 * 服务端 GET /companion/model/manifest 只读取该清单并为每个文件签临时下载 URL。
 *
 * 用法（在 apps/api 下，环境变量与 API 相同的 MinIO/S3 配置）：
 *   npx tsx scripts/ingest-companion-model.ts \
 *     --dir ../desktop-client/src/renderer/public/assets/companion/live2d-v3/whale \
 *     --model-id companion-live2d-whale-v3 [--version v3-20261015]
 *
 * 清单最后写入：上传中途失败不会留下半份可被服务端读到的清单。
 */
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { S3Client, CreateBucketCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { resolveStorageConfig } from "@astella/shared/storage-config";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".json") return "application/json";
  if (ext === ".txt") return "text/plain; charset=utf-8";
  return "application/octet-stream"; // .moc3 等二进制
}

async function walk(dir: string, base = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full, base));
    else files.push(path.relative(base, full));
  }
  return files;
}

async function main() {
  const dir = arg("dir");
  const modelId = arg("model-id");
  const explicitVersion = arg("version");
  if (!dir || !modelId) {
    console.error("usage: tsx scripts/ingest-companion-model.ts --dir <modelDir> --model-id <id> [--version <v>]");
    process.exit(2);
  }

  const config = resolveStorageConfig(process.env);
  if (!config) {
    console.error("object storage is not configured (MINIO/S3 env missing)");
    process.exit(2);
  }

  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    requestHandler: new NodeHttpHandler({ requestTimeout: config.requestTimeoutMs }),
  });
  const prefix = (process.env.COMPANION_MODEL_OBJECT_PREFIX ?? "companion/live2d/").replace(/\/*$/, "/");

  // 桶可能还没建（minio-init 的 mc 镜像不可用时也一样）。头一回部署模型时
  // 由这里补建，避免"清单发布成功但根本没有桶"被误读成别的问题。
  try {
    await client.send(new CreateBucketCommand({ Bucket: config.bucket }));
    console.log(`created bucket ${config.bucket}`);
  } catch (error) {
    const name = (error as { name?: string }).name ?? "";
    if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") throw error;
  }

  const allFiles = (await walk(dir)).sort();
  const entryFile = allFiles.find((f) => f.endsWith(".model3.json"));
  if (!entryFile) throw new Error(`no .model3.json under ${dir}`);
  const relativeFiles = allFiles.filter((f) => {
    const name = path.basename(f);
    return name !== "manifest.json" && name !== "README.md" && name !== ".DS_Store" && !name.startsWith(".");
  });

  const files: Array<{ path: string; contentType: string; byteLength: number; sha256: string }> = [];
  const versionHash = createHash("sha256");
  for (const rel of relativeFiles) {
    const posixRel = rel.split(path.sep).join("/");
    const bytes = await readFile(path.join(dir, rel));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const contentType = contentTypeFor(rel);
    const key = `${prefix}${posixRel}`;
    await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: bytes, ContentType: contentType }));
    files.push({ path: posixRel, contentType, byteLength: bytes.length, sha256 });
    versionHash.update(posixRel).update(sha256);
    console.log(`uploaded ${key} (${bytes.length} bytes)`);
  }

  const version = explicitVersion ?? versionHash.digest("hex").slice(0, 12);
  const manifest = {
    schemaVersion: 1,
    modelId,
    version,
    entry: entryFile.split(path.sep).join("/"),
    files,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await client.send(new PutObjectCommand({
    Bucket: config.bucket, Key: `${prefix}manifest.json`, Body: manifestBytes, ContentType: "application/json",
  }));
  console.log(`manifest written: ${prefix}manifest.json (modelId=${modelId} version=${version} files=${files.length})`);
  client.destroy();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
