/**
 * API 进程内**唯一**的模型/语音外发边界。
 *
 * ## 为什么只有这一个出口
 *
 * 同意门、数据外发政策、PII 净化、审计行这四件事，如果每条外发路径各写一份，
 * 漂移的方向永远是"新加的那条没写"。所以这里把"准备"（查设置、过政策与 PII）
 * 和"结算"（写审计行）收成一对函数，底下挂两种媒介适配：
 *
 *   - **JSON**：文本模型调用（讲解、核查、评估、复核、主动生成）。
 *   - **媒介**：语音合成与语音识别。输入是文本或音频字节，输出是一条流或一段字节。
 *
 * 两种适配共用同一对准备/结算函数，所以"语音这条路忘了查同意"这种形状写不出来。
 * 公共政策与 PII 规则只在 `@astella/agent-host/ai-governance-policy` 里有一份，
 * 这里只做接线。
 *
 * ## 审计到底记什么
 *
 * 只记元数据：provider / model / operation / 内容类别 / 字节数 / 状态 / 耗时 / token。
 * **正文、音频、完整 URL、凭据一律不进审计行。** provider 记的是 host，不是路径。
 *
 * 语音路径的 `costTokens` 恒为 `null`：qwen / edge / SiliconFlow 这三个接口都不回
 * token 用量。写 0 会让"没报"和"真的没用"在图上长得一样，所以按**明确未知**记 null。
 *
 * 音频（ASR 的输入、TTS 的输出）**不声称做过文本 PII**：净化只作用于文本，
 * 字节流上跑的是同意/政策/大小这三件事。`prepareText` 只有真的要送文本时才调，
 * 于是"音频被文本 PII 处理过"这件事在类型上就不可能成立。
 *
 * ## 依赖方向：同意与审计是**注入进来的**，不是这里 import 的
 *
 * 这个文件住在 `lib/`（基础设施层），而"这个人同不同意、政策是什么、审计行写哪张表"
 * 是 **identity 域**的知识。此前它直接 `import ../modules/identity/ai-consent-service.ts`
 * 去拿那两个函数——依赖方向倒过来，于是基础设施层知道了领域层的存储形状。
 *
 * 现在这里只声明**两个端口**：
 *
 *   - `settings`：按 (workspaceId, userId) 读这一次的同意与数据外发政策；
 *   - `audit`：写一行只含元数据的审计记录。
 *
 * 实现由上层装配（`src/governance/ai-governance-runtime.ts`）在**一处**接上，
 * 每个调用点把它当依赖传进来。于是：
 *
 *   - `lib/` 不再依赖 `modules/`（依赖方向只朝下，`lib-layering-boundary-source-guard` 的 ③）；
 *   - **没有"没装配也能跑"的那一种形状**：两个端口在类型上就是必填的，
 *     真缺了也只会 fail closed（这一次外发直接不发），不会退化成"没同意也照发"。
 *
 * 算法没有搬家：同意门、政策门、PII 净化、审计行、未知用量（`null` 而非 0）与
 * 取消/错误/EOF 的结算口径，都还是下面这一份实现。
 */

import { normalizeWorkspaceAIPolicy, prepareGovernedAIPayload } from "@astella/agent-host";
import { assertOutsideRegisteredTransactions } from "@astella/shared/workspace-transaction";
import { postJsonToPublicEndpoint, type PublicJsonRequester } from "@astella/shared/public-json-http";
import { logger } from "./logger.ts";
import { PostgresRateLimitStore } from "./rate-limit-store.ts";

export interface ApiAICallScope { workspaceId: string; userId: string }

/**
 * 读到的同意与数据外发政策（**只读**，边界不改它）。
 *
 * 字段刻意与 identity 的存储形状解耦：这一层判断的是"有没有同意""政策允不允许发"，
 * 不是"用户表里怎么记的"。`systemUsesExternalAI()` 那类系统判据由读设置的一方负责，
 * 边界不需要知道——它只看得到期的 `consentAt` / `consentVersion`。
 */
export interface ApiAIPrivacySettings {
  consentAt?: Date | null;
  consentVersion?: string | null;
  dataPolicy?: {
    sendToExternal?: boolean;
    sendImageContent?: boolean;
    piiDetection?: boolean;
    auditLogging?: boolean;
  };
}

