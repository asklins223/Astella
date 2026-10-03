import { useMemo } from "react";
import { ArrowRight, BookOpenText, Play } from "lucide-react";
import type { UnderstandingEdgeProjectionV3, UnderstandingNodeProjectionV3 } from "@ailearn/shared/note-deepening-contracts";
import type { NoteApplicabilityAxisV3, NoteDeepeningV3, NoteNextStepAxisV3, NotePerformanceAxisV3 } from "@ailearn/shared/note-deepening-v3-contracts";
import { graphNodeLabel, graphNodeSummary, graphObjectiveStateLabel, isNoteNode, isObjectiveNode } from "./graph-sky";

type ObjectiveNode = Extract<UnderstandingNodeProjectionV3, { nodeRef: { kind: "objective" } }>;

const PERFORMANCE_AXIS_LABEL: Readonly<Record<NotePerformanceAxisV3, string>> = {
  no_record_yet: "还没有学习记录",
  met_once: "见过一次，还没有留下可复述的记录",
  assisted_once: "借助提示完成的",
  used_independently: "有一次是独立说出来的",
  repeated_over_time: "隔了不同日子，重复用上过",
};

const NEXT_STEP_AXIS_LABEL: Readonly<Record<NoteNextStepAxisV3, string>> = {
  nothing_to_do: "现在没有下一步",
  can_continue: "可以接着往下走",
  suggest_relearn: "建议补学",
  due_for_review: "适合回访",
  paused_by_user: "你把这一段停下了",
};

const APPLICABILITY_AXIS_LABEL: Readonly<Record<NoteApplicabilityAxisV3, string>> = {
  basis_holds: "依据还适用",
  basis_updated: "材料有更新，要对一眼",
  needs_check: "待核对",
  no_permission: "现在读不到材料",
};

/** §11.2 笔记局部那一行的三个动作，各叫什么。 */
const RELATION_REASON_LABEL: Readonly<Record<string, string>> = {
  prerequisite: "理解这条之前需要",
  explains: "用这一条来解释",
  contrasts: "可以和这一条对比",
  relates_to: "系统认为有关",
};

const RELATION_STATUS_LABEL: Readonly<Record<"confirmed" | "dismissed" | "suggested", string>> = {
  confirmed: "你确认过",
  suggested: "待确认建议",
  dismissed: "你收起了",
};

