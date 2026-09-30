import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * P2-10：一趟协同落盘里 `projectFragmentBlocks` 只算**一次**。
 *
 * ## 为什么要盯这个
 *
 * `projectFragmentBlocks` 把整个 Y.XmlFragment 过一遍 `yXmlFragmentToProsemirrorJSON`，
 * 再把 ProseMirror JSON 映射成 `note_blocks` 行。文档越大越贵。
 *
 * 协同保存（`collaboration.ts` 的 flush）本来要**两个**：
 * `resolveNoteDocFlushTarget` 要块算版本快照，`persistNoteDoc` 要块写 `note_blocks`。
 * 同一趟落盘里白烧一遍——而这条路径是**每次按键停顿**都会走到的。
 *
 * ## 为什么用结构断言而不是数调用次数
 *
 * 真的去数运行时的调用次数需要一个能观测的 Y.Doc 替身，价值不高。
 * 这里钉的是更靠得住的东西：**落盘那一段必须把同一份 `projected` 递下去**，
 * 而不是让两个函数各自去算。判据的对象是"这件事只做一次"这个契约。
 */

const API_ROOT = new URL("..", import.meta.url).pathname;
const COLLAB = join(API_ROOT, "modules", "note", "collaboration.ts");
const DOC_STATE = join(API_ROOT, "modules", "note", "document-state.ts");

test("协同落盘那一段：投影算一次，两个函数共用同一份", () => {
  const source = readFileSync(COLLAB, "utf8");
  // ⚠️ 切片要**从投影那一行之前**开始：从 `resolveNoteDocFlushTarget(` 起切会
  // 正好把它前面那一次 `projectFragmentBlocks` 漏掉，判据于是恒为 0——
  // 第一版就是这么写的，报出来的是「出现了 0 次」，看着像代码问题，其实是尺子的问题。
  const at = source.indexOf("resolveNoteDocFlushTarget(tx");
  assert.ok(at > 0, "自证：应当找得到 resolveNoteDocFlushTarget 的调用");
  const block = source.slice(Math.max(0, at - 400), at + 1200);

  // 落盘段内只能出现一次「真正去算」的动作：
  // 允许在块之前算一次，不允许在两个调用点各自算。
  const assignments = [...block.matchAll(/const\s+(\w+)\s*=\s*projectFragmentBlocks\(/g)]
    .map((m) => m[1]!);
  assert.equal(assignments.length, 1,
    `落盘段里出现了 ${assignments.length} 次 projectFragmentBlocks 调用，`
    + "应当只在落盘前算一次，然后把同一份递进两个函数");

  const projected = assignments[0]!;
  // 两个调用点都要收到它
  const passes = [...block.matchAll(
    new RegExp(`(?:resolveNoteDocFlushTarget|persistNoteDoc)\\([\\s\\S]{0,400}?,\\s*${projected}\\s*\\)`, "g"),
  )].length;
  assert.equal(passes, 2,
    `「${projected}」应当同时传给 resolveNoteDocFlushTarget 与 persistNoteDoc，`
    + `实际传了 ${passes} 次——少传的那个函数会自己去再算一遍`);
});

test("两个落盘函数都接受已投影结果（可选入参，不是各自硬算）", () => {
  const source = readFileSync(DOC_STATE, "utf8");
  for (const fn of ["persistNoteDoc", "resolveNoteDocFlushTarget"]) {
    const at = source.indexOf(`export async function ${fn}(`);
    assert.ok(at > 0, `自证：应当找得到 ${fn}`);
    const sig = source.slice(at, source.indexOf("): Promise<", at));
    assert.ok(
      /projected\??:\s*ProjectedNoteBlock\[\]/.test(sig),
      `${fn} 的签名里没有 projected 入参——调用方算好的结果没法递下去`,
    );
  }
  // 函数体里必须是「projected ?? projectFragmentBlocks(doc)」：
  // 没传就自己算（其余调用方照旧），传了就不重算。
  for (const fn of ["persistNoteDoc", "resolveNoteDocFlushTarget"]) {
    const at = source.indexOf(`export async function ${fn}(`);
    const body = source.slice(at, at + 2500);
    assert.ok(
      /projected\s*\?\?\s*projectFragmentBlocks\(doc\)/.test(body),
      `${fn} 的函数体里没有「projected ?? projectFragmentBlocks(doc)」——`
      + "要么它硬算（白费调用方算的那份），要么它只认入参（其余调用方直接坏掉）",
    );
  }
});

test("【自证】形状判据会红：去掉共用就会被抓", () => {
  const real = readFileSync(COLLAB, "utf8");
  // 模拟"回到各自去算"的写法
  const regressed = real.replace(
    /const projected = projectFragmentBlocks\(document\);/,
    "const projectedUnused = projectFragmentBlocks(document);",
  );
  assert.ok(
    !/const\s+projected\s*=\s*projectFragmentBlocks\(/.test(regressed),
    "自证样本没造好：改名之后应当认不出那个变量名",
  );
  // 自证不该改动磁盘上的文件
  assert.ok(
    /const\s+projected\s*=\s*projectFragmentBlocks\(/.test(readFileSync(COLLAB, "utf8")),
    "自证：真实文件里那一行还在",
  );
});
