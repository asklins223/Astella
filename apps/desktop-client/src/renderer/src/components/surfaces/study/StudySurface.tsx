import { useMemo, useRef, type KeyboardEvent } from "react";
import { ArrowRight, BookOpen, CalendarDays, Leaf, NotebookPen, RefreshCw, Route, Sparkles } from "lucide-react";
import type { ActivityTargetV1, TodayActivityV1 } from "@ailearn/shared/activity-surface-contracts";
import type { AllWorkspacesStatsOverviewV1 } from "@ailearn/shared/stats-overview-contracts";
import type { NoteLearningRoundPersonalHistoryItemV1 } from "@ailearn/shared/note-learning-round-contracts";
import type { PageReadableV1 } from "@ailearn/shared/companion-bridge-contracts";
import { SETTINGS_ATTENTION_AI_CONSENT } from "../../../app/companion-consent-gate";
import { useRoomStore } from "../../../app/room-store";
import { createRequestMeta, unwrapGatewayResult } from "../../../app/desktop-client";
import { HudPage } from "../../hud/HudPage";
import { useHudPage } from "../../hud/use-hud-page";
import { usePageReadableView } from "../../hud/use-page-readable-view";
import { useTactileSurface } from "../../motion/use-tactile-surface";
import { SurfaceDataState, useDayAnchor, useSurfaceProjection } from "../notebook/surface-data.tsx";
import { buildAllSpacesSummary, type AllSpacesSummary } from "../library/all-spaces-summary.ts";
import { buildTodayAnomalyGroups, buildTodayLogRows, buildTodayVerdict, sharedAnomalyStep, sortAnomalyGroups,
  todayAnomalyTruncationNote, todayLogTruncationNote, type TodayAnomalyGroup, type TodayLogRow } from "../library/today-log.ts";
import { ROUND_RECORD_COPY_V1, roundHistoryStateLabelV1 } from "../notebook/round-record-copy.ts";
import { AllSpacesPanel, AnomalyTriage, CompanionRail, DayVerdict, LogStream, RoundRecordStream } from "./study-log-sections";
import { useStudyRoundRecords } from "./use-study-round-records";
import { useStudyJournalPosition, type StudyTab } from "./use-study-journal-position";

