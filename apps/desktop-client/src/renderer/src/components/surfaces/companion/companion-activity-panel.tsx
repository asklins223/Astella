import type { PageReadableV1 } from "@ailearn/shared/companion-bridge-contracts";
import type { CompanionLearningContextV1 } from "@ailearn/shared/companion-conversation-contracts";
import type { CompanionJourneyAction,CompanionJourneyBootstrap } from "@ailearn/shared/companion-journey-contracts";
import type { CompanionActivityDeliveryV1,CompanionActivityTimelineV1 } from "@ailearn/shared/companion-memory-desktop-contracts";
import { Sparkles } from "lucide-react";
import { useEffect,useMemo,useRef,useState } from "react";
import { HUD_PAGES } from "../../hud/hud-pages";
import { usePageReadableView } from "../../hud/use-page-readable-view";
import { formatRelative } from "../notebook/surface-data";
import { RESUME_RUN_ACTION_LABEL } from "../run/objective-state-copy";
import type { Section } from "./companion-center-model";
import { isPendingDelivery,needsDeliveryResponse } from "./companion-center-model";
import { CenterFeedback,SectionState } from "./companion-center-primitives";

const JOURNEY_STEP_LABEL: Record<string, string> = {
  boundary_intro: "了解使用边界",
  preference_capture: "记录学习偏好",
  goal_capture: "确认学习卡",
  choose_start: "选择开始方式",
  first_source: "添加第一份材料",
  source_processing: "整理材料",
  first_note: "写下第一篇笔记",
  first_card: "生成第一张学习卡",
  first_evidence: "补充第一条证据",
  first_run: "完成第一次理解验证",
  first_schedule: "安排第一次复习",
  sample_orientation: "熟悉示例空间",
  closing: "完成旅程",
};

const JOURNEY_STATUS_LABEL: Record<string, string> = {
  active: "进行中",
  paused: "已暂停",
  skipped: "已结束",
  completed: "已完成",
  recoverable_error: "需要重试",
};

const JOURNEY_BRANCH_LABEL: Record<string, string> = {
  own_material: "使用自己的材料",
  blank_note: "从空白笔记开始",
  sandbox_sample: "使用示例材料",
};

type ActivityPanelProps = {
  section: Section<CompanionJourneyBootstrap>;
  learningContextSection: Section<CompanionLearningContextV1>;
  deliverySection: Section<CompanionActivityTimelineV1>;
  deliveries: CompanionActivityDeliveryV1[];
  busy: boolean;
  journeyLoading?: boolean;
  learningLoading?: boolean;
  deliveryLoading?: boolean;
  error: string | null;
  onStart: (kind: "start_journey" | "replay") => void;
  onAction: (action: CompanionJourneyAction) => void;
  onResumeLearning: (runId: string) => void;
  onOpenObjective: (objectiveId: string) => void;
  onPresent: (item: CompanionActivityDeliveryV1) => void;
  onDelivery: (item: CompanionActivityDeliveryV1, transition: "acted" | "dismissed") => void;
  onRetry: () => void;
};

const DELIVERY_PENDING_STATES: ReadonlyArray<CompanionActivityDeliveryV1["state"]> = ["queued", "delivered", "displayed"];

const ACTIVITY_SECTIONS = { learning: "继续学习", journey: "伴星旅程", feed: "最近动态" } as const;

const ACTIVITY_LINES = {
  learningUnavailable: "学习上下文当前不可用",
  learningNothing: { message: "当前没有可继续的学习", detail: "这里只列出系统从真实学习状态里挑出的候选。" },
  journeyUnavailable: "旅程当前不可用",
  journeyInvite: { title: "开始第一段学习旅程", summary: "从你自己的资料开始，伴星会跟随真实进度。" },
  journeySkipped: { title: "旅程邀请已跳过", summary: "需要时可以重新开始，不会补造任何里程碑。" },
  journeyNone: { message: "目前没有进行中的旅程", detail: "新的状态更新会在这里出现。" },
  feedUnavailable: "主动投递当前不可用",
  feedEmpty: { message: "目前没有新的动态", detail: "新的邀请、主动投递和状态更新会出现在这里。" },
  feedNoPending: { message: "没有待处理的动态", detail: "处理完的会收进下面的历史记录。" },
} as const;

