/**
 * 提案卡上的三行文案：**标题 / 目标 / 影响**（2026-10-05）。
 *
 * ## 这里原来是什么
 *
 * `createAgentProposal` 曾经这么写：
 *
 * ```ts
 * const title = `执行${definition.description.slice(0, 30)}`;
 * const targetSummary = definition.description.slice(0, 160);
 * ```
 *
 * 而 `definition.description` 是**给模型看的工具用法说明**，不是给用户看的话。
 * `companion_save_memory` 那条写的是「仅保存用户本轮明确要求记住或以后遵循的新内容；
 * 遵循已有偏好、普通学习问题、一次性要求或历史里曾说过记住，都不需要再保存。
 * 已有同一偏好需长期纠正时先读当前版本并用 revise。条件或期限须附本轮原话短引句……
 * ——一整屏都是**写给模型的行为约束**（什么时候**不要**调、参数该逐字来自哪里）。
 *
 * 用户在这张卡上要做的事只有一个：**这次到底要不要按下去**。他需要的答案不是
 * 「这个工具的使用规则是��么」，而是「**是哪一件事**要变」。那句话在 payload 里
 * （`content` / `activeness` / `level` / `reason`），从来不在 description 里。
 *
 * 截断还让每张卡都以半句话收尾——160 字正好切在「…普通学习问题、」这种顿号后面，
 * 30 字那句更短（标题是「执行」+ 描述前 30 字，实测渲染出来就是
 * 「执行 仅保存用户本轮明确要求记住或以后遵循的新内容；遵循已有偏好、」）。
 *
 * ## 这一版的判据
 *
 * 1. **不引用 description 里的任何一个字。** 用例与守卫都在
 *    `__tests__/companion-proposal-copy.test.ts` 与 `companion-agent-proposal-guard.test.ts`。
 * 2. **目标那一行必须指名 payload 里的那个值**，用户扫一眼就知道在改什么。
 * 3. **影响那一行说人可观察的后果**（会怎样、能不能撤回），并尽量指出在哪撤。
 * 4. **不在这层格式化绝对时间。** `deferredUntil` / `validUntil` 落库的是 UTC，
 *    而各处界面（记忆面板、复习排期）都用客户端本地时区渲染——服务端在这里印一个
 *    日期就会与用户在别处看到的差一天。要日期的那几个 kind 改成说「会怎样」，
 *    具体日期交给拥有时区的那一屏。
 * 5. **截断落在小句边界**，不留悬在半句的顿号；且截断后仍满足合同的
 *    title≤80 / target≤160 / impact≤240。
 */

import { COMPANION_AGENT_TOOL_LABELS, proposedLearningActionPayloadV1Schema } from "@ailearn/shared";
import type { z } from "zod";

type ProposalPayload = z.infer<typeof proposedLearningActionPayloadV1Schema>;

export interface AgentProposalCopy {
  readonly title: string;
  readonly targetSummary: string;
  readonly impactSummary: string;
}

/** 合同的三个上限（`actionProposedProposalV1Schema`）；截断按它们来，不另设一套。 */
const TITLE_MAX = 80;
const TARGET_MAX = 160;
const IMPACT_MAX = 240;

const MEMORY_KIND_LABEL: Record<string, string> = {
  preference: "偏好",
  goal: "目标",
  learning_context: "学习背景",
  interaction_note: "相处约定",
  episodic: "经历",
};

const ACTIVENESS_LABEL: Record<string, string> = { quiet: "安静", moderate: "适中", active: "活跃" };

const GRAPH_LENS_LABEL: Record<string, string> = {
  current_target: "当前目标", evidence: "证据", provenance: "来源", issues: "存疑处",
};

const DEFER_REASON_LABEL: Record<string, string> = {
  user_requested: "你说现在不方便",
  temporary_unavailable: "现在顾不上",
};

/**
 * 截断到 `max` 以内，且尽量断在小句边界。
 *
 * 找不到后半段的小句边界时宁可硬切——留一个悬空的顿号正是这次要修的那个毛病，
 * 但硬切至少是**可预期**的边界，而 `slice` 切在哪个字上完全随机。
 */
function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  const budget = max - 1;
  const head = text.slice(0, budget);
  for (const stop of ["；", "。", "，", "、", " "]) {
    const at = head.lastIndexOf(stop);
    if (at >= Math.floor(budget * 0.6)) return `${head.slice(0, at)}…`;
  }
  return `${head}…`;
}

/**
 * 记忆的适用条件与期限。条件逐字来自用户原话（40 §4.5），照印不改写，
 * 也不自己补「时」之类的语气词——它是自由短语（「讲解新概念时」「正式作答时不要主动提示」），
 * 加一个字就会拼出「讲解新概念时时」。这里沿用「记忆」页给同一个字段的措辞：**适用条件**。
 */
function memoryTerms(parts: { appliesWhen?: string | null; validUntil?: string | null }): string {
  const terms: string[] = [];
  if (parts.appliesWhen) terms.push(`适用条件：${parts.appliesWhen}`);
  // 期限只说「到期之后怎样」，不把 UTC 时刻印成日期（见头注释判据 4）。
  if (parts.validUntil) terms.push("到期之后就不再按这条来");
  return terms.length ? `（${terms.join("；")}）` : "";
}

