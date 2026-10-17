/**
 * 伴星投机的**发与收**（2026-10-07 起，2026-10-13 补提问形状）。
 *
 * 请求形状与"什么条件下允许保留"是纯判据，在 `companion-speculative-first-step.ts`；
 * 这一份只管两条飞地：按两个假设各把第一步**流式**发出去、分类落地后二选一，
 * 另一版整版作废。拆成两个文件是因为它们要的东西不一样——判据不需要 provider、
 * 不需要信号、不看时钟，这一份每一样都要。
 *
 * 为什么走流式而不是缓冲：缓冲要等整段生成完才交付，实测首字 4s，比原来还慢；
 * 流式 + 攒住才是"分类器落地的瞬间就把已经生成的部分吐出去"。
 *
 * 三条附加入场条件（提问版）：
 * - provider 必须声明"流式也解析 tool_calls"——否则真实第一步走的是缓冲取回，
 *   流式投机可能把工具调用静默丢掉；
 * - 本轮还没有任何工具回执（由调用方判定并挡住）——续跑的第一步工具面里不含
 *   已用过的搜索配额，这里不复制那套恢复逻辑，宁可不投机；
 * - 工具面按"这一轮能不能用 web 搜索"现算，与真实第一步同一判据。
 */
import type { AgentTurnInterpretationV1 } from "@astella/shared/agent-contracts";
import type { AgentTurnRequest, AgentTurnResult } from "@astella/shared";
import type { AIProvider } from "../../lib/ai-provider.ts";
import { resolveProviderCallTimeout } from "../../lib/handler-timeout-config.ts";
import { logger } from "../../lib/logger.ts";
import { AIContextCompactionRequiredError, AIContextOverflowError } from "../../lib/context-governor.ts";
import { companionStepOutputCeiling } from "../turn/companion-dialogue-content.ts";
import { stepHoldChars } from "../turn/companion-step-plan.ts";
import { canRetryCompanionStream, runStreamingAgentStep } from "./companion-agent-streaming-step.ts";
import {
  buildCasualFirstStepRequest,
  buildQuestionFirstStepRequest,
  shouldKeepSpeculativeFirstStep,
  shouldKeepSpeculativeQuestionStep,
} from "./companion-speculative-first-step.ts";
import {
  companionReleaseGateFor,
  type CompanionReleaseRouterPort,
} from "./companion-release-router.ts";

type AgentMessage = AgentTurnRequest["messages"][number];

/** 留在投机里的那一步：正式循环直接消费它，不再重打一次请求。 */
export type CompanionPrefetchedFirstStepV1 = {
  request: AgentTurnRequest;
  result: AgentTurnResult;
  emitted: boolean;
};

export interface CompanionSpeculativeFlightsV1 {
  /**
   * 分类落地后二选一；两版都不该留时返回 null（正式第一步照原路径重打）。
   *
   * `deadlineAt`/`handlerStartedAtMs` 由调用方给：留没留由解释决定，
   * 但**还要不要等**由这一轮的执行预算决定，那个数只有运行时知道。
   */
  settle(args: {
    attention: AgentTurnInterpretationV1;
    runId: string;
    deadlineAt: number;
    handlerStartedAtMs: number;
  }): Promise<CompanionPrefetchedFirstStepV1 | null>;
}

