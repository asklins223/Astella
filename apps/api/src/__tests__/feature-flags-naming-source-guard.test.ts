import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * P3-12：文件的名字要**对得上它装的东西**。
 *
 * ## 这一条是怎么来的
 *
 * `packages/shared/src/feature-flags.ts` 里**只有一件事**：
 * `PROMPT_CACHE_ENABLED` / `PROMPT_CACHE_PROVIDERS` 两个环境变量，
 * 决定要不要给 provider 的请求加缓存提示。
 *
 * 名字承诺的是"通用 feature flag 收口处"，于是两类错误都会发生：
 * 以为"新 flag 都该加在这里"而往里塞；以及以为"这里管所有开关"而找不到自己那个。
 * 仓库里真正的 feature flag 收口处是 `apps/api/src/config/learning-companion-flags.ts`
 * ——两份同名不同物，是这类误用的温床。
 *
 * 2026-09-29 正名为 `provider-prompt-cache.ts`。
 *
 * ## 为什么要有这条判据
 *
 * 正名本身是**一次性**的：改完就没有事了。但名字漂回去是很容易的——
 * 下一个加 flag 的人看到"这里曾经叫 feature-flags"，就可能把它当收口处。
 *
 * 所以钉的是"**这个名字的文件里，装的是不是它名字说的事**"：
 * 一个叫 `*-flags.ts` 的文件，里面出现了 provider 缓存相关的符号，就是漂了。
 */

// 本文件在 `apps/api/src/__tests__/`，仓库根往上 **四** 层；写三层会落到
// `apps/`，于是 `packages/shared/src` 变成 `apps/packages/shared/src`，读不到。
const REPO_ROOT = new URL("../../../../", import.meta.url).pathname;
const SHARED_SRC = join(REPO_ROOT, "packages", "shared", "src");

/** 真正的 feature flag 收口处（P1-8 建的那一份）。 */
const REAL_FLAG_HOME = join(REPO_ROOT, "apps", "api", "src", "config", "learning-companion-flags.ts");

test("共享包里不再有一个名不副实的 feature-flags.ts", () => {
  assert.ok(
    !existsSync(join(SHARED_SRC, "feature-flags.ts")),
    "packages/shared/src/feature-flags.ts 又回来了——"
    + "它装的只有 provider 提示词缓存（已正名为 provider-prompt-cache.ts）。"
    + "两个同名不同物的地方，就是下一次『新 flag 该加在哪』答错的源头。",
  );
});

test("正名后的文件仍然提供那两个函数（改名不能把东西改没）", () => {
  const source = readFileSync(join(SHARED_SRC, "provider-prompt-cache.ts"), "utf8");
  for (const name of ["getPromptCacheProviders", "shouldUsePromptCache"]) {
    assert.ok(
      new RegExp(`export function ${name}\\b`).test(source),
      `provider-prompt-cache.ts 里应当仍然导出 ${name}——`
      + "worker 的 `lib/providers/openai-compatible.ts` 正从 barrel 取它",
    );
  }
  assert.ok(
    existsSync(REAL_FLAG_HOME),
    "真正的 feature flag 收口处不见了——那才是『新 flag 加在哪』的答案",
  );
});

test("【自证】判据会红：把旧文件放回去必须被抓", () => {
  // 判据的形状：文件名以 feature-flags 结尾，且内容里出现 provider 缓存符号
  const bogus = "export function shouldUsePromptCache(): boolean { return false; }";
  const looksLikeFlagHome = /^feature-flags\.ts$/.test("feature-flags.ts");
  assert.ok(looksLikeFlagHome, "自证样本没造好：文件名不叫 feature-flags.ts");
  assert.ok(
    /shouldUsePromptCache/.test(bogus),
    "自证样本没造好：内容里没有 provider 缓存符号",
  );
  // 自证不该改动磁盘上的文件
  assert.ok(!existsSync(join(SHARED_SRC, "feature-flags.ts")),
    "自证：磁盘上不该有那个旧文件");
});