/**
 * 一条待确认提案该怎么跟用户说。
 *
 * `toolName` 只在兜底那一条上用到（按注册表里的展示名取，而不是去猜这个工具干什么）。
 */
export function describeAgentProposal(payload: ProposalPayload, toolName: string): AgentProposalCopy {
  return copy(payload) ?? fallbackCopy(toolName);
}

function fallbackCopy(toolName: string): AgentProposalCopy {
  // 注册表里的 `presentation.label` 是**已经写给人听**的（如「正在记住这件事」），
  // 只是为了放在动作轨道上用了进行时；去掉「正在」后可以直接当标题。
  const label = COMPANION_AGENT_TOOL_LABELS[toolName]?.replace(/^正在/, "");
  return {
    title: clamp(label && label.length > 0 ? label : "要做一件事", TITLE_MAX),
    targetSummary: clamp("这件事", TARGET_MAX),
    impactSummary: clamp("确认之后才会执行。", IMPACT_MAX),
  };
}

function copy(payload: ProposalPayload): AgentProposalCopy | null {
  switch (payload.kind) {
    case "save_memory":
      return {
        title: clamp(`记住一条${MEMORY_KIND_LABEL[payload.memoryKind] ?? "事情"}`, TITLE_MAX),
        targetSummary: clamp(
          `「${payload.content}」${memoryTerms(payload)}`,
          TARGET_MAX,
        ),
        impactSummary: clamp(
          // 撤回路径用「记忆」页自己的措辞（纠正 / 归档 / 移除），不给一个不存在的入口。
          "以后聊到相关的事，她会按这条来。写错了可以在「记忆」里纠正、归档或者删掉。",
          IMPACT_MAX,
        ),
      };

    case "revise_memory":
      return {
        title: clamp("改掉一条已经记住的", TITLE_MAX),
        targetSummary: clamp(`改成「${payload.content}」${memoryTerms(payload)}`, TARGET_MAX),
        impactSummary: clamp("新的一句从现在起生效，旧的那句留在版本历史里。", IMPACT_MAX),
      };

    case "set_pet_activeness":
      return {
        title: clamp(`把活跃度调成${ACTIVENESS_LABEL[payload.activeness] ?? payload.activeness}`, TITLE_MAX),
        targetSummary: clamp("伴星主动开口的频率", TARGET_MAX),
        impactSummary: clamp("下一次尚未开始的对话会用上；正在进行的这一轮不变。", IMPACT_MAX),
      };

    case "pause_learning_run":
      return {
        title: clamp("先暂停这一轮", TITLE_MAX),
        targetSummary: clamp("当前正在进行的那一轮学习", TARGET_MAX),
        impactSummary: clamp("进度会留着，随时能接着学。", IMPACT_MAX),
      };

    case "resume_learning_run":
      return {
        title: clamp("接着学这一轮", TITLE_MAX),
        targetSummary: clamp("上一次没学完的那一轮", TARGET_MAX),
        impactSummary: clamp("回到你离开时的位置，进度都还在。", IMPACT_MAX),
      };

    case "start_learning_run_v2": {
      const seconds = payload.request.requestedTimeBudgetSeconds ?? 180;
      const minutes = Math.max(1, Math.round(seconds / 60));
      return {
        title: clamp("开一轮新的学习", TITLE_MAX),
        targetSummary: clamp(`当前这篇笔记的一个学习目标，先学 ${minutes} 分钟`, TARGET_MAX),
        impactSummary: clamp("会新建一轮学习记录；想停随时能停，进度会留着。", IMPACT_MAX),
      };
    }

    case "request_hint_level":
      return {
        // 与作答工位上的措辞同源（`learning-run-copy.tsx`：「给我一点提示」/「第 N 级提示」）。
        title: clamp(payload.level === 1 ? "给我一点提示" : `看第 ${payload.level} 级提示`, TITLE_MAX),
        targetSummary: clamp("当前这道题", TARGET_MAX),
        impactSummary: clamp("看过提示之后，这一轮只计练习分，不作为掌握证据。", IMPACT_MAX),
      };

    case "switch_task_variant":
      return {
        title: clamp("换一道题", TITLE_MAX),
        // `alternativeId` 是 id，用户读不出来；模型写的换题理由才是他能核对的依据。
        targetSummary: clamp(payload.reason, TARGET_MAX),
        impactSummary: clamp(
          "当前这道会换成同一目标的另一道，刚才的作答留在这一轮的记录里。",
          IMPACT_MAX,
        ),
      };

    case "defer_review":
      return {
        title: clamp("把这次复习往后挪", TITLE_MAX),
        targetSummary: clamp(DEFER_REASON_LABEL[payload.reasonCode] ?? "这次复习", TARGET_MAX),
        impactSummary: clamp("这次复习重新排期，到点还会提醒你，不会跳过。", IMPACT_MAX),
      };

    case "focus_graph_node":
      return {
        title: clamp("在星图上定位", TITLE_MAX),
        targetSummary: clamp(`看「${GRAPH_LENS_LABEL[payload.lens] ?? payload.lens}」这一面`, TARGET_MAX),
        impactSummary: clamp("只是换个视角看，不会改动任何东西。", IMPACT_MAX),
      };

    default:
      return null;
  }
}