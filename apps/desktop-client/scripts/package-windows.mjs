#!/usr/bin/env node
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile, open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(desktop, '../..');
const require = createRequire(join(desktop, 'package.json'));
const { build, Platform, Arch } = require('electron-builder');
const { getPath7za } = require('app-builder-lib/out/toolsets/7zip');
const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap');
const { version } = JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8'));
const setup = resolve(desktop, 'outputs/windows-installer/base');
const release = resolve(desktop, 'release');
const artifact = join(release, `astella-${version}-win-x64.exe`);

async function run(file, args, cwd = desktop) {
  await new Promise((done, reject) => {
    const process = spawn(file, args, { cwd, stdio: 'inherit', shell: false });
    process.once('error', reject);
    process.once('exit', code => code === 0 ? done() : reject(new Error(`${file} exited ${code}`)));
  });
}
async function hash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function list(directory, relative = '') {
  const files = [];
  for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Windows payload cannot contain links: ${path}`);
    if (entry.isDirectory()) files.push(...await list(directory, path));
    else if (entry.isFile()) files.push({ path, size: (await stat(join(directory, path))).size, sha256: await hash(join(directory, path)) });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

// 安装包是「单文件壳 + 追加的 zip + 追加的清单」，签名又贴在最后。这几段只能靠 PE 自己的
// 证书目录定位，任何一段错位都会在用户机器上表现为「双击没反应」，所以在这里当场拆开核对。
async function inspectWindowsExecutable(path) {
  const handle = await open(path, 'r');
  try {
    const size = (await handle.stat()).size;
    const dos = Buffer.alloc(64);
    await handle.read(dos, 0, 64, 0);
    if (dos.subarray(0, 2).toString('latin1') !== 'MZ') throw new Error(`不是 Windows 可执行文件（缺 MZ 头）：${path}`);
    const peOffset = dos.readInt32LE(60);
    if (peOffset < 64 || peOffset > size - 240) throw new Error(`PE 偏移不合理：${peOffset}（文件 ${size} 字节）`);
    const header = Buffer.alloc(240);
    await handle.read(header, 0, 240, peOffset);
    if (header.subarray(0, 4).toString('latin1') !== 'PE\0\0') throw new Error(`PE 头缺失：${path}`);
    const machine = header.readUInt16LE(4);
    const certificateAt = peOffset + (header.readUInt16LE(24) === 0x20b ? 168 : 152);
    const certificate = Buffer.alloc(8);
    await handle.read(certificate, 0, 8, certificateAt);
    const certificateOffset = certificate.readUInt32LE(0);
    const certificateSize = certificate.readUInt32LE(4);
    const subsystem = header.readUInt16LE(24 + 68);
    if (machine !== 0x8664) throw new Error(`安装包不是 x64：machine=0x${machine.toString(16)}`);
    if (subsystem !== 2) throw new Error(`安装程序不是 GUI 子系统：subsystem=${subsystem}`);
    if (certificateSize > 0 && certificateOffset + certificateSize !== size)
      throw new Error(`签名没贴在文件末尾：证书 ${certificateOffset}+${certificateSize}，总长 ${size}`);
    const dataEnd = certificateSize === 0 ? size : certificateOffset;
    for (let padding = 0; padding < 8; padding++) {
      const at = dataEnd - padding - 24;
      if (at < 24) break;
      const footer = Buffer.alloc(24);
      await handle.read(footer, 0, 24, at);
      if (footer.subarray(16, 24).toString('latin1') !== 'ASTELLA1') continue;
      const jsonSize = Number(footer.readBigInt64LE(0));
      const zipSize = Number(footer.readBigInt64LE(8));
      const manifest = Buffer.alloc(jsonSize);
      await handle.read(manifest, 0, jsonSize, at - jsonSize);
      const apphostSize = at - jsonSize - zipSize;
      if (apphostSize < 20 * 1024 * 1024)
        throw new Error(`尾部尺寸不合理：壳 ${apphostSize}、载荷 ${zipSize}、清单 ${jsonSize}`);
      return { size, signed: certificateSize > 0, apphostSize, zipSize, manifest: JSON.parse(manifest.toString('utf8')) };
    }
    throw new Error(`安装包尾部找不到 ASTELLA1 标记：${path}`);
  } finally { await handle.close(); }
}

await mkdir(setup, { recursive: true });
await run(process.env.ASTELLA_DOTNET ?? 'dotnet', ['publish', join(root, 'apps/windows-installer/Astella.Setup.csproj'),
  '-c', 'Release', '-r', 'win-x64', '-o', setup, `-p:Version=${version}`, '--nologo']);
let windowsPackager;
await build({ projectDir: desktop, targets: Platform.WINDOWS.createTarget(['dir'], Arch.x64), publish: 'never',
  config: { extends: join(desktop, 'electron-builder.config.cjs'), afterPack: context => { windowsPackager = context.packager; } } });
if (!windowsPackager) throw new Error('Windows packaging context missing');
const payload = join(release, 'win-unpacked');
const uninstall = join(payload, 'Uninstall Astella.exe');
await copyFile(join(setup, 'AstellaSetup.exe'), uninstall);
await windowsPackager.signIf(uninstall);
await copyFile(join(root, 'LICENSE'), join(payload, 'LICENSE.txt'));
await copyFile(join(root, 'THIRD_PARTY_NOTICES.md'), join(payload, 'THIRD_PARTY_NOTICES.txt'));
await copyFile(join(root, 'apps/windows-installer/Resources/usage.txt'), join(payload, '用户使用须知.txt'));
await mkdir(join(payload, 'licenses'), { recursive: true });
for (const file of ['dotnet-LICENSE.txt', 'dotnet-THIRD-PARTY-NOTICES.txt', 'wpf-LICENSE.txt'])
  await copyFile(join(root, 'apps/windows-installer/Resources', file), join(payload, 'licenses', file));
// Directory targets do not emit a Windows installer feed; the independent updater uses this config.
await writeFile(join(payload, 'resources/app-update.yml'), 'provider: github\nowner: asklins223\nrepo: Astella\nupdaterCacheDirName: astella-desktop-client-updater\n');
const files = await list(payload);
const zip = join(setup, 'payload.zip');
await rm(zip, { force: true });
await run(await getPath7za(), ['a', '-tzip', '-mx=5', '-y', zip, '.'], payload);
const manifest = Buffer.from(JSON.stringify({ formatVersion: 1, appId: 'com.asklins.astella', version, arch: 'x64',
  size: files.reduce((sum, file) => sum + file.size, 0), sha256: await hash(zip), files }));
await copyFile(join(setup, 'AstellaSetup.exe'), artifact);
await pipeline(createReadStream(zip), createWriteStream(artifact, { flags: 'a' }));
const footer = Buffer.alloc(24);
footer.writeBigInt64LE(BigInt(manifest.length), 0);
footer.writeBigInt64LE(BigInt((await stat(zip)).size), 8);
footer.write('ASTELLA1', 16, 'ascii');
await writeFile(artifact, Buffer.concat([manifest, footer]), { flag: 'a' });
// Sign last: signing covers the custom payload. Its trailer reader understands PE certificate padding.
await windowsPackager.signIf(artifact);
const shipped = await inspectWindowsExecutable(artifact);
const { version: shippedVersion, appId, arch, size: unpackedSize, files: listed } = shipped.manifest;
if (shippedVersion !== version || appId !== 'com.asklins.astella' || arch !== 'x64')
  throw new Error(`安装包内登记的版本与本次构建不符：${shippedVersion}/${appId}/${arch}，期望 ${version}/com.asklins.astella/x64`);
if (unpackedSize !== files.reduce((sum, file) => sum + file.size, 0) || listed.length !== files.length)
  throw new Error(`安装包清单与 win-unpacked 对不上：清单 ${listed.length} 项 ${unpackedSize} 字节，实际 ${files.length} 项 ${files.reduce((sum, file) => sum + file.size, 0)} 字节`);
console.log(`安装包自检：壳 ${Math.round(shipped.apphostSize / 1024 / 1024)} MB + 载荷 ${Math.round(shipped.zipSize / 1024 / 1024)} MB + 清单 ${listed.length} 项 = ${shipped.size} 字节 · ${shipped.signed ? '已签名' : '未签名'}`);
if (!shipped.signed) console.warn('⚠ 未签名：数百 MB 的自解压单文件包最容易在用户机器上被安全软件静默拦下——双击没反应、也不报错。正式包请配好 WIN_CSC_LINK。');
// 出问题的机器上「双击没反应」查不出原因，随包带上只读诊断脚本（不安装、不卸载）。
await copyFile(join(desktop, 'scripts/diagnose-windows-installer.ps1'), join(release, 'diagnose-windows-installer.ps1'));
// Older released clients can download this EXE using their existing differential-download path.
await buildBlockMap(artifact, 'gzip', artifact + '.blockmap');
const sha512 = createHash('sha512');
for await (const chunk of createReadStream(artifact)) sha512.update(chunk);
const checksum = sha512.digest('base64');
const size = (await stat(artifact)).size;
const name = artifact.slice(artifact.lastIndexOf('/') + 1).split('\\').pop();
await writeFile(join(release, 'latest.yml'), `version: ${version}\nfiles:\n  - url: ${name}\n    sha512: ${checksum}\n    size: ${size}\npath: ${name}\nsha512: ${checksum}\nreleaseDate: '${new Date().toISOString()}'\n`);
console.log(`Independent Windows installer: ${artifact} (${Math.round(size / 1024 / 1024)} MB)`);
