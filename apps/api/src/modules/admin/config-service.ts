/**
 * 运维面板的 AI 平台配置读写（`/admin/config`）。
 *
 * ## 配的是什么
 *
 * `config/ai-platforms.json`（路径来自 `AI_PLATFORMS_CONFIG`）——本项目**唯一**
 * 的运行时模型路由配置：平台定义（type / apiKey / baseUrl / options）与
 * 能力→平台模型的映射，以及可选的 TTS 设置。契约见
 * `@ailearn/shared/platform-config`。
 *
 * feature flag 不在这里：它们是**环境变量**，改一个 flag 的正确姿势是改 compose
 * 再滚动重启，不是热写。队列上限是编译期常量。把这些做成面板上的可点开关
 * 会造出「改了但没生效」的状态，比不做更糟。所以面板只**展示** flag 实际生效值
 * （由 overview 服务读函数判定），不给写入口。
 *
 * ## 密钥不经过浏览器
 *
 * 配置里的 `apiKey` 几乎总是 `${ENV_VAR}` 引用。面板显示的是：
 *   - 引用的**变量名**（`${DASHSCOPE_API_KEY}`）——这不敏感，运维要知道配的是哪个；
 *   - 该变量在**本进程**里是否已设置、是否非空——这决定平台能不能用；
 * 而不是插值后的真实 key。即使有人手写了明文 key，返回给浏览器前也会被替换掉。
 *
 * ## 写回的真实约束
 *
 * 写回是**补丁合并**（见 {@link mergeConfigPatch}），不是整文件替换：面板按
 * 快照重建用户改过的那几个字段，而快照里明文密钥是脱敏的——整文件替换会在
 * 「改一个 baseUrl」时顺手把密钥抹掉。合并的基底始终是磁盘上的现状，面板看
 * 不见的字段留在原地。
 *
 * compose 把 `./config` 以 **`:ro`** 挂进容器（dev 与 prod 两侧都是，见
 * docker-compose.dev.yml / docker-compose.yml），所以按默认部署配置**一定**写不
 * 回去。这里**不假装成功**：探测写权限，失败时返回明确的 `config_read_only` 与
 * errno 对应的说明，面板据此把编辑器整体切成只读态。
 *
 * 要让写回生效，部署方需要把该挂载改成可写（或把配置放到可写路径并用
 * `AI_PLATFORMS_CONFIG` 指过去）。这是部署决策，代码不替它做。
 *
 * 写入是「临时文件 + rename」的原子替换，避免写到一半被读到一个坏 JSON——
 * 那个窗口里进程重启会直接 fail closed（platform-config-node.ts 读失败抛错）。
 */

import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { AIPlatformConfig, PlatformDefinition } from "@ailearn/shared";
import {
  loadPlatformConfig,
  resetPlatformConfigCache,
} from "@ailearn/shared/platform-config-node";
import { logger } from "../../lib/logger.ts";

const DEFAULT_CONFIG_PATH = "config/ai-platforms.json";

/** `${ENV_VAR}` 引用的形状。与 platform-config-node 的插值正则保持一致。 */
const ENV_REF_PATTERN = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;

/** 已知能力。用于校验配置的 capability 键是不是拼错了。 */
const KNOWN_CAPABILITIES = [
  "text_generation",
  "vision",
  "agent_turn",
  "companion_fallback",
  "embedding",
  "rerank",
  "speech_recognition",
  "image_generation",
] as const;

/** 已注册的 provider 协议实现。新增一种要改 provider-registry，这里随之。 */
const KNOWN_PLATFORM_TYPES = [
  "mock",
  "dashscope",
  "openai_compatible",
  "siliconflow",
  "opencode_go",
] as const;

export function resolveConfigPath(raw: string | undefined = process.env.AI_PLATFORMS_CONFIG): string {
  return resolve(raw && raw.trim().length > 0 ? raw.trim() : DEFAULT_CONFIG_PATH);
}

export interface ConfigIssue {
  /** 出问题的路径，如 `capabilities.agent_turn.platform`。空串表示根。 */
  path: string;
  message: string;
  /** 阻断级：true 时拒绝写回；false 时只是提示。 */
  blocking: boolean;
}

export interface PlatformView {
  id: string;
  type: string;
  baseUrl: string | null;
  /** 脱敏后的 key 描述：引用了哪个变量、是否已注入。**永不含真实 key**。 */
  apiKey: { mode: "env-ref" | "literal-redacted" | "unset"; envVar: string | null; resolved: boolean };
  options: Record<string, unknown> | null;
  /**
   * 平台级的模型字段（契约里的可选项）。面板不编辑它们，但**保存时必须原样
   * 带回去**：编辑器按快照重建整个配置文件，快照里没有的字段会在一次保存后
   * 被静默删掉——那是"改 baseUrl 顺手弄丢 visionModel"的事故形态。
   */
  model: string | null;
  visionModel: string | null;
  embeddingModel: string | null;
  /** 该平台被哪些能力引用（面板上直接看出「删了会打断谁」）。 */
  usedByCapabilities: string[];
}

