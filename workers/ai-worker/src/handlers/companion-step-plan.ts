/**
 * 伴星 agent 的**步进规划**（2026-09-30 拆出，B2）。
 *
 * ## 为什么拆
 *
 * `companion-agent-runtime.ts` 混着四类东西：步进规划、事件持久化、读工具
 * （已搬进 `companion-read-tools.ts`）、工具执行与提案创建。
 *
 * 步进规划这一族是**纯**的：给它一份预算快照和一步的判断，它回答
 * 「这一步该攒多少字才下发」「能不能转向」「最后一步压了几个工具调用」。
 * 不查库、不开事务、不看时钟——除了一个时间参数。
 *
 * 它住在 runtime 头部，于是"改一句提示词"看起来像"改 agent 运行时"，
 * 而那两件事的风险完全不同。
 *
 * ## 这一段是**照搬**的
 *
 * 判据、上限、类型一个字没改。调用点在 `companion-agent-runtime.ts`，
 * 从这里 import。
 */

/** 非白名单异常的对外统一摘要：绝不外传驱动/供应商原文。 */
export const TOOL_FAILURE_SAFE_SUMMARY = "工具执行失败，请稍后再试";

import { COMPANION_AGENT_MAX_STEPS, type CompanionContentBlockV1, type AgentTurnRequest } from "@ailearn/shared";

/** Internal repair cannot take the place of the user's current request. */
export function companionStepCorrectionMessages(input: {
  currentRequest: AgentTurnRequest["messages"][number];
  instruction: string;
  alreadyDisplayed: boolean;
}): AgentTurnRequest["messages"] {
  return [
    {
      role: "system",
      content: [
        "这是本轮的内部核对，不是新的用户请求。继续处理下方原样重附的当前问题与选区；历史问题不需要重新回答，实时页面也不能替换用户已经选定的原文。",
        input.instruction,
        input.alreadyDisplayed
          ? "上一段已向用户显示，只补充与当前问题有关的必要核对、纠正或工具结果；不重新从头解释，也不补答旧话题。"
          : "上一段尚未显示，可以修正后完整回答当前问题。",
      ].join("\n"),
    },
    { ...input.currentRequest, role: "user" },
  ];
}

/**
 * 终答步攒够这么多字符才开始下发（见 `runStreamingAgentStep.holdUntilChars`）。
 *
 * 12 字是"值不值得流式"的分界：短于它的回复本来一跳就完，省下流式没有任何损失；
 * 长于它的正常回复照旧逐字下发。真正的目的不是省流量，而是让坍缩闸还能有机会拦。
 */
export const FINAL_ANSWER_HOLD_CHARS = 12;

/** 高到一步的正文永远达不到 = **整段攒住**（只有动作轮用）。 */
export const BUFFERED_STEP_HOLD_CHARS = 1_000_000;

/**
 * 这一步的话什么时候允许落到屏幕上。
 *
 * 普通轮照旧：攒够 12 字就开始逐字下发（流式体验优先，见 `FINAL_ANSWER_HOLD_CHARS`）。
 * **动作轮整段攒住**：用户要的是"必须动系统才算做到"的事（改边界、记/忘、排提醒），
 * 这一步结束之前没人知道她到底调没调工具。先落屏的代价实测过（2026-09-22 场景 T）：
 * "嗯，这条早就设好了喵"先到屏幕上，之后哪怕真调了 `companion_set_boundary`，
 * 也只能在同一条消息里自相矛盾；没调就留下一句没兑现的承诺。
 *
 * 攒住不会让字丢失：没下发过的内容由 writeTail 在终态整段补发（T 轮实测
 * delta=1 批 73 字就是这条路径），代价是动作轮开头会有几秒安静——
 * 按用户口径（"说了没做"是最重的一类抱怨），这个方向值。
 */
export function stepHoldChars(input: { userAskedForAction: boolean }): number {
  return input.userAskedForAction ? BUFFERED_STEP_HOLD_CHARS : FINAL_ANSWER_HOLD_CHARS;
}

