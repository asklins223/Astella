/**
 * 进程内日志环形缓冲 —— 运维面板的「日志」页数据源。
 *
 * ## 为什么需要它
 *
 * 本项目的日志出口是 **pino → stdout**，由容器运行时收集。运维在浏览器里
 * 打开面板时，他手上没有 `docker logs` 的权限，也不该为了看一眼最近的错误
 * 而去连进生产容器。没有这一层缓冲的话，「日志」这一页就只能是个摆设。
 *
 * ## 它捕获的是什么
 *
 * 通过 pino 的 `hooks.logMethod(args, method, level)` 钩子挂载：它在**序列化
 * 之前**拿到结构化参数与数字 level，因此能保留 `scope` / `runId` / `workspaceId`
 * 这些字段——比解析 stdout 的 JSON 文本可靠（dev 下 stdout 走 pino-pretty，
 * 根本不是 JSON）。
 *
 * ## 边界：它不是审计日志
 *
 * 这是一个**有界的最近窗口**，进程重启即清空，不落盘、不可检索、不导出。
 * 它的用途是「刚才那会儿到底报了什么」，用途之外的一切（跨重启追因、合规
 * 取证）仍然走 stdout 与审计表。把缓冲说成日志系统会同时误导运维和读者。
 *
 * 容量按「够看清一次故障」定：{@link DEFAULT_CAPACITY} 条 × 平均约 200 字节
 * ≈ 数百 KB 常驻，换任何角度看都不值得为它争论。
 */

import type pino from "pino";

/** pino 的数字 level ↔ 名字。`silent` 是 pino 的 100：没有比它更低的级别。 */
const LEVEL_NAMES: Record<number, LogLevelName> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
  100: "silent",
};

export type LogLevelName = "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "silent";

export interface CapturedLog {
  /** 进程内单调序号，面板用它做稳定排序键与「比刚才新」的判断。 */
  seq: number;
  /** ISO 8601。取 pino 写入时刻，与日志内容里的业务时间戳无关。 */
  time: string;
  level: LogLevelName;
  msg: string;
  /** 除 msg 之外的合并字段（scope / runId / …）。 */
  fields: Record<string, unknown>;
}

export const DEFAULT_CAPACITY = 500;

/**
 * 字段值的最大字符串长度。
 *
 * 缓冲里最常见的「大字段」是 error 对象——它已经过 `safeErrorSerializer`，
 * 但 `diag.stack` 在开发期可达 4 KB。截断是为了不让一条栈把 500 条的窗口
 * 挤掉大半；截断标记写在末尾，读的人知道后面还有内容。
 */
const MAX_FIELD_STRING = 1_024;
const MAX_FIELDS_PER_ENTRY = 24;

function levelName(level: number): LogLevelName {
  return LEVEL_NAMES[level] ?? "info";
}

/** 把任意值压成可安全放进缓冲的标量；对象/数组只留一个形状摘要。 */
function normalizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") {
    return value.length > MAX_FIELD_STRING
      ? `${value.slice(0, MAX_FIELD_STRING)}…(+${value.length - MAX_FIELD_STRING})`
      : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return { __type: "array", length: value.length };
  }
  if (typeof value === "object") {
    // 构造器名转小写：它对读日志的人有用（TypeError 与 Object 差别很大），
    // 但必须归一——构造器名在压缩构建里可能被改写，跨版本漂移会让同一个对象
    // 在不同构建里显示成不同的形状。
    return { __type: (value.constructor?.name ?? "object").toLowerCase() };
  }
  return String(value);
}

export class LogRingBuffer {
  readonly capacity: number;
  #entries: CapturedLog[] = [];
  #next: number;
  #seq = 0;

  constructor(capacity: number = DEFAULT_CAPACITY) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.#next = 0;
  }

  /** 追加一条。`fields` 是**已合并**的合并字段，不含 msg。 */
  push(level: number, msg: string, fields: Record<string, unknown>, time = new Date()): void {
    const kept: Record<string, unknown> = {};
    let taken = 0;
    for (const [key, value] of Object.entries(fields)) {
      if (taken >= MAX_FIELDS_PER_ENTRY) break;
      kept[key] = normalizeValue(value);
      taken += 1;
    }
    this.#entries[this.#next] = {
      seq: ++this.#seq,
      time: time.toISOString(),
      level: levelName(level),
      msg: typeof msg === "string" ? msg : String(msg),
      fields: kept,
    };
    this.#next = (this.#next + 1) % this.capacity;
  }

  get size(): number {
    return this.#entries.length;
  }

  /**
   * 取最近 `limit` 条，按时间**新 → 旧**。
   *
   * `minLevel` 按名字过滤而非按数字：面板上的筛选器是人用的，名字不会错配。
   */
  recent(options: { limit?: number; minLevel?: LogLevelName } = {}): CapturedLog[] {
    const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 100)));
    const floor = levelThreshold(options.minLevel ?? "trace");
    const ordered: CapturedLog[] = [];
    // 从最新位置往回走，因此天然是「新 → 旧」，不受环形回绕影响。
    for (let i = 1; i <= this.#entries.length; i += 1) {
      const entry = this.#entries[(this.#next - i + this.capacity * 2) % this.capacity];
      if (!entry) continue;
      if (levelNumberOf(entry.level) < floor) continue;
      ordered.push(entry);
      if (ordered.length >= limit) break;
    }
    return ordered;
  }

  clear(): void {
    this.#entries = [];
    this.#next = 0;
  }
}

