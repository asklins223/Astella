/**
 * 笔记正文的本机会话缓存（2026-09-30 随 `noteDocLocalSession` 一起搬成模块级）。
 *
 * 它**本来就是进程级**的：一次进程一个网关，缓存跟着进程走。
 * 搬成自由函数之后它没有「this」可挂，所以变成模块级状态——语义不变。
 */
new Map<string, NoteDocLocalSession>()

/**
 * 网关的「笔记」那一族 —— **2026-09-30 从 `DesktopGateway` 类搬出**。
 *
 * ## 最后一块，也是最干净的一块
 *
 * AST 实测：它原先对类状态的依赖有 10 个，**逐个查下来全部是笔记族专属的**
 * （`ensureNoteDocSeeded` / `getCardGeneration*` / `noteDocLocalSession` / `settleNoteDocUpdate`
 * / `getNote` / `getNoteLearningRoundTeaching` / `postNoteLearningRound*`）——
 * **没有一个是跨命名空间的**。所以它们整族跟着走，`note` 不需要任何跨域依赖参数。
 *
 * ## 至此，`DesktopGateway` 的十一个命名空间全部搬空
 *
 * 下面**逐字搬移**：成员由脚本按 TS AST 的精确源区间从 `desktop-gateway.ts` 切出，
 * 只做三处改写——签名前加 `t: GatewayTransport`、`this.transport.` 换成 `t.`、
 * 同族方法互相调用改成直接按函数名并补 `t`。
 */
/**
 * 笔记正文的本机会话缓存（2026-09-30 随 `noteDocLocalSession` 一起搬成模块级）。
 *
 * 它**本来就是进程级**的：一次进程一个网关，缓存跟着进程走。
 * 搬成自由函数之后它没有 `this` 可挂，所以变成模块级状态——语义不变。
 */
const noteDocLocalSessions = new Map<string, NoteDocLocalSession>();

const NOTE_DOC_PENDING_MAX = 200;
export type NoteDocSyncOutcome = {
  via: "uploaded" | "unchanged" | "queued";
  revision: number;
  savedAt: string;
};
function isOfflineFailure(error: unknown): boolean {
  return error instanceof DesktopGatewayFailure
    && (error.code === "api_unavailable" || error.code === "network_timeout");
}
export type NoteDocLocalSession = {
  state: NoteDocState;
  /** 是否已经从服务端取到过起点。没取到过就不能本机差分（见 `noteDocLocalSessions`）。 */
  seeded: boolean;
  revision: number;
  savedAt: string;
  /** 攒着待重发的增量，按提交顺序。 */
  pending: string[];
  /**
   * 最后一次看到这篇归属时留下的那一位。离线打开这篇时"要不要建长连接"以它为准——
   * 猜不得：猜成 shared 会给一篇「仅自己可见」的笔记开一条实时连接。
   */
  shareScope: NoteShareScopeV1 | null;
};
import { NOTE_DOC_PREFIX, noteDocStreamUrl, toNoteDocStreamEvent } from "./note-doc-transport";
import type { NoteDocStreamEventV1 } from "@ailearn/shared/desktop-ipc-contracts";
import type { NoteDocWatchHandle } from "./note-doc-transport";
import type { NoteDocTransport } from "./note-doc-transport";
import type { NoteDocState } from "./note-doc-state";
import {
  DesktopGatewayFailure,
} from "./desktop-gateway-failure";
import {
  safeUuid,
} from "./desktop-gateway-uuid";
import {
  createNoteDocState,
  mergeNoteDocUpdates,
} from "./note-doc-state.ts";
import {
  CardActivationReceiptDesktopV1,
  CardGenerationCancelResultV1,
  CardGenerationCandidateListV1,
  CardGenerationCloseResultV1,
  CardGenerationExposureEligibilityV1,
  CardGenerationJobAcceptedV1,
  CardGenerationRetryResultV1,
  CardGenerationReviewResultV1,
  CardGenerationRunServerViewV2,
  CardGenerationRunSnapshotV1,
  cardActivationReceiptDesktopV1Schema,
  cardGenerationCancelResultV1Schema,
  cardGenerationCandidateListV1Schema,
  cardGenerationCloseResultV1Schema,
  cardGenerationExposureEligibilityV1Schema,
  cardGenerationJobAcceptedV1Schema,
  cardGenerationRetryResultV1Schema,
  cardGenerationReviewResultV1Schema,
  cardGenerationRunServerViewV2Schema,
  cardGenerationRunSnapshotV1Schema,
  projectCardActivationReceiptV1,
  projectCardGenerationRunSnapshotV1,
} from "@ailearn/shared/card-generation-desktop-contracts";
import {
  activateCardCandidatesRequestV2Schema,
  candidateActionCommandV2Schema,
  candidateRevealV2Schema,
  cardActivationReceiptV2Schema,
  cardPlanV2Schema,
} from "@ailearn/shared/card-generation-v2-contracts";
import {
  computeClientReviewHashV2,
} from "@ailearn/shared/card-generation-v2-hashing";
import {
  DesktopCandidateReviewRequestV2,
  DesktopCardGenerationActivationSelectionV1,
  DesktopCreateCardGenerationRunRequestV2,
  DesktopNoteSaveRequestV1,
  DesktopRevealCandidateRequestV2,
  NoteDocStateResultV1,
  NoteDocUploadResultV1,
  noteDocServerStateV1Schema,
  noteDocUploadResultV1Schema,
} from "@ailearn/shared/desktop-ipc-contracts";
import {
  DesktopNoteCreateRequest,
  DesktopNoteListPage,
  DesktopNoteMutationResult,
  DesktopNoteVersionList,
  desktopNoteListPageSchema,
  desktopNoteVersionListSchema,
} from "@ailearn/shared/desktop-surface-contracts";
import {
  NoteAnnotationCommandV1,
  createNoteAnnotationTaskV1Schema,
  noteAnnotationLatestTaskQueryV1Schema,
  noteAnnotationLatestTaskV1Schema,
  noteAnnotationPageV1Schema,
  noteAnnotationTaskV1Schema,
  noteAnnotationWriteResultV1Schema,
} from "@ailearn/shared/note-annotation-contracts";
import {
  confirmNoteExpansionTaskV1Schema,
  createNoteExpansionTaskV1Schema,
  noteExpansionBatchWriteResultV1Schema,
  noteExpansionLatestTaskQueryV1Schema,
  noteExpansionLatestTaskV1Schema,
  noteExpansionListQueryV1Schema,
  noteExpansionPageV1Schema,
  noteExpansionReviewV1Schema,
  noteExpansionTaskV1Schema,
} from "@ailearn/shared/note-expansion-contracts";
import {
  NOTE_IMAGE_UPLOAD_MAX_BYTES,
  NoteImageUploadRequestV1,
  NoteImageUploadResultV1,
  noteImageUploadResultV1Schema,
} from "@ailearn/shared/note-image-upload-contracts";
import {
  createNoteDynamicArtifactTaskV1Schema,
  noteLearningArtifactPageV1Schema,
  noteLearningArtifactTaskListQueryV1Schema,
  noteLearningArtifactTaskPageV1Schema,
  noteLearningArtifactTaskV1Schema,
} from "@ailearn/shared/note-learning-artifact-contracts";
import {
  NoteReflectionCommandV1,
  noteReflectionPageV1Schema,
  noteReflectionWriteResultV1Schema,
} from "@ailearn/shared/note-learning-reflection-contracts";
import {
  NoteLearningRoundHistoryV1,
  NoteLearningRoundPersonalHistoryV1,
  NoteLearningRoundV1Wire,
  NoteLearningRoundViewV1,
  ROUND_HISTORY_DEFAULT_LIMIT_V1,
  RoundTeachingViewV1,
  noteLearningRoundHistoryPageV1Schema,
  noteLearningRoundPersonalHistoryPageV1Schema,
  noteLearningRoundViewV1Schema,
  roundTeachingViewV1Schema,
} from "@ailearn/shared/note-learning-round-contracts";
import {
  createNoteOverviewTaskV1Schema,
  noteOverviewLatestTaskQueryV1Schema,
  noteOverviewLatestTaskV1Schema,
  noteOverviewPageV1Schema,
  noteOverviewTaskV1Schema,
} from "@ailearn/shared/note-overview-contracts";
import {
  NoteDetailV1,
  noteDetailV1Schema,
} from "@ailearn/shared/note-projection-contracts";
import {
  noteRecallActionResultV1Schema,
  noteRecallActionV1Schema,
  noteRecallPageV1Schema,
  noteRecallStartInputV1Schema,
  noteRecallStartResultV1Schema,
} from "@ailearn/shared/note-recall-contracts";
import {
  NoteRouteCoverageV1,
  noteRouteCoverageV1Schema,
} from "@ailearn/shared/note-route-coverage-v2";
import {
  NoteSaveReceiptV1,
  noteSaveReceiptV1Schema,
} from "@ailearn/shared/note-save-contracts";
import {
  NoteShareScopeReceiptV1,
  NoteShareScopeV1,
  noteShareScopeReceiptV1Schema,
} from "@ailearn/shared/note-share-contracts";
import {
  z,
} from "zod";
import type { GatewayTransport } from "./desktop-gateway-transport";

