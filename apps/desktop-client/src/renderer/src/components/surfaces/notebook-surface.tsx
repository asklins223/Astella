import { NoteReflectionShelf } from "./note-reflection-shelf";
import { noteLearningScene, notePracticeResultCopy, roundTrackNextV1, roundTrackV1 } from "./note-learning-flow";
import { stageReflectionAppend } from "./note-reflection-document";
import { LearningRunBody, releaseRunThroughMainV1 } from "./learning-run-surface";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { History, LoaderCircle, RefreshCw, Sparkles } from "lucide-react";
import "./note-hud.css";
import type { CapabilityProjectionV1 } from "@ailearn/shared/desktop-ipc-contracts";
import type {
  CardGenerationActiveSummaryV1,
  CardGenerationRunSnapshotV1,
  DesktopCardDetailThresholdV2,
  DesktopCardGenerationFeedbackReasonV2,
  DesktopCardLearningGoalV2,
  DesktopCardStrategyV2,
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
import { useRoomStore } from "../../app/room-store";
import { SpaceShareButton, noteShareScopeLabel } from "../space-share-control";
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
} from "../../app/desktop-client";
import { imageOnlyFiles } from "../../app/source-intake";
import { ROUND_RECORD_COPY_V1, roundHistoryStateLabelV1, roundRecordDayV1, roundRecordModesLabelV1 } from "./round-record-copy";
import { NoteRouteCoverage } from "./note-route-coverage";
import type { NoteRouteCoverageV1 } from "@ailearn/shared/note-route-coverage-v2";
import { HudPage } from "../hud/HudPage";
import { useHudPage } from "../hud/use-hud-page";
import { usePageReadableView } from "../hud/use-page-readable-view";
import type { PageReadableV1 } from "@ailearn/shared/companion-bridge-contracts";
import type { HudPageId } from "../hud/hud-pages";
import {
  SurfaceDataState,
  formatRelative,
  noteBlockText,
  parseImageBlock,
  useSurfaceProjection,
} from "./surface-data";
import {
  cardGenerationEntryLabel,
  cardGenerationStatusLabel,
  sourceCappedNotice,
  isCardGenerationInFlight,
  isLiveGenerationForNote,
} from "./card-generation-status";
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
} from "./objective-state-copy";
import { startObjectiveJourney } from "./objective-primary-action";
import { ArtifactFrameHost } from "./artifact-frame-host";
import { RoundNotice } from "./round-notice";
import { parseMarkdownTable } from "./note-blocks";
import { isHorizontalRule, noteInlineDisplayText, noteInlineImages, renderNoteInline } from "./note-reading-inline";
import { sourceImageObjectKeyFromUrl } from "@ailearn/shared/source-image-contracts";
import { useSourceImage } from "./source-image";
import { ImageGalleryLightbox, useImageLightbox, ZoomableReadingImage, type GalleryImage } from "./image-viewer";
import { NoteMarkdownEditor, type NoteMarkdownEditorHandle } from "./note-markdown-editor";
import { useNoteDocLiveView } from "./use-note-doc-live-view";
import { NotebookPresence } from "./notebook-presence";
import { NoteImageUploads, useNoteImageUploads } from "./note-image-uploads";

/**
 * Pages 08 / 09: one committed note as a paper notebook.
 *
 * Reading (`note-read`) and writing (`note-edit`) are the same server record in
 * two modes. Every field on this page comes from `room.getProjection` /
 * `note.get` / `source.get` / `capabilities.get`; nothing about the note is
 * written locally before the server confirms it.
 *
 * 正文在编辑器里是**真 Markdown**（Milkdown 所见即所得），在服务端是分类型的块，
 * 两边只经 `note-blocks.ts` 那一份换算，所以"打开一篇没改过的笔记就显示未提交"
 * 这种漂移不存在。撤销由编辑器自己的 history 承担，这一页不再维护第二套。
 */
