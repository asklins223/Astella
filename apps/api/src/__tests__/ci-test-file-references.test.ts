/**
 * CI / npm 脚本点名的集成测试文件必须真的存在（doc 34 L31）。
 *
 * 病是这么来的：`apps/api/package.json` 的 `test:companion-integration:postgres`
 * 里写着 `assistant-deliveries-kind-constraint-postgres.integration.ts`，
 * 盘上那个文件却没有 `-postgres` 后缀；`.github/workflows/ci.yml` 又点着
 * `db-commit-port.integration.ts`，而那个测试早就不在了。两处都在
 * `fresh-migrations` 那条链上，`ci.yml` 的注释还写着"其中 kind-constraint 那条
 * 锁死『代码 kind 集合 == 库约束』"——**锁不锁得住取决于那个文件跑没跑**，
 * 而它跑不到：`node --test` 对不存在的文件直接失败，整个 job 红在"找不到文件"上，
 * 没人会去读那条真实断言。
 *
 * 这道检查故意写成单测而不是新增 CI 步骤：它跟着现有的 api 单元 job 一起跑，
 * 不需要动 workflow，也不会因为"新加的 job 没人看"而形同虚设。
 *
 * 一个真踩过的坑写在前面：**基准目录要跟着 `working-directory` 走**。
 * 第一版把 `workers/ai-worker/src/integration-tests/queue-postgres.integration.ts`
 * 报成了死引用——它在仓库根下当然不存在。凡是"引用不存在"的结论，
 * 先证明你是按谁的目录解析的。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
// 本文件在 apps/api/src/__tests__ 下，到仓库根是四层。
// 数错层级的后果很阴：路径全都不存在，但断言只检查"引用都存在的文件都在"，
// 空清单会一路绿到底——所以下面还有一条"清单不得少于 20 条"的反向断言。
const repoRoot = resolve(here, "..", "..", "..", "..");

const INTEGRATION_REF = /src\/integration-tests\/([\w.-]+\.ts)/g;

/**
 * `--test` 脚本里点名的**每一个** `.ts` token，无论带不带目录。
 *
 * 这条是 2026-09-29 补的，理由是上面那条正则正好在出事的地方瞎了：
 * `INTEGRATION_REF` 要求路径**带** `src/integration-tests/` 前缀，而真正的 bug
 * （`test:learning-rounds:postgres` 里那条 `note-route-coverage-postgres.integration.ts`
 * 漏了前缀）就**没有**前缀，于是既没被这条守卫抓到，
 * 也因为 Node 的 `node --test` 在"至少有一个文件存在"时会**静默丢弃缺失文件并退出 0**
 * 而让 CI 长期绿灯——一整套 28KB 的路由级集成测试从没跑过。
 *
 * 所以判据不能是"路径长得像不像集成测试"，只能是：
 * **只要脚本跑的是 `--test`，它点名的每个 `.ts` token 都必须在盘上存在。**
 *
 * `(?<![\w.*\/-])` 保证不会从 token 中间开始匹配（否则 `a-b-c.ts` 会被从 `c` 匹配上），
 * 也不会从 shell glob 的 `*` 之后开始匹配（否则 `*.test.ts` 会被当成 `.test.ts`）。
 */
const TEST_FILE_TOKEN = /(?<![\w.*\/-])([\w.\/-]+\.ts)\b/g;

/**
 * 从一条命令串里抽出被点名的 `.ts`（单独抽出来，好让"解析器本身"可被验证）。
 *
 * 含 `*` 的是 shell glob 而不是文件名——`npm test` 那条脚本用的是
 * `$(find src -name '*.test.ts' | sort)`，它点名的不是某个具体文件，跳过。
 */
function parseTestFileTokens(command: string): string[] {
  return [...command.matchAll(TEST_FILE_TOKEN)]
    .map((match) => match[1])
    .filter((token) => !token.includes("*"));
}

function testFileTokensFromScripts(): Array<{ label: string; file: string }> {
  const found: Array<{ label: string; file: string }> = [];
  for (const pkg of ["apps/api", "workers/ai-worker", "apps/desktop-client"]) {
    const manifest = join(repoRoot, pkg, "package.json");
    if (!existsSync(manifest)) continue;
    const scripts = JSON.parse(readFileSync(manifest, "utf8")).scripts ?? {};
    for (const [name, body] of Object.entries(scripts)) {
      const command = String(body);
      if (!command.includes("--test")) continue;
      for (const token of parseTestFileTokens(command)) {
        found.push({ label: `${pkg} package.json → ${name} → ${token}`, file: `${pkg}/${token}` });
      }
    }
  }
  return found;
}

function packageScripts(): Array<{ label: string; file: string }> {
  const found: Array<{ label: string; file: string }> = [];
  for (const pkg of ["apps/api", "workers/ai-worker", "apps/desktop-client"]) {
    const manifest = join(repoRoot, pkg, "package.json");
    if (!existsSync(manifest)) continue;
    const scripts = JSON.parse(readFileSync(manifest, "utf8")).scripts ?? {};
    for (const [name, body] of Object.entries(scripts)) {
      for (const match of String(body).matchAll(INTEGRATION_REF)) {
        found.push({ label: `${pkg} package.json → ${name}`, file: `${pkg}/src/integration-tests/${match[1]}` });
      }
    }
  }
  return found;
}

