import { useMemo, useState } from "react";
import { ArrowRight, BookOpenText, Play } from "lucide-react";
import { RELATION_ROW_LIMIT } from "./graph-surface-types";
import type { UnderstandingEdgeProjectionV3, UnderstandingNodeProjectionV3 } from "@astella/shared/note-deepening-contracts";
import type { NoteApplicabilityAxisV3, NoteDeepeningV3, NoteNextStepAxisV3, NotePerformanceAxisV3, NoteLearningQuestionTypeV1 } from "@astella/shared/note-deepening-v3-contracts";
import { graphNodeLabel, graphNodeSummary, isNoteNode } from "./graph-sky";

const PERFORMANCE_AXIS_LABEL: Readonly<Record<NotePerformanceAxisV3, string>> = {
  no_record_yet: "还没有练过这张卡",
  met_once: "答过，还有提升空间",
  assisted_once: "答过，分数偏低",
  used_independently: "答得不错",
  repeated_over_time: "隔了不同日子都答得不错",
};

const NEXT_STEP_AXIS_LABEL: Readonly<Record<NoteNextStepAxisV3, string>> = {
  nothing_to_do: "还没有出题",
  can_continue: "可以再做一遍",
};

const APPLICABILITY_AXIS_LABEL: Readonly<Record<NoteApplicabilityAxisV3, string>> = {
  basis_holds: "跟当前正文一致",
  basis_updated: "正文改过，题目可能要对一眼",
};

const QUESTION_TYPE_LABEL: Readonly<Record<NoteLearningQuestionTypeV1, string>> = {
  single_choice: "单选",
  multi_choice: "多选",
  true_false: "判断",
  fill_blank: "填空",
  short_answer: "简答",
  ordering: "排序",
  matching: "配对",
  operation: "操作",
};

function NoteStateAxes({ deepening }: { readonly deepening: NoteDeepeningV3 }) {
  return (
    <div className="universe-axes" role="group" aria-label="三种状态（分开看，不合成一个）">
      <dl className="universe-axes__row">
        <div className="universe-axes__slip">
          <dt>练习情况</dt>
          <dd>{PERFORMANCE_AXIS_LABEL[deepening.axes.performance]}</dd>
        </div>
        <div className="universe-axes__slip">
          <dt>下一步</dt>
          <dd>{NEXT_STEP_AXIS_LABEL[deepening.axes.nextStep]}</dd>
        </div>
        <div className="universe-axes__slip">
          <dt>内容适用性</dt>
          <dd>{APPLICABILITY_AXIS_LABEL[deepening.axes.applicability]}</dd>
        </div>
      </dl>
    </div>
  );
}

/**
 * 层一：笔记总览。只读拓扑投影，不额外发一次读——这一层要的东西（有没有
 * 学习卡、练到几星、引用了谁）拓扑里都有。
 */