export async function ensureNoteDocSeeded(t: GatewayTransport, safeNoteId: string, requestId?: string): Promise<void> {
    const session = noteDocLocalSession(t, safeNoteId);
    if (session.seeded) return;
    const start = await t.request(
      `/v2/notes/${safeNoteId}/doc-state`,
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = noteDocServerStateV1Schema.safeParse(start.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    session.state.seed(parsed.data.update);
    session.seeded = true;
    session.revision = parsed.data.revision;
    session.savedAt = parsed.data.savedAt;
    // 归属也一并留下：这条路上没走过 `getNoteDocState`，不落这一位的话，
    // 本机那份永远"不可持久化"，离线队列又只能在内存里活一次。
    session.shareScope = parsed.data.shareScope;
  }

export async function getCardGenerationExposureEligibility(t: GatewayTransport, 
    runId: string,
    candidateId: string,
    revision: number,
    requestId?: string,
  ): Promise<CardGenerationExposureEligibilityV1> {
    await t.ensureConnected(requestId);
    const query = new URLSearchParams({ revision: String(revision) });
    const result = await t.request(
      `/v2/card-generation-runs/${safeUuid(runId)}/candidates/${safeUuid(candidateId)}/exposure?${query.toString()}`,
      { method: "GET" },
      true,
      true,
      requestId,
    );
    return cardGenerationExposureEligibilityV1Schema.parse(result.body);
  }

export async function getCardGenerationPlan(t: GatewayTransport, runId: string, requestId?: string) {
    await t.ensureConnected(requestId);
    const result = await t.request(
      `/v2/card-generation-runs/${safeUuid(runId)}/plan`,
      { method: "GET" },
      true,
      true,
      requestId,
    );
    return cardPlanV2Schema.parse(result.body);
  }

export async function getCardGenerationRunServerView(t: GatewayTransport, runId: string, requestId?: string): Promise<CardGenerationRunServerViewV2> {
    await t.ensureConnected(requestId);
    const result = await t.request(
      `/v2/card-generation-runs/${safeUuid(runId)}`,
      { method: "GET" },
      true,
      true,
      requestId,
    );
    return cardGenerationRunServerViewV2Schema.parse(result.body);
  }

export function noteDocLocalSession(t: GatewayTransport, noteId: string): NoteDocLocalSession {
    const existing = noteDocLocalSessions.get(noteId);
    if (existing) return existing;
    const created: NoteDocLocalSession = {
      state: createNoteDocState(),
      seeded: false,
      revision: 0,
      savedAt: "",
      pending: [],
      shareScope: null,
    };
    noteDocLocalSessions.set(noteId, created);
    return created;
  }

export async function settleNoteDocUpdate(t: GatewayTransport, 
    safeNoteId: string,
    produced: string | null,
    requestId?: string,
  ): Promise<NoteDocSyncOutcome> {
    const session = noteDocLocalSession(t, safeNoteId);
    if (produced !== null) {
      if (session.pending.length >= NOTE_DOC_PENDING_MAX) {
        // 不再往上堆：把"攒了多少"如实报出来，界面才能说"先联网再改"。
        throw new DesktopGatewayFailure("result_unknown", "resync_first");
      }
      session.pending.push(produced);
    }
    if (session.pending.length === 0) {
      return { via: "unchanged", revision: session.revision, savedAt: session.savedAt };
    }
    const merged = mergeNoteDocUpdates(session.pending);
    let receipt: NoteDocUploadResultV1;
    try {
      receipt = await deps.uploadNoteDocUpdate(t, safeNoteId, merged, requestId);
    } catch (error) {
      if (!isOfflineFailure(error)) {
        // **失败的那一条留在队列里**，不能退掉。它此刻已经并进本机这份文档了，退掉
        // 之后的下一次写会走"这次没产生新东西"那条分支、如实回 `unchanged`——而界面
        // 把 `unchanged` 当"已保存"（清未提交标记、清草稿），于是这次失败变成一次
        // 静默丢字：文档里有、服务端没有，屏上还写着"已自动保存"。
        // 留着它，下一次写会把同一批再交一次，失败也照样**喊出来**。
        // 重发的代价是有界的：只有用户再敲字（或点重试）才会触发下一次尝试，不是定时
        // 轮询；而"重发一百次也是同一个结果"的那类错误本来就该让用户看见，不是咽下去。
        throw error;
      }
      return { via: "queued", revision: session.revision, savedAt: session.savedAt };
    }
    session.pending = [];
    session.revision = receipt.revision;
    session.savedAt = receipt.savedAt;
    return { via: "uploaded", revision: receipt.revision, savedAt: receipt.savedAt };
  }

export async function actOnNoteRecall(t: GatewayTransport, noteId: string, recallId: string, action: unknown, requestId?: string) {
    await t.ensureConnected(requestId);
    const input = noteRecallActionV1Schema.parse(action);
    const result = await t.request(`/v2/notes/${safeUuid(noteId)}/recalls/${safeUuid(recallId)}/actions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }, true, true, requestId);
    if (result.status >= 300) throw t.mapResponseError(result.status, result.headers);
    const parsed = noteRecallActionResultV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function activateCardGeneration(t: GatewayTransport, 
    runId: string,
    request: DesktopCardGenerationActivationSelectionV1,
    commandId: string,
    requestId?: string,
  ): Promise<CardActivationReceiptDesktopV1> {
    await t.ensureConnected(requestId);
    if (request.runId !== runId) throw new DesktopGatewayFailure("invalid_request", "user_action");
    try {
      const server = await getCardGenerationRunServerView(t, runId, requestId);
      const plan = await getCardGenerationPlan(t, runId, requestId);
      // Activation confirmation must be based on current-user, exact-revision
      // server state—not renderer/session memory. Any unavailable/invalid
      // preflight fails closed before the activation POST is attempted.
      for (const selected of request.selectedCandidates) {
        const exposure = await getCardGenerationExposureEligibility(t, 
          runId,
          selected.candidateId,
          selected.revision,
          requestId,
        );
        if (exposure.exposureStatus === "unknown" || exposure.initialValidationPolicyEffect === "unknown") {
          throw new DesktopGatewayFailure("result_unknown", "resync_first");
        }
      }
      const clientReviewHash = computeClientReviewHashV2({
        runId,
        expectedReviewDraftRevision: request.expectedReviewDraftRevision,
        selected: request.selectedCandidates.map((selected) => ({
          candidateId: selected.candidateId,
          revision: selected.revision,
          revisionHash: selected.revisionHash,
        })),
        reviewUiContractVersion: "review-ui-v1",
      });
      const body = activateCardCandidatesRequestV2Schema.parse({
        version: 2,
        runId,
        sourceSnapshotHash: server.sourceSnapshotHash,
        semanticSpecHash: server.semanticSpecHash,
        inputSnapshotHash: server.inputSnapshotHash,
        expectedCardContentEpoch: server.cardContentEpoch,
        planRevisionId: plan.planRevisionId,
        expectedPlanVersion: plan.planVersion,
        planHash: plan.planHash,
        selectedCandidates: request.selectedCandidates.map((selected) => ({
          ...selected,
          qualityReportHashes: [],
        })),
        existingLifecycleActions: request.existingLifecycleActions,
        expectedReviewDraftRevision: request.expectedReviewDraftRevision,
        clientReviewHash,
        // 那一档原样带过去，不在这里替用户决定。**不写成 `=== true ? {…} : {}`**：
        // 服务端把这一格算进请求哈希（缺省与 false 折成同一档），所以这一发到底要不要
        // 排期必须跟着**这一次命令**走，不能由传输层补一个默认值。
        startReviewScheduling: request.startReviewScheduling,
      });
      const result = await t.request(
        `/v2/card-generation-runs/${safeUuid(runId)}/activate`,
        {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "X-Idempotency-Key": t.idempotencyKey("cardGeneration-activate", commandId) },
        },
        true,
        true,
        requestId,
      );
      const receipt = cardActivationReceiptV2Schema.parse(result.body);
      return cardActivationReceiptDesktopV1Schema.parse(projectCardActivationReceiptV1(receipt));
    } catch (error) {
      if (error instanceof DesktopGatewayFailure && error.code === "api_unavailable") {
        throw new DesktopGatewayFailure("result_unknown", "resync_first");
      }
      throw error;
    }
  }

export async function cancelCardGeneration(t: GatewayTransport, runId: string, _commandId: string, requestId?: string): Promise<CardGenerationCancelResultV1> {
    await t.ensureConnected(requestId);
    try {
      const result = await t.request(
        `/v2/card-generation-runs/${safeUuid(runId)}/cancel`,
        { method: "POST" },
        true,
        true,
        requestId,
      );
      return cardGenerationCancelResultV1Schema.parse(result.body);
    } catch (error) {
      if (error instanceof DesktopGatewayFailure && error.code === "api_unavailable") {
        throw new DesktopGatewayFailure("result_unknown", "resync_first");
      }
      throw error;
    }
  }

export async function closeCardGeneration(t: GatewayTransport, runId: string, expectedReviewDraftRevision: number, _commandId: string, requestId?: string): Promise<CardGenerationCloseResultV1> {
    await t.ensureConnected(requestId);
    try {
      const result = await t.request(
        `/v2/card-generation-runs/${safeUuid(runId)}/close`,
        {
          method: "POST",
          body: JSON.stringify({ expectedReviewDraftRevision }),
        },
        true,
        true,
        requestId,
      );
      return cardGenerationCloseResultV1Schema.parse(result.body);
    } catch (error) {
      if (error instanceof DesktopGatewayFailure && error.code === "api_unavailable") {
        throw new DesktopGatewayFailure("result_unknown", "resync_first");
      }
      throw error;
    }
  }

export async function closeNoteLearningRound(t: GatewayTransport, 
    input: { roundId: string; expectedRevision: number; outcome: "completed" | "partial" },
    requestId?: string,
  ): Promise<NoteLearningRoundV1Wire> {
    return postNoteLearningRoundAction(t, 
      `/v2/note-learning-rounds/${safeUuid(input.roundId)}`,
      { expectedRevision: input.expectedRevision, action: { kind: "close", outcome: input.outcome } },
      requestId,
      "PATCH",
    );
  }

export async function confirmNoteExpansionTask(t: GatewayTransport, noteId: string, taskId: string, request: unknown, requestId?: string) {
    await t.ensureConnected(requestId);
    const input = confirmNoteExpansionTaskV1Schema.parse(request);
    const result = await t.request(`/v2/notes/${safeUuid(noteId)}/expansion-tasks/${safeUuid(taskId)}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }, true, true, requestId);
    if (result.status >= 300) throw t.mapResponseError(result.status, result.headers);
    const parsed = noteExpansionBatchWriteResultV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function createNote(t: GatewayTransport, request: DesktopNoteCreateRequest, requestId?: string): Promise<NoteDetailV1> {
    await t.ensureConnected(requestId);
    const result = await t.request(
      "/notes",
      { method: "POST", body: JSON.stringify(request) },
      true,
      true,
      requestId,
    );
    const created = z.object({ note: z.object({ id: z.string().uuid() }).passthrough() }).passthrough().safeParse(result.body);
    if (!created.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    try {
      return await getNote(t, created.data.note.id, requestId);
    } catch {
      throw new DesktopGatewayFailure("result_unknown", "resync_first");
    }
  }

export async function createNoteLearningRound(t: GatewayTransport, 
    input: {
      noteId: string;
      drivingQuestion?: string;
      drivingQuestionSource: "suggested" | "user_rewritten" | "user_authored";
    },
    requestId?: string,
  ): Promise<NoteLearningRoundV1Wire> {
    await t.ensureConnected(requestId);
    const result = await t.request(
      "/v2/note-learning-rounds",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          noteId: input.noteId,
          drivingQuestion: input.drivingQuestion,
          drivingQuestionSource: input.drivingQuestionSource,
        }),
      },
      true,
      true,
      requestId,
    );
    const parsed = noteLearningRoundViewV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data.round;
  }

