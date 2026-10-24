import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { parseBody } from "../../lib/validate.ts";
import { assetManifestResponse, assertAllowedUrl, validateClientAssets } from "./manifest.ts";
import {
  activateReleaseSchema,
  appReleaseRegistrationSchema,
  assetManifestQuerySchema,
  clientAssetsRegistrationSchema,
  serverReleaseRegistrationSchema,
  versionQuerySchema,
} from "./schema.ts";
import {
  activateAssets,
  activateRelease,
  readAssetHistory,
  readAssetVersion,
  readCurrentAssets,
  readCurrentRelease,
  readCurrentServerRelease,
  readReleaseHistory,
  readServerReleaseHistory,
  registerAppRelease,
  registerClientAssets,
  registerServerRelease,
  ReleaseCenterError,
  type AppReleaseRecord,
} from "./service.ts";

function fail(reply: FastifyReply, statusCode: number, error: string, message: string) {
  return reply.code(statusCode).send({ error, message });
}

/** 把服务层的 ReleaseCenterError 变成 HTTP 错误；其它异常交给全局处理器。 */
function sendServiceError(reply: FastifyReply, error: unknown): boolean {
  if (error instanceof ReleaseCenterError) {
    fail(reply, error.statusCode, error.code, error.message);
    return true;
  }
  return false;
}

/** 内部注册接口只认服务令牌；未配置时整组路由关闭（fail closed）。 */
async function requireReleaseToken(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const expected = process.env.RELEASE_CENTER_TOKEN?.trim();
  if (!expected) {
    fail(reply, 503, "release_center_disabled", "Release Center 注册接口未配置令牌");
    return;
  }
  const header = request.headers.authorization;
  const provided = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    fail(reply, 401, "unauthorized", "注册令牌不正确");
  }
}

function versionPayload(release: AppReleaseRecord) {
  const full = release.packages.find((item) => item.kind === "full") ?? release.packages[0];
  return {
    platform: release.platform,
    channel: release.channel,
    version: release.version,
    build: release.build,
    tag: release.tag,
    releasedAt: release.releasedAt,
    signed: release.signed,
    notes: release.notes,
    downloadUrl: full?.url ?? null,
    mirrors: release.packages
      .filter((item) => item.mirrorUrl)
      .map((item) => ({ kind: item.kind, name: item.name, url: item.mirrorUrl })),
    packages: release.packages,
    sha256: full?.sha256 ?? null,
    byteLength: full?.byteLength ?? null,
    clientAssetsVersion: release.clientAssetsVersion,
  };
}