const TABS: readonly { id: StudyTab; label: string; Icon: typeof CalendarDays }[] = [
  { id: "today", label: "今天的足迹", Icon: CalendarDays },
  { id: "rounds", label: "学过的每一轮", Icon: NotebookPen },
  { id: "spaces", label: "各个空间", Icon: BookOpen },
];
function dayWindowFromAnchor(nowMs: number) {
  const midnight = new Date(nowMs); midnight.setHours(0, 0, 0, 0);
  const next = new Date(midnight.getFullYear(), midnight.getMonth(), midnight.getDate() + 1);
  return { from: midnight.toISOString(), to: next.toISOString() };
}
function dayIso(nowMs: number) {
  const date = new Date(nowMs);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function StudySurface() {
  const invoke = useRoomStore((state) => state.invoke);
  const setActiveObjectiveId = useRoomStore((state) => state.setActiveObjectiveId);
  const setActiveRunId = useRoomStore((state) => state.setActiveRunId);
  const setActiveNoteRef = useRoomStore((state) => state.setActiveNoteRef);
  const setActiveCardGenerationRunId = useRoomStore((state) => state.setActiveCardGenerationRunId);
  const setActiveSourceId = useRoomStore((state) => state.setActiveSourceId);
  const setSettingsSection = useRoomStore((state) => state.setSettingsSection);
  const setSettingsAttention = useRoomStore((state) => state.setSettingsAttention);
  const spaceIdentity = useRoomStore((state) => state.spaceIdentity);
  useHudPage("today");

  // 日锚点先于数据读取确定：窗口是"读者的今天"，刷新焦点时页面会自己跟上
  // 跨午夜的变化（useDayAnchor 在可见性恢复/跨天时重锚）。
  const nowMs = useDayAnchor();
  const dayWindow = useMemo(() => dayWindowFromAnchor(nowMs), [nowMs]);

  const { data, loading, failure, refreshing, refreshFailure, reload } = useSurfaceProjection<TodayActivityV1>(async ({ workspaceEpoch }) => {
    const meta = createRequestMeta(workspaceEpoch);
    const result = await window.ailearn.activity.getToday({ meta, from: dayWindow.from, to: dayWindow.to });
    return unwrapGatewayResult(result);
  }, [dayWindow.from, dayWindow.to], { refreshOnFocus: true });

  // 「全部空间」是**另一条**读数：它不随当前空间变，所以也不跟日锚点/空间绑定，
  // 只在进入这一页时读一次（失败就地给重试，不冒充"全部"）。
  const allSpaces = useSurfaceProjection<AllWorkspacesStatsOverviewV1>(async ({ workspaceEpoch }) => {
    const meta = createRequestMeta(workspaceEpoch);
    const result = await window.ailearn.stats.getOverviewAll({ meta });
    return unwrapGatewayResult(result);
  }, []);

  const rounds = useStudyRoundRecords();
  const { tab, select: setTab, paperRef, rememberScroll } = useStudyJournalPosition({
    today: loading, rounds: rounds.loading || rounds.restoring, spaces: allSpaces.loading,
  }, rounds.items.length);
  const rootRef = useRef<HTMLElement>(null);
  useTactileSurface(rootRef, tab);

  const rows: readonly TodayLogRow[] = useMemo(() => (data ? buildTodayLogRows(data.events) : []), [data]);
  const groups: readonly TodayAnomalyGroup[] = useMemo(
    () => (data ? sortAnomalyGroups(buildTodayAnomalyGroups(data.anomalies)) : []),
    [data],
  );
  /**
   * 分诊只收用户能处理的那些（审计 F14）：有可打开对象或有恢复路径。其余是后台任务
   * 自己的失败，另起一块列出——说出来，但不当成用户的待办。
   */
  const { actionableGroups, backgroundGroups } = useMemo(() => ({
    actionableGroups: groups.filter((group) => Boolean(group.target || group.recovery)),
    backgroundGroups: groups.filter((group) => !group.target && !group.recovery),
  }), [groups]);
  const verdict = useMemo(() => (data ? buildTodayVerdict(data) : null), [data]);
  const allSpacesSummary: AllSpacesSummary | null = useMemo(
    () => (allSpaces.data ? buildAllSpacesSummary(allSpaces.data) : null),
    [allSpaces.data],
  );
  const sharedStep = useMemo(() => sharedAnomalyStep(actionableGroups), [actionableGroups]);
  const logNote = useMemo(() => (data ? todayLogTruncationNote(data) : null), [data]);
  const anomalyNote = useMemo(() => (data ? todayAnomalyTruncationNote(data) : null), [data]);

  /**
   * 今日页登记给伴星读的可读视图（doc 37）。条目就是屏上「待处理」那几组，
   * 序号按屏幕顺序；headline/detail/metrics 全部复用 `buildTodayVerdict` 的产物，
   * 这一层不重新算任何一个数。
   */
  const readableView = useMemo<PageReadableV1 | null>(() => {
    if (tab === "rounds") return {
      pageId: "today", title: "今日学习 · 学过的每一轮",
      statusLine: rounds.loading ? "正在读取学习轮次" : `共 ${rounds.total} 轮，已列出 ${rounds.items.length} 轮`,
      metrics: [{ label: "学习轮次", value: `${rounds.total} 轮` }],
      items: rounds.items.slice(0, 8).map((item, index) => ({ ordinal: index + 1,
        label: item.drivingQuestion.slice(0, 60), state: `${item.noteTitle.slice(0, 25)} · ${roundHistoryStateLabelV1(item)}` })),
      ...(rounds.failure ? { notice: rounds.failure.slice(0, 80) } : {}),
    };
    if (tab === "spaces") return {
      pageId: "today", title: "今日学习 · 各个空间",
      statusLine: allSpaces.loading ? "正在读取各个空间" : allSpacesSummary ? "每个空间的进度单独列出" : "各个空间的进度暂时读不到",
      metrics: allSpacesSummary?.totalMetrics.map(item => ({ label: item.label, value: `${item.value}` })) ?? [],
      items: allSpacesSummary?.rows.slice(0, 8).map((item, index) => ({ ordinal: index + 1, label: item.name.slice(0, 60), state: item.isCurrent ? "当前空间" : item.kindLabel })) ?? [],
    };
    if (!data || !verdict) return null;
    return {
      pageId: "today",
      title: "今日学习",
      statusLine: `${verdict.headline}${verdict.detail ? ` · ${verdict.detail.slice(0, 80)}` : ""}`,
      metrics: [
        ...verdict.metrics.map((metric) => ({ label: metric.label, value: metric.value })),
        ...(verdict.background > 0 ? [{ label: "后台失败", value: `${verdict.background} 条` }] : []),
      ],
      items: groups.slice(0, 8).map((group, index) => ({
        ordinal: index + 1,
        label: group.title.slice(0, 60),
        state: group.count > 1
          ? `${group.statusLabel.slice(0, 16)} ×${group.count}`
          : group.statusLabel.slice(0, 24),
      })),
      ...(failure ? { notice: `这一页没读到最新内容：${failure.slice(0, 80)}` } : {}),
    };
  }, [tab, data, failure, groups, verdict, rounds.items, rounds.total, rounds.loading, rounds.failure, allSpacesSummary, allSpaces.loading]);
  usePageReadableView(readableView);

  const triageRef = useRef<HTMLElement>(null);
  const scrollToTriage = () => {
    setTab("today");
    triageRef.current?.scrollIntoView({ block: "start", behavior: "instant" });
    triageRef.current?.focus({ preventScroll: true });
  };

  const returnTo = { label: "返回今日学习", run: () => invoke("continue") };
  const openTarget = (target: ActivityTargetV1) => {
    switch (target.kind) {
      case "learning_run":
        setActiveRunId(target.id);
        invoke("validate");
        return;
      case "objective":
        setActiveObjectiveId(target.id);
        invoke("open-objective", { returnTo });
        return;
      case "note":
        setActiveNoteRef({ noteId: target.id, noteVersionId: target.noteVersionId });
        invoke("open-notebook", { returnTo });
        return;
      case "card_generation":
        setActiveCardGenerationRunId(target.id);
        invoke("open-card-generation", { returnTo });
        return;
      case "source":
        setActiveSourceId(target.id);
        invoke("open-source", { returnTo });
        return;
    }
  };

  const openRoundRecord = (item: NoteLearningRoundPersonalHistoryItemV1) => {
    setActiveNoteRef({ noteId: item.noteId, noteVersionId: null, mode: "preview", learningRoundId: item.roundId });
    invoke("open-notebook", { returnTo });
  };

  const recoverAnomaly = (recovery: TodayAnomalyGroup["recovery"]) => {
    if (recovery !== "ai_consent") return;
    setSettingsAttention(SETTINGS_ATTENTION_AI_CONSENT);
    setSettingsSection("data");
    invoke("open-settings", { returnTo });
  };

  const reading = loading || Boolean(failure);
  const selectTab = (id: StudyTab) => {
    setTab(id);
    rootRef.current?.querySelector<HTMLElement>(`#study-tab-${id}`)?.focus({ preventScroll: true });
  };
  const tabKeys = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = TABS.findIndex(item => item.id === tab);
    const next = event.key === "ArrowRight" ? (index + 1) % TABS.length
      : event.key === "ArrowLeft" ? (index + TABS.length - 1) % TABS.length
      : event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : null;
    if (next !== null) { event.preventDefault(); selectTab(TABS[next].id); }
  };

  return (
    <HudPage page="today">
      <section ref={rootRef} className="day-route" data-page="today-log" aria-label="今日学习">
        <header className="day-head">
          <div className="day-head__calendar" aria-hidden="true">
            <span>{new Date(nowMs).getMonth() + 1} 月</span><b>{new Date(nowMs).getDate()}</b>
          </div>
          <div className="day-head__intro">
            <p className="day-head__date"><time dateTime={dayIso(nowMs)}>{new Intl.DateTimeFormat("zh-CN", { weekday: "long" }).format(new Date(nowMs))}</time><span>今天，学一点喜欢的。</span></p>
            <p className="day-head__scope">当前空间{spaceIdentity ? ` · ${spaceIdentity.name}` : ""}</p>
          </div>
          <button type="button" className="button day-head__refresh" disabled={refreshing} onClick={() => void reload({ silent: true })}
            aria-label="重新读取今日学习记录" aria-busy={refreshing}><RefreshCw size={17} aria-hidden="true" /></button>
        </header>
        <div className="day-paths" aria-label="今天从哪里开始">
          <button className="day-path" type="button" onClick={() => invoke("open-resumable", { returnTo })}>
            <span className="day-path__icon"><Route size={22} aria-hidden="true" /></span><span><b>接着上次学</b><small>未完成的练习，进度还在</small></span><ArrowRight size={17} aria-hidden="true" />
          </button>
          <button className="day-path" type="button" onClick={() => invoke("open-notes", { returnTo })}>
            <span className="day-path__icon"><BookOpen size={22} aria-hidden="true" /></span><span><b>翻开一篇笔记</b><small>读一读，也回想一下</small></span><ArrowRight size={17} aria-hidden="true" />
          </button>
          <button className="day-path" type="button" onClick={() => invoke("review", { returnTo })}>
            <span className="day-path__icon"><Leaf size={22} aria-hidden="true" /></span><span><b>温习熟悉的知识</b><small>看看今天到期的复习</small></span><ArrowRight size={17} aria-hidden="true" />
          </button>
        </div>
        <div className="day-tabs" role="tablist" aria-label="学习手账" data-tactile-tabs>
          <span className="day-tabs__cushion" data-tactile-cushion aria-hidden="true" />
          {TABS.map(({ id, label, Icon }) => <button key={id} type="button" role="tab" id={`study-tab-${id}`} aria-controls={`study-panel-${id}`}
            aria-selected={tab === id} tabIndex={tab === id ? 0 : -1} onKeyDown={tabKeys} onClick={() => selectTab(id)}><Icon size={17} aria-hidden="true" />{label}</button>)}
        </div>
        <div className="day-paper" ref={paperRef} onScroll={rememberScroll}>
          <section className="day-tab-page" id="study-panel-today" role="tabpanel" aria-labelledby="study-tab-today" hidden={tab !== "today"} data-tactile-page="today">
            {refreshFailure ? <p className="day-head__refresh-failure" role="status">{refreshFailure} · 仍显示上次读到的记录</p> : null}
            {reading ? <SurfaceDataState kind={loading ? "loading" : "error"}
              message={loading ? "正在读取今天的操作日志" : "今天的操作日志暂时不可用"}
              detail={loading ? "笔记、来源和练习的足迹，正在收进这页手账。" : failure ?? ""}
              onRetry={loading ? undefined : () => void reload()} /> : verdict ? <>
              <DayVerdict verdict={verdict} triageCount={actionableGroups.length} onTriage={scrollToTriage} />
              <div className="day-log" role="group" aria-label="今日操作日志与待处理事务">
                <LogStream rows={rows} note={logNote} onOpen={openTarget} onPick={intent => invoke(intent, { returnTo })} />
                {groups.length > 0 ? <AnomalyTriage groups={actionableGroups} backgroundGroups={backgroundGroups}
                  total={data?.anomalies.length ?? groups.length} sharedStep={sharedStep} note={anomalyNote} onOpen={openTarget} onRecover={recoverAnomaly} anchorRef={triageRef} /> : null}
              </div>
            </> : null}
          </section>
          <section className="day-tab-page" id="study-panel-rounds" role="tabpanel" aria-labelledby="study-tab-rounds" hidden={tab !== "rounds"} data-tactile-page="rounds">
            <p className="day-page-lead"><NotebookPen size={20} aria-hidden="true" />一轮一个问题，慢慢留下弄懂它的过程。</p>
            <RoundRecordStream items={rounds.items} total={rounds.total} hasMore={rounds.hasMore} busy={rounds.busy}
              failure={rounds.failure} loading={rounds.loading} loadingText={ROUND_RECORD_COPY_V1.loadingOlder} loadMoreText={ROUND_RECORD_COPY_V1.loadOlder}
              onLoadOlder={() => void rounds.loadOlder()} onReload={rounds.reload} onOpen={openRoundRecord} />
          </section>
          <section className="day-tab-page" id="study-panel-spaces" role="tabpanel" aria-labelledby="study-tab-spaces" hidden={tab !== "spaces"} data-tactile-page="spaces">
            <p className="day-page-lead"><BookOpen size={20} aria-hidden="true" />每个空间都有自己的小小积累。</p>
            <AllSpacesPanel summary={allSpacesSummary} loading={allSpaces.loading} failure={allSpaces.failure} onRetry={() => void allSpaces.reload()} />
          </section>
        </div>
        <aside className="day-rail" aria-label="伴星日记"><Sparkles size={23} aria-hidden="true" /><CompanionRail onOpen={() => invoke("open-companion-center", { returnTo })} /></aside>
      </section>
    </HudPage>
  );
}
