#!/usr/bin/env node
/**
 * `packages/shared` 的子路径解析验证（P1-15）。
 *
 * ## 为什么宿主 typecheck 在这里不可信
 *
 * 2026-09-29 实测（`.github/scripts/verify-shared-exports.mjs` 的判定依据）：
 *
 * ```
 * // apps/api/src/<探针>.ts
 * import { getPromptCacheProviders } from "@ailearn/shared/feature-flags";
 * ```
 *
 * ```
 * npx tsc --noEmit        →  exit 0     （绿）
 * node import(同一条路径)  →  ERR_PACKAGE_PATH_NOT_EXPORTED
 * ```
 *
 * `feature-flags.ts` **在磁盘上真实存在**，所以 TypeScript 能顺着
 * `node_modules/@ailearn/shared`（本仓是 workspace 软链）找到它；
 * 而 Node 的解析器读的是 `package.json` 的 `exports` 字段，那条子路径没登记，
 * 于是运行时直接拒。
 *
 * 也就是说：**只要有人写了一个"文件存在但没导出"的深路径 import，
 * 宿主 typecheck 一定是绿的，失败发生在运行时。** 本仓 126 条 exports 是
 * 零通配符的（B5 重组的硬约束），所以这不会自己暴露。
 *
 * ## 这个脚本做什么
 *
 * 1. 扫出全仓每一处 `@ailearn/shared/<子路径>` import；
 * 2. **用 Node 自己的解析器**逐个试一遍（`import()`），而不是看字符串——
 *    看的���是运行时会接受的那一份；
 * 3. exports 里的每一条 target 必须在磁盘上真实存在；
 * 4. 零通配符这条约束不许被破坏。
 *
 * 任何一条不过就 exit 1。
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SHARED = join(ROOT, "packages/shared");
const SHARED_PKG = join(SHARED, "package.json");

/** 会 import `@ailearn/shared/...` 的地方。 */
const SCAN_ROOTS = [
  "apps/api/src",
  "apps/desktop-client/src",
  "workers/ai-worker/src",
  "packages/shared/src",
  ".github/scripts",
];

const CODE_EXT = new Set([".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js"]);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (CODE_EXT.has(entry.name.slice(entry.name.lastIndexOf(".")))) out.push(full);
  }
  return out;
}

