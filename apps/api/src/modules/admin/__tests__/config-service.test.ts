/**
 * 配置读写的契约测试。
 *
 * 两条最要紧的性质，各有一条专门的用例：
 *   1. **坏配置绝不能落盘**。写坏 JSON 的代价是整个 provider 解析 fail closed
 *      （loadPlatformConfig 抛错 → 整条 AI 链路不可用），远高于「这次没保存成功」。
 *   2. **密钥不回传浏览器**。配置里明文写死的 apiKey 也不能出现在读取结果里。
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
// 单行 import：source-text-guard-naming 的判据用 `/^import .*? from "\./` 识别
// 「这个文件 import 了本地模块、因此它是行为测试」。多行 import 匹配不上，
// 会把本文件误判成源码文本守卫并把棘轮基线顶上去。
import { ConfigWriteError, readConfigSnapshot, resolveConfigPath, validateConfig, writeConfig } from "../config-service.ts";
import { resetPlatformConfigCache } from "@astella/shared/platform-config-node";

const originalPath = process.env.AI_PLATFORMS_CONFIG;

async function withTempConfig(contents: unknown): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "astella-admin-config-"));
  const path = join(dir, "ai-platforms.json");
  await writeFile(path, typeof contents === "string" ? contents : JSON.stringify(contents, null, 2), "utf8");
  process.env.AI_PLATFORMS_CONFIG = path;
  resetPlatformConfigCache();
  return { dir, path };
}

after(() => {
  if (originalPath === undefined) delete process.env.AI_PLATFORMS_CONFIG;
  else process.env.AI_PLATFORMS_CONFIG = originalPath;
  resetPlatformConfigCache();
});

const VALID = {
  platforms: {
    demo: {
      type: "openai_compatible",
      apiKey: "${DEMO_KEY}",
      baseUrl: "https://example.invalid/v1",
      // 严格声明制（2026-10-06）：capabilities 引用的模型必须声明能力档案。
      models: { "demo-model": { contextWindowTokens: 128_000, maxOutputTokens: 8_192 } },
    },
    local: { type: "mock" },
  },
  capabilities: {
    agent_turn: { platform: "demo", model: "demo-model" },
    text_generation: { platform: "local", model: "fixed" },
  },
};

test("resolveConfigPath 走环境变量，缺省回落到 config/ai-platforms.json", () => {
  assert.equal(resolveConfigPath("/tmp/x.json"), "/tmp/x.json");
  assert.equal(resolveConfigPath(undefined).endsWith("config/ai-platforms.json"), true);
  assert.equal(resolveConfigPath("").endsWith("config/ai-platforms.json"), true);
});

test("校验：合法配置无阻断问题", () => {
  assert.deepEqual(validateConfig(VALID).filter((i) => i.blocking), []);
});

test("校验：引用未定义平台是阻断项（resolveSystemPlatform 会抛错而非降级）", () => {
  const issues = validateConfig({
    ...VALID,
    capabilities: { agent_turn: { platform: "ghost", model: "m" } },
  });
  const blocking = issues.filter((i) => i.blocking);
  assert.equal(blocking.length, 1);
  assert.ok(blocking[0].path.includes("agent_turn.platform"));
});

test("校验：缺 platforms / capabilities / model 都阻断；未知能力与未知 type 只提示", () => {
  assert.ok(validateConfig({}).some((i) => i.blocking && i.path === "platforms"));
  assert.ok(validateConfig({ platforms: {} }).some((i) => i.blocking && i.path === "capabilities"));

  const missingModel = validateConfig({
    platforms: VALID.platforms,
    capabilities: { agent_turn: { platform: "demo" } },
  });
  assert.ok(missingModel.some((i) => i.blocking && i.path.endsWith(".model")));

  const unknownCapability = validateConfig({
    ...VALID,
    capabilities: { ...VALID.capabilities, totally_made_up: { platform: "demo", model: "demo-model" } },
  });
  assert.equal(unknownCapability.some((i) => i.blocking), false, "未知能力不该阻断写回");
  assert.ok(unknownCapability.some((i) => !i.blocking && i.path.includes("totally_made_up")));

  const unknownType = validateConfig({
    platforms: { x: { type: "not_a_real_protocol" } },
    capabilities: { agent_turn: { platform: "x", model: "m" } },
  });
  assert.equal(unknownType.some((i) => i.blocking), false, "provider-registry 可能已支持它");
  assert.ok(unknownType.some((i) => !i.blocking && i.path.includes("type")));
});

/* ── 模型档案与严格声明制（2026-10-06 配置重设计）──────────────────────── */