/**
 * "让她做事却没做"这一支可以补几步。
 *
 * 动作轮给**两次**（普通形状仍是一次），前提是 `stepHoldChars` 已经把整段攒住：
 * 多试一次不会先把假话落到屏幕上，只是多等几秒。其他形状的话已经流出去了，
 * 再补一步只会让她在同一条消息里自相矛盾（那是 §9.28 定一次性额度的原因）。
 */
export function actionSteerBudget(input: { userAskedForAction: boolean }): number {
  return input.userAskedForAction ? 2 : 1;
}

/**
 * 这一步要不要补、补的时候花掉哪条额度（纯函数，方案 29 §9.28 双额度的账目）。
 *
 * 单独立出来是因为那条"独立的"额度在实现里并不独立：原来只要触发一次 steer
 * 就把 `lookupClaimSteered` 置真，于是第 1 步的形状问题会吃掉"说查过而没查"的额度，
 * 第 2 步的假阴性就没闸可拦了（实机 2026-09-22 真人轮量到，见 §12 C1）。
 */
export function planStepSteer(input: {
  stepCalls: number;
  toolCallCount: number;
  finalAnswerOnly: boolean;
  withinBudget: boolean;
  userAskedForAction: boolean;
  hasUnverifiedClaims: boolean;
  looksLikeUnfulfilledNarration: boolean;
  lookupClaim: boolean;
  actionSteerAttempts: number;
  actionSteerBudget: number;
  lookupClaimSteered: boolean;
}): {
  steer: boolean;
  consumeAction: boolean;
  consumeLookup: boolean;
  swapToFallback: boolean;
} {
  const shapeSteer = input.actionSteerAttempts < input.actionSteerBudget
    && (input.userAskedForAction
      || input.hasUnverifiedClaims
      || input.looksLikeUnfulfilledNarration);
  const lookupSteer = !input.lookupClaimSteered && input.lookupClaim;
  const steer = input.stepCalls === 0
    && input.toolCallCount === 0
    && !input.finalAnswerOnly
    && input.withinBudget
    && (shapeSteer || lookupSteer);
  return {
    steer,
    consumeAction: steer && shapeSteer,
    consumeLookup: steer && lookupSteer,
    // 假阴性与"让她做事她没做"这两类，多说一遍同样的话在同档模型上换不来行动
    // （实机各两次），补的那一步要换兜底模型；纯数字无出处那类不必换。
    swapToFallback: steer && (lookupSteer || input.userAskedForAction),
  };
}

/**
 * 把"与当前值完全相同"的项从补丁里剔掉。
 *
 * 为什么工具侧要做这件事：工具结果里那句"已把 X 设为 Y"是她措辞的唯一依据。
 * 实机 2026-09-22 场景 U，用户只要一句口头禅，她顺手把活跃度也"调成了「活跃」"
 * ——而活跃度本来就是 active（revision 白 +1，什么都没变）。那不是恶意，是
 * **一个没发生的变化被写成了成功**。区分"改成了"和"本来就是这样"是工具的责任。
 */
export function partitionPersonaPatch(
  current: Record<string, unknown>,
  patch: Record<string, string | boolean>,
): { changed: Record<string, string | boolean>; unchangedKeys: string[] } {
  const changed: Record<string, string | boolean> = {};
  const unchangedKeys: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    // 当前值缺项不算"已经是这样"：没设过 ≠ 设成了这个值。
    if (Object.prototype.hasOwnProperty.call(current, key) && current[key] === value) {
      unchangedKeys.push(key);
    } else {
      changed[key] = value;
    }
  }
  return { changed, unchangedKeys };
}

/**
 * 扁平工具面下的固定步数预算（方案 29 §4.1）。
 *
 * 原来每个技能自带 maxSteps（2/4/6），没命中技能就是 1——那正是坍缩成单步的
 * 机制。4 是「读一次上下文 → 需要时再读一次 → 调一个动作 → 作答」的实际最深链路，
 * 再深就是拿尾延迟换小概率的循环。
 */
