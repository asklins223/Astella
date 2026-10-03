// @vitest-environment jsdom

import { noteDocResult, seedUpdate, seedBlocksUpdate } from "../../../test-support/note-doc-fixtures.ts";
import { ROUND_COPY, roundPracticeStateLabelV1 } from "../notebook/notebook-round-copy.ts";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { objectiveListItemV3Schema, type ObjectiveListItemV3 } from "@ailearn/shared/learning-objective-surface-contracts";
import type { NoteBlockProjectionV1 } from "@ailearn/shared/note-projection-contracts";
import type { RoundNextStepV1 } from "@ailearn/shared/note-learning-round-contracts";
import { NotebookSurface } from "../notebook/notebook-surface.tsx";
import { ROUND_PRESETS_V1, STRUCTURE_QUESTION_LABEL_MAX_V1, STRUCTURE_QUESTION_LIMIT_V1, notebookReadingSectionsV1, structureQuestionCandidatesV1 } from "../notebook/notebook-surface.tsx";
import { useRoomStore } from "../../../app/room-store.ts";

/**
 * 笔记页的那一颗主要动作（39d W4-2 第三刀）。
 *
 * 这一页过去只有"生成学习卡"一个动作，目标只是 meta 里的一行字（「学习卡：xxx」），
 * 于是"这一篇到底该做什么"要用户自己去列表里找。现在它按 `noteId` 读自己的目标，
 * 把服务端裁决好的那一个主行动画在正文上方。
 *
 * 这一组用例钉的是三件**没有别的层能替它证明**的事：
 *  1. 按钮上的动词与按下去的去处来自**同一个对象**（服务端那个 `primaryAction`）——
 *     这一页不另写词、也不自己拼一份 start；
 *  2. 这块是**增补**：读不到、读失败都不许把笔记本身顶掉（它过去整页只有笔记）；
 *  3. 取的是**这一篇**的目标，不是"最近更新的那一个"（同一次改动的服务端那一半
 *     已经有集测钉过，这里是桌面侧的最后一环）。
 *
 * 夹具走 `objectiveListItemV3Schema.parse`：合同与假数据漂移要红在这里，而不是红成
 * "页面上什么都没画"。
 */

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-4222-4222-8222-222222222222";
const OBJECTIVE_ID = "33333333-4333-4333-8333-333333333333";
const RUN_ID = "44444444-4444-4444-8444-444444444444";
// 另起一轮那一条的 id：用例要分清"屏上换成了新那一条"与"还是手上那一条"。
const REOPENED_ROUND_ID = "77777777-4777-4777-8777-777777777777";

const ok = <T,>(data: T) => ({ ok: true as const, workspaceEpoch: 1, data });

const START = {
  version: 2,
  originV2: { kind: "today", objectiveId: OBJECTIVE_ID },
  goal: "stabilize",
  requestedTimeBudgetSeconds: 180,
  responsePreference: "adaptive",
} as const;

/** 列表项夹具：默认"这一篇还没有学习记录"，各用例只覆盖自己要的那一格。 */
function listItem(overrides: Record<string, unknown> = {}): ObjectiveListItemV3 {
  return objectiveListItemV3Schema.parse({
    objectiveId: OBJECTIVE_ID,
    surfaceRevision: 1,
    conceptLabel: "惯性与质量",
    publicSummary: "质量是惯性大小的唯一量度。",
    knowledgeForm: "fact",
    cardStrategy: null,
    lifecycle: "active",
    freshness: "fresh",
    primaryNoteId: NOTE_ID,
    primaryNoteTitle: "物理笔记",
    createdAt: "2026-09-20T09:00:00.000Z",
    personalState: { state: "unvalidated", activeRunId: null },
    progress: {
      practiceTrailCount: 0,
      lastCanonicalAt: null,
      reviewDueAt: null,
      initialValidation: null,
      validationNotBefore: null,
    },
    reviewHold: null,
    primaryAction: { kind: "create_run", objectiveId: OBJECTIVE_ID, label: "开始学习", start: START },
    ...overrides,
  });
}

type Api = {
  artifact: { ensure: ReturnType<typeof vi.fn> };
  objective: { list: ReturnType<typeof vi.fn> };
  /** W7-3 刀三：目标级「暂不安排」／「恢复并开启」那两条命令。 */
  review: {
    holdObjective: ReturnType<typeof vi.fn>;
    resumeObjective: ReturnType<typeof vi.fn>;
    /** W7-3 刀六：订阅来源分别开停。 */
    activateSubscription: ReturnType<typeof vi.fn>;
    pauseSubscription: ReturnType<typeof vi.fn>;
    listNoteSubscriptions: ReturnType<typeof vi.fn>;
  };
  learningRun: {
    start: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    getDraft: ReturnType<typeof vi.fn>;
    getResult: ReturnType<typeof vi.fn>;
    getReturnContract: ReturnType<typeof vi.fn>;
    recordActivityLease: ReturnType<typeof vi.fn>;
    revealTarget: ReturnType<typeof vi.fn>;
    saveDraft: ReturnType<typeof vi.fn>;
    submit: ReturnType<typeof vi.fn>;
    action: ReturnType<typeof vi.fn>;
  };
  note: { save: ReturnType<typeof vi.fn> };
  noteLearningRound: {
    open: ReturnType<typeof vi.fn>;
    history: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    revise: ReturnType<typeof vi.fn>;
    reopen: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    teaching: ReturnType<typeof vi.fn>;
    explain: ReturnType<typeof vi.fn>;
    preparePractice: ReturnType<typeof vi.fn>;
  };
};

/**
 * 一条轮次回读（39d W4-3 第三刀）。`sourceContentHash` 用**真实主形状**（32 位 md5），
 * 不是随手写的 64 个 a——假回执照假形状写，测出来的就是假形状。
 */
function roundRow(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    roundId: "77777777-7777-4777-8777-777777777777",
    noteId: NOTE_ID,
    phase: "active",
    outcome: null,
    drivingQuestion: "判断为什么有索引，查询仍然可能慢",
    drivingQuestionSource: "suggested",
    drivingQuestionRevision: 1,
    noteVersionId: VERSION_ID,
    sourceContentHash: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
    evidenceSnapshotIds: [],
    budgets: { maxModelCalls: 8, maxWallClockSeconds: 900, maxTasks: 6 },
    revision: 1,
    pausedAt: null,
    resumedAt: null,
    closedAt: null,
    createdAt: "2026-09-26T04:00:00.000Z",
    updatedAt: "2026-09-26T04:00:00.000Z",
    ...overrides,
  };
}

const ROUND_ID = "77777777-7777-4777-8777-777777777777";

/**
 * 一条教学产物的回读（39d W4-6 刀二）。形状照线上合同写：解释与例子在 `content` 里，
 * 依据是块序号——它不是一段裸文本，也不是"根据笔记"一句话。
 */
function teachingRow(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    teachingId: "88888888-8888-4888-8888-888888888888",
    roundId: ROUND_ID,
    ordinal: 1,
    kind: "explanation",
    content: {
      explanation: "「间隔重复」这一节说的是：在快要忘记的时候再见到它。",
      example: "例如把新词放在第 1、3、7 天各见一次。",
    },
    sourceBlockOrdinals: [1, 2],
    createdAt: "2026-09-26T04:10:00.000Z",
    ...overrides,
  };
}

