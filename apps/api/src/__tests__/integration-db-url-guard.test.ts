/**
 * 测试代码里**不许**再出现写死的开发库串（39d §19 那条待办的守卫那一半）。
 *
 * 病是这么来的（2026-09-25 实测）：一批集成测试把 `process.env.DATABASE_URL ?? "postgres://…@localhost:5432/ailearn"`
 * 当成方便，于是**在本机跑测试时夹具悄悄写进了开发者真实的 dev 库**（那一轮多出 12 个
 * fixture 用户／10 个 workspace，事后数出来的）。CI 里看不出来——那条链上变量总是设好的，
 * 所以这个洞只在"人手动跑"时现形，而那恰恰是最常发生的一种跑法。
 *
 * 现在统一走 `@ailearn/shared/integration-test-db-env` 的 `testDatabaseUrl()`：变量缺了
 * 当场喊，并告诉人怎么起一次性库。这道守卫把"不许再长回来"钉死——扫到一处就红。
 *
 * **扫描范围**：测试面（`src/integration-tests`、`src/__tests__`、`*.test.ts`）与
 * `src/scripts`。**产品代码不在范围内**，而且是有意的：`db/client.ts`／`db/migrate.ts`／
 * `server.ts`／`run-processing-tick.ts` 里那几处回落指向的是 compose 内的服务名
 * （`@postgres:5432`）且都带 `NODE_ENV=production` 必填守卫，进程在宿主机上根本连不上它，
 * 构不成"写进真实 dev 库"那条路。哪天它们要改，是另一件事（改的是产品行为，不是测试夹具）。
 *
 * 判据只认**代码行**里的字符串字面量，不认注释与文档里的示例（那些地名出现在运行说明里）。
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { HARDCODED_DEV_DATABASE_URL_PATTERN } from "@ailearn/shared/integration-test-db-env";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const SCAN_ROOTS = ["apps", "workers", "packages"];
const SKIP_DIRS = new Set(["node_modules", "dist", "out", "coverage", ".impeccable", "project-archive"]);

/** 测试面：这些路径下的代码是"跑测试的人"而不是"产品"。 */
function isTestFacing(relativePath: string): boolean {
  return (
    relativePath.includes("/src/integration-tests/")
    || relativePath.includes("/src/__tests__/")
    || /\.(test|spec)\.[cm]?[jt]sx?$/.test(relativePath)
    || relativePath.includes("/src/scripts/")
  );
}

function sourceFiles(root: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(root, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx|mts)$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * 返回这份源码里**代码行**中命中写死开发库串的行号。
 *
 * 为什么要剥注释：本仓库的运行说明里到处写着 `DATABASE_URL=postgres://ailearn_dev@127.0.0.1:5432/ailearn`
 * 这类示例（那是正确的用法），把它们算违例会让这道守卫从第一天起就红成一片。
 */
export function hardcodedDevDbUrlLines(source: string): number[] {
  return source
    .split("\n")
    .map((line, index) => ({ line, index: index + 1 }))
    .filter(({ line }) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("*") || trimmed.startsWith("//")) return false;
      return HARDCODED_DEV_DATABASE_URL_PATTERN.test(line);
    })
    .map(({ index }) => index);
}

describe("测试代码里没有写死的开发库串", () => {
  it("一处都不剩（扫测试面全仓库）", () => {
    const files = SCAN_ROOTS
      .flatMap((root) => sourceFiles(join(repoRoot, root)))
      .filter((file) => isTestFacing(relative(repoRoot, file)))
      .filter((file) => !file.endsWith("integration-db-url-guard.test.ts"));

    // 阳性对照的第一半：守卫必须真的读到了文件。读不到而全绿是最坏的假绿。
    assert.ok(files.length > 100, `扫描面只有 ${files.length} 个文件，路径或过滤条件写错了`);

    const violations = files
      .map((file) => ({
        file: relative(repoRoot, file),
        lines: hardcodedDevDbUrlLines(readFileSync(file, "utf8")),
      }))
      .filter((entry) => entry.lines.length > 0);

    assert.deepEqual(
      violations.map((entry) => `${entry.file}: ${entry.lines.join(", ")}`),
      [],
      "测试代码里又出现了写死的开发库串。请改用 testDatabaseUrl()（@ailearn/shared/integration-test-db-env）："
        + "变量缺了就喊，绝不静默落到某个开发库。",
    );
  });

  it("正对照：检测形状会响；负对照：注释里的示例不响", () => {
    assert.deepEqual(
      hardcodedDevDbUrlLines('const CONN = process.env.DATABASE_URL ?? "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";'),
      [1],
    );
    assert.deepEqual(
      hardcodedDevDbUrlLines('process.env.DATABASE_URL_WORKER ??= "postgres://ailearn_worker:ailearn_dev@127.0.0.1:5432/ailearn";'),
      [1],
    );
    // 负对照——注释里的运行示例（本仓库到处都是）不算违例。
    assert.deepEqual(
      hardcodedDevDbUrlLines(' * 运行：DATABASE_URL="postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn" \\'),
      [],
    );
    assert.deepEqual(
      hardcodedDevDbUrlLines('// DATABASE_URL=postgres://ailearn:ailearn_dev@localhost:5432/ailearn'),
      [],
    );
    // 负对照——指向别处（compose 服务名、别的库名）的串不是这一条要抓的东西。
    assert.deepEqual(
      hardcodedDevDbUrlLines('const url = "postgres://ailearn:ailearn_dev@postgres:5432/ailearn";'),
      [],
    );
    assert.deepEqual(
      hardcodedDevDbUrlLines('const url = "postgres://ailearn:ailearn_dev@localhost:5432/some_other_db";'),
      [],
    );
  });
});
