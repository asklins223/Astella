import { ensureAiActionAllowed, guideAiPermissionFailure } from "../../../../app/gate/ai-action-gate";
import { CompanionNoteWritePreview } from "../../../companion/journal/CompanionNoteWritePreview";
import { useNotebookMindMap } from "../generation/use-notebook-mind-map.ts";
import { NoteMindMapPaper } from "../generation/note-mind-map-paper.tsx";
import type { NoteMindMapV1 } from "@astella/shared/note-mind-map-contracts";
import { noteBlockMarkdown } from "@astella/shared/note-markdown";
import { readNotebookProjection } from "./notebook-projection.ts";
import { useNotebookCompanionEditing } from "./use-notebook-companion-editing.ts";
import { beginNoteAiWork, endNoteAiWork, useNoteAiWork, resolveNoteAiRanges, type NoteAiRange } from "../../../companion/content/note-companion-editing";
import { noteHtmlAlignments } from "../document/note-html-alignment.ts";
import { publishCompanionRecordsChanged } from "../../../companion/content/companion-events";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BookOpen, FileText, History, Link2, PencilLine } from "lucide-react";
import type { DesktopNoteVersionItem, DesktopSourceDetail } from "@astella/shared/desktop-surface-contracts";
import type { NoteBlockProjectionV1, NoteDetailV1 } from "@astella/shared/note-projection-contracts";
import { useRoomStore } from "../../../../app/home/room-store";
import { SETTINGS_ATTENTION_AI_CONSENT, SETTINGS_SECTION_AI_CONSENT } from "../../../../app/companion-pages/companion-consent-gate";
import type { NoteShareScopeV1 } from "@astella/shared/note-share-contracts";
import {
  createCommandId,
  createRequestMeta,
  gatewayErrorMessage,
  unwrapGatewayResult,
} from "../../../../app/client/desktop-client";
import { imageOnlyFiles } from "../../../../app/source/source-intake";
import { useHudPage } from "../../../hud/use-hud-page";
import type { PageReadableV1 } from "@astella/shared/companion-bridge-contracts";
import { usePageReadableView } from "../../../hud/use-page-readable-view";
import type { HudPageId } from "../../../hud/hud-pages";
import {
  SurfaceDataState,
  formatRelative,
  noteLeadingTitleBlock,
  useSurfaceProjection,
} from "./surface-data.tsx";
import { ArtifactFrameHost } from "../../source/artifact-frame-host.tsx";
import { resolveArtifactMotion } from "../../source/artifact-motion";
import { NotebookLearningArtifactPaper } from "../learning/notebook-learning-artifact-paper.tsx";
import { parseMarkdownTable } from "@astella/shared/note-doc-schema";
import { isHorizontalRule, noteInlineDisplayText, noteInlineImages, renderNoteInline } from "../reading/note-reading-inline.tsx";
import { sourceImageObjectKeyFromUrl } from "@astella/shared/source-image-contracts";
import { markdownToBlocks } from "@astella/shared/markdown-parser";
import { useSourceImage } from "../../source/source-image.ts";
import { ImageGalleryLightbox, useImageLightbox, ZoomableReadingImage, type GalleryImage } from "../../source/image-viewer.tsx";
import type { NoteMarkdownEditorHandle } from "../document/note-markdown-editor.tsx";
import { NoteDocumentEditor } from "../document/note-document-editor.tsx";
import { annotationPlacements, chronologicalAnnotations } from "../annotation/note-annotation-placement.ts";
import { AnnotationDeleteControl, useAnnotationDeleteConfirm } from "../annotation/annotation-delete-control.tsx";
import { isNoteEditingMode, type NoteBodyMode } from "../document/note-document-mode.ts";
import { useNotebookBodyMode } from "../document/use-notebook-body-mode.ts";
import { NotebookDesk } from "./notebook-desk.tsx";
import { NotebookNoteList } from "../library/notebook-note-list.tsx";
import { NotebookOverviewSwitch } from "../generation/notebook-overview-switch.tsx";
import { openNotebookListNote } from "../library/notebook-note-navigation.ts";
import { useNotebookFullscreenActive, useNotebookFullscreenSession, useNotebookFullscreenState } from "./notebook-fullscreen-state.ts";
import { NotebookFullscreenRibbon } from "./notebook-fullscreen-ribbon.tsx";
import { NotebookEditorTools } from "../document/notebook-editor-tools.tsx";
import { useWritingPreferences, writingPreferenceAttributes } from "../document/note-writing-preferences.ts";
import { useNotebookLinkEditor } from "../document/notebook-link-editor.tsx";
import { noteOutline } from "../document/note-outline.ts";
import { useNotebookLearningView } from "../learning/use-notebook-learning-view.ts";
import { useNotebookLearningEntry, type NoteLearningTask } from "../learning/use-notebook-learning-entry.ts";
import { TaskSlip } from "../generation/task-slip.tsx";
import { NotebookVersionChoice } from "../library/notebook-version-choice.tsx";
import { NotebookLearningPage } from "../learning/notebook-learning-page.tsx";
import { useNoteDocLiveView } from "../document/use-note-doc-live-view.ts";
import { NoteAnnotationSidePage } from "../annotation/note-annotation-side-page.tsx";
import { useNotebookSidePage } from "../annotation/use-notebook-side-page.ts";
import { VersionHistory } from "../library/version-history.tsx";
import { ReadingBlock } from "../reading/notebook-reading-block.tsx";
import { noteReadingText } from "../reading/note-reading-text.ts";
import { noteAnchorMatchesV1 } from "@astella/shared/note-annotation-contracts";
import { noteBlockRenderedTextV1 } from "@astella/shared/note-doc-schema";
import { useNotebookAnnotationState } from "../annotation/use-notebook-annotation-state.ts";
import { useNotebookLearningArtifactState } from "../learning/use-notebook-learning-artifact-state.ts";
import { prepareNotebookTaskNotification } from "./notebook-task-notifications.ts";
import { useNotebookExpansionState } from "../generation/use-notebook-expansion-state.ts";
import { useNotebookExpansionTask } from "../generation/use-notebook-expansion-task.ts";
import { useNotebookRecallState } from "../learning/use-notebook-recall-state.ts";
import { useNotebookSaveState } from "../document/use-notebook-save-state.ts";
import { useNotebookOverview } from "../generation/use-notebook-overview.ts";
import { useNotebookGoalResult } from "../learning/use-notebook-goal-result.ts";
import { NoteRecallPaper } from "../learning/notebook-recall-paper.tsx";
import { NoteOverviewPaper } from "../generation/notebook-overview-paper.tsx";
import { NotebookSelectionActions } from "./notebook-selection-actions.tsx";
import { useNotebookSelection } from "../document/use-notebook-selection.ts";
import { useNotebookAnnotationDraft } from "../annotation/use-notebook-annotation-draft.ts";
import { NotebookAnnotationComposer } from "../annotation/notebook-annotation-composer.tsx";
import { NotebookArtifactTaskPaper } from "../generation/notebook-artifact-task-paper.tsx";
import { NoteExpansionDrafts } from "../generation/notebook-expansion-drafts.tsx";
import { openNoteLearningCard } from "../learning/card/learning-card-navigation";
import { NotebookSharingControl } from "../library/notebook-sharing-control.tsx";
import { useNotebookVersions } from "../library/use-notebook-versions.ts";
import { NoteImageUploads, useNoteImageUploads } from "../document/note-image-uploads.tsx";
import { feedNoteIntentToCompanion, feedSelectionToCompanion } from "../../../companion/hud/companion-feed";
import { noteAnchorsOverlap, noteExplanationBusy, pendingNoteExplanation, stopNoteExplanation, useNoteCompanionExplanations } from "../../../companion/content/note-companion-explanation";
import { stopCompanionSpeech } from "../../../../app/companion-session/companion-voice-playback";
import { NoteCompanionExplanationPaper } from "../reading/note-companion-explanation-paper.tsx";
import { noteAnnotationV1Schema, type NoteAnnotationAnchorV1, type NoteAnnotationTaskV1, type NoteAnnotationV1 } from "@astella/shared/note-annotation-contracts";
import type { NoteOverviewTaskV1, NoteOverviewV1 } from "@astella/shared/note-overview-contracts";
import type { NoteRecallRecordV1 } from "@astella/shared/note-recall-contracts";
import {
  noteExpansionLinkV1Schema,
  type NoteExpansionLinkV1,
} from "@astella/shared/note-expansion-contracts";
import {
  noteLearningArtifactV1Schema,
  type NoteLearningArtifactTaskV1,
  type NoteLearningArtifactV1,
} from "@astella/shared/note-learning-artifact-contracts";
import { NoteLearningFootprint, type FootprintKind } from "../learning/note-learning-footprint.tsx";

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

