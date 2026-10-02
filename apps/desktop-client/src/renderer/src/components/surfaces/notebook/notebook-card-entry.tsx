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
  readonly partialSourceNotice?: string | null;
  readonly onClick: () => void;
  readonly triggerRef?: RefObject<HTMLButtonElement | null>;
}) {
  const state = props.status ? STATES[props.status] ?? "查看状态" : props.busy ? "创建中" : null;
  /**
   * 入口的名字要说清**按下去会去哪儿**。
   *
   * 已有 run 时入口不是「开始生成」——那会诱导用户以为要点一下才开跑，而它**已经**
   * 在跑了。所以按 `cardGenerationEntryLabel` 的口径说「查看生成进度」／「审核学习卡」。
   *
   * 它写在**可见文字**上而不只是 `aria-label`：按钮旁那行状态字说的是阶段
   *（「生成中」「待激活」），而这一行说的是**按下去会去哪**。只放在 aria-label 里的话，
   * 看屏的人读得到、看得见的人反而读不到。
   */
  /**
   * 可见文字说的是**按下去会去哪**，`aria-label` 说的是**阶段**。
   *
   * 去处只有三种，所以文案也只有三种说法（外加「制作学习卡」这个起点）：
   * - 还没有在制的一轮，或上一轮停在「没有保存到卡组」—— 入口是**重新做一份**，
   *   叫「查看生成进度」会让人以为按下去能看到什么，而它其实开的是新一轮；
   * - 上一轮 `activated`—— 卡已经进组了，叫「查看学习卡」；
   * - 其余带 run 的状态（在跑／失败／被取消／过期）—— 一律**去那一轮的工位**，
   *   那里有进度，也有失败原因与重试入口。失败那一档不再单说一句「查看失败原因」：
   *   阶段已经由旁边那颗状态字（生成失败）和 `aria-label` 说了，入口再说一遍
   *   就把「去哪」和「现在什么状态」两件事挤进了同一个词里。
   *
   * 判据取"这一轮还在不在"而不是"有没有过一轮"：后者会让上一轮早就结束的用户，
   * 永远点不到「制作学习卡」。
   */
  const destinationLabel = props.status && props.status !== "closed_without_activation"
    ? cardGenerationEntryLabel(props.status)
    : "制作学习卡";
  /**
   * `aria-label` 只在入口**指着那一轮生成**时才给。
   *
   * `aria-label` 会盖掉可见文字成为无障碍名，所以它必须与按钮**说得同一件事**：
   * 入口去的是那一轮 ⇒ 「学习卡：排队中」（阶段）；入口是重新做一份 ⇒ 不给
   * `aria-label`，让可见的「制作学习卡」直接成为无障碍名。
   *
   * 唯一的例外是 `closed_without_activation`：那一轮停在「没有保存到卡组」，
   * 用户能做的下一件事是**重新做一份**，所以入口不说「查看」，而 `aria-label`
   * 也就不该再宣称这一轮还开着。早先这里对任何状态都给 `学习卡：<阶段>`，
   * 于是那一档读出来是「学习卡：未激活」——用户与读屏都被告知去看一个已经结束的东西。
   */
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
