/**
 * 伴星 Live2D 模型分发（2026-10-15，移动端全量重构扩展 E）。
 *
 * - GET /companion/model/manifest — 鉴权：返回模型清单 + 每个文件的对象存储
 *   临时签名下载 URL（signObjectDownload，300s TTL）。模型资产不随任何客户端
 *   安装包分发（许可 redistributionAllowed:false），移动端运行时下载后本地缓存，
 *   离线用缓存；静态 PNG 仅作加载失败时的降级形态。
 *
 * 清单本体是对象存储里 `<prefix><modelId>/manifest.json`（prefix 由
 * COMPANION_MODEL_OBJECT_PREFIX 配置，默认 companion/live2d/），由
 * `tsx scripts/ingest-companion-model.ts --model-id <id>` 从桌面端同一套模型目录
 * 上传生成。本文件只做读取与签名，不做任何模型内容加工。
 *
 * 2026-11-05 多形态：清单按 modelId 寻址（`?modelId=`）。缺省仍是旧的单模型位置
 * `<prefix>manifest.json`——老客户端不带这个参数，读到的还是它一直在用的清单。
 *
 * GET /companion/model/catalog 是形象名单的唯一来源：只返回对象存储里确实
 * 有清单的模型，并带上发布时写的名字和介绍。客户端不得再把自己认得的模型全部列出来。
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { requireSession } from "../identity/middleware.ts";
import { isStorageConfigured, getObject, headObject, signObjectDownload, usesRemoteStorage } from "../../lib/object-storage.ts";
import { companionModelCatalogV1Schema } from "@astella/shared/companion-shell-contracts";
import {
  companionModelCatalogDocumentSchema,
  listingForStoredManifest,
  selectPublishedCompanionModels,
  type CompanionModelCatalogEntryV1,
} from "./companion-model-catalog.ts";

const modelPath = z.string().min(1).max(512).refine(value => !value.startsWith("/") && !value.includes("\\") && value.split("/").every(part => part !== ".." && part !== "." && part.length > 0));
const companionModelManifestFileSchema = z.object({
  path: modelPath,
  contentType: z.string().min(1).max(128),
  byteLength: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

const companionModelManifestSchema = z.object({
  schemaVersion: z.literal(1),
  modelId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  version: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  entry: modelPath,
  /**
   * 文件对象键的前缀（相对配置的 `<prefix>`，且必须在它里面）。
   *
   * 旧清单没有这个字段：那时文件平铺在 `<prefix>` 下，所以缺省值就是空串。
   * 2026-11-05 起新入库的清单写 `<modelId>/`，每个形态一层，跨形态的文件名不打架。
   */
  filesPrefix: z.string().max(160).regex(/^([A-Za-z0-9_.-]+\/)*$/).optional(),
  displayName: z.string().min(1).max(80).optional(),
  detail: z.string().max(400).optional(),
  files: z.array(companionModelManifestFileSchema).min(1).max(256),
});

export type CompanionModelManifest = z.infer<typeof companionModelManifestSchema>;

export function companionModelObjectPrefix(): string {
  const raw = process.env.COMPANION_MODEL_OBJECT_PREFIX ?? "companion/live2d/";
  return raw.endsWith("/") ? raw : `${raw}/`;
}

/** modelId 允许的字符集：它会被拼进对象键，必须挡住路径分隔与穿越。 */
const companionModelIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

/**
 * 某个形态的清单对象键（向后兼容的关键）。
 *
 * - 缺省 modelId：`<prefix>manifest.json`，2026-11-05 之前唯一的那个位置；
 * - 指定 modelId：`<prefix><modelId>/manifest.json`。
 */
export function companionModelManifestKey(modelId?: string): string {
  const prefix = companionModelObjectPrefix();
  return modelId ? `${prefix}${modelId}/manifest.json` : `${prefix}manifest.json`;
}

export function companionModelCatalogKey(): string {
  return `${companionModelObjectPrefix()}catalog.json`;
}

async function readStoredListing(modelId?: string): Promise<CompanionModelCatalogEntryV1 | null> {
  try {
    const stored = await getObject(companionModelManifestKey(modelId));
    const parsed = companionModelManifestSchema.safeParse(JSON.parse(stored.body.toString("utf8")));
    return parsed.success ? listingForStoredManifest(parsed.data) : null;
  } catch {
    return null;
  }
}

