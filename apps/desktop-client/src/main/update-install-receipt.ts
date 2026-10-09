import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

const receiptSchema = z.object({
  fromVersion: z.string().min(1), version: z.string().min(1),
  status: z.enum(['pending', 'completed', 'acknowledged', 'failed']),
  stagingDirectory: z.string().optional(),
})
export type UpdateInstallReceipt = z.infer<typeof receiptSchema>

/** The install intent survives quitting; a matching running version confirms success. */
export class UpdateInstallReceiptStore {
  constructor(private readonly directory: string) {}

  read(): UpdateInstallReceipt | null {
    try { return receiptSchema.parse(JSON.parse(readFileSync(join(this.directory, 'update-install.json'), 'utf8'))) }
    catch { return null }
  }

  write(receipt: UpdateInstallReceipt): void {
    mkdirSync(this.directory, { recursive: true })
    const target = join(this.directory, 'update-install.json')
    writeFileSync(`${target}.tmp`, JSON.stringify(receiptSchema.parse(receipt)), { mode: 0o600 })
    renameSync(`${target}.tmp`, target)
  }

  reconcile(currentVersion: string): UpdateInstallReceipt | null {
    const receipt = this.read()
    if (!receipt || receipt.status === 'acknowledged') return null
    if (receipt.fromVersion !== receipt.version && receipt.version === currentVersion) {
      const completed = { ...receipt, status: 'completed' as const }
      this.write(completed)
      return completed
    }
    if (receipt.status === 'pending' || receipt.status === 'failed') {
      const failed = { ...receipt, status: 'failed' as const }
      this.write(failed)
      return failed
    }
    return null
  }

  acknowledge(version: string): void {
    const receipt = this.read()
    if (receipt?.status === 'completed' && receipt.version === version) this.write({ ...receipt, status: 'acknowledged' })
  }
}