type NotebookProjection = {
  readonly note: NoteDetailV1;
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

/**
 * What a generation run is asked for. These are the run contract's own knobs —
 * the page used to hard-code all four, so every run was "理解 / 均衡 / 最多 8 张 /
 * 主动回忆+机制解释" with no way to say otherwise, and only two of the seven
 * strategies the contract accepts were ever reachable.
 */
type GenerationOptions = {
  readonly learningGoal: DesktopCardLearningGoalV2;
  readonly detailThreshold: DesktopCardDetailThresholdV2;
  readonly hardMaxCards: number;
  readonly preferredStrategies: readonly DesktopCardStrategyV2[];
};

/**
 * 题型是「系统按知识形态分配」的候选集合，不是优先级：勾掉某种即表示不要它，
 * 全勾即完全交给 planner 决定（planner-service.allocateStrategies）。
 * 默认值必须是全集——曾经默认 ["recall","why"] 时，即便题型真正生效，
 * 事实类知识也会被压成清一色的回忆题。
 */
const STRATEGIES: readonly { readonly value: DesktopCardStrategyV2; readonly label: string }[] = [
  { value: "recall", label: "主动回忆" },
  { value: "cloze", label: "关键补全" },
  { value: "compare", label: "对比辨析" },
  { value: "sequence", label: "顺序重建" },
  { value: "why", label: "机制解释" },
  { value: "boundary", label: "边界判断" },
  { value: "application", label: "情境应用" },
];

const DEFAULT_GENERATION_OPTIONS: GenerationOptions = {
  learningGoal: "understand",
  detailThreshold: "balanced",
  hardMaxCards: 8,
  preferredStrategies: STRATEGIES.map((item) => item.value),
};

/** Session scope, like the library's view choice: a page visit keeps the writer's pick. */
let persistedGenerationOptions: GenerationOptions = DEFAULT_GENERATION_OPTIONS;

const LEARNING_GOALS: readonly { readonly value: DesktopCardLearningGoalV2; readonly label: string }[] = [
  { value: "remember", label: "记住" },
  { value: "understand", label: "理解" },
  { value: "apply", label: "应用" },
  { value: "exam", label: "应试" },
];

const DETAIL_THRESHOLDS: readonly { readonly value: DesktopCardDetailThresholdV2; readonly label: string }[] = [
  { value: "concise", label: "精简" },
  { value: "balanced", label: "均衡" },
  { value: "deep", label: "深入" },
];

const CARD_LIMITS = [4, 8, 12] as const;

/** Statuses where the run has stopped; only those can be answered with feedback. */
const FINISHED_RUN_STATUSES = new Set(["activated", "closed_without_activation", "cancelled", "failed", "stale"]);

const FEEDBACK_REASONS: readonly { readonly value: DesktopCardGenerationFeedbackReasonV2; readonly label: string }[] = [
  { value: "too_many", label: "卡片太多" },
  { value: "missing_key_objective", label: "漏掉关键目标" },
  { value: "surface_paraphrase", label: "只是换了个说法" },
  { value: "wrong_learning_goal", label: "学习卡不符" },
  { value: "duplicate_existing_card", label: "与已有卡片重复" },
  { value: "not_worth_reviewing", label: "不值得复习" },
];

function generationOptionSummary(options: GenerationOptions): string {
  const goal = LEARNING_GOALS.find((item) => item.value === options.learningGoal)?.label ?? options.learningGoal;
  const detail = DETAIL_THRESHOLDS.find((item) => item.value === options.detailThreshold)?.label ?? options.detailThreshold;
  const strategies = options.preferredStrategies
    .map((value) => STRATEGIES.find((item) => item.value === value)?.label ?? value)
    .join("+");
  return `${goal} · ${detail} · 最多 ${options.hardMaxCards} 张 · ${strategies}`;
}

/**
 * 工具栏：每个按钮直接调 Milkdown 的命令，光标所在的块自己变形状，不再往纯文本
 * 里拼标记。这是 Web 端工具栏的做法，也是"所见即所得"与"纯文本标记"的分界线——
 * 按钮改的是文档结构，不是字符串。
 *
 * `onMouseDown` 一律 `preventDefault`：命令作用在**当前选区**上，按下去的那一下
 * 若把焦点抢走，加粗就会落到空处。字形沿用纸面原本的写法（`H`、`“`、`⌁`、`fx`），
 * 只是同一批字形现在指挥的是真文档。
 */
type EditorToolSpec = {
  readonly glyph: string;
  readonly label: string;
  readonly title: string;
  readonly run: (editor: NoteMarkdownEditorHandle) => void;
};

const EDITOR_TOOLS: readonly EditorToolSpec[] = [
  { glyph: "H", label: "标题", title: "把这一段变成标题", run: (editor) => editor.toggleHeading(2) },
  { glyph: "B", label: "加粗", title: "加粗（⌘/Ctrl+B）", run: (editor) => editor.toggleStrong() },
  { glyph: "I", label: "斜体", title: "斜体（⌘/Ctrl+I）", run: (editor) => editor.toggleEmphasis() },
  { glyph: "``", label: "行内代码", title: "行内代码", run: (editor) => editor.toggleInlineCode() },
  { glyph: "“", label: "引用", title: "把这一段变成引用", run: (editor) => editor.toggleBlockquote() },
  { glyph: "⌁", label: "无序列表", title: "变成无序列表", run: (editor) => editor.toggleBulletList() },
  { glyph: "1.", label: "有序列表", title: "变成有序列表", run: (editor) => editor.toggleOrderedList() },
  { glyph: "fx", label: "代码块", title: "插入代码区块", run: (editor) => editor.insertCodeBlock() },
  { glyph: "—", label: "分隔线", title: "插入分隔线", run: (editor) => editor.insertHr() },
  { glyph: "⛓", label: "链接", title: "插入链接（⌘/Ctrl+K）", run: (editor) => editor.toggleLink("https://") },
];

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
    // 拿它算偏移，高亮就会整体错位几个字符（渲染与这里共用 `noteInlineDisplayText`）。
    const text = noteInlineDisplayText(block.content);
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
  const setActiveCardGenerationRunId = useRoomStore((state) => state.setActiveCardGenerationRunId);
  const setActiveObjectiveId = useRoomStore((state) => state.setActiveObjectiveId);
  const setActiveRunId = useRoomStore((state) => state.setActiveRunId);
  // 就地作答要靠它判断"这一轮正在答的那一次"是不是眼下这一次（见 `inlineRoundRunId`）。
  const activeRunId = useRoomStore((state) => state.activeRunId);
  const activeNoteRef = useRoomStore((state) => state.activeNoteRef);
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
  const [inspectedRound, setInspectedRound] = useState<{ roundId: string; view: RoundTeachingViewV1 } | null>(null);
  const [inspectedRoundBusy, setInspectedRoundBusy] = useState(false);
  const [inspectedRoundFailure, setInspectedRoundFailure] = useState<string | null>(null);
  const [historyInspectRevision, setHistoryInspectRevision] = useState(0);
  const historyDetailRef = useRef<HTMLElement>(null);
  const appendedReflections = useRef(new Map<string, string>());
  const reflectionShelfRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<NoteMarkdownEditorHandle | null>(null);
  const editorPaneRef = useRef<HTMLDivElement>(null);
  const epochRef = useRef<number | undefined>(undefined);
  const syncedNoteRef = useRef<string | null>(null);
  const saveRef = useRef<() => void>(() => {});
  const [mode, setMode] = useState<"read" | "edit">("read");
  const [leaf, setLeaf] = useState<"reading" | "learning" | "history">("reading");
  const [reviewingTeaching, setReviewingTeaching] = useState(false);
  /** 就地作答的工位停在哪一屏：`assessment` 作答／`result` 那一次的结算。 */
  const [inlineRunPage, setInlineRunPage] = useState<"assessment" | "result">("assessment");
  const handledRoundReturnRef = useRef<string | null>(null);
  const autoFocusedSuspectNoteRef = useRef<string | null>(null);
  const [showAllBlocks, setShowAllBlocks] = useState(false);
  const [showAllReadingSections, setShowAllReadingSections] = useState(false);
  const [focusedBlockOrdinal, setFocusedBlockOrdinal] = useState<number | null>(null);
  const leafScrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    setLeaf(activeNoteRef?.learningRoundId ? "learning" : "reading");
    setReviewingTeaching(false);
    setShowAllBlocks(false);
    setShowAllReadingSections(false);
    setFocusedBlockOrdinal(null);
    setReflectionRoundId(activeNoteRef?.learningRoundId);
    appendedReflections.current.clear();
  }, [activeNoteRef?.noteId, activeNoteRef?.learningRoundId]);
  /**
   * 换书签时回到页首，**除非**这一趟是"回到刚才读的那一段"（39f §3「从笔记进入」）。
   *
   * 位置放在 ref 里而不是 state：这个效果只随 `leaf` 跑一次，落回原位之后必须**不再**
   * 触发第二轮（state 会因为 set(null) 再跑一次，于是刚落回去就被自己抹成 0）。
   *
   * 真正在滚的是 `.notebook-scroll`（`leafScrollRef`），不是里面的 `.reading-body`——
   * 后者的 `scrollTop` 恒为 0，早先那版记位置记在它上面，等于永远记到 0。
   */
  const pendingReadingTopRef = useRef<number | null>(null);
  useEffect(() => {
    const scroller = leafScrollRef.current;
    if (!scroller) return;
    const restore = pendingReadingTopRef.current;
    pendingReadingTopRef.current = null;
    scroller.scrollTop = restore ?? 0;
  }, [leaf]);
  /**
   * `title` 是**本机改过、还没写进文档**的那一份，`null` = 这一屏没改过标题，
   * 于是标题框画文档 `meta` 里的那一份（别人改名会跟着动）。正文不在这里存副本，
   * 只有编辑器 `onChange` 交出来的那一份（图片上传回填要用）。
   */
  const [draft, setDraft] = useState<{ title: string | null; content: string }>({ title: null, content: "" });
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "committed" | "error">("idle");
  const [receipt, setReceipt] = useState<{
    savedAt: string;
    isAutosave: boolean;
    /**
     * 这一次走的是长连接还是 HTTP。它不是装饰：流式那条只说明"本机已并进文档"，
     * 服务端落盘还要等 Hocuspocus 的 debounce，保存行不能说成"已保存"。
     */
    via: "stream" | "uploaded" | "unchanged" | "queued";
  } | null>(null);
  const [saveFailure, setSaveFailure] = useState<string | null>(null);
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
  const [reviewHoldBusy, setReviewHoldBusy] = useState<"hold" | "resume" | null>(null);
  /** W7-3 刀六：订阅那一发在进行中（"开"与"停"共用一颗闸，同一篇不该并发两发）。 */
  const [subscriptionBusy, setSubscriptionBusy] = useState<"activate" | "pause" | null>(null);
  const [subscriptionNotice, setSubscriptionNotice] = useState<string | null>(null);
  const [subscriptionError, setSubscriptionError] = useState<string | null>(null);
  const [reviewHoldNotice, setReviewHoldNotice] = useState<string | null>(null);
  const [reviewHoldError, setReviewHoldError] = useState<string | null>(null);
  // 39d W4-3 第三刀：那张表单自己的三份状态。`roundStarter` 记住"这句是哪一颗预设放的"，
  // 来源那一档（suggested / rewritten / authored）就靠它判，不靠猜用户改没改。
  const [roundDraft, setRoundDraft] = useState("");
  const [roundStarter, setRoundStarter] = useState<string | null>(null);
  const [roundEditing, setRoundEditing] = useState(false);
  const [roundBusy, setRoundBusy] = useState<RoundBusyV1>(null);
  /**
   * 翻出来的那几页（第一页由投影自己读，往后每页累加在这里）。存着 `noteId` 并按它过滤，
   * 而不是"切篇时记得清空"——后者靠一次副作用，漏一次就把上一篇的记录接在这一篇下面。
   */
  // 用合同那一份类型，不再手抄四格：上一刀加 `totalCount` 时，抄出来的那份形状
  // 会静默少一格（`historyTotal` 读不到它，总数就退回 0），而 typecheck 只会红在
  // 读它的那一行上，不会告诉你"这里本来该跟着长"。
  const [olderRounds, setOlderRounds] = useState<NoteLearningRoundHistoryV1 | null>(null);
  const [olderBusy, setOlderBusy] = useState(false);
  const [olderFailure, setOlderFailure] = useState<string | null>(null);
  const [roundFailure, setRoundFailure] = useState<{ kind: GatewayFailureKind; message: string } | null>(null);
  /**
   * 迟到的那一句（§16.39 的"另一份草稿明确保留为冲突"，39d W4-5 第四刀）。
   *
   * 被服务端判成 conflict 的那一发要做两件事，缺一不可：那一行换回**现在那一版**
   * （真窗口实测过不换的害处：她对着作废的那句继续），同时她交出去的那一句
   * **不许消失**——顶掉与拼进新版本是同一处缺陷的两种画法，PRD 两个都不要。
   * 所以这里存的是「句子＋当时用的那句引子」这一对：`roundQuestionSourceV1` 按
   * 引子判 source，只留句子会把她原本算 `suggested` 的那一发改记成 `user_authored`。
   */
  const [roundLostDraft, setRoundLostDraft] = useState<{ question: string; starter: string | null } | null>(null);
  /** 教学面（W4-6 刀二）：生成那一发在途、以及它自己的失败那一句。 */
  const [teachingBusy, setTeachingBusy] = useState(false);
  const [teachingFailure, setTeachingFailure] = useState<{ kind: GatewayFailureKind; message: string } | null>(null);
  const [teachingReflectionIds, setTeachingReflectionIds] = useState<string[]>([]);
  /** 「练一道」（W4-6 刀三）：开那场 run 的在途与它自己的失败那一句。 */
  const [practiceBusy, setPracticeBusy] = useState(false);
  const [practiceFailure, setPracticeFailure] = useState<{ kind: GatewayFailureKind; message: string } | null>(null);
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
  const [historyOpen, setHistoryOpen] = useState(false);
  const [options, setOptions] = useState<GenerationOptions>(persistedGenerationOptions);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const generationTriggerRef = useRef<HTMLButtonElement>(null);
  const closeGenerationSetup = () => {
    generationTriggerRef.current?.focus();
    setOptionsOpen(false);
  };
  const [feedbackReasons, setFeedbackReasons] = useState<readonly DesktopCardGenerationFeedbackReasonV2[]>([]);
  const [feedbackNote, setFeedbackNote] = useState("");
  const [versions, setVersions] = useState<readonly DesktopNoteVersionItem[] | null>(null);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionsFailure, setVersionsFailure] = useState<string | null>(null);
  const [restoringVersionId, setRestoringVersionId] = useState<string | null>(null);
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

    // 核心路线（§4.4）。**失败要说得出来**——与上面那两读"自己吞异常"刻意不同：
    // 记录那两块是增补，读不到最多那一块不出现；而册页一旦画成空的，读的人会以为
    // 「这一篇没有核心问题」，那是内容状态而不是读取失败（§13.4）。
    let routeCoverage: NotebookProjection["routeCoverage"] = null;
    let routeCoverageFailure: NotebookProjection["routeCoverageFailure"] = null;
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
  }, [activeNoteRef?.noteId]);

  // A note with an unresolved factual warning should open on the learning leaf,
  // where the original quote and its reason live. This makes a next-day return
  // surface the caution immediately without taking the reader away from the
  // familiar notebook HUD; choosing another paper tab remains under the
  // reader's control.
  useEffect(() => {
    if (!data) return;
    const hasUnresolvedSuspectClaim = Boolean(data.roundTeachingView?.teaching?.content.suspectClaims?.length);
    if (!hasUnresolvedSuspectClaim) {
      autoFocusedSuspectNoteRef.current = null;
      return;
    }
    if (autoFocusedSuspectNoteRef.current === data.note.noteId) return;
    autoFocusedSuspectNoteRef.current = data.note.noteId;
    setLeaf("learning");
  }, [data?.note.noteId, data?.roundTeachingView]);

  // The pill returns to whatever opened this note: the library, the
  // card-generation workbench the reader stepped out of, or the star map a
  // star was clicked on. It never skips a level up to the study room.
  useEffect(() => {
    const returnTo = useRoomStore.getState().noteReturnTo;
    setReturnTarget(returnTo === "generation"
      ? { label: "返回生成任务", run: () => invoke("open-card-generation") }
      : returnTo === "graph"
        ? { label: "返回星图", run: () => invoke("graph") }
        : { label: "返回笔记库", run: () => invoke("open-notes") });
    return () => setReturnTarget(null);
  }, [invoke, setReturnTarget]);

  const note = data?.note ?? null;
  useEffect(() => {
    if (!activeNoteRef?.learningRoundId || note?.noteId !== activeNoteRef.noteId ||
      reflectionRoundId !== activeNoteRef.learningRoundId || leaf !== "history" || mode !== "read") return;
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
  useEffect(() => {
    if (!data || !activeNoteRef?.learningRoundId) return;
    const key = `${data.note.noteId}:${activeNoteRef.learningRoundId}`;
    if (handledRoundReturnRef.current === key) return;
    handledRoundReturnRef.current = key;
    // 「回到本轮学习」这颗按钮承诺的是**这一轮**，不是这篇文章。
    // 此前只在"轮次已经结束"时切到 history；轮次还开着的那一支什么都不做，
    // 于是落点停在 leaf 的默认值 reading——按的是"回到本轮学习"，看到的是正文。
    if (openRound) setLeaf("learning");
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
  const editable = Boolean(note?.permissions.canEdit);
  const canSave = Boolean(note?.permissions.canSave);
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
  const noteDocLive = useNoteDocLiveView(
    note?.noteId ?? null,
    spaceIdentity !== null && !spaceIdentity.isPersonal,
    () => {
      void reload({ silent: true });
    },
    presenceName,
    epochRef,
  );
  // 标题只有一个事实源：文档 `meta` 里那一份（起点还没到时退回这次回读的那一份）。
  // 界面上只留"本机改过、还没写进文档"的那一段，所以别人的改名会跟着上屏，
  // 而我正在改的那一段不会被盖掉——两件事共用同一条判据 `draft.title !== null`。
  const docTitle = noteDocLive.title.trim() || note?.title || "";
  const titleValue = draft.title ?? docTitle;
  // "有没有待提交"问文档，不问界面上的文本拷贝：拷贝落后于文档时两种判断都会算错，
  // 实测过的最坏结局就是拿落后那份去覆盖。标题这一半得单独判——它在文档里是一份
  // LWW 文本，没有"攒着没发的增量"可看。
  const titleEdited = draft.title !== null && draft.title !== docTitle;
  const dirty = noteDocLive.dirty || titleEdited;
  // 正文也只有一个来源了：这一份文档。它既含别人写进来的，也含本机还没交出去的，
  // 所以不必在"帧"和"回读"之间二选一（那两个来源并存正是上一次覆盖的根）。
  const readSourceBlocks = noteDocLive.blocks.length ? noteDocLive.blocks : (note?.currentVersion.blocks ?? []);
  /**
   * 这一屏的正文来自哪里（审计 F35）。实时文档优先、没有才退回当前版本——这正是
   * 上一行那个判据；标签必须跟着它。以前一边渲染未定版的实时文档、一边写
   * "不可变版本：v1"，而 v1 本身是空的：那句话是假的，用户以为自己在读一个已定版的版本。
   */
  const readingUnversionedContent = noteDocLive.blocks.length > 0;
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
  const hiddenBlockCount = allBlocks.length - readingBlocks.length;
  const readingSections = useMemo(
    () => notebookReadingSectionsV1(allBlocks),
    [allBlocks],
  );
  const visibleReadingSections = showAllReadingSections
    ? readingSections
    : readingSections.slice(0, NOTEBOOK_STRUCTURE_PAGE_SIZE_V1);
  const hiddenReadingSectionCount = readingSections.length - visibleReadingSections.length;

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
  /**
   * 点一颗依据：滚到那一段并短暂高亮。`scrollIntoView` **不用 smooth**——动效是
   * 产品设置里的一档（那套在 D4 那一侧），这一处只负责"看得见"；高亮自己过期撤掉，
   * 不留"上次点过哪"这种会跟人走的读数。
   */
  const locateTeachingReference = (ordinal: number): void => {
    setLeaf("reading");
    if (!readingBlocks.some((block) => block.ordinal === ordinal)) setShowAllBlocks(true);
    setFocusedBlockOrdinal(ordinal);
  };
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
  const [lastReadingTop, setLastReadingTop] = useState<number | null>(null);
  const enterLearning = (): void => {
    setLastReadingTop(leafScrollRef.current?.scrollTop ?? 0);
    setLeaf("learning");
  };
  const backToReading = (options: { restorePlace?: boolean } = {}): void => {
    if (options.restorePlace) pendingReadingTopRef.current = lastReadingTop;
    setLeaf("reading");
  };

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
      setMode(note.permissions.canEdit && activeNoteRef?.mode === "edit" ? "edit" : "read");
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
      if (written.via !== "unchanged") applyDraft({ ...draftRef.current, title: null });
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

  // The writer's generation settings are a session choice, like the library's view.
  useEffect(() => {
    persistedGenerationOptions = options;
  }, [options]);

  // Debounced autosave: the save-line reports the server receipt, never a local guess.
  // A failed save is sticky: the effect must not re-arm, or every AUTOSAVE_DELAY_MS
  // would flip the save-line between "正在保存…" and the failure notice — the
  // flicker. Recovery paths: the "重试保存" button, or a new keystroke (the
  // effect below clears the error so the debounce restarts naturally).
  // Debounced autosave. 依赖里**不能有 `save` 或 `note` 对象**：这一屏每几秒就有一次
  // 静默回读带来一个新的 `data`，`save` 因此换身份，定时器被"清理—重挂"反复归零——
  // 实窗量到的正是这个：文档明明脏着（标签「草稿」），自动保存却永远不触发，
  // 本机那几句话从来没有交出去过。走 `saveRef`（每个渲染都刷新）就不需要那些身份。
  useEffect(() => {
    if (mode !== "edit" || !canSave || !dirty || saving || saveState === "error") {
      return undefined;
    }
    const timer = window.setTimeout(() => { saveRef.current(); }, AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [canSave, dirty, mode, saveState, saving]);

  // Editing again after a failed save clears the sticky error so autosave can
  // resume. Keyed on the draft object, which only changes on real input — the
  // failed save itself leaves the draft untouched and the error stays put.
  useEffect(() => {
    setSaveState((current) => (current === "error" ? "idle" : current));
  }, [draft]);

  // Leaving the page while the debounce is still pending must not drop keystrokes.
  // The ref is refreshed in an effect (not during render) so the unmount save
  // always closes over the latest draft without a render-phase side effect.
  useEffect(() => {
    saveRef.current = () => { void save("auto"); };
  });
  useEffect(() => () => saveRef.current(), []);

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
  const paperAcceptsImages = mode === "edit" && editable;
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
    if (!api || !note || dirty || startingGeneration || !generationEnabled) return;
    setStartingGeneration(true);
    setGenerationFailure(null);
    try {
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
      setActiveCardGenerationRunId(accepted.runId);
      setFeedbackReasons([]);
      setFeedbackNote("");
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
   * W7-3 刀三：这一颗目标的「暂不安排」／「恢复并开启」（39 §9.1 行 2、行 3）。
   *
   * 三件在这一发里定下来的事：
   *  1. **成功后必须回读**（`reload({silent:true})`），屏上那枚纸签与那颗按钮
   *     换不换，由**服务端存下来的那一条**说了算——不是本地把 state 改一下。
   *     本地改的后果是这一页说"暂不安排"而库里没有，下一次回读又变回去。
   *  2. **回执要念出来**（`objectiveHoldNotice` / `objectiveResumeNotice`），
   *     尤其是「顺手撤下了 N 条」与「沿用已经排好的安排」两句：它们是这一发
   *     唯一能让用户看见后果的地方（§9.1"操作时说明"）。
   *  3. **失败不吞**：409（`still_held`）与网络失败都走 `reviewHoldError`，
   *     且**清掉**上一次的成功回执——两句话同时挂着会读成"没生效但有结果"。
   */
  const runObjectiveReviewHoldAction = async (kind: "hold" | "resume") => {
    const api = desktopApi();
    const currentNote = data?.note ?? null;
    const target = noteObjective;
    if (!api || !currentNote || !target || reviewHoldBusy) return;
    setReviewHoldBusy(kind);
    setReviewHoldError(null);
    setReviewHoldNotice(null);
    try {
      const request = { noteId: currentNote.noteId, objectiveId: target.objectiveId };
      if (kind === "hold") {
        const response = await api.review.holdObjective({ meta: createRequestMeta(epochRef.current), request });
        if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
        setReviewHoldNotice(objectiveHoldNotice(unwrapGatewayResult(response)));
      } else {
        const response = await api.review.resumeObjective({ meta: createRequestMeta(epochRef.current), request });
        if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
        setReviewHoldNotice(objectiveResumeNotice(unwrapGatewayResult(response)));
      }
      await reload({ silent: true });
    } catch (error) {
      setReviewHoldError(gatewayErrorMessage(error));
    } finally {
      setReviewHoldBusy(null);
    }
  };

  /**
   * W7-3 刀六：这一篇的**笔记订阅**开／停（39 §9.1 第一段与规则表行 1）。
   *
   * 两处与「暂不安排」那一族同源、且都写在这里而不是散进 JSX：
   *  1. 成功后**回读**。开关拨完之后屏上那个"开／关"必须来自服务端存下来的那一条，
   *     不是本地改 state——本地改的后果是这一页说"已停用"而库里没有。
   *  2. 回执**整句念出来**。§9.1 规则表行 1「其他来源仍有效时**显示原因**」是
   *     那一格存在的理由：停笔记订阅而那张卡还单独开着时，只说"已停用"会让用户
   *     以为整篇都不提醒了。`reviewSubscriptionNotice` 按 `stillCoveredBy` 分两句。
   */
  const runNoteSubscriptionAction = async (kind: "activate" | "pause") => {
    const api = desktopApi();
    const currentNote = data?.note ?? null;
    if (!api || !currentNote || subscriptionBusy) return;
    setSubscriptionBusy(kind);
    setSubscriptionError(null);
    setSubscriptionNotice(null);
    try {
      const request = { source: "note_subscription" as const, subjectId: currentNote.noteId };
      const response = kind === "activate"
        ? await api.review.activateSubscription({ meta: createRequestMeta(epochRef.current), request })
        : await api.review.pauseSubscription({ meta: createRequestMeta(epochRef.current), request });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      setSubscriptionNotice(reviewSubscriptionNotice(unwrapGatewayResult(response)));
      await reload({ silent: true });
    } catch (error) {
      setSubscriptionError(gatewayErrorMessage(error));
    } finally {
      setSubscriptionBusy(null);
    }
  };

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

/**
   * 「先讲讲这一节」：让服务端生成这一轮当前问题下的一条解释（W4-6 刀二）。
   *
   * 三件事刻意与别的写动作同一形状：①带 `expectedRevision`——两发之间问题被改写或
   * 轮次被收尾时，后到的那一发必须失败并拿到现在那一版；②成功后走 silent 回读，
   * 屏上那句解释来自服务端存下来的那一条，不是本机拼的；③失败也要回读一次，
   * 把屏上换回现在那一版（§16.39 那条一样的道理）。
   */
  const startRoundTeaching = async (regenerate = false, personalReflectionIds = teachingReflectionIds) => {
    const api = desktopApi();
    if (!api || !openRound || teachingBusy) return;
    setTeachingBusy(true);
    setTeachingFailure(null);
    try {
      const response = await api.noteLearningRound.explain({
        meta: createRequestMeta(epochRef.current),
        roundId: openRound.roundId,
        expectedRevision: openRound.revision,
        personalReflectionIds,
        // 「换一种解释」走同一发：服务端据此**跳过复用**，在同一问题下落第二条（序号 +1）。
        ...(regenerate ? { regenerate: true } : {}),
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      unwrapGatewayResult(response);
      setTeachingReflectionIds([]);
      await reload({ silent: true });
    } catch (error) {
      setTeachingFailure(classifyGatewayError(error));
      await reload({ silent: true });
    } finally {
      setTeachingBusy(false);
    }
  };

  /** Prepare a bounded first attempt from this saved snapshot without revealing the explanation. */
  const prepareRoundPractice = async () => {
    const api = desktopApi();
    if (!api || !openRound || practiceBusy) return;
    setPracticeBusy(true);
    setPracticeFailure(null);
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
      setPracticeBusy(false);
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
    setPracticeBusy(true);
    setPracticeFailure(null);
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
      setPracticeBusy(false);
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
  useEffect(() => {
    if (leaf !== "history" || !reflectionRoundId || !note || selectedHistoryMasked) return;
    let cancelled = false;
    setInspectedRoundBusy(true);
    setInspectedRoundFailure(null);
    const api = desktopApi();
    if (!api) {
      setInspectedRoundBusy(false);
      setInspectedRoundFailure("这一轮暂时读不到，请稍后重试。");
      return;
    }
    void api.noteLearningRound.teaching({
      meta: createRequestMeta(epochRef.current),
      roundId: reflectionRoundId,
    }).then((response) => {
      if (cancelled) return;
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      setInspectedRound({ roundId: reflectionRoundId, view: unwrapGatewayResult(response) });
    }).catch((error) => {
      if (!cancelled) setInspectedRoundFailure(gatewayErrorMessage(error));
    }).finally(() => {
      if (!cancelled) setInspectedRoundBusy(false);
    });
    return () => { cancelled = true; };
  }, [leaf, reflectionRoundId, note?.noteId, selectedHistoryMasked, historyInspectRevision]);
  /**
   * 那句总数只读**服务端报的那一格**：`historyItems.length` 回答的是"这一屏列了几轮"，
   * 不是"这一篇开过几轮"——翻过一页之后两者会分叉（§16.16 后半要的是后者）。
   */
  const historyTotal = historyTail?.totalCount ?? roundHistory?.totalCount ?? 0;
  const historyHasMore = historyTail ? historyTail.hasMore : (roundHistory?.hasMore ?? false);
  const historyNextCursor = historyTail ? historyTail.nextCursor : (roundHistory?.nextCursor ?? null);

  /** 「看更早的几轮」：带着游标再读一页，接在已经看到的那些后面（不覆盖）。 */
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

  const openGeneration = () => {
    if (!noteGeneration) return;
    setActiveCardGenerationRunId(noteGeneration.runId);
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
      editorRef.current?.toggleLink("https://");
    }
  };

  const runTool = (tool: EditorToolSpec) => {
    const editor = editorRef.current;
    if (editor) tool.run(editor);
  };

  const page: HudPageId = mode === "edit" ? "note-edit" : leaf === "learning" ? "note-learning" : leaf === "history" ? "note-history" : "note-read";
  useHudPage(page);

  const sourceTitle = source?.source.title ?? (note?.sourceId ? "来源暂时不可读" : "没有关联来源");
  const validationLabel = objective?.personal.lastCanonicalAt
    ? formatRelative(objective.personal.lastCanonicalAt)
    : "尚未开始";
  const firstSegment = segments[0] ?? null;
  /**
   * 那块资料卡片的名字：**屏上与给她的视图共用这一份**（两边各写一句迟早分叉，而分叉不报错）。
   * 以前它写的是 `来源片段 00`——那其实是首段的**序号**（0 基补零），可同一页上方还有一行
   * `来源片段 72` 是**条数**。同四个字在这块屏上表示两个数，她照着念就念出了
   * 「只挂了 1 段（标着「来源片段 00」）」这种自相矛盾的话（2026-09-25 真窗口量到）。
   */
  const firstSegmentClipLabel = firstSegment ? `第 ${firstSegment.ordinal + 1} 段来源片段` : "来源片段";
  // Dirty outranks the last receipt: after a save the state stays "committed"
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

  /**
   * 笔记页登记给伴星读的可读视图（doc 37 / 39d W2-2 的 P4-a）。
   *
   * 阅读（`note-read`）与编辑（`note-edit`）是**同一条服务端记录的两个模式**，所以共用
   * 一份视图、只按 `page` 分 `pageId`——像 `CardGenerationSurface` 那样一个调用点分两条。
   *
   * 每个字段都**照抄这一页已经在渲染的那一个派生值**，不另算一份：
   *  - `title` ← `titleValue`（`:1483` 标题输入框的 `value`，阅读页也是它）；
   *  - `statusLine` ← `saveLabel`（屏上那行保存状态，含 `●` 与相对时间）；
   *  - `metrics` ← `sourceTitle`（`:1314`「来源：{sourceTitle}」）、
   *    `validationLabel`（`:1320`「最近验证：{validationLabel}」）；
   *  - `items[0]` ← `firstSegment` 与屏上共用的 `firstSegmentClipLabel`（39d §19：以前这一格
   *    抄的是「来源片段 00」那种**序号当计数**的写法，与页眉的条数撞在同一个名词上）。
   *
   * 抄现成值而不是重算，是因为这条判据要的是「屏上那句话与视图字段逐字相同」；
   * 重算一份迟早会与屏上分叉，而分叉**不会报错**——`usePageReadableView` 那边不合合同
   * 只是不发布，症状仅仅是"她偶尔读不到这一页"。
   */
  const readableView = useMemo<PageReadableV1 | null>(() => {
    if (!note) return null;
    return {
      pageId: page === "note-edit" ? "note_edit" : "note_read",
      // 标题为空时屏上是一个空输入框；这里给的是这一页的名字，不是屏上文字。
      title: (titleValue.trim() || "未命名笔记").slice(0, 120),
      statusLine: saveLabel.slice(0, 160),
      metrics: [
        { label: "来源", value: sourceTitle.slice(0, 40) },
        { label: "最近验证", value: validationLabel.slice(0, 40) },
      ],
      ...(firstSegment
        ? {
            items: [{
              ordinal: 1,
              label: excerpt(firstSegment.text).slice(0, 120),
              state: firstSegmentClipLabel.slice(0, 40),
            }],
          }
        : {}),
    };
  }, [firstSegment, note, page, saveLabel, sourceTitle, titleValue, validationLabel]);
  usePageReadableView(readableView);

  const openSource = () => {
    if (!note?.sourceId) return;
    useRoomStore.getState().setActiveSourceId(note.sourceId);
    invoke("open-source");
  };

  // 模式跟随 activeNoteRef 走：从工作台"返回笔记"时，用户回到的是离开时的
  // 编辑/阅读模式，而不是每次都被重置成阅读页。
  const switchMode = (next: "read" | "edit") => {
    // The reading page renders the server version, so a draft still waiting for
    // the debounce has to be committed first — otherwise switching to 预览此版本
    // looked exactly like losing the last sentence.
    if (next === "read" && dirty && note?.permissions.canSave && !saving) void save("auto");
    setMode(next);
    const store = useRoomStore.getState();
    if (note && store.activeNoteRef?.noteId === note.noteId && store.activeNoteRef.mode !== next) {
      store.setActiveNoteRef({ ...store.activeNoteRef, mode: next });
    }
  };

  /**
   * The immutable versions of this note, read on demand. The list carries no
   * bodies: a version is read by making it current again, which is also the only
   * way back to text a save or a tool edit replaced.
   */
  const loadVersions = async () => {
    const api = desktopApi();
    const current = data?.note ?? null;
    if (!api || !current) return;
    setVersionsLoading(true);
    setVersionsFailure(null);
    try {
      const response = await api.note.versions({
        meta: createRequestMeta(epochRef.current),
        noteId: current.noteId,
        currentVersionId: current.currentVersionId,
        limit: 50,
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      setVersions(unwrapGatewayResult(response).items);
    } catch (error) {
      setVersionsFailure(gatewayErrorMessage(error));
    } finally {
      setVersionsLoading(false);
    }
  };

  const restoreVersion = async (version: DesktopNoteVersionItem) => {
    const api = desktopApi();
    const current = data?.note ?? null;
    if (!api || !current || restoringVersionId) return;
    setRestoringVersionId(version.versionId);
    setVersionsFailure(null);
    try {
      const response = await api.note.restoreVersion({
        meta: createRequestMeta(epochRef.current),
        noteId: current.noteId,
        versionId: version.versionId,
        baseVersionId: current.currentVersionId,
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      unwrapGatewayResult(response);
      await reload();
      await loadVersions();
    } catch (error) {
      setVersionsFailure(`恢复未确认：${gatewayErrorMessage(error)}`);
    } finally {
      setRestoringVersionId(null);
    }
  };

  const statePaper = loading ? (
    <SurfaceDataState kind="loading" message="正在读取真实笔记" detail="先确认工作区、Note identity 与当前版本。" />
  ) : failure ? (
    <SurfaceDataState kind="error" message="研究册暂时不可用" detail={failure} onRetry={() => void reload()} />
  ) : !note ? (
    <SurfaceDataState kind="empty" message="当前学习空间还没有主笔记" detail="这篇笔记没有给出可编辑的版本，这一页不会在本机另存草稿。" />
  ) : null;

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
      </div>
    </div>
  );

  // One generation entry shared by the reading and editor action rows. With a
  // live run it navigates to the workbench (never starts a second run, so it
  // ignores `dirty` — viewing progress needs no clean save); without one it
  // starts a generation from the committed whole-note version.
  const generationAction = noteGeneration ? (
    <button
      type="button"
      className="button"
      title="这次生成在后台进行，来回翻看不会打断它"
      onClick={openGeneration}
    >
      {isCardGenerationInFlight(noteGeneration.status)
        ? <LoaderCircle className="run-spinner" size={15} aria-hidden="true" />
        : <Sparkles size={15} aria-hidden="true" />}
      {cardGenerationEntryLabel(noteGeneration.status)}
    </button>
  ) : (
    <button
      type="button"
      ref={generationTriggerRef}
      className="button"
      disabled={!generationEnabled || startingGeneration}
      title={generationReason ?? "查看本次学习卡生成方案"}
      onClick={() => setOptionsOpen(true)}
    >
      <Sparkles size={15} aria-hidden="true" />
      {startingGeneration ? "正在创建生成任务…" : "制作学习卡"}
    </button>
  );

  const generationLiveNote = noteGeneration ? (
    <>
      <p className="small notebook-note notebook-generation-live" role="status">
        学习卡{cardGenerationStatusLabel(noteGeneration.status)} · 后台进行中，可随时回到本页，进度不会丢失。
      </p>
      {/* 39d W4-4：这次生成若被规模上限截断过，就在这儿说明白——"这一批只读到前半篇"
          不能让用户以为整篇都被读过（读数来自服务端投影，不是这一页算的）。 */}
      {noteGeneration.sourceCapped ? (
        <p className="small notebook-note notebook-generation-capped" role="status">
          {sourceCappedNotice(noteGeneration.sourceCapped)}
        </p>
      ) : null}
    </>
  ) : null;

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
        <section className="version-history" aria-label="笔记版本历史">
          <h3 className="serif">版本历史</h3>
          <p className="small">
            每次提交都会留下一个不可变版本。恢复会把这篇笔记切回那一版，不会删除任何版本。
          </p>
          {versionsLoading ? <p className="small" role="status">正在读取版本历史…</p> : null}
          {!versionsLoading && versionsFailure ? (
            <p className="small notebook-note" role="alert">
              {versionsFailure}
              <button type="button" className="text-action text-action--strong" onClick={() => void loadVersions()}>
                重新读取
              </button>
            </p>
          ) : null}
          {!versionsLoading && !versionsFailure && versions?.length === 0 ? (
            <p className="small">这篇笔记还没有可列出的版本。</p>
          ) : null}
          {!versionsLoading && !versionsFailure && versions?.length ? (
            <ul className="version-list">
              {versions.map((version) => (
                <li key={version.versionId} className={version.current ? "current" : undefined}>
                  <span className="version-no">v{version.versionNo}</span>
                  <span className="version-time">{formatRelative(version.createdAt)}</span>
                  {version.current ? (
                    <span className="version-tag">当前版本</span>
                  ) : (
                    <button
                      type="button"
                      className="text-action text-action--strong"
                      disabled={!editable || dirty || restoringVersionId !== null}
                      title={!editable
                        ? "你在这个空间是只读身份，不能改写这篇笔记的版本"
                        : dirty
                          ? "先提交或撤销当前编辑，再恢复历史版本"
                          : "把这篇笔记切回这一版，不删除任何版本"}
                      onClick={() => void restoreVersion(version)}
                    >
                      {restoringVersionId === version.versionId ? "正在恢复…" : "恢复这一版"}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </>
  );

  // The run contract's knobs live in a full-screen planning sheet so both
  // reading and editing mode can reach the same deliberate start step.
  const generationSetup = optionsOpen && generationEnabled ? createPortal(
        <div className="generation-setup-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeGenerationSetup(); }}>
        <section className="generation-setup" role="dialog" aria-modal="true" aria-labelledby="generation-setup-title" onKeyDown={(event) => {
          if (event.key === "Escape") { event.stopPropagation(); closeGenerationSetup(); }
          if (event.key !== "Tab") return;
          const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)")];
          const first = controls[0];
          const last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first && last) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last && first) { event.preventDefault(); first.focus(); }
        }}>
        <header className="generation-setup__header">
          <span className="generation-setup__eyebrow">从笔记到一叠新卡</span>
          <h2 id="generation-setup-title">安排这次出题</h2>
          <p>从已保存的整篇笔记出发。先选你想练的方向，生成后再逐张审核。</p>
          <button autoFocus type="button" className="generation-setup__close" aria-label="关闭生成方案" onClick={closeGenerationSetup}>×</button>
        </header>
        <fieldset className="generation-options">
          <legend>生成方案</legend>
          <div className="generation-options__row">
            <span className="generation-options__label">学习卡</span>
            {LEARNING_GOALS.map((item) => (
              <button
                key={item.value}
                type="button"
                className={options.learningGoal === item.value ? "chip on" : "chip"}
                aria-pressed={options.learningGoal === item.value}
                onClick={() => setOptions((current) => ({ ...current, learningGoal: item.value }))}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="generation-options__row">
            <span className="generation-options__label">详略</span>
            {DETAIL_THRESHOLDS.map((item) => (
              <button
                key={item.value}
                type="button"
                className={options.detailThreshold === item.value ? "chip on" : "chip"}
                aria-pressed={options.detailThreshold === item.value}
                onClick={() => setOptions((current) => ({ ...current, detailThreshold: item.value }))}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="generation-options__row">
            <span className="generation-options__label">卡片上限</span>
            {CARD_LIMITS.map((limit) => (
              <button
                key={limit}
                type="button"
                className={options.hardMaxCards === limit ? "chip on" : "chip"}
                aria-pressed={options.hardMaxCards === limit}
                onClick={() => setOptions((current) => ({ ...current, hardMaxCards: limit }))}
              >
                {limit} 张
              </button>
            ))}
          </div>
          <div className="generation-options__row">
            <span className="generation-options__label">学习卡型</span>
            {STRATEGIES.map((item) => {
              const on = options.preferredStrategies.includes(item.value);
              return (
                <button
                  key={item.value}
                  type="button"
                  className={on ? "chip on" : "chip"}
                  aria-pressed={on}
                  // The run contract wants at least one strategy; the last one on
                  // stays on rather than sending an empty list.
                  disabled={on && options.preferredStrategies.length === 1}
                  title={on && options.preferredStrategies.length === 1 ? "至少保留一种题型" : undefined}
                  onClick={() => setOptions((current) => ({
                    ...current,
                    preferredStrategies: on
                      ? current.preferredStrategies.filter((value) => value !== item.value)
                      : [...current.preferredStrategies, item.value],
                  }))}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
          {/* 让勾选成为筛选。顺序由 planner-service.allocateStrategies 按适配度定，
              与勾选顺序无关——这里说清，是因为默认值就是全勾选。 */}
          <p className="small">
            这些是每张卡的思考策略，不是作答按钮。默认允许全部七种；取消某种后，系统便不会采用它。
          </p>
          {feedbackTarget ? (
            <>
              <div className="generation-options__row">
                <span className="generation-options__label">针对上次</span>
                <span className="small">
                  上次生成{cardGenerationStatusLabel(feedbackTarget.status)} · {formatRelative(feedbackTarget.updatedAt)}
                  {feedbackReasons.length ? "" : "（选原因即按反馈重生成）"}
                </span>
              </div>
              <div className="generation-options__row">
                {FEEDBACK_REASONS.map((item) => {
                  const on = feedbackReasons.includes(item.value);
                  return (
                    <button
                      key={item.value}
                      type="button"
                      className={on ? "chip on" : "chip"}
                      aria-pressed={on}
                      onClick={() => setFeedbackReasons((current) => (on
                        ? current.filter((value) => value !== item.value)
                        : [...current, item.value]))}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>
              {feedbackReasons.length ? (
                <div className="generation-options__row">
                  <span className="generation-options__label">补充说明</span>
                  <input
                    className="generation-options__note"
                    value={feedbackNote}
                    maxLength={2000}
                    placeholder="可选，写给下一次生成的说明"
                    aria-label="重新生成的补充说明"
                    onChange={(event) => setFeedbackNote(event.currentTarget.value)}
                  />
                </div>
              ) : null}
            </>
          ) : null}
          <p className="small">
            本次：{generationOptionSummary(options)}
            {feedbackTarget && feedbackReasons.length
              ? ` · 按反馈重生成（${feedbackReasons
                .map((value) => FEEDBACK_REASONS.find((item) => item.value === value)?.label ?? value)
                .join("+")}）`
              : ""}
          </p>
        </fieldset>
        <footer className="generation-setup__footer">
          <p role={generationFailure ? "alert" : undefined}>{generationFailure ? `任务未开始：${generationFailure}` : dirty ? "请先保存当前改动，再从已保存版本开始生成。" : "生成在后台进行；候选写好后由你逐张决定。"}</p>
          <div>
            <button type="button" className="generation-setup__cancel" onClick={closeGenerationSetup}>再想想</button>
            <button type="button" className="generation-setup__start" disabled={dirty || startingGeneration || !generationEnabled} onClick={() => void startGeneration()}><Sparkles size={17} aria-hidden="true" />{startingGeneration ? "正在创建任务…" : "开始生成"}</button>
          </div>
        </footer>
        </section>
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

  const readPageBody = note ? (
    <>
      {leaf === "reading" ? <>
      <div className="version-ribbon">
        <span>
          {readingUnversionedContent
            ? "未定版的当前内容"
            : `版本 v${note.currentVersion.versionNo}`}
        </span>
        {segments.length > 0 ? <span>来源片段 {segments.length}</span> : null}
        <NotebookPresence peers={noteDocLive.presencePeers} selfName={presenceName} />
        {shareStateControls}
      </div>
      <h2 className="title">{readTitle || "未命名笔记"}</h2>
      <div className="meta">
        <span>{formatRelative(note.currentVersion.updatedAt)}</span>
        <span>{note.sourceId ? `关联来源 ${source?.source.title ?? "暂时读不到"}` : "未关联来源"}</span>
      </div>
      <section id="notebook-reading-leaf" className="notebook-leaf-page" aria-label="笔记正文">
      {allBlocks.length > READING_WINDOW && readingSections.length > 0 ? (
        <nav className="notebook-reading-outline" aria-label="正文小节目录">
          <div className="notebook-reading-outline__heading">
            <span className="notebook-reading-outline__title">从纸签跳读</span>
            <span className="notebook-reading-outline__hint">{readingSections.length} 枚纸签 · 点选回到正文原位</span>
            {readingSections.length > NOTEBOOK_STRUCTURE_PAGE_SIZE_V1 ? (
              <button
                type="button"
                className="notebook-reading-outline__toggle"
                aria-expanded={showAllReadingSections}
                onClick={() => setShowAllReadingSections((expanded) => !expanded)}
              >
                {showAllReadingSections ? "收起后面的纸签" : `看看另外 ${hiddenReadingSectionCount} 枚纸签`}
              </button>
            ) : null}
          </div>
          <ol>
            {visibleReadingSections.map((section, index) => {
              const contentLabel = section.bodyBlockCount > 0 ? "有正文" : "只有标题";
              return (
                <li key={section.startOrdinal}>
                  <button
                    type="button"
                    className="notebook-reading-outline__bookmark"
                    aria-label={`跳到${section.title}，${contentLabel}`}
                    data-reading-section-ordinal={section.startOrdinal}
                    onClick={() => locateTeachingReference(section.startOrdinal)}
                  >
                    <span className="notebook-reading-outline__name">
                      <span className="notebook-reading-outline__number" aria-hidden="true">{index + 1}</span>
                      <span>{section.title}</span>
                    </span>
                    <span className={`notebook-reading-outline__presence${section.bodyBlockCount === 0 ? " is-heading-only" : ""}`}>
                      {contentLabel}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>
      ) : null}
      <div className="reading-body" ref={readingBodyRef}>
        {readSourceBlocks.length ? readingBlocks.map((block) => (
          <ReadingBlock
            key={block.ordinal}
            block={block}
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
      </div>
      <div className="provenance-line">
        <span>来源：{sourceTitle}</span>
        <span>
          {readingUnversionedContent
            ? `未定版的当前内容 · 已存版本 v${note.currentVersion.versionNo}`
            : `不可变版本：v${note.currentVersion.versionNo} · ${note.currentVersion.contentHash.slice(0, 8)}`}
        </span>
        <span>最近验证：{validationLabel}</span>
      </div>
      {/* The pasted source clips read as part of the provenance cluster, so they
          sit in the flow right after it. They used to hang absolute off the
          paper's right edge; real excerpts ran long and the sticky notes
          covered body text and table columns. */}
      {clips}
      </section>
      </> : null}
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
            <button type="button" className="round-bookmark" onClick={() => backToReading()}>回到正文</button>
            {lastReadingTop !== null && lastReadingTop > 0
              ? <button type="button" className="round-bookmark" onClick={() => backToReading({ restorePlace: true })}>回到刚才读的那一段</button>
              : null}
            <p className="round-desk__note">{readTitle || "未命名笔记"}</p>
          </div>

          <div className="round-desk__body">
            {/* ── 左栏：顺着读的那条线 ─────────────────────────────────── */}
            <div className="round-desk__line">
              {openRound ? (
                <figure className="round-slip round-slip--question" data-round-question>
                  <span className="round-tape" aria-hidden="true" />
                  <figcaption>这一轮要弄懂</figcaption>
                  <h2 className="round-slip__question">{openRound.drivingQuestion}</h2>
                </figure>
              ) : (
                <h2 className="round-desk__ask">想弄懂这篇里的哪一件事？</h2>
              )}

              {inFlightStep ? <RoundNotice kind="pending" message={inFlightStep} testId="round-inflight" /> : null}

              {learningScene === "unavailable" ? (
                <div className="round-slip round-slip--muted" aria-label="读取本轮状态失败">
                  <p>{roundTeachingFailure || "这一轮的当前步骤没有读到，暂时无法确定该从哪里继续。"}</p>
                  <p className="round-slip__aside">已经存下的讲解与作答都还在，不会被当成未开始。</p>
                </div>
              ) : null}

              {learningScene === "paused" ? (
                <div className="round-slip round-slip--paused" aria-label="这一轮暂停了">
                  <p className="round-slip__lead">这一轮停在这儿，留下的都还在。</p>
                  <dl className="round-ledger">
                    <div><dt>讲解</dt><dd>{roundTeaching ? `讲过 · ${roundRecordDayV1(roundTeaching.createdAt)}` : "还没讲过"}</dd></div>
                    <div><dt>练习</dt><dd>{roundPractices.length > 0
                      ? `做过 ${roundPractices.length} 次 · 最近一次 ${roundRecordDayV1(latestRoundPractice?.startedAt ?? roundPractices[0]!.startedAt)}`
                      : "还没试过"}</dd></div>
                    <div><dt>接下来</dt><dd>{roundNextStep ? roundTrackNextV1(roundNextStep.kind) : "这一轮的下一步暂时读不到"}</dd></div>
                  </dl>
                  <p className="round-slip__aside">接着学会接着原来的记录，不会重讲一遍，也不会让你从头再答。</p>
                  {roundFailure ? <RoundNotice kind={roundFailure.kind} message={roundFailure.message} onRetry={() => void reload({ silent: true })} retryLabel="重新读取这一轮" /> : null}
                </div>
              ) : null}

              {learningScene === "question" ? (
                openRound && !roundEditing ? (
                  <>
                    {openRoundContentMoved ? <p className="round-slip__aside" data-round-content-moved="true">{ROUND_COPY.contentMoved}</p> : null}
                    <NoteChangeImpactNotice impact={openRoundNoteChangeImpact} context="round" />
                    {/* 这一轮的两个岔口**只给按钮**。上一版在这里还写了一句"围绕这个问题，
                        可以直接看讲解，也可以先试一个小问题"——按钮自己已经把话说完了，
                        再复述一遍只是把纸面撑长（39f UI-4）。 */}
                    <div className="round-forks">
                      {roundNextStep?.kind === "explain"
                        ? <button type="button" className="round-stamp" disabled={practiceBusy || teachingBusy} onClick={() => void prepareRoundPractice()}>
                            {practiceBusy ? "正在准备…" : "先试一小问"}
                          </button>
                        : null}
                      {roundNextStep?.kind === "attempt" && !roundTeaching
                        ? <button type="button" className="round-stamp" disabled={teachingBusy} onClick={() => void startRoundTeaching(false)}>看讲解</button>
                        : null}
                      {roundNextStep?.kind === "explain" || (roundNextStep?.kind === "attempt" && !roundTeaching)
                        ? <button type="button" className="round-tab" disabled={practiceBusy || teachingBusy} onClick={() => {
                            const other = roundNextStep?.kind === "explain"
                              ? () => void startRoundTeaching(false)
                              : () => void prepareRoundPractice();
                            other();
                          }}>{roundNextStep?.kind === "explain" ? "改成先看讲解" : "改成先试一小问"}</button>
                        : null}
                    </div>
                    {data?.roundTeachingView?.plans.length ? (
                      <details className="round-flap">
                        <summary>这次会讲到哪</summary>
                        <div className="round-flap__sheet">
                          <ol>{data.roundTeachingView.plans.at(-1)!.plan.steps.map((step, index) => <li key={index}>{step.text}</li>)}</ol>
                          <p className="round-slip__aside">{data.roundTeachingView.plans.at(-1)!.plan.expectedScale}</p>
                        </div>
                      </details>
                    ) : null}
                  </>
                ) : (
                  <div className="round-ask">
                    <label htmlFor="notebook-round-question">写一句就行</label>
                    <input id="notebook-round-question" aria-label={ROUND_COPY.ask} className="round-ask__line" value={roundDraft} maxLength={500} placeholder={ROUND_COPY.ask} disabled={roundBusy !== null} onChange={(event) => setRoundDraft(event.target.value)} />
                    <p className="round-slip__aside">下面几颗给的是问的方向，不是答案——挑一个，再改成你自己的话。</p>
                    {structureQuestions.length > 0 ? (
                      <div className="round-ask__from">
                        <span>从这篇的小节里挑</span>
                        {structureQuestions.map((candidate) => (
                          <button key={candidate.ordinal} type="button" className="round-tab round-tab--section" disabled={roundBusy !== null} onClick={() => { setRoundStarter(candidate.question); setRoundDraft(candidate.question); setRoundFailure(null); }}>
                            {candidate.label}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    <div className="round-ask__presets">
                      {ROUND_PRESETS_V1.map((preset) => (
                        <button key={preset.key} type="button" className="round-tab" disabled={roundBusy !== null} onClick={() => { setRoundStarter(preset.starter); setRoundDraft(preset.starter); setRoundFailure(null); }}>
                          {preset.label}
                        </button>
                      ))}
                    </div>
                    <div className="round-forks">
                      <button type="button" className="round-stamp" disabled={roundBusy !== null || saving || (openRound !== null && roundDraft.trim().length === 0)} onClick={() => void submitRoundQuestion(openRound ? "revise" : "start")}>
                        {roundSubmitLabelV1(roundBusy, openRound !== null)}
                      </button>
                      {!openRound && (dirty || saveState === "error")
                        ? <button type="button" className="round-tab" disabled={roundBusy !== null || saving} onClick={() => void submitRoundQuestion("start", "last_saved")}>按上次已保存内容开始</button>
                        : null}
                      {openRound ? <button type="button" className="round-tab" onClick={() => setRoundEditing(false)}>不改了</button> : null}
                    </div>
                  </div>
                )
              ) : null}

              {roundTeaching && (learningScene === "teaching" || reviewingTeaching || learningScene === "result") ? (
                <article className="round-prose" data-round-section="teaching" aria-label="本轮讲解">
                  <p className="round-prose__body">{roundTeaching.content.explanation}</p>
                  {roundTeaching.content.example ? (
                    <aside className="round-slip round-slip--example">
                      <p className="round-slip__label">看一个例子</p>
                      <p>{roundTeaching.content.example}</p>
                    </aside>
                  ) : null}
                  {roundTeaching.content.suspectClaims?.length ? (
                    <div className="round-slip round-slip--flag" aria-label="需要核对的事实主张">
                      <p className="round-slip__label">有几处说法要核对</p>
                      {roundTeaching.content.suspectClaims.map((claim, index) => (
                        <div key={`${claim.unitIds.join("-")}-${index}`} className="round-slip__item">
                          {claim.sourceQuote ? <blockquote>{claim.sourceQuote}</blockquote> : <p className="round-slip__aside">原文位置还没能可靠定位</p>}
                          <p>{claim.reason}</p>
                        </div>
                      ))}
                      <p className="round-slip__aside">核对前，这些说法不会成为正式的学习目标。</p>
                    </div>
                  ) : null}
                  {teachingReferences.length ? (
                    <details className="round-flap">
                      <summary>回到笔记里那句话</summary>
                      <div className="round-flap__sheet">{teachingReferences.map((item) => (
                        <button key={item.ordinal} type="button" className="round-tab" onClick={() => locateTeachingReference(item.ordinal)}>{item.label}</button>
                      ))}</div>
                    </details>
                  ) : !teachingSnapshotIsReadVersion ? <p className="round-slip__aside">{ROUND_COPY.teaching.staleVersion}</p> : null}
                  {roundTeaching.personalSources?.length ? (
                    <details className="round-flap">
                      <summary>这次参考的个人理解</summary>
                      <div className="round-flap__sheet">
                        <ul>{roundTeaching.personalSources.map((item) => <li key={item.reflectionId}>{item.source.question} · 私有备注第 {item.revision} 版</li>)}</ul>
                        <p className="round-slip__aside">这些内容只作本人理解背景，不作笔记依据或正式判定。</p>
                      </div>
                    </details>
                  ) : null}
                </article>
              ) : null}

              {learningScene === "practice" && !reviewingTeaching ? (
                <div className="round-bench" aria-label="继续练习">
                  {/* 就地作答，不跳页（2026-09-28 用户裁决）。挂的是同一个
                      `LearningRunBody`——状态机、草稿自动保存、闸门与结算一条没改，
                      改的只是它在树上挂在哪里；离开这一轮走的也是同一个 `onExit`
                      （含主进程那道 `FormalAssessmentGuard` 释放），两条路不会长出两套收尾。 */}
                  {inlineRoundRunId ? (
                    <>
                      <p className="round-slip__aside">写下的内容会自己存着，中途离开也能接着做。</p>
                      <LearningRunBody
                        runId={inlineRoundRunId}
                        onExit={(request) => { void exitInlineRoundRun(request); }}
                        onPageChange={setInlineRunPage}
                      />
                    </>
                  ) : <p>这一道已经在答了。回到那道题作答，结果会自动接回这一轮。</p>}
                  {roundPractices.length > 1 ? (
                    <details className="round-flap">
                      <summary>这一轮之前做过的 {roundPractices.length - 1} 道</summary>
                      <div className="round-flap__sheet">
                        <ol className="round-runlist">{roundPractices.slice(0, -1).map((practice) => (
                          <li key={practice.runId}>
                            <span>{roundRecordDayV1(practice.startedAt)} · {roundPracticeStateLabelV1(practice)}</span>
                            <button type="button" className="round-tab" onClick={() => { void openRoundPractice(practice.runId); }}>看这一次</button>
                          </li>
                        ))}</ol>
                      </div>
                    </details>
                  ) : null}
                  {roundFailure ? <RoundNotice kind={roundFailure.kind} message={roundFailure.message} onRetry={() => void reload({ silent: true })} retryLabel="重试这一步" /> : null}
                </div>
              ) : null}

              {learningScene === "result" && !reviewingTeaching ? (
                <div className="round-receipt" aria-label="本轮结果">
                  <p className="round-slip__label">这一轮的收获</p>
                  <p className="round-receipt__today">{roundResultCopy.today}</p>
                  <p className="round-receipt__gap">{roundResultCopy.gap}</p>
                  <p className="round-receipt__next">{roundResultCopy.next}</p>
                  <p className="round-slip__aside">这里说的是这一道题的证据；它不代替整篇笔记的掌握判断。</p>
                  {roundPractices.length ? (
                    <details className="round-flap">
                      <summary>这一轮的 {roundPractices.length} 次作答</summary>
                      <div className="round-flap__sheet">
                        <ol className="round-runlist">{roundPractices.map((practice) => (
                          <li key={practice.runId}>
                            <span>{roundRecordDayV1(practice.startedAt)} · {roundPracticeStateLabelV1(practice)}</span>
                            <button type="button" className="round-tab" onClick={() => { void openRoundPractice(practice.runId); }}>看这一次</button>
                          </li>
                        ))}</ol>
                      </div>
                    </details>
                  ) : null}
                  {roundGapHelp?.stopped ? (
                    <details className="round-flap">
                      <summary>这次需要换一种帮助</summary>
                      <div className="round-flap__sheet">
                        <p className="round-slip__aside">{ROUND_COPY.teaching.stopLead(roundGapHelp.consecutiveHelpCount)}</p>
                        <button type="button" className="round-stamp" disabled={teachingBusy || roundBusy !== null} onClick={() => { setReviewingTeaching(true); void startRoundTeaching(true, teachingReflectionIds); }}>
                          {teachingBusy ? ROUND_COPY.teaching.starting : ROUND_COPY.teaching.switchExplanation}
                        </button>
                        {teachingReferences[0] ? <button type="button" className="round-tab" onClick={() => locateTeachingReference(teachingReferences[0]!.ordinal)}>{ROUND_COPY.teaching.backToMaterial}</button> : null}
                        {data?.roundTeachingView?.prerequisite.kind === "candidate" ? (
                          <p className="round-slip__aside">可能需要先补：{data.roundTeachingView.prerequisite.label}（约 {data.roundTeachingView.prerequisite.estimatedSteps} 步）。
                            <button type="button" className="round-tab" onClick={() => { setRoundDraft(data.roundTeachingView!.prerequisite.kind === "candidate" ? data.roundTeachingView!.prerequisite.label : openRound?.drivingQuestion ?? ""); setRoundStarter(null); setRoundEditing(true); }}>改为先学这个</button>
                          </p>
                        ) : null}
                      </div>
                    </details>
                  ) : null}
                </div>
              ) : null}

              {learningScene === "question" ? (
                <>
                  {roundFailure ? <RoundNotice kind={roundFailure.kind} message={roundFailure.message} onRetry={() => void reload({ silent: true })} retryLabel="重试这一步" secondary={<button type="button" className="round-tab" disabled={roundBusy !== null} onClick={() => void endNoteRound()}>先到这里</button>} /> : null}
                  {teachingFailure ? <RoundNotice kind={teachingFailure.kind} message={teachingFailure.message} onRetry={() => { void startRoundTeaching(true, teachingReflectionIds); }} retryLabel="换一种讲解" /> : null}
                  {practiceFailure ? <RoundNotice kind={practiceFailure.kind} message={practiceFailure.message} onRetry={() => void startRoundPractice()} retryLabel="再试一次" secondary={<button type="button" className="round-tab" disabled={roundBusy !== null} onClick={() => void endNoteRound()}>先到这里</button>} /> : null}
                  {roundLostDraft ? (
                    <div className="round-slip round-slip--muted" data-round-lost>
                      <p>{ROUND_COPY.lostDraft(roundLostDraft.question)}</p>
                      <div className="round-forks">
                        <button type="button" className="round-stamp" onClick={() => { setRoundDraft(roundLostDraft.question); setRoundStarter(roundLostDraft.starter); setRoundLostDraft(null); setRoundEditing(true); }}>{ROUND_COPY.applyLost}</button>
                        <button type="button" className="round-tab" onClick={() => setRoundLostDraft(null)}>{ROUND_COPY.dropLost}</button>
                      </div>
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>

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
      {leaf === "history" ? <section id="notebook-history-leaf" className="notebook-leaf-page notebook-journey" aria-label="学习记录">
        <div className="notebook-journey__header"><button type="button" className="text-action" onClick={() => setLeaf("reading")}>← 回笔记正文</button><span className="notebook-journey__note">{readTitle || "未命名笔记"}</span><h2>这篇笔记的学习足迹</h2><p>从这里回看做过的事；以后是否安排复习由你决定。</p></div>
      {/* 这一篇的轮次记录（PRD §10.3 读侧第一刀）。没有历史时一行都不多——空数组
          与"这篇还没开过轮"是同一件事，不必对用户播报；读失败也不报（这块是增补）。 */}
      {historyItems.length > 0 ? (
        <section className="notebook-round-history">
          <p className="small notebook-note">{ROUND_COPY.historyLead(historyTotal, historyItems.length, historyHasMore)}</p>
          <ol className="notebook-round-history__list">
            {historyItems.map((item) => (
              <li key={item.roundId}>
                <span className="small notebook-round-history__day">{roundRecordDayV1(item.startedAt)}</span>
                <span className="small notebook-round-history__state">{roundHistoryStateLabelV1(item)}</span>
                <span className="notebook-round-history__question">{item.drivingQuestion}</span>
                {!("contentMasked" in item && item.contentMasked) ? <button type="button" className="text-action" onClick={() => {
                  setReflectionRoundId(item.roundId);
                  requestAnimationFrame(() => {
                    historyDetailRef.current?.scrollIntoView?.({ block: "start" });
                  });
                }}>查看这一轮</button> : null}
                {item.actualModes.length > 0 ? (
                  <span className="small notebook-round-history__modes" data-round-history-modes="true">
                    {roundRecordModesLabelV1(item.actualModes)}
                  </span>
                ) : null}
                {item.followUpSettledAt ? (
                  <span className="small notebook-round-history__follow-up" data-round-history-follow-up="true">
                    {ROUND_COPY.followUp(roundRecordDayV1(item.followUpSettledAt))}
                  </span>
                ) : null}
                {item.systemUncertain ? (
                  <span className="small notebook-round-history__uncertain" data-round-history-uncertain="true">
                    {ROUND_COPY.historyUncertain}
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
          {historyHasMore ? (
            <button type="button" className="button" disabled={olderBusy} onClick={() => void loadOlderRounds()}>
              {olderBusy ? ROUND_COPY.loadingOlder : ROUND_COPY.loadOlder}
            </button>
          ) : null}
          {olderFailure ? <p className="small notebook-note" role="alert">{olderFailure}</p> : null}
        </section>
      ) : null}
        {/* 这一篇的核心路线册页（PRD §4.4；39d W4-5 ③）。摆在记录**上面**：
            「这一篇走到哪」是那一页要答的第一句，而记录是它的证据。两者都空时
            下面那个空态才出现——空态那一格说的是"还没留下学习记录"，而册页说的
            是"还没有核心路线"，两句不能互相顶替。 */}
        <NoteRouteCoverage
          coverage={routeCoverage}
          failure={routeCoverageFailure}
          onInspectRound={(roundId) => {
            setReflectionRoundId(roundId);
            setLeaf("history");
            requestAnimationFrame(() => {
              historyDetailRef.current?.scrollIntoView?.({ block: "start" });
            });
          }}
        />
        {reflectionRoundId ? (
          <section ref={historyDetailRef} className="notebook-round-recap" aria-label="这一轮回看" data-round-recap="true">
            <h4>这一轮回看</h4>
            {selectedHistoryMasked ? <p>这轮的内容已按当前权限遮蔽。</p> : inspectedRoundBusy ? (
              <p role="status">正在翻开这一轮的记录…</p>
            ) : inspectedRoundFailure ? (
              <p role="alert">记录没读到：{inspectedRoundFailure}<button type="button" className="text-action" onClick={() => setHistoryInspectRevision((value) => value + 1)}>重试</button></p>
            ) : inspectedRound?.roundId === reflectionRoundId ? (
              <>
                <p className="notebook-round-recap__question">{inspectedRound.view.round.drivingQuestion}</p>
                <p className="small notebook-note">这一轮{selectedHistoryItem ? roundHistoryStateLabelV1(selectedHistoryItem) : "的记录"}。{inspectedRound.view.teaching ? "读过讲解" : "还没有讲解记录"}；{inspectedRound.view.practices.length ? `做过 ${inspectedRound.view.practices.length} 次练习` : "还没有练习记录"}。</p>
                {inspectedRound.view.practices.length ? (
                  <ul className="notebook-round-recap__practices">{inspectedRound.view.practices.map((practice) => (
                    <li key={practice.runId}>{roundRecordDayV1(practice.startedAt)} · {roundPracticeStateLabelV1(practice)} <button type="button" className="text-action" onClick={() => { void openRoundPractice(practice.runId); }}>查看这次作答</button></li>
                  ))}</ul>
                ) : null}
                {inspectedRound.view.teaching ? (
                  <details><summary>查看当时的讲解与例子</summary>
                    <p>{inspectedRound.view.teaching.content.explanation}</p>
                    {inspectedRound.view.teaching.content.example ? <p>例子：{inspectedRound.view.teaching.content.example}</p> : null}
                  </details>
                ) : null}
                <p className="small notebook-note">这轮没有涉及的内容和仍待核对的地方，见上方核心路线；练过一次不代表整篇已掌握。</p>
                <button type="button" className="text-action" onClick={() => {
                  reflectionShelfRef.current?.scrollIntoView?.({ block: "start" });
                  reflectionShelfRef.current?.querySelector("summary")?.focus();
                }}>查看或留下这一轮的理解</button>
              </>
            ) : null}
          </section>
        ) : null}
        {historyItems.length === 0 ? (
          <div className="notebook-history-empty">
            <History size={28} aria-hidden="true" />
            {roundHistory ? (
              <>
                <p>还没留下学习记录。</p>
                <p className="small">挑一个想弄懂的问题，开始后就会记在这里。</p>
                <button type="button" className="button primary" onClick={() => setLeaf("learning")}>去开始这一轮</button>
              </>
            ) : (
              <>
                <p role="status">学习记录暂时没读到。</p>
                <button type="button" className="button" onClick={() => void reload({ silent: true })}>重新读取记录</button>
              </>
            )}
          </div>
      ) : null}
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
      </section> : null}
      {(leaf === "learning" && learningScene === "result" && !reviewingTeaching && Boolean(openRound && (roundTeaching || roundPractices.length > 0))
        || leaf === "history" && Boolean(reflectionRoundId && inspectedRound?.roundId === reflectionRoundId && (inspectedRound.view.teaching || inspectedRound.view.practices.length > 0))) ? <div className="note-reflection-anchor" ref={reflectionShelfRef}><NoteReflectionShelf key={note.noteId} noteId={note.noteId} roundId={leaf === "history" ? reflectionRoundId : openRound?.roundId}
        refreshKey={`${roundTeaching?.teachingId ?? ""}:${roundPractices.map(p => `${p.runId}:${p.phase}`).join(",")}`}
        workspaceEpoch={epochRef.current} canAppend={canSave && Boolean(noteDocLive.fragment) && !saving} shared={note.shareScope === "shared"}
        openSources={leaf === "history" && Boolean(reflectionRoundId)}
        canUseForTeaching={leaf !== "history" && Boolean(openRound)}
        selectedForTeaching={teachingReflectionIds}
        onSelectionChange={setTeachingReflectionIds}
        onInspectBody={() => { setMode("read"); setLeaf("reading"); }}
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
      {leaf === "reading" && generationReason ? <p className="small notebook-note">{generationReason}</p> : null}
      {leaf === "reading" && generationFailure ? <p className="small notebook-note" role="alert">{generationFailure}</p> : null}
      {leaf === "reading" ? generationLiveNote : null}
      {leaf === "reading" ? historyPaper : null}
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
        className="button"
        aria-expanded={historyOpen}
        onClick={() => {
          const next = !historyOpen;
          setHistoryOpen(next);
          if (next) void loadVersions();
        }}
      >
        版本历史
      </button>
    </>
  ) : null;

  const readPageActions = note && leaf === "reading" ? (
    <div className="actions notebook-actions notebook-actions--reading">
      {!note.permissions.canEdit ? <span className="tag">只读</span> : null}
      <div className="notebook-actions__next">
        <span className="notebook-actions__why" title={openRound?.drivingQuestion ?? undefined}>{openRound ? `接着上次的问题：${openRound.drivingQuestion}` : "从这篇笔记选一个问题，直接开始学"}</span>
        <button type="button" className="button primary" onClick={enterLearning}>{openRound ? "继续学习" : "开始学习"}</button>
      </div>
      {note.permissions.canEdit ? (
        <button type="button" className="button" onClick={() => switchMode("edit")}>
          编辑笔记
        </button>
      ) : null}
      <details className="notebook-actions__extras"><summary>更多笔记操作</summary>
        <div className="notebook-actions__drawer">
          <button type="button" className="button" onClick={() => setLeaf("history")}>学习记录{historyTotal > 0 ? ` · ${historyTotal}` : ""}</button>
          {note.sourceId ? <button type="button" className="button" onClick={openSource}>查看关联来源</button> : null}
          {versionAndOptionsToggles}
          {generationAction}
        </div>
      </details>
    </div>
  ) : null;

  /**
   * 编辑页固定在纸面顶部的两条：状态/版本那一行，和格式工具栏。
   *
   * 它们原先随正文一起滚——一篇两屏的笔记里，写到第二屏就再够不到"预览此版本"，
   * 也看不到这一版提交没有。现在纸面是一个纵向 flex：这两条装进
   * `.notebook-chrome`（不参与滚动），只有 `.notebook-scroll` 里的正文滚动。
   */
  const editChrome = note ? (
    <div className="notebook-chrome">
      <div className="editor-head">
        <div>
          <span className="tag red">{dirty || saveState === "error" ? "草稿" : "已同步"}</span>
      <NotebookPresence peers={noteDocLive.presencePeers} selfName={presenceName} />
      {shareStateControls}
      {/* 自动保存并入正文，只有按「保存」才留下一个可回去的版本。左上角 HUD 那句
          "每次改动都会存成版本"讲的正是这件错的事——两处必须跟着同一句走。 */}
      <span className="small">改动会实时并入这一篇；点「保存」才存成一个可回去的版本</span>
        </div>
        <div className="meta">
          <span>{note.permissions.canSave ? "自动保存开启" : "当前身份不能保存"}</span>
          <span>版本 v{note.currentVersion.versionNo}</span>
          <button
            type="button"
            className="ribbon-action"
            onClick={() => switchMode("read")}
          >
            预览此版本
          </button>
        </div>
      </div>
      <div className="editor-tools" role="toolbar" aria-label="Markdown 格式工具">
        {EDITOR_TOOLS.map((tool) => (
          <button
            key={tool.label}
            type="button"
            className="tool"
            disabled={!editable}
            aria-label={tool.label}
            title={tool.title}
            // 命令作用在当前选区上，按下去那一下不能把焦点从正文抢走。
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => runTool(tool)}
          >
            {tool.glyph}
          </button>
        ))}
        <button
          type="button"
          className="tool"
          disabled={!editable || !note.permissions.canSave}
          aria-label="插入图片"
          title="插入图片 · 也可以直接把图片粘贴或拖进正文"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => imageUploads.fileInputRef.current?.click()}
        >
          图
        </button>
        <span className="editor-tools-legend">
          支持 Markdown · 所见即所得 · 停顿 1.2 秒自动保存 · 图片可粘贴或拖入
        </span>
        <input
          ref={imageUploads.fileInputRef}
          className="note-image-upload-input"
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            imageUploads.queueFiles(event.currentTarget.files);
            event.currentTarget.value = "";
          }}
        />
      </div>
    </div>
  ) : null;

  // The editor page, like the reading one: scrolling body, pinned actions and
  // receipt line. The fields stay editable while a save is in flight — the
  // save snapshots the draft, so typing during the round trip is safe.
  const editPageBody = note && draftSeeded ? (
    // Milkdown 的 defaultValueCtx 只在创建时读一次，所以编辑器按 noteId 重建：
    // 换一篇笔记就是换一个编辑器，而"恢复历史版本"这类同一篇里的整体替换走 ref 的
    // setMarkdown（见上面那个回读效应）。首帧不等 draftSeeded 就会用空正文建文档。
    <div className="editor-copy" ref={editorPaneRef} onKeyDown={onEditorKeyDown}>
      <h2>
        <label className="sr-only" htmlFor="notebook-surface-title">笔记标题</label>
        <input
          id="notebook-surface-title"
          value={titleValue}
          maxLength={200}
          disabled={!note.permissions.canEdit}
          placeholder="未命名笔记"
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
              event.preventDefault();
              void save("manual");
            }
          }}
          onChange={(event) => {
            // Read the value during dispatch: `currentTarget` is nulled once
            // the event finishes, so the snapshot is taken here and handed to
            // the one draft setter.
            const { value } = event.currentTarget;
            applyDraft({ ...draftRef.current, title: value });
          }}
        />
      </h2>
      <label className="sr-only" htmlFor="notebook-surface-body">笔记正文</label>
      <div id="notebook-surface-body" data-surface-initial-focus={mode === "edit" ? "true" : undefined}>
        {coWriters.length ? (
          // 一句文字，不靠颜色：这一格说的是"别人和我在同一段里"，看不见颜色的人
          // 与截图review都得能读出来。名字来自对端自己报的，一个也没本机代填。
          <p className="small notebook-note notebook-cowriters" role="status">
            {`${coWriters.map((peer) => peer.name ?? "另一个人").join("、")} 也在写这一段`}
          </p>
        ) : null}
        {noteDocLive.fragment ? <NoteMarkdownEditor
          key={note.noteId}
          ref={editorRef}
          fragment={noteDocLive.fragment}
          initialMarkdown={draft.content}
          onChange={applyContent}
          disabled={!editable}
          onImagePaste={imageUploads.queueFile}
          onCaretBlock={onCaretBlock}
        /> : null}
      </div>
      <NoteImageUploads
        uploads={imageUploads.uploads}
        error={imageUploads.error}
        onRetry={imageUploads.retry}
        onDismiss={imageUploads.dismiss}
      />
      {restoredDraftNote}
      {saveFailure ? <p className="small notebook-note" role="alert">保存没成功：{saveFailure}</p> : null}
      {generationReason ? <p className="small notebook-note">{generationReason}</p> : null}
      {generationFailure ? <p className="small notebook-note" role="alert">{generationFailure}</p> : null}
      {generationLiveNote}
      {historyPaper}
    </div>
  ) : null;

  const editPageActions = note ? (
    <div className="actions notebook-actions notebook-actions--editor">
      {/* 撤销/重做归编辑器自己的 history：正文里按 ⌘Z 就是它的原生行为，这一行
          不再替它摆一对按钮。 */}
      {/* 常驻：这不只是"存一下改过的字"，而是把此刻定成一个可回去的版本。
          挂在 `dirty` 上会让它在自动保存过后消失——那正是 F36 里用户一次都点不到的按钮。
          名字与纸面提示、版本历史里那句必须同一个。
          没保存上时它就地变成「重试保存」：这一档只留一颗可点的按钮，
          而不是并排摆两颗、让人猜该点哪个（用户报的就是"都保存好了还让我确认什么"）。 */}
      {note.permissions.canSave ? (
        <button
          type="button"
          className={saveState === "error" ? "button danger" : "button"}
          disabled={saving}
          onClick={() => void save("manual")}
        >
          {saveState === "error" ? (
            <><RefreshCw size={15} aria-hidden="true" />重试保存</>
          ) : saving ? "正在保存…" : "保存"}
        </button>
      ) : null}
      {versionAndOptionsToggles}
      {generationAction}
    </div>
  ) : null;

  return (
    <>
      <HudPage page={page}>
        <article
          className="notebook notebook-hud"
          aria-busy={loading || undefined}
          data-mode={mode}
          data-note-paper-image-drop={paperAcceptsImages ? "" : undefined}
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
          {statePaper ? <div className="notebook-scroll">{statePaper}</div> : null}
          {!loading && !failure && note ? (
            <>
              {mode === "edit" ? editChrome : null}
              <div className="notebook-scroll" ref={leafScrollRef}>{mode === "edit" ? editPageBody : readPageBody}</div>
              {mode === "edit" ? (
                <>
                  {editPageActions}
                  <div className="save-line">
                    <span role="status" aria-live="polite">{saveLabel}</span>
                    <span>当前版本 v{note.currentVersion.versionNo} · 来源片段 {segments.length}</span>
                  </div>
                </>
              ) : readPageActions}
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
      </HudPage>
      {generationSetup}
    </>
  );
}

/** One stored block, drawn with the weight its own type carries on paper. */
/**
 * 阅读正文里**每一块的锚点**（39d W4-6 刀二）：教学面的依据要能"点开定位到那一块"，
 * 而在此之前正文里没有任何能指认某一段的东西。锚点包一层 `.reading-block`，样式表里
 * 三条直接子选择器（`> p` / `> h3` / `> p.list-block`）跟着走进这一层——格线、
 * 标题字号与列表缩进一个字都不变。`data-block-focused` 是"依据点开的那一段"的短暂高亮。
 */
function ReadingBlock(props: {
  readonly block: NoteBlockProjectionV1;
  /** 依据点开的那一段：短暂高亮（W4-6 刀二）。 */
  readonly focused?: boolean;
  readonly mark: readonly [number, number] | null;
  readonly workspaceEpoch?: number;
  readonly gallery?: {
    readonly start: number;
    readonly openAt: (index: number) => void;
    readonly close: () => void;
  };
}) {
  return (
    <div
      className="reading-block"
      data-block-ordinal={props.block.ordinal}
      {...(props.focused ? { "data-block-focused": "true" } : {})}
    >
      <ReadingBlockContent
        block={props.block}
        mark={props.mark}
        workspaceEpoch={props.workspaceEpoch}
        gallery={props.gallery}
      />
    </div>
  );
}

function ReadingBlockContent({
  block,
  mark,
  workspaceEpoch,
  gallery,
}: {
  readonly block: NoteBlockProjectionV1;
  /** Character range of the sentence this block contributes, when it has one. */
  readonly mark: readonly [number, number] | null;
  /** 站内图片的字节请求要带上它，工作区换了就不该再回旧图。 */
  readonly workspaceEpoch?: number;
  /**
   * 这一块第一张图在整篇画廊里的序号与开关（一块可以有好几张：编辑器里的图是行内
   * 节点）。没有图的块不传，那时行内图仍可单独放大，只是不进整篇画廊。
   */
  readonly gallery?: {
    readonly start: number;
    readonly openAt: (index: number) => void;
    readonly close: () => void;
  };
}) {
  if (block.type === "image") {
    // 图片块要先取字节再画图，所以由自己的组件承载状态：hook 不能排在这一串
    // 按块类型分叉的早返回之后。
    return <ReadingImage block={block} workspaceEpoch={workspaceEpoch} gallery={gallery} />;
  }
  const inline = {
    mark,
    workspaceEpoch,
    galleryStart: gallery?.start,
    onOpenGallery: gallery?.openAt,
  };
  if (block.type === "heading") return <h3 className="serif">{renderNoteInline(block.content, inline)}</h3>;
  if (block.type === "code") {
    // 代码块里的换行与星号都是内容，不是语法：`pre` 自己保空白，不走行内解析。
    return <pre className="code-block"><code>{noteBlockText(block.content)}</code></pre>;
  }
  if (block.type === "list") {
    // 每一项占一行、带自己的记号：以前整块列表压成一行，第二项开始根本看不出是列表。
    return <p className="list-block">{renderNoteInline(block.content, { ...inline, lineClass: "list-line" })}</p>;
  }
  if (block.type === "quote") return <p className="quote">{renderNoteInline(block.content, inline)}</p>;
  // Tables have no block type; a paragraph of pipe rows renders as one.
  const table = parseMarkdownTable(noteBlockText(block.content));
  if (table) {
    // 第二行是**语法**不是内容（`| --- | --- |` 那一条分隔行），跟着画就多出一整行减号。
    const [header, , ...rows] = table;
    const cell = (value: string, key: string) => <span key={key}>{renderNoteInline(value, { mark: null })}</span>;
    return (
      <table className="md-table">
        <thead>
          <tr>{header?.map((value, index) => <th key={index}>{cell(value, `h${index}`)}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>{row.map((value, cellIndex) => <td key={cellIndex}>{cell(value, `c${rowIndex}-${cellIndex}`)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    );
  }
  // 编辑器把 `---` 画成一条线，投影回来它是一个内容为 `---` 的段落；不认出来就是
  // 纸面上凭空多出三个减号。
  if (isHorizontalRule(noteInlineDisplayText(block.content))) return <hr className="reading-rule" />;
  return <p>{renderNoteInline(block.content, inline)}</p>;
}

/**
 * A stored image block (`![alt](url)`).
 *
 * 从来源起稿的笔记里，这个地址是 `/api/uploads/{objectKey}`：解析把网页内嵌图片
 * 下载进对象存储后改写的站内引用。渲染层的 origin 是 `ailearn-app://`，相对路径
 * 会落到应用包内，所以图由 main 带会话令牌取回字节，这里用 blob URL 画出来。
 * 站外地址仍原样交给 `<img>`；取不回来时只这一张缺位，正文照旧读下去。
 */
function ReadingImage({
  block,
  workspaceEpoch,
  gallery,
}: {
  readonly block: NoteBlockProjectionV1;
  readonly workspaceEpoch?: number;
  readonly gallery?: {
    readonly start: number;
    readonly openAt: (index: number) => void;
    readonly close: () => void;
  };
}) {
  const image = parseImageBlock(block.content);
  const { state, retry } = useSourceImage(image?.url ?? "", workspaceEpoch);

  if (!image) return <p className="small">图片片段无法解析：{block.content}</p>;

  const alt = image.alt || "笔记图片";
  if (state.status === "external" || state.status === "ready") {
    return (
      <ZoomableReadingImage
        src={state.src}
        alt={alt}
        retryable={state.status === "ready"}
        onRetry={retry}
        // 有整篇画廊时开关归画廊（受控，组件自己不再叠一层灯箱）；没有就单张放大。
        open={gallery ? false : undefined}
        onOpenChange={(open) => {
          if (!gallery) return;
          if (open) gallery.openAt(gallery.start);
          else gallery.close();
        }}
      />
    );
  }
  if (state.status === "loading") return <p className="small notebook-note">正在载入图片…</p>;
  return <p className="small notebook-note">这张图片没能取回：{alt}</p>;
}
