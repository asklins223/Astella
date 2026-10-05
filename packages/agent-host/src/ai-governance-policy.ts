import { AI_CONSENT_REQUIRED_CODE, DomainError } from "@ailearn/shared";

export class AIConsentRequiredError extends DomainError {
  readonly code = AI_CONSENT_REQUIRED_CODE;
  constructor() { super({ name: "AIConsentRequiredError", code: AI_CONSENT_REQUIRED_CODE,
    message: "AI consent not signed for this account", statusCode: 403 }); }
}

export class AIDataPolicyDeniedError extends DomainError {
  readonly code = "ai_data_policy_denied";
  constructor(reason: string) { super({ name: "AIDataPolicyDeniedError", code: "ai_data_policy_denied", message: reason, statusCode: 403 }); }
}

export interface WorkspaceAIPolicy {
  sendToExternal: boolean;
  sendImageContent?: boolean;
  piiDetection: boolean;
  auditLogging: boolean;
}

export const DEFAULT_AI_DATA_POLICY: WorkspaceAIPolicy = {
  sendToExternal: false,
  sendImageContent: false,
  piiDetection: true,
  auditLogging: true,
};

/**
 * QUAL-28: Factory function that returns a fresh copy of the default AI
 * data policy. Use this instead of `{ ...DEFAULT_AI_DATA_POLICY }` to
 * centralise the creation logic and avoid accidental shared references.
 */
export function createDefaultAIPolicy(): WorkspaceAIPolicy {
  return { ...DEFAULT_AI_DATA_POLICY };
}

export function normalizeWorkspaceAIPolicy(value: unknown): WorkspaceAIPolicy {
  if (!value || typeof value !== "object") return createDefaultAIPolicy();
  const policy = value as Partial<WorkspaceAIPolicy>;
  // QUAL-28: 直接从 DEFAULT_AI_DATA_POLICY 读取字段默认值是安全的，
  // 因为只是读操作而非创建引用副本。仅在需要返回完整新对象时使用 createDefaultAIPolicy()。
  return {
    sendToExternal: typeof policy.sendToExternal === "boolean"
      ? policy.sendToExternal
      : DEFAULT_AI_DATA_POLICY.sendToExternal,
    sendImageContent: typeof policy.sendImageContent === "boolean"
      ? policy.sendImageContent
      : DEFAULT_AI_DATA_POLICY.sendImageContent,
    piiDetection: typeof policy.piiDetection === "boolean"
      ? policy.piiDetection
      : DEFAULT_AI_DATA_POLICY.piiDetection,
    auditLogging: typeof policy.auditLogging === "boolean"
      ? policy.auditLogging
      : DEFAULT_AI_DATA_POLICY.auditLogging,
  };
}

function luhnCheck(num: string): boolean {
  let sum = 0;
  let isEven = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let digit = parseInt(num[i], 10);
    if (isNaN(digit)) return false;
    if (isEven) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    isEven = !isEven;
  }
  return sum % 10 === 0;
}

/**
 * PII 正则模式定义。
 *
 * PERF-12 修复：所有正则在模块加载时一次性预编译为 `compiled` 字段，
 * 之后 detectAndSanitizePII 的每次调用都复用同一实例，不再每次创建新 RegExp。
 *
 * 复用安全性说明：String.prototype.match() 和 String.prototype.replace()
 * 内部会重置 g 标志 RegExp 的 lastIndex，因此单个预编译实例在多次调用间
 * 不会出现 lastIndex 状态泄漏问题（仅在 test()/exec() 场景才有此风险）。
 *
 * 保留 source 和 flags 字段是为了调试和未来动态重建正则的需求。
 *
 * QUAL-12: 修复 [A-Z|a-z] → [A-Za-z]（`|` 曾被误写为字面管道符）。
 * QUAL-13: 银行卡模式新增 Luhn 校验，避免对任意长数字（时间戳、订单号等）误匹配。
 */
interface PIIPatternDef {
  source: string;
  flags: string;
  label: string;
  /** Optional post-match validation (e.g. Luhn check for bank cards). */
  validate?: (match: string) => boolean;
  /** PERF-12 修复：预编译的 RegExp 实例，避免每次调用重新创建 */
  compiled: RegExp;
}

const PII_PATTERN_DEFS: PIIPatternDef[] = [
  { source: "\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b", flags: "g", label: "email", compiled: /(?:)/g },
  { source: "\\b1[3-9]\\d{9}\\b", flags: "g", label: "phone", compiled: /(?:)/g },
  { source: "\\b\\d{6}(18|19|20)\\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\\d|3[01])\\d{3}[\\dXx]\\b", flags: "g", label: "id_card", compiled: /(?:)/g },
  { source: "\\b\\d{16,19}\\b", flags: "g", label: "bank_card", validate: luhnCheck, compiled: /(?:)/g },
  // SEC-01: Additional PII patterns
  // SEC-10 修复：IPv4 地址正则需要排除版本号误匹配。
  // 原正则 \b...\b 会匹配 "1.2.3.4" 这样的版本号字符串。
  // 修复策略：使用 negative lookbehind/lookahead 排除前后还有数字或点的上下文。
  // 注意：JS 正则不支持固定宽度 lookbehind 在所有引擎中，但 V8 支持。
  // (?<!\d\.)(?<!\d) 确保前面不是数字或"数字."，(?!\.?\d) 确保后面不是。
  { source: "(?<!\\d\\.)(?<!\\d)\\b(?:(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\b(?!\\.?\\d)", flags: "g", label: "ip_address", compiled: /(?:)/g },
];
// PERF-12 修复：模块加载时一次性编译所有正则表达式
for (const def of PII_PATTERN_DEFS) {
  def.compiled = new RegExp(def.source, def.flags);
}

