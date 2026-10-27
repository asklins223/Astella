
import type { NoteDocLocalSession } from "./desktop-gateway-ns-note";
const noteDocLocalSessions = new Map<string, NoteDocLocalSession>();
import * as ns_note from "./desktop-gateway-ns-note";
import type { CompanionVoiceAudioCache } from "../voice/companion-voice-audio-cache";
import type { CompanionMessageAudioCache } from "../voice/companion-message-audio-cache";
import { z } from "zod";import { DESKTOP_API_SERVICE_ID, DESKTOP_IPC_CONTRACT_VERSION, desktopRouteKindM2Values, apiConnectionStateSchema, deploymentConfigSchema, memberListResultV1Schema, type MemberListResultV1, localApiTrustSchema, runtimeSnapshotSchema, companionChatStreamEventV1Schema, type ApiConnectionStateV1, type CompanionChatStreamEventV1, type DeploymentConfigV1, type GatewayErrorCode, type LocalApiTrustV1, type RuntimeSnapshotV1, windowStateSnapshotV1Schema } from "@astella/shared/desktop-ipc-contracts";import { defaultNoteDocTransport, type NoteDocTransport } from "../note-doc/note-doc-transport.ts";
import { roomProjectionV1Schema, type RoomProjectionV1 } from "@astella/shared/room-projection-contracts";import { companionAccountGlobalOffEventV1Schema, runtimeFenceResponseSchema, type CompanionAccountGlobalOffEventV1, type RuntimeFenceResponse } from "@astella/shared/companion-shell-contracts";import { companionStreamEventV1Schema } from "@astella/shared/companion-conversation-contracts";import { assistantDeliveryV2Schema, type AssistantDeliveryV2 } from "@astella/shared/companion-bridge-contracts";import { companionMemoryItemV1Schema, type CompanionMemoryItemV1 } from "@astella/shared/companion-memory-desktop-contracts";
import { understandingTopologySnapshotV3Schema, type NoteDeepeningSnapshotV1 } from "@astella/shared/note-deepening-contracts";
import { noteDeepeningV3Schema, type NoteDeepeningV3 } from "@astella/shared/note-deepening-v3-contracts";
// 2026-09-30 拆出：传输层与它依赖的两个类型各自成文件。`GatewayTransport` 持有
// 发请求所需的那一小块状态（`request` 的传递闭包，恰好 11 个成员）——
// 先抽状态、再搬方法，理由见那个文件的头。
import * as ns_source from "./desktop-gateway-ns-source";
import * as ns_auth from "./desktop-gateway-ns-auth";
import * as ns_runtime from "./desktop-gateway-ns-runtime";import { GatewayTransport, type GatewayConfiguration } from "./desktop-gateway-transport";
import * as ns_workspace from "./desktop-gateway-ns-workspace";import { CompanionBridge } from "./desktop-gateway-companion-bridge";
import * as ns_search from "./desktop-gateway-ns-search";
import * as ns_invite from "./desktop-gateway-ns-invite";

import * as ns_artifact from "./desktop-gateway-ns-artifact";
import { safeUuid } from "./desktop-gateway-uuid";
import { DesktopGatewayFailure } from "./desktop-gateway-failure";
import type { SessionCredentialStore } from "./desktop-gateway-credentials";

const DEFAULT_API_ORIGIN = "http://127.0.0.1:4000";

function readPairingSecret(value: string | undefined): Buffer | null {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const secret = Buffer.from(value, "base64url");
  return secret.length >= 32 && secret.toString("base64url") === value ? secret : null;
}

