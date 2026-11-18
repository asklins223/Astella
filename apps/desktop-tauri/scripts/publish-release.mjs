#!/usr/bin/env node
/**
 * 把 dist/<version> 里的安装包挂到 GitHub Release（迁移文档「发布准备」）。
 *
 * 默认只打印将要执行的命令；加 --execute 才真正调用 gh。
 * 默认创建 draft，确认无误后再在网页上发布。
 *
 * 用法：
 *   node scripts/publish-release.mjs --version 2.0.6            # 预览
 *   node scripts/publish-release.mjs --version 2.0.6 --execute  # 建 draft 并上传
 *   [--tag c-v2.0.6] [--notes path/to/notes.md] [--no-draft]
 *
 * 注意：不要上传 latest*.yml（清单归 Electron 发布链，服务端会改写 url）；
 * 增量补丁与当版 Tauri 二进制由发布流程另行上传（见迁移文档）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const flag = (name) => process.argv.includes(`--${name}`);

const version = arg("version");
if (!version) {
  console.error("usage: node scripts/publish-release.mjs --version <semver> [--tag c-v<semver>] [--notes <file>] [--no-draft] [--execute]");
  process.exit(2);
}

const dist = join(appRoot, "dist", version);
if (!existsSync(dist)) {
  console.error(`缺少产物目录：${dist}`);
  process.exit(1);
}

const required = [`Astella_${version}_aarch64.dmg`, `Astella_${version}_x64-setup.exe`, "SHA256SUMS"];
for (const file of required) {
  if (!existsSync(join(dist, file))) {
    console.error(`缺少产物：${join(dist, file)}`);
    process.exit(1);
  }
}

// 只传明确列出的安装包与校验值；其余文件（尤其 latest*.yml）不上传。
const assets = required.map((file) => join(dist, file));
const tag = arg("tag") ?? `c-v${version}`;
const notes = arg("notes");
const draft = !flag("no-draft");
const execute = flag("execute");

const createArgs = ["release", "create", tag, ...assets, "--title", `Astella ${version}`];
if (draft) createArgs.push("--draft");
if (notes) createArgs.push("--notes-file", notes);
else createArgs.push("--notes", `Tauri 桌面端 ${version}（macOS arm64 DMG / Windows x64 NSIS）。清单与增量补丁由发布链另行处理。`);

// 已存在同名 release 时改为追加资产。
let exists = false;
try {
  execFileSync("gh", ["release", "view", tag], { stdio: "ignore" });
  exists = true;
} catch {
  exists = false;
}
const uploadArgs = ["release", "upload", tag, ...assets, "--clobber"];

const show = (args) => `gh ${args.map((value) => (value.includes(" ") ? JSON.stringify(value) : value)).join(" ")}`;
console.log(exists ? "release 已存在，将追加资产：" : "将创建 release：");
console.log(`  ${show(exists ? uploadArgs : createArgs)}`);
if (!execute) {
  console.log("（预览模式；确认无误后加 --execute）");
  process.exit(0);
}
if (exists && !flag("allow-existing")) {
  console.error("该 Release 已存在并可能已发布；追加资产请显式加 --allow-existing（先核对现有资产无重名）。");
  process.exit(1);
}
execFileSync("gh", exists ? uploadArgs : createArgs, { stdio: "inherit" });
console.log(`done: ${tag}`);
