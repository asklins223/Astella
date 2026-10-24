import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { formatReleaseNotes } from "./release-notes.mjs";
import {
  inspectExactReleaseTags,
  inspectVersionCopies,
  loadVersionSource,
  loadReleaseSource,
  parseReleaseTag,
  parseServerReleaseTag,
  PACKAGE_ROOTS,
  REPOSITORY_ROOT,
  syncVersionCopies,
  setReleaseVersion,
  validateVersion,
} from "./version-contract.mjs";
import {
  DESKTOP_PACKAGE_ROOTS,
  DESKTOP_VERSION_SOURCE_PATH,
  inspectDesktopVersionCopies,
  loadDesktopReleaseSource,
  loadDesktopVersionSource,
  parseDesktopReleaseTag,
  setDesktopVersion,
  syncDesktopVersionCopies,
} from "./desktop-version.mjs";

const SCRIPT_DIRECTORY = fileURLToPath(new URL(".", import.meta.url));
const VERSION_CONTRACT_SCRIPT = join(SCRIPT_DIRECTORY, "version-contract.mjs");
const DESKTOP_VERSION_SCRIPT = join(SCRIPT_DIRECTORY, "desktop-version.mjs");
const RELEASE_NOTES_SCRIPT = join(SCRIPT_DIRECTORY, "release-notes.mjs");

const temporaryRoots = [];

/**
 * 版本契约必须覆盖的包根（**契约本身**，不是实现细节的复述）。
 *
 * 这里显式列出而不是直接用 `PACKAGE_ROOTS` 造期望值：如果日后有人从实现里删掉一个
 * 包根，直接用实现常量算期望会让测试**静默通过**，而真正该发生的是"这个包不再被
 * 版本契约覆盖了"这件事被顶出来。下面的断言会把它变成一条可读的失败。
 *
 * 2026-10-24 版本线拆分后，服务端契约只覆盖 shared / api / worker；桌面客户端由
 * desktop-version.mjs 单独覆盖（`REQUIRED_DESKTOP_PACKAGE_ROOTS`）。
 */
const REQUIRED_SERVER_PACKAGE_ROOTS = ["apps/api", "workers/ai-worker", "packages/shared"];
const REQUIRED_DESKTOP_PACKAGE_ROOTS = ["apps/desktop-client"];

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop(), { recursive: true, force: true });
  }
});

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * 同时包含服务端与桌面两条版本线的夹具：来源文件、README 标记、包与 lockfile。
 * 默认让副本比来源旧一个版本，这样 inspect 应当报出全部漂移。
 */
function createFixture({
  serverVersion = "0.5.0",
  serverCopyVersion = "0.4.0",
  desktopVersion = "0.7.0",
  desktopCopyVersion = "0.6.0",
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "astella-version-contract-"));
  temporaryRoots.push(root);

  mkdirSync(join(root, "release"), { recursive: true });
  writeJson(join(root, "release/version.json"), { version: serverVersion, notes: ["修复笔记保存", "改善伴星回复"] });
  mkdirSync(join(root, "apps/desktop-client"), { recursive: true });
  writeJson(join(root, DESKTOP_VERSION_SOURCE_PATH), { version: desktopVersion, notes: ["桌面端修复窗口尺寸", "改善更新提示"] });

  writeFileSync(
    join(root, "README.md"),
    `服务端版本：\`s-v${serverCopyVersion}\`\n桌面客户端版本：\`c-v${desktopCopyVersion}\`\n`,
    "utf8",
  );
  writeFileSync(
    join(root, "README.en.md"),
    `Server version: \`s-v${serverCopyVersion}\`\nDesktop client version: \`c-v${desktopCopyVersion}\`\n`,
    "utf8",
  );

  for (const packageRoot of [...PACKAGE_ROOTS, ...DESKTOP_PACKAGE_ROOTS]) {
    const version = packageRoot === "apps/desktop-client" ? desktopCopyVersion : serverCopyVersion;
    const directory = join(root, packageRoot);
    const name = `fixture-${packageRoot.replaceAll("/", "-")}`;
    mkdirSync(directory, { recursive: true });
    writeJson(join(directory, "package.json"), { name, version, private: true });
    writeJson(join(directory, "package-lock.json"), {
      name,
      version,
      lockfileVersion: 3,
      packages: { "": { name, version } },
    });
  }
  return root;
}