export const AGENT_LOOP_MAX_STEPS = 4;

/**
 * 终答步违约（工具已收起、provider 仍然回 tool_calls）时一次性宽限多给的步数。
 *
 * 是 **2 不是 1**：多给的那一步要把她真正要的工具跑掉，之后还得留一步强制收尾——
 * 只加一步的话那一步依旧是 `finalAnswerOnly`（判据是 `stepCount >= 步数预算`），
 * 工具仍然不在面上，等于白走一步。
 */
export const AGENT_LOOP_GRACE_STEPS = 2;

/**
 * 允许走宽限的最低剩余时间。
 *
 * 一刀切到 `deadlineAt` 会把宽限变成**更贵的失败**：宽限回合要两次 provider 调用
 * （跑工具 + 收尾作答），实机单次伴星调用 1.5–4s，剩下的时间不够时宁可直接用
 * 她已经说出的那句话交付，也不要跑到一半被预算拦停。`deadlineAt` 本身已经扣掉
 * 了持久化余量（`resolveCompanionAgentBudget().loopDeadlineMs`），所以这里不必
 * 再为终态事务留量。
 */
export const AGENT_LOOP_GRACE_MIN_REMAINING_MS = 20_000;

/**
 * 终答步收起工具之后 provider 仍然回 tool_calls 时，怎么处理这一步。
 *
 * 2026-09-22 实测：最近的 3 次 INTERNAL_ERROR 里 **2 次是这一条**
 * （`provider returned tool calls on a tools-disabled final step`），而原来的处理是
 * `finishStep(failed)` + 抛错整轮失败。用户看到的是"报错"，可她已经把这轮的话说出
 * 去一大半（afecc8d2 报错前已下发 82 字、9e484924 已下发 149 字）——这是最难看的
 * 一种失败：内容几乎都在，只差最后一步没让她做完。
 *
 * 两条出口都**不执行没在她面上的写操作**以外的东西：
 * - `grace`：预算、时限、工具名三个条件都满足时多给 AGENT_LOOP_GRACE_STEPS 步，
 *   把她要的那次查询真跑掉再收尾（"我这就去翻" 之后真的有翻）；
 * - `deliver`：任一条件不满足就丢掉这些调用，按她已经产出的文本交付。文本为空时
 *   下游仍走 EMPTY_AGENT_RESPONSE——不为了"看起来成功"伪造内容。
 *
 * 只宽限一次（额度由调用方持有）：provider 在收尾步上反复违约时，第二轮直接落到
 * `deliver`，步数上界因此是确定的（预算 + 2），不会把 110s 的 handler 超时吃光。
 */
export function planWithheldFinalStepCalls(input: {
  graceAlreadyUsed: boolean;
  /** 这一步要调、但不在本轮工具面上的名字。含未知名字时不给宽限。 */
  unknownToolNames: string[];
  /** 距离 `deadlineAt` 还剩多少毫秒。 */
  remainingMs: number;
  /** 当前生效的步数预算（含此前已给的宽限）。 */
  stepBudget: number;
}): "grace" | "deliver" {
  if (input.graceAlreadyUsed) return "deliver";
  if (input.unknownToolNames.length > 0) return "deliver";
  if (input.stepBudget + AGENT_LOOP_GRACE_STEPS > COMPANION_AGENT_MAX_STEPS) return "deliver";
  if (input.remainingMs < AGENT_LOOP_GRACE_MIN_REMAINING_MS) return "deliver";
  return "grace";
}

export type CompanionAgentLoopResult =
  | { status: "completed"; text: string; blocks: CompanionContentBlockV1[]; memoryRefs: unknown[] }
  | { status: "waiting_for_confirmation"; proposalId: string; memoryRefs: unknown[] };
