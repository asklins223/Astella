import type { ReactNode } from "react";
import { LoaderCircle, TriangleAlert, Lock } from "lucide-react";
import type { GatewayFailureKind } from "../../app/desktop-client";

/**
 * 一次失败在纸面上的样子（39 §13.3／§13.4）。
 *
 * ## 为什么它不该只是一行灰字
 *
 * 这一层此前把**所有**失败都渲染成同一样东西：一段 `.small.notebook-note`，
 * 带 `role="alert"`，摆在纸片最底下。于是三件性质完全不同的事长得一样：
 *
 *  1. 「这一轮正在准备讲解，稍后刷新就能接回」——服务端**已经收下**这一发，
 *     结果还没到。它是成功受理的回执，却顶着一张红色的脸。
 *  2. 「这次请求的内容没有通过校验，请检查后重试」——用户能做什么，一个字没说。
 *  3. 「还没签署 AI 使用同意」——这一条的重试按钮按一万次也没用，缺的是"去哪签"。
 *
 * 所以这里给四档（`GatewayFailureKind`）不同的**结构**，不只是不同的措辞：
 *
 * | 档 | 是不是错误 | 配什么出路 |
 * | --- | --- | --- |
 * | `pending` | 不是 | 一句"会自动接上"，**不给进度条也不给重试** |
 * | `retryable` | 是 | 就地重试 |
 * | `blocked` | 是 | 指出去哪里解决，重试按钮不给（给了就是骗人） |
 * | `failed` | 是 | 重试 ＋ 一条离开的出路 |
 *
 * 摆位也一并定下来：它在**该动作的下面**，不在纸片最底下——§13.4 说"可恢复步骤
 * 提供就地重试"，就地的前提是它离那个按钮够近。
 */
export type RoundNoticeProps = {
  readonly kind: GatewayFailureKind;
  readonly message: string;
  /** `retryable` / `failed` 才用得上；`blocked` 与 `pending` 不会渲染它。 */
  readonly onRetry?: () => void;
  readonly retryLabel?: string;
  /** `retryable` / `failed` 的第二出路：结束这一轮、回笔记之类。 */
  readonly secondary?: ReactNode;
  /** 屏幕阅读器用的前缀，四档各不相同（"还在准备" 念成 alert 是错的）。 */
  readonly testId?: string;
};

const KIND_LABEL: Record<GatewayFailureKind, string> = {
  pending: "还在准备",
  retryable: "这一步没做成",
  blocked: "这一步被挡住了",
  failed: "这一步没有完成",
};

export function RoundNotice({
  kind,
  message,
  onRetry,
  retryLabel = "重试这一步",
  secondary,
  testId,
}: RoundNoticeProps) {
  if (kind === "pending") {
    return (
      <p className="round-notice round-notice--pending" data-round-notice="pending" data-testid={testId}>
        <LoaderCircle className="round-notice__icon" size={15} aria-hidden="true" />
        <span>
          <b className="round-notice__kind">{KIND_LABEL.pending}</b>
          {message}
        </span>
      </p>
    );
  }

  const blocked = kind === "blocked";

  return (
    <div
      className={`round-notice round-notice--${blocked ? "blocked" : "failed"}`}
      data-round-notice={blocked ? "blocked" : "failed"}
      // pending 不进 alert：它不是错误，播报会打断正在做别的事的人。
      role="alert"
      data-testid={testId}
    >
      <p className="round-notice__line">
        {blocked
          ? <Lock className="round-notice__icon" size={15} aria-hidden="true" />
          : <TriangleAlert className="round-notice__icon" size={15} aria-hidden="true" />}
        <span>
          <b className="round-notice__kind">{KIND_LABEL[kind]}</b>
          {message}
        </span>
      </p>
      {onRetry && !blocked ? (
        <div className="round-notice__actions">
          <button type="button" className="button" onClick={onRetry}>
            {retryLabel}
          </button>
          {secondary}
        </div>
      ) : null}
      {blocked && secondary ? <div className="round-notice__actions">{secondary}</div> : null}
    </div>
  );
}