describe("server version contract", () => {
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
    const preview = execFileSync(process.execPath, [RELEASE_NOTES_SCRIPT], { encoding: "utf8" });
    execFileSync(process.execPath, [RELEASE_NOTES_SCRIPT, "--output", output]);
    assert.equal(readFileSync(output, "utf8"), preview);
    const source = loadReleaseSource();
    assert.ok(preview.startsWith(`Astella 服务端 s-v${source.version}\n`));
    assert.ok(preview.includes(`- ${source.notes[0]}`));
    assert.ok(formatReleaseNotes({ version: "1.2.3", notes: ["第一行\n第二行"] }).includes("- 第一行\n  第二行"));
  });

  it("supports a desktop release-note source without reading the server notes", () => {
    const preview = execFileSync(process.execPath, [RELEASE_NOTES_SCRIPT, "--source", "desktop"], { encoding: "utf8" });
    const source = loadDesktopReleaseSource();
    assert.ok(preview.startsWith(`Astella 桌面客户端 c-v${source.version}\n`));
    assert.ok(preview.includes(`- ${source.notes[0]}`));
    assert.ok(formatReleaseNotes({ version: "1.2.3", notes: ["桌面端修复"], source: "desktop" })
      .startsWith("Astella 桌面客户端 c-v1.2.3\n"));
    const unknown = spawnSync(process.execPath, [RELEASE_NOTES_SCRIPT, "--source", "mobile"], { encoding: "utf8" });
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /--source must be one of server, desktop/);
  });

  /**
   * 这一条是"哪些包必须被版本契约覆盖"的**显式契约**。
   *
   * 服务端与桌面客户端在 2026-10-24 起是两条独立版本线：服务端覆盖 shared / api /
   * worker，桌面只覆盖 desktop-client。漏掉这一步时，本测试会直接指出预期与实际
   * 的差集，而不是让 `make verify` 以一个看不懂的计数错误红着。
   */
  it("covers exactly the packages that share the server release version", () => {
    assert.deepEqual(
      [...PACKAGE_ROOTS].sort(),
      [...REQUIRED_SERVER_PACKAGE_ROOTS].sort(),
      "PACKAGE_ROOTS 与版本契约声明的服务端包根不一致：新增或删除包时请一并更新本测试的"
      + " REQUIRED_SERVER_PACKAGE_ROOTS，并确认该包是否真的与 release/version.json 同版本",
    );
    assert.ok(
      !PACKAGE_ROOTS.includes("apps/desktop-client"),
      "桌面客户端不再跟随服务端版本，PACKAGE_ROOTS 里不应出现 apps/desktop-client",
    );
    assert.deepEqual(
      [...DESKTOP_PACKAGE_ROOTS].sort(),
      [...REQUIRED_DESKTOP_PACKAGE_ROOTS].sort(),
      "DESKTOP_PACKAGE_ROOTS 与桌面版本契约声明的包根不一致",
    );
  });

  it("detects and repairs package, lockfile, and README drift", () => {
    const root = createFixture();
    const version = loadVersionSource(root);
    // 每个服务端包根贡献 3 处漂移（package.json 的 version、lock 顶层 version、
    // lock packages[""].version），中英文 README 的服务端标记各贡献 1 处。
    const expectedIssues = REQUIRED_SERVER_PACKAGE_ROOTS.length * 3 + 2;
    // 每个包根会被改写 2 个文件（package.json + package-lock.json），README 2 个。
    const expectedRewrites = REQUIRED_SERVER_PACKAGE_ROOTS.length * 2 + 2;
    assert.equal(inspectVersionCopies(root, version).length, expectedIssues);

    const changed = syncVersionCopies(root, version);
    assert.equal(changed.length, expectedRewrites);
    assert.deepEqual(inspectVersionCopies(root, version), []);
    assert.match(readFileSync(join(root, "README.md"), "utf8"), /服务端版本：`s-v0\.5\.0`/);
    assert.match(readFileSync(join(root, "README.en.md"), "utf8"), /Server version: `s-v0\.5\.0`/);
  });

  it("rejects prerelease or decorated manual version values", () => {
    assert.throws(() => validateVersion("0.5.0-rc.1"), /stable MAJOR\.MINOR\.PATCH/);
    assert.throws(() => validateVersion("v0.5.0"), /stable MAJOR\.MINOR\.PATCH/);
    assert.throws(() => validateVersion("s-v0.5.0"), /stable MAJOR\.MINOR\.PATCH/);
  });

  it("binds exact annotated server release tags to the manual version", () => {
    assert.deepEqual(inspectExactReleaseTags("0.5.0", [
      { name: "s-v0.5.0", objectType: "tag" },
      { name: "v0.5.0", objectType: "tag" },
      { name: "v0.5.0-rc.1", objectType: "tag" },
      { name: "benchmark-baseline", objectType: "commit" },
    ]), []);

    const issues = inspectExactReleaseTags("0.5.0", [
      { name: "s-v0.5.1", objectType: "tag" },
      { name: "s-v0.5.0", objectType: "commit" },
    ]);
    assert.equal(issues.length, 2);
    assert.match(issues[0], /s-v0\.5\.1/);
    assert.match(issues[1], /annotated/);
  });

  it("parses only s-v<version> server tags", () => {
    assert.deepEqual(parseServerReleaseTag("s-v0.5.0"), { version: "0.5.0" });
    for (const tag of ["v0.5.0", "s-v0.5.0-rc.1", "s-v0.5", "s-vgarbage", "c-v0.5.0"]) {
      assert.equal(parseServerReleaseTag(tag), null, tag);
    }
  });

  it("checks the server tag against release/version.json from the CLI", () => {
    const version = loadVersionSource();
    assert.equal(
      execFileSync(process.execPath, [VERSION_CONTRACT_SCRIPT, "--tag", `s-v${version}`], { encoding: "utf8" }).trim(),
      version,
    );
    const mismatched = spawnSync(process.execPath, [VERSION_CONTRACT_SCRIPT, "--tag", "s-v0.0.1"], { encoding: "utf8" });
    assert.equal(mismatched.status, 1);
    assert.match(mismatched.stderr, /targets version 0\.0\.1/);
    const legacy = spawnSync(process.execPath, [VERSION_CONTRACT_SCRIPT, "--tag", `v${version}`], { encoding: "utf8" });
    assert.equal(legacy.status, 1);
    assert.match(legacy.stderr, /expected an s-v/);
  });

  it("still parses the legacy v<version> tag form for the historical RC flow", () => {
    assert.deepEqual(parseReleaseTag("v0.5.0"), { version: "0.5.0", prerelease: null });
    assert.deepEqual(parseReleaseTag("v0.5.0-rc.1"), { version: "0.5.0", prerelease: "rc.1" });
    for (const tag of [
      "v0.5.0-rc.0",
      "v0.5.0-alpha",
      "v0.5.0-rc.1.extra",
      "v0.5",
      "s-v0.5.0",
      "vgarbage",
    ]) {
      assert.equal(parseReleaseTag(tag), null, tag);
    }
  });
});

