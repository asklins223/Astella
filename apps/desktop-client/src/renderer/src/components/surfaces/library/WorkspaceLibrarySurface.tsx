import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  BookOpenText,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  CircleAlert,
  Clock3,
  FileText,
  FolderOpen,
  History,
  Layers3,
  Leaf,
  LoaderCircle,
  RefreshCw,
  Search,
  Sparkles,
  Target,
  X,
} from "lucide-react";
import type {
  CapabilityProjectionV1,
  SessionContextV1,
  WorkspaceSummaryV1,
} from "@ailearn/shared/desktop-ipc-contracts";
import type {
  DesktopNoteListItem,
  DesktopNoteListPage,
} from "@ailearn/shared/desktop-surface-contracts";
import type { PageReadableV1 } from "@ailearn/shared/companion-bridge-contracts";
import type {
  LearningObjectivePrimaryActionV3,
  LearningObjectiveSurfaceV3,
  ObjectiveListItemV3,
  ObjectiveListPageV3,
} from "@ailearn/shared/learning-objective-surface-contracts";
import { useRoomStore } from "../../../app/room-store";
import {
  createCommandId,
  createRequestMeta,
  gatewayErrorMessage,
  RendererGatewayError,
  unwrapGatewayResult,
} from "../../../app/desktop-client";
import { useCardTactile } from "../../motion/use-card-tactile";
import { CardCollection } from "./card-collection";
import { cardStrategyPresentation } from "../review/card-strategy-presentation";
import { useCardPaperArrival } from "../../motion/card-object-spring";
import { SurfaceReturnControl } from "../study/SurfaceReturnControl.tsx";
import { learningRunPhaseLabels } from "../run/learning-run-surface.tsx";
import { startObjectiveJourney } from "../run/objective-primary-action.ts";
import { ObjectiveProgressBand } from "../run/ObjectiveProgressBand.tsx";
import { progressSegmentForState } from "../run/objective-progress-band.ts";
import { groupObjectiveCardsByNoteV2 } from "@ailearn/shared/objective-card-groups-v2";
import {
  freshnessLabel,
  formatObjectiveDateTime,
  formatObjectiveState,
  objectiveStateHint,
  objectiveStateNeedsAttention,
  objectiveStateTone,
  objectiveProgressChips,
  primaryActionDescription,
  primaryActionLabel,
} from "../run/objective-state-copy.ts";
import {
  readObjectiveLibraryView,
  retargetObjectiveLibraryView,
  writeObjectiveLibraryView,
  type ObjectiveLibraryFilter,
} from "../run/objective-library-view-state.ts";
import { useHudPage } from "../../hud/use-hud-page";
import { usePageReadableView } from "../../hud/use-page-readable-view";
import { HUD_PAGES } from "../../hud/hud-pages";
import { cardStrategyLabel } from "../review/card-strategy-presentation.ts";
import {
  runModePresentation,
} from "../run/objective-quest-presentation.ts";

type SurfaceHeaderProps = {
  // 页面家族眉标：与 .impeccable/review/desktop-pages-v2/REVIEW.md 的家族列一致。
  readonly eyebrow: string;
  readonly title: string;
  readonly detail: string;
  readonly headingId?: string;
};

function SurfaceHeader({ eyebrow, title, detail, headingId }: SurfaceHeaderProps) {
  // 样式在 components/approved-surfaces.css：__heading 是左上角标题块，
  // __return 是独立的左下角返回控件（两者都自己绝对定位）。
  return (
    <>
      <header className="approved-surface__heading task-artifact task-artifact--header">
        <span className="approved-surface__eyebrow">{eyebrow}</span>
        <h2 id={headingId}>{title}</h2>
        <p>{detail}</p>
      </header>
      <SurfaceReturnControl className="approved-surface__return" />
    </>
  );
}

export function ApprovedSurfaceFrame({
  family,
  eyebrow,
  title,
  detail,
  headingId,
  children,
  className = "",
  surfaceRef,
}: {
  readonly className?: string;
  readonly surfaceRef?: React.RefObject<HTMLElement | null>;
  readonly family: "library" | "writing" | "workshop" | "observatory" | "system";
  readonly eyebrow: string;
  readonly title: string;
  readonly detail: string;
  readonly headingId: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section ref={surfaceRef} className={`approved-surface approved-surface--${family} task-artifact ${className}`} aria-labelledby={headingId}>
      <SurfaceHeader eyebrow={eyebrow} headingId={headingId} title={title} detail={detail} />
      <div className="approved-surface__content">{children}</div>
    </section>
  );
}