export type ApiAIPrivacySettingsReader = (
  workspaceId: string,
  userId: string,
) => Promise<ApiAIPrivacySettings | null | undefined>;

/**
 * 一行审计。**只有元数据**：正文、音频、完整 URL、凭据都不进这里（见文件头）。
 *
 * `actorUserId` 必填：审计表有租户守卫与插入者守卫，没有归属的行等于没有记录。
 *
 * 写成 type 而不是 interface：类型别名会带上隐式索引签名，于是
 * "拿 `Record<string, unknown>` 接行的"那种测试替身仍能接上（它们只是在读字段）。
 */
export type ApiAIAuditRow = {
  workspaceId: string;
  actorUserId: string;
  provider: string;
  modelId: string;
  operation: string;
  dataCategories?: string[];
  dataSizeBytes?: number | null;
  costTokens?: number | null;
  durationMs?: number | null;
  status?: string;
  errorMessage?: string | null;
};

export type ApiAIAuditWriter = (row: ApiAIAuditRow) => Promise<void>;

export interface ApiAIGovernanceDependencies {
  /** 读同意与数据外发政策。**必填**：没有它就没有门。 */
  settings: ApiAIPrivacySettingsReader;
  /** 写审计行。**必填**：没有它就没有可追溯的记录。 */
  audit: ApiAIAuditWriter;
  /** 可信宿主端口（显式注入，测试用）。缺省是带 SSRF 守卫的共享 transport。 */
  requester?: PublicJsonRequester;
  /** 配额预留。缺省是按账号分桶的持久化限流。 */
  reserveCall?: (scope: ApiAICallScope, signal?: AbortSignal) => Promise<void>;
}

const modelCallQuota = new PostgresRateLimitStore();
async function reserveApiModelCall(scope: ApiAICallScope, signal?: AbortSignal): Promise<void> {
  for (const [window, windowMs, limit] of [["minute", 60_000, 30], ["hour", 3_600_000, 120]] as const) {
    signal?.throwIfAborted();
    const entry = await modelCallQuota.increment(`ai-model:${scope.userId}:${window}`, windowMs, Date.now());
    if (entry.count > limit) throw Object.assign(new Error("这段时间的 AI 调用已较多，请稍后继续；已有成果保留。"),
      { code: "AI_CALL_RATE_LIMITED", statusCode: 429 });
  }
}

export type ApiAICallStatus = "success" | "error" | "cancelled";

interface GovernedCallPlan {
  scope: ApiAICallScope;
  operation: string;
  context: { consentOk: boolean; policy: ReturnType<typeof normalizeWorkspaceAIPolicy> };
  categories: readonly string[];
  startedAt: number;
  /** 这一次外发实际送出去多少字节（准备阶段能确定的先记下）。 */
  bytes: number;
  /** 审计写入器：准备阶段解析一次，之后每一次结算都用同一份。 */
  audit: ApiAIAuditWriter;
}

/**
 * 取两个端口，并且**只在这一处**判它们真的在。
 *
 * 类型上它们是必填的，但"必填"在 `as any`、在 JS 调用方那里都不作数。缺端口时唯一
 * 正确的后果是**这一次外发直接不发**（fail closed），绝不能是"没查同意也照发"——
 * 那正是 `settings` 曾经是可选项时最危险的形状。
 */
function portsOf(dependencies: ApiAIGovernanceDependencies | undefined): {
  settings: ApiAIPrivacySettingsReader; audit: ApiAIAuditWriter;
} {
  const settings = dependencies?.settings;
  const audit = dependencies?.audit;
  if (typeof settings !== "function" || typeof audit !== "function") {
    throw new Error(
      "AI governance is not assembled: 查同意与写审计的实现必须由上层装配后注入（governance/ai-governance-runtime.ts）",
    );
  }
  return { settings, audit };
}

/**
 * 唯一"准备"：核对真实身份 → 查同意与数据外发政策 → 核不在事务里。
 *
 * 这里**不做** PII 净化——净化要针对具体载荷（JSON 是整个对象，语音是那段文本），
 * 由适配器在拿到载荷之后调 `prepareGovernedAIPayload`。政策与同意不依赖载荷，
 * 所以放在这一处，六条路径一次都跑不掉。
 */