function installApi(
  list: () => Promise<unknown>,
  options: {
    syncController?: { fail: boolean };
    manualSaveFails?: boolean;
    openRound?: Record<string, unknown> | null;
    /** 这一篇的正文块。默认只有一段（即"没有小节"那一档，见结构另选那组用例）。 */
    blocks?: NoteBlockProjectionV1[];
    /** 轮次回读的第 N 次给什么（缺省 = 每次都给 `openRound` 那一份）。 */
    openSequence?: (Record<string, unknown> | null)[];
    /** 网关那一发回的信封里那个派生格（默认「没动」）。 */
    contentMoved?: boolean;
    /** 这一轮目标引用的依据变化；默认没有已生成的目标。 */
    roundNoteChangeImpact?: Record<string, unknown> | null;
    /** 这一篇的轮次记录回读（缺省 = 空表，即"还没有过轮次"）。 */
    roundHistory?: Record<string, unknown>;
    /** 那一发读失败（走网关那一条形状）。 */
    roundHistoryFails?: boolean;
    /** 带游标那几发的回读，按调用次给（"更早的那一页、再更早的那一页"）。 */
    olderPages?: Record<string, unknown>[];
    /** 这一轮的解释（W4-6 刀二）；缺省 = 还没讲过。 */
    roundTeaching?: Record<string, unknown> | null;
    plans?: Record<string, unknown>[];
    /** 解释那一读按调用次给（生成成功之后回读要拿到新的一条）。 */
    teachingSequence?: (Record<string, unknown> | null)[];
    /** 生成那一发失败（走网关那一条形状）。 */
    explainFails?: boolean;
    /** 「继续这一轮」那一发失败（走网关那一条形状）。 */
    resumeFails?: boolean;
    /** 这一轮练过的那几道（W4-6 刀三）；缺省 = 还没练过。 */
    practices?: Record<string, unknown>[];
    /** 「练一道」那一发的起点；缺省 = 没有（无目标轮次）。 */
    practiceStart?: Record<string, unknown> | null;
    nextStep?: RoundNextStepV1;
    /** 缺口帮助停止那一格（W4-6 刀四）；缺省 = 没停。 */
    gapHelp?: Record<string, unknown>;
    /** 这一条解释的动态产物引用（W4-6 刀五）；缺省 = 没有动态版本。 */
    artifact?: Record<string, unknown> | null;
    /** 落盘那一发失败。 */
    artifactEnsureFails?: boolean;
    /** 「暂不安排」那一发失败（走网关那一条形状）。 */
    holdFails?: boolean;
    /** 「恢复并开启」那一发失败（409 still_held 的形状）。 */
    resumeObjectiveFails?: boolean;
    /** 立排除那一发撤下了几条待办；缺省 2。 */
    dismissedPendingSchedules?: number;
    /** 恢复那一发是新建还是沿用；缺省 created。 */
    resumeScheduled?: "created" | "reused_existing";
    /** 这一篇的订阅读侧（缺省＝没订阅过）。 */
    noteSubscriptions?: Record<string, unknown>[];
    /** 开/停那一发失败（走网关那一条形状）。 */
    subscriptionFails?: boolean;
    /** 停用那一发交回"还有什么在撑着"；缺省＝空（不再被安排）。 */
    stillCoveredBy?: ("note_subscription" | "card_review")[];
  } = {},
): Api {
  const syncController = options.syncController ?? { fail: false };
  let openReads = 0;
  let olderPageReads = 0;
  let teachingReads = 0;
  let prepared = false;
  const signedNextStep = (teaching: Record<string, unknown> | null): RoundNextStepV1 => {
    if (options.nextStep) return options.nextStep;
    const practice = options.practices?.at(-1);
    const basisRunId = typeof practice?.runId === "string" ? practice.runId : null;
    if (practice?.outcome === null) return { kind: "resume", basisRunId, gapFacets: [], evidence: "none" };
    if (practice?.outcome === "demonstrated" || practice?.outcome === "practice_completed") {
      return { kind: "finish", basisRunId, gapFacets: [], evidence: "independent_demonstrated" };
    }
    if (practice?.outcome === "not_assessable") return { kind: "uncertain", basisRunId, gapFacets: [], evidence: "unassessable" };
    if (practice) return { kind: options.gapHelp?.stopped ? "choose" : "help", basisRunId, gapFacets: [], evidence: "incomplete" };
    if (!teaching) return { kind: prepared ? "attempt" : "explain", basisRunId: null, gapFacets: [], evidence: "none" };
    return { kind: options.practiceStart ? "attempt" : "review_material", basisRunId: null, gapFacets: [], evidence: "none" };
  };
  const api: Api = {
    // 动态产物落盘那一发（W4-6 刀五）：跨桥只回"在不在盘上了"，渲染层读的是这一发的**成败**，
    // 不是那一格（`stored:false`——本来就在——同样是成功）。
    artifact: {
      ensure: vi.fn(async () => (options.artifactEnsureFails
        ? { ok: false as const, error: { code: "api_unavailable", safeMessageKey: "error.api_unavailable", retry: "user_action" } }
        : ok({ stored: true }))),
    },
    objective: { list: vi.fn(list) },
    learningRun: {
      start: vi.fn(async () => ok({ runId: RUN_ID, snapshotId: "55555555-4555-4555-8555-555555555555" })),
      // 就地作答把 `LearningRunBody` 挂进了这一页（2026-09-28 用户裁决），所以这一份
      // 替身要多几格，否则挂上去的那一刻就抛 `get is not a function`，而用例还在绿——
      // 那正是"自制替身给了错误信心"（39f §6）那一条。
      //
      // 这里**不**伪造一份可作答的快照：run 状态机自己的用例在 `learning-run-surface`
      // 那一侧。这一组只钉"工位挂没挂上来、页面有没有跳走"。读快照回一份失败回执，
      // 工位于是显示它自己的"读不到"——真实失败时也是这个样子。
      get: vi.fn(async () => ({ ok: false as const, workspaceEpoch: 1, error: { code: "run_not_found", message: "这一场已经不在了" } })),
      getDraft: vi.fn(async () => ({ ok: false as const, workspaceEpoch: 1, error: { code: "run_not_found", message: "这一场已经不在了" } })),
      getResult: vi.fn(async () => ({ ok: false as const, workspaceEpoch: 1, error: { code: "run_not_found", message: "这一场已经不在了" } })),
      getReturnContract: vi.fn(async () => ({ ok: false as const, workspaceEpoch: 1, error: { code: "run_not_found", message: "这一场已经不在了" } })),
      recordActivityLease: vi.fn(async () => ok({})),
      revealTarget: vi.fn(async () => ok({})),
      saveDraft: vi.fn(async () => ok({})),
      submit: vi.fn(async () => ok({})),
      action: vi.fn(async () => ok({})),
    },
    // W7-3 刀三。两条各自一个替身而不是共用一个 toggle 替身：§9.1 规则表把
    // "设排除"与"恢复并开启"列成两件不同的事，用一个替身会让人以为它们是同一发。
    // 回执形状照线上合同写（`dismissedPendingSchedules`、`scheduled` 三档分两档回执）。
    review: {
      // W7-3 刀六：订阅读侧默认"这一篇没有订阅过"，于是屏上是"开启"那一档；
      // 给了 `noteSubscriptions` 就按那份回——**连暂停的也列**，因为开关要能拨回"开"。
      listNoteSubscriptions: vi.fn(async () => ok({
        version: 2 as const,
        items: options.noteSubscriptions ?? [],
      })),
      activateSubscription: vi.fn(async () => (options.subscriptionFails
        ? { ok: false as const, error: { code: "api_unavailable", safeMessageKey: "error.api_unavailable", retry: "user_action" } }
        : ok({
          subscription: { source: "note_subscription" as const, subjectType: "note" as const, subjectId: NOTE_ID, status: "active" as const, scopeNote: "持续回访这篇里学过的东西。", createdAt: new Date().toISOString(), pausedAt: null },
          changed: true,
          stillCoveredBy: options.stillCoveredBy ?? [],
        }))),
      pauseSubscription: vi.fn(async () => (options.subscriptionFails
        ? { ok: false as const, error: { code: "api_unavailable", safeMessageKey: "error.api_unavailable", retry: "user_action" } }
        : ok({
          subscription: { source: "note_subscription" as const, subjectType: "note" as const, subjectId: NOTE_ID, status: "paused" as const, scopeNote: "持续回访这篇里学过的东西。", createdAt: new Date().toISOString(), pausedAt: new Date().toISOString() },
          changed: true,
          stillCoveredBy: options.stillCoveredBy ?? [],
        }))),
      holdObjective: vi.fn(async () => (options.holdFails
        ? { ok: false as const, error: { code: "api_unavailable", safeMessageKey: "error.api_unavailable", retry: "user_action" } }
        : ok({
          objectiveId: OBJECTIVE_ID,
          noteId: NOTE_ID,
          alreadyHeld: false,
          dismissedPendingSchedules: options.dismissedPendingSchedules ?? 2,
        }))),
      resumeObjective: vi.fn(async () => (options.resumeObjectiveFails
        ? { ok: false as const, error: { code: "objective_held", safeMessageKey: "error.objective_held", retry: "user_action" } }
        : ok({
          version: 2 as const,
          objectiveId: OBJECTIVE_ID,
          released: true,
          scheduled: options.resumeScheduled ?? ("created" as const),
          scheduleId: "99999999-4999-4999-8999-999999999999",
          nextReviewAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
        }))),
    },
    noteLearningRound: {
      // 读失败走网关那一条（`{ok:false}`），不是抛异常：与真桥同一形状。
      history: vi.fn(async (input?: { before?: string }) => (options.roundHistoryFails
        ? { ok: false as const, error: { code: "api_unavailable", safeMessageKey: "error.api_unavailable", retry: "user_action" } }
        // 带了游标就按调用次给"更早的那一页"：只有一页可给的话，"下一页是接上还是覆盖"
        // 这件事根本没被走过。
        : ok(input?.before && options.olderPages?.length
          ? options.olderPages[Math.min(olderPageReads++, options.olderPages.length - 1)]
          : options.roundHistory ?? { version: 1, noteId: NOTE_ID, items: [], hasMore: false, shownCount: 0, totalCount: 0, nextCursor: null }))),

      // 轮次的回读**按调用次**给：迟到那一发的场景必须是"第一次读到旧版、
    // 失败之后重读读到新版"，一份固定回读测不出"换回了现在那一版"。
    open: vi.fn(async () => {
      const rows = options.openSequence ?? [options.openRound ?? null];
      const read = Math.min(openReads, rows.length - 1);
      openReads += 1;
      // 网关 `noteLearningRound.open` 回的是那一层信封（`{version, round, contentMoved}`），
      // 不是轮次记录本身——替身照线上形状来，别替渲染层省一步。
      const row = rows[read] ?? null;
      return ok(row === null ? null
        : {
          version: 1 as const,
          round: row,
          contentMoved: options.contentMoved ?? false,
          noteChangeImpact: options.roundNoteChangeImpact ?? null,
        });
    }),
      // 解释那一读：按调用次给（首读"还没讲过"，生成之后回读拿到那一条）。
      // 生成那一发自己走网关形状：失败时屏上不许装作已经讲过。
      teaching: vi.fn(async () => {
        const rows = options.teachingSequence ?? [options.roundTeaching ?? null];
        const read = Math.min(teachingReads, rows.length - 1);
        teachingReads += 1;
        return ok({
          version: 1,
          round: options.openRound ?? roundRow(),
          plans: options.plans ?? [],
          teaching: rows[read] ?? null,
          practices: options.practices ?? [],
          practiceStart: options.practiceStart ?? null,
          nextStep: signedNextStep(rows[read] ?? null),
          gapHelp: options.gapHelp ?? { stopped: false, consecutiveHelpCount: 0, threshold: 2 },
          prerequisite: { kind: "none", reason: "no_usable_material", gap: null, largeBranchThreshold: 2 },
          artifactFailure: null,
          artifact: options.artifact ?? null,
        });
      }),
      explain: vi.fn(async () => (options.explainFails
        ? { ok: false as const, error: { code: "api_unavailable", safeMessageKey: "error.api_unavailable", retry: "user_action" } }
        : ok({ version: 1, round: options.openRound ?? roundRow(), teaching: teachingRow() }))),
      preparePractice: vi.fn(async () => {
        prepared = true;
        return ok({ version: 1, round: options.openRound ?? roundRow(), teaching: null });
      }),
      create: vi.fn(async () => ok(roundRow())),
      revise: vi.fn(async () => ok(roundRow({ drivingQuestion: "先分清两种情况，再判断慢在哪一步", drivingQuestionRevision: 2, revision: 2 }))),
      // 恢复那一发的回信是**教学面那一份**（不是光一行轮次）：桥那一侧推进之后接着把
      // 服务端那一份读回来，界面拿到的就是屏上要摆的那一块（这里照那个形状给）。
      resume: vi.fn(async () => (options.resumeFails
        ? { ok: false as const, error: { code: "api_unavailable", safeMessageKey: "error.api_unavailable", retry: "user_action" } }
        : ok({
          version: 1,
          round: roundRow(),
          plans: options.plans ?? [],
          teaching: null,
          practices: options.practices ?? [],
          practiceStart: options.practiceStart ?? null,
          nextStep: signedNextStep(null),
          gapHelp: options.gapHelp ?? { stopped: false, consecutiveHelpCount: 0, threshold: 2 },
          prerequisite: { kind: "none", reason: "no_usable_material", gap: null, largeBranchThreshold: 2 },
          artifactFailure: null,
          artifact: null,
        }))),
      // 另起一轮那一发的回信是**新那一轮的信封**（与 `open` 同形，`contentMoved` 回到 false）：
      // 服务端在同一发事务里封存旧的、按当前正文建新的，界面无从参与那一版是哪一版。
      reopen: vi.fn(async () => ok({
        version: 1 as const,
        round: roundRow({ roundId: REOPENED_ROUND_ID, noteVersionId: "66666666-4666-4666-8666-666666666666" }),
        contentMoved: false,
        noteChangeImpact: null,
      })),
      close: vi.fn(async () => ok(roundRow({ phase: "closed", outcome: "partial", revision: 2, closedAt: "2026-09-26T05:00:00.000Z" }))),
    },
    note: {
      // 手动定版那一发（「先保存再开始」走它；自动保存**不**走它——自动那条只交
      // yjs 增量，见 `save()` 里 reason 那两个分支）。
      save: vi.fn(async () => (options.manualSaveFails
        ? { ok: false as const, error: { code: "api_unavailable", safeMessageKey: "error.api_unavailable", retry: "user_action" } }
        : ok({ savedAt: "2026-09-25T00:00:00.000Z" }))),
    },
  };
  Object.defineProperty(window, "ailearn", {
    configurable: true,
    value: {
      ...api,
      // 这四法挂在桥对象上，**不能**塞进下面那个 `note:` 键里——上一轮就是被它整个盖掉过
      // （`window.ailearn.note.save` 变 undefined，症状与"字没交出去"完全同形）。
      noteLearningRound: api.noteLearningRound,
      artifact: api.artifact,
      contract: { enabledRoutes: ["note.detail"] },
      auth: { getState: vi.fn(async () => ok({ status: "authenticated", workspace: { workspaceId: "ws-1" } })) },
      room: {
        getProjection: vi.fn(async () => ok({ primaryFocus: { state: "empty" } })),
      },
      note: {
        // `api.note` 必须先摊开：这一整个 `note` 键会盖掉上面 `...api` 里那份，
        // 于是 `window.ailearn.note.save` 变成 undefined。真窗口里这一发是「手动定版」
        // 的唯一通道，盖掉它的下场是 `save("manual")` 抛 `not a function`、被 catch 咽成
        // 「保存失败」，读起来跟"字没交出去"一模一样——那两条挂起的用例卡的正是这里。
        ...api.note,
        // 回读**按请求里那一篇**给：换篇的那条用例要看见另一篇，
        // 一份写死 id 的夹具会让"上一篇的翻页记录跟着过来"这件事根本发生不了。
        get: vi.fn(async (input?: { noteId?: string }) => ok({
          noteId: input?.noteId ?? NOTE_ID,
          title: "物理笔记",
          sourceId: null,
          currentVersionId: VERSION_ID,
          shareScope: "shared",
          permissions: { canEdit: true, canSave: true, canShare: false },
          currentVersion: {
            versionId: VERSION_ID,
            versionNo: 1,
            updatedAt: "2026-09-24T00:00:00.000Z",
            contentHash: "hash-abcdef12",
            blocks: options.blocks ?? [{ ordinal: 1, type: "paragraph", content: "质量是惯性大小的唯一量度。" }],
          },
        })),
        doc: {
          state: vi.fn(async () => noteDocResult({ update: seedBlocksUpdate("物理笔记", options.blocks ?? [{ type: "paragraph", content: "质量是惯性大小的唯一量度。" }]) })),
          // 增量真正交出去的地方（自动保存与"先保存再开始"都走它）。给不出网关形状，
        // flush 就永远不收敛、`saving` 会一直挂着——那是夹具假象，不是产品行为。
        // 结果按**调用次**给：第一次是切回阅读态那次自动保存（要它失败，字才留得住），
        // 第二次才是手动那一发的 flush。
        syncUpdate: vi.fn(async () => (syncController.fail
          ? { ok: false as const, error: { code: "api_unavailable", safeMessageKey: "error.api_unavailable", retry: "user_action" } }
          : { ok: true as const, workspaceEpoch: 1, data: { via: "uploaded" as const, revision: 1, savedAt: new Date().toISOString() } })),
        // 保存失败时真实传输把本机草稿留住（draft-recovery 那组用例钉的就是它）。
        // 缺了这三个，失败路径会走进夹具造出来的假分支。
        draftGet: vi.fn(async () => ok({ draft: null })),
        draftSave: vi.fn(async () => ok({ saved: true })),
        draftClear: vi.fn(async () => ok({ cleared: true })),
          presence: vi.fn(async () => ok({ shared: false })),
        },
      },
      capabilities: {
        get: vi.fn(async () => ok({
          actionCapabilities: { "note.save": "allowed", "note.create": "allowed" },
          featureAvailability: { card_generation_v2: { state: "disabled" }, companion_dialogue_v1: { state: "disabled" } },
        })),
      },
      source: { get: vi.fn(async () => ({ ok: false as const, error: { code: "api_unavailable", safeMessageKey: "error.api_unavailable", retry: "user_action" } })) },
      subscriptions: { subscribe: vi.fn(), unsubscribe: vi.fn(), onEvent: vi.fn(() => () => undefined) },
      shell: { openExternal: vi.fn(async () => ok({ opened: true })) },
    },
  });
  return api;
}

