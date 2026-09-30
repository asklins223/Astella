import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

/**
 * P1-8：feature flag 只能从 `config/learning-companion-flags.ts` 读。
 *
 * ## 为什么需要这条守卫
 *
 * 收口之前，`COMPANION_JOURNEY_V2` 这一个开关散在 **6 个地方**：
 * 4 份逐字复制的 `isCompanionJourneyV2Enabled()`，外加 2 处 OR 集合。
 * 分散本身不致命，致命的是**它不会报错**：改判据时漏掉某一份，
 * 症状只是「某个子端点一直 404」，没有任何一条测试会红。
 *
 * 审计给这类整改的建议（P1-4/5/8/9 那段的「建议每次只统一一个维度」附带的）
 * 是：**同时加一条 CI 检查防止回退**。这就是那条检查。
 */

/** 唯一允许直接读 `process.env.FLAG` 的文件。 */
const FLAG_HOME = "config/learning-companion-flags.ts";

/** 这些开关已经有收口的读取函数，模块代码里不该再直接读 env。 */
const KNOWN_FLAGS = [
  "LEARNING_RUN_ENABLED",
  "CARD_GENERATION_V2_ENABLED",
  "COMPANION_DIALOGUE_V1_ENABLED",
  "COMPANION_VOICE_DIALOGUE_V1_ENABLED",
  "COMPANION_JOURNEY_V2",
  "COMPANION_MEMORY_VECTOR_V1",
  "COMPANION_PET_PROFILE_V1",
];

// 本文件在 src/__tests__/ 下，所以要退**两级**才是 apps/api/ 包根
// （写成 ".." 只会拿到 src/，那下面 join("src") 就变成 src/src 了）。
const API_ROOT = new URL("../..", import.meta.url).pathname;

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) tsFiles(full, out);
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

test("已收口的开关只允许在 config/learning-companion-flags.ts 里读 process.env", () => {
  const offenders: string[] = [];
  const files = tsFiles(join(API_ROOT, "src"))
    .filter((f) => !f.endsWith(".test.ts"))
    // 集成测试**必须**能自己把开关打开——那正是它们在做的事
    // （把 COMPANION_MEMORY_VECTOR_V1 之类设上再验端点行为）。把它们一起禁掉，
    // 结果只是逼着集成测试去绕开守卫，那比现在更糟。
    .filter((f) => !f.includes("/integration-tests/"))
    .filter((f) => relative(API_ROOT, f).split("/").join("/") !== `src/${FLAG_HOME}`);

  for (const file of files) {
    const rel = relative(API_ROOT, file).split("/").join("/");
    const source = stripComments(readFileSync(file, "utf8"));
    for (const flag of KNOWN_FLAGS) {
      if (source.includes(`process.env.${flag}`)) {
        offenders.push(`${rel} 直接读了 process.env.${flag}，改用 config/learning-companion-flags.ts 里的函数`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    "新收口的开关又散开了（每处复制都意味着改判据时会漏改）：\n" + offenders.join("\n"));
});

test("收口模块自己覆盖了全部已知开关，且每个都有导出函数", () => {
  const source = stripComments(readFileSync(join(API_ROOT, "src", FLAG_HOME), "utf8"));
  for (const flag of KNOWN_FLAGS) {
    assert.ok(
      source.includes(`process.env.${flag}`),
      `${FLAG_HOME} 里没有 ${flag} 的读取——KNOWN_FLAGS 列了它但收口模块没管它`,
    );
  }
  const exported = [...source.matchAll(/export function (\w+)\(\)/g)].map((m) => m[1]!);
  assert.ok(exported.length >= KNOWN_FLAGS.length,
    `收口模块只导出了 ${exported.length} 个函数，少于 ${KNOWN_FLAGS.length} 个开关`);
});

test("收口模块里没有裸的 process.env[...] 动态取值（那会绕过本守卫）", () => {
  const source = readFileSync(join(API_ROOT, "src", FLAG_HOME), "utf8");
  assert.doesNotMatch(source, /process\.env\[/,
    "收口模块里用方括号动态取 env 的话，上面两条守卫都看不见它");
});
