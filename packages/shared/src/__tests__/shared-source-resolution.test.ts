/**
 * `@astella/shared` 在**运行时**到底从哪读：必须是活源码，不是安装期快照。
 *
 * 为什么这条要常驻（2026-09-27 量出来的三件事）：
 * ① `apps/api/node_modules/@astella/shared` 与 worker 那份都不是指向 `packages/shared` 的活符号链接，
 *    而是 `.pnpm` 里的**硬链快照**（`install-links=true`）。硬链只在那一刻等于源码：
 *    编辑器保存是"写新文件再 rename"，链接当场断（本机拿 `/tmp` 一对硬链实测：改完 `dst` 仍是旧内容）。
 * ② 但跑套件**不需要重装**——`apps/api/tsconfig.json` 与 `workers/ai-worker/tsconfig.json` 都把
 *    `@astella/shared/*` 映射到 `../../packages/shared/src/*.ts`，而 **tsx 真的在运行时应用 `paths`**：
 *    从包目录里问 `import.meta.resolve`，交回的是 `packages/shared/src/…`；临时往 shared 里放一个新文件，
 *    不重装也 import 得到。⇒ 这条映射是"改了合同马上生效"的唯一支点。
 * ③ 支点被拿掉之后的失效方向是**静默**的：typecheck 走 `paths`（读新合同），测试跑走快照（读旧合同），
 *    于是"加了一个必填字段"这种改动会让类型检查与用例各看一份合同，绿得没有任何意义。
 *    同族的既有教训：`workers/ai-worker/scripts/companion-s1-probe.ts` 头部写着"不显式给 `--tsconfig`
 *    会退回安装期快照、新加的合同文件会找不到"。
 *
 * 所以两条腿都要：**结构腿**钉映射还在，**行为腿**问运行时"你刚才到底读的那一份在哪"。
 * 只有结构腿会在"映射在、但那条链路不走 tsx"时空转；只有行为腿会在解析失败时被当成"没落在 node_modules ⇒ 活源码"，
 * 因此行为腿自带一格"这一发必须真的解析成功"的正控制。
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");
const SHARED_SRC = join(REPO_ROOT, "packages", "shared", "src");
/** 探哪一份合同不重要，重要的是它两边都存在（快照里也有一份）。 */
const PROBE_SUBPATH = "@astella/shared/learning-run-v2-contracts";
const PACKAGES = ["apps/api", "workers/ai-worker"] as const;

const RESOLVE_SNIPPET = `console.log(import.meta.resolve(${JSON.stringify(PROBE_SUBPATH)}))`;

/**
 * 从宿主包的 tsconfig 出发，问 tsx：这条 import 最终落在哪个文件。
 * 解析失败就抛出（不许被当成"落在别处"）。
 *
 * ## 为什么 cwd 不是宿主包本身（2026-10-05 改）
 *
 * 第一版把 cwd 设成 `apps/api`，靠"从那里启动，`--import tsx` 自然能解析到 tsx"。
 * 那是**借了宿主包的 node_modules**：CI 的 `Shared contracts` job 只 `npm ci` 了
 * `packages/shared`，`apps/api/node_modules` 在 runner 上根本不存在，于是 tsx 解析不到，
 * 这条腿报的是 `node:internal/modules/package_json_reader:314`——一个跟映射毫无关系的错。
 * 本地有装所以绿，CI 没装所以红：判据被安装产物绑架了。
 *
 * 改法：cwd 用 `packages/shared`（tsx 一定在这儿），用 `TSX_TSCONFIG_PATH` 显式指定
 * **宿主那份** tsconfig。判据问的问题没变——"宿主包的 paths 映射在运行时还指向活源码吗"，
 * 映射坏掉照样红（指到一份不存在的 tsconfig 或坏掉的 paths 都过不去），
 * 但不再依赖"三个包都装过"。
 */
