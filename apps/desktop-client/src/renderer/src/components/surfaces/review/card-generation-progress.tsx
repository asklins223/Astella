import { ArrowLeft, CircleAlert, FileText, LoaderCircle, RefreshCw, RotateCcw, Square } from "lucide-react";
import { useRef, type CSSProperties } from "react";
import type { CardGenerationCandidateV1 } from "@astella/shared/card-generation-desktop-contracts";
import { useCardVisibleArrival } from "../../motion/card-object-spring";
import { CardPackArt } from "../library/card-pack-object";
import { useCardPackMotion } from "../library/use-card-pack-motion";
import { cardGenerationRecoveryReasonLabel, cardGenerationStatusLabel, cardGenerationSyncReportText, isCardGenerationInFlight, isCardGenerationStopped } from "./card-generation-status";
import { formatRelative } from "../notebook/surface-data";
import { cardStrategyPresentation } from "./card-strategy-presentation";
import { CandidateText } from "./candidate-text";
import { CardGenerationRecoveryActions } from "./card-generation-recovery-actions";
import type { CardGenerationSession } from "./use-card-generation-session";

function WrittenCard({ candidate, index }: { candidate: CardGenerationCandidateV1; index: number }) {
  const paperRef = useRef<HTMLLIElement>(null);
  // 同样用「一直可见」那一档：这一列的意义就是**一张张多出来**，而"刚出来的那张先
  // 透明半秒"会把用户最想看的那一条藏起来。
  useCardVisibleArrival(paperRef, candidate.candidateId);
  return <li ref={paperRef} data-testid="card-generation-landing-item" className="card-generation-landing__item">
    <header><span className="card-generation-landing__type">{cardStrategyPresentation[candidate.strategy].symbol} · {cardStrategyPresentation[candidate.strategy].label}</span><span>{String(index + 1).padStart(2, "0")}</span></header>
    <strong className="card-generation-landing__concept"><CandidateText text={candidate.objective.publicSummary} /></strong>
    <span className="card-generation-landing__prompt"><CandidateText text={candidate.front.prompt} /></span>
    <small>{candidate.qualityState === "passed" ? "依据已核对 · 等你挑选" : "题面已写出 · 正在核对依据"}</small>
  </li>;
}

function PreparingPack({ working, count }: { working: boolean; count: number }) {
  const poseRef = useRef<HTMLSpanElement>(null);
  useCardPackMotion(poseRef, working);
  return <div className="card-making__empty">
    <span className="card-making__pack" aria-hidden="true"><span className="card-pack-object__scene" ref={poseRef}><CardPackArt count={count} opened={working} /></span></span>
    <h3>{working ? "正在为这篇笔记准备卡包" : "暂时没有写出的题面"}</h3>
    <p>{working ? "写好的题面会逐张出现在这里，完成后由你挑选。" : "生成状态与下一步操作都在左侧。"}</p>
  </div>;
}

