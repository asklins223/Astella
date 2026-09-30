/**
 * 上游熔断器（2026-09-29，P0-14）。
 *
 * ## 为什么需要
 *
 * 审计结论：全仓 `grep circuit|breaker` **零命中**（唯一命中是制卡测试语料里的英文课文），
 * 也就是说外部模型调用**只有重试、没有熔断**。
 *
 * 现在的失败放大链是这样的：
 *   job 级退避（`2^attempts × jitter`，MAX_ATTEMPTS=3）
 *     → 每个 job 失败后重新排队
 *       → 上游已经挂了，但队列仍按节奏把请求一批批送出去
 *         → 每一次都等满 TOTAL_RESPONSE_TIMEOUT_MS 才失败
 *
 * 上游持续 5xx 或网络不通时，这等于用满配额的连接与 worker 时间去反复确认
 * "它确实还挂着"，而**本可以做一次快速失败**、把时间让给健康的上游与其它 job。
 *
 * ## 三态
 *
 *   closed    —— 正常放行；连续失败数达阈值 → open
 *   open      —— 直接抛 `CircuitOpenError`，**不发请求**；冷却期满 → half-open
 *   half-open —— 只放**一个**探测请求；它成功 → closed（并清零计数），
 *                它失败 → 立刻回 open（冷却重新计时）
 *
 * half-open 只放一个，是这一类实现最容易漏的点：放多个等于没有熔断，
 * 上游还没恢复就先被自己那批探测打死了。
 *
 * ## 什么算失败
 *
 * - **抛出的异常**（DNS 失败、连接被拒、TLS 错误、超时）—— 一定算。
 * - **HTTP 5xx 与 429** —— 算。它们是上游"现在不可用"的表达。
 * - **其他 4xx**（400/401/404/422…）—— **不算**。那是请求本身有问题，
 *   换一台上游、隔一分钟再试，结果一样。把它们计进熔断会让一次参数错误
 *   把整条上游线路熔掉，而它本来就没坏。
 *
 * ## 为什么放在这里（`packages/shared` 而不是 worker）
 *
 * `postJsonToPublicEndpoint` 是**全部** provider 的唯一 HTTP 出口
 * （`openai-compatible.ts:401`、`opencode-go.ts:452`、`siliconflow.ts:68` 三处
 * `options.request ?? postJsonToPublicEndpoint`），而且 API 进程里的
 * Critic / teaching 调用也走它。装在这一层，一处覆盖两个进程的全部模型调用。
 *
 * 代价是 shared 里多了一个进程内可变状态（每 host 一条）。这是有意的：
 * 熔断本来就是进程本地的判断，跨进程共享需要额外的一致性设施，
 * 而本项目两个进程的请求量级都不大，各自熔断各自恢复更简单也更安全。
 */

export interface CircuitBreakerOptions {
  /** 连续失败多少次后打开。默认 5。 */
  failureThreshold?: number;
  /** open 之后多久放一个探测请求。默认 30s。 */
  cooldownMs?: number;
  /** 可注入时钟，测试用。 */
  now?: () => number;
  /**
   * 一个「拿到响应但仍算失败」的判据。默认 5xx 与 429。
   * 传响应的 `status` 进来，返回 true 表示计入连续失败。
   */
  isFailureStatus?: (status: number) => boolean;
  /**
   * 每次**拒绝**（即熔断真的挡住了、没发网络请求）时回调。
   *
   * 熔断会主动拒绝请求，所以"它在拒绝"必须可观测——本项目吃过一次
   * "指标存在但从不阻断"的亏（coverage-gate.mjs 的 --report-only）。
   * 熔断器本身不知道 prom-client，所以用回调把埋点责任交回各进程。
   * 回调**不允许抛**：抛了会把"记录指标"变成"熔断失灵"的原因。
   */
  onReject?: (host: string, reason: "open" | "half_open", retryAfterMs: number) => void;
}

export type CircuitState = "closed" | "open" | "half-open";

/** 上游熔断打开时抛的错。**不重试**是有意的语义，不是偷懒。 */
export class CircuitOpenError extends Error {
  readonly circuitHost: string;
  readonly retryAfterMs: number;

  constructor(circuitHost: string, retryAfterMs: number) {
    super(
      `circuit_open: ${circuitHost} 暂时不可用，${Math.ceil(retryAfterMs / 1000)}s 后放一个探测请求`
      + `（连续失败已触发熔断；这一次没有发出网络请求）`,
    );
    this.name = "CircuitOpenError";
    this.circuitHost = circuitHost;
    this.retryAfterMs = retryAfterMs;
  }
}

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_COOLDOWN_MS = 30_000;

/** 5xx 与 429 算上游不可用；其余 4xx 不算（那是请求本身的问题）。 */
function defaultIsFailureStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

interface HostState {
  state: CircuitState;
  consecutiveFailures: number;
  /** open 那一刻记下的时间戳；half-open 用它判断冷却是否满。 */
  openedAt: number;
  /** half-open 期间是否已经放出了一个探测。 */
  probeInFlight: boolean;
}

