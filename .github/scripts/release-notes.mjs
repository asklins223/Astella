#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadReleaseSource } from "./version-contract.mjs";

export function formatReleaseNotes({ version, notes }) {
  return [
    `Astella v${version}`,
    "",
    ...notes.map((note) => `- ${note.replace(/\r?\n/g, "\n  ")}`),
    "",
    "已安装旧版的用户可在客户端检查更新，或下载本次安装包替换原应用。更新通过 GitHub Releases 直连下载。",
    "",
    "未配置 Apple Developer ID 签名与公证时，macOS 首次打开可能需要在系统设置 → 隐私与安全性中选择“仍要打开”；未配置 Windows 签名时，首次运行可能经过 SmartScreen。",
    "",
  ].join("\n");
}

function main() {
  const args = process.argv.slice(2);
  try {
    if (args.length && (args.length !== 2 || args[0] !== "--output" || !args[1])) {
      throw new Error("Usage: node .github/scripts/release-notes.mjs [--output <path>]");
    }
    const notes = formatReleaseNotes(loadReleaseSource());
    if (args.length) writeFileSync(resolve(args[1]), notes, "utf8");
    else process.stdout.write(notes);
  } catch (error) {
    console.error(`release notes failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