async function prepareGovernedCall(
  scope: ApiAICallScope,
  operation: string,
  dataCategories: readonly string[],
  dependencies: ApiAIGovernanceDependencies,
): Promise<GovernedCallPlan> {
  assertOutsideRegisteredTransactions({ boundary: "API AI provider call", caller: operation });
  if (!scope.userId || !scope.workspaceId) throw new Error("AI call requires workspace and initiating user");
  const ports = portsOf(dependencies);
  const settings = await ports.settings(scope.workspaceId, scope.userId);
  return {
    scope,
    operation,
    context: {
      consentOk: !!(settings?.consentAt && settings.consentVersion),
      policy: normalizeWorkspaceAIPolicy(settings?.dataPolicy),
    },
    categories: dataCategories,
    startedAt: performance.now(),
    bytes: 0,
    audit: ports.audit,
  };
}

/** 唯一"结算"：写审计行。失败不阻塞主流程，也绝不抛回给调用方。 */
async function settleGovernedCall(
  plan: GovernedCallPlan,
  outcome: {
    provider: string;
    modelId: string;
    status: ApiAICallStatus;
    durationMs?: number;
    /** 上游真的报了 usage 才给；没有就是 `null`（明确未知），不是 0。 */
    costTokens?: number | null;
    errorCode?: string | null;
  },
): Promise<void> {
  if (!plan.context.policy.auditLogging) return;
  try {
    await plan.audit({
      workspaceId: plan.scope.workspaceId,
      actorUserId: plan.scope.userId,
      provider: outcome.provider,
      modelId: outcome.modelId,
      operation: plan.operation,
      dataCategories: [...plan.categories],
      dataSizeBytes: plan.bytes > 0 ? plan.bytes : null,
      costTokens: outcome.costTokens ?? null,
      durationMs: outcome.durationMs ?? Math.round(performance.now() - plan.startedAt),
      status: outcome.status,
      errorMessage: outcome.errorCode ?? null,
    });
  } catch {
    logger.error({ operation: plan.operation }, "failed to record API AI call audit");
  }
}

/**
 * 只留一个**稳定的机器码**，不写 provider 的原始 message。
 *
 * 原始 message 里出现过的真实东西：完整请求 URL（含 query 里的签名）、Bearer 凭据、
 * 偶尔还有被拒请求的回显正文。`ai_audit_log` 是合规表，不是错误日志——
 * 这些内容进了它，审计本身就成了泄漏源。
 * 取不到短机器码就什么都不写：那一格空着，比写一段可能带正文的话安全。
 */
function stableErrorCode(error: unknown): string | null {
  const candidates = [
    (error as { code?: unknown } | null)?.code,
    (error as { name?: unknown } | null)?.name,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(candidate)) return candidate;
  }
  return null;
}

/** 从响应里读真实 token 用量：先 total，否则 prompt+completion，两者都没有就是 null。 */
function usageTokensOf(body: unknown): number | null {
  const usage = (body as { usage?: { total_tokens?: unknown; prompt_tokens?: unknown; completion_tokens?: unknown } } | null)?.usage;
  const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
  if (finite(usage?.total_tokens)) return usage.total_tokens;
  if (finite(usage?.prompt_tokens) && finite(usage?.completion_tokens)) return usage.prompt_tokens + usage.completion_tokens;
  return null;
}

/** 从载荷里读出这次用的是哪个模型；读不到就如实记 unspecified，不猜。 */
function modelIdOf(payload: Record<string, unknown>): string {
  return typeof payload.model === "string" ? payload.model : "unspecified";
}

