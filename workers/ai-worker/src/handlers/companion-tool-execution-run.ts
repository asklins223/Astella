/**
 * 一次工具调用的**执行段**（40b §4.1-1 / §4.1-2 / R7）。
 *
 * ## 为什么这一段要搬出来
 *
 * 工具步循环里"落 `requested` → 执行 → 失败终结"这一段，本来是循环体的一部分。
 * 提前派发（R7）需要在**流还没结束**时就跑同一段代码——而那不可能是循环：
 * 循环要等 provider 交回 `toolCalls` 才存在。
 *
 * 所以这段必须能脱离循环被调用一次。搬出来之后它**仍然是同一份**：
 * 循环调用它，scheduler 的 `dispatch` 也调用它，不是两份实现。
 *
 * ## 这一段**不**做什么（这些留在循环里）
 *
 *  - 不判 identity / 工具是否存在 / 参数是否合法 / 是否超长 —— 那些在
 *    `ensureAgentToolCall` 之前，各自带账本与 SSE 事件，不属于"执行"。
 *  - 不推 `messages` —— tool 消息的形状由循环一处统一决定。搬两处就会分叉，
 *    而分叉不报错。
 *  - 不判预算、不计 `toolCallCount` —— 那是循环的记账。
 *
 * ## 三种结局
 *
 * `success`（含 route/blocks，由调用方决定要不要收）／`waiting`（等用户确认，
 * 必须把整轮挂起）／`failure`（终态已写进账本并已下发 SSE）。
 *
 * 失败**不抛**：它已经被映射成账本词与模型词并落库了，调用方要做的是推一条
 * tool 消息然后继续，而不是再包一层 try。
 */
import type { AgentToolExecutionResult } from "./companion-tool-result.ts";
import { classifyCompanionToolFailure } from "./companion-tool-outcome.ts";
import { companionToolFailureFaces } from "./companion-tool-failure-faces.ts";
import { runWithAbortBudget } from "../lib/handler-timeout.ts";
import {
  updateToolCall,
  executeTool,
  type ToolExecutionFence,
} from "./companion-tool-call-ledger.ts";
import { appendAgentEvent } from "./companion-agent-events.ts";
import {
  recordCompanionRunFailureSpanBestEffort,
  recoverCompanionRunFailureSpanBestEffort,
} from "./companion-dialogue-store.ts";
import { CompanionAgentBudgetExceededError } from "../lib/non-retryable-errors.ts";
import { COMPANION_AGENT_TOOL_TIMEOUT_MS, COMPANION_AGENT_TOOL_LABELS } from "@astella/shared";
import { READ_IMAGE_TOOL_TIMEOUT_MS, type AgentEventContext } from "./companion-read-tools.ts";
import type { CompanionAgentToolDefinitionV1, CompanionAgentToolStatus } from "@astella/shared";

export type ToolExecutionRun =
  | { kind: "success"; execution: AgentToolExecutionResult }
  | { kind: "waiting"; proposalId: string }
  | { kind: "failure"; ledgerStatus: CompanionAgentToolStatus; modelStatus: string; safeSummary: string };

export interface ToolExecutionRunLogger {
  warn(bindings: Record<string, unknown>, message: string): void;
}

export interface ToolExecutionRunArgs {
  event: AgentEventContext;
  definition: CompanionAgentToolDefinitionV1;
  /** 账本里的 id（`ensureAgentToolCall` 给的），不是 provider 那个 id。 */
  operationCallId: string;
  /** provider 那个 id——tool 消息要按它回。 */
  toolCallId: string;
  arguments: Record<string, unknown>;
  /** 整轮的工具执行截止时刻；`remainingMs` 从它算。 */
  deadlineAt: number;
  /** 父信号，超时要**向下传**给执行器（40b §4.1-2）。 */
  signal: AbortSignal;
  /** 运行 id，只进日志。 */
  runId: string;
  logger: ToolExecutionRunLogger;
}

/**
 * 执行一次已经登记好账本的工具调用。
 *
 * ⚠️ 这个函数**不 await 外部提供的任何东西**之外没有别的约定；调用方可以
 * 挂起它并发地跑多格（提前派发正是这么用的）。账本那一行由调用方
 * `ensureAgentToolCall` 建好后传 `operationCallId` 进来。
 */
