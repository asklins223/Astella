import type { AgentTurnRequest, AgentTurnResult, ChatMessage } from "@ailearn/shared";
import type { AIProvider } from "../lib/ai-provider.ts";
import { runWithAbortBudget } from "../lib/handler-timeout.ts";
import { logger } from "../lib/logger.ts";
import { buildAgentTurnMessages } from "../lib/providers/json-response.ts";
import { createCompanionEnvelopeDecoder } from "./companion-dialogue-envelope.ts";
import { CompanionStreamStoppedError } from "./companion-dialogue-stream.ts";

/**
 * 单步的真实流式执行（2026-09-19 ④-b 起覆盖**每一步**，不再只是终答步）。
 *
 * 背景：此前只有终答步（无工具、`finalAnswerOnly`）走流式，理由是"带工具的前几步
 * 要的是结构化 tool_calls，自然文本流会丢掉工具协议"。于是带页面上下文的对话
 * （`learning-context`，`maxSteps=4`）因为"模型在第 1–2 步就作答、永远到不了最后一步"
 * 而**一次都不流式**——宠物位聊天能逐字出现，一带上下文就憋成一块。
 *
 * 现在：`chatCompletionStream` 一并解析 `delta.tool_calls`（协议里本来就有），
 * 所以每一步都能流式。由此产生的新问题是"已经发出去的可能是开场白"——这一步
 * 最终是工具调用，正文在下一轮。处理方式不是撤回（已提交的前缀不可撤回），
 * 而是**让开场白成为回复的一部分**：agent loop 把每一步的 content 按顺序拼成
 * 最终正文（见 joinVisibleSegmentsDeduped），流式前缀天然是它的前缀，硬约束
 * （`reconcileStreamedText`）不需要放宽。这也正是通用 agent 的行为——模型
 * 调用工具之前说的话本来就是展示给用户的。
 *
 * `separatorBefore` 是与拼接口径对齐的分段符：调用方按同一规则（非首段 "\n\n"）
 * 在最终正文里插入它，这里把它**随该段第一个文本增量一起**下发，保证
 * "已下发原文 == 最终正文的前缀"逐字节成立。该段一个字都没吐时不发（调用方也不拼）。
 *
 * 增量按链式排队交给 `onProviderDelta`（异步落库不阻塞 provider 的读取循环）；
 * 交付管线说"停"（校验失败/fence 失联/**落库链路抛错**）时中断底层请求并抛
 * `CompanionStreamStoppedError`，由调用方按失败收尾。
 *
 * 返回形状与 executeAgentTurn 对齐（含 toolCalls / finishReason），下游校验/落库
 * 逻辑不分叉。
 *
 * 导出仅为可测：不依赖 DB，provider/onProviderDelta 全部可注入（见
 * companion-agent-runtime.test.ts 的流式中止用例）。
 */
