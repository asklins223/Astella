import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { formatReleaseNotes } from "./release-notes.mjs";
import {
  inspectExactReleaseTags,
  inspectVersionCopies,
  loadVersionSource,
  loadReleaseSource,
  PACKAGE_ROOTS,
  parseReleaseTag,
  REPOSITORY_ROOT,
  syncVersionCopies,
  setReleaseVersion,
  validateVersion,
} from "./version-contract.mjs";

const temporaryRoots = [];

/**
 * 版本契约必须覆盖的包根（**契约本身**，不是实现细节的复述）。
 *
 * 这里显式列出而不是直接用 `PACKAGE_ROOTS` 造期望值：如果日后有人从实现里删掉一个
 * 包根，直接用实现常量算期望会让测试**静默通过**，而真正该发生的是"这个包不再被
 * 版本契约覆盖了"这件事被顶出来。下面的断言会把它变成一条可读的失败。
 *
 * 曾经踩过的坑：`apps/web` 被整包删除后，实现里同步删掉了该根，但这个测试的期望值
 * 是硬编码的（13 处漂移 / 9 个文件），于是 `make verify` 一直红着——而红的原因不是
 * 契约被破坏，只是"期望值没人跟着改"。所以下面改成按根数量推导，并把"应当覆盖哪些根"
 * 单独钉住。
 */
const REQUIRED_PACKAGE_ROOTS = ["apps/api", "workers/ai-worker", "packages/shared", "apps/desktop-client"];

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop(), { recursive: true, force: true });
  }
});

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createFixture(copyVersion = "0.4.0") {
  const root = mkdtempSync(join(tmpdir(), "astella-version-contract-"));
  temporaryRoots.push(root);
  mkdirSync(join(root, "release"), { recursive: true });
  writeJson(join(root, "release/version.json"), { version: "0.5.0", notes: ["修复笔记保存", "改善伴星回复"] });
  writeFileSync(
    join(root, "README.md"),
    `[![Version](https://img.shields.io/badge/version-v${copyVersion}-blue.svg)](https://example.invalid)\n`,
    "utf8",
  );
  writeFileSync(join(root, "README.en.md"), `Repository version: \`v${copyVersion}\`\n`, "utf8");

  for (const packageRoot of PACKAGE_ROOTS) {
    const directory = join(root, packageRoot);
    const name = `fixture-${packageRoot.replaceAll("/", "-")}`;
    mkdirSync(directory, { recursive: true });
    writeJson(join(directory, "package.json"), { name, version: copyVersion, private: true });
    writeJson(join(directory, "package-lock.json"), {
      name,
      version: copyVersion,
      lockfileVersion: 3,
      packages: { "": { name, version: copyVersion } },
    });
  }
  return root;
}