test("校验：capabilities 引用未声明的模型是阻断项（严格声明制）", () => {
  const issues = validateConfig({
    ...VALID,
    capabilities: { agent_turn: { platform: "demo", model: "ghost-model" } },
  });
  const blocking = issues.filter((i) => i.blocking);
  assert.equal(blocking.length, 1);
  assert.ok(blocking[0].message.includes("未在 platforms.demo.models 中声明"));
});

test("校验：平台级旧字段（enableThinking / contextWindowTokens 等）阻断——不能再被静默忽略", () => {
  const legacy = validateConfig({
    platforms: {
      demo: {
        ...VALID.platforms.demo,
        options: { disableThinking: true, contextWindowTokens: 128_000 },
      },
    },
    capabilities: VALID.capabilities,
  });
  assert.ok(legacy.some((i) => i.blocking && i.path.endsWith("options.disableThinking")));
  assert.ok(legacy.some((i) => i.blocking && i.path.endsWith("options.contextWindowTokens")));
});

test("校验：模型档案的档位取值与 default∈levels 都是阻断项", () => {
  const badLevel = validateConfig({
    platforms: {
      demo: { ...VALID.platforms.demo, models: { "demo-model": { reasoning: { levels: ["none", "ultra"], default: "none" } } } },
    },
    capabilities: VALID.capabilities,
  });
  assert.ok(badLevel.some((i) => i.blocking && i.path.includes("reasoning.levels")));

  const badDefault = validateConfig({
    platforms: {
      demo: { ...VALID.platforms.demo, models: { "demo-model": { reasoning: { levels: ["none"], default: "high" } } } },
    },
    capabilities: VALID.capabilities,
  });
  assert.ok(badDefault.some((i) => i.blocking && i.path.includes("reasoning.default")));
});

test("校验：识图映射的模型声明 vision:false 只提示（运行时按没有可用看图模型处理）", () => {
  const issues = validateConfig({
    platforms: {
      vis: { type: "openai_compatible", apiKey: "${K}", baseUrl: "https://x.invalid", models: { vlm: { vision: false } } },
    },
    capabilities: { vision: { platform: "vis", model: "vlm" } },
  });
  assert.deepEqual(issues.filter((i) => i.blocking), []);
  assert.ok(issues.some((i) => !i.blocking && i.message.includes("vision:false")));
});

test("读取：密钥只回「引用了哪个变量 / 是否已注入」，明文永不出现在结果里", async () => {
  process.env.DEMO_KEY = "sk-real-secret-value";
  await withTempConfig({
    platforms: {
      withRef: { type: "openai_compatible", apiKey: "${DEMO_KEY}" },
      withLiteral: { type: "openai_compatible", apiKey: "sk-literal-should-never-be-returned" },
      bare: { type: "mock" },
    },
    capabilities: {},
  });

  const snapshot = await readConfigSnapshot();
  // 按 id 取，缺失就明确炸出来——用 indexOf 拿 undefined 再断言，
  // 会让"平台根本没读回来"这种真实故障伪装成断言失败。
  const byId = (id: string) => {
    const found = snapshot.platforms.find((platform) => platform.id === id);
    assert.ok(found, `快照里应当有平台 ${id}`);
    return found;
  };
  const withRef = byId("withRef");
  const withLiteral = byId("withLiteral");
  const bare = byId("bare");

  assert.equal(withRef.apiKey.mode, "env-ref");
  assert.equal(withRef.apiKey.envVar, "DEMO_KEY");
  assert.equal(withRef.apiKey.resolved, true);

  assert.equal(withLiteral.apiKey.mode, "literal-redacted");
  assert.equal(JSON.stringify(snapshot).includes("sk-literal-should-never-be-returned"), false);
  assert.equal(JSON.stringify(snapshot).includes("sk-real-secret-value"), false);

  assert.equal(bare.apiKey.mode, "unset");

  delete process.env.DEMO_KEY;
});