/** A scoped transport adapter; retry, timeout and commit remain in the shared task runtime. */
export function createGovernedApiRequester(scope: ApiAICallScope, operation: string,
  dataCategories: readonly string[], dependencies: ApiAIGovernanceDependencies): PublicJsonRequester {
  return async (url, headers, payload, signal) => {
    const plan = await prepareGovernedCall(scope, operation, dataCategories, dependencies);
    // Provider is the public endpoint host; credentials and full URLs never enter audit metadata.
    const provider = new URL(url).hostname;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("AI payload must be a structured object");
    const input = payload as Record<string, unknown>;
    const sanitized = prepareGovernedAIPayload({ context: plan.context, workspaceId: plan.scope.workspaceId,
      providerName: provider, dataCategories, payload: input });
    plan.bytes = Buffer.byteLength(JSON.stringify(sanitized));
    let status: ApiAICallStatus = "error";
    let costTokens: number | null = null;
    let errorCode: string | null = null;
    try {
      signal?.throwIfAborted();
      await (dependencies.reserveCall ?? reserveApiModelCall)(scope, signal);
      signal?.throwIfAborted();
      const response = await (dependencies.requester ?? postJsonToPublicEndpoint)(url, headers, sanitized, signal);
      status = response.status >= 200 && response.status < 300 ? "success" : "error";
      costTokens = usageTokensOf(response.body);
      return response;
    } catch (error) {
      status = signal?.aborted ? "cancelled" : "error";
      errorCode = stableErrorCode(error);
      throw error;
    } finally {
      // 这里 await：JSON 路径的调用方本来就在等一个返回值，顺带把审计落库等完，
      // "结局"才不会因为 fire-and-forget 而丢在进程退出的那一瞬间。
      await settleGovernedCall(plan, { provider, modelId: modelIdOf(input), status, costTokens, errorCode });
    }
  };
}

// ─── 媒介适配（语音合成 / 语音识别）──────────────────────────────────────────

/** 一次外发最终是哪种结局：正常读到结尾、中途出错、或被上游/客户端取消。 */
export interface GovernedMediaOutcome {
  provider: string;
  modelId: string;
  status: ApiAICallStatus;
  /** 只用来取稳定机器码；原始 message 不进审计行。 */
  error?: unknown;
}

/**
 * 一次媒介外发的治理句柄。
 *
 * 句柄是**一次外发一份**：qwen 失败降级 edge 是两次真实外发，也就两个句柄、两条审计。
 * 缓存命中（伴星段预热）根本不会造出句柄，所以缓存不制造第二次调用。
 *
 * `settle` 只会生效一次：流式路径上 EOF / error / cancel 三条线都可能先到，
 * 而"一次外发一条审计"是这条边界最要紧的不变量。
 */
export interface GovernedMediaCall {
  readonly scope: ApiAICallScope;
  readonly operation: string;
  /**
   * 净化后的文本，**必须**把它真正传给 provider。
   * 返回净化结果而不是就地改写调用方的变量：让"算了净化却没送净化后的那份"
   * 这件事在调用点上看得见。
   */
  prepareText(text: string, provider: string): string;
  /** 记这一次送出去多少字节（ASR 的音频输入、流式之前已知的部分）。 */
  noteBytes(bytes: number): void;
  /** 非流式的一次性外发：成功 / 失败 / 取消各自结算恰好一次。 */
  run<T>(input: { provider: string; modelId: string }, fn: () => Promise<T>): Promise<T>;
  /** 流式外发：把上游流包成「读到 EOF / 出错 / 被取消 才结算」的流。 */
  trackStream(stream: ReadableStream<Uint8Array>, input: { provider: string; modelId: string }): ReadableStream<Uint8Array>;
  /**
   * 开一条流式外发：成功只代表"拿到了上游连接"，**不代表这一次完成**。
   *
   * 失败在这里结算一次；成功把跟踪挂到流上，之后由 EOF / 出错 / 取消各自结算。
   * 把这两件事放进同一个方法，是因为"拿到流就记成功"恰恰是流式路径最容易写出的
   * 形状——响应头都发出去了，用户一个字都还没听到。
   */
  openStream<T extends { stream: ReadableStream<Uint8Array> }>(
    input: { provider: string; modelId: string },
    open: () => Promise<T>): Promise<Omit<T, "stream"> & { stream: ReadableStream<Uint8Array> }>;
  /** 直接结算（上层已经自己掌握结局时用）。重复调用会被忽略。 */
  settle(outcome: GovernedMediaOutcome): void;
}

/**
 * 媒介外发的治理出口。
 *
 * `dataCategories` 由调用点按**真实送出去的内容**声明（合成送文本、识别送音频）。
 * 注意这里没有 `provider`/`modelId` 参数：TTS 的模型取决于这次用哪个引擎、
 * ASR 的模型可能来自 workspace policy，那都是**每一次**才知道的事，
 * 放到结算时再给才不会把上一个引擎的模型写进这一条的审计。
 */
