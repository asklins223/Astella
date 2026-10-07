#!/usr/bin/env node

// Desktop and server share release/version.json and the same v<version> tag.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REPOSITORY_ROOT, VERSION_SOURCE_PATH, loadVersionSource, validateVersion,
  inspectVersionCopies, syncVersionCopies, parseReleaseTag,
} from "./version-contract.mjs";

export { REPOSITORY_ROOT };
export const DESKTOP_VERSION_SOURCE_PATH = VERSION_SOURCE_PATH;
export const DESKTOP_PACKAGE_ROOT = "apps/desktop-client";
export const DESKTOP_TAG_PREFIX = "v";
export const validateDesktopVersion = validateVersion;
export const loadDesktopVersionSource = loadVersionSource;
export const inspectDesktopVersionCopies = inspectVersionCopies;
export const syncDesktopVersionCopies = syncVersionCopies;

export function parseDesktopReleaseTag(name) {
  const parsed = parseReleaseTag(name ?? "");
  return parsed && !parsed.prerelease ? { version: parsed.version } : null;
}

function main() {
  const args = process.argv.slice(2);
  try {
    if (args[0] === "--set") {
      const version = validateVersion(args[1]);
      const sourcePath = join(REPOSITORY_ROOT, VERSION_SOURCE_PATH);
      const next = `${JSON.stringify({ version }, null, 2)}\n`;
      if (readFileSync(sourcePath, "utf8") !== next) writeFileSync(sourcePath, next);
      const changed = syncVersionCopies(REPOSITORY_ROOT, version);
      console.log(`unified release version ${version}; synchronized ${changed.join(", ") || "no changes"}`);
      return;
    }
    if (args[0] === "--tag") {
      const parsed = parseDesktopReleaseTag(args[1]);
      if (!parsed) throw new Error("expected a stable v<major>.<minor>.<patch> release tag");
      console.log(parsed.version);
      return;
    }
    if (args[0] && args[0] !== "--check") {
      console.log("Usage: node .github/scripts/desktop-version.mjs [--check|--set <version>|--tag <tag>]");
      process.exitCode = args[0] === "--help" ? 0 : 2;
      return;
    }
    const version = loadVersionSource();
    const issues = inspectVersionCopies(REPOSITORY_ROOT, version);
    if (issues.length) throw new Error(issues.join("; "));
    console.log(`unified desktop/server version contract OK (v${version})`);
  } catch (error) {
    console.error(`version contract failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