export async function deleteNote(t: GatewayTransport, noteId: string, requestId?: string): Promise<DesktopNoteMutationResult> {
    await t.ensureConnected(requestId);
    await t.request(`/notes/${safeUuid(noteId)}`, { method: "DELETE" }, true, true, requestId);
    return { noteId, status: "deleted" };
  }

export async function explainNoteLearningRoundTeaching(t: GatewayTransport, 
    input: { roundId: string; expectedRevision: number; regenerate?: boolean; personalReflectionIds?: string[] },
    requestId?: string,
  ): Promise<RoundTeachingViewV1> {
    await t.ensureConnected(requestId);
    const result = await t.request(
      `/v2/note-learning-rounds/${safeUuid(input.roundId)}/teaching`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        // `regenerate` 缺省不带（服务端默认 false = 同快照同问题复用既有那条）。
        body: JSON.stringify({
          expectedRevision: input.expectedRevision,
          ...(input.regenerate ? { regenerate: true } : {}),
          ...(input.personalReflectionIds?.length ? { personalReflectionIds: input.personalReflectionIds.map((id) => safeUuid(id)) } : {}),
        }),
      },
      true,
      true,
      requestId,
    );
    if (result.status >= 300) throw t.mapResponseError(result.status, result.headers);
    const parsed = roundTeachingViewV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function getCardGenerationCandidates(t: GatewayTransport, runId: string, requestId?: string): Promise<CardGenerationCandidateListV1> {
    await t.ensureConnected(requestId);
    const result = await t.request(
      `/v2/card-generation-runs/${safeUuid(runId)}/candidates`,
      { method: "GET" },
      true,
      true,
      requestId,
    );
    return cardGenerationCandidateListV1Schema.parse(result.body);
  }

export async function getCardGenerationExposure(t: GatewayTransport, 
    runId: string,
    candidateId: string,
    revision: number,
    requestId?: string,
  ): Promise<CardGenerationExposureEligibilityV1> {
    return getCardGenerationExposureEligibility(t, runId, candidateId, revision, requestId);
  }

export async function getCardGenerationRun(t: GatewayTransport, runId: string, requestId?: string): Promise<CardGenerationRunSnapshotV1> {
    const server = await getCardGenerationRunServerView(t, runId, requestId);
    return cardGenerationRunSnapshotV1Schema.parse(projectCardGenerationRunSnapshotV1(server));
  }

export async function getLatestCardGenerationRun(t: GatewayTransport, noteId: string, requestId?: string): Promise<CardGenerationRunSnapshotV1 | null> {
    await t.ensureConnected(requestId);
    try {
      const result = await t.request(
        `/v2/notes/${safeUuid(noteId)}/card-generation-runs/latest`,
        { method: "GET" },
        true,
        true,
        requestId,
      );
      const server = cardGenerationRunServerViewV2Schema.parse(result.body);
      return cardGenerationRunSnapshotV1Schema.parse(projectCardGenerationRunSnapshotV1(server));
    } catch (error) {
      if (error instanceof DesktopGatewayFailure && error.code === "not_found") return null;
      throw error;
    }
  }