export async function runCompanionToolExecution(args: ToolExecutionRunArgs): Promise<ToolExecutionRun> {
  const { event, definition, operationCallId, logger } = args;

  await appendAgentEvent(event, "agent.tool", {
    tool: {
      toolCallId: operationCallId,
      name: definition.name,
      toolVersion: definition.toolVersion,
      riskClass: definition.riskClass,
      status: "requested",
      safeLabel: COMPANION_AGENT_TOOL_LABELS[definition.name] ?? definition.description.slice(0, 240),
    },
  });

  const fence: ToolExecutionFence = { abandoned: false };
  let executionStarted = false;
  try {
    const remainingMs = args.deadlineAt - Date.now();
    if (remainingMs <= 0) {
      throw new CompanionAgentBudgetExceededError("companion agent deadline exceeded");
    }
    const execution = await runWithAbortBudget(
      // 收下子步骤的 signal 并**向下传**：此前这里是 `() => {...}`，
      // signal 被整个丢掉，于是超时只会让调用方停止等待，在途的工具
      // 照跑照写。40b §4.1-2 要求「向下传播 abort」——驱动的逐查询取消
      // 做不到，但"写之前先看一眼"能做到，那才是能挡住损害的那一层。
      (childSignal) => {
        executionStarted = true;
        return executeTool(
          event, definition, { id: operationCallId, arguments: args.arguments }, fence, childSignal,
        );
      },
      args.signal,
      // 读图里嵌的是一次视觉模型往返，10s 的通用工具预算对它来说必然超时；
      // 其余工具查一次库就返回，45s 只是把尾延迟留给真正需要它的那一个。
      Math.min(
        definition.name === "companion_read_image"
          ? READ_IMAGE_TOOL_TIMEOUT_MS
          : COMPANION_AGENT_TOOL_TIMEOUT_MS,
        remainingMs,
      ),
      (lateError) => {
        // 迟到 settle 此前被静默吞掉（无任何可观测信号）。只记日志，
        // 不回写状态：此刻审计行已按超时终结。
        logger.warn(
          { runId: args.runId, tool: definition.name, toolCallId: operationCallId, err: lateError },
          "companion agent tool settled after its budget expired",
        );
      },
    );
    await recoverCompanionRunFailureSpanBestEffort({
      workspaceId: event.ctx.workspaceId,
      userId: event.read.userId,
      runId: args.runId,
    }, "tool");
    if ("waiting" in execution) {
      return { kind: "waiting", proposalId: execution.proposalId };
    }
    return { kind: "success", execution };
  } catch (error) {
    // 超时后的在途执行仍会尝试提交；先置位 fence，让迟到的 succeeded
    // 既不覆盖审计状态，也不再下发一条 succeeded SSE。
    fence.abandoned = true;
    // 原始 error 只进服务端日志：postgres 驱动/供应商错误的 message 可能带
    // schema、约束名或请求体，绝不能进 SSE 或模型上下文（工具参数侧早已
    // 只落 hash，错误信息侧必须同等净化）。
    logger.warn(
      { runId: args.runId, tool: definition.name, toolCallId: operationCallId, err: error },
      "companion agent tool execution failed",
    );
    const failure = companionToolFailureFaces(
      classifyCompanionToolFailure(error, definition.riskClass, executionStarted),
    );
    // 账本与 SSE 走映射后的既有词，模型拿精确词——理由见 companionToolFailureFaces。
    await updateToolCall(event, operationCallId, { status: failure.ledgerStatus, safeSummary: failure.safeSummary });
    await appendAgentEvent(event, "agent.tool", {
      tool: {
        toolCallId: operationCallId,
        name: definition.name,
        toolVersion: definition.toolVersion,
        riskClass: definition.riskClass,
        status: failure.ledgerStatus,
        safeLabel: COMPANION_AGENT_TOOL_LABELS[definition.name] ?? definition.description.slice(0, 240),
        safeSummary: failure.safeSummary,
      },
    });
    await recordCompanionRunFailureSpanBestEffort({
      workspaceId: event.ctx.workspaceId,
      userId: event.read.userId,
      runId: args.runId,
    }, "tool");
    return {
      kind: "failure",
      ledgerStatus: failure.ledgerStatus,
      modelStatus: failure.modelStatus,
      safeSummary: failure.safeSummary,
    };
  }
}