export async function runStreamingAgentStep(args: {
  provider: AIProvider;
  stepRequest: AgentTurnRequest;
  ctxSignal: AbortSignal;
  timeoutMs: number;
  onProviderDelta: (delta: string) => Promise<boolean>;
  /**
   * 流中**已完整**的工具调用（40b §4.1-1 / R7）。provider 每判定一格确定完整就调一次。
   *
   * 这一层**只做转发**，不执行任何东西：真正的派发在 runtime 那边（要落账本、要连库），
   * 而账本那一层在流还没结束时多半还拿不到最终结果。
   *
   * ⚠️ provider 侧**不 await** 这个回调（它在 SSE 读取循环里，await 会把流按停）。
   * 所以回调方自己负责排队：拿到一格就开始跑，跑完了在流结束时一并收结果。
   * 不传 ⇒ 与现在的行为逐字相同。
   */
  onToolCallSettled?: (slot: { index: number; id: string; name: string; argsText: string }) => void;
  /** 分段符（见上方说明）：非首段传 "\n\n"，首段传空串。 */
  separatorBefore?: string;
  /**
   * **真正下发给客户端之前**先攒够这么多字符（2026-09-20 坍缩闸）。
   *
   * 为什么必须攒：退化回复检测的判据之一是"这一步还没把字发给用户"（`!stepEmitted`），
   * 而流式路径只要吐过一个字就永远不满足——实机四条连续轮次落库正文是
   * `现在是`(3)/`今天`(2)/`最近`(2)/`你`(1)，全是流式，闸一次都没拦住。
   * 攒住之后：短到不值得发的整步一个字都不下发，闸可以安全地用思考档重跑；
   * 重跑不需要撤回任何东西，"已下发原文必须是最终正文前缀"这条硬约束原样成立。
   * 未放行时 `deliveredChars()===0`，交付管线自动走既有的整段补写 delta 分支。
   */
  holdUntilChars?: number;
  /** 本步**真正下发**了第一个字符时回调（不是"模型吐了字"，见 holdUntilChars）。 */
  onTextEmitted?: () => void;
}): Promise<AgentTurnResult> {
  const controller = new AbortController();
  const onCtxAbort = (): void => controller.abort();
  args.ctxSignal.addEventListener("abort", onCtxAbort, { once: true });
  const messages = buildAgentTurnMessages(args.stepRequest.systemPrompt, args.stepRequest.messages) as ChatMessage[];
  let stopped = false;
  let flushChain: Promise<void> = Promise.resolve();
  /**
   * 增量分发（2026-09-19 ④）。
   *
   * 主路径已经是**纯文本直通**（下面请求里传了 responseFormat="text"）：provider 给的
   * 增量就是正文，不需要任何解码。但"模型/网关自发把回复包成 JSON 信封"是实测发生过
   * 8 次的真实形态（且用户配置的 openai-compatible 端点不保证遵守 responseFormat），
   * 所以再做一层**头部嗅探**：
   * - sniffing：先攒头部，首个非空白字符不是 `{`/`[` → 纯文本直通；
   * - decoding：头部像信封 → 交给增量解码器即时剥壳；解不出形状就**一个字都不下发**，
   *   退化成整段下发，由下游的信封守卫 + 全文校验兜底（不会把 JSON 语法吐给用户）。
   */
  let mode: "sniffing" | "passthrough" | "decoding" = "sniffing";
  let sniffed = "";
  /** 头部快照上限：超过这么多字符还没出现 `{`/`[` 就认定是自然文本。 */
  const SNIFF_MAX_CHARS = 512;
  /**
   * 头部像 JSON 信封的判据（2026-09-19 收窄）。
   *
   * 初版只看首字符是否 `{`/`[`，于是**以 `[标签]` 开头的自然回复**（模型偶发吐
   * 表情/语气方括号，V4 人格禁止但小模型仍会自造）也被送进 JSON 信封解码器——
   * 解码器解不出形状时一个字都不下发，那一轮就会"缺头"。实机库里确有缺头的
   * 落库正文（`这么开心，是遇到什么有趣的事了吗？`、`呀。今天的学习状态怎么样？`），
   * 与"首字符是 `[`"这一条完全吻合。
   *
   * 真实信封只有两种开头：对象 `{`，对象/字符串数组 `[{` / `["` / `[["`。
   * 数组里不可能直接出现裸字母，所以 `[标签]`（`[` + 字母）天然被排除。
   */
  const JSON_ENVELOPE_HEAD = /^\s*(?:\{|\[\s*[{["\d-])/;
  const envelopeDecoder = createCompanionEnvelopeDecoder();
  /** 分段符只随本段第一个文本增量走；该段没有文本就整个不发。 */
  let pendingSeparator = args.separatorBefore ?? "";
  /** 阈值未达之前攒着的文本；一旦放行即清空并转为直通。 */
  let held = "";
  let released = (args.holdUntilChars ?? 0) <= 0;

  const emit = (text: string): void => {
    if (text.length === 0) return;
    if (!released) {
      held += text;
      if (held.length < (args.holdUntilChars ?? 0)) return;
      // 分隔符必须在**真正放行**的那一帧前面，且只加一次。
      text = pendingSeparator + held;
      pendingSeparator = "";
      held = "";
      released = true;
    }
    if (pendingSeparator.length > 0) {
      text = pendingSeparator + text;
      pendingSeparator = "";
    }
    // 注意：这一行现在代表"**第一个字符真的下发了**"，不是"模型吐了字"。
    // 重试安全性（canRetryStream）与坍缩闸（degenerate gate）都以它为准。
    args.onTextEmitted?.();
    flushChain = flushChain.then(async () => {
      if (stopped) return;
      const keepGoing = await args.onProviderDelta(text);
      if (!keepGoing) {
        stopped = true;
        controller.abort();
      }
    }).catch((err) => {
      // 落库链路抛错（fence 事务异常 / delta 对账 desync）：与"返回 false"
      // 同路处理——立即中断底层请求。此前该 rejection 只被链尾吞掉：后续增量
      // 继续被消费却不再落库，provider 白读到流尾，失败要等 finish() 再次
      // 抛错才暴露。这里记录原因后马上 abort，错误经既有
      // CompanionStreamStoppedError 路径按失败收尾。
      logger.warn(
        // 同 `streaming answer failed` 一族：传对象，否则真实类名/code 会被投影掉。
        { err },
        "companion stream flush rejected; aborting provider read",
      );
      stopped = true;
      controller.abort();
    });
  };

  const feedDecoder = (text: string): void => {
    for (const chunk of envelopeDecoder.push(text)) {
      if (chunk.kind === "text") emit(chunk.text);
    }
  };

  const consume = (delta: string): void => {
    if (mode === "passthrough") {
      emit(delta);
      return;
    }
    if (mode === "decoding") {
      feedDecoder(delta);
      return;
    }
    sniffed += delta;
    const head = sniffed.trimStart();
    if (head.length === 0) return;
    if (!JSON_ENVELOPE_HEAD.test(head)) {
      // 自然文本（含以 `[标签]` 开头的回复）→ 原样直通。
      mode = "passthrough";
      const buffered = sniffed;
      sniffed = "";
      emit(buffered);
      return;
    }
    if (head.length > SNIFF_MAX_CHARS && !/[}\]]/.test(head)) {
      // 又长又不见闭合：不是信封，按自然文本直通（否则会一直憋着不下发）。
      mode = "passthrough";
      const buffered = sniffed;
      sniffed = "";
      emit(buffered);
      return;
    }
    mode = "decoding";
    const buffered = sniffed;
    sniffed = "";
    feedDecoder(buffered);
  };

  try {
    const { content, toolCalls, finishReason } = await runWithAbortBudget(
      (signal) => args.provider.chatCompletionStream!(
        messages,
        {
          maxTokens: args.stepRequest.maxTokens,
          temperature: args.stepRequest.temperature,
          // 2026-09-19 ④ 修复：终答步明确要**自然文本**，不再强制 json_object。
          //
          // 曾经强制 JSON 是因为"用户消息是一整份 JSON 文档"，模型于是用文档回文档；
          // 输入改成原生多轮之后（T0）这个理由已经消失，而代价一直留着：
          // - 流式信封解码器只认 6 个正文键名（response/text/content/message/reply/answer），
          //   模型换个键（`{"emotion":"happy","reply":"…"}`）就判 unrecognized →
          //   整段守住不发 → 退化成"憋一大口再吐出来"（库里 30 个 run 里 28 个只有
          //   1 条 delta、时间跨度 0.00 秒）；
          // - 认不出→整段 JSON 落库→`json_envelope_leak` 成为失败原因第一名（8 次），
          //   且 11:49 那次"不再强制 json_object"只改了 executeAgentTurn，流式这条路没改。
          //
          // 改成纯文本后增量本身就是正文：不需要解码器、不存在认错键名的退化，
          // 且下游仍有两道防线（projectCompanionVisible 的信封守卫 + 全文校验）。
          responseFormat: "text",
          // ④-b：带工具的一步也必须把工具列表发出去，否则模型永远不返回 tool_calls。
          // 与 executeAgentTurn 的 body 完全同形（那里同样是 tools + tool_choice=auto、
          // 不传 response_format）。终答步的 tools 已在 stepRequest 里被清空。
          tools: args.stepRequest.tools,
          toolChoice: args.stepRequest.toolChoice,
          // 只在调用方要了的时候才挂：不挂就是 undefined，provider 不做任何额外工作。
          ...(args.onToolCallSettled
            ? { onToolCallSettled: (slot: { index: number; id: string; name: string; argsText: string }) => args.onToolCallSettled!(slot) }
            : {}),
        },
        signal,
        (delta) => {
          if (stopped || delta.length === 0) return;
          consume(delta);
        },
      ),
      controller.signal,
      args.timeoutMs,
    );
    await flushChain.catch(() => undefined);
    if (stopped) throw new CompanionStreamStoppedError("companion stream stopped by delivery pipeline");
    // 纯文本模式下 provider 累积的 content 就是正文。但如果这一轮走了信封解码
    // （头部嗅探判定为信封），解码结果就是**唯一事实来源**——它同时是已下发的
    // 前缀，下游 `reconcileStreamedText` 要求"最终正文以已下发内容开头"，
    // 返回原始 JSON 会把这个不变量交给 unwrap 的运气去赌。
    const decoded = envelopeDecoder.text();
    return {
      content: decoded.length > 0 ? decoded : content,
      toolCalls: toolCalls ?? [],
      finishReason: finishReason ?? "stop",
      usage: null,
      providerRequestId: null,
    };
  } catch (error) {
    await flushChain.catch(() => undefined);
    if (stopped && !(error instanceof CompanionStreamStoppedError)) {
      throw new CompanionStreamStoppedError("companion stream stopped by delivery pipeline");
    }
    throw error;
  } finally {
    args.ctxSignal.removeEventListener("abort", onCtxAbort);
  }
}
