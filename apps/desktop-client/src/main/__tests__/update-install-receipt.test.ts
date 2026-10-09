import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { UpdateInstallReceiptStore } from '../update-install-receipt'

const directories: string[] = []
const store = () => {
  const directory = mkdtempSync(join(tmpdir(), 'astella-update-receipt-'))
  directories.push(directory)
  return new UpdateInstallReceiptStore(directory)
}
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })))

describe('install receipts across restart', () => {
  it('confirms the new running version and retains success until presentation', () => {
    const receipt = store()
    receipt.write({ fromVersion: '1.3.2', version: '1.3.3', status: 'pending' })
    expect(receipt.reconcile('1.3.3')?.status).toBe('completed')
    expect(receipt.reconcile('1.3.3')?.status).toBe('completed')
    receipt.acknowledge('1.3.2')
    expect(receipt.reconcile('1.3.3')?.status).toBe('completed')
    receipt.acknowledge('1.3.3')
    expect(receipt.reconcile('1.3.3')).toBeNull()
  })
  it('relaunching the previous version is failure, never success', () => {
    const receipt = store()
    receipt.write({ fromVersion: '1.3.2', version: '1.3.3', status: 'pending' })
    expect(receipt.reconcile('1.3.2')?.status).toBe('failed')
  })
  it('a download, fresh install or same-version restart has no success receipt', () => {
    const receipt = store()
    expect(receipt.reconcile('1.3.3')).toBeNull()
    receipt.write({ fromVersion: '1.3.3', version: '1.3.3', status: 'pending' })
    expect(receipt.reconcile('1.3.3')?.status).toBe('failed')
  })
})