/** level 名字 → pino 数字 level。未知名字退回 trace（最宽松）。 */
function levelNumberOf(name: LogLevelName): number {
  for (const [value, label] of Object.entries(LEVEL_NAMES)) {
    if (label === name) return Number(value);
  }
  return 10;
}

/** 面板筛选器的最小 level。 */
function levelThreshold(name: LogLevelName): number {
  return levelNumberOf(name);
}

/**
 * 进程共享缓冲。
 *
 * 单例而不是每请求新建：pino 钩子在进程创建时就绑好，缓冲必须活得比任何
 * 请求都久。容量取环境变量 `ADMIN_LOG_BUFFER_SIZE`，便于在内存吃紧的部署里
 * 调小。
 */
function resolveCapacity(): number {
  const raw = Number(process.env.ADMIN_LOG_BUFFER_SIZE);
  return Number.isInteger(raw) && raw > 0 ? Math.min(5_000, raw) : DEFAULT_CAPACITY;
}

export const adminLogBuffer = new LogRingBuffer(resolveCapacity());

/**
 * pino `hooks.logMethod` 的实现。
 *
 * **必须**调用传入的 `method`（pino 的契约），否则这条日志不会真的写出去——
 * 钩子的常见写法是 `method.apply(this, args)`。
 *
 * 捕获本身刻意不做任何防护：缓冲写失败绝不能影响日志落地，所以 `push` 用的是
 * 纯内存操作，没有 IO。`try` 只围住捕获本身，`method.apply` 在 `finally` 之外
 * 的位置——不，更正：它必须在捕获失败时**依然**被调用，因此放在 try 之后而非其中。
 */
export function createLogCaptureHook(
  buffer: LogRingBuffer = adminLogBuffer,
): NonNullable<NonNullable<pino.LoggerOptions["hooks"]>["logMethod"]> {
  return function logCaptureHook(this: unknown, args, method, level) {
    try {
      // pino 的 LogFn 签名是 `(obj, msg?, ...args)`，消息可能在第一个也可能在
      // 第二个位置：
      //   logger.info("完成")            → args = ["完成"]
      //   logger.info({ runId }, "完成")  → args = [{ runId }, "完成"]
      // 只看第一个参数会把后一种（Fastify 的请求日志正是这种）整条记成
      // "(no message)"，缓冲里只剩一堆没有消息的壳。
      //
      // 关键：消费掉「消息」之后的位置才轮到合并字段。第一个参数是字符串时
      // **第二个参数仍然是字段对象**，不能跟着消息一起被丢掉。
      const [first, second, ...tail] = args;
      const objects = (values: unknown[]): Record<string, unknown>[] =>
        values.filter((value): value is Record<string, unknown> =>
          Boolean(value) && typeof value === "object",
        );

      let msg: string;
      let fields: Record<string, unknown>;

      if (typeof first === "string") {
        msg = first;
        fields = Object.assign({}, ...objects([second, ...tail]));
      } else if (first && typeof first === "object") {
        const { msg: embedded, ...others } = first as Record<string, unknown>;
        const rest = objects(tail);
        if (typeof embedded === "string") {
          msg = embedded;
          fields = Object.assign({}, others, ...rest);
        } else if (typeof second === "string") {
          msg = second;
          fields = Object.assign({}, others, ...rest);
        } else {
          // 既没有内嵌 msg 也没有第二个字符串：确实就是无消息调用。
          msg = "(no message)";
          fields = Object.assign({}, others, ...rest, ...objects([second]));
        }
      } else {
        msg = typeof second === "string" ? second : "(no message)";
        fields = Object.assign({}, ...objects([...tail, second]));
      }
      buffer.push(level, msg, fields);
    } catch {
      // 捕获失败不得影响日志落地——这里只是"这次没抓到"。
    }
    method.apply(this as never, args);
  };
}