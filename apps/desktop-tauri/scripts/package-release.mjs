#!/usr/bin/env node
/**
 * Tauri 桌面端的发布打包脚本（2026-11-18）。
 *
 * 把前几轮手工演练固化成一条命令：构建渲染层 → 构建 release → 打包 .app/DMG →
 * （可选）对上一版二进制生成增量补丁 → 汇总到 dist/。
 *
 * macOS 26 上 Tauri 的 DMG 样式脚本会卡在 Finder AppleEvent，脚本内部强制 CI=true
 * 走无样式路径。
 *
 * 用法：
 *   node scripts/package-release.mjs \
 *     --version 2.0.7 \
 *     [--previous /path/to/previous/Astella] \   # 上一版主二进制（CI 从上个 release 下载）
 *     [--deployment /path/to/deployment.json] \  # 注入 .app/Contents/Resources
 *     [--release-url-base https://cdn.example/updates/desktop] \  # 仅供本地演练生成 latest(-mac).yml
 *     [--skip-renderer] [--skip-bundle] [--dry-run]
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appRoot, "../..");

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const flag = (name) => process.argv.includes(`--${name}`);

const version = arg("version");
if (!version) {
  console.error("usage: node scripts/package-release.mjs --version <semver> [--previous <binary>] [--deployment <json>]");
  process.exit(2);
}
const previous = arg("previous");
const deployment = arg("deployment");
const features = arg("features");
const releaseUrlBase = arg("release-url-base");
const dryRun = flag("dry-run");
const dist = join(appRoot, "dist", version);
// 本机默认按真实平台；ASTELLA_PACKAGE_PLATFORM=windows 可在 mac 上演练 Windows 分支。
const isWindows = process.env.ASTELLA_PACKAGE_PLATFORM === "windows" || process.platform === "win32";

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(" ")}`);
  if (dryRun) return;
  // Windows 上 npm/npx 是 .cmd，必须经 shell 启动。
  const shell = process.platform === "win32" && (command === "npm" || command === "npx");
  execFileSync(command, args, { stdio: "inherit", cwd: appRoot, shell, ...options });
}

// 1. 渲染层产物（out/renderer 是 Tauri 的 frontendDist）。
if (!flag("skip-renderer")) {
  run("npm", ["run", "build"], { cwd: join(repoRoot, "apps/desktop-client") });
}

// 2. 主二进制 + 安装包（mac: .app/DMG，win: NSIS）。
let bundleConfig;
if (deployment && isWindows) {
  // Windows 走 bundle.resources 平铺到安装目录；macOS 仍是手工放进 Contents/Resources。
  const resourceDir = join(appRoot, "resources");
  if (!dryRun) {
    mkdirSync(resourceDir, { recursive: true });
    copyFileSync(deployment, join(resourceDir, "deployment.json"));
  }
  const configPath = join(appRoot, "target", "tauri-bundle-config.json");
  if (!dryRun) {
    mkdirSync(join(appRoot, "target"), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ bundle: { resources: { "resources/deployment.json": "deployment.json" } } }));
  }
  bundleConfig = configPath;
}
if (!flag("skip-bundle")) {
  const featureArgs = features ? ["--features", features] : [];
  const bundles = isWindows ? "nsis" : "app,dmg";
  run("cargo", ["build", "--release", "--bin", "astella-desktop-tauri", ...featureArgs]);
  run("npx", ["--yes", "@tauri-apps/cli@latest", "build", "--bundles", bundles, ...featureArgs,
    ...(bundleConfig ? ["--config", bundleConfig] : [])], {
    env: { ...process.env, CI: "true" },
  });
}

// 3. 部署默认值注入（打包后的资源目录）。
if (deployment && !isWindows) {
  const app = join(appRoot, "target/release/bundle/macos/Astella.app");
  if (!dryRun && !existsSync(app)) {
    console.error("Astella.app 不存在；先跑一次不带 --skip-bundle 的打包");
    process.exit(1);
  }
  if (!dryRun) copyFileSync(deployment, join(app, "Contents/Resources/deployment.json"));
  console.log(`deployment.json -> Contents/Resources/deployment.json`);
}
if (deployment && isWindows) {
  console.log(`deployment.json -> 安装目录资源（bundle.resources 平铺）`);
}

// 4. 增量补丁（只保上一版）。
if (previous) {
  const binary = join(appRoot, "target/release/astella-desktop-tauri" + (isWindows ? ".exe" : ""));
  const patchOut = join(dist, "delta");
  if (!dryRun) mkdirSync(patchOut, { recursive: true });
  const previousVersion = arg("previous-version");
  if (!previousVersion) {
    console.error("--previous 需要同时给 --previous-version（用于补丁命名）");
    process.exit(2);
  }
  run("cargo", ["run", "--release", "--bin", "make_patch", "--",
    "--from", previous, "--to", binary,
    "--from-version", previousVersion, "--to-version", version,
    "--out", patchOut, "--verify"]);
}

// 5. 汇总安装包。
if (!dryRun) {
  mkdirSync(dist, { recursive: true });
  if (isWindows) {
    const nsis = join(appRoot, "target/release/bundle/nsis");
    if (existsSync(nsis)) {
      for (const file of readdirSync(nsis)) {
        if (file.endsWith(".exe")) copyFileSync(join(nsis, file), join(dist, file));
      }
    }
  } else {
    const dmg = join(appRoot, `target/release/bundle/dmg/Astella_${version}_aarch64.dmg`);
    if (existsSync(dmg)) copyFileSync(dmg, join(dist, `Astella_${version}_aarch64.dmg`));
  }
  console.log(`artifacts -> ${dist}`);

  // 6. 更新清单（仅供本地演练：正式发布的 latest*.yml 由 Electron 发布链产出、服务端改写 url；
  //    把这里生成的清单传到同一个 Release 会顶掉 Electron 的清单，切勿使用）。
  if (releaseUrlBase) {
    const artifact = isWindows
      ? readdirSync(dist).find((file) => file.endsWith(".exe"))
      : `Astella_${version}_aarch64.dmg`;
    const artifactPath = artifact ? join(dist, artifact) : undefined;
    if (!artifactPath || !existsSync(artifactPath)) {
      console.error(`找不到要写进清单的安装包（${artifact ?? "未知产物"}）`);
      process.exit(1);
    }
    const bytes = readFileSync(artifactPath);
    const sha512 = createHash("sha512").update(bytes).digest("base64");
    const manifestName = isWindows ? "latest.yml" : "latest-mac.yml";
    const lines = [
      `version: ${version}`,
      "files:",
      `  - url: ${releaseUrlBase.replace(/\/$/, "")}/${artifact}`,
      `    sha512: ${sha512}`,
      `    size: ${bytes.length}`,
      "",
    ];
    writeFileSync(join(dist, manifestName), lines.join("\n"));
    console.log(`${manifestName} -> ${dist}`);
  } else {
    console.log("未给 --release-url-base，跳过更新清单");
  }
}
console.log(dryRun ? "dry run ok" : "release packaging done");