test("读取：未注入的环境变量被点名（它们会以字面 ${VAR} 当凭据，通常表现为 401）", async () => {
  delete process.env.NOT_SET_ANYWHERE_KEY;
  await withTempConfig({
    platforms: { a: { type: "openai_compatible", apiKey: "${NOT_SET_ANYWHERE_KEY}" } },
    capabilities: {},
  });
  const snapshot = await readConfigSnapshot();
  assert.deepEqual(snapshot.unresolvedEnvRefs, ["NOT_SET_ANYWHERE_KEY"]);
  assert.equal(snapshot.platforms[0].apiKey.resolved, false);
});

test("读取：磁盘上就是坏 JSON 时如实呈现问题，而不是假装配置为空", async () => {
  await withTempConfig("{ this is not json");
  const snapshot = await readConfigSnapshot();
  assert.ok(snapshot.issues.some((i) => i.blocking && i.message.includes("JSON")));
});

test("写入：坏配置被拒绝，磁盘内容不变", async () => {
  const { path } = await withTempConfig(VALID);
  const before = await readFile(path, "utf8");

  await assert.rejects(
    () => writeConfig({ platforms: { a: { type: "mock" } }, capabilities: { agent_turn: { platform: "ghost", model: "m" } } }),
    (error: unknown) => error instanceof ConfigWriteError && error.code === "invalid_config",
  );
  assert.equal(await readFile(path, "utf8"), before, "被拒绝的写入不应碰磁盘");
});

test("写入：合法配置原子落盘并可被重新解析", async () => {
  const { path } = await withTempConfig(VALID);
  const next = {
    platforms: { ...VALID.platforms, extra: { type: "mock" } },
    capabilities: { ...VALID.capabilities, embedding: { platform: "local", model: "fixed" } },
  };
  const result = await writeConfig(next);
  assert.equal(result.changed, true);

  const written = JSON.parse(await readFile(path, "utf8"));
  assert.ok(written.platforms.extra);
  assert.equal(written.capabilities.embedding.model, "fixed");

  // 原子替换不该留下临时文件。
  const { readdir } = await import("node:fs/promises");
  const leftovers = (await readdir(path.replace(/\/[^/]+$/, ""))).filter((n) => n.includes(".tmp"));
  assert.deepEqual(leftovers, []);
});

/* ── 补丁合并（2026-10-03：面板可编辑配置）────────────────────────────── */

test("合并：补丁只改 baseUrl，明文密钥与 options 原样保留（不被抹掉）", async () => {
  await withTempConfig({
    platforms: {
      lit: {
        type: "openai_compatible",
        apiKey: "sk-literal-stays-on-disk",
        baseUrl: "https://old.invalid/v1",
        models: { m: {} },
        options: { disableMaxTokens: true },
      },
    },
    capabilities: { agent_turn: { platform: "lit", model: "m" } },
  });

  const result = await writeConfig({ platforms: { lit: { baseUrl: "https://new.invalid/v1" } } });
  assert.equal(result.changed, true);

  const onDisk = JSON.parse(await readFile(resolveConfigPath(), "utf8"));
  assert.equal(onDisk.platforms.lit.baseUrl, "https://new.invalid/v1");
  assert.equal(onDisk.platforms.lit.apiKey, "sk-literal-stays-on-disk", "面板看不见的密钥必须留在磁盘上");
  assert.deepEqual(onDisk.platforms.lit.options, { disableMaxTokens: true });
  // 回应里也不含明文密钥。
  assert.equal(JSON.stringify(result.snapshot).includes("sk-literal-stays-on-disk"), false);
});

