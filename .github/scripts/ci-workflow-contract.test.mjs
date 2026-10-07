import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * CI 工作流契约：**CI 跑的东西必须和本地跑的东西是同一套。**
 *
 * 2026-10-06 之前这份守卫盯的是另一件事（Gitleaks 必须在 typecheck job 上），
 * 而那件事背后是 1742 行的发布流水线。它长期给出的结论是"CI 坏了"，
 * 可本地全绿——因为 CI 跑的本地产物之外的十来个门禁。
 *
 * 现在的口径窄得多，也就硬得多：`make verify` 逐个包跑 typecheck + npm test，
 * 工作流必须**逐个包**也跑。少接一个包，本地绿、CI 静默不测——那正是当初
 * `agent-core` / `agent-host` 连续几轮没人跑的那类事故（它们有测试，
 * 但不在任何验证目标里）。这道守卫就是那份台账。
 *
 * 反过来也钉一条：CI 里不许再冒出本地不存在的门禁名（coverage-gate、
 * skip-todo-gate、gitleaks、npm audit、trivy）。它们是真门禁、脚本也还在，
 * 但**不在 CI 这条路上**——再挂回来就是再制造一次"本地绿、CI 红"。
 */

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const workflowPath = join(repositoryRoot, ".github/workflows/main-ci.yml");
const workflow = readFileSync(workflowPath, "utf8");
const makefile = readFileSync(join(repositoryRoot, "Makefile"), "utf8");

/** `make verify` 里逐个包跑的那些目录，必须和 CI 跑的那几个是同一份。 */
const VERIFIED_PACKAGES = [
  "packages/shared",
  "packages/agent-core",
  "packages/agent-host",
  "packages/ai-quality",
  "apps/api",
  "apps/desktop-client",
  "workers/ai-worker",
];

/** 已退出 CI、脚本仍在仓库里的门禁。名字出现在工作流里就是挂错了地方。 */
const GATES_THAT_LEFT_CI = [
  "coverage-gate",
  "skip-todo-gate",
  "gitleaks",
  "npm audit",
  "trivy",
  "pgvector",
];

/** 工作流里除注释与空行以外的内容。 */
function codeLines(source) {
  return source
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"))
    .join("\n");
}

/**
 * 工作流里**真的会被测试**的目录。
 *
 * 判据不能是"文件里出现过这个包名"：包名还会出现在别人的依赖安装清单里
 * （`agent-host` 装 `agent-core`），那样少测一个包照样绿——2026-10-06 实测过，
 * 拿掉 `packages/agent-core` 的 `path:` 之后这道守卫还是全绿。
 *
 * 只有两处算数：矩阵里的 `path:`（决定 `typecheck`/`test` 跑在哪），
 * 和字面量的 `working-directory:`。`${{ matrix.path }}` 那种引用不算，
 * 它指向的值已经在 `path:` 里数过了。
 */
function testedPaths(source) {
  const code = codeLines(source);
  const found = new Set();
  for (const match of code.matchAll(/^\s+path:\s*(\S+)\s*$/gm)) found.add(match[1]);
  for (const match of code.matchAll(/^\s+working-directory:\s*(\S+)\s*$/gm)) {
    if (!match[1].startsWith("${{")) found.add(match[1]);
  }
  return found;
}

describe("CI workflow contract", () => {
  it("reads the workflow this guard is about", () => {
    assert.ok(workflow.includes("name: CI"), "没读到 main-ci.yml 的 CI 工作流");
    assert.ok(
      testedPaths(workflow).size > 0,
      "一个被测路径都读不出来——路径或正则是坏的，下面每条都会空转",
    );
  });

  it("每一个 make verify 验证的包，工作流里也都真的跑到了", () => {
    const tested = testedPaths(workflow);
    for (const pkg of VERIFIED_PACKAGES) {
      const inMakefile = new RegExp(`^\\s*cd ${pkg.replace(/[/-]/g, ".")} &&`, "m").test(makefile);
      assert.ok(
        inMakefile,
        `${pkg} 已经不在 make verify 里了——同步改这份清单，别让它继续占位`,
      );
      assert.ok(
        tested.has(pkg),
        `${pkg} 在 make verify 里跑，但工作流没有把它当成被测目录——本地绿、CI 不测`,
      );
    }
  });

  it("仓库级脚本闸在本地与 CI 两边都在（缺一边就是假绿）", () => {
    const code = codeLines(workflow);
    // 这些不是"某个包的 typecheck+test"，上面那个矩阵对账看不见它们。
    // 备份脚本自测就是例子：53 条断言长期只有文档提到，没有任何目标跑它。
    const repoLevelGates = [
      { name: "备份脚本自测", path: "infra/backup/backup-scripts.test.sh" },
    ];
    for (const gate of repoLevelGates) {
      const inMakefile = makefile.includes(gate.path);
      const inCi = code.includes(gate.path);
      assert.equal(
        inMakefile && inCi, true,
        `${gate.name} 必须两边都跑：make verify=${inMakefile} 工作流=${inCi}。`
        + "只加本地会攒出「本地测过、CI 从没测过」，只加 CI 就是当初那种反向假绿。",
      );
    }
  });

  it("工作流没有跑任何 make verify 不跑的门禁", () => {
    const code = codeLines(workflow);
    for (const gate of GATES_THAT_LEFT_CI) {
      assert.ok(
        !code.toLowerCase().includes(gate.toLowerCase()),
        `工作流里又出现了 ${gate}——它已经不在本地基线上，挂回来就是再制造一次「本地绿、CI 红」`,
      );
    }
  });

  it("工作流不在 pg 上建集成测试库（postgres 集测已退出 CI）", () => {
    assert.ok(
      !/services:\s*\n\s+postgres:/.test(workflow),
      "工作流又起了 postgres service——postgres 集测已退出 CI，本地基线不需要它",
    );
  });

  it("工作流仍然会在 main 的推送上跑（否则本地绿了很久、CI 一次没跑过）", () => {
    const code = codeLines(workflow);
    // `branches: [main]`（行内序列）与
    //   branches:
    //     - main（块序列）两种写法都要认。
    const branches = code.match(/branches:\s*(.*)/);
    assert.ok(branches, "工作流的 push 触发里没有 branches 字段");
    const inline = branches[1].match(/\[([^\]]*)\]/);
    const block = branches[1].trim() === ""
      ? [...code.matchAll(/^\s+-\s+(\S+)\s*$/gm)].map((m) => m[1])
      : [];
    const values = [...(inline ? inline[1].split(",") : []), ...block]
      .map((value) => value.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
    assert.ok(
      values.includes("main"),
      `push 只在 ${values.join("、") || "（没解析出分支）"} 上跑。2026-10-05 的事故正是这么来的：`
      + "tag 打完之后又落地 5 个 commit，没人重跑，CI 一直停在 5 天前那份代码上",
    );
  });
});