export interface CapabilityView {
  capability: string;
  platform: string;
  model: string;
  visionModel: string | null;
  embeddingModel: string | null;
  /** 该映射现在能不能真的用（平台存在 + key 已注入）。 */
  resolvable: boolean;
  problem: string | null;
}

export interface ConfigSnapshot {
  path: string;
  exists: boolean;
  writable: boolean;
  /** 文件是否可读可写。生产 compose 的 `:ro` 挂载会把它压成 false。 */
  readOnlyReason: string | null;
  platforms: PlatformView[];
  capabilities: CapabilityView[];
  tts: Record<string, unknown> | null;
  issues: ConfigIssue[];
  /** 配置文件里的字面 `${VAR}` 在本进程未命中的清单。 */
  unresolvedEnvRefs: string[];
  /** 进程内已缓存的解析结果是否与磁盘一致（写回后应立即一致）。 */
  configFileMtime: string | null;
}

/** 把配置的 apiKey 投影成「可展示但不泄密」的三态描述。 */
function describeApiKey(raw: unknown): PlatformView["apiKey"] {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { mode: "unset", envVar: null, resolved: false };
  }
  const value = raw.trim();
  const match = ENV_REF_PATTERN.exec(value);
  if (match?.[1]) {
    const injected = (process.env[match[1]] ?? "").trim().length > 0;
    return { mode: "env-ref", envVar: match[1], resolved: injected };
  }
  // 明文写进配置文件的 key：结构仍然合法，但它已经在磁盘上明文躺着了，
  // 面板不该再把它读出来显示（会经浏览器、日志、截图各扩散一次）。
  return { mode: "literal-redacted", envVar: null, resolved: true };
}

/** 配置里所有 `${VAR}` 引用的变量名（去重、排序）。 */
function collectEnvRefs(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g)) {
      if (match[1]) into.add(match[1]);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectEnvRefs(item, into);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectEnvRefs(item, into);
  }
}

/**
 * 静态校验。返回全部问题而不是遇错即停——一次把 5 个问题摆出来，
 * 比让人改一次提交一次有用得多。
 */
export function validateConfig(raw: unknown): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return [{ path: "", message: "配置根必须是一个 JSON 对象", blocking: true }];
  }
  const config = raw as Partial<AIPlatformConfig>;

  const platforms = config.platforms;
  if (!platforms || typeof platforms !== "object" || Array.isArray(platforms)) {
    issues.push({ path: "platforms", message: "缺少 platforms 对象", blocking: true });
  } else if (Object.keys(platforms).length === 0) {
    issues.push({ path: "platforms", message: "platforms 为空：没有任何平台可用", blocking: true });
  } else {
    for (const [id, definition] of Object.entries(platforms as Record<string, PlatformDefinition>)) {
      if (!definition || typeof definition !== "object") {
        issues.push({ path: `platforms.${id}`, message: "平台定义必须是对象", blocking: true });
        continue;
      }
      const type = typeof definition.type === "string" ? definition.type.trim() : "";
      if (type.length === 0) {
        issues.push({ path: `platforms.${id}.type`, message: "缺少 type", blocking: true });
      } else if (!(KNOWN_PLATFORM_TYPES as readonly string[]).includes(type)) {
        // 非阻断：provider-registry 可以有面板这份清单之外的实现。
        issues.push({
          path: `platforms.${id}.type`,
          message: `未知平台类型 "${type}"（已知：${KNOWN_PLATFORM_TYPES.join(" / ")}），该平台可能不可用`,
          blocking: false,
        });
      }
      if (definition.apiKey !== undefined && typeof definition.apiKey !== "string") {
        issues.push({ path: `platforms.${id}.apiKey`, message: "apiKey 必须是字符串", blocking: true });
      }
      if (definition.baseUrl !== undefined && typeof definition.baseUrl !== "string") {
        issues.push({ path: `platforms.${id}.baseUrl`, message: "baseUrl 必须是字符串", blocking: true });
      }
    }
  }

  const capabilities = config.capabilities;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    issues.push({ path: "capabilities", message: "缺少 capabilities 对象", blocking: true });
    return issues;
  }

  const platformIds = new Set(
    platforms && typeof platforms === "object" ? Object.keys(platforms as Record<string, unknown>) : [],
  );
  for (const [capability, mapping] of Object.entries(capabilities as Record<string, { platform?: string; model?: string }>)) {
    if (!(KNOWN_CAPABILITIES as readonly string[]).includes(capability)) {
      issues.push({
        path: `capabilities.${capability}`,
        message: `未知能力 "${capability}"（已知：${KNOWN_CAPABILITIES.join(" / ")}）`,
        blocking: false,
      });
    }
    if (!mapping || typeof mapping !== "object") {
      issues.push({ path: `capabilities.${capability}`, message: "能力映射必须是对象", blocking: true });
      continue;
    }
    const platform = typeof mapping.platform === "string" ? mapping.platform : "";
    if (platform.length === 0) {
      issues.push({ path: `capabilities.${capability}.platform`, message: "缺少 platform", blocking: true });
    } else if (!platformIds.has(platform)) {
      // 这条阻断：resolveSystemPlatform 在这种情况下会**抛错**而不是返回 null，
      // 整条能力链路直接 500，而不是优雅降级。
      issues.push({
        path: `capabilities.${capability}.platform`,
        message: `引用了未定义的平台 "${platform}"`,
        blocking: true,
      });
    }
    if (typeof mapping.model !== "string" || mapping.model.trim().length === 0) {
      issues.push({ path: `capabilities.${capability}.model`, message: "缺少 model", blocking: true });
    }
  }

  return issues;
}

