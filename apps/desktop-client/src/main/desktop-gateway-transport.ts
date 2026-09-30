/**
 * 网关的**传输层**：`DesktopGateway` 发请求所依赖的那一小块状态。
 *
 * ## 为什么把它抽出来（2026-09-30）
 *
 * `desktop-gateway.ts` 当时 6379 行 / 264 个方法。用 TypeScript AST 量过之后，
 * 原来打算的「按命名空间把方法搬进 mixin」**根本走不通**：那个类 25 个属性
 * **全是 `private`**（而 `private` 是类作用域的），且 264 个方法里
 * **188 个调 `this.request(`**。搬出去的方法每一个都会在类型上断掉。
 * **所以顺序必须反过来：先抽状态，再搬方法。**
 *
 * ## 三刀，每一刀都是「闭包 + 查外部使用者」
 *
 * ① `request` 的传递闭包（11 个成员）②二进制与音频那一族（5 个）
 * ③`safeUuid` 出网（`desktop-gateway-uuid.ts`）+ 命令幂等账本
 *
 * 每一段都由脚本按 TS AST 的精确源区间从 `desktop-gateway.ts` 切出，**逐字搬移**。
 * 第四刀（连接与凭据那一族 10 个）**没有落进来**——它连带十几次文本插入把这个文件
 * 切碎了，8 个成员在重组中丢失。重来时先备份这一份。
 */
  // 第四刀那一族要用的两份模块级（原先与网关类同文件，2026-09-30 随方法搬来）。

export const rawHealthSchema = z.strictObject({
    status: z.literal("ok"),
    service: z.literal("api"),
    timestamp: z.string().datetime({ offset: true }),
  });


export const rawReadinessSchema = z.object({
  status: z.enum(["ready", "not_ready"]),
  service: z.literal("api"),
  timestamp: z.string().datetime({ offset: true }),
}).passthrough();
  function retryFor(code: GatewayErrorCode): DesktopGatewayFailure["retry"] {
    if (code === "api_unavailable" || code === "network_timeout") return "safe_retry";
    if (code === "result_unknown") return "resync_first";
    if (code === "api_untrusted" || code === "configuration_error") return "user_action";
    return "never";
  }

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  COMPANION_VOICE_MAX_AUDIO_BYTES,
} from "@ailearn/shared/companion-voice-contracts";
import { DesktopGatewayFailure } from "./desktop-gateway-failure";
import type { SessionCredentialStore } from "./desktop-gateway-credentials";
import type { RoomProjectionV1 } from "@ailearn/shared/room-projection-contracts";
import type { LearningDashboardV2 } from "@ailearn/shared/learning-objective-surface-contracts";
import type {
  ApiConnectionStateV1,
  CapabilityProjectionV1,
  DeploymentConfigV1,
  GatewayErrorCode,
  LocalApiTrustV1,
  NativeCapabilityProjectionV1,
  SessionContextV1,
  WorkspaceSummaryV1,
  WorkspaceContextV1,
} from "@ailearn/shared/desktop-ipc-contracts";
// 下面这几个是**值**（zod schema 与常量），不是类型——不能待在 `import type { … }` 里（TS1361）。
import {
  DESKTOP_API_SERVICE_ID,
  DESKTOP_IPC_CONTRACT_VERSION,
  apiConnectionStateSchema,
  desktopTrustChallengeRequestSchema,
  desktopTrustChallengeResponseSchema,
  desktopTrustSignatureMessage,
  DESKTOP_IPC_CHANNELS,
  localApiTrustSchema,
  emailSchema,
  nonEmptyStringSchema,
  sessionContextSchema,
} from "@ailearn/shared/desktop-ipc-contracts";

/** 部署配置 + 配对密钥。**2026-09-30 从 `desktop-gateway.ts` 原样搬来。** */
export type GatewayConfiguration = {
  readonly config: DeploymentConfigV1;
  readonly pairingSecret: Buffer | null;
};

