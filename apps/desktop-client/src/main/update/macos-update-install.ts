import { app } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { access, chmod, mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Read Mach-O headers directly; users do not need Xcode's lipo tool. */
export function macosExecutableSupportsArchitecture(header: Buffer, arch: string): boolean {
  if (header.length < 8) return false
  const cpu = arch === 'arm64' ? 0x0100000c : arch === 'x64' ? 0x01000007 : -1
  const magic = header.readUInt32BE(0)
  if (magic === 0xcffaedfe) return header.readUInt32LE(4) === cpu
  if (magic === 0xfeedfacf) return header.readUInt32BE(4) === cpu
  if (magic !== 0xcafebabe && magic !== 0xcafebabf) return false
  const count = header.readUInt32BE(4)
  const stride = magic === 0xcafebabf ? 32 : 20
  if (count > 16 || header.length < 8 + count * stride) return false
  for (let index = 0; index < count; index++) if (header.readUInt32BE(8 + index * stride) === cpu) return true
  return false
}

export function macosAppBundle(): string {
  return resolve(app.getAppPath(), '../../..')
}

export async function verifyMacosInstallLocation(bundle = macosAppBundle()): Promise<void> {
  if (!bundle.endsWith('.app') || bundle.includes('/AppTranslocation/') || bundle.startsWith('/Volumes/')) {
    throw new Error('MAC_UPDATE_LOCATION: 请先把书房移到「应用程序」文件夹，再重启安装更新。')
  }
  try { await access(dirname(bundle), constants.W_OK); await access(bundle, constants.W_OK) }
  catch { throw new Error('MAC_UPDATE_PERMISSION: 当前应用位置不能写入，请把书房移到你有权限的「应用程序」文件夹。') }
}

/** Runs outside Electron/asar and waits for the old process to release its files. */
export const MACOS_INSTALL_SCRIPT = `#!/bin/sh
set -u
parent_pid="$1"
target="$2"
staged="$3"
backup="$4"
receipt="$5"
failure="$6"
attempt=0
while kill -0 "$parent_pid" 2>/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 120 ]; then
    printf '%s' "$failure" > "$receipt"
    exit 1
  fi
  /bin/sleep 0.5
done
if ! /bin/mv "$target" "$backup"; then
  printf '%s' "$failure" > "$receipt"
  /usr/bin/open -n "$target"
  exit 1
fi
if ! /bin/mv "$staged" "$target"; then
  /bin/mv "$backup" "$target"
  printf '%s' "$failure" > "$receipt"
  /usr/bin/open -n "$target"
  exit 1
fi
if ! /usr/bin/open -n "$target"; then
  /bin/mv "$target" "$staged"
  /bin/mv "$backup" "$target"
  printf '%s' "$failure" > "$receipt"
  /usr/bin/open -n "$target"
  exit 1
fi
`

export async function prepareMacosArchiveInstall(archive: { path: string; version: string; sha512: string }): Promise<{ launch: () => Promise<void>; stagingDirectory: string }> {
  const target = macosAppBundle()
  await verifyMacosInstallLocation(target)
  // Recheck even the download cache before executing its contents.
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(archive.path)) hash.update(chunk)
  if (hash.digest('base64') !== archive.sha512) throw new Error('Update SHA512 checksum mismatch')
  // Same volume as the installed bundle: replacement is a rename, never a partial copy.
  const staging = await mkdtemp(join(dirname(target), '.astella-update-'))
  try {
    await chmod(staging, 0o700)
    await run('/usr/bin/ditto', ['-x', '-k', '--noqtn', archive.path, staging], { timeout: 120_000 })
    const bundles = (await readdir(staging, { withFileTypes: true })).filter(entry => entry.isDirectory() && entry.name.endsWith('.app'))
    if (bundles.length !== 1) throw new Error('Update archive must contain exactly one app')
    const staged = join(staging, bundles[0].name)
    const plist = join(staged, 'Contents/Info.plist')
    const readPlist = async (key: string) => (await run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist])).stdout.trim()
    if (await readPlist('CFBundleIdentifier') !== 'com.asklins.astella' || await readPlist('CFBundleShortVersionString') !== archive.version) {
      throw new Error('Update bundle identity or version mismatch')
    }
    const executable = await readPlist('CFBundleExecutable')
    if (!executable || basename(executable) !== executable) throw new Error('Invalid update executable')
    const binary = await open(join(staged, 'Contents/MacOS', executable), 'r')
    try {
      const header = Buffer.alloc(520)
      const { bytesRead } = await binary.read(header, 0, header.length, 0)
      if (!macosExecutableSupportsArchitecture(header.subarray(0, bytesRead), process.arch)) throw new Error('Update architecture mismatch')
    } finally { await binary.close() }
    // An ad-hoc seal needs no Apple certificate and still detects damaged resources.
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged], { timeout: 60_000 })
    const script = join(staging, 'install.sh')
    await writeFile(script, MACOS_INSTALL_SCRIPT, { mode: 0o700 })
    const receipt = join(app.getPath('userData'), 'update-install.json')
    const failure = JSON.stringify({ fromVersion: app.getVersion(), version: archive.version, status: 'failed', stagingDirectory: staging })
    const launch = async () => {
      try {
        const child = spawn('/bin/sh', [script, String(process.pid), target, staged, join(staging, 'previous.app'), receipt, failure], {
          detached: true, stdio: 'ignore',
        })
        await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
        child.unref()
      } catch (error) { await rm(staging, { recursive: true, force: true }); throw error }
    }
    return { launch, stagingDirectory: staging }
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}
