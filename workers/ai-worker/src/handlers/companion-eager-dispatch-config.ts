/**
 * 提前派发**默认关闭**的开关，以及"哪些工具可以提前跑"的白名单。
 *
 * ## 为什么开关在这儿，而不在合同里
 *
 * 40b §4.3 说得很直接：**无收益或等待不合格就撤回**。而收益（p95／成本／
 * 取消率／故障目标）必须实测才能知道，实测需要真实 provider 流与真实数据库。
 *
 * 所以它此刻的正确状态是**关闭**：代码在路���上、判据都测过了，但没人量过它
 * 值多少钱。开关放在环境变量上，是为了让"开"这件事必须是一个**明确的、
 * 有日期的决定**，而不是某次顺手改的默认值。
 *
 * ## 白名单为什么只有这三个
 *
 * 40b §4.1-1：「第一批仅对**无业务副作用、可取消的读取工具**测收益。」
 *
 * 提前派发的风险是「工具已经执行、但模型这一轮最终失败/被取消」。对读工具
 * 这个风险可接受（重读一次即可），对写工具不是——所以白名单里**没有**
 * 任何 `save_*` / `forget_*` / `move_*` / `revise_*`。新增工具进白名单必须
 * 单独判断它有没有副作用，不能"看着像读的就放进去"。
 */

/**
 * 提前派发是否开启。**默认关闭。**
 *
 * 读一次环境变量并缓存：这个值在一轮里必须是稳定的，否则同一轮的前后两步
 * 可能走不同的路径，而那种分叉在日志里看不出来。
 */
export const EAGER_TOOL_DISPATCH_ENABLED: boolean =
  process.env.COMPANION_EAGER_TOOL_DISPATCH === "1";

/**
 * 可提前派发的**只读**工具。
 *
 * ⚠️ 这不是"所有 riskClass=read 的工具"——`getCompanionAgentTool` 里的
 * `read` 是**风险档**，而 §4.1-1 要的是"无业务副作用"。`companion_read_context`
 * 会去读空间里的笔记，只读但**要付费**（provider 往返）；这里只放不需要
 * 再发一次模型请求的那几个。
 */
export const EAGER_DISPATCH_ELIGIBLE_TOOLS: ReadonlySet<string> = new Set([
  "companion_read_memory",
  "companion_recall_memory",
  "companion_read_playbook",
  "companion_read_diary",
]);


import {
  ensureAgentToolCall,
} from "./companion-tool-call-ledger.ts";
import { getCompanionAgentTool, validateCompanionAgentToolArguments } from "@ailearn/shared";
import { runCompanionToolExecution } from "./companion-tool-execution-run.ts";
import type { AgentEventContext } from "./companion-read-tools.ts";
export type { StreamToolCallSlot } from "./companion-eager-dispatch.ts";
import type { StreamToolCallSlot } from "./companion-eager-dispatch.ts";
import { canonicalJsonV1, sha256Utf8V1 } from "@ailearn/shared/content-hash";

/**
 * 提前派发**一格**工具：登记账本，然后跑**与循环同一份**执行段。
 *
 * ## 为什么是这三步，顺序不能换
 *
 *  1. `ensureAgentToolCall` —— 40b §4.1-1「工具**先登记到持久 ledger**」。
 *     这一步必须是第一��：它返回的 `toolCallId` 是账本里的 id，而 SSE 事件与
 *     执行都按那个 id 写。晚一步，账本里就少这一行。
 *
 *  2. 参数校验 —— provider 给的是**流式拼出来的文本**，不是已校验的值。
 *     这里必须重新过一遍 schema：调度判据只认「能解析成对象」，
 *     而「是对象」不等于「字段都对」。
 *
 *  3. `runCompanionToolExecution` —— 与工具步循环共用的那一份（§4.1-2 的
 *     abort 传播、超时预算、失败终结都在里面）。**不做第二份**。
 *
 * ## 失败为什么不抛
 *
 * 抛出去会被 scheduler 记成 `outcome_unknown`，那是对的：工具可能已经部分执行。
 * 但账本与 SSE 事件必须已经写好——所以本函数**自己**先落终态再返回，
 * 让循环随后那次 `ensureAgentToolCall` 看到终态并走重放路径。
 */
export async function eagerDispatchOne(
  event: AgentEventContext,
  stepId: string,
  slot: StreamToolCallSlot,
  deadlineAt: number,
  args: {
    read: { runId: string; userId: string };
    ctx: { workspaceId: string };
    /**
     * 提交前的现查钩子（40b §4.1-1「提交前复查取消、租约、权限与内容版本」/ A76）。
     *
     * 抛错表示"这条现在不该提交"：调用方把它归成未执行或未知结果。
     * 不抛则照常提交。**默认没有这个钩子**——白名单里全是只读工具，
     * 读工具即使不提交也只是白读一次，所以早期版本没有它；接上之后
     * 撤权/租约丢失会真的把这一格挡在提交之外。
     */
    commitGuard?: () => Promise<void>;
  },
): Promise<unknown> {
  const definition = getCompanionAgentTool(slot.name);
  // 白名单之外或根本没注册：什么都不做。判据那边已经会拦住非白名单的，
  // 这里再挡一次是防止白名单与登记表漂移——那时宁可少跑一次。
  if (!definition) throw new Error(`eager dispatch: unknown tool ${slot.name}`);

  const parsedArgs = validateCompanionAgentToolArguments(slot.name, JSON.parse(slot.argsText));
  if (!parsedArgs.success) throw new Error(`eager dispatch: invalid arguments for ${slot.name}`);

  const serializedArgs = canonicalJsonV1(parsedArgs.data);
  const argsHash = sha256Utf8V1(serializedArgs);

  // ① 账本先行
  const record = await ensureAgentToolCall(
    event,
    stepId,
    definition,
    { id: slot.id, arguments: parsedArgs.data },
    argsHash,
    undefined,
  );
  const operationCallId = record.toolCallId;

  // 已经有终态（同一格里别的派发跑过了，或这是一次重放）：直接返回。
  if (record.status !== "requested" && record.status !== "executing") {
    return record.safeSummary ?? null;
  }

  // ② 提交前复查（A76）：在**登记之后、执行之前**再问一次。
  //    放在这里而不是执行之后，是因为读工具的"执行"就是"把读到的结果交出去"——
  //    那一刻才是不可回退的点（40b §4.1-1「未提交不再写」）。
  if (args.commitGuard) await args.commitGuard();

  // ③ 同一个执行段
  const run = await runCompanionToolExecution({
    event,
    definition,
    operationCallId,
    toolCallId: slot.id,
    arguments: parsedArgs.data,
    deadlineAt,
    signal: event.ctx.signal,
    runId: args.read.runId,
    logger: { warn: () => undefined },
  });

  // ④ 结局由账本承载，循环随后会重放；这里只把值还回去给 scheduler 记账。
  if (run.kind === "failure") throw new Error(run.safeSummary);
  // `waiting` 表示这一格要挂起整轮等用户确认。白名单里都是只读工具，正常走不到；
  // 真走到了就把提案 id 带回，账本与 SSE 事件已经由执行段写好了。
  if (run.kind === "waiting") return run.proposalId;
  return run.execution.value;
}
