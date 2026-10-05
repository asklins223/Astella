import { useState, type Ref } from "react";
import { BookOpen, Compass, FileText, Layers, LoaderCircle, MousePointerClick, Route, Settings2, Sparkles, TriangleAlert } from "lucide-react";
import type { ActivityTargetV1 } from "@ailearn/shared/activity-surface-contracts";
import type { NoteLearningRoundPersonalHistoryItemV1 } from "@ailearn/shared/note-learning-round-contracts";
import type { RoomIntent } from "../../../app/room-machine";
import { ROUND_RECORD_COPY_V1, roundHistoryStateLabelV1, roundRecordDayV1, roundRecordModesLabelV1 } from "../notebook/round-record-copy.ts";
import type { AllSpacesSummary } from "../library/all-spaces-summary.ts";
import { anomalyStep, type TodayAnomalyGroup, type TodayLogRow, type TodayVerdict } from "../library/today-log.ts";

const KIND_ICONS: Readonly<Record<TodayLogRow["kind"], typeof FileText>> = {
  note: FileText,
  source: BookOpen,
  objective: Compass,
  learning_run: Route,
  card_generation: Layers,
  job: Settings2,
  page: MousePointerClick,
};

const TRIAGE_PREVIEW = 2;

const START_ACTIONS: readonly { readonly label: string; readonly intent: RoomIntent }[] = [
  { label: "写笔记", intent: "open-notebook" },
  { label: "收录来源", intent: "open-sources" },
  { label: "学习卡", intent: "open-objectives" },
];

function EntryJump({
  target,
  label,
  action,
  onOpen,
}: {
  readonly target: ActivityTargetV1 | null;
  readonly label: string;
  readonly action: string;
  readonly onOpen: (target: ActivityTargetV1) => void;
}) {
  if (!target) return null;
  return (
    <button type="button" className="button day-jump" onClick={() => onOpen(target)} aria-label={`${action} ${label}`}>
      {action}
    </button>
  );
}