describe("desktop version contract", () => {
  it("accepts the canonical desktop copies", () => {
    const version = loadDesktopVersionSource(REPOSITORY_ROOT);
    assert.deepEqual(inspectDesktopVersionCopies(REPOSITORY_ROOT, version), []);
  });

  it("reads the desktop version from its own source file", () => {
    const source = loadDesktopReleaseSource(REPOSITORY_ROOT);
    assert.equal(loadDesktopVersionSource(REPOSITORY_ROOT), source.version);
    assert.match(source.version, /^\d+\.\d+\.\d+$/);
    assert.ok(Array.isArray(source.notes) && source.notes.length > 0);
  });

  it("preserves desktop notes when setting and synchronizing the version", () => {
    const root = createFixture();
    const notes = loadDesktopReleaseSource(root).notes;
    setDesktopVersion(root, "1.2.3");
    syncDesktopVersionCopies(root);
    assert.deepEqual(loadDesktopReleaseSource(root), { version: "1.2.3", notes });
    assert.deepEqual(inspectDesktopVersionCopies(root), []);
    // 桌面同步不能动服务端的来源文件或服务端包。
    assert.equal(loadVersionSource(root), "0.5.0");
    assert.equal(JSON.parse(readFileSync(join(root, "apps/api/package.json"), "utf8")).version, "0.4.0");
  });

  it("detects and repairs desktop package, lockfile, and README drift", () => {
    const root = createFixture();
    const version = loadDesktopVersionSource(root);
    // package.json + lock 顶层 + lock packages[""] + 中英文 README 标记。
    assert.equal(inspectDesktopVersionCopies(root, version).length, 5);
    assert.equal(syncDesktopVersionCopies(root, version).length, 4);
    assert.deepEqual(inspectDesktopVersionCopies(root, version), []);
    assert.match(readFileSync(join(root, "README.md"), "utf8"), /桌面客户端版本：`c-v0\.7\.0`/);
    assert.match(readFileSync(join(root, "README.en.md"), "utf8"), /Desktop client version: `c-v0\.7\.0`/);
  });

  it("parses only c-v<version> desktop tags", () => {
    assert.deepEqual(parseDesktopReleaseTag("c-v0.7.0"), { version: "0.7.0" });
    for (const tag of ["v0.7.0", "c-v0.7.0-rc.1", "c-v0.7", "c-vgarbage", "s-v0.7.0"]) {
      assert.equal(parseDesktopReleaseTag(tag), null, tag);
    }
  });

  it("checks the desktop tag against apps/desktop-client/version.json from the CLI", () => {
    const version = loadDesktopVersionSource();
    assert.equal(
      execFileSync(process.execPath, [DESKTOP_VERSION_SCRIPT, "--tag", `c-v${version}`], { encoding: "utf8" }).trim(),
      version,
    );
    const mismatched = spawnSync(process.execPath, [DESKTOP_VERSION_SCRIPT, "--tag", "c-v0.0.1"], { encoding: "utf8" });
    assert.equal(mismatched.status, 1);
    assert.match(mismatched.stderr, /targets version 0\.0\.1/);
    const legacy = spawnSync(process.execPath, [DESKTOP_VERSION_SCRIPT, "--tag", `v${version}`], { encoding: "utf8" });
    assert.equal(legacy.status, 1);
    assert.match(legacy.stderr, /expected a stable c-v/);
  });
});
