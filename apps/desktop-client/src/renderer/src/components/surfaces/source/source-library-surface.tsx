import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, BookOpen, Code2, FileText, Globe2, LoaderCircle, Search, X } from "lucide-react";
import type { DesktopSourceListItem } from "@ailearn/shared/desktop-surface-contracts";
import type { PageReadableV1 } from "@ailearn/shared/companion-bridge-contracts";
import { useRoomStore } from "../../../app/room-store";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../../app/desktop-client";
import {
  SOURCE_CAPTURED_EVENT,
  type SourceCapturedDetail,
} from "../../../app/source-intake";
import { HudPage } from "../../hud/HudPage";
import { useHudPage } from "../../hud/use-hud-page";
import { usePageReadableView } from "../../hud/use-page-readable-view";
import { HUD_PAGES } from "../../hud/hud-pages";
import {
  SurfaceDataState,
  formatRelative,
  formatSourceKind,
  formatSourceKindLabel,
  formatSourceStamp,
  formatSourceStatus,
  sourceStatusTone,
  useSurfaceProjection,
} from "../notebook/surface-data.tsx";
import {
  SOURCE_PAGE_LIMIT,
  SOURCE_PAGE_MAX,
  SOURCE_SEARCH_LIMIT,
  SOURCE_STATUS_POLL_MAX_ATTEMPTS,
  SOURCE_STATUS_POLL_MS,
  SOURCE_STATUS_TABS,
  countSourcesByStatus,
  needsOriginAddress,
  needsStatusRefresh,
  readSourceLibrary,
  selectSources,
  sourcePoolFor,
  tabCount,
} from "./source-index.ts";
import { CaptureStrip } from "./source-capture";
import { useSourceMotion } from "./use-source-motion";

type LibraryMemory = { draft: string; query: string; fullTextIds: readonly string[]; scroll: number };
const libraryMemory = new Map<number, LibraryMemory>();

type SourceLibraryProjection = {
  readonly items: readonly DesktopSourceListItem[];
  readonly total: number;
  readonly truncated: boolean;
  readonly archived: readonly DesktopSourceListItem[];
  readonly archivedTotal: number;
  readonly archivedTruncated: boolean;
  readonly captureAllowed: boolean;
};

/** Page 05 — the whole source library on one working index. */
export function SourceLibrarySurface() {
  const scope = useRoomStore(state => state.workspaceScopeRevision);
  return <SourceLibraryContent key={scope} scope={scope} />;
}