export function startCompanionSpeculativeFirstSteps(args: {
  provider: AIProvider;
  ctxSignal: AbortSignal;
  onProviderDelta: ((delta: string) => Promise<boolean>) | undefined;
  onReasoningDelta?: (text: string) => void;
  attention: Promise<AgentTurnInterpretationV1>;
  /** 已有本轮的权威解释（重试路径）时不投机：那条往返早就付过了。 */
  cachedInterpretation: AgentTurnInterpretationV1 | null;
  turnPolicy: string;
  permissionLevel: Parameters<typeof buildCasualFirstStepRequest>[0]["permissionLevel"];
  stepBudget: number;
  messages: AgentMessage[];
  deadlineAt: number;
  availableTools: AgentTurnRequest["tools"];
  /** 这一轮能不能用 web 搜索（与真实第一步同一判据，由运行时算好交进来）。 */
  webSearchAllowed: boolean;
  /** 本轮已有的工具回执数：非 0 就不投提问版（续跑的第一步工具面不一样）。 */
  toolCallCount: number;
  /**
   * L1 放行端口（只有 `COMPANION_RELEASE_ROUTER=enforce` 才有）。
   * 给了就两架航班各按自己的意图猜测量一次：命中即可先开闸，未命中仍等 L2。
   */
  releaseRouter?: CompanionReleaseRouterPort;
}): CompanionSpeculativeFlightsV1 {
  const eligible = args.cachedInterpretation === null
    && typeof args.provider.chatCompletionStream === "function"
    && Boolean(args.onProviderDelta);
  const maxTokens = companionStepOutputCeiling(args.provider);
  /** 一次 L1 判断，两架航班共用（memoized 在端口里）。 */
  const releaseVerdict = args.releaseRouter?.evaluate() ?? Promise.resolve(null);
  const casualReleaseGate = companionReleaseGateFor(
    releaseVerdict, "conversation", () => args.attention.then(shouldKeepSpeculativeFirstStep));
  const questionReleaseGate = companionReleaseGateFor(
    releaseVerdict, "question", () => args.attention.then(shouldKeepSpeculativeQuestionStep));
  const timeoutMs = Math.min(resolveProviderCallTimeout("companion_agent"),
    Math.max(1, args.deadlineAt - Date.now()));
  const holdUntilChars = stepHoldChars({ userAskedForAction: false });
  const casualRequest = eligible
    ? buildCasualFirstStepRequest({
      turnPolicy: args.turnPolicy,
      permissionLevel: args.permissionLevel,
      stepBudget: args.stepBudget,
      messages: args.messages,
      maxTokens,
      tools: args.availableTools,
    })
    : null;
  /** 投机那一步真的发过字没有——保留时它就是这一步的 `stepEmitted`。 */
  const casual = { emitted: false };
  const casualFlight = casualRequest
    ? runStreamingAgentStep({
      provider: args.provider,
      stepRequest: casualRequest,
      ctxSignal: args.ctxSignal,
      timeoutMs,
      onProviderDelta: args.onProviderDelta!,
      // 闲聊版按本轮意图关思考，通常一个思考字都没有；仍然挂上，
      // 因为档案没声明 none 的模型只能降到最低档（那时这段思考也是真的）。
      ...(args.onReasoningDelta ? { onReasoningDelta: args.onReasoningDelta } : {}),
      // 第一步之前没有任何段下发过，分段符为空（与真实第一步同口径）。
      separatorBefore: "",
      holdUntilChars,
      onTextEmitted: () => { casual.emitted = true; },
      releaseGate: casualReleaseGate,
    })
    : null;
  // 作废是这条飞地的正常出口之一：先接住，免得没人处理的 rejection 冒出来。
  casualFlight?.catch(() => undefined);

  const questionTools = args.availableTools
    .filter(definition => definition.name !== "agent_web_search" || args.webSearchAllowed);
  const questionRequest = eligible && args.provider.chatCompletionStreamToolCalls === true
    && args.toolCallCount === 0
    ? buildQuestionFirstStepRequest({
      turnPolicy: args.turnPolicy,
      permissionLevel: args.permissionLevel,
      stepBudget: args.stepBudget,
      messages: args.messages,
      maxTokens,
      tools: questionTools,
    })
    : null;
  const question = { emitted: false };
  const questionFlight = questionRequest
    ? runStreamingAgentStep({
      provider: args.provider,
      stepRequest: questionRequest,
      ctxSignal: args.ctxSignal,
      timeoutMs,
      onProviderDelta: args.onProviderDelta!,
      ...(args.onReasoningDelta ? { onReasoningDelta: args.onReasoningDelta } : {}),
      separatorBefore: "",
      // 保留条件是 question + toolUse none，真实第一步也就是这一条阈值。
      holdUntilChars,
      onTextEmitted: () => { question.emitted = true; },
      releaseGate: questionReleaseGate,
    })
    : null;
  questionFlight?.catch(() => undefined);

  const keep = async (
    request: AgentTurnRequest,
    flight: Promise<AgentTurnResult>,
    state: { emitted: boolean },
    label: string,
    settle: { runId: string, deadlineAt: number, handlerStartedAtMs: number },
  ): Promise<CompanionPrefetchedFirstStepV1 | null> => {
    try {
      const result = await flight;
      logger.info({ runId: settle.runId, ms: Date.now() - settle.handlerStartedAtMs },
        `speculative ${label} first step kept after interpretation; generation overlapped the classifier round-trip`);
      return { request, result, emitted: state.emitted };
    } catch (err) {
      // Speculation has no compaction owner. A locally rejected request has
      // delivered nothing; let the formal bounded sender compact its actual
      // request instead of terminating before that recovery path can run.
      if (!state.emitted && !args.ctxSignal.aborted && Date.now() < settle.deadlineAt
        && (err instanceof AIContextCompactionRequiredError || err instanceof AIContextOverflowError)) {
        logger.info({ runId: settle.runId }, "speculative context pressure deferred to formal request compaction");
        return null;
      }
      // 投机请求一旦送达文字，或输出额度/鉴权等确定性失败，就和正式流式
      // 步一样直接失败。无条件回退会再次生成、重复送达已发布的前缀。
      // `state.emitted` 必须读到**出错那一刻**的值：字是在 await 期间才发出去的。
      if (!canRetryCompanionStream(err, { emitted: state.emitted, now: Date.now(), deadline: settle.deadlineAt })) throw err;
      logger.warn({ runId: settle.runId, err },
        `speculative ${label} first step failed; falling back to the normal path`);
      return null;
    }
  };

  return {
    async settle(settle) {
      const keepCasual = shouldKeepSpeculativeFirstStep(settle.attention);
      if (casualRequest && casualFlight && keepCasual) {
        return keep(casualRequest, casualFlight, casual, "casual", settle);
      }
      const keepQuestion = !keepCasual && shouldKeepSpeculativeQuestionStep(settle.attention);
      if (questionRequest && questionFlight && keepQuestion) {
        return keep(questionRequest, questionFlight, question, "question", settle);
      }
      return null;
    },
  };
}