/** 域错误体的读取上限。 */
const DOMAIN_ERROR_BODY_MAX_BYTES = 4_096;

/** 域错误码表。 */
const AUTH_DOMAIN_ERROR_CODES: Record<string, GatewayErrorCode> = {
  email_exists: "email_exists",
  not_found: "invite_invalid",
  revoked: "invite_invalid",
  expired: "invite_expired",
  already_consumed: "invite_consumed",
  concurrent_consumption: "invite_consumed",
  workspace_limit_reached: "workspace_limit",
  already_member: "already_member",
  personal_workspace_not_shareable: "personal_workspace_not_shareable",
};

const NOTE_DOMAIN_ERROR_CODES: Record<string, GatewayErrorCode> = {
  doc_identity_mismatch: "note_doc_stale",
};

const NOTE_TEACHING_DOMAIN_CODES: Record<string, { status: number; code: GatewayErrorCode }> = {
  reflection_stale_revision: { status: 409, code: "reflection_stale_revision" },
  teaching_grounding_failed: { status: 422, code: "teaching_grounding_failed" },
  teaching_model_unconfigured: { status: 503, code: "teaching_model_unconfigured" },
  teaching_in_progress: { status: 409, code: "teaching_in_progress" },
  round_budget_exhausted: { status: 409, code: "round_budget_exhausted" },
  model_not_configured: { status: 503, code: "teaching_model_unconfigured" },
  evidence_rejected: { status: 422, code: "teaching_grounding_failed" },
  document_rejected: { status: 422, code: "teaching_grounding_failed" },
  render_rejected: { status: 422, code: "teaching_grounding_failed" },
  model_failed: { status: 422, code: "note_artifact_generation_failed" },
  contract_rejected: { status: 422, code: "teaching_grounding_failed" },
  note_empty: { status: 422, code: "teaching_grounding_failed" },
  note_version_changed: { status: 409, code: "note_artifact_stale" },
};

const CONSENT_REQUIRED_TOKEN = "ai_consent_required";

function domainErrorCode(status: number, body: unknown): GatewayErrorCode | null {
  if (!body || typeof body !== "object" || !("error" in body)) return null;
  const token = (body as { error?: unknown }).error;
  if (typeof token !== "string") return null;
  const teachingCode = NOTE_TEACHING_DOMAIN_CODES[token];
  if (teachingCode?.status === status) return teachingCode.code;
  if (status === 413 && token === "note_too_long") return "note_artifact_too_long";
  // 403 上只认这一个 token：登录那一族的字符串是**路由内**的约定
  // （`not_found` 在邀请那条路上意思是"邀请码无效"，在取图上意思是"文件没了"）。
  // 把它们放到 403 上一起认，就会把一次取图失败说成邀请码问题。
  if (status === 403) return token === CONSENT_REQUIRED_TOKEN ? "ai_consent_required" : null;
  if (status !== 400 && status !== 404 && status !== 409 && status !== 410) return null;
  return NOTE_DOMAIN_ERROR_CODES[token] ?? AUTH_DOMAIN_ERROR_CODES[token] ?? null;
}