interface PIIDetectionResult {
  hasPII: boolean;
  detectedTypes: string[];
  sanitizedText: string;
}

export function detectAndSanitizePII(text: string): PIIDetectionResult {
  const detectedTypes = new Set<string>();
  let sanitizedText = text;

  for (const def of PII_PATTERN_DEFS) {
    // PERF-12 修复：使用模块加载时预编译的 RegExp，不再每次创建新实例。
    // 注意：String.match() 和 String.replace() 不会修改 g 标志 RegExp 的 lastIndex，
    // 因此单个实例在多次调用间是安全的。
    const pattern = def.compiled;
    const matches = text.match(pattern);
    if (!matches || matches.length === 0) continue;

    // QUAL-13: If a validation function is defined, only count matches that pass.
    const validMatches = def.validate
      ? matches.filter(def.validate)
      : matches;
    if (validMatches.length === 0) continue;

    detectedTypes.add(def.label);
    // 脱敏：保留首尾字符，中间用 *** 替代
    // QUAL-24: Reuse the same pattern — replace() resets lastIndex internally.
    sanitizedText = sanitizedText.replace(pattern, (match) => {
      if (def.validate && !def.validate(match)) return match;
      if (match.length <= 4) return "***";
      return match[0] + "***" + match[match.length - 1];
    });
  }

  return {
    hasPII: detectedTypes.size > 0,
    detectedTypes: Array.from(detectedTypes),
    sanitizedText,
  };
}

/**
 * N-011: 对对象中的所有字符串值进行 PII 脱敏。
 * 递归遍历对象，对所有字符串字段进行 PII 检测和脱敏。
 */
export function sanitizePIIInObject<T>(obj: T): { data: T; detectedTypes: string[] } {
  const allDetectedTypes = new Set<string>();

  function sanitizeValue(value: unknown): unknown {
    if (typeof value === "string") {
      const result = detectAndSanitizePII(value);
      for (const t of result.detectedTypes) allDetectedTypes.add(t);
      return result.sanitizedText;
    }
    if (Array.isArray(value)) {
      return value.map(sanitizeValue);
    }
    if (value !== null && typeof value === "object") {
      // QUAL-07 fix: Preserve Date instances and other non-plain objects.
      // Previously, all objects were converted to plain objects via
      // Object.entries(), losing prototype chain and type information.
      if (value instanceof Date) {
        return new Date(value.getTime());
      }
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        result[k] = sanitizeValue(v);
      }
      return result;
    }
    return value;
  }

  return { data: sanitizeValue(obj) as T, detectedTypes: Array.from(allDetectedTypes) };
}

/**
 * 使用预解析的 policy 执行隐私治理检查，避免重复查询 workspaces 表。
 * 与 resolveAIGovernanceContext 配合使用。
 */
export function enforcePrivacyGovernanceWithPolicy(
  policy: WorkspaceAIPolicy,
  _workspaceId: string,
  dataCategories: string[],
  data: Record<string, unknown>,
  providerName: string,
): {
  allowed: boolean;
  reason?: string;
  sanitizedData: Record<string, unknown>;
  piiDetectedTypes: string[];
} {
  const provider = providerName.toLowerCase();

  // 1. sendToExternal 门禁：非 mock provider + sendToExternal=false → 拒绝
  if (provider !== "mock" && !policy.sendToExternal) {
    return {
      allowed: false,
      reason: "账号尚未允许向外部 AI 发送内容，请在设置的 AI 使用设置中开启（sendToExternal=false）。",
      sanitizedData: data,
      piiDetectedTypes: [],
    };
  }

  if (provider !== "mock" && dataCategories.includes("image_content") && !policy.sendImageContent) {
    return {
      allowed: false,
      reason: "账号尚未允许向外部 AI 发送图片，请在设置的 AI 使用设置中开启（sendImageContent=false）。",
      sanitizedData: data,
      piiDetectedTypes: [],
    };
  }

  // 2. PII 检测和脱敏
  let sanitizedData = data;
  let piiDetectedTypes: string[] = [];
  if (policy.piiDetection && provider !== "mock") {
    const result = sanitizePIIInObject(data);
    sanitizedData = result.data;
    piiDetectedTypes = result.detectedTypes;
  }

  return { allowed: true, sanitizedData, piiDetectedTypes };
}

export function containsImageContent(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => containsImageContent(item, depth + 1));
  const record = value as Record<string, unknown>;
  if (record.type === "image" || "image_url" in record || "imageUrl" in record) return true;
  return Object.values(record).some((item) => containsImageContent(item, depth + 1));
}

export function prepareGovernedAIPayload<T extends Record<string, unknown>>(options: {
  context: { consentOk: boolean; policy: WorkspaceAIPolicy };
  workspaceId: string; providerName: string; dataCategories?: readonly string[]; payload: T;
}): T {
  if (!options.context.consentOk && options.providerName.toLowerCase() !== "mock") throw new AIConsentRequiredError();
  const categories = [...(options.dataCategories ?? ["text_content"])];
  if (containsImageContent(options.payload) && !categories.includes("image_content")) categories.push("image_content");
  const result = enforcePrivacyGovernanceWithPolicy(options.context.policy, options.workspaceId,
    categories, options.payload, options.providerName);
  if (!result.allowed) throw new AIDataPolicyDeniedError(result.reason ?? "AI data policy denied the request");
  return result.sanitizedData as T;
}
