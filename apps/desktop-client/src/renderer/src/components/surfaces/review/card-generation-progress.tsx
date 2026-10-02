import { ArrowLeft, Check, CircleAlert, LoaderCircle, RefreshCw, Sparkles } from "lucide-react";
import { cardGenerationRecoveryReasonLabel, cardGenerationStageCount, cardGenerationStatusLabel, cardGenerationSyncReportText, isCardGenerationInFlight, isCardGenerationStopped } from "./card-generation-status";
import { formatRelative } from "../notebook/surface-data";
import { cardStrategyPresentation } from "./card-strategy-presentation";
import { CardGenerationRecoveryActions } from "./card-generation-recovery-actions";
import type { CardGenerationSession } from "./use-card-generation-session";

const progressStepStateLabels = { done: "已完成", current: "进行中", todo: "待进行" } as const;
export function CardGenerationProgress({ session }: { readonly session: CardGenerationSession }) {
 const { runId, run, noteTitle, progressView, loading, waitingForRun, failure, actionFailure, busyAction, landedCandidates, syncReport, resync, returnToNote, cancel } = session;
 const generationStage = progressView?.stage ?? 0;
 const progressStep = progressView ? Math.min(progressView.stage + 1, cardGenerationStageCount) : 0;
 const progressDone = progressView ? Math.min(progressView.stage, cardGenerationStageCount) : 0;
 const progressTodo = progressView ? Math.max(cardGenerationStageCount - progressStep, 0) : 0;
 const progressPercent = progressView?.percent ?? 0;
 const progressInFlight = Boolean(run && isCardGenerationInFlight(run.status));
 const generationStages = [["读取笔记", "核对封存下来的原文版本"], ["形成问题", "围绕主张生成可验证候选"], ["对齐证据", "核对质量门与证据绑定"], ["等待审核", "由你决定保留、丢弃或保存到卡组"]] as const;
 const recoveryActions = () => <CardGenerationRecoveryActions session={session} />;
 return (
<section className="card-press card-generation-board" aria-label="学习卡生成进度">
          <header className="card-generation-board__header">
            <div>
              <span className="tag green">{run ? cardGenerationStatusLabel(run.status) : "准备中"}</span>
              <h2>{noteTitle ? `把《${noteTitle}》整理成学习卡` : "把一篇笔记整理成可练习的问题"}</h2>
              <p>{run ? "后台正在整理，离开本页也会继续。新进展自动更新，你也可以随时刷新。" : "进度只跟着已经确认的阶段走。"}</p>
            </div>
            <button type="button" className="button card-generation-board__sync" disabled={loading} onClick={() => void resync()}>
              <RefreshCw size={14} aria-hidden="true" />{loading ? "正在刷新…" : "刷新状态"}
            </button>
          </header>

          {/* 进度头条：一眼看清「走到第几步 / 当前在做什么 / 完成了几步 / 还剩几步」。
              百分比 = (已完成阶段 + 当前阶段内的候选进度) ÷ 4，细分只来自服务端计数，
              不猜时间；说不出阶段的状态整块不显示，而不是亮一条走完的轨道。 */}
          {run && progressView ? (
            <section className="card-generation-progress" aria-label="生成进度">
              <div className="card-generation-progress__summary">
                <div className="card-generation-progress__current">
                  <span className="card-generation-progress__eyebrow">
                    {progressView.eyebrow}
                  </span>
                  <strong className="card-generation-progress__name">
                    {progressInFlight
                      ? <LoaderCircle className="run-spinner" size={17} aria-hidden="true" />
                      : <Check size={17} aria-hidden="true" />}
                    {cardGenerationStatusLabel(run.status)}
                  </strong>
                  <span className="card-generation-progress__meta">
                    {[
                      // 在途时不报步数（`run.status` 还在那个大事务里），但张数是实时
                      // 读数（0249），所以 `detail` 照旧显示——以前这里整块换成一句
                      // "中间计数要等这一批写完"，那句现在已经是假话了。
                      ...(progressView.inFlight
                        ? []
                        : [`已完成 ${progressDone} 步 · 待进行 ${progressTodo} 步`]),
                      ...(progressView.detail ? [progressView.detail] : []),
                      `最后更新 ${formatRelative(run.updatedAt)}`,
                    ].join(" · ")}
                  </span>
                </div>
                <div
                  className="card-generation-progress__gauge"
                  role="progressbar"
                  aria-label="整体进度"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={progressPercent}
                  aria-valuetext={`第 ${progressStep} 步，共 ${cardGenerationStageCount} 步：${cardGenerationStatusLabel(run.status)}${progressView.detail ? `，${progressView.detail}` : ""}`}
                >
                  <strong className="card-generation-progress__percent">{progressPercent}<i>%</i></strong>
                  <span className="card-generation-progress__percent-caption">整体进度</span>
                </div>
              </div>
              <ol className="card-generation-progress__steps" aria-label="生成步骤">
                {generationStages.map(([label, detail], index) => {
                  const state = index < generationStage ? "done" : index === generationStage ? "current" : "todo";
                  return (
                    <li
                      key={label}
                      className={`card-generation-progress__step is-${state}`}
                      aria-current={state === "current" ? "step" : undefined}
                    >
                      <span className="card-generation-progress__rail" aria-hidden="true" />
                      <span className="card-generation-progress__label">
                        {state === "done" ? <Check size={11} aria-hidden="true" /> : null}
                        {label}
                      </span>
                      {/* 这一步在做什么，以前只写在下面那排 press-stage 上。删掉那一排
                          （它与本轨道读的是同一个 `generationStages` 与同一个
                          `generationStage`，同一屏上那四个名字因此出现两遍）之后，唯一
                          说清「第 2 步到底在干嘛」的地方就是这里。
                          第 1 步额外说封存——那是 press-track 里唯一不与步骤名重复的
                          事实：还在排队时并没有封存任何东西，所以「来源版本已封存」
                          只在真的走过第 1 步之后才成立。 */}
                      <span className="card-generation-progress__detail">{index === 0
                        ? generationStage > 0
                          ? (run.sourceOutdated ? "来源版本已变化" : `${detail} · 已封存`)
                          : "正在确认要封存的来源版本"
                        : detail}</span>
                      <span className="card-generation-progress__state">{progressStepStateLabels[state]}</span>
                    </li>
                  );
                })}
              </ol>
            </section>
          ) : null}

          {/* 生成中的逐张落地（A1 · B4）：候选现在一张一个事务提交，写完的那张就能在这里
              看到——只有题面与概念名，答案与来源证据仍要走审核阶段的主动查看。
              一条都没有时整块不出现：亮一个"已写好 0 张"的空壳是拿没发生的事报数。 */}
          {progressInFlight && landedCandidates.length > 0 ? (
            <section className="card-generation-landing" aria-label="已经写好的卡">
              {/* 标题**不再重复一个张数**：进度头条那一行已经在说「已写出 N / 共 M 张」，
                  而且它与服务端候选计数同源。这里再报一个数就是同一屏两个答案——
                  列表本身就是答案，数几条看见几条。 */}
              <h3 className="card-generation-landing__title">已经写好的卡，后面的还在写</h3>
              <ol className="card-generation-landing__list">
                {landedCandidates.map((candidate) => (
                  <li key={candidate.candidateId} data-testid="card-generation-landing-item" className="card-generation-landing__item">
                    <span className="card-generation-landing__type">卡型 · {cardStrategyPresentation[candidate.strategy].label}</span>
                    <strong className="card-generation-landing__concept">{candidate.objective.publicSummary}</strong>
                    <span className="card-generation-landing__prompt">{candidate.front.prompt}</span>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          {/* 同步回执：按下刷新之后必须说清楚读到了什么。 */}
          {run && syncReport ? (
            <p className="card-generation-board__sync-report" role="status" aria-live="polite">
              {cardGenerationSyncReportText(syncReport.status, syncReport.changed)}
              <span className="card-generation-board__sync-at">· {formatRelative(syncReport.at)}</span>
            </p>
          ) : null}

          {loading || waitingForRun ? <div className="card-generation-hud-state" role="status"><LoaderCircle className="run-spinner" size={24} aria-hidden="true" /><strong>正在读取生成任务</strong><p>正在核对笔记版本和生成进度。</p></div> : null}
          {!loading && !waitingForRun && failure ? <div className="card-generation-hud-state" role="alert"><CircleAlert size={24} aria-hidden="true" /><strong>无法确认这次生成</strong><p>{failure}</p><button type="button" className="button" onClick={() => void resync()}>重新同步</button></div> : null}
          {!loading && !waitingForRun && !failure && !run ? <div className="card-generation-hud-state" role="status"><Sparkles size={24} aria-hidden="true" /><strong>还没有进行中的生成任务</strong><p>回到笔记页，从已保存的整篇笔记重新开始。</p><button type="button" className="button primary" onClick={returnToNote}><ArrowLeft size={14} aria-hidden="true" />返回笔记</button></div> : null}

          {!loading && !failure && run ? (
            <>
              {isCardGenerationStopped(run.status) ? (
                <div className="card-generation-hud-state" role="status">
                  <CircleAlert size={24} aria-hidden="true" />
                  <strong>这次生成已取消</strong>
                  <p>没有生成出候选卡，进度也不会往前走。回到笔记页可以重新开始一次。</p>
                  <div className="actions">
                    <button type="button" className="button primary" onClick={returnToNote}>
                      <ArrowLeft size={14} aria-hidden="true" />返回笔记
                    </button>
                  </div>
                </div>
              ) : !run.recovery && progressView ? null
                // 这一支过去画的是 press-track 那一排四张卡。它与上方
                // `card-generation-progress__steps` 读的是同一个 `generationStages`
                // 与同一个 `generationStage`——同一屏上那四个名字于是各出现两遍
                // （card-generation-status.ts 自己在批评「同一屏两个答案」那一族）。
                // 删掉它之后，这一屏的阶段由上方那一条轨说完，这里不必再画一份：
                // 页脚（计划版本／取消／返回笔记）照旧在下面。
                : !run.recovery ? (
                // 既说不出走到哪一步、服务端也没签发恢复动作（例如结束后未激活）：
                // 只能给状态与出口，不能点亮一条假装走完的轨道。
                <div className="card-generation-hud-state" role="status">
                  <CircleAlert size={24} aria-hidden="true" />
                  <strong>{cardGenerationStatusLabel(run.status)}</strong>
                  <p>这次生成停下来了，后台也没有给出可以恢复的下一步。回到笔记页可以重新开始一次。</p>
                  <div className="actions">
                    <button type="button" className="button primary" onClick={returnToNote}>
                      <ArrowLeft size={14} aria-hidden="true" />返回笔记
                    </button>
                  </div>
                </div>
              ) : (
                <div className="card-generation-recovery" role="status">
                  <strong>{cardGenerationRecoveryReasonLabel(run.recovery.publicReasonCode)}</strong>
                  <p>{run.recovery.retryability === "resync_required" ? "先重新读一次进度；这台电脑不会把失败的那一步再跑一遍。" : "下一步只做后台明确说可以恢复的那件事。"}</p>
                  <div className="actions">{recoveryActions()}</div>
                </div>
              )}
              {actionFailure ? <p className="small card-generation-board__failure" role="alert">这一步没成功：{actionFailure}</p> : null}
              <footer className="card-generation-board__footer">
                <span>{run.sourceOutdated ? "笔记已有新版本，本次候选不会被当作最新内容。" : `生成计划 ${run.currentPlanVersion || "—"} · 审核版本 ${run.reviewDraftRevision}`}</span>
                <div className="actions">
                  {/* A cancelled run has nothing left to cancel. */}
                  {!run.recovery && run.status !== "cancelled" && run.status !== "activated" && run.status !== "closed_without_activation" ? (
                    <button type="button" className="button" disabled={busyAction !== null} onClick={() => void cancel()}>
                      {busyAction === "cancel" ? "正在取消…" : "取消生成"}
                    </button>
                  ) : null}
                  <button type="button" className="button" onClick={returnToNote}><ArrowLeft size={14} aria-hidden="true" />返回笔记</button>
                </div>
              </footer>
            </>
          ) : null}
        </section>
 );
}