export function DayVerdict({
  verdict,
  triageCount,
  onTriage,
}: {
  readonly verdict: TodayVerdict;
  readonly triageCount: number;
  readonly onTriage: () => void;
}) {
  return (
    <div className="day-verdict" data-pending={verdict.pending > 0 || undefined}>
      {verdict.metrics.length > 0 ? (
        <dl className="day-verdict__metrics">
          {verdict.metrics.map((metric) => (
            <div className="day-verdict__metric" key={metric.key} data-metric={metric.key} data-alarm={metric.alarm || undefined}>
              <dt>{metric.label}</dt>
              <dd>{metric.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      <div className="day-verdict__copy">
        <b>{verdict.headline}</b>
        <span>{verdict.detail}</span>
      </div>

      {verdict.pending > 0 ? (
        <button type="button" className="button primary day-verdict__act" onClick={onTriage}>
          <TriangleAlert size={13} strokeWidth={2.2} aria-hidden="true" />
          查看 {triageCount} 个处理项
        </button>
      ) : null}
    </div>
  );
}

export function AnomalyTriage({
  groups,
  backgroundGroups,
  total,
  sharedStep,
  note,
  onOpen,
  onRecover,
  anchorRef,
}: {
  readonly groups: readonly TodayAnomalyGroup[];
  readonly backgroundGroups: readonly TodayAnomalyGroup[];
  readonly total: number;
  readonly sharedStep: string | null;
  readonly note: string | null;
  readonly onOpen: (target: ActivityTargetV1) => void;
  readonly onRecover: (recovery: TodayAnomalyGroup["recovery"]) => void;
  readonly anchorRef: Ref<HTMLElement>;
}) {
  const [expanded, setExpanded] = useState(false);
  const overflow = groups.length - TRIAGE_PREVIEW;
  const collapsed = overflow > 0 && !expanded;
  const visible = collapsed ? groups.slice(0, TRIAGE_PREVIEW) : groups;

  return (
    <section className="day-triage" aria-labelledby="today-triage-title" ref={anchorRef} tabIndex={-1}>
      <h2 className="day-section-head" id="today-triage-title">
        <b>待处理</b>
        <span>
          {groups.length > 0
            ? `${groups.length} 项${groups.length < total ? ` · 共 ${total} 条记录` : ""}`
            : "0 项 · 没有需要你处理的事"}
        </span>
      </h2>

      {sharedStep ? <p className="day-triage__step">{sharedStep}</p> : null}
      {groups.length === 0 && backgroundGroups.length > 0 ? (
        <p className="day-triage__step">
          剩下的都是后台任务自己的失败，没有可以打开的对象，也不需要你处理——它们在本节末尾列出。
        </p>
      ) : null}

      <ul className="day-triage__list">
        {visible.map((group) => {
          const step = anomalyStep(group);
          return (
            <li
              className="day-anomaly"
              key={group.id}
              data-phase={group.phase}
              
            >
              <span className="day-anomaly__icon" aria-hidden="true">
                {group.phase === "inflight" ? (
                  <LoaderCircle size={13} strokeWidth={2.2} />
                ) : (
                  <TriangleAlert size={13} strokeWidth={2.2} />
                )}
              </span>

              <div className="day-anomaly__main">
                <b className="day-anomaly__title">{group.title}</b>
                <span className="day-anomaly__meta">
                  {group.count > 1 ? (
                    <span className="day-anomaly__count" title={`同类系统记录 ${group.count} 条`}>
                      同类记录 ×{group.count}
                    </span>
                  ) : null}
                  {/* 处置语与组头相同就不再复读；不同才在这里说这一组自己的话。 */}
                  {step === sharedStep ? null : <span className="day-anomaly__step">{step}</span>}
                  {group.target || group.recovery ? null : (
                    <span className="day-anomaly__stuck">这条记录没有可直接打开的位置</span>
                  )}
                </span>
              </div>

              {group.recovery ? (
                <button
                  type="button"
                  className="button day-jump"
                  onClick={() => onRecover(group.recovery)}
                  aria-label={`去设置处理 ${group.title}`}
                >
                  去设置
                </button>
              ) : (
                <EntryJump target={group.target} label={group.title} action="去处理" onOpen={onOpen} />
              )}
            </li>
          );
        })}
      </ul>

      {overflow > 0 ? (
        <button
          type="button"
          className="day-triage__more"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          {expanded ? "收起" : `还有 ${overflow} 个处理项`}
        </button>
      ) : null}

      {/* 审计 F14：后台任务自己的失败列在这里——它们在页面上有位置、有解释，
          但没有"处理"按钮、也不进"待处理 N"的数。 */}
      {backgroundGroups.length > 0 ? (
        <details className="day-triage__background">
          <summary>系统异常 · {backgroundGroups.length} 类 · 不需要你处理</summary>
          <h3 className="day-section-head">
            <b>系统异常</b>
            <span>{backgroundGroups.length} 类 · 不需要你处理</span>
          </h3>
          <p className="small">
            这些后台任务（解析、生成、同步）未能完成，失败记录已保留。如需这些结果，可以回到原页面重新尝试。
            如果同一件事一直失败，可以在「设置 → 数据与维护」里反馈。
          </p>
          <ul className="day-triage__list">
            {backgroundGroups.map((group) => (
              <li className="day-anomaly" key={group.id} data-phase={group.phase}>
                <span className="day-anomaly__icon" aria-hidden="true">
                  <TriangleAlert size={13} strokeWidth={2.2} />
                </span>
                <div className="day-anomaly__main">
                  <b className="day-anomaly__title">{group.title}</b>
                  <span className="day-anomaly__meta">
                    {group.count > 1 ? (
                      <span className="day-anomaly__count" title={`同类系统记录 ${group.count} 条`}>
                        同类记录 ×{group.count}
                      </span>
                    ) : null}
                    <span className="day-anomaly__step">{anomalyStep(group)}</span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {note ? <p className="day-log__note">{note}</p> : null}
    </section>
  );
}

function LogRows({
  rows,
  ariaLabel,
  onOpen,
}: {
  readonly rows: readonly TodayLogRow[];
  readonly ariaLabel: string;
  readonly onOpen: (target: ActivityTargetV1) => void;
}) {
  return (
    <ol className="day-log__stream" aria-label={ariaLabel}>
      {rows.map((row) => {
        const Icon = KIND_ICONS[row.kind];
        return (
          <li className="day-log__entry" key={row.id} data-kind={row.kind} >
            <time className="day-log__time" dateTime={row.at}>{row.time}</time>
            <span className="day-log__node" aria-hidden="true">
              <Icon size={13} strokeWidth={2.2} />
            </span>
            <div className="day-log__body">
              {row.headline.includes(row.kindLabel) ? null : (
                <span className="sr-only">{row.kindLabel} · </span>
              )}
              <b>{row.headline}</b>
              {row.detail ? <small>{row.detail}</small> : null}
            </div>
            <EntryJump target={row.target} label={row.headline} action="查看" onOpen={onOpen} />
          </li>
        );
      })}
    </ol>
  );
}

export function RoundRecordStream({
  items,
  total,
  hasMore,
  busy,
  failure,
  loadingText,
  loadMoreText,
  onLoadOlder,
  onReload,
  loading,
  onOpen,
}: {
  readonly items: readonly NoteLearningRoundPersonalHistoryItemV1[];
  readonly total: number;
  readonly hasMore: boolean;
  readonly busy: boolean;
  readonly failure: string | null;
  readonly loadingText: string;
  readonly loadMoreText: string;
  readonly onLoadOlder: () => void;
  readonly onReload: () => void;
  readonly loading: boolean;
  readonly onOpen: (item: NoteLearningRoundPersonalHistoryItemV1) => void;
}) {
  return (
    <section className="day-stream day-rounds" aria-labelledby="today-round-record-title" data-round-record="true">
      <h2 className="day-section-head" id="today-round-record-title">
        <b>我学过的每一轮</b>
        {items.length > 0 ? <span>{ROUND_RECORD_COPY_V1.personalLead(total, items.length, hasMore)}</span> : null}
      </h2>
      {failure ? (
        <p className="day-log__note" role="alert">
          {failure} <button type="button" className="button" onClick={onReload}>再读一次</button>
        </p>
      ) : null}
      {loading ? <p className="day-stream__empty" role="status">正在读取学习轮次…</p> : items.length > 0 ? (
        <ol className="day-rounds__list" aria-label="我的学习轮次记录">
          {items.map((item) => (
            <li className="day-rounds__entry" key={item.roundId} data-round-record-row={item.roundId}>
              <time className="day-rounds__date" dateTime={item.startedAt}>{roundRecordDayV1(item.startedAt)}</time>
              <div className="day-rounds__body">
                <b>{item.drivingQuestion}</b>
                <span className="day-rounds__meta">
                  {item.noteTitle} · {roundHistoryStateLabelV1(item)}
                  {item.actualModes.length > 0 ? ` · ${roundRecordModesLabelV1(item.actualModes)}` : ""}
                  {item.systemUncertain ? ` · ${ROUND_RECORD_COPY_V1.uncertain}` : ""}
                  {item.followUpSettledAt ? ` · ${ROUND_RECORD_COPY_V1.followUp(roundRecordDayV1(item.followUpSettledAt))}` : ""}
                </span>
              </div>
              <button type="button" className="button day-jump" onClick={() => onOpen(item)} aria-label={`回看这一轮 ${item.drivingQuestion}`}>
                回看
              </button>
            </li>
          ))}
        </ol>
      ) : (failure ? null : (
        <p className="day-stream__empty">还没有开过一轮。在任意一篇笔记上问一句"想弄懂什么"，这里就会记上。</p>
      ))}
      {hasMore ? (
        <button type="button" className="button" disabled={busy} onClick={onLoadOlder}>
          {busy ? loadingText : loadMoreText}
        </button>
      ) : null}
    </section>
  );
}

export function LogStream({
  rows,
  note,
  onOpen,
  onPick,
}: {
  readonly rows: readonly TodayLogRow[];
  readonly note: string | null;
  readonly onOpen: (target: ActivityTargetV1) => void;
  readonly onPick: (intent: RoomIntent) => void;
}) {
  const [systemExpanded, setSystemExpanded] = useState(false);
  const learningRows = rows.filter((row) => row.kind !== "job");
  const systemRows = rows.filter((row) => row.kind === "job");

  return (
    <section className="day-stream" aria-labelledby="today-learning-log-title">
      <h2 className="day-section-head" id="today-learning-log-title">
        <b>学习记录</b>
        <span>{learningRows.length > 0 ? `${learningRows.length} 条 · 最新的在最上面` : "还没有记录"}</span>
      </h2>

      {learningRows.length > 0 ? (
        <LogRows rows={learningRows} ariaLabel="今日学习记录" onOpen={onOpen} />
      ) : (
        <div className="day-stream__empty">
          <b>从这里开始</b>
          <p>从下面任意一件事开始，真正的学习记录会按时间排在这里。</p>
          <div className="actions">
            {START_ACTIONS.map((action) => (
              <button key={action.intent} type="button" className="button" onClick={() => onPick(action.intent)}>
                {action.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {systemRows.length > 0 ? (
        <section className="day-system" aria-labelledby="today-system-log-title">
          <button
            type="button"
            className="day-system__toggle"
            aria-expanded={systemExpanded}
            aria-controls="today-system-log"
            onClick={() => setSystemExpanded((value) => !value)}
          >
            <span>
              <b id="today-system-log-title">系统活动</b>
              <small>{systemRows.length} 条派生处理，不计入学习记录</small>
            </span>
            <span aria-hidden="true">{systemExpanded ? "收起" : "展开"}</span>
          </button>
          {systemExpanded ? (
            <div id="today-system-log">
              <LogRows rows={systemRows} ariaLabel="今日系统活动" onOpen={onOpen} />
            </div>
          ) : null}
        </section>
      ) : null}

      {note ? <p className="day-log__note">{note}</p> : null}
    </section>
  );
}

export function AllSpacesPanel({
  summary,
  loading,
  failure,
  onRetry,
}: {
  readonly summary: AllSpacesSummary | null;
  readonly loading: boolean;
  readonly failure: string | null;
  readonly onRetry: () => void;
}) {
  return (
    <section className="day-spaces" aria-labelledby="today-all-spaces-title">
      <span className="tag">全部空间</span>
      <div className="day-rail__card">
        <h2>
          <Layers size={13} strokeWidth={2.2} aria-hidden="true" />
          <span id="today-all-spaces-title">我在每个空间的进度</span>
        </h2>
        {loading ? (
          <p className="day-rail__why" role="status">正在读取全部空间…</p>
        ) : failure !== null || summary === null ? (
          <div className="day-spaces__failure">
            <p role="status">全部空间的统计暂时读不到，本页其余数字仍然只算当前空间。</p>
            <button type="button" className="button" onClick={onRetry}>重试</button>
          </div>
        ) : (
          <>
            <ul className="day-spaces__list" aria-label="每个空间各自的进度">
              {summary.rows.map((row) => (
                <li className="day-spaces__row" key={row.workspaceId} data-current={row.isCurrent || undefined}>
                  <span className="day-spaces__head">
                    <b>{row.name}</b>
                    <small>{row.kindLabel} · {row.roleLabel}</small>
                    {row.isCurrent ? <em className="day-spaces__current">当前空间</em> : null}
                  </span>
                  <span className="day-spaces__numbers">
                    {row.metrics.map((metric) => (
                      <span key={metric.key}>{metric.label} {metric.value}</span>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
            <p className="day-spaces__total">
              <b>合计</b>
              <span className="day-spaces__numbers">
                {summary.totalMetrics.map((metric) => (
                  <span key={metric.key}>{metric.label} {metric.value}</span>
                ))}
              </span>
            </p>
            {summary.totalDegraded ? (
              <p className="day-rail__why">某个空间的活跃卡片太多，合计里的明细按前 2000 张卡计算。</p>
            ) : null}
            {summary.skippedNote ? <p className="day-rail__why">{summary.skippedNote}</p> : null}
            <p className="day-rail__why">本页其余数字都只算当前空间；只有这里是全部空间。</p>
          </>
        )}
      </div>
    </section>
  );
}

export function CompanionRail({ onOpen }: { readonly onOpen: () => void }) {
  return (
    <div className="day-rail__card">
      <h2>
        <Sparkles size={13} strokeWidth={2.2} aria-hidden="true" />
        伴星日记
      </h2>
      <p>把这一路的学习与对话，留在她的日记里。</p>
      <p className="day-rail__why">日记按你设置的时间整理，去看看她记住了什么。</p>
      <button type="button" className="button" onClick={onOpen}>打开伴星</button>
    </div>
  );
}
