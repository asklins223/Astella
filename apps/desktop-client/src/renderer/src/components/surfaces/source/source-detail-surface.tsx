import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Archive, ArrowRight, BookOpen, Check, FileText, List, LoaderCircle, Pencil, RotateCcw, X } from "lucide-react";
import type {
  DesktopSourceDetail,
  DesktopSourceNotesPage,
  DesktopSourceSegment,
} from "@ailearn/shared/desktop-surface-contracts";
import type { PageReadableV1 } from "@ailearn/shared/companion-bridge-contracts";
import { parseMarkdownTable } from "@ailearn/shared/note-doc-schema";
import { useRoomStore } from "../../../app/room-store";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult, RendererGatewayError } from "../../../app/desktop-client";
import { HudPage } from "../../hud/HudPage";
import { useHudPage } from "../../hud/use-hud-page";
import { usePageReadableView } from "../../hud/use-page-readable-view";
import { HUD_PAGES } from "../../hud/hud-pages";
import {
  SurfaceDataState,
  formatDate,
  formatRelative,
  formatSourceKindLabel,
  formatSourceStatus,
  parseImageBlock,
  useSurfaceProjection,
} from "../notebook/surface-data.tsx";
import {
  SOURCE_STATUS_POLL_MAX_ATTEMPTS,
  SOURCE_STATUS_POLL_MS,
  isSourceSettling,
  needsOriginAddress,
} from "./source-index.ts";
import {
  describeStructure,
  excerpt,
  listSegment,
  parseStateLine,
  segmentLabel,
  segmentText,
} from "./source-segments.ts";
import { useSourceImage } from "./source-image.ts";
import { ZoomableReadingImage } from "./image-viewer.tsx";
import { useSourceMotion, useSourceSheetMotion } from "./use-source-motion";
import { renderNoteInline } from "../notebook/note-reading-inline";

const readingPositions = new Map<string, number>();

type SourceDetailProjection = {
  readonly detail: DesktopSourceDetail;
  readonly notes: DesktopSourceNotesPage;
  /** `source.update` / `source.createNote` / `source.archive` are owner-only on the API. */
  readonly canRename: boolean;
  readonly canStartNote: boolean;
  readonly canArchive: boolean;
};

/** A note that already holds the same content, as the API reported it. */
type DuplicateNote = { readonly noteId: string; readonly title: string };

/**
 * 屏上那几句状态字各写一次：JSX 与登记给伴星的可读视图共用同一份表达式。
 * 抄成两处就是两个来源——而视图字段写错了**不会红**（只有 `usePageReadableView`
 * 那道形状校验会喊），最后只会变成"她说的与屏幕上不是一句"。
 */
const NO_SOURCE_SCREEN = {
  message: "还没有选择来源",
  detail: "从来源库打开一份材料后，这里会直接铺开它的正文与解析结果。",
} as const;
const SOURCE_GONE_SCREEN = {
  message: "这份来源已经不在当前工作区",
  detail: "它可能被移除或归档，返回来源库可以继续查找其它材料。",
} as const;
const STALLED_SCREEN_LINE = "解析还在进行，页面已停止自动刷新。";
const NO_NOTE_SCREEN_LINE = "还没有基于这份材料建立的笔记；开始写笔记会从它的片段直接起稿。";

/** Original text stays central; structure and notes open as loose sheets. */
export function SourceDetailSurface() {
  const scope = useRoomStore(state => state.workspaceScopeRevision);
  const activeSourceId = useRoomStore((state) => state.activeSourceId);
  return <SourceDetailContent key={`${scope}:${activeSourceId}`} scope={scope} activeSourceId={activeSourceId} />;
}