/** 只读探测：文件在不在、能不能写。 */
async function inspectPath(
  path: string,
): Promise<{ exists: boolean; writable: boolean; readOnlyReason: string | null; mtime: string | null }> {
  try {
    const info = await stat(path);
    // 配置目录可能不存在（首启、只读挂载）。目录本身也要能写，
    // 否则「文件存在」和「能原子替换」是两件事。
    await access(path, fsConstants.W_OK);
    return { exists: true, writable: true, readOnlyReason: null, mtime: info.mtime.toISOString() };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      try {
        await access(dirname(path), fsConstants.W_OK);
        return { exists: false, writable: true, readOnlyReason: null, mtime: null };
      } catch (dirError) {
        return {
          exists: false,
          writable: false,
          readOnlyReason: explainFsError(dirError, dirname(path)),
          mtime: null,
        };
      }
    }
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
      return { exists: true, writable: false, readOnlyReason: explainFsError(error, path), mtime: null };
    }
    throw error;
  }
}

/** 把 errno 翻成人能据此行动的说明。 */
function explainFsError(error: unknown, path: string): string {
  const code = (error as NodeJS.ErrnoException).code;
  // 说明刻意不点名 compose 文件：dev 与 prod 用的都是 `:ro`，
  // 而「哪个文件把它挂成只读」是部署细节，写死在错误文案里会立刻过期。
  if (code === "EROFS") return `文件系统是只读的，配置无法写回：${path}。容器把 config 目录以 :ro 挂载。`;
  if (code === "EACCES" || code === "EPERM") return `没有写入权限：${path}`;
  return `${code ?? "unknown"}：${path}`;
}

