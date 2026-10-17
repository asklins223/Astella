/**
 * Privacy-safe operational error projection.
 *
 * Error messages and stacks can contain SQL parameters, prompts, questions,
 * answers, source URLs, provider responses, or credentials.  They must never
 * be copied into logs, telemetry, audit rows, or jobs.last_error.
 *
 * This module deliberately keeps only a coarse category, a bounded error
 * class name, and an optional machine-readable code.
 *
 * ## 开发期例外（diag）
 *
 * 上述约束在**生产环境**无条件成立。开发期是一个**有意的、窄的例外**：
 * {@link safeErrorSerializer} 会附带一个 `diag` 字段（message + stack），
 * 门控是 `NODE_ENV === "development"` —— 必须是**恰好**这个值，而不是
 * `!== "production"`。
 *
 * 为什么用正向门控：漏设 `NODE_ENV` 的预发/临时环境因此**不会**泄漏，
 * 而 `!== "production"` 在那种环境里恰好会泄漏。宁可漏掉诊断，不可漏掉脱敏。
 *
 * 先例：worker 的 ARCH-04（`workers/ai-worker/src/index.ts`）早就是这么做的，
 * 这里只是把同一个决定推广到 API 与共用序列化器，让两边口径一致。
 *
 * 这个例外的代价要说清楚：**开发期日志可能含用户数据**。它换来的东西是
 * 5xx 不再是一句无法定位的 `RangeError`——2026-09-30 一次栈溢出 5xx 就是
 * 因为只印 `category/name/code`，排查必须临时插桩才能拿到堆栈。
 *
 * 持久化路径（{@link sanitizeOperationalError} / {@link safeErrorMessage}）
 * **不受**此例外影响，永远不带 `diag`。
 */

export type OperationalErrorCategory =
  | "aborted"
  | "timeout"
  | "database"
  | "provider"
  | "authentication"
  | "billing"
  | "configuration"
  | "validation"
  | "not_found"
  | "unknown";

export interface SanitizedOperationalError {
  category: OperationalErrorCategory;
  name: string;
  code: string | null;
}

/** 开发期诊断内容。**只在 `NODE_ENV === "development"` 下产生。** */
export interface DevErrorDiagnostics {
  message: string;
  stack: string;
}

/** 序列化器返回值 = 脱敏投影 + 可选的开发期诊断。 */
export type SerializedOperationalError =
  & SanitizedOperationalError
  & { diag?: DevErrorDiagnostics };

/** 诊断字段的长度上限：日志不该被一个超长堆栈撑爆，但仍要够读。 */
const DIAG_MESSAGE_LIMIT = 512;
const DIAG_STACK_LIMIT = 4_096;

const SAFE_ERROR_PREFIX = "operational_error";
const SAFE_ERROR_MESSAGE_PATTERN =
  /^operational_error:(aborted|timeout|database|provider|authentication|billing|configuration|validation|not_found|unknown):([A-Za-z][A-Za-z0-9_.-]{0,63})(?::([A-Za-z0-9_.-]{1,40}))?$/;
const SAFE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const SAFE_CODE_PATTERN = /^[A-Za-z0-9_.-]{1,40}$/;

/**
 * 跨进程共享的错误码常量。
 *
 * 设计 P1-15（2026-09-15 审计）：`"ai_consent_required"` 此前在 worker 的错误类里
 * 定义、又在 API 的分类器里以字符串字面量 + `endsWith` 重复一遍——改名不会让编译器
 * 报错，只会让分类**静默失效**（用户再也看不到"去签署同意"的引导）。现在两侧引用
 * 同一常量。
 */
export const AI_CONSENT_REQUIRED_CODE = "ai_consent_required";

/**
 * 解析已脱敏错误消息（{@link safeErrorMessage} 的产物）里的机器码。
 *
 * 与 `SAFE_ERROR_MESSAGE_PATTERN` **同源**：消费端不再自行 `endsWith(":code")`，
 * 从而消除"格式是隐式契约、改格式静默失配"的问题。非该格式（含自由文本）返回 null。
 */
export function readSafeErrorCode(message: string | null | undefined): string | null {
  if (typeof message !== "string" || message.length === 0) return null;
  const match = SAFE_ERROR_MESSAGE_PATTERN.exec(message);
  return match?.[3] ?? null;
}

function rawMessage(value: unknown): string {
  if (value instanceof Error) {
    const cause = "cause" in value ? rawMessage(value.cause) : "";
    return `${value.name} ${value.message} ${cause}`.slice(0, 8_192);
  }
  if (typeof value === "string") return value.slice(0, 8_192);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return [
      typeof record.name === "string" ? record.name : "",
      typeof record.message === "string" ? record.message : "",
      typeof record.code === "string" ? record.code : "",
      "cause" in record ? rawMessage(record.cause) : "",
    ].join(" ").slice(0, 8_192);
  }
  return "";
}

