#!/usr/bin/env node

// 桌面客户端版本契约。
//
// 2026-10-24（用户决定，见 docs/plans/app-release-center-2026-10-24.md §5.1）：版本线拆分。
//   · 来源：apps/desktop-client/version.json（桌面自己的 version + notes）。
//   · 同步：apps/desktop-client/package.json、apps/desktop-client/package-lock.json
//     与 README 的**桌面客户端**版本标记。
//   · tag：c-v<version>（macOS 与 Windows 是同一个产品线、同一个版本号）。
//   · 服务端版本在 release/version.json，由 version-contract.mjs 维护，两者互不跟随。
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REPOSITORY_ROOT,
  VERSION_README_PATHS,
  inspectReadmeVersionMarkers,
  inspectPackageVersionCopies,
  loadVersionSourceFile,
  setVersionFileVersion,
  syncReadmeVersionMarkers,
  syncPackageVersionCopies,
  validateVersion,
} from "./version-contract.mjs";

export { REPOSITORY_ROOT };
export const DESKTOP_VERSION_SOURCE_PATH = "apps/desktop-client/version.json";
export const DESKTOP_PACKAGE_ROOTS = ["apps/desktop-client"];
export const DESKTOP_TAG_PREFIX = "c-v";

const DESKTOP_RELEASE_TAG_PATTERN =
  /^c-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;

// README 中**桌面客户端**版本标记（中文 / 英文各一处）。服务端标记由
// version-contract.mjs 校验，两处互不覆盖。
export const README_DESKTOP_VERSION_MARKERS = [
  {
    name: "桌面客户端版本 text",
    pattern: /桌面客户端版本：`c-v([^`]+)`/g,
    versionGroup: 1,
    replace(readme, version) {
      return readme.replace(this.pattern, `桌面客户端版本：\`c-v${version}\``);
    },
  },
  {
    name: "Desktop client version text",
    pattern: /Desktop client version: `c-v([^`]+)`/g,
    versionGroup: 1,
    replace(readme, version) {
      return readme.replace(this.pattern, `Desktop client version: \`c-v${version}\``);
    },
  },
];

export const validateDesktopVersion = validateVersion;

export function loadDesktopReleaseSource(root = REPOSITORY_ROOT) {
  return loadVersionSourceFile(root, DESKTOP_VERSION_SOURCE_PATH);
}

export function loadDesktopVersionSource(root = REPOSITORY_ROOT) {
  return loadDesktopReleaseSource(root).version;
}

export function setDesktopVersion(root = REPOSITORY_ROOT, version) {
  setVersionFileVersion(root, DESKTOP_VERSION_SOURCE_PATH, version);
}

export function inspectDesktopVersionCopies(root = REPOSITORY_ROOT, version = loadDesktopVersionSource(root)) {
  return [
    ...inspectPackageVersionCopies(root, DESKTOP_PACKAGE_ROOTS, version),
    ...inspectReadmeVersionMarkers(
      root,
      VERSION_README_PATHS,
      README_DESKTOP_VERSION_MARKERS,
      version,
    ),
  ];
}

export function syncDesktopVersionCopies(root = REPOSITORY_ROOT, version = loadDesktopVersionSource(root)) {
  return [
    ...syncPackageVersionCopies(root, DESKTOP_PACKAGE_ROOTS, version),
    ...syncReadmeVersionMarkers(
      root,
      VERSION_README_PATHS,
      README_DESKTOP_VERSION_MARKERS,
      version,
    ),
  ];
}

/** 桌面发布 tag：c-v<version>（macOS / Windows 共用）。 */
export function parseDesktopReleaseTag(name) {
  const match = DESKTOP_RELEASE_TAG_PATTERN.exec(name ?? "");
  return match ? { version: match[1] } : null;
}

export function desktopTagForVersion(version) {
  return `${DESKTOP_TAG_PREFIX}${validateVersion(version)}`;
}

function usage() {
  console.log("Usage: node .github/scripts/desktop-version.mjs [--check|--write|--set <version>|--tag <c-vX.Y.Z>]");
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }
  const mode = args[0] ?? "--check";
  const validArity = mode === "--set" || mode === "--tag"
    ? args.length === 2 && Boolean(args[1])
    : args.length <= 1;
  if (!["--check", "--write", "--set", "--tag"].includes(mode) || !validArity) {
    usage();
    process.exitCode = 2;
    return;
  }

  try {
    if (mode === "--set") {
      const version = validateVersion(args[1]);
      setDesktopVersion(REPOSITORY_ROOT, version);
      const changed = syncDesktopVersionCopies(REPOSITORY_ROOT, version);
      console.log(`desktop release version ${version}; synchronized ${changed.join(", ") || "no changes"}`);
      return;
    }
    if (mode === "--tag") {
      const parsed = parseDesktopReleaseTag(args[1]);
      if (!parsed) throw new Error(`expected a stable c-v<major>.<minor>.<patch> release tag, got ${JSON.stringify(args[1])}`);
      const version = loadDesktopVersionSource();
      if (parsed.version !== version) {
        throw new Error(`tag ${args[1]} targets version ${parsed.version}, but ${DESKTOP_VERSION_SOURCE_PATH} is ${version}`);
      }
      console.log(parsed.version);
      return;
    }

    const version = loadDesktopVersionSource();
    if (mode === "--write") {
      const changed = syncDesktopVersionCopies(REPOSITORY_ROOT, version);
      console.log(changed.length > 0
        ? `synchronized ${changed.length} desktop version copies to ${version}`
        : `desktop version copies already synchronized at ${version}`);
    }

    const issues = inspectDesktopVersionCopies(REPOSITORY_ROOT, version);
    if (issues.length) throw new Error(issues.join("; "));
    console.log(`desktop version contract OK (c-v${version}; ${DESKTOP_PACKAGE_ROOTS.length} package, README)`);
  } catch (error) {
    console.error(`version contract failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
