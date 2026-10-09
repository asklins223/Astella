import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({ exe: '', userData: '', spawn: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: (name: string) => name === 'exe' ? runtime.exe : runtime.userData, getVersion: () => '1.0.0' } }))
vi.mock('node:child_process', () => ({ spawn: runtime.spawn }))
import { prepareWindowsInstaller } from '../windows-update-install'

const roots: string[] = []
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); runtime.spawn.mockReset() })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "astella win 中文 ' "))
  roots.push(root)
  const install = join(root, 'custom apps', 'Astella')
  mkdirSync(install, { recursive: true })
  runtime.exe = join(install, 'Astella.exe')
  runtime.userData = join(root, 'profile')
  const path = join(root, 'new version.exe')
  const bytes = Buffer.from('MZ test independent Windows installer')
  writeFileSync(path, bytes)
  return { install, installer: { path, version: '2.0.0', sha512: createHash('sha512').update(bytes).digest('base64') } }
}

it('checks the cache, launches literal arguments and waits for Electron to exit before replacement', async () => {
  const { install, installer } = fixture()
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
  runtime.spawn.mockImplementation(() => { queueMicrotask(() => child.emit('spawn')); return child })
  const prepared = await prepareWindowsInstaller(installer)
  expect(runtime.spawn).not.toHaveBeenCalled()
  await prepared.launch()
  expect(runtime.spawn).toHaveBeenCalledWith(installer.path, ['--update', '--install-dir', install, '--wait-pid', String(process.pid),
    '--receipt', join(runtime.userData, 'update-install.json'), '--from-version', '1.0.0', '--target-version', '2.0.0', '--launch'],
  { detached: true, stdio: 'ignore', windowsHide: false })
  expect(child.unref).toHaveBeenCalledOnce()
})

it('rejects a damaged download or non-PE executable before quitting', async () => {
  const { installer } = fixture()
  await expect(prepareWindowsInstaller({ ...installer, sha512: 'wrong' })).rejects.toThrow('checksum')
  const bytes = Buffer.from('not a Windows executable')
  writeFileSync(installer.path, bytes)
  await expect(prepareWindowsInstaller({ ...installer, sha512: createHash('sha512').update(bytes).digest('base64') })).rejects.toThrow('executable')
  expect(runtime.spawn).not.toHaveBeenCalled()
})

it('reports launch failure to the live application so it can remain open', async () => {
  const { installer } = fixture()
  const child = new EventEmitter()
  runtime.spawn.mockImplementation(() => { queueMicrotask(() => child.emit('error', new Error('launch denied'))); return child })
  await expect((await prepareWindowsInstaller(installer)).launch()).rejects.toThrow('launch denied')
})