export async function getLatestNoteAnnotationTask(t: GatewayTransport, noteId: string, query: unknown, requestId?: string) {
    await t.ensureConnected(requestId);
    const input = noteAnnotationLatestTaskQueryV1Schema.parse(query);
    const search = new URLSearchParams({ noteVersionId: safeUuid(input.noteVersionId) });
    const result = await t.request(`/v2/notes/${safeUuid(noteId)}/annotation-tasks/latest?${search.toString()}`, { method: "GET" }, true, true, requestId);
    if (result.status >= 300) throw t.mapResponseError(result.status, result.headers);
    const parsed = noteAnnotationLatestTaskV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function getLatestNoteOverviewTask(t: GatewayTransport, noteId: string, query: unknown, requestId?: string) {
    await t.ensureConnected(requestId);
    const input = noteOverviewLatestTaskQueryV1Schema.parse(query);
    const search = new URLSearchParams({ noteVersionId: safeUuid(input.noteVersionId) });
    const result = await t.request(`/v2/notes/${safeUuid(noteId)}/overview-tasks/latest?${search.toString()}`, { method: "GET" }, true, true, requestId);
    if (result.status >= 300) throw t.mapResponseError(result.status, result.headers);
    const parsed = noteOverviewLatestTaskV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function getMyLearningRoundHistory(t: GatewayTransport, 
    input: { limit?: number; before?: string },
    requestId?: string,
  ): Promise<NoteLearningRoundPersonalHistoryV1> {
    await t.ensureConnected(requestId);
    const params = new URLSearchParams({ limit: String(input.limit ?? ROUND_HISTORY_DEFAULT_LIMIT_V1) });
    if (input.before) params.set("before", safeUuid(input.before));
    const result = await t.request(
      `/v2/note-learning-rounds?${params.toString()}`,
      { method: "GET" },
      true,
      false,
      requestId,
    );
    if (result.status >= 300) throw t.mapResponseError(result.status, result.headers);
    const parsed = noteLearningRoundPersonalHistoryPageV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function getNote(t: GatewayTransport, noteId: string, requestId?: string): Promise<NoteDetailV1> {
    await t.ensureConnected(requestId);
    const result = await t.request(`/v2/notes/${safeUuid(noteId)}`, { method: "GET" }, true, true, requestId);
    const parsed = noteDetailV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function getNoteAnnotationTask(t: GatewayTransport, noteId: string, taskId: string, requestId?: string) {
    await t.ensureConnected(requestId);
    const result = await t.request(`/v2/notes/${safeUuid(noteId)}/annotation-tasks/${safeUuid(taskId)}`, { method: "GET" }, true, true, requestId);
    if (result.status >= 300) throw t.mapResponseError(result.status, result.headers);
    const parsed = noteAnnotationTaskV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function getNoteDocState(t: GatewayTransport, noteId: string, requestId?: string): Promise<NoteDocStateResultV1> {
    await t.ensureConnected(requestId);
    const safeNoteId = safeUuid(noteId);
    const result = await t.request(`/v2/notes/${safeNoteId}/doc-state`, { method: "GET" }, true, true, requestId);
    const parsed = noteDocServerStateV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    // yjs 编码只活在这一层：主进程解成视图再交给界面。让界面也拿编码，就得在渲染进程
    // 再装一份 CRDT 依赖，而它要显示的本来就是块。
    // 顺手把这篇的本机会话打好底。**离线编辑的前提是"曾经拿到过起点"**：没有共同的
    // 祖先就凭空造不出增量（从行里拼一棵树会被服务端当成另一篇文档，一改就复制块）。
    // 所以取起点的那一刻（界面打开这篇）就把状态留下，而不是等第一次提交才去取——
    // 那时候可能已经没有网了。
    const session = noteDocLocalSession(t, safeNoteId);
    // 服务端这一刻的那份状态**每次都并进来**，不是只有第一次。
    //
    // 跳过它的后果不是省一次合并，而是这台机器此后一直拿着"第一次打开这一篇时"的那份
    // 正文：个人空间没有长连接（决定 7b），另一个窗口写进去的字没有任何别的通道能到
    // 这一屏，于是用户看到的是十分钟前的笔记，而他刚在另一个窗口改过。CRDT 的合并是
    // 纯加法——本机攒着没交出去的增量一条都不会因此丢掉（那些在 `pending` 里，且同在
    // 这份文档里），所以"每次都并"只有好处。
    session.state.seed(parsed.data.update);
    if (!session.seeded) {
      session.seeded = true;
      session.revision = parsed.data.revision;
      session.savedAt = parsed.data.savedAt;
    }
    // 归属每次都记：一篇从 shared 撤回成 private 的笔记，本机下一次离线打开时
    // 要按最新那一位决定建不建连接。
    session.shareScope = parsed.data.shareScope;
    // 起点交的是**这一台机器上看到的那份状态**，不是服务端那一串原字节：本机如果已经
    // 攒了没送出去的编辑，界面重启后必须接着它们，而不是从服务端那份重开一篇、
    // 再把没送出去的改动当成别人的覆盖掉。`seed` 之后 `encodeState()` 就是两者合并的结果。
    return {
      update: session.state.encodeState(),
      revision: parsed.data.revision,
      backfilled: parsed.data.backfilled,
      shareScope: parsed.data.shareScope,
    };
  }

export async function getNoteExpansionTask(t: GatewayTransport, noteId: string, taskId: string, requestId?: string) {
    await t.ensureConnected(requestId);
    const result = await t.request(`/v2/notes/${safeUuid(noteId)}/expansion-tasks/${safeUuid(taskId)}`, { method: "GET" }, true, true, requestId);
    if (result.status >= 300) throw t.mapResponseError(result.status, result.headers);
    const parsed = noteExpansionTaskV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function getNoteLearningArtifactTask(t: GatewayTransport, noteId: string, taskId: string, requestId?: string) {
    await t.ensureConnected(requestId);
    const result = await t.request(`/v2/notes/${safeUuid(noteId)}/learning-artifact-tasks/${safeUuid(taskId)}`, { method: "GET" }, true, true, requestId);
    if (result.status >= 300) throw t.mapResponseError(result.status, result.headers);
    const parsed = noteLearningArtifactTaskV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function getNoteLearningRoundHistory(t: GatewayTransport, 
    input: { noteId: string; limit?: number; before?: string },
    requestId?: string,
  ): Promise<NoteLearningRoundHistoryV1> {
    await t.ensureConnected(requestId);
    const params = new URLSearchParams({ limit: String(input.limit ?? ROUND_HISTORY_DEFAULT_LIMIT_V1) });
    if (input.before) params.set("before", safeUuid(input.before));
    const result = await t.request(
      `/v2/notes/${safeUuid(input.noteId)}/learning-rounds?${params.toString()}`,
      { method: "GET" },
      true,
      false,
      requestId,
    );
    if (result.status >= 300) throw t.mapResponseError(result.status, result.headers);
    // 整份过合同（含 `hasMore` ⇒ `nextCursor` 那条 refine）：形状不对就报合同不受支持，
    // 不在这里替服务端补一个游标。
    const parsed = noteLearningRoundHistoryPageV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function getNoteLearningRoundTeaching(t: GatewayTransport, roundId: string, requestId?: string): Promise<RoundTeachingViewV1> {
    await t.ensureConnected(requestId);
    const result = await t.request(
      `/v2/note-learning-rounds/${safeUuid(roundId)}/teaching`,
      { method: "GET" },
      true,
      false,
      requestId,
    );
    if (result.status >= 300) throw t.mapResponseError(result.status, result.headers);
    const parsed = roundTeachingViewV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function getNoteOverviewTask(t: GatewayTransport, noteId: string, taskId: string, requestId?: string) {
    await t.ensureConnected(requestId);
    const result = await t.request(`/v2/notes/${safeUuid(noteId)}/overview-tasks/${safeUuid(taskId)}`, { method: "GET" }, true, true, requestId);
    if (result.status >= 300) throw t.mapResponseError(result.status, result.headers);
    const parsed = noteOverviewTaskV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function getNoteRouteCoverage(t: GatewayTransport, 
    input: { noteId: string },
    requestId?: string,
  ): Promise<NoteRouteCoverageV1> {
    await t.ensureConnected(requestId);
    const result = await t.request(
      `/v2/notes/${safeUuid(input.noteId)}/learning-route`,
      { method: "GET" },
      true,
      false,
      requestId,
    );
    if (result.status >= 300) throw t.mapResponseError(result.status, result.headers);
    const parsed = noteRouteCoverageV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function getOpenNoteLearningRound(t: GatewayTransport, noteId: string, requestId?: string): Promise<NoteLearningRoundViewV1 | null> {
    await t.ensureConnected(requestId);
    const result = await t.request(
      `/v2/notes/${safeUuid(noteId)}/learning-round`,
      { method: "GET" },
      true,
      false,
      requestId,
      undefined,
      true,
    );
    if (result.status >= 300) {
      const roundNotFound = z.object({ error: z.literal("round_not_found") }).safeParse(result.body);
      if (result.status === 404 && roundNotFound.success) return null;
      throw t.mapResponseError(result.status, result.headers);
    }
    const parsed = noteLearningRoundViewV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function latestNoteExpansionTask(t: GatewayTransport, noteId: string, query: unknown, requestId?: string) {
    await t.ensureConnected(requestId);
    const input = noteExpansionLatestTaskQueryV1Schema.parse(query);
    const params = new URLSearchParams({ noteVersionId: safeUuid(input.noteVersionId) });
    const result = await t.request(`/v2/notes/${safeUuid(noteId)}/expansion-tasks/latest?${params}`, { method: "GET" }, true, true, requestId);
    if (result.status >= 300) throw t.mapResponseError(result.status, result.headers);
    const parsed = noteExpansionLatestTaskV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function listNoteAnnotations(t: GatewayTransport, input: { noteId: string; noteVersionId?: string; before?: string }, requestId?: string) {
    await t.ensureConnected(requestId);
    const query = new URLSearchParams();
    if (input.noteVersionId) query.set("noteVersionId", safeUuid(input.noteVersionId));
    if (input.before) query.set("before", safeUuid(input.before));
    const encodedQuery = query.toString();
    const suffix = encodedQuery ? `?${encodedQuery}` : "";
    const result = await t.request(`/v2/notes/${safeUuid(input.noteId)}/annotations${suffix}`, { method: "GET" }, true, true, requestId);
    if (result.status >= 300) throw t.mapResponseError(result.status, result.headers);
    const parsed = noteAnnotationPageV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function listNoteExpansions(t: GatewayTransport, noteId: string, query: unknown = {}, requestId?: string) {
    await t.ensureConnected(requestId);
    const input = noteExpansionListQueryV1Schema.parse(query);
    const params = new URLSearchParams();
    if (input.beforeCreatedAt) params.set("beforeCreatedAt", input.beforeCreatedAt);
    if (input.beforeExpansionId) params.set("beforeExpansionId", safeUuid(input.beforeExpansionId));
    const encodedQuery = params.toString();
    const suffix = encodedQuery ? `?${encodedQuery}` : "";
    const result = await t.request(`/v2/notes/${safeUuid(noteId)}/expansions${suffix}`, { method: "GET" }, true, true, requestId);
    if (result.status >= 300) throw t.mapResponseError(result.status, result.headers);
    const parsed = noteExpansionPageV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function listNoteLearningArtifactTasks(t: GatewayTransport, noteId: string, query: unknown, requestId?: string) {
    await t.ensureConnected(requestId);
    const input = noteLearningArtifactTaskListQueryV1Schema.parse(query);
    const search = new URLSearchParams({ noteVersionId: safeUuid(input.noteVersionId) });
    const result = await t.request(`/v2/notes/${safeUuid(noteId)}/learning-artifact-tasks?${search.toString()}`, { method: "GET" }, true, true, requestId);
    if (result.status >= 300) throw t.mapResponseError(result.status, result.headers);
    const parsed = noteLearningArtifactTaskPageV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function listNoteLearningArtifacts(t: GatewayTransport, input: { noteId: string; before?: string }, requestId?: string) {
    await t.ensureConnected(requestId);
    const query = new URLSearchParams();
    if (input.before) query.set("before", safeUuid(input.before));
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    const result = await t.request(`/v2/notes/${safeUuid(input.noteId)}/learning-artifacts${suffix}`, { method: "GET" }, true, true, requestId);
    if (result.status >= 300) throw t.mapResponseError(result.status, result.headers);
    const parsed = noteLearningArtifactPageV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function listNoteOverviews(t: GatewayTransport, input: { noteId: string; before?: string }, requestId?: string) {
    await t.ensureConnected(requestId);
    const query = new URLSearchParams();
    if (input.before) query.set("before", safeUuid(input.before));
    const encodedQuery = query.toString();
    const suffix = encodedQuery ? `?${encodedQuery}` : "";
    const result = await t.request(`/v2/notes/${safeUuid(input.noteId)}/overviews${suffix}`, { method: "GET" }, true, true, requestId);
    if (result.status >= 300) throw t.mapResponseError(result.status, result.headers);
    const parsed = noteOverviewPageV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function listNoteRecallRecords(t: GatewayTransport, input: { noteId: string; before?: string }, requestId?: string) {
    await t.ensureConnected(requestId);
    const query = new URLSearchParams();
    if (input.before) query.set("before", safeUuid(input.before));
    const encodedQuery = query.toString();
    const suffix = encodedQuery ? `?${encodedQuery}` : "";
    const result = await t.request(`/v2/notes/${safeUuid(input.noteId)}/recalls${suffix}`, { method: "GET" }, true, true, requestId);
    if (result.status >= 300) throw t.mapResponseError(result.status, result.headers);
    const parsed = noteRecallPageV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function listNoteReflections(t: GatewayTransport, input: { noteId: string; roundId?: string; before?: string; reflectionId?: string }, requestId?: string) {
    await t.ensureConnected(requestId);
    const query = new URLSearchParams();
    if (input.roundId) query.set("roundId", safeUuid(input.roundId));
    if (input.before) query.set("before", safeUuid(input.before));
    if (input.reflectionId) query.set("reflectionId", safeUuid(input.reflectionId));
    const result = await t.request(`/v2/notes/${safeUuid(input.noteId)}/learning-reflections?${query}`, { method: "GET" }, true, true, requestId);
    if (result.status >= 300) throw t.mapResponseError(result.status, result.headers);
    const parsed = noteReflectionPageV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function listNoteVersions(t: GatewayTransport, 
    noteId: string,
    currentVersionId: string,
    limit: number,
    requestId?: string,
  ): Promise<DesktopNoteVersionList> {
    await t.ensureConnected(requestId);
    const result = await t.request(
      `/notes/${safeUuid(noteId)}/versions?limit=${encodeURIComponent(String(limit))}`,
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = z.object({
      items: z.array(z.object({
        id: z.string().uuid(),
        versionNo: z.number().int().min(1),
        createdAt: z.string(),
        updatedAt: z.string(),
      }).passthrough()).max(200),
    }).passthrough().safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return desktopNoteVersionListSchema.parse({
      noteId,
      total: parsed.data.items.length,
      items: parsed.data.items.map((item) => ({
        versionId: item.id,
        versionNo: item.versionNo,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        current: item.id === currentVersionId,
      })),
    });
  }

export async function listNotes(t: GatewayTransport, options: { cursor?: string; limit?: number; trashed?: boolean } = {}, requestId?: string): Promise<DesktopNoteListPage> {
    await t.ensureConnected(requestId);
    const query = new URLSearchParams();
    if (options.cursor) query.set("cursor", options.cursor);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.trashed !== undefined) query.set("trashed", options.trashed ? "true" : "false");
    const suffix = query.toString();
    const result = await t.request(`/notes${suffix ? `?${suffix}` : ""}`, { method: "GET" }, true, true, requestId);
    const parsed = desktopNoteListPageSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function prepareNoteLearningRoundPractice(t: GatewayTransport, 
    input: { roundId: string; expectedRevision: number }, requestId?: string,
  ): Promise<RoundTeachingViewV1> {
    await t.ensureConnected(requestId);
    const result = await t.request(
      `/v2/note-learning-rounds/${safeUuid(input.roundId)}/practice-preparation`,
      { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: input.expectedRevision }) },
      true, true, requestId,
    );
    if (result.status >= 300) throw t.mapResponseError(result.status, result.headers);
    const parsed = roundTeachingViewV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function reopenNoteLearningRound(t: GatewayTransport, 
    input: { roundId: string; expectedRevision: number },
    requestId?: string,
  ): Promise<NoteLearningRoundViewV1> {
    return postNoteLearningRoundView(t, 
      `/v2/note-learning-rounds/${safeUuid(input.roundId)}/reopen`,
      { expectedRevision: input.expectedRevision },
      requestId,
    );
  }

export async function restoreNote(t: GatewayTransport, noteId: string, requestId?: string): Promise<DesktopNoteMutationResult> {
    await t.ensureConnected(requestId);
    await t.request(`/notes/${safeUuid(noteId)}/restore`, { method: "POST" }, true, true, requestId);
    return { noteId, status: "restored" };
  }

export function restoreNoteDocLocal(t: GatewayTransport, 
    noteId: string,
    snapshot: {
      docState: string;
      pending: string[];
      revision: number;
      savedAt: string;
      shareScope: NoteShareScopeV1;
    },
  ): void {
    const safeNoteId = safeUuid(noteId);
    const session = noteDocLocalSession(t, safeNoteId);
    if (session.seeded) return;
    session.state.seed(snapshot.docState);
    session.pending = snapshot.pending.slice(0, NOTE_DOC_PENDING_MAX);
    session.revision = snapshot.revision;
    session.savedAt = snapshot.savedAt;
    session.shareScope = snapshot.shareScope;
  }

export async function restoreNoteVersion(t: GatewayTransport, 
    noteId: string,
    versionId: string,
    baseVersionId: string,
    requestId?: string,
  ): Promise<DesktopNoteMutationResult> {
    await t.ensureConnected(requestId);
    await t.request(
      `/notes/${safeUuid(noteId)}/versions/${safeUuid(versionId)}/restore`,
      { method: "POST", body: JSON.stringify({ baseVersionId }) },
      true,
      true,
      requestId,
    );
    return { noteId, status: "restored" };
  }

export async function resumeNoteLearningRound(t: GatewayTransport, 
    input: { roundId: string; expectedRevision: number },
    requestId?: string,
  ): Promise<RoundTeachingViewV1> {
    await postNoteLearningRoundAction(t, 
      `/v2/note-learning-rounds/${safeUuid(input.roundId)}`,
      { expectedRevision: input.expectedRevision, action: { kind: "resume" } },
      requestId,
      "PATCH",
    );
    return getNoteLearningRoundTeaching(t, input.roundId, requestId);
  }

export async function retryCardGeneration(t: GatewayTransport, runId: string, _commandId: string, requestId?: string): Promise<CardGenerationRetryResultV1> {
    await t.ensureConnected(requestId);
    try {
      const result = await t.request(
        `/v2/card-generation-runs/${safeUuid(runId)}/retry`,
        { method: "POST" },
        true,
        true,
        requestId,
      );
      return cardGenerationRetryResultV1Schema.parse(result.body);
    } catch (error) {
      if (error instanceof DesktopGatewayFailure && error.code === "api_unavailable") {
        // 与 cancel 同一纪律：网络断了不等于操作没生效，让用户先重新同步再决定。
        throw new DesktopGatewayFailure("result_unknown", "resync_first");
      }
      throw error;
    }
  }

export async function revealCardGenerationCandidate(t: GatewayTransport, 
    runId: string,
    candidateId: string,
    request: DesktopRevealCandidateRequestV2,
    commandId: string,
    requestId?: string,
  ): Promise<z.infer<typeof candidateRevealV2Schema>> {
    await t.ensureConnected(requestId);
    if (request.candidateId !== candidateId) throw new DesktopGatewayFailure("invalid_request", "user_action");
    try {
      const result = await t.request(
        `/v2/card-generation-runs/${safeUuid(runId)}/candidates/${safeUuid(candidateId)}/reveal`,
        {
          method: "POST",
          body: JSON.stringify(request),
          headers: { "X-Idempotency-Key": t.idempotencyKey("cardGeneration-reveal", commandId) },
        },
        true,
        true,
        requestId,
      );
      return candidateRevealV2Schema.parse(result.body);
    } catch (error) {
      if (error instanceof DesktopGatewayFailure && error.code === "api_unavailable") {
        throw new DesktopGatewayFailure("result_unknown", "resync_first");
      }
      throw error;
    }
  }

export async function reviewCardGeneration(t: GatewayTransport, 
    runId: string,
    request: DesktopCandidateReviewRequestV2,
    commandId: string,
    requestId?: string,
  ): Promise<CardGenerationReviewResultV1> {
    await t.ensureConnected(requestId);
    try {
      const server = await getCardGenerationRunServerView(t, runId, requestId);
      const plan = await getCardGenerationPlan(t, runId, requestId);
      const body = candidateActionCommandV2Schema.parse({
        version: 2,
        runId,
        expectedCardContentEpoch: server.cardContentEpoch,
        expectedPlanVersion: plan.planVersion,
        expectedPlanHash: plan.planHash,
        expectedReviewDraftRevision: request.expectedReviewDraftRevision,
        action: request.action,
      });
      const result = await t.request(
        `/v2/card-generation-runs/${safeUuid(runId)}/candidate-actions`,
        {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "X-Idempotency-Key": t.idempotencyKey("cardGeneration-review", commandId) },
        },
        true,
        true,
        requestId,
      );
      const response = cardGenerationReviewResultV1Schema.parse(result.body);
      const refreshed = await getCardGenerationRunServerView(t, runId, requestId);
      if (refreshed.reviewDraftRevision !== response.reviewDraftRevision) {
        throw new DesktopGatewayFailure("unsupported_contract", "user_action");
      }
      return response;
    } catch (error) {
      if (error instanceof DesktopGatewayFailure && error.code === "api_unavailable") {
        throw new DesktopGatewayFailure("result_unknown", "resync_first");
      }
      throw error;
    }
  }

export async function reviewNoteExpansionTask(t: GatewayTransport, noteId: string, taskId: string, review: unknown, requestId?: string) {
    await t.ensureConnected(requestId);
    const input = noteExpansionReviewV1Schema.parse(review);
    const result = await t.request(`/v2/notes/${safeUuid(noteId)}/expansion-tasks/${safeUuid(taskId)}/drafts`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }, true, true, requestId);
    if (result.status >= 300) throw t.mapResponseError(result.status, result.headers);
    const parsed = noteExpansionTaskV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function reviseNoteLearningRound(t: GatewayTransport, 
    input: { roundId: string; expectedRevision: number; drivingQuestion: string; drivingQuestionSource: "suggested" | "user_rewritten" | "user_authored" },
    requestId?: string,
  ): Promise<NoteLearningRoundV1Wire> {
    return postNoteLearningRoundAction(t, 
      `/v2/note-learning-rounds/${safeUuid(input.roundId)}/driving-question`,
      {
        expectedRevision: input.expectedRevision,
        drivingQuestion: input.drivingQuestion,
        drivingQuestionSource: input.drivingQuestionSource,
      },
      requestId,
    );
  }

export async function saveNote(t: GatewayTransport, 
    noteId: string,
    request: DesktopNoteSaveRequestV1,
    _commandId: string,
    requestId?: string,
  ): Promise<NoteSaveReceiptV1> {
    await t.ensureConnected(requestId);
    try {
      const result = await t.request(
        `/v2/notes/${safeUuid(noteId)}`,
        { method: "PATCH", body: JSON.stringify(request) },
        true,
        true,
        requestId,
      );
      const parsed = noteSaveReceiptV1Schema.safeParse(result.body);
      if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
      return parsed.data;
    } catch (error) {
      // PATCH may have committed before the transport failed.  The caller
      // must re-read the Note/version and must not blindly replay the write.
      if (error instanceof DesktopGatewayFailure && error.code === "api_unavailable") {
        throw new DesktopGatewayFailure("result_unknown", "resync_first");
      }
      throw error;
    }
  }

export async function setNoteShareScope(t: GatewayTransport, 
    noteId: string,
    shareScope: NoteShareScopeV1,
    requestId?: string,
  ): Promise<NoteShareScopeReceiptV1> {
    await t.ensureConnected(requestId);
    const safeNoteId = safeUuid(noteId);
    const result = await t.request(
      `/v2/notes/${safeNoteId}/share-scope`,
      { method: "PATCH", body: JSON.stringify({ shareScope }) },
      true,
      true,
      requestId,
    );
    const parsed = noteShareScopeReceiptV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function startCardGenerationRun(t: GatewayTransport, 
    request: DesktopCreateCardGenerationRunRequestV2,
    commandId: string,
    requestId?: string,
  ): Promise<CardGenerationJobAcceptedV1> {
    await t.ensureConnected(requestId);
    try {
      const result = await t.request(
        "/v2/card-generation-runs",
        {
          method: "POST",
          body: JSON.stringify(request),
          headers: { "X-Idempotency-Key": t.idempotencyKey("cardGeneration-start", commandId) },
        },
        true,
        true,
        requestId,
      );
      return cardGenerationJobAcceptedV1Schema.parse(result.body);
    } catch (error) {
      if (error instanceof DesktopGatewayFailure && error.code === "api_unavailable") {
        throw new DesktopGatewayFailure("result_unknown", "resync_first");
      }
      throw error;
    }
  }

export async function startNoteAnnotationTask(t: GatewayTransport, noteId: string, request: unknown, requestId?: string) {
    await t.ensureConnected(requestId);
    const input = createNoteAnnotationTaskV1Schema.parse(request);
    const result = await t.request(`/v2/notes/${safeUuid(noteId)}/annotation-tasks`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
    }, true, true, requestId);
    if (result.status >= 300) throw t.mapResponseError(result.status, result.headers);
    const parsed = noteAnnotationTaskV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function startNoteExpansionTask(t: GatewayTransport, noteId: string, request: unknown, requestId?: string) {
    await t.ensureConnected(requestId);
    const input = createNoteExpansionTaskV1Schema.parse(request);
    const result = await t.request(`/v2/notes/${safeUuid(noteId)}/expansion-tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }, true, true, requestId);
    if (result.status >= 300) throw t.mapResponseError(result.status, result.headers);
    const parsed = noteExpansionTaskV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function startNoteLearningArtifactTask(t: GatewayTransport, noteId: string, request: unknown, requestId?: string) {
    await t.ensureConnected(requestId);
    const input = createNoteDynamicArtifactTaskV1Schema.parse(request);
    const result = await t.request(`/v2/notes/${safeUuid(noteId)}/learning-artifact-tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }, true, true, requestId);
    if (result.status >= 300) throw t.mapResponseError(result.status, result.headers, undefined, result.body);
    const parsed = noteLearningArtifactTaskV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function startNoteOverviewTask(t: GatewayTransport, noteId: string, request: unknown, requestId?: string) {
    await t.ensureConnected(requestId);
    const input = createNoteOverviewTaskV1Schema.parse(request);
    const result = await t.request(`/v2/notes/${safeUuid(noteId)}/overview-tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }, true, true, requestId);
    if (result.status >= 300) throw t.mapResponseError(result.status, result.headers);
    const parsed = noteOverviewTaskV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function startNoteRecall(t: GatewayTransport, noteId: string, request: unknown, requestId?: string) {
    await t.ensureConnected(requestId);
    const input = noteRecallStartInputV1Schema.parse(request);
    const result = await t.request(`/v2/notes/${safeUuid(noteId)}/recalls`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }, true, true, requestId);
    if (result.status >= 300) throw t.mapResponseError(result.status, result.headers);
    const parsed = noteRecallStartResultV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function syncNoteDocTitle(t: GatewayTransport, 
    noteId: string,
    title: string,
    titleSource: string,
    requestId?: string,
  ): Promise<NoteDocSyncOutcome> {
    const safeNoteId = safeUuid(noteId);
    await deps.ensureNoteDocSeeded(t, safeNoteId, requestId);
    return settleNoteDocUpdate(t, 
      safeNoteId,
      noteDocLocalSession(t, safeNoteId).state.applyTitle(title, titleSource),
      requestId,
    );
  }

export async function syncNoteDocUpdate(t: GatewayTransport, 
    noteId: string,
    update: string,
    requestId?: string,
  ): Promise<NoteDocSyncOutcome> {
    const safeNoteId = safeUuid(noteId);
    await deps.ensureNoteDocSeeded(t, safeNoteId, requestId);
    return settleNoteDocUpdate(t, 
      safeNoteId,
      noteDocLocalSession(t, safeNoteId).state.applyLocal(update),
      requestId,
    );
  }

export async function uploadNoteImage(t: GatewayTransport, 
    noteId: string,
    request: NoteImageUploadRequestV1,
    requestId?: string,
  ): Promise<NoteImageUploadResultV1> {
    await t.ensureConnected(requestId);
    const configuration = t.configuration;
    if (!configuration) throw new DesktopGatewayFailure("configuration_error", "user_action");

    const bytes = Buffer.from(request.bytesBase64, "base64");
    if (bytes.byteLength === 0 || bytes.byteLength > NOTE_IMAGE_UPLOAD_MAX_BYTES) {
      throw new DesktopGatewayFailure("validation", "user_action");
    }

    const form = new FormData();
    form.set("noteId", noteId);
    form.set("file", new Blob([bytes], { type: request.mimeType }), request.fileName);

    const headers = new Headers();
    if (t.token) headers.set("Authorization", `Bearer ${t.token}`);
    const controller = requestId ? new AbortController() : undefined;
    if (requestId && controller) t.activeRequests.set(requestId, controller);
    let response: Response;
    try {
      response = await fetch(new URL("/uploads/images", `${configuration.config.apiOrigin}/`), {
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
    if (!response.ok && response.status === 401 && t.tokenIsRestored) {
      await t.discardStoredCredential();
    }
    if (!response.ok) throw t.mapResponseError(response.status, response.headers, undefined, body);

    // 服务端回的是 `{ assetId, url, objectKey, size, mimeType, sha256, width, height }`；
    // 只有合同里那五个字段过桥，别的连名字都不进渲染层。
    const payload = (body ?? {}) as Record<string, unknown>;
    const parsed = noteImageUploadResultV1Schema.safeParse({
      version: 1,
      url: payload.url,
      byteLength: payload.size,
      mimeType: payload.mimeType,
      width: payload.width,
      height: payload.height,
    });
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function writeNoteAnnotation(t: GatewayTransport, noteId: string, command: NoteAnnotationCommandV1, requestId?: string) {
    await t.ensureConnected(requestId);
    const base = `/v2/notes/${safeUuid(noteId)}/annotations`;
    const annotationId = command.kind === "create" ? null : safeUuid(command.annotationId);
    const result = await t.request(annotationId ? `${base}/${annotationId}` : base, {
      method: command.kind === "create" ? "POST" : command.kind === "update" ? "PATCH" : "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command.kind === "create" ? {
        anchor: command.anchor,
        explanation: command.explanation,
        ...(command.sourceMessageId ? { sourceMessageId: command.sourceMessageId } : {}),
      } : command.kind === "update" ? {
        expectedRevision: command.expectedRevision,
        explanation: command.explanation,
      } : { expectedRevision: command.expectedRevision }),
    }, true, true, requestId);
    if (result.status >= 300) throw t.mapResponseError(result.status, result.headers);
    const parsed = noteAnnotationWriteResultV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function writeNoteReflection(t: GatewayTransport, noteId: string, command: NoteReflectionCommandV1, requestId?: string) {
    await t.ensureConnected(requestId);
    const base = `/v2/notes/${safeUuid(noteId)}/learning-reflections`;
    const result = await t.request(command.kind === "create" ? base : `${base}/${safeUuid(command.reflectionId)}`, {
      method: command.kind === "create" ? "POST" : command.kind === "update" ? "PATCH" : "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command.kind === "create" ? { source: command.source, annotation: command.annotation }
        : command.kind === "update" ? { expectedRevision: command.expectedRevision, annotation: command.annotation }
          : { expectedRevision: command.expectedRevision }),
    }, true, true, requestId);
    if (result.status >= 300) throw t.mapResponseError(result.status, result.headers);
    const parsed = noteReflectionWriteResultV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function uploadNoteDocUpdate(t: GatewayTransport, 
    noteId: string,
    update: string,
    requestId?: string,
  ): Promise<NoteDocUploadResultV1> {
    await t.ensureConnected(requestId);
    const safeNoteId = safeUuid(noteId);
    const result = await t.request(
      `/v2/notes/${safeNoteId}/doc-update`,
      { method: "POST", body: JSON.stringify({ update }) },
      true,
      true,
      requestId,
    );
    const parsed = noteDocUploadResultV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function flushNoteDocPending(t: GatewayTransport, noteId: string, requestId?: string): Promise<void> {
    const session = noteDocLocalSessions.get(safeUuid(noteId));
    if (!session || session.pending.length === 0) return;
    const merged = mergeNoteDocUpdates(session.pending);
    try {
      const receipt = await deps.uploadNoteDocUpdate(t, safeUuid(noteId), merged, requestId);
      session.pending = [];
      session.revision = receipt.revision;
      session.savedAt = receipt.savedAt;
    } catch (error) {
      if (!isOfflineFailure(error)) {
        // 与 `settleNoteDocUpdate` 同一条规矩：失败的那一批**留在队列里**。清了它，这些
        // 操作就只剩文档里那一份，而下一次写会走"没产生新东西"那条分支、如实回
        // `unchanged`——界面把它当"已保存"（清未提交标记、清草稿），这次失败就变成一次
        // 静默丢字。留着，下一次写或下一次建连还会再交一次，失败也照样喊出来。
        throw error;
      }
      // 还是没通：留着，下一次写或下一次建连再试。
    }
  }

export async function postNoteLearningRoundAction(t: GatewayTransport, 
    path: string,
    payload: Record<string, unknown>,
    requestId?: string,
    method: "POST" | "PATCH" = "POST",
  ): Promise<NoteLearningRoundV1Wire> {
    return (await postNoteLearningRoundView(t, path, payload, requestId, method)).round;
  }

export async function postNoteLearningRoundView(t: GatewayTransport, 
    path: string,
    payload: Record<string, unknown>,
    requestId?: string,
    method: "POST" | "PATCH" = "POST",
  ): Promise<NoteLearningRoundViewV1> {
    await t.ensureConnected(requestId);
    const result = await t.request(
      path,
      {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
      true,
      true,
      requestId,
    );
    const parsed = noteLearningRoundViewV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function watchNoteDocument(t: GatewayTransport, ndt: NoteDocTransport, 
    noteId: string,
    onEvent: (event: { noteId: string } & NoteDocStreamEventV1) => void | Promise<void>,
    requestId?: string,
  ): Promise<NoteDocWatchHandle | null> {
    await t.ensureConnected(requestId);
    const configuration = t.configuration;
    if (!configuration) throw new DesktopGatewayFailure("configuration_error", "user_action");
    if (!t.token) throw new DesktopGatewayFailure("auth_required", "user_action");
    const safeNoteId = safeUuid(noteId);
    // 「仅自己可见」的那篇不建实时连接。顺便这一步也把编辑起点取到手了，
    // 所以它不是"为判一位而多发一次请求"——离线那条路本来就靠这次打底。
    const startingPoint = await deps.getNoteDocState(t, safeNoteId, requestId);
    if (startingPoint.shareScope !== "shared") return null;
    let url: string;
    try {
      url = noteDocStreamUrl(configuration.config.apiOrigin);
    } catch {
      throw new DesktopGatewayFailure("configuration_error", "user_action");
    }
    let stopped = false;
    const handle = ndt({
      url,
      documentName: `${NOTE_DOC_PREFIX}${safeNoteId}`,
      token: t.token,
      onEvent: (event) => {
        // stop() 之后迟到的帧必须丢掉：渲染层此刻可能已经换到另一篇笔记甚至另一个空间。
        if (stopped) return;
        const wire = toNoteDocStreamEvent(event);
        if (!wire) return;
        void onEvent({ noteId: safeNoteId, ...wire });
      },
    });
    return {
      applyLocal: (update) => (stopped ? null : handle.applyLocal(update)),
      setPresence: (state) => {
        if (stopped) return;
        handle.setPresence(state);
      },
      stop: () => {
        if (stopped) return;
        stopped = true;
        handle.close();
      },
    };
  }


/**
 * 本机正文的存储接缝（2026-09-30 随 note 族搬出时加）。
 *
 * `uploadNoteDocUpdate` 这类操作**既是 IPC 入口、又是模块内部被调的接缝**
 * （`settleNoteDocUpdate` / `flushNoteDocPending` 内部会调它）。
 * 内部直接按函数名调用时，**外部的桩拦不住**——那 20 条红就是这么来的。
 *
 * 把它收成依赖对象，和 `desktop-gateway.ts` 的 `options`
 * （`noteDocCache` / `artifactUserDataDir` …）是**同一形状**：
 * **把外部资源作为可替换的依赖传进来，而不是藏在模块内部**。
 * 替换入口在 `src/main/__tests__/ns-note-stubs.ts`；生产代码里它是默认实现，
 * **没有任何测试专用分支**。
 */
/** 依赖的形状**从真实现用 `typeof` 取**——手写一遍签名必然会走样（实测）。 */
export type NoteDocDeps = {
  ensureNoteDocSeeded: typeof ensureNoteDocSeeded;
  getNoteDocState: typeof getNoteDocState;
  uploadNoteDocUpdate: typeof uploadNoteDocUpdate;
  restoreNoteDocLocal: typeof restoreNoteDocLocal;
  dropNoteDocLocalSessions: typeof dropNoteDocLocalSessions;
};

let deps: NoteDocDeps = {
  ensureNoteDocSeeded,
  getNoteDocState,
  uploadNoteDocUpdate,
  restoreNoteDocLocal,
  dropNoteDocLocalSessions: (t: GatewayTransport) => dropNoteDocLocalSessions(t),
};

/** 换掉本机正文的存储接缝。**生产代码不调它**；测试用它把真持久化换成假存储。 */
export function setNoteDocDeps(next: Partial<NoteDocDeps>): void {
  deps = { ...deps, ...next };
}

/** 恢复默认实现。 */
export function resetNoteDocDeps(): void {
  deps = {
    ensureNoteDocSeeded,
    getNoteDocState,
    uploadNoteDocUpdate,
    restoreNoteDocLocal,
    dropNoteDocLocalSessions: (t: GatewayTransport) => dropNoteDocLocalSessions(t),
  };
}

export function noteDocLocalSnapshot(t: GatewayTransport, noteId: string): {
    docState: string;
    pending: string[];
    revision: number;
    savedAt: string;
    shareScope: NoteShareScopeV1;
  } | null {
    const session = noteDocLocalSessions.get(safeUuid(noteId));
    // 认的是"这一份有没有一个来自服务端的祖先"（`shareScope` 只在拿到服务端起点
    // 或从盘上接回来时才有值），不认 `seeded`：从盘上接回来的那份同样该被再次落盘，
    // 否则第一次重启就把欠的增量弄丢了。
    if (!session || !session.shareScope) return null;
    return {
      docState: session.state.encodeState(),
      pending: [...session.pending],
      revision: session.revision,
      savedAt: session.savedAt,
      shareScope: session.shareScope,
    };
  }


export function dropNoteDocLocalSessions(t: GatewayTransport, ): void {
    for (const session of noteDocLocalSessions.values()) session.state.dispose();
    noteDocLocalSessions.clear();
  }