function SourceDetailContent({ scope, activeSourceId }: { readonly scope: number; readonly activeSourceId: string | null }) {
  const setActiveNoteRef = useRoomStore((state) => state.setActiveNoteRef);
  const setActiveSourceId = useRoomStore(state => state.setActiveSourceId);
  const invoke = useRoomStore((state) => state.invoke);
  useHudPage("source-detail");

  /** The title draft while the headline is a field; null means it reads. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [busy, setBusy] = useState<"rename" | "note" | "archive" | "reparse" | "restore" | null>(null);
  const [notice, setNotice] = useState<{ readonly tone: "info" | "error"; readonly text: string } | null>(null);
  const [duplicate, setDuplicate] = useState<DuplicateNote | null>(null);
  const [archiveConfirm, setArchiveConfirm] = useState(false);
  /** The bounded poll gave up while the server was still parsing. */
  const [stalled, setStalled] = useState(false);
  const pollAttemptsRef = useRef(0);
  /** Set while the field is being closed on purpose, so its blur cannot commit. */
  const renameAbortRef = useRef(false);
  const alive = useRef(true);
  const busyRef = useRef(false);
  const readerRef = useRef<HTMLDivElement>(null);
  const articleRef = useRef<HTMLElement>(null);
  const sideRef = useRef<HTMLElement>(null);
  const fragmentsTrigger = useRef<HTMLButtonElement>(null);
  const notesTrigger = useRef<HTMLButtonElement>(null);
  const restoredPosition = useRef(false);
  const [panel, setPanel] = useState<"structure" | "notes" | null>(null);
  const lastPanel = useRef<"structure" | "notes">("structure");
  if (panel) lastPanel.current = panel;
  const panelContent = panel ?? lastPanel.current;
  const [selectedSegment, setSelectedSegment] = useState<string | null>(null);
  const positionKey = `${scope}:${activeSourceId}`;
  useSourceMotion(readerRef, `${activeSourceId}`);
  useSourceSheetMotion(sideRef, panel !== null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useLayoutEffect(() => {
    if (panel) sideRef.current?.querySelector<HTMLButtonElement>(".source-side-close")?.focus({ preventScroll: true });
  }, [panel]);
  const closePanel = () => { const previous = panel; setPanel(null); (previous === "structure" ? fragmentsTrigger : notesTrigger).current?.focus({ preventScroll: true }); };

  const { data, loading, failure, reload, epochRef, refreshFailure } = useSurfaceProjection(async ({ workspaceEpoch }) => {
    if (!activeSourceId) return null;
    const meta = () => createRequestMeta(workspaceEpoch);
    const [detailResponse, notesResponse, capabilitiesResponse] = await Promise.all([
      window.ailearn.source.get({ meta: meta(), sourceId: activeSourceId }),
      window.ailearn.source.listNotes({ meta: meta(), sourceId: activeSourceId }),
      window.ailearn.capabilities.get({ meta: meta() }),
    ]);
    const capabilities = unwrapGatewayResult(capabilitiesResponse).actionCapabilities;
    return {
      detail: unwrapGatewayResult(detailResponse),
      notes: unwrapGatewayResult(notesResponse),
      canRename: capabilities["source.update"] === "allowed",
      canStartNote: capabilities["source.createNote"] === "allowed",
      canArchive: capabilities["source.archive"] === "allowed",
    } satisfies SourceDetailProjection;
  }, [activeSourceId], { refreshOnFocus: true });

  const source = data?.detail.source ?? null;
  const segments = data?.detail.segments ?? [];
  const notes = data?.notes.items ?? [];
  useLayoutEffect(() => {
    if (!loading && data && articleRef.current && !restoredPosition.current) {
      articleRef.current.scrollTop = readingPositions.get(positionKey) ?? 0;
      restoredPosition.current = true;
    }
  }, [data, loading, positionKey]);

  /**
   * The chapter tab counts what the workspace holds, not what one page of the
   * notes endpoint returned: `GET /sources/:id/notes` answers with the newest
   * fifty plus the source's real total, so a source with more notes can say so.
   */
  const noteTotal = Math.max(data?.notes.total ?? 0, notes.length);

  /**
   * The one note "继续写" can open. `currentVersionId` is what the writer needs,
   * and a note without a version has nothing to open yet.
   */
  const continueTarget = useMemo(() => {
    for (const note of notes) {
      if (note.currentVersionId) return { noteId: note.id, versionId: note.currentVersionId, title: note.title };
    }
    return null;
  }, [notes]);

  const structureLine = useMemo(
    () => describeStructure(segments, source?.status),
    [segments, source?.status],
  );

  /**
   * 这一屏登记给伴星读的可读视图（39d W2-7）。
   *
   * 标题＝`<h2>` 里那份**已提交**的来源标题（改名框里那份是草稿，没落库就不算屏上
   * 那一句）；状态行＝"解析与结构"下面那句 `structureLine`；四个数全部复用页面已经
   * 在渲染的派生值（`<div className="meta">` 的状态与类型、页签上的片段数与笔记数）；
   * 条目＝右栏"关联笔记"那一批，`state` 就是每行 `<small>` 的前半句。
   *
   * `notice` 是一条**按优先级选出来的**屏上原话：读不到 ＞ 刚做过什么的回执 ＞
   * 停止自动刷新 ＞ 没有正文 ＞ 没有笔记 ＞ 笔记只列了最近几篇。
   * 没有一份是推断出来的。
   */
  const notesTruncatedLine
    = notes.length > 1 && noteTotal > notes.length
      ? `共 ${noteTotal} 篇，这里列出最近 ${notes.length} 篇。`
      : null;
  const detailNotice
    = !activeSourceId
      ? `${NO_SOURCE_SCREEN.message}：${NO_SOURCE_SCREEN.detail}`
      : failure
        ? `来源详情暂时不可用：${failure.slice(0, 60)}`
        : !source
          ? `${SOURCE_GONE_SCREEN.message}：${SOURCE_GONE_SCREEN.detail}`
          : notice?.text
            ? notice.text.slice(0, 200)
            : stalled
              ? STALLED_SCREEN_LINE
              : segments.length === 0
                ? parseStateLine(source.status)
                : panel === "notes" && notes.length === 0
                  ? NO_NOTE_SCREEN_LINE
                  : panel === "notes" ? notesTruncatedLine : null;
  const readableView = useMemo<PageReadableV1 | null>(() => {
    // 选了某一份材料、却还没读到它：什么都不登记，别把上一份的残留留给这一页。
    if (activeSourceId && !source && !failure) return null;
    return {
      pageId: "source_detail",
      title: source?.title ?? HUD_PAGES["source-detail"].title,
      statusLine: source ? structureLine : NO_SOURCE_SCREEN.message,
      metrics: source
        ? [
            { label: "状态", value: formatSourceStatus(source.status) },
            { label: "类型", value: `${formatSourceKindLabel(source)}来源` },
            { label: "片段", value: `${segments.length}` },
            { label: "关联笔记", value: `${noteTotal}` },
          ]
        : [],
      ...(panel === "notes" && notes.length > 0
        ? {
            items: notes.slice(0, 12).map((note, index) => ({
              ordinal: index + 1,
              label: `《${note.title}》`.slice(0, 120),
              state: (note.currentVersionId ? "已存好" : "还没有版本").slice(0, 40),
            })),
          }
        : {}),
      ...(detailNotice ? { notice: detailNotice } : {}),
    };
  }, [activeSourceId, detailNotice, failure, noteTotal, notes, panel, segments.length, source, structureLine]);
  usePageReadableView(readableView);

  // Another source is another page: a half-typed title or an unconfirmed note
  // must not follow the reader into it.
  useEffect(() => {
    setRenaming(null);
    setDuplicate(null);
    setNotice(null);
    setBusy(null);
    setArchiveConfirm(false);
    setStalled(false);
    renameAbortRef.current = false;
    pollAttemptsRef.current = 0;
  }, [activeSourceId]);

  // Parsing finishes after the capture form closes, and this page is where the
  // reader waits for it: keep asking while the server still holds the source
  // (`draft` is the state a fresh capture lands in), within a bounded budget so a
  // stuck job cannot keep the read alive forever. When the budget runs out the
  // page says so and offers a re-read instead of waiting silently.
  useEffect(() => {
    if (!source || !isSourceSettling(source.status)) {
      pollAttemptsRef.current = 0;
      setStalled(false);
      return;
    }
    if (pollAttemptsRef.current >= SOURCE_STATUS_POLL_MAX_ATTEMPTS) {
      setStalled(true);
      return;
    }
    const timer = window.setTimeout(() => {
      pollAttemptsRef.current += 1;
      void reload({ silent: true });
    }, SOURCE_STATUS_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [source, reload]);

  const retryRead = () => {
    pollAttemptsRef.current = 0;
    setStalled(false);
    void reload({ silent: true });
  };

  const sourceId = source?.id ?? null;
  const canRename = data?.canRename ?? false;
  const canStartNote = data?.canStartNote ?? false;
  const canArchive = data?.canArchive ?? false;
  const titleSegment = segments[0]?.segmentType === "heading" && segmentText(segments[0]) === source?.title ? segments[0] : null;

  /**
   * Why "开始写笔记" cannot run yet, in the order the API would refuse it: only a
   * `ready` source with fragments becomes a note (see `createNoteFromSource`),
   * and only an owner may ask. Saying so up front beats a 409 after the click.
   */
  const startBlockedReason = !source
    ? null
    : !canStartNote
      ? "当前工作区的身份只能阅读来源，不能从来源开始笔记。"
      : source.status === "archived"
        ? "这份来源已经归档；要接着用它，先在上面点「恢复来源」。"
        : source.status !== "ready"
          ? "材料解析完成后才能开始写笔记。"
          : segments.length === 0
            ? "这份来源还没有可引用的片段，先去来源库补充正文。"
            : null;

  const openNote = (noteId: string, noteVersionId: string, mode: "preview" | "live-preview") => {
    setActiveNoteRef({ noteId, noteVersionId, mode });
    invoke("open-notebook", { returnTo: { label: "返回来源资料", run: () => {
      setActiveSourceId(sourceId);
      invoke("open-source", { returnTo: { label: "返回来源库", run: () => invoke("open-sources") } });
    } } });
  };

  /** Leaving the field without saving: Escape and 取消 both come through here. */
  const closeRename = () => {
    renameAbortRef.current = true;
    setRenaming(null);
  };

  const openRename = () => {
    renameAbortRef.current = false;
    setNotice(null);
    setRenaming(source?.title ?? "");
  };

  /** Renaming a source is a title-only save: the server owns the parse state. */
  const renameSource = async () => {
    const title = renaming?.trim() ?? "";
    if (!sourceId || busyRef.current) return;
    if (!title || title === source?.title) {
      setRenaming(null);
      return;
    }
    busyRef.current = true; setBusy("rename");
    setNotice(null);
    try {
      unwrapGatewayResult(await window.ailearn.source.update({
        meta: createRequestMeta(epochRef.current),
        sourceId,
        request: { title },
      }));
      if (!alive.current) return;
      setRenaming(null);
      await reload({ silent: true });
    } catch (error) {
      if (alive.current) setNotice({ tone: "error", text: `改标题没成功：${gatewayErrorMessage(error)}` });
    } finally {
      busyRef.current = false; if (alive.current) setBusy(null);
    }
  };

  /**
   * Clicking away from the field is a save, the way every other inline title
   * behaves. Two blurs are not: the one the action row's own buttons cause (they
   * commit or cancel on click) and the one a deliberate close causes.
   */
  const commitRenameOnBlur = (event: React.FocusEvent<HTMLInputElement>) => {
    if (renameAbortRef.current) {
      renameAbortRef.current = false;
      return;
    }
    if (event.relatedTarget instanceof HTMLElement && event.relatedTarget.closest(".actions")) return;
    void renameSource();
  };

  /**
   * Build a note out of the source's fragments and
   * land in the writer. A note that already carries the same content is not an
   * error to decode but a choice to make, so the duplicate answer is offered
   * back as "open it" or "make another".
   */
  const startNote = async (force = false) => {
    if (!sourceId || busyRef.current) return;
    busyRef.current = true; setBusy("note");
    setNotice(null);
    try {
      const result = unwrapGatewayResult(await window.ailearn.source.createNote({
        meta: createRequestMeta(epochRef.current),
        sourceId,
        ...(force ? { force: true } : {}),
      }));
      if (!alive.current) return;
      if (result.kind === "duplicate") {
        setDuplicate({ noteId: result.noteId, title: result.title });
        setNotice({ tone: "info", text: `服务器上已经有一篇内容相同的笔记《${result.title}》。打开它，或者再建一份副本。` });
        return;
      }
      setDuplicate(null);
      openNote(result.noteId, result.noteVersionId, "live-preview");
    } catch (error) {
      if (!alive.current) return;
      setNotice({
        tone: "error",
        text: source?.status === "ready"
          ? `开始笔记未确认：${gatewayErrorMessage(error)}`
          : "这份材料还没有解析完成；等状态变成「已就绪」再来开始写笔记。",
      });
    } finally {
      busyRef.current = false; if (alive.current) setBusy(null);
    }
  };

  /** Opening the duplicate needs the version id, which the notes page carries. */
  const openDuplicate = async () => {
    if (!duplicate || busyRef.current) return;
    const known = notes.find((note) => note.id === duplicate.noteId);
    if (known?.currentVersionId) {
      setDuplicate(null);
      openNote(known.id, known.currentVersionId, "live-preview");
      return;
    }
    busyRef.current = true; setBusy("note");
    try {
      const note = unwrapGatewayResult(await window.ailearn.note.get({ meta: createRequestMeta(epochRef.current), noteId: duplicate.noteId }));
      if (!alive.current) return;
      setDuplicate(null); openNote(note.noteId, note.currentVersionId, "live-preview");
    } catch (error) { if (alive.current) setNotice({ tone: "error", text: `这篇笔记暂时没打开：${gatewayErrorMessage(error)}` }); }
    finally { busyRef.current = false; if (alive.current) setBusy(null); }
  };

  /**
   * Archive is reversible and the source remains readable under 已归档.
   */
  const archiveSource = async () => {
    if (!sourceId || busyRef.current) return;
    busyRef.current = true; setBusy("archive");
    setNotice(null);
    try {
      unwrapGatewayResult(await window.ailearn.source.archive({
        meta: createRequestMeta(epochRef.current),
        sourceId,
      }));
      if (!alive.current) return;
      setArchiveConfirm(false);
      invoke("open-sources");
    } catch (error) {
      if (alive.current) setNotice({ tone: "error", text: `归档没成功：${gatewayErrorMessage(error)}` });
    } finally {
      busyRef.current = false; if (alive.current) setBusy(null);
    }
  };

  /**
   * 归档的逆操作（审计 F08）。
   *
   * 归档那条路写的提示语是"可在已归档页签找到"，而此前没有回去的路——数据一直在
   * （只是 `status=archived`），界面上唯一的后果却是"再也不能从它开始笔记"。
   * 恢复到哪一档由服务端按事实定（有片段 → `ready`，没有 → `draft`），回执照实说，
   * 不假装"恢复完成"就完事：这一档决定了用户接下来能做什么。
   */
  const restoreSource = async () => {
    if (!sourceId || busyRef.current) return;
    busyRef.current = true; setBusy("restore");
    setNotice(null);
    try {
      const restored = unwrapGatewayResult(await window.ailearn.source.restore({
        meta: createRequestMeta(epochRef.current),
        sourceId,
      }));
      if (!alive.current) return;
      setNotice({
        tone: "info",
        text: restored.alreadyActive
          ? "这份来源本来就没有归档。"
          : `已把《${source?.title ?? "这份来源"}》恢复到来源列表${
              restored.status === "ready"
                ? "，之前解析好的片段都还在"
                : "；它还没有正文片段，可以重新解析"
            }。`,
      });
      await reload({ silent: true });
    } catch (error) {
      if (alive.current) setNotice({ tone: "error", text: `恢复没成功：${gatewayErrorMessage(error)}` });
    } finally {
      busyRef.current = false; if (alive.current) setBusy(null);
    }
  };

  /**
   * 重新解析这一篇（doc 34 L7）。文案里那句"打开来源后可以重新解析"以前没有对应的
   * 端点，也没有按钮——job 被判 dead 时只改 `jobs`，来源会永远停在「处理中」。
   *
   * 只给 `failed` 与 `processing` 两种状态看到：`ready` 不需要，`draft` 是刚建还没跑。
   * 服务端对"已经有任务在跑"回 409，这里原样把那句话显示出来而不是重试——
   * 重复入队是同一份外部调用付两遍钱。
   */
  const reparseSource = async () => {
    if (!sourceId || busyRef.current) return;
    busyRef.current = true; setBusy("reparse");
    setNotice(null);
    try {
      unwrapGatewayResult(await window.ailearn.source.reparse({
        meta: createRequestMeta(epochRef.current),
        sourceId,
      }));
      if (!alive.current) return;
      setNotice({ tone: "info", text: "已经排上重新解析了，稍后回到这一页看结果。" });
      pollAttemptsRef.current = 0; setStalled(false);
      void reload({ silent: true });
    } catch (error) {
      if (!alive.current) return;
      // 判"是不是已经有任务在跑"要认**错误码**，不是认文案：文案是
      // `gatewayErrorMessage` 按码翻出来的中文句子，拿它做子串匹配等于把
      // "改了措辞就静默走错分支"埋进这里。
      const inFlight = error instanceof RendererGatewayError && error.code === "conflict";
      setNotice({
        tone: "error",
        text: inFlight
          ? "这一篇已经有任务在跑了，不用重复排。"
          : `重新解析没排上：${gatewayErrorMessage(error)}`,
      });
    } finally {
      busyRef.current = false; if (alive.current) setBusy(null);
    }
  };

  const runPrimary = () => {
    if (continueTarget) {
      openNote(continueTarget.noteId, continueTarget.versionId, "live-preview");
      return;
    }
    if (notes.length > 0) {
      invoke("open-notes");
      return;
    }
    void startNote();
  };

  const primaryLabel = notes.length === 0
    ? busy === "note" ? "正在建立…" : "开始写笔记"
    : continueTarget ? "继续写笔记" : "前往笔记库";

  const archiveAvailable = canArchive && source?.status !== "archived";
  // 归档的逆操作：只有已归档的来源才看得到（审计 F08）。
  const restoreAvailable = canArchive && source?.status === "archived";
  // 与归档同一个门：能力投影里 owner 那批写能力是一起置位的（`source.update` 与
  // `source.archive` 不会一个开一个关），真判据仍在服务端 `requireOwner` 那一处。
  /**
   * 「重新解析」收的是"这一篇的解析没跑完、用户要自己再排一次"这三档。
   *
   * 过去这里少了 `draft`——而它恰恰是最容易卡死的那一档：采集落库就是 `draft`，
   * worker 停着、容器正在重启、或 job 判 dead 没收尾时，它会永远停在这里，
   * 界面上却没有一颗按钮能把它再排一次（`restoreSource` 的注释里写着"回到
   * draft，走既有的重新解析那条路"，可见这条路本来就该通）。
   *
   * 真判据仍在服务端：真有一条 pending/running 的 parse job 时它回 409，
   * 界面如实说"已经有任务在跑"，而不是替用户猜该不该点。
   */
  const reparseAvailable = canArchive
    && (source?.status === "failed"
      || source?.status === "processing"
      || source?.status === "draft");

  const actions = duplicate ? (
    <>
      <button type="button" className="button primary" disabled={!!busy} onClick={() => void openDuplicate()}><BookOpen size={16} aria-hidden="true" />打开已有笔记</button>
      <button type="button" className="text-action" disabled={busy === "note"} onClick={() => void startNote(true)}>仍然新建一份</button>
      <button type="button" className="text-action" onClick={() => { setDuplicate(null); setNotice(null); }}>取消</button>
    </>
  ) : archiveConfirm ? (
    <>
      <button type="button" className="button danger" disabled={busy === "archive"} onClick={() => void archiveSource()}>
        <Archive size={16} aria-hidden="true" />{busy === "archive" ? "正在归档…" : "确认归档"}
      </button>
      <button type="button" className="text-action" disabled={busy === "archive"} onClick={() => setArchiveConfirm(false)}>取消</button>
    </>
  ) : renaming !== null ? (
    <>
      <button type="button" className="button primary" disabled={busy === "rename"} onClick={() => void renameSource()}>
        <Check size={16} aria-hidden="true" />{busy === "rename" ? "正在保存…" : "保存标题"}
      </button>
      <button type="button" className="text-action" disabled={busy === "rename"} onClick={closeRename}>取消</button>
    </>
  ) : (
    <>
      <button
        type="button"
        className="button primary"
        disabled={!!busy || (notes.length === 0 && Boolean(startBlockedReason))}
        title={notes.length === 0 ? startBlockedReason ?? "从这份来源的片段建立一篇笔记" : "在写作页继续这篇笔记"}
        onClick={runPrimary}
      >
        {busy === "note" ? <LoaderCircle className="source-spin" size={16} aria-hidden="true" /> : <BookOpen size={16} aria-hidden="true" />}{primaryLabel}
      </button>
      {canRename ? (
        <button type="button" className="source-icon" aria-label="重命名" title="重命名" disabled={!!busy} onClick={openRename}><Pencil size={17} /></button>
      ) : null}
      {reparseAvailable ? (
        <button
          type="button"
          className="button"
          title="这一篇的解析还没跑完，或者已经停了——重新排一次"
          disabled={!!busy}
          onClick={() => void reparseSource()}
        >
          <RotateCcw size={16} aria-hidden="true" />{busy === "reparse" ? "正在重新排…" : "重新解析"}
        </button>
      ) : null}
      {restoreAvailable ? (
        <button
          type="button"
          className="button"
          title="把它放回默认的来源列表；之前解析好的片段都还在"
          disabled={!!busy}
          onClick={() => void restoreSource()}
        >
          <RotateCcw size={16} aria-hidden="true" />{busy === "restore" ? "正在恢复…" : "恢复来源"}
        </button>
      ) : null}
      {archiveAvailable ? (
        <button
          type="button"
          className="source-icon source-icon--muted"
          aria-label="归档"
          disabled={!!busy}
          title="归档后不再出现在默认索引，可在来源库的「已归档」页签找到，也能从这里恢复"
          onClick={() => { setNotice(null); setArchiveConfirm(true); }}
        >
          <Archive size={17} />
        </button>
      ) : null}
    </>
  );

  const jumpToSegment = (segment: DesktopSourceSegment) => {
    const target = articleRef.current?.querySelector<HTMLElement>(`[data-source-segment="${segment.id}"]`);
    closePanel();
    setSelectedSegment(segment.id);
    target?.scrollIntoView({ block: "start", behavior: "instant" });
    target?.focus({ preventScroll: true });
  };

  return (
    <HudPage page="source-detail">
      <div ref={readerRef} className="source-reader source-experience">
        {!activeSourceId ? <SurfaceDataState kind="empty" message={NO_SOURCE_SCREEN.message} detail={NO_SOURCE_SCREEN.detail} /> : null}
        {activeSourceId && loading ? <SurfaceDataState kind="loading" message="正在读取来源详情" detail="正在取回原文与笔记。" /> : null}
        {activeSourceId && !loading && failure ? <SurfaceDataState kind="error" message="来源详情暂时不可用" detail={failure} onRetry={retryRead} /> : null}
        {activeSourceId && !loading && !failure && !source ? <SurfaceDataState kind="empty" message={SOURCE_GONE_SCREEN.message} detail={SOURCE_GONE_SCREEN.detail} /> : null}
        {!loading && !failure && source ? <>
          <header className="source-reader-tools">
            <div className="chapter-tabs" role="group" aria-label="来源详情分区">
              <span className="source-reading-label"><FileText size={17} aria-hidden="true" />正文</span>
              <button ref={fragmentsTrigger} type="button" aria-expanded={panel === "structure"} aria-controls="source-side-sheet" onClick={() => panel === "structure" ? closePanel() : setPanel("structure")}>
                <List size={16} aria-hidden="true" /><span>片段 {segments.length}</span>
              </button>
              <button ref={notesTrigger} type="button" aria-expanded={panel === "notes"} aria-controls="source-side-sheet" onClick={() => panel === "notes" ? closePanel() : setPanel("notes")}>
                <BookOpen size={16} aria-hidden="true" /><span>笔记 {noteTotal}</span>
              </button>
            </div>
            <div className="source-command-bar actions">{actions}</div>
          </header>
          <div className="source-reader-notices">
            {archiveConfirm ? <p className="source-archive-question">把这份材料暂时收起来？之后可以在「已归档」里找回，笔记会保留。</p> : null}
            {notice ? <p className={`surface-notice${notice.tone === "error" ? " surface-notice--error" : ""}`} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}</p> : null}
            {refreshFailure ? <p className="surface-notice surface-notice--error" role="alert">更新暂时没取回：{refreshFailure}<button type="button" className="text-action" onClick={retryRead}>重新读取</button></p> : null}
            {stalled ? <p className="surface-notice" role="status">{STALLED_SCREEN_LINE}<button type="button" className="text-action" onClick={retryRead}>重新读取</button></p> : null}
            {notes.length === 0 && startBlockedReason ? <p className="source-blocked-reason">{startBlockedReason}</p> : null}
          </div>
          <article ref={articleRef} className="source-reading-paper article-copy" aria-label="来源正文"
            onScroll={event => { if (restoredPosition.current) readingPositions.set(positionKey, event.currentTarget.scrollTop); }}>
            <div className="source-reading-inner">
              <div className="meta">
                <span>{formatSourceKindLabel(source)}来源</span>
                <span data-status={source.status}>{formatSourceStatus(source.status)}</span>
                <time dateTime={source.updatedAt}>{formatRelative(source.updatedAt)}更新</time>
              </div>
              <div className={titleSegment ? "source-segment" : undefined} data-source-segment={titleSegment?.id} data-selected={titleSegment && selectedSegment === titleSegment.id || undefined} tabIndex={titleSegment ? -1 : undefined}>
              {renaming === null ? <h2>{source.title}</h2> : <>
                <label className="sr-only" htmlFor="source-title-input">新的来源标题</label>
                <input id="source-title-input" className="note-rename-input" value={renaming} autoFocus maxLength={500} disabled={busy === "rename"}
                  onChange={event => setRenaming(event.currentTarget.value)} onBlur={commitRenameOnBlur}
                  onKeyDown={event => {
                    if (event.key === "Enter") { event.preventDefault(); void renameSource(); }
                    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeRename(); }
                  }} />
              </>}
              </div>
              <p className="source-structure-line">{structureLine}</p>
              {segments.length === 0 ? <p className="source-parse-state sub" role="status">{parseStateLine(source.status)}</p> : segments.filter(segment => segment !== titleSegment).map(segment => (
                <div key={segment.id} className="source-segment" data-source-segment={segment.id} data-selected={selectedSegment === segment.id || undefined} tabIndex={-1}>
                  <SegmentBody segment={segment} workspaceEpoch={epochRef.current} />
                </div>
              ))}
              <footer className="source-provenance">
                <dl className="source-facts">
                  <div><dt>来源地址</dt><dd>{source.origin ?? (needsOriginAddress(source) ? "这份网页来源没有记录地址" : "粘贴的正文，没有地址")}</dd></div>
                  <div><dt>收录于</dt><dd><time dateTime={source.createdAt}>{formatDate(source.createdAt)}</time></dd></div>
                </dl>
              </footer>
            </div>
          </article>
        </> : null}
        <aside ref={sideRef} id="source-side-sheet" className="source-side-sheet" role="dialog" aria-label={panelContent === "notes" ? "关联笔记" : "解析与片段"} aria-modal="false" inert={panel === null}
          onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closePanel(); } }}>
          <header className="source-sheet-heading">
            <h3>{panelContent === "notes" ? "从这里写下的笔记" : "解析与片段"}</h3>
            <button type="button" className="source-icon source-side-close" aria-label="收起附页" title="收起附页" onClick={closePanel}><X size={18} /></button>
          </header>
          {panelContent === "notes" ? <>
            {notes.length === 0 ? <p className="sub">{NO_NOTE_SCREEN_LINE}</p> : <div className="note-links">
              {notes.map(note => <button key={note.id} type="button" disabled={!note.currentVersionId} title={note.currentVersionId ? "打开这篇笔记" : "这篇笔记还没有版本"}
                onClick={() => { if (note.currentVersionId) openNote(note.id, note.currentVersionId, "preview"); }}>
                <BookOpen size={19} aria-hidden="true" />
                <span><b>《{note.title}》</b><small>{note.currentVersionId ? "已存好" : "还没有版本"} · {formatRelative(note.updatedAt)}</small></span>
                <ArrowRight size={15} aria-hidden="true" />
              </button>)}
            </div>}
            {notesTruncatedLine ? <p className="small">{notesTruncatedLine}</p> : null}
          </> : <><p className="sub">{structureLine}</p>
            <ol className="source-fragments">{segments.map(segment => <li key={segment.id}>
              <button type="button" onClick={() => jumpToSegment(segment)}>
                <b>{segment.ordinal + 1}</b>
                <span><small>{segmentLabel(segment)}</small>{excerpt(segmentText(segment), 90)}</span>
                <ArrowRight size={14} aria-hidden="true" />
              </button>
            </li>)}</ol>
          </>}
        </aside>
      </div>
    </HudPage>
  );
}