test("合并：apiKey 换成环境变量引用后生效；capabilities 映射整体替换", async () => {
  await withTempConfig({
    platforms: { a: { type: "openai_compatible", apiKey: "sk-plain" }, b: { type: "mock" } },
    capabilities: { agent_turn: { platform: "a", model: "old" } },
  });

  await writeConfig({
    platforms: { a: { apiKey: "${NEW_KEY}" } },
    capabilities: { agent_turn: { platform: "b", model: "new-model" } },
  });

  const onDisk = JSON.parse(await readFile(resolveConfigPath(), "utf8"));
  assert.equal(onDisk.platforms.a.apiKey, "${NEW_KEY}");
  assert.deepEqual(onDisk.capabilities.agent_turn, { platform: "b", model: "new-model" });
});

test("合并：tts 整体替换，null 删除；未提到的平台保持原样", async () => {
  await withTempConfig({
    ...VALID,
    tts: { engine: "edge", edge: { voice: "zh-CN-XiaoyiNeural" } },
  });

  await writeConfig({ tts: { engine: "qwen" } });
  let onDisk = JSON.parse(await readFile(resolveConfigPath(), "utf8"));
  assert.deepEqual(onDisk.tts, { engine: "qwen" });
  assert.ok(onDisk.platforms.demo, "未提到的平台必须原样保留");

  await writeConfig({ tts: null });
  onDisk = JSON.parse(await readFile(resolveConfigPath(), "utf8"));
  assert.equal("tts" in onDisk, false);
});

test("合并：补丁里的未知顶层键被拒绝（拼错的键不许静默忽略）", async () => {
  const { path } = await withTempConfig(VALID);
  const before = await readFile(path, "utf8");
  await assert.rejects(
    () => writeConfig({ platfroms: {} }),
    (error: unknown) => error instanceof ConfigWriteError && error.code === "invalid_config",
  );
  assert.equal(await readFile(path, "utf8"), before, "被拒绝的写入不应碰磁盘");
});

test("合并：磁盘上是坏 JSON 时拒绝合并保存（不覆盖可能还能救的内容）", async () => {
  const { path } = await withTempConfig("{ broken json");
  const before = await readFile(path, "utf8");
  await assert.rejects(
    () => writeConfig({ tts: { engine: "edge" } }),
    (error: unknown) => error instanceof ConfigWriteError && error.code === "unreadable_config",
  );
  assert.equal(await readFile(path, "utf8"), before);
});

test("写入：只读路径明确报错 config_read_only，不假装成功", async () => {
  const { dir, path } = await withTempConfig(VALID);
  // 用只读目录制造 EACCES（macOS 上对**目录**的写权限位最可靠）。
  const { chmod } = await import("node:fs/promises");
  await chmod(dir, 0o500);
  try {
    await assert.rejects(
      () => writeConfig({ ...VALID, platforms: { ...VALID.platforms, added: { type: "mock" } } }),
      (error: unknown) => error instanceof ConfigWriteError && error.code === "config_read_only",
    );
    const after = JSON.parse(await readFile(path, "utf8"));
    assert.equal(after.platforms.added, undefined, "只读失败时原文件必须保持不变");
  } finally {
    await chmod(dir, 0o700);
  }
});

test("读取：配置不存在时给出可行动的状态而不是抛错", async () => {
  const dir = await mkdtemp(join(tmpdir(), "astella-admin-missing-"));
  process.env.AI_PLATFORMS_CONFIG = join(dir, "nope.json");
  resetPlatformConfigCache();
  const snapshot = await readConfigSnapshot();
  assert.equal(snapshot.exists, false);
  assert.equal(snapshot.platforms.length, 0);
  assert.equal(snapshot.writable, true, "目录可写 ⇒ 可以新建");
});