export type NotebookProjection = {
  readonly note: NoteDetailV1;
  readonly source: DesktopSourceDetail | null;
  readonly sourceFailure: string | null;
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

function desktopApi() {
  return typeof window === "undefined" ? undefined : window.astella;
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

/** Page 08 / 09 / 22 — the note as one paper, read, written or discussed. */
export function NotebookSurface() {
  // 排版偏好属于书桌本身：阅读、编辑与源码共用同一份，切换视图不重排。
  const writingPreferences = useWritingPreferences();
  const invoke = useRoomStore((state) => state.invoke);
  const setSettingsAttention = useRoomStore((state) => state.setSettingsAttention);
  const setSettingsSection = useRoomStore((state) => state.setSettingsSection);
  const setReturnTarget = useRoomStore((state) => state.setReturnTarget);
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
  const editorRef = useRef<NoteMarkdownEditorHandle | null>(null);
  const editorPaneRef = useRef<HTMLDivElement>(null);
  const epochRef = useRef<number | undefined>(undefined);

  const syncedNoteRef = useRef<string | null>(null);
  const saveRef = useRef<() => void>(() => {});

  const [leaf, setLeaf] = useState<"reading" | "history" | "expansion">("reading");
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
    setLeaf("reading");
    setOverviewOpen(false);
    setShowAllBlocks(false);

    setFocusedBlockOrdinal(null);
  }, [activeNoteRef?.noteId]);
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
  const motionMode = useRoomStore((state) => state.motionMode);
  const reducedMotion = useRoomStore((state) => state.reducedMotion);
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
    epochRef.current = workspaceEpoch;
    return readNotebookProjection({
      api, workspaceEpoch, noteId: activeNoteRef?.noteId,
    });
  }, [activeNoteRef?.noteId]);

  // The pill returns to whatever opened this note: the library, the notes list,
  // or the star map a star was clicked on. It never skips a level up to the
  // study room.
  useEffect(() => {
    // An explicit caller (such as the learning journal) owns its return path.
    if (useRoomStore.getState().returnTarget) return;
    const returnTo = useRoomStore.getState().noteReturnTo;
    const target = returnTo === "graph"
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
  const noteAiSourceRef = useRef(learningArtifactScopeRef.current);
  noteAiSourceRef.current = learningArtifactScopeRef.current;
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
  const mindMap = useNotebookMindMap({ note, epochRef, requestedMindMap: requestedGoalResult?.kind === "note_mind_map"
    ? goalResult.result?.kind === "note_mind_map" ? goalResult.result.mindMap : null : undefined });
  const [overviewTab, setOverviewTab] = useState<{ noteId: string; tab: "points" | "mindMap" } | null>(null);
  const brainActive = requestedGoalResult?.kind === "note_mind_map" || overviewTab?.noteId === note?.noteId && overviewTab?.tab === "mindMap";
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

  /** 版本历史那一簇（4 个 state + 读取与恢复）已于 2026-09-29 收进 `use-notebook-versions.ts`。 */
  const {
    versions, setVersions, versionsLoading, versionsFailure, setVersionsFailure,
    restoringVersionId, loadVersions, restoreVersion,
  } = useNotebookVersions({ data, epochRef, reload, api: desktopApi() });
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
    });
  }, [note?.noteId, note?.currentVersionId]);









  const loadNoteLearningArtifacts = useCallback(async (before?: string) => {
    if (!note) return;
    const api = typeof window === "undefined" ? undefined : window.astella;
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
    const api = typeof window === "undefined" ? undefined : window.astella;
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
      if (request === learningArtifactTaskRequestRef.current && !guideAiPermissionFailure(error)) setLearningArtifactTaskError(gatewayErrorMessage(error));
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
    const api = typeof window === "undefined" ? undefined : window.astella;
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
    window.addEventListener("astella:note-expansion-saved", onExpansionSaved);
    return () => window.removeEventListener("astella:note-expansion-saved", onExpansionSaved);
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
    const api = typeof window === "undefined" ? undefined : window.astella;
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
    const api = typeof window === "undefined" ? undefined : window.astella;
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
      if (request === annotationTaskRequestRef.current && !guideAiPermissionFailure(error)) setAnnotationTaskError(gatewayErrorMessage(error));
    }
  }, [note?.noteId, note?.currentVersionId]);

  const startNoteAnnotationTask = useCallback(async (anchor: NoteAnnotationAnchorV1, hasUnsavedChanges: boolean) => {
    if (!note || !note.currentVersionId || annotationTaskStarting || hasUnsavedChanges) return;
    const api = typeof window === "undefined" ? undefined : window.astella;
    if (!api?.noteAnnotation) {
      setAnnotationTaskError("这句解释暂时不可用");
      return;
    }
    const request = ++annotationTaskRequestRef.current;
    setAnnotationTaskStarting(true);
    setAnnotationTaskError(null);
    const workId = `annotation-start:${note.noteId}:${request}`;
    const expectedSource = noteAiSourceRef.current;
    try {
      if (!await ensureAiActionAllowed(epochRef.current, () => request === annotationTaskRequestRef.current && expectedSource === noteAiSourceRef.current)) return;
      beginNoteAiWork(workId, note.noteId, [{ startBlock: anchor.startBlockOrdinal, endBlock: anchor.endBlockOrdinal,
        label: "伴星正在解读原句", expectedBlocks: note.currentVersion.blocks.slice(anchor.startBlockOrdinal, anchor.endBlockOrdinal + 1).map(b => b.content) }]);
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
      if (request === annotationTaskRequestRef.current && !guideAiPermissionFailure(error)) setAnnotationTaskError(gatewayErrorMessage(error));
    } finally {
      endNoteAiWork(workId);
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
    const api = typeof window === "undefined" ? undefined : window.astella;
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
    const api = typeof window === "undefined" ? undefined : window.astella;
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
    window.addEventListener("astella:note-annotation-saved", onAnnotationSaved);
    return () => window.removeEventListener("astella:note-annotation-saved", onAnnotationSaved);
  }, [note?.noteId]);
  const source = data?.source ?? null;
  const sourceFailure = data?.sourceFailure ?? null;
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
    links.forEach(expansion => window.dispatchEvent(new CustomEvent("astella:note-expansion-saved", {
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
    const api = typeof window === "undefined" ? undefined : window.astella;
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
      if (!await ensureAiActionAllowed(epochRef.current, () => request === learningArtifactTaskRequestRef.current && expectedScope === learningArtifactScopeRef.current)) return;
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
      if (request === learningArtifactTaskRequestRef.current && !guideAiPermissionFailure(error)) setLearningArtifactTaskError(gatewayErrorMessage(error));
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
  // 谁在这同一块里：判据是**对端自己报的那一格**，而且要他已经报明「在写」——
  // 只报过块号却还在读的人，不该被写成"也在写这一段"（那是同一句话的两个条件）。
  // `caretBlock` 为空时整条不成立（光标还没进正文，说不出"这一段"是哪一段）。
  const coWriters = caretBlock === null
    ? []
    : noteDocLive.presencePeers.filter((peer) => peer.mode === "editing" && peer.block === caretBlock);
  /**
   * AI-generated notes commonly start with `# <title>` in the body while the
   * page header already prints that title. The reading view hides the duplicate
   * at the display layer only: stored blocks, their ordinals and every
   * annotation offset into `content` stay untouched. The in-body TOC is built
   * from the visible blocks, so its heading order matches the rendered headings
   * (see `note-markdown-reading`).
   */
  const leadingTitleBlock = useMemo(() => noteLeadingTitleBlock(readSourceBlocks, readTitle), [readSourceBlocks, readTitle]);
  const readableBlocks = useMemo(() => leadingTitleBlock
    ? readSourceBlocks.filter((block) => block.ordinal !== leadingTitleBlock.ordinal)
    : readSourceBlocks, [readSourceBlocks, leadingTitleBlock]);
  const readingDocumentSource = useMemo(() => readableBlocks.map(block => noteBlockMarkdown(block.type, block.content)).join("\n\n"), [readableBlocks]);
  const allBlocks = readableBlocks;
  const htmlAlignments = useMemo(() => noteHtmlAlignments(readSourceBlocks), [readSourceBlocks]);
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
        // The duplicate title heading is hidden from the body but printed by the
        // page header: its text is still on screen, so the anchor stays verifiable.
        if (block.ordinal === leadingTitleBlock?.ordinal) return true;
        const content = body.querySelector(`[data-block-ordinal="${block.ordinal}"] [data-note-block-content]`);
        return content && noteReadingText(content) === noteBlockRenderedTextV1(block.type, block.content);
      })) ids.add(annotation.annotationId);
    }
    setAnnotationVerification((current) => {
      if (current?.noteId === note.noteId && current.versionId === note.currentVersionId
        && current.ids.size === ids.size && [...ids].every((id) => current.ids.has(id))) return current;
      return { noteId: note.noteId, versionId: note.currentVersionId, ids };
    });
  }, [note?.noteId, note?.currentVersionId, currentAnnotationCandidates, leaf, learningView, readSourceBlocks, leadingTitleBlock, showAllBlocks]);
  useEffect(() => {
    if (unresolvedNoteAnnotations.length > 0) setAnnotationShelfOpen(true);
  }, [unresolvedNoteAnnotations.length, note?.noteId, note?.currentVersionId]);
  const { selectedPassage, setSelectedPassage } = useNotebookSelection({ note, blocks: readSourceBlocks, bodyRef: readingBodyRef, active: leaf === "reading" && learningView === "body" && mode === "preview" });

  useNotebookCompanionEditing({ note, blocks: readSourceBlocks, mode, editable, bodyRef: readingBodyRef, editorRef,
    selection: selectedPassage, flush: noteDocLive.flush });
  const noteAiWork = useNoteAiWork(state => state.items);
  const noteAiRanges: NoteAiRange[] = resolveNoteAiRanges([
    ...Object.values(noteAiWork).filter(item => item.noteId === note?.noteId).flatMap(item => item.ranges),
    ...noteCompanionExplanations.filter(item => noteExplanationBusy(item) && item.target.anchor.noteVersionId === note?.currentVersionId).map(item => ({ startBlock: item.target.anchor.startBlockOrdinal,
      endBlock: item.target.anchor.endBlockOrdinal, label: "伴星正在解释这段", expectedBlocks: note?.currentVersion.blocks.slice(item.target.anchor.startBlockOrdinal, item.target.anchor.endBlockOrdinal + 1).map(b => b.content) })),
    ...(annotationTask && annotationTask.noteVersionId === note?.currentVersionId && (annotationTask.status === "queued" || annotationTask.status === "running") ? [{ startBlock: annotationTask.anchor.startBlockOrdinal,
      endBlock: annotationTask.anchor.endBlockOrdinal, label: "伴星正在解读原句", expectedBlocks: note?.currentVersion.blocks.slice(annotationTask.anchor.startBlockOrdinal, annotationTask.anchor.endBlockOrdinal + 1).map(b => b.content) }] : []),
  ], readSourceBlocks);

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
    setSettingsSection(SETTINGS_SECTION_AI_CONSENT);
    invoke("open-settings");
  };
  /**
   * 点一颗依据：滚到那一段并短暂高亮。`scrollIntoView` **不用 smooth**——动效是
   * 产品设置里的一档（那套在 D4 那一侧），这一处只负责"看得见"；高亮自己过期撤掉，
   * 不留"上次点过哪"这种会跟人走的读数。
   */
  const locateTeachingReference = (ordinal: number): void => {
    // A citation can point at the duplicate title heading (block ordinal 1).
    // That heading is not in the body; the page header shows the same title, so
    // locate the first visible block instead of scrolling to nothing.
    const target = leadingTitleBlock && ordinal === leadingTitleBlock.ordinal
      ? allBlocks[0]?.ordinal ?? ordinal
      : ordinal;
    clearGoalResultSelection();
    setLeaf("reading");
    setLearningView("body");
    if (isNoteEditingMode(mode)) requestAnimationFrame(() => editorRef.current?.focusPosition({ block: target, offset: 0 }));
    if (!readingBlocks.some((block) => block.ordinal === target)) setShowAllBlocks(true);
    setFocusedBlockOrdinal(target);
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

  // 这篇笔记的全部图片，按正文顺序排好；顺带记下**每一块**第一张图在画廊里的序号，
  // 让正文里的缩略图点击时知道自己该开在哪一张。一块可以有好几张：编辑器里的图是
  // **行内节点**（`paragraph > image`），一整段里并排两张是常态。
  // 笔记块里存的是站内地址：画廊切到哪张才取哪张的字节，站外直链则原样交给 `<img>`。
  const noteImages = useMemo(() => {
    const images: GalleryImage[] = [];
    const ordinalToStart = new Map<number, number>();
    for (const block of allBlocks) {
      const found = noteInlineImages(block.content);
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
  const { setLocalTitle, flush, setLocalBlock, setLocalMode } = noteDocLive;

  // 「在读 / 在写」报的是正文模式这一格，不是"这台机器今天改过字没有"：
  // 停在编辑器里但一个字没敲的人确实在写，切回阅读的人不该继续挂着那个说法。
  useEffect(() => {
    setLocalMode(isNoteEditingMode(mode) ? "editing" : "reading");
  }, [mode, setLocalMode]);

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




  const footprintHasRecords = noteOverviews.length > 0
    || mindMap.noteMindMaps.length > 0
    || noteRecallRecords.length > 0
    || noteExpansions.length > 0
    || noteAnnotations.length > 0
    || noteLearningArtifacts.length > 0;
  const footprintRowsLoaded = Boolean(note
    && mindMap.mindMapRows?.noteId === note.noteId
    && overviewRows?.noteId === note.noteId
    && recallRows?.noteId === note.noteId
    && expansionRows?.noteId === note.noteId
    && annotationRows?.noteId === note.noteId
    && learningArtifactRows?.noteId === note.noteId);
  const footprintPending = Boolean(note && (
    (mindMap.mindMapRows?.noteId !== note.noteId && !mindMap.mindMapError)
    || (overviewRows?.noteId !== note.noteId && !overviewError)
    || (recallRows?.noteId !== note.noteId && !recallError)
    || (expansionRows?.noteId !== note.noteId && !expansionError)
    || (annotationRows?.noteId !== note.noteId && !annotationError)
    || (learningArtifactRows?.noteId !== note.noteId && !learningArtifactError)
  ));

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
  const openFootprintMindMap = (map: NoteMindMapV1) => {
    clearGoalResultSelection(); rememberReadingPosition(); closeSidePage();
    mindMap.setMindMapRows(current => ({ noteId: map.noteId, nextCursor: current?.noteId === map.noteId ? current.nextCursor : null,
      items: [map, ...(current?.noteId === map.noteId ? current.items.filter(item => item.mindMapId !== map.mindMapId) : [])] }));
    mindMap.selectMindMap(map); setOverviewTab({ noteId: map.noteId, tab: "mindMap" }); setLeaf("reading"); setLearningView("overview");
  };
  const loadOlderFootprint = (kind: FootprintKind) => {
    if (kind === "mindMap" && mindMap.mindMapRows?.nextCursor) void mindMap.loadNoteMindMaps(mindMap.mindMapRows.nextCursor);
    if (kind === "overview" && overviewRows?.nextCursor) void loadNoteOverviews(overviewRows.nextCursor);
    if (kind === "recall" && recallRows?.nextCursor) void loadNoteRecallRecords(recallRows.nextCursor);
    if (kind === "annotation" && annotationRows?.nextCursor) void loadNoteAnnotations(annotationRows.nextCursor);
    if (kind === "artifact" && learningArtifactRows?.nextCursor) void loadNoteLearningArtifacts(learningArtifactRows.nextCursor);
    if (kind === "expansion" && expansionRows?.nextCursor) void loadNoteExpansions(expansionRows.nextCursor);
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

  const page: HudPageId = leaf === "expansion" ? "note-learning" : leaf === "history" ? "note-history" : isNoteEditingMode(mode) ? "note-edit" : "note-read";
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
    <SurfaceDataState kind="loading" message="正在打开这篇笔记" detail="先确认工作区与当前版本。" />
  ) : failure ? (
    <SurfaceDataState kind="error" message="打不开这篇笔记" detail={failure} onRetry={() => void reload()} />
  ) : !note ? (
    <SurfaceDataState
      kind="empty"
      message="这里还没有打开的笔记"
      detail="从笔记库挑一篇接着读，那里也能新建一篇空笔记。"
      action={<button type="button" className="button primary" onClick={() => invoke("open-notes")}>打开笔记库</button>}
    />
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
    // 往外学与回想各自一屏：屏上最大的那一句是这一屏的题目。
    if (leaf === "expansion") {
      return { pageId: "note.learning", title: readTitle || "这一篇", statusLine: "从这篇往外学", items: [] };
    }
    if (leaf === "reading" && learningView === "recall") {
      return { pageId: "note.learning", title: readTitle || "这一篇", statusLine: "正在回想", items: activeRecall ? [{ ordinal: 1, label: "回想问题", state: activeRecall.question }] : [] };
    }
    // 学习记录那一屏：屏上摆的是笔记名与留下的记录，不是来源片段。
    if (leaf === "history") {
      return {
        pageId: "note.history",
        title: readTitle || "这一篇",
        statusLine: "留下的线索都在这页",
        items: [],
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
    leaf, mode, readTitle, sourceBagOpen, learningView, activeRecall]);
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
      if (kind === "mindMap") setOverviewTab({ noteId: note!.noteId, tab: "mindMap" });
      else if (kind === "overview") setOverviewTab({ noteId: note!.noteId, tab: "points" });
      rememberReadingPosition(); closeSidePage();
      if (kind === "expansion") setLeaf("expansion");
      else { setLeaf("reading"); setLearningView(kind === "mindMap" ? "overview" : kind); if (kind === "overview" || kind === "mindMap") setOverviewOpen(true); }
    },
    lookup: async (kind) => {
      if (kind === "mindMap") {
        const [latest, page] = await Promise.all([mindMap.loadLatestNoteMindMapTask(), mindMap.loadNoteMindMaps()]);
        return !latest || !page ? "error" : latest.task || page.items.length ? "existing" : "missing";
      }
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
        setLeaf("reading"); setLearningView(kind === "mindMap" ? "overview" : kind);
        if (kind === "mindMap") { setOverviewTab({ noteId: note!.noteId, tab: "mindMap" }); if (regenerate || !mindMap.latestNoteMindMap) void mindMap.startNoteMindMapTask(false); }
        else if (kind === "overview") { setOverviewOpen(true); if (regenerate || !latestNoteOverview) void startNoteOverviewTask(false); }
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
      {learningView === "overview" && brainActive && requestedGoalResult?.kind !== "note_mind_map" && !mindMap.latestNoteMindMap ? <NotebookLearningPage kind="mindMap" title={readTitle || note.title} version={note.currentVersion.versionNo}
        state={mindMap.mindMapLoading || learningEntry.checking === "mindMap" ? "loading" : mindMap.mindMapTaskStarting ? "queued" : mindMap.taskForCurrentVersion?.status === "ready" ? "loading" : mindMap.taskForCurrentVersion?.status ?? (mindMap.mindMapTaskError || mindMap.mindMapError || learningEntry.error ? "failed" : "empty")}
        error={mindMap.taskForCurrentVersion?.failureMessage ?? mindMap.taskForCurrentVersion?.failureReason ?? mindMap.mindMapTaskError ?? mindMap.mindMapError ?? learningEntry.error}
        onPrepare={() => learningEntry.prepare("mindMap")} onBody={() => setLearningView("body")}
        onRetry={() => learningEntry.prepare("mindMap", true)} onSettings={openAiConsentSettings} /> : null}
      {learningView === "overview" && brainActive && mindMap.latestNoteMindMap ? <NoteMindMapPaper key={`${mindMap.latestNoteMindMap.mindMapId}:${epochRef.current}`} map={mindMap.latestNoteMindMap} currentVersionId={note.currentVersionId}
        unversioned={readingUnversionedContent || dirty} epoch={epochRef.current} regenerating={mindMap.mindMapTaskStarting || ["queued","running"].includes(mindMap.taskForCurrentVersion?.status ?? "")}
        onRegenerate={() => learningEntry.prepare("mindMap", true)}
        notice={mindMap.mindMapTaskStarting || ["queued","running","failed"].includes(mindMap.taskForCurrentVersion?.status ?? "") || mindMap.mindMapTaskError ? <aside className="note-mind-map__notice" aria-live="polite">
        <p>{mindMap.taskForCurrentVersion?.status === "failed" ? mindMap.taskForCurrentVersion.failureMessage ?? (mindMap.taskForCurrentVersion.failureReason === "ai_consent_required" ? "需要先到设置开启 AI 使用权限。" : "这次脑图没有完成，之前的脑图仍可阅读。") : mindMap.mindMapTaskError ?? "正在后台整理新脑图，之前的脑图仍可阅读。"}</p>
        {mindMap.taskForCurrentVersion?.failureReason === "ai_consent_required" || mindMap.taskForCurrentVersion?.failureReason === "ai_data_policy_denied" ? <button type="button" className="text-action" onClick={openAiConsentSettings}>去 AI 设置</button> : null}
        {mindMap.taskForCurrentVersion?.status === "failed" || mindMap.mindMapTaskError ? <button type="button" className="text-action" onClick={() => learningEntry.prepare("mindMap", true)}>重新生成</button> : null}
      </aside> : null} /> : null}
      {((learningView === "overview" && (requestedGoalResult?.kind === "note_overview" || requestedGoalResult?.kind === "note_mind_map"))
        || (learningView === "artifact" && requestedGoalResult?.kind === "note_dynamic_artifact")) && !goalResult.result ? <SurfaceDataState
          kind={goalResult.error ? "error" : "loading"}
          message={goalResult.error ? "这份结果暂时没读到" : "正在翻开这份结果"}
          detail={goalResult.error ?? "正在读取手记里保存的这一份内容。"}
          onRetry={goalResult.retry}
          action={<button type="button" className="text-action" onClick={() => { clearGoalResultSelection(); setLearningView("body"); }}>回正文</button>} /> : null}
      {learningView === "overview" && !brainActive && !latestNoteOverview && requestedGoalResult?.kind !== "note_overview" ? <NotebookLearningPage kind="overview" title={readTitle || note.title} version={note.currentVersion.versionNo}
        state={learningEntry.checking === "overview" ? "loading" : overviewTaskStarting ? "queued" : taskForCurrentVersion?.status === "ready" ? "loading" : taskForCurrentVersion?.status ?? (overviewTaskError || learningEntry.error ? "failed" : "empty")}
        error={taskForCurrentVersion?.failureReason ?? overviewTaskError ?? learningEntry.error}
        onPrepare={() => learningEntry.prepare("overview")} onBody={() => setLearningView("body")}
        onRetry={() => learningEntry.error ? void learningEntry.request("overview") : void startNoteOverviewTask(dirty)} onSettings={openAiConsentSettings} /> : null}

      {latestNoteOverview && learningView === "overview" && !brainActive ? (
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
      {latestNoteOverview && learningView === "overview" && !brainActive && (overviewTaskStarting || taskForCurrentVersion?.status === "queued" || taskForCurrentVersion?.status === "running" || taskForCurrentVersion?.status === "failed" || overviewTaskError) ? <aside className="notebook-regeneration" aria-label="新速看的进度">
        <TaskSlip kind="overview" status={overviewTaskStarting ? "queued" : taskForCurrentVersion?.status}
          runningSince={taskForCurrentVersion?.status === "queued" || taskForCurrentVersion?.status === "running" ? taskForCurrentVersion.createdAt : null}
          failureReason={taskForCurrentVersion?.failureReason} onRetry={() => learningEntry.prepare("overview", true)} onOpenSettings={openAiConsentSettings} />
        {overviewTaskError ? <p role="alert">{overviewTaskError}</p> : null}
        <small>之前的速看仍可阅读，所有结果都留在学习记录里。</small>
      </aside> : null}
      {(learningView === "body" || learningView === "overview" && !brainActive) && (learningView === "overview" && learningArtifactTaskError || learningArtifactTasks.some((task) => task.sourceKind === "overview")) ? (
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
          motion={resolveArtifactMotion(motionMode, reducedMotion)} onLocateReference={locateTeachingReference}
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
      >
        {/* `allBlocks` (not `readSourceBlocks`) owns this branch: a version whose
            only block is the duplicate title heading has nothing left to read. */}
        {allBlocks.length ? readingBlocks.map((block) => (
          <ReadingBlock
            key={block.ordinal}
            block={block}
            mark={null}
            documentSource={readingDocumentSource}
            alignment={htmlAlignments.get(block.ordinal)}
            aiWork={noteAiRanges.find(range => block.ordinal >= range.startBlock && block.ordinal <= range.endBlock)}
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
            {expansionLoading ? "正在找更早的…" : "再看一些拓展笔记"}
          </button>
        ) : null}
      </section>
      )}</div>)}
      {(<div hidden={leaf !== "history"}>{<section id="notebook-history-leaf" className="notebook-journey" aria-label="学习记录" tabIndex={-1} data-task-focus>
        <p className="notebook-journey__intro">速看、脑图、回想、批注和拓展都留在这里。打开一条记录，接着看当时的内容。</p>
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
          mindMaps={mindMap.noteMindMaps}
          onOpenMindMap={openFootprintMindMap}
          recalls={noteRecallRecords}
          annotations={noteAnnotations}
          artifacts={noteLearningArtifacts}
          expansions={noteExpansions}
          hasMore={{
            mindMap: Boolean(mindMap.mindMapRows?.nextCursor),
            overview: Boolean(overviewRows?.nextCursor),
            recall: Boolean(recallRows?.nextCursor),
            annotation: Boolean(annotationRows?.nextCursor),
            artifact: Boolean(learningArtifactRows?.nextCursor),
            expansion: Boolean(expansionRows?.nextCursor),
          }}
          loadingMore={{
            mindMap: mindMap.mindMapLoading,
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
        {overviewError ? <p className="notebook-footprint-error" role="alert">速看暂时没读到。<button type="button" className="text-action" onClick={() => void loadNoteOverviews()}>重试</button></p> : null}
        {recallError ? <p className="notebook-footprint-error" role="alert">回想记录暂时没读到。<button type="button" className="text-action" onClick={() => void loadNoteRecallRecords()}>重试</button></p> : null}
        {annotationError ? <p className="notebook-footprint-error" role="alert">批注暂时没读到。<button type="button" className="text-action" onClick={() => void loadNoteAnnotations()}>重试</button></p> : null}
        {learningArtifactError && !activeLearningArtifact ? <p className="notebook-footprint-error" role="alert">互动讲解暂时没读到。<button type="button" className="text-action" onClick={() => void loadNoteLearningArtifacts()}>重试</button></p> : null}
        {expansionError ? <p className="notebook-footprint-error" role="alert">拓展笔记暂时没读到。<button type="button" className="text-action" onClick={() => void loadNoteExpansions()}>重试</button></p> : null}
        {footprintRowsLoaded && !footprintHasRecords ? (
          <div className="notebook-history-empty notebook-footprint-empty">
            <History size={28} aria-hidden="true" />
            <p>这篇笔记还没有学习记录。</p>
            <p className="small">回到正文，先看懂这篇、回想一下，或圈出难懂的一句；做过的内容会留在这里。</p>
            <button type="button" className="button primary" onClick={() => setLeaf("reading")}>回到笔记，选一种方式开始</button>
          </div>
        ) : null}
      </section>}</div>)}
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
    </>
  ) : null;

  /** 「版本历史」那一颗：阅读页与编辑页共用；此前只有阅读页摆出按钮，编辑态摸不到（复盘 #15）。 */
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
  const pageTitle = leaf === "expansion" ? "往外学" : leaf === "history" ? "学习记录"
    : learningView === "overview" ? "这篇的速看" : learningView === "recall" ? "回想一下" : learningView === "artifact" ? "互动讲解"
      : isNoteEditingMode(mode) ? "笔记编辑" : "这篇笔记";
  const pageSubtitle = leaf === "expansion" ? "先翻开，再决定收下哪篇" : leaf === "history" ? "留下的线索都在这页"
    : learningView === "recall" ? "先自己想想，再翻开原文" : learningView === "overview" ? "抓住要点，回原文核对"
      : isNoteEditingMode(mode) ? "写下理解，留下可回看的版本" : "原文还在，接着往下读";

  const editChrome = note ? <NotebookEditorTools title={titleValue || "笔记"} editorRef={editorRef} editable={editable} canUpload={Boolean(note.permissions.canSave)} fileInputRef={imageUploads.fileInputRef} onImages={imageUploads.queueFiles} onLink={linkEditor.open} /> : null;

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
          aiRanges={noteAiRanges}
          onChange={applyContent}
          disabled={!editable || leaf !== "reading" || learningView !== "body"}
          onImagePaste={imageUploads.queueFile}
          onImagesPaste={imageUploads.queueFiles}
          imageUploads={imageUploads.uploads}
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
      </> : null}
    </div>
  ) : null;



  // One visibility entry stays outside the scrolling paper in reading, editing and fullscreen.
  // Private notes expose their scope here too, without inventing a presence list.
  const presenceRow = !note || !spaceIdentity || spaceIdentity.isPersonal ? null : (
    <NotebookSharingControl
      key={note.noteId}
      shareScope={note.shareScope}
      canShare={note.permissions.canShare}
      busy={sharing}
      onShare={setShareScope}
      peers={noteDocLive.presencePeers}
      selfName={presenceName}
      selfMode={isNoteEditingMode(mode) ? "editing" : "reading"}
      failure={noteDocLive.failure}
    />
  );
  const saveStatusLabel = saving || saveState === "saving" ? "正在保存…"
    : saveState === "error" ? "这次没保存上"
      : dirty ? "草稿"
        : saveState === "committed" && receipt
          ? receipt.via === "queued" ? "离线暂存" : receipt.via === "stream" ? "正在同步" : receipt.isAutosave ? "已自动保存" : "已保存"
          : "已同步";

  useNotebookFullscreenSession(note ? { noteId: note.noteId, noteVersionId: activeNoteRef?.noteVersionId ?? null, mode } : null);
  const notebookFullscreen = useNotebookFullscreenActive();
  return (
    <>
      <div className="task-title notebook-page-title" data-editing={isNoteEditingMode(mode) && learningView === "body" && leaf === "reading" || undefined}><h1>{pageTitle}</h1><p>{pageSubtitle}</p></div>
      <main className="content notebook-space">
        {linkEditor.dialog}
        <div className="notebook-detail-layout">
        <NotebookNoteList currentId={activeNoteRef?.noteId ?? note?.noteId ?? null}
          currentTitle={note && (!activeNoteRef || activeNoteRef.noteId === note.noteId) ? readTitle : null}
          fullscreen={notebookFullscreen} onSelect={noteId => {
            rememberReadingPosition();
            openNotebookListNote(noteId, note ? { noteId: note.noteId, noteVersionId: activeNoteRef?.noteVersionId ?? null, mode } : null);
          }} />
        <article
          className="notebook-workspace notebook-hud"
          aria-busy={loading || undefined}
          data-mode={mode}
          {...writingPreferenceAttributes(writingPreferences)}
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
            imageUploads.queueFiles(files);
          }}
        >
          {statePaper ? <div className="notebook-workspace__state">{statePaper}</div> : null}
          {statePaper && notebookFullscreen ? <NotebookFullscreenRibbon onExit={() => useNotebookFullscreenState.setState({ active: false })} /> : null}
          {!loading && !failure && note ? (
            <>
              <NotebookDesk
                // 只有画布真的挂出来时才让画布自己管全屏：脑图还没生成时纸面是「生成脑图内容」那一页，页内全屏入口不能被藏掉。
                mindMapActive={leaf === "reading" && learningView === "overview" && Boolean(brainActive && mindMap.latestNoteMindMap)}
                overviewSwitch={leaf === "reading" && learningView === "overview" ? <NotebookOverviewSwitch active={brainActive ? "mindMap" : "points"}
                  onSelect={(tab) => { clearGoalResultSelection(); setOverviewTab({ noteId: note.noteId, tab }); }} /> : null}
                noteId={note.noteId} noteTitle={readTitle || "未命名笔记"} version={note.currentVersion.versionNo} mode={mode} canEdit={editable} pendingMode={pendingMode}
                presence={presenceRow}
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
                    {note.sourceId ? <button type="button" className="text-action" title={sourceTitle} onClick={() => setSourceBagOpen(true)}><FileText size={13} aria-hidden="true" />资料袋</button> : <span>独立笔记</span>}
                    {/*
                        「来源片段」这四个字在屏上**只表示一个数**（2026-09-25 真窗口量到）：
                        资料卡片写 `第 N 段来源片段`（那是序号），页眉这里写条数。
                        两边曾经都是「来源片段 NN」，一个序号一个计数，她照着念就念出
                        自相矛盾的话。所以这里只放条数，卡片那侧只放序号。
                      */}
                    {segments.length > 0 ? <span>来源片段 {segments.length}</span> : null}
                    {noteExpansions.length ? <button type="button" className="text-action" onClick={() => openExpansionPage()}><Link2 size={13} aria-hidden="true" />往外学 · {noteExpansions.length}</button> : null}
                    <time dateTime={note.currentVersion.updatedAt}>{formatRelative(note.currentVersion.updatedAt)}更新</time>
                    {!isNoteEditingMode(mode) ? saveState === "error" ? <><span title={saveLabel} role="status">{saveStatusLabel}</span><button type="button" className="text-action" onClick={() => switchMode("live-preview")}>去编辑并重试</button></> : <span title={saveLabel} role="status">{saveStatusLabel}</span> : null}
                    {!editable ? <span className="tag">只读</span> : null}
                  </div>
                </header> : null}
                onMode={switchMode} outline={noteOutline(noteDocLive.fragment, readSourceBlocks)
                  // The hidden duplicate title heading has no rendered target; keep
                  // the page's own outline pointing at headings that are on the page.
                  .filter((entry) => entry.block !== leadingTitleBlock?.ordinal)}
                onLocate={locateTeachingReference}
                onOpenDirectory={() => { setHistoryOpen(false); setSourceBagOpen(false); setOpenAnnotationId(null); setAnnotationTaskOpen(false); }}
                learningView={leaf === "reading" ? learningView : leaf}
                onLearning={learningEntry.request}
                onBody={() => { clearGoalResultSelection(); rememberReadingPosition(); closeSidePage(); setLeaf("reading"); setLearningView("body"); setOverviewOpen(false); }}
                onHistory={() => { clearGoalResultSelection(); rememberReadingPosition(); closeSidePage(); setLeaf("history"); }}
                onCard={() => {
                  clearGoalResultSelection(); rememberReadingPosition(); closeSidePage();
                  openNoteLearningCard({ noteId: note.noteId, noteVersionId: note.currentVersionId, mode });
                }}
                primaryAction={isNoteEditingMode(mode) && leaf === "reading" && learningView === "body" && canSave ? <button type="button" className="button primary"
                    disabled={saving} onClick={() => void save("manual")}>{saveState === "error" ? "重试保存" : saving ? "正在保存…" : "保存版本"}</button> : null}
                taskActions={leaf === "expansion" && expansionTask?.status === "ready" ? <>
                  <span className="notebook-expansion-selection" role="status">待收下 {pendingExpansionDrafts.length} 篇 · 未选中的仍是草稿</span>
                  <button type="button" className="button primary" disabled={expansionReviewSaving || !pendingExpansionDrafts.length} onClick={() => void confirmNoteExpansionDrafts()}>{expansionReviewSaving ? "正在保存…" : `确认收下 ${pendingExpansionDrafts.length} 篇`}</button>
                </> : null}
                sourceAction={<button type="button" className="text-action notebook-desk__utility-icon" aria-label="资料袋" title="资料袋" aria-expanded={sourceBagOpen} onClick={() => setSourceBagOpen(!sourceBagOpen)}><Link2 size={16} aria-hidden="true" /><span className="notebook-desk__utility-label">资料袋</span></button>}
                extraActions={<>
                  {annotationDraft.draft ? <button type="button" className="text-action" onClick={() => setAnnotationDraftOpen(true)}><PencilLine size={14} aria-hidden="true" />继续写批注</button> : null}
                  {versionAndOptionsToggles}
                </>}
                tools={isNoteEditingMode(mode) && leaf === "reading" && learningView === "body" ? editChrome : null}
                status={<><span className={dirty || saveState === "error" ? "tag red notebook-save-status" : "tag notebook-save-status"}
                  data-state={saveState === "error" ? "error" : saving || dirty || saveStatusLabel === "正在同步" || saveStatusLabel === "离线暂存" ? "pending" : "saved"}
                  title={saveLabel} role="status">{saveStatusLabel}</span>
                  {!editable ? <span className="tag">只读</span> : null}
                  </>}
                scrollRef={leafScrollRef}
                saveError={saveState === "error" ? saveLabel : null}
                sidePage={historyOpen ? { kind: "history", title: "版本历史", closeLabel: "收起版本历史", onClose: () => setHistoryOpen(false), content: historyPaper } : sourceBagOpen ? { kind: "source", title: "资料袋", closeLabel: "合起资料袋", onClose: () => setSourceBagOpen(false), content: <>
                  <h3>原始资料</h3><p>{sourceTitle}</p>{clips}
                  {note.sourceId ? <button type="button" className="button" onClick={openSource}>打开只读原始资料</button> : null}
                </> } : annotationSidePage ? { kind: "annotation", title: annotationDraftOpen ? "写批注" : openCompanionExplanation ? "伴星解释" : "原句批注", closeLabel: "收起批注", onClose: closeSidePage, content: annotationSidePage } : null}
              >
                {learningEntry.choice ? <NotebookVersionChoice kind={learningEntry.choice} version={note.currentVersion.versionNo}
                  regenerating={learningEntry.regenerating}
                  canSave={canSave} saving={learningEntry.saving} error={learningEntry.error} hasChanges={readingUnversionedContent || dirty} existing={learningEntry.existing}
                  onSaved={learningEntry.startSaved} onSave={() => void learningEntry.saveAndStart()} onDismiss={learningEntry.dismiss} /> : null}
                <CompanionNoteWritePreview noteId={note.noteId}>
                  <div hidden={leaf !== "reading" || learningView !== "body" || !isNoteEditingMode(mode)}>{editPageBody}</div>
                  <div hidden={leaf === "reading" && learningView === "body" && isNoteEditingMode(mode)}>{readPageBody}</div>
                </CompanionNoteWritePreview>
              </NotebookDesk>
              {selectedPassage && leaf === "reading" && learningView === "body" && mode === "preview" ? <NotebookSelectionActions
                range={selectedPassage.range} scrollRef={leafScrollRef} hasAnchor={Boolean(selectedPassage.anchor)} dirty={dirty} busy={annotationTaskStarting}
                companionPending={Boolean(selectedPassage.anchor && noteCompanionExplanations.some(item => (noteExplanationBusy(item) || item.phase === "save-error") && noteAnchorsOverlap(item.target.anchor, selectedPassage.anchor!)))}
                onExplain={() => { explainSelectedPassage(); setSelectedPassage(null); window.getSelection()?.removeAllRanges(); }}
                onWrite={() => { if (selectedPassage.anchor) { annotationDraft.start(selectedPassage.anchor); setAnnotationDraftOpen(true); setSelectedPassage(null); window.getSelection()?.removeAllRanges(); } }}
                onAskCompanion={askCompanionAboutSelectedPassage} onEditWithCompanion={editable && selectedPassage.anchor ? () => {
                  feedSelectionToCompanion({ text: selectedPassage.text, source: "selection" });
                  setSelectedPassage(null); window.getSelection()?.removeAllRanges();
                } : undefined} onDismiss={() => { setSelectedPassage(null); window.getSelection()?.removeAllRanges(); }} /> : null}
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
        </div>
      </main>
    </>
  );
}