export async function appReleaseRoutes(app: FastifyInstance): Promise<void> {
  // ─── 对外只读：客户端不访问 GitHub ──────────────────────────────────────
  app.get("/app/version", async (request, reply) => {
    const query = versionQuerySchema.safeParse(request.query ?? {});
    if (!query.success) return fail(reply, 400, "bad_request", "平台或通道参数不合法");
    let release: AppReleaseRecord | null;
    try {
      release = await readCurrentRelease(query.data.platform, query.data.channel);
    } catch (error) {
      if (sendServiceError(reply, error)) return reply;
      throw error;
    }
    if (!release) return fail(reply, 404, "release_not_found", "当前没有可用的版本记录");
    const etag = `"${release.platform}:${release.channel}:${release.version}"`;
    reply.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    reply.header("ETag", etag);
    if (request.headers["if-none-match"] === etag) return reply.code(304).send();
    return reply.send(versionPayload(release));
  });

  app.get("/app/client-assets/manifest", async (request, reply) => {
    const query = assetManifestQuerySchema.safeParse(request.query ?? {});
    if (!query.success) return fail(reply, 400, "bad_request", "平台或通道参数不合法");
    let asset;
    try {
      asset = query.data.version
        ? await readAssetVersion(query.data.platform, query.data.channel, query.data.version)
        : await readCurrentAssets(query.data.platform, query.data.channel);
    } catch (error) {
      if (sendServiceError(reply, error)) return reply;
      throw error;
    }
    if (!asset) return fail(reply, 404, "asset_release_not_found", "当前没有可用的热更新资产");
    const manifest = assetManifestResponse(asset.manifest);
    if (!manifest) return fail(reply, 503, "asset_manifest_invalid", "热更新资产清单不可用");
    const etag = `"${asset.platform}:${asset.version}"`;
    reply.header("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
    reply.header("ETag", etag);
    if (request.headers["if-none-match"] === etag) return reply.code(304).send();
    return reply.send(manifest);
  });

  app.get("/app/server-version", async (_request, reply) => {
    const current = await readCurrentServerRelease();
    reply.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    if (!current) {
      return reply.send({
        version: process.env.APP_VERSION?.trim() || "dev",
        tag: null,
        commit: process.env.GIT_COMMIT?.trim() || null,
        releasedAt: null,
        notes: null,
        source: "process-env",
      });
    }
    return reply.send({
      version: current.version,
      tag: current.tag,
      commit: current.commit,
      releasedAt: current.releasedAt,
      notes: current.notes,
      source: "release-center",
    });
  });

  // ─── 内部注册：CI / 部署流水线 ──────────────────────────────────────────
  await app.register(async (internal) => {
    internal.addHook("preHandler", requireReleaseToken);

    internal.post("/internal/app-releases", async (request, reply) => {
      const body = parseBody(app, appReleaseRegistrationSchema, request.body);
      for (const item of body.packages) {
        assertAllowedUrl(item.url, `packages[${item.kind}].url`);
        if (item.mirrorUrl) assertAllowedUrl(item.mirrorUrl, `packages[${item.kind}].mirrorUrl`);
      }
      let release;
      try {
        release = await registerAppRelease(body);
      } catch (error) {
        if (sendServiceError(reply, error)) return reply;
        throw error;
      }
      return reply.code(201).send({ release });
    });

    internal.post("/internal/client-assets", async (request, reply) => {
      const body = parseBody(app, clientAssetsRegistrationSchema, request.body);
      validateClientAssets(body);
      let asset;
      try {
        asset = await registerClientAssets(body);
      } catch (error) {
        if (sendServiceError(reply, error)) return reply;
        throw error;
      }
      return reply.code(201).send({ asset });
    });

    internal.post("/internal/channels/:platform/:channel/activate", async (request, reply) => {
      const params = request.params as { platform?: string; channel?: string };
      const platform = params.platform;
      if (!platform || !["ios", "android", "macos", "windows"].includes(platform)) {
        return fail(reply, 400, "bad_request", "平台参数不合法");
      }
      const body = parseBody(app, activateReleaseSchema, request.body);
      const channel = params.channel ?? "stable";
      try {
        await activateRelease(platform as "ios" | "android" | "macos" | "windows", channel, body.version, { force: body.force });
      } catch (error) {
        if (sendServiceError(reply, error)) return reply;
        throw error;
      }
      return reply.send({ platform, channel, version: body.version });
    });

    internal.post("/internal/channels/:platform/:channel/assets/activate", async (request, reply) => {
      const params = request.params as { platform?: string; channel?: string };
      const platform = params.platform;
      if (!platform || !["ios", "android"].includes(platform)) return fail(reply, 400, "bad_request", "平台参数不合法");
      const body = parseBody(app, activateReleaseSchema.pick({ version: true }), request.body);
      const channel = params.channel ?? "stable";
      try {
        await activateAssets(platform as "ios" | "android", channel, body.version);
      } catch (error) {
        if (sendServiceError(reply, error)) return reply;
        throw error;
      }
      return reply.send({ platform, channel, version: body.version });
    });

    internal.post("/internal/server-releases", async (request, reply) => {
      const body = parseBody(app, serverReleaseRegistrationSchema, request.body);
      let release;
      try {
        release = await registerServerRelease(body);
      } catch (error) {
        if (sendServiceError(reply, error)) return reply;
        throw error;
      }
      return reply.code(201).send({ release });
    });

    internal.get("/internal/releases", async (_request, reply) => {
      const [server, ios, android, macos, windows, iosAssets, androidAssets] = await Promise.all([
        readServerReleaseHistory(20),
        readReleaseHistory("ios", "stable", 20),
        readReleaseHistory("android", "stable", 20),
        readReleaseHistory("macos", "stable", 20),
        readReleaseHistory("windows", "stable", 20),
        readAssetHistory("ios", "stable", 20),
        readAssetHistory("android", "stable", 20),
      ]);
      return reply.send({ server, ios, android, macos, windows, assets: { ios: iosAssets, android: androidAssets } });
    });
  });
}
