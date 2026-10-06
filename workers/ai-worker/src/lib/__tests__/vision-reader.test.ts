/**
 * 识图路由（2026-10-06 配置重设计）。
 *
 * 决策树只在两个地方生效：读图工具（companion-tool-execution）与日记看图
 * （companion-daily-summary-image），以及 here-and-now 的措辞同步
 *（visionReaderAvailableFromConfig）。这里钉住"谁能当读图的眼睛"本身。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { afterEach } from "node:test";
import { resolveVisionReader, visionReaderAvailableFromConfig } from "../governance.ts";
import { resetPlatformConfigCache, setPlatformConfig } from "@ailearn/shared/platform-config-node";

function gov(over: {
  providerName?: string;
  providerConfig?: { modelProfile?: Record<string, unknown> };
  visionProviderName?: string | null;
  visionProviderConfig?: { modelProfile?: Record<string, unknown> } | null;
}) {
  return {
    providerName: over.providerName ?? "main-platform",
    providerConfig: over.providerConfig ?? {},
    visionProviderName: over.visionProviderName ?? null,
    visionProviderConfig: over.visionProviderConfig ?? null,
  } as Parameters<typeof resolveVisionReader>[0];
}

afterEach(() => {
  setPlatformConfig(null);
  resetPlatformConfigCache();
});

test("主模型声明 vision:true → 主模型自己看", () => {
  const reader = resolveVisionReader(gov({
    providerConfig: { modelProfile: { vision: true } },
    visionProviderName: "vision-platform",
    visionProviderConfig: {},
  }));
  assert.deepEqual(reader?.providerName, "main-platform");
  assert.equal(reader?.source, "main");
});

test("主模型没有 vision 声明 → 用专门的识图槽", () => {
  const reader = resolveVisionReader(gov({
    providerConfig: { modelProfile: { vision: false } },
    visionProviderName: "vision-platform",
    visionProviderConfig: { modelProfile: { vision: true } },
  }));
  assert.equal(reader?.providerName, "vision-platform");
  assert.equal(reader?.source, "dedicated");
  // 识图槽的模型没声明 vision 字段时也可用（那是"这条映射就是为识图建的"的显式意图）。
  const undeclared = resolveVisionReader(gov({
    visionProviderName: "vision-platform",
    visionProviderConfig: {},
  }));
  assert.equal(undeclared?.source, "dedicated");
});

test("识图槽的模型被显式声明 vision:false 时不可用（配置矛盾，不猜）", () => {
  const reader = resolveVisionReader(gov({
    visionProviderName: "vision-platform",
    visionProviderConfig: { modelProfile: { vision: false } },
  }));
  assert.equal(reader, null);
});

test("主模型看不见、也没有识图槽 → null（调用方明确失败，不回落给看不见的模型）", () => {
  assert.equal(resolveVisionReader(gov({})), null);
  assert.equal(resolveVisionReader(gov({ providerConfig: { modelProfile: { vision: false } } })), null);
});

test("visionReaderAvailableFromConfig 与配置同源", () => {
  // 识图槽存在即意图：它没被显式声明 vision:false 就能用（未声明档案 ≠ 能看图，
  // 但"这条映射就是为识图建的"本身就是声明）。
  setPlatformConfig({
    platforms: { main: { type: "mock" }, vision: { type: "mock" } },
    capabilities: {
      agent_turn: { platform: "main", model: "m1" },
      vision: { platform: "vision", model: "v1" },
    },
  });
  assert.equal(visionReaderAvailableFromConfig(), true);

  // agent_turn 的模型能看 → true（不需要 vision 槽）。
  setPlatformConfig({
    platforms: { main: { type: "mock", models: { m1: { vision: true } } }, vision: { type: "mock" } },
    capabilities: {
      agent_turn: { platform: "main", model: "m1" },
      vision: { platform: "vision", model: "v1" },
    },
  });
  assert.equal(visionReaderAvailableFromConfig(), true);

  // 识图槽的模型被声明 vision:false → 不可用。
  setPlatformConfig({
    platforms: { main: { type: "mock" }, vision: { type: "mock", models: { v1: { vision: false } } } },
    capabilities: {
      agent_turn: { platform: "main", model: "m1" },
      vision: { platform: "vision", model: "v1" },
    },
  });
  assert.equal(visionReaderAvailableFromConfig(), false);

  // 连映射都没有 → false。
  setPlatformConfig({
    platforms: { main: { type: "mock" } },
    capabilities: { agent_turn: { platform: "main", model: "m1" } },
  });
  assert.equal(visionReaderAvailableFromConfig(), false);
});