function readConfiguration(env: NodeJS.ProcessEnv): { ok: true; value: GatewayConfiguration } | { ok: false; reason: "missing" | "invalid" } {
  const apiOrigin = env.DESKTOP_API_ORIGIN?.trim() || DEFAULT_API_ORIGIN;
  const expectedDomainSchemaRevision = env.ASTELLA_DOMAIN_SCHEMA_REVISION?.trim();
  const configRevision = env.DESKTOP_DEPLOYMENT_CONFIG_REVISION?.trim() || "desktop-dev-config-v1";

  if (!expectedDomainSchemaRevision) return { ok: false, reason: "missing" };

  if (apiOrigin.startsWith("https://")) {
    const parsed = deploymentConfigSchema.safeParse({
      version: 1,
      mode: "remote_https",
      apiOrigin,
      expectedDomainSchemaRevision,
      configRevision,
    });
    return parsed.success ? { ok: true, value: { config: parsed.data, pairingSecret: null } } : { ok: false, reason: "invalid" };
  }

  const pairingKeyId = env.ASTELLA_DESKTOP_PAIRING_KEY_ID?.trim();
  const pairingSecret = readPairingSecret(env.ASTELLA_DESKTOP_PAIRING_SECRET?.trim());
  if (!pairingKeyId || !pairingSecret) return { ok: false, reason: "missing" };

  const parsed = deploymentConfigSchema.safeParse({
    version: 1,
    mode: "local_loopback",
    apiOrigin,
    localServiceTrust: "hmac_pairing_v1",
    expectedServiceId: DESKTOP_API_SERVICE_ID,
    expectedDomainSchemaRevision,
    pairingKeyId,
    configRevision,
  });
  return parsed.success ? { ok: true, value: { config: parsed.data, pairingSecret } } : { ok: false, reason: "invalid" };
}

function retryFor(code: GatewayErrorCode): DesktopGatewayFailure["retry"] {
  if (code === "api_unavailable" || code === "network_timeout") return "safe_retry";
  if (code === "result_unknown") return "resync_first";
  if (code === "api_untrusted" || code === "configuration_error") return "user_action";
  return "never";
}

