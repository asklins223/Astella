import { app } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { access, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export async function prepareWindowsInstaller(installer: { path: string; version: string; sha512: string }): Promise<{ launch: () => Promise<void> }> {
  const directory = dirname(app.getPath('exe'))
  try { await access(directory, constants.W_OK) }
  catch { throw new Error('WINDOWS_UPDATE_PERMISSION: 当前程序位置不能写入，请从下载页获取安装包并选择有权限的位置。') }
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(installer.path)) hash.update(chunk)
  if (hash.digest('base64') !== installer.sha512) throw new Error('Update SHA512 checksum mismatch')
  const binary = await open(installer.path, 'r')
  try {
    const header = Buffer.alloc(2)
    await binary.read(header, 0, 2, 0)
    if (header.toString('ascii') !== 'MZ') throw new Error('Invalid Windows update executable')
  } finally { await binary.close() }
  return { launch: async () => {
    const child = spawn(installer.path, ['--update', '--install-dir', directory, '--wait-pid', String(process.pid),
      '--receipt', join(app.getPath('userData'), 'update-install.json'), '--from-version', app.getVersion(),
      '--target-version', installer.version, '--launch'], { detached: true, stdio: 'ignore', windowsHide: false })
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
    child.unref()
  } }
}
