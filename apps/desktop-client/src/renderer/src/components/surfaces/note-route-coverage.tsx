/**
 * 核心路线册页（39d W4-5 ③；PRD §4.4）。
 *
 * ## 它是书房里的什么
 *
 * 一张**翻开的册页**：左边是这一篇纳入过的核心问题（每一条一枚纸签），右边是
 * 册页头上那一句结论。**不是**一张表、不是一个进度条、不是一个百分比环——
 * §4.1 明写目录不可靠时不给出全篇覆盖百分比，而一个环恰好会让人把
 * "我们还没敢承诺"读成"已经走了八成"。
 *
 * **每条问题只印状态，不印结论**：哪一轮练的、哪一发作答的都在
 * `question.roundIds` / `question.attempts` 里，屏上给的是「点开看」而不是
 * 一屏表格（§10.3 详情页那一层已经能读到它们）。
 *
 * ## 三条不许越界的
 *
 *  1. **不重算**：结论与计数都由服务端给（`verdict` / `summary`），界面只呈现。
 *     同一个问题在屏上被算成第二个分母，正是这批代码一直在拆的形状。
 *  2. **不静默**：读不到就说明"没读到"，不画一册空页——空册页会被读成
 *     "这一篇还没有核心问题"，而那是两件事（§13.4）。
 *  3. **缩小时说清**：`route_complete_within_adjusted_scope` 那一档要把理由
 *     念出来（§4.4 末句），不能只换一个词。
 */
import { useMemo } from "react";
import { BookOpen, CircleAlert, Leaf } from "lucide-react";
import type { NoteRouteCoverageV1 } from "@ailearn/shared/note-route-coverage-v2";
import { ROUTE_QUESTION_STATE_COPY_V1, routeVerdictCopyV1 } from "./route-coverage-copy";

export type RouteCoverageProps = {
  /** `null` = 这一发没读到（**不是**"没有路线"）。 */
  coverage: NoteRouteCoverageV1 | null;
  /** 读失败时的那一句真因（§13.4：失败要说得清是什么失败）。 */
  failure: string | null;
  /** 伴星那一格仍在同屏摆着，这一句进可读视图（doc 37）。 */
  onInspectRound?: (roundId: string) => void;
};

export function NoteRouteCoverage({ coverage, failure, onInspectRound }: RouteCoverageProps) {
  const uncoveredByState = useMemo(() => {
    const counts: Partial<Record<keyof typeof ROUTE_QUESTION_STATE_COPY_V1, number>> = {};
    for (const entry of coverage?.verdict.uncovered ?? []) {
      counts[entry.state] = (counts[entry.state] ?? 0) + 1;
    }
    return counts;
  }, [coverage]);

  if (failure !== null) {
    // 读失败**如实说一句**，不画空册页：空册页读起来像"这一篇没有核心问题"。
    return (
      <section className="notebook-route" data-route-state="failed" aria-label="这一篇的核心路线">
        <h4 className="notebook-route__title">核心路线</h4>
        <p className="small notebook-route__failure" role="status">
          <CircleAlert size={14} aria-hidden="true" />
          <span>核心路线没读到：{failure}下面那份记录仍然可用。</span>
        </p>
      </section>
    );
  }
  if (coverage === null) return null;

  const verdict = routeVerdictCopyV1({
    kind: coverage.verdict.kind,
    totalCount: coverage.summary.totalCount,
    coveredCount: coverage.summary.coveredCount,
    assistedCount: coverage.summary.assistedCount,
    scopeAdjustmentReason: coverage.verdict.scopeAdjustmentReason,
    uncoveredByState,
  });

  return (
    <section
      className="notebook-route"
      data-route-state={coverage.verdict.kind}
      aria-label="这一篇的核心路线"
    >
      <div className="notebook-route__head">
        <h4 className="notebook-route__title">
          <BookOpen size={16} aria-hidden="true" />
          核心路线
        </h4>
        <p className="notebook-route__verdict">{verdict}</p>
        {coverage.verdict.kind === "route_complete_within_adjusted_scope" ? (
          <p className="small notebook-route__scope" data-route-scope-note="true">
            <Leaf size={13} aria-hidden="true" />
            <span>范围变过，所以这句话只对调整之后的范围成立。</span>
          </p>
        ) : null}
      </div>
      {coverage.questions.length === 0 ? null : (
        <ol className="notebook-route__list">
          {coverage.questions.map((question) => {
            const state = ROUTE_QUESTION_STATE_COPY_V1[question.state];
            return (
              <li key={question.questionId} className="notebook-route__item" data-route-state={question.state}>
                <span className={`tag notebook-route__stamp${state.tone === "plain" ? "" : ` tag--${state.tone}`}`}>
                  {state.label}
                </span>
                <span className="notebook-route__label">{question.label}</span>
                {question.conflictReason ? (
                  <span className="small notebook-route__reason">{question.conflictReason}</span>
                ) : null}
                {onInspectRound && question.roundIds.length > 0 ? (
                  <button
                    type="button"
                    className="text-action"
                    onClick={() => onInspectRound(question.roundIds[0]!)}
                  >
                    去看走过的那一轮
                  </button>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
