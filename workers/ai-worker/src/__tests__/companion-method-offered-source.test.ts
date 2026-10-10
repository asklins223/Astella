import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";


test("44 §6.3（源码守卫）：目录被提供的调用点还在——这是一根绊线，不是证明", async () => {
  // ⚠ **这是一条源码文本守卫，本身证明不了功能**。它只防一件事：有人把
  // `recordAgentMethodOffered` 这个调用点删掉/挪走而没人注意。
  //
  // 真正的行为证据不在这个文件里，而是 2026-10-06 真窗口跑出来的那一行：
  //   stage=offered | context_kind=conversation | conversation:bbcd0e32-…
  // 那行是**阳性对照**跑出来的（方法临时置为 active+supported），它证明这条线真的
  // 会落库；这个守卫只是防止它以后被悄悄拆掉。
  //
  // 为什么仍然值得留：这条缺陷（每轮渲染目录却一条都不记）**纯函数单测全绿**，
  // 两个纯函数 `renderPlaybookCatalog` / `selectRelevantMethods` 各自都有判据——
  // 缺的正是调用点。所以需要一个盯调用点存在性的绊线。
  // 文件名带 `-source-` 是仓库约定：只对源码文本下断言的守卫必须自报家门。
  const source = await readFile(
    new URL("../handlers/companion-context-orchestrator.ts", import.meta.url), "utf8");
  const callSite = source.slice(source.indexOf("await retrievePlaybookViews"));
  const window = callSite.slice(0, 1200);
  assert.match(window, /recordAgentMethodOffered\(/, "取到目录之后必须记一次 offered");
  assert.match(window, /kind:\s*"conversation"/, "来源要与 agent-goal 分得清");
  assert.match(window, /sourceKey:\s*`conversation:\$\{input\.runId\}/,
    "去重口径要带上下文版本，同一次提供只留一行");
});