export async function createGovernedMediaCall(
  scope: ApiAICallScope,
  operation: string,
  dataCategories: readonly string[],
  dependencies: ApiAIGovernanceDependencies,
): Promise<GovernedMediaCall> {
  const plan = await prepareGovernedCall(scope, operation, dataCategories, dependencies);
  let settled = false;

  /**
   * 同意门 + 外发政策门。**每一次真实外发之前都要过一遍，不给调用方跳过的口子。**
   *
   * 载荷是空的：音频字节没有文本形态，PII 扫描对它不成立——扫一个空对象等于什么都没扫，
   * 这一步只过同意与外发政策两关。这里不假装"音频做了文本 PII"。
   * 但门本身必须跑到：`sendToExternal=false` 或没同意时，音频一次都不该发出去。
   */
  const gate = (provider: string): void => {
    prepareGovernedAIPayload({ context: plan.context, workspaceId: scope.workspaceId,
      providerName: provider, dataCategories, payload: {} });
  };

  const settleOnce = (outcome: GovernedMediaOutcome): Promise<void> => {
    if (settled) return Promise.resolve();
    settled = true;
    return settleGovernedCall(plan, { provider: outcome.provider, modelId: outcome.modelId,
      status: outcome.status, errorCode: stableErrorCode(outcome.error ?? null) });
  };

  const trackStream = (stream: ReadableStream<Uint8Array>, input: { provider: string; modelId: string }) => {
    const reader = stream.getReader();
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            // 读到 EOF 才算这一次真的完成：拿到流、写出响应头都还什么都没发生。
            void settleOnce({ ...input, status: "success" });
            controller.close();
            return;
          }
          if (value) controller.enqueue(value);
        } catch (error) {
          // 流上不能 await（会把音频管线卡在审计落库上），但结局不丢：
          // settleOnce 只生效一次，内部吞掉写库失败。
          void settleOnce({ ...input, status: isCancellation(error) ? "cancelled" : "error", error });
          controller.error(error);
        }
      },
      async cancel(reason) {
        // 客户端打断（`req.raw.on("close")` → 销毁管线）会走到这里。
        // 取消是一次真实结局，它必须被记账，不能悄悄消失。
        void settleOnce({ ...input, status: "cancelled" });
        await reader.cancel(reason).catch(() => undefined);
      },
    });
  };

  const handle: GovernedMediaCall = {
    scope,
    operation,
    prepareText(text, provider) {
      const sanitized = prepareGovernedAIPayload({ context: plan.context, workspaceId: scope.workspaceId,
        providerName: provider, dataCategories, payload: { text } });
      const out = String(sanitized.text ?? "");
      plan.bytes += Buffer.byteLength(out, "utf8");
      return out;
    },
    noteBytes(bytes) {
      plan.bytes += bytes;
    },
    async run(input, fn) {
      gate(input.provider);
      // 合成出去的只有那段文本（`prepareText` 已记），音频是**回来**的东西，
      // 不算外发字节；识别送出去的是音频（调用前 `noteBytes` 已记）。
      // 所以这里不碰 `plan.bytes`：把回程音频算成"送出去"，审计那一格就反了。
      try {
        const value = await fn();
        await settleOnce({ ...input, status: "success" });
        return value;
      } catch (error) {
        await settleOnce({ ...input, status: isCancellation(error) ? "cancelled" : "error", error });
        throw error;
      }
    },
    async openStream<T extends { stream: ReadableStream<Uint8Array> }>(
      input: { provider: string; modelId: string },
      open: () => Promise<T>,
    ) {
      gate(input.provider);
      let result: T;
      try {
        result = await open();
      } catch (error) {
        await settleOnce({ ...input, status: isCancellation(error) ? "cancelled" : "error", error });
        throw error;
      }
      // 原样带回上游结果（contentType 等字段照旧可用），只把流换成被跟踪的那一条。
      return { ...result, stream: trackStream(result.stream, input) };
    },
    trackStream,
    settle(outcome) { void settleOnce(outcome); },
  };
  return handle;
}

/** 取消的判定：AbortError，或调用方已经把信号按下去了。 */
function isCancellation(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === "AbortError"
    || ["ABORT_ERR", "CANCELLED"].includes(String((error as { code?: unknown } | null)?.code));
}
