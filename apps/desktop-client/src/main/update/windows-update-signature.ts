import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

type WindowsSigner = { status?: unknown; algorithm?: unknown; publicKey?: unknown }

/** A renewed certificate using the same key remains valid; a new key requires manual installation. */
export function sameTrustedWindowsSigner(installed: WindowsSigner, update: WindowsSigner): boolean {
  return installed.status === 'Valid' && update.status === 'Valid'
    && typeof installed.algorithm === 'string' && installed.algorithm.length > 0
    && installed.algorithm === update.algorithm
    && typeof installed.publicKey === 'string' && installed.publicKey.length > 0
    && installed.publicKey === update.publicKey
}

export async function verifyWindowsUpdateSignature(installedPath: string, updatePath: string): Promise<void> {
  const systemRoot = process.env.SystemRoot
  if (!systemRoot) throw new Error('Windows signature verification unavailable')
  const script = `$ErrorActionPreference = 'Stop'
function Read-Signer([string] $path) {
  $s = Get-AuthenticodeSignature -LiteralPath $path
  $c = $s.SignerCertificate
  if ($null -eq $c) { return @{ status = [string]$s.Status } }
  return @{ status = [string]$s.Status; algorithm = $c.GetKeyAlgorithm(); publicKey = $c.GetPublicKeyString() }
}
@{ installed = (Read-Signer $env:ASTELLA_INSTALLED_EXE); update = (Read-Signer $env:ASTELLA_UPDATE_EXE) } | ConvertTo-Json -Compress`
  try {
    const { stdout } = await run(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', script], {
        timeout: 60_000, maxBuffer: 64 * 1024, windowsHide: true,
        env: { ...process.env, ASTELLA_INSTALLED_EXE: installedPath, ASTELLA_UPDATE_EXE: updatePath },
      })
    const result = JSON.parse(stdout) as { installed?: WindowsSigner; update?: WindowsSigner }
    if (!result.installed || !result.update || !sameTrustedWindowsSigner(result.installed, result.update)) throw new Error('untrusted signer')
  } catch {
    throw new Error('Windows update signature verification failed; install a trusted release manually')
  }
}