export function CardGenerationProgress({ session }: { readonly session: CardGenerationSession }) {
  const { run, noteTitle, progressCounts, progressView, loading, waitingForRun, failure, actionFailure, busyAction, landedCandidates, syncReport, resync, returnToNote, cancel, canRegenerate, regenerate } = session;
  const working = Boolean(run && isCardGenerationInFlight(run.status));
  const canCancel = Boolean(run && working && run.status !== "activating");
  const authored = progressCounts.authored;
  const planned = progressCounts.plannedCards;
  const passed = progressCounts.gatePassed;
  const locked = busyAction !== null;

  return <section className="card-making-workshop" aria-label="学习卡生成进度" data-working={working}>
    <div className="card-making__paper">
      <header className="card-making__header"><span className="card-making__eyebrow">学习卡</span><h1>{working ? "正在做一套学习卡" : "这一套学习卡"}</h1></header>
      <div className="card-making__source"><FileText size={20} aria-hidden="true" /><p className="card-making__note">{noteTitle ? `来自《${noteTitle}》` : "从一篇已保存的笔记开始"}</p></div>
      {run && progressView && working ? <section className="card-generation-progress" aria-label="生成进度" role="status">
        <h2 className="card-generation-progress__name"><LoaderCircle className="run-spinner" size={18} aria-hidden="true" />{cardGenerationStatusLabel(run.status)}</h2>
        <p className="card-generation-progress__meta">{progressView.detail ?? "正在阅读这篇笔记，找出值得反复回想的内容。"}</p>
        <dl className="card-making__counts"><div><dt>已写出</dt><dd>{authored}<small> 张</small></dd></div><div><dt>通过核对</dt><dd>{passed}<small> 张</small></dd></div>{planned > 0 ? <div><dt>计划</dt><dd>{planned}<small> 张</small></dd></div> : null}</dl>
        {planned > 0 ? <div className="card-making__meter" role="progressbar" aria-label="候选卡编写进度" aria-valuemin={0} aria-valuemax={planned} aria-valuenow={Math.min(authored, planned)} aria-valuetext={`已写出 ${authored} / ${planned} 张候选，通过核对 ${passed} 张`} style={{ "--making-progress": `${Math.min(100, authored / planned * 100)}%` } as CSSProperties}><span /></div> : null}
        <p className="card-making__reassurance">写好的题面会放到旁边。完成后，由你挑选要留下的卡。</p>
      </section> : null}
      {(loading || waitingForRun) && !run ? <div className="card-making__state" role="status"><LoaderCircle className="run-spinner" size={23} aria-hidden="true" /><h2>正在读取生成任务</h2><p>正在核对笔记版本和生成进度。</p></div> : null}
      {!loading && !waitingForRun && failure ? <div className="card-making__state" role="alert"><CircleAlert size={23} aria-hidden="true" /><h2>无法确认这次生成</h2><p>{failure}</p></div> : null}
      {!loading && !waitingForRun && !failure && !run ? <div className="card-making__state" role="status"><h2>还没有进行中的生成任务</h2><p>回到笔记页，从已保存的整篇笔记开始。</p></div> : null}
      {!loading && !failure && run && !progressView && !run.recovery ? <div className="card-making__state" role="status"><CircleAlert size={23} aria-hidden="true" /><h2>{isCardGenerationStopped(run.status) ? "这次生成已取消" : cardGenerationStatusLabel(run.status)}</h2><p>本次已经停下。可以直接按最新已保存的笔记，重新生成一套学习卡。</p></div> : null}
      {!loading && !failure && run?.recovery ? <div className="card-making__recovery" role="status"><CircleAlert size={23} aria-hidden="true" /><h2>{cardGenerationRecoveryReasonLabel(run.recovery.publicReasonCode)}</h2><p>{run.recovery.retryability === "resync_required" ? "重新检查状态，或按最新笔记重新生成。" : "可以重试本次任务，也可以按最新笔记重新生成。"}</p><div className="actions"><CardGenerationRecoveryActions session={session} showReturn={false} /></div></div> : null}
      {run?.sourceOutdated ? <p className="card-making__source-notice" role="status">笔记已有新版本。本次依据旧版；重新生成会读取最新已保存的内容。</p> : null}
      <footer className="card-making__footer">
        {canCancel ? <button type="button" className="button" disabled={locked} onClick={() => void cancel()}><Square size={14} aria-hidden="true" />{busyAction === "cancel" ? "正在停止…" : "停止生成"}</button> : canRegenerate ? <button type="button" className="button primary" disabled={locked || loading} onClick={() => void regenerate()}><RotateCcw size={16} aria-hidden="true" />{busyAction === "regenerate" ? "正在重新生成…" : "重新生成学习卡"}</button> : null}
        <button type="button" className="text-action" onClick={returnToNote}><ArrowLeft size={14} aria-hidden="true" />返回笔记</button>
      </footer>
      <p className="card-making__background-note">{working ? "可以先去做别的，离开这里不会中断生成。" : "重新生成会另开一份，已经保存的卡仍在卡组里。"}</p>
      <div className="card-making__sync-row"><span>{run ? `最后更新 ${formatRelative(run.updatedAt)}` : "核对本次任务"}</span><button type="button" className="text-action card-making__sync" disabled={loading || locked} onClick={() => void resync()}><RefreshCw size={13} aria-hidden="true" />{loading ? "正在刷新…" : "刷新状态"}</button></div>
      {run && syncReport ? <p className="card-generation-board__sync-report" role="status" aria-live="polite">{cardGenerationSyncReportText(syncReport.status, syncReport.changed)}</p> : null}
      {actionFailure ? <p className="card-making__failure" role="alert">这一步没成功：{actionFailure}</p> : null}
    </div>
    <section className="card-generation-landing" aria-label="已经写好的卡"><header><h2>写好的题面</h2><span>{landedCandidates.length ? `${landedCandidates.length} 张候选` : "完成后开始挑选"}</span></header>
      {landedCandidates.length ? <ol className="card-generation-landing__list">{landedCandidates.map((candidate, index) => <WrittenCard key={candidate.candidateId} candidate={candidate} index={index} />)}</ol> : <PreparingPack working={working} count={authored} />}
    </section>
  </section>;
}
