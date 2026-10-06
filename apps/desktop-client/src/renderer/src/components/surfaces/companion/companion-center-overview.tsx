import type { PageReadableV1 } from "@astella/shared/companion-bridge-contracts";
import type {
CompanionActivityTimelineV1,
CompanionDailySummaryV1,
CompanionHistoryPageV1,
} from "@astella/shared/companion-memory-desktop-contracts";
import { ArrowRight,BookOpen,MessageCircle,Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { plainCompanionBubbleText } from "../../companion/companion-markdown";
import { HUD_PAGES } from "../../hud/hud-pages";
import { usePageReadableView } from "../../hud/use-page-readable-view";
import { formatDate,formatRelative } from "../notebook/surface-data.tsx";

import { needsDeliveryResponse,type Section } from "./companion-center-model";
import { CompanionCapabilityGuide, companionDiscoverableCapabilities } from "./companion-capability-guide";

/**
 * 概览页屏上就那几句小标题与状态字，各写一次：JSX 与登记给伴星的可读视图引用同一份
 * （视图字段写错不会红，抄成两处迟早分叉）。
 */
const OVERVIEW_TITLES = {
  diary: "最近一篇日记",
  excerpt: "原文摘录",
  pending: "需要你回应",
  recent: "最近的对话",
} as const;
const OVERVIEW_STATES = {
  diaryUnavailable: "日记暂时读不到。你仍可以继续交流。",
  diaryImageOnly: "这篇日记以图片开篇，打开后可按原顺序阅读。",
  diaryFailed: "这一天她没能写下来。",
  diaryNone: "这里还没有日记。之后她写下的内容会出现在这里。",
  pendingUnavailable: "动态暂时读不到。",
  pendingNone: "目前没有待回应的事。",
  recentUnavailable: "对话记录暂时读不到。",
  recentNone: "你们还没有留下对话。",
} as const;

export function CompanionCenterOverview({
  companionName,
  diary,
  history,
  activity,
  onContinue,
  onGo,
}: {
  readonly companionName: string;
  readonly diary: Section<CompanionDailySummaryV1>;
  readonly history: Section<CompanionHistoryPageV1>;
  readonly activity: Section<CompanionActivityTimelineV1>;
  readonly onContinue: () => void;
  readonly onGo: (tab: "dialogue" | "memory" | "diary" | "activity") => void;
}) {
  const [guideOpen, setGuideOpen] = useState(false);
  const latest = diary.ok ? diary.value : null;
  const excerpt = latest?.status === "generated"
    ? latest.blocks.find((block) => block.type === "text" || block.type === "quote")
    : null;
  const excerptText = excerpt?.type === "text" ? excerpt.text : excerpt?.type === "quote" ? excerpt.text : null;
  const pending = activity.ok
    ? activity.value.items
        .filter(needsDeliveryResponse)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    : [];
  const latestReply = history.ok
    ? [...history.value.items].filter((item) => item.role === "assistant" && item.blocks.some((block) => block.type === "text"))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    : null;
  const latestReplyText = latestReply?.blocks.find((block) => block.type === "text");
  const latestReplyExcerpt = latestReplyText?.type === "text" ? plainCompanionBubbleText(latestReplyText.text).split(/\n\s*\n/)[0] : null;

  /**
   * 登记三块各自露出的那一行，以及用户已展开的能力说明；收起内容不注入。
   *
   * `state` 一律是"这一行属于屏上哪一个小标题"（同一个字段只准一个含义）：
   * 日记有摘录时那一行挂在「原文摘录」下面，所以它的小标题就是「原文摘录」，
   * 不是「最近一篇日记」。没露出的内容（要点开整篇才看得到的其余段落）一条都不登记。
   */
  const overviewReadableView = useMemo<PageReadableV1 | null>(() => {
    const rows: Array<{ label: string; state: string }> = [];
    const push = (label: string, state: string) => {
      if (label.trim() && rows.length < 12) rows.push({ label, state });
    };
    if (guideOpen) companionDiscoverableCapabilities.forEach(item => push(item.presentation.discovery!, item.presentation.label));
    if (!diary.ok) push(OVERVIEW_STATES.diaryUnavailable, OVERVIEW_TITLES.diary);
    else if (latest?.status === "generated") {
      if (excerptText) push(excerptText, OVERVIEW_TITLES.excerpt);
      else push(OVERVIEW_STATES.diaryImageOnly, OVERVIEW_TITLES.diary);
    } else if (latest?.status === "failed") push(OVERVIEW_STATES.diaryFailed, OVERVIEW_TITLES.diary);
    else push(OVERVIEW_STATES.diaryNone, OVERVIEW_TITLES.diary);

    if (!activity.ok) push(OVERVIEW_STATES.pendingUnavailable, OVERVIEW_TITLES.pending);
    else if (pending.length === 0) push(OVERVIEW_STATES.pendingNone, OVERVIEW_TITLES.pending);
    else push(pending[0].label, OVERVIEW_TITLES.pending);

    if (!history.ok) push(OVERVIEW_STATES.recentUnavailable, OVERVIEW_TITLES.recent);
    else if (latestReplyExcerpt) push(latestReplyExcerpt, OVERVIEW_TITLES.recent);
    else push(OVERVIEW_STATES.recentNone, OVERVIEW_TITLES.recent);

    return {
      pageId: "companion",
      title: HUD_PAGES.companion.title,
      ...((activity.ok && pending.length > 0) || latest?.date
        ? {
            metrics: [
              ...(activity.ok && pending.length > 0 ? [{ label: "待回应", value: `${pending.length} 件提议`.slice(0, 40) }] : []),
              ...(latest?.date ? [{ label: "最近日记", value: formatDate(latest.date).slice(0, 40) }] : []),
            ],
          }
        : {}),
      items: rows.map((row, index) => ({
        ordinal: index + 1,
        label: row.label.slice(0, 120),
        state: row.state.slice(0, 40),
      })),
    };
  }, [activity, diary, history, latest?.date, latest?.status, excerptText, pending, guideOpen]);
  usePageReadableView(overviewReadableView);

  return <div className="cc-overview">
    <div className="cc-overview__greeting"><div><span className="cc-kicker">一起留下的日常</span><h3>和 {companionName} 接着聊</h3></div><button type="button" className="cc-button is-primary" onClick={onContinue}><MessageCircle size={17} aria-hidden="true" />开始交流<ArrowRight size={15} aria-hidden="true" /></button></div>
    <CompanionCapabilityGuide onContinue={onContinue} onOpenChange={setGuideOpen} />
    {activity.ok && pending.length > 0 ? <section className="cc-overview__response" aria-labelledby="companion-pending-title"><div><Sparkles size={17} aria-hidden="true" /><h3 id="companion-pending-title">{OVERVIEW_TITLES.pending}</h3><span>{pending.length} 件提议</span></div><p>{pending[0].label}</p><button type="button" className="cc-link" onClick={() => onGo("activity")}>查看提议<ArrowRight size={14} /></button></section> : null}
    <div className="cc-overview__reading">
      <section className="cc-overview__diary" aria-labelledby="companion-latest-diary-title"><header><BookOpen size={18} aria-hidden="true" /><h3 id="companion-latest-diary-title">{OVERVIEW_TITLES.diary}</h3>{latest?.date ? <time>{formatDate(latest.date)}</time> : null}</header>
        {!diary.ok ? <p className="cc-overview__quiet">{OVERVIEW_STATES.diaryUnavailable}</p> : latest?.status === "generated" ? <><span className="cc-kicker">{OVERVIEW_TITLES.excerpt}</span>{excerptText ? <blockquote>{excerptText}</blockquote> : <p className="cc-overview__quiet">{OVERVIEW_STATES.diaryImageOnly}</p>}</> : <p className="cc-overview__quiet">{latest?.status === "failed" ? OVERVIEW_STATES.diaryFailed : OVERVIEW_STATES.diaryNone}</p>}
        <button type="button" className="cc-link" onClick={() => onGo("diary")}>{latest?.status === "generated" ? "读完整篇" : latest?.status === "failed" ? "查看原因" : "翻开日记"}<ArrowRight size={15} aria-hidden="true" /></button>
      </section>
      <section className="cc-overview__conversation" aria-labelledby="companion-recent-title"><span className="cc-kicker">上一次的话题</span><h3 id="companion-recent-title">{OVERVIEW_TITLES.recent}</h3>
        {!history.ok ? <p className="cc-overview__quiet">{OVERVIEW_STATES.recentUnavailable}</p> : latestReplyExcerpt ? <><p>{latestReplyExcerpt}</p><time>{latestReply ? formatRelative(latestReply.createdAt) : null}</time></> : <p className="cc-overview__quiet">{OVERVIEW_STATES.recentNone}</p>}
        <button type="button" className="cc-link" onClick={() => onGo("dialogue")}>{latestReply ? "查看这段对话" : "查看对话记录"}<ArrowRight size={15} aria-hidden="true" /></button>
      </section>
    </div>
    {!activity.ok ? <p className="cc-overview__quiet">{OVERVIEW_STATES.pendingUnavailable}</p> : !pending.length ? <p className="cc-overview__footnote">{OVERVIEW_STATES.pendingNone} <button type="button" className="cc-link" onClick={() => onGo("activity")}>看看最近动态<ArrowRight size={14} /></button></p> : null}
    <button type="button" className="cc-overview__memory-link" onClick={() => onGo("memory")}><span><strong>她记住了什么</strong><small>偏好、共同经历，还有她对一些事的看法。</small></span><ArrowRight size={18} aria-hidden="true" /></button>
  </div>;
}
