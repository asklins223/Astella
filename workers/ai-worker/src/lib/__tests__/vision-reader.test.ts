/**
 * 识图路由（2026-10-12「不再单独配识图模型」）。
 *
 * 决策树只在两个地方生效：读图工具（companion-tool-execution）与日记看图
 * （companion-daily-summary-image），以及 here-and-now 的措辞同步
 * （visionReaderAvailableFromConfig）。这里钉住"谁能当读图的眼睛"本身：
 * 主模型声明能看 → 主模型；否则副模型（text_generation 那台）声明能看 → 副模型；
 * 都不行 → null，调用方如实说看不了，不回落给看不了的模型。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { afterEach } from "node:test";
import { resolveVisionReader, visionReaderAvailableFromConfig } from "../governance.ts";
import { resetPlatformConfigCache, setPlatformConfig } from "@astella/shared/platform-config-node";

function gov(over: {
  providerName?: string;
  providerConfig?: { modelProfile?: Record<string, unknown> };
  textProviderName?: string | null;
  textProviderConfig?: { modelProfile?: Record<string, unknown> } | null;
}) {
  return {
    providerName: over.providerName ?? "main-platform",
    providerConfig: over.providerConfig ?? {},
    textProviderName: over.textProviderName ?? null,
    textProviderConfig: over.textProviderConfig ?? null,
  } as Parameters<typeof resolveVisionReader>[0];
}

afterEach(() => {
  setPlatformConfig(null);
  resetPlatformConfigCache();
});

test("主模型声明 vision:true → 主模型自己看（副模型不用出场）", () => {
  const reader = resolveVisionReader(gov({
    providerConfig: { modelProfile: { vision: true } },
    textProviderName: "aux-platform",
    textProviderConfig: { modelProfile: { vision: true } },
  }));
  assert.equal(reader?.providerName, "main-platform");
  assert.equal(reader?.source, "main");
});

test("主模型看不了 → 副模型声明 vision:true 时用副模型", () => {
  const reader = resolveVisionReader(gov({
    providerConfig: { modelProfile: { vision: false } },
    textProviderName: "aux-platform",
    textProviderConfig: { modelProfile: { vision: true } },
  }));
  assert.equal(reader?.providerName, "aux-platform");
  assert.equal(reader?.source, "aux");
});

test("副模型必须显式声明 vision:true——未声明不算能看图", () => {
  assert.equal(resolveVisionReader(gov({
    textProviderName: "aux-platform",
    textProviderConfig: {},
  })), null);
  assert.equal(resolveVisionReader(gov({
    textProviderName: "aux-platform",
    textProviderConfig: { modelProfile: { vision: false } },
  })), null);
});

test("都没有 → null（调用方如实说看不了，不回落给看不了的模型）", () => {
  assert.equal(resolveVisionReader(gov({})), null);
  assert.equal(resolveVisionReader(gov({ providerConfig: { modelProfile: { vision: false } } })), null);
});

test("visionReaderAvailableFromConfig 与配置同源", () => {
  // 副模型（text_generation）声明能看 → true。
  setPlatformConfig({
    platforms: { main: { type: "mock" }, aux: { type: "mock", models: { t1: { vision: true } } } },
    capabilities: {
      agent_turn: { platform: "main", model: "m1" },
      text_generation: { platform: "aux", model: "t1" },
    },
  });
  assert.equal(visionReaderAvailableFromConfig(), true);

  // 主模型能看 → true（不需要副模型）。
  setPlatformConfig({
    platforms: { main: { type: "mock", models: { m1: { vision: true } } }, aux: { type: "mock", models: { t1: { vision: false } } } },
    capabilities: {
      agent_turn: { platform: "main", model: "m1" },
      text_generation: { platform: "aux", model: "t1" },
    },
  });
  assert.equal(visionReaderAvailableFromConfig(), true);

  // 副模型声明看不了 → false。
  setPlatformConfig({
    platforms: { main: { type: "mock" }, aux: { type: "mock", models: { t1: { vision: false } } } },
    capabilities: {
      agent_turn: { platform: "main", model: "m1" },
      text_generation: { platform: "aux", model: "t1" },
    },
  });
  assert.equal(visionReaderAvailableFromConfig(), false);

  // 副模型没声明档案 → false（未声明 ≠ 能看图）。
  setPlatformConfig({
    platforms: { main: { type: "mock" }, aux: { type: "mock" } },
    capabilities: {
      agent_turn: { platform: "main", model: "m1" },
      text_generation: { platform: "aux", model: "t1" },
    },
  });
  assert.equal(visionReaderAvailableFromConfig(), false);

  // 连副模型映射都没有 → false。
  setPlatformConfig({
    platforms: { main: { type: "mock" } },
    capabilities: { agent_turn: { platform: "main", model: "m1" } },
  });
  assert.equal(visionReaderAvailableFromConfig(), false);
});
