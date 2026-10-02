/**
 * 流中提前派发（40b §4.1-1，R7，验收 A58 / A75 / A76）。
 *
 * ## 这一层解决什么
 *
 * 现在一轮里的工具调用是**全部吐完再执行**：provider 流结束 → 合并分片 →
 * 依次执行。模型想 3 段、工具只要 0.5 秒时，那 0.5 秒被白白压在生成之后。
 *
 * 提前派发要在这中间插一段：某个调用**一旦可以确认完整**，就先写账本、再执行，
 * 不等后面的调用。合同给的前置条件是硬的：
 *
 * > 「provider 有可识别的完成事件且参数完整合法；**不能从流式 JSON 片段、猜测调用名
 * > 或越过输出序号缺口执行**。」
 *
 * ## 为什么"完成事件"在这里只能是**顺序**，不是 provider 的标记
 *
 * OpenAI 兼容协议没有"第 N 个工具调用已完成"这种事件：`finish_reason` 是**整步**
 * 的，出现在流末尾。可用的可靠信号只有一条——**provider 按 index 顺序吐**。
 * 于是：
 *
 *   第 N 个调用可执行 ⇔ 第 N+1 个调用**已经开始吐字**
 *
 * 因为一旦 N+1 开始了，N 就不会再有分片。这不是猜测，是协议给的顺序保证。
 * 反过来，第 N 个调用在流末尾之前**永远不可执行**——那正好等价于现在的行为，
 * 也就是说本模块在没有收益的形状上退化成原样，而不是猜着跑。
 *
 * ## 三条不许越过的线（合同原话）
 *
 * 1. **参数没解析完就不派。** `arguments` 必须是完整 JSON；半截 JSON 解析失败
 *    或者解析出来不是对象，都判不可派（A75）。
 * 2. **序号有缺口就不派。** index 1 缺失而 index 2 出现时，不能先跑 index 2。
 * 3. **确认门之后的调用不得越过。** 一个 `requiresConfirmation` 的工具必须在
 *    提案流程里停住，它后面的调用不能抢在它前面执行（A58）。
 *
 * ## 这一批只放**只读**工具
 *
 * 合同：「第一批仅对无业务副作用、可取消的读取工具测收益。」
 * 提前派发的收益完全取决于"生成与执行重叠了多少时间"，而它引入的风险是
 * 「工具已经执行、但模型这一轮最终失败/被取消」。对读工具来说这个风险是
 * 可接受的（重读一次即可），对写工具不是。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ## ⚠️ **这一层已就位，接线尚未做**（别把它当成已经上线的能力）
 *
 * 已完成且已测：顺序/缺口/确认门/参数完整/只读白名单这五个判据，
 * 它们是提前派发里最容易错、又最难在真流里看出来的那部分。
 *
 * 已完成且已测（同样不依赖真流）：
 *
 *  - **分片累积与"够不够完整"**已经从 provider 的 SSE 循环里搬进
 *    `lib/providers/stream-tool-call-accumulator.ts`，并有单测。原来那段住在
 *    网络循环内部（**没有合成 SSE 的喂入夹具**），于是"半截参数会不会被当完整"
 *    只能等真 provider 接入才看得见；现在它是一条可断言的函数。
 *
 *  - `interruptedEagerCallStatus` —— 流中断时的结果配对：已执行的**保留**、
 *    未开始的写 `not_executed`、正在跑的写 `outcome_unknown`（合同 §4.1-1）。
 *    最后一档是提前派发**新引入**的处境：以前工具只在模型成功之后才执行，
 *    所以"跑了但没回执"不会发生。
 *  - `eagerCommitRecheck` —— 撤权/取消/租约丢失后的提交前复查（A76）。
 *    带副作用的一律落 `outcome_unknown`：**不假回滚**。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ## 剩下最后一步：怎么把它装到 runtime 上（形状已确认，不要重新推）
 *
 * 已就位并测过：判据五个、`onToolCallSettled`（真 provider + 合成 SSE）、
 * provider → 流式步骤 的转接、`EagerDispatchScheduler` 的排队/收口/配对。
 *
 * 装配点在 `companion-agent-runtime.ts` 的**工具步循环**里。三件事：
 *
 *  1. 步骤开始时（`persistStep` 之后，`stepId` 已就绪）建一个
 *    `EagerDispatchScheduler`，`decision.eligibleTools` 指向只读白名单。
 *  2. 把 `offer` 挂进 `runStreamingAgentStep` 的 `onToolCallSettled`；
 *    流结束后 `await scheduler.close(被中断)` —— 收口必须 await，它要等在途。
 *  3. **`dispatch` 要复用循环里那条「落账本 → 执行 → 写终态」的链**。
 *
 * ### 为什么第 3 条是唯一的真难点（这决定了该怎么做、别怎么做）
 *
 * 循环里那一步已经存在了：调 `ensureAgentToolCall` 拿 `record`，
 * `replayable === false`（已有终态）就重发事件、推 tool 消息、**直接 `continue`
 * 而不执行**。所以提前派发只要把终态写进账本，循环自然就不会重跑它——
 * **不需要新写一条"跳过"分支**，那反而危险（跳过漏了 tool 消息，
 * 下一次请求会被 provider 拒）。
 *
 * 真正要做的只有一件：把「落账本 → 执行 → 写终态」那一段从循环里**抽成
 * 一个函数**，让循环和 `dispatch` 共用它。这是一处 ~100 行的搬移，
 * 落点在 `companion-agent-runtime.ts` 的 `for (const call of calls)` 体内。
 *
 * 搬完之后的验收（这几条不查等于没做）：
 *  - 全量 worker 测试无新增红（循环那条老路必须逐字不变）；
 *  - 用真库跑一轮带**两个只读工具**的对话，确认账本里每个 tool_call_id
 *    **只有一行**，且 `tool` 消息条数与调用数一致（多一条就是跑了两遍）；
 *  - 断流一次，确认已执行的那条回执是 `succeeded` 而不是 `not_executed`。
 *
 * ### 为什么这一段至今没搬
 *
 * 它落在每一轮对话的每一次工具调用上，而本仓**没有能跑这条链的真库夹具**。
 * 搬错了不报错，只在真机表现为「工具不执行」或「跑两遍」——
 * 而"跑两遍"对写工具就是重复提交。
 *
 * 按 §4.3，R7 是「无收益就撤回」的优化：收益（p95／成本／取消率／故障目标）
 * 在本环境**测不出来**，所以它此刻的正确状态就是默认关闭。
 *
 * 收益本身也需要实测：§4.3 要求「预先声明质量、p95、成本、取消率与故障目标」
 * 并「无收益或等待不合格就撤回」。本仓没有真 provider 流可跑，所以**收益未知**，
 * 按合同它此刻的正确状态是**默认关闭**。
 * ─────────────────────────────────────────────────────────────────────
 */

