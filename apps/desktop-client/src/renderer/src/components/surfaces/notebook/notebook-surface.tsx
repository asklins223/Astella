import { publishCompanionRecordsChanged } from "../../companion/companion-events";
import { NoteReflectionShelf } from "./note-reflection-shelf.tsx";
import { noteLearningScene, notePracticeResultCopy, roundTrackNextV1, roundTrackV1 } from "./note-learning-flow.ts";
import { stageReflectionAppend } from "./note-reflection-document.ts";
import { LearningRunBody, releaseRunThroughMainV1 } from "../run/learning-run-surface.tsx";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BookOpen, Clock3, FileText, History, Link2, MessageCircle, PencilLine, RefreshCw, Sparkles, X } from "lucide-react";
import type { CapabilityProjectionV1 } from "@ailearn/shared/desktop-ipc-contracts";
import type {
  CardGenerationActiveSummaryV1,
  CardGenerationRunSnapshotV1,
  DesktopCardGenerationFeedbackReasonV2,
} from "@ailearn/shared/card-generation-desktop-contracts";
import type { RoomProjectionV1 } from "@ailearn/shared/room-projection-contracts";
import { reviewSubscriptionV2Schema } from "@ailearn/shared/review-queue-v2-contracts";
import type { z } from "zod";
import type { DesktopNoteVersionItem, DesktopSourceDetail } from "@ailearn/shared/desktop-surface-contracts";
import type {
  LearningObjectiveSurfaceV3,
  ObjectiveNoteChangeImpactV1,
  ObjectiveReviewHoldV1,
} from "@ailearn/shared/learning-objective-surface-contracts";
/** W7-3 刀六：笔记订阅那一行。取共享合同那份，渲染层不再自己拼形状。 */
type NoteReviewSubscriptionV1 = z.infer<typeof reviewSubscriptionV2Schema>;
import type { NoteBlockProjectionV1, NoteDetailV1 } from "@ailearn/shared/note-projection-contracts";
import type {
  NoteLearningRoundHistoryV1,
  NoteLearningRoundV1Wire,
  RoundPracticeV1,
  RoundTeachingV1,
  RoundTeachingViewV1,
} from "@ailearn/shared/note-learning-round-contracts";
import { useRoomStore } from "../../../app/room-store";
import { SETTINGS_ATTENTION_AI_CONSENT } from "../../../app/companion-consent-gate";
import { SpaceShareButton, noteShareScopeLabel } from "../../space-share-control";
import type { NoteShareScopeV1 } from "@ailearn/shared/note-share-contracts";
import type { DesktopRouteV1 } from "@ailearn/shared/desktop-ipc-contracts";
import {
  createCommandId,
  createRequestMeta,
  classifyGatewayError,
  gatewayErrorMessage,
  type GatewayFailureKind,
  RendererGatewayError,
  unwrapGatewayResult,
} from "../../../app/desktop-client";
import { imageOnlyFiles } from "../../../app/source-intake";
import { ROUND_RECORD_COPY_V1, roundHistoryStateLabelV1, roundRecordDayV1, roundRecordModesLabelV1 } from "./round-record-copy.ts";
import { NoteRouteCoverage } from "./note-route-coverage.tsx";
import type { NoteRouteCoverageV1 } from "@ailearn/shared/note-route-coverage-v2";
import { useHudPage } from "../../hud/use-hud-page";
import type { PageReadableV1 } from "@ailearn/shared/companion-bridge-contracts";
import { usePageReadableView } from "../../hud/use-page-readable-view";
import type { HudPageId } from "../../hud/hud-pages";
import {
  SurfaceDataState,
  formatRelative,
  noteBlockText,
  parseImageBlock,
  useSurfaceProjection,
} from "./surface-data.tsx";
import {
  cardGenerationStatusLabel,
  sourceCappedNotice,
  isLiveGenerationForNote,
  isNoteGenerationLive,
  isCardGenerationInFlight,
  isCardGenerationReviewOpen,
} from "../review/card-generation-status.ts";
import {
  reviewSourceScopeHint,
  reviewSourceSwitchLabel,
  reviewSubscriptionNotice,
  objectiveHoldActionDescription,
  objectiveHoldNotice,
  objectiveNoteChangeImpactCopy,
  objectiveResumeNotice,
  objectiveReviewHoldHint,
  objectiveReviewHoldLabel,
  OBJECTIVE_HOLD_ACTION_LABEL,
  OBJECTIVE_RESUME_ACTION_LABEL,
} from "../run/objective-state-copy.ts";
import { startObjectiveJourney } from "../run/objective-primary-action.ts";
import { ArtifactFrameHost } from "../source/artifact-frame-host.tsx";
import { NotebookLearningArtifactPaper } from "./notebook-learning-artifact-paper";
import { RoundNotice } from "./round-notice.tsx";
import { parseMarkdownTable } from "@ailearn/shared/note-doc-schema";
import { isHorizontalRule, noteInlineDisplayText, noteInlineImages, renderNoteInline } from "./note-reading-inline.tsx";
import { sourceImageObjectKeyFromUrl } from "@ailearn/shared/source-image-contracts";
import { markdownToBlocks } from "@ailearn/shared/markdown-parser";
import { useSourceImage } from "../source/source-image.ts";
import { ImageGalleryLightbox, useImageLightbox, ZoomableReadingImage, type GalleryImage } from "../source/image-viewer.tsx";
import type { NoteMarkdownEditorHandle } from "./note-markdown-editor.tsx";
import { NoteDocumentEditor } from "./note-document-editor";
import { annotationPlacements, chronologicalAnnotations } from "./note-annotation-placement";
import { AnnotationDeleteControl, useAnnotationDeleteConfirm } from "./annotation-delete-control";
import { isNoteEditingMode, type NoteBodyMode } from "./note-document-mode";
import { useNotebookBodyMode } from "./use-notebook-body-mode";
import { NotebookDesk } from "./notebook-desk";
import { NotebookEditorTools } from "./notebook-editor-tools";
import { useNotebookLinkEditor } from "./notebook-link-editor";
import { noteOutline } from "./note-outline";
import { useNotebookLearningView } from "./use-notebook-learning-view";
import { useNotebookLearningEntry, type NoteLearningTask } from "./use-notebook-learning-entry";
import { TaskSlip } from "./task-slip";
import { NotebookVersionChoice } from "./notebook-version-choice";
import { NotebookLearningPage } from "./notebook-learning-page";
import { NotebookCardEntry } from "./notebook-card-entry";
import { useNoteDocLiveView } from "./use-note-doc-live-view.ts";
import { NoteAnnotationSidePage } from "./note-annotation-side-page";
import { useNotebookSidePage } from "./use-notebook-side-page";
import { VersionHistory } from "./version-history.tsx";
import { ReadingBlock, ReadingImage } from "./notebook-reading-block.tsx";
import { noteReadingText } from "./note-reading-text";
import { noteAnchorMatchesV1 } from "@ailearn/shared/note-annotation-contracts";
import { noteBlockRenderedTextV1 } from "@ailearn/shared/note-doc-schema";
import { useNotebookAnnotationState } from "./use-notebook-annotation-state.ts";
import { useNotebookLearningArtifactState } from "./use-notebook-learning-artifact-state.ts";
import { prepareNotebookTaskNotification } from "./notebook-task-notifications";
import { useNotebookExpansionState } from "./use-notebook-expansion-state.ts";
import { useNotebookExpansionTask } from "./use-notebook-expansion-task.ts";
import { useNotebookRoundState } from "./use-notebook-round-state.ts";
import { useNotebookRecallState } from "./use-notebook-recall-state.ts";
import { useNotebookSaveState } from "./use-notebook-save-state.ts";
import { useNotebookPractice } from "./use-notebook-practice.ts";
import { useNotebookInspectedRound } from "./use-notebook-inspected-round.ts";
import { useNotebookOverview } from "./use-notebook-overview.ts";
import { useNotebookGoalResult } from "./use-notebook-goal-result.ts";
import { NoteRecallPaper } from "./notebook-recall-paper.tsx";
import { NoteOverviewPaper } from "./notebook-overview-paper.tsx";
import { GenerationSetup } from "./notebook-generation-setup.tsx";
import { RoundDeskLine } from "./notebook-round-line.tsx";
import { NotebookSelectionActions } from "./notebook-selection-actions.tsx";
import { useNotebookSelection } from "./use-notebook-selection";
import { useNotebookAnnotationDraft } from "./use-notebook-annotation-draft";
import { NotebookAnnotationComposer } from "./notebook-annotation-composer";
import { NotebookArtifactTaskPaper } from "./notebook-artifact-task-paper.tsx";
import { NotebookRoundRecap } from "./notebook-round-recap.tsx";
import { NotebookRoundHistory } from "./notebook-round-history.tsx";
import { NoteExpansionDrafts } from "./notebook-expansion-drafts.tsx";
import { NotebookPresence } from "./notebook-presence.tsx";
import { useNotebookReviewHold } from "./use-notebook-review-hold.ts";
import { useNotebookSubscription } from "./use-notebook-subscription.ts";
import { useNotebookTeaching } from "./use-notebook-teaching.ts";
import { useNotebookVersions } from "./use-notebook-versions.ts";
import { useNotebookGenerationFeedback } from "./use-notebook-generation-feedback.ts";
import { FINISHED_RUN_STATUSES, generationOptionSummary, useNotebookGenerationOptions } from "./notebook-generation-options.ts";
import { noteCardGenerationEntry } from "./note-card-generation-entry";
import { NoteImageUploads, useNoteImageUploads } from "./note-image-uploads.tsx";
import { feedNoteIntentToCompanion, feedSelectionToCompanion } from "../../companion/companion-feed";
import { noteAnchorsOverlap, noteExplanationBusy, pendingNoteExplanation, stopNoteExplanation, useNoteCompanionExplanations } from "../../companion/note-companion-explanation";
import { stopCompanionSpeech } from "../../../app/companion-voice-playback";
import { NoteCompanionExplanationPaper } from "./note-companion-explanation-paper";
import { noteAnnotationV1Schema, type NoteAnnotationAnchorV1, type NoteAnnotationTaskV1, type NoteAnnotationV1 } from "@ailearn/shared/note-annotation-contracts";
import type { NoteOverviewTaskV1, NoteOverviewV1 } from "@ailearn/shared/note-overview-contracts";
import type { NoteRecallRecordV1 } from "@ailearn/shared/note-recall-contracts";
import {
  noteExpansionLinkV1Schema,
  type NoteExpansionLinkV1,
} from "@ailearn/shared/note-expansion-contracts";
import {
  noteLearningArtifactV1Schema,
  type NoteLearningArtifactTaskV1,
  type NoteLearningArtifactV1,
} from "@ailearn/shared/note-learning-artifact-contracts";
import { NoteLearningFootprint, type FootprintKind } from "./note-learning-footprint.tsx";

/**
 * Pages 08 / 09: one committed note as a paper notebook.
 *
 * Reading (`note-read`) and writing (`note-edit`) are the same server record in
 * two modes. Every field on this page comes from `room.getProjection` /
 * `note.get` / `source.get` / `capabilities.get`; nothing about the note is
 * written locally before the server confirms it.
 *
 * 正文在编辑器里是**真 Markdown**（Milkdown 所见即所得），在服务端是分类型的块，
 * 两边只经 shared 的 `note-doc-schema.ts` 那一份换算，所以"打开一篇没改过的笔记就显示未提交"
 * 这种漂移不存在。撤销由编辑器自己的 history 承担，这一页不再维护第二套。
 */
/**
 * 来源性质的中文说法（41 §1.5）。
 *
 * 用来源库自己的枚举，不用自己编一套近义词——资料袋说的是「这份材料是什么」，
 * 而来源库里那一份是**全库**通用的说法；两处各说各的，改一处就对不上了。
 */
const SOURCE_KIND_LABELS: Readonly<Record<string, string>> = {
  url: "网页",
  text: "文本文档",
  markdown: "Markdown",
  code: "代码",
};

export type NotebookProjection = {  readonly note: NoteDetailV1;
  readonly source: DesktopSourceDetail | null;
  readonly sourceFailure: string | null;
  readonly objective: LearningObjectiveSurfaceV3 | null;
  /** 最近的目标只用于学习记录页中的单项复习安排，不决定笔记的学习入口。 */
  readonly noteObjective: {
    readonly objectiveId: string;
    readonly publicSummary: string;
    readonly reviewHold: ObjectiveReviewHoldV1 | null;
  } | null;
  /**
   * 这一篇此刻**未完成**的那一轮（39d W4-3 第三刀；表与服务是 W4-5）。
   *
   * 读不到 ⇒ null，那一整块不画——和上面 `noteObjective` 同一纪律：它是一块增补，
   * 不能把笔记本身顶掉。`null` 在这里是真值："这一篇现在没有进行中的一轮"。
   */
  readonly openRound: NoteLearningRoundV1Wire | null;
  /**
   * W7-3 刀六：这一篇的**笔记订阅**（39 §9.1 第一段）。
   *
   * `null` = 这一篇没有订阅过（屏上给"开启"那一档）；有一份就画出那一档，
   * `status` 决定开关在"开"还是"关"。读不到也走 `null`——它和上面那些读一样是
   * **增补**，不能把笔记本身顶掉。
   */
  readonly noteSubscription: NoteReviewSubscriptionV1 | null;
  /** 这一轮冻的正文，与这一篇现在已保存的那一版不是同一版（服务端算的，见 D3 §3 第 2 层）。 */
  readonly openRoundContentMoved: boolean;
  /** 这一轮绑定目标的引用依据变化；与正文版本提示分开显示。 */
  readonly openRoundNoteChangeImpact: ObjectiveNoteChangeImpactV1 | null;
  /**
   * 这一篇的轮次记录（PRD §10.3 读侧第一刀）。**空数组是真值**："这一篇还没有过一轮"，
   * 不是读失败——读失败走 `catch` 那条，同样是空表（这一块的纪律与上面两读一致：
   * 它是增补，不许把笔记本身顶掉）。
   */
  readonly roundHistory: NoteLearningRoundHistoryV1 | null;
  /**
   * 这一篇的**核心路线**（39d W4-5 ③；§4.4）。与 `roundHistory` 分开两格：
   * 那一格是**按轮次**的时间线，这一格是**按核心问题**的跨轮汇总。合成一格
   * 就会出现「记录读到了但路线读失败」被读成「没有路线」。
   *
   * 读失败**不吞**：另给一句真因，因为空册页会被读成"这一篇没有核心问题"（§13.4）。
   */
  readonly routeCoverage: NoteRouteCoverageV1 | null;
  readonly routeCoverageFailure: string | null;
  /**
   * 教学面那一整发（39d W4-6 刀二／刀三）：这一轮当前问题下的解释、这一轮练过哪几道、
   * 以及「练一道」那一发的起点。**收回一份**而不是散成三个字段：它们本来就在同一发
   * 回信里（服务端一次说清"这一轮现在是什么样"），分开存会让三者有时间差。
   * 与上面两读同一条纪律：读不到 ⇒ null 且整块退成"还没讲过"，不把笔记顶掉。
   */
  readonly roundTeachingView: RoundTeachingViewV1 | null;
  /** A failed teaching read must never look like an untouched round. */
  readonly roundTeachingFailure: string | null;
  readonly capabilities: CapabilityProjectionV1;
  /**
   * The workspace's one live Card Generation run (owner only; Member sees an
   * empty section). The note page reads it so "生成学习卡" becomes a status
   * sync instead of a duplicate start.
   */
  readonly activeGeneration: RoomProjectionV1["activeGenerationSummary"];
  /**
   * The note's most recent run, finished or not. A regeneration that answers the
   * last one has to name it, and no other projection says which run that was.
   */
  readonly latestGenerationRun: CardGenerationRunSnapshotV1 | null;
};

const AUTOSAVE_DELAY_MS = 1_200;

/**
 * How many blocks the reading page draws before it asks. The note contract
 * allows 10,000 blocks in one version, and every block is parsed for markdown
 * tables while rendering — a window keeps a long note's first paint bounded
 * without hiding anything: the rest is one click away.
 */
const READING_WINDOW = 200;
const NOTEBOOK_STRUCTURE_PAGE_SIZE_V1 = 12;

/*
 * 轻量定向那张表单的全部字面（39d W4-3 第三刀；PRD §3.3）。一处一份：屏上这句话、
 * 测试里的期望都从这里取。
 *
 * 直接讲解与先试分别走服务端的 explain / preparePractice，屏上不借制卡入口。
 */
export const ROUND_COPY = {
  ask: "你想弄懂的是哪一件事？",
  start: "开始这一轮",
  starting: "正在开始…",
  /** 已经有一轮在进行中时，那颗提交按钮是"改写这一句"，不是"再开一轮"。 */
  save: "保存这个问题",
  revise: "换一个问题",
  saving: "正在改写…",
  end: "先到这里",
  ending: "正在收尾…",
  /**
   * 「接着学下去」（39d W4-5 ④ 的前置）：只有**停住**的那一轮摆这一颗。
   * 恢复不需要「暂停」那颗欠的那道活跃度判据——它是用户明确的动作。
   *
   * 措辞从「继续这一轮」改成这句，是因为这一页上"这一轮"已经是主语（标题牌上写着），
   * 按钮再说一遍就成了系统词；一个动词短语比一个内部名词更像"接着做下去"（39f UI-4）。
   */
  resume: "接着学下去",
  reopenWithCurrent: "按当前内容新开一轮",
  /**
   * 这一轮冻的正文后来又保存过一版。与教学面那句 `teaching.staleVersion`（依据不再在这里定位）
   * 不是一句话，也与笔记页那颗"有内容更新"的徽标不是一句话（D3 §5.1 后果②：徽标说内容，这句说这一轮）。
   */
  contentMoved: "这一轮当时用的正文，这一篇后来又保存过一版。",
  resuming: "正在继续…",
  reopening: "正在另起一轮…",
  /**
   * 迟到的那一句那三格（§16.39）。措辞按伴星那条口径走：说**这一发没进去**这个事实，
   * 不报"服务端版本号"这类她用不上的字，也不把她那句写成"作废"——它只是没交上去。
   */
  lostDraft: (question: string) => `这一句没有交上去，先替你留着：${question}`,
  applyLost: "把这一句改到新版本上",
  dropLost: "不要这一句了",
  fromStructure: "或从这篇的小节里另选一句：",
  /**
   * 那一块的第一句。`hasMore` 会改这句话的**量词**：只回了最近几条时报"开过 N 轮"
   * 就是个假总数（§10.3 要的是完整历史，而这一版没做分页）——所以那种情况下
   * 只说"最近的这几轮"，不替整篇报数。
   */
  historyLead: ROUND_RECORD_COPY_V1.noteLead,
  loadOlder: ROUND_RECORD_COPY_V1.loadOlder,
  loadingOlder: ROUND_RECORD_COPY_V1.loadingOlder,
  /** §10.3 那一格里"完成／部分完成／中断"这三个字由这一处签发；`active` 不在其中。 */
  historyState: ROUND_RECORD_COPY_V1.state,
  /**
   * §10.3 那一行的「实际方式」与「系统不确定项」（W4-8 刀一）。两格的字都**由服务端那两个
   * 事实决定**，界面不重算也不猜：没讲过也没练过时这两格整格不出（不是"这一轮什么都没干"
   * ——那需要另一种判断，而记录只报发生过什么）。
   */
  historyMode: ROUND_RECORD_COPY_V1.mode,
  historyUncertain: ROUND_RECORD_COPY_V1.uncertain,
  followUp: ROUND_RECORD_COPY_V1.followUp,
  historyOutcome: ROUND_RECORD_COPY_V1.outcome,
  /**
   * 教学面（39d W4-6 刀二）。这一轮讲没讲过、按哪一版讲的、依据是哪几段，
   * 这三句话由这一处签发——屏上与剧本读的是同一份（与状态那几档同一条规矩）。
   */
  teaching: {
    start: "先讲讲这一节",
    starting: "正在讲这一节…",
    /**
     * 缺口帮助停止之后摆的那四档（W4-6 刀四；PRD §5.3）。
     *
     * 第一句只说**读数**（帮了几次、还没有看到改善的证据），不许说成"你没弄懂"——
     * 那是对用户下判断，而系统在这一档有的只是"没有证据"。
     */
    stopLead: (count: number) => `帮了 ${count} 次，还没有看到改善的证据——先不自动加题了。你想怎么走？`,
    switchExplanation: "换一种解释",
    backToMaterial: "回材料核对",
    endRound: "先结束这一轮",
    /**
     * 动态产物（W4-6 刀五）。两句都只说这件事本身：动态这一版没起来**不是**
     * 学习失败，文字解释与练习照旧（"动态失败不冒充教学失败"）。
     */
    artifactFailed: "这一版动态讲解没能打开；上面的文字解释照旧，可以继续读、继续练。",
    artifactFallback: "动态这一版先停下了；步骤与解释在上面的文字里。",
    /** 教学面里"练一道"（W4-6 刀三）：只在有 active 目标时出现。 */
    practice: "练一道",
    practicing: "正在开这一道…",
    practicesLead: "这一轮练过：",
    exampleLead: "例子：",
    referencesLead: "依据（点开定位到正文）：",
    /**
     * 快照不是屏幕上这一版时，依据**不定位**：正文后来改过，块序号与屏上那段
     * 已经不是同一份材料，照序号跳过去会把手指点到别处。话要如实说。
     */
    staleVersion: "这一轮是按开始那一版的正文讲的；正文后来改过，依据就不在这里定位了。",
  },
  openLine: (question: string) => `这一轮：${question}`,
  revisedLine: (revision: number) => `这一句话已经改过 ${revision - 1} 次。`,
  hint: "改这句话不用重编笔记；这一轮先只对你自己可见。",
} as const;

/**
 * 那颗提交按钮的字。真窗口跑出来的第一个缺陷就在这里（2026-09-26，§16.16 实机读数）：
 * 旧写法把"在途"与"空闲"两档接反了——已经有一轮在进行中、请求**根本没在跑**的时候
 * 屏上写着「正在改写…」，而改写真的在跑时写的是「正在开始…」。
 * "正在…"只许出现在真有一次请求在途的那一段时间里，这是这一页所有按钮共用的规矩。
 */
/**
 * 一场练习现在到哪一步（W4-6 刀三）：**一处签发**，屏上与剧本读同一份。
 *
 * 结算过 ⇒ 说结论（七档与 run 自己的 `result.outcome` 一一对应，不另造词）；
 * 没结算 ⇒ 按 phase 说"正在进行／停住了／中断了"。`not_assessable` 不是"没弄通"，
 * 它是"这一次判不了"——两者都是要走下去的状态，说法必须分开（§3.2 那条老规矩）。
 */
export const ROUND_PRACTICE_OUTCOME_LABEL_V1: Record<string, string> = {
  demonstrated: "做出来了",
  partial: "做出一部分",
  needs_repair: "还有一处要补",
  not_assessable: "这一次判不了",
  practice_completed: "练完了",
  skipped: "跳过了",
  declared_unable: "说没想起来",
};

export function roundPracticeStateLabelV1(practice: Pick<RoundPracticeV1, "phase" | "outcome">): string {
  if (practice.outcome) {
    return ROUND_PRACTICE_OUTCOME_LABEL_V1[practice.outcome] ?? practice.outcome;
  }
  if (practice.phase === "paused") return "停住了";
  if (["ended", "cancelled", "stale", "completed", "skipped"].includes(practice.phase)) return "中断了";
  return "正在进行";
}

/**
 * 轮次那一块里此刻在途的那一发。`"resume"` 与其余四档共用同一个状态，因为屏上那一整块
 * （那颗提交按钮、教学面那几颗、输入框）的禁用判据是"这一块的某一发在途"——分成两份
 * 状态就会有一处忘了判，症状是"点两下发出两发"。
 */
export type RoundBusyV1 = "start" | "revise" | "end" | "resume" | "reopen" | null;

export function roundSubmitLabelV1(
  busy: RoundBusyV1,
  hasOpenRound: boolean,
): string {
  if (busy === "start") return ROUND_COPY.starting;
  if (busy === "revise") return ROUND_COPY.saving;
  return hasOpenRound ? ROUND_COPY.save : ROUND_COPY.start;
}

/**
 * 起步的三个问法（39f §3「本轮问题」那一格）。
 *
 * 上一版只有一颗「我完全不熟」，它把整篇题名塞进「从头到尾有个站得住的解释」——一篇
 * 长笔记于是被包装成**一个大问题**，用户读完仍然不知道该先弄懂哪一个机制、条件或边界。
 * 真正能收窄方向的是那三类**问法**，不是题名，所以三颗都不带题名。
 *
 * 题名那一路由 `structureQuestionCandidatesV1` 从这篇自己的小节里取（见下）：那才是
 * 唯一有依据的收窄。这三颗只是把"该往哪个方向问"摆出来，让人**挑一个方向**再改。
 */
export const ROUND_PRESETS_V1: ReadonlyArray<{
  readonly key: "condition" | "why" | "boundary";
  readonly label: string;
  readonly starter: string;
}> = [
  { key: "condition", label: "先弄懂那个条件", starter: "这篇里有一句话，它要成立需要什么条件？" },
  // 「为什么非做不可，不做会错在哪」这一版**撤掉了**（2026-09-28 真窗口实测）：
  // 它是一个**反事实**问法，而多数笔记（尤其是产品发布、技术介绍这类）根本不写"不做会
  // 怎样"。于是讲解模型照着问法编——"不做就会导致语音错误（'東京'读成 dōng jīng）"、
  // "无法支撑视频配音"——独立核查逐条指出材料没有这句话，**整份讲解被拒**。真窗口实测
  // 连撞两次：换一篇短笔记、换一篇 70 段的富笔记，都是同一条 422。
  //
  // 判据不是"提问不好听"，是**这道题能不能被材料回答**：问法必须落在笔记真的说过的
  // 那句话上。核查者那一档是明确允许"材料不足"如实说的（`hasMeasurementClaimV1` 旁边
  // 的免责处理就是为它准备的），所以"材料没说"本身不该让整轮失败。
  { key: "why", label: "先弄懂为什么", starter: "这一步为什么这么做？这篇给了什么理由？" },
  { key: "boundary", label: "先弄懂边界", starter: "这个做法在什么情况下就不管用了？材料说过它的限制吗？" },
];

/**
 * 「从这篇的结构里另选一句」（§16.16 的第二半：用户否定推荐问题之后要有路可走）。
 *
 * 刻意**不调模型**：能出题的依据是这篇笔记里已经存在的小节标题，那是真实数据；
 * 一次模型调用只是把同一件事变贵且不可复现。三件判据：
 *  - 只认 `heading` 那一档——段落第一句当标题是**猜测**，这一页已经有过一次
 *    "把排版猜测当依据"的返工（见 `conceptMark` 头上那段）；
 *  - 字要取自**屏上显示的那一份**（`noteInlineDisplayText`），markdown 原文里的
 *    `**`、`[]()` 会跟着进问题；
 *  - 一节标题**复述整篇题名**（同名，或以题名开头再加一句限定）⇒ 不出：它没有把方向
 *    收窄，选了它等于没选；
 *  - 一颗上写的字要能放下，所以**标签**截断；但放进输入框的那句问话用**完整的小节名**
 *    ——真窗口实测：把带省略号的小节名塞进「」里，出来的是一句读不通的话
 *    （「学习科学术语定义集（用于验证定义类知识能否产出选…」）。
 * 一篇没有小节的笔记就**一颗都不出**：没有结构就不发明结构。
 */
export const STRUCTURE_QUESTION_LIMIT_V1 = 3;

/** 标签那一颗的宽度上限；超了就带省略号，只影响"看得见的字"，不影响放进问话的那一份。 */
export const STRUCTURE_QUESTION_LABEL_MAX_V1 = 24;

export type StructureQuestionCandidateV1 = {
  readonly ordinal: number;
  readonly label: string;
  readonly question: string;
};

export function structureQuestionCandidatesV1(
  blocks: readonly NoteBlockProjectionV1[],
  noteTitle: string,
): readonly StructureQuestionCandidateV1[] {
  const title = noteTitle.trim();
  const seen = new Set<string>();
  const candidates: StructureQuestionCandidateV1[] = [];
  for (const block of blocks) {
    if (block.type !== "heading") continue;
    const heading = headingDisplayTextV1(block);
    if (heading.length === 0 || seen.has(heading)) continue;
    // `startsWith` 已经含住"完全同名"那一档（变异验过：再写一条 `=== title` 是多余的，
    // 摘掉它任何用例都不会红）。`title.length > 0` 那道挡不能省：空题名时
    // `startsWith("")` 对每节都成立，会把一整组候选静默清空。
    if (title.length > 0 && heading.startsWith(title)) continue;
    seen.add(heading);
    candidates.push({
      ordinal: block.ordinal,
      label: heading.length > STRUCTURE_QUESTION_LABEL_MAX_V1
        ? `${heading.slice(0, STRUCTURE_QUESTION_LABEL_MAX_V1)}…`
        : heading,
      question: `先弄懂「${heading}」这一节在讲什么，以及它和整篇的关系`,
    });
    if (candidates.length >= STRUCTURE_QUESTION_LIMIT_V1) break;
  }
  return candidates;
}