function journeyCardTitle(journey: { currentStep: string | null }): string {
  return journey.currentStep ? `当前步骤：${JOURNEY_STEP_LABEL[journey.currentStep] ?? "继续学习旅程"}` : "旅程状态";
}

function journeyCardSummary(journey: { status: string; branch: string }): string {
  return journey.status === "recoverable_error"
    ? "这一步暂时没有完成，可以直接重试。"
    : `${JOURNEY_STATUS_LABEL[journey.status] ?? "状态已更新"} · ${JOURNEY_BRANCH_LABEL[journey.branch] ?? "当前学习路径"}`;
}

function resolvedGroupLabel(count: number): string {
  return `历史动态 · ${count} 条`;
}

export function ActivityPanel(props: ActivityPanelProps) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const journeyState = props.section.ok ? props.section.value : null;
  const learningContext = props.learningContextSection.ok ? props.learningContextSection.value : null;
  const resumeCandidate = learningContext?.learningRunResumeCandidate ?? null;
  const startCandidate = learningContext?.learningRunStartCandidate ?? null;
  const pending = props.deliveries.filter(isPendingDelivery);
  const resolved = props.deliveries.filter((item) => !isPendingDelivery(item));
  const proposals = pending.filter(needsDeliveryResponse);
  const messages = pending.filter(item => !needsDeliveryResponse(item));

  /**
   * 这一格登记给伴星读的是**三段各自那一刻露出的那一行**（39d W2-7）。
   *
   * `state` 一律是"这一行来自哪一段"（同一个字段同一个含义）；投递自己的
   * "待处理"那一层不进这个字段。历史动态按当前展开状态登记，读取中不登记旧数据。
   */
  const activityReadableView = useMemo<PageReadableV1 | null>(() => {
    const rows: Array<{ label: string; state: string }> = [];
    const push = (label: string, state: string) => {
      if (rows.length < 12) rows.push({ label, state });
    };
    if (props.learningLoading) push("正在读取学习状态", ACTIVITY_SECTIONS.learning);
    else if (!props.learningContextSection.ok) push(ACTIVITY_LINES.learningUnavailable, ACTIVITY_SECTIONS.learning);
    else if (resumeCandidate) push(resumeCandidate.title, ACTIVITY_SECTIONS.learning);
    else if (startCandidate) push(startCandidate.title, ACTIVITY_SECTIONS.learning);
    else push(ACTIVITY_LINES.learningNothing.message, ACTIVITY_SECTIONS.learning);

    if (props.deliveryLoading) push("正在读取动态", ACTIVITY_SECTIONS.feed);
    else if (!props.deliverySection.ok) push(ACTIVITY_LINES.feedUnavailable, ACTIVITY_SECTIONS.feed);
    else if (props.deliveries.length === 0) push(ACTIVITY_LINES.feedEmpty.message, ACTIVITY_SECTIONS.feed);
    else {
      if (pending.length === 0) push(ACTIVITY_LINES.feedNoPending.message, ACTIVITY_SECTIONS.feed);
      [...proposals, ...messages, ...(historyOpen ? resolved : [])].forEach((item) => push(item.label, ACTIVITY_SECTIONS.feed));
    }

    if (props.journeyLoading) push("正在读取旅程", ACTIVITY_SECTIONS.journey);
    else if (!journeyState) push(ACTIVITY_LINES.journeyUnavailable, ACTIVITY_SECTIONS.journey);
    else if (journeyState.journey) push(journeyCardTitle(journeyState.journey), ACTIVITY_SECTIONS.journey);
    else if (journeyState.invitation.status === "offered" || journeyState.invitation.status === "deferred") push(ACTIVITY_LINES.journeyInvite.title, ACTIVITY_SECTIONS.journey);
    else if (journeyState.invitation.status === "skipped") push(ACTIVITY_LINES.journeySkipped.title, ACTIVITY_SECTIONS.journey);
    else if (journeyState.invitation.status === "accepted") push(ACTIVITY_LINES.journeyNone.message, ACTIVITY_SECTIONS.journey);

    return {
      pageId: "companion",
      title: HUD_PAGES.companion.title,
      ...(props.error ? { statusLine: props.error.slice(0, 160) } : {}),
      items: rows.map((row, index) => ({
        ordinal: index + 1,
        label: row.label.slice(0, 120),
        state: row.state.slice(0, 40),
      })),
      ...(props.deliverySection.ok && !props.deliveryLoading && resolved.length > 0 ? { notice: resolvedGroupLabel(resolved.length) } : {}),
    };
  }, [historyOpen, journeyState, messages, pending.length, proposals, props.deliverySection, props.deliveryLoading, props.error, props.journeyLoading, props.learningContextSection, props.learningLoading, resolved, resumeCandidate, startCandidate]);
  usePageReadableView(activityReadableView);

  const renderDelivery = (item: CompanionActivityDeliveryV1) => <ActivityDeliveryCard key={item.deliveryId} item={item} busy={props.busy} onPresent={props.onPresent} onDelivery={props.onDelivery} />;
  return <div className="cc-activity">
    <CenterFeedback error={props.error} />
    <section className="cc-learning-continuation" aria-label="学习衔接">
      <span className="cc-kicker">继续学习</span>
      {props.learningLoading ? <p role="status">正在读取学习状态</p> : !props.learningContextSection.ok
        ? <SectionState message={ACTIVITY_LINES.learningUnavailable} detail={props.learningContextSection.message} onRetry={props.onRetry} />
        : resumeCandidate ? <div><span><strong>{resumeCandidate.title}</strong><p>{resumeCandidate.targetSummary}</p><small>{resumeCandidate.impactSummary}</small></span><button type="button" className="button primary" onClick={() => props.onResumeLearning(resumeCandidate.runId)}>{RESUME_RUN_ACTION_LABEL}</button></div>
        : startCandidate ? <div><span><strong>{startCandidate.title}</strong><p>{startCandidate.targetSummary}</p><small>{startCandidate.impactSummary}</small></span><button type="button" onClick={() => props.onOpenObjective(startCandidate.objectiveId)}>查看目标</button></div>
        : <p className="cc-muted">{ACTIVITY_LINES.learningNothing.message}</p>}
    </section>
    <div className="cc-activity-columns">
      <section className="cc-timeline" aria-label="主动投递与状态更新"><h3>最近动态</h3>
        {props.deliveryLoading ? <SectionState message="正在读取动态" /> : !props.deliverySection.ok ? <SectionState message={ACTIVITY_LINES.feedUnavailable} detail={props.deliverySection.message} onRetry={props.onRetry} />
          : !props.deliveries.length ? <SectionState message={ACTIVITY_LINES.feedEmpty.message} detail={ACTIVITY_LINES.feedEmpty.detail} />
          : <>{proposals.length ? <div className="cc-timeline-group"><h4>待选择 · {proposals.length}</h4>{proposals.map(renderDelivery)}</div> : null}
            {messages.length ? <div className="cc-timeline-group"><h4>留给你的消息 · {messages.length}</h4>{messages.map(renderDelivery)}</div> : null}
            {!pending.length ? <p className="cc-muted">{ACTIVITY_LINES.feedNoPending.message}</p> : null}
            {resolved.length ? <details className="cc-timeline-history" open={historyOpen} onToggle={event => setHistoryOpen(event.currentTarget.open)}><summary>{resolvedGroupLabel(resolved.length)}</summary>{resolved.map(renderDelivery)}</details> : null}</>}
      </section>
      <aside className="cc-journey" aria-label="伴星旅程"><Sparkles size={20} aria-hidden="true" /><h3>伴星旅程</h3><p className="cc-muted">跟随这个书房的真实学习进度。</p>
        {props.journeyLoading ? <p role="status">正在读取旅程</p> : !journeyState ? <SectionState message={ACTIVITY_LINES.journeyUnavailable} detail={!props.section.ok ? props.section.message : undefined} onRetry={props.onRetry} /> : <>
          {!journeyState.journey && ["offered", "deferred"].includes(journeyState.invitation.status) ? <div><strong>{ACTIVITY_LINES.journeyInvite.title}</strong><p>{ACTIVITY_LINES.journeyInvite.summary}</p><button type="button" className="button primary" disabled={props.busy} onClick={() => props.onStart("start_journey")}>开始旅程</button></div> : null}
          {!journeyState.journey && journeyState.invitation.status === "skipped" ? <div><strong>{ACTIVITY_LINES.journeySkipped.title}</strong><p>{ACTIVITY_LINES.journeySkipped.summary}</p><button type="button" disabled={props.busy} onClick={() => props.onStart("replay")}>重新邀请</button></div> : null}
          {!journeyState.journey && journeyState.invitation.status === "accepted" ? <p>{ACTIVITY_LINES.journeyNone.message}</p> : null}
          {journeyState.journey ? <div><strong>{journeyCardTitle(journeyState.journey)}</strong><p>{journeyCardSummary(journeyState.journey)}</p><div className="cc-actions">
            {journeyState.journey.status === "active" ? <button type="button" disabled={props.busy} onClick={() => props.onAction({ kind: "pause" })}>暂停</button> : null}
            {journeyState.journey.status === "paused" ? <button type="button" className="button primary" disabled={props.busy} onClick={() => props.onAction({ kind: "resume", resumeToken: journeyState.journey!.resumeTokenRef })}>继续</button> : null}
            {journeyState.journey.status === "recoverable_error" && journeyState.journey.error?.retryable ? <button type="button" className="button primary" disabled={props.busy} onClick={() => props.onAction({ kind: "retry" })}>重试</button> : null}
            {["active", "paused"].includes(journeyState.journey.status) ? <button type="button" disabled={props.busy} onClick={() => props.onAction({ kind: "skip" })}>结束旅程</button> : null}
          </div></div> : null}
        </>}
      </aside>
    </div>
  </div>;
}

