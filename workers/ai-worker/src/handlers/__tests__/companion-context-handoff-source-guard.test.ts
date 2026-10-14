/**
 * 上下文交接的**源码守卫**：窗口只有一个主人。
 *
 * 旧形状是「对话链与摘要链各写一个 20」——改一处不改另一处就静默重叠或静默留空档。
 * 现在窗口由本次路由声明的输入预算整条决定，所以判据落在「只有一个地方做这个决定」，
 * 而不是「两处数字相等」（相等也能各写一遍）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/** 取某个导出函数的函数体（源码守卫按语法结构取区间，不按行数）。 */
function bodyOfExportedFn(source: string, name: string): string {
  const start = source.indexOf(`export function ${name}(`);
  assert.ok(start > 0, `判据认不出 ${name}——函数被改名或搬走了，这里会红（那是该红的时候）`);
  let depth = 0;
  let end = start;
  for (let i = source.indexOf("{", start); i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}" && --depth === 0) { end = i; break; }
  }
  return source.slice(start, end);
}

const isCommentLine = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line);

test("决定窗口的地方只有一处：链上不许有第二个按条数切尾部的口子", () => {
  // 旧形状是「对话链与摘要链各写一个 20」——改一处不改另一处就静默重叠或静默留空档。
  // 现在窗口只有一个主人，所以判据落在「只有一个地方做这个决定」上，
  // 而不是「两处数字相等」（相等也能各写一遍）。
  const source = readFileSync(new URL("../companion-context-handoff.ts", import.meta.url), "utf8");
  const boundBody = bodyOfExportedFn(source, "boundCompanionRecentHistory");
  assert.match(boundBody, /selectCompanionReplayWindow\(/,
    "boundCompanionRecentHistory 不再把取舍转给同一个选择器——窗口就有了第二个主人");
  assert.doesNotMatch(boundBody, /\.slice\(/,
    "收边函数里又出现了按位置切数组：条数窗口回来了");
  assert.doesNotMatch(boundBody, /REPLAY_HISTORY_READ_ROWS/,
    "收边函数又拿条数常量当覆盖边界");

  const chain = [
    "companion-context-handoff.ts",
    "companion-dialogue.ts",
    "companion-dialogue-content.ts",
    "companion-summarizer.ts",
    "companion-tool-intent.ts",
  ];
  for (const file of chain) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    if (file !== "companion-context-handoff.ts") {
      // 交互预算那一层（`selectCompanionInteractiveReplayWindow`）也是同一个主人家的：
      // 它只是把「本轮声明的容量」夹成 min(路由, 回放预算) 再转给同一个选择器。
      // 摘要器现在经它取锚点——两侧必须是同一个裁剪决定，否则就会出现
      // 「摘要没覆盖、原文也没回放」的那一层（150 轮实测曾宽达 176 条）。
      assert.match(text, /boundCompanionRecentHistory|selectCompanionReplayWindow|selectCompanionInteractiveReplayWindow/,
        `${file} 没再经过那个唯一的窗口选择器`);
    }
    assert.doesNotMatch(text,
      /\b(?:recent|recentMessages|history|historyTail|messages|visibleRecent|boundedRecent|visible|tail|tailRows|rows)\w*\.slice\(\s*-\s*(?:REPLAY_HISTORY_READ_ROWS|\d+)/,
      `${file} 里又出现了一处「按条数取最近几条」——窗口不再只由一处决定`);
    // 那个常量只剩「一次读回多少行」的含义：出现的地方必须挂在读数的 limit 上
    for (const line of text.split("\n")) {
      if (!line.includes("REPLAY_HISTORY_READ_ROWS") || isCommentLine(line)) continue;
      assert.ok(
        /limit:/.test(line) || /^\s*(?:export\s+const|REPLAY_HISTORY_READ_ROWS,?$)/.test(line.trim()) || /^export const REPLAY_HISTORY_READ_ROWS/.test(line.trim()),
        `${file} 里 REPLAY_HISTORY_READ_ROWS 出现在读数 limit 之外：它又被当成覆盖边界用了`);
    }
  }
});