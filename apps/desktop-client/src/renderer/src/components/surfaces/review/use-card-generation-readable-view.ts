import { useMemo, useState, useEffect } from "react";
import type { PageReadableV1 } from "@astella/shared/companion-bridge-contracts";
import { usePageReadableView } from "../../hud/use-page-readable-view";
import { cardGenerationStatusLabel, isCardGenerationInFlight } from "./card-generation-status";
import { candidateDecisionLabel } from "./candidate-review-model";
import { cardStrategyPresentation } from "./card-strategy-presentation";
import type { CardGenerationSession } from "./use-card-generation-session";

export function useCardGenerationReadableView(session: CardGenerationSession) {
 const { run, loading, activeCandidate, activeCandidateIndex, candidates, actionableUndecidedCount, noteTitle, practiceQuotaView, schedulingNotice, failure, page, progressView, landedCandidates, receipt } = session;
 const [, setTick] = useState(0);
 useEffect(() => { if (!run) return; const timer = window.setInterval(() => setTick(value => value + 1), 30_000); return () => window.clearInterval(timer); }, [run?.runId]);
const readableView = useMemo<PageReadableV1 | null>(() => {
    if (!run || loading) return null;
    const shortLabel = (text: string) => text.slice(0, 60);
    if (page === "candidate") {
      return {
        pageId: "card_generation_review",
        title: `审核这次生成的学习卡${noteTitle ? `（《${shortLabel(noteTitle)}》）` : ""}`,
        statusLine: activeCandidate ? candidateDecisionLabel(activeCandidate) : cardGenerationStatusLabel(run.status),
        metrics: [
          { label: "候选", value: `${activeCandidateIndex + 1} / ${candidates.length}` },
          { label: "还没决定", value: `${actionableUndecidedCount} 张` },
          ...(practiceQuotaView ? [{ label: "练习件", value: shortLabel(practiceQuotaView) }] : []),
          // 这一屏刚做过那一发时，读页面的那条通道也要能说出这件事——否则伴星只知道
          // "保存了几张"，不知道"复习从哪天开始"（或不知道这次**没**要复习）。
          ...(schedulingNotice ? [{ label: "复习", value: shortLabel(schedulingNotice) }] : []),
        ],
        items: candidates.slice(0, 8).map((candidate, index) => ({
          ordinal: index + 1,
          label: shortLabel(candidate.objective.publicSummary),
          state: shortLabel(candidateDecisionLabel(candidate)).slice(0, 24),
        })),
        ...(failure ? { notice: `候选卡暂时不可用：${shortLabel(failure)}` } : {}),
      };
    }
    return {
      pageId: "card_generation_progress",
      title: isCardGenerationInFlight(run.status) ? "正在做一套学习卡" : "这一套学习卡",
      statusLine: cardGenerationStatusLabel(run.status),
      metrics: [
        ...(noteTitle ? [{ label: "笔记", value: `来自《${noteTitle}》` }] : []),
        ...(progressView?.detail ? [{ label: "进度", value: shortLabel(progressView.detail) }] : []),
        ...(run.progress ? [{ label: "已写出", value: `${run.progress.authored} 张` }, { label: "已核对", value: `${run.progress.gatePassed} 张` }] : []),
        { label: "已落地的候选", value: `${landedCandidates.length} 张` },
      ],
      items: landedCandidates.slice(0, 8).map((candidate, index) => ({
        ordinal: index + 1,
        label: shortLabel(candidate.objective.publicSummary),
        state: shortLabel(`卡型 · ${cardStrategyPresentation[candidate.strategy].label}`).slice(0, 24),
      })),
      ...(failure
        ? { notice: `无法确认这次生成：${shortLabel(failure)}` }
        : progressView
          ? {}
          : { notice: "这次生成已经停下，可以按最新已保存的笔记重新生成。" }),
    };
  }, [
    activeCandidate, activeCandidateIndex, actionableUndecidedCount, candidates, failure,
    landedCandidates, loading, noteTitle, page, practiceQuotaView, progressView, receipt, run,
    schedulingNotice,
  ]);
usePageReadableView(readableView);
}
