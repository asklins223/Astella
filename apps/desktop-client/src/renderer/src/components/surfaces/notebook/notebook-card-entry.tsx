import { Layers, LoaderCircle } from "lucide-react";
import type { RefObject } from "react";
import { cardGenerationEntryLabel } from "../review/card-generation-status.ts";

const STATES: Readonly<Record<string, string>> = {
  queued: "排队中", source_sealing: "生成中", planning: "生成中", authoring: "生成中", checking: "生成中",
  review_ready: "待激活", needs_attention: "待处理", activating: "激活中", activated: "已完成",
  failed: "失败", cancelled: "已取消", stale: "需重做", no_cards_recommended: "无候选", closed_without_activation: "未激活",
};

export function NotebookCardEntry(props: {
  readonly status?: string;
  readonly busy?: boolean;
  readonly disabled?: boolean;
  readonly title: string;
  readonly startLabel?: string;
  readonly partialSourceNotice?: string | null;
  readonly onClick: () => void;
  readonly triggerRef?: RefObject<HTMLButtonElement | null>;
}) {
  const state = props.status ? STATES[props.status] ?? "查看状态" : props.busy ? "创建中" : null;
  // Status is supplied only when this entry opens that run. New source and
  // stopped-run entries use a start label instead.
  const destinationLabel = props.status && props.status !== "closed_without_activation"
    ? cardGenerationEntryLabel(props.status)
    : props.startLabel ?? "生成学习卡";
  const entryIsAboutThisRun = Boolean(props.status) && props.status !== "closed_without_activation";
  // 重新生成那一档不能只靠"不给 aria-label"：可见文字后面还跟着状态字（「未激活」），
  // 无障碍名会把两段拼起来，于是变成「制作学习卡 未激活」，谁也按名字点不到。
  // 所以这一档显式给 aria-label，内容就是**按下去会做的事**。
  const label = entryIsAboutThisRun && state
    ? `学习卡：${state}`
    : props.status ? destinationLabel : undefined;
  return <button type="button" ref={props.triggerRef} className="button notebook-card-entry" data-status={props.status}
    aria-label={label} disabled={props.disabled || props.busy} title={props.partialSourceNotice ? `${props.title}。${props.partialSourceNotice}` : props.title} onClick={props.onClick}>
    {props.busy ? <LoaderCircle size={15} className="run-spinner" aria-hidden="true" /> : <Layers size={15} aria-hidden="true" />}
    <span>{destinationLabel}</span>{state ? <span className="notebook-card-entry__state" role="status">{state}</span> : null}
    {props.partialSourceNotice ? <span className="notebook-card-entry__coverage" role="status" title={props.partialSourceNotice}>仅部分正文</span> : null}
  </button>;
}