describe("version contract", () => {
  it("accepts the canonical repository copies", () => {
    const version = loadVersionSource(REPOSITORY_ROOT);
    assert.deepEqual(inspectVersionCopies(REPOSITORY_ROOT, version), []);
  });

  it("preserves release notes when setting and synchronizing the version", () => {
    const root = createFixture();
    const notes = loadReleaseSource(root).notes;
    setReleaseVersion(root, "1.2.3");
    syncVersionCopies(root);
    assert.deepEqual(loadReleaseSource(root), { version: "1.2.3", notes });
    assert.deepEqual(inspectVersionCopies(root), []);
  });

  it("rejects missing or empty notes and unknown release fields", () => {
    const root = createFixture();
    for (const source of [
      { version: "1.2.3" },
      { version: "1.2.3", notes: [] },
      { version: "1.2.3", notes: [" "] },
      { version: "1.2.3", notes: [null] },
      { version: "1.2.3", notes: "changes" },
      { version: "1.2.3", notes: ["changes"], unexpected: true },
    ]) {
      writeJson(join(root, "release/version.json"), source);
      assert.throws(() => loadReleaseSource(root), /version and notes|non-empty/);
    }
  });

  it("writes the selected version and Markdown changes to release notes", () => {
    const root = createFixture();
    const output = join(root, "release-notes.md");
    const preview = execFileSync(process.execPath, [join(REPOSITORY_ROOT, ".github/scripts/release-notes.mjs")], { encoding: "utf8" });
    execFileSync(process.execPath, [join(REPOSITORY_ROOT, ".github/scripts/release-notes.mjs"), "--output", output]);
    assert.equal(readFileSync(output, "utf8"), preview);
    const source = loadReleaseSource();
    assert.ok(preview.startsWith(`Astella v${source.version}\n`));
    assert.ok(preview.includes(`- ${source.notes[0]}`));
    assert.ok(formatReleaseNotes({ version: "1.2.3", notes: ["第一行\n第二行"] }).includes("- 第一行\n  第二行"));
  });

  /**
   * 这一条是"哪些包必须被版本契约覆盖"的**显式契约**。
   *
   * 服务端与桌面客户端共用产品版本；新增或删除包时需要确认是否纳入。
   * 漏掉这一步时，本测试会直接指出预期与实际
   * 的差集，而不是让 `make verify` 以一个看不懂的计数错误红着。
   */
  it("covers exactly the packages that share the release version", () => {
    assert.deepEqual(
      [...PACKAGE_ROOTS].sort(),
      [...REQUIRED_PACKAGE_ROOTS].sort(),
      "PACKAGE_ROOTS 与版本契约声明的包根不一致：新增或删除包时请一并更新本测试的"
      + " REQUIRED_PACKAGE_ROOTS，并确认该包是否真的与 release/version.json 同版本",
    );
  });

  it("detects and repairs package, lockfile, and README drift", () => {
    const root = createFixture();
    const version = loadVersionSource(root);
    // 每个包根贡献 3 处漂移（package.json 的 version、lock 顶层 version、
    // lock packages[""].version），中英文 README 各贡献 1 处。
    const expectedIssues = REQUIRED_PACKAGE_ROOTS.length * 3 + 2;
    // 每个包根会被改写 2 个文件（package.json + package-lock.json），README 2 个。
    const expectedRewrites = REQUIRED_PACKAGE_ROOTS.length * 2 + 2;
    assert.equal(inspectVersionCopies(root, version).length, expectedIssues);

    const changed = syncVersionCopies(root, version);
    assert.equal(changed.length, expectedRewrites);
    assert.deepEqual(inspectVersionCopies(root, version), []);
    assert.match(readFileSync(join(root, "README.md"), "utf8"), /version-v0\.5\.0-blue/);
    assert.match(readFileSync(join(root, "README.en.md"), "utf8"), /Repository version: `v0\.5\.0`/);
  });

  it("rejects prerelease or decorated manual version values", () => {
    assert.throws(() => validateVersion("0.5.0-rc.1"), /stable MAJOR\.MINOR\.PATCH/);
    assert.throws(() => validateVersion("v0.5.0"), /stable MAJOR\.MINOR\.PATCH/);
  });

  it("binds exact annotated release tags to the manual version", () => {
    assert.deepEqual(inspectExactReleaseTags("0.5.0", [
      { name: "v0.5.0", objectType: "tag" },
      { name: "v0.5.0-rc.1", objectType: "tag" },
      { name: "benchmark-baseline", objectType: "commit" },
    ]), []);

    const issues = inspectExactReleaseTags("0.5.0", [
      { name: "v0.5.1", objectType: "tag" },
      { name: "v0.5.0", objectType: "commit" },
    ]);
    assert.equal(issues.length, 2);
    assert.match(issues[0], /v0\.5\.1/);
    assert.match(issues[1], /annotated/);
  });

  it("accepts only stable or positive rc.N release tag forms", () => {
    assert.deepEqual(parseReleaseTag("v0.5.0"), { version: "0.5.0", prerelease: null });
    assert.deepEqual(parseReleaseTag("v0.5.0-rc.1"), { version: "0.5.0", prerelease: "rc.1" });
    for (const tag of [
      "v0.5.0-rc.0",
      "v0.5.0-alpha",
      "v0.5.0-rc.1.extra",
      "v0.5",
      "vgarbage",
    ]) {
      assert.equal(parseReleaseTag(tag), null, tag);
    }
  });
});
