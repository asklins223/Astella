import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ target: '', userData: '' }))
vi.mock('electron', () => ({ app: {
  getAppPath: () => join(fixture.target, 'Contents/Resources/app.asar'),
  getPath: () => fixture.userData, getVersion: () => '1.0.0',
} }))
import { prepareMacosArchiveInstall, verifyMacosInstallLocation, macosExecutableSupportsArchitecture } from '../macos-update-install'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))

function bundle(root: string, name: string, version: string, marker: string): string {
  const app = join(root, name)
  mkdirSync(join(app, 'Contents/MacOS'), { recursive: true })
  mkdirSync(join(app, 'Contents/Resources'))
  const source = join(root, `${version}.c`)
  writeFileSync(source, `#include <stdio.h>\nint main(void) { FILE *f=fopen(${JSON.stringify(marker)}, "w"); if(f) { fputs("${version}", f); fclose(f); } return 0; }`)
  execFileSync('/usr/bin/clang', [source, '-o', join(app, 'Contents/MacOS/Astella')])
  writeFileSync(join(app, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.asklins.astella</string><key>CFBundleExecutable</key><string>Astella</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleVersion</key><string>${version}</string></dict></plist>`)
  writeFileSync(join(app, 'Contents/Resources/version.txt'), version)
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', app], { stdio: 'pipe' })
  return app
}

function setup(tamper = false) {
  const root = mkdtempSync(join(tmpdir(), "astella install ' 中文-"))
  roots.push(root)
  fixture.userData = join(root, 'profile')
  mkdirSync(fixture.userData)
  fixture.target = bundle(root, '书房 old.app', '1.0.0', join(root, 'old-started'))
  const next = bundle(root, '书房 new.app', '2.0.0', join(root, 'new-started'))
  if (tamper) writeFileSync(join(next, 'Contents/Resources/version.txt'), 'damaged')
  const zip = join(root, 'update.zip')
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', next, zip])
  const sha512 = createHash('sha512').update(readFileSync(zip)).digest('base64')
  return { root, archive: { path: zip, version: '2.0.0', sha512 } }
}

describe.skipIf(process.platform !== 'darwin')('native Mac archive installation (no Apple certificate)', () => {
  it('waits for the old process, replaces the whole bundle and launches the new executable', async () => {
    const { root, archive } = setup()
    const prepared = await prepareMacosArchiveInstall(archive)
    const oldProcess = spawn('/bin/sleep', ['1'])
    const script = spawn('/bin/sh', [join(prepared.stagingDirectory, 'install.sh'), String(oldProcess.pid), fixture.target,
      join(prepared.stagingDirectory, '书房 new.app'), join(prepared.stagingDirectory, 'previous.app'),
      join(fixture.userData, 'update-install.json'), '{"status":"failed"}'], { stdio: 'pipe' })
    expect(readFileSync(join(fixture.target, 'Contents/Resources/version.txt'), 'utf8')).toBe('1.0.0')
    await new Promise<void>((resolve, reject) => {
      script.once('error', reject); script.once('exit', code => code === 0 ? resolve() : reject(new Error(`Installer exited ${code}`)))
    })
    await vi.waitFor(() => expect(existsSync(join(root, 'new-started'))).toBe(true), { timeout: 10_000 })
    expect(readFileSync(join(root, 'new-started'), 'utf8')).toBe('2.0.0')
    expect(readFileSync(join(prepared.stagingDirectory, 'previous.app/Contents/Resources/version.txt'), 'utf8')).toBe('1.0.0')
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', fixture.target])
  })

  it('restores the old bundle if the replacement cannot be moved into place', async () => {
    const { root, archive } = setup()
    const prepared = await prepareMacosArchiveInstall(archive)
    const script = spawn('/bin/sh', [join(prepared.stagingDirectory, 'install.sh'), '2147483647', fixture.target,
      join(root, 'missing.app'), join(prepared.stagingDirectory, 'previous.app'),
      join(fixture.userData, 'update-install.json'), '{"status":"failed"}'], { stdio: 'ignore' })
    const code = await new Promise(resolve => script.once('exit', resolve))
    expect(code).toBe(1)
    expect(readFileSync(join(fixture.target, 'Contents/Resources/version.txt'), 'utf8')).toBe('1.0.0')
    expect(JSON.parse(readFileSync(join(fixture.userData, 'update-install.json'), 'utf8')).status).toBe('failed')
    await vi.waitFor(() => expect(existsSync(join(root, 'old-started'))).toBe(true), { timeout: 10_000 })
  })

  it('rejects a changed cache, damaged app seal and wrong version before quitting', async () => {
    const good = setup()
    await expect(prepareMacosArchiveInstall({ ...good.archive, sha512: 'wrong' })).rejects.toThrow('checksum')
    await expect(prepareMacosArchiveInstall({ ...good.archive, version: '3.0.0' })).rejects.toThrow('version mismatch')
    const damaged = setup(true)
    await expect(prepareMacosArchiveInstall(damaged.archive)).rejects.toThrow()
    expect(readFileSync(join(fixture.target, 'Contents/Resources/version.txt'), 'utf8')).toBe('1.0.0')
  })

  it('explains read-only disk images and translocated launches before replacing files', async () => {
    await expect(verifyMacosInstallLocation('/Volumes/Astella/Astella.app')).rejects.toThrow('应用程序')
    await expect(verifyMacosInstallLocation('/private/var/AppTranslocation/token/Astella.app')).rejects.toThrow('应用程序')
  })
})

it('recognizes arm64, Intel and universal Mach-O headers without developer tools', () => {
  const thin = Buffer.alloc(32)
  thin.writeUInt32LE(0xfeedfacf, 0); thin.writeUInt32LE(0x0100000c, 4)
  expect(macosExecutableSupportsArchitecture(thin, 'arm64')).toBe(true)
  expect(macosExecutableSupportsArchitecture(thin, 'x64')).toBe(false)
  thin.writeUInt32LE(0x01000007, 4)
  expect(macosExecutableSupportsArchitecture(thin, 'x64')).toBe(true)
  const universal = Buffer.alloc(48)
  universal.writeUInt32BE(0xcafebabe, 0); universal.writeUInt32BE(2, 4)
  universal.writeUInt32BE(0x0100000c, 8); universal.writeUInt32BE(0x01000007, 28)
  expect(macosExecutableSupportsArchitecture(universal, 'arm64')).toBe(true)
  expect(macosExecutableSupportsArchitecture(universal, 'x64')).toBe(true)
  expect(macosExecutableSupportsArchitecture(universal.subarray(0, 9), 'arm64')).toBe(false)
})