/**
 * 那三个来源档不是三种表情，是"这句话是谁定的"这一件事实（§3.3）：
 * 没点预设、整句自己写的 ⇒ authored；点了预设原样用 ⇒ suggested；点了又改 ⇒ rewritten。
 */
/**
 * 记录里那一格"这一轮到哪一步了"的**唯一**签发处（§10.3 的"完成／部分完成／中断"）。
 * 终态才看 outcome；`active`/`paused` 没有 outcome（0282 的双向 CHECK 保证），
 * 所以那种行只说状态、不猜原因。
 */
/** 搬去 `round-record-copy.ts` 了（两个级别共用）；这一行留着是让既有 import 路径不变。 */
export { roundHistoryStateLabelV1 };

export function roundQuestionSourceV1(
  draft: string,
  starterApplied: string | null,
): "suggested" | "user_rewritten" | "user_authored" {
  if (starterApplied === null) return "user_authored";
  return draft.trim() === starterApplied.trim() ? "suggested" : "user_rewritten";
}

function desktopApi() {
  return typeof window === "undefined" ? undefined : window.ailearn;
}

function formatClock(value: string | null | undefined): string {
  if (!value) return "时间未提供";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf())) return "时间未提供";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(parsed);
}

/**
 * 依据那一颗的字（39d W4-6 刀二）：**从材料里取**——小节取标题，其余取正文开头。
 * 拼不出字（空块）时退成"第 N 段"：序号是屏幕上**真有的**东西，不是编的说法。
 * 窗口按显示出来的字截（markdown 标记不占格子，同 `conceptMark` 那条规矩）。
 */
/**
 * 一块小节标题在屏上该显示成什么。**真库里两种形状都有**（实测 dev 库 6 条小节里
 * 3 条带 `# `）：有的存 `间隔重复`，有的存 `## 间隔重复`。剥标记这件事只写在这里，
 * 教学面的依据标签与"从结构另选"的问话共用同一份——两处各写一遍，迟早一处漏。
 */
export function headingDisplayTextV1(block: NoteBlockProjectionV1): string {
  return noteInlineDisplayText(block.content)
    .replace(/^\s{0,3}#{1,6}\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export type NotebookReadingSectionV1 = {
  readonly startOrdinal: number;
  readonly title: string;
  /** Non-empty blocks after the heading; this is content presence, not learning progress. */
  readonly bodyBlockCount: number;
};

/**
 * A verifiable outline for long notes (W4-4). It follows headings already present in the
 * current block list and counts non-empty body blocks under each one. It never invents a
 * heading or interprets content presence as teaching readiness or user mastery.
 */
export function notebookReadingSectionsV1(
  blocks: readonly NoteBlockProjectionV1[],
): readonly NotebookReadingSectionV1[] {
  const hasHeadings = blocks.some((block) => block.type === "heading");
  const sections: NotebookReadingSectionV1[] = [];
  let current: { startOrdinal: number; title: string; bodyBlockCount: number } | null = null;
  const flush = () => {
    if (current) sections.push(current);
    current = null;
  };

  for (const block of blocks) {
    if (block.type === "heading") {
      flush();
      current = {
        startOrdinal: block.ordinal,
        title: headingDisplayTextV1(block) || "未命名小节",
        bodyBlockCount: 0,
      };
      continue;
    }

    if (!current && block.content.trim().length > 0) {
      current = {
        startOrdinal: block.ordinal,
        title: hasHeadings ? "开篇" : "未分节正文",
        bodyBlockCount: 0,
      };
    }
    if (current && block.content.trim().length > 0) current.bodyBlockCount += 1;
  }

  flush();
  return sections;
}

export function teachingReferenceLabelV1(block: NoteBlockProjectionV1, max = 16): string {
  const text = block.type === "heading"
    ? headingDisplayTextV1(block)
    : noteInlineDisplayText(block.content).replace(/\s+/g, " ").trim();
  if (text.length === 0) return `第 ${block.ordinal} 段`;
  if (block.type === "heading") return `小节「${excerpt(text, max)}」`;
  return excerpt(text, max);
}

function excerpt(value: string, max = 96): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

/**
 * The sentence the reading page marks: the one that names the concept this note
 * is bound to. The mockup marked the opening clause of the first paragraph, but
 * nothing in the note record says the first paragraph is the claim — that was a
 * typographic guess presented as emphasis. The linked objective's concept label
 * is real data, so the mark follows it and disappears when there is nothing to
 * follow.
 */
function conceptMark(
  blocks: readonly NoteBlockProjectionV1[],
  conceptLabel: string | null | undefined,
): { readonly ordinal: number; readonly range: readonly [number, number] } | null {
  const label = conceptLabel?.trim();
  if (!label) return null;
  for (const block of blocks) {
    if (block.type !== "paragraph") continue;
    // 区间要落在**显示出来的字**上：`content` 里还有 `**`、`![]()` 这些不占格子的标记，
    // 与批注一样按实际文本节点计算；换行分隔符与图片不占字符。
    const text = noteBlockRenderedTextV1(block.type, block.content);
    const at = text.indexOf(label);
    if (at < 0) continue;
    return { ordinal: block.ordinal, range: sentenceRange(text, at, label.length) };
  }
  return null;
}

/** The sentence around `[at, at + length)`, punctuation included. */
function sentenceRange(text: string, at: number, length: number): readonly [number, number] {
  const stops = /[。！？!?\n]/;
  let start = 0;
  for (let index = at - 1; index >= 0; index -= 1) {
    if (stops.test(text[index] ?? "")) {
      start = index + 1;
      break;
    }
  }
  let end = text.length;
  for (let index = at + length; index < text.length; index += 1) {
    if (stops.test(text[index] ?? "")) {
      end = index + 1;
      break;
    }
  }
  return [start, end];
}

/** Shared HUD notice for a note objective or its active learning round. */
function NoteChangeImpactNotice({
  impact,
  context,
}: {
  impact: ObjectiveNoteChangeImpactV1 | null;
  context?: "objective" | "round";
}) {
  const copy = objectiveNoteChangeImpactCopy(impact);
  if (!copy || !impact) return null;
  const notice = (
    <>
      <p className="small notebook-note" data-note-change-impact="true">{copy}</p>
      {impact.status !== "unaffected" ? (
        <details
          className="notebook-objective__impact-evidence"
          data-note-change-evidence="true"
          {...(context === "round" ? { "data-round-note-change-evidence": "true" } : {})}
        >
          <summary>展开核对当时与现在的依据</summary>
          {impact.evidenceDetails.map((detail) => (
            <div className="notebook-objective__impact-excerpt" key={detail.evidenceIndex}>
              <p className="small notebook-note">
                <strong>依据 {detail.evidenceIndex} · 当时 · {detail.previousOrdinal ? `第 ${detail.previousOrdinal} 段` : "原文位置不明"}</strong>
                <br />
                {detail.previousQuote === null
                  ? "当时的引用原文没有可核对的副本。"
                  : `${detail.previousQuote}${detail.previousQuoteTruncated ? "…（节录）" : ""}`}
              </p>
              <p className="small notebook-note">
                <strong>当前 · 同段同位置</strong>
                <br />
                {detail.currentQuote === null
                  ? "当前版本没有可定位的对应段落。"
                  : `${detail.currentQuote}${detail.currentQuoteTruncated ? "…（节录）" : ""}`}
              </p>
            </div>
          ))}
          {impact.evidenceDetails.length === 0 ? (
            <p className="small notebook-note">这条目标还没有可展示的历史引用；请回笔记正文核对。</p>
          ) : null}
          {impact.evidenceDetailsOmittedCount > 0 ? (
            <p className="small notebook-note">另有 {impact.evidenceDetailsOmittedCount} 条依据未展开。</p>
          ) : null}
        </details>
      ) : null}
    </>
  );
  return context === "round"
    ? <div data-round-note-change-impact="true">{notice}</div>
    : notice;
}

/** Page 08 / 09 / 22 — the note as one paper, read, written or discussed. */
export function NotebookSurface() {
  const invoke = useRoomStore((state) => state.invoke);
  const setSettingsAttention = useRoomStore((state) => state.setSettingsAttention);
  const setSettingsSection = useRoomStore((state) => state.setSettingsSection);
  const setActiveCardGenerationRunId = useRoomStore((state) => state.setActiveCardGenerationRunId);
  const setActiveObjectiveId = useRoomStore((state) => state.setActiveObjectiveId);
  const setActiveRunId = useRoomStore((state) => state.setActiveRunId);
  // 就地作答要靠它判断"这一轮正在答的那一次"是不是眼下这一次（见 `inlineRoundRunId`）。
  const activeRunId = useRoomStore((state) => state.activeRunId);
  const activeNoteRef = useRoomStore((state) => state.activeNoteRef);
  const setActiveNoteRef = useRoomStore((state) => state.setActiveNoteRef);
  // 协同流只在协作空间里存在（personal 按门控不建长连接），所以订阅与否看它。
  const spaceIdentity = useRoomStore((state) => state.spaceIdentity);
  // 我在这一篇里是谁，要广播给同处这篇的人。显示名缺省时落回邮箱 @ 前那一段：
  // 实窗量过一次，演示账号没有显示名，结果别人那一排看到的全是「?」印章——一排问号
  // 说不出任何事，等于没做这个功能。不广播完整邮箱：成员列表本来看不到别人的邮箱，
  // 协同状态不该另开一条路把它散出去。
  const presenceName = useRoomStore((state) => {
    const account = state.accountIdentity;
    if (!account) return null;
    return account.displayName?.trim() || account.email.split("@")[0]?.trim() || null;
  });
  const setReturnTarget = useRoomStore((state) => state.setReturnTarget);
  const [reflectionRoundId, setReflectionRoundId] = useState<string | undefined>(undefined);
  const [historyInspectRevision, setHistoryInspectRevision] = useState(0);
  const [legacyHistoryOpen, setLegacyHistoryOpen] = useState(false);
  const legacyRouteCoverageRequestedForNoteRef = useRef<string | null>(null);
  const historyDetailRef = useRef<HTMLElement>(null);
  const appendedReflections = useRef(new Map<string, string>());
  const reflectionShelfRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<NoteMarkdownEditorHandle | null>(null);
  const editorPaneRef = useRef<HTMLDivElement>(null);
  const epochRef = useRef<number | undefined>(undefined);

  const syncedNoteRef = useRef<string | null>(null);
  const saveRef = useRef<() => void>(() => {});

  const [leaf, setLeaf] = useState<"reading" | "learning" | "history" | "expansion">("reading");
  const [reviewingTeaching, setReviewingTeaching] = useState(false);
  /** 就地作答的工位停在哪一屏：`assessment` 作答／`result` 那一次的结算。 */
  const [inlineRunPage, setInlineRunPage] = useState<"assessment" | "result">("assessment");
  const handledRoundReturnRef = useRef<string | null>(null);
  const [showAllBlocks, setShowAllBlocks] = useState(false);

  const [focusedBlockOrdinal, setFocusedBlockOrdinal] = useState<number | null>(null);
  const annotationTaskRequestRef = useRef(0);
  const focusedAnnotationTaskRef = useRef<string | null>(null);
  const requestedAnnotationTaskRef = useRef<string | null>(null);
  const overviewRequestRef = useRef(0);

  const recallPaperRef = useRef<HTMLElement | null>(null);
  const learningArtifactPaperRef = useRef<HTMLElement | null>(null);
  const [activeLearningArtifactId, setActiveLearningArtifactId] = useState<string | null>(null);
  const learningArtifactRequestRef = useRef(0);
  const learningArtifactTaskRequestRef = useRef(0);
  const learningArtifactStartingRef = useRef(false);
  const learningArtifactScopeRef = useRef("");
  const artifactRegenerationSource = useRef<{ sourceKind: "overview" | "annotation"; anchor?: NoteAnnotationAnchorV1 } | null>(null);


  const expansionRequestRef = useRef(0);
  const annotationOrigin = useRef<"body" | "history">("body");
  const annotationRequestRef = useRef(0);

  const leafScrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    setLeaf(activeNoteRef?.learningRoundId ? "learning" : "reading");
    setOverviewOpen(false);
    setReviewingTeaching(false);
    setShowAllBlocks(false);

    setFocusedBlockOrdinal(null);
    setReflectionRoundId(activeNoteRef?.learningRoundId);
    appendedReflections.current.clear();
  }, [activeNoteRef?.noteId, activeNoteRef?.learningRoundId]);
  /**
   * `title` 是**本机改过、还没写进文档**的那一份，`null` = 这一屏没改过标题，
   * 于是标题框画文档 `meta` 里的那一份（别人改名会跟着动）。正文不在这里存副本，
   * 只有编辑器 `onChange` 交出来的那一份（图片上传回填要用）。
   */
  const [draft, setDraft] = useState<{ title: string | null; content: string }>({ title: null, content: "" });
  const [saving, setSaving] = useState(false);
  const [receipt, setReceipt] = useState<{
    savedAt: string;
    isAutosave: boolean;
    /**
     * 这一次走的是长连接还是 HTTP。它不是装饰：流式那条只说明"本机已并进文档"，
     * 服务端落盘还要等 Hocuspocus 的 debounce，保存行不能说成"已保存"。
     */
    via: "stream" | "uploaded" | "unchanged" | "queued";
  } | null>(null);
  const [sharing, setSharing] = useState(false);
  const [startingGeneration, setStartingGeneration] = useState(false);
  const [generationFailure, setGenerationFailure] = useState<string | null>(null);
  /**
   * W7-3 刀三：目标级「暂不安排」／「恢复并开启」那两条命令的状态。
   *
   * **notice 与 error 分开两个 state**（不是同一个字符串）：回执是成功的话也要念出来
   * ——「顺手撤下了 N 条」是这一发**唯一**告诉用户"它有后果"的地方（§9.1 要求
   * "操作时说明"），把它塞进 error 那条通道就等于成功时什么都不说。
   */
  /** W7-3 刀六：订阅那一发在进行中（"开"与"停"共用一颗闸，同一篇不该并发两发）。 */
  // 39d W4-3 第三刀：那张表单自己的三份状态。`roundStarter` 记住"这句是哪一颗预设放的"，
  // 来源那一档（suggested / rewritten / authored）就靠它判，不靠猜用户改没改。
  /**
   * 翻出来的那几页（第一页由投影自己读，往后每页累加在这里）。存着 `noteId` 并按它过滤，
   * 而不是"切篇时记得清空"——后者靠一次副作用，漏一次就把上一篇的记录接在这一篇下面。
   */
  // 用合同那一份类型，不再手抄四格：上一刀加 `totalCount` 时，抄出来的那份形状
  // 会静默少一格（`historyTotal` 读不到它，总数就退回 0），而 typecheck 只会红在
  // 读它的那一行上，不会告诉你"这里本来该跟着长"。
  /**
   * 迟到的那一句（§16.39 的"另一份草稿明确保留为冲突"，39d W4-5 第四刀）。
   *
   * 被服务端判成 conflict 的那一发要做两件事，缺一不可：那一行换回**现在那一版**
   * （真窗口实测过不换的害处：她对着作废的那句继续），同时她交出去的那一句
   * **不许消失**——顶掉与拼进新版本是同一处缺陷的两种画法，PRD 两个都不要。
   * 所以这里存的是「句子＋当时用的那句引子」这一对：`roundQuestionSourceV1` 按
   * 引子判 source，只留句子会把她原本算 `suggested` 的那一发改记成 `user_authored`。
   */
  /** 教学面（W4-6 刀二）：生成那一发在途、以及它自己的失败那一句。 */
  /** 「练一道」（W4-6 刀三）：开那场 run 的在途与它自己的失败那一句。 */
  /**
   * 动态产物落盘那一发（W4-6 刀五）：`idle` 还没试 / `ready` 已在盘上可以挂宿主 /
   * `failed` 如实说明。**只有这三档**：失败不是"落盘失败"，它连带把宿主也关掉——
   * 让宿主去读一个不存在的文件，画出来的是浏览器自己的错误页，那不是我们的界面。
   */
  const [artifactState, setArtifactState] = useState<"idle" | "ready" | "failed">("idle");
  const motionMode = useRoomStore((state) => state.motionMode);
  /**
   * 依据里点开的那一段。它只是**屏幕上的注意力**（滚动 + 短暂高亮），不进任何写：
   * 值一过期就撤掉，不留"上次点到哪"这种会跟人走的读数。
   */
  const generationTriggerRef = useRef<HTMLButtonElement>(null);
  const closeGenerationSetup = () => {
    generationTriggerRef.current?.focus();
    setOptionsOpen(false);
  };
  /** 本机光标此刻在第几块。冲突提示读的就是这一格，所以它必须与报给对端的那一份同源。 */
  const [caretBlock, setCaretBlock] = useState<number | null>(null);
  /**
   * 与 `draft` 同一份内容的 ref：图片上传回填要在渲染之外读到当前正文，
   * 卸载时那一次保存也要闭包到最新一份，而不能在渲染阶段读 ref。
   */
  const draftRef = useRef<{ title: string | null; content: string }>({ title: null, content: "" });

  /** The one way the draft changes, so state and ref cannot drift apart. */
  const applyDraft = useCallback((next: { title: string | null; content: string }) => {
    draftRef.current = next;
    setDraft(next);
  }, []);

  /** 正文变了而标题没变时只替换正文那一半：编辑器输入与上传回填都走这里。 */
  const applyContent = useCallback((content: string) => {
    applyDraft({ ...draftRef.current, content });
  }, [applyDraft]);

  const { data, loading, failure, reload } = useSurfaceProjection(async ({ workspaceEpoch }) => {
    const api = desktopApi();
    if (!api) throw new Error("桌面端 API 不可用，无法读取真实笔记。");
    const projectionResponse = await api.room.getProjection({ meta: createRequestMeta(workspaceEpoch) });
    if (projectionResponse.workspaceEpoch) epochRef.current = projectionResponse.workspaceEpoch;
    const projection = unwrapGatewayResult(projectionResponse);
    const focus = projection.primaryFocus.state === "data" ? projection.primaryFocus.data : null;
    const primaryNote = focus?.objective.sources.primaryNote ?? null;
    const noteId = activeNoteRef?.noteId ?? primaryNote?.noteId;
    if (!noteId) {
      throw new Error("这一篇笔记还没定下来是哪一篇，不能编辑，也不能生成学习卡。");
    }
    const noteResponse = await api.note.get({ meta: createRequestMeta(epochRef.current), noteId });
    if (noteResponse.workspaceEpoch) epochRef.current = noteResponse.workspaceEpoch;
    const note = unwrapGatewayResult(noteResponse);

    const capabilityResponse = await api.capabilities.get({ meta: createRequestMeta(epochRef.current) });
    if (capabilityResponse.workspaceEpoch) epochRef.current = capabilityResponse.workspaceEpoch;

    let source: DesktopSourceDetail | null = null;
    let sourceFailure: string | null = null;
    if (note.sourceId) {
      try {
        const sourceResponse = await api.source.get({
          meta: createRequestMeta(epochRef.current),
          sourceId: note.sourceId,
        });
        if (sourceResponse.workspaceEpoch) epochRef.current = sourceResponse.workspaceEpoch;
        source = unwrapGatewayResult(sourceResponse);
      } catch (error) {
        sourceFailure = gatewayErrorMessage(error);
      }
    }

    // A note that has never been generated answers 404, which is an ordinary
    // state: the page then simply has no previous run to respond to.
    let latestGenerationRun: CardGenerationRunSnapshotV1 | null = null;
    if ((api.contract.enabledRoutes ?? []).includes("note.cardGeneration")) {
      try {
        latestGenerationRun = unwrapGatewayResult(await api.note.cardGeneration.latestRun({
          meta: createRequestMeta(epochRef.current),
          noteId: note.noteId,
        }));
      } catch {
        latestGenerationRun = null;
      }
    }

    // 目标只供记录页的单项安排使用。笔记学习始终由 noteLearningRound.open 决定。
    let noteObjective: NotebookProjection["noteObjective"] = null;
    try {
      const objectiveResponse = await api.objective.list({
        meta: createRequestMeta(epochRef.current),
        limit: 1,
        lifecycle: "active",
        noteId: note.noteId,
      });
      if (objectiveResponse.workspaceEpoch) epochRef.current = objectiveResponse.workspaceEpoch;
      const item = unwrapGatewayResult(objectiveResponse).items[0] ?? null;
      if (item) {
        noteObjective = {
          objectiveId: item.objectiveId,
          publicSummary: item.publicSummary,
          reviewHold: item.reviewHold ?? null,
        };
      }
    } catch {
      noteObjective = null;
    }

    // W7-3 刀六：这一篇的笔记订阅。**读不到也是 null**（老网关没这条路由 / 没订阅过 /
    // 读取失败三件事在屏上是同一句话：这里没有那颗开关），和上面那些读同一纪律。
    let noteSubscription: NotebookProjection["noteSubscription"] = null;
    try {
      const subResponse = await api.review.listNoteSubscriptions({ meta: createRequestMeta(epochRef.current) });
      if (subResponse.workspaceEpoch) epochRef.current = subResponse.workspaceEpoch;
      const found = unwrapGatewayResult(subResponse).items
        .find((item) => item.subjectType === "note" && item.subjectId === note.noteId);
      noteSubscription = found
        ? { source: found.source, subjectType: found.subjectType, subjectId: found.subjectId, status: found.status, scopeNote: found.scopeNote, createdAt: found.createdAt, pausedAt: found.pausedAt }
        : null;
    } catch {
      noteSubscription = null;
    }

    // 39d W4-3 第三刀：这一篇有没有未完成的那一轮。和上面那两读一样自己吞异常——
    // 老网关没有这条路由时不能让笔记页变成错误页。
    let openRound: NotebookProjection["openRound"] = null;
    let openRoundContentMoved = false;
    let openRoundNoteChangeImpact: ObjectiveNoteChangeImpactV1 | null = null;
    try {
      const roundResponse = await api.noteLearningRound.open({
        meta: createRequestMeta(epochRef.current),
        noteId: note.noteId,
      });
      if (roundResponse.workspaceEpoch) epochRef.current = roundResponse.workspaceEpoch;
      // 回的是那一层信封：`contentMoved` 是读侧现算的派生格，渲染层不许自己比版本号。
      const view = unwrapGatewayResult(roundResponse);
      openRound = view?.round ?? null;
      openRoundContentMoved = view?.contentMoved ?? false;
      openRoundNoteChangeImpact = view?.noteChangeImpact ?? null;
    } catch {
      openRound = null;
      openRoundContentMoved = false;
      openRoundNoteChangeImpact = null;
    }

    // 教学产物那一读（W4-6 刀二）：只有真有一轮在进行中才有得读——没轮次就没有
    // "这一轮讲了什么"。同样自己吞异常：读失败退成"还没讲过"，不是错误页。
    let roundTeachingView: NotebookProjection["roundTeachingView"] = null;
    let roundTeachingFailure: string | null = null;
    if (openRound) {
      try {
        const teachingResponse = await api.noteLearningRound.teaching({
          meta: createRequestMeta(epochRef.current),
          roundId: openRound.roundId,
        });
        if (teachingResponse.workspaceEpoch) epochRef.current = teachingResponse.workspaceEpoch;
        roundTeachingView = unwrapGatewayResult(teachingResponse);
      } catch (error) {
        roundTeachingView = null;
        roundTeachingFailure = gatewayErrorMessage(error);
      }
    }

    // 记录那一发与上面两读同一纪律：自己吞异常。它读的是历史，
    // 读失败最多是这一块不出现，不许把整篇笔记换成错误页。
    let roundHistory: NotebookProjection["roundHistory"] = null;
    try {
      const historyResponse = await api.noteLearningRound.history({
        meta: createRequestMeta(epochRef.current),
        noteId: note.noteId,
      });
      if (historyResponse.workspaceEpoch) epochRef.current = historyResponse.workspaceEpoch;
      roundHistory = unwrapGatewayResult(historyResponse);
    } catch {
      roundHistory = null;
    }

    // 核心路线是旧学习记录的附加页，只在用户打开旧记录，或从旧轮次明确返回时读取。
    // 新笔记首屏不需要为已经折叠的旧册页再多发一个请求。
    let routeCoverage: NotebookProjection["routeCoverage"] = null;
    let routeCoverageFailure: NotebookProjection["routeCoverageFailure"] = null;
    const shouldReadLegacyRouteCoverage = Boolean(activeNoteRef?.learningRoundId)
      || legacyRouteCoverageRequestedForNoteRef.current === note.noteId;
    if (shouldReadLegacyRouteCoverage) {
      try {
        const routeResponse = await api.noteLearningRound.route({
          meta: createRequestMeta(epochRef.current),
          noteId: note.noteId,
        });
        if (routeResponse.workspaceEpoch) epochRef.current = routeResponse.workspaceEpoch;
        routeCoverage = unwrapGatewayResult(routeResponse);
      } catch (error) {
        routeCoverageFailure = gatewayErrorMessage(error);
      }
    }

    return {
      note,
      source,
      sourceFailure,
      openRound,
      openRoundContentMoved,
      openRoundNoteChangeImpact,
      roundHistory,
      routeCoverage,
      routeCoverageFailure,
      roundTeachingView,
      roundTeachingFailure,
      objective: focus && focus.objective.sources.primaryNote?.noteId === note.noteId
        ? focus.objective
        : null,
      noteObjective,
    noteSubscription,
      capabilities: unwrapGatewayResult(capabilityResponse),
      activeGeneration: projection.activeGenerationSummary,
      latestGenerationRun,
    } satisfies NotebookProjection;
  }, [activeNoteRef?.noteId, activeNoteRef?.learningRoundId]);

  // The pill returns to whatever opened this note: the library, the
  // card-generation workbench the reader stepped out of, or the star map a
  // star was clicked on. It never skips a level up to the study room.
  useEffect(() => {
    // An explicit caller (such as the learning journal) owns its return path.
    if (useRoomStore.getState().returnTarget) return;
    const returnTo = useRoomStore.getState().noteReturnTo;
    const target = returnTo === "generation"
      ? { label: "返回生成任务", run: () => invoke("open-card-generation") }
      : returnTo === "graph"
        ? { label: "返回星图", run: () => invoke("graph") }
        : returnTo === "search"
          ? { label: "返回搜索", run: () => invoke("search") }
        : { label: "返回笔记库", run: () => invoke("open-notes") };
    setReturnTarget(target);
    // Navigation may already have installed the next page's return path.
    return () => { if (useRoomStore.getState().returnTarget === target) setReturnTarget(null); };
  }, [invoke, setReturnTarget]);

  const note = data?.note ?? null;
  learningArtifactScopeRef.current = `${note?.noteId ?? ""}:${note?.currentVersionId ?? ""}`;
  const { historyOpen, setHistoryOpen, sourceBagOpen, setSourceBagOpen,
    openAnnotationId, setOpenAnnotationId, annotationTaskOpen, setAnnotationTaskOpen, annotationDraftOpen, setAnnotationDraftOpen,
    companionExplanationId, setCompanionExplanationId, closeSidePage } = useNotebookSidePage(note?.noteId ?? null);
  const companionExplanations = useNoteCompanionExplanations(state => state.items);
  const requestedCompanionExplanationId = useNoteCompanionExplanations(state => state.requestedOpenId);
  const noteCompanionExplanations = companionExplanations.filter(item => item.target.noteId === note?.noteId);
  const openCompanionExplanation = noteCompanionExplanations.find(item => item.id === companionExplanationId);
  useEffect(() => {
    const item = companionExplanations.find(item => item.id === requestedCompanionExplanationId && item.target.noteId === note?.noteId);
    if (!item) return;
    setLeaf("reading"); setLearningView("body"); setCompanionExplanationId(item.id);
    if (item.target.anchor.noteVersionId === note?.currentVersionId) setFocusedBlockOrdinal(item.target.anchor.startBlockOrdinal);
    useNoteCompanionExplanations.setState({ requestedOpenId: null });
  }, [requestedCompanionExplanationId, companionExplanations, note?.noteId, note?.currentVersionId, setCompanionExplanationId]);
  const annotationDraft = useNotebookAnnotationDraft({ noteId: note?.noteId ?? null, epochRef, onSaved: annotation => {
    setAnnotationRows(current => ({ noteId: annotation.noteId, items: [annotation, ...(current?.noteId === annotation.noteId ? current.items : [])], nextCursor: current?.noteId === annotation.noteId ? current.nextCursor : null }));
    setOpenAnnotationId(annotation.annotationId);
  } });