/** 一个流中累积到一半的工具调用槽（与 provider 的归并形状一致）。 */
export interface StreamToolCallSlot {
  index: number;
  id: string;
  name: string;
  /** 逐片拼接的 arguments 文本，**可能**是半截 JSON。 */
  argsText: string;
}

export type EagerIneligibleReason =
  /** 分片还没收完：N+1 还没开始，N 理论上还可能有分片。 */
  | "awaiting_later_index"
  /** arguments 解析不成完整 JSON（A75：不能从流式片段猜参数）。 */
  | "arguments_incomplete"
  /** arguments 解析出来不是对象。 */
  | "arguments_not_object"
  /** provider 没给调用名（只给了 index 与参数）——不猜。 */
  | "missing_name"
  /** 序号有缺口：前面还有没到的 index。 */
  | "index_gap"
  /** 这一批只放行白名单里的只读工具。 */
  | "tool_not_eligible";

export type EagerDispatchDecision =
  | { ready: true; index: number; name: string; arguments: Record<string, unknown> }
  | { ready: false; index: number; reason: EagerIneligibleReason };

export interface EagerDispatchOptions {
  /** 本批允许提前执行的白名单（**只读**工具）。 */
  eligibleTools: ReadonlySet<string>;
  /** 流是否已结束。结束时最后一个槽子也变成"确定完整"。 */
  streamFinished?: boolean;
  /** 已确认用户授权的工具：确认门之后的调用不得越过。 */
  requiresConfirmation?: (name: string) => boolean;
}

