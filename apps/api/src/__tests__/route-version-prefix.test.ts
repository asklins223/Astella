import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

/**
 * P1-5：版本段必须放在路径**最前**，形如 `/v2/notes/:id`。
 *
 * ## 收口前实测
 *
 * 240 条注册路由里同时存在三种风格：
 *   - `/v2/notes/:id`            72 条（头部风格，主流）
 *   - `/v2/reviews/queue`        15 条（**版本在中间**）
 *   - `/notes/:id`              152 条（无版本前缀）
 *
 * 15 条中间风格已迁到头部风格。剩下 152 条无前缀**不在本守卫范围内**——
 * 其中有 `/health`、`/metrics`、`/uploads` 这类本就不该带版本的端点，
 * 也有一批尚未决定要不要版本化的（见同目录的迁移清单文档）。
 * 把它们一并塞进守卫只会逼人写豁免名单，而豁免名单没人维护。
 *
 * ## 唯一豁免
 *
 * `/_astella/desktop/trust/v1/challenge` 是**内部命名空间**（`_astella` 前缀），
 * 不是业务路由：它由桌面主进程在建立可信连接前调用，调用方与服务端是一起发布的，
 * 没有第三方消费者，版本段在中间是有意为之（`desktop/trust/v1` 读起来是
 * "桌面信任协议的 v1"，不是"reviews 的 v2"那类业务版本）。
 * 改名会把这条内部协议的语义也一起改掉，所以显式豁免并写明理由。
 */
const INTERNAL_NAMESPACE_EXEMPTIONS: ReadonlySet<string> = new Set([
  "/_astella/desktop/trust/v1/challenge",
]);

/** `/v2`、`/v3`… —— 段首形如 v + 纯数字。 */
const VERSION_SEGMENT = /^v\d+$/;

const API_ROOT = new URL("../..", import.meta.url).pathname;

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) tsFiles(full, out);
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

type RouteRef = { file: string; line: number; path: string };

function collectRoutes(): RouteRef[] {
  // app.get("/…") / app.post("/…") …，含泛型形参 `app.get<{…}>(` 的写法
  const pattern = /\bapp\.(?:get|post|patch|delete|put)\s*(?:<[^>]*>)?\s*\(\s*(["'])(\/[^"']*)\1/g;
  const refs: RouteRef[] = [];
  for (const file of tsFiles(join(API_ROOT, "src"))) {
    if (file.endsWith(".test.ts")) continue;
    const source = readFileSync(file, "utf8");
    for (const m of source.matchAll(pattern)) {
      refs.push({
        file: relative(API_ROOT, file).split("\\").join("/"),
        line: source.slice(0, m.index ?? 0).split("\n").length,
        path: m[2]!,
      });
    }
  }
  return refs;
}

/**
 * 判定本体，单独抽出来是为了让"它自己还能不能抓"**真的能被测**。
 *
 * 第一版把判定内联在遍历里，结果是：把 `versionInMiddle` 改成 `false`
 * 之后整条测试依然全绿——守卫不抓任何东西时，没有任何一条断言会红。
 * 那种"看起来有守卫、其实已经失效"的状态比没有守卫更糟。
 * 下面是它的自证。
 */
export function versionSegmentMisplaced(path: string): boolean {
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return false;
  if (VERSION_SEGMENT.test(segments[0]!)) return false;
  // 注意是 slice(1) 而不是 slice(0, -1)：**尾部**的版本段
  // （/learning-runs/:runId/result/v2）同样违规，抽函数时漏掉它会让自证变红——
  // 而那正是这条自证存在的意义。
  return segments.slice(1).some((s) => VERSION_SEGMENT.test(s));
}

test("【自证】判定本身抓得到中间与尾部版本段（守卫失效时这条会红）", () => {
  // 这几条是本仓库里真实存在过的三种违规形状
  assert.ok(versionSegmentMisplaced("/reviews/v2/queue"), "版本在中间");
  assert.ok(versionSegmentMisplaced("/home/v2/suggestion"), "版本在中间，另一族");
  assert.ok(versionSegmentMisplaced("/learning-runs/:runId/result/v2"), "版本在尾部");
  assert.ok(versionSegmentMisplaced("/a/b/c/v1"), "更深处的尾部");

  // 合法的不能误报
  assert.equal(versionSegmentMisplaced("/v2/reviews/queue"), false, "头部风格");
  assert.equal(versionSegmentMisplaced("/v3/understanding/topology"), false, "头部风格，v3");
  assert.equal(versionSegmentMisplaced("/notes/:id"), false, "无版本前缀");
  assert.equal(versionSegmentMisplaced("/v2"), false, "整条路径就是一个版本段");
  assert.equal(versionSegmentMisplaced("/companion/vision"), false, "vision 不是版本段");
  assert.equal(versionSegmentMisplaced("/v2beta/thing"), false, "v2beta 不是 v + 纯数字");
});

test("版本段必须在路径最前（/v2/…），不能在中间（/v2/reviews/…）", () => {
  const offenders: string[] = [];
  for (const route of collectRoutes()) {
    if (INTERNAL_NAMESPACE_EXEMPTIONS.has(route.path)) continue;
    if (!versionSegmentMisplaced(route.path)) continue;
    const head = route.path.split("/").filter(Boolean)[0];
    offenders.push(`${route.file}:${route.line}  ${route.path}  →  应为 /${head}/… 把版本提到最前`);
  }
  assert.deepEqual(offenders, [],
    "版本段放在了路径中间：\n" + offenders.join("\n"));
});

test("豁免名单里的路径确实存在（否则豁免会变成僵尸条目）", () => {
  const paths = new Set(collectRoutes().map((r) => r.path));
  for (const exempt of INTERNAL_NAMESPACE_EXEMPTIONS) {
    assert.ok(paths.has(exempt), `豁免的 ${exempt} 已经不存在了，删掉这条豁免`);
  }
});

test("头部风格的路由是多数派（否则守卫在守一个少数派约定）", () => {
  const refs = collectRoutes();
  const versioned = refs.filter((r) => VERSION_SEGMENT.test(r.path.split("/").filter(Boolean)[0] ?? ""));
  const total = refs.length;
  assert.ok(total > 0, "一条路由都没收集到，判据本身坏了");
  assert.ok(
    versioned.length / total > 0.2,
    `带版本前缀的只占 ${versioned.length}/${total}，这个守卫在守一个少数派约定`,
  );
});