async function show(
  items: ObjectiveListItemV3[] | "fail",
  options: {
    leaf?: "reading" | "learning" | "history";
    learningRoundId?: string;
    mode?: "preview" | "live-preview";
    makeDirty?: boolean;
    syncController?: { fail: boolean };
    manualSaveFails?: boolean;
    /** undefined = 这一篇没有未完成的那一轮；给了就是屏上该显示它。 */
    openRound?: Record<string, unknown> | null;
    blocks?: NoteBlockProjectionV1[];
    openSequence?: (Record<string, unknown> | null)[];
    /** 网关那一发回的信封里那个派生格（默认「没动」）。 */
    contentMoved?: boolean;
    /** 这一轮目标引用的依据变化；默认没有已生成的目标。 */
    roundNoteChangeImpact?: Record<string, unknown> | null;
    roundHistory?: Record<string, unknown>;
    roundHistoryFails?: boolean;
    olderPages?: Record<string, unknown>[];
    roundTeaching?: Record<string, unknown> | null;
    plans?: Record<string, unknown>[];
    teachingSequence?: (Record<string, unknown> | null)[];
    explainFails?: boolean;
    resumeFails?: boolean;
    practices?: Record<string, unknown>[];
    nextStep?: RoundNextStepV1;
    practiceStart?: Record<string, unknown> | null;
    gapHelp?: Record<string, unknown>;
    artifact?: Record<string, unknown> | null;
    artifactEnsureFails?: boolean;
    /** 「暂不安排」那一发失败（走网关那一条形状）。 */
    holdFails?: boolean;
    /** 「恢复并开启」那一发失败（409 still_held 的形状）。 */
    resumeObjectiveFails?: boolean;
    /** 立排除那一发撤下了几条待办；缺省 2。 */
    dismissedPendingSchedules?: number;
    /** 恢复那一发是新建还是沿用；缺省 created。 */
    resumeScheduled?: "created" | "reused_existing";
    /** 这一篇的订阅读侧（缺省＝没订阅过）。 */
    noteSubscriptions?: Record<string, unknown>[];
    /** 开/停那一发失败（走网关那一条形状）。 */
    subscriptionFails?: boolean;
    /** 停用那一发交回"还有什么在撑着"；缺省＝空（不再被安排）。 */
    stillCoveredBy?: ("note_subscription" | "card_review")[];
  } = {},
) {
  const syncController = options.syncController ?? { fail: false };
  const api = installApi(
    items === "fail"
      ? async () => { throw new Error("gateway offline"); }
      : async () => ok({
          version: 3,
          items,
          total: items.length,
          nextCursor: null,
          snapshotAt: new Date().toISOString(),
        }),
    { ...options, syncController },
  );
  const invoke = vi.fn();
  const initialRound = options.openRound ?? options.openSequence?.[0];
  const routedRoundId = options.learningRoundId ?? (
    typeof initialRound?.roundId === "string"
      ? initialRound.roundId
      : options.leaf === "learning" ? ROUND_ID : undefined
  );
  useRoomStore.setState({
    invoke,
    activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID, mode: options.mode ?? "preview", learningRoundId: routedRoundId },
  });
  vi.useFakeTimers();
  const view = render(<NotebookSurface />);
  for (let i = 0; i < 14; i += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  }
  if (options.makeDirty) {
    // 走真实的"草稿 → 防抖 → 保存"链路造脏（标题是那条链上的受控输入），
    // 不直接改内部状态——否则测的就不是产品会发生的那个"有未提交编辑"。
    const title = document.getElementById("notebook-surface-title") as HTMLInputElement | null;
    if (!title) throw new Error("标题输入框不在屏上：编辑态夹具没生效");
    await act(async () => { fireEvent.input(title, { target: { value: "改过的标题" } }); });
    // 再走真实的"切回阅读态"：`switchMode("read")` 会顺手发起一次自动保存，
    // 而主要动作那一行只在阅读态才画——"有未提交编辑"因此只可能在这里被用户看到。
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "阅读" }));
      await vi.advanceTimersByTimeAsync(50);
    });
  }
  // 新笔记入口留在正文；历史页从“学习记录”进入。旧轮次只通过明确的回链参数打开。
  const visibleLeaf = (selector: string) => {
    const node = view.container.querySelector(selector);
    return node && !node.closest("[hidden]") ? node : null;
  };
  const targetHistory = options.leaf === "history" || !options.leaf && Boolean(options.roundHistory || options.roundHistoryFails);
  if (targetHistory && !visibleLeaf("#notebook-history-leaf")) {
    await act(async () => {
      fireEvent.click(within(view.container).getByRole("button", { name: "学习记录" }));
    });
  }
  return {
    ...view,
    api,
    syncController,
    invoke,
    objectiveBlock: () => {
      if (!visibleLeaf("#notebook-history-leaf")) {
        if (!visibleLeaf("#notebook-reading-leaf")) {
          fireEvent.click(within(view.container).getByRole("button", { name: "回到正文" }));
        }
        fireEvent.click(within(view.container).getByRole("button", { name: "学习记录" }));
      }
      const details = view.container.querySelector<HTMLDetailsElement>(".notebook-review-options");
      if (details && !details.open) fireEvent.click(within(details).getByText("以后怎么复习（可选）"));
      return details;
    },
    // Explicit round return opens the learning paper; default note entry stays in the reading page.
    roundBlock: () => view.container.querySelector<HTMLElement>("#notebook-learning-leaf"),
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(window, "ailearn");
  useRoomStore.setState({ activeNoteRef: null, invoke: undefined, surface: null, activeRunId: null, activeObjectiveId: null });
});