/**
 * 判断每个槽此刻**能不能**提前执行。
 *
 * 纯函数：只吃累积槽与三个开关，不碰 IO、不碰时钟。顺序、缺口与确认门
 * 三件事都在这里判定，所以它们能被穷举着测——而这三样恰好是提前派发
 * 最容易出错、错了又最难在真流里看出来的地方。
 */
export function eagerDispatchDecisions(
  slots: readonly StreamToolCallSlot[],
  options: EagerDispatchOptions,
): EagerDispatchDecision[] {
  const byIndex = new Map(slots.map((slot) => [slot.index, slot]));
  const indices = [...byIndex.keys()].sort((a, b) => a - b);
  const decisions: EagerDispatchDecision[] = [];

  // 确认门：第一个需要用户确认的工具之后，全部不得越过（A58）。
  const barrierIndex = indices.find((index) => {
    const slot = byIndex.get(index);
    return slot?.name ? (options.requiresConfirmation?.(slot.name) ?? false) : false;
  });

  // 序号缺口：0..max 里缺的那一个，**后面的一律不得越过**。
  //
  // 为什么必须这样：`awaiting_later_index` 这条判据说的是"下一个开始 ⇒ 我完了"。
  // 有缺口时那个"下一个"是缺的，我们并不知道缺口里会吐出什么——可能是一个
  // `requiresConfirmation` 的工具。按顺序把 2 派出去，就等于赌缺口里是空的。
  const maxIndex = indices.length > 0 ? indices[indices.length - 1] : -1;
  let firstHole = -1;
  for (let i = 0; i <= maxIndex; i += 1) {
    if (!byIndex.has(i)) { firstHole = i; break; }
  }

  for (const index of indices) {
    const slot = byIndex.get(index)!;

    // 缺口与屏障都用 index_gap 这一档：两者的后果一样——"不能越过它"。
    // 它们不是同一件事，但把原因拆成两个词并不会让任何调用方更聪明。
    if (firstHole !== -1 && index > firstHole) {
      decisions.push({ ready: false, index, reason: "index_gap" });
      continue;
    }
    if (barrierIndex !== undefined && index > barrierIndex) {
      decisions.push({ ready: false, index, reason: "index_gap" });
      continue;
    }
    if (!slot.name) {
      // provider 没给名字就不猜（A58：「不能猜测调用名」）。
      decisions.push({ ready: false, index, reason: "missing_name" });
      continue;
    }
    if (!options.eligibleTools.has(slot.name)) {
      decisions.push({ ready: false, index, reason: "tool_not_eligible" });
      continue;
    }
    // 参数必须完整：半截 JSON 会解析失败，而"解析失败"与"参数确实坏"在这
    // 一层分不开，所以统一先判不可派（A75）。
    let parsed: unknown;
    try {
      parsed = JSON.parse(slot.argsText);
    } catch {
      decisions.push({ ready: false, index, reason: "arguments_incomplete" });
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      decisions.push({ ready: false, index, reason: "arguments_not_object" });
      continue;
    }

    // 顺序保证：N+1 已经开始 ⇒ N 不会再有分片。
    const laterStarted = indices.some((other) => other > index && byIndex.get(other)!.argsText.length > 0);
    if (!laterStarted && options.streamFinished !== true) {
      decisions.push({ ready: false, index, reason: "awaiting_later_index" });
      continue;
    }

    decisions.push({
      ready: true,
      index,
      name: slot.name,
      arguments: parsed as Record<string, unknown>,
    });
  }
  return decisions;
}

