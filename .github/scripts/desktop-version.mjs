#!/usr/bin/env node

/**
 * 桌面端版本线。
 *
 * ## 为什么单独一套，而不是并进 `version-contract.mjs`
 *
 * 这个仓库把客户端（`apps/desktop-client`）和服务端放在同一个 git 仓库里，两条版本线
 * 的节奏本来就不一样：服务端按 `release/version.json` 发版，桌面端在有可安装包之前
 * 一直是 0.1.0 原地不动。硬合成一条线，会让每发一个服务端补丁都逼着桌面端跳版本；
 * 硬分成两套 `v*` tag，又会让 `inspectExactReleaseTags` 把对方的 tag 当成版本冲突。
 *
 * 所以这里用**带组件前缀的 tag**：`desktop-v1.0.0` 只走桌面端，`v0.5.0` 只走服务端。
 * 两者在物理上不重叠：
 *
 * - `version-contract.mjs` 的 `RELEASE_TAG_PATTERN` 是 `^v<major>.<minor>.<patch>`，
 *   `desktop-v1.0.0` 解析结果为 `null`，被 `continue` 掉——服务端门禁看不见它。
 * - `ci.yml` 的 `push.tags: ["v*"]` 要求 tag 以 `v` 开头，`desktop-v*` 不匹配，
 *   打桌面端 tag 不会把整套后端 CI 拽起来。
 *
 * 代价是两条线要各自记一次版本：桌面端的唯一来源是 `release/desktop-version.json`，
 * 由本脚本同步到 `apps/desktop-client/package.json` 与其 lockfile。构建实际使用的
 * 版本号由 electron-builder 从 package.json 读取，所以同步没跑成功的话产物名会
 * 停在旧版本——`--check` 就是为了让这种情况在打包之前红掉。
 */

import { readFileSync, renameSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
export const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "../..");

export const DESKTOP_VERSION_SOURCE_PATH = "release/desktop-version.json";
export const DESKTOP_PACKAGE_ROOT = "apps/desktop-client";

/** 与服务端 `version-contract.mjs` 的 VERSION_PATTERN 保持同一套版本形状。 */
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * 桌面端专用 tag 前缀。刻意**不带** `v` 开头：`v*` 是服务端的命名空间，
 * 桌面端占了它就会互相串味。
 */