function safeName(value: unknown): string {
  const candidate = value instanceof Error
    ? value.name
    : value && typeof value === "object" && typeof (value as Record<string, unknown>).name === "string"
      ? String((value as Record<string, unknown>).name)
      : "Error";
  return SAFE_NAME_PATTERN.test(candidate) ? candidate : "Error";
}

function safeCode(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const candidate = (value as Record<string, unknown>).code;
  if (typeof candidate !== "string" && typeof candidate !== "number") return null;
  const normalized = String(candidate);
  return SAFE_CODE_PATTERN.test(normalized) ? normalized : null;
}

function categorize(message: string): OperationalErrorCategory {
  const normalized = message.toLowerCase();
  if (/\b(abort|aborted|aborterror|lease lost|lease expired)\b/.test(normalized)) {
    return "aborted";
  }
  if (/\b(timeout|timed out|deadline|etimedout)\b/.test(normalized)) {
    return "timeout";
  }
  if (/\b(postgres|postgreserror|drizzle|database|sqlstate|failed query|deadlock|constraint)\b/.test(normalized)) {
    return "database";
  }
  if (/\b(unauthorized|unauthenticated|authentication|invalid api key|forbidden|permission denied|401|403)\b/.test(normalized)) {
    return "authentication";
  }
  if (/\b(overdue|billing|payment|required quota|insufficient quota|credit balance|402)\b/.test(normalized)) {
    return "billing";
  }
  if (/\b(configuration|config|missing env|not configured|unsupported provider|consent not signed)\b/.test(normalized)) {
    return "configuration";
  }
  if (/\b(validation|schema|invalid|malformed|parse|contract violation)\b/.test(normalized)) {
    return "validation";
  }
  if (/\b(not found|missing resource|404)\b/.test(normalized)) {
    return "not_found";
  }
  if (/\b(provider|dashscope|openai|model|fetch|network|socket|econn|http)\b/.test(normalized)) {
    return "provider";
  }
  return "unknown";
}

export function sanitizeOperationalError(value: unknown): SanitizedOperationalError {
  if (typeof value === "string") {
    const alreadySafe = SAFE_ERROR_MESSAGE_PATTERN.exec(value);
    if (alreadySafe) {
      return {
        category: alreadySafe[1] as OperationalErrorCategory,
        name: alreadySafe[2],
        code: alreadySafe[3] ?? null,
      };
    }
  }

  return {
    category: categorize(rawMessage(value)),
    name: safeName(value),
    code: safeCode(value),
  };
}

/**
 * Stable, idempotent representation suitable for persistence.
 */
export function safeErrorMessage(value: unknown): string {
  if (typeof value === "string" && SAFE_ERROR_MESSAGE_PATTERN.test(value)) {
    return value;
  }
  const error = sanitizeOperationalError(value);
  const code = error.code ? `:${error.code}` : "";
  return `${SAFE_ERROR_PREFIX}:${error.category}:${error.name}${code}`;
}

/**
 * 开发期诊断：把原始 message 与堆栈取出来并**限长**。
 *
 * 单独成函数是为了让"是否产生诊断"这件事只有一处判定（下面的
 * {@link DEV_DIAGNOSTICS_ENABLED}），调用点无从绕过。
 */
function devDiagnostics(value: unknown): DevErrorDiagnostics | undefined {
  if (process.env.NODE_ENV !== "development") return undefined;
  if (value instanceof Error) {
    const cause = "cause" in value && value.cause instanceof Error
      ? `\nCaused by: ${value.cause.name}: ${value.cause.message}`
      : "";
    return {
      message: value.message.slice(0, DIAG_MESSAGE_LIMIT),
      stack: `${value.stack ?? `${value.name}: ${value.message}`}${cause}`.slice(0, DIAG_STACK_LIMIT),
    };
  }
  if (typeof value === "string") {
    return { message: value.slice(0, DIAG_MESSAGE_LIMIT), stack: "" };
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const message = typeof record.message === "string" ? record.message : "";
    const stack = typeof record.stack === "string" ? record.stack : "";
    if (message === "" && stack === "") return undefined;
    return {
      message: message.slice(0, DIAG_MESSAGE_LIMIT),
      stack: stack.slice(0, DIAG_STACK_LIMIT),
    };
  }
  return undefined;
}

/**
 * Pino serializer for every top-level error-shaped field.
 *
 * 唯一的脱敏例外出口：开发期附带 `diag`（见文件头「开发期例外」）。
 * 生产与非开发环境返回值与 {@link sanitizeOperationalError} **逐字节相同**。
 */
export function safeErrorSerializer(value: unknown): SerializedOperationalError {
  const sanitized = sanitizeOperationalError(value);
  const diag = devDiagnostics(value);
  // 注意：诊断为 undefined 时**不写这个键**，而不是写 `diag: undefined`——
  // 后者会让 `assert.deepEqual` 形状断言在开发环境下平白变红。
  return diag === undefined ? sanitized : { ...sanitized, diag };
}