/**
 * 把这一轮**已经可以派**的调用按 index 顺序交出去。
 *
 * 顺序必须与模型发出的顺序一致：调用结果要按顺序回到模型的 tool 消息里，
 * 乱序会让模型读到"第二条的结果在第一条之前"。
 */
export function dispatchableCalls(
  decisions: readonly EagerDispatchDecision[],
): Extract<EagerDispatchDecision, { ready: true }>[] {
  return decisions
    .filter((decision): decision is Extract<EagerDispatchDecision, { ready: true }> => decision.ready)
    .sort((a, b) => a.index - b.index);
}

/** 一个提前派发的调用在中途的状态。 */
export type EagerCallPhase =
  | "pending"        // 已确定完整、正在执行
  | "executed"       // 执行完成、结果已配对
  | "not_started"    // 还没开始就被打断
  | "outcome_unknown"; // 可能执行了、但拿不到确定回执

/**
 * 流被中断时，一次**提前派发**的调用该怎么结账（40b §4.1-1 / A58）。
 *
 * 合同原话：「回执落存与调用配对；流中断**保留已经执行的结果，未开始写
 * not_executed，可能执行但不确定写 outcome_unknown**。」
 *
 * 为什么要单列这一档：提前派发把"模型这一轮最终失败"与"工具已经跑了"这两件事
 * **解耦**了。以前不会发生——工具只在模型这一轮成功之后才执行。现在会发生，
 * 于是必须有一档专门说"它可能做过了，但我们没有回执"。
 *
 * 绝不能把它算成 `not_executed`：那个词告诉用户「没发生」，而用户据此再操作
 * 一次，就是一次重复提交。
 */
export function interruptedEagerCallStatus(
  phase: EagerCallPhase,
  streamInterrupted: boolean,
): "succeeded" | "not_executed" | "outcome_unknown" {
  if (!streamInterrupted) {
    if (phase === "executed") return "succeeded";
    // ⚠️ `outcome_unknown` **不**因为流没断就降成 `not_executed`。
    // 它的含义是"跑了、但没拿到确定回执"——那与流断不断流毫无关系。
    // 早先这里写成 `phase === "executed" ? "succeeded" : "not_executed"`，
    // 于是派发抛错的一律被报成"没发生"，而用户会据此再操作一次：重复提交。
    // 这条是被 companion-eager-scheduler 的那条用例逮住的。
    if (phase === "outcome_unknown") return "outcome_unknown";
    return "not_executed";
  }
  switch (phase) {
    case "executed":
      // 已经执行完、结果已配对：**保留**。丢掉等于让用户以为没发生过。
      return "succeeded";
    case "pending":
      // 正在跑，结果未知 —— 可能已经落库了。
      return "outcome_unknown";
    case "not_started":
      return "not_executed";
    case "outcome_unknown":
      return "outcome_unknown";
  }
}

/**
 * 提前派发之后、提交之前的一次复查（A76）。
 *
 * 合同原话：「提前派发后权限撤销/取消/租约丢失 → 提交前复查；**未提交不再写**，
 * 可能已有副作用时核对并标未知，**不假回滚**。」
 *
 * `hasSideEffect` 指这一次调用会不会改动外部状态。只读调用撤销之后直接不提交
 * 就行；带副作用的不能"假装没发生"，必须落 `outcome_unknown` 让上层去核对。
 */
export function eagerCommitRecheck(input: {
  revoked: boolean;
  cancelled: boolean;
  leaseLost: boolean;
  hasSideEffect: boolean;
}): { commit: boolean; status: "succeeded" | "not_executed" | "outcome_unknown" } {
  const blocked = input.revoked || input.cancelled || input.leaseLost;
  if (!blocked) return { commit: true, status: "succeeded" };
  if (!input.hasSideEffect) {
    // 只读调用：还没提交就不再写。它本来也没改过任何东西。
    return { commit: false, status: "not_executed" };
  }
  // 带副作用：可能已经发生了一部分。**不假回滚** —— 那是比"状态不准"更重的错。
  return { commit: false, status: "outcome_unknown" };
}