describe("笔记学习入口", () => {
  it("第一次看笔记时保留正文，学习页签和记录始终能直接返回", async () => {
    const { container } = await show([listItem()], { leaf: "reading" });
    const start = within(container).getByRole("navigation", { name: "笔记学习" });
    expect(within(start).getAllByRole("button").map((item) => item.getAttribute("aria-label") ?? item.textContent?.trim())).toEqual(["正文", "速看", "回想", "往外学", "学习记录"]);
    expect(within(start).getByRole("button", { name: "正文" }).getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".note-transcript")?.textContent).toContain("质量是惯性大小的唯一量度。");
    expect(container.querySelector(".note-expansion-shelf")?.closest("[hidden]")).toBeTruthy();
    expect(container.querySelector("#notebook-learning-leaf")).toBeNull();
  });

  it("已有进行中轮次和目标时，仍只显示这轮的问题与讲解", async () => {
    const { roundBlock, container } = await show([listItem()], { openRound: roundRow() });
    expect(roundBlock()?.textContent).toContain(roundRow().drivingQuestion);
    expect(container.querySelector(".notebook-objective:not(.notebook-round)")).toBeNull();
  });

  it("练习有结算后可完成本轮，关闭命令写 completed；回正文后能进入该轮回看", async () => {
    const { api, container } = await show([], {
      openRound: roundRow(),
      practices: [{ runId: RUN_ID, phase: "completed", outcome: "demonstrated", startedAt: "2026-09-26T04:20:00.000Z" }],
      roundHistory: historyOf([historyItem({ roundId: ROUND_ID, outcome: "completed", actualModes: ["practice"] })]),
      leaf: "learning",
    });
    fireEvent.click(within(container).getByRole("button", { name: "这一轮学完了，回笔记" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(api.noteLearningRound.close).toHaveBeenCalledWith(expect.objectContaining({
      roundId: ROUND_ID,
      outcome: "completed",
    }));
    expect(container.querySelector("#notebook-reading-leaf")).toBeTruthy();
    fireEvent.click(within(container).getByRole("button", { name: "学习记录" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(container.querySelector("#notebook-history-leaf")).toBeTruthy();
    expect(container.querySelector('[data-round-recap="true"]')).toBeTruthy();
  });

  it("未结算的练习可返回原 Run，轮次不被改写或重开", async () => {
    const { api, invoke, container } = await show([], {
      openRound: roundRow(),
      practices: [{ runId: RUN_ID, phase: "active", outcome: null, startedAt: "2026-09-26T04:20:00.000Z" }],
    });
    fireEvent.click(within(container).getByRole("button", { name: "回到那道题" }));
    expect(useRoomStore.getState().activeRunId).toBe(RUN_ID);
    // **就地**（2026-09-28 用户裁决）：回到原 Run 不再 `invoke("validate")` 换页。
    // 判据是"没有发生页面跳转"，而不是"发生了"——后者正是要删掉的那件事。
    expect(invoke).not.toHaveBeenCalledWith("validate");
    // 工位**就在这一页上**（2026-09-28 用户裁决）：这是"不跳页"的正面判据。
    // 只钉 `invoke` 没被调用是不够的——那也可能是"什么都没发生"。
    expect(container.querySelector(".round-bench")).toBeTruthy();
    expect(api.learningRun.start).not.toHaveBeenCalled();
    expect(api.noteLearningRound.close).not.toHaveBeenCalled();
  });

  it("另有练习仍在作答时不把本轮标成完成", async () => {
    const { roundBlock, container } = await show([], {
      openRound: roundRow(),
      practices: [
        { runId: RUN_ID, phase: "completed", outcome: "demonstrated", startedAt: "2026-09-26T04:20:00.000Z" },
        { runId: "99999999-9999-4999-8999-999999999999", phase: "active", outcome: null, startedAt: "2026-09-26T05:20:00.000Z" },
      ],
    });
    expect(within(container).queryByRole("button", { name: "这一轮学完了，回笔记" })).toBeNull();
    expect(within(roundBlock()!).getByRole("button", { name: "今天先到这里" })).toBeTruthy();
  });
});

/** 轻量定向只处理笔记轮次，目标的存在不再切换产品路径。 */
describe("笔记页的轻量定向表单（39d W4-3 第三刀）", () => {
  it("有一轮在进行中：显示服务端的问题，收尾带着它的 revision", async () => {
    const open = roundRow({ drivingQuestion: "判断为什么有索引，查询仍然可能慢", revision: 4 });
    const { api, roundBlock } = await show([], { openRound: open });
    expect(roundBlock()!.querySelector(".round-slip__question")?.textContent).toBe(open.drivingQuestion);
    expect(roundBlock()!.textContent).not.toContain("围绕这个问题，可以直接看讲解，也可以先试一个小问题");
    const close = within(roundBlock()!).getByRole("button", { name: "今天先到这里" });
    fireEvent.click(close);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(api.noteLearningRound.close.mock.calls[0][0]).toMatchObject({
      roundId: open.roundId,
      expectedRevision: 4,
      outcome: "partial",
    });
  });

  /**
   * 2026-09-26 真窗口跑这张表单时抓到的第一个缺陷（`probe-note-round-form.mts`）：
   * 旧写法把"在途"与"空闲"接反了——已经有一轮在进行中、什么都没在跑的时候屏上写着
   * 「正在改写…」，而改写真的在跑时写着「正在开始…」。两档各钉一条，且必须同一条用例里
   * 钉（只看空闲那一半，"把两个标签对调"这种改法照样绿）。
   */
  it("那一行报了「后来又保存过一版」：旁边摆得出「按当前内容新开一轮」，带的是手上这一条的 revision", async () => {
    const open = roundRow({ drivingQuestion: "索引为什么还是慢", revision: 3 });
    const { api, roundBlock } = await show([], { openRound: open, contentMoved: true });
    const button = [...roundBlock()!.querySelectorAll("button")].find((b) => b.textContent === ROUND_COPY.reopenWithCurrent) ?? null;
    expect(button).not.toBeNull();
    fireEvent.click(button!);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(api.noteLearningRound.reopen.mock.calls[0][0]).toMatchObject({
      roundId: open.roundId,
      expectedRevision: 3,
    });
    // 点过之后屏上是**服务端读回来的那一条**（silent 回读）：这一发不拿回执自己拼状态。
    expect(api.noteLearningRound.open).toHaveBeenCalledTimes(2);

    // 没报那一行时这颗不出现：没有问题就报这句话，等于无端要人再确认一次。
    const quiet = await show([], { openRound: open });
    expect([...quiet.roundBlock()!.querySelectorAll("button")].find((b) => b.textContent === ROUND_COPY.reopenWithCurrent)).toBeUndefined();
  });

  it("这一轮冻的正文后来又保存过一版：那一行要说出来，没动时一个字不多", async () => {
    const open = roundRow({ drivingQuestion: "为什么有索引还是慢", revision: 2 });
    const moved = await show([], { openRound: open, contentMoved: true });
    expect(moved.roundBlock()!.querySelector("[data-round-content-moved]")?.textContent)
      .toContain(ROUND_COPY.contentMoved);

    const still = await show([], { openRound: open });
    expect(still.roundBlock()!.querySelector("[data-round-content-moved]")).toBeNull();
  });

  it("轮次绑定目标的依据变动时，在这轮旁显示同段原文对照", async () => {
    const impact = {
      noteId: NOTE_ID,
      status: "affected",
      layer: 3,
      reasonCode: "quoted_text_changed",
      evidenceCount: 1,
      unchangedEvidenceCount: 0,
      changedEvidenceCount: 1,
      uncertainEvidenceCount: 0,
      evidenceDetails: [{
        evidenceIndex: 1,
        previousOrdinal: 2,
        previousQuote: "间隔重复要在快要忘记时练习。",
        currentQuote: "间隔重复要在快要忘记时主动回想。",
        previousQuoteTruncated: false,
        currentQuoteTruncated: false,
      }],
      evidenceDetailsOmittedCount: 0,
    };
    const { roundBlock } = await show([], { openRound: roundRow(), roundNoteChangeImpact: impact });
    const block = roundBlock()!;
    expect(block.querySelector("[data-round-note-change-impact] [data-note-change-impact]")?.textContent)
      .toBe("引用的段落有改动，先核对原文再继续。");
    expect(block.querySelector("[data-round-note-change-evidence] summary")?.textContent)
      .toBe("展开核对当时与现在的依据");
    expect(block.querySelector("[data-round-note-change-evidence]")?.textContent)
      .toContain("间隔重复要在快要忘记时主动回想。");
  });

  it("那颗提交按钮：空闲时写动词，只有一次请求真的在途时才写「正在…」", async () => {
    const open = roundRow({ drivingQuestion: "判断为什么有索引，查询仍然可能慢", revision: 4 });
    const { api, roundBlock } = await show([], { openRound: open });
    fireEvent.click(screen.getByRole("button", { name: ROUND_COPY.revise }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const submit = roundBlock()!.querySelector<HTMLButtonElement>("button.round-stamp");
    expect(submit?.textContent).toBe(ROUND_COPY.save);
    expect(submit?.disabled).toBe(false);

    // 把那一发吊住，才能在"请求在途"这段时间里读屏——不是读一个我以为存在的瞬间。
    let release: (value: unknown) => void = () => {};
    api.noteLearningRound.revise.mockImplementationOnce(
      () => new Promise((resolvePromise) => { release = resolvePromise; }),
    );
    fireEvent.click(submit!);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(roundBlock()!.querySelector("button.round-stamp")?.textContent).toBe(ROUND_COPY.saving);

    release(ok(roundRow({ drivingQuestion: "换成了一句新的", revision: 5 })));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(roundBlock()!.querySelector('[role="alert"]')).toBeNull();
  });

  it("读不到旧轮次时仍保留正文和伴星入口", async () => {
    const { container } = await show([], { openRound: undefined });
    expect(container.querySelector(".note-transcript")?.textContent).toContain("质量是惯性大小的唯一量度。");
    expect(container.querySelector("#notebook-learning-leaf")).toBeNull();
    expect(within(container).getByRole("button", { name: "速看" })).toBeTruthy();
  });

  /** §16.16 第二半的夹具：这一篇有哪几块正文。 */
  const heading = (ordinal: number, content: string): NoteBlockProjectionV1 =>
    ({ ordinal, type: "heading", content });
  const paragraph = (ordinal: number, content: string): NoteBlockProjectionV1 =>
    ({ ordinal, type: "paragraph", content });

  it("长笔记小节只取真实标题与正文块，空小节如实标成只有标题", () => {
    const sections = notebookReadingSectionsV1([
      paragraph(0, "标题前的正文。"),
      heading(1, "## 间隔重复"),
      paragraph(2, "间隔后再提取。"),
      paragraph(3, "   "),
      heading(4, "尚无正文"),
      heading(5, "尚无正文"),
      { ordinal: 6, type: "image", content: "![图示](/uploads/example.png)" },
    ]);
    expect(sections).toEqual([
      { startOrdinal: 0, title: "开篇", bodyBlockCount: 1 },
      { startOrdinal: 1, title: "间隔重复", bodyBlockCount: 1 },
      { startOrdinal: 4, title: "尚无正文", bodyBlockCount: 0 },
      { startOrdinal: 5, title: "尚无正文", bodyBlockCount: 1 },
    ]);
    expect(notebookReadingSectionsV1([paragraph(7, "只有一段。")])).toEqual([
      { startOrdinal: 7, title: "未分节正文", bodyBlockCount: 1 },
    ]);
    expect(notebookReadingSectionsV1([paragraph(8, "  ")])).toEqual([]);
  });

  it("长笔记纸签点到首屏外时展开并跳到真实原文块", async () => {
    const blocks: NoteBlockProjectionV1[] = Array.from(
      { length: 200 },
      (_, ordinal) => paragraph(ordinal, `正文第 ${ordinal + 1} 段。`),
    );
    blocks.push(heading(200, "第二节：间隔重复"), heading(201, "第三节：留待补充"));
    for (let ordinal = 202; ordinal <= 212; ordinal += 1) {
      blocks.push(heading(ordinal, `附加小节 ${ordinal - 199}`));
    }
    blocks.push(paragraph(213, "这一节已经有正文。"));
    const { container } = await show([], { leaf: "reading", blocks });

    expect(container.querySelector(".notebook-desk__index")).toBeNull();
    fireEvent.click(within(container).getByRole("button", { name: "目录" }));
    const outline = within(container).getByRole("complementary", { name: "笔记目录" });
    expect(outline.querySelectorAll("li > button")).toHaveLength(13);
    fireEvent.click(within(outline).getByRole("button", { name: "固定目录" }));
    fireEvent.click(within(outline).getByRole("button", { name: "附加小节 13" }));
    expect(container.querySelector('[data-block-ordinal="212"]')?.getAttribute("data-block-focused")).toBe("true");
    // The compact directory yields the page to the chosen section.
    expect(container.querySelector(".notebook-desk__index")).toBeNull();
  });

  it("判据：只认小节、取屏上那份字、复述题名与重复都不出、按块序取前三", () => {
    const found = structureQuestionCandidatesV1([
      paragraph(0, "开头一段没有小节的正文。"),
      heading(1, "**质量与惯性**"),
      heading(2, "两种理解"),
      heading(3, "两种理解"),
      heading(4, "物理笔记"),
      heading(5, "物理笔记（用于验证定义类知识能否产出选择题）"),
      heading(6, "第三个小节"),
      heading(7, "第四个小节"),
    ], "物理笔记");
    // `**` 是 markdown 的标记、不是屏上的字：拿原文出题会把标记带进这一句（`conceptMark` 头上记过同形返工）。
    expect(found.map((c) => c.label)).toEqual(["质量与惯性", "两种理解", "第三个小节"]);
    expect(found.length).toBe(STRUCTURE_QUESTION_LIMIT_V1);
    expect(found[0].question).toBe("先弄懂「质量与惯性」这一节在讲什么，以及它和整篇的关系");
    // 没有小节 ⇒ 一颗都不出（不拿段落第一句冒充标题，那是排版猜测）
    expect(structureQuestionCandidatesV1([paragraph(0, "只有一段。")], "物理笔记")).toEqual([]);
    // 空题名（刚建出来还没起名的那一篇）也要能出题：那道"以题名开头"的排除对空串
    // 会把**每一节**都判成复述题名，一颗都不剩。
    expect(structureQuestionCandidatesV1([heading(0, "两种理解")], "").map((c) => c.label)).toEqual(["两种理解"]);
    // 小节的存储形状**两种都有**（dev 库实测：6 条里 3 条带 `# `）：标记不许进标签，
    // 也不许进那句问话——教学面的依据标签共用同一份归一化。
    const marked = structureQuestionCandidatesV1([heading(0, "## 间隔重复")], "物理笔记");
    expect(marked.map((c) => c.label)).toEqual(["间隔重复"]);
    expect(marked[0].question).toBe("先弄懂「间隔重复」这一节在讲什么，以及它和整篇的关系");
  });

  it("标签可以截断，放进问话的那一句必须用完整小节名（真窗口实测：带省略号的半截话读不通）", () => {
    const long = "间隔重复与提取练习这两种做法在长期记忆上的差别到底在哪里";
    const [only] = structureQuestionCandidatesV1([heading(0, long)], "物理笔记");
    expect(only.label).toBe(`${long.slice(0, STRUCTURE_QUESTION_LABEL_MAX_V1)}…`);
    expect(only.question).toBe(`先弄懂「${long}」这一节在讲什么，以及它和整篇的关系`);
    expect(only.question).not.toContain("…");
  });

  /** 迟到的那一发（§16.39 那一族在笔记页的落点）：服务端拒掉之后不许让她对着一句作废的话。 */
  const CONFLICT = { ok: false as const, error: { code: "conflict", safeMessageKey: "error.conflict", retry: "user_action" } };
  const CONFLICT_TEXT = "这条学习状态已经发生变化，请先同步后再继续。";

  it("改写这一发迟到了：那一行换回服务端现在的那一版，失败那句照留，她那一句留在下面（§16.39）", async () => {
    const before = roundRow({ drivingQuestion: "本机读到的那一版", revision: 1 });
    const now = roundRow({ drivingQuestion: "另一端改过的那一版", drivingQuestionRevision: 2, revision: 5 });
    const { api, roundBlock } = await show([], { openRound: before, openSequence: [before, now] });
    api.noteLearningRound.revise.mockResolvedValue(CONFLICT);
    fireEvent.click([...roundBlock()!.querySelectorAll("button")].find((b) => b.textContent === ROUND_COPY.revise)!);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const input = roundBlock()!.querySelector("input#notebook-round-question") as HTMLInputElement;
    await act(async () => { fireEvent.change(input, { target: { value: "本机这一发是迟到的" } }); });
    fireEvent.click([...roundBlock()!.querySelectorAll("button")].find((b) => b.textContent === ROUND_COPY.save)!);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    // 那一行只说现在的事实：作废的那一句不许挂在它上面（这一条是原判据，收窄到那一格，不删）。
    expect(roundBlock()!.querySelector(".round-slip__question")?.textContent)
      .toBe("另一端改过的那一版");
    // 但这一句必须还在屏上：PRD 要"明确保留为冲突"，顶掉与拼进新版本是同一处缺陷的两种画法。
    expect(roundBlock()!.querySelector("[data-round-lost]")?.textContent)
      .toContain(ROUND_COPY.lostDraft("本机这一发是迟到的"));
    const conflictNotice = roundBlock()!.querySelector('[data-round-notice="failed"]');
    expect(conflictNotice?.textContent).toContain(CONFLICT_TEXT);
    // §13.4：可恢复的一步要给就地重试 + 一条离开的出路，不许把人困在这一格。
    expect(conflictNotice?.querySelectorAll("button").length ?? 0).toBeGreaterThanOrEqual(2);
    expect(api.noteLearningRound.revise).toHaveBeenCalledTimes(1);
  });

  it("迟到那一句「把这一句改到新版本上」：句子回输入框、引子跟着走、那一行收掉", async () => {
    const before = roundRow({ drivingQuestion: "本机读到的那一版", revision: 1 });
    const now = roundRow({ drivingQuestion: "另一端改过的那一版", drivingQuestionRevision: 2, revision: 5 });
    const { api, roundBlock } = await show([], { openRound: before, openSequence: [before, now] });
    api.noteLearningRound.revise.mockResolvedValue(CONFLICT);
    fireEvent.click([...roundBlock()!.querySelectorAll("button")].find((b) => b.textContent === ROUND_COPY.revise)!);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const input = roundBlock()!.querySelector("input#notebook-round-question") as HTMLInputElement;
    await act(async () => { fireEvent.change(input, { target: { value: "本机这一发是迟到的" } }); });
    fireEvent.click([...roundBlock()!.querySelectorAll("button")].find((b) => b.textContent === ROUND_COPY.save)!);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    fireEvent.click([...roundBlock()!.querySelectorAll("button")].find((b) => b.textContent === ROUND_COPY.applyLost)!);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const reopened = roundBlock()!.querySelector("input#notebook-round-question") as HTMLInputElement;
    expect(reopened.value).toBe("本机这一发是迟到的");
    expect(roundBlock()!.querySelector("[data-round-lost]")).toBeNull();
    // 引子没被换掉：她原本自己打的那一句，重来一次还是同一档 source。
    // 断言读**第二次**那一发——第一次是刚才被拒的那一发，它的 source 早就定了，
    // 拿 `calls[0]` 判这一条等于没判（变异自证时就是这么发现的）。
    api.noteLearningRound.revise.mockResolvedValue(ok(now));
    fireEvent.click([...roundBlock()!.querySelectorAll("button")].find((b) => b.textContent === ROUND_COPY.save)!);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    const sources = api.noteLearningRound.revise.mock.calls.map((call) => call[0].drivingQuestionSource);
    expect(sources).toEqual(["user_rewritten", "user_rewritten"]);
    expect(api.noteLearningRound.revise.mock.calls[1][0].drivingQuestion).toBe("本机这一发是迟到的");
  });

  it("对照：不是 conflict 的失败不许说「替你留着」，也不许把她那句抹掉", async () => {
    const before = roundRow({ drivingQuestion: "本机读到的那一版", revision: 1 });
    const { api, roundBlock } = await show([], { openRound: before, openSequence: [before] });
    api.noteLearningRound.revise.mockResolvedValue({
      ok: false as const,
      error: { code: "api_unavailable", safeMessageKey: "error.api_unavailable", retry: "user_action" },
    });
    fireEvent.click([...roundBlock()!.querySelectorAll("button")].find((b) => b.textContent === ROUND_COPY.revise)!);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const input = roundBlock()!.querySelector("input#notebook-round-question") as HTMLInputElement;
    await act(async () => { fireEvent.change(input, { target: { value: "这一发不知道有没有进去" } }); });
    fireEvent.click([...roundBlock()!.querySelectorAll("button")].find((b) => b.textContent === ROUND_COPY.save)!);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    expect(roundBlock()!.querySelector("[data-round-lost]")).toBeNull();
    // 留在编辑态：她那一句还在输入框里，下一次「换一个问题」不会把它覆盖掉。
    const stillThere = roundBlock()!.querySelector("input#notebook-round-question") as HTMLInputElement;
    expect(stillThere.value).toBe("这一发不知道有没有进去");
  });

  it("对照：这一发赶上了——屏上就是新的那一条，也没有告警", async () => {
    const before = roundRow({ drivingQuestion: "本机读到的那一版", revision: 1 });
    const after = roundRow({ drivingQuestion: "本机这一发赶上了", drivingQuestionRevision: 2, revision: 2 });
    const { api, roundBlock } = await show([], { openRound: before, openSequence: [before, after] });
    api.noteLearningRound.revise.mockResolvedValue(ok(after));
    fireEvent.click([...roundBlock()!.querySelectorAll("button")].find((b) => b.textContent === ROUND_COPY.revise)!);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const input = roundBlock()!.querySelector("input#notebook-round-question") as HTMLInputElement;
    await act(async () => { fireEvent.change(input, { target: { value: "本机这一发赶上了" } }); });
    fireEvent.click([...roundBlock()!.querySelectorAll("button")].find((b) => b.textContent === ROUND_COPY.save)!);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    const shown = roundBlock()!.textContent ?? "";
    expect(roundBlock()!.querySelector(".round-slip__question")?.textContent).toBe("本机这一发赶上了");
    expect(roundBlock()!.querySelector('[role="alert"]')).toBeNull();
  });

  it("收尾这一发迟到了：那一行不撤（撤了会被读成「已经收尾」），并换回现在那一版", async () => {
    const before = roundRow({ drivingQuestion: "本机读到的那一版", revision: 1 });
    const now = roundRow({ drivingQuestion: "另一端推进过的那一版", revision: 5 });
    const { api, roundBlock } = await show([], { openRound: before, openSequence: [before, now] });
    api.noteLearningRound.close.mockResolvedValue(CONFLICT);
    fireEvent.click(within(roundBlock()!).getByRole("button", { name: "今天先到这里" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    const shown = roundBlock()!.textContent ?? "";
    expect(roundBlock()!.querySelector(".round-slip__question")?.textContent).toBe("另一端推进过的那一版");
    expect(shown).not.toContain("本机读到的那一版");
    const conflictNotice = roundBlock()!.querySelector('[data-round-notice="failed"]');
    expect(conflictNotice?.textContent).toContain(CONFLICT_TEXT);
    // §13.4：可恢复的一步要给就地重试 + 一条离开的出路，不许把人困在这一格。
    expect(conflictNotice?.querySelectorAll("button").length ?? 0).toBeGreaterThanOrEqual(2);
  });

});

/**
 * 这一篇的轮次记录（PRD §10.3 读侧第一刀；39d W4-5 第四刀）。
 *
 * 钉的是四件**只有渲染层能钉**的：
 *  1. 每一行把日期、状态那一格、那一轮的问题原文放在**同一行**上；
 *  2. 状态那一格只有一个来源（`roundHistoryStateLabelV1`）：终态才看收尾原因；
 *  3. 数量那句话不替整篇报假总数（只回了最近几条时不说"开过 N 轮"）；
 *  4. 这一发读失败不许把笔记本身顶掉。
 */
function historyItem(overrides: Record<string, unknown> = {}) {
  return {
    roundId: "aaaaaaaa-1111-4111-8111-111111111111",
    phase: "closed",
    outcome: "partial",
    drivingQuestion: "判断为什么有索引，查询仍然可能慢",
    drivingQuestionSource: "suggested",
    drivingQuestionRevision: 1,
    // §10.3 那两格（W4-8 刀一）默认取"什么都没发生过"那一档：它是一行的**事实**，
    // 不是可选项——要验"讲过／练过／判不准"的用例必须显式给 overrides。
    actualModes: [],
    systemUncertain: false,
    followUpSettledAt: null,
    startedAt: "2026-09-24T02:00:00.000Z",
    closedAt: "2026-09-24T03:00:00.000Z",
    ...overrides,
  };
}

function historyOf(items: Record<string, unknown>[], hasMore = false, totalCount?: number) {
  // 真合同那六格（`hasMore` 为真时必须带游标；`shownCount` 与 `totalCount` 都由服务端报）。
  // `totalCount` 默认取屏上条数只是省事：**要验"两数分叉"的那条用例必须显式给它**。
  const last = items[items.length - 1] as { roundId?: string } | undefined;
  return {
    version: 1,
    noteId: NOTE_ID,
    items,
    hasMore,
    shownCount: items.length,
    totalCount: totalCount ?? items.length,
    nextCursor: hasMore ? (last?.roundId ?? null) : null,
  };
}

function historyRows(): string[] {
  return [...document.querySelectorAll(".notebook-round-history__list li")].map((row) => row.textContent ?? "");
}

describe("这一篇的轮次记录（§10.3 读侧）", () => {
  it("那句总数读的是服务端报的那一格，不是屏上列了几条", async () => {
    // 两数分叉的形状只有构造出来才测得到：屏上列 2 条、这一篇其实开过 5 轮。
    // 拿 `items.length` 当总数的那一行代码，在这份夹具下会写出「开过 2 轮」——当场红。
    await show([], {
      roundHistory: historyOf(
        [
          historyItem({ roundId: "dddddddd-1111-4111-8111-111111111111", drivingQuestion: "第五轮的那句问题" }),
          historyItem({ roundId: "eeeeeeee-1111-4111-8111-111111111111", drivingQuestion: "第四轮的那句问题" }),
        ],
        true,
        5,
      ),
    });
    const lead = (document.querySelector(".notebook-round-history .small")?.textContent ?? "").trim();
    expect(lead).toBe("这一篇开过 5 轮，这里列了最近 2 轮，更早的还能看。");
  });

  it("没有更早的了 ⇒ 只报总数，不再报「列了最近几条」", async () => {
    await show([], {
      roundHistory: historyOf([
        historyItem({ roundId: "ffffffff-1111-4111-8111-111111111111", drivingQuestion: "唯一那一轮" }),
      ]),
    });
    const lead = (document.querySelector(".notebook-round-history .small")?.textContent ?? "").trim();
    expect(lead).toBe("这一篇开过 1 轮。");
  });


  it("每一行：日期、状态那一格、那一轮的问题原文，都在同一行上", async () => {
    await show([], {
      roundHistory: historyOf([
        historyItem({ roundId: "bbbbbbbb-1111-4111-8111-111111111111", drivingQuestion: "第二轮的那句问题", outcome: "superseded" }),
        historyItem({ roundId: "cccccccc-1111-4111-8111-111111111111", drivingQuestion: "第一轮的那句问题" }),
      ]),
    });
    const rows = historyRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("第二轮的那句问题");
    expect(rows[0]).toContain("被新的一轮替掉");
    expect(rows[1]).toContain("先到这里");
    // 日期是真格式化出来的：只断言"含数字"太宽（startedAt 写成什么都含数字）。
    expect(/年.*月.*日/.test(rows[0])).toBe(true);
  });

  it("状态那一格只有一个来源：终态看收尾原因，未完成的只看状态、不猜原因", async () => {
    await show([], {
      roundHistory: historyOf([
        historyItem({ roundId: "11111111-2222-4222-8222-222222222222", phase: "active", outcome: null, closedAt: null }),
        historyItem({ roundId: "22222222-3333-4333-8333-333333333333", phase: "paused", outcome: null, closedAt: null }),
        historyItem({ roundId: "33333333-4444-4444-8444-444444444444", outcome: "completed", closedAt: "2026-09-25T03:00:00.000Z" }),
        historyItem({ roundId: "44444444-5555-4555-8555-555555555555", outcome: "system_failure", closedAt: "2026-09-25T04:00:00.000Z" }),
      ]),
    });
    const states = [...document.querySelectorAll(".notebook-round-history__list li")]
      .map((row) => row.querySelectorAll("span")[1].textContent?.trim());
    expect(states).toEqual(["正在进行", "停住了", "走完了", "中途出了问题"]);
  });

  it("实际方式与系统不确定项：只把真发生过的那几档上屏，一格都不猜", async () => {
    await show([], {
      roundHistory: historyOf([
        historyItem({ roundId: "a1111111-1111-4111-8111-111111111111", actualModes: ["explained", "practiced"] }),
        historyItem({ roundId: "a2222222-2222-4222-8222-222222222222", actualModes: ["practiced"] }),
        historyItem({ roundId: "a3333333-3333-4333-8333-333333333333", actualModes: [], systemUncertain: true }),
        historyItem({ roundId: "a4444444-4444-4444-8444-444444444444", actualModes: [] }),
      ]),
    });
    // 两格各自只有"发生过"才出那一档：次序由服务端定（讲过在前），界面不重排也不补默认。
    expect([...document.querySelectorAll("[data-round-history-modes]")].map((node) => node.textContent))
      .toEqual(["讲过 · 练过", "练过"]);
    expect([...document.querySelectorAll("[data-round-history-uncertain]")].map((node) => node.textContent))
      .toEqual([ROUND_COPY.historyUncertain]);
    const rows = historyRows();
    expect(rows[3]).not.toContain("讲过");
    expect(rows[3]).not.toContain("练过");
    expect(rows[3]).not.toContain(ROUND_COPY.historyUncertain);
  });

  it("后来才判出来那一格：只有服务端给了时刻才上屏，且不改那一行说的那一版", async () => {
    await show([], {
      roundHistory: historyOf([
        historyItem({ roundId: "f1111111-1111-4111-8111-111111111111", followUpSettledAt: "2026-09-26T01:02:03.000Z" }),
        historyItem({ roundId: "f2222222-2222-4222-8222-222222222222" }),
      ]),
    });
    const followUps = [...document.querySelectorAll("[data-round-history-follow-up]")].map((node) => node.textContent);
    // 那句带时间（§10.3 要的是"补充记录"而不是把"当时"改掉），所以必须有日子。
    expect(followUps).toEqual(["后来才判出来：2026年9月26日"]);
    const rows = historyRows();
    expect(rows[1]).not.toContain("后来才判出来");
  });

  it("翻两页都接在后面；翻到最后一页才许说「开过 N 轮」，那颗也随之消失", async () => {
    const c1 = "77777777-8888-4888-8888-888888888888";
    const c2 = "66666666-7777-4777-8777-777777777777";
    const c3 = "55555555-6666-4666-8666-666666666666";
    const { api, container } = await show([], {
      // 三页都是同一篇的**同一份总数**（3 轮），每页只列 1 条——这才像真服务端回信。
      roundHistory: historyOf([historyItem({ roundId: c1 })], true, 3),
      olderPages: [
        historyOf([historyItem({ roundId: c2 })], true, 3),
        historyOf([historyItem({ roundId: c3 })], false, 3),
      ],
    });
    const lead = () => container.querySelector(".notebook-round-history p")?.textContent ?? "";
    const rows = () => container.querySelectorAll(".notebook-round-history__list li").length;
    const button = () => [...container.querySelectorAll(".notebook-round-history button")]
      .find((candidate) => candidate.textContent === ROUND_COPY.loadOlder) ?? null;
    // 总数从第一页就是服务端的既成事实（不是"翻到底才知道"），但仍要说清"这里只列了 1 条"，
    // 两件事各归各的来源：总数那格翻多少页都不动，"列了最近几条"随屏上涨。
    expect(lead()).toContain("这一篇开过 3 轮，这里列了最近 1 轮，更早的还能看。");

    fireEvent.click(button()!);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(rows()).toBe(2);
    expect(api.noteLearningRound.history.mock.calls[1][0]).toMatchObject({ before: c1 });

    fireEvent.click(button()!);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    // 第二页是**接在**第一页后面：覆盖式实现到这里只会剩 1 行。
    expect(rows()).toBe(3);
    expect(api.noteLearningRound.history.mock.calls[2][0]).toMatchObject({ before: c2 });
    expect(lead()).toBe("这一篇开过 3 轮。");
    expect(button()).toBeNull();
  });

  it("取下一页失败时不假装翻到了：那一页不加进来，话要说得出口", async () => {
    const { container } = await show([], {
      roundHistory: historyOf([historyItem({ roundId: "99999999-1111-4111-8111-111111111111" })], true),
      olderPages: [{ version: 1, noteId: NOTE_ID, items: [], hasMore: true, shownCount: 0, totalCount: 1, nextCursor: null }],
    });
    const before = container.querySelectorAll(".notebook-round-history__list li").length;
    fireEvent.click([...container.querySelectorAll(".notebook-round-history button")]
      .find((candidate) => candidate.textContent === ROUND_COPY.loadOlder)!);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(container.querySelectorAll(".notebook-round-history__list li").length).toBe(before);
  });

  it("翻出来的那几页跟着那一篇走：切到另一篇时不许把上一篇的更早记录接上", async () => {
    const { container } = await show([], {
      roundHistory: historyOf([
        historyItem({ roundId: "aaaa1111-1111-4111-8111-111111111111" }),
        historyItem({ roundId: "aaaa2222-2222-4222-8222-222222222222" }),
      ], true),
      olderPages: [historyOf([historyItem({ roundId: "aaaa3333-3333-4333-8333-333333333333" })], false),],
    });
    fireEvent.click([...container.querySelectorAll(".notebook-round-history button")]
      .find((candidate) => candidate.textContent === ROUND_COPY.loadOlder)!);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(container.querySelectorAll(".notebook-round-history__list li")).toHaveLength(3);

    useRoomStore.setState({
      activeNoteRef: { noteId: "bbbb1111-1111-4111-8111-111111111111", noteVersionId: VERSION_ID, mode: "preview" },
    });
    for (let i = 0; i < 6; i += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(120); });
    }
    fireEvent.click(within(container).getByRole("button", { name: "学习记录" }));
    // 另一篇的第一页还是那两条（同一份回读），但**不该**再带着上一篇翻出来的那一条。
    expect(container.querySelectorAll(".notebook-round-history__list li")).toHaveLength(2);
  });

  it("这一篇还没有过轮次 ⇒ 那一块根本不在（不给页面添一行空话）", async () => {
    const { container } = await show([]);
    // 缺省回读是空表；上面几条已经证明"有记录时这一块在"，所以这里的"不在"测的是判据。
    expect(container.querySelector(".notebook-round-history")).toBeNull();
  });

  it("读记录失败不许把笔记顶掉：那一块不出现，纸上还是笔记", async () => {
    const { api, container } = await show([], { roundHistoryFails: true });
    expect(api.noteLearningRound.history).toHaveBeenCalled();
    expect(container.querySelector(".notebook-round-history")).toBeNull();
    fireEvent.click(within(container).getByRole("button", { name: "正文" }));
    expect(container.querySelector(".note-transcript")?.textContent).toContain("质量是惯性大小的唯一量度。");
    // 旧轮次记录失败不影响笔记页里的快速理解入口。
    expect(within(container).getByRole("button", { name: "速看" })).toBeTruthy();
    expect(within(container).getByRole("button", { name: "回想" })).toBeTruthy();
    expect(container.querySelector("#notebook-learning-leaf")).toBeNull();
  });
});

/**
 * 教学面（39d W4-6 刀二）。
 *
 * 这一组钉四件**别的层替它证不了**的事：
 *  1. 讲没讲过这件事只由服务端说：还没讲过就一颗按钮，点下去带着**读过的那一版** `revision`
 *     发一发；成功了屏上那句解释来自服务端回读，不是本机拼的；
 *  2. 依据要点得动：那一段真的有锚点、点一颗会把它标出来并滚过去，高亮自己会过期；
 *  3. 快照不是屏幕上这一版时**不摆依据**（正文后来改过，块序号已经不是同一份材料），
 *     并如实说一句——不假装定位得到；
 *  4. 生成失败不装作已经讲过：错的句子照实说，那颗按钮还在。
 */
describe("笔记页的教学面（39d W4-6 刀二）", () => {
  it("可以先试且不提前展示讲解；准备后使用服务端签发的练习起点", async () => {
    const practiceStart = {
      objectiveId: OBJECTIVE_ID,
      start: { version: 2, originV2: { kind: "note_round", roundId: ROUND_ID, noteId: NOTE_ID, objectiveId: OBJECTIVE_ID }, goal: "stabilize", requestedTimeBudgetSeconds: 180, responsePreference: "adaptive" },
    };
    const { api, roundBlock } = await show([], { openRound: roundRow({ revision: 4 }), practiceStart });
    const block = roundBlock()!;
    expect(block.querySelector(".round-prose__body")).toBeNull();
    fireEvent.click(within(block).getByRole("button", { name: "先试一小问" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(api.noteLearningRound.preparePractice.mock.calls[0][0]).toMatchObject({ roundId: ROUND_ID, expectedRevision: 4 });
    expect(roundBlock()!.querySelector(".round-prose__body")).toBeNull();
    fireEvent.click(within(roundBlock()!).getByRole("button", { name: "先试这一道" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(api.learningRun.start.mock.calls[0][0].request).toEqual(practiceStart.start);
  });

  it("恢复学习页展示服务端最新路线，不把旧计划摆成当前计划", async () => {
    const plan = (ordinal: number, text: string) => ({ version: 1, planOrdinal: ordinal, roundRevision: ordinal + 1,
      plan: { version: 1, steps: [{ text }], expectedScale: "一个要点", endCondition: "解释适用条件" },
      reason: "本轮问题调整", recordedAt: "2026-09-27T00:00:00.000Z" });
    const { roundBlock } = await show([], { openRound: roundRow(), plans: [plan(1, "旧路线"), plan(2, "先分清索引与扫描范围")] });
    const block = roundBlock()!;
    expect(block.textContent).toContain("先分清索引与扫描范围");
    expect(block.textContent).toContain("一个要点");
    expect(block.textContent).not.toContain("旧路线");
  });

  it("还没讲过：只有那颗按钮；点它带着 revision 发一发，屏上换成服务端回读的那条解释", async () => {
    const open = roundRow({ revision: 3 });
    const teaching = teachingRow();
    const { api, roundBlock } = await show([], {
      openRound: open,
      teachingSequence: [null, teaching],
    });
    const block = roundBlock()!;
    expect(block.querySelector(".round-prose__body")).toBeNull();
    const start = [...block.querySelectorAll("button")].find((b) => b.textContent === "看讲解")!;
    expect(start).toBeTruthy();
    fireEvent.click(start);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(api.noteLearningRound.explain.mock.calls[0][0]).toMatchObject({
      roundId: ROUND_ID,
      expectedRevision: 3,
    });
    // 屏上那一句是**回读**来的（第二读），不是发出去那一发自己拼的。
    expect(roundBlock()!.querySelector(".round-prose__body")?.textContent)
      .toBe(teaching.content.explanation);
    expect(api.noteLearningRound.teaching).toHaveBeenCalledTimes(2);
  });

  it("讲过了：解释、例子与依据都在；点一颗依据会把那一段标出来并滚过去，高亮自己过期", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const blocks: NoteBlockProjectionV1[] = [
      { ordinal: 0, type: "heading", content: "## 间隔重复" },
      { ordinal: 1, type: "paragraph", content: "间隔重复说的是在快要忘记的时候再见到它。" },
    ];
    const teaching = teachingRow({ sourceBlockOrdinals: [0, 1] });
    const { roundBlock, container } = await show([], {
      openRound: roundRow(),
      blocks,
      roundTeaching: teaching,
    });
    const block = roundBlock()!;
    expect(block.querySelector(".round-prose__body")?.textContent).toBe(teaching.content.explanation);
    expect(block.querySelector(".round-slip--example p:not(.round-slip__label)")?.textContent).toBe(teaching.content.example);
    expect(block.textContent).toContain("回到笔记里那句话");
    fireEvent.click(within(block).getByText("回到笔记里那句话"));
    // 那一颗的字**从材料里取**（小节取标题），不是"第 N 段"这种编号冒充。
    const chip = [...block.querySelectorAll(".round-flap__sheet button")]
      .find((b) => b.textContent === "小节「间隔重复」")!;
    expect(chip).toBeTruthy();
    scrollIntoView.mockClear();
    fireEvent.click(chip);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    const target = container.querySelector<HTMLElement>('[data-block-ordinal="0"]')!;
    expect(target.getAttribute("data-block-focused")).toBe("true");
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    // 高亮只是"我在这儿"，过期就撤——不留"上次点到哪"这种会跟人走的读数。
    await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
    expect(container.querySelector('[data-block-ordinal="0"]')!.getAttribute("data-block-focused")).toBeNull();
  });

  it("讲解保留疑似主张的原句和原因，并明确说明这轮没有形成正式目标", async () => {
    const teaching = teachingRow({ content: {
      ...teachingRow().content,
      suspectClaims: [{ unitIds: ["unit-1"], sourceBlockOrdinal: 2, sourceQuote: "复合索引缺少最左列条件就无法使用索引",
        reason: "这个说法可能省略查询条件，值得再核对。", sourceChanged: true }],
    } });
    const { roundBlock } = await show([], { openRound: roundRow(), roundTeaching: teaching });
    const block = roundBlock()!;
    const warning = block.querySelector<HTMLElement>(".round-slip--flag")!;
    expect(warning).toBeTruthy();
    expect(warning.textContent).toContain("有几处说法要核对");
    expect(warning.textContent).toContain("复合索引缺少最左列条件就无法使用索引");
    expect(warning.textContent).toContain("这个说法可能省略查询条件，值得再核对。");
    expect(warning.textContent).toContain("核对前，这些说法不会成为正式的学习目标");
  });

  it("快照不是屏幕上这一版：依据不摆，换一句如实的话", async () => {
    const { roundBlock } = await show([], {
      openRound: roundRow({ noteVersionId: "99999999-9999-4999-8999-999999999999" }),
      roundTeaching: teachingRow({ sourceBlockOrdinals: [1, 2] }),
    });
    const block = roundBlock()!;
    expect(block.querySelector(".round-prose__body")).toBeTruthy();
    expect(block.querySelectorAll(".round-flap__sheet button").length).toBe(0);
    expect(block.textContent).toContain(ROUND_COPY.teaching.staleVersion);
  });

  it("依据的序号在屏幕这一版里对不上：不瞎画，也不说那句「正文改过」", async () => {
    const { roundBlock } = await show([], {
      openRound: roundRow(),
      blocks: [{ ordinal: 9, type: "paragraph", content: "这一段与那条解释无关。" }],
      roundTeaching: teachingRow({ sourceBlockOrdinals: [42] }),
    });
    const block = roundBlock()!;
    expect(block.querySelectorAll(".round-flap__sheet button").length).toBe(0);
    expect(block.textContent).not.toContain(ROUND_COPY.teaching.staleVersion);
  });

  it("生成失败：那句错上屏，且屏上不装作已经讲过（按钮还在）", async () => {
    const { api, roundBlock, container } = await show([], { openRound: roundRow(), explainFails: true });
    const block = roundBlock()!;
    fireEvent.click([...block.querySelectorAll("button")].find((b) => b.textContent === "看讲解")!);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(api.noteLearningRound.explain).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".round-prose__body")).toBeNull();
    expect(block.querySelector('[role="alert"]')?.textContent).toBeTruthy();
    expect([...block.querySelectorAll("button")].some((b) => b.textContent === "看讲解")).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent?.trim().length ?? 0).toBeGreaterThan(0);
  });
});

/**
 * 轮次里的练习（39d W4-6 刀三）。
 *
 * 这一组钉三件别的层替它证不了的事：
 *  1. 「练一道」只在**服务端给了起点**时出现（无目标的轮次没有这一颗），
 *     按下去发出去的就是服务端那一份 `start`——这一页不自己拼 goal／时长／锚点；
 *  2. 开出去之后接上旅程界面（与主要动作同一条路），不是"点了没反应"；
 *  3. 练过的几道在屏上带日期与结论，措辞由一处签发（结算后说结论、没结算说进行到哪）。
 */
describe("轮次里的练习（39d W4-6 刀三）", () => {
  const practiceStart = {
    objectiveId: OBJECTIVE_ID,
    start: {
      version: 2,
      originV2: {
        kind: "note_round",
        roundId: ROUND_ID,
        noteId: NOTE_ID,
        objectiveId: OBJECTIVE_ID,
      },
      goal: "stabilize",
      requestedTimeBudgetSeconds: 180,
      responsePreference: "adaptive",
    },
  };

  it("有起点才摆「练一道」：按下去发的就是服务端那一份 start，随即接上旅程界面", async () => {
    const { api, invoke, roundBlock } = await show([], {
      openRound: roundRow(),
      roundTeaching: teachingRow(),
      practiceStart,
    });
    const button = [...roundBlock()!.querySelectorAll("button")].find((b) => b.textContent === "拿这道题试一次");
    expect(button).toBeTruthy();
    fireEvent.click(button!);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(api.learningRun.start).toHaveBeenCalledTimes(1);
    const input = api.learningRun.start.mock.calls[0][0] as { request: unknown };
    // 逐字节比：这一页若自己拼一份 start，最可能拼错的就是锚点那一格
    // （note_round 的 objectiveId 是必填，缺了服务端会拒）。
    expect(input.request).toEqual(practiceStart.start);
    expect((input.request as { originV2: { kind: string } }).originV2.kind).toBe("note_round");
    // 开出去之后**留在这一页**（2026-09-28 用户裁决）：`activeRunId` 落位、工位挂在
    // 学习页的 `practice` 那一屏里，不换页、不换操作语言。钉的是"没有跳走"。
    expect(invoke).not.toHaveBeenCalledWith("validate");
    expect(useRoomStore.getState().activeRunId).toBe(RUN_ID);
  });

  it("没有起点（无目标的轮次）：不摆「练一道」，其余教学面照旧", async () => {
    const { roundBlock } = await show([], { openRound: roundRow(), roundTeaching: teachingRow() });
    const block = roundBlock()!;
    expect([...block.querySelectorAll("button")].some((b) => b.textContent === "拿这道题试一次")).toBe(false);
    // 对照：解释还在（"没有练一道"不是"整块没画"）。
    expect(block.querySelector(".round-prose__body")).toBeTruthy();
  });

  it("练过的几道可回看日期与结论；没结算的那一场可继续原 Run", async () => {
    const { roundBlock, container, invoke } = await show([], {
      openRound: roundRow(),
      roundTeaching: teachingRow(),
      practices: [
        { runId: RUN_ID, phase: "completed", outcome: "declared_unable", startedAt: "2026-09-26T04:20:00.000Z" },
        {
          runId: "99999999-9999-4999-8999-999999999999",
          phase: "active",
          outcome: null,
          startedAt: "2026-09-26T05:20:00.000Z",
        },
      ],
    });
    const block = roundBlock()!;
    expect(block.textContent).toContain("这一道已经在答了");
    expect(block.textContent).toContain("回到那道题作答");
    expect(within(block).getByRole("button", { name: "回到那道题" })).toBeTruthy();
    fireEvent.click(within(block).getByText("这一轮之前做过的 1 道"));
    const earlier = block.querySelector(".round-runlist li")!;
    expect(earlier.textContent).toContain("2026");
    expect(earlier.textContent).toContain(roundPracticeStateLabelV1({ phase: "completed", outcome: "declared_unable" }));
    fireEvent.click(within(earlier as HTMLElement).getByRole("button", { name: "看这一次" }));
    expect(useRoomStore.getState().activeRunId).toBe(RUN_ID);
    // 同样就地：回看一次作答不换页（2026-09-28 用户裁决）。
    expect(invoke).not.toHaveBeenCalledWith("validate");
    fireEvent.click(within(block).getByText("先回看讲解"));
    expect(container.querySelector(".round-prose__body")?.textContent).toBe(teachingRow().content.explanation);
  });

  it("那一格的措辞由一处签发：七种结论各有自己的话，没结论时按 phase 说状态", () => {
    expect(roundPracticeStateLabelV1({ phase: "completed", outcome: "demonstrated" })).toBe("做出来了");
    expect(roundPracticeStateLabelV1({ phase: "completed", outcome: "needs_repair" })).toBe("还有一处要补");
    expect(roundPracticeStateLabelV1({ phase: "completed", outcome: "not_assessable" })).toBe("这一次判不了");
    expect(roundPracticeStateLabelV1({ phase: "active", outcome: null })).toBe("正在进行");
    expect(roundPracticeStateLabelV1({ phase: "paused", outcome: null })).toBe("停住了");
    expect(roundPracticeStateLabelV1({ phase: "cancelled", outcome: null })).toBe("中断了");
  });
});

/**
 * 缺口帮助停止之后的四选一（39d W4-6 刀四）。
 *
 * 这一组钉三件事：**停了才摆**（没停不许多一行）；四档里那三档真有去处——换解释走同一发
 * 生成的 `regenerate`（同一问题落第二条）、回材料核对把依据那段带到眼前、先结束收尾这一轮；
 * 前置建议只有服务端给出候选时才展示，不凭空写一条没有行动的占位说明。
 */
describe("缺口帮助停止后的四选一（39d W4-6 刀四）", () => {
  const stopped = { stopped: true, consecutiveHelpCount: 2, threshold: 2 };
  const settledPractice = { runId: RUN_ID, phase: "completed", outcome: "needs_repair", startedAt: "2026-09-26T04:20:00.000Z" };

  it("停了才摆：那一句只说读数，没有前置候选时不虚构建议", async () => {
    const { roundBlock } = await show([], { openRound: roundRow(), roundTeaching: teachingRow({ sourceBlockOrdinals: [0] }), practices: [settledPractice], gapHelp: stopped });
    const block = roundBlock()!;
    fireEvent.click(within(block).getByText("这次需要换一种帮助"));
    expect(block.textContent).toContain(ROUND_COPY.teaching.stopLead(2));
    // 那句话是对**读数**说的，不许变成对用户的判断。
    expect(block.textContent).not.toContain("你没有改善");
    const labels = [...block.querySelectorAll(".round-receipt button")].map((b) => b.textContent);
    expect(labels).toEqual(["看这一次", ROUND_COPY.teaching.switchExplanation, ROUND_COPY.teaching.backToMaterial]);
    expect(block.textContent).not.toContain("补一节前置还没接上");
  });

  it("没停就不摆那一块", async () => {
    const { roundBlock } = await show([], { openRound: roundRow(), roundTeaching: teachingRow(), practices: [settledPractice] });
    expect(roundBlock()!.textContent).not.toContain("这次需要换一种帮助");
  });

  it("「换一种解释」发的是 regenerate：同一问题落第二条，不是复用", async () => {
    const { api, roundBlock } = await show([], { openRound: roundRow(), roundTeaching: teachingRow(), practices: [settledPractice], gapHelp: stopped });
    fireEvent.click(within(roundBlock()!).getByText("这次需要换一种帮助"));
    const button = [...roundBlock()!.querySelectorAll(".round-receipt button")]
      .find((b) => b.textContent === ROUND_COPY.teaching.switchExplanation)!;
    fireEvent.click(button);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(api.noteLearningRound.explain).toHaveBeenCalledTimes(1);
    expect(api.noteLearningRound.explain.mock.calls[0][0]).toMatchObject({ regenerate: true });
  });

  it("「回材料核对」把依据那一段带到眼前；「先结束这一轮」走的是收尾那一发", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const blocks: NoteBlockProjectionV1[] = [
      { ordinal: 1, type: "heading", content: "## 间隔重复" },
      { ordinal: 2, type: "paragraph", content: "间隔重复说的是在快要忘记的时候再见到它。" },
    ];
    const { api, roundBlock, container } = await show([], {
      openRound: roundRow({ revision: 5 }),
      blocks,
      roundTeaching: teachingRow({ sourceBlockOrdinals: [1, 2] }),
      practices: [settledPractice],
      gapHelp: stopped,
    });
    fireEvent.click(within(roundBlock()!).getByText("这次需要换一种帮助"));
    const options = (label: string) => [...roundBlock()!.querySelectorAll(".round-receipt button")]
      .find((b) => b.textContent === label)!;

    scrollIntoView.mockClear();
    fireEvent.click(options(ROUND_COPY.teaching.backToMaterial));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-block-ordinal="1"]')!.getAttribute("data-block-focused")).toBe("true");

    expect(container.querySelector("#notebook-reading-leaf")).toBeTruthy();
    expect(api.noteLearningRound.close).not.toHaveBeenCalled();
  });
});

/**
 * 动态产物的挂载（39d W4-6 刀五）。
 *
 * 这一组钉三件下沉到界面上的判断：
 *  1. 有动态版本时才**发一次落盘**（幂等那一发由 main 负责，界面只管"确保"），
 *     落盘成功之后隔离展示面的宿主才挂上去——**渲染层不拿 HTML**，只报 id；
 *  2. 落盘失败**不冒充教学失败**：宿主不挂（不画浏览器自己的错误页），留一句如实说明，
 *     而文字解释照旧在屏上；
 *  3. 没有动态版本的那一条：不发那一发、也不多一行话。
 */
describe("动态产物的挂载（39d W4-6 刀五）", () => {
  const artifact = {
    version: 1,
    artifactId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    kind: "dynamic_explanation",
    createdAt: "2026-09-26T05:00:00.000Z",
  };

  it("有动态版本：发一次落盘（带 id），成功后挂上宿主", async () => {
    const { api, container } = await show([], {
      openRound: roundRow(),
      roundTeaching: teachingRow(),
      artifact,
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(api.artifact.ensure).toHaveBeenCalledTimes(1);
    expect(api.artifact.ensure.mock.calls[0][0]).toMatchObject({ artifactId: artifact.artifactId });
    const slot = container.querySelector(".round-sheet")!;
    expect(slot).not.toBeNull();
    expect(slot.querySelector("iframe")).toBeTruthy();
  });

  it("落盘失败：不挂宿主、如实说一句，文字解释照旧", async () => {
    const { container } = await show([], {
      openRound: roundRow(),
      roundTeaching: teachingRow(),
      artifact,
      artifactEnsureFails: true,
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(container.querySelector(".round-sheet iframe")).toBeNull();
    expect(within(container).getByRole("alert").textContent).toContain(ROUND_COPY.teaching.artifactFailed);
    // "动态失败不冒充教学失败"：解释与依据都还在。
    expect(container.querySelector(".round-prose__body")?.textContent?.length ?? 0).toBeGreaterThan(0);
  });

  it("没有动态版本：不发那一发，也不多一行话", async () => {
    const { api, container } = await show([], { openRound: roundRow(), roundTeaching: teachingRow() });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(api.artifact.ensure).not.toHaveBeenCalled();
    expect(container.querySelector(".round-sheet")).toBeNull();
    expect(container.querySelector(".round-sheet iframe")).toBeNull();
  });
});

/**
 * 「继续这一轮」：停住的那一轮在屏幕上的那个出口（39d W4-5 ④ 的前置）。
 *
 * `paused → active` 那条判据在服务端 reducer（轮次族集测钉过），这里钉的是**这一侧欠的那一整条路**：
 * 在接上这一发之前，任何一条被暂停的轮次（从 API 就造得出来）在界面上是永久死路——它既回不到
 * 进行中，又还占着 §6.1 那个未完成名额（同一篇开不出第二轮）。四件里任何一件消失，症状都是
 * "那一轮停在原地"：
 *  1. 那颗按钮**只**在服务端那一行是 `paused` 时出现：`active` 与"这一篇没有未完成轮次"两种时候
 *     都不在（摆错了地方就是在教用户"这里有个能继续的东西"，而它没有）；
 *  2. 按下去交出去的是服务端那一行的 `roundId` 与读过的那一版 `expectedRevision`，不是本机记的数；
 *  3. 成功之后屏上换读的是服务端读回来的那一条，而且是 **silent**（整屏换成加载态等于把她眼前
 *     那份材料抽走一次，刀二那条纪律在恢复这一发上同样成立）；
 *  4. 失败留一句如实的话，那一行不撤（撤了会被读成"已经继续了"，而它什么都没发生）。
 */
describe("停住的那一轮：「继续这一轮」（W4-5 ④ 的前置）", () => {
  const pausedRow = (overrides: Record<string, unknown> = {}) => roundRow({
    phase: "paused",
    pausedAt: "2026-09-26T04:30:00.000Z",
    revision: 3,
    ...overrides,
  });
  const buttonNamed = (block: HTMLElement | null, label: string) =>
    [...(block?.querySelectorAll("button") ?? [])].find((node) => node.textContent === label) ?? null;
  const resumeButton = (block: HTMLElement | null) => buttonNamed(block, ROUND_COPY.resume);

  it("那颗按钮只在服务端那一行是 paused 时出现；active 那一行与没有轮次时都不在", async () => {
    const stopped = await show([], { openRound: pausedRow() });
    expect(resumeButton(stopped.roundBlock())).toBeTruthy();

    cleanup();
    const running = await show([], { openRound: roundRow() });
    expect(resumeButton(running.roundBlock())).toBeNull();

    cleanup();
    // 这一篇没有未完成轮次：旧练习页不作为新笔记的入口。
    const none = await show([]);
    expect(none.roundBlock()).toBeNull();
    expect(resumeButton(none.roundBlock())).toBeNull();
  });

  it("按下去发的是服务端那一行的 id 与读过的那一版；在途那一秒按钮禁用，一次点击不重发", async () => {
    const stopped = pausedRow({ drivingQuestion: "停住的那一轮的问题", revision: 5 });
    const { api, roundBlock } = await show([], { openRound: stopped });
    let settle: ((value: unknown) => void) | null = null;
    api.noteLearningRound.resume.mockImplementationOnce(
      () => new Promise((resolve) => { settle = resolve; }),
    );
    const button = resumeButton(roundBlock())!;
    fireEvent.click(button);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(api.noteLearningRound.resume).toHaveBeenCalledTimes(1);
    expect(api.noteLearningRound.resume.mock.calls[0][0]).toMatchObject({
      roundId: stopped.roundId,
      expectedRevision: 5,
    });
    expect(api.noteLearningRound.resume.mock.calls[0][0].meta).toBeTruthy();
    // "正在…"只许出现在真有一次请求在途的那一段时间里（这一页所有按钮共用的规矩）
    expect(button.textContent).toBe(ROUND_COPY.resuming);
    expect(button.disabled).toBe(true);
    await act(async () => { settle?.(ok({ version: 1, round: roundRow({ revision: 6 }) })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(api.noteLearningRound.resume).toHaveBeenCalledTimes(1);
  });

  it("成功之后屏上换读服务端读回来的那一条，且这一屏没被换成加载态", async () => {
    const stopped = pausedRow({ drivingQuestion: "停住时那一句", revision: 4 });
    const resumed = roundRow({
      drivingQuestion: "接上之后服务端那一句",
      revision: 5,
      pausedAt: "2026-09-26T04:30:00.000Z",
      resumedAt: "2026-09-26T05:00:00.000Z",
    });
    const { api, container, roundBlock } = await show([], { openRound: stopped, openSequence: [stopped, resumed] });
    fireEvent.click(resumeButton(roundBlock())!);
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });

    const shown = roundBlock()!.textContent ?? "";
    expect(roundBlock()!.querySelector(".round-slip__question")?.textContent).toBe("接上之后服务端那一句");
    expect(shown).not.toContain("停住时那一句");
    // 那颗按钮随状态一起撤：它读的是服务端那一行，不是"我刚才按过了"。
    expect(resumeButton(roundBlock())).toBeNull();
    // silent 的那次回读：这一屏还是那张纸（非 silent 会把它整屏换成加载态）。
    expect(container.textContent).not.toContain("正在读取真实笔记");
    // 回读之后教学面也跟着换读服务端那一份（恢复那一发的回执不是本机拼的那一块）。
    expect(api.noteLearningRound.teaching).toHaveBeenCalled();
  });

  it("失败：留一句如实的话，那一行不撤、那颗也还在（什么都没发生过）", async () => {
    const stopped = pausedRow({ drivingQuestion: "还是停着的那一句", revision: 4 });
    const { api, roundBlock } = await show([], {
      openRound: stopped,
      openSequence: [stopped, stopped],
      resumeFails: true,
    });
    fireEvent.click(resumeButton(roundBlock())!);
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });

    expect(roundBlock()!.querySelector('[role="alert"]')?.textContent).toBeTruthy();
    const shown = roundBlock()!.textContent ?? "";
    expect(roundBlock()!.querySelector(".round-slip__question")?.textContent).toBe("还是停着的那一句");
    // 换回服务端那一版之后仍然是停着的：那颗按钮必须还在，否则这一发失败被她读成成功了。
    expect(resumeButton(roundBlock())).toBeTruthy();
    expect(resumeButton(roundBlock())!.textContent).toBe(ROUND_COPY.resume);
  });
});

/**
 * W7-3 刀三：目标级「暂不安排」／「恢复并开启」（39 §9.1 行 2、行 3）。
 *
 * 这一组钉的是**屏上那一句承诺有没有兑现**，四件：
 *  1. 排除生效时换上去的是恢复那颗，而且那颗承诺的是「恢复**并开启**」——
 *     §9.1 行 3：只解除会让用户点完之后那个目标再也回不到队列（撤下去的是
 *     `dismissed` 终态），所以文案退化成"取消排除"就会重新造出那个洞。
 *  2. 立排除那一发**有后果要说**：回执里「撤下了 N 条」是这一发唯一让用户看见
 *     后果的地方（§9.1「操作时说明」），不说就等于只有未来被挡住。
 *  3. 失败**不吞**，且失败时**不同时挂着一句成功回执**——两句话同时挂着会被读成
 *     "没生效但有结果"。
 *  4. 发出去的那一发要带**这一篇的 noteId**：服务端按笔记判可见性，漏了就是 400。
 *
 * 每格都带正控制：①的反向是"被排除时不该再有那颗"；②的反向是"撤了 0 条说另一句"；
 * ③的反向是成功那格不挂 alert。
 */
describe("笔记页：目标级「暂不安排」/「恢复并开启」", () => {
  const HELD_AT = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const heldItem = () => listItem({
    reviewHold: { objectiveId: OBJECTIVE_ID, noteId: NOTE_ID, reasonCode: "user_deferred_objective", createdAt: HELD_AT },
  });

  it("正对照：没被排除时，那颗按钮与它的范围说明都在屏上", async () => {
    const { objectiveBlock } = await show([listItem()]);
    const block = objectiveBlock()!;
    expect(block).not.toBeNull();
    fireEvent.click(within(block).getByRole("button", { name: "暂不安排这个目标" }));
    // 范围说明必须出现："只停这一个目标的回访安排"——不说的话用户会以为整篇停了。
    expect(within(block).getByText(/只停这一个目标/)).toBeTruthy();
  });

  it("按下去带的是这一篇的 noteId 与这一颗目标，并念出撤下了几条", async () => {
    const { objectiveBlock, api } = await show([listItem()]);
    const block = objectiveBlock()!;
    await act(async () => {
      fireEvent.click(within(block).getByRole("button", { name: "暂不安排这个目标" }));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(api.review.holdObjective).toHaveBeenCalledTimes(1);
    const sent = api.review.holdObjective.mock.calls[0][0];
    expect(sent.request).toEqual({ noteId: NOTE_ID, objectiveId: OBJECTIVE_ID });
    // §9.1「操作时说明」：撤下几条是这一发唯一的后果说明。
    expect(within(block).getByText(/撤下了 2 条/).textContent).toContain("暂不安排");
  });

  it("正对照：撤了 0 条时说成另一句，不让「0 条」读成没生效", async () => {
    const { objectiveBlock } = await show([listItem()], { dismissedPendingSchedules: 0 });
    const block = objectiveBlock()!;
    await act(async () => {
      fireEvent.click(within(block).getByRole("button", { name: "暂不安排这个目标" }));
      await vi.advanceTimersByTimeAsync(10);
    });
    const notice = within(block).getByText(/没有排着的回访/);
    expect(notice.textContent).not.toContain("0 条");
  });

  it("排除生效时：换上去的是「恢复并开启」，且那颗「暂不安排」不在屏上", async () => {
    const { objectiveBlock } = await show([heldItem()]);
    const block = objectiveBlock()!;
    expect(within(block).getByRole("button", { name: "恢复并开启" })).toBeTruthy();
    // 反向：两个动作**不同时**在屏上——一颗开关会把 §9.1 规则表中间那半句折叠掉。
    expect(within(block).queryByRole("button", { name: "暂不安排这个目标" })).toBeNull();
    // 排除期间要说清为什么它不回到队列，以及怎么回来。
    expect(within(block).getByText(/别的目标和已经记下的练习都不动|笔记和卡片的其他安排照旧/)).toBeTruthy();
  });

  it("恢复那一发念出回访日期；沿用已有的那一格说「沿用」", async () => {
    const view = await show([heldItem()], { resumeScheduled: "reused_existing" });
    const block = view.objectiveBlock()!;
    await act(async () => {
      fireEvent.click(within(block).getByRole("button", { name: "恢复并开启" }));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(view.api.review.resumeObjective).toHaveBeenCalledTimes(1);
    const said = within(block).getByText(/沿用已经排好的安排/).textContent;
    expect(said).not.toContain("已经排上");
  });

  it("恢复失败（409 still_held）：屏上有 alert，且**没有**成功回执同时挂着", async () => {
    const view = await show([heldItem()], { resumeObjectiveFails: true });
    const block = view.objectiveBlock()!;
    await act(async () => {
      fireEvent.click(within(block).getByRole("button", { name: "恢复并开启" }));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(within(block).getByRole("alert")).toBeTruthy();
    // 这一格是第 3 件事的正控制：失败时那句「已经排上…」不许还在。
    expect(within(block).queryByText(/沿用已经排好的安排/)).toBeNull();
  });
});

/**
 * W7-3 刀六：笔记订阅那一档（39 §9.1 第一段与规则表行 1）。
 *
 * 钉的是规则表行 1 那一句，以及它的三处会被折叠掉的地方：
 *  1. **两颗开关而不是一颗 toggle**——「两种意图可以分别存在」，合成一颗就把
 *     "停哪一个"变成系统的默认。
 *  2. **停用那一发要念出「仍由 X 继续安排」**（`stillCoveredBy` 非空时）。只说
 *     "已停用"会让用户以为整篇都不提醒了，而她那张卡明明还开着——这比多显示
 *     一行字重要得多，所以它是本组的主断言。
 *  3. **连暂停的也读**：开关要能拨回"开"，只读活着的那些就等于"停过的那篇
 *     从此找不到"。
 *
 * 每格带正控制：①的反向是"没订阅时那一档在屏上"；②的反向是"空数组说另一句"；
 * ③的反向是"停过的那份出现在屏上且开关在关的位置"。
 */
describe("笔记页：笔记订阅（39 §9.1 规则表行 1）", () => {
  const active = {
    source: "note_subscription" as const,
    subjectType: "note" as const,
    subjectId: NOTE_ID,
    status: "active" as const,
    scopeNote: "持续回访这篇里学过的东西。",
    createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    pausedAt: null,
  };
  const paused = { ...active, status: "paused" as const, pausedAt: new Date().toISOString() };

  it("正对照：这一篇没订阅过时，那一档在屏上，标签说得出「开启笔记订阅」", async () => {
    const { objectiveBlock } = await show([listItem()]);
    const block = objectiveBlock()!;
    expect(within(block).getByRole("button", { name: "开启笔记订阅" })).toBeTruthy();
    // 停用那一颗**不在**：没订阅就没有"停"可停。
    expect(within(block).queryByRole("button", { name: "停用笔记订阅" })).toBeNull();
  });

  it("订阅开着时换上去的是「停用笔记订阅」，并且范围说明念出来", async () => {
    const { objectiveBlock } = await show([listItem()], { noteSubscriptions: [active] });
    const block = objectiveBlock()!;
    expect(within(block).getByRole("button", { name: "停用笔记订阅" })).toBeTruthy();
    // §9.1「开启时用一句话说明这个持续范围」——那句话要能念出来。
    expect(within(block).getByText(/持续回访这篇里学过的东西/).textContent).toContain("现在在持续回访");
  });

  it("停用那一发：仍有卡片订阅时，屏上必须念「仍由卡片复习继续安排」", async () => {
    const view = await show([listItem()], { noteSubscriptions: [active], stillCoveredBy: ["card_review"] });
    const block = view.objectiveBlock()!;
    await act(async () => {
      fireEvent.click(within(block).getByRole("button", { name: "停用笔记订阅" }));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(view.api.review.pauseSubscription).toHaveBeenCalledTimes(1);
    const sent = view.api.review.pauseSubscription.mock.calls[0][0];
    expect(sent.request).toEqual({ source: "note_subscription", subjectId: NOTE_ID });
    const said = within(block).getByText(/仍由/).textContent;
    expect(said).toContain("已停用笔记订阅");
    expect(said).toContain("卡片复习");
  });

  it("正对照：停用之后没有任何来源撑着时，说的是另一句", async () => {
    const view = await show([listItem()], { noteSubscriptions: [active], stillCoveredBy: [] });
    const block = view.objectiveBlock()!;
    await act(async () => {
      fireEvent.click(within(block).getByRole("button", { name: "停用笔记订阅" }));
      await vi.advanceTimersByTimeAsync(10);
    });
    const said = within(block).getByText(/不再被安排/).textContent;
    expect(said).toContain("已停用笔记订阅");
    expect(said).not.toContain("仍由");
  });

  it("停过的那一份也出现在屏上，开关在「开启」那一档（能拨回去）", async () => {
    const { objectiveBlock } = await show([listItem()], { noteSubscriptions: [paused] });
    const block = objectiveBlock()!;
    expect(within(block).getByRole("button", { name: "开启笔记订阅" })).toBeTruthy();
    // 暂停那一刻的时间要念出来：屏上要能说"她什么时候停的"。
    expect(within(block).getByText(/停用了它/).textContent).toContain("持续回访这篇里学过的东西");
  });

  it("失败时屏上有 alert，且**不同时挂着一句成功回执**", async () => {
    const view = await show([listItem()], { noteSubscriptions: [active], subscriptionFails: true });
    const block = view.objectiveBlock()!;
    await act(async () => {
      fireEvent.click(within(block).getByRole("button", { name: "停用笔记订阅" }));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(within(block).getByRole("alert")).toBeTruthy();
    expect(within(block).queryByText(/已停用笔记订阅/)).toBeNull();
  });
});

// 「回到本轮学习」必须真的回到这一轮。
// 此前练习结算那张回执上的按钮写着"回到本轮学习"，但恢复逻辑只在**轮次已经结束**
// 时切到 history；轮次还开着的那一支什么都不做，落点停在 leaf 的默认值 reading
// ——按的是"回到本轮学习"，看到的是正文。
it("从一次尝试回到本轮：轮次还开着时落在「本轮学习」，不是正文页", async () => {
  const { container } = await show([], {
    learningRoundId: "77777777-7777-4777-8777-777777777777",
    openRound: roundRow(),
  });
  // 轮次还开着 ⇒ 落在本轮学习，不该是正文页
  expect(container.querySelector("#notebook-learning-leaf")).not.toBeNull();
  expect(container.querySelector("#notebook-reading-leaf")).toBeNull();
});

it("从一次尝试回到本轮：轮次已经结束时落在「学习记录」", async () => {
  const { container } = await show([], {
    learningRoundId: "77777777-7777-4777-8777-777777777777",
    openSequence: [null],
  });
  // 轮次收掉了 ⇒ 落在学习记录
  expect(container.querySelector("#notebook-history-leaf")).not.toBeNull();
});

/**
 * 39f 的那几刀，在**真实渲染**上钉住。
 *
 * 这一组只钉屏上看得见的那几件事：问题在薄荷牌上、三枚纸签按真实状态亮、暂停回来有一张
 * 真回执（不是空纸）、回到正文有两枚说得清的书签、结果三行指名道姓。
 * 纯逻辑那一半（纸签怎么判、结果那三行怎么写）在 `note-learning-flow.test.ts` 里。
 */
describe("39f：学习纸面上的物件与上下文", () => {
  const plate = (block: HTMLElement | null) => block?.querySelector<HTMLElement>(".round-slip__question") ?? null;
  const track = (block: HTMLElement | null) =>
    [...(block?.querySelectorAll<HTMLElement>(".round-thread li") ?? [])];

  it("这一轮的问题在薄荷标题牌上，不是页眉里一行没框的字", async () => {
    const { roundBlock } = await show([], { openRound: roundRow() });
    const board = roundBlock()!.querySelector<HTMLElement>(".round-slip--question");
    expect(board).toBeTruthy();
    expect(plate(roundBlock())!.textContent).toBe("判断为什么有索引，查询仍然可能慢");
    // 没有开轮次时这一块不出：那时尚没有问题，主视觉让给下面那张问法纸签。
    cleanup();
    const fresh = await show([]);
    expect(fresh.roundBlock()).toBeNull();
  });

  it("三枚纸签：什么也没做时只有第一枚亮，其余不装", async () => {
    const { roundBlock } = await show([], { openRound: roundRow() });
    expect(track(roundBlock()).map((node) => node.dataset.mark)).toEqual(["current", "todo", "todo"]);
    expect(track(roundBlock()).map((node) => node.textContent)).toEqual([
      "讲一遍正在讲", "试一次还没试过", "看收获等试过之后",
    ]);
  });

  it("讲过、练过之后纸签跟着亮，且只数已结算的那几次", async () => {
    const { roundBlock } = await show([], {
      openRound: roundRow(),
      roundTeaching: { createdAt: "2026-09-26T04:10:00.000Z", sourceBlockOrdinals: [], content: { explanation: "先合上书讲一遍。", example: null } },
      practices: [
        { runId: RUN_ID, phase: "settled", outcome: "demonstrated", startedAt: "2026-09-26T04:20:00.000Z" },
      ],
      nextStep: { kind: "finish", basisRunId: null, gapFacets: [], evidence: "independent_demonstrated" },
    });
    expect(track(roundBlock()).map((node) => node.dataset.mark)).toEqual(["done", "done", "done"]);
    expect(track(roundBlock())[1]!.textContent).toContain("已经试过 1 次");
  });

  it("暂停回来有一张真回执：讲过没有、做过几次、接下来是哪一步", async () => {
    const stopped = await show([], {
      openRound: roundRow({ phase: "paused", pausedAt: "2026-09-26T04:30:00.000Z", revision: 3 }),
      roundTeaching: { createdAt: "2026-09-26T04:10:00.000Z", sourceBlockOrdinals: [], content: { explanation: "先合上书讲一遍。", example: null } },
      practices: [
        { runId: RUN_ID, phase: "settled", outcome: "partial", startedAt: "2026-09-26T04:20:00.000Z" },
      ],
      nextStep: { kind: "retry", basisRunId: null, gapFacets: [], evidence: "incomplete" },
    });
    const receipt = stopped.roundBlock()!.querySelector<HTMLElement>(".round-slip--paused")!;
    expect(receipt).toBeTruthy();
    const rows = [...receipt.querySelectorAll<HTMLElement>(".round-ledger > div")];
    expect(rows).toHaveLength(3);
    expect(rows[0]!.querySelector("dt")?.textContent).toBe("讲解");
    expect(rows[0]!.textContent).toContain("讲过");
    expect(rows[1]!.textContent).toContain("做过 1 次");
    // 「接下来」那一格与结果页第三行读的是同一句（`roundTrackNextV1`）。
    expect(rows[2]!.textContent).toContain("可以再试一次");
    // 暂停时那颗"接着学下去"仍在纸脚，不因为换了版面就消失。
    expect(stopped.roundBlock()!.textContent).toContain(ROUND_COPY.resume);
  });

  it("暂停且什么都没做时，回执如实写「还没讲过」「还没试过」，不装成做过", async () => {
    const stopped = await show([], {
      openRound: roundRow({ phase: "paused", pausedAt: "2026-09-26T04:30:00.000Z" }),
    });
    const receipt = stopped.roundBlock()!.querySelector<HTMLElement>(".round-slip--paused")!;
    expect(receipt.textContent).toContain("还没讲过");
    expect(receipt.textContent).toContain("还没试过");
  });

  it("正式练习回链只打开指定的旧轮次，用户可明确回到笔记正文", async () => {
    const view = await show([], { leaf: "learning", openRound: roundRow() });
    expect(view.container.querySelector("#notebook-learning-leaf")).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(view.container).getByRole("button", { name: "回到正文" }));
    });
    expect(view.container.querySelector("#notebook-reading-leaf")).toBeTruthy();
    expect(view.container.querySelector("#notebook-learning-leaf")).toBeNull();
  });

  it("结果那三行指名道姓：问题、最近一次的结算、还差的一个动作", async () => {
    const settled = await show([], {
      openRound: roundRow(),
      practices: [
        { runId: RUN_ID, phase: "settled", outcome: "demonstrated", startedAt: "2026-09-26T04:20:00.000Z" },
      ],
      nextStep: { kind: "finish", basisRunId: null, gapFacets: [], evidence: "independent_demonstrated" },
    });
    const answers = settled.roundBlock()!.querySelector<HTMLElement>(".round-receipt")!;
    const today = answers.querySelector(".round-receipt__today")?.textContent ?? "";
    const gap = answers.querySelector(".round-receipt__gap")?.textContent ?? "";
    const next = answers.querySelector(".round-receipt__next")?.textContent ?? "";
    expect(today).toContain("判断为什么有索引，查询仍然可能慢");
    expect(today).toContain("走出来了");
    expect(today).toContain("做出来了");
    expect(gap).toContain("整篇笔记");
    expect(next).toContain("这一轮可以收了");
    // 旧版那三句通用话不许再出现。
    expect(settled.roundBlock()!.textContent).not.toContain("留下作答记录");
  });
});