/** 只含已经能下载的形象。目录缺失时退回旧的单模型清单。 */
export async function listPublishedCompanionModels(): Promise<CompanionModelCatalogEntryV1[]> {
  let catalog: CompanionModelCatalogEntryV1[] = [];
  try {
    const stored = await getObject(companionModelCatalogKey());
    const parsed = companionModelCatalogDocumentSchema.safeParse(JSON.parse(stored.body.toString("utf8")));
    if (parsed.success) catalog = parsed.data.models;
  } catch {
    catalog = [];
  }
  const legacy = await readStoredListing();
  const available = new Set<string>();
  await Promise.all([...catalog, ...(legacy ? [legacy] : [])].map(async (model) => {
    if (legacy?.modelId === model.modelId) {
      available.add(model.modelId);
      return;
    }
    const head = await headObject(companionModelManifestKey(model.modelId));
    if (head) available.add(model.modelId);
  }));
  return selectPublishedCompanionModels(catalog, legacy, available);
}

/** 清单里的文件对象键：`<prefix><filesPrefix><path>`（旧清单的 filesPrefix 为空）。 */
function companionModelFileKey(manifest: CompanionModelManifest, filePath: string): string {
  return `${companionModelObjectPrefix()}${manifest.filesPrefix ?? ""}${filePath}`;
}

/** 解析 `?modelId=`：缺省 = 旧单模型；非法值交给调用方回 400。 */
function requestedCompanionModelId(query: unknown): { ok: true; modelId?: string } | { ok: false } {
  const raw = (query as { modelId?: unknown } | null | undefined)?.modelId;
  if (raw === undefined || raw === null || raw === "") return { ok: true, modelId: undefined };
  const parsed = companionModelIdSchema.safeParse(raw);
  return parsed.success ? { ok: true, modelId: parsed.data } : { ok: false };
}

export async function companionModelRoutes(app: FastifyInstance) {
  app.get("/companion/model/catalog", { preHandler: [requireSession] }, async (req, reply) => {
    if (!isStorageConfigured()) {
      return reply.code(503).send({ error: "object_storage_not_configured", message: "对象存储未配置，模型暂时无法下载" });
    }
    try {
      const models = await listPublishedCompanionModels();
      return reply.send(companionModelCatalogV1Schema.parse({ version: 1, models }));
    } catch (error) {
      req.log.error({ error }, "companion model catalog unavailable");
      return reply.code(503).send({ error: "model_catalog_unavailable", message: "形象目录暂时不可用" });
    }
  });
  app.get<{ Params: { "*": string } }>("/companion/model/files/*", { preHandler: [requireSession] }, async (req, reply) => {
    const path = req.params["*"];
    if (!modelPath.safeParse(path).success) return reply.code(400).send({ error: "invalid_model_path" });
    const requested = requestedCompanionModelId(req.query);
    if (!requested.ok) return reply.code(400).send({ error: "invalid_model_id" });
    try {
      const stored = await getObject(companionModelManifestKey(requested.modelId));
      const manifest = companionModelManifestSchema.parse(JSON.parse(stored.body.toString("utf8")));
      const file = manifest.files.find(item => item.path === path);
      if (!file) return reply.code(404).send({ error: "model_file_not_found" });
      const object = await getObject(companionModelFileKey(manifest, path));
      return reply.type(file.contentType).header("Cache-Control", "private, max-age=3600").send(object.body);
    } catch { return reply.code(503).send({ error: "model_file_unavailable", message: "模型文件暂时不可用" }); }
  });
  app.get("/companion/model/manifest", { preHandler: [requireSession] }, async (req, reply) => {
    if (!isStorageConfigured()) {
      return reply.code(503).send({ error: "object_storage_not_configured", message: "对象存储未配置，模型暂时无法下载" });
    }
    const requested = requestedCompanionModelId(req.query);
    if (!requested.ok) return reply.code(400).send({ error: "invalid_model_id" });
    let manifest: CompanionModelManifest;
    try {
      const stored = await getObject(companionModelManifestKey(requested.modelId));
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
      const download = usesRemoteStorage()
        ? await signObjectDownload(
          companionModelFileKey(manifest, file.path),
          file.contentType,
          file.byteLength,
          file.sha256,
        )
        : {
          url: `/companion/model/files/${file.path.split("/").map(encodeURIComponent).join("/")}`
            + `?modelId=${encodeURIComponent(manifest.modelId)}`,
          authorization: "session",
        };
      return { path: file.path, contentType: file.contentType, byteLength: file.byteLength, sha256: file.sha256, download };
    }));

    return reply.send({ version: 1, modelId: manifest.modelId, modelVersion: manifest.version, entry: manifest.entry, files });
  });
}