export function NoteOverviewLayer({
  noteId,
  projections,
  edges,
  onContinue,
  onOpenNote,
  onSelectQuestion,
  onSelectNote,
}: {
  readonly noteId: string;
  readonly projections: readonly UnderstandingNodeProjectionV3[];
  readonly edges: readonly UnderstandingEdgeProjectionV3[];
  readonly onContinue: () => void;
  readonly onOpenNote: () => void;
  readonly onSelectQuestion: (questionId: string) => void;
  readonly onSelectNote: (noteId: string) => void;
}) {
  const note = projections.find((node) => isNoteNode(node) && node.nodeRef.noteId === noteId);
  const [expandedFor, setExpandedFor] = useState<string | null>(null);
  const questions = useMemo(() => {
    const ids = new Set(
      edges
        .filter((edge) => edge.kind === "contains_question" && edge.from.kind === "note" && edge.from.id === noteId)
        .map((edge) => edge.to.id),
    );
    return projections.filter(
      (node): node is Extract<UnderstandingNodeProjectionV3, { nodeRef: { kind: "card_question" } }> =>
        node.nodeRef.kind === "card_question" && ids.has(node.nodeRef.questionId),
    );
  }, [edges, noteId, projections]);
  const bestStars = questions.reduce<number | null>((best, node) => {
    if (!("bestStars" in node) || node.bestStars === null) return best;
    return best === null || node.bestStars > best ? node.bestStars : best;
  }, null);

  /**
   * 正文引用分两个方向列。折叠**按方向各切一刀**：被很多篇引用、自己只引了两篇
   * 的那种笔记，整串切会把「引用了」那一半整个挤掉。
   */
  const referenceGroups = useMemo(() => {
    const rows: { edgeId: string; noteId: string; label: string; outbound: boolean }[] = [];
    for (const edge of edges) {
      if (edge.kind !== "references") continue;
      const outbound = edge.from.kind === "note" && edge.from.id === noteId;
      if (!outbound && !(edge.to.kind === "note" && edge.to.id === noteId)) continue;
      const other = outbound ? edge.to : edge.from;
      const node = projections.find(
        (candidate) => isNoteNode(candidate) && candidate.nodeRef.noteId === other.id,
      );
      if (!node || other.kind !== "note") continue;
      rows.push({ edgeId: edge.edgeId, noteId: other.id, label: graphNodeLabel(node), outbound });
    }
    const byLabel = (left: typeof rows[number], right: typeof rows[number]) =>
      left.label.localeCompare(right.label, "zh-CN");
    return {
      outbound: rows.filter(row => row.outbound).sort(byLabel),
      inbound: rows.filter(row => !row.outbound).sort(byLabel),
    };
  }, [edges, noteId, projections]);
  const opened = expandedFor === noteId;
  const collapsible = referenceGroups.outbound.length > RELATION_ROW_LIMIT
    || referenceGroups.inbound.length > RELATION_ROW_LIMIT;
  const shownReferences = opened ? referenceGroups : {
    outbound: referenceGroups.outbound.slice(0, RELATION_ROW_LIMIT),
    inbound: referenceGroups.inbound.slice(0, RELATION_ROW_LIMIT),
  };
  const hiddenReferences = referenceGroups.outbound.length + referenceGroups.inbound.length
    - shownReferences.outbound.length - shownReferences.inbound.length;

  return (
    <>
      <section>
        <h2 className="universe-detail-title">{note ? graphNodeLabel(note) : "这一篇笔记"}</h2>
        <p className="universe-detail-description">
          {note ? graphNodeSummary(note) : ""}
        </p>
      </section>
      <dl className="universe-detail-timing">
        <div><dt>题目</dt><dd>{questions.length} 道</dd></div>
        <div><dt>练过最好</dt><dd>{bestStars === null ? "还没练" : `${bestStars} 星`}</dd></div>
        <div><dt>笔记</dt><dd>{note ? "有正文" : "读不到"}</dd></div>
      </dl>
      <section className="universe-locals">
        <div className="universe-detail-section-title">
          <span>从这一篇继续</span>
          <small>正文和配套练习在同一篇里</small>
        </div>
        <button type="button" className="universe-locals__act" onClick={questions.length > 0 ? onContinue : onOpenNote}>
          {questions.length > 0 ? <Play size={14} /> : <BookOpenText size={14} />}
          <span><strong>{questions.length > 0 ? "回笔记做这张卡" : "打开这一篇笔记"}</strong><small>正文、材料与配套练习都在那儿</small></span>
          <ArrowRight size={14} />
        </button>
        {questions.length > 0 ? <ul className="universe-overview-stars">
          {questions.map(question => <li key={question.nodeRef.questionId}>
            <button type="button" onClick={() => onSelectQuestion(question.nodeRef.questionId)}>
              <span className="universe-small-star" aria-hidden="true">✦</span>
              <span><strong>{graphNodeLabel(question)}</strong><small>{graphNodeSummary(question)}</small></span>
              <ArrowRight size={14} />
            </button>
          </li>)}
        </ul> : null}
        {questions.length === 0 ? (
          <p className="universe-layer-empty">这一篇还没有配套练习——在笔记里生成学习卡之后，题目会出现在这里。</p>
        ) : null}
      </section>
      {referenceGroups.outbound.length + referenceGroups.inbound.length > 0 ? (
        <section className="universe-references">
          <div className="universe-detail-section-title"><span>正文里的引用</span></div>
          <ul>
            {[...shownReferences.outbound, ...shownReferences.inbound].map(row => (
              <li key={row.edgeId}>
                <button type="button" onClick={() => onSelectNote(row.noteId)}>
                  <em>{row.outbound ? "引用了" : "被引用"}</em>
                  <strong>{row.label}</strong>
                </button>
              </li>
            ))}
          </ul>
          {collapsible ? (
            <button type="button" className="universe-references__more" onClick={() => setExpandedFor(opened ? null : noteId)}>
              {opened ? "收起" : `还有 ${hiddenReferences} 篇没列出`}
            </button>
          ) : null}
        </section>
      ) : null}
    </>
  );
}

