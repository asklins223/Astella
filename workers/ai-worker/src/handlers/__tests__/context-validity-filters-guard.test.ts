import assert from "node:assert/strict";
import test from "node:test";

/**
 * 方案 44 §3.3：读取侧检查当前有效性。
 *
 * 这条只对**源码文本**下断言（文件里确实带着那个条件），所以按仓库约定放在名字带
 * `guard` 的文件里——打开失败列表的人需要一眼分得出「行为测试红了」和「文本形状变了」。
 *
 * 行为那一半在 `companion-summary-retrieval.test.ts`：它真的跑一次检索，
 * 用桩执行器断言**产出的查询**里带了这些条件。
 */
test("44 §3.3：会话内的接续链与跨会话检索用同一套有效性判据", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const chain = readFileSync(
    fileURLToPath(new URL("../companion-dialogue-store.ts", import.meta.url)),
    "utf8",
  );
  const crossSession = readFileSync(
    fileURLToPath(new URL("../companion-summary-retrieval.ts", import.meta.url)),
    "utf8",
  );
  // 同一个判据，两处读路径；只在一头生效等于「已经接上治理」这句话说半截。
  assert.match(chain, /s\.verified_context_revision = c\.context_revision/);
  assert.match(crossSession, /s\.verified_context_revision = c\.context_revision/);
});