function resolvedFrom(cwdRel: string): string {
  const probeCwd = import.meta.dirname; // packages/shared/src/__tests__ —— tsx 必装的地方
  const hostTsconfig = join(REPO_ROOT, cwdRel, "tsconfig.json");
  let out: string;
  try {
    out = execFileSync(
      "node",
      ["--import", "tsx", "--input-type=module", "-e", RESOLVE_SNIPPET],
      {
        cwd: probeCwd,
        encoding: "utf8",
        timeout: 60_000,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, TSX_TSCONFIG_PATH: hostTsconfig },
      },
    );
  } catch (error) {
    throw new Error(`${cwdRel} 里连解析都做不到（那不等于"读的是活源码"）：${describeFailure(error)}`);
  }
  const lines = out.split("\n").map((line) => line.trim()).filter(Boolean);
  assert.equal(lines.length, 1, `${cwdRel} 的解析读数不是一行：${JSON.stringify(out)}`);
  assert.ok(lines[0].startsWith("file://"), `${cwdRel} 交回的不是 file URL：${lines[0]}`);
  return resolve(new URL(lines[0]).pathname);
}

/**
 * 报错时真正有用的那几行，而不是堆栈首行。
 *
 * Node 的 stderr 长这样：第一行是 `file:///…/package_json_reader.js:314`，紧跟着才是
 * `[ERR_…]: 真正的说明`。只取 `split("\n")[0]` 拿到的是文件路径，等于什么都没说——
 * 上面那 314 就是这么来的：对着一个模块解析错误读文件行号。
 */
function describeFailure(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr ?? "";
  const meaningful = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^file:\/\/\/.*:\d+$/.test(line) && !/^\s*at\s/.test(line) && !/^-+$/.test(line));
  return meaningful.slice(0, 2).join(" ") || String(error);
}

/**
 * tsconfig 是 **JSONC**（这两份里都有 `//` 注释），不许 `JSON.parse` 整份。
 * 这里只需要回答"那条映射还在不在、指向哪"，所以按形状匹配，不解析。
 */
function hasLiveSharedMapping(cwdRel: string): boolean {
  const raw = readFileSync(join(REPO_ROOT, cwdRel, "tsconfig.json"), "utf8");
  return /"@astella\/shared\/\*"\s*:\s*\[[^\]]*packages\/shared\/src/s.test(raw);
}

test("结构腿：两个包的 tsconfig 都把 @astella/shared/* 映射到活源码", () => {
  for (const cwdRel of PACKAGES) {
    assert.ok(hasLiveSharedMapping(cwdRel),
      `${cwdRel}/tsconfig.json 里找不到「"@astella/shared/*" → ../../packages/shared/src/*.ts」那条映射 ⇒ `
      + "运行时退回 .pnpm 里那份安装期快照，而 typecheck 还在读活源码：两边各看一份合同");
  }
});

test("行为腿：tsx 运行时真的把 @astella/shared 解析到活源码，不是 node_modules", () => {
  for (const cwdRel of PACKAGES) {
    const resolved = resolvedFrom(cwdRel);
    assert.ok(!resolved.includes("/node_modules/"),
      `${cwdRel} 运行时读到的是安装期快照：${resolved} ⇒ 改了合同不会生效，而 typecheck 还在读活源码`);
    assert.ok(resolved.startsWith(SHARED_SRC),
      `${cwdRel} 解析到的不是 shared 的活源码：${resolved}`);
  }
});

test("行为腿自己的正控制：没解析出来的东西不能被判成「读到了活源码」", () => {
  // 这一格只有一件事可验：解析失败会被 resolvedFrom 抛出来，而不是返回一个"不在 node_modules"的假路径。
  let threw = false;
  try {
    execFileSync("node",
      ["--import", "tsx", "--input-type=module", "-e", 'console.log(import.meta.resolve("@astella/shared/这一份合同不存在-zz"))'],
      {
        // 与上面那条探针**同一套环境**，否则这一格就成了一次换了条件的对照：
        // 它要证明的是"解析失败会被当成失败"，不是"换个 cwd 会不会失败"。
        cwd: import.meta.dirname,
        encoding: "utf8",
        timeout: 60_000,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, TSX_TSCONFIG_PATH: join(REPO_ROOT, "apps/api", "tsconfig.json") },
      });
  } catch {
    threw = true;
  }
  assert.ok(threw, "一个不存在的合同子路径居然解析成功了 ⇒ 行为腿把「命中别处」当成了命中活源码");
});
