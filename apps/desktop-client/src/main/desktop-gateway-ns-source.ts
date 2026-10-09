import { getNoteImageStore } from "./note-image-store";
import { noteImageCacheScope, primeNoteImageCache } from "./note-image-cache";
import { uploadRemoteObject } from "./desktop-object-transfers";
/**
 * 网关的「来源」那一族方法 —— **2026-09-30 从 `DesktopGateway` 类搬出**。
 *
 * ## 为什么它现在才搬
 *
 * 实测（AST）：13 个命名空间里多数都还依赖类里的 `private` 成员。本族原先依赖
 * `workspaceEpoch` 与 `cachedCapabilities` —— 它们是**工作区纪元与它的能力投影缓存**，
 * 属连接/会话状态，2026-09-30 第五刀把它们连同实现（`transportNativeCapabilities` /
 * `NATIVE_CAPABILITY_CHANNELS` / `CAPABILITY_CACHE_TTL_MS`）搬进了 `GatewayTransport`。
 * 搬完之后本族对类状态的依赖**归零**，于是可以整体变成自由函数。
 *
 * **顺序不是随意的**：命名空间要等它依赖的私有状态先有落脚点。否则只有两条路——
 * 把它复制一份进每个文件（那是把耦合从类搬进文件，不是拆开），
 * 或给每个自由函数挂一串参数（那样它比原来更难读）。两条都不做。
 *
 * 下面的代码**逐字搬移**：成员由脚本按 TS AST 的精确源区间从 `desktop-gateway.ts`
 * 切出，只做两处改写——签名前加 `t: GatewayTransport`，方法体里 `t.transport.` 换成 `t.`。
 */
import {
  z,
} from "zod";
import {
  CapabilityProjectionV1,
  capabilityProjectionSchema,
} from "@astella/shared/desktop-ipc-contracts";
import {
  SOURCE_IMAGE_MAX_BYTES,
  SOURCE_IMAGE_MIME_TYPES,
  SourceImageGetRequestV1,
  SourceImageGetResultV1,
  sourceImageGetResultV1Schema,
  sourceImageObjectKeyFromUrl,
} from "@astella/shared/source-image-contracts";
import {
  DesktopSourceArchiveResult,
  DesktopSourceCreateRequest,
  DesktopSourceCreateResultV1,
  DesktopSourceDetail,
  DesktopSourceListPage,
  DesktopSourceNoteResult,
  DesktopSourceNotesPage,
  DesktopSourceReparseResult,
  DesktopSourceRestoreResult,
  DesktopSourceUpdateRequest,
  desktopSourceCreateResultV1Schema,
  desktopSourceDetailSchema,
  desktopSourceListPageSchema,
  desktopSourceNotesPageSchema,
  desktopSourceRestoreResultSchema,
} from "@astella/shared/desktop-surface-contracts";
import {
  safeUuid,
} from "./desktop-gateway-uuid";
import {
  DesktopGatewayFailure,
} from "./desktop-gateway-failure";
import {
  CAPABILITY_CACHE_TTL_MS,
  rawHealthSchema,
  rawReadinessSchema,
  transportNativeCapabilities,
} from "./desktop-gateway-transport";
import type { GatewayTransport } from "./desktop-gateway-transport";

export async function archiveSource(t: GatewayTransport, sourceId: string, requestId?: string): Promise<DesktopSourceArchiveResult> {
    await t.ensureConnected(requestId);
    await t.request(`/sources/${safeUuid(sourceId)}`, { method: "DELETE" }, true, true, requestId);
    return { sourceId, status: "archived" };
  }