/** 读取并投影为面板视图。文件不存在时返回空视图而不是抛错。 */
export async function readConfigSnapshot(): Promise<ConfigSnapshot> {
  const path = resolveConfigPath();
  const inspection = await inspectPath(path);

  if (!inspection.exists) {
    return {
      path,
      exists: false,
      writable: inspection.writable,
      readOnlyReason: inspection.readOnlyReason,
      platforms: [],
      capabilities: [],
      tts: null,
      issues: [{ path: "", message: "配置文件不存在", blocking: false }],
      unresolvedEnvRefs: [],
      configFileMtime: null,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    // 磁盘上就是坏 JSON。**必须**如实呈现为问题，而不是悄悄返回空配置——
    // 后者会让运维以为「配置是空的」，从而去新建一份，把问题变成两个。
    return {
      path,
      exists: true,
      writable: inspection.writable,
      readOnlyReason: inspection.readOnlyReason,
      platforms: [],
      capabilities: [],
      tts: null,
      issues: [
        {
          path: "",
          message: `配置文件不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
          blocking: true,
        },
      ],
      unresolvedEnvRefs: [],
      configFileMtime: inspection.mtime,
    };
  }

  const config = parsed as AIPlatformConfig;
  const issues = validateConfig(parsed);
  const refs = new Set<string>();
  collectEnvRefs(parsed, refs);
  const unresolvedEnvRefs = [...refs].filter((name) => (process.env[name] ?? "").length === 0).sort();

  const platforms: PlatformView[] = Object.entries(config.platforms ?? {}).map(([id, definition]) => ({
    id,
    type: typeof definition.type === "string" ? definition.type : "",
    baseUrl: typeof definition.baseUrl === "string" ? definition.baseUrl : null,
    apiKey: describeApiKey(definition.apiKey),
    options: definition.options && typeof definition.options === "object"
      ? (definition.options as Record<string, unknown>)
      : null,
    model: typeof definition.model === "string" ? definition.model : null,
    visionModel: typeof definition.visionModel === "string" ? definition.visionModel : null,
    embeddingModel: typeof definition.embeddingModel === "string" ? definition.embeddingModel : null,
    usedByCapabilities: [],
  }));

  const capabilities: CapabilityView[] = Object.entries(config.capabilities ?? {}).map(([capability, mapping]) => {
    const platformId = mapping?.platform ?? "";
    const platform = platforms.find((p) => p.id === platformId);
    platform?.usedByCapabilities.push(capability);
    const typeIsMock = platform?.type === "mock";
    const keyUsable = typeIsMock || platform?.apiKey.mode === "unset" ? true : platform?.apiKey.resolved === true;
    const problem = !platform
      ? `平台 "${platformId}" 未定义`
      : platform.apiKey.mode === "env-ref" && !platform.apiKey.resolved
        ? `环境变量 ${platform.apiKey.envVar} 未注入`
        : null;
    return {
      capability,
      platform: platformId,
      model: mapping?.model ?? "",
      visionModel: mapping?.visionModel ?? null,
      embeddingModel: mapping?.embeddingModel ?? null,
      // 与 platform-config-node 的 §2.3 缺 key 判定同口径：返回 null 即回退 mock。
      resolvable: Boolean(platform) && keyUsable,
      problem: problem ?? (keyUsable ? null : "平台 key 不可用，该能力会回退 mock"),
    };
  });

  return {
    path,
    exists: true,
    writable: inspection.writable,
    readOnlyReason: inspection.readOnlyReason,
    platforms: platforms.sort((a, b) => a.id.localeCompare(b.id)),
    capabilities: capabilities.sort((a, b) => a.capability.localeCompare(b.capability)),
    tts: config.tts && typeof config.tts === "object" ? (config.tts as Record<string, unknown>) : null,
    issues,
    unresolvedEnvRefs,
    configFileMtime: inspection.mtime,
  };
}

export class ConfigWriteError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ConfigWriteError";
    this.code = code;
  }
}

/** 顶层允许出现在补丁里的键。拼错的键要是被静默忽略，那是一类查不出来的 bug。 */
const PATCH_KEYS = ["platforms", "capabilities", "tts"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * 把补丁合并到现有配置上（纯函数，不改入参）。
 *
 * 语义：
 *   - `platforms.<id>`：字段级浅合并——补丁里出现的键覆盖，未出现的保持；
 *     值为 `null` 表示删掉该键；`platforms.<id> = null` 表示删掉整个平台。
 *   - `capabilities.<capability>`：**整体替换**该能力的映射（它本来就是几个
 *     标量字段的集合，字段级合并反而要处理"删 model"这种半状态）。
 *   - `tts`：整体替换；`null` 删除。
 *   - 补丁里没提到的平台 / 能力：原样保留。
 */
export function mergeConfigPatch(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };

  if ("tts" in patch) {
    if (patch.tts === null) delete merged.tts;
    else merged.tts = patch.tts;
  }

  if (isPlainObject(patch.platforms)) {
    const platforms: Record<string, unknown> = isPlainObject(merged.platforms) ? { ...merged.platforms } : {};
    for (const [id, fields] of Object.entries(patch.platforms)) {
      if (fields === null) {
        delete platforms[id];
        continue;
      }
      if (!isPlainObject(fields)) continue;
      const current: Record<string, unknown> = isPlainObject(platforms[id])
        ? { ...(platforms[id] as Record<string, unknown>) }
        : {};
      for (const [key, value] of Object.entries(fields)) {
        if (value === null) delete current[key];
        else current[key] = value;
      }
      platforms[id] = current;
    }
    merged.platforms = platforms;
  }

  if (isPlainObject(patch.capabilities)) {
    const capabilities: Record<string, unknown> = isPlainObject(merged.capabilities) ? { ...merged.capabilities } : {};
    for (const [capability, mapping] of Object.entries(patch.capabilities)) {
      if (mapping === null) delete capabilities[capability];
      else capabilities[capability] = mapping;
    }
    merged.capabilities = capabilities;
  }

  return merged;
}

/**
 * 校验并写回配置文件（**补丁语义**，见 {@link mergeConfigPatch}）。
 *
 * 为什么不是整文件替换：面板按快照重建配置，而快照里**明文 apiKey 是脱敏的**
 * （literal-redacted，值不回浏览器）。整文件替换意味着「改一个 baseUrl 会把
 * 写死在文件里的密钥抹掉」——那是不可接受的事故形态。补丁把「面板能表达的」
 * 与「面板看不见但必须原样保留的」分开，后者永远不离开磁盘。
 *
 * 顺序刻意是 **先读现状 → 再合并 → 后校验 → 最后落盘**：写坏 JSON 的代价是
 * 整个 provider 解析 fail closed（loadPlatformConfig 抛错 → 整条 AI 链路不可
 * 用），远高于「这次没保存成功」。任何 blocking 问题存在时拒绝写入，并把问题
 * 原样返回给面板。
 *
 * 写成功后清解析缓存，否则本进程会继续用**旧的**配置，而面板显示的是新的——
 * 一个「界面说改好了、实际还在用旧的」的面板比没有面板更坏。
 */
export async function writeConfig(patch: unknown): Promise<{ snapshot: ConfigSnapshot; changed: boolean }> {
  const path = resolveConfigPath();

  // 防路径逃逸：配置路径只允许来自环境变量/默认值，不接受请求体里的路径。
  if (!isAbsolute(path)) {
    throw new ConfigWriteError("invalid_path", `配置路径必须是绝对路径：${path}`);
  }
  if (!isPlainObject(patch)) {
    throw new ConfigWriteError("invalid_config", "请求体必须是配置补丁对象");
  }
  const unknownKeys = Object.keys(patch).filter((key) => !(PATCH_KEYS as readonly string[]).includes(key));
  if (unknownKeys.length > 0) {
    throw new ConfigWriteError(
      "invalid_config",
      `补丁里有不认识的顶层键：${unknownKeys.join("、")}（允许：${PATCH_KEYS.join("、")}）`,
    );
  }

  // 以磁盘上的现状为合并基底。不存在 → 空基底；存在但不可解析 → 明确拒绝：
  // 合并无从谈起，且默默覆盖会把损坏文件里还救得回来的部分一起送走。
  const inspection = await inspectPath(path);
  let base: Record<string, unknown> = {};
  if (inspection.exists) {
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!isPlainObject(parsed)) throw new Error("根不是对象");
      base = parsed;
    } catch {
      throw new ConfigWriteError(
        "unreadable_config",
        "磁盘上的配置不是合法 JSON 对象，无法在它上面做合并保存；先修好文件再让面板来改。",
      );
    }
  }

  const merged = mergeConfigPatch(base, patch);
  const issues = validateConfig(merged);
  const blocking = issues.filter((issue) => issue.blocking);
  if (blocking.length > 0) {
    throw new ConfigWriteError("invalid_config", blocking.map((i) => `${i.path || "(root)"}: ${i.message}`).join("; "));
  }

  if (!inspection.writable) {
    throw new ConfigWriteError(
      "config_read_only",
      inspection.readOnlyReason ?? `配置不可写：${path}`,
    );
  }

  const serialized = `${JSON.stringify(merged, null, 2)}\n`;

  await mkdir(dirname(path), { recursive: true });

  // 原子替换：同目录临时文件 + rename。rename 在同一文件系统上是原子的，
  // 因此不存在「读到一个写了一半的 JSON」的窗口。
  const temporary = `${path}.admin-${process.pid}-${Date.now()}.tmp`;
  try {
    await writeFile(temporary, serialized, "utf8");
    await rename(temporary, path);
  } catch (error) {
    // 清理半成品，否则配置目录会攒下一堆 .tmp（只读挂载时这里必然失败）。
    await unlink(temporary).catch(() => undefined);
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EROFS" || code === "EACCES" || code === "EPERM") {
      throw new ConfigWriteError("config_read_only", explainFsError(error, path));
    }
    throw error;
  }

  // 解析缓存必须跟着失效，否则本进程继续用旧配置（见函数注释）。
  resetPlatformConfigCache();

  // 立刻验证一次能解析：写出一个「语法合法但语义坏」的文件（比如 platforms
  // 全空）在写入时就发现，好过等到下一次 provider 调用才炸。
  const reloaded = loadPlatformConfig();
  if (!reloaded) {
    logger.error({ scope: "admin-config", path }, "配置写回后无法重新解析");
    throw new ConfigWriteError("unreadable_after_write", "写入后的配置无法被解析，已请检查文件内容");
  }

  logger.info({ scope: "admin-config", path }, "运维面板更新了 AI 平台配置");
  return { snapshot: await readConfigSnapshot(), changed: true };
}