/** 层二：这一篇的卡与题目。 */
export function NoteLocalLayer({
  deepening,
  onOpenNote,
}: {
  readonly deepening: NoteDeepeningV3;
  readonly onOpenNote: () => void;
}) {
  const card = deepening.card;
  return (
    <>
      <NoteStateAxes deepening={deepening} />
      <section className="universe-locals">
        <div className="universe-detail-section-title">
          <span>配套练习</span>
          <small>{card ? `${card.questions.length} 道题` : "还没有出题"}</small>
        </div>
        {!card ? (
          <p className="universe-layer-empty">这一篇还没有学习卡。需要练的时候在笔记里生成一张。</p>
        ) : (
          <>
            <dl className="universe-detail-timing">
              <div><dt>最好成绩</dt><dd>{card.bestScore === null ? "还没做完一次" : `${card.bestScore} 分`}</dd></div>
              <div><dt>星级</dt><dd>{card.bestStars === null ? "还没有星" : `${card.bestStars} 星`}</dd></div>
              <div><dt>做过</dt><dd>{card.attemptCount} 次</dd></div>
            </dl>
            <ul className="universe-locals__list">
              {card.questions.map((question) => (
                <li key={question.questionId} className="universe-locals__item">
                  <div>
                    <strong>{question.stem}</strong>
                    <small>{QUESTION_TYPE_LABEL[question.questionType]}</small>
                  </div>
                  <span className="universe-locals__tags">
                    <em>{question.bestStars === null ? "没练过" : `最好 ${question.bestStars} 星`}</em>
                  </span>
                </li>
              ))}
            </ul>
            <button type="button" className="universe-locals__act" onClick={onOpenNote}>
              <Play size={14} />
              <span><strong>去做这张卡</strong><small>答完由伴星批改，整卷给星级</small></span>
              <ArrowRight size={14} />
            </button>
          </>
        )}
      </section>
    </>
  );
}

/** 层三：这张卡的历次作答。 */
export function NoteRecordLayer({
  deepening,
  onOpenNote,
}: {
  readonly deepening: NoteDeepeningV3;
  readonly onOpenNote: () => void;
}) {
  return (
    <>
      <NoteStateAxes deepening={deepening} />
      <section className="universe-locals">
        <div className="universe-detail-section-title">
          <span>练习记录</span>
          <small>
            {deepening.attemptsComplete
              ? `${deepening.attempts.length} 次，全部在这里`
              : `只列到今天 ${deepening.attempts.length} 次，更早的还在服务器上`}
          </small>
        </div>
        {deepening.attempts.length === 0 ? (
          <p className="universe-layer-empty">这一篇还没有练习记录。这里不替你造一条示例。</p>
        ) : (
          <ol className="universe-records">
            {deepening.attempts.map((attempt) => (
              <li key={attempt.attemptId} className="universe-record">
                <header>
                  <time dateTime={attempt.completedAt ?? undefined}>{attempt.completedAt ? formatDeepeningDate(attempt.completedAt) : "还没做完"}</time>
                  <span>{attemptStatusLabel(attempt.status)}</span>
                </header>
                <p className="universe-record__answer">
                  {attempt.score === null ? "还没有分数。" : `${attempt.score} 分`}
                  {attempt.stars === null ? "" : ` · ${attempt.stars} 星`}
                </p>
                <footer>
                  <button type="button" onClick={onOpenNote}>回到这张卡</button>
                </footer>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}

function attemptStatusLabel(status: NoteDeepeningV3["attempts"][number]["status"]): string {
  switch (status) {
    case "completed": return "已批改";
    case "grading": return "伴星正在批改";
    case "grading_failed": return "这次没批成";
    case "abandoned": return "中途放弃了";
    default: return "还没做完";
  }
}

/** 「日期」按本地日历念；解析不了就**原样交出**那一串 ISO，不显示 Invalid Date。 */
function formatDeepeningDate(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}
