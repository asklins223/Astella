// 样式表改由 `styles.ts` 统一按顺序注入（2026-09-29）——见该文件顶部的分层说明。
import { Loader2 } from "lucide-react";
import type { CompanionProposalUiState } from "../../../app/companion-session/companion-chat-session";
import { renderCompanionMarkdown } from "../content/companion-markdown";

const PROPOSAL_STATUS_LABEL: Record<
  Extract<CompanionProposalUiState, { phase: "ready" }>["proposal"]["status"],
  string
> = {
  pending: "待确认",
  accepted: "已确认",
  executing: "正在执行",
  succeeded: "已完成",
  rejected: "已跳过",
  failed: "执行失败",
  expired: "已过期",
};

export interface CompanionProposalChoiceProps {
  readonly proposalId: string;
  readonly state: CompanionProposalUiState | undefined;
  readonly context: "bubble" | "history";
  readonly onDecide: (decision: "confirm" | "reject") => void;
  /** 快照读不成时才用得上；不给就不画重试（历史里的旧卡不需要）。 */
  readonly onRetry?: () => void;
}

/**
 * 到点就算过期（方案 35 F2）。
 *
 * 服务端的 `action.expired` 事件是唯一权威，但那条走的是**回合内**的 SSE 订阅，
 * 而订阅在回合收尾时就退了；另一台设备作出的决定同样送不到这张卡上。
 * 于是过期后的卡长期写着"等待你的选择"、两颗按钮都能点，点下去撞 409。
 * `expiresAt` 在此之前从未参与渲染层的任何判定。
 */
export function companionProposalExpired(expiresAt: string | null, now: number = Date.now()): boolean {
  if (!expiresAt) return false;
  const at = Date.parse(expiresAt);
  return Number.isFinite(at) && at <= now;
}

/**
 * Agent 需要用户作决定时的唯一交互组件。
 *
 * 气泡与历史记录共用这一个实例形状，也共用会话层的 proposal 状态；这里不复制状态、
 * 不猜执行结果。历史中的卡片因此能在另一个入口作出决定后同步变成终态留痕。
 */
export function CompanionProposalChoice({
  proposalId,
  state,
  context,
  onDecide,
  onRetry,
}: CompanionProposalChoiceProps) {
  if (!state || state.phase === "loading") {
    return (
      <section
        className="companion-choice-card companion-choice-card--loading"
        data-context={context}
        aria-label="正在加载操作详情"
        aria-busy="true"
      >
        <Loader2 className="companion-choice-card__spinner" size={16} aria-hidden="true" />
        <span>正在加载操作详情…</span>
      </section>
    );
  }

  if (state.phase === "error") {
    return (
      <section
        className="companion-choice-card companion-choice-card--error"
        data-context={context}
        role="status"
        aria-label="这个选择暂时无法读取"
      >
        <strong>这个选择暂时无法读取</strong>
        <span>{state.message}</span>
        {onRetry ? (
          <button type="button" className="companion-choice-card__retry" onClick={onRetry}>重试</button>
        ) : null}
      </section>
    );
  }

  const { proposal, deciding, error } = state;
  const review = proposal.payload.kind === "agent_tool_review" ? proposal.payload : null;
  const saveReview = review?.confirmationStage === "after_preview";
  const expired = proposal.status === "pending" && companionProposalExpired(proposal.expiresAt);
  const pending = proposal.status === "pending" && !expired;
  const statusLabel = expired ? PROPOSAL_STATUS_LABEL.expired : saveReview && proposal.status === "pending" ? "待保存" : PROPOSAL_STATUS_LABEL[proposal.status];

  return (
    <section
      className="companion-choice-card"
      data-context={context}
      data-status={expired ? "expired" : proposal.status}
      data-proposal-id={proposalId}
      role="group"
      aria-label={`${proposal.title}：${statusLabel}`}
      aria-busy={Boolean(deciding)}
    >
      <header>
        <span>{pending ? saveReview ? "结果已准备好，等你保存" : "操作前请确认" : "选择结果"}</span>
        <small>{statusLabel}</small>
      </header>
      <strong className="companion-choice-card__title">{proposal.title}</strong>
      <dl>
        <div><dt>目标</dt><dd>{proposal.targetSummary}</dd></div>
        <div><dt>影响</dt><dd>{proposal.impactSummary}</dd></div>
      </dl>
      {review?.preview.markdown ? <div className="companion-write-preview companion-markdown" aria-label={saveReview ? "待保存的完整结果" : "操作详情"}>
        {renderCompanionMarkdown(review.preview.markdown)}
      </div> : null}
      {review?.preview.markdown ? <details className="companion-write-preview__source"><summary>查看完整 Markdown 源码</summary>
        <pre>{review.preview.markdown}</pre>
      </details> : null}
      {review?.preview.beforeMarkdown ? <details className="companion-write-preview__original"><summary>查看改动前的原文</summary>
        <div className="companion-markdown">{renderCompanionMarkdown(review.preview.beforeMarkdown)}</div>
      </details> : null}
      {pending ? (
        <div className="companion-choice-card__actions">
          <button
            type="button"
            className="text-action"
            disabled={Boolean(deciding)}
            onClick={() => onDecide("reject")}
          >
            {deciding === "reject" ? "正在取消…" : saveReview ? "取消并还原" : "取消操作"}
          </button>
          <button
            type="button"
            className="button primary companion-choice-card__confirm"
            disabled={Boolean(deciding)}
            onClick={() => onDecide("confirm")}
          >
            {deciding === "confirm" ? "正在确认…" : saveReview ? "保存这次改动" : "确认执行"}
          </button>
        </div>
      ) : null}
      {error ? <p className="companion-choice-card__error" role="status">{error}</p> : null}
    </section>
  );
}
