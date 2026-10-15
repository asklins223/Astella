/**
 * 伴星 Live2D 模型分发（2026-10-15，移动端全量重构扩展 E）。
 *
 * - GET /companion/model/manifest — 鉴权：返回模型清单 + 每个文件的对象存储
 *   临时签名下载 URL（signObjectDownload，300s TTL）。模型资产不随任何客户端
 *   安装包分发（许可 redistributionAllowed:false），移动端运行时下载后本地缓存，
 *   离线用缓存；静态 PNG 仅作加载失败时的降级形态。
 *
 * 清单本体是对象存储里 `<prefix>manifest.json`（prefix 由
 * COMPANION_MODEL_OBJECT_PREFIX 配置，默认 companion/live2d/），由
 * `tsx scripts/ingest-companion-model.ts` 从桌面端同一套模型目录上传生成。
 * 本文件只做读取与签名，不做任何模型内容加工。
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { requireSession } from "../identity/middleware.ts";
import { isStorageConfigured, getObject, signObjectDownload } from "../../lib/object-storage.ts";

const companionModelManifestFileSchema = z.object({
  path: z.string().min(1).max(512),
  contentType: z.string().min(1).max(128),
  byteLength: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

const companionModelManifestSchema = z.object({
  schemaVersion: z.literal(1),
  modelId: z.string().min(1).max(128),
  version: z.string().min(1).max(128),
  entry: z.string().min(1).max(512),
  files: z.array(companionModelManifestFileSchema).min(1).max(256),
});

export type CompanionModelManifest = z.infer<typeof companionModelManifestSchema>;

export function companionModelObjectPrefix(): string {
  const raw = process.env.COMPANION_MODEL_OBJECT_PREFIX ?? "companion/live2d/";
  return raw.endsWith("/") ? raw : `${raw}/`;
}

export async function companionModelRoutes(app: FastifyInstance) {
  app.get("/companion/model/manifest", { preHandler: [requireSession] }, async (req, reply) => {
    if (!isStorageConfigured()) {
      return reply.code(503).send({ error: "object_storage_not_configured", message: "对象存储未配置，模型暂时无法下载" });
    }
    let manifest: CompanionModelManifest;
    try {
      const stored = await getObject(`${companionModelObjectPrefix()}manifest.json`);
      const parsed = companionModelManifestSchema.safeParse(JSON.parse(stored.body.toString("utf8")));
      if (!parsed.success) {
        req.log.error({ issues: parsed.error.issues }, "companion model manifest invalid");
        return reply.code(502).send({ error: "model_manifest_invalid", message: "模型清单损坏，请联系维护者重新发布" });
      }
      manifest = parsed.data;
    } catch (error) {
      req.log.error({ error }, "companion model manifest missing");
      return reply.code(502).send({ error: "model_manifest_missing", message: "模型清单不可用，请稍后重试" });
    }

    const files = await Promise.all(manifest.files.map(async (file) => {
      const download = await signObjectDownload(
        `${companionModelObjectPrefix()}${file.path}`, file.contentType, file.byteLength, file.sha256,
      );
      return { path: file.path, contentType: file.contentType, byteLength: file.byteLength, sha256: file.sha256, download };
    }));

    return reply.send({ version: 1, modelId: manifest.modelId, modelVersion: manifest.version, entry: manifest.entry, files });
  });
}
