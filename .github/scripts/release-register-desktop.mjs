#!/usr/bin/env node
/**
 * 把一次桌面发布登记到 Release Center（macOS + Windows 两行），并生成可选的
 * 对象存储镜像地址。与 mobile 仓库的 release-register.mjs 使用同一套内部契约。
 *
 * 用法：
 *   RELEASE_CENTER_URL=… RELEASE_CENTER_TOKEN=… \
 *   node .github/scripts/release-register-desktop.mjs \
 *     --artifacts artifacts --version 2.0.0 --tag c-v2.0.0
 *
 * 缺少 RELEASE_CENTER_* 时打印跳过并 exit 0：桌面发布仍依赖 GitHub Releases 与
 * electron-builder 的 latest*.yml，不因未配置 Release Center 而失败。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

function log(message) { console.log(`release-register-desktop: ${message}`); }
function fail(message) { console.error(`release-register-desktop: ${message}`); process.exit(1); }

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const artifacts = resolve(arg("artifacts", "artifacts"));
const version = arg("version");
const tag = arg("tag");
const channel = arg("channel", "stable");
if (!version || !tag) fail("--version and --tag are required");
const centerUrl = (process.env.RELEASE_CENTER_URL || "").trim().replace(/\/+$/, "");
const token = (process.env.RELEASE_CENTER_TOKEN || "").trim();
if (!centerUrl || !token) {
  log("RELEASE_CENTER_URL / RELEASE_CENTER_TOKEN not configured; skipping registration.");
  process.exit(0);
}
if (!existsSync(artifacts)) fail(`artifacts directory not found: ${artifacts}`);

function sha256File(path) {
  const data = readFileSync(path);
  return { sha256: createHash("sha256").update(data).digest("hex"), byteLength: data.length };
}
function findFile(predicate) {
  return readdirSync(artifacts).find((name) => predicate(name) && statSync(join(artifacts, name)).isFile()) ?? null;
}
function packageEntry(kind, name, githubBase, mirrorBase, mirrorPlatform) {
  const path = join(artifacts, name);
  if (!existsSync(path)) return null;
  const { sha256, byteLength } = sha256File(path);
  return {
    kind, name,
    url: `${githubBase}/${encodeURIComponent(name)}`,
    ...(mirrorBase ? { mirrorUrl: `${mirrorBase}/app-releases/${mirrorPlatform}/${version}/${encodeURIComponent(name)}` } : {}),
    sha256, byteLength,
  };
}
async function post(path, payload) {
  const response = await fetch(`${centerUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text().catch(() => "");
  if (!response.ok) fail(`POST ${path} -> HTTP ${response.status}: ${text.slice(0, 500)}`);
  log(`POST ${path} -> HTTP ${response.status}`);
}

const repo = process.env.GITHUB_REPOSITORY || "asklins223/Astella";
const githubBase = `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}`;
const publicBase = (process.env.RELEASE_ASSETS_PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
const storageConfigured = Boolean((process.env.RELEASE_S3_BUCKET || "").trim() && (process.env.RELEASE_S3_ENDPOINT || "").trim());
const mirrorBase = publicBase && storageConfigured ? publicBase : null;
const releasedAt = new Date().toISOString();
const windowsSigned = ["1", "true", "yes"].includes(String(process.env.WINDOWS_SIGNED ?? "").toLowerCase());
const macosSigned = ["1", "true", "yes"].includes(String(process.env.MACOS_SIGNED ?? "").toLowerCase());
const notes = (() => {
  try { return JSON.parse(readFileSync("apps/desktop-client/version.json", "utf8")).notes?.join("\n\n") ?? null; }
  catch { return null; }
})();

/**
 * electron-builder 写下的 `url:` 是相对文件名；API 会把这个清单直接返回给
 * electron-updater，若保持相对路径，更新器会把地址拼到 /updates/desktop/ 下而 404。
 * 这里改写为 GitHub Release 的具体资产地址；绝对地址原样保留。
 */
function rewriteManifestUrls(body) {
  return body.split("\n").map((line) => {
    const matched = /^(\s*-?\s*url:\s*)(.+?)\s*$/.exec(line);
    if (!matched) return line;
    const target = matched[2].replace(/^["']|["']$/g, "");
    if (/^https?:\/\//i.test(target)) return line;
    return `${matched[1]}${githubBase}/${target}`;
  }).join("\n");
}

const latestWin = rewriteManifestUrls(readFileSync(join(artifacts, "latest.yml"), "utf8"));
const latestMac = rewriteManifestUrls(readFileSync(join(artifacts, "latest-mac.yml"), "utf8"));

const winExe = findFile((name) => name.endsWith("-win-x64.exe"));
const winBlockmap = findFile((name) => name.endsWith("-win-x64.exe.blockmap"));
const macZip = findFile((name) => name.includes("-mac-") && name.endsWith(".zip"));
const macDmg = findFile((name) => name.includes("-mac-") && name.endsWith(".dmg"));
const macBlockmap = findFile((name) => name.includes("-mac-") && name.endsWith(".zip.blockmap"));

for (const [label, name] of [["windows installer", winExe], ["macOS zip", macZip], ["macOS dmg", macDmg]]) {
  if (!name) fail(`missing ${label} in ${artifacts}`);
}

const windowsPackages = [
  packageEntry("full", winExe, githubBase, mirrorBase, "windows"),
  winBlockmap ? packageEntry("blockmap", winBlockmap, githubBase, mirrorBase, "windows") : null,
].filter(Boolean);
const macosPackages = [
  packageEntry("full", macZip, githubBase, mirrorBase, "macos"),
  packageEntry("full", macDmg, githubBase, mirrorBase, "macos"),
  macBlockmap ? packageEntry("blockmap", macBlockmap, githubBase, mirrorBase, "macos") : null,
].filter(Boolean);

await post("/internal/app-releases", {
  platform: "windows", channel, version, build: 0, tag, releasedAt,
  notes, signed: windowsSigned, packages: windowsPackages,
  desktopManifest: { "latest.yml": latestWin }, activate: true,
});
await post("/internal/app-releases", {
  platform: "macos", channel, version, build: 0, tag, releasedAt,
  notes, signed: macosSigned, packages: macosPackages,
  desktopManifest: { "latest-mac.yml": latestMac }, activate: true,
});
log(`registered desktop ${version} ${tag} (windows ${windowsPackages.length} / macos ${macosPackages.length} packages)`);