/**
 * ci.yml 里的引用按"当前 step 的 working-directory"解析：
 * 遇到新的 `- name:` 就退回仓库根（workflow 的默认目录）。
 */
function ciReferences(): Array<{ label: string; file: string }> {
  const workflow = join(repoRoot, ".github", "workflows", "ci.yml");
  if (!existsSync(workflow)) return [];
  const found: Array<{ label: string; file: string }> = [];
  let workingDirectory = "";
  for (const line of readFileSync(workflow, "utf8").split("\n")) {
    if (/^\s*-\s+name:/.test(line)) workingDirectory = "";
    const wd = line.match(/^\s*working-directory:\s*(\S+)/);
    if (wd) workingDirectory = wd[1].trim();
    for (const match of line.matchAll(INTEGRATION_REF)) {
      const relative = `${workingDirectory ? `${workingDirectory}/` : ""}src/integration-tests/${match[1]}`;
      found.push({ label: `ci.yml [wd=${workingDirectory || "."}] ${match[1]}`, file: relative });
    }
  }
  return found;
}

describe("CI 与脚本点名的集成测试文件都存在", () => {
  it("清单不为空（解析失败不能伪装成通过）", () => {
    const total = [...packageScripts(), ...ciReferences()];
    assert.ok(total.length >= 20, `只解析到 ${total.length} 条引用，八成是路径/正则坏了`);
  });

  for (const reference of [...packageScripts(), ...ciReferences()]) {
    it(reference.label, () => {
      assert.ok(
        existsSync(join(repoRoot, reference.file)),
        `引用了不存在的测试文件：${reference.file}——这条 job 会红在"找不到文件"上，`
        + "真实断言一条也没跑",
      );
    });
  }
});

describe("跑 --test 的脚本里，每个 .ts token 都必须在盘上（防 Node 静默丢弃）", () => {
  const tokens = testFileTokensFromScripts();

  /**
   * 分母自证。
   *
   * 故意**不**要求"仓库里至少有一条违规"：2026-09-29 修掉那条之后违规归零，
   * 那样"清单非空"会当场变红——那说明守卫被违反了，而不是它坏了。
   * 正确做法是拿解析器自己的产物证明它**看得见那次事故**，见下。
   */
  it("解析器看得见 2026-09-29 那条真实事故（漏前缀的裸文件名）", () => {
    const realCommand = [
      "node --import tsx --test --test-concurrency=1",
      "src/integration-tests/note-learning-round-access-revoked-postgres.integration.ts",
      "note-route-coverage-postgres.integration.ts",
    ].join(" ");
    assert.ok(
      parseTestFileTokens(realCommand).includes("note-route-coverage-postgres.integration.ts"),
      "解析器已经看不见裸文件名了——这条守卫正是在这里瞎的，它必须先红",
    );
  });

  it("带目录的路径也会被完整捕获（不是只抓裸文件名）", () => {
    const command = "node --test src/integration-tests/note-learning-rounds-postgres.integration.ts";
    assert.deepEqual(parseTestFileTokens(command), ["src/integration-tests/note-learning-rounds-postgres.integration.ts"]);
  });

  it("不会从 token 中间开始匹配", () => {
    assert.deepEqual(parseTestFileTokens("node --test a-b-c.integration.ts"), ["a-b-c.integration.ts"]);
  });

  it("shell glob 不算文件引用（npm test 用的是 find + '*.test.ts'）", () => {
    assert.deepEqual(
      parseTestFileTokens("node --import tsx --test $(find src -name '*.test.ts' | sort)"),
      [],
    );
  });

  it("扫描范围本身有效：至少读到一条 --test 脚本", () => {
    let testScriptCount = 0;
    for (const pkg of ["apps/api", "workers/ai-worker", "apps/desktop-client"]) {
      const manifest = join(repoRoot, pkg, "package.json");
      if (!existsSync(manifest)) continue;
      const scripts = JSON.parse(readFileSync(manifest, "utf8")).scripts ?? {};
      testScriptCount += Object.values(scripts).filter((body) => String(body).includes("--test")).length;
    }
    assert.ok(testScriptCount >= 1, "一条 --test 脚本都没读到，扫描范围可能整个坏了");
  });

  for (const reference of tokens) {
    it(reference.label, () => {
      assert.ok(
        existsSync(join(repoRoot, reference.file)),
        `脚本点名了 ${reference.file}，但它在盘上不存在。`
        + "Node 的 node --test 在同时给了有效文件与缺失文件时会**静默丢弃缺失文件并退出 0**，"
        + "所以这类错误不会让 CI 变红，只会让这一条测试永远不跑。",
      );
    });
  }
});

