/**
 * 守卫：能吃下**整篇正文**的入口，都必须自己声明 bodyLimit。
 *
 * ## 这条守卫挡住的是哪次真事故
 *
 * 实测（2026-10-14）：75 万字符的整篇新建走 `POST /notes` 直接回 413
 * `FST_ERR_CTP_BODY_TOO_LARGE`，而同一篇正文从 `/import/markdown`（50 MiB）进得来。
 * 差别的来源不是设计——`noteCreateSchema` 每块允许 50,000 字符且不设块数上限，
 * 这条路由却没写 `bodyLimit`，于是吃的是 Fastify 的默认 1 MiB（约 34 万汉字）。
 * 症状长得像"这篇太长，产品不支持"，实际是传输闸门和正文合同各说一套。
 *
 * ## 判据怎么定的
 *
 * 只看一件事：注册那一发里有没有显式 `bodyLimit`。框架默认值是一个**与产品无关**的数，
 * 任何按正文规模设计的入口都不该继承它。`/v2/notes/:id/doc-update` 那一支是反例的正形：
 * 它写了 8 MiB，并在路由里按解码后字节数给出可分辨的 `update_too_large`。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";

const API_ROOT = new URL("..", import.meta.url).pathname;
const NOTE_ROUTES = join(API_ROOT, "modules", "note", "routes.ts");
const SOURCE_ROUTES = join(API_ROOT, "modules", "source", "routes.ts");
const IMPORT_ROUTES = join(API_ROOT, "modules", "import", "routes.ts");

/** 注册那一发从路径到回调开头的那一段——`bodyLimit` 必须出现在这里。 */
function registration(source: string, method: "post", path: string): string {
  // 连方法名一起锚：同一个路径上 `app.get("/notes")` 是列表，它不该吃正文闸门这条判据。
  const at = source.indexOf(`app.${method}("${path}"`);
  assert.ok(at >= 0, `找不到入口 ${path}——它被搬走了，这条守卫的扫描范围要跟着更新`);
  const handler = source.indexOf("async (req", at);
  return source.slice(at, handler < 0 ? at + 600 : handler);
}

for (const [file, path] of [
  [NOTE_ROUTES, "/notes"],
  [SOURCE_ROUTES, "/sources"],
  [IMPORT_ROUTES, "/import/markdown"],
] as const) {
  test(`${path} 自己声明了 bodyLimit，不吃框架那 1 MiB 默认值`, () => {
    const source = readFileSync(file, "utf8");
    assert.ok(/bodyLimit\s*:/.test(registration(source, "post", path)),
      `${path} 的注册里没有 bodyLimit——正文合同允许到 50,000 字符一块且不设块数，`
      + "传输闸门却停在框架默认的 1 MiB，长笔记会在这里被一句英文 413 挡掉。");
  });
}

test("整篇新建的那道闸与正文上限同一个源", () => {
  const source = readFileSync(NOTE_ROUTES, "utf8");
  assert.match(source, /MAX_SOURCE_TEXT_BYTES/,
    "POST /notes 的 bodyLimit 应从 `MAX_SOURCE_TEXT_BYTES`（一份文档正文的唯一上限）推出来；"
    + "在这里另写一个字符数，下一次改正文上限就又对不上。");
});