function ActivityDeliveryCard({ item, busy, onPresent, onDelivery }: {
  readonly item: CompanionActivityDeliveryV1;
  readonly busy: boolean;
  readonly onPresent: (item: CompanionActivityDeliveryV1) => void;
  readonly onDelivery: (item: CompanionActivityDeliveryV1, transition: "acted" | "dismissed") => void;
}) {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || item.expired || !["queued", "delivered"].includes(item.state) || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting && entry.intersectionRatio >= 0.6)) {
        onPresent(item);
        observer.disconnect();
      }
    }, { root: element.closest(".cc-page"), threshold: 0.6 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [item, onPresent]);

  return <article ref={ref} className="cc-delivery" data-state={item.state} data-expired={item.expired || undefined}>
    <span className="cc-delivery__dot" aria-hidden="true" />
    <div><strong>{item.label}</strong><small>{formatRelative(item.createdAt)} · {item.expired ? "已失效" : item.state === "acted" ? "已处理" : item.state === "dismissed" ? "已忽略" : needsDeliveryResponse(item) ? "待选择" : "未处理"}</small>
      {!item.expired && DELIVERY_PENDING_STATES.includes(item.state) ? <div className="cc-actions"><button type="button" className="cc-link" disabled={busy} onClick={() => onDelivery(item, "acted")}>{item.target.kind === "none" ? "知道了" : item.target.kind === "proposal" ? "查看提议" : "查看"}</button><button type="button" className="cc-link cc-muted" disabled={busy} onClick={() => onDelivery(item, "dismissed")}>忽略</button></div> : null}
    </div>
  </article>;
}