const noteDocLive = useNoteDocLiveView(
    note?.noteId ?? null,
    spaceIdentity !== null && !spaceIdentity.isPersonal,
    () => {
      void reload({ silent: true });
    },
    presenceName,
    epochRef,
    note?.currentVersionId ?? null,
  );
  const editable = Boolean(note?.permissions.canEdit) && noteDocLive.authorizedScope !== "readonly";
  const linkEditor = useNotebookLinkEditor(editorRef, activeNoteRef?.noteId ?? null, editable);
  const canSave = Boolean(note?.permissions.canSave) && noteDocLive.authorizedScope !== "readonly";
  const { mode, changeMode, pendingMode } = useNotebookBodyMode({
    noteId: note?.noteId ?? null,
    initialMode: activeNoteRef?.mode,
    canEdit: editable,
    editorRef,
    scrollRef: leafScrollRef,
    onChange: (next) => {
      const store = useRoomStore.getState();
      if (note && store.activeNoteRef?.noteId === note.noteId) store.setActiveNoteRef({ ...store.activeNoteRef, mode: next });
    },
  });

  /** 「批注」那一簇的 8 个 state 已于 2026-09-29 收进 `use-notebook-annotation-state.ts`；
      五个 handler 留在页面。「verification 要记版本」「shelfOpen 是旧版搁架」两条在那个文件里。 */
  const {
    annotationRows, setAnnotationRows,
    annotationTask, setAnnotationTask,
    annotationTaskStarting, setAnnotationTaskStarting,
    annotationTaskError, setAnnotationTaskError,
    annotationShelfOpen, setAnnotationShelfOpen,
    annotationVerification, setAnnotationVerification,
    annotationLoading, setAnnotationLoading,
    annotationError, setAnnotationError,
  } = useNotebookAnnotationState();

  /** 「互动演示」那一簇的 8 个 state 已于 2026-09-29 收进
      `use-notebook-learning-artifact-state.ts`；三个 handler 留在页面。
      「ensureRevision 是计数器」「storedId 记的是已收好的那一份」两条写在那个文件里。 */
  const {
    learningArtifactRows, setLearningArtifactRows,
    learningArtifactLoading, setLearningArtifactLoading,
    learningArtifactStoredId, setLearningArtifactStoredId,
    learningArtifactError, setLearningArtifactError,
    learningArtifactEnsureRevision, setLearningArtifactEnsureRevision,
    learningArtifactTasks, setLearningArtifactTasks,
    learningArtifactTaskError, setLearningArtifactTaskError,
    learningArtifactTaskStarting, setLearningArtifactTaskStarting,
  } = useNotebookLearningArtifactState();

  /** 关联笔记列表与未确认草稿分别管理，列表回读不覆盖草稿。 */
  const {
    expansionRows, setExpansionRows,
    expansionLoading, setExpansionLoading,
    expansionError, setExpansionError,
  } = useNotebookExpansionState();

  /** 「这一轮」那一簇的 6 个 state 已于 2026-09-29 收进 `use-notebook-round-state.ts`；
      四个 handler 留在页面。两条不许动（`roundStarter` 记来源、`roundLostDraft` 是独立草稿）
      写在那个文件里。 */
  const {
    roundDraft, setRoundDraft,
    roundStarter, setRoundStarter,
    roundEditing, setRoundEditing,
    roundBusy, setRoundBusy,
    roundFailure, setRoundFailure,
    roundLostDraft, setRoundLostDraft,
  } = useNotebookRoundState();

  /** 「回想」那一簇的 5 个 state 已于 2026-09-29 收进 `use-notebook-recall-state.ts`；
      四个 handler 留在页面（它们要读 note / activeNoteRef / epochRef / reload / setLeaf）。
      「四档动作共用一颗闸」这条在那个文件里。 */
  const {
    rows: recallRows, records: noteRecallRecords, active: activeRecall,
    visit: recallVisit, presentation: recallPresentation,
    busy: recallBusy, loading: recallLoading, error: recallError,
    reflection: recallReflection, setReflection: setRecallReflection,
    load: loadNoteRecallRecords, start: startNoteRecall, act: actOnActiveRecall,
    open: openRecall, close: closeRecall,
  } = useNotebookRecallState({ note, epochRef });

  /** 「练一道」那一发的在途与失败收进 hook；两个 handler 留在页面（它们要读
      `openRound` / `roundPracticeStart` / `startObjectiveJourney` 这些页面级东西）。
      `busy` 只有一格是**故意的**——见那个文件里第 3 条。 */
  const {
    busy: practiceBusy,
    failure: practiceFailure,
    begin: beginPractice,
    end: endPractice,
    setFailure: setPracticeFailure,
  } = useNotebookPractice();

  /** 「速看」整簇（7 个 state + 读 + 发起 + 三个派生）已于 2026-09-29 收进
      `use-notebook-overview.ts`。它只依赖 `note` 与 `epochRef` 两样。 */
  const requestedGoalResult = activeNoteRef?.noteId === note?.noteId ? activeNoteRef?.learningResult : undefined;
  const goalResult = useNotebookGoalResult(note?.noteId, requestedGoalResult, epochRef);
  const clearGoalResultSelection = () => {
    const room = useRoomStore.getState();
    if (room.activeNoteRef?.noteId === note?.noteId && room.activeNoteRef?.learningResult) {
      room.setActiveNoteRef({ ...room.activeNoteRef, learningResult: undefined, learningView: undefined });
    }
  };
  const {
    overviewRows, setOverviewRows,
    overviewLoading, setOverviewLoading, overviewError, setOverviewError,
    overviewTask, overviewTaskStarting,
    overviewTaskError, setOverviewTaskError,
    overviewOpen, setOverviewOpen, overviewPaperRef,
    loadNoteOverviews, loadLatestNoteOverviewTask, startNoteOverviewTask,
    noteOverviews, taskForCurrentVersion, latestNoteOverview,
  } = useNotebookOverview({ note, epochRef, requestedOverview: requestedGoalResult?.kind === "note_overview"
    ? goalResult.result?.kind === "note_overview" ? goalResult.result.overview : null : undefined });
  const { learningView, setLearningView, rememberReadingPosition } = useNotebookLearningView({
    noteId: note?.noteId ?? null,
    leaf, recallVisit,
    scrollRef: leafScrollRef, inReading: leaf === "reading",
    ready: !loading && !failure && Boolean(note),
  });
  useEffect(() => {
    if (loading || failure || !note || activeNoteRef?.noteId !== note.noteId || !activeNoteRef.learningView) return;
    if (activeNoteRef.learningView === "overview") { setLeaf("reading"); setLearningView("overview"); setOverviewOpen(true); }
    else if (activeNoteRef.learningView === "artifact") { setLeaf("reading"); setLearningView("artifact"); }
    else setLeaf(activeNoteRef.learningView);
    useRoomStore.getState().setActiveNoteRef({ ...activeNoteRef, learningView: undefined });
  }, [activeNoteRef, note?.noteId, loading, failure, setLearningView]);
  const [olderRounds, setOlderRounds] = useState<NoteLearningRoundHistoryV1 | null>(null);
  const [olderBusy, setOlderBusy] = useState(false);
  const [olderFailure, setOlderFailure] = useState<string | null>(null);


  /** 生成设置那两格（当前这一档 + 面板开没开）与它们在会话里的记忆，
      已于 2026-09-29 收进 `use-notebook-generation-options.ts`。 */
  const {
    options,
    setOptions,
    optionsOpen,
    setOptionsOpen,
  } = useNotebookGenerationOptions();

  /** 生成反馈那张表的两个 state 已于 2026-09-29 收进 `use-notebook-generation-feedback.ts`。 */
  const {
    reasons: feedbackReasons,
    setReasons: setFeedbackReasons,
    note: feedbackNote,
    reset: resetGenerationFeedback,
    setNote: setFeedbackNote,
  } = useNotebookGenerationFeedback();
  const loadOlderRounds = async () => {
    const api = desktopApi();
    const current = data?.note ?? null;
    if (!api || !current || !historyHasMore || olderBusy) return;
    setOlderBusy(true);
    setOlderFailure(null);
    try {
      const response = await api.noteLearningRound.history({
        meta: createRequestMeta(epochRef.current),
        noteId: current.noteId,
        before: historyNextCursor ?? undefined,
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      // 变量别叫 `page`：`page-readable-registration.test.ts` 那道静态守卫是"顺着调用点
      // 往前找同名声明"来认屏名的，同名的那一发会让它抓到错的初始化式、把两屏整个丢掉。
      const olderPage = unwrapGatewayResult(response);
      setOlderRounds((previous) => {
        const base = previous && previous.noteId === current.noteId && previous.contentMasked === olderPage.contentMasked
          ? previous
          : { noteId: current.noteId, items: [], nextCursor: null, hasMore: false };
        return {
          version: 1,
          noteId: current.noteId,
          contentMasked: olderPage.contentMasked,
          items: [...base.items, ...olderPage.items],
          nextCursor: olderPage.nextCursor,
          hasMore: olderPage.hasMore,
          // 累加之后各归各位：屏上列了几轮 = 两批 items 之和；总数还是服务端那一份
          // （它与游标无关，翻到第二页不会把它"翻小"）。少带任意一格，
          // 合同类型现在会当场拦住——因为这份状态不再手抄形状。
          shownCount: base.items.length + olderPage.items.length,
          totalCount: olderPage.totalCount,
        };
      });
    } catch (error) {
      setOlderFailure(gatewayErrorMessage(error));
    } finally {
      setOlderBusy(false);
    }
  };



  /** 版本历史那一簇（4 个 state + 读取与恢复）已于 2026-09-29 收进 `use-notebook-versions.ts`。 */
  const {
    versions, setVersions, versionsLoading, versionsFailure, setVersionsFailure,
    restoringVersionId, loadVersions, restoreVersion,
  } = useNotebookVersions({ data, epochRef, reload, api: desktopApi() });
  const loadLegacyRouteCoverage = useCallback(() => {
    if (!note || activeNoteRef?.learningRoundId
      || legacyRouteCoverageRequestedForNoteRef.current === note.noteId) return;
    legacyRouteCoverageRequestedForNoteRef.current = note.noteId;
    void reload({ silent: true });
  }, [activeNoteRef?.learningRoundId, note?.noteId, reload]);
  useEffect(() => {
    if (!note) return;
    const store = useRoomStore.getState();
    const current = store.activeNoteRef;
    if (current?.noteId === note.noteId && current.noteVersionId === note.currentVersionId) return;
    store.setActiveNoteRef({
      ...(current?.noteId === note.noteId ? current : {}),
      noteId: note.noteId,
      noteVersionId: note.currentVersionId,
      mode: current?.noteId === note.noteId ? current.mode : "preview",
      ...(current?.noteId === note.noteId && current.learningRoundId ? { learningRoundId: current.learningRoundId } : {}),
    });
  }, [note?.noteId, note?.currentVersionId]);









  const loadNoteLearningArtifacts = useCallback(async (before?: string) => {
    if (!note) return;
    const api = typeof window === "undefined" ? undefined : window.ailearn;
    if (!api?.noteLearningArtifact) {
      setLearningArtifactError("互动讲解记录暂不可用");
      return;
    }
    const request = ++learningArtifactRequestRef.current;
    setLearningArtifactLoading(true);
    setLearningArtifactError(null);
    try {
      const page = unwrapGatewayResult(await api.noteLearningArtifact.list({
        meta: createRequestMeta(epochRef.current),
        noteId: note.noteId,
        before,
      }));
      if (request !== learningArtifactRequestRef.current) return;
      setLearningArtifactRows((current) => before && current?.noteId === note.noteId
        ? { ...page, noteId: note.noteId, items: [...current.items, ...page.items.filter((item) => !current.items.some((seen) => seen.artifactId === item.artifactId))] }
        : { ...page, noteId: note.noteId });
    } catch (error) {
      if (request === learningArtifactRequestRef.current) setLearningArtifactError(gatewayErrorMessage(error));
    } finally {
      if (request === learningArtifactRequestRef.current) setLearningArtifactLoading(false);
    }
  }, [note?.noteId, note?.currentVersionId]);

  const loadNoteLearningArtifactTasks = useCallback(async () => {
    if (!note?.currentVersionId) return;
    const api = typeof window === "undefined" ? undefined : window.ailearn;
    if (!api?.noteLearningArtifact) {
      setLearningArtifactTaskError("互动演示任务暂不可用");
      return;
    }
    const request = ++learningArtifactTaskRequestRef.current;
    setLearningArtifactTaskError(null);
    const notifyTask = prepareNotebookTaskNotification(note, epochRef.current);
    try {
      const page = unwrapGatewayResult(await api.noteLearningArtifact.listTasks({
        meta: createRequestMeta(epochRef.current),
        noteId: note.noteId,
        query: { noteVersionId: note.currentVersionId },
      }));
      for (const task of page.items) if (["queued", "running"].includes(task.status)) notifyTask(task, "artifact");
      if (request !== learningArtifactTaskRequestRef.current) return;
      setLearningArtifactTasks(page.items);
      const completed = page.items.flatMap((task) => task.artifact ? [task.artifact] : []);
      if (completed.length) {
        setLearningArtifactRows((current) => {
          const base = current?.noteId === note.noteId ? current : { noteId: note.noteId, items: [], nextCursor: null };
          const items = [...completed, ...base.items.filter((artifact) => !completed.some((saved) => saved.artifactId === artifact.artifactId))];
          return { ...base, items };
        });
      }
    } catch (error) {
      if (request === learningArtifactTaskRequestRef.current) setLearningArtifactTaskError(gatewayErrorMessage(error));
    }
  }, [note?.noteId, note?.currentVersionId]);

  useEffect(() => {
    ++learningArtifactTaskRequestRef.current; learningArtifactStartingRef.current = false;
    setLearningArtifactTaskStarting(false);
    setLearningArtifactRows(null);
    setActiveLearningArtifactId(null);
    setLearningArtifactStoredId(null);
    setLearningArtifactTasks([]);
    setLearningArtifactTaskError(null);
    if (note) void loadNoteLearningArtifacts();
    if (note?.currentVersionId) void loadNoteLearningArtifactTasks();
    return () => { ++learningArtifactTaskRequestRef.current; learningArtifactStartingRef.current = false; };
  }, [note?.noteId, note?.currentVersionId, loadNoteLearningArtifacts, loadNoteLearningArtifactTasks]);

  const noteLearningArtifacts = useMemo(
    () => note && learningArtifactRows?.noteId === note.noteId ? learningArtifactRows.items : [],
    [note?.noteId, learningArtifactRows],
  );
  const activeLearningArtifact = requestedGoalResult?.kind === "note_dynamic_artifact"
    ? goalResult.result?.kind === "note_dynamic_artifact" ? goalResult.result.artifact : null
    : noteLearningArtifacts.find((item) => item.artifactId === activeLearningArtifactId) ?? null;

  useEffect(() => {
    if (goalResult.result?.kind === "note_dynamic_artifact") {
      setActiveLearningArtifactId(goalResult.result.artifact.artifactId);
    }
  }, [goalResult.result]);

  const runningArtifactTaskIds = learningArtifactTasks
    .filter((task) => task.status === "queued" || task.status === "running")
    .map((task) => task.taskId);
  const runningArtifactTaskKey = runningArtifactTaskIds.join("|");

  useEffect(() => {
    if (!note || !runningArtifactTaskKey) return;
    const api = desktopApi();
    if (!api?.noteLearningArtifact) return;
    const taskIds = runningArtifactTaskKey.split("|").filter(Boolean);
    let cancelled = false;
    let timer: number | undefined;
    const poll = () => {
      timer = window.setTimeout(async () => {
        try {
          const updates = await Promise.all(taskIds.map(async (taskId) => unwrapGatewayResult(await api.noteLearningArtifact!.getTask({
            meta: createRequestMeta(epochRef.current), noteId: note.noteId, taskId,
          }))));
          if (cancelled) return;
          setLearningArtifactTasks((current) => current.map((task) => updates.find((update) => update.taskId === task.taskId) ?? task));
          const completed = updates.flatMap((task) => task.artifact ? [task.artifact] : []);
          if (completed.length) {
            setLearningArtifactRows((current) => {
              const base = current?.noteId === note.noteId ? current : { noteId: note.noteId, items: [], nextCursor: null };
              const items = [...completed, ...base.items.filter((artifact) => !completed.some((saved) => saved.artifactId === artifact.artifactId))];
              return { ...base, items };
            });
            setLearningArtifactTaskError(null);
          }
          if (updates.some((task) => task.status === "queued" || task.status === "running")) poll();
        } catch (error) {
          if (cancelled) return;
          setLearningArtifactTaskError(gatewayErrorMessage(error));
          poll();
        }
      }, 1_500);
    };
    poll();
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [note?.noteId, note?.currentVersionId, runningArtifactTaskKey]);

  useEffect(() => {
    const artifact = activeLearningArtifact;
    if (!artifact) {
      setLearningArtifactStoredId(null);
      return;
    }
    const api = desktopApi();
    if (!api) return;
    let cancelled = false;
    setLearningArtifactError(null);
    void (async () => {
      try {
        const response = await api.artifact.ensure({
          meta: createRequestMeta(epochRef.current),
          artifactId: artifact.artifactId,
          origin: "note_learning",
        });
        if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
        unwrapGatewayResult(response);
        if (!cancelled) setLearningArtifactStoredId(artifact.artifactId);
      } catch (error) {
        if (!cancelled) setLearningArtifactError(gatewayErrorMessage(error));
      }
    })();
    return () => { cancelled = true; };
  }, [activeLearningArtifact?.artifactId, learningArtifactEnsureRevision]);

  const loadNoteExpansions = useCallback(async (before?: { createdAt: string; expansionId: string }) => {
    if (!note) return;
    const api = typeof window === "undefined" ? undefined : window.ailearn;
    if (!api?.noteExpansion) {
      setExpansionError("拓展记录暂不可用");
      return;
    }
    const request = ++expansionRequestRef.current;
    setExpansionLoading(true);
    setExpansionError(null);
    try {
      const page = unwrapGatewayResult(await api.noteExpansion.list({
        meta: createRequestMeta(epochRef.current),
        noteId: note.noteId,
        ...(before ? { query: { beforeCreatedAt: before.createdAt, beforeExpansionId: before.expansionId } } : {}),
      }));
      if (request !== expansionRequestRef.current) return;
      setExpansionRows((current) => before && current?.noteId === note.noteId
        ? { ...page, noteId: note.noteId, items: [...current.items, ...page.items.filter((item) => !current.items.some((seen) => seen.expansionId === item.expansionId))] }
        : { ...page, noteId: note.noteId });
    } catch (error) {
      if (request === expansionRequestRef.current) setExpansionError(gatewayErrorMessage(error));
    } finally {
      if (request === expansionRequestRef.current) setExpansionLoading(false);
    }
  }, [note?.noteId]);

  useEffect(() => {
    setExpansionRows(null);
    if (note) void loadNoteExpansions();
  }, [note?.noteId, loadNoteExpansions]);



  useEffect(() => {
    const onExpansionSaved = (event: Event) => {
      const detail = (event as CustomEvent<{ noteId?: unknown; expansion?: unknown }>).detail;
      const parsed = noteExpansionLinkV1Schema.safeParse(detail?.expansion);
      const currentNote = note;
      if (!parsed.success || !currentNote || detail?.noteId !== currentNote.noteId || parsed.data.sourceNoteId !== currentNote.noteId) return;
      setExpansionRows((current) => {
        const base = current?.noteId === currentNote.noteId ? current : { noteId: currentNote.noteId, items: [], nextCursor: null };
        return { ...base, items: [parsed.data, ...base.items.filter((item) => item.expansionId !== parsed.data.expansionId)] };
      });
    };
    window.addEventListener("ailearn:note-expansion-saved", onExpansionSaved);
    return () => window.removeEventListener("ailearn:note-expansion-saved", onExpansionSaved);
  }, [note?.noteId]);

  useEffect(() => {
    setOverviewRows(null);
    if (note) void loadNoteOverviews();
  }, [note?.noteId, loadNoteOverviews]);

  // Earlier Companion replies remain in the history, but they never claimed
  // full-note coverage. Only a completed background task can occupy the
  // reading page's "这篇的重点" slot.
  const currentNoteOverviews = noteOverviews.filter((overview) => overview.versionState === "current"
    && overview.generationJobId !== null && overview.coverage !== null);

  const noteExpansions = useMemo(
    () => note && expansionRows?.noteId === note.noteId ? expansionRows.items : [],
    [note?.noteId, expansionRows],
  );
  const noteAnnotations = useMemo(
    () => note && annotationRows && annotationRows.noteId === note.noteId ? annotationRows.items : [],
    [annotationRows, note?.noteId],
  );
  const currentAnnotationCandidates = useMemo(
    () => chronologicalAnnotations(noteAnnotations.filter((annotation) => annotation.versionState === "current")),
    [noteAnnotations],
  );
  const currentVerification = annotationVerification;
  const verificationIds = note && currentVerification && currentVerification.noteId === note.noteId
    && currentVerification.versionId === note.currentVersionId ? currentVerification.ids : null;
  const currentNoteAnnotations = verificationIds
    ? currentAnnotationCandidates.filter((annotation) => verificationIds.has(annotation.annotationId))
    : [];
  const unresolvedNoteAnnotations = verificationIds
    ? currentAnnotationCandidates.filter((annotation) => !verificationIds.has(annotation.annotationId))
    : [];
  const olderNoteAnnotations = noteAnnotations.filter((annotation) => annotation.versionState === "older");
  const [annotationDeleting, setAnnotationDeleting] = useState(false);
  const annotationDeleteInFlightRef = useRef<symbol | null>(null);
  const annotationDeleteScopeRef = useRef(note?.noteId);
  annotationDeleteScopeRef.current = note?.noteId;
  const [annotationRemovedNotice, setAnnotationRemovedNotice] = useState<string | null>(null);
  /**
   * 两步确认的状态**页面只存一份**：记号浮层那枚「删掉这条」和批注附页那颗
   * 「删掉这条批注」是同一个动作的两个入口。各自存一份的话，会出现「附页里正问着
   * 要不要删，正文里那枚记号还是平常的样子」。
   */
  const annotationDelete = useAnnotationDeleteConfirm();
  useEffect(() => {
    setAnnotationDeleting(false);
    setAnnotationRemovedNotice(null);
    annotationDelete.reset();
    return () => { annotationDeleteInFlightRef.current = null; };
  }, [note?.noteId]);

  const loadNoteAnnotations = useCallback(async (before?: string) => {
    if (!note) return;
    const api = typeof window === "undefined" ? undefined : window.ailearn;
    if (!api?.noteAnnotation) {
      setAnnotationError("批注记录暂不可用");
      return;
    }
    const request = ++annotationRequestRef.current;
    setAnnotationLoading(true);
    setAnnotationError(null);
    try {
      const page = unwrapGatewayResult(await api.noteAnnotation.list({
        meta: createRequestMeta(epochRef.current),
        noteId: note.noteId,
        before,
      }));
      if (request !== annotationRequestRef.current) return;
      setAnnotationRows((current) => before && current?.noteId === note.noteId
        ? { ...page, noteId: note.noteId, items: [...current.items, ...page.items] }
        : { ...page, noteId: note.noteId });
    } catch (error) {
      if (request === annotationRequestRef.current) setAnnotationError(gatewayErrorMessage(error));
    } finally {
      if (request === annotationRequestRef.current) setAnnotationLoading(false);
    }
  }, [note?.noteId]);

  const loadLatestNoteAnnotationTask = useCallback(async () => {
    if (!note?.currentVersionId) return;
    const api = typeof window === "undefined" ? undefined : window.ailearn;
    if (!api?.noteAnnotation) return;
    const request = ++annotationTaskRequestRef.current;
    setAnnotationTaskError(null);
    try {
      const result = unwrapGatewayResult(await api.noteAnnotation.latestTask({
        meta: createRequestMeta(epochRef.current),
        noteId: note.noteId,
        query: { noteVersionId: note.currentVersionId },
      }));
      if (request === annotationTaskRequestRef.current) {
        setAnnotationTask(result.task);
        if (result.task?.annotation) {
          const saved = result.task.annotation;
          setAnnotationRows((current) => {
            const base = current?.noteId === note.noteId ? current : { noteId: note.noteId, items: [], nextCursor: null };
            return { ...base, items: [saved, ...base.items.filter((item) => item.annotationId !== saved.annotationId)] };
          });
        }
      }
    } catch (error) {
      if (request === annotationTaskRequestRef.current) setAnnotationTaskError(gatewayErrorMessage(error));
    }
  }, [note?.noteId, note?.currentVersionId]);

  const startNoteAnnotationTask = useCallback(async (anchor: NoteAnnotationAnchorV1, hasUnsavedChanges: boolean) => {
    if (!note || !note.currentVersionId || annotationTaskStarting || hasUnsavedChanges) return;
    const api = typeof window === "undefined" ? undefined : window.ailearn;
    if (!api?.noteAnnotation) {
      setAnnotationTaskError("这句解释暂时不可用");
      return;
    }
    const request = ++annotationTaskRequestRef.current;
    setAnnotationTaskStarting(true);
    setAnnotationTaskError(null);
    try {
      const task = unwrapGatewayResult(await api.noteAnnotation.startTask({
        meta: createRequestMeta(epochRef.current),
        noteId: note.noteId,
        request: { anchor, requestId: crypto.randomUUID() },
      }));
      if (request === annotationTaskRequestRef.current) {
        setAnnotationTask(task);
        requestedAnnotationTaskRef.current = task.taskId;
        setAnnotationTaskOpen(true);
        setHistoryOpen(false);
        setOpenAnnotationId(null);
        setSelectedPassage(null);
        setFocusedBlockOrdinal(task.anchor.startBlockOrdinal);
        setLeaf("reading");
      }
    } catch (error) {
      if (request === annotationTaskRequestRef.current) setAnnotationTaskError(gatewayErrorMessage(error));
    } finally {
      if (request === annotationTaskRequestRef.current) setAnnotationTaskStarting(false);
    }
  }, [note?.noteId, note?.currentVersionId, annotationTaskStarting]);

  /**
   * 删掉一条批注。
   *
   * 三处要一起收：
   * 1. **列表**：那条批注从屏上消失（否则纸合上再打开，它还在）。
   * 2. **复核集合** `annotationVerification.ids`：它是「复核的是哪一版的哪几条」，
   *    留着这条 id，下一次读列表时 `currentNoteAnnotations` 会拿一个已经不存在的
   *    id 去比对，结果是**这一篇所有批注的记号一起消失**——所以必须从集合里摘掉。
   * 3. **产物任务**：它按锚点找得到那批演示，删完批注就没人引它们了，屏上也不该
   *    再摆着「打开互动演示」。
   *
   * `expectedRevision` 走的是批注自己的修订号：别人刚改过这一条时按删除会被服务端
   * 挡下（`stale_revision`），不会把别人的改动连同批注一起抹掉。
   *
   * 伴星的对话**不动**：删除只经 `noteAnnotation.write` 的 `remove` 分支，
   * 服务端删的是 `note_annotations` 行与按锚点对上的动态讲解页。
   */
  const removeNoteAnnotation = useCallback(async (target: NoteAnnotationV1) => {
    const api = typeof window === "undefined" ? undefined : window.ailearn;
    const current = note;
    if (!api?.noteAnnotation || !current || annotationDeleteInFlightRef.current) return;
    const request = Symbol("annotation-delete");
    annotationDeleteInFlightRef.current = request;
    const isCurrent = () => annotationDeleteInFlightRef.current === request && annotationDeleteScopeRef.current === current.noteId;
    setAnnotationDeleting(true);
    setAnnotationRemovedNotice(null);
    try {
      const result = unwrapGatewayResult(await api.noteAnnotation.write({
        meta: createRequestMeta(epochRef.current),
        noteId: current.noteId,
        command: { kind: "remove", annotationId: target.annotationId, expectedRevision: target.revision },
      }));
      if (!isCurrent()) return;
      setAnnotationRows((rows) => rows?.noteId === current.noteId
        ? { ...rows, items: rows.items.filter((item) => item.annotationId !== target.annotationId) }
        : rows);
      setAnnotationVerification((current2) => {
        if (!current2 || current2.noteId !== current.noteId) return current2;
        const ids = new Set(current2.ids);
        ids.delete(target.annotationId);
        return { ...current2, ids };
      });
      setLearningArtifactTasks((tasks) => tasks.filter((item) => !(item.sourceKind === "annotation"
        && item.selectionAnchor
        && item.selectionAnchor.noteVersionId === target.anchor.noteVersionId
        && item.selectionAnchor.startBlockOrdinal === target.anchor.startBlockOrdinal
        && item.selectionAnchor.startOffset === target.anchor.startOffset
        && item.selectionAnchor.endBlockOrdinal === target.anchor.endBlockOrdinal
        && item.selectionAnchor.endOffset === target.anchor.endOffset
        && item.selectionAnchor.excerpt === target.anchor.excerpt)));
      setOpenAnnotationId((open) => (open === target.annotationId ? null : open));
      const removedArtifacts = "removedArtifacts" in result ? result.removedArtifacts : 0;
      setAnnotationRemovedNotice(removedArtifacts > 0
        ? `已删掉这条批注和它做的 ${removedArtifacts} 个互动演示。伴星的对话记录没有动。`
        : "已删掉这条批注。伴星的对话记录没有动。");
    } catch (error) {
      if (isCurrent()) annotationDelete.fail(target, gatewayErrorMessage(error));
    } finally {
      if (isCurrent()) { annotationDeleteInFlightRef.current = null; setAnnotationDeleting(false); }
    }
  }, [note?.noteId]);

  /**
   * 记号浮层里那一格「删掉这条」（正文里就能删，不必先开附页）。
   *
   * 两个入口唯一的差别是**短版**（浮层只有两百来宽）与措辞更短；确认状态与那句
   * 「对话不受影响」仍是同一份，所以漏不掉。声明在 `removeNoteAnnotation` 之后——
   * 它要用那一个。
   */
  const renderAnnotationDeleteControl = useCallback((annotation: NoteAnnotationV1) =>
    <AnnotationDeleteControl annotation={annotation} compact
      hasArtifact={learningArtifactTasks.some((task) => task.sourceKind === "annotation"
        && task.status === "ready" && task.selectionAnchor
        && task.selectionAnchor.noteVersionId === annotation.anchor.noteVersionId
        && task.selectionAnchor.startBlockOrdinal === annotation.anchor.startBlockOrdinal
        && task.selectionAnchor.startOffset === annotation.anchor.startOffset
        && task.selectionAnchor.endBlockOrdinal === annotation.anchor.endBlockOrdinal
        && task.selectionAnchor.endOffset === annotation.anchor.endOffset
        && task.selectionAnchor.excerpt === annotation.anchor.excerpt)}
      view={annotationDelete.viewFor(annotation)}
      deleting={annotationDeleting} error={annotationDelete.errorFor(annotation)}
      onRequest={() => annotationDelete.request(annotation)}
      onCancel={annotationDelete.cancel}
      onConfirm={() => void removeNoteAnnotation(annotation)} />,
    [annotationDelete, annotationDeleting, learningArtifactTasks, removeNoteAnnotation]);

  useEffect(() => {
    setAnnotationRows(null);
    setAnnotationVerification(null);
    setOpenAnnotationId(null);
    setAnnotationShelfOpen(false);
    setSelectedPassage(null);
    setAnnotationTask(null);
    setAnnotationTaskOpen(false);
    requestedAnnotationTaskRef.current = null;
    setAnnotationTaskError(null);
    setAnnotationTaskStarting(false);
    if (note) void loadNoteAnnotations();
    if (note?.currentVersionId) void loadLatestNoteAnnotationTask();
  }, [note?.noteId, note?.currentVersionId, loadNoteAnnotations, loadLatestNoteAnnotationTask]);

  useEffect(() => {
    if (!note || !annotationTask || annotationTask.noteId !== note.noteId
      || annotationTask.noteVersionId !== note.currentVersionId
      || (annotationTask.status !== "queued" && annotationTask.status !== "running")) return;
    const api = typeof window === "undefined" ? undefined : window.ailearn;
    if (!api?.noteAnnotation) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = () => {
      timer = window.setTimeout(async () => {
        try {
          const task = unwrapGatewayResult(await api.noteAnnotation.getTask({
            meta: createRequestMeta(epochRef.current), noteId: note.noteId, taskId: annotationTask.taskId,
          }));
          if (cancelled) return;
          setAnnotationTaskError(null);
          setAnnotationTask(task);
          if (task.status === "ready" && task.annotation) {
            const saved = task.annotation;
            setAnnotationRows((current) => {
              const base = current?.noteId === note.noteId ? current : { noteId: note.noteId, items: [], nextCursor: null };
              return { ...base, items: [saved, ...base.items.filter((item) => item.annotationId !== saved.annotationId)] };
            });
            setAnnotationVerification(null);
            if (requestedAnnotationTaskRef.current === task.taskId && annotationTaskOpen) {
              setOpenAnnotationId(saved.annotationId);
              setAnnotationTaskOpen(false);
            }
          } else if (task.status === "queued" || task.status === "running") {
            poll();
          }
        } catch (error) {
          if (cancelled) return;
          setAnnotationTaskError(gatewayErrorMessage(error));
          poll();
        }
      }, 1_500);
    };
    poll();
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [note?.noteId, note?.currentVersionId, annotationTask, annotationTaskOpen]);
  useEffect(() => {
    const onAnnotationSaved = (event: Event) => {
      const detail = (event as CustomEvent<{ noteId?: unknown; annotation?: unknown }>).detail;
      const parsed = noteAnnotationV1Schema.safeParse(detail?.annotation);
      const currentNote = note;
      if (!parsed.success || !currentNote || detail?.noteId !== currentNote.noteId) return;
      setAnnotationRows((current) => {
        const base = current?.noteId === currentNote.noteId ? current : { noteId: currentNote.noteId, items: [], nextCursor: null };
        return { ...base, items: [parsed.data, ...base.items.filter((item) => item.annotationId !== parsed.data.annotationId)] };
      });
      setAnnotationVerification(null);
      // Completion updates the original quote without replacing a manual draft or another open paper.
      if (parsed.data.versionState === "older") setAnnotationShelfOpen(true);
    };
    window.addEventListener("ailearn:note-annotation-saved", onAnnotationSaved);
    return () => window.removeEventListener("ailearn:note-annotation-saved", onAnnotationSaved);
  }, [note?.noteId]);
  useEffect(() => {
    if (!activeNoteRef?.learningRoundId || note?.noteId !== activeNoteRef.noteId ||
      reflectionRoundId !== activeNoteRef.learningRoundId || leaf !== "history" || mode !== "preview") return;
    const frame = requestAnimationFrame(() => {
      reflectionShelfRef.current?.scrollIntoView({ block: "start" });
      reflectionShelfRef.current?.querySelector("summary")?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [activeNoteRef?.noteId, activeNoteRef?.learningRoundId, note?.noteId, reflectionRoundId, leaf, mode]);
  const source = data?.source ?? null;
  const sourceFailure = data?.sourceFailure ?? null;
  const objective = data?.objective ?? null;
  /** 单项目标只在记录页的复习安排中出现。 */
  const noteObjective = data?.noteObjective ?? null;
  /** W7-3 刀六：这一篇的笔记订阅；读不到＝没有那一档开关（与上面同一纪律）。 */
  const noteSubscription = data?.noteSubscription ?? null;
  const openRound = data?.openRound ?? null;

  /** 三簇「一颗写动作 + 它的在途 + 它的失败」已于 2026-09-29 收进各自的 hook。
      三处纪律（成功后回读 / 回执念出来 / 失败不吞）在那些文件的头注释里。 */
  const {
    reviewHoldBusy, reviewHoldNotice, reviewHoldError, runObjectiveReviewHoldAction,
  } = useNotebookReviewHold({
    noteId: data?.note?.noteId ?? null,
    currentVersionId: data?.note?.currentVersionId ?? null,
    noteObjective,
    epochRef, reload, api: desktopApi(),
    notices: { hold: objectiveHoldNotice, resume: objectiveResumeNotice },
  });
  const {
    subscriptionBusy, subscriptionNotice, subscriptionError, runNoteSubscriptionAction,
  } = useNotebookSubscription({
    noteId: data?.note?.noteId ?? null,
    epochRef, reload, api: desktopApi(),
    notices: { notice: reviewSubscriptionNotice },
  });
  const {
    teachingBusy, teachingFailure, teachingReflectionIds, setTeachingReflectionIds, startRoundTeaching,
  } = useNotebookTeaching({
    epochRef, reload, api: desktopApi(), openRound,
    classifyError: classifyGatewayError,
  });
  useEffect(() => {
    if (!data || !activeNoteRef?.learningRoundId || data.note.noteId !== activeNoteRef.noteId) return;
    const key = `${data.note.noteId}:${activeNoteRef.learningRoundId}`;
    if (handledRoundReturnRef.current === key) return;
    handledRoundReturnRef.current = key;
    // 「回到本轮学习」这颗按钮承诺的是**这一轮**，不是这篇文章。
    // 同一篇可能已有更新的一轮；回看旧轮次不能把读者送到那一轮。
    if (openRound?.roundId === activeNoteRef.learningRoundId) setLeaf("learning");
    else setLeaf("history");
  }, [data, activeNoteRef?.learningRoundId, openRound]);
  useEffect(() => { setTeachingReflectionIds([]); }, [activeNoteRef?.noteId, openRound?.roundId]);
  const openRoundContentMoved = data?.openRoundContentMoved ?? false;
  const openRoundNoteChangeImpact = data?.openRoundNoteChangeImpact ?? null;
  const roundHistory = data?.roundHistory ?? null;
  const routeCoverage = data?.routeCoverage ?? null;
  const routeCoverageFailure = data?.routeCoverageFailure ?? null;
  /** 这一轮当前问题下的那条解释；`null` = 还没讲过（W4-6 刀二）。 */
  const roundTeaching = data?.roundTeachingView?.teaching ?? null;
  const roundNextStep = data?.roundTeachingView?.nextStep ?? null;
  const roundTeachingFailure = data?.roundTeachingFailure ?? null;
  /** 这一轮练过的那几道（W4-6 刀三；空数组 = 还没练过）。 */
  const roundPractices = data?.roundTeachingView?.practices ?? [];
  const practiceReceiptKey = roundPractices.map((practice) => `${practice.runId}:${practice.phase}:${practice.outcome ?? ""}`).join("|");
  useEffect(() => { setReviewingTeaching(false); }, [openRound?.roundId, practiceReceiptKey]);
  const learningScene = noteLearningScene({
    roundPhase: openRound?.phase === "paused" ? "paused" : openRound ? "active" : null,
    editingQuestion: roundEditing,
    hasTeaching: Boolean(roundTeaching),
    nextStep: roundNextStep,
  });
  const latestRoundPractice = roundPractices.at(-1) ?? null;
  /**
   * 此刻真正在跑的那一步，一句话；没有在跑就是 `null`。
   *
   * 三个动作各有各的 `busy` 布尔，于是屏上会出现"这一颗按钮说自己忙、那一颗按钮
   * 说自己不忙、纸片底下还有一条红字"的三方不一致——用户看不出点了什么、在等什么。
   * 这里按**优先级取唯一一个**在途动作（讲解 > 练一道 > 开轮次），只说那一句。
   *
   * 刻意不给百分比、不给预计秒数（§13.3「不伪造预计成功率」）：说得出来的只有
   * "在做哪一步"，以及"做好了会自动接上"。
   */
  //
  // **不要**在正文里再写一个"正在"：`RoundNotice` 的 pending 档已经印了"还在准备"
  // 这一格标签（它是给屏幕阅读器的那句前缀，真窗口里两句拼起来读成"还在准备正在准备
  // 这一道小问题"——同一件事说了两遍，且第二遍把第一遍吞掉了）。
  const inFlightStep: string | null = teachingBusy
    ? "为这个问题准备讲解。做好了会自动接上，可以先去读笔记。"
    : practiceBusy
      ? "准备这一道小问题。做好了会自动接上。"
      : roundBusy !== null
        ? "处理这一轮。处理完会接上，不用重复点。"
        : null;
  const roundResultCopy = notePracticeResultCopy({
    question: openRound?.drivingQuestion ?? null,
    practices: roundPractices,
    nextStep: roundNextStep,
  });
  /**
   * 纸上那三枚纸签（39f UI-2：暂停回来第一眼看不见"做过什么、接着做什么"）。
   *
   * 每一枚的判定都来自真实状态：讲没讲过看讲解在不在，练没练过看**已结算**的那几次，
   * 结果看服务端有没有说这一轮可以收。所以这一排不会在用户什么也没做的时候先亮一格。
   */
  const roundTrack = roundTrackV1({
    scene: learningScene,
    hasTeaching: Boolean(roundTeaching),
    practiceCount: roundPractices.length,
    settledCount: roundPractices.filter((practice) => practice.outcome !== null).length,
    canFinish: roundNextStep?.kind === "finish",
  });
  /** 「练一道」那一发的起点；`null` = 没有可开的目标（无目标轮次不摆这颗按钮）。 */
  const roundPracticeStart = data?.roundTeachingView?.practiceStart ?? null;
  /** 缺口帮助停止那一格（W4-6 刀四）：停了就摆四选一。 */
  const roundGapHelp = data?.roundTeachingView?.gapHelp ?? null;
  /** 这一条解释的动态产物引用（W4-6 刀五）；`null` = 没有动态版本（不是失败）。 */
  const roundArtifact = data?.roundTeachingView?.artifact ?? null;
  const capabilities = data?.capabilities ?? null;
  const activeGenerations = data?.activeGeneration?.state === "data" ? data.activeGeneration.data : [];
  // 这篇笔记自己的在制批次。一个工作区可以同时有多篇笔记各自在制一批卡，所以
  // 必须按 noteId 找，不能取「最近更新的那一个」——此前取的是后者，于是第二篇
  // 笔记的在制 run 一出现，这篇笔记的守卫就失效，「生成学习卡」可以再点一次
  // （2026-09-20 实走复盘 #5）。run 在服务端跑，页面必须显示它的步骤而不是
  // 对同一个版本再开一次。
  const noteGeneration: CardGenerationActiveSummaryV1 | null = note
    ? activeGenerations.find((generation) => isLiveGenerationForNote(generation, note.noteId)) ?? null
    : null;
  const latestRun = data?.latestGenerationRun ?? null;
  // Only a run that has stopped can be answered; while one is live the page
  // offers the status sync instead of a second start.
  const feedbackTarget = latestRun && FINISHED_RUN_STATUSES.has(latestRun.status) ? latestRun : null;
  const segments = source?.segments ?? [];
  // Every block type — including images, which the editor writes as one
  // markdown line — has a text form now, so editability is a pure permission.


  // 第一篇笔记刚读回来的那一帧还没有模式、回执这些"跟着这一篇重置"的状态，
  // 编辑页要等它过完再挂（早挂一帧就是白挂一份马上被换掉的编辑器）。
  const draftSeeded = Boolean(note && syncedNoteRef.current === note.noteId);
  // Dirty is a statement about **this machine's own keystrokes**: the draft differs
  // from the last thing it submitted (or was seeded with). It used to compare the
  // draft against the freshly-read server record, which a collab peer can move ahead
  // of — that made an untouched page look clean while its text was already stale, and
  // its next autosave deleted the peer's sentence (measured 2026-09-22, two windows).
  // Whitespace the block model cannot represent still must not keep the page dirty
  // forever, so both sides compare through the same markdown the seeding produced.
  // 别人（同机另一个窗口、另一台机器、另一个人）改了这一篇：正文由 yjs 合进这份文档，
  // 阅读态与编辑态画的是**同一份**文档，不必再按模式二选一（那是批次 C 之前
  // "编辑态不接远端帧"那条分支存在的唯一理由）。仍然叫醒一次回读，取的是版本号、
  // 权限、来源片段那半边（为什么帧比回读新：见 use-note-doc-live-view 里 3.5 秒的实测）。

  // 标题只有一个事实源：文档 `meta` 里那一份（起点还没到时退回这次回读的那一份）。
  // 界面上只留"本机改过、还没写进文档"的那一段，所以别人的改名会跟着上屏，
  // 而我正在改的那一段不会被盖掉——两件事共用同一条判据 `draft.title !== null`。
  const docTitle = noteDocLive.fragment ? noteDocLive.title : note?.title ?? "";
  const titleValue = draft.title ?? docTitle;
  // "有没有待提交"问文档，不问界面上的文本拷贝：拷贝落后于文档时两种判断都会算错，
  // 实测过的最坏结局就是拿落后那份去覆盖。标题这一半得单独判——它在文档里是一份
  // LWW 文本，没有"攒着没发的增量"可看。
  const titleEdited = draft.title !== null && draft.title !== docTitle;
  const dirty = noteDocLive.dirty || titleEdited;

  const {
    expansionTask, setExpansionTask, expansionTaskLoading, expansionTaskStarting,
    expansionReviewSaving, expansionTaskError, expansionTaskErrorAction, retryNoteExpansionTask, expansionReviewDirty,
    loadLatestNoteExpansionTask, startNoteExpansionTask,
    persistNoteExpansionReview, confirmNoteExpansionDrafts,
    expansionTaskHistory, expansionTaskHistoryCursor, expansionTaskHistoryLoading, expansionTaskHistoryError,
    loadNoteExpansionTaskHistory, openNoteExpansionTask,
  } = useNotebookExpansionTask({ note, dirty, epochRef,
    requestedTask: requestedGoalResult?.kind === "note_expansion" && requestedGoalResult.noteVersionId
      ? { taskId: requestedGoalResult.taskId, noteVersionId: requestedGoalResult.noteVersionId } : undefined,
    onStarted: (task) => {
      const room = useRoomStore.getState();
      if (room.activeNoteRef?.noteId !== task.noteId) return;
      room.setActiveNoteRef({ ...room.activeNoteRef, noteVersionId: task.noteVersionId, learningResult: {
        kind: "note_expansion", artifactId: task.taskId, taskId: task.taskId, noteVersionId: task.noteVersionId,
      } });
    },
    onConfirmed: (links) => {
    links.forEach(expansion => window.dispatchEvent(new CustomEvent("ailearn:note-expansion-saved", {
      detail: { noteId: note!.noteId, expansion },
    })));
    void loadNoteExpansions();
  } });
  const selectedExpansionDraftCount = expansionTask?.drafts.filter((draft) => draft.selected).length ?? 0;
  const startNoteLearningArtifactTask = useCallback(async (
    sourceKind: "overview" | "annotation",
    selectionAnchor?: NoteAnnotationAnchorV1,
    useSavedVersion = false,
  ) => {
    if (!note?.currentVersionId || dirty && !useSavedVersion || learningArtifactStartingRef.current) return;
    const anchor = selectionAnchor ? { ...selectionAnchor, noteVersionId: note.currentVersionId } : undefined;
    if (anchor && !noteAnchorMatchesV1(note.currentVersion.blocks, anchor)) {
      setLearningArtifactTaskError("原句在新版本里变了，请回到正文重新圈选后制作演示。"); return;
    }
    if (learningArtifactTasks.some(task => (task.status === "queued" || task.status === "running") && task.sourceKind === sourceKind
      && (sourceKind === "overview" || JSON.stringify(task.selectionAnchor) === JSON.stringify(anchor)))) return;
    const api = typeof window === "undefined" ? undefined : window.ailearn;
    if (!api?.noteLearningArtifact) {
      setLearningArtifactTaskError("互动演示暂时不可用");
      return;
    }
    const request = ++learningArtifactTaskRequestRef.current;
    const expectedScope = learningArtifactScopeRef.current;
    learningArtifactStartingRef.current = true;
    setLearningArtifactTaskStarting(true);
    setLearningArtifactTaskError(null);
    const notifyTask = prepareNotebookTaskNotification(note, epochRef.current);
    try {
      const task = unwrapGatewayResult(await api.noteLearningArtifact.startTask({
        meta: createRequestMeta(epochRef.current),
        noteId: note.noteId,
        request: {
          noteVersionId: note.currentVersionId,
          requestId: crypto.randomUUID(),
          sourceKind,
          ...(anchor ? { selectionAnchor: anchor } : {}),
        },
      }));
      notifyTask(task, "artifact");
      if (request === learningArtifactTaskRequestRef.current && expectedScope === learningArtifactScopeRef.current) {
        setLearningArtifactTasks((current) => [task, ...current.filter((item) => item.taskId !== task.taskId)]);
        if (task.artifact) {
          setLearningArtifactRows((current) => {
            const base = current?.noteId === note.noteId ? current : { noteId: note.noteId, items: [], nextCursor: null };
            return { ...base, items: [task.artifact!, ...base.items.filter((item) => item.artifactId !== task.artifact!.artifactId)] };
          });
        }
      }
    } catch (error) {
      if (request === learningArtifactTaskRequestRef.current) setLearningArtifactTaskError(gatewayErrorMessage(error));
    } finally {
      if (request === learningArtifactTaskRequestRef.current) { learningArtifactStartingRef.current = false; setLearningArtifactTaskStarting(false); }
    }
  }, [note?.noteId, note?.currentVersionId, dirty, learningArtifactTasks]);

  // 正文也只有一个来源了：这一份文档。它既含别人写进来的，也含本机还没交出去的，
  // 所以不必在"帧"和"回读"之间二选一（那两个来源并存正是上一次覆盖的根）。
  const readSourceBlocks = noteDocLive.fragment ? noteDocLive.blocks : (note?.currentVersion.blocks ?? []);
  /**
   * 这一屏的正文来自哪里（审计 F35）。实时文档优先、没有才退回当前版本——这正是
   * 上一行那个判据；标签必须跟着它。以前一边渲染未定版的实时文档、一边写
   * "不可变版本：v1"，而 v1 本身是空的：那句话是假的，用户以为自己在读一个已定版的版本。
   */
  const readingUnversionedContent = Boolean(noteDocLive.fragment && (titleValue !== note?.title
    || JSON.stringify(readSourceBlocks.map(({ type, content }) => ({ type, content })))
      !== JSON.stringify((note?.currentVersion.blocks ?? []).map(({ type, content }) => ({ type, content })))));
  // Autosave submits the live document without creating a saved version. Its
  // cleared dirty flag cannot make a run from the previous source current again.
  const generationNeedsSavedVersion = dirty || readingUnversionedContent;
  const readTitle = titleValue;
  // 谁在这同一块里：判据只有对端自己报的那一格，`caretBlock` 为空时不成立
  // （光标还没进正文，说不出"这一段"是哪一段）。
  const coWriters = caretBlock === null
    ? []
    : noteDocLive.presencePeers.filter((peer) => peer.block === caretBlock);
  const mark = useMemo(
    () => conceptMark(readSourceBlocks, objective?.content.conceptLabel),
    [readSourceBlocks, objective],
  );
  const allBlocks = readSourceBlocks;
  // §16.16 的第二半：这篇有小节时才多给几颗"从结构里另选"的起步句（用全部块，
  // 不用阅读窗口那一段——结构是整篇的事实，不是当前滚到哪一屏）。
  const structureQuestions = useMemo(
    () => structureQuestionCandidatesV1(readSourceBlocks, docTitle),
    [readSourceBlocks, docTitle],
  );
  const readingBlocks = showAllBlocks || allBlocks.length <= READING_WINDOW
    ? allBlocks
    : allBlocks.slice(0, READING_WINDOW);
  useEffect(() => {
    if (!note || !annotationTask || annotationTask.noteId !== note.noteId
      || requestedAnnotationTaskRef.current !== annotationTask.taskId
      || annotationTask.noteVersionId !== note.currentVersionId || annotationTask.status === "ready"
      || focusedAnnotationTaskRef.current === annotationTask.taskId) return;
    focusedAnnotationTaskRef.current = annotationTask.taskId;
    if (!readingBlocks.some((block) => block.ordinal === annotationTask.anchor.startBlockOrdinal)) setShowAllBlocks(true);
    setFocusedBlockOrdinal(annotationTask.anchor.startBlockOrdinal);
    setLeaf("reading");
  }, [note?.noteId, note?.currentVersionId, annotationTask, readingBlocks]);
  const hiddenBlockCount = allBlocks.length - readingBlocks.length;




  // ── 教学面的依据（W4-6 刀二）──
  // 只认**屏幕上这一版**能对上的块：这一轮的快照与屏幕上读的那一版不同时，块序号
  // 已经不是同一份材料，照序号跳过去会点到别处——那种情况下不摆这几颗，话在
  // `ROUND_COPY.teaching.staleVersion`（如实说，而不是假装定位得到）。
  const teachingSnapshotIsReadVersion = Boolean(
    openRound && note && openRound.noteVersionId === note.currentVersionId,
  );
  const teachingReferences = useMemo(() => {
    if (!roundTeaching || !teachingSnapshotIsReadVersion) return [];
    return roundTeaching.sourceBlockOrdinals.flatMap((ordinal) => {
      const block = allBlocks.find((item) => item.ordinal === ordinal);
      return block ? [{ ordinal, label: teachingReferenceLabelV1(block) }] : [];
    });
  }, [roundTeaching, teachingSnapshotIsReadVersion, allBlocks]);
  /**
   * 动态产物那一发：教学面读到"这一条有动态版本"时，让 main 去确保它已落盘
   * （幂等——已经在盘上就不重复取）。**读不到文件不影响文字那半边**：失败只把
   * 宿主关掉并留一句如实话。
   *
   * 依赖里只放 `artifactId` 与当前轮：切篇/换条之后要重新试一次；同一份不重复发。
   */
  useEffect(() => {
    const artifactId = roundArtifact?.artifactId ?? null;
    if (!artifactId) {
      setArtifactState("idle");
      return;
    }
    const api = desktopApi();
    if (!api) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await api.artifact.ensure({ meta: createRequestMeta(epochRef.current), artifactId });
        if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
        unwrapGatewayResult(response);
        if (!cancelled) setArtifactState("ready");
      } catch {
        if (!cancelled) setArtifactState("failed");
      }
    })();
    return () => { cancelled = true; };
  }, [roundArtifact?.artifactId]);

  const readingBodyRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const body = readingBodyRef.current;
    if (!note || !body || leaf !== "reading" || learningView !== "body") {
      setAnnotationVerification(null);
      return;
    }
    const ids = new Set<string>();
    for (const annotation of currentAnnotationCandidates) {
      const { anchor } = annotation;
      if (anchor.noteVersionId !== note.currentVersionId || !noteAnchorMatchesV1(readSourceBlocks, anchor)) continue;
      const selected = readSourceBlocks.filter(block => block.ordinal >= anchor.startBlockOrdinal && block.ordinal <= anchor.endBlockOrdinal);
      if (selected.every(block => {
        const content = body.querySelector(`[data-block-ordinal="${block.ordinal}"] [data-note-block-content]`);
        return content && noteReadingText(content) === noteBlockRenderedTextV1(block.type, block.content);
      })) ids.add(annotation.annotationId);
    }
    setAnnotationVerification((current) => {
      if (current?.noteId === note.noteId && current.versionId === note.currentVersionId
        && current.ids.size === ids.size && [...ids].every((id) => current.ids.has(id))) return current;
      return { noteId: note.noteId, versionId: note.currentVersionId, ids };
    });
  }, [note?.noteId, note?.currentVersionId, currentAnnotationCandidates, leaf, learningView, readSourceBlocks, showAllBlocks]);
  useEffect(() => {
    if (unresolvedNoteAnnotations.length > 0) setAnnotationShelfOpen(true);
  }, [unresolvedNoteAnnotations.length, note?.noteId, note?.currentVersionId]);
  const { selectedPassage, setSelectedPassage, captureSelectedPassage } = useNotebookSelection({ note, blocks: readSourceBlocks, bodyRef: readingBodyRef, active: leaf === "reading" && learningView === "body" && mode === "preview" });

  const askCompanionAboutPassage = (text: string, anchor: NoteAnnotationAnchorV1 | null, noteId: string): void => {
    if (anchor) {
      if (annotationTaskStarting) return;
      const pending = pendingNoteExplanation({ noteId, anchor });
      if (pending) { setCompanionExplanationId(pending.id); return; }
      if (annotationTask && (annotationTask.status === "queued" || annotationTask.status === "running")
        && noteAnchorsOverlap(annotationTask.anchor, anchor)) { setAnnotationTaskOpen(true); return; }
    }
    // A conversational replacement owns the next explanation. Keep the old
    // task in its history, rather than displaying its failure beside this turn.
    setAnnotationTaskOpen(false);
    feedSelectionToCompanion({
      text,
      source: "selection",
      initialPrompt: "请用通俗易懂的话解释这段；如果举个具体例子会更清楚，也请举例。",
      ...(anchor && noteId
        ? { noteAnchor: { noteId, anchor } }
        : {}),
    });
  };
  const askCompanionAboutSelectedPassage = (): void => {
    if (!selectedPassage) return;
    askCompanionAboutPassage(selectedPassage.text, dirty ? null : selectedPassage.anchor, selectedPassage.noteId);
    setSelectedPassage(null);
    window.getSelection()?.removeAllRanges();
  };
  const explainSelectedPassage = (): void => {
    if (!selectedPassage) return;
    if (!selectedPassage.anchor) {
      setAnnotationTaskError("重新选中可核对的原文，才能把解读贴回这里。也可以直接发给伴星。");
      return;
    }
    const pending = pendingNoteExplanation({ noteId: selectedPassage.noteId, anchor: selectedPassage.anchor });
    if (pending) { setCompanionExplanationId(pending.id); setSelectedPassage(null); window.getSelection()?.removeAllRanges(); return; }
    if (annotationTask && (annotationTask.status === "queued" || annotationTask.status === "running")
      && noteAnchorsOverlap(annotationTask.anchor, selectedPassage.anchor)) {
      setAnnotationTaskOpen(true); setSelectedPassage(null); window.getSelection()?.removeAllRanges(); return;
    }
    void startNoteAnnotationTask(selectedPassage.anchor, dirty);
  };
  const retryNoteAnnotationTask = (): void => {
    if (annotationTask?.status === "failed") void startNoteAnnotationTask(annotationTask.anchor, dirty);
  };
  const openAiConsentSettings = (): void => {
    setSettingsAttention(SETTINGS_ATTENTION_AI_CONSENT);
    setSettingsSection("data");
    invoke("open-settings");
  };
  /**
   * 点一颗依据：滚到那一段并短暂高亮。`scrollIntoView` **不用 smooth**——动效是
   * 产品设置里的一档（那套在 D4 那一侧），这一处只负责"看得见"；高亮自己过期撤掉，
   * 不留"上次点过哪"这种会跟人走的读数。
   */
  const locateTeachingReference = (ordinal: number): void => {
    clearGoalResultSelection();
    setLeaf("reading");
    setLearningView("body");
    if (isNoteEditingMode(mode)) requestAnimationFrame(() => editorRef.current?.focusPosition({ block: ordinal, offset: 0 }));
    if (!readingBlocks.some((block) => block.ordinal === ordinal)) setShowAllBlocks(true);
    setFocusedBlockOrdinal(ordinal);
  };
  const openNoteAnnotation = (annotation: NoteAnnotationV1): void => {
    clearGoalResultSelection();
    annotationOrigin.current = "body";
    const located = currentNoteAnnotations.some(item => item.annotationId === annotation.annotationId);
    if (located && !readingBlocks.some((block) => block.ordinal === annotation.anchor.startBlockOrdinal)) setShowAllBlocks(true);
    setOpenAnnotationId((current) => current === annotation.annotationId ? null : annotation.annotationId);
    setHistoryOpen(false);
    setSourceBagOpen(false);
    setAnnotationTaskOpen(false);
    if (located) setFocusedBlockOrdinal(annotation.anchor.startBlockOrdinal);
    setLeaf("reading");
    setLearningView("body");
  };

  /**
   * 编辑态那两个记号（可编辑预览 / 纯编辑）传回来的只有一个 id——它们拿不到
   * `NoteAnnotationV1` 对象。找不到就什么都不做：宁可点一下没反应，也不要
   * 打开一张不存在的旁页。
   */
  const openNoteAnnotationById = (annotationId: string): void => {
    const found = currentNoteAnnotations.find((item) => item.annotationId === annotationId);
    if (found) openNoteAnnotation(found);
  };

  /**
   * 两个编辑态的批注落位。
   *
   * 收 `currentNoteAnnotations`（**已按当前版本验过锚点**的那一批），不收全量
   * `noteAnnotations`——后者含 versionState: "older"，那些属于旧版记录，画在
   * 当前正文上就是 41 §2.3 禁止的「按相似文本猜一个新位置」。
   *
   * 落位本身在 `note-annotation-placement.ts`，那里还会**再核一次**：调用方那次
   * 筛选只代表它筛选那一刻，而正文在编辑中会继续变。
   */
  const editAnnotationPlacements = useMemo(
    () => annotationPlacements(currentNoteAnnotations, readingBlocks),
    [currentNoteAnnotations, readingBlocks],
  );
  useEffect(() => {
    if (focusedBlockOrdinal === null) return;
    const target = readingBodyRef.current?.querySelector(`[data-block-ordinal="${focusedBlockOrdinal}"]`);
    // jsdom 没有布局也就没有 `scrollIntoView`；真窗口那一半由剧本量（那段真的动了）。
    if (target && typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "center" });
    const timer = setTimeout(() => setFocusedBlockOrdinal(null), 2_400);
    return () => clearTimeout(timer);
  }, [focusedBlockOrdinal]);

  /**
   * 从正文切到学习页时，把**读到的位置**记下来（39f §3「从笔记进入」那一格）。
   *
   * 正文与学习是同一本册子的两张书签（`leaf` 互斥），所以切过去之后原来读到哪儿在屏上
   * **没有任何痕迹**——用户想核一句就得自己往上翻。这里的做法是记下滚动位置，并在
   * 学习页摆一枚「回到刚才读的那一段」的书签：它是一个**明确说清去哪儿**的动作，与页首
   * 那颗「回到正文」不是同一件事（后者只是换书签，不挪位置）。
   *
   * 位置**不落库、不跟人走**：它只活在这一次打开的这一篇笔记里，关掉就没了。
   */
  const backToReading = (): void => setLeaf("reading");

  // 这篇笔记的全部图片，按正文顺序排好；顺带记下**每一块**第一张图在画廊里的序号，
  // 让正文里的缩略图点击时知道自己该开在哪一张。一块可以有好几张：编辑器里的图是
  // **行内节点**（`paragraph > image`），一整段里并排两张是常态。
  // 笔记块里存的是站内地址：画廊切到哪张才取哪张的字节，站外直链则原样交给 `<img>`。
  const noteImages = useMemo(() => {
    const images: GalleryImage[] = [];
    const ordinalToStart = new Map<number, number>();
    for (const block of allBlocks) {
      const found = block.type === "image"
        ? (() => {
          const image = parseImageBlock(block.content);
          return image ? [{ src: image.url, alt: image.alt }] : [];
        })()
        : noteInlineImages(block.content);
      if (found.length === 0) continue;
      ordinalToStart.set(block.ordinal, images.length);
      for (const item of found) {
        images.push(sourceImageObjectKeyFromUrl(item.src)
          ? { kind: "internal", url: item.src, alt: item.alt || "笔记图片" }
          : { kind: "resolved", src: item.src, alt: item.alt || "笔记图片" });
      }
    }
    return { images, ordinalToStart };
  }, [allBlocks]);
  // 画廊的开关状态收在通用钩子里（本页只负责 openAt/close 的接线）。
  const noteGallery = useImageLightbox(noteImages.images.length);

  // The server record is the source of truth, but local keystrokes win while a
  // save is still in flight: the draft is only replaced when nothing is pending.
  useEffect(() => {
    if (!note) return;
    const firstLoadForNote = syncedNoteRef.current !== note.noteId;
    if (firstLoadForNote) {
      syncedNoteRef.current = note.noteId;
      // Reading is the page a note opens on; only an explicit "继续写" — or a
      // home entry that asks for it — lands in the editor.
      setReceipt(null);
      setSaveState("idle");
      setHistoryOpen(false);
      setVersions(null);
      setVersionsFailure(null);
      setShowAllBlocks(false);
      noteGallery.close();
    }
    // 这里过去有一整套"作者这台机器没有待提交的字，就把最新一份接进草稿，必要时整体
    // 替换编辑器"的逻辑，还有一个只在阅读态成立的 `pendingLocalEdit` 判据。它存在的
    // 唯一理由是界面持有一份文本拷贝——不接帧会看到过期正文，接了又会抹掉作者正在写的
    // 字与撤销栈，所以只能按模式二选一（那是批次 C 之前那条"编辑态不接远端帧"的分支）。
    // 现在编辑器写的就是那份共享文档，别人写的字由 yjs 合进来、编辑器自己重画：
    // 两个毛病一起消失，这个分支也就没有存在的理由了。
  }, [note, editable, activeNoteRef?.mode, applyDraft]);


  // 这两个引用按 noteId / doc 建（`useCallback`），每个 noteId 内不变。把它们单独取出来
  // 再进 `save` 的依赖，是为了不让 `save` 每次渲染都换身份——那会把自动保存的 debounce
  // 一帧一帧地重置掉，永远等不到触发。
  const { setLocalTitle, flush, setLocalBlock } = noteDocLive;

  // 光标换块：本机改这一格，对端那一格交给 awareness（同一次调用里两份一起动，
  // 否则"我看到的"与"别人看到的我"会分开）。
  const onCaretBlock = useCallback((block: number | null) => {
    setCaretBlock(block);
    setLocalBlock(block);
  }, [setLocalBlock]);

  /**
   * 返回值 = "这一份草稿现在**确实**已经交出去了"（没改动也算：那它本来就是最新一版）。
   * 需求方只有一个：笔记页那颗「先保存再开始」（39d W4-4）——保存失败时它绝不许开始，
   * 否则就应了 PRD §3.4 那句"不创建看似已开始的空轮次"。调用点若不关心，忽略即可。
   */
  const save = useCallback(async (reason: "auto" | "manual"): Promise<boolean> => {
    const api = desktopApi();
    const current = data?.note ?? null;
    if (!api || !current || !current.permissions.canSave || saving) return false;
    // Autosave flushes the live document; only the server checkpoint can say
    // whether it already has a saved version. Explicit saves always reach it.
    if (!dirty && reason === "auto") return true;
    const nextTitle = titleValue;
    setSaving(true);
    setSaveState("saving");
    setSaveFailure(null);
    try {
      // 正文与标题都交给文档增量（批次 4.4）。原来一次保存同时提交**整篇正文**和一个
      // 版本指针：两扇窗口都还在编辑时，后提交的那一次把前一次的正文原地改掉，而且
      // 没有版本可回去。现在交的是"我改了哪些块"，合并由 CRDT 负责——内容这条路上
      // 不再存在"覆盖"这个动作。（谁先按「保存」仍然会先推进版本指针，后一次
      // 确认拿旧令牌会被 409 挡下来，那是版本历史的顺序问题，与正文覆盖是两回事。）
      // 标题先写进文档的 `meta`，然后正文与它一起作为**一条 yjs 增量**交出去。
      // 原来这里是两个通道（blocks + title），于是"改了标题没改正文"和"正文删空了"
      // 必须靠 `blocks` 缺省与否来区分——那种表达一旦写反就是清空整篇。
      setLocalTitle(nextTitle, "manual");
      const flushed = await flush();
      // flush 给了 null 就是"本机没有攒下任何增量"：那一次什么都没写，报成提交过就是在骗回执。
      const written = { via: flushed ?? "unchanged" as const, savedAt: new Date().toISOString() };
      if (reason === "manual" && written.via === "queued") {
        setReceipt({ ...written, isAutosave: true });
        setSaveState("error");
        setSaveFailure("改动还在本机队列里，联网后才能保存版本。");
        return false;
      }
      if (reason === "manual") {
        // 「保存」多走一步：把文档此刻定成一个可回去的版本。它不再带正文。
        const response = await api.note.save({
          meta: createRequestMeta(epochRef.current),
          commandId: createCommandId("note-save"),
          noteId: current.noteId,
          request: {
            version: 1,
            baseVersionId: current.currentVersionId,
          },
        });
        if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
        const committed = unwrapGatewayResult(response);
        setReceipt({ savedAt: committed.savedAt, isAutosave: false, via: "uploaded" });
      } else {
        setReceipt({ savedAt: written.savedAt, isAutosave: true, via: written.via });
      }
      setSaveState("committed");
      // 交出去的就是这一份了：本机的标题覆盖值到此作废，之后屏幕上的标题又跟着文档走
      // （别人改名会上屏）。没交出去（`unchanged`/失败）时留着，否则那一次改名就凭空没了。
      if (written.via !== "unchanged" && draftRef.current.title === nextTitle) applyDraft({ ...draftRef.current, title: null });
      // 必须是要 silent 的那次回读：非 silent 会把这一屏换成「正在读取真实笔记」，
      // 编辑器整个卸掉——自动保存每按几下就来一次，那等于每次保存都把选区、滚动位置和
      // 还没交出去的字一起带走。版本号、权限那半边照样刷新。
      await reload({ silent: true });
      if (reason === "manual") appendedReflections.current.clear();
      return true;
    } catch (error) {
      setSaveState("error");
      setSaveFailure(gatewayErrorMessage(error));
      return false;
    } finally {
      setSaving(false);
    }
  }, [applyDraft, data, dirty, flush, reload, saving, setLocalTitle, titleValue]);

  // Debounced autosave: the save-line reports the server receipt, never a local guess.
  // A failed save is sticky: the effect must not re-arm, or every AUTOSAVE_DELAY_MS
  // would flip the save-line between "正在保存…" and the failure notice — the
  // flicker. Recovery paths: the "重试保存" button, or a new keystroke (the
  // effect below clears the error so the debounce restarts naturally).
  // Debounced autosave. 依赖里**不能有 `save` 或 `note` 对象**：这一屏每几秒就有一次
  // 静默回读带来一个新的 `data`，`save` 因此换身份，定时器被"清理—重挂"反复归零——
  // 实窗量到的正是这个：文档明明脏着（标签「草稿」），自动保存却永远不触发，
  // 本机那几句话从来没有交出去过。走 `saveRef`（每个渲染都刷新）就不需要那些身份。

  // Editing again after a failed save clears the sticky error so autosave can
  // resume. Keyed on the draft object, which only changes on real input — the
  // failed save itself leaves the draft untouched and the error stays put.

  // Leaving the page while the debounce is still pending must not drop keystrokes.
  // The ref is refreshed in an effect (not during render) so the unmount save
  // always closes over the latest draft without a render-phase side effect.
  useEffect(() => {
    saveRef.current = () => { void save("auto"); };
  });
  useEffect(() => () => saveRef.current(), []);

  /** 保存那一簇的**状态与两条自动保存 effect**已于 2026-09-29 收进
      `use-notebook-save-state.ts`；`save` 那个 callback 留在页面（它要读文档增量与本地标题）。
      三条不许动写在那个文件头——尤其「自动保存那个 effect 的依赖里不能有 save / note」。 */
  const {
    saveState, setSaveState, saveFailure, setSaveFailure,
  } = useNotebookSaveState({
    canSave, dirty, saving, draft, saveRef,
    delayMs: AUTOSAVE_DELAY_MS,
  });


  /**
   * 粘贴/拖进来、或经工具栏选中的图片。只在可写时开放：只读身份连正文都改不了，
   * 更不该往对象存储里写东西。
   */
  const imageUploads = useNoteImageUploads({
    noteId: note?.noteId ?? null,
    editorRef,
    onContentChange: applyContent,
    getContent: () => draftRef.current.content,
    disabled: !editable || !note?.permissions.canSave,
  });

  /**
   * 纸面上松手的图片归这一篇正文。
   *
   * 正文那一块由编辑器自己的插件接住（`note-markdown-editor` 的 NOTE_IMAGE_UPLOAD），
   * 但纸面比正文大：工具条、页边、最后一行下面那一截都落不到 `.ProseMirror` 上，
   * 过去那几处会被全局采集器抢走，回一句"暂不解析这张图"。混进非图片文件就不算
   * "往正文里放图"，仍然交回采集器逐份说清去向。
   */
  const paperAcceptsImages = leaf === "reading" && isNoteEditingMode(mode) && editable;
  const paperImageFiles = (event: React.DragEvent<HTMLElement>): File[] => {
    if (!paperAcceptsImages) return [];
    // 正文里那一下编辑器已经接过了，这里只补它够不着的那一圈。
    if (event.target instanceof HTMLElement && event.target.closest(".ProseMirror")) return [];
    return imageOnlyFiles(event.dataTransfer);
  };

  /** 改归属：走 IPC 那一条，服务端那一处判作者。 */
  const setShareScope = async (shareScope: NoteShareScopeV1) => {
    const api = desktopApi();
    const current = data?.note ?? null;
    if (!api || !current) return;
    setSharing(true);
    try {
      unwrapGatewayResult(await api.note.setShareScope({
        meta: createRequestMeta(epochRef.current),
        commandId: createCommandId("note-share"),
        noteId: current.noteId,
        shareScope,
      }));
      await reload();
    } catch (error) {
      setSaveFailure(gatewayErrorMessage(error));
    } finally {
      setSharing(false);
    }
  };

  const api = desktopApi();
  const routes = api?.contract.enabledRoutes ?? [];
  const generationRoutes = routes.includes("note.detail") && routes.includes("note.cardGeneration");
  const generationEnabled = Boolean(
    capabilities
    && generationRoutes
    && capabilities.actionCapabilities["card_generation.start"] === "allowed"
    && capabilities.featureAvailability.card_generation_v2.state === "enabled",
  );
  const generationReason = generationEnabled
    ? null
    : !capabilities
      ? "正在确认 Card Generation 能力。"
      : !generationRoutes
        ? "这台电脑还没有开放生成学习卡的入口。"
        : capabilities.featureAvailability.card_generation_v2.state !== "enabled"
          ? "学习卡生成现在没有开放。"
          // 能力位被拒和开关没开是两件事：把前者说成后者，读者会以为去找管理员
          // 开功能，而真实原因是在这个空间里自己是只读身份。
          : "生成学习卡由空间所有者发起，你在这个空间是成员。";

  const startGeneration = async () => {
    if (!api || !note || generationNeedsSavedVersion || saving || startingGeneration || !generationEnabled) return;
    setStartingGeneration(true);
    setGenerationFailure(null);
    try {
      const previous = noteGeneration ?? latestRun;
      if (previous && isCardGenerationInFlight(previous.status)) {
        setGenerationFailure("上一份还在生成，请先查看进度并停止，再按最新笔记生成。");
        return;
      }
      if (previous && isCardGenerationReviewOpen(previous.status)) {
        const ended = await api.note.cardGeneration.close({
          meta: createRequestMeta(epochRef.current), commandId: createCommandId("card-generation-replace-review"),
          runId: previous.runId, expectedReviewDraftRevision: previous.reviewDraftRevision,
        });
        unwrapGatewayResult(ended);
        if (ended.workspaceEpoch) epochRef.current = ended.workspaceEpoch;
        // If creating the next run fails, return to an entry that can retry.
        reload();
      }
      const response = await api.note.cardGeneration.start({
        meta: createRequestMeta(epochRef.current),
        commandId: createCommandId("card-generation-start"),
        noteId: note.noteId,
        request: {
          version: 2,
          noteVersionId: note.currentVersionId,
          sourceScope: { kind: "whole_note" },
          learningGoal: options.learningGoal,
          detailThreshold: options.detailThreshold,
          quantity: { kind: "adaptive", hardMaxCards: options.hardMaxCards },
          preferredStrategies: [...options.preferredStrategies],
          ...(feedbackTarget && feedbackReasons.length
            ? {
                feedbackContext: {
                  previousRunId: feedbackTarget.runId,
                  reasonCodes: [...feedbackReasons],
                  ...(feedbackNote.trim() ? { optionalNote: feedbackNote.trim() } : {}),
                },
              }
            : {}),
          clientRequestId: createCommandId("card-generation-request"),
        },
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      const accepted = unwrapGatewayResult(response);
      if (accepted.agentRunId) publishCompanionRecordsChanged();
      setActiveCardGenerationRunId(accepted.runId);
      resetGenerationFeedback();
      setOptionsOpen(false);
      invoke("open-card-generation");
    } catch (error) {
      setGenerationFailure(gatewayErrorMessage(error));
      // 被服务端拒绝说明页面看到的是过期状态（这篇笔记已有一批在制，或配额已满）。
      // 不重读的话入口会一直停在「生成学习卡」，用户点一次撞一次 409。
      reload();
    } finally {
      setStartingGeneration(false);
    }
  };


  /**
   * 入口按下去的那一下（2026-10-04 用户决定）。
   *
   * 干净的工作稿过去是**直接开跑**的，方案屏收在旁边的「调整这次」里。那样多数人
   * 按这一下只要的是默认档，却根本不知道自己挑走了什么——直到卡片出来了才发现方向
   * 不对，而那一批已经跑完。现在这一格只有一颗按钮，按它就开「这次想怎么练？」：
   * 方向、数量、详略、卡型都在那儿，用户先说清要什么，再开始生成。
   *
   * 未保存的改动也不用再单独分一条路：挡住它的那句话（「笔记改动还没保存，保存后
   * 就可以开始。」）本来就写在方案屏的底栏上，进得去就看得见。
   */
  const openGenerationSetup = () => { setOptionsOpen(true); };

  /**
   * 提交这一轮的问题：没有进行中轮次时开一轮，已经有了就是改写那一句。
   *
   * 两条路共用一次提交，因为屏上只有一句话与一颗按钮——差别只在带不带
   * `expectedRevision`（§16.39 那一族：后到的那一份要失败并拿到现在那一版，
   * 而不是悄悄覆盖）。成功后走 silent 回读：句子上屏的是**服务端存下来的那一条**，
   * 不是本机草稿（这里写过的失败形状：屏幕显示了自己拼的那句，库里却是另一句）。
   */
  const submitRoundQuestion = async (target: "start" | "revise", snapshot: "current" | "last_saved" = "current") => {
    const api = desktopApi();
    const currentNote = data?.note ?? null;
    const question = roundDraft.trim();
    if (!api || !currentNote || (target === "revise" && question.length === 0) || roundBusy) return;
    setRoundBusy(target);
    setRoundFailure(null);
    try {
      if (target === "start" && snapshot === "current" && currentNote.permissions.canSave) {
        if (!await save("manual")) {
          setRoundFailure({ kind: "failed", message: "这次保存没有完成，还没有开始新的一轮。当前内容保留，可以重试保存。" });
          return;
        }
      }
      const meta = createRequestMeta(epochRef.current);
      const source = roundQuestionSourceV1(question, roundStarter);
      const response = target === "start"
        ? await api.noteLearningRound.create({ meta, noteId: currentNote.noteId,
          ...(question ? { drivingQuestion: question } : {}), drivingQuestionSource: source })
        : await api.noteLearningRound.revise({
          meta,
          roundId: openRound!.roundId,
          expectedRevision: openRound!.revision,
          drivingQuestion: question,
          drivingQuestionSource: source,
        });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      unwrapGatewayResult(response);
      setRoundEditing(false);
      setRoundDraft("");
      setRoundStarter(null);
      setRoundLostDraft(null);
      await reload({ silent: true });
    } catch (error) {
      setRoundFailure(classifyGatewayError(error));
      // 只有服务端**明确拒掉**（conflict：这一轮在别处被推进过／已经收尾／已经有开着的一轮）
      // 才敢说那一句没进去。网络与超时不能这样报——那一发的结果本机不知道，
      // 把"可能已经写成功"说成"替你留着"，是拿一次假回执盖掉真回执。
      if (error instanceof RendererGatewayError && error.code === "conflict") {
        setRoundLostDraft({ question, starter: roundStarter });
        setRoundDraft("");
        setRoundStarter(null);
        setRoundEditing(false);
      }
      // 失败也要把她带到**现在那一版**上去：真窗口实测（`probe-note-round-conflict.mts`），
      // 迟到的那一发被服务端拒掉之后，屏上留着的还是那句已经不作数的草稿——
      // "请先同步"这句话没有配一次同步，等于让她自己猜该按哪一版继续。
      // 交出去的那一句不撤：conflict 时它搬去下面那一行，其余失败**留在输入框里**
      // （不退出编辑态）——那一发可能已经写成功，说"替你留着"是拿一次假回执盖掉真
      // 回执，但直接退编辑态又会让下一次「换一个问题」把它覆盖掉，两种都不能做。
      await reload({ silent: true });
    } finally {
      setRoundBusy(null);
    }
  };

  /** 活动的完成与能力结论分开：练习已结算才开放「完成本轮」。 */
  const endNoteRound = async (outcome: "completed" | "partial" = "partial") => {
    const api = desktopApi();
    if (!api || !openRound || roundBusy) return;
    setRoundBusy("end");
    setRoundFailure(null);
    try {
      const response = await api.noteLearningRound.close({
        meta: createRequestMeta(epochRef.current),
        roundId: openRound.roundId,
        expectedRevision: openRound.revision,
        outcome,
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      unwrapGatewayResult(response);
      await reload({ silent: true });
      setReflectionRoundId(openRound.roundId);
      setLeaf("reading");
    } catch (error) {
      setRoundFailure(classifyGatewayError(error));
      // 收尾迟到（这一轮在别处被推进过）同一条规矩：换回服务端读回来的那一版，
      // 那一行不撤——撤掉会被读成"已经收尾了"，而它其实什么都没发生。
      await reload({ silent: true });
    } finally {
      setRoundBusy(null);
    }
  };

  /**
   * 「继续这一轮」= resume：把停住的那一轮接回进行中（39d W4-5 ④ 的前置）。
   *
   * 与另外三发同一形状：①带读过的那一版 `expectedRevision`（这一轮在别处被推进过时，
   * 这一发要失败并拿到现在那一版）；②成功后走 **silent 回读**——屏上那一整块换的是
   * 服务端读回来的那一份，不是这一发的回执自己拼的（刀二那条纪律）；③失败也回读一次，
   * 留一句如实的话。已经 active 的轮次重复点不出第二个状态：noop 由服务端判（不推进计数器）。
   */
  const resumeNoteRound = async () => {
    const api = desktopApi();
    if (!api || !openRound || roundBusy) return;
    setRoundBusy("resume");
    setRoundFailure(null);
    try {
      const response = await api.noteLearningRound.resume({
        meta: createRequestMeta(epochRef.current),
        roundId: openRound.roundId,
        expectedRevision: openRound.revision,
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      unwrapGatewayResult(response);
      await reload({ silent: true });
    } catch (error) {
      setRoundFailure(classifyGatewayError(error));
      await reload({ silent: true });
    } finally {
      setRoundBusy(null);
    }
  };

    /**
   * 「按当前内容新开一轮」（PRD §4.3 后半件，紧接上面那句「后来又保存过一版」）。
   *
   * 封存手上这一条与新建那一条在**服务端同一发事务**里做完：分两发调用会留下
   * "旧的已封存、新的没建成"那个窗口，用户看到的是这一轮凭空没了。
   * 与「继续这一轮」同一形状：带 CAS 钥匙、成功后 silent 回读、失败也回读一次。
   * 只有上一行真的报了"动过"才摆这一颗——没问题时报这句话，就是无端的第二次确认。
   */
  const reopenNoteRound = async () => {
    const api = desktopApi();
    if (!api || !openRound || roundBusy) return;
    setRoundBusy("reopen");
    setRoundFailure(null);
    try {
      const response = await api.noteLearningRound.reopen({
        meta: createRequestMeta(epochRef.current),
        roundId: openRound.roundId,
        expectedRevision: openRound.revision,
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      unwrapGatewayResult(response);
      await reload({ silent: true });
    } catch (error) {
      setRoundFailure(classifyGatewayError(error));
      await reload({ silent: true });
    } finally {
      setRoundBusy(null);
    }
  };


  /** Prepare a bounded first attempt from this saved snapshot without revealing the explanation. */
  const prepareRoundPractice = async () => {
    const api = desktopApi();
    if (!api || !openRound || practiceBusy) return;
    beginPractice();
    try {
      const response = await api.noteLearningRound.preparePractice({
        meta: createRequestMeta(epochRef.current),
        roundId: openRound.roundId,
        expectedRevision: openRound.revision,
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      unwrapGatewayResult(response);
      await reload({ silent: true });
    } catch (error) {
      setPracticeFailure(classifyGatewayError(error));
      await reload({ silent: true });
    } finally {
      endPractice();
    }
  };

  /**
   * 「练一道」（W4-6 刀三）：用**服务端签发的那份起点**开一场 run。
   *
   * 刻意不自己拼请求：`start` 里那几格（goal／时长／怎么答／锚点）都来自服务端
   * ——拼一份就等于在这一页埋下第二个来源（W4-2 第五刀收的就是这一族）。
   *
   * 开出去之后**留在这一页**（`openRunSurface` 不再 `invoke("validate")` 跳去作答页）：
   * `activeRunId` 一落位，`inlineRoundRunId` 就成立，工位挂在 `practice` 那一屏里。
   * 跳页的那一版把"这道题属于哪一轮"留给了用户自己记——现在问题、依据、上一轮做到
   * 哪一步与正在作答的格子在同一张纸上，中间不留断点。
   */
  const startRoundPractice = async () => {
    const practiceStartValue = roundPracticeStart;
    if (!practiceStartValue || practiceBusy) return;
    beginPractice();
    try {
      setActiveObjectiveId(practiceStartValue.objectiveId);
      await startObjectiveJourney(
        {
          kind: "create_run",
          objectiveId: practiceStartValue.objectiveId,
          label: ROUND_COPY.teaching.practice,
          start: practiceStartValue.start,
        },
        {
          epochRef,
          setActiveObjectiveId,
          setActiveRunId,
          // 就地：这一页自己会把工位挂出来。
          openRunSurface: () => { setInlineRunPage("assessment"); },
          reload: () => reload({ silent: true }),
        },
      );
    } catch (error) {
      setPracticeFailure(classifyGatewayError(error));
    } finally {
      endPractice();
    }
  };

  /**
   * 就地作答的工位：**这一轮**正在答的那一次 run。
   *
   * 判据是「服务端说的正在答的那一次」而不是「全局的 `activeRunId`」：从复习队列或
   * 学习卡开来的另一次作答也占着 `activeRunId`，拿它当这一轮的会答错题。所以两份都要
   * 吻合——场景是 `practice`，且 `nextStep.kind === "resume"` 且 `basisRunId` 就是它。
   * `uncertain` 的 `basisRunId` 指向的是**已经结算**的那一次（要看的是它的反馈，不是
   * 重新答一遍），所以那一格走 `openRoundPractice` 的结果页，不接工位。
   */
  const inlineRoundRunId: string | null =
    learningScene === "practice"
      && !reviewingTeaching
      && roundNextStep?.kind === "resume"
      && roundNextStep.basisRunId === activeRunId
      ? roundNextStep.basisRunId
      : null;

  /**
   * 回看这一轮里某一次作答：同样**就地**，不换页面语言。
   *
   * 挂的是同一个工位（它自己会显示这一次的结果页），所以题目与反馈用的是同一套控件与
   * 同一份读数；离开时仍然经主进程释放 `FormalAssessmentGuard`（见
   * `releaseRunThroughMainV1` 那段注释：绕过它的症状出现在**别处**，极难往回找）。
   */
  const openRoundPractice = async (runId: string) => {
    setActiveObjectiveId(null);
    setActiveRunId(runId);
    setInlineRunPage("result");
    await reload({ silent: true });
  };

  /**
   * 离开就地作答的工位。
   *
   * 三步，顺序不能换：①摘掉 run 树；②让出一帧；③经主进程解析并提交返回路由。②③之间
   * 必须是"主进程已经看不到 Player 了"才放行，所以这一段与 `LearningRunSurface` 里的
   * 收尾共用 `releaseRunThroughMainV1`。落地后回读一次这一轮，于是纸上从 `practice`
   * 变成 `result`——用户看见的是结算，而不是"被踢回上一个页面"。
   */
  const exitInlineRoundRun = async (request?: { route: DesktopRouteV1; objectiveId?: string; reflectionRoundId?: string }) => {
    const runId = inlineRoundRunId;
    if (!runId || !note) return;
    setActiveRunId(null);
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    await releaseRunThroughMainV1({
      runId,
      route: request?.route ?? { kind: "note.detail", noteId: note.noteId },
    });
    setInlineRunPage("assessment");
    await reload({ silent: true });
  };

  const historyTail = olderRounds && olderRounds.noteId === note?.noteId ? olderRounds : null;
  const historyItems: readonly NoteLearningRoundHistoryV1["items"][number][] = [
    ...(roundHistory?.items ?? []),
    ...(historyTail?.items ?? []),
  ];
  const selectedHistoryItem = historyItems.find((item) => item.roundId === reflectionRoundId);
  const selectedHistoryMasked = Boolean(selectedHistoryItem && "contentMasked" in selectedHistoryItem && selectedHistoryItem.contentMasked);
  /**
   * 那句总数只读**服务端报的那一格**：`historyItems.length` 回答的是"这一屏列了几轮"，
   * 不是"这一篇开过几轮"——翻过一页之后两者会分叉（§16.16 后半要的是后者）。
  */

  /** 「回看某一轮」那一簇（3 个 state + 一个 effect）已于 2026-09-29 收进
      `use-notebook-inspected-round.ts`。那个 `cancelled` 防竞态闭包的说明在那个文件里。 */
  const { inspectedRound, inspectedRoundBusy, inspectedRoundFailure } = useNotebookInspectedRound({
    leaf,
    roundId: reflectionRoundId,
    noteId: note?.noteId,
    masked: selectedHistoryMasked,
    inspectRevision: historyInspectRevision,
    epochRef,
    api: desktopApi(),
  });

  const historyTotal = historyTail?.totalCount ?? roundHistory?.totalCount ?? 0;
  const historyHasMore = historyTail ? historyTail.hasMore : (roundHistory?.hasMore ?? false);
  const historyNextCursor = historyTail ? historyTail.nextCursor : (roundHistory?.nextCursor ?? null);



  const footprintHasRecords = noteOverviews.length > 0
    || noteRecallRecords.length > 0
    || noteExpansions.length > 0
    || noteAnnotations.length > 0
    || noteLearningArtifacts.length > 0;
  const footprintRowsLoaded = Boolean(note
    && overviewRows?.noteId === note.noteId
    && recallRows?.noteId === note.noteId
    && expansionRows?.noteId === note.noteId
    && annotationRows?.noteId === note.noteId
    && learningArtifactRows?.noteId === note.noteId);
  const footprintPending = Boolean(note && (
    (overviewRows?.noteId !== note.noteId && !overviewError)
    || (recallRows?.noteId !== note.noteId && !recallError)
    || (expansionRows?.noteId !== note.noteId && !expansionError)
    || (annotationRows?.noteId !== note.noteId && !annotationError)
    || (learningArtifactRows?.noteId !== note.noteId && !learningArtifactError)
  ));

  const inspectRoundInFootprint = (roundId: string) => {
    setLegacyHistoryOpen(true);
    loadLegacyRouteCoverage();
    setReflectionRoundId(roundId);
    setLeaf("history");
    requestAnimationFrame(() => requestAnimationFrame(() => historyDetailRef.current?.scrollIntoView?.({ block: "start" })));
  };
  const openFootprintRecall = (record: NoteRecallRecordV1) => {
    clearGoalResultSelection();
    rememberReadingPosition();
    closeSidePage();
    openRecall(record, "history");
    setLeaf("reading");
    setLearningView("recall");
  };
  const openFootprintAnnotation = (annotation: NoteAnnotationV1) => {
    rememberReadingPosition();
    openNoteAnnotation(annotation);
    annotationOrigin.current = "history";
    setOpenAnnotationId(annotation.annotationId);
  };
  const openFootprintArtifact = (artifact: NoteLearningArtifactV1) => {
    // A selected receipt may lie beyond the gallery's first page. Keep it
    // available when the reader explicitly switches to normal note controls.
    setLearningArtifactRows(current => ({
      noteId: artifact.noteId, nextCursor: current?.noteId === artifact.noteId ? current.nextCursor : null,
      items: [artifact, ...(current?.noteId === artifact.noteId ? current.items.filter(item => item.artifactId !== artifact.artifactId) : [])],
    }));
    clearGoalResultSelection();
    rememberReadingPosition();
    closeSidePage();
    setActiveLearningArtifactId(artifact.artifactId);
    setLeaf("reading");
    setLearningView("artifact");
  };
  const loadOlderFootprint = (kind: FootprintKind) => {
    if (kind === "overview" && overviewRows?.nextCursor) void loadNoteOverviews(overviewRows.nextCursor);
    if (kind === "recall" && recallRows?.nextCursor) void loadNoteRecallRecords(recallRows.nextCursor);
    if (kind === "annotation" && annotationRows?.nextCursor) void loadNoteAnnotations(annotationRows.nextCursor);
    if (kind === "artifact" && learningArtifactRows?.nextCursor) void loadNoteLearningArtifacts(learningArtifactRows.nextCursor);
    if (kind === "expansion" && expansionRows?.nextCursor) void loadNoteExpansions(expansionRows.nextCursor);
  };

  /** 「看更早的几轮」：带着游标再读一页，接在已经看到的那些后面（不覆盖）。 */

  // Live status sync while this page stays open: one cardGeneration
  // subscription per known run. Each event triggers a silent re-read of the
  // projection — the entry button and status line follow the run's real step
  // without a loading paper over the writer's text, and without offering a
  // second start for the same note version.
  const noteGenerationRunId = noteGeneration?.runId ?? null;

  useEffect(() => {
    if (!noteGenerationRunId || !window.ailearn) return undefined;
    let disposed = false;
    let subscriptionId: string | null = null;
    let unsubscribeEvent: (() => void) | undefined;
    const subscribe = async () => {
      try {
        const response = await window.ailearn.subscriptions.subscribe({
          meta: createRequestMeta(),
          topic: { kind: "cardGeneration", runId: noteGenerationRunId },
        });
        if (disposed) return;
        subscriptionId = unwrapGatewayResult(response).subscriptionId;
        unsubscribeEvent = window.ailearn.subscriptions.onEvent(subscriptionId, () => {
          void reload({ silent: true });
        });
      } catch {
        // Streaming is progressive enhancement: the status still refreshes on
        // remount, on focus of another page, and through the workbench itself.
      }
    };
    void subscribe();
    return () => {
      disposed = true;
      unsubscribeEvent?.();
      if (subscriptionId) {
        void window.ailearn.subscriptions.unsubscribe({
          meta: createRequestMeta(),
          subscriptionId,
        });
      }
    };
  }, [noteGenerationRunId, reload]);

  /**
   * 后台还在做这一批时的兜底轮询。
   *
   * 事件流推的是"有事件才来"，这一格要的是"那一行状态自己往前走"——而流是会被顶回的
   * （服务端每用户 SSE 上限 5，主进程那一侧曾经漏过连接；占满之后每一次订阅都 429，
   * 入口就会一直停在旧阶段：明明已经写好了还读作「查看生成进度」，或者反过来）。
   *
   * **只在真在跑的时候跑**，而且比工作台慢一倍：这一页的 `reload` 是整份投影（笔记、
   * 能力、资料袋、最新一批），不是工作台那种只读一条 run 的轻量重读；而这一格慢半拍
   * 没有人会察觉——用户盯着的是刚点下去那一页。
   */
  const noteGenerationInFlight = Boolean(noteGeneration && isCardGenerationInFlight(noteGeneration.status));
  useEffect(() => {
    if (!noteGenerationRunId || !noteGenerationInFlight) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void reload({ silent: true });
    }, 4000);
    const onVisibility = (): void => { if (document.visibilityState === "visible") void reload({ silent: true }); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [noteGenerationRunId, noteGenerationInFlight, reload]);

  const openGeneration = () => {
    const run = noteGeneration ?? latestRun;
    if (!run) return;
    rememberReadingPosition();
    setActiveCardGenerationRunId(run.runId);
    invoke("open-card-generation");
  };

  /**
   * 编辑器里的键盘约定。加粗、斜体、行内代码、撤销、重做都归 Milkdown 自己的
   * 快捷键；这一层只管纸张语境里的两条：⌘S 立即提交、⌘K 插入链接。
   */
  const onEditorKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (!(event.metaKey || event.ctrlKey)) return;
    const key = event.key.toLowerCase();
    if (key === "s") {
      event.preventDefault();
      void save("manual");
    } else if (key === "k") {
      event.preventDefault();
      linkEditor.open();
    }
  };



  const openSource = () => {
    if (!note?.sourceId) return;
    rememberReadingPosition();
    const returnRef = { noteId: note.noteId, noteVersionId: activeNoteRef?.noteVersionId ?? null, mode };
    useRoomStore.getState().setActiveSourceId(note.sourceId);
    invoke("open-source", { returnTo: { label: "返回笔记", run: () => { setActiveNoteRef(returnRef); invoke("open-notebook"); } } });
  };

  // 模式跟随 activeNoteRef 走：从工作台"返回笔记"时，用户回到的是离开时的
  // 编辑/阅读模式，而不是每次都被重置成阅读页。
  const switchMode = (next: NoteBodyMode) => {
    clearGoalResultSelection();
    setLeaf("reading");
    setLearningView("body");
    setOverviewOpen(false);
    setShowAllBlocks(true);
    changeMode(next);
  };

  const page: HudPageId = leaf === "learning" || leaf === "expansion" ? "note-learning" : leaf === "history" ? "note-history" : isNoteEditingMode(mode) ? "note-edit" : "note-read";
  useHudPage(page);

  const sourceTitle = source?.source.title ?? (note?.sourceId ? "来源暂时不可读" : "没有关联来源");
  const firstSegment = segments[0] ?? null;
  /**
   * 那块资料卡片的名字：**屏上与给她的视图共用这一份**（两边各写一句迟早分叉，而分叉不报错）。
   * 以前它写的是 `来源片段 00`——那其实是首段的**序号**（0 基补零），可同一页上方还有一行
   * `来源片段 72` 是**条数**。同四个字在这块屏上表示两个数，她照着念就念出了
   * 「只挂了 1 段（标着「来源片段 00」）」这种自相矛盾的话（2026-09-25 真窗口量到）。
   */
  const firstSegmentClipLabel = firstSegment ? `第 ${firstSegment.ordinal + 1} 段来源片段` : "来源片段";
  /**
   * 来源性质与地址（41 §1.5「每项有标题、来源性质、地址和实际引用片段」）。
   *
   * 这两个字段投影里一直有（`source.type` / `source.origin`），而资料袋此前只用了
   * `title` 与段数——于是「这份材料是网页还是本地 Markdown」「它从哪儿来」这两件
   * 核对来源时最先要看的事，屏上一个字都没有。
   *
   * `type` 是枚举不是自由文本，所以直接用来源库自己的说法（网页 / 文本 / Markdown /
   * 代码）；`origin` 可能是空串（本地材料没有地址），那时**不画那一行**而不是画一个
   * 空地址——「没有地址」与「地址读不到」是两件事。
   */
  const sourceKindLabel = source ? (SOURCE_KIND_LABELS[source.source.type] ?? source.source.type) : null;  // Dirty outranks the last receipt: after a save the state stays "committed"
  // until the next one starts, so checking the receipt first made the line claim
  // "已自动保存" while keystrokes were still uncommitted — and the page's own
  // 草稿 tag said the opposite.
  const saveLabel = saving || saveState === "saving"
    ? "● 正在保存…"
    : saveState === "error"
      ? "● 这次没保存上，你写的还在本机"
      : dirty
        ? "● 有改动还没保存"
        : saveState === "committed" && receipt
          ? // 流式那条只能说"已写入、正在同步"：服务端落盘还要等 Hocuspocus 的空闲
            // 刷写。把本机接受说成已保存，就是这次审查里"看起来存下来了"那一类错觉。
            `● ${receipt.isAutosave
              ? receipt.via === "queued"
                ? "没网，先记在本机，联网后自动保存"
                : receipt.via === "stream" ? "已写入，正在同步" : "已自动保存"
              : "已保存"} · ${formatClock(receipt.savedAt)}`
          : "● 已经存好，和服务器上的版本一致";

  const statePaper = loading ? (
    <SurfaceDataState kind="loading" message="正在读取真实笔记" detail="先确认工作区、Note identity 与当前版本。" />
  ) : failure ? (
    <SurfaceDataState kind="error" message="研究册暂时不可用" detail={failure} onRetry={() => void reload()} />
  ) : !note ? (
    <SurfaceDataState kind="empty" message="当前学习空间还没有主笔记" detail="这篇笔记没有给出可编辑的版本，这一页不会在本机另存草稿。" />
  ) : null;

  /**
   * 这一屏给伴星「我在这儿」的复述稿。
   *
   * **逐字抄屏上的那些字，不重算一遍**：`firstSegmentClipLabel` 里那个「第 N 段」是
   * 跟着正文长度变的，重算就会与屏上分叉——而分叉**不会报错**。
   * `notebook-surface.source-clip-label.test.ts` 盯的就是这一条：她说出来的那一句
   * 与屏上那一行必须**逐字相同**。
   */
  /**
   * 伴星「我在这儿」的复述稿。
   *
   * ⚠️ 2026-09-30：**这一份按叶分两枚 pageId**（`note.detail` 与 `note.history`）。
   * 以前只发一枚，于是 `page-readable-registration` 报「挂着 note-history/note-read 共 2 屏，
   * 却只发出 1 枚」——那条红灯是**真的**：翻到轮回看那一屏时，伴星手上还揣着正文页那份，
   * 读到的是**她看不见的那一屏**。屏上写着上一轮的话，她念的是来源片段。
   *
   * 判据照旧：**逐字抄屏上那些字，不重算一遍。**
   */
  const readableView = useMemo<PageReadableV1 | null>(() => {
    if (!note) return null;
    // 这一轮那一屏（`leaf` 是 learning／expansion）：屏上最大的那一句是**那一轮的问题**。
    if (leaf === "expansion") {
      return { pageId: "note.learning", title: readTitle || "这一篇", statusLine: "从这篇往外学", items: [] };
    }
    if (leaf === "reading" && learningView === "recall") {
      return { pageId: "note.learning", title: readTitle || "这一篇", statusLine: "正在回想", items: activeRecall ? [{ ordinal: 1, label: "回想问题", state: activeRecall.question }] : [] };
    }
    if (leaf === "learning") {
      return {
        pageId: "note.learning",
        title: readTitle || "这一篇",
        statusLine: openRound
          ? (openRound.phase === "paused" ? "这一轮停着" : "这一轮进行中")
          : "这一轮还没有开始",
        items: [
          { ordinal: 1, label: "这一轮的问题", state: openRound?.drivingQuestion ?? "屏上还没有一轮" },
        ],
      };
    }
    // 轮回看那一屏：屏上摆的是笔记名与「这一轮走到哪儿」，不是来源片段。
    if (leaf === "history") {
      return {
        pageId: "note.history",
        title: readTitle || "这一篇",
        statusLine: historyTotal > 0 ? `练过 ${historyTotal} 轮` : "还没有练过",
        items: [
          { ordinal: 1, label: "这一轮", state: selectedHistoryItem ? (selectedHistoryMasked ? "这一轮的内容按权限遮蔽" : selectedHistoryItem.drivingQuestion) : "还没有翻开哪一轮" },
        ],
      };
    }
    return {
      // 正文页也有两屏：读与编。**屏上那一句状态不一样**（编辑中那一条是「正在改」），
      // 而伴星要念的是**她此刻看见的那一句**——不是这一页通用的一句。
      pageId: isNoteEditingMode(mode) ? "note.edit" : "note.read",
      title: readTitle || "这一篇",
      statusLine: sourceBagOpen ? "资料袋已打开" : learningView === "overview" ? "正在速看" : learningView === "artifact" ? "正在看互动演示" : mode === "source" ? "正在编辑 Markdown 源码" : mode === "live-preview" ? "正在改这一篇" : "正在读这一篇",
      items: sourceBagOpen ? [
        // ordinal / label / state 三格都照抄屏上那一行。
        { ordinal: 1, label: "来源片段", state: firstSegmentClipLabel },
        { ordinal: 2, label: "来源关系", state: source ? `${source.source.title} · ${segments.length} 段已解析片段` : "尚未关联来源" },
      ] : [],
    };
  }, [note?.title, note?.noteId, firstSegmentClipLabel, source?.source.title, segments.length,
    leaf, mode, readTitle, sourceBagOpen, learningView, activeRecall, openRound?.drivingQuestion, openRound?.phase,
    historyTotal, selectedHistoryItem, selectedHistoryMasked]);
  usePageReadableView(readableView);


  const clips = (
    <div className="source-clips">
      <div className="clip">
        {/* The projection exposes the source's parsed fragments, not a
            note-level evidence binding, so this clip names what it really is:
            the source's first fragment. Calling it 证据 claimed an alignment
            nothing in the record provides. */}
        <b>{firstSegmentClipLabel}</b>
        <br />
        {firstSegment
          ? excerpt(firstSegment.text)
          : sourceFailure
            ? `来源暂时不可读：${sourceFailure}`
            : "当前笔记尚未关联来源"}
      </div>
      <div className="clip">
        <b>来源关系</b>
        <br />
        {source
          ? `${source.source.title} · ${segments.length} 段已解析片段`
          : note?.sourceId
            ? "来源暂时读不到"
            : "未关联来源"}
        {source && sourceKindLabel ? <><br />性质：{sourceKindLabel}</> : null}
        {source?.source.origin ? <><br />地址：{source.source.origin}</> : null}
      </div>
    </div>
  );

  const generationRun = noteGeneration ?? latestRun;
  const { startsNewRun, sourceChanged, blockedByGeneration, offersRegenerate } = noteCardGenerationEntry(
    generationRun, note?.currentVersionId, generationNeedsSavedVersion);
  const generationAction = (
    <>
      <NotebookCardEntry status={startsNewRun ? undefined : generationRun?.status} busy={startingGeneration} triggerRef={generationTriggerRef}
        startLabel={generationRun && !sourceChanged ? "重新生成学习卡" : "生成学习卡"}
        disabled={saving || startsNewRun && (!generationEnabled || blockedByGeneration)}
        partialSourceNotice={!startsNewRun && noteGeneration?.sourceCapped ? sourceCappedNotice(noteGeneration.sourceCapped) : null}
        title={generationReason
          ?? (blockedByGeneration ? "旧版笔记还在生成，请先查看旧版进度并停止，再生成最新版本"
            : startsNewRun
              ? generationRun && !sourceChanged ? "用最新已保存的笔记再生成一套"
                : sourceChanged ? "按当前已保存的笔记生成学习卡"
                  : generationNeedsSavedVersion ? "先保存当前改动，再从已保存版本开始生成"
                    : "先说这次想怎么练，选完就开始生成"
              : generationRun?.status === "activated" ? "查看已保存的学习卡"
                : generationRun?.status === "review_ready" ? "这一批已经写好，等你逐张决定留哪些"
                  : "这次生成在后台进行，来回翻看不会打断它")}
        onClick={startsNewRun ? openGenerationSetup : openGeneration} />
      {/*
        「重新生成学习卡」只在这一颗**去看手上那一批**的时候补位（`offersRegenerate`）。
        另外两种情形里主按钮自己就是"另开一批"：正文改过了就该说「生成学习卡」（这一版
        还没有任何一批卡），上次那批停了就说「重新生成学习卡」——旁边再挂一颗同义的，
        用户要先认出哪一颗是哪一颗才知道按哪一颗。
        正在生成时一颗都不出现：此刻唯一能做的是"停下来"，而那一颗在进度页上。
      */}
      {offersRegenerate ? <button type="button" className="text-action notebook-card-entry__tweak" disabled={!generationEnabled || saving || startingGeneration}
        title="按最新已保存的笔记再生成一套；也可以先说明这次想怎么练" onClick={openGenerationSetup}>重新生成学习卡</button> : null}
      {generationRun && startsNewRun ? <button type="button" className="text-action notebook-card-entry__previous"
        onClick={openGeneration}>{sourceChanged ? "查看旧版生成" : "查看上次生成"}</button> : null}
    </>
  );

  /**
   * 上次没交出去、这一次开门接回来的那几个字。这一句必须说：屏幕上的正文比服务器上的新，
   * 而用户并没有做过任何让它变新的动作，不说他只会以为这篇一直就是这样。写在纸面上、
   * 不用弹窗：它是一条状态，不是一次需要处理的打断。
   */
  const restoredDraftNote = noteDocLive.restoredDraft ? (
    <p className="small notebook-note" role="status">
      本机草稿已恢复：{formatClock(noteDocLive.restoredDraft.savedAt)} 之前还没交上去的改动已经接回来，接着写会自动一起提交。
    </p>
  ) : null;

  // The reading page splits into a scrolling body and the pinned action row:
  // the paper is the scroll container's child, so the buttons stay reachable on
  // a note longer than one screen.
  /**
   * 版本历史仍在笔记纸面，生成方案独立成全屏确认页。
   * 阅读与编辑模式都可开启这两处内容（复盘 #15）。
   * 恢复历史版本在草稿未提交时仍然被按钮自己的 `dirty` 判断挡住。
   */
  const historyPaper = (
    <>
      {historyOpen ? (
        <VersionHistory
          versions={versions}
          loading={versionsLoading}
          failure={versionsFailure}
          restoringVersionId={restoringVersionId}
          editable={Boolean(note?.permissions.canSave)}
          dirty={dirty}
          formatRelative={formatRelative}
          onReload={() => void loadVersions()}
          onRestore={(version) => void restoreVersion(version)}
        />
      ) : null}
    </>
  );
  const pendingExpansionDrafts = expansionTask?.drafts.filter(draft => draft.selected && !expansionTask.confirmedCandidateIds?.includes(draft.candidateId)) ?? [];
  const selectedAnnotation = noteAnnotations.find((item) => item.annotationId === openAnnotationId) ?? null;
  /**
   * 这一条批注**锚的不是当前正文**（改版后核不上，或它本来就属于旧版记录）。
   *
   * 拿它当一个名字用：附页顶部那句「旧版的原句与批注」和「不��它」两处判断的是
   * 同一件事。此前一处内联算、一处内联算同一个表达式——两处迟早会算岔，而岔了的
   * 后果是「屏上说它是旧版快照，却递了个能删的按钮」。
   */
  const annotationIsStaleSnapshot = Boolean(selectedAnnotation
    && !currentNoteAnnotations.some((item) => item.annotationId === selectedAnnotation.annotationId));
  const annotationSidePage = annotationDraftOpen && annotationDraft.draft ? <NotebookAnnotationComposer
    anchor={annotationDraft.draft.anchor} text={annotationDraft.draft.text} saving={annotationDraft.saving} error={annotationDraft.error}
    companionExplanation={noteCompanionExplanations.find(item => !item.dismissed && noteAnchorsOverlap(item.target.anchor, annotationDraft.draft!.anchor))}
    onChange={annotationDraft.setText} onSave={() => void annotationDraft.save()} /> : openCompanionExplanation ? (
    <NoteCompanionExplanationPaper item={openCompanionExplanation}
      onStop={() => { stopCompanionSpeech(); stopNoteExplanation(openCompanionExplanation.id); }}
      onWrite={() => { annotationDraft.start(openCompanionExplanation.target.anchor); setAnnotationDraftOpen(true); }}
      onDismiss={closeSidePage} />
  ) : selectedAnnotation || annotationTaskOpen && annotationTask ? (
    <NoteAnnotationSidePage annotation={selectedAnnotation} task={annotationTaskOpen ? annotationTask : null}
      readOnlySnapshot={annotationIsStaleSnapshot}
      onReturnToHistory={annotationOrigin.current === "history" ? () => { rememberReadingPosition(); setOpenAnnotationId(null); setAnnotationTaskOpen(false); setLeaf("history"); } : undefined}
      artifactTasks={learningArtifactTasks} artifactStarting={learningArtifactTaskStarting} artifactError={learningArtifactTaskError}
      onAsk={(anchor) => askCompanionAboutPassage(anchor.excerpt, anchor, note!.noteId)}
      onCreateArtifact={(anchor) => void startNoteLearningArtifactTask("annotation", anchor)}
      onOpenArtifact={openFootprintArtifact}
      onRetry={retryNoteAnnotationTask} onSettings={openAiConsentSettings}
      // 旧版快照不给删除：那一行锚的版本已经不是当前正文，删掉它会让人以为
      // 「改回去就没了」——而它本来就属于旧版记录那一层。
      onDelete={selectedAnnotation && !annotationIsStaleSnapshot ? () => annotationDelete.request(selectedAnnotation) : undefined}
      onCancelDelete={annotationDelete.cancel}
      onConfirmDelete={selectedAnnotation ? () => void removeNoteAnnotation(selectedAnnotation) : undefined}
      deleteView={selectedAnnotation ? annotationDelete.viewFor(selectedAnnotation) : "idle"}
      deleting={annotationDeleting} deleteError={annotationDelete.errorFor(selectedAnnotation)} removedNotice={annotationRemovedNotice} />
  ) : null;

  // The run contract's knobs live in a full-screen planning sheet so both
  // reading and editing mode can reach the same deliberate start step.
  const generationSetup = optionsOpen && generationEnabled ? createPortal(
        <div className="generation-setup-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeGenerationSetup(); }}>
            <GenerationSetup
              options={options}
              setOptions={setOptions}
              startingGeneration={startingGeneration}
              generationFailure={generationFailure}
              dirty={generationNeedsSavedVersion || saving}
              generationEnabled={generationEnabled}
              startGeneration={() => void startGeneration()}
              feedbackTarget={feedbackTarget}
              feedbackNote={feedbackNote}
              setFeedbackNote={setFeedbackNote}
              feedbackReasons={feedbackReasons}
              setFeedbackReasons={setFeedbackReasons}
              generationOptionSummary={generationOptionSummary}
              cardGenerationStatusLabel={cardGenerationStatusLabel}
              formatRelative={formatRelative}
              closeGenerationSetup={closeGenerationSetup}
            />
        </div>,
        document.body,
      ) : null;

  /**
   * 归属那一位状态 + 那一个动作。编辑态与阅读态共用同一段：只读成员永远进不了
   * 编辑态，而"这篇是只给自己看还是已经拿出去"正是他最该看见的一条信息。
   */
  const shareStateControls = !note || !spaceIdentity || spaceIdentity.isPersonal ? null : (
    <>
      <span className="tag" title={note.permissions.canShare ? "这篇的归属由你决定" : "只有写下这篇的人能改它共享给谁"}>
        {noteShareScopeLabel(note.shareScope)}
      </span>
      <SpaceShareButton
        shareScope={note.shareScope}
        canShare={note.permissions.canShare}
        isPersonal={spaceIdentity.isPersonal}
        busy={sharing}
        onShare={(next) => void setShareScope(next)}
      />
    </>
  );

  const askCompanionAboutNote = () => {
    if (!note || dirty || !note.currentVersionId) return;
    feedNoteIntentToCompanion({
      kind: "overview",
      noteId: note.noteId,
      noteVersionId: note.currentVersionId,
      noteTitle: readTitle || note.title,
    });
  };










  const openExpansionPage = () => {
    if (requestedGoalResult?.kind !== "note_expansion") clearGoalResultSelection();
    rememberReadingPosition();
    closeSidePage();
    setLeaf("expansion");
    void loadLatestNoteExpansionTask();
  };

  const openExpansionNote = (noteId: string) => {
    setActiveNoteRef({ noteId, noteVersionId: null, mode: "preview" });
    invoke("open-notebook");
  };

  const learningEntry = useNotebookLearningEntry<NoteLearningTask>({
    noteId: note?.noteId ?? null,
    hasUnversionedChanges: readingUnversionedContent || dirty,
    save: () => save("manual"),
    open: (kind) => {
      if (kind !== "expansion" || requestedGoalResult?.kind !== "note_expansion") clearGoalResultSelection();
      if (kind === "artifact") return;
      rememberReadingPosition(); closeSidePage();
      if (kind === "expansion") setLeaf("expansion");
      else { setLeaf("reading"); setLearningView(kind); if (kind === "overview") setOverviewOpen(true); }
    },
    lookup: async (kind) => {
      if (kind === "artifact") return activeLearningArtifact ? "existing" : "missing";
      if (kind === "expansion") {
        const result = await loadLatestNoteExpansionTask();
        return !result.ok ? "error" : result.task || noteExpansions.length ? "existing" : "missing";
      }
      if (kind === "recall") {
        const records = await loadNoteRecallRecords();
        if (records === null) return "error";
        const record = records.find(item => item.noteVersionId === note?.currentVersionId);
        if (record) { openRecall(record, "practice"); return "existing"; }
        return "missing";
      }
      const [latest, page] = await Promise.all([loadLatestNoteOverviewTask(), loadNoteOverviews()]);
      if (!latest || !page) return "error";
      return latest.task || page.items.some(item => item.versionState === "current" && item.generationJobId && item.coverage) ? "existing" : "missing";
    },
    start: (kind, regenerate) => {
      if (kind !== "expansion") clearGoalResultSelection();
      if (kind === "artifact") {
        const source = artifactRegenerationSource.current;
        if (source) void startNoteLearningArtifactTask(source.sourceKind, source.anchor, true);
        return;
      }
      rememberReadingPosition();
      closeSidePage();
      if (kind === "expansion") { setLeaf("expansion"); void startNoteExpansionTask(undefined, true); }
      else {
        setLeaf("reading"); setLearningView(kind);
        if (kind === "overview") { setOverviewOpen(true); if (regenerate || !latestNoteOverview) void startNoteOverviewTask(false); }
        else void startNoteRecall(regenerate);
      }
    },
  });
  const regenerateArtifact = (artifact: NoteLearningArtifactV1) => {
    openFootprintArtifact(artifact);
    artifactRegenerationSource.current = { sourceKind: artifact.sourceKind, ...(artifact.selectionAnchor ? { anchor: artifact.selectionAnchor } : {}) };
    learningEntry.prepare("artifact", true);
  };

  const readPageBody = note ? (
    <>
      {leaf === "reading" ? <>
      {((learningView === "overview" && requestedGoalResult?.kind === "note_overview")
        || (learningView === "artifact" && requestedGoalResult?.kind === "note_dynamic_artifact")) && !goalResult.result ? <SurfaceDataState
          kind={goalResult.error ? "error" : "loading"}
          message={goalResult.error ? "这份结果暂时没读到" : "正在翻开这份结果"}
          detail={goalResult.error ?? "正在读取手记里保存的这一份内容。"}
          onRetry={goalResult.retry}
          action={<button type="button" className="text-action" onClick={() => { clearGoalResultSelection(); setLearningView("body"); }}>回正文</button>} /> : null}
      {learningView === "overview" && !latestNoteOverview && requestedGoalResult?.kind !== "note_overview" ? <NotebookLearningPage kind="overview" title={readTitle || note.title} version={note.currentVersion.versionNo}
        state={learningEntry.checking === "overview" ? "loading" : overviewTaskStarting ? "queued" : taskForCurrentVersion?.status === "ready" ? "loading" : taskForCurrentVersion?.status ?? (overviewTaskError || learningEntry.error ? "failed" : "empty")}
        error={taskForCurrentVersion?.failureReason ?? overviewTaskError ?? learningEntry.error}
        onPrepare={() => learningEntry.prepare("overview")} onBody={() => setLearningView("body")}
        onRetry={() => learningEntry.error ? void learningEntry.request("overview") : void startNoteOverviewTask(dirty)} onSettings={openAiConsentSettings} /> : null}

      {latestNoteOverview && learningView === "overview" ? (
            <NoteOverviewPaper
              overview={latestNoteOverview}
              paperRef={overviewPaperRef}
              dirty={dirty}
              onCollapse={() => { clearGoalResultSelection(); setOverviewOpen(false); setLearningView("body"); }}
              onLocateReference={locateTeachingReference}
              onOpenExpansionPage={openExpansionPage}
              onAskCompanion={askCompanionAboutNote}
              artifactTask={learningArtifactTasks.find(task => task.sourceKind === "overview" && task.noteVersionId === latestNoteOverview.noteVersionId) ?? null}
              artifactStarting={learningArtifactTaskStarting}
              onCreateArtifact={() => void startNoteLearningArtifactTask("overview")}
              onOpenArtifact={openFootprintArtifact}
              onRegenerate={() => learningEntry.prepare("overview", true)}
              regenerating={overviewTaskStarting || taskForCurrentVersion?.status === "queued" || taskForCurrentVersion?.status === "running"}
            />
      ) : null}
      {latestNoteOverview && learningView === "overview" && (overviewTaskStarting || taskForCurrentVersion?.status === "queued" || taskForCurrentVersion?.status === "running" || taskForCurrentVersion?.status === "failed" || overviewTaskError) ? <aside className="notebook-regeneration" aria-label="新速看的进度">
        <TaskSlip kind="overview" status={overviewTaskStarting ? "queued" : taskForCurrentVersion?.status}
          failureReason={taskForCurrentVersion?.failureReason} onRetry={() => learningEntry.prepare("overview", true)} onOpenSettings={openAiConsentSettings} />
        {overviewTaskError ? <p role="alert">{overviewTaskError}</p> : null}
        <small>之前的速看仍可阅读，所有结果都留在学习记录里。</small>
      </aside> : null}
      {(learningView === "body" || learningView === "overview") && (learningView === "overview" && learningArtifactTaskError || learningArtifactTasks.some((task) => task.sourceKind === "overview")) ? (
        <NotebookArtifactTaskPaper
          tasks={learningArtifactTasks.filter((task) => task.sourceKind === "overview").slice(0, 1)}
          error={learningArtifactTaskError}
          onStart={(task) => void startNoteLearningArtifactTask("overview", undefined)}
          onOpen={openFootprintArtifact}
          onOpenSettings={openAiConsentSettings}
        />
      ) : null}
      {activeLearningArtifact && learningView === "artifact" ? (
        <NotebookLearningArtifactPaper artifact={activeLearningArtifact} paperRef={learningArtifactPaperRef}
          ready={learningArtifactStoredId === activeLearningArtifact.artifactId} error={learningArtifactError}
          referenceBlocks={readSourceBlocks}
          motion={motionMode === "full" ? "full" : "reduced"} onLocateReference={locateTeachingReference}
          onRegenerate={activeLearningArtifact.sourceKind === "overview" || activeLearningArtifact.versionState === "current" ? () => regenerateArtifact(activeLearningArtifact) : undefined}
          regenerationStarting={learningArtifactTaskStarting}
          regenerationError={learningArtifactTaskError}
          regenerationTask={learningArtifactTasks.find(task => task.noteVersionId === note.currentVersionId && task.sourceKind === activeLearningArtifact.sourceKind
            && (task.sourceKind === "overview" || task.selectionAnchor?.excerpt === activeLearningArtifact.selectionAnchor?.excerpt)) ?? null}
          onOpenGenerated={openFootprintArtifact}
          onRetry={() => { setLearningArtifactStoredId(null); setLearningArtifactError(null); setLearningArtifactEnsureRevision((revision) => revision + 1); }} />
      ) : null}
      {activeRecall && learningView === "recall" ? (
        <NoteRecallPaper
          key={`${activeRecall.recallId}:${recallVisit}`}
          recall={activeRecall}
          presentation={recallPresentation}
          workspaceEpoch={epochRef.current}
          onNew={() => learningEntry.prepare("recall", true)}
          paperRef={recallPaperRef}
          onCollapse={() => { closeRecall(); if (recallPresentation === "history") setLeaf("history"); else setLearningView("body"); }}
          onAct={(action) => actOnActiveRecall(action)}
          onReflectionChange={setRecallReflection}
          onLocateSection={locateTeachingReference}
          busy={recallBusy}
          failure={recallError}
          reflection={recallReflection}
        />
      ) : learningView === "recall" ? <NotebookLearningPage kind="recall" title={readTitle || note.title} version={note.currentVersion.versionNo}
        state={recallBusy === "start" ? "running" : recallLoading || learningEntry.checking === "recall" ? "loading" : recallError || learningEntry.error ? "failed" : "empty"}
        error={recallError ?? learningEntry.error} onPrepare={() => learningEntry.prepare("recall")}
        onBody={() => setLearningView("body")} onRetry={() => void learningEntry.request("recall")} /> : null}
      {learningView === "body" ? <section id="notebook-reading-leaf" aria-label="笔记正文">

      <div
        className="note-transcript"
        ref={readingBodyRef}
        onMouseUp={captureSelectedPassage}
        onKeyUp={captureSelectedPassage}
        onTouchEnd={captureSelectedPassage}
      >
        {readSourceBlocks.length ? readingBlocks.map((block) => (
          <ReadingBlock
            key={block.ordinal}
            block={block}
            annotations={currentNoteAnnotations}
            companionExplanations={noteCompanionExplanations.filter(item => !item.dismissed && item.phase !== "saved"
              && item.target.anchor.noteVersionId === note.currentVersionId && noteAnchorMatchesV1(readSourceBlocks, item.target.anchor))}
            onOpenCompanionExplanation={item => setCompanionExplanationId(item.id)}
            pendingAnnotationTask={annotationTask?.noteVersionId === note.currentVersionId
              && annotationTask.anchor.startBlockOrdinal === block.ordinal ? annotationTask : null}
            learningArtifactTasks={learningArtifactTasks.filter((task) => task.sourceKind === "annotation" && task.selectionAnchor?.startBlockOrdinal === block.ordinal)}
            onCreateLearningArtifact={(anchor) => void startNoteLearningArtifactTask("annotation", anchor)}
            learningArtifactTaskStarting={learningArtifactTaskStarting}
            openAnnotationId={openAnnotationId}
            onOpenAnnotation={openNoteAnnotation}
            // 正文里就能删（用户裁决）：记号浮层上那枚「删掉这条」，不必先开附页。
            // 确认状态与附页共用同一份 —— `annotationDeleteConfirm`，见那个 hook 的注释。
            onDeleteAnnotation={renderAnnotationDeleteControl}
            onRetryAnnotationTask={retryNoteAnnotationTask}
            onOpenPendingAnnotation={() => { setAnnotationTaskOpen(true); setHistoryOpen(false); setOpenAnnotationId(null); }}
            onOpenAiConsentSettings={openAiConsentSettings}
            onAskCompanion={(anchor) => askCompanionAboutPassage(anchor.excerpt, anchor, note.noteId)}
            focused={focusedBlockOrdinal === block.ordinal}
            mark={mark?.ordinal === block.ordinal ? mark.range : null}
            workspaceEpoch={epochRef.current}
            gallery={noteImages.ordinalToStart.has(block.ordinal)
              ? {
                start: noteImages.ordinalToStart.get(block.ordinal)!,
                openAt: (index: number) => noteGallery.openAt(index),
                close: noteGallery.close,
              }
              : undefined}
          />
        )) : <p className="small">这一版正文还没有段落。</p>}
        {hiddenBlockCount > 0 ? (
          <div className="actions reading-more">
            <button type="button" className="button" onClick={() => setShowAllBlocks(true)}>
              展开剩余 {hiddenBlockCount} 段
            </button>
          </div>
        ) : null}
        {olderNoteAnnotations.length > 0 || unresolvedNoteAnnotations.length > 0 || annotationRows?.nextCursor ? (
          <details
            className="note-annotation-history"
            open={annotationShelfOpen}
            onToggle={(event) => setAnnotationShelfOpen(event.currentTarget.open)}
          >
            <summary>以前留下的批注{olderNoteAnnotations.length ? ` · 旧版 ${olderNoteAnnotations.length}` : ""}{unresolvedNoteAnnotations.length ? ` · 需核对 ${unresolvedNoteAnnotations.length}` : ""}{annotationRows?.nextCursor ? " +" : ""}</summary>
            {[...olderNoteAnnotations, ...unresolvedNoteAnnotations].map((annotation) => (
              <article className="note-annotation-history__entry" key={annotation.annotationId}>
                <small>{annotation.versionState === "older"
                  ? "原句来自旧版本，当前正文没有可靠的对应位置"
                  : "原句位置暂时无法核对，没有自动贴到相似句"}</small>
                <blockquote>{annotation.anchor.excerpt}</blockquote>
                <p>{annotation.explanation}</p>
              </article>
            ))}
            {annotationRows?.nextCursor ? (
              <button
                type="button"
                className="note-annotation-history__more"
                disabled={annotationLoading}
                onClick={() => void loadNoteAnnotations(annotationRows.nextCursor!)}
              >
                {annotationLoading ? "正在翻找…" : "再翻一些批注"}
              </button>
            ) : null}
            {annotationError ? <p role="alert">批注暂时读不到：{annotationError} <button type="button" onClick={() => void loadNoteAnnotations()}>重试</button></p> : null}
          </details>
        ) : null}
        {annotationTaskError ? <p className="note-annotation-task-error" role="alert">{annotationTaskError}</p> : null}
      </div>

      </section> : null}
      </> : null}
      {(<div hidden={leaf !== "expansion"}>{(
      <section className="note-expansion-shelf" aria-label="从这篇往外学">
        <header>
          {expansionTask && expansionTask.noteVersionId !== note.currentVersionId ? <p className="note-expansion-shelf__intro">这批草稿来自之前保存的笔记版本。仍可修改和收下；引用保留原版本，当前正文已更新。</p> : null}
          {expansionTask?.status === "ready" || expansionTask?.status === "confirmed" || noteExpansions.length ? <p className="note-expansion-shelf__intro">每篇都有来处。先翻开看看，再决定收下哪篇。</p> : null}
          <div className="note-expansion-shelf__actions">
            {!expansionTaskLoading && !expansionTaskStarting && (expansionTask?.status === "ready" || expansionTask?.status === "confirmed" || !expansionTask && noteExpansions.length > 0) ? (
              <button type="button" disabled={expansionReviewSaving || expansionReviewDirty || !note.currentVersionId} onClick={() => learningEntry.prepare("expansion", true)}>
                重新生成拓展
              </button>
            ) : null}
          </div>
        </header>
        {/* 这一句原来已经写对了（「可以继续阅读」），只是它和另外三处各写一遍。
            现在四处读同一张纸签：说清在做什么、明说不用等、没做成时给一条能走的路。 */}
        {expansionTaskStarting || expansionTaskLoading && !expansionTask || expansionTask?.status === "queued" || expansionTask?.status === "running" || expansionTask?.status === "failed" || !expansionTask && !noteExpansions.length ? <NotebookLearningPage
          kind="expansion" title={readTitle || note.title} version={note.currentVersion.versionNo}
          state={expansionTaskStarting ? "queued" : expansionTaskLoading || learningEntry.checking === "expansion" ? "loading" : expansionTask?.status === "failed" || expansionTaskError || learningEntry.error ? "failed" : expansionTask?.status === "queued" || expansionTask?.status === "running" ? expansionTask.status : "empty"}
          error={expansionTask?.failureReason ?? expansionTaskError ?? learningEntry.error}
          onPrepare={() => learningEntry.prepare("expansion")} onBody={() => { clearGoalResultSelection(); setLeaf("reading"); setLearningView("body"); }}
          onRetry={() => expansionTask?.status === "failed" ? void startNoteExpansionTask(undefined, true) : void learningEntry.request("expansion")} onSettings={openAiConsentSettings} /> : null}
        {expansionTask && (expansionTask.status === "ready" || expansionTask.status === "confirmed") ? (
              <NoteExpansionDrafts
                key={expansionTask.taskId}
                task={expansionTask}
                saving={expansionReviewSaving || expansionTaskStarting}
                locateTeachingReference={expansionTask.noteVersionId === note.currentVersionId ? locateTeachingReference : undefined}
                setExpansionTask={setExpansionTask}
                persistNoteExpansionReview={persistNoteExpansionReview}
              />
        ) : null}
        {expansionTaskError ? <p className="note-expansion-task-error" role="alert">{expansionTaskError} <button type="button" className="text-action" disabled={expansionReviewSaving || expansionTaskLoading || expansionTaskStarting} onClick={() => void retryNoteExpansionTask()}>{({ read: "重试读取", start: "重试生成", save: "重试保存", confirm: "重试收下" })[expansionTaskErrorAction]}</button></p> : null}
        {expansionTaskHistory.some(task => task.taskId !== expansionTask?.taskId) || expansionTaskHistoryError ? <details className="notebook-expansion-history" onToggle={event => { if (event.currentTarget.open) void loadNoteExpansionTaskHistory(); }}>
          <summary>之前整理的草稿{expansionTask && expansionTask.noteVersionId !== note.currentVersionId ? " · 同一原文版本" : ` · 笔记 v${note.currentVersion.versionNo}`}</summary>
          <p>重新生成会另开一批，之前未收下的草稿和修改仍保留。</p>
          <ul>{expansionTaskHistory.filter(task => task.taskId !== expansionTask?.taskId).map(task => <li key={task.taskId}>
            <button type="button" className="text-action" disabled={expansionReviewDirty || expansionReviewSaving || expansionTaskStarting}
              onClick={() => void openNoteExpansionTask(task.taskId)}>{task.drafts[0]?.title || (task.status === "failed" ? "未完成的拓展" : "正在整理的拓展")}<small>{new Date(task.createdAt).toLocaleString()} · {task.drafts.length} 篇 · {task.status === "confirmed" ? "已收下" : task.status === "ready" ? "草稿" : task.status === "failed" ? "未完成" : "生成中"}</small></button>
          </li>)}</ul>
          {expansionTaskHistoryCursor ? <button type="button" className="text-action" disabled={expansionTaskHistoryLoading} onClick={() => void loadNoteExpansionTaskHistory(expansionTaskHistoryCursor)}>再翻一些草稿批次</button> : null}
          {expansionTaskHistoryError ? <p role="alert">草稿批次没能读到：{expansionTaskHistoryError} <button type="button" className="text-action" onClick={() => void loadNoteExpansionTaskHistory()}>重试读取</button></p> : null}
        </details> : null}
        {noteExpansions.length > 0 ? (
          <ul>
            {noteExpansions.map((expansion) => {
              const isSource = expansion.direction === "expanded_from_here";
              const targetNoteId = isSource ? expansion.expandedNoteId : expansion.sourceNoteId;
              return (
                <li key={expansion.expansionId}>
                  <button type="button" onClick={() => openExpansionNote(targetNoteId)}>
                    <span>{isSource ? "从这里继续" : "从这篇来到这里"}</span>
                    <strong>{expansion.otherNoteTitle}</strong>
                    <small>{isSource
                      ? `原笔记 v${expansion.sourceNoteVersionNumber} → 新笔记 v${expansion.expandedNoteVersionNumber}`
                      : `来源笔记 v${expansion.sourceNoteVersionNumber} → 本篇 v${expansion.expandedNoteVersionNumber}`}</small>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
        {expansionRows?.nextCursor ? (
          <button type="button" className="note-expansion-shelf__more" disabled={expansionLoading} onClick={() => void loadNoteExpansions(expansionRows.nextCursor!)}>
            {expansionLoading ? "正在找更早的…" : "再看一些关联笔记"}
          </button>
        ) : null}
      </section>
      )}</div>)}
      {leaf === "learning" ? (
        /*
         * 书桌上的这一页（2026-09-28 整体重构）。
         *
         * 上一版是「页眉 h2 + 薄荷标题牌 + 三枚药丸 + 描边框段落 + 底部悬浮坞」——
         * 四个带框的东西从上到下排成一列，屏上读起来就是一张后台表单：标题被滚动容器
         * 裁掉一半，薄荷左边框变成一截孤零零的竖条，说服用户的句子和一颗按钮占掉一个
         * 整块描边框，失败提示被裁在纸脚看不见，而真正该被看见的「在弄什么」排在中间。
         *
         * 那一版的骨架整个不要了。现在这一页按**书桌**组织：
         *
         *   - 左栏是一条**顺着读下去**的线：问题 → 讲解 → 例子 → 作答 → 收获。
         *     全部是纸上的字，**没有一块描边框**。
         *   - 右栏是**摆在桌上的物件**：走到哪一步（进度绳）、笔记原句（依据便签）、
         *     那页能动手的演示。这些是"手上拿着的东西"，不是"系统状态"。
         *   - 主动作回到**纸脚**（`round-desk__foot`），不再挂在纸外的悬浮条上。
         *   - 那一行「正在学 / 停住了 / 这一轮的收获」删掉：它是界面自己的状态，
         *     用户看得见按钮在做什么，不需要另一句话复述一遍（39f UI-4）。
         *
         * 问题不再是"牌"，它是**这一页的标题**——所以它就是那个 h2，视觉上是一张
         * 用和纸胶带贴在书页上的纸片，微微歪着，有自己的影子。
         */
        <section id="notebook-learning-leaf" className="round-desk" aria-label="这一轮学习" data-learning-scene={reviewingTeaching ? "teaching" : learningScene}>
          <div className="round-desk__head">
            <button type="button" className="round-bookmark" onClick={backToReading}>回到正文</button>
            <p className="round-desk__note">{readTitle || "未命名笔记"}</p>
          </div>

          <div className="round-desk__body">
            {/* ── 左栏：顺着读的那条线 ─────────────────────────────────── */}
            <RoundDeskLine
      data={data}
      roundDraft={roundDraft}
      setRoundDraft={setRoundDraft}
      roundBusy={roundBusy}
      roundFailure={roundFailure}
      roundLostDraft={roundLostDraft}
      setRoundLostDraft={setRoundLostDraft}
      roundEditing={roundEditing}
      setRoundEditing={setRoundEditing}
      teachingBusy={teachingBusy}
      teachingFailure={teachingFailure}
      practiceBusy={practiceBusy}
      reviewingTeaching={reviewingTeaching}
      setReviewingTeaching={setReviewingTeaching}
      learningScene={learningScene}
      inFlightStep={inFlightStep}
      inlineRoundRunId={inlineRoundRunId}
      setInlineRunPage={setInlineRunPage}
      structureQuestions={structureQuestions}
      teachingReferences={teachingReferences}
      roundArtifact={roundArtifact}
      artifactState={artifactState}
      onLocateReference={locateTeachingReference}
      onSubmitQuestion={submitRoundQuestion}
      onStartRoundTeaching={startRoundTeaching}
      onStartRoundPractice={startRoundPractice}
      onPrepareRoundPractice={prepareRoundPractice}
      onEndNoteRound={endNoteRound}
      onEndNoteRoundHere={() => endNoteRound()}
      onExitInlineRun={exitInlineRoundRun}
      onReload={reload}
      onGoToReading={() => setLeaf("reading")}
      onApplyLostDraft={() => { setRoundDraft(roundLostDraft?.question ?? ""); setRoundStarter(roundLostDraft?.starter ?? null); setRoundLostDraft(null); }}
      noteChangeImpactNotice={openRoundNoteChangeImpact ? <NoteChangeImpactNotice impact={openRoundNoteChangeImpact} context="round" /> : null}
      setRoundStarter={setRoundStarter}
      setRoundFailure={setRoundFailure}
      saving={saving}
      saveState={saveState}
      practiceFailure={practiceFailure}
      latestRoundPractice={latestRoundPractice}
      teachingReflectionIds={teachingReflectionIds}
      teachingSnapshotIsReadVersion={teachingSnapshotIsReadVersion}
      openRoundPractice={openRoundPractice}
      dirty={dirty}
            />

            {/* ── 右栏：摆在桌上的物件 ─────────────────────────────────── */}
            <aside className="round-desk__objects">
              {/* 进度绳：三个刻痕串在一根线上，线上串着一颗木珠。上一版是三枚带框的药丸，
                  读起来像三个系统状态；这里是一根线上的位置——"走到哪儿了"比"哪几格是
                  什么状态"更接近人对自己进度的感觉。判定仍然全在 `roundTrackV1` 里。 */}
              {openRound ? (
                <ol className="round-thread" aria-label="这一轮走到哪一步">
                  {roundTrack.map((step) => (
                    <li key={step.key} data-mark={step.mark}>
                      <span className="round-thread__bead" aria-hidden="true" />
                      <span className="round-thread__label">{step.label}</span>
                      <span className="round-thread__note">{step.note}</span>
                    </li>
                  ))}
                </ol>
              ) : null}

              {/* 演示：一张**摊在桌上、比笔记纸略小并稍稍错开**的大纸。这是这一页最该被
                  看见的东西，所以它不折进任何折叠区，也不再挂一个"跟着演示看一遍"的
                  标题——它就是那一页演示本身。 */}
              {roundArtifact && artifactState === "ready" ? (
                <figure className="round-sheet" aria-label="动态演示">
                  <span className="round-sheet__clip" aria-hidden="true" />
                  <span className="round-sheet__fold" aria-hidden="true" />
                  <ArtifactFrameHost
                    artifactId={roundArtifact.artifactId}
                    motion={motionMode === "full" ? "full" : "reduced"}
                    fallback={<p className="round-slip__aside">{ROUND_COPY.teaching.artifactFallback}</p>}
                  />
                </figure>
              ) : null}
              {roundArtifact && artifactState === "failed" ? <p role="alert" className="round-slip__aside">{ROUND_COPY.teaching.artifactFailed}</p> : null}
            </aside>
          </div>

          {/* ── 纸脚：主动作回到纸上（不是挂在纸外的悬浮条）──────────────── */}
          {openRound && !roundEditing ? (
            <div className="round-desk__foot">
              {reviewingTeaching
                ? <button type="button" className="round-stamp" onClick={() => setReviewingTeaching(false)}>{learningScene === "practice" ? "回到正在做的那道题" : "回到下一步"}</button>
                : learningScene === "paused"
                  ? <button type="button" className="round-stamp" disabled={roundBusy !== null} onClick={() => void resumeNoteRound()}>{roundBusy === "resume" ? ROUND_COPY.resuming : ROUND_COPY.resume}</button>
                  : learningScene === "unavailable"
                    ? <button type="button" className="round-stamp" onClick={() => void reload({ silent: true })}>重新读取这一轮</button>
                    : learningScene === "question" && roundNextStep?.kind === "attempt" && roundPracticeStart
                      ? <button type="button" className="round-stamp" disabled={practiceBusy} onClick={() => void startRoundPractice()}>{practiceBusy ? ROUND_COPY.teaching.practicing : "先试这一道"}</button>
                      : learningScene === "question"
                        ? <button type="button" className="round-stamp" disabled={teachingBusy || roundBusy !== null} onClick={() => void startRoundTeaching(false)}>{teachingBusy ? ROUND_COPY.teaching.starting : "看讲解"}</button>
                        : learningScene === "teaching"
                          ? roundNextStep?.kind === "attempt" && roundPracticeStart
                            ? <button type="button" className="round-stamp" disabled={practiceBusy} onClick={() => void startRoundPractice()}>{practiceBusy ? ROUND_COPY.teaching.practicing : "拿这道题试一次"}</button>
                            : <button type="button" className="round-stamp" onClick={() => setLeaf("reading")}>回到笔记里核对</button>
                          : learningScene === "practice"
                            ? <button type="button" className="round-stamp" onClick={() => { if (!roundNextStep?.basisRunId) return; void openRoundPractice(roundNextStep.basisRunId); }}>回到那道题</button>
                            : roundNextStep?.kind === "help"
                              ? <button type="button" className="round-stamp" disabled={teachingBusy} onClick={() => { setReviewingTeaching(true); void startRoundTeaching(true, teachingReflectionIds); }}>{teachingBusy ? ROUND_COPY.teaching.starting : "换一种讲解"}</button>
                              : (roundNextStep?.kind === "retry" || roundNextStep?.kind === "apply") && roundPracticeStart
                                ? <button type="button" className="round-stamp" disabled={practiceBusy} onClick={() => void startRoundPractice()}>{practiceBusy ? ROUND_COPY.teaching.practicing : roundNextStep.kind === "apply" ? "用新情境试一次" : "再试一次"}</button>
                                : roundNextStep?.kind === "finish"
                                  ? <button type="button" className="round-stamp" disabled={roundBusy !== null} onClick={() => void endNoteRound("completed")}>{roundBusy === "end" ? ROUND_COPY.ending : "这一轮学完了，回笔记"}</button>
                                  : roundNextStep?.kind === "uncertain" || roundNextStep?.kind === "choose"
                                    ? <button type="button" className="round-stamp" disabled={roundBusy !== null} onClick={() => void endNoteRound()}>{roundBusy === "end" ? ROUND_COPY.ending : "先到这里"}</button>
                                    : <button type="button" className="round-stamp" onClick={() => void reload({ silent: true })}>重新读取下一步</button>}
              {/* 次级动作是**纸签**，不是第二排描边按钮。它们挨着主动作，不抢主位。 */}
              <div className="round-desk__others">
                {learningScene === "result" && !reviewingTeaching && roundTeaching
                  ? <button type="button" className="round-tab" onClick={() => setReviewingTeaching(true)}>回看讲解</button>
                  : null}
                {learningScene === "practice" && !reviewingTeaching && roundTeaching && !inlineRoundRunId
                  ? <button type="button" className="round-tab" onClick={() => setReviewingTeaching(true)}>先回看讲解</button>
                  : null}
                {learningScene === "result" && !reviewingTeaching && roundNextStep?.kind === "uncertain" && roundNextStep.basisRunId
                  ? <button type="button" className="round-tab" onClick={() => { void openRoundPractice(String(roundNextStep.basisRunId)); }}>看原回答和反馈</button>
                  : null}
                {openRound ? (
                  <button type="button" className="round-tab" disabled={roundBusy !== null} onClick={() => { setRoundDraft(openRound.drivingQuestion); setRoundStarter(openRound.drivingQuestion); setRoundEditing(true); }}>{ROUND_COPY.revise}</button>
                ) : null}
                {openRoundContentMoved ? (
                  <button type="button" className="round-tab" data-round-reopen-current="true" disabled={roundBusy !== null} onClick={() => void reopenNoteRound()}>{roundBusy === "reopen" ? ROUND_COPY.reopening : ROUND_COPY.reopenWithCurrent}</button>
                ) : null}
                {openRound && !reviewingTeaching && learningScene !== "result" ? (
                  <button type="button" className="round-tab" disabled={roundBusy !== null} onClick={() => void endNoteRound()}>今天先到这里</button>
                ) : null}
                {openRound && !reviewingTeaching && learningScene === "result" ? (
                  <button type="button" className="round-tab" disabled={roundBusy !== null} onClick={() => void endNoteRound()}>先到这里</button>
                ) : null}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}
      {(<div hidden={leaf !== "history"}>{<section id="notebook-history-leaf" className="notebook-journey" aria-label="学习记录" tabIndex={-1} data-task-focus>
        <p className="notebook-journey__intro">速看、回想、批注和拓展都留在这里。打开一条记录，接着看当时的内容。</p>
          {/* ── 那一块为什么没被搬走（2026-09-29 量过的，不是猜的）─────────────────
              250 行、79 个外部符号，里面**已经有 10 处是组件调用**（足迹 / 学习记录 /
              轮回看 / 路线覆盖 / 感想区 / 在场…）。再往里逐块扫，**只有一段 18 行的
              动作条**（6 个外部符号）还值得切，其余全是页面级派生与已成组件的摆位。

              所以「切不动」的原因**不是依赖多**——是**这一块已经切到头了**：
              再切下去切的是版式而不是逻辑，收益为负。要继续缩，只能先把那 79 个符号
              里属于 page 的那些收进 hook（review / subscription / teaching / versions /
              overview / recall / practice / save 八簇已收），再重新量。── */}
        <NoteLearningFootprint
          key={note.noteId}
          overviews={noteOverviews}
          recalls={noteRecallRecords}
          annotations={noteAnnotations}
          artifacts={noteLearningArtifacts}
          expansions={noteExpansions}
          hasMore={{
            overview: Boolean(overviewRows?.nextCursor),
            recall: Boolean(recallRows?.nextCursor),
            annotation: Boolean(annotationRows?.nextCursor),
            artifact: Boolean(learningArtifactRows?.nextCursor),
            expansion: Boolean(expansionRows?.nextCursor),
          }}
          loadingMore={{
            overview: overviewLoading,
            recall: recallLoading,
            annotation: annotationLoading,
            artifact: learningArtifactLoading,
            expansion: expansionLoading,
          }}
          onLoadMore={loadOlderFootprint}
          onOpenRecall={openFootprintRecall}
          onOpenAnnotation={openFootprintAnnotation}
          onOpenArtifact={openFootprintArtifact}
          onOpenExpansion={(expansion) => openExpansionNote(expansion.direction === "expanded_from_here" ? expansion.expandedNoteId : expansion.sourceNoteId)}
          onLocateReference={locateTeachingReference}
        />
        {footprintPending ? <p className="notebook-footprint-status" role="status">正在找回这篇笔记的记录…</p> : null}
        {overviewError ? <p className="notebook-footprint-error" role="alert">速览暂时没读到。<button type="button" className="text-action" onClick={() => void loadNoteOverviews()}>重试</button></p> : null}
        {recallError ? <p className="notebook-footprint-error" role="alert">回想记录暂时没读到。<button type="button" className="text-action" onClick={() => void loadNoteRecallRecords()}>重试</button></p> : null}
        {annotationError ? <p className="notebook-footprint-error" role="alert">批注暂时没读到。<button type="button" className="text-action" onClick={() => void loadNoteAnnotations()}>重试</button></p> : null}
        {learningArtifactError && !activeLearningArtifact ? <p className="notebook-footprint-error" role="alert">互动讲解暂时没读到。<button type="button" className="text-action" onClick={() => void loadNoteLearningArtifacts()}>重试</button></p> : null}
        {expansionError ? <p className="notebook-footprint-error" role="alert">拓展笔记暂时没读到。<button type="button" className="text-action" onClick={() => void loadNoteExpansions()}>重试</button></p> : null}
        {footprintRowsLoaded && !footprintHasRecords ? (
          <div className="notebook-history-empty notebook-footprint-empty">
            <History size={28} aria-hidden="true" />
            {historyTotal > 0 || historyItems.length > 0 ? (
              <>
                <p>这篇笔记还没有速览、回想、批注或拓展笔记。</p>
                <p className="small">以前的讲解和练习仍在下方；回到正文，可以从更轻的方式开始。</p>
              </>
            ) : (
              <>
                <p>这篇笔记还没有学习记录。</p>
                <p className="small">回到正文，先看懂这篇、回想一下，或圈出难懂的一句；做过的内容会留在这里。</p>
              </>
            )}
            <button type="button" className="button primary" onClick={() => setLeaf("reading")}>回到笔记，选一种方式开始</button>
          </div>
        ) : null}
        <details className="notebook-legacy-footprint" open={legacyHistoryOpen} onToggle={(event) => {
          const open = event.currentTarget.open;
          setLegacyHistoryOpen(open);
          if (open) loadLegacyRouteCoverage();
        }}>
          <summary>以前的讲解与练习{historyTotal > 0 ? ` · ${historyTotal} 条记录` : ""}</summary>
          <p className="small notebook-note">这里是以前的讲解和练习；新的记录会留在上面。</p>
      {/* 旧学习流程的记录仍可回看，但不再作为新流程的默认入口。 */}
      {historyItems.length > 0 ? (
            <NotebookRoundHistory
              items={historyItems}
              total={historyTotal}
              hasMore={historyHasMore}
              busy={olderBusy}
              failure={olderFailure}
              recordDay={roundRecordDayV1}
              recordModesLabel={roundRecordModesLabelV1}
              historyStateLabel={roundHistoryStateLabelV1}
              onInspect={inspectRoundInFootprint}
              onLoadOlder={loadOlderRounds}
            />
      ) : null}
        {/* 这一篇的核心路线册页（PRD §4.4；39d W4-5 ③）。摆在记录**上面**：
            「这一篇走到哪」是那一页要答的第一句，而记录是它的证据。两者都空时
            下面那个空态才出现——空态那一格说的是"还没留下学习记录"，而册页说的
            是"还没有核心路线"，两句不能互相顶替。 */}
        <NoteRouteCoverage
          coverage={routeCoverage}
          failure={routeCoverageFailure}
          onInspectRound={inspectRoundInFootprint}
        />
        {reflectionRoundId ? (
          <NotebookRoundRecap
            masked={selectedHistoryMasked}
            busy={inspectedRoundBusy}
            failure={inspectedRoundFailure}
            inspected={inspectedRound}
            reflectionRoundId={reflectionRoundId}
            selectedItem={selectedHistoryItem ?? null}
            stateLabel={roundHistoryStateLabelV1}
            recordDay={roundRecordDayV1}
            practiceLabel={roundPracticeStateLabelV1}
            onRetry={() => setHistoryInspectRevision((value) => value + 1)}
            onOpenReflection={() => {
              reflectionShelfRef.current?.scrollIntoView?.({ block: "start" });
              reflectionShelfRef.current?.querySelector("summary")?.focus();
            }}
            detailRef={historyDetailRef}
          />
        ) : null}
        </details>
        <details className="notebook-review-options" data-note-review-options="true">
          <summary>以后怎么复习（可选）</summary>
          <p className="small notebook-note">这篇笔记的持续回访由你决定，卡片若单独开启复习会另行安排。</p>
          <div className="notebook-objective__source" data-note-subscription="true">
            {noteSubscription?.status === "active" ? (
              <>
                <button type="button" className="button" disabled={subscriptionBusy !== null}
                  onClick={() => void runNoteSubscriptionAction("pause")}>
                  {subscriptionBusy === "pause" ? "正在处理…" : reviewSourceSwitchLabel("note_subscription", true)}
                </button>
                <p className="small notebook-note">{reviewSourceScopeHint(noteSubscription)}</p>
              </>
            ) : (
              <>
                <button type="button" className="button" disabled={subscriptionBusy !== null}
                  onClick={() => void runNoteSubscriptionAction("activate")}>
                  {subscriptionBusy === "activate" ? "正在处理…" : reviewSourceSwitchLabel("note_subscription", false)}
                </button>
                <p className="small notebook-note">{noteSubscription ? reviewSourceScopeHint(noteSubscription) : "开启后，这篇里学过或已确认要维护的目标会持续回访。"}</p>
              </>
            )}
            {subscriptionNotice ? <p className="small notebook-note" data-subscription-notice="true">{subscriptionNotice}</p> : null}
            {subscriptionError ? <p className="small notebook-note" role="alert" data-subscription-error="true">{subscriptionError}</p> : null}
          </div>
          {noteObjective ? (
            <div className="notebook-objective__hold" data-note-objective-hold="true">
              <p className="small notebook-note">最近形成的一个学习目标：{noteObjective.publicSummary}</p>
              {noteObjective.reviewHold ? (
                <>
                  <p className="small notebook-note" data-review-hold-label="true">{objectiveReviewHoldLabel(noteObjective.reviewHold)}</p>
                  <button type="button" className="button" disabled={reviewHoldBusy !== null}
                    onClick={() => void runObjectiveReviewHoldAction("resume")}>
                    {reviewHoldBusy === "resume" ? "正在恢复…" : OBJECTIVE_RESUME_ACTION_LABEL}
                  </button>
                  <p className="small notebook-note">{objectiveReviewHoldHint(noteObjective.reviewHold)}</p>
                </>
              ) : (
                <>
                  <button type="button" className="button" disabled={reviewHoldBusy !== null}
                    onClick={() => void runObjectiveReviewHoldAction("hold")}>
                    {reviewHoldBusy === "hold" ? "正在处理…" : OBJECTIVE_HOLD_ACTION_LABEL}
                  </button>
                  <p className="small notebook-note">{objectiveHoldActionDescription()}</p>
                </>
              )}
              {reviewHoldNotice ? <p className="small notebook-note" data-review-hold-notice="true">{reviewHoldNotice}</p> : null}
              {reviewHoldError ? <p className="small notebook-note" role="alert" data-review-hold-error="true">{reviewHoldError}</p> : null}
            </div>
          ) : null}
        </details>
      </section>}</div>)}
      {(leaf === "learning" && learningScene === "result" && !reviewingTeaching && Boolean(openRound && (roundTeaching || roundPractices.length > 0))
        || leaf === "history" && Boolean(reflectionRoundId && inspectedRound?.roundId === reflectionRoundId && (inspectedRound.view.teaching || inspectedRound.view.practices.length > 0))) ? <div className="note-reflection-anchor" ref={reflectionShelfRef}><NoteReflectionShelf key={note.noteId} noteId={note.noteId} roundId={leaf === "history" ? reflectionRoundId : openRound?.roundId}
        refreshKey={`${roundTeaching?.teachingId ?? ""}:${roundPractices.map(p => `${p.runId}:${p.phase}`).join(",")}`}
        workspaceEpoch={epochRef.current} canAppend={canSave && Boolean(noteDocLive.fragment) && !saving} shared={note.shareScope === "shared"}
        openSources={leaf === "history" && Boolean(reflectionRoundId)}
        canUseForTeaching={leaf !== "history" && Boolean(openRound)}
        selectedForTeaching={teachingReflectionIds}
        onSelectionChange={setTeachingReflectionIds}
        onInspectBody={() => switchMode("preview")}
        onAppend={async (source, annotation) => {
          if (!note.permissions.canSave || !noteDocLive.fragment || saving) throw new Error("正文此刻不可编辑，请回到笔记核对权限和保存状态。");
          stageReflectionAppend(noteDocLive.fragment, note.noteId, source, annotation, appendedReflections.current);
          const saved = await save("manual");
          return saved;
        }} /></div> : null}
      {/* Leaving the editor now commits the pending draft first, so a reader who
          lands here must be told what happened to it instead of seeing the older
          server text with no explanation. */}
      {saving || dirty ? (
        <p className="small notebook-note" role="status">
          {saving ? "正在保存刚才的编辑…" : "有改动还没保存，切回编辑继续写。"}
        </p>
      ) : null}
      {restoredDraftNote}
      {saveState === "error" ? (
        <p className="small notebook-note" role="alert">
          保存没成功：{saveFailure}
          <button
            type="button"
            className="text-action text-action--strong"
            disabled={saving}
            onClick={() => void save("manual")}
          >
            重试保存
          </button>
        </p>
      ) : null}
      {leaf === "reading" && learningView === "body" && generationReason ? <p className="small notebook-note">{generationReason}</p> : null}
      {leaf === "reading" && learningView === "body" && generationFailure ? <p className="small notebook-note" role="alert">{generationFailure}</p> : null}
    </>
  ) : null;

  /**
   * 「版本历史」「生成设置」两个开关。阅读页与编辑页共用同一对：面板已经在同一
   * 个组件里了；此前只有阅读页摆出按钮，编辑态摸不到
   * （复盘 #15）。
   */
  const versionAndOptionsToggles = note ? (
    <>
      <button
        type="button"
        className="text-action notebook-meta-action"
        aria-expanded={historyOpen}
        onClick={() => {
          const next = !historyOpen;
          setHistoryOpen(next);
          if (next) { setOpenAnnotationId(null); setAnnotationTaskOpen(false); }
          if (next) void loadVersions();
        }}
      >
        <History size={14} aria-hidden="true" />
        版本历史
      </button>
    </>
  ) : null;



  const documentHeading = isNoteEditingMode(mode) ? (
    <h2>
      <label className="sr-only" htmlFor="notebook-surface-title">笔记标题</label>
      <textarea id="notebook-surface-title" rows={1} value={titleValue} maxLength={200} disabled={!editable}
        placeholder="未命名笔记"
        onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) event.preventDefault(); if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save("manual"); } }}
        onChange={(event) => { const value = event.currentTarget.value.replace(/\r?\n/g, " "); applyDraft({ ...draftRef.current, title: value }); setLocalTitle(value, "manual"); }} />
    </h2>
  ) : <h2>{readTitle || "未命名笔记"}</h2>;
  const pageTitle = leaf === "expansion" ? "往外学" : leaf === "history" ? "学习记录" : leaf === "learning" ? "学这篇笔记"
    : learningView === "overview" ? "这篇的速看" : learningView === "recall" ? "回想一下" : learningView === "artifact" ? "互动讲解"
      : isNoteEditingMode(mode) ? "笔记编辑" : "这篇笔记";
  const pageSubtitle = leaf === "expansion" ? "先翻开，再决定收下哪篇" : leaf === "history" ? "留下的线索都在这页"
    : learningView === "recall" ? "先自己想想，再翻开原文" : learningView === "overview" ? "抓住要点，回原文核对"
      : isNoteEditingMode(mode) ? "写下理解，留下可回看的版本" : "原文还在，接着往下读";

  const editChrome = note ? <NotebookEditorTools editorRef={editorRef} editable={editable} canUpload={Boolean(note.permissions.canSave)} fileInputRef={imageUploads.fileInputRef} onImages={imageUploads.queueFiles} onLink={linkEditor.open} /> : null;

  // Both editors stay attached to the shared document throughout this visit.
  // Saving snapshots the draft, so fields remain editable during the request.
  const editPageBody = note && draftSeeded ? (
    // Milkdown 的 defaultValueCtx 只在创建时读一次，所以编辑器按 noteId 重建：
    // 换一篇笔记就是换一个编辑器，而"恢复历史版本"这类同一篇里的整体替换走 ref 的
    // setMarkdown（见上面那个回读效应）。首帧不等 draftSeeded 就会用空正文建文档。
    <div className="note-draft" ref={editorPaneRef} onKeyDown={onEditorKeyDown}>
      <label className="sr-only" htmlFor="notebook-surface-body">笔记正文</label>
      <div id="notebook-surface-body" data-surface-initial-focus={isNoteEditingMode(mode) ? "true" : undefined}>
        {coWriters.length ? (
          // 一句文字，不靠颜色：这一格说的是"别人和我在同一段里"，看不见颜色的人
          // 与截图review都得能读出来。名字来自对端自己报的，一个也没本机代填。
          <p className="small notebook-note notebook-cowriters" role="status">
            {`${coWriters.map((peer) => peer.name ?? "另一个人").join("、")} 也在写这一段`}
          </p>
        ) : null}
        {noteDocLive.fragment ? <NoteDocumentEditor
          key={note.noteId}
          ref={editorRef}
          mode={mode}
          fragment={noteDocLive.fragment}
          initialMarkdown={draft.content}
          onChange={applyContent}
          disabled={!editable || leaf !== "reading" || learningView !== "body"}
          onImagePaste={imageUploads.queueFile}
          onCaretBlock={onCaretBlock}
          // 41 §1.4：两个编辑态都要保留批注记号。落位只收**当前版本上仍核得上**的
          // 那一批（`currentNoteAnnotations`）——核不上的留在旧版记录里，不挪位置。
          annotationPlacements={editAnnotationPlacements}
          onOpenAnnotation={openNoteAnnotationById}
        /> : null}
      </div>
      <NoteImageUploads
        uploads={imageUploads.uploads}
        error={imageUploads.error}
        onRetry={imageUploads.retry}
        onDismiss={imageUploads.dismiss}
      />
      {isNoteEditingMode(mode) && leaf === "reading" ? <>
        {restoredDraftNote}
        {saveFailure ? <p className="small notebook-note" role="alert">保存没成功：{saveFailure}</p> : null}
        {generationReason ? <p className="small notebook-note">{generationReason}</p> : null}
        {generationFailure ? <p className="small notebook-note" role="alert">{generationFailure}</p> : null}
      </> : null}
    </div>
  ) : null;



  return (
    <>
      <div className="task-title notebook-page-title"><h1>{pageTitle}</h1><p>{pageSubtitle}</p></div>
      <main className="content notebook-space">
        {linkEditor.dialog}
        <article
          className="notebook-workspace notebook-hud"
          aria-busy={loading || undefined}
          data-mode={mode}
          data-note-paper-image-drop={paperAcceptsImages ? "" : undefined}
          onPointerDown={(event) => {
            if (!(event.target instanceof Element) || !event.target.closest("[data-note-selection-action]")) {
              setSelectedPassage(null);
            }
          }}
          onDragOver={(event) => {
            if (paperImageFiles(event).length > 0) event.preventDefault();
          }}
          onDrop={(event) => {
            const files = paperImageFiles(event);
            if (files.length === 0) return;
            event.preventDefault();
            for (const file of files) imageUploads.queueFile(file);
          }}
        >
          {statePaper ? <div className="notebook-workspace__state">{statePaper}</div> : null}
          {!loading && !failure && note ? (
            <>
              <NotebookDesk
                noteId={note.noteId} noteTitle={readTitle || "未命名笔记"} version={note.currentVersion.versionNo} mode={mode} canEdit={editable} pendingMode={pendingMode}
                articleHeader={leaf === "reading" && learningView === "body" ? <header className="notebook-volume__article-head" tabIndex={-1} data-task-focus>
                  <div className="notebook-volume__heading">{documentHeading}</div>
                  <div className="notebook-volume__meta">{/*
                      版本标签要说清**这一屏正文来自哪里**（审计 F35）。
                      这里此前只写 `v{n}`：正文其实来自未保存的实时文档，而那一版的
                      编号摆在那里，用户会以为自己在读一个已定版的版本——那一版
                      甚至可能是空的。未定版时不出现「不可变版本」这几个字。
                    */}
                    <span className="notebook-volume__version" title={readingUnversionedContent ? `已存版本 v${note.currentVersion.versionNo}` : undefined}>
                      <BookOpen size={13} aria-hidden="true" />
                      {readingUnversionedContent
                        ? "当前草稿"
                        : `已存版本 v${note.currentVersion.versionNo}`}
                    </span>
                    {note.sourceId ? <button type="button" className="text-action" title={sourceTitle} onClick={() => setSourceBagOpen(true)}><FileText size={13} aria-hidden="true" />来源资料</button> : <span>独立笔记</span>}
                    {/*
                        「来源片段」这四个字在屏上**只表示一个数**（2026-09-25 真窗口量到）：
                        资料卡片写 `第 N 段来源片段`（那是序号），页眉这里写条数。
                        两边曾经都是「来源片段 NN」，一个序号一个计数，她照着念就念出
                        自相矛盾的话。所以这里只放条数，卡片那侧只放序号。
                      */}
                    {segments.length > 0 ? <span>来源片段 {segments.length}</span> : null}
                    {noteExpansions.length ? <button type="button" className="text-action" onClick={() => openExpansionPage()}><Link2 size={13} aria-hidden="true" />关联笔记 · {noteExpansions.length}</button> : null}
                    <time dateTime={note.currentVersion.updatedAt}>{formatRelative(note.currentVersion.updatedAt)}更新</time>
                    {!isNoteEditingMode(mode) ? <span title={saveLabel} role="status">{saveState === "error" ? "同步失败" : saving ? "正在同步…" : dirty ? "等待同步…" : "已同步"}</span> : null}
                    {!editable ? <span className="tag">只读</span> : null}<NotebookPresence peers={noteDocLive.presencePeers} selfName={presenceName} />{shareStateControls}
                  </div>
                </header> : null}
                onMode={switchMode} outline={noteOutline(noteDocLive.fragment, readSourceBlocks)}
                onLocate={locateTeachingReference}
                onOpenDirectory={() => { setHistoryOpen(false); setSourceBagOpen(false); setOpenAnnotationId(null); setAnnotationTaskOpen(false); }}
                learningView={leaf === "reading" ? learningView : leaf}
                onLearning={learningEntry.request}
                onBody={() => { clearGoalResultSelection(); rememberReadingPosition(); closeSidePage(); setLeaf("reading"); setLearningView("body"); setOverviewOpen(false); }}
                onHistory={() => { clearGoalResultSelection(); rememberReadingPosition(); closeSidePage(); setLeaf("history"); }}
                primaryAction={isNoteEditingMode(mode) && leaf === "reading" && learningView === "body" && canSave ? <button type="button" className="button primary"
                    disabled={saving} onClick={() => void save("manual")}>{saveState === "error" ? "重试保存" : saving ? "正在保存…" : "保存版本"}</button> : null}
                taskActions={leaf === "expansion" && expansionTask?.status === "ready" ? <>
                  <span className="notebook-expansion-selection" role="status">待收下 {pendingExpansionDrafts.length} 篇 · 未选中的仍是草稿</span>
                  <button type="button" className="button primary" disabled={expansionReviewSaving || !pendingExpansionDrafts.length} onClick={() => void confirmNoteExpansionDrafts()}>{expansionReviewSaving ? "正在保存…" : `确认收下 ${pendingExpansionDrafts.length} 篇`}</button>
                </> : null}
                sourceAction={<button type="button" className="text-action" aria-expanded={sourceBagOpen} onClick={() => setSourceBagOpen(!sourceBagOpen)}><Link2 size={16} aria-hidden="true" />资料袋</button>}
                generationAction={generationAction}
                extraActions={<>
                  {annotationDraft.draft ? <button type="button" className="text-action" onClick={() => setAnnotationDraftOpen(true)}><PencilLine size={14} aria-hidden="true" />继续写批注</button> : null}
                  {versionAndOptionsToggles}
                </>}
                tools={isNoteEditingMode(mode) && leaf === "reading" && learningView === "body" ? editChrome : null}
                status={<><span className={dirty || saveState === "error" ? "tag red" : "tag"}>{dirty || saveState === "error" ? "草稿" : "已同步"}</span>
                  <span role="status">{saveLabel}</span>
                  {!editable ? <span className="tag">只读</span> : null}
                  <NotebookPresence peers={noteDocLive.presencePeers} selfName={presenceName} />{shareStateControls}</>}
                scrollRef={leafScrollRef}
                sidePage={historyOpen ? { kind: "history", title: "版本历史", closeLabel: "收起版本历史", onClose: () => setHistoryOpen(false), content: historyPaper } : sourceBagOpen ? { kind: "source", title: "资料袋", closeLabel: "合起资料袋", onClose: () => setSourceBagOpen(false), content: <>
                  <h3>原始资料</h3><p>{sourceTitle}</p>{clips}
                  {note.sourceId ? <button type="button" className="button" onClick={openSource}>打开只读原始资料</button> : null}
                </> } : annotationSidePage ? { kind: "annotation", title: annotationDraftOpen ? "写批注" : openCompanionExplanation ? "伴星解释" : "原句批注", closeLabel: "收起批注", onClose: closeSidePage, content: annotationSidePage } : null}
              >
                {learningEntry.choice ? <NotebookVersionChoice kind={learningEntry.choice} version={note.currentVersion.versionNo}
                  regenerating={learningEntry.regenerating}
                  canSave={canSave} saving={learningEntry.saving} error={learningEntry.error} hasChanges={readingUnversionedContent || dirty} existing={learningEntry.existing}
                  onSaved={learningEntry.startSaved} onSave={() => void learningEntry.saveAndStart()} onDismiss={learningEntry.dismiss} /> : null}
                <div hidden={leaf !== "reading" || learningView !== "body" || !isNoteEditingMode(mode)}>{editPageBody}</div>
                <div hidden={leaf === "reading" && learningView === "body" && isNoteEditingMode(mode)}>{readPageBody}</div>
              </NotebookDesk>
              {selectedPassage && leaf === "reading" && learningView === "body" && mode === "preview" ? <NotebookSelectionActions
                range={selectedPassage.range} scrollRef={leafScrollRef} hasAnchor={Boolean(selectedPassage.anchor)} dirty={dirty} busy={annotationTaskStarting}
                companionPending={Boolean(selectedPassage.anchor && noteCompanionExplanations.some(item => (noteExplanationBusy(item) || item.phase === "save-error") && noteAnchorsOverlap(item.target.anchor, selectedPassage.anchor!)))}
                onExplain={() => { explainSelectedPassage(); setSelectedPassage(null); window.getSelection()?.removeAllRanges(); }}
                onWrite={() => { if (selectedPassage.anchor) { annotationDraft.start(selectedPassage.anchor); setAnnotationDraftOpen(true); setSelectedPassage(null); window.getSelection()?.removeAllRanges(); } }}
                onAskCompanion={askCompanionAboutSelectedPassage} onDismiss={() => { setSelectedPassage(null); window.getSelection()?.removeAllRanges(); }} /> : null}
            </>
          ) : null}
          {/* 阅读页的图片画廊：点击正文任一张图进入，左右切换整篇的图。
              variant="card"：遮罩只盖住这张纸面，不铺满整个窗口。 */}
          {noteGallery.isOpen && noteImages.images.length ? (
            <ImageGalleryLightbox
              images={noteImages.images}
              index={noteGallery.openIndex ?? 0}
              variant="card"
              workspaceEpoch={epochRef.current}
              onClose={noteGallery.close}
              onIndexChange={noteGallery.setIndex}
            />
          ) : null}
        </article>
      </main>
      {generationSetup}
    </>
  );
}
