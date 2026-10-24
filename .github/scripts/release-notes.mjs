#!/usr/bin/env node

// 发布说明生成器。2026-10-24 起版本线拆分：--source server（默认）读
// release/version.json，--source desktop 读 apps/desktop-client/version.json。
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SERVER_TAG_PREFIX, loadReleaseSource } from "./version-contract.mjs";
import {
  DESKTOP_TAG_PREFIX,
  loadDesktopReleaseSource,
} from "./desktop-version.mjs";

export const RELEASE_SOURCES = ["server", "desktop"];

export function loadReleaseNotesSource(source = "server", root) {
  if (source === "server") return loadReleaseSource(root);
  if (source === "desktop") return loadDesktopReleaseSource(root);
  throw new Error(`unknown release source ${JSON.stringify(source)}; expected one of ${RELEASE_SOURCES.join(", ")}`);
}

export function formatReleaseNotes({ version, notes, source = "server" }) {
  const body = notes.map((note) => `- ${note.replace(/\r?\n/g, "\n  ")}`);
  if (source === "desktop") {
    return [
      `Astella 桌面客户端 ${DESKTOP_TAG_PREFIX}${version}`,
      "",
      ...body,
      "",
      "已安装旧版的用户可在客户端检查更新，或下载本次安装包替换原应用。更新通过服务端 Release Center 的 electron-updater 清单下发，GitHub Releases 作为兜底。",
      "",
      "未配置 Apple Developer ID 签名与公证时，macOS 首次打开可能需要在系统设置 → 隐私与安全性中选择“仍要打开”；未配置 Windows 签名时，首次运行可能经过 SmartScreen。",
      "",
    ].join("\n");
  }
  if (source !== "server") {
    throw new Error(`unknown release source ${JSON.stringify(source)}; expected one of ${RELEASE_SOURCES.join(", ")}`);
  }
  return [
    `Astella 服务端 ${SERVER_TAG_PREFIX}${version}`,
    "",
    ...body,
    "",
    "服务端版本与桌面客户端、iOS、Android 各自独立发布，不随客户端安装包发布；部署与版本登记见 docs/guide/zh/deployment.md。",
    "",
  ].join("\n");
}

function parseArgs(args) {
  const options = { source: "server", output: null };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--source") {
      options.source = args[index + 1];
      index += 1;
    } else if (arg === "--output") {
      options.output = args[index + 1];
      index += 1;
    } else {
      throw new Error(`Usage: node .github/scripts/release-notes.mjs [--source server|desktop] [--output <path>]`);
    }
    if (options.source === undefined || options.source === null || options.source === "") {
      throw new Error("--source requires server or desktop");
    }
    if (options.output !== null && !options.output) {
      throw new Error("--output requires a path");
    }
  }
  if (!RELEASE_SOURCES.includes(options.source)) {
    throw new Error(`--source must be one of ${RELEASE_SOURCES.join(", ")}, got ${JSON.stringify(options.source)}`);
  }
  return options;
}

function main() {
  const args = process.argv.slice(2);
  try {
    const options = parseArgs(args);
    const notes = formatReleaseNotes({
      ...loadReleaseNotesSource(options.source),
      source: options.source,
    });
    if (options.output) writeFileSync(resolve(options.output), notes, "utf8");
    else process.stdout.write(notes);
  } catch (error) {
    console.error(`release notes failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