function SurfaceDataState({
  kind,
  message,
  detail,
  onRetry,
  onContinue,
  continueLabel,
  busy = false,
}: {
  readonly kind: "loading" | "error" | "empty";
  readonly message: string;
  readonly detail: string;
  readonly onRetry?: () => void;
  readonly onContinue?: () => void;
  readonly continueLabel?: string;
  readonly busy?: boolean;
}) {
  return (
    <div className={`approved-state approved-state--${kind}`} role={kind === "error" ? "alert" : "status"}>
      {kind === "loading" ? <LoaderCircle size={24} aria-hidden="true" /> : null}
      {kind === "error" ? <CircleAlert size={24} aria-hidden="true" /> : null}
      {kind === "empty" ? <FolderOpen size={24} aria-hidden="true" /> : null}
      <strong>{message}</strong>
      <p>{detail}</p>
      {kind === "error" && onRetry ? <button type="button" className="button primary" onClick={onRetry}><RefreshCw size={15} aria-hidden="true" />重新读取</button> : null}
      {kind === "empty" && onContinue ? <button type="button" className="button primary" onClick={onContinue} disabled={busy}>{busy ? "正在读取…" : continueLabel ?? "继续读取"}</button> : null}
    </div>
  );
}

// 按行调的 formatter 提到模块作用域建一次（同 surface-data，0269 轮 M23）。
const LIBRARY_MONTH_DAY_FORMAT = new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" });

function formatDate(value: string | null | undefined): string {
  if (!value) return "时间未提供";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf())) return "时间未提供";
  return LIBRARY_MONTH_DAY_FORMAT.format(parsed);
}

function formatKnowledgeForm(value: ObjectiveListItemV3["knowledgeForm"]): string {
  return {
    fact: "事实",
    definition: "定义",
    relationship: "关系",
    comparison: "比较",
    sequence: "顺序",
    procedure: "步骤",
    causal_model: "因果模型",
    boundary: "边界",
    application_rule: "应用规则",
  }[value] ?? value;
}

function formatLifecycle(value: LearningObjectiveSurfaceV3["content"]["lifecycle"]): string {
  return {
    active: "正在推进",
    archived: "已归档",
    superseded: "已有后继版本",
    blocked_content_upgrade: "等待内容更新",
  }[value];
}

function formatOriginKind(value: LearningObjectiveSurfaceV3["sources"]["origins"][number]["kind"]): string {
  return { note: "笔记", manual: "手动建立", imported: "导入记录" }[value];
}

function formatOriginIntegrity(value: LearningObjectiveSurfaceV3["sources"]["origins"][number]["integrity"]): string {
  // 审计 F10：这四个字以前写"链路已核对"，而它就排在"0 条原文证据"旁边——
  // 于是状态词替学习主张作了一个它没做过的保证。核对过的是**来源关系**
  // （这条出处指得回哪一份快照），不是"原文证实了你这句话"。
  return value === "verified" ? "来源关系已确认" : "旧链路待复核";
}

/**
 * 可追溯程度的三档，各说各的话（F10 的验收就是这三档要分得开）。
 *
 * 以前这一句判的是 `sourceSnapshotId` 有没有，却没判引用有没有留下——于是
 * "有当时那份来源、但没留下引用到的原文"被说成"留了当时引用的原文"，
 * 恰好是三种情况里最容易看错的那一种。
 */
function formatOriginTrace(origin: {
  readonly sourceSnapshotId: string | null;
  readonly evidenceSnapshotIds: readonly string[];
}): string {
  if (origin.evidenceSnapshotIds.length > 0) return "留了当时引用的原文";
  if (origin.sourceSnapshotId) return "有当时那份来源，但没留下引用到的原文";
  return "没有留当时引用的原文";
}

function formatSupportGrade(value: LearningObjectiveSurfaceV3["sources"]["origins"][number]["supportGrade"]): string {
  return value === "primary" ? "主要依据" : "补充依据";
}

function isActionable(action: LearningObjectivePrimaryActionV3): boolean {
  return action.kind === "create_run"
    || action.kind === "resume_run"
    || action.kind === "create_review_run"
    || action.kind === "practice_only"
    || action.kind === "view_successor"
    || action.kind === "refresh";
}

async function readAuthenticatedSession(epochRef: React.MutableRefObject<number | undefined>): Promise<SessionContextV1> {
  if (!window.ailearn) throw new Error("桌面端 API 不可用，无法读取真实工作区数据。");
  const response = await window.ailearn.auth.getState({ meta: createRequestMeta(epochRef.current) });
  if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
  const session = unwrapGatewayResult(response);
  if (session.status !== "authenticated" || !session.workspace) {
    throw new RendererGatewayError({ code: "auth_required", safeMessageKey: "error.auth_required", retry: "user_action" });
  }
  return session;
}

/**
 * 概览数字和筛选按钮共用这一张表。此前同一组桶在两处各写一遍字面量，
 * 「待处理 / 推进中 / 已稳定」到底是按什么口径数的，只有读代码的人知道
 * （2026-09-20 实走复盘 #9、#14）。
 */
const PERSONAL_BUCKETS = [
  { key: "attention", label: "要处理", hint: "还没正式答过、答错了、到复习时间，或原文已经更新的" },
  { key: "progress", label: "进行中", hint: "这一轮还没答完，或复习时间已经排好的" },
  { key: "stable", label: "答对过", hint: "至少有一次正式作答达到标准的" },
] as const satisfies ReadonlyArray<{ key: Exclude<ObjectiveLibraryFilter, "all">; label: string; hint: string }>;