function SourceLibraryContent({ scope }: { readonly scope: number }) {
  const invoke = useRoomStore((state) => state.invoke);
  const setActiveSourceId = useRoomStore((state) => state.setActiveSourceId);
  const setReturnTarget = useRoomStore((state) => state.setReturnTarget);
  // The tab lives in the store so returning from a source resumes the index the
  // reader left, instead of dropping them back on 全部.
  const status = useRoomStore((state) => state.sourceIndexTab);
  const setStatus = useRoomStore((state) => state.setSourceIndexTab);
  const remembered = useRef(libraryMemory.get(scope) ?? { draft: "", query: "", fullTextIds: [], scroll: 0 });
  const [draft, setDraft] = useState(remembered.current.draft);
  const [query, setQuery] = useState(remembered.current.query);
  const [fullTextIds, setFullTextIds] = useState<readonly string[]>(remembered.current.fullTextIds);
  const deskRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRequest = useRef(0);
  const restoredScroll = useRef(false);
  useSourceMotion(deskRef, "library");
  useEffect(() => {
    remembered.current = { ...remembered.current, draft, query, fullTextIds };
    libraryMemory.set(scope, remembered.current);
  }, [scope, draft, query, fullTextIds]);
  useEffect(() => () => { searchRequest.current++; }, []);
  const [searching, setSearching] = useState(false);
  const [searchNotice, setSearchNotice] = useState<{ readonly tone: "info" | "error"; readonly text: string } | null>(null);
  const [captured, setCaptured] = useState<{ readonly sourceId: string; readonly title: string } | null>(null);
  /** 一次收下多份时的收据。单独一格：单份那条说的是「这一份怎么样了」，批量这条说的是「这一批」。 */
  const [batchReceipt, setBatchReceipt] = useState<string | null>(null);
  /** The bounded poll gave up while the server was still parsing. */
  const [stalled, setStalled] = useState(false);
  const pollAttemptsRef = useRef(0);
  /** How many pages one read may walk; 加载更多 raises it. */
  const pageBudgetRef = useRef(SOURCE_PAGE_MAX);
  useHudPage("sources");

  const { data, loading, failure, reload, epochRef, refreshFailure } = useSurfaceProjection(async ({ workspaceEpoch }) => {
    const meta = () => createRequestMeta(workspaceEpoch);
    // The index is the whole library, not its first page: status tab counts and
    // the search filter are only truthful once every source has been read.
    // 已归档 is read by its own walk because `GET /sources` excludes it.
    const [library, capabilitiesResponse] = await Promise.all([
      readSourceLibrary(async (cursor, archived) => {
        const page = unwrapGatewayResult(await window.ailearn.source.list({
          meta: meta(),
          limit: SOURCE_PAGE_LIMIT,
          ...(cursor ? { cursor } : {}),
          ...(archived ? { status: archived } : {}),
        }));
        return { items: page.items, total: page.total, nextCursor: page.nextCursor };
      }, pageBudgetRef.current),
      window.ailearn.capabilities.get({ meta: meta() }),
    ]);
    return {
      items: library.items,
      total: library.total,
      truncated: library.truncated,
      archived: library.archived,
      archivedTotal: library.archivedTotal,
      archivedTruncated: library.archivedTruncated,
      captureAllowed: unwrapGatewayResult(capabilitiesResponse).actionCapabilities["source.create"] === "allowed",
    } satisfies SourceLibraryProjection;
  }, [], { refreshOnFocus: true });

  useLayoutEffect(() => {
    if (!loading && data && !restoredScroll.current && listRef.current) {
      listRef.current.scrollTop = remembered.current.scroll;
      restoredScroll.current = true;
    }
  }, [data, loading]);

  const items = data?.items ?? [];
  const archived = data?.archived ?? [];
  const total = data?.total ?? 0;
  const truncated = data?.truncated ?? false;
  const archivedTruncated = data?.archivedTruncated ?? false;
  const captureAllowed = data?.captureAllowed ?? false;

  const counts = useMemo(() => countSourcesByStatus([...items, ...archived]), [archived, items]);
  const pool = sourcePoolFor({ items, archived }, status);
  const visible = useMemo(
    () => selectSources(pool, status, query.trim().toLocaleLowerCase("zh-CN"), new Set(fullTextIds)),
    [fullTextIds, pool, query, status],
  );
  // `draft` is a source the worker has not picked up yet: it is exactly as
  // "待处理" as a running parse, and leaving it out made a fresh capture read as
  // "没有待处理的材料" while it was still being parsed.
  const pending = counts.draft + counts.processing + counts.failed;
  const pendingDetail = [
    counts.failed > 0 ? `${counts.failed} 份需人工检查` : null,
    counts.processing > 0 ? `${counts.processing} 份正在解析` : null,
    counts.draft > 0 ? `${counts.draft} 份排队等待解析` : null,
  ].filter(Boolean).join("、");
  const missingOrigin = useMemo(() => items.filter(needsOriginAddress).length, [items]);

  // Parsing finishes after the capture form closes, so the index keeps asking
  // while any row is still unsettled — including the `draft` a fresh capture
  // lands in, which is the state the reader is actually waiting on. A job that
  // never settles stops at the bounded attempt budget and says so instead of
  // polling forever.
  useEffect(() => {
    if (!needsStatusRefresh(items)) {
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
  }, [items, reload]);

  const retryRead = () => {
    pollAttemptsRef.current = 0;
    setStalled(false);
    void reload({ silent: true });
  };

  const loadMore = () => {
    pageBudgetRef.current += SOURCE_PAGE_MAX;
    void reload({ silent: true });
  };

  const openSource = (sourceId: string) => {
    setActiveSourceId(sourceId);
    invoke("open-source");
    // The detail page was opened from this list, so its pill comes back here —
    // and the next navigation clears the target again.
    setReturnTarget({ label: "返回来源库", run: () => invoke("open-sources") });
  };

  /**
   * Body text is not part of the
   * list projection — it lives in the server's search index. So a submit asks
   * the server for the phrase and unions the ids with what the rows can match
   * locally: nothing that used to be found stops being found.
   *
   * The filter is applied only once the answer is in: narrowing to the new
   * phrase first made the list flash "没有找到" for every body-text hit.
   */
  const submitSearch = async (event: React.FormEvent) => {
    event.preventDefault();
    const request = ++searchRequest.current;
    const needle = draft.trim();
    setSearchNotice(null);
    if (!needle) {
      setQuery("");
      setFullTextIds([]);
      return;
    }
    setSearching(true);
    try {
      const hits = unwrapGatewayResult(await window.ailearn.search.global({
        meta: createRequestMeta(epochRef.current),
        query: needle,
        type: "source",
        limit: SOURCE_SEARCH_LIMIT,
      }));
      if (request !== searchRequest.current) return;
      setFullTextIds(hits.items.map((item) => item.objectId));
      setQuery(needle);
      if (hits.total > hits.items.length) {
        setSearchNotice({
          tone: "info",
          text: `服务端检索命中 ${hits.total} 份，索引只标出了最相关的前 ${hits.items.length} 份。`,
        });
      }
    } catch (error) {
      if (request !== searchRequest.current) return;
      // A search index that cannot be reached must not take the index away.
      setFullTextIds([]);
      setQuery(needle);
      setSearchNotice({
        tone: "error",
        text: `正文检索未确认：${gatewayErrorMessage(error)}；下面只按标题、作者与类型筛选。`,
      });
    } finally {
      if (request === searchRequest.current) setSearching(false);
    }
  };

  const clearQuery = () => {
    searchRequest.current++;
    setSearching(false);
    setDraft("");
    setQuery("");
    setFullTextIds([]);
    setSearchNotice(null);
  };

  const handleCaptured = useCallback(async (sourceId: string, title: string) => {
    searchRequest.current++;
    setSearching(false);
    setBatchReceipt(null);
    setCaptured({ sourceId, title });
    setStatus("all");
    setDraft("");
    setQuery("");
    setFullTextIds([]);
    setSearchNotice(null);
    pollAttemptsRef.current = 0;
    setStalled(false);
    await reload({ silent: true });
  }, [reload, setStatus]);

  /**
   * 一次收下多份之后的那一句。
   *
   * 收据与单份分开：**逐份调 `handleCaptured` 会刷新 N 次索引**，而读者在这几十秒里
   * 只想看到「收下了几份、有没有没进来的」。没进来的那几份由采集栏自己列着，
   * 这里只报数——两处各说各话的话，同一份材料会在两个地方被说成不同的样子。
   */
  const handleBatchCaptured = useCallback(async (result: { readonly accepted: number; readonly failed: number }) => {
    searchRequest.current++;
    setSearching(false);
    setCaptured(null);
    setBatchReceipt(result.failed > 0
      ? `已收下 ${result.accepted} 份材料，正在解析；另有 ${result.failed} 份没能收下，采集栏里列着是哪几份。`
      : `已收下 ${result.accepted} 份材料，正在解析，完成后这张索引会自动更新。`);
    setStatus("all");
    setDraft("");
    setQuery("");
    setFullTextIds([]);
    setSearchNotice(null);
    pollAttemptsRef.current = 0;
    setStalled(false);
    await reload({ silent: true });
  }, [reload, setStatus]);

  // 弹窗与全局拖放在页面之外收进来的来源：同样回到全部、清掉搜索并重读，
  // 收据随行状态走，和采集栏亲手收的一样。
  useEffect(() => {
    const onExternalCapture = (event: Event) => {
      const detail = (event as CustomEvent<SourceCapturedDetail>).detail;
      if (!detail?.sourceId) return;
      void handleCaptured(detail.sourceId, detail.title);
    };
    window.addEventListener(SOURCE_CAPTURED_EVENT, onExternalCapture);
    return () => window.removeEventListener(SOURCE_CAPTURED_EVENT, onExternalCapture);
  }, [handleCaptured]);

  /**
   * An empty index is three different situations, and the reader's next move
   * differs in each: nothing captured yet, nothing under this tab, nothing
   * matching the query.
   */
  const emptyIndex = query.trim()
    ? { message: `没有找到“${query.trim()}”`, detail: "换一个关键词，或把搜索框清空。" }
    : items.length === 0 && archived.length === 0
      ? { message: "来源库还是空的", detail: "收下第一份想读的材料吧。" }
      : { message: "这个状态还没有来源", detail: "把状态切回「全部」，可以看到这个工作区的其它材料。" };

  /**
   * The receipt follows the row it is about. Freezing it at capture time left it
   * promising "正在解析，完成后这张索引会自动更新" long after the parse had
   * finished — or failed.
   */
  const capturedRow = captured
    ? [...items, ...archived].find((item) => item.id === captured.sourceId) ?? null
    : null;
  const receipt = batchReceipt ?? (captured ? captureReceipt(captured.title, capturedRow?.status ?? null) : null);
  const truncatedForTab = status === "archived" ? archivedTruncated : truncated;

  /**
   * 屏上那几句状态字各算一次，界面与登记给伴星的可读视图共用同一份表达式
   * （分成两处写就是两份文案，早晚会分叉）。
   */
  const pendingHead = pending > 0 ? `${pending} 份待处理` : "没有待处理的材料";
  const totalLine = `共 ${total} 份来源`;
  const missingOriginLine = missingOrigin > 0 ? `另有 ${missingOrigin} 份网页来源缺少地址` : null;
  const stalledLine = "还有材料在解析，页面已停止自动刷新。";
  const truncatedFootLine
    = `索引只覆盖了前 ${pool.length} 份，共有 ${status === "archived" ? data?.archivedTotal ?? 0 : total} 份；页签计数只统计已读取的部分。`;
  const tabLabel = (value: (typeof SOURCE_STATUS_TABS)[number]) =>
    (value === "all" ? `全部 ${total}` : `${formatSourceStatus(value)} ${tabCount(counts, value, total)}`);
  const activeTabLabel = tabLabel(status);
  /**
   * 伴星读到的那一行"该说什么"：读不到 ＞ 停止刷新 ＞ 空索引 ＞ 刚采集的回执 ＞
   * 只读了一部分。每一句都是屏上原话，她自己不重新推断。
   */
  const noticeLine
    = failure
      ? `来源库暂时不可用：${failure.slice(0, 60)}`
      : stalled
        ? stalledLine
        : visible.length === 0
          ? `${emptyIndex.message}：${emptyIndex.detail.slice(0, 60)}`
          : receipt
            ? receipt.slice(0, 200)
            : truncatedForTab
              ? truncatedFootLine.slice(0, 200)
              : null;

  /**
   * 这一屏登记给伴星读的可读视图（39d W2-7）。
   *
   * 标题＝`HudPage` 渲染的那个 `<h1>`（直接取注册表，不另抄一份字面量）；状态行＝采集栏
   * 的 `<b>` 那一句；页签与搜索词进 `filters`（她要知道"这一屏是筛过的"，不然会把
   * "搜索结果 3 份"说成"库里有 3 份"）；条目＝索引里真正渲染的那批 `source-sheet`，
   * 序号按屏幕顺序；`state` 取那一行的状态标签字面。数字全部复用页面已经在算的派生值。
   *
   * **只在屏上写着的时候才登记**：`pending > 0` 那一支屏上是"明细"而不是"共 N 份来源"，
   * 两个数各占各的档，别让她读到一句屏幕上没有的话。
   */
  const readableView = useMemo<PageReadableV1 | null>(() => {
    if (!data && !failure) return null;
    return {
      pageId: "sources",
      title: HUD_PAGES.sources.title,
      statusLine: pendingHead,
      metrics: [
        ...(pending > 0
          ? [{ label: "待处理明细", value: pendingDetail.slice(0, 40) }]
          : [{ label: "共", value: totalLine }]),
        ...(missingOriginLine ? [{ label: "缺地址", value: missingOriginLine.slice(0, 40) }] : []),
      ],
      filters: [
        { label: "页签", value: activeTabLabel.slice(0, 40) },
        ...(query.trim() ? [{ label: "搜索", value: query.trim().slice(0, 40) }] : []),
      ],
      ...(visible.length > 0
        ? {
            items: visible.slice(0, 12).map((source, index) => ({
              ordinal: index + 1,
              label: source.title.slice(0, 120),
              state: formatSourceStatus(source.status).slice(0, 40),
            })),
          }
        : {}),
      ...(noticeLine ? { notice: noticeLine } : {}),
    };
  }, [activeTabLabel, data, failure, missingOriginLine, noticeLine, pending, pendingDetail, query, totalLine, visible]);
  usePageReadableView(readableView);

  return (
    <HudPage page="sources">
      <div ref={deskRef} className="source-desk source-experience">
        <CaptureStrip
          disabled={loading || Boolean(failure) || !captureAllowed}
          lockedReason={
            loading
              ? "正在读取工作区，稍后就能采集。"
              : failure
                ? "来源库读取失败，先重新读取再采集。"
                : !captureAllowed
                  ? "只有工作区所有者可以采集来源。"
                  : null
          }
          epochRef={epochRef}
          receipt={receipt}
          summary={
            <p role="status">
              <b>{pendingHead}</b>
              <br />
              {pending > 0 ? pendingDetail : totalLine}
              {missingOrigin > 0 ? (
                <>
                  <br />
                  另有 {missingOrigin} 份网页来源缺少地址
                </>
              ) : null}
            </p>
          }
          onCaptured={handleCaptured}
          onBatchCaptured={handleBatchCaptured}
          onOpenExisting={openSource}
        />

        <section data-guide-anchor="sources" className="source-index" aria-label="来源资料索引">
          <form className="search-line" onSubmit={(event) => void submitSearch(event)} role="search">
            <Search size={18} aria-hidden="true" />
            <label className="sr-only" htmlFor="source-library-query">搜索标题或正文</label>
            <input
              id="source-library-query"
              value={draft}
              placeholder="搜索标题或正文"
              onChange={(event) => {
                const next = event.currentTarget.value;
                searchRequest.current++;
                setSearching(false);
                setDraft(next);
                // Clearing the box returns the whole index immediately; only a
                // submit narrows it, so the mockup's 搜索 button carries weight.
                if (!next.trim()) clearQuery();
              }}
            />
            {draft ? <button type="button" className="source-icon" aria-label="清空搜索" title="清空搜索" onClick={clearQuery}><X size={16} /></button> : null}
            <button type="submit" className="source-icon" aria-label={searching ? "检索中" : "搜索"} title="搜索" disabled={searching}>
              {searching ? <LoaderCircle size={18} className="source-spin" /> : <ArrowRight size={18} />}
            </button>
          </form>

          <div className="index-tabs" role="group" aria-label="来源状态">
            {SOURCE_STATUS_TABS.map((value) => (
              <button
                key={value}
                type="button"
                className={status === value ? "active" : undefined}
                aria-pressed={status === value}
                onClick={() => { setStatus(value); if (listRef.current) listRef.current.scrollTop = 0; }}
                // 「全部」不含已归档（归档就是"不再出现在默认索引"那条合同），
                // 但"全部"这个词本身会被读成包含——所以把这件事写在悬停里，
                // 而不是让用户自己拿 全部 8 + 已归档 1 去对总数（审计 F32）。
                title={value === "all"
                  ? `这里的 ${total} 份不含已归档${data?.archivedTotal ? `（另有 ${data.archivedTotal} 份在「已归档」页签）` : ""}`
                  : value === "processing"
                    ? `还没解析完的：正在解析 ${counts.processing} 份 + 排队等待 ${counts.draft} 份`
                    : undefined}
              >
                {tabLabel(value)}
              </button>
            ))}
          </div>

          <div ref={listRef} className="source-list" onScroll={event => {
            if (!restoredScroll.current) return;
            remembered.current = { ...remembered.current, scroll: event.currentTarget.scrollTop };
            libraryMemory.set(scope, remembered.current);
          }}>
            {loading ? <SurfaceDataState kind="loading" message="正在读取来源库" detail="正在确认当前身份与工作区。" /> : null}
            {!loading && failure ? <SurfaceDataState kind="error" message="来源库暂时不可用" detail={failure} onRetry={retryRead} /> : null}
            {!loading && !failure && searchNotice ? (
              <p
                className={`surface-notice${searchNotice.tone === "error" ? " surface-notice--error" : ""}`}
                role={searchNotice.tone === "error" ? "alert" : "status"}
              >
                {searchNotice.text}
              </p>
            ) : null}
            {!loading && !failure && stalled ? (
              <p className="surface-notice" role="status">
                {stalledLine}
                <button type="button" className="text-action" onClick={retryRead}>重新读取</button>
              </p>
            ) : null}
            {refreshFailure ? <p className="surface-notice surface-notice--error" role="alert">更新暂时没取回：{refreshFailure}<button type="button" className="text-action" onClick={retryRead}>重新读取</button></p> : null}
            {!loading && !failure && visible.length === 0 ? (
              <SurfaceDataState kind="empty" message={emptyIndex.message} detail={emptyIndex.detail}
                action={query ? <button type="button" className="button" onClick={clearQuery}>清空搜索</button> : status !== "all" ? <button type="button" className="button" onClick={() => setStatus("all")}>查看全部</button> : null} />
            ) : null}
            {!loading && !failure ? visible.map((source) => (
              <button
                key={source.id}
                type="button"
                className="source-sheet"
                data-kind={formatSourceKind(source)}
                data-status={source.status}
                title={`打开《${source.title}》`}
                onClick={() => openSource(source.id)}
              >
                <span className="source-material" aria-hidden="true">
                  {source.type === "url" ? <Globe2 size={24} /> : source.type === "code" ? <Code2 size={24} /> : <FileText size={24} />}
                  <i>{formatSourceKind(source)}</i>
                </span>
                <span className="source-copy">
                  <strong>{source.title}</strong>
                  <small>
                    {[
                      formatSourceKindLabel(source),
                      needsOriginAddress(source) ? "缺少来源地址" : null,
                      formatRelative(source.updatedAt),
                    ].filter(Boolean).join(" · ")}
                  </small>
                </span>
                <span className="source-state">
                  <span className={`tag ${sourceStatusTone(source.status)}`.trim()}>{formatSourceStatus(source.status)}</span>
                  {/* 「已生成笔记」是这份材料的进展，不是脚注（复盘 #18）：一眼要能
                      区分"解析完了但还没动手"和"已经出笔记了"。 */}
                  <span className={source.noteCount > 0 ? "tag green" : "tag"}>
                    <BookOpen size={13} aria-hidden="true" />{source.noteCount > 0 ? `已生成 ${source.noteCount} 篇笔记` : "还没生成笔记"}
                  </span>
                  {/* 「笔记已出卡」（复盘 #18 后半）：服务端按 sourceId 聚合出批次与
                      正式目标数，界面不猜。三档互斥，一眼能分清"还没出笔记""笔记出了但
                      还没出卡""已经有卡可以答"。 */}
                  {source.noteCount > 0 ? (
                    <>
                      <span className={source.cardProgress.activeObjectives > 0 ? "tag green" : "tag"}>
                        {source.cardProgress.activeObjectives > 0
                          ? `已出 ${source.cardProgress.activeObjectives} 张学习卡`
                          : source.cardProgress.pendingReviewRuns > 0
                            ? `${source.cardProgress.pendingReviewRuns} 批学习卡待审核`
                            : "还没出学习卡"}
                      </span>
                    </>
                  ) : null}
                  <time dateTime={source.updatedAt} title={formatSourceStamp(source.updatedAt)}>{formatRelative(source.updatedAt)}</time>
                </span>
                <ArrowRight className="source-open-arrow" size={17} aria-hidden="true" />
              </button>
            )) : null}
            {!loading && !failure && truncatedForTab ? (
              <p className="index-foot">
                {truncatedFootLine}
                <button type="button" className="text-action" onClick={loadMore}>加载更多</button>
              </p>
            ) : null}
          </div>
        </section>
      </div>
    </HudPage>
  );
}

/** What the capture strip says about the material it just took in. */
function captureReceipt(title: string, status: DesktopSourceListItem["status"] | null): string {
  if (!status) return `已采集《${title}》，正在确认它的解析状态。`;
  switch (status) {
    case "ready": return `已采集《${title}》，解析已完成。`;
    case "failed": return `已采集《${title}》，解析没有成功；打开材料可以重新解析。`;
    case "archived": return `《${title}》已归档，可在「已归档」页签找到。`;
    default: return `已采集《${title}》，正在解析，完成后这张索引会自动更新。`;
  }
}