function parseSseSequence(block: string): number | null {
  const idLine = block.split(/\r?\n/).find((line) => line.startsWith("id:"));
  if (!idLine) return null;
  const value = Number(idLine.slice(3).trim());
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** 单帧 payload 的过桥上限：伴星事件体常态 <1KB，超过即视为异常帧丢弃。 */
const COMPANION_CHAT_EVENT_MAX_PAYLOAD_BYTES = 16 * 1024;

/**
 * 伴星 SSE 单帧 → 可过桥的最小投影（`companionChatStreamEventV1Schema`）。
 *
 * 主进程是信任边界：畸形 JSON、缺字段、payload 非对象或超限一律返回 null 丢弃，
 * 绝不把原始 SSE 文本转发给渲染层。事件类型不做白名单——DB 允许 18 种，桌面端
 * 只对认识的那几种做事，未知类型照样过桥但不渲染。
 */
export function parseCompanionSseFrame(block: string): CompanionChatStreamEventV1 | null {
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(dataLines.join("\n"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const envelope = companionStreamEventV1Schema.safeParse(raw);
  if (!envelope.success) return null;
  // synthesisText 与 instruction 都只服务端合成用（服务端按 ref 重读事件），
  // 渲染层只需要引用、正文区间与 cue——两个都不过桥。
  const payload = envelope.data.type === "voice.segment.ready"
    ? (({ synthesisText: _privateSynthesisText, instruction: _privateInstruction, ...rendererSafe }) => rendererSafe)(envelope.data.payload)
    : envelope.data.payload;
  // A saved note receipt carries its bounded CRDT state so personal notes can
  // refresh without a collaboration stream. The strict shared schema has
  // already checked its identity, shape and 3MB update limit above.
  const carriesNoteEdit = envelope.data.type === "agent.tool"
    && envelope.data.payload.tool.name === "notes.write.edit"
    && envelope.data.payload.tool.status === "succeeded"
    && envelope.data.payload.tool.noteEdit !== undefined;
  if (JSON.stringify(payload).length > (carriesNoteEdit ? 3_010_000 : COMPANION_CHAT_EVENT_MAX_PAYLOAD_BYTES)) return null;
  const parsed = companionChatStreamEventV1Schema.safeParse({
    seq: envelope.data.seq,
    runId: envelope.data.runId,
    generation: envelope.data.generation,
    eventType: envelope.data.type,
    payload,
  });
  return parsed.success ? parsed.data : null;
}

export function parseCompanionAccountSseFrame(block: string): CompanionAccountGlobalOffEventV1 | null {
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  try {
    const parsed = companionAccountGlobalOffEventV1Schema.safeParse(JSON.parse(dataLines.join("\n")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Durable inbox frames are validated in main before becoming renderer invalidations. */
export function parseCompanionInboxSseFrame(block: string): AssistantDeliveryV2 | null {
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  try {
    const parsed = assistantDeliveryV2Schema.safeParse(JSON.parse(dataLines.join("\n")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function waitForStreamRetry(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * SSE 断线重连的阶梯（0269 轮 M17）。
 *
 * 以前 5 条流（account / inbox / 学习轮 / 制卡 / 伴星对话）在"流自然结束"和"抛错"两条
 * 出口上都写死固定 1000 毫秒：本地 API 一停，主进程就变成每秒最多 5 次
 * 重连，而每一次 `ensureConnected()` 会把整套 HMAC 信任握手 + `/health` 再走一遍——
 * 那正好是服务在恢复期最需要喘息的时候。退避到 30s 封顶，并带 ±25% 抖动，避免五条流
 * 永远在同一毫秒一起撞上去。
 *
 * 归零点在"真的读到一帧"上（见各 watcher 里的 `streamRetryAttempt = 0`）：能收到帧就
 * 说明这条线是通的，不该再背着失败历史。
 */
/** 只为读出一个 `error` token 而碰失败响应的 body，给它一个比任何正常响应都小的上限。 */
const DOMAIN_ERROR_BODY_MAX_BYTES = 4_096;

const STREAM_RETRY_BASE_MS = 1_000;
const STREAM_RETRY_CEILING_MS = 30_000;

function streamRetryDelayMs(attempt: number): number {
  const exponential = Math.min(
    STREAM_RETRY_CEILING_MS,
    STREAM_RETRY_BASE_MS * 2 ** Math.max(0, Math.min(attempt, 10)),
  );
  // ±25% 抖动：五条流同时断开时不该同时重连。
  const jitter = 0.75 + Math.random() * 0.5;
  return Math.round(exponential * jitter);
}

function roomActiveGenerationErrorReason(error: unknown): "upstream_unavailable" | "unsupported_contract" | "permission_denied" | "stale_workspace" | "route_not_available" {
  if (error instanceof DesktopGatewayFailure) {
    if (error.code === "unsupported_contract") return "unsupported_contract";
    if (error.code === "forbidden") return "permission_denied";
    if (error.code === "stale_workspace") return "stale_workspace";
    if (error.code === "route_not_available") return "route_not_available";
  }
  return "upstream_unavailable";
}

export class DesktopGateway {
  /**
   * 传输层。**所有发请求的动作最终都落到它**——`this.transport.request(...)`。
   *
   * 为什么它是字段而不是一堆方法：2026-09-30 用 AST 量过，264 个方法里 188 个调
   * `this.request`，而原来那 25 个状态字段全是 `private`——**类作用域的 private
   * 在 mixin 里拿不到**。所以「按命名空间把方法搬走」必须先把这块状态抽出来。
   * 拆分的顺序与理由见 `desktop-gateway-transport.ts` 的文件头。
   */
  private readonly transport: GatewayTransport;

  /**
   * 伴星桥与投递租约（2026-09-30 从本类搬出，见 `desktop-gateway-companion-bridge.ts`）。
   *
   * 它有**自己的定时续约与世代号**，是一个自成一体的小子系统——继续挂在 200 个成员的
   * 这个类上只会让它更难读。auth 的四个方法（`login` / `register` / `logout` /
   * `reauthenticate`）要调它的清理，**这���搬它的直接原因**。
   */
  private readonly bridge: CompanionBridge;

  /**
   * 伴星桥。**只读**——`desktop-ipc.ts` 通过它登记/撤销「助手此刻在读哪一页」。
   *
   * 与 `gatewayTransport` 同理：外部只该「拿它去调东西」，不该改它的状态。
   * 做成访问器而不是把字段改成 public，是为了让这条界线画出来。
   */
  get companionBridge(): CompanionBridge {
    return this.bridge;
  }

  /**
   * 传输层。**只读**，给 `desktop-ipc.ts` 那些**自由函数**用——
   * 2026-09-30 起有一批命名空间方法不再住在类里（见 `desktop-gateway-ns-*.ts`），
   * 它们的调用点是 `ns_search.getSearchDrift(gateway.transport, …)`。
   *
   * 为什么是访问器而不是把字段改成 public：`transport` 本身**仍然是类内部实现**，
   * 外部只该「拿它去调东西」，不该改它。访问器把这条界线画出来。
   */
  get gatewayTransport(): GatewayTransport {
    return this.transport;
  }
  private readonly noteDocTransport: NoteDocTransport;

  /**
   * 笔记正文的 SSE 传输（2026-09-30 随 `watchNoteDocument` 一起搬成自由函数）。
   *
   * **只读**——`desktop-ipc.ts` 通过它开/停那条长连接。与 `gatewayTransport` 同理：
   * 外部只该拿它去调东西，不该改它。
   */
  get noteDocTransportHandle(): NoteDocTransport {
    return this.noteDocTransport;
  }

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    options: {
      credentials?: SessionCredentialStore | null;
      guidanceAudioCache?: CompanionVoiceAudioCache;
      messageAudioCache?: CompanionMessageAudioCache;
      /**
       * 协同传输的实现。默认用真的 Hocuspocus provider；测试里换成假的，才能断言
       * "该不该建这条连接"（门控）与"帧怎么转发"，而不是去连一个真服务端。
       */
      noteDocTransport?: NoteDocTransport;
    } = {},
  ) {
    this.noteDocTransport = options.noteDocTransport ?? defaultNoteDocTransport;
    const result = readConfiguration(env);
    const configuredTrustOrigin = result.ok && result.value.config.mode === "local_loopback"
      ? result.value.config.apiOrigin
      : DEFAULT_API_ORIGIN;
    // `configuration` 与 `connection` 在传输层里是 readonly / 构造期定的，
    // 所以**先在这里算出来，再一起交给 transport**——不在构造里回头写它的字段。
    const configuration = result.ok ? result.value : null;
    const connection: ApiConnectionStateV1 = result.ok
      ? { version: 1, kind: "checking", originKind: result.value.config.mode }
      : {
        version: 1,
        kind: "configuration_error",
        reason: result.reason === "missing" ? "pairing_secret_missing" : "invalid_deployment_config",
      };
    // 2026-09-30 第四刀：`configurationError` 与 `trust` 变成**构造期定**——
    // 原先在构造里「先算再写」，而 `readonly` 字段只能在构造函数体内赋初值。
    const configurationError: "missing" | "invalid" | null = result.ok ? null : result.reason;
    const trust: LocalApiTrustV1 = {
      version: 1,
      state: "untrusted",
      origin: configuredTrustOrigin,
      serviceId: DESKTOP_API_SERVICE_ID,
      transportEpoch: 1,
    };
    this.transport = new GatewayTransport(
      configuration,
      configurationError,
      options.credentials ?? null,
      connection,
      trust,
      options.guidanceAudioCache ?? null,
      options.messageAudioCache ?? null,
    );
    this.bridge = new CompanionBridge(this.transport);
  }

  /** 对外的一格。`desktop-ipc.ts` 直接调它——所以它留在类上，实现在传输层。 */
  getConnectionState(): ApiConnectionStateV1 {
    return apiConnectionStateSchema.parse(this.transport.connection);
  }

  getTrust(): LocalApiTrustV1 {
    return localApiTrustSchema.parse(this.transport.trust);
  }

  getDeploymentConfig(): DeploymentConfigV1 | null {
    return this.transport.configuration?.config ?? null;
  }

  getRuntimeSnapshot(windowState: RuntimeSnapshotV1["windowState"], reducedMotion: boolean): RuntimeSnapshotV1 {
    return runtimeSnapshotSchema.parse({
      version: 1,
      contractVersion: DESKTOP_IPC_CONTRACT_VERSION,
      appId: "astella-desktop-client",
      appVersion: this.env.npm_package_version?.trim() || "0.1.0",
      platform: process.platform === "darwin" || process.platform === "win32" ? process.platform : "linux",
      windowState: windowStateSnapshotV1Schema.parse(windowState),
      apiConnection: this.getConnectionState(),
      nativeCapabilities: this.transport.nativeCapabilities(),
      reducedMotion,
      startupRevision: 1,
      sessionCredential: {
        persistence: this.transport.credentials ? "local_file" : "memory",
        stored: this.transport.credentials?.hasStored() ?? false,
      },
    });
  }

  async connect(requestId?: string): Promise<ApiConnectionStateV1> {
    if (!this.transport.configuration) {
      this.transport.connection = {
        version: 1,
        kind: "configuration_error",
        reason: this.transport.configurationError === "missing" ? "pairing_secret_missing" : "invalid_deployment_config",
      };
      throw new DesktopGatewayFailure("configuration_error", retryFor("configuration_error"));
    }

    this.transport.connection = { version: 1, kind: "checking", originKind: this.transport.configuration.config.mode };
    try {
      if (this.transport.configuration.config.mode === "local_loopback") await this.transport.performLocalTrust(this.transport.configuration, requestId);
      else await this.transport.performRemoteHealth(this.transport.configuration.config, requestId);
      return this.getConnectionState();
    } catch (error) {
      if (error instanceof DesktopGatewayFailure) throw error;
      this.transport.connection = { version: 1, kind: "api_unavailable" };
      throw new DesktopGatewayFailure("api_unavailable", "safe_retry");
    }
  }

  /** GET /members（Owner）：活跃成员列表。 */
  async listMembers(requestId?: string): Promise<MemberListResultV1> {
    await this.transport.ensureConnected(requestId);
    const result = await this.transport.request("/members?limit=200", { method: "GET" }, true, true, requestId);
    const payload = (result.body ?? {}) as { items?: unknown[]; total?: unknown };
    const parsed = memberListResultV1Schema.safeParse({
      version: 1,
      items: (payload.items ?? []).map((item) => {
        const row = (item ?? {}) as Record<string, unknown>;
        return {
          version: 1,
          userId: row.userId,
          email: row.email,
          role: row.role,
          joinedAt: row.joinedAt,
        };
      }),
      total: payload.total,
    });
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /** DELETE /members/:userId（Owner）：移除成员，其会话立即失效。 */
  async removeMember(userId: string, requestId?: string): Promise<{ removed: true }> {
    await this.transport.ensureConnected(requestId);
    await this.transport.request(`/members/${userId}`, { method: "DELETE" }, true, true, requestId);
    return { removed: true };
  }

  async getUnderstandingTopology(requestId?: string): Promise<NoteDeepeningSnapshotV1> {
    await this.transport.ensureConnected(requestId);
    const result = await this.transport.request("/v3/understanding/topology", { method: "GET" }, true, true, requestId);
    const parsed = understandingTopologySnapshotV3Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /**
   * 星图三层展开的层二与层三（39d W8-1、W8-3；§11.2）。
   *
   * **按一篇笔记读，不复用 `getUnderstandingTopology`**：拓扑那一份回答"图上有哪些
   * 节点"，这一份回答"沿着一篇笔记往下读会依次看到什么"；§11.5「总览只显示当前层，
   * 局部按需加载」。合在一起就是每一次读星图都把每一篇笔记的作答与反馈搬一遍。
   *
   * `limit` 不给就**不给**——本进程不替她决定这一屏看几条（补一个默认值会让服务端
   * 那句"截断了"变成一个客户端挑的数）。
   */
  async getUnderstandingNoteDeepening(input: {
    noteId: string;
    limit?: number;
  }, requestId?: string): Promise<NoteDeepeningV3> {
    await this.transport.ensureConnected(requestId);
    const query = new URLSearchParams();
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    const suffix = query.toString();
    const result = await this.transport.request(
      `/v3/understanding/notes/${encodeURIComponent(input.noteId)}/deepening${suffix ? `?${suffix}` : ""}`,
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = noteDeepeningV3Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /**
   * 首页的房间投影。Plan 57 之后 objective/run/review 这条链已经不在了，
   * 首页要说的只剩"这个空间里有哪些笔记和来源"。不再请求 `/v2/learning-dashboard`
   * （那条路由已随旧链删除），只用两份列表里真实存在的数字构图；
   * 读不到就如实报告为不可用，不编一个 0。
   */
  async getRoomProjection(requestId?: string): Promise<RoomProjectionV1> {
    await this.transport.ensureConnected(requestId);
    const [notes, sources] = await Promise.all([
      ns_note.listNotes(this.gatewayTransport, { limit: 20 }, requestId),
      ns_source.listSources(this.gatewayTransport, { limit: 1 }, requestId),
    ]);
    const snapshotAt = new Date().toISOString();
    const revision = `room-${notes.total}-${sources.total}-${notes.items[0]?.id ?? "none"}`;
    const recentActivities = notes.items.slice(0, 6).map((note) => ({
      activityId: note.id,
      kind: "note.updated",
      occurredAt: note.updatedAt,
    }));
    const latestNote = notes.items[0];
    const recentNote = latestNote?.currentVersionId
      ? { noteId: latestNote.id, noteVersionId: latestNote.currentVersionId, title: latestNote.title }
      : null;
    return roomProjectionV1Schema.parse({
      version: 1,
      workspaceEpoch: this.transport.workspaceEpoch,
      snapshotAt,
      dashboardRevision: revision,
      mode: notes.total > 0 ? "notes" : "first_use",
      recentNote,
      recentActivitySummary: recentActivities.length > 0
        ? { state: "data" as const, data: { items: recentActivities } }
        : { state: "empty" as const },
      captureCapability: { state: "enabled" as const },
      sectionStates: {
        recentActivitySummary: { state: recentActivities.length > 0 ? "data" as const : "empty" as const },
      },
      degradation: null,
    });
  }

  async renewCompanionRuntimeFence(
    surfaceEpoch: number,
    ttlSeconds = 120,
    requestId?: string,
  ): Promise<RuntimeFenceResponse> {
    await this.transport.ensureConnected(requestId);
    const result = await this.transport.request(
      "/me/companion/runtime-fences",
      {
        method: "POST",
        body: JSON.stringify({
          deviceSessionId: this.transport.deviceSessionId,
          surfaceEpoch,
          ttlSeconds,
        }),
      },
      true,
      true,
      requestId,
    );
    const parsed = runtimeFenceResponseSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /** Main-only account epoch stream. Raw SSE and device identity never cross preload. */
  async watchCompanionAccountEvents(
    afterEpoch: number,
    onEvent: (event: CompanionAccountGlobalOffEventV1) => void | Promise<void>,
    onError?: (error: unknown) => void,
  ): Promise<() => void> {
    await this.transport.ensureConnected();
    const controller = new AbortController();
    let closed = false;
    let cursor = Number.isSafeInteger(afterEpoch) && afterEpoch >= 0 ? afterEpoch : 0;
    const stop = (): void => {
      closed = true;
      controller.abort();
    };
    let streamRetryAttempt = 0;
    const run = async (): Promise<void> => {
      while (!closed) {
        try {
          const configuration = this.transport.configuration;
          if (!configuration) throw new DesktopGatewayFailure("configuration_error", "user_action");
          const headers = new Headers({ Accept: "text/event-stream" });
          if (this.transport.token) headers.set("Authorization", `Bearer ${this.transport.token}`);
          const userId = this.transport.currentSession?.status === "authenticated" ? this.transport.currentSession.user.userId : null;
          if (cursor > 0 && userId) headers.set("Last-Event-ID", `${userId}:${cursor}`);
          const url = new URL("/me/companion/events", `${configuration.config.apiOrigin}/`);
          url.searchParams.set("after", String(cursor));
          const response = await fetch(url, { method: "GET", headers, signal: controller.signal, redirect: "manual" });
          if (response.status >= 300 && response.status < 400) throw new DesktopGatewayFailure("api_untrusted", "user_action");
          if (!response.ok) throw this.transport.mapResponseError(response.status, response.headers);
          const reader = response.body?.getReader();
          if (!reader) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
          const decoder = new TextDecoder();
          let buffer = "";
          while (!closed) {
            const chunk = await reader.read();
            // 读到帧 = 这条线是通的，退避阶梯归零；下一次意外断开从 1 秒重新起。
            streamRetryAttempt = 0;
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() ?? "";
            for (const block of blocks) {
              const event = parseCompanionAccountSseFrame(block);
              if (!event || event.epoch <= cursor) continue;
              cursor = event.epoch;
              await onEvent(event);
            }
          }
          if (!closed) await waitForStreamRetry(streamRetryDelayMs(streamRetryAttempt++));
        } catch (error) {
          if (closed || (error instanceof Error && error.name === "AbortError")) return;
          onError?.(error);
          if (error instanceof DesktopGatewayFailure && ["api_untrusted", "auth_required", "reauth_required", "forbidden", "not_found", "unsupported_contract"].includes(error.code)) return;
          await waitForStreamRetry(streamRetryDelayMs(streamRetryAttempt++));
        }
      }
    };
    void run();
    return stop;
  }

  /**
   * Main-owned durable proactive inbox stream. The renderer receives only a
   * sequence invalidation and re-reads the strict timeline projection.
   */
  async watchCompanionInboxEvents(
    afterSequence: number,
    onDelivery: (delivery: AssistantDeliveryV2) => void | Promise<void>,
    onError?: (error: unknown) => void,
  ): Promise<() => void> {
    await this.transport.ensureConnected();
    const controller = new AbortController();
    let closed = false;
    let cursor = Number.isSafeInteger(afterSequence) && afterSequence >= 0 ? afterSequence : 0;
    const stop = (): void => {
      closed = true;
      controller.abort();
    };
    let streamRetryAttempt = 0;
    const run = async (): Promise<void> => {
      while (!closed) {
        try {
          const configuration = this.transport.configuration;
          if (!configuration) throw new DesktopGatewayFailure("configuration_error", "user_action");
          const headers = new Headers({ Accept: "text/event-stream" });
          if (this.transport.token) headers.set("Authorization", `Bearer ${this.transport.token}`);
          if (cursor > 0) headers.set("Last-Event-ID", String(cursor));
          const url = new URL("/companion/deliveries/inbox/stream", `${configuration.config.apiOrigin}/`);
          url.searchParams.set("after", String(cursor));
          const response = await fetch(url, { method: "GET", headers, signal: controller.signal, redirect: "manual" });
          if (response.status >= 300 && response.status < 400) throw new DesktopGatewayFailure("api_untrusted", "user_action");
          if (!response.ok) throw this.transport.mapResponseError(response.status, response.headers);
          const reader = response.body?.getReader();
          if (!reader) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
          const decoder = new TextDecoder();
          let buffer = "";
          while (!closed) {
            const chunk = await reader.read();
            // 读到帧 = 这条线是通的，退避阶梯归零；下一次意外断开从 1 秒重新起。
            streamRetryAttempt = 0;
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() ?? "";
            for (const block of blocks) {
              const delivery = parseCompanionInboxSseFrame(block);
              if (!delivery || delivery.inboxSequence <= cursor) continue;
              cursor = delivery.inboxSequence;
              await onDelivery(delivery);
            }
          }
          if (!closed) await waitForStreamRetry(streamRetryDelayMs(streamRetryAttempt++));
        } catch (error) {
          if (closed || (error instanceof Error && error.name === "AbortError")) return;
          onError?.(error);
          if (error instanceof DesktopGatewayFailure && ["api_untrusted", "auth_required", "reauth_required", "forbidden", "not_found", "unsupported_contract"].includes(error.code)) return;
          await waitForStreamRetry(streamRetryDelayMs(streamRetryAttempt++));
        }
      }
    };
    void run();
    return stop;
  }

  /** 候选记忆确认：服务端同一事务里写长期记忆并抬高 familiarity。 */
  async confirmCompanionMemory(memoryId: string, requestId?: string): Promise<CompanionMemoryItemV1> {
    return this.mutateCompanionMemory("confirm", memoryId, requestId);
  }

  async pinCompanionMemory(memoryId: string, requestId?: string): Promise<CompanionMemoryItemV1> {
    return this.mutateCompanionMemory("pin", memoryId, requestId);
  }

  async unpinCompanionMemory(memoryId: string, requestId?: string): Promise<CompanionMemoryItemV1> {
    return this.mutateCompanionMemory("unpin", memoryId, requestId);
  }

  async archiveCompanionMemory(memoryId: string, requestId?: string): Promise<CompanionMemoryItemV1> {
    return this.mutateCompanionMemory("archive", memoryId, requestId);
  }

  async restoreCompanionMemory(memoryId: string, requestId?: string): Promise<CompanionMemoryItemV1> {
    return this.mutateCompanionMemory("restore", memoryId, requestId);
  }

  /**
   * 从 30 天回收区恢复（40 §11「删除可撤回」）。
   *
   * 走 `POST /:id/restore-deleted` 而不是既有的 `restore`：后者恢复的是**归档**，
   * 前者恢复的是**已删除**。两者都叫 restore，但一个撤归档、一个撤删除——
   * 混用会让用户以为删掉的东西回来了，实际只是从归档区回来。
   */

  /**
   * 彻底清除（不可逆，40 §11「不以『正式历史不可变』拒绝适用的删除规则」）。
   *
   * 与 `removeCompanionMemory`（进回收区，等 30 天）的分工是**时间**：
   * 那条是默认，那条是「现在就删干净」。所以这里不给"撤销"留位置。
   */

  private async mutateCompanionMemory(
    action: "confirm" | "pin" | "unpin" | "archive" | "restore",
    memoryId: string,
    requestId?: string,
  ): Promise<CompanionMemoryItemV1> {
    await this.transport.ensureConnected(requestId);
    const result = await this.transport.request(
      `/companion/memory/${safeUuid(memoryId)}/${action}`,
      { method: "POST", body: JSON.stringify({}) },
      true,
      true,
      requestId,
    );
    const parsed = companionMemoryItemV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

  /**
   * 伴星会话事件流（§5.3）：`GET /companion/conversations/:id/events`。
   *
   * 与 learningRun/cardGeneration 两条流同构（NOTIFY 唤醒 + 兜底轮询由服务端负责），
   * 区别是这里转发**事件本身**而不是"有新版本了"的信号：回复的渐进显现与逐句开口
   * 要求帧到即渲染，再让渲染层回查一次消息等于把流式的收益原路还回去。
   *
   * `eventCursor` 是订阅起点（seq 独占），来自回合响应的 `eventCursor`——从
   * turn.accepted 之后开始收，不重放历史。断线以 `Last-Event-ID` 续传；
   * 400/409（游标落在过期窗口）只允许重置为 0 重放一次，再失败即停流并报错，
   * 由渲染层的消息快照兜底。
   */
  async watchCompanionConversationEvents(
    conversationId: string,
    eventCursor: number,
    onEvent: (event: CompanionChatStreamEventV1) => void | Promise<void>,
    onError?: (error: unknown) => void,
    voiceOutput = false,
  ): Promise<() => void> {
    await this.transport.ensureConnected();
    const safeConversationId = safeUuid(conversationId);
    const controller = new AbortController();
    let closed = false;
    let cursor = Number.isSafeInteger(eventCursor) && eventCursor >= 0 ? eventCursor : 0;
    let resetOnce = false;
    const stop = (): void => {
      closed = true;
      controller.abort();
    };

    let streamRetryAttempt = 0;
    const run = async (): Promise<void> => {
      while (!closed) {
        try {
          const configuration = this.transport.configuration;
          if (!configuration) throw new DesktopGatewayFailure("configuration_error", "user_action");
          const headers = new Headers({ Accept: "text/event-stream" });
          if (this.transport.token) headers.set("Authorization", `Bearer ${this.transport.token}`);
          // 服务端 cursor 取合法较大值：query `after` 与 Last-Event-ID 并存时以
          // 大者为准（§5.3），两者给同一个值即可。
          if (cursor > 0) headers.set("Last-Event-ID", `${safeConversationId}:${cursor}`);
          const eventsUrl = new URL(
            `/companion/conversations/${safeConversationId}/events`,
            `${configuration.config.apiOrigin}/`,
          );
          eventsUrl.searchParams.set("after", String(cursor));
          if (voiceOutput) eventsUrl.searchParams.set("voiceOutput", "1");
          const response = await fetch(eventsUrl, {
            method: "GET",
            headers,
            signal: controller.signal,
            redirect: "manual",
          });
          if (response.status === 400 || response.status === 409) {
            // INVALID_CURSOR / CURSOR_EXPIRED：窗口已过期，只能从头重放一次。
            // 渲染层按 runId/generation 过滤，重放不会污染当前回合的呈现。
            if (resetOnce) throw this.transport.mapResponseError(response.status, response.headers);
            resetOnce = true;
            cursor = 0;
            continue;
          }
          if (response.status >= 300 && response.status < 400) {
            throw new DesktopGatewayFailure("api_untrusted", "user_action");
          }
          if (!response.ok) throw this.transport.mapResponseError(response.status, response.headers);
          const reader = response.body?.getReader();
          if (!reader) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
          const decoder = new TextDecoder();
          let buffer = "";
          while (!closed) {
            const chunk = await reader.read();
            // 读到帧 = 这条线是通的，退避阶梯归零；下一次意外断开从 1 秒重新起。
            streamRetryAttempt = 0;
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() ?? "";
            for (const block of blocks) {
              const event = parseCompanionSseFrame(block);
              if (!event || event.seq <= cursor) continue;
              cursor = event.seq;
              await onEvent(event);
            }
          }
          buffer += decoder.decode();
          const tail = parseCompanionSseFrame(buffer);
          if (tail && tail.seq > cursor) {
            cursor = tail.seq;
            await onEvent(tail);
          }
          if (!closed) await waitForStreamRetry(streamRetryDelayMs(streamRetryAttempt++));
        } catch (error) {
          if (closed || (error instanceof Error && error.name === "AbortError")) return;
          onError?.(error);
          if (error instanceof DesktopGatewayFailure && ["api_untrusted", "auth_required", "reauth_required", "forbidden", "not_found", "unsupported_contract"].includes(error.code)) return;
          await waitForStreamRetry(streamRetryDelayMs(streamRetryAttempt++));
        }
      }
    };
    void run();
    return stop;
  }
}