function NoteStateAxes({ deepening }: { readonly deepening: NoteDeepeningV3 }) {
  return (
    <div className="universe-axes" role="group" aria-label="三种状态（分开看，不合成一个）">
      <dl className="universe-axes__row">
        <div className="universe-axes__slip">
          <dt>学习表现</dt>
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
 * 层一：笔记总览（§11.2 第一行「笔记、最近学习位置、未完旅程和当前回访建议」）。
 *
 * **由拓扑投影出来，不额外发一次读**——这一层要的东西（未完的一轮、回访日期、
 * 继续学习）拓扑里逐字都有，另起一份读就是第二个出处。
 */
export function NoteOverviewLayer({
  noteId,
  projections,
  edges,
  onContinue,
  onOpenNote,
  onSelectObjective,
}: {
  readonly noteId: string;
  readonly projections: readonly UnderstandingNodeProjectionV3[];
  readonly edges: readonly UnderstandingEdgeProjectionV3[];
  readonly onContinue: () => void;
  readonly onOpenNote: () => void;
  readonly onSelectObjective: (objectiveId: string) => void;
}) {
  const note = projections.find((node) => isNoteNode(node) && node.nodeRef.noteId === noteId);
  const objectives = useMemo(() => {
    const keys = new Set(
      edges
        .filter((edge) => edge.kind === "sourced_from" && edge.from.kind === "note" && edge.from.id === noteId)
        .map((edge) => `${edge.to.kind}:${edge.to.id}`),
    );
    return projections.filter(
      (node): node is ObjectiveNode =>
        isObjectiveNode(node) && keys.has(`objective:${node.nodeRef.objectiveId}`),
    );
  }, [edges, noteId, projections]);
  const openRun = objectives.find((objective) => objective.personal.activeRunId !== null) ?? null;
  const due = objectives.find((objective) => objective.personal.state === "due_review") ?? null;

  return (
    <>
      <section>
        <h2 className="universe-detail-title">{note ? graphNodeLabel(note) : "这一篇笔记"}</h2>
        <p className="universe-detail-description">
          {note ? graphNodeSummary(note) : ""}
        </p>
      </section>
      <dl className="universe-detail-timing">
        <div><dt>已形成的目标</dt><dd>{objectives.length} 个</dd></div>
        <div><dt>未完的一轮</dt><dd>{openRun ? "有一轮" : "没有"}</dd></div>
        <div><dt>该回访的</dt><dd>{due ? graphObjectiveStateLabel(due.personal.state) : "暂时没有"}</dd></div>
      </dl>
      <section className="universe-locals">
        <div className="universe-detail-section-title">
          <span>从这一篇继续</span>
          <small>正文和这一轮学习在同一篇里</small>
        </div>
        <button type="button" className="universe-locals__act" onClick={openRun ? onContinue : onOpenNote}>
          {openRun ? <Play size={14} /> : <BookOpenText size={14} />}
          <span><strong>{openRun ? "回笔记继续学习" : "打开这一篇笔记"}</strong><small>正文、材料与本轮学习都在那儿</small></span>
          <ArrowRight size={14} />
        </button>
        {objectives.length > 0 ? <ul className="universe-overview-stars">
          {objectives.map(objective => <li key={objective.nodeRef.objectiveId}>
            <button type="button" onClick={() => onSelectObjective(objective.nodeRef.objectiveId)}>
              <span className="universe-small-star" aria-hidden="true">✦</span>
              <span><strong>{graphNodeLabel(objective)}</strong><small>{graphObjectiveStateLabel(objective.personal.state)}</small></span>
              <ArrowRight size={14} />
            </button>
          </li>)}
        </ul> : null}
        {objectives.length === 0 ? (
          // §11.2「有正文的笔记无需制卡即可出现」：没有目标时**说清楚**是"还没有
          // 形成目标"，而不是画一句"知识宇宙正在生成"。
          <p className="universe-layer-empty">这一篇还没有形成任何目标——正文在就行，不需要先制卡。</p>
        ) : null}
      </section>
    </>
  );
}

/**
 * 层二：笔记局部（§11.2 第二行「核心问题／已形成的目标／必要前置和明确关系／
 * 当前缺口」；动作：查看关系理由、打开某个学习位置、查看相关记录）。
 */
export function NoteLocalLayer({
  deepening,
  onOpenLearningPosition,
  onOpenCard,
}: {
  readonly deepening: NoteDeepeningV3;
  readonly onOpenLearningPosition: () => void;
  readonly onOpenCard: (objectiveId: string) => void;
}) {
  const { local } = deepening;
  return (
    <>
      <NoteStateAxes deepening={deepening} />
      {local.openDrivingQuestion ? (
        <section className="universe-locals">
          <div className="universe-detail-section-title"><span>这一轮的问题</span><small>未完的那一轮</small></div>
          <p className="universe-question">{local.openDrivingQuestion}</p>
        </section>
      ) : null}
      <section className="universe-locals">
        <div className="universe-detail-section-title">
          <span>核心问题与已形成的目标</span>
          <small>{local.coreQuestions.length} 个</small>
        </div>
        {local.objectives.length === 0 ? (
          <p className="universe-layer-empty">还没有形成任何目标，这里不替你编一条。</p>
        ) : (
          <ul className="universe-locals__list">
            {local.objectives.map((objective) => (
              <li key={objective.objectiveId} className="universe-locals__item">
                <button type="button" onClick={onOpenLearningPosition}>
                  <strong>{objective.label}</strong>
                  <small>{objective.summary}</small>
                </button>
                <span className="universe-locals__tags">
                  <em>{graphObjectiveStateLabel(objective.state)}</em>
                  {objective.runId ? <em className="universe-locals__tag--run">有一轮没走完</em> : null}
                  {objective.cardId ? (
                    <button type="button" className="universe-locals__card" onClick={() => onOpenCard(objective.objectiveId)}>
                      打开对应卡片
                    </button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="universe-locals">
        {/* §11.3 + §11.2「查看关系理由」：理由与关系在同一行。拆成两张表，
            屏上就得自己拼，而拼不上的那一行会变成一条没有理由的实线。 */}
        <div className="universe-detail-section-title">
          <span>必要前置与明确关系</span>
          <small>{local.relations.length ? "每条都写清为什么被推出来" : "这一篇还没有可核对的关系"}</small>
        </div>
        {local.relations.length === 0 ? (
          <p className="universe-layer-empty">没有可核对的关系。这里不替你推断——没有学习记录时不伪造关系。</p>
        ) : (
          <ul className="universe-locals__list">
            {local.relations.map((relation) => (
              <li key={relation.edgeId} className="universe-locals__item universe-locals__item--relation">
                <div>
                  <strong>{relation.otherLabel}</strong>
                  <small>{RELATION_REASON_LABEL[relation.relation] ?? relation.relation}</small>
                </div>
                <span className="universe-locals__tags">
                  <em className={`is-${relation.status}`}>{RELATION_STATUS_LABEL[relation.status]}</em>
                  {relation.reasonCodes.length ? (
                    <small className="universe-relation-reason">
                      理由：{relation.reasonCodes.map((code) => RELATION_REASON_LABEL[code] ?? code).join("、")}
                    </small>
                  ) : (
                    <small className="universe-relation-reason">系统没有给出理由。</small>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="universe-locals">
        <div className="universe-detail-section-title">
          <span>当前缺口</span>
          <small>{local.gaps.length ? "哪一个目标卡在哪一档" : "暂时没有缺口"}</small>
        </div>
        {local.gaps.length === 0 ? (
          <p className="universe-layer-empty">没有列出来的缺口。</p>
        ) : (
          // §11.4「没有单一'整篇掌握亮度'」在层二的具体形状：列出来的是
          // **哪一个**目标卡在哪一档，不是一句整体百分比。
          <ul className="universe-locals__list">
            {local.gaps.map((gap) => (
              <li key={gap.objectiveId} className="universe-locals__item is-gap">
                <button type="button" onClick={onOpenLearningPosition}>
                  <strong>{gap.label}</strong>
                  <small>建议补学</small>
                </button>
                <span className="universe-locals__tags"><em className="is-gap">{graphObjectiveStateLabel(gap.state)}</em></span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/**
 * 层三：证据详情（§11.2 第三行「真实回答／反馈／日期／材料依据／可选卡片」；
 * 动作：回看、进入笔记旅程、打开相应卡片）。
 */
export function NoteRecordLayer({
  deepening,
  onOpenNote,
  onOpenCard,
}: {
  readonly deepening: NoteDeepeningV3;
  readonly onOpenNote: () => void;
  readonly onOpenCard: (objectiveId: string) => void;
}) {
  return (
    <>
      <NoteStateAxes deepening={deepening} />
      <section className="universe-locals">
        <div className="universe-detail-section-title">
          <span>真实学习记录</span>
          <small>
            {deepening.recordsComplete
              ? `${deepening.records.length} 条，全部在这里`
              : `只列到这里 ${deepening.records.length} 条，更早的还在服务器上`}
          </small>
        </div>
        {deepening.records.length === 0 ? (
          <p className="universe-layer-empty">这一篇还没有学习记录。这里不替你造一条示例。</p>
        ) : (
          <ol className="universe-records">
            {deepening.records.map((record) => (
              <li key={record.recordId} className="universe-record">
                <header>
                  <time dateTime={record.occurredAt}>{formatDeepeningDate(record.occurredAt)}</time>
                  <span>{record.objectiveLabel ?? "这一步没有挂到具体目标上"}</span>
                </header>
                {/* 「原回答」。结构化作答那一格是空的——屏上就写清楚"这一步不是一句
                    可复述的回答"，不替她造一句。 */}
                {record.answerText ? (
                  <blockquote className="universe-record__answer">{record.answerText}</blockquote>
                ) : (
                  <p className="universe-record__answer is-empty">
                    {record.answerForm === "structured" ? "这一步是结构化作答，没有一句可念的回答。" : "这一次没有留下可念的回答。"}
                  </p>
                )}
                {record.feedback.length ? (
                  <ul className="universe-record__feedback">
                    {record.feedback.map((item, index) => (
                      <li key={`${record.recordId}-fb-${index}`}>
                        <em>{FEEDBACK_VERDICT_LABEL[item.verdict]}</em>
                        <span>{item.reason}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="universe-record__answer is-empty">这一次没有留下可展示的反馈。</p>
                )}
                {record.materialBasis.length ? (
                  <div className="universe-record__material">
                    <span>材料依据</span>
                    {record.materialBasis.map((material) => (
                      <small key={material.evidenceSnapshotId}>{material.supportSummary}</small>
                    ))}
                  </div>
                ) : (
                  <div className="universe-record__material">
                    <span>材料依据</span>
                    <small>这一条没有挂材料。</small>
                  </div>
                )}
                <footer>
                  {/* 「可选卡片」——§11.2 末段：卡片是目标详情里的一条记忆工具
                      链接，不为同一目标再画一颗星。 */}
                  {record.cardId && record.objectiveId ? (
                    <button type="button" onClick={() => onOpenCard(record.objectiveId!)}>打开对应卡片</button>
                  ) : null}
                  <button type="button" onClick={onOpenNote}>进入笔记旅程</button>
                </footer>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}

const FEEDBACK_VERDICT_LABEL: Readonly<Record<NoteDeepeningV3["records"][number]["feedback"][number]["verdict"], string>> = {
  covered: "讲到了",
  partial: "讲了一半",
  missing: "没讲到",
  contradicted: "与材料相反",
  not_assessable: "判不了",
};

/** 「日期」按本地日历念；解析不了就**原样交出**那一串 ISO，不显示 Invalid Date。 */
function formatDeepeningDate(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}