function retryAfterFromHeaders(headers: Headers): string | undefined {
  const value = headers.get("retry-after")?.trim();
  if (!value) return undefined;
  if (/^\d{1,7}$/.test(value)) {
    const seconds = Number(value);
    return new Date(Date.now() + seconds * 1000).toISOString();
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

// 能力投影的实现（2026-09-30 第五刀）：`workspaceEpoch` 的缓存与它的投影函数。

// 它们是 `cachedCapabilities` 的另一半——**缓存在这里，投影也得在这里**，
// 否则「缓存的那份」和「算出来的那份」会分居两个文件。
// `/auth/me` 与工作区列表的回信形状（2026-09-30 第六刀）：
// `loadSession` / `toWorkspaceSummary` 要用，跟着一起搬。
export const rawAuthMeSchema = z.strictObject({
  userId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  email: emailSchema,
  role: z.enum(["owner", "member"]),
  displayName: nonEmptyStringSchema.nullable(),
  avatarUrl: z.string().nullable(),
  workspaceName: nonEmptyStringSchema,
  workspaceType: z.enum(["personal", "collaborative"]),
  isPersonal: z.boolean(),
  personalWorkspaceId: z.string().uuid().nullable(),
  // 0261：服务端边界令牌。**必填**——它是本机 epoch 的权威值，缺了就该按契约不符
  // 拒掉，而不是悄悄退回本地计数（那正是审查说的"数字只活在客户端"）。
  workspaceEpoch: z.number().int().positive(),
});

export const rawWorkspaceListSchema = z.strictObject({
  workspaces: z.array(z.strictObject({
    workspaceId: z.string().uuid(),
    workspaceName: nonEmptyStringSchema,
    role: z.enum(["owner", "member"]),
    workspaceType: z.enum(["personal", "collaborative"]),
    isPersonal: z.boolean(),
    leftAt: z.string().datetime({ offset: true }).nullable(),
  })),
});

export const CAPABILITY_CACHE_TTL_MS = 5_000;

const NATIVE_CAPABILITY_CHANNELS: Readonly<Record<keyof NativeCapabilityProjectionV1, string | null>> = {
  filePicker: null,
  clipboard: DESKTOP_IPC_CHANNELS.clipboardReadLinks,
  notifications: null,
  // ASR：2026-09-18 起接了真实语音链路——本地 SenseVoice（WASM）优先，云
  // `/voice/transcribe` 兜底，通道存在即视为可用。
  asr: DESKTOP_IPC_CHANNELS.companionVoiceTranscribe,
  updates: null,
  live2d: null,
};

export function transportNativeCapabilities(): NativeCapabilityProjectionV1 {
  const registered = new Set<string>(Object.values(DESKTOP_IPC_CHANNELS));
  return Object.fromEntries(
    Object.entries(NATIVE_CAPABILITY_CHANNELS).map(([key, channel]) => [
      key,
      channel !== null && registered.has(channel) ? "available" : "unavailable",
    ]),
  ) as NativeCapabilityProjectionV1;
}

export class GatewayTransport {

  // ── 会话与凭据（2026-09-30 第六刀） ────────────────────────────────
  //
  // 实测（AST）：这五段只依赖传输层自己的成员，所以能整体搬过来。
  // 它们原先住在 `DesktopGateway` 上，第四刀搬 `restoreStoredCredential` 时漏掉了。
  //
  // **逐字搬移**：由脚本按 TS AST 的精确源区间切出后原样放入。

  // `sessionWorkspaceReturn` 是登录前的回跳工作区（纯状态字段）。
  sessionWorkspaceReturn: { email: string; workspaceId: string } | null = null;
  // `loadSession` 用已存凭据恢复会话——**本来就属于传输层**，第四刀搬 `restoreStoredCredential` 时漏了它。
  async loadSession(requestId?: string): Promise<SessionContextV1> {
      const result = await this.request("/auth/me", { method: "GET" }, true, true, requestId);
      const parsed = rawAuthMeSchema.safeParse(result.body);
      if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
      const workspace = this.toWorkspaceContext(parsed.data);
      // 服务端是本机 epoch 的权威来源：边界一变（成员 / AI 同意 / 改名）它就变大，
      // 这里跟着走。本地切换时仍会 +1（切空间必须立刻让在途请求作废），但两者取
      // 较大值——否则"服务端抬过、本地计数还小"会让刚拿到的新 epoch 被自己覆盖回去。
      if (parsed.data.workspaceEpoch > this.workspaceEpoch) {
        this.workspaceEpoch = parsed.data.workspaceEpoch;
      }
      this.currentSession = sessionContextSchema.parse({
        version: 1,
        status: "authenticated",
        user: {
          userId: parsed.data.userId,
          email: parsed.data.email,
          ...(parsed.data.displayName ? { displayName: parsed.data.displayName } : {}),
        },
        workspace,
        membership: { role: parsed.data.role },
        capabilities: null,
        workspaceEpoch: this.workspaceEpoch,
        credentialPersistence: this.credentialPersistence,
      });
      // 记下"这个人现在在哪个空间"，给重认证那道门回去用（见 `reauthenticate`）。
      if (workspace) this.sessionWorkspaceReturn = { email: parsed.data.email, workspaceId: workspace.workspaceId };
      return this.currentSession;
    }
  // `persistCredential` 把凭据写回（内存或 `safe_storage`）。
  async persistCredential(remember: boolean): Promise<void> {
      const store = this.credentials;
      this.tokenIsRestored = false;
      if (!remember || !store?.available || !this.token) {
        this.credentialPersistence = "memory";
        if (store?.available) await store.clear().catch(() => undefined);
        return;
      }
      try {
        await store.save(this.token);
        this.credentialPersistence = "safe_storage";
      } catch {
        this.credentialPersistence = "memory";
        await store.clear().catch(() => undefined);
      }
    }
  // `toWorkspaceContext` / `toWorkspaceSummary` 是上面两个的纯转换助手。
  toWorkspaceContext(value: z.infer<typeof rawAuthMeSchema>): WorkspaceContextV1 {
      const summary = this.toWorkspaceSummary({
        workspaceId: value.workspaceId,
        workspaceName: value.workspaceName,
        role: value.role,
        workspaceType: value.workspaceType,
        isPersonal: value.isPersonal,
        leftAt: null,
      });
      return { ...summary, workspaceEpoch: this.workspaceEpoch };
    }
  toWorkspaceSummary(value: z.infer<typeof rawWorkspaceListSchema>["workspaces"][number]): WorkspaceSummaryV1 {
      return {
        version: 1,
        workspaceId: value.workspaceId,
        name: value.workspaceName,
        role: value.role,
        workspaceType: value.workspaceType,
        isPersonal: value.isPersonal,
      };
    }
    constructor(
      configuration: GatewayConfiguration | null,
      // `configurationError` 与 `trust` 是**构造期定**的（2026-09-30 第四刀）：它们原先在
      // 网关构造里「先算再写」，搬进这个类之后必须走构造器——`readonly` 字段只能在
      // 构造函数体内赋初值，写成 `this.x = …` 在别的方法里是编译错误。
      configurationError: "missing" | "invalid" | null,
      credentials: SessionCredentialStore | null,
      connection: ApiConnectionStateV1,
      trust: LocalApiTrustV1,
    ) {
      this.configuration = configuration;
      this.configurationError = configurationError;
      this.credentials = credentials;
      this.connection = connection;
      this.trust = trust;
    }

  // ── 状态 ────────────────────────────────────────────────────────
    readonly activeRequests = new Map<string, AbortController>();
  // ── 连接与凭据（2026-09-30 第四刀） ────────────────────────────────
  //
  // `ensureConnected` 被全类 **198 个方法**调用——它是整个网关的入口门，
  // 与 `request` 是同一件事的两半：「先确认连得上，再发」。所以它们住一起。
  // `trust` / `transportEpoch` 是 `performLocalTrust` 的产物，一并搬来。

    readonly configurationError: "missing" | "invalid" | null;

    credentialRestored = false;

    trust: LocalApiTrustV1;

    transportEpoch = 0;

    async restoreStoredCredential(): Promise<void> {
        if (this.credentialRestored) return;
        this.credentialRestored = true;
        const store = this.credentials;
        if (!store?.available || this.token) return;
        const stored = await store.load().catch(() => null);
        if (!stored) return;
        this.token = stored;
        this.tokenIsRestored = true;
        this.credentialPersistence = "safe_storage";
      }

    async performLocalTrust(configuration: GatewayConfiguration, requestId?: string): Promise<void> {
        if (!configuration.pairingSecret || configuration.config.mode !== "local_loopback") {
          throw new DesktopGatewayFailure("configuration_error", "user_action");
        }
        const request = desktopTrustChallengeRequestSchema.parse({
          version: 1,
          nonce: randomBytes(32).toString("base64url"),
          ipcContractVersion: DESKTOP_IPC_CONTRACT_VERSION,
          pairingKeyId: configuration.config.pairingKeyId,
        });
        let result: { status: number; body: unknown };
        try {
          result = await this.request("/_ailearn/desktop/trust/v1/challenge", {
            method: "POST",
            body: JSON.stringify(request),
          }, false, false, requestId);
        } catch (error) {
          if (error instanceof DesktopGatewayFailure && error.httpStatus !== undefined && error.httpStatus >= 400 && error.httpStatus < 500) {
            this.connection = { version: 1, kind: "api_untrusted", reason: error.httpStatus === 401 ? "wrong_key" : "unsupported_contract" };
            throw new DesktopGatewayFailure("api_untrusted", "user_action");
          }
          throw error;
        }
        const response = desktopTrustChallengeResponseSchema.safeParse(result.body);
        if (!response.success) {
          this.connection = { version: 1, kind: "api_untrusted", reason: "unsupported_contract" };
          throw new DesktopGatewayFailure("api_untrusted", "user_action");
        }
        const value = response.data;
        if (
          value.nonce !== request.nonce ||
          value.serviceId !== DESKTOP_API_SERVICE_ID ||
          value.ipcContractVersion !== DESKTOP_IPC_CONTRACT_VERSION ||
          value.pairingKeyId !== configuration.config.pairingKeyId ||
          value.domainSchemaRevision !== configuration.config.expectedDomainSchemaRevision
        ) {
          this.connection = { version: 1, kind: "api_untrusted", reason: "unsupported_contract" };
          throw new DesktopGatewayFailure("api_untrusted", "user_action");
        }
        const expected = createHmac("sha256", configuration.pairingSecret)
          .update(desktopTrustSignatureMessage(value), "ascii")
          .digest();
        const received = Buffer.from(value.signature, "hex");
        if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
          this.connection = { version: 1, kind: "api_untrusted", reason: "bad_hmac" };
          throw new DesktopGatewayFailure("api_untrusted", "user_action");
        }
        const health = await this.request("/health", { method: "GET" }, false, false, requestId, undefined, true);
        const healthParsed = rawHealthSchema.safeParse(health.body);
        if (health.status >= 300 || !healthParsed.success) {
          this.connection = { version: 1, kind: "api_untrusted", reason: "unsupported_contract" };
          throw new DesktopGatewayFailure("api_untrusted", "user_action");
        }
        const previousInstanceId = this.trust.state === "trusted" ? this.trust.instanceId : null;
        if (previousInstanceId && previousInstanceId !== value.instanceId) {
          // A domain idempotency key must never be replayed against a different
          // API instance/configuration revision.
          this.commandIdempotency.clear();
        }
        this.transportEpoch += 1;
        this.trust = localApiTrustSchema.parse({
          version: 1,
          state: "trusted",
          origin: configuration.config.apiOrigin,
          serviceId: DESKTOP_API_SERVICE_ID,
          pairingKeyId: value.pairingKeyId,
          instanceId: value.instanceId,
          transportEpoch: this.transportEpoch,
          verifiedAt: new Date().toISOString(),
        });
        this.connection = { version: 1, kind: "ready", instanceId: value.instanceId, schemaRevision: value.domainSchemaRevision };
      }

    async performRemoteHealth(config: DeploymentConfigV1, requestId?: string): Promise<void> {
        const result = await this.request("/health", { method: "GET" }, false, false, requestId);
        const parsed = rawHealthSchema.safeParse(result.body);
        if (!parsed.success || parsed.data.service !== DESKTOP_API_SERVICE_ID.replace("ailearn-", "")) {
          this.connection = { version: 1, kind: "api_untrusted", reason: "wrong_service" };
          throw new DesktopGatewayFailure("api_untrusted", "user_action");
        }
        this.connection = { version: 1, kind: "ready", schemaRevision: config.expectedDomainSchemaRevision };
      }

    getConnectionState(): ApiConnectionStateV1 {
        return apiConnectionStateSchema.parse(this.connection);
      }

    async connect(requestId?: string): Promise<ApiConnectionStateV1> {
        if (!this.configuration) {
          this.connection = {
            version: 1,
            kind: "configuration_error",
            reason: this.configurationError === "missing" ? "pairing_secret_missing" : "invalid_deployment_config",
          };
          throw new DesktopGatewayFailure("configuration_error", retryFor("configuration_error"));
        }
  
        this.connection = { version: 1, kind: "checking", originKind: this.configuration.config.mode };
        try {
          if (this.configuration.config.mode === "local_loopback") await this.performLocalTrust(this.configuration, requestId);
          else await this.performRemoteHealth(this.configuration.config, requestId);
          return this.getConnectionState();
        } catch (error) {
          if (error instanceof DesktopGatewayFailure) throw error;
          this.connection = { version: 1, kind: "api_unavailable" };
          throw new DesktopGatewayFailure("api_unavailable", "safe_retry");
        }
      }

    async ensureConnected(requestId?: string): Promise<void> {
        await this.restoreStoredCredential();
        if (this.connection.kind === "ready") return;
        await this.connect(requestId);
      }

  // ── 工作区纪元与能力缓存（2026-09-30 第五刀） ──────────────────────
  //
  // `workspaceEpoch` 是**这一份工作区**的身份，`cachedCapabilities` 是它的能力投影缓存——
  // 两者都是**连接/会话状态**，不是某一个命名空间的私产。`source` 那一族要读它们，
  // 所以它们住在这里而不是被复制一份到 `desktop-gateway-ns-source.ts`。

    workspaceEpoch = 1;

    cachedCapabilities: { atMs: number; epoch: number; projection: CapabilityProjectionV1 } | null = null;

  // 2026-09-30 第七刀：`roomProjectionCache` 与上面那个 `cachedCapabilities` 是同一族——
  // **某个昂贵投影的缓存**，都跟着 `workspaceEpoch` 走（缓存要按纪元失效）。
  // `joinWorkspace` / `leaveWorkspace` 要读它，而那两个方法要变成自由函数，
  // 所以缓存得先在传输层有个落脚点。

  roomProjectionCache: {
    readonly etag: string;
    readonly workspaceEpoch: number;
    readonly dashboard: LearningDashboardV2;
    readonly value: RoomProjectionV1;
  } | null = null;

    forgetCapabilities(): void {
        this.cachedCapabilities = null;
      }

    /** 本机能力投影。模块级实现（`transportNativeCapabilities`），这里只是把它挂进实例，
     *  因为 `desktop-gateway.ts` 的 `getCapabilities` 要从传输层拿它。 */
    nativeCapabilities(): NativeCapabilityProjectionV1 {
      return transportNativeCapabilities();
    }

  // 本次进程固定的会话标识（2026-09-30 第八刀）。它们是**每次请求都要带的身份**，
  // 属传输层状态——不是某一个命名空间的私产。
readonly deviceSessionId = randomUUID();
readonly companionAccountSessionId = randomUUID();
    readonly configuration: GatewayConfiguration | null;
    connection: ApiConnectionStateV1;
    readonly credentials: SessionCredentialStore | null;
    currentSession: SessionContextV1 | null = null;
    readonly commandIdempotency = new Map<string, string>();
    token: string | null = null;
    tokenIsRestored = false;
    credentialPersistence: "memory" | "safe_storage" = "memory";

  // ── 方法 ────────────────────────────────────────────────────────
    async discardStoredCredential(): Promise<void> {
    this.token = null;
    this.tokenIsRestored = false;
    this.currentSession = null;
    this.credentialPersistence = "memory";
    await this.credentials?.clear().catch(() => undefined);
}
  mapResponseError(status: number, headers: Headers, unauthorizedCode?: GatewayErrorCode, body?: unknown): DesktopGatewayFailure {
  const retryAfter = retryAfterFromHeaders(headers);
  const options = { httpStatus: status, ...(retryAfter ? { retryAfter } : {}) };
  const domainCode = domainErrorCode(status, body);
  if (domainCode) return new DesktopGatewayFailure(domainCode, "never", options);
  if (status === 401) return new DesktopGatewayFailure(unauthorizedCode ?? (this.token ? "reauth_required" : "auth_required"), "user_action", options);
  // 403 上只有白名单里那一种 token 会被翻成专用码，其余一律还是 `forbidden`。
  if (status === 403) return new DesktopGatewayFailure("forbidden", "never", options);
  if (status === 404) return new DesktopGatewayFailure("not_found", "never", options);
  if (status === 409) return new DesktopGatewayFailure("conflict", "never", options);
  if (status === 429) return new DesktopGatewayFailure("rate_limited", "safe_retry", options);
  if (status >= 500) return new DesktopGatewayFailure("safe_internal_error", "user_action", options);
  return new DesktopGatewayFailure("validation", "user_action", options);
}
  private async readBytesWithinCap(response: Response, maxBytes: number): Promise<Uint8Array> {
  const body = response.body;
  if (!body) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        // 超限立即 abort 响应流，绝不把 oversize body 读完或编码进 renderer payload。
        await reader.cancel().catch(() => undefined);
        throw new DesktopGatewayFailure("unsupported_contract", "user_action");
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // reader 已因 abort/error 失效时不需要额外处理。
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
  async discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // 已关闭或已失败的 body 无需处理。
  }
}
  async errorBodyForDomainCode(response: Response): Promise<unknown> {
  try {
    const bytes = await this.readBytesWithinCap(response, DOMAIN_ERROR_BODY_MAX_BYTES);
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}
  async request(
  path: string,
  init: RequestInit,
  authenticated: boolean,
  mapErrors = true,
  requestId?: string,
  unauthorizedCode?: GatewayErrorCode,
  allowHttpErrors = false,
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const configuration = this.configuration;
  if (!configuration) throw new DesktopGatewayFailure("configuration_error", "user_action");
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  if (authenticated && this.token) headers.set("Authorization", `Bearer ${this.token}`);
  let response: Response;
  const controller = requestId ? new AbortController() : undefined;
  if (requestId && controller) this.activeRequests.set(requestId, controller);
  try {
    response = await fetch(new URL(path, `${configuration.config.apiOrigin}/`), {
      ...init,
      headers,
      signal: controller?.signal,
      redirect: "manual",
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new DesktopGatewayFailure("cancelled", "never", { localEffect: "request_cancelled" });
    }
    this.connection = { version: 1, kind: "api_unavailable" };
    throw new DesktopGatewayFailure("api_unavailable", "safe_retry");
  } finally {
    if (requestId && controller && this.activeRequests.get(requestId) === controller) this.activeRequests.delete(requestId);
  }
  if (response.status >= 300 && response.status < 400 && response.status !== 304) {
    this.connection = { version: 1, kind: "api_untrusted", reason: "wrong_service" };
    throw new DesktopGatewayFailure("api_untrusted", "user_action");
  }
  let body: unknown = null;
  if (response.status !== 204) {
    try {
      body = await response.json();
    } catch {
      body = null;
    }
  }
  if (!response.ok && response.status === 401 && this.tokenIsRestored) {
    // The credential resumed at start-up is dead (expired or revoked). Retire
    // it *before* mapping, so the caller sees `auth_required` and lands on the
    // sign-in form instead of a re-authentication prompt for an account this
    // process can no longer name.
    await this.discardStoredCredential();
  }
  if (!response.ok && mapErrors) throw this.mapResponseError(response.status, response.headers, unauthorizedCode, body);
  if (!response.ok && !allowHttpErrors) throw new DesktopGatewayFailure("api_unavailable", "safe_retry", { httpStatus: response.status });
  return { status: response.status, body, headers: response.headers };
}
  async requestBinaryBytes(
  path: string,
  init: RequestInit,
  policy: { readonly accept: string; readonly contentTypePrefix: string; readonly maxBytes: number },
  requestId?: string,
): Promise<{ status: number; bytes: Uint8Array; contentType: string; headers: Headers }> {
  const configuration = this.configuration;
  if (!configuration) throw new DesktopGatewayFailure("configuration_error", "user_action");
  const headers = new Headers(init.headers);
  headers.set("Accept", policy.accept);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  if (this.token) headers.set("Authorization", `Bearer ${this.token}`);
  const controller = requestId ? new AbortController() : undefined;
  if (requestId && controller) this.activeRequests.set(requestId, controller);
  try {
    const response = await fetch(new URL(path, `${configuration.config.apiOrigin}/`), {
      ...init,
      headers,
      signal: controller?.signal,
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      this.connection = { version: 1, kind: "api_untrusted", reason: "wrong_service" };
      throw new DesktopGatewayFailure("api_untrusted", "user_action");
    }
    if (!response.ok) {
      // 只有 403 才去碰失败体：那条路上唯一值得区分的就是"没签 AI 使用同意"。
      // 其余状态维持"按状态码分类"，取图那条 404 不会因为服务端也带了一个
      // `error` 字符串就被说成邀请码问题（这个回归是真被既有用例抓到的）。
      const errorBody = response.status === 403 ? await this.errorBodyForDomainCode(response) : undefined;
      throw this.mapResponseError(response.status, response.headers, undefined, errorBody);
    }
    const contentType = response.headers.get("content-type")?.trim().toLowerCase() ?? "";
    if (!contentType.startsWith(policy.contentTypePrefix)) {
      // 服务端失败体（JSON error）永远不进入 renderer。
      await this.discardResponseBody(response);
      throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > policy.maxBytes) {
      await this.discardResponseBody(response);
      throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    }
    return {
      status: response.status,
      bytes: await this.readBytesWithinCap(response, policy.maxBytes),
      contentType,
      headers: response.headers,
    };
  } catch (error) {
    if (error instanceof DesktopGatewayFailure) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new DesktopGatewayFailure("cancelled", "never", { localEffect: "request_cancelled" });
    }
    this.connection = { version: 1, kind: "api_unavailable" };
    throw new DesktopGatewayFailure("api_unavailable", "safe_retry");
  } finally {
    if (requestId && controller && this.activeRequests.get(requestId) === controller) this.activeRequests.delete(requestId);
  }
}
  requestAudioBytes(path: string, init: RequestInit, requestId?: string) {
  return this.requestBinaryBytes(path, init, {
    accept: "audio/mpeg",
    contentTypePrefix: "audio/",
    maxBytes: COMPANION_VOICE_MAX_AUDIO_BYTES,
  }, requestId);
}
  idempotencyKey(operation: string, commandId: string): string {
  const key = `${operation}:${commandId}`;
  const existing = this.commandIdempotency.get(key);
  if (existing) return existing;
  const generated = randomUUID();
  this.commandIdempotency.set(key, generated);
  if (this.commandIdempotency.size > 2048) {
    const oldest = this.commandIdempotency.keys().next().value;
    if (oldest) this.commandIdempotency.delete(oldest);
  }
  return generated;
}
}
