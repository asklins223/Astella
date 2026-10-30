import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");

/**
 * 伴星 / LearningRun / Card Generation V2 的能力开关契约守护。
 *
 * 背景（2026-09-16 修复）：本脚本此前只校验 3 个 flag，其中
 * `COMPANION_PET_V1_ENABLED` 已经没有任何 TS 读取方（死配置），而真正生效的
 * 12 个伴星 flag 一个都没被守护——prod compose 因此漏声明了 8 个，dev worker
 * 则声明了 4 个它从不读取的 flag。两者都不会被任何门禁发现。
 *
 * 现在改为数据驱动的双向断言：
 *   1. 每个服务必须声明且只声明它实际读取的开关（多一个=死配置，少一个=运维
 *      无法在不改 compose 的情况下开启能力）；
 *   2. 表达式必须精确等于 `${NAME:-<期望默认值>}`；伴星中心基础能力在 dev/prod
 *      默认开启，外部模型/设备增强能力保持独立关闭。
 *
 * 读取方来源：`apps/api/src` 与 `workers/ai-worker/src` 中的 `process.env.<NAME>`
 * （不含测试）。新增开关时必须同时更新本表与两个 compose 文件。
 */

/** 能力开关读取方契约：服务 → 开关 → { dev, prod } 期望默认值。 */
const CAPABILITY_FLAGS = {
  api: {
    COMPANION_DIALOGUE_V1_ENABLED: { dev: true, prod: true },
    COMPANION_VOICE_DIALOGUE_V1_ENABLED: { dev: true, prod: false },
    COMPANION_STREAMING_VOICE_V1_ENABLED: { dev: false, prod: false },
    COMPANION_JOURNEY_V2: { dev: true, prod: true },
    COMPANION_BRIDGE_V2: { dev: true, prod: true },
    COMPANION_MEMORY_VECTOR_V1: { dev: true, prod: true },
    COMPANION_MEMORY_STAR_MAP_V1: { dev: true, prod: true },
    COMPANION_PET_PROFILE_V1: { dev: true, prod: true },
    COMPANION_PROACTIVE_PERSONALIZED_V1: { dev: true, prod: true },
    COMPANION_SUMMARIZER_V1: { dev: true, prod: true },
    COMPANION_DAILY_SUMMARY_V1: { dev: true, prod: true },
  },
  worker: {
    COMPANION_DIALOGUE_V1_ENABLED: { dev: true, prod: true },
    COMPANION_VOICE_DIALOGUE_V1_ENABLED: { dev: true, prod: false },
    COMPANION_MEMORY_EXTRACTOR_V1: { dev: true, prod: true },
    COMPANION_MEMORY_VECTOR_V1: { dev: true, prod: true },
    COMPANION_SUMMARIZER_V1: { dev: true, prod: true },
    COMPANION_DAILY_SUMMARY_V1: { dev: true, prod: true },
    // 2026-10-30：输出看门狗的读取方在 `handlers/agent/companion-output-watchdog.ts`。
    // 这三个开关自 v1.8.18 起就在 compose 里，本表一直没登记；分类器对冲与
    // L1 路由撤掉后，`COMPANION_TOOL_INTENT_HEDGE_MS` / `COMPANION_RELEASE_ROUTER`
    // 已没有读取方，从契约和 compose 一起移除。
    COMPANION_PROVIDER_FIRST_OUTPUT_TIMEOUT_MS: { dev: "12000", prod: "12000" },
    COMPANION_CASUAL_PROVIDER_FIRST_OUTPUT_TIMEOUT_MS: { dev: "5000", prod: "5000" },
    COMPANION_PROVIDER_IDLE_TIMEOUT_MS: { dev: "45000", prod: "45000" },
    // 入口只有 fast / thinking 两档，读取方是
    // `handlers/turn/companion-entry-mode.ts` 的 `resolveCompanionEntryMode`。
    COMPANION_AGENT_ENTRY_MODE: { dev: "direct_fast", prod: "direct_fast" },
  },
};

/** 属于本契约管辖的开关键名；用于抓出多余的（死）能力开关。 */
const GOVERNABLE_KEY = /^COMPANION_[A-Z0-9_]+$/;

const FILES = [
  { file: "docker-compose.dev.yml", profile: "dev" },
  { file: "docker-compose.yml", profile: "prod" },
];

function loadCompose(file) {
  return yaml.load(readFileSync(file, "utf8"));
}

function environment(document, service, file) {
  const value = document?.services?.[service]?.environment;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${file}: service ${service} environment is missing`);
  }
  return value;
}

const problems = [];

for (const { file, profile } of FILES) {
  const document = loadCompose(file);
  for (const [service, expected] of Object.entries(CAPABILITY_FLAGS)) {
    const env = environment(document, service, file);

    for (const [name, defaults] of Object.entries(expected)) {
      const wanted = `\${${name}:-${defaults[profile]}}`;
      const actual = env[name];
      if (actual === undefined) {
        problems.push(`${file}: ${service} is missing ${name} (expected ${wanted})`);
      } else if (actual !== wanted) {
        problems.push(`${file}: ${service} ${name} must be ${wanted} (got ${JSON.stringify(actual)})`);
      }
    }

    const declared = Object.keys(env).filter((key) => GOVERNABLE_KEY.test(key));
    for (const key of declared) {
      if (!Object.hasOwn(expected, key)) {
        problems.push(
          `${file}: ${service} declares ${key}, which no ${service} code reads `
          + "(dead capability switch — remove it or wire it up)",
        );
      }
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`[companion-capability-config] ${problem}`);
  throw new Error(`companion capability config drift: ${problems.length} problem(s)`);
}

const apiCount = Object.keys(CAPABILITY_FLAGS.api).length;
const workerCount = Object.keys(CAPABILITY_FLAGS.worker).length;
console.log(
  "companion capability config OK "
  + `(base Companion Center enabled; api ${apiCount} flags, worker ${workerCount} flags; no dead switches)`,
);