/** One parsed fragment, rendered with the weight its own segment type carries. */
function SegmentBody({
  segment,
  workspaceEpoch,
}: {
  readonly segment: DesktopSourceSegment;
  /** 站内图片的字节请求要带上它，工作区换了就不该再回旧图。 */
  readonly workspaceEpoch?: number;
}) {
  if (segment.segmentType === "code") return <pre className="code-block"><code>{segmentText(segment)}</code></pre>;
  const inline = (text: string) => renderNoteInline(text, { workspaceEpoch });
  if (segment.segmentType === "heading") return <h3 className="serif">{inline(segmentText(segment))}</h3>;
  if (segment.segmentType === "list") {
    const { ordered, items } = listSegment(segment.text);
    const List = ordered ? "ol" : "ul";
    const start = ordered ? Number(/^\s*(\d+)\.\s/.exec(segment.text)?.[1] ?? 1) : undefined;
    return (
      <List className="list-block" start={start}>
        {items.map((item, index) => <li key={index}>{inline(item)}</li>)}
      </List>
    );
  }
  // 图片有自己的组件：它要先取字节再画图，不能把 hook 排在这一串早返回之后。
  if (segment.segmentType === "image") {
    return <SegmentImage segment={segment} workspaceEpoch={workspaceEpoch} />;
  }
  const text = segmentText(segment);
  if (segment.segmentType === "quote") return <p className="quote">{inline(text)}</p>;
  // Tables remain paragraph segments so evidence offsets still refer to the
  // untouched source. Use the notebook grammar for their reading presentation.
  const table = parseMarkdownTable(text);
  if (table) {
    const [header, separators, ...rows] = table;
    const alignments = (separators ?? []).map(separator => separator.endsWith(":")
      ? (separator.startsWith(":") ? "center" as const : "right" as const) : "left" as const);
    return <div className="source-table-scroll"><table className="source-table">
      <thead><tr>{header?.map((cell, index) => <th scope="col" key={index} style={{ textAlign: alignments[index] }}>{inline(cell)}</th>)}</tr></thead>
      <tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex} style={{ textAlign: alignments[cellIndex] }}>{inline(cell)}</td>)}</tr>)}</tbody>
    </table></div>;
  }
  return <p>{inline(text)}</p>;
}

/**
 * 一个图片片段。
 *
 * 解析把网页内嵌图片下载并写进对象存储后，片段里存的是
 * `![alt](/api/uploads/{objectKey})`——渲染层的 origin 是 `ailearn-app://`，
 * 这个相对路径会落到应用包内，所以图由 main 取回字节、这里用 blob URL 画。
 * 取不回来时只这一张缺位，正文照旧读下去。
 */
function SegmentImage({
  segment,
  workspaceEpoch,
}: {
  readonly segment: DesktopSourceSegment;
  readonly workspaceEpoch?: number;
}) {
  const image = parseImageBlock(segment.text);
  const { state, retry } = useSourceImage(image?.url ?? "", workspaceEpoch);

  if (!image) return <p className="sub">图片片段：{segmentText(segment)}</p>;

  const alt = image.alt || "来源图片";
  if (state.status === "external" || state.status === "ready") {
    return (
      <ZoomableReadingImage
        src={state.src}
        alt={alt}
        retryable={state.status === "ready"}
        onRetry={retry}
      />
    );
  }
  if (state.status === "loading") return <p className="sub">正在载入图片…</p>;
  return <p className="sub">这张图片没能取回：{alt}</p>;
}