const FILTER_BUCKETS = [
  { key: "all", label: "全部", hint: "已载入的全部学习卡" },
  ...PERSONAL_BUCKETS,
] as const satisfies ReadonlyArray<{ key: ObjectiveLibraryFilter; label: string; hint: string }>;

export function ObjectiveLibrarySurface() {
  const invoke = useRoomStore((state) => state.invoke);
  const setActiveObjectiveId = useRoomStore((state) => state.setActiveObjectiveId);
  const epochRef = useRef<number | undefined>(undefined);
  const listRef = useRef<HTMLDivElement>(null);
  const restoredViewRef = useRef(false);
  const surfaceRef = useRef<HTMLElement>(null);
  useCardTactile(surfaceRef);
  const loadedCursorsRef = useRef(new Set<string>());
  const [page, setPage] = useState<ObjectiveListPageV3 | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [pageFailure, setPageFailure] = useState<string | null>(null);
  const [query, setQuery] = useState(() => readObjectiveLibraryView().query);
  const [filter, setFilter] = useState<ObjectiveLibraryFilter>(() => readObjectiveLibraryView().filter);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [openPackKey, setOpenPackKey] = useState(() => readObjectiveLibraryView().openPackKey);
  useHudPage("goals");

  const load = useCallback(async () => {
    setLoading(true);
    setFailure(null);
    setPageFailure(null);
    loadedCursorsRef.current.clear();
    try {
      const session = await readAuthenticatedSession(epochRef);
      const workspaceId = session.workspace?.workspaceId;
      if (!workspaceId) throw new Error("当前工作区不可用。");
      if (readObjectiveLibraryView().workspaceId !== workspaceId) {
        retargetObjectiveLibraryView(workspaceId);
        setQuery("");
        setFilter("all");
        setFilterMenuOpen(false);
        setOpenPackKey(null);
      }
      const meta = createRequestMeta(session.workspaceEpoch);
      const response = await window.ailearn.objective.list({ meta, limit: 60, lifecycle: "active" });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      setPage(unwrapGatewayResult(response));
    } catch (error) {
      setFailure(gatewayErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const loadMore = useCallback(async () => {
    const cursor = page?.nextCursor;
    if (!cursor || loadingMore || loadedCursorsRef.current.has(cursor)) return;
    loadedCursorsRef.current.add(cursor);
    setLoadingMore(true);
    setPageFailure(null);
    try {
      const session = await readAuthenticatedSession(epochRef);
      const response = await window.ailearn.objective.list({
        meta: createRequestMeta(session.workspaceEpoch),
        cursor,
        limit: 60,
        lifecycle: "active",
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      const next = unwrapGatewayResult(response);
      setPage((current) => {
        if (!current) return next;
        const byId = new Map(current.items.map((item) => [item.objectiveId, item]));
        for (const item of next.items) byId.set(item.objectiveId, item);
        return {
          ...next,
          items: [...byId.values()],
          total: Math.max(current.total, next.total),
          nextCursor: next.nextCursor === cursor ? null : next.nextCursor,
        };
      });
      if (next.nextCursor === cursor) {
        setPageFailure("后续页面返回了重复游标，已停止继续读取以避免循环。");
      }
    } catch (error) {
      loadedCursorsRef.current.delete(cursor);
      setPageFailure(gatewayErrorMessage(error));
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, page?.nextCursor]);

  useLayoutEffect(() => {
    if (loading || !page || !listRef.current || restoredViewRef.current) return;
    listRef.current.scrollTop = readObjectiveLibraryView().scrollTop;
    restoredViewRef.current = true;
  }, [loading, page?.items.length]);

  useEffect(() => {
    writeObjectiveLibraryView({ query, filter });
  }, [filter, query]);

  // 目标可以直接从笔记学习。只有真正保存了卡片的目标才属于学习卡册；
  // 服务端仅在有关联卡片时下发 cardStrategy，空值不能被画成一张卡。
  const cardItems = useMemo(() => (page?.items ?? []).filter((item) => item.cardStrategy !== null), [page]);
  const activeGoal = cardItems[0] ?? null;
  const visibleGoals = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
    return cardItems.filter((item) => {
      const tone = objectiveStateTone(item.personalState.state);
      const matchesFilter = filter === "all"
        || (filter === "attention" && objectiveStateNeedsAttention(item.personalState.state))
        || (filter === "progress" && tone === "progress")
        || (filter === "stable" && tone === "calm");
      if (!matchesFilter) return false;
      if (!normalizedQuery) return true;
      return [item.conceptLabel, item.publicSummary, item.primaryNoteTitle]
        .filter(Boolean)
        .some((value) => value!.toLocaleLowerCase("zh-CN").includes(normalizedQuery));
    });
  }, [cardItems, filter, query]);
  const orderedVisibleGoals = visibleGoals;
  /**
   * W7-6 刀二：§8.5「**顶层按笔记显示卡组**，一篇笔记至多一个组；组内才展示卡片」。
   *
   * 分组是 `groupObjectiveCardsByNoteV2` 那份**纯函数**算的，不在这里另写一遍——
   * 键必须是 `noteId`（按标题分组＝同一篇改标题就分家、两篇同名就并家），
   * 「未关联笔记」是一个组且排在最后（§8.5「不按标题猜造」），三档互斥且
   * 待核对先判。判据都在 `packages/shared/src/objective-card-groups-v2.test.ts`。
   *
   * 过滤与搜索**先于**分组：§8.5「按内容搜索可以找到卡片并显示所属笔记，不只搜索
   * 组标题」——搜到的是卡，它所在的组跟着出现；而不是先分组再在组标题里搜。
   */
  const noteGroups = useMemo(() => groupObjectiveCardsByNoteV2(orderedVisibleGoals), [orderedVisibleGoals]);
  const allNoteGroups = useMemo(() => groupObjectiveCardsByNoteV2(cardItems), [cardItems]);

  const openObjective = (objectiveId: string) => {
    writeObjectiveLibraryView({ lastObjectiveId: objectiveId });
    setActiveObjectiveId(objectiveId);
    invoke("open-objective", { returnTo: { label: "返回学习卡", run: () => invoke("open-objectives") } });
  };
  const resetListScroll = () => {
    writeObjectiveLibraryView({ scrollTop: 0 });
    if (listRef.current) listRef.current.scrollTop = 0;
  };

  const indexCountLine = page?.nextCursor ? `已载入 ${cardItems.length} 张卡` : `共 ${cardItems.length} 张卡`;
  const activeFilterBucket = FILTER_BUCKETS.find((bucket) => bucket.key === filter);
  const NO_ACTIVE_GOAL_EMPTY = page?.nextCursor
    ? { message: "这批目标还没有学习卡", detail: "可以继续查找后面的目标；笔记本身可以直接学习。" }
    : { message: "这里还没有学习卡", detail: "从一篇笔记制作学习卡，挑选后收进这里。笔记本身也可以直接学习。" };
  const goalsNotice = !activeGoal
    ? `${NO_ACTIVE_GOAL_EMPTY.message}：${NO_ACTIVE_GOAL_EMPTY.detail}`
    : !visibleGoals.length ? `已载入范围内没有匹配卡片：${page?.nextCursor ? "可以继续读取后面的目标，或更换条件。" : "换一个关键词或筛选条件。"}`
    : pageFailure ?? (!page?.nextCursor ? "已读到全部学习卡" : null);
  const readableView = useMemo<PageReadableV1 | null>(() => {
    if (loading && !page) return null;
    const opened = noteGroups.find(group => group.noteKey === openPackKey);
    const readableItems = opened
      ? opened.items.slice(0, 12).map((item, index) => ({ ordinal: index + 1, label: (item.conceptLabel ?? "未命名学习卡").slice(0, 120), state: formatObjectiveState(item.personalState.state).slice(0, 40) }))
      : noteGroups.slice(0, 12).map((group, index) => ({ ordinal: index + 1, label: group.title.slice(0, 120), state: `${(allNoteGroups.find(item => item.noteKey === group.noteKey) ?? group).items.length} 张学习卡` }));
    return {
      pageId: "goals", title: HUD_PAGES.goals.title,
      statusLine: opened ? `已打开卡包：${opened.title}` : query ? `正在查找：${query}` : activeGoal ? "学习卡包收藏" : NO_ACTIVE_GOAL_EMPTY.message,
      metrics: [
        { label: "卡包", value: `${page?.nextCursor ? "已载入" : "共"} ${allNoteGroups.length} 套` },
        { label: "卡片册", value: indexCountLine },
      ],
      ...(query.trim() || filter !== "all" ? { filters: [
        ...(query.trim() ? [{ label: "关键词", value: query.trim().slice(0, 40) }] : []),
        ...(filter !== "all" && activeFilterBucket ? [{ label: "筛选", value: activeFilterBucket.label }] : []),
      ] } : {}),
      ...(readableItems.length ? { items: readableItems } : {}),
      ...(goalsNotice ? { notice: goalsNotice.slice(0, 200) } : {}),
    };
  }, [activeGoal, activeFilterBucket, allNoteGroups, filter, goalsNotice, indexCountLine, loading, noteGroups, openPackKey, page, query]);
  usePageReadableView(readableView);

  return (
    <ApprovedSurfaceFrame family="workshop" className="card-experience card-library" surfaceRef={surfaceRef} eyebrow="我的卡片册" headingId="objective-library-title" title={HUD_PAGES.goals.title} detail="把零散知识，收进自己的收藏册">
      {loading ? <SurfaceDataState kind="loading" message="正在读取学习卡" detail="马上把你的卡包摆出来。" /> : null}
      {!loading && failure ? <SurfaceDataState kind="error" message="学习卡暂时不可用" detail={failure} onRetry={() => void load()} /> : null}
      {!loading && !failure && !activeGoal ? <>
        <SurfaceDataState kind="empty" message={NO_ACTIVE_GOAL_EMPTY.message} detail={NO_ACTIVE_GOAL_EMPTY.detail} onContinue={page?.nextCursor ? () => void loadMore() : () => invoke("open-notes")} continueLabel={page?.nextCursor ? "继续查找学习卡" : "去笔记挑一篇"} busy={loadingMore} />
        {pageFailure ? <p role="alert">{pageFailure}</p> : null}
      </> : null}
      {!loading && !failure && activeGoal ? <CardCollection
        groups={noteGroups} allGroups={allNoteGroups} filterMenuOpen={filterMenuOpen} openPackKey={openPackKey} onPack={setOpenPackKey}
        query={query} filter={filter} countLine={indexCountLine} hasMore={Boolean(page?.nextCursor)}
        pageFailure={pageFailure} loadingMore={loadingMore} listRef={listRef}
        onFilterMenu={setFilterMenuOpen}
        onOpen={openObjective}
        onQuery={value => { resetListScroll(); setQuery(value); }}
        onFilter={value => { resetListScroll(); setFilter(value); }}
        onMake={() => invoke("open-notes")} onMore={() => void loadMore()}
        onScroll={scrollTop => writeObjectiveLibraryView({ scrollTop })}
      /> : null}
    </ApprovedSurfaceFrame>
  );
}

/** 目标详情只拿到 phase 字符串；复用学习旅程的中文标签，未知值原样显示。 */
function formatRunPhase(phase: string): string {
  return (learningRunPhaseLabels as Record<string, string>)[phase] ?? phase;
}

/**
 * 简报页那几句状态字各写一次（39d W2-7）：JSX 与登记给伴星的可读视图共用同一份。
 * 抄成两处就是两个来源，而**视图字段写错不会红**。
 */
const NO_OBJECTIVE_SELECTED_EMPTY = {
  message: "还没有选择学习卡",
  detail: "从学习卡列表点开一张卡后，会直接进入完整详情。",
} as const;
const OBJECTIVE_BRIEF_LINES = {
  loading: "正在读取目标详情",
  unavailable: "目标详情暂时不可用",
} as const;
const PRIMARY_NOTE_MISSING_LINE = "尚未关联主笔记";
const ORIGIN_EMPTY_LINE = "还没有可公开的出处";

/** 出处那一行的事实句：完整度，以及**真的留了**当时引用的原文时才追加条数。 */
function originFactsLine(origin: LearningObjectiveSurfaceV3["sources"]["origins"][number]): string {
  return `${formatOriginIntegrity(origin.integrity)}${origin.evidenceSnapshotIds.length ? ` · ${origin.evidenceSnapshotIds.length} 条原文证据` : ""}`;
}
const initialValidationLabels = {
  ready: "现在可以挑战",
  deferred: "等待开放",
  idle: "还没开始",
  completed: "已经答过",
} as const;

const previousResultLabels = {
  demonstrated: "已证明掌握",
  partial: "已经说对一部分",
  needs_repair: "找到了待修补处",
  not_assessable: "本轮暂无法判定",
  practice_completed: "练习已完成",
  skipped: "本轮已跳过",
  declared_unable: "本轮选择先学习",
} as const;

export function ObjectiveDetailSurface() {
  const surfaceRef = useRef<HTMLElement>(null);
  useCardTactile(surfaceRef);
  const activeObjectiveId = useRoomStore((state) => state.activeObjectiveId);
  const setActiveObjectiveId = useRoomStore((state) => state.setActiveObjectiveId);
  const setActiveRunId = useRoomStore((state) => state.setActiveRunId);
  const setActiveNoteRef = useRoomStore((state) => state.setActiveNoteRef);
  const invoke = useRoomStore((state) => state.invoke);
  const epochRef = useRef<number | undefined>(undefined);
  const [objective, setObjective] = useState<LearningObjectiveSurfaceV3 | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [actionFailure, setActionFailure] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  useHudPage("goal-detail");

  const load = useCallback(async () => {
    if (!activeObjectiveId) { setLoading(false); return; }
    setLoading(true);
    setFailure(null);
    try {
      const session = await readAuthenticatedSession(epochRef);
      const response = await window.ailearn.objective.get({ meta: createRequestMeta(session.workspaceEpoch), objectiveId: activeObjectiveId });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      setObjective(unwrapGatewayResult(response));
    } catch (error) {
      setFailure(gatewayErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [activeObjectiveId]);
  useEffect(() => { void load(); }, [load]);

  const startAction = async () => {
    if (!objective || starting) return;
    setActionFailure(null);
    if (!window.ailearn) {
      setActionFailure("这次没有拿到完整的学习凭据，先不开始。");
      return;
    }
    setStarting(true);
    try {
      await startObjectiveJourney(objective.primaryAction, {
        epochRef,
        setActiveObjectiveId,
        setActiveRunId,
        openRunSurface: () => invoke("validate"),
        reload: load,
      });
    } catch (error) {
      setActionFailure(gatewayErrorMessage(error));
    } finally {
      setStarting(false);
    }
  };

  useCardPaperArrival(surfaceRef, !loading && objective ? activeObjectiveId : null);
  const content = objective?.content;
  const detailState = objective?.personalState.state ?? null;
  const evidenceSnapshotCount = objective?.sources.origins.reduce((sum, origin) => sum + origin.evidenceSnapshotIds.length, 0) ?? 0;
  const detailMode = objective ? runModePresentation(objective.primaryAction) : null;
  const previousResult = objective?.personal.latestResult;
  // 最近一轮与旧练习计数来自不同记录；不能用旧计数的 0 覆盖已经完成的这一轮。
  const practiceTrailLabel = previousResult ? "已有学习记录" : `${objective?.personal.practiceTrailCount ?? 0} 次练习`;
  const noteChangeImpact = objective?.noteChangeImpact ?? null;
  const needsNoteEvidenceCheck = Boolean(noteChangeImpact && noteChangeImpact.status !== "unaffected");
  const reviewNeedsNoteCheck = Boolean(needsNoteEvidenceCheck && objective?.primaryAction.kind === "create_review_run");
  const noteEvidenceNotice = noteChangeImpact?.status === "affected"
    ? "伴星发现这张卡引用的笔记有新变化，先核对原文再开始复习。"
    : noteChangeImpact?.status === "uncertain"
      ? "伴星暂时对不上这张卡的原文依据，先回笔记核对一下。"
      : null;
  /**
   * 打开"这个目标自己的"主笔记（审计 F05）。
   *
   * 病是这么来的：这颗按钮只 `invoke("open-notebook")`，不带指的是哪一篇——于是
   * 阅读面按 store 里残留的 `activeNoteRef`（或首页焦点目标的主笔记）打开，实测在
   * 非焦点目标上点开的是**另一个目标**的笔记。入口必须自己把身份交出去：
   * 先按这颗按钮上写的那一篇设 ref，再导航；没有可用版本时**不跳**，就地说明。
   */
  const openPrimaryNote = (note: { readonly noteId: string; readonly noteVersionId: string }) => {
    setActiveNoteRef({ noteId: note.noteId, noteVersionId: note.noteVersionId });
    invoke("open-notebook");
  };

  const openNoteEvidence = () => {
    if (!noteChangeImpact) return;
    const origin = objective?.sources.origins.find((candidate) =>
      candidate.kind === "note" && candidate.noteId === noteChangeImpact.noteId);
    setActiveNoteRef({
      noteId: noteChangeImpact.noteId,
      noteVersionId: origin?.kind === "note" ? origin.noteVersionId : null,
      mode: "preview",
    });
    invoke("open-notebook");
  };

  const openPreviousResult = () => {
    if (!previousResult) return;
    setActiveRunId(previousResult.runId);
    invoke("validate");
  };

  /**
   * 这一屏登记给伴星读的可读视图（39d W2-7）。
   *
   * `title` 用**这一张卡自己的名字**（`<h3>` 那一行，与阅读面拿笔记标题同一种做法），
   * 不是外框那三个词——这一页外框写"挑战简报"、页面注册表写"学习卡详情"、卡自己的
   * 标题又是第三个，三个词里只有卡名是"这一页在讲什么"的答案。
   * 三条事实（正式验证／当前旅程／复习安排）直接取那一列 `<li>` 上屏上的字面，
   * 条目取"资料卷宗"里真正展开的那些出处。
   */
  const BRIEF_TITLE = "学习卡详情";
  const detailNotice
    = !activeObjectiveId
      ? `${NO_OBJECTIVE_SELECTED_EMPTY.message}：${NO_OBJECTIVE_SELECTED_EMPTY.detail}`
      : failure
        ? `${OBJECTIVE_BRIEF_LINES.unavailable}：${failure.slice(0, 60)}`
        : actionFailure
          ? actionFailure.slice(0, 200)
          : objective && !objective.sources.primaryNote
            ? PRIMARY_NOTE_MISSING_LINE
            : objective && objective.sources.origins.length === 0
              ? ORIGIN_EMPTY_LINE
              : null;
  const briefReadableView = useMemo<PageReadableV1 | null>(() => {
    if (!activeObjectiveId) {
      return {
        pageId: "goal_detail",
        title: BRIEF_TITLE,
        statusLine: NO_OBJECTIVE_SELECTED_EMPTY.message,
        notice: `${NO_OBJECTIVE_SELECTED_EMPTY.message}：${NO_OBJECTIVE_SELECTED_EMPTY.detail}`,
      };
    }
    if (!objective || !content || !detailState) return null;
    return {
      pageId: "goal_detail",
      title: (content.conceptLabel ?? "未命名学习卡").slice(0, 120),
      statusLine: (reviewNeedsNoteCheck ? "先核对原文再开始复习" : objectiveStateHint(detailState)).slice(0, 160),
      metrics: [
        { label: "卡型", value: cardStrategyLabel(content.cardStrategy).slice(0, 40) },
        { label: "状态", value: formatObjectiveState(detailState).slice(0, 40) },
        { label: "练习", value: practiceTrailLabel.slice(0, 40) },
        {
          label: "正式验证",
          value: (objective.personal.initialValidation
            ? objective.personal.initialValidation.status === "ready" && objective.personal.lastCanonicalAt
              ? "可以再次挑战"
              : initialValidationLabels[objective.personal.initialValidation.status]
            : "还没安排").slice(0, 40),
        },
        {
          label: "当前旅程",
          value: (objective.personal.activeRun ? formatRunPhase(objective.personal.activeRun.phase) : "尚未开始").slice(0, 40),
        },
        {
          label: "复习安排",
          value: (objective.personal.review
            ? objective.personal.review.status === "due"
              ? "已经到期"
              : formatObjectiveDateTime(objective.personal.review.dueAt)
            : "正式验证后安排").slice(0, 40),
        },
      ],
      ...(objective.sources.origins.length > 0
        ? {
            items: objective.sources.origins.slice(0, 12).map((origin, index) => ({
              ordinal: index + 1,
              label: formatOriginKind(origin.kind).slice(0, 120),
              state: originFactsLine(origin).slice(0, 40),
            })),
          }
        : {}),
      ...(noteEvidenceNotice ? { notice: noteEvidenceNotice.slice(0, 160) } : detailNotice ? { notice: detailNotice } : {}),
    };
  }, [activeObjectiveId, content, detailNotice, detailState, noteEvidenceNotice, objective, practiceTrailLabel, reviewNeedsNoteCheck]);
  usePageReadableView(briefReadableView);

  return (
    <ApprovedSurfaceFrame family="workshop" className="card-experience card-detail" surfaceRef={surfaceRef} eyebrow="这一张卡" headingId="objective-detail-title" title={BRIEF_TITLE} detail="看清要点，再用自己的话试一试">
      {!activeObjectiveId ? <SurfaceDataState kind="empty" message={NO_OBJECTIVE_SELECTED_EMPTY.message} detail={NO_OBJECTIVE_SELECTED_EMPTY.detail} /> : null}
      {activeObjectiveId && loading ? <SurfaceDataState kind="loading" message={OBJECTIVE_BRIEF_LINES.loading} detail="这里只显示公开内容，不含答案和评分规则。" /> : null}
      {activeObjectiveId && !loading && failure ? <SurfaceDataState kind="error" message={OBJECTIVE_BRIEF_LINES.unavailable} detail={failure} onRetry={() => void load()} /> : null}
      {activeObjectiveId && !loading && !failure && objective && content && detailState ? (
        <div className="objective-brief">
          <article className="objective-brief__board" data-strategy={content.cardStrategy}>
            <div className="objective-brief__postcard">
            <header className="objective-brief__masthead">
              <div className="objective-brief__flags">
                <span className="objective-brief__card-mark" aria-hidden="true">{content.cardStrategy ? cardStrategyPresentation[content.cardStrategy].symbol : "✦"}</span>
                <span className="objective-card-type objective-card-type--brief" data-empty={content.cardStrategy ? "false" : "true"}><strong>{cardStrategyLabel(content.cardStrategy)}</strong></span>
                <span className={`v3-objective-state v3-objective-state--${objectiveStateTone(detailState)}`}><CircleDot size={12} aria-hidden="true" />{formatObjectiveState(detailState)}</span>
              </div>
              <h3>{content.conceptLabel ?? "未命名学习卡"}</h3>
              {content.publicSummary !== content.conceptLabel ? <p className="v3-objective-summary">{content.publicSummary}</p> : null}
            </header>

            </div>
            <section className="objective-brief__departure" aria-label="开始学习">
              <div className="objective-brief__launchpad">
                <span className="objective-brief__mode-label">{detailMode?.label}</span>
                <p id="objective-next-action-state">{reviewNeedsNoteCheck ? "先核对原文再开始复习" : objectiveStateHint(detailState)}</p>
                {noteEvidenceNotice && reviewNeedsNoteCheck ? (
                  <p className="objective-brief__note-evidence" role="status">
                    <Leaf size={15} aria-hidden="true" />
                    <span>{noteEvidenceNotice}</span>
                  </p>
                ) : null}
                <button
                  type="button"
                  className="objective-brief__launch"
                  disabled={starting || (!reviewNeedsNoteCheck && !isActionable(objective.primaryAction))}
                  onClick={() => reviewNeedsNoteCheck ? openNoteEvidence() : void startAction()}
                  aria-labelledby="objective-next-action-verb"
                  aria-describedby="objective-next-action-state objective-next-action-why"
                >
                  <strong id="objective-next-action-verb">{reviewNeedsNoteCheck ? "先核对原文" : starting ? "正在准备" : previousResult && objective.primaryAction.kind === "create_run" ? "再挑战一次" : primaryActionLabel(objective.primaryAction)}</strong>
                  <span aria-hidden="true">{reviewNeedsNoteCheck ? <BookOpenText size={22} /> : starting ? <LoaderCircle size={22} /> : objective.primaryAction.kind === "refresh" ? <RefreshCw size={22} /> : <ArrowRight size={22} />}</span>
                </button>
                <small id="objective-next-action-why">{reviewNeedsNoteCheck ? "回到笔记，核对旧句和现句后再继续。" : primaryActionDescription(objective.primaryAction)}</small>
              </div>
            </section>
            <details className="objective-brief__mission">
              <summary><Target size={16} aria-hidden="true" /><strong id="objective-proof-title">练习说明</strong></summary>
              <div className="objective-brief__mission-body">
                <p>用自己的话说清这个要点，再补一个解释、例子或边界。</p>
                <p className="objective-brief__type-help">可以打字或口述。随卡的客观题只记练习，正式作答才更新掌握状态。</p>
                <p className="objective-brief__mode-description">{detailMode?.description}</p>
              </div>
            </details>
              <details className="objective-brief__progress">
                <summary><History size={17} aria-hidden="true" /><strong id="learning-ledger-title">学习足迹</strong><span>{practiceTrailLabel}</span></summary><div className="objective-brief__trail-body">
                <ObjectiveProgressBand
                  segment={progressSegmentForState(detailState)}
                  submitted={objective.personal.practiceTrailCount > 0 || previousResult?.outcome === "practice_completed"}
                />
                <ul>
                  <li><CheckCircle2 size={16} aria-hidden="true" /><span>正式验证</span><strong>{objective.personal.initialValidation ? objective.personal.initialValidation.status === "ready" && objective.personal.lastCanonicalAt ? "可以再次挑战" : initialValidationLabels[objective.personal.initialValidation.status] : "还没安排"}</strong></li>
                  <li><Clock3 size={16} aria-hidden="true" /><span>当前旅程</span><strong>{objective.personal.activeRun ? formatRunPhase(objective.personal.activeRun.phase) : "尚未开始"}</strong></li>
                  <li><CalendarClock size={16} aria-hidden="true" /><span>复习安排</span><strong>{objective.personal.review ? (objective.personal.review.status === "due" ? "已经到期" : formatObjectiveDateTime(objective.personal.review.dueAt)) : "正式验证后安排"}</strong></li>
                </ul>
              </div></details>


            {actionFailure ? <p className="v3-action-error" role="alert"><AlertTriangle size={14} aria-hidden="true" />{actionFailure}</p> : null}

            {previousResult ? (
              <section className="objective-brief__history" aria-labelledby="objective-previous-result-title">
                <div className="objective-brief__history-copy">
                  <span><History size={18} aria-hidden="true" /> 上一次留下的学习记录</span>
                  <h4 id="objective-previous-result-title">{previousResultLabels[previousResult.outcome]}</h4>
                  <p>{formatObjectiveDateTime(previousResult.completedAt)} · 可以回看当时的作答、判定与解析；重新挑战会生成新的一轮，不会覆盖这份记录。</p>
                </div>
                <button type="button" onClick={openPreviousResult}>回看上次结果 <ArrowRight size={18} aria-hidden="true" /></button>
              </section>
            ) : null}

            <details className="objective-brief__dossier">
              <summary><span><Layers3 size={16} aria-hidden="true" /><strong>出处与原文</strong></span><small>{noteEvidenceNotice ? "依据待核对" : `${objective.sources.origins.length} 条来源 · ${evidenceSnapshotCount} 条原文证据`}</small></summary>
              <div className="objective-brief__dossier-body">
                {noteEvidenceNotice && !reviewNeedsNoteCheck ? <p className="objective-brief__note-evidence" role="status"><Leaf size={15} aria-hidden="true" /><span>{noteEvidenceNotice}</span><button type="button" className="objective-brief__evidence-link" onClick={openNoteEvidence}>翻开原文</button></p> : null}
                {objective.sources.primaryNote ? <button type="button" className="v3-primary-note" onClick={() => openPrimaryNote(objective.sources.primaryNote!)}><FileText size={17} aria-hidden="true" /><span><small>主笔记</small><strong>{objective.sources.primaryNote.title}</strong></span><ChevronRight size={16} aria-hidden="true" /></button> : <div className="v3-primary-note v3-primary-note--missing"><AlertTriangle size={17} aria-hidden="true" /><span><small>主笔记</small><strong>{PRIMARY_NOTE_MISSING_LINE}</strong></span></div>}
                {objective.sources.missingOrigin ? <p className="v3-lineage-warning"><AlertTriangle size={14} aria-hidden="true" />部分来源还没对上，验证前建议先补齐。</p> : null}
                <div className="v3-origin-list">
                  {objective.sources.origins.length ? objective.sources.origins.map((origin, index) => <article key={origin.originId} className="v3-origin-row"><span className="v3-origin-row__index">{String(index + 1).padStart(2, "0")}</span><div><div><strong>{formatOriginKind(origin.kind)}</strong><span>{formatSupportGrade(origin.supportGrade)}</span></div><p>{originFactsLine(origin)}</p><small>{origin.kind === "imported" ? `导入批次 ${origin.importBatchRef}` : formatOriginTrace(origin)}</small></div></article>) : <div className="v3-origin-empty"><FolderOpen size={19} aria-hidden="true" /><strong>{ORIGIN_EMPTY_LINE}</strong><span>这里不会用示例证据填充空白。</span></div>}
                </div>
                <footer className="v3-lineage-boundary"><strong>公开边界</strong><p>这里只讲来源关系和学习状态；标准答案、评分依据和原文段落不会提前出现。</p></footer>
                <footer className="objective-brief__revision"><span>{formatKnowledgeForm(content.knowledgeForm)} · {freshnessLabel(content.freshness)} · {formatLifecycle(content.lifecycle)} · 更新于 {formatObjectiveDateTime(objective.updatedAt)}</span></footer>
              </div>
            </details>
            
          </article>
        </div>
      ) : null}
    </ApprovedSurfaceFrame>
  );
}