export async function createNoteFromSource(t: GatewayTransport, 
    sourceId: string,
    options: { force?: boolean } = {},
    requestId?: string,
  ): Promise<DesktopSourceNoteResult> {
    await t.ensureConnected(requestId);
    const suffix = options.force ? "?force=true" : "";
    const result = await t.request(
      `/sources/${safeUuid(sourceId)}/create-note${suffix}`,
      { method: "POST" },
      true,
      false,
      requestId,
      undefined,
      true,
    );

    if (result.status === 409) {
      const conflict = z.object({
        error: z.enum(["duplicate_content", "source_not_ready"]),
        existingNoteId: z.string().uuid().optional(),
        existingNoteTitle: z.string().optional(),
      }).passthrough().safeParse(result.body);
      if (!conflict.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
      if (conflict.data.error === "duplicate_content" && conflict.data.existingNoteId) {
        return {
          kind: "duplicate",
          noteId: conflict.data.existingNoteId,
          title: conflict.data.existingNoteTitle ?? "",
        };
      }
      throw new DesktopGatewayFailure("conflict", "never", { httpStatus: result.status });
    }
    if (result.status < 200 || result.status >= 300) {
      throw t.mapResponseError(result.status, result.headers, undefined, result.body);
    }

    const created = z.object({
      note: z.object({ id: z.string().uuid(), title: z.string() }).passthrough(),
      version: z.object({ id: z.string().uuid() }).passthrough(),
    }).passthrough().safeParse(result.body);
    if (!created.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return {
      kind: "created",
      noteId: created.data.note.id,
      noteVersionId: created.data.version.id,
      title: created.data.note.title,
    };
  }

export async function createSource(t: GatewayTransport, 
    request: DesktopSourceCreateRequest,
    requestId?: string,
  ): Promise<DesktopSourceCreateResultV1> {
    await t.ensureConnected(requestId);
    const remote = request.content ? await uploadRemoteObject(t, { purpose: "source_text",
      fileName: `${request.title?.slice(0, 180) || "source"}.txt`, mimeType: request.type === "markdown" ? "text/markdown" : "text/plain",
      source: { type: request.type, title: request.title, url: request.url, force: request.force } }, Buffer.from(request.content), requestId) : null;
    const result = remote ?? await t.request(
      "/sources",
      { method: "POST", body: JSON.stringify(request) },
      true,
      true,
      requestId,
    );
    const parsed = desktopSourceCreateResultV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function getCapabilities(t: GatewayTransport, requestId?: string): Promise<CapabilityProjectionV1> {
    /**
     * 0269 轮 M12：这条以前**每次**都打服务端。它自己是幂等只读的，代价在它的使用方式上
     * ——`requireActionCapability()` 在每个受控动作前都要读它一次（制卡的 11 个通道、建/删/
     * 存笔记、上传图像……），于是"点一个按钮"变成"先一次往返确认能不能点，再真正那一次"。
     * 实测这个端点平均 51.5 ms，也就是说每个按钮前面白垫半秒之内的延迟。
     *
     * 缓存按 `workspaceEpoch` 失效：切空间、重登都会把它复位或推进，那一刻能力必然要重算。
     * 再加一条 5s TTL 兜住"运维在服务端翻了 feature flag 但没有任何 epoch 变化"这种情况
     * ——那类翻转的传播延迟上限从"直到下次切空间"变成 5 秒。
     */
    const cached = t.cachedCapabilities;
    if (cached && cached.epoch === t.workspaceEpoch && Date.now() - cached.atMs < CAPABILITY_CACHE_TTL_MS) {
      return cached.projection;
    }
    await t.ensureConnected(requestId);
    const epoch = t.workspaceEpoch, token = t.token, generation = t.capabilityReadGeneration;
    const pending = t.capabilityRead;
    if (pending?.epoch === epoch && pending.token === token && pending.generation === generation) return pending.value;
    const value = readCapabilities(t, epoch, token, generation, requestId);
    t.capabilityRead = { epoch, token, generation, value };
    try { return await value; }
    finally { if (t.capabilityRead?.value === value) t.capabilityRead = null; }
  }

async function readCapabilities(t: GatewayTransport, epoch: number, token: string | null, generation: number, requestId?: string): Promise<CapabilityProjectionV1> {
    const result = await t.request("/v1/auth/capabilities", { method: "GET" }, true, true, requestId);
    if (t.workspaceEpoch !== epoch || t.token !== token || t.capabilityReadGeneration !== generation) {
      throw new DesktopGatewayFailure("stale_workspace", "resync_first");
    }
    const parsed = capabilityProjectionSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    // 本机能力属于桌面壳，服务端只能给 fail-closed 占位；真正的值在这里覆盖，
    // 让「设置 → 本机能力 / 半身形象」显示的是这台机器的事实而不是猜测。
    const projection = capabilityProjectionSchema.parse({
      ...parsed.data,
      workspaceEpoch: t.workspaceEpoch,
      nativeCapabilities: transportNativeCapabilities(),
    });
    t.cachedCapabilities = { atMs: Date.now(), epoch: t.workspaceEpoch, projection };
    return projection;
  }

export async function getSource(t: GatewayTransport, sourceId: string, requestId?: string): Promise<DesktopSourceDetail> {
    await t.ensureConnected(requestId);
    const result = await t.request(`/sources/${safeUuid(sourceId)}`, { method: "GET" }, true, true, requestId);
    const parsed = desktopSourceDetailSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function getSourceImage(t: GatewayTransport, 
    request: SourceImageGetRequestV1,
    requestId?: string,
  ): Promise<SourceImageGetResultV1> {
    await t.ensureConnected(requestId);
    const epoch = t.workspaceEpoch, token = t.token;
    const scope = noteImageCacheScope(t, request.objectKey);
    if (t.currentSession?.status === "authenticated" && !scope) throw new DesktopGatewayFailure("not_found", "never");
    const load = async () => {
      const result = await t.requestBinaryBytes(`/uploads/${request.objectKey}`, { method: "GET" },
        { accept: "image/*", contentTypePrefix: "image/", maxBytes: SOURCE_IMAGE_MAX_BYTES }, requestId);
      const mime = result.contentType.split(";")[0].trim();
      if (!(SOURCE_IMAGE_MIME_TYPES as readonly string[]).includes(mime)) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
      if (t.workspaceEpoch !== epoch || t.token !== token) throw new DesktopGatewayFailure("stale_workspace", "resync_first");
      return { bytes: Buffer.from(result.bytes), mime };
    };
    const store = getNoteImageStore();
    const result = scope && store ? await store.get(scope, request.objectKey, load, async () => {
      // 复用磁盘字节仍复核当前可见性；通配条件只返回 304，存储只查元数据，不取图片体。
      const authorized = await t.request(`/uploads/${request.objectKey}`, { method: "HEAD", headers: { "If-None-Match": "*" } }, true, false, requestId, undefined, true);
      if (authorized.status !== 304) throw t.mapResponseError(authorized.status, authorized.headers, undefined, authorized.body);
    }) : await load();
    if (t.workspaceEpoch !== epoch || t.token !== token) throw new DesktopGatewayFailure("stale_workspace", "resync_first");
    const mimeType = result.mime;
    const parsed = sourceImageGetResultV1Schema.safeParse({
      version: 1,
      mimeType,
      imageBase64: Buffer.from(result.bytes).toString("base64"),
      byteLength: result.bytes.byteLength,
    });
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

/**
 * 导入 Markdown 时随正文进来的图片：先走预签名那条（`markdown_import_image` 用途），
 * 这台机器没启用远端存储时回退到 `POST /uploads/import-images`（与笔记图片那条同形）。
 *
 * 交回的是**站内地址** `/api/uploads/{objectKey}`：正文里的相对路径换成它之后，
 * 建来源、建笔记、翻页显示，走的和网页图片那条是同一条路，一处都不新。
 */
export async function uploadBundleImage(t: GatewayTransport,
    input: { fileName: string; mimeType: string; bytes: Buffer },
    requestId?: string,
  ): Promise<string> {
    await t.ensureConnected(requestId);
    const epoch = t.workspaceEpoch, token = t.token;
    const assertCurrent = () => { if (t.workspaceEpoch !== epoch || t.token !== token) throw new DesktopGatewayFailure("stale_workspace", "resync_first"); };
    const remote = await uploadRemoteObject(t, { purpose: "markdown_import_image", fileName: input.fileName,
      mimeType: input.mimeType }, input.bytes, requestId);
    if (remote) {
      assertCurrent();
      const url = bundleImageUploadUrl(remote.body);
      await primeNoteImageCache(t, url, { bytes: input.bytes, mime: input.mimeType });
      return url;
    }
    const configuration = t.configuration;
    if (!configuration) throw new DesktopGatewayFailure("configuration_error", "user_action");
    const form = new FormData();
    form.set("file", new Blob([input.bytes], { type: input.mimeType }), input.fileName);

    const headers = new Headers();
    if (t.token) headers.set("Authorization", `Bearer ${t.token}`);
    const controller = requestId ? new AbortController() : undefined;
    if (requestId && controller) t.activeRequests.set(requestId, controller);
    let response: Response;
    try {
      response = await fetch(new URL("/uploads/import-images", `${configuration.config.apiOrigin}/`), {
        method: "POST",
        headers,
        body: form,
        signal: controller?.signal,
        redirect: "manual",
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new DesktopGatewayFailure("cancelled", "never", { localEffect: "request_cancelled" });
      }
      t.connection = { version: 1, kind: "api_unavailable" };
      throw new DesktopGatewayFailure("api_unavailable", "safe_retry");
    } finally {
      if (requestId && controller && t.activeRequests.get(requestId) === controller) t.activeRequests.delete(requestId);
    }
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      t.connection = { version: 1, kind: "api_untrusted", reason: "wrong_service" };
      throw new DesktopGatewayFailure("api_untrusted", "user_action");
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok && response.status === 401 && t.tokenIsRestored) await t.discardStoredCredential();
    if (!response.ok) throw t.mapResponseError(response.status, response.headers, undefined, body);
    assertCurrent();
    const url = bundleImageUploadUrl(body);
    await primeNoteImageCache(t, url, { bytes: input.bytes, mime: input.mimeType });
    return url;
  }

/**
 * 上传回执里的站内地址，按**渲染层那一份**判据核过形状才交出去。
 *
 * 存得进对象存储却显示不出来的地址（形状不合 → 取图通道拒），读者要等到打开笔记才
 * 发现，而且那时正文已经收进去了。所以在这里 fail closed，这一张如实报失败。
 */
function bundleImageUploadUrl(body: unknown): string {
  const url = (body as { url?: unknown } | null)?.url;
  if (typeof url !== "string" || !sourceImageObjectKeyFromUrl(url)) {
    throw new DesktopGatewayFailure("unsupported_contract", "user_action");
  }
  return url;
}

export async function listSourceNotes(t: GatewayTransport, sourceId: string, requestId?: string): Promise<DesktopSourceNotesPage> {
    await t.ensureConnected(requestId);
    const result = await t.request(`/sources/${safeUuid(sourceId)}/notes`, { method: "GET" }, true, true, requestId);
    const parsed = desktopSourceNotesPageSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function listSources(t: GatewayTransport, options: { status?: string; cursor?: string; limit?: number } = {}, requestId?: string): Promise<DesktopSourceListPage> {
    await t.ensureConnected(requestId);
    const query = new URLSearchParams();
    if (options.status) query.set("status", options.status);
    if (options.cursor) query.set("cursor", options.cursor);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    const suffix = query.toString();
    const result = await t.request(`/sources${suffix ? `?${suffix}` : ""}`, { method: "GET" }, true, true, requestId);
    const parsed = desktopSourceListPageSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function reparseSource(t: GatewayTransport, sourceId: string, requestId?: string): Promise<DesktopSourceReparseResult> {
    await t.ensureConnected(requestId);
    const response = await t.request(
      `/sources/${safeUuid(sourceId)}/reparse`,
      { method: "POST" },
      true,
      true,
      requestId,
    );
    if (response.status === 409) throw new DesktopGatewayFailure("conflict", "user_action", { httpStatus: response.status });
    return { sourceId, status: "draft" };
  }

export async function restoreSource(t: GatewayTransport, sourceId: string, requestId?: string): Promise<DesktopSourceRestoreResult> {
    await t.ensureConnected(requestId);
    const result = await t.request(
      `/sources/${safeUuid(sourceId)}/restore`,
      { method: "POST" },
      true,
      true,
      requestId,
    );
    const parsed = desktopSourceRestoreResultSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return { sourceId, status: parsed.data.status as DesktopSourceRestoreResult["status"], alreadyActive: parsed.data.alreadyActive };
  }

export async function updateSourceTitle(t: GatewayTransport, 
    sourceId: string,
    request: DesktopSourceUpdateRequest,
    requestId?: string,
  ): Promise<DesktopSourceDetail> {
    await t.ensureConnected(requestId);
    const result = await t.request(
      `/sources/${safeUuid(sourceId)}`,
      { method: "PATCH", body: JSON.stringify(request) },
      true,
      true,
      requestId,
    );
    const parsed = desktopSourceDetailSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }
