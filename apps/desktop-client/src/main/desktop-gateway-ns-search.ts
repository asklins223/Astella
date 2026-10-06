/**
 * 网关的「搜索」那一族方法 —— **2026-09-30 从 `DesktopGateway` 类搬出**。
 *
 * ## 为什么搬
 *
 * `desktop-gateway.ts` 当时 5916 行 / 248 个方法。这个命名空间的 3 个方法
 * **对类状态的依赖集合是空的**：它们只碰 `transport`（2026-09-30 已经抽出去了）。
 * 所以它们可以整体变成自由函数，第一个参数是那一个 `t: GatewayTransport`。
 *
 * ## 为什么这一步排在其他命名空间前面
 *
 * 实测（AST）：13 个命名空间里，**只有 5 个是零依赖**——其余每一个都还要用类里的
 * `private` 成员（`note` 12 个、`companion` 14 个、`auth` 11 个…）。
 * **零依赖的先搬**，每搬完一族都保持 typecheck 与 49 个主进程测试全绿；
 * 下一族有变化时，回滚的范围就只有一族。
 *
 * ## 与 `desktop-ipc.ts` 的关系
 *
 * 这些方法原先是 `gateway.foo(…)`，现在调用点是 `foo(gateway.transport, …)`。
 * **`desktop-ipc.ts` 里那一处改动与这里是同一次改动**——两边分开改会让它同时知道
 * 两套形状，比搬之前更难读。
 *
 * 下面的代码是**逐字搬移**：成员由脚本从 `desktop-gateway.ts` 按 TS AST 的精确源区间
 * 切出，只做了两处改写——签名前加 `t: GatewayTransport`（方法体里的
 * `this.transport.` 换成 `t.`）。手抄这类搬移最容易走形。
 */
import { z } from "zod";
import { DesktopGatewayFailure } from "./desktop-gateway-failure";
import { safeUuid } from "./desktop-gateway-uuid";
import {
  DESKTOP_API_SERVICE_ID,
  DESKTOP_IPC_CHANNELS,
  DESKTOP_IPC_CONTRACT_VERSION,
  desktopRouteKindM2Values,
  apiConnectionStateSchema,
  capabilityProjectionSchema,
  desktopTrustChallengeRequestSchema,
  desktopTrustChallengeResponseSchema,
  desktopTrustSignatureMessage,
  deploymentConfigSchema,
  emailSchema,
  uuidSchema,
  AVATAR_MAX_BYTES,
  authProfileResultV1Schema,
  authSurfaceManifestResultV1Schema,
  avatarObjectKeySchema,
  avatarUploadResultV1Schema,
  inviteCreatedV1Schema,
  inviteListResultV1Schema,
  memberListResultV1Schema,
  renameWorkspaceResultV1Schema,
  dissolvePreviewResultV1Schema,
  dissolveWorkspaceResultV1Schema,
  transferWorkspaceOwnershipResultV1Schema,
  type DissolvePreviewResultV1,
  type DissolveWorkspaceResultV1,
  type TransferWorkspaceOwnershipResultV1,
  createWorkspaceResultV1Schema,
  searchDriftResultV1Schema,
  searchReindexResultV1Schema,
  type AuthProfileResultV1,
  type AvatarUploadResultV1,
  type InviteCreatedV1,
  type InviteListResultV1,
  type MemberListResultV1,
  type RenameWorkspaceResultV1,
  type CreateWorkspaceResultV1,
  type SearchDriftResultV1,
  type SearchReindexResultV1,
  type DesktopCreateLearningRunV2Request,
  type DesktopCardGenerationActivationSelectionV1,
  type DesktopCandidateReviewRequestV2,
  type DesktopCreateCardGenerationRunRequestV2,
  type DesktopRevealCandidateRequestV2,
  type DesktopNoteSaveRequestV1,
  type DesktopLearningRunActionRequestV2,
  type DesktopLearningRunAbandonRequestV2,
  type DesktopPutLearningTaskDraftV2Request,
  type DesktopRecordLearningRunActivityLeaseRequestV2,
  type DesktopSubmitTaskArtifactV2,
  recordLearningRunActivityLeaseOutputV2Schema,
  localApiTrustSchema,
  nonEmptyStringSchema,
  runtimeSnapshotSchema,
  sessionContextSchema,
  companionChatStreamEventV1Schema,
  type ApiConnectionStateV1,
  type CapabilityProjectionV1,
  type CompanionChatStreamEventV1,
  type DeploymentConfigV1,
  type GatewayErrorCode,
  type LocalApiTrustV1,
  type AiDataPolicyV1,
  type NativeCapabilityProjectionV1,
  type RuntimeSnapshotV1,
  type SessionContextV1,
  type WorkspaceAiSettingsV1,
  type WorkspaceContextV1,
  type WorkspaceSummaryV1,
  windowStateSnapshotV1Schema,
  workspaceAiSettingsV1Schema,
  noteDocServerStateV1Schema,
  noteDocStateResultV1Schema,
  noteDocUploadResultV1Schema,
  type NoteDocStateResultV1,
  type NoteDocStreamEventV1,
  type NoteDocUploadResultV1,
} from "@astella/shared/desktop-ipc-contracts";
import {
  desktopSourceListPageSchema,
  desktopSourceDetailSchema,
  desktopSourceCreateResultV1Schema,
  desktopSourceNotesPageSchema,
  desktopNoteListPageSchema,
  desktopNoteVersionListSchema,
  desktopSearchPageSchema,
  type DesktopSourceListPage,
  type DesktopSourceDetail,
  type DesktopSourceCreateResultV1,
  type DesktopSourceCreateRequest,
  type DesktopSourceNotesPage,
  type DesktopSourceNoteResult,
  type DesktopSourceUpdateRequest,
  type DesktopSourceArchiveResult,
  type DesktopSourceReparseResult,
  desktopSourceRestoreResultSchema,
  type DesktopSourceRestoreResult,
  type DesktopNoteListPage,
  type DesktopNoteCreateRequest,
  type DesktopNoteMutationResult,
  type DesktopNoteVersionList,
  type DesktopSearchPage,
  type DesktopAiAuditPageV1,
  desktopAiAuditPageV1Schema,
} from "@astella/shared/desktop-surface-contracts";
import type { GatewayTransport } from "./desktop-gateway-transport";

export async function getSearchDrift(t: GatewayTransport, requestId?: string): Promise<SearchDriftResultV1> {
    await t.ensureConnected(requestId);
    const result = await t.request("/search/drift", { method: "GET" }, true, true, requestId);
    const payload = (result.body ?? {}) as Record<string, unknown>;
    const count = (value: unknown): number | undefined =>
      Array.isArray(value) ? value.length : typeof value === "number" ? value : undefined;
    // 「内容过期」= 标题过期 + 正文过期。只数标题会让"正文过期但标题没变"的漂移
    // 在界面上显示成 `发现漂移：缺失 0、幽灵 0、内容过期 0`——三个 0 配一句"发现漂移"，
    // 用户只能当它坏了（审计 F15 现场读到的就是这三个数）。两类过期都算进来，
    // hasDrift 与这几个计数才是同一件事。
    const staleTitles = count(payload.staleTitles) ?? 0;
    const staleBodies = count(payload.staleBodies) ?? 0;
    const parsed = searchDriftResultV1Schema.safeParse({
      version: 1,
      hasDrift: payload.hasDrift,
      ghosts: count(payload.ghosts),
      missing: count(payload.missing),
      stale: staleTitles + staleBodies,
    });
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function reindexSearch(t: GatewayTransport, requestId?: string): Promise<SearchReindexResultV1> {
    await t.ensureConnected(requestId);
    const result = await t.request("/search/reindex", { method: "POST", body: JSON.stringify({}) }, true, true, requestId);
    const payload = (result.body ?? {}) as Record<string, unknown>;
    const indexed = (payload.indexed ?? {}) as Record<string, unknown>;
    const parsed = searchReindexResultV1Schema.safeParse({
      version: 1,
      deleted: payload.deleted,
      indexedNotes: indexed.note,
      indexedSources: indexed.source,
      indexedObjectives: indexed.objective,
      errors: payload.errors,
      capped: payload.capped,
    });
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function searchGlobal(t: GatewayTransport, queryValue: string, options: { type?: "note" | "source" | "objective"; limit?: number; cursor?: string } = {}, requestId?: string): Promise<DesktopSearchPage> {
    await t.ensureConnected(requestId);
    const query = new URLSearchParams({ q: queryValue });
    if (options.type) query.set("type", options.type);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    // 游标原样透传：它是服务端生成的 keyset 位置，主进程不解释也不重算。
    if (options.cursor !== undefined) query.set("cursor", options.cursor);
    const result = await t.request(`/search?${query.toString()}`, { method: "GET" }, true, true, requestId);
    const parsed = desktopSearchPageSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }
