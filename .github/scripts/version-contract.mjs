#!/usr/bin/env node

// 服务端版本契约。
//
// 2026-10-24（用户决定，见 docs/plans/app-release-center-2026-10-24.md §5.1）：版本线拆分。
//   · 服务端：release/version.json → apps/api、workers/ai-worker、packages/shared 的
//     package.json / package-lock.json 与 README 的**服务端**版本标记；tag 前缀 s-v。
//   · 桌面客户端：apps/desktop-client/version.json → 桌面包与 lockfile、README 的**桌面**
//     版本标记；tag 前缀 c-v（见 desktop-version.mjs）。
//   · iOS / Android 在独立仓库 astella-mobile，不在这里维护。
//
// 这个脚本**不再**写桌面客户端：以前服务端与桌面共用一个版本，改服务端版本
// 会顺手把桌面版本也改掉，桌面就没法独立发版了。
import {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
export const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "../..");
export const VERSION_SOURCE_PATH = "release/version.json";
export const VERSION_README_PATHS = ["README.md", "README.en.md"];
// 服务端版本同步到的包根（api / worker / shared）；桌面客户端不在其列。
export const PACKAGE_ROOTS = ["apps/api", "workers/ai-worker", "packages/shared"];
export const SERVER_TAG_PREFIX = "s-v";

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
// 历史发布线（旧版桌面 / 旧 RC 流程）用 v<version>。新发布线不再产生这种 tag；
// release-manifest-contract 的旧 RC 闸仍依赖这个解析，保留。
const LEGACY_RELEASE_TAG_PATTERN =
  /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:-(rc\.[1-9]\d*))?$/;
const SERVER_RELEASE_TAG_PATTERN =
  /^s-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;

// README 中**服务端**版本标记（中文 / 英文各一处）。桌面客户端版本标记由
// desktop-version.mjs 自己校验，两处互不覆盖。
export const README_SERVER_VERSION_MARKERS = [
  {
    name: "服务端版本 text",
    pattern: /服务端版本：`s-v([^`]+)`/g,
    versionGroup: 1,
    replace(readme, version) {
      return readme.replace(this.pattern, `服务端版本：\`s-v${version}\``);
    },
  },
  {
    name: "Server version text",
    pattern: /Server version: `s-v([^`]+)`/g,
    versionGroup: 1,
    replace(readme, version) {
      return readme.replace(this.pattern, `Server version: \`s-v${version}\``);
    },
  },
];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function relative(root, path) {
  return path.slice(root.length + 1);
}

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeFileAtomically(path, contents) {
  const temporaryDirectory = mkdtempSync(join(dirname(path), ".version-sync-"));
  const temporaryPath = join(temporaryDirectory, "next");
  try {
    writeFileSync(temporaryPath, contents, "utf8");
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function validateVersion(value) {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
    throw new Error(`version must be a stable MAJOR.MINOR.PATCH value, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** 读取任意一条版本线的来源文件（{version, notes} 形状），schema 相同。 */
export function loadVersionSourceFile(root, sourcePath) {
  const source = readJson(join(root, sourcePath));
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error(`${sourcePath} must contain one JSON object`);
  }
  const keys = Object.keys(source).sort();
  if (keys.length !== 2 || keys[0] !== "notes" || keys[1] !== "version") {
    throw new Error(`${sourcePath} must contain only version and notes`);
  }
  const version = validateVersion(source.version);
  if (!Array.isArray(source.notes) || source.notes.length === 0
    || source.notes.some((note) => typeof note !== "string" || !note.trim())) {
    throw new Error(`${sourcePath} notes must be a non-empty array of non-empty strings`);
  }
  return { version, notes: source.notes.map((note) => note.trim()) };
}

export function loadReleaseSource(root = REPOSITORY_ROOT) {
  return loadVersionSourceFile(root, VERSION_SOURCE_PATH);
}

export function loadVersionSource(root = REPOSITORY_ROOT) {
  return loadReleaseSource(root).version;
}

/** 改任意一条版本线来源文件里的 version（notes 原样保留）。 */
export function setVersionFileVersion(root, sourcePath, version) {
  validateVersion(version);
  const source = loadVersionSourceFile(root, sourcePath);
  const sourcePathAbsolute = join(root, sourcePath);
  const contents = serializeJson({ ...source, version });
  if (readFileSync(sourcePathAbsolute, "utf8") !== contents) {
    writeFileAtomically(sourcePathAbsolute, contents);
  }
}

export function setReleaseVersion(root = REPOSITORY_ROOT, version) {
  setVersionFileVersion(root, VERSION_SOURCE_PATH, version);
}

export function inspectPackageVersionCopies(root, packageRoots, version) {
  const issues = [];

  for (const packageRoot of packageRoots) {
    const packagePath = join(root, packageRoot, "package.json");
    try {
      const packageJson = readJson(packagePath);
      if (packageJson.version !== version) {
        issues.push(`${relative(root, packagePath)} version is ${JSON.stringify(packageJson.version)}, expected ${version}`);
      }
    } catch (error) {
      issues.push(`${relative(root, packagePath)} could not be read: ${error instanceof Error ? error.message : error}`);
    }

    const lockPath = join(root, packageRoot, "package-lock.json");
    try {
      const lock = readJson(lockPath);
      if (lock.version !== version) {
        issues.push(`${relative(root, lockPath)} top-level version is ${JSON.stringify(lock.version)}, expected ${version}`);
      }
      if (!lock.packages || !lock.packages[""]) {
        issues.push(`${relative(root, lockPath)} has no packages[""] root metadata`);
      } else if (lock.packages[""].version !== version) {
        issues.push(`${relative(root, lockPath)} packages[""].version is ${JSON.stringify(lock.packages[""].version)}, expected ${version}`);
      }
    } catch (error) {
      issues.push(`${relative(root, lockPath)} could not be read: ${error instanceof Error ? error.message : error}`);
    }
  }

  return issues;
}

export function syncPackageVersionCopies(root, packageRoots, version) {
  const changed = [];

  for (const packageRoot of packageRoots) {
    const packagePath = join(root, packageRoot, "package.json");
    const packageJson = readJson(packagePath);
    packageJson.version = version;
    const packageContents = serializeJson(packageJson);
    if (readFileSync(packagePath, "utf8") !== packageContents) {
      writeFileAtomically(packagePath, packageContents);
      changed.push(relative(root, packagePath));
    }

    const lockPath = join(root, packageRoot, "package-lock.json");
    const lock = readJson(lockPath);
    if (!lock.packages || !lock.packages[""]) {
      throw new Error(`${relative(root, lockPath)} has no packages[""] root metadata`);
    }
    lock.version = version;
    lock.packages[""].version = version;
    const lockContents = serializeJson(lock);
    if (readFileSync(lockPath, "utf8") !== lockContents) {
      writeFileAtomically(lockPath, lockContents);
      changed.push(relative(root, lockPath));
    }
  }

  return changed;
}

function findReadmeVersionMarkers(readme, markers) {
  return markers.flatMap((marker) =>
    Array.from(readme.matchAll(marker.pattern), (match) => ({
      marker,
      version: match[marker.versionGroup],
    })),
  );
}

export function inspectReadmeVersionMarkers(root, readmePaths, markers, version) {
  const issues = [];
  for (const readmePath of readmePaths) {
    try {
      const readme = readFileSync(join(root, readmePath), "utf8");
      const found = findReadmeVersionMarkers(readme, markers);
      if (found.length !== 1) {
        issues.push(`${readmePath} must contain exactly one supported version marker, found ${found.length}`);
      } else if (found[0].version !== version) {
        issues.push(`${readmePath} ${found[0].marker.name} is ${JSON.stringify(found[0].version)}, expected ${version}`);
      }
    } catch (error) {
      issues.push(`${readmePath} could not be read: ${error instanceof Error ? error.message : error}`);
    }
  }
  return issues;
}

export function syncReadmeVersionMarkers(root, readmePaths, markers, version) {
  const changed = [];
  for (const readmePath of readmePaths) {
    const absolutePath = join(root, readmePath);
    const readme = readFileSync(absolutePath, "utf8");
    const found = findReadmeVersionMarkers(readme, markers);
    if (found.length !== 1) {
      throw new Error(`${readmePath} must contain exactly one supported version marker before synchronization, found ${found.length}`);
    }
    const nextReadme = found[0].marker.replace(readme, version);
    if (readme !== nextReadme) {
      writeFileAtomically(absolutePath, nextReadme);
      changed.push(readmePath);
    }
  }
  return changed;
}

export function inspectVersionCopies(root = REPOSITORY_ROOT, version = loadVersionSource(root)) {
  return [
    ...inspectPackageVersionCopies(root, PACKAGE_ROOTS, version),
    ...inspectReadmeVersionMarkers(
      root,
      VERSION_README_PATHS,
      README_SERVER_VERSION_MARKERS,
      version,
    ),
  ];
}

export function syncVersionCopies(root = REPOSITORY_ROOT, version = loadVersionSource(root)) {
  return [
    ...syncPackageVersionCopies(root, PACKAGE_ROOTS, version),
    ...syncReadmeVersionMarkers(
      root,
      VERSION_README_PATHS,
      README_SERVER_VERSION_MARKERS,
      version,
    ),
  ];
}

/** 历史 v<version> tag 解析（旧桌面发布线 / 旧 RC 流程）。 */
export function parseReleaseTag(name) {
  const match = LEGACY_RELEASE_TAG_PATTERN.exec(name);
  return match ? { version: match[1], prerelease: match[2] ?? null } : null;
}

/** 服务端发布 tag：s-v<version>。 */
export function parseServerReleaseTag(name) {
  const match = SERVER_RELEASE_TAG_PATTERN.exec(name);
  return match ? { version: match[1] } : null;
}

export function serverTagForVersion(version) {
  return `${SERVER_TAG_PREFIX}${validateVersion(version)}`;
}

export function inspectExactReleaseTags(version, tags) {
  validateVersion(version);
  const issues = [];
  for (const tag of tags) {
    const parsed = parseServerReleaseTag(tag.name);
    if (!parsed) continue;
    if (parsed.version !== version) {
      issues.push(`exact release tag ${tag.name} targets version ${parsed.version}, but ${VERSION_SOURCE_PATH} is ${version}`);
    }
    if (tag.objectType !== "tag") {
      issues.push(`exact release tag ${tag.name} must be annotated, got Git object type ${tag.objectType}`);
    }
  }
  return issues;
}

function usage() {
  console.log("Usage: node .github/scripts/version-contract.mjs [--check|--write|--tag <s-vX.Y.Z>]");
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }
  const mode = args[0] ?? "--check";
  const validArity = mode === "--tag"
    ? args.length === 2 && Boolean(args[1])
    : args.length <= 1;
  if (!["--check", "--write", "--tag"].includes(mode) || !validArity) {
    usage();
    process.exitCode = 2;
    return;
  }

  try {
    if (mode === "--tag") {
      const parsed = parseServerReleaseTag(args[1]);
      if (!parsed) throw new Error(`expected an s-v<major>.<minor>.<patch> release tag, got ${JSON.stringify(args[1])}`);
      const version = loadVersionSource();
      if (parsed.version !== version) {
        throw new Error(`tag ${args[1]} targets version ${parsed.version}, but ${VERSION_SOURCE_PATH} is ${version}`);
      }
      console.log(parsed.version);
      return;
    }

    const version = loadVersionSource();
    if (mode === "--write") {
      const changed = syncVersionCopies(REPOSITORY_ROOT, version);
      console.log(changed.length > 0
        ? `synchronized ${changed.length} server version copies to ${version}`
        : `server version copies already synchronized at ${version}`);
    }

    const issues = inspectVersionCopies(REPOSITORY_ROOT, version);
    if (issues.length > 0) {
      for (const issue of issues) console.error(`version contract failed: ${issue}`);
      process.exitCode = 1;
      return;
    }
    console.log(`server version contract OK (${version}; ${PACKAGE_ROOTS.length} packages, ${PACKAGE_ROOTS.length} lockfiles, README)`);
  } catch (error) {
    console.error(`version contract failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main();
}