/** 抓出源码里出现的每一个 `@ailearn/shared/<子路径>`。 */
function collectSpecifiers() {
  const found = new Map(); // specifier -> 引用它的文件
  // 只匹配**字符串字面量**里的 import/require/dynamic import，
  // 避免把注释里提到的路径算进来（注释里写错字不该让构建红）。
  const patterns = [
    /(?:from|import|require)\s*\(?\s*["']@ailearn\/shared\/([^"']+)["']/g,
    /import\(\s*["']@ailearn\/shared\/([^"']+)["']\s*\)/g,
  ];
  // 扫自己会把注释里举例的 specifier 也算进来，报错信息里出现"本文件引用了它"
  // 这种自指的噪音。先把自己排掉。
  const SELF = fileURLToPath(import.meta.url);
  for (const root of SCAN_ROOTS) {
    for (const file of walk(join(ROOT, root))) {
      if (file === SELF) continue;
      const source = readFileSync(file, "utf8");
      const rel = relative(ROOT, file);
      for (const pattern of patterns) {
        for (const m of source.matchAll(pattern)) {
          const spec = `@ailearn/shared/${m[1].replace(/\/$/, "")}`;
          if (!found.has(spec)) found.set(spec, new Set());
          found.get(spec).add(rel);
        }
      }
    }
  }
  return found;
}

function fail(lines) {
  console.error("[shared-exports] 验证失败：\n" + lines.join("\n"));
  process.exit(1);
}

async function main() {
  const pkg = JSON.parse(readFileSync(SHARED_PKG, "utf8"));
  const exportsMap = pkg.exports ?? {};

  // ── 1. 零通配符（本仓的硬约束，B5 重组依赖它）────────────────────
  const wildcards = Object.keys(exportsMap).filter((k) => k.includes("*"));
  if (wildcards.length > 0) {
    fail([
      "exports 里出现了通配符，本仓约定是零通配符（B5 按域重组靠它保证 key 不漂）：",
      ...wildcards.map((k) => `  ${k}`),
    ]);
  }

  // ── 2. exports 的每条 target 必须在磁盘上存在 ───────────────────
  const brokenTargets = [];
  for (const [key, value] of Object.entries(exportsMap)) {
    const targets = typeof value === "string" ? [value] : Object.values(value);
    for (const target of targets) {
      if (typeof target !== "string" || !target.startsWith(".")) continue;
      const full = join(SHARED, target);
      if (!existsSync(full) || !statSync(full).isFile()) {
        brokenTargets.push(`  ${key} → ${target}（磁盘上没有这个文件）`);
      }
    }
  }
  if (brokenTargets.length > 0) {
    fail(["exports 指向了不存在的文件：", ...brokenTargets]);
  }

  // ── 3. 逐条用 Node 的解析器实跑（这是本脚本的核心）────────────
  // 故意在 apps/api 下执行：那里有一个指向 packages/shared 的 workspace 软链，
  // 解析器走的正是生产/测试会走的那条路径。
  const specifiers = collectSpecifiers();
  if (specifiers.size === 0) {
    console.error("[shared-exports] 一条 @ailearn/shared 深路径 import 都没扫到——收集器坏了");
    process.exit(1);
  }

  // ── 3. 逐条按**运行时解析器**验证子路径真的能解析 ──────────────
  //
  // ⚠️ 两个踩过的坑，都写在下面，免得下一个人重写一遍：
  //
  // (a) **解析基准必须是 apps/api**，不能用本脚本自己所在的仓库根。
  //     根目录的 `node_modules/@ailearn/` 是空的（workspace 软链只建在各包下面），
  //     从那儿解析会一律失败。
  //
  // (b) **只做"解析路径"，不要真的 import()**。`packages/shared/src` 里放的是
  //     `.ts` 源文件，裸 `node` 加载不了（会报 ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING），
  //     而本项目跑在 `--import tsx` 下——那与"子路径有没有被导出"是两件事。
  //     `require.resolve()` 走的是 Node 的解析器、**读 exports 字段**，
  //     正好只回答我们问的那个问题，且不执行模块。
  const requireFromApi = createRequire(join(ROOT, "apps/api/package.json"));

  const rejected = [];
  const unresolved = [];
  for (const [spec, files] of specifiers) {
    try {
      requireFromApi.resolve(spec);
    } catch (error) {
      const code = error?.code ?? "(无 code)";
      const where = [...files].slice(0, 3).join(", ");
      if (code === "ERR_PACKAGE_PATH_NOT_EXPORTED") {
        rejected.push(`  ${spec}\n      引用处：${where}`);
      } else {
        // 其余解析失败同样要报：解析不到 = 构建到那里就炸，
        // 不该因为"不是我想拦的那一个 code"就被静默放过
        // （第一版正是这么漏掉了整条检查——它一路"全绿"通过）。
        unresolved.push(`  ${spec}  [${code}]\n      引用处：${where}`);
      }
    }
  }
  if (unresolved.length > 0) {
    fail([
      "这些 @ailearn/shared 深路径连解析都没成功（不是 exports 的问题，是包根本找不到）：",
      ...unresolved,
      "",
      "常见原因：workspace 软链没建（该目录下 node_modules/@ailearn/shared 不存在）。",
    ]);
  }

  if (rejected.length > 0) {
    fail([
      "这些 @ailearn/shared 深路径**文件在磁盘上存在**、但没登记进 exports，",
      "所以 TypeScript 是绿的、运行时却是 ERR_PACKAGE_PATH_NOT_EXPORTED：",
      ...rejected,
      "",
      "修法：把子路径加进 packages/shared/package.json 的 exports（零通配符，逐条列）。",
    ]);
  }

  // 顺带报一件容易忘的事：pnpm 把 file: 依赖**硬拷贝**进 store，
  // 所以 packages/shared 加了新导出之后，各包的 node_modules 里那份是旧的，
  // 必须重装才能让运行时的解析器看见。这一条 P1-15 真的咬到过。
  console.log(
    `[shared-exports] OK：${Object.keys(exportsMap).length} 条 exports 全部有对应文件；`
    + `${specifiers.size} 处深路径 import 全部能通过 Node 的解析器。`,
  );
  console.log(
    "[shared-exports] 提醒：packages/shared 改过 exports 之后，"
    + "需要在各包目录里重跑一次 pnpm install（file: 依赖是硬拷贝，不会自动跟着变）。",
  );
}

await main();
