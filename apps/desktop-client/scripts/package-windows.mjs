#!/usr/bin/env node
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
// Older released clients can download this EXE using their existing differential-download path.
await buildBlockMap(artifact, 'gzip', artifact + '.blockmap');
const sha512 = createHash('sha512');
for await (const chunk of createReadStream(artifact)) sha512.update(chunk);
const checksum = sha512.digest('base64');
const size = (await stat(artifact)).size;
const name = artifact.slice(artifact.lastIndexOf('/') + 1).split('\\').pop();
await writeFile(join(release, 'latest.yml'), `version: ${version}\nfiles:\n  - url: ${name}\n    sha512: ${checksum}\n    size: ${size}\npath: ${name}\nsha512: ${checksum}\nreleaseDate: '${new Date().toISOString()}'\n`);
console.log(`Independent Windows installer: ${artifact} (${Math.round(size / 1024 / 1024)} MB)`);