export const DESKTOP_TAG_PREFIX = "desktop-v";
const DESKTOP_RELEASE_TAG_PATTERN = new RegExp(
  `^${DESKTOP_TAG_PREFIX}((?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*))$`,
);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function relativeToRoot(root, path) {
  return relative(root, path).split("\\").join("/");
}

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeFileAtomically(path, contents) {
  const temporaryDirectory = mkdtempSync(join(dirname(path), ".desktop-version-sync-"));
  const temporaryPath = join(temporaryDirectory, "next");
  try {
    writeFileSync(temporaryPath, contents, "utf8");
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function validateDesktopVersion(value) {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
    throw new Error(
      `desktop version must be a stable MAJOR.MINOR.PATCH value, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * 解析桌面端 tag。`desktop-v1.0.0` → `{ version: "1.0.0" }`；
 * `v1.0.0`（服务端命名空间）返回 `null`。
 */
export function parseDesktopReleaseTag(name) {
  const match = DESKTOP_RELEASE_TAG_PATTERN.exec(name ?? "");
  return match ? { version: match[1] } : null;
}

export function loadDesktopVersionSource(root = REPOSITORY_ROOT) {
  const source = readJson(join(root, DESKTOP_VERSION_SOURCE_PATH));
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error(`${DESKTOP_VERSION_SOURCE_PATH} must contain one JSON object`);
  }
  const keys = Object.keys(source).sort();
  if (keys.length !== 1 || keys[0] !== "version") {
    throw new Error(`${DESKTOP_VERSION_SOURCE_PATH} must contain only the manually maintained version field`);
  }
  return validateDesktopVersion(source.version);
}

/**
 * 核对 package.json / lockfile 是否与唯一来源一致。
 * electron-builder 的 `${version}` 取自 package.json，所以这里漂了＝产物名会漂。
 */
export function inspectDesktopVersionCopies(root = REPOSITORY_ROOT, version = loadDesktopVersionSource(root)) {
  const issues = [];

  const packagePath = join(root, DESKTOP_PACKAGE_ROOT, "package.json");
  try {
    const packageJson = readJson(packagePath);
    if (packageJson.version !== version) {
      issues.push(
        `${relativeToRoot(root, packagePath)} version is ${JSON.stringify(packageJson.version)}, expected ${version}`,
      );
    }
  } catch (error) {
    issues.push(`${relativeToRoot(root, packagePath)} could not be read: ${describe(error)}`);
  }

  const lockPath = join(root, DESKTOP_PACKAGE_ROOT, "package-lock.json");
  try {
    const lock = readJson(lockPath);
    if (lock.version !== version) {
      issues.push(`${relativeToRoot(root, lockPath)} top-level version is ${JSON.stringify(lock.version)}, expected ${version}`);
    }
    if (!lock.packages || !lock.packages[""]) {
      issues.push(`${relativeToRoot(root, lockPath)} has no packages[""] root metadata`);
    } else if (lock.packages[""].version !== version) {
      issues.push(
        `${relativeToRoot(root, lockPath)} packages[""].version is ${JSON.stringify(lock.packages[""].version)}, expected ${version}`,
      );
    }
  } catch (error) {
    issues.push(`${relativeToRoot(root, lockPath)} could not be read: ${describe(error)}`);
  }

  return issues;
}

export function syncDesktopVersionCopies(root = REPOSITORY_ROOT, version = loadDesktopVersionSource(root)) {
  const changed = [];

  const packagePath = join(root, DESKTOP_PACKAGE_ROOT, "package.json");
  const packageJson = readJson(packagePath);
  packageJson.version = version;
  const packageContents = serializeJson(packageJson);
  if (readFileSync(packagePath, "utf8") !== packageContents) {
    writeFileAtomically(packagePath, packageContents);
    changed.push(relativeToRoot(root, packagePath));
  }

  const lockPath = join(root, DESKTOP_PACKAGE_ROOT, "package-lock.json");
  const lock = readJson(lockPath);
  if (!lock.packages || !lock.packages[""]) {
    throw new Error(`${relativeToRoot(root, lockPath)} has no packages[""] root metadata`);
  }
  lock.version = version;
  lock.packages[""].version = version;
  const lockContents = serializeJson(lock);
  if (readFileSync(lockPath, "utf8") !== lockContents) {
    writeFileAtomically(lockPath, lockContents);
    changed.push(relativeToRoot(root, lockPath));
  }

  return changed;
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

function usage() {
  console.log(`Usage: node .github/scripts/desktop-version.mjs [--check|--set <version>|--tag <tag>]`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }

  try {
    if (args[0] === "--set") {
      const requested = validateDesktopVersion(args[1]);
      const sourcePath = join(REPOSITORY_ROOT, DESKTOP_VERSION_SOURCE_PATH);
      const next = serializeJson({ version: requested });
      if (readFileSync(sourcePath, "utf8") !== next) {
        writeFileAtomically(sourcePath, next);
        console.log(`${DESKTOP_VERSION_SOURCE_PATH} set to ${requested}`);
      } else {
        console.log(`${DESKTOP_VERSION_SOURCE_PATH} already at ${requested}`);
      }
      const changed = syncDesktopVersionCopies(REPOSITORY_ROOT, requested);
      console.log(changed.length > 0 ? `synchronized ${changed.join(", ")}` : "package copies already in sync");
      return;
    }

    if (args[0] === "--tag") {
      const parsed = parseDesktopReleaseTag(args[1]);
      if (!parsed) {
        throw new Error(
          `tag ${JSON.stringify(args[1])} is not a desktop release tag (expected ${DESKTOP_TAG_PREFIX}<major>.<minor>.<patch>)`,
        );
      }
      console.log(parsed.version);
      return;
    }

    const mode = args[0] ?? "--check";
    if (mode !== "--check") {
      usage();
      process.exitCode = 2;
      return;
    }

    const version = loadDesktopVersionSource();
    const issues = inspectDesktopVersionCopies(REPOSITORY_ROOT, version);
    if (issues.length > 0) {
      for (const issue of issues) console.error(`desktop version contract failed: ${issue}`);
      process.exitCode = 1;
      return;
    }
    console.log(`desktop version contract OK (${DESKTOP_TAG_PREFIX}${version})`);
  } catch (error) {
    console.error(`desktop version contract failed: ${describe(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main();
}