export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly isFailureStatus: (status: number) => boolean;
  private onReject: ((host: string, reason: "open" | "half_open", retryAfterMs: number) => void) | undefined;
  private readonly hosts = new Map<string, HostState>();

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.now = options.now ?? (() => Date.now());
    this.isFailureStatus = options.isFailureStatus ?? defaultIsFailureStatus;
    this.onReject = options.onReject;
  }

  /**
   * 事后挂一个拒绝观察者。返回摘掉它的函数。
   * 构造之后再挂，是为了不把 prom-client 之类的实现细节引进本包。
   */
  setRejectObserver(
    observer: (host: string, reason: "open" | "half_open", retryAfterMs: number) => void,
  ): () => void {
    this.onReject = observer;
    return () => {
      if (this.onReject === observer) this.onReject = undefined;
    };
  }

  /** 拒绝回调必须吞掉自己的异常：埋点失败不该变成熔断失灵。 */
  private notifyReject(host: string, reason: "open" | "half_open", retryAfterMs: number): void {
    if (!this.onReject) return;
    try {
      this.onReject(host, reason, retryAfterMs);
    } catch {
      // 指标系统的问题不上抛到调用方路径
    }
  }

  private stateOf(host: string): HostState {
    let state = this.hosts.get(host);
    if (!state) {
      state = { state: "closed", consecutiveFailures: 0, openedAt: 0, probeInFlight: false };
      this.hosts.set(host, state);
    }
    return state;
  }

  /** 只读当前状态，供指标与测试观测；不改变状态机。 */
  peek(host: string): CircuitState {
    const state = this.hosts.get(host);
    return state ? state.state : "closed";
  }

  /**
   * 门卫。返回 void 表示放行；抛 `CircuitOpenError` 表示这一次**不要发请求**。
   */
  assertCanAttempt(host: string): void {
    const state = this.stateOf(host);
    if (state.state === "closed") return;

    if (state.state === "open") {
      const elapsed = this.now() - state.openedAt;
      if (elapsed < this.cooldownMs) {
        const retryAfterMs = this.cooldownMs - elapsed;
        this.notifyReject(host, "open", retryAfterMs);
        throw new CircuitOpenError(host, retryAfterMs);
      }
      // 冷却期满：转 half-open，并且**只放这一个**探测。
      state.state = "half-open";
      state.probeInFlight = true;
      return;
    }

    // half-open：已经有探测在飞了，后来的全部挡掉。
    if (state.probeInFlight) {
      this.notifyReject(host, "half_open", this.cooldownMs);
      throw new CircuitOpenError(host, this.cooldownMs);
    }
    state.probeInFlight = true;
  }

  /** 一次尝试结束：成功则清零并关闭；失败则累加，必要时打开。 */
  recordSuccess(host: string): void {
    const state = this.stateOf(host);
    state.state = "closed";
    state.consecutiveFailures = 0;
    state.probeInFlight = false;
  }

  recordFailure(host: string): void {
    const state = this.stateOf(host);
    state.probeInFlight = false;
    state.consecutiveFailures += 1;
    if (state.state === "half-open") {
      // 探测失败：立刻回 open，冷却重新计时。
      state.state = "open";
      state.openedAt = this.now();
      return;
    }
    if (state.consecutiveFailures >= this.failureThreshold) {
      state.state = "open";
      state.openedAt = this.now();
    }
  }

  /**
   * 跑一次受熔断保护的尝试，并按结果记账。
   *
   * `attempt` 抛出的异常与"响应被判为失败"都会计入连续失败；
   * 除此之外**原样转发**——熔断器不吞异常，也不改异常类型，
   * 这样上层那套错误分类（`non-retryable-errors.ts`）的语义完全不变。
   */
  async run<T>(host: string, attempt: () => Promise<{ status: number } & T>): Promise<T> {
    this.assertCanAttempt(host);
    try {
      const result = await attempt();
      if (this.isFailureStatus(result.status)) this.recordFailure(host);
      else this.recordSuccess(host);
      return result;
    } catch (error) {
      this.recordFailure(host);
      throw error;
    }
  }

  /** 清空某个 host（或全部）的状态。给测试与运维用。 */
  reset(host?: string): void {
    if (host === undefined) this.hosts.clear();
    else this.hosts.delete(host);
  }
}

/**
 * 进程内共享的那一个。按 host 分键，所以一个 provider 挂掉
 * 不会把同一进程里其它 provider 一起熔掉。
 */
export const sharedAiCircuitBreaker = new CircuitBreaker();

/**
 * 让各进程把"熔断拒绝了请求"接到自己的指标上。
 *
 * 之所以是"进程启动时再注册"而不是构造时传入：这一层在 `packages/shared`，
 * 里面没有 prom-client（也不该有，那会把指标实现绑进契约包）。
 * worker / api 各自在自己的进程入口调一次即可。
 */
export function observeSharedAiCircuitRejects(
  observer: (host: string, reason: "open" | "half_open", retryAfterMs: number) => void,
): () => void {
  return sharedAiCircuitBreaker.setRejectObserver(observer);